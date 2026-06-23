import { VultrApiClient } from "./dist/services/vultr-api.js";
import fs from "fs";
import path from "path";

// Read .env from parent directory
const envPath = path.resolve("../.env");
let envContent = fs.readFileSync(envPath, "utf-8");

function getEnvVal(name) {
  const match = envContent.match(new RegExp(`${name}=([^\\r\\n]*)`));
  return match ? match[1].trim() : null;
}

const apiKey = getEnvVal("VULTR_API_KEY");
const region = getEnvVal("VULTR_REGION") || "tlv";
const plan = getEnvVal("VULTR_PLAN") || "vhf-2c-4gb";
const sshKeyPath = getEnvVal("SSH_PRIVATE_KEY_PATH") || "~/.ssh/vulmini_rsa";

if (!apiKey) {
  console.error("VULTR_API_KEY not found in .env");
  process.exit(1);
}

// Resolve public key path
const pubKeyPath = sshKeyPath.replace(/^~/, process.env.HOME) + ".pub";
if (!fs.existsSync(pubKeyPath)) {
  console.error(`SSH Public Key not found at: ${pubKeyPath}`);
  process.exit(1);
}
const sshPublicKeyContent = fs.readFileSync(pubKeyPath, "utf-8").trim();

const client = new VultrApiClient(apiKey);

async function main() {
  try {
    console.log("1. Checking SSH keys on Vultr...");
    const keysData = await client.request("GET", "/ssh-keys");
    let sshKeyId = null;

    // Check if key already exists by content or name
    const existingKey = keysData.ssh_keys.find(
      (k) =>
        k.name === "vulmini-key" ||
        k.ssh_key.includes(sshPublicKeyContent.slice(10, 50)),
    );
    if (existingKey) {
      console.log(`SSH Key already exists in Vultr: ${existingKey.id}`);
      sshKeyId = existingKey.id;
    } else {
      console.log("Adding SSH Key to Vultr...");
      const newKey = await client.request("POST", "/ssh-keys", {
        name: "vulmini-key",
        ssh_key: sshPublicKeyContent,
      });
      sshKeyId = newKey.ssh_key.id;
      console.log(`SSH Key added successfully: ${sshKeyId}`);
    }

    console.log(
      `2. Creating Vultr VPS Staging instance (Ubuntu 24.04, ${plan} in ${region})...`,
    );
    const instance = await client.createInstance({
      region: region,
      plan: plan,
      os_id: 2284, // Ubuntu 24.04
      label: "vulmini-stage",
      hostname: "vulmini-stage",
      sshkey_id: [sshKeyId],
      enable_ipv6: true,
      tags: ["vulmini", "staging"],
    });

    const instanceId = instance.id;
    console.log(
      `VPS Staging Instance created: ${instanceId}. Status: ${instance.status}. Waiting to become active...`,
    );

    // Wait for the instance to become active
    const activeInstance = await client.waitForInstanceActive(instanceId);
    const ip = activeInstance.main_ip;
    console.log(`\n🎉 Staging VPS is now active! IP Address: ${ip}`);

    // Update .env with SSH_HOST and add VULMINI_STAGING_HOST
    console.log("Updating .env file...");
    envContent = envContent.replace(/SSH_HOST=[^\r\n]*/, `SSH_HOST=${ip}`);

    // Add or update VULMINI_STAGING_HOST
    if (envContent.includes("VULMINI_STAGING_HOST=")) {
      envContent = envContent.replace(
        /VULMINI_STAGING_HOST=[^\r\n]*/,
        `VULMINI_STAGING_HOST=${ip}`,
      );
    } else {
      envContent += `\nVULMINI_STAGING_HOST=${ip}`;
    }

    fs.writeFileSync(envPath, envContent, "utf-8");

    console.log(
      "\nStaging deployment configuration updated successfully in .env:",
    );
    console.log(`- SSH_HOST: ${ip}`);
    console.log(`- VULMINI_STAGING_HOST: ${ip}`);
    console.log(`- Staging Instance ID: ${instanceId}`);
  } catch (error) {
    console.error("Error deploying staging VPS:", error);
  }
}

main();
