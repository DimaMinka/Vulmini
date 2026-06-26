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
if (target !== "mcp") {
  console.error(
    `❌ deploy-node.js only supports the 'mcp' target. For staging/prod, use deploy-docker.js.`,
  );
  process.exit(1);
}

const hostVar = "VULTR_MCP_HOST";
const sshHost = getEnvVal(hostVar);
const sshPort = parseInt(getEnvVal("SSH_PORT") || "22", 10);
const sshUser = getEnvVal("SSH_USER") || "root";
const sshKeyPathRaw = getEnvVal("SSH_PRIVATE_KEY_PATH") || "~/.ssh/vulmini_rsa";
const sshKeyPath = sshKeyPathRaw.replace(/^~/, process.env.HOME || "");
const domainName = getEnvVal("DOMAIN_NAME") || "vulmini.cdk.app";
const sslEmail = getEnvVal("LETSENCRYPT_EMAIL") || "cdk@cdk.co.il";

if (!sshHost) {
  console.error(
    `❌ SSH Host variable ${hostVar} not found/empty in .env. Please run deploy-vps.js first.`,
  );
  process.exit(1);
}

const privateKey = fs.readFileSync(sshKeyPath);

console.log(`\nTarget VPS (${target}): ${sshUser}@${sshHost}:${sshPort}`);

// 1. Pack project files locally
console.log("1. Compiling TypeScript locally and packaging project files...");
const tarFile = "vulmini-mcp.tar.gz";
try {
  // Compile TypeScript first
  execSync("npm run build", { cwd: __dirname, stdio: "inherit" });

  // Copy .env temporarily for packaging
  fs.copyFileSync(envPath, path.join(__dirname, ".env.prod"));

  // Tar essential files
  execSync(
    `tar -czf ${tarFile} dist package.json package-lock.json .env.prod -C .. docker-compose.yml nginx php scripts`,
    { cwd: __dirname, stdio: "inherit" },
  );

  // Clean up temporary .env
  fs.unlinkSync(path.join(__dirname, ".env.prod"));
  console.log("Files compiled and packaged successfully.");
} catch (err) {
  console.error("Failed to package files:", err);
  if (fs.existsSync(path.join(__dirname, ".env.prod")))
    fs.unlinkSync(path.join(__dirname, ".env.prod"));
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
    // 2. Install Node.js, Nginx & Certbot on remote host
    console.log(
      "2. Checking/Installing dependencies on remote host (NodeJS, Nginx, Certbot)...",
    );

    // Check NodeJS 20
    const checkNode = await executeRemoteCommand(
      conn,
      "which node || echo 'missing'",
    );
    if (checkNode.stdout.includes("missing")) {
      console.log("Installing Node.js 20 on remote server...");
      await executeRemoteCommand(
        conn,
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs",
      );
    } else {
      console.log("Node.js is already installed.");
    }

    // Check Nginx
    const checkNginx = await executeRemoteCommand(
      conn,
      "which nginx || echo 'missing'",
    );
    if (checkNginx.stdout.includes("missing")) {
      console.log("Installing Nginx on remote server...");
      await executeRemoteCommand(
        conn,
        "apt-get update && apt-get install -y nginx",
      );
    }

    // Check Certbot
    const checkCertbot = await executeRemoteCommand(
      conn,
      "which certbot || echo 'missing'",
    );
    if (checkCertbot.stdout.includes("missing")) {
      console.log("Installing Certbot Nginx plugin on remote server...");
      await executeRemoteCommand(
        conn,
        "apt-get update && apt-get install -y certbot python3-certbot-nginx",
      );
    }

    // 3. Upload tarball
    const remoteTar = "/root/vulmini-mcp.tar.gz";
    await uploadFile(conn, path.join(__dirname, tarFile), remoteTar);

    // 3.1. Upload SSH Key for accessing staging/production VPS
    console.log(
      "3.1. Uploading SSH private and public keys to remote server...",
    );
    await executeRemoteCommand(
      conn,
      "mkdir -p /root/.ssh && chmod 700 /root/.ssh",
    );
    const remoteKeyPath = "/root/.ssh/vulmini_rsa";
    const remotePubKeyPath = "/root/.ssh/vulmini_rsa.pub";
    if (fs.existsSync(sshKeyPath)) {
      await uploadFile(conn, sshKeyPath, remoteKeyPath);
      await executeRemoteCommand(conn, `chmod 600 ${remoteKeyPath}`);
      console.log("SSH private key uploaded and secured.");
    } else {
      console.warn(
        `⚠️ Warning: Local SSH private key not found at ${sshKeyPath}. Skipping private key upload.`,
      );
    }
    const pubKeyPath = sshKeyPath + ".pub";
    if (fs.existsSync(pubKeyPath)) {
      await uploadFile(conn, pubKeyPath, remotePubKeyPath);
      await executeRemoteCommand(conn, `chmod 644 ${remotePubKeyPath}`);
      console.log("SSH public key uploaded and secured.");
    } else {
      console.warn(
        `⚠️ Warning: Local SSH public key not found at ${pubKeyPath}. Skipping public key upload.`,
      );
    }

    // 4. Extract tarball
    console.log("3. Extracting files to /var/www/vulmini-mcp...");
    await executeRemoteCommand(
      conn,
      "mkdir -p /var/www/vulmini-mcp && tar -xzf /root/vulmini-mcp.tar.gz -C /var/www/vulmini-mcp",
    );
    await executeRemoteCommand(
      conn,
      "mv -f /var/www/vulmini-mcp/.env.prod /var/www/vulmini-mcp/.env",
    );

    // 5. Install Production Dependencies
    console.log("4. Installing production dependencies on remote host...");
    // Configure Swap Space to prevent memory issues on 512MB RAM instances
    await executeRemoteCommand(
      conn,
      "if [ ! -f /swapfile ]; then fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi",
    );
    await executeRemoteCommand(
      conn,
      "cd /var/www/vulmini-mcp && npm ci --omit=dev",
    );

    // 6. Write and Enable Systemd Service
    console.log("5. Setting up Systemd service...");
    const systemdService = `[Unit]
Description=Vulmini MCP HTTP Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/var/www/vulmini-mcp
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
Environment=PORT=3000
EnvironmentFile=/var/www/vulmini-mcp/.env

[Install]
WantedBy=multi-user.target
`;
    // Write service file remotely
    await executeRemoteCommand(
      conn,
      `cat << 'EOF' > /etc/systemd/system/vulmini-mcp.service\n${systemdService}EOF`,
    );
    await executeRemoteCommand(
      conn,
      "systemctl daemon-reload && systemctl enable vulmini-mcp && systemctl restart vulmini-mcp",
    );

    // 7. Write Nginx Reverse Proxy Config
    console.log("6. Setting up Nginx reverse proxy...");
    const nginxConfig = `server {
    listen 80;
    server_name ${domainName};

    location /mcp {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        proxy_set_header Connection "";
        proxy_set_header X-Accel-Buffering no;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
    await executeRemoteCommand(
      conn,
      `cat << 'EOF' > /etc/nginx/sites-available/vulmini-mcp\n${nginxConfig}EOF`,
    );
    await executeRemoteCommand(
      conn,
      "ln -sf /etc/nginx/sites-available/vulmini-mcp /etc/nginx/sites-enabled/vulmini-mcp",
    );
    await executeRemoteCommand(conn, "rm -f /etc/nginx/sites-enabled/default");
    await executeRemoteCommand(
      conn,
      "which ufw && ufw allow 'Nginx Full' || echo 'UFW not installed'",
    );
    await executeRemoteCommand(conn, "nginx -t && systemctl restart nginx");

    // 8. Setup SSL certificates using Certbot
    console.log("7. Requesting Let's Encrypt SSL Cert via Certbot...");
    const certbotRes = await executeRemoteCommand(
      conn,
      `certbot --nginx -d ${domainName} --non-interactive --agree-tos --email ${sslEmail} --redirect`,
    );
    if (certbotRes.code !== 0) {
      console.log(
        `\n⚠️  Certbot was unable to automatically provision SSL. This is expected if DNS for '${domainName}' does not point to IP '${sshHost}' yet. Node server remains active on port 3000.`,
      );
    }

    console.log("\n🎉 Lightweight Node.js MCP server deployed successfully!");
    console.log("Systemd service status:");
    await executeRemoteCommand(conn, "systemctl status vulmini-mcp --no-pager");

    conn.end();
    if (fs.existsSync(path.join(__dirname, tarFile)))
      fs.unlinkSync(path.join(__dirname, tarFile));
    console.log("\nDone!");
  } catch (err) {
    console.error("❌ Error during remote execution:", err);
    conn.end();
    if (fs.existsSync(path.join(__dirname, tarFile)))
      fs.unlinkSync(path.join(__dirname, tarFile));
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
    if (fs.existsSync(path.join(__dirname, tarFile)))
      fs.unlinkSync(path.join(__dirname, tarFile));
    process.exit(1);
  }
});

startSshConnection();
