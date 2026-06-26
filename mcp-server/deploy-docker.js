import { Client } from "ssh2";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read .env
const envPath = path.resolve(__dirname, "../.env");
const envContent = fs.readFileSync(envPath, "utf-8");

function getEnvVal(name) {
  const match = envContent.match(new RegExp(`${name}=([^\\r\\n]*)`));
  return match ? match[1].trim() : null;
}

// ── Target Configuration ──
const target = process.argv[2] || "mcp";
if (!["mcp", "stage", "prod"].includes(target)) {
  console.error(`❌ Invalid target: ${target}. Must be mcp, stage, or prod.`);
  process.exit(1);
}

let hostVar = "";
let dockerComposeServices = "";

switch (target) {
  case "mcp":
    hostVar = "VULTR_MCP_HOST";
    // Spin up only the web server proxy and the MCP server
    dockerComposeServices = "vulmini_web vulmini_mcp";
    break;
  case "stage":
    hostVar = "VULMINI_STAGING_HOST";
    // Spin up staging wordpress services (db, redis, app, cron, nginx, certbot)
    dockerComposeServices =
      "vulmini_db vulmini_cache vulmini_app vulmini_cron vulmini_web vulmini_certbot";
    break;
  case "prod":
    hostVar = "SSH_HOST";
    // Spin up production wordpress services
    dockerComposeServices =
      "vulmini_db vulmini_cache vulmini_app vulmini_cron vulmini_web vulmini_certbot";
    break;
}

const sshHost = getEnvVal(hostVar);
const sshPort = parseInt(getEnvVal("SSH_PORT") || "22", 10);
const sshUser = getEnvVal("SSH_USER") || "root";
const sshKeyPathRaw = getEnvVal("SSH_PRIVATE_KEY_PATH") || "~/.ssh/vulmini_rsa";
const sshKeyPath = sshKeyPathRaw.replace(/^~/, process.env.HOME || "");

if (!sshHost) {
  console.error(
    `❌ SSH Host variable ${hostVar} not found/empty in .env. Please run deploy-vps.js first.`,
  );
  process.exit(1);
}

const privateKey = fs.readFileSync(sshKeyPath);

console.log(`\nTarget VPS (${target}): ${sshUser}@${sshHost}:${sshPort}`);

// 1. Pack project files locally
console.log("1. Packaging project files locally...");
const tarFile = "vulmini.tar.gz";
try {
  // Go to root folder and tar essential files
  execSync(
    `tar -czf ${tarFile} -C .. --exclude=mcp-server/node_modules --exclude=mcp-server/dist docker-compose.yml .env nginx php scripts mcp-server`,
    { stdio: "inherit" },
  );
  console.log("Files packaged successfully.");
} catch (err) {
  console.error("Failed to package files:", err);
  process.exit(1);
}

const conn = new Client();

function executeRemoteCommand(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      stream
        .on("close", (code) => {
          resolve({ stdout, stderr, code });
        })
        .on("data", (data) => {
          stdout += data.toString();
          process.stdout.write(data);
        })
        .stderr.on("data", (data) => {
          stderr += data.toString();
          process.stderr.write(data);
        });
    });
  });
}

function uploadFile(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      console.log(`SFTP: Uploading ${localPath} to ${remotePath}...`);
      sftp.fastPut(localPath, remotePath, {}, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
}

conn.on("ready", async () => {
  console.log("SSH Connection established successfully.");
  try {
    // 2. Install Docker
    console.log("2. Checking/Installing Docker on remote host...");
    const checkDocker = await executeRemoteCommand(
      conn,
      "which docker || echo 'missing'",
    );
    if (checkDocker.stdout.includes("missing")) {
      console.log(
        "Installing Docker on remote server (this may take a minute)...",
      );
      await executeRemoteCommand(
        conn,
        "curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh",
      );
      console.log("Docker installed successfully.");
    } else {
      console.log("Docker is already installed.");
    }

    // 3. Upload tarball
    const remoteTar = "/root/vulmini.tar.gz";
    await uploadFile(conn, tarFile, remoteTar);

    // 4. Extract tarball
    console.log("3. Extracting files on remote server...");
    await executeRemoteCommand(
      conn,
      "mkdir -p /root/vulmini && tar -xzf /root/vulmini.tar.gz -C /root/vulmini",
    );

    // 4.1 Generate self-signed SSL cert if missing to prevent Nginx crash
    console.log("3.1. Setting up dummy self-signed SSL certificates...");
    await executeRemoteCommand(
      conn,
      "docker volume create vulmini_certbot_etc || true",
    );
    await executeRemoteCommand(
      conn,
      "docker run --rm -v vulmini_certbot_etc:/etc/letsencrypt alpine sh -c '" +
        "if [ ! -f /etc/letsencrypt/live/vulmini.cdk.app/fullchain.pem ]; then " +
        "mkdir -p /etc/letsencrypt/live/vulmini.cdk.app && " +
        "apk add --no-cache openssl && " +
        'openssl req -x509 -newkey rsa:2048 -keyout /etc/letsencrypt/live/vulmini.cdk.app/privkey.pem -out /etc/letsencrypt/live/vulmini.cdk.app/fullchain.pem -sha256 -days 3650 -nodes -subj "/CN=vulmini.cdk.app" && ' +
        "cp /etc/letsencrypt/live/vulmini.cdk.app/fullchain.pem /etc/letsencrypt/live/vulmini.cdk.app/chain.pem; " +
        "fi'",
    );

    // 5. Run Docker Compose
    console.log(
      `4. Running Docker Compose up for target services: ${dockerComposeServices}...`,
    );
    // Stop all running services in directory first to prevent conflicts, then start specific services
    await executeRemoteCommand(conn, "cd /root/vulmini && docker compose down");
    await executeRemoteCommand(
      conn,
      `cd /root/vulmini && docker compose up -d ${dockerComposeServices}`,
    );

    console.log("\n🎉 Docker Stack is booting up on Vultr VPS!");
    console.log("Checking container status in 10 seconds...");
    setTimeout(async () => {
      console.log("\nContainer Status:");
      await executeRemoteCommand(conn, "docker ps");
      conn.end();
      // Delete local tarball
      if (fs.existsSync(tarFile)) fs.unlinkSync(tarFile);
      console.log("\nDone!");
    }, 10000);
  } catch (err) {
    console.error("❌ Error during remote execution:", err);
    conn.end();
    if (fs.existsSync(tarFile)) fs.unlinkSync(tarFile);
    process.exit(1);
  }
});

let connectionAttempts = 0;
const maxAttempts = 15;

function startSshConnection() {
  connectionAttempts++;
  console.log(
    `Connecting to SSH (Attempt ${connectionAttempts}/${maxAttempts})...`,
  );
  conn.connect({
    host: sshHost,
    port: sshPort,
    username: sshUser,
    privateKey: privateKey,
    readyTimeout: 60000,
  });
}

conn.on("error", (err) => {
  console.error(
    `❌ SSH Connection Error (Attempt ${connectionAttempts}/${maxAttempts}):`,
    err.message || err,
  );
  if (
    connectionAttempts < maxAttempts &&
    (err.code === "ECONNREFUSED" ||
      err.level === "client-timeout" ||
      err.code === "ETIMEDOUT")
  ) {
    console.log("Waiting 10 seconds before retrying...");
    setTimeout(startSshConnection, 10000);
  } else {
    if (fs.existsSync(tarFile)) fs.unlinkSync(tarFile);
    process.exit(1);
  }
});

startSshConnection();
