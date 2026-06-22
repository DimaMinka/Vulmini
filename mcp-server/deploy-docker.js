import { Client } from 'ssh2';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// Read .env
const envPath = path.resolve('../.env');
const envContent = fs.readFileSync(envPath, 'utf-8');

function getEnvVal(name) {
  const match = envContent.match(new RegExp(`${name}=([^\\r\\n]*)`));
  return match ? match[1].trim() : null;
}

const sshHost = getEnvVal("SSH_HOST");
const sshPort = parseInt(getEnvVal("SSH_PORT") || "22", 10);
const sshUser = getEnvVal("SSH_USER") || "root";
const sshKeyPathRaw = getEnvVal("SSH_PRIVATE_KEY_PATH") || "~/.ssh/vulmini_rsa";
const sshKeyPath = sshKeyPathRaw.replace(/^~/, process.env.HOME || '');

if (!sshHost) {
  console.error("SSH_HOST not found in .env. Please run deploy-vps.js first.");
  process.exit(1);
}

const privateKey = fs.readFileSync(sshKeyPath);

console.log(`Target VPS: ${sshUser}@${sshHost}:${sshPort}`);

// 1. Pack project files locally
console.log("1. Packaging project files locally...");
const tarFile = 'vulmini.tar.gz';
try {
  // Go to root folder and tar essential files
  execSync(`tar -czf ${tarFile} -C .. docker-compose.yml .env nginx php scripts`, { stdio: 'inherit' });
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
      let stdout = '';
      let stderr = '';
      stream.on('close', (code) => {
        resolve({ stdout, stderr, code });
      }).on('data', (data) => {
        stdout += data.toString();
        process.stdout.write(data);
      }).stderr.on('data', (data) => {
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

conn.on('ready', async () => {
  console.log("SSH Connection established successfully.");
  try {
    // 2. Install Docker
    console.log("2. Checking/Installing Docker on remote host...");
    const checkDocker = await executeRemoteCommand(conn, "which docker || echo 'missing'");
    if (checkDocker.stdout.includes("missing")) {
      console.log("Installing Docker on remote server (this may take a minute)...");
      await executeRemoteCommand(conn, "curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh");
      console.log("Docker installed successfully.");
    } else {
      console.log("Docker is already installed.");
    }

    // 3. Upload tarball
    const remoteTar = '/root/vulmini.tar.gz';
    await uploadFile(conn, tarFile, remoteTar);

    // 4. Extract tarball
    console.log("3. Extracting files on remote server...");
    await executeRemoteCommand(conn, "mkdir -p /root/vulmini && tar -xzf /root/vulmini.tar.gz -C /root/vulmini");

    // 5. Run Docker Compose
    console.log("4. Running Docker Compose up...");
    await executeRemoteCommand(conn, "cd /root/vulmini && docker compose down && docker compose up -d");

    console.log("\n🎉 Docker Stack is booting up on Vultr VPS!");
    console.log("Checking container status in 10 seconds...");
    setTimeout(async () => {
      console.log("\nContainer Status:");
      await executeRemoteCommand(conn, "docker ps");
      conn.end();
      // Delete local tarball
      fs.unlinkSync(tarFile);
      console.log("\nDone!");
    }, 10000);

  } catch (err) {
    console.error("Error during remote execution:", err);
    conn.end();
    if (fs.existsSync(tarFile)) fs.unlinkSync(tarFile);
  }
}).on('error', (err) => {
  console.error("SSH Connection Error:", err);
}).connect({
  host: sshHost,
  port: sshPort,
  username: sshUser,
  privateKey: privateKey,
  readyTimeout: 60000
});
