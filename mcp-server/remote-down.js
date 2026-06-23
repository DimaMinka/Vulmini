import { VultrApiClient } from './dist/services/vultr-api.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read .env from parent directory
const envPath = path.resolve(__dirname, '../.env');
if (!fs.existsSync(envPath)) {
  console.error("❌ .env file not found.");
  process.exit(1);
}

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

let instanceIdVar = '';
let hostVar = '';

switch (target) {
  case 'mcp':
    instanceIdVar = 'VULTR_MCP_INSTANCE_ID';
    hostVar = 'VULTR_MCP_HOST';
    break;
  case 'stage':
    instanceIdVar = 'VULTR_STAGE_INSTANCE_ID';
    hostVar = 'VULMINI_STAGING_HOST';
    break;
  case 'prod':
    instanceIdVar = 'VULTR_PROD_INSTANCE_ID';
    hostVar = 'SSH_HOST';
    break;
}

const apiKey = getEnvVal("VULTR_API_KEY");
const instanceId = getEnvVal(instanceIdVar);

if (!apiKey) {
  console.error("❌ VULTR_API_KEY not found in .env");
  process.exit(1);
}

if (!instanceId) {
  console.error(`❌ ${instanceIdVar} not found/empty in .env. Is the server already destroyed or not yet created?`);
  process.exit(1);
}

console.log(`Destroying VPS instance ${instanceId} for target '${target}'...`);

const client = new VultrApiClient(apiKey);

async function main() {
  try {
    await client.deleteInstance(instanceId);
    console.log(`\n🎉 VPS instance ${instanceId} has been successfully queued for deletion on Vultr!`);

    // Clean up .env file
    console.log("Cleaning up .env file configuration...");
    envContent = envContent.replace(new RegExp(`${hostVar}=[^\\r\\n]*`), `${hostVar}=`);
    envContent = envContent.replace(new RegExp(`${instanceIdVar}=[^\\r\\n]*`), `${instanceIdVar}=`);

    fs.writeFileSync(envPath, envContent, 'utf-8');
    console.log(`Cleared ${hostVar} and ${instanceIdVar} in .env.`);
  } catch (error) {
    console.error("❌ Error destroying VPS:", error.message);
    process.exit(1);
  }
}

main();
