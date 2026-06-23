import { VultrApiClient } from './dist/services/vultr-api.js';
import fs from 'fs';
import path from 'path';

// Read .env from parent directory
const envPath = path.resolve('../.env');
let envContent = fs.readFileSync(envPath, 'utf-8');

function getEnvVal(name) {
  const match = envContent.match(new RegExp(`${name}=([^\\r\\n]*)`));
  return match ? match[1].trim() : null;
}

// ── Target Configuration ──
const target = process.argv[2] || 'mcp';
if (!['mcp', 'stage', 'prod'].includes(target)) {
  console.error(`❌ Invalid target: ${target}. Must be mcp, stage, or prod.`);
  process.exit(1);
}

let planVar = '';
let regionVar = '';
let instanceIdVar = '';
let hostVar = '';
let label = '';
let tag = '';

switch (target) {
  case 'mcp':
    planVar = 'VULTR_MCP_PLAN';
    regionVar = 'VULTR_MCP_REGION';
    instanceIdVar = 'VULTR_MCP_INSTANCE_ID';
    hostVar = 'VULTR_MCP_HOST';
    label = 'vulmini-mcp';
    tag = 'mcp';
    break;
  case 'stage':
    planVar = 'VULTR_STAGE_PLAN';
    regionVar = 'VULTR_STAGE_REGION';
    instanceIdVar = 'VULTR_STAGE_INSTANCE_ID';
    hostVar = 'VULMINI_STAGING_HOST';
    label = 'vulmini-stage';
    tag = 'staging';
    break;
  case 'prod':
    planVar = 'VULTR_PROD_PLAN';
    regionVar = 'VULTR_PROD_REGION';
    instanceIdVar = 'VULTR_PROD_INSTANCE_ID';
    hostVar = 'SSH_HOST';
    label = 'vulmini-prod';
    tag = 'production';
    break;
}

const apiKey = getEnvVal("VULTR_API_KEY");
const region = (regionVar ? getEnvVal(regionVar) : null) || getEnvVal("VULTR_REGION") || "tlv";
const plan = getEnvVal(planVar) || (target === 'mcp' ? 'vc2-1c-0.5gb' : target === 'stage' ? 'vc2-1c-1gb' : 'vc2-1c-2gb');
const sshKeyPath = getEnvVal("SSH_PRIVATE_KEY_PATH") || "~/.ssh/vulmini_rsa";

if (!apiKey) {
  console.error("VULTR_API_KEY not found in .env");
  process.exit(1);
}

// Resolve public key path
const pubKeyPath = sshKeyPath.replace(/^~/, process.env.HOME) + '.pub';
if (!fs.existsSync(pubKeyPath)) {
  console.error(`SSH Public Key not found at: ${pubKeyPath}`);
  process.exit(1);
}
const sshPublicKeyContent = fs.readFileSync(pubKeyPath, 'utf-8').trim();

const client = new VultrApiClient(apiKey);

async function main() {
  try {
    console.log("1. Checking SSH keys on Vultr...");
    const keysData = await client.request("GET", "/ssh-keys");
    let sshKeyId = null;

    // Check if key already exists by content or name
    const existingKey = keysData.ssh_keys.find(k => k.name === "vulmini-key" || k.ssh_key.includes(sshPublicKeyContent.slice(10, 50)));
    if (existingKey) {
      console.log(`SSH Key already exists in Vultr: ${existingKey.id}`);
      sshKeyId = existingKey.id;
    } else {
      console.log("Adding SSH Key to Vultr...");
      const newKey = await client.request("POST", "/ssh-keys", {
        name: "vulmini-key",
        ssh_key: sshPublicKeyContent
      });
      sshKeyId = newKey.ssh_key.id;
      console.log(`SSH Key added successfully: ${sshKeyId}`);
    }

    const osId = target === 'mcp' ? 2136 : 2284; // Debian 12 for MCP (512MB compatibility), Ubuntu 24.04 for others
    const osName = target === 'mcp' ? 'Debian 12' : 'Ubuntu 24.04';
    console.log(`2. Creating Vultr VPS instance for target '${target}' (${osName}, ${plan} in ${region})...`);
    const instance = await client.createInstance({
      region: region,
      plan: plan,
      os_id: osId,
      label: label,
      hostname: label,
      sshkey_id: [sshKeyId],
      enable_ipv6: true,
      tags: ["vulmini", tag]
    });

    const instanceId = instance.id;
    console.log(`VPS Instance created: ${instanceId}. Status: ${instance.status}. Waiting to become active...`);

    // Wait for the instance to become active
    const activeInstance = await client.waitForInstanceActive(instanceId);
    const ip = activeInstance.main_ip;
    console.log(`\n🎉 VPS is now active! IP Address: ${ip}`);

    // Update .env with host IP and Instance ID
    console.log("Updating .env file...");
    envContent = envContent.replace(new RegExp(`${hostVar}=[^\\r\\n]*`), `${hostVar}=${ip}`);
    envContent = envContent.replace(new RegExp(`${instanceIdVar}=[^\\r\\n]*`), `${instanceIdVar}=${instanceId}`);
    fs.writeFileSync(envPath, envContent, 'utf-8');

    console.log(`\nDeployment configuration updated successfully in .env for '${target}':`);
    console.log(`- ${hostVar}: ${ip}`);
    console.log(`- ${instanceIdVar}: ${instanceId}`);
  } catch (error) {
    console.error("Error deploying VPS:", error);
    process.exit(1);
  }
}

main();
