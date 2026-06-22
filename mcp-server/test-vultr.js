import { VultrApiClient } from './dist/services/vultr-api.js';
import fs from 'fs';
import path from 'path';

// Read .env from parent directory
const envPath = path.resolve('../.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
const apiKeyMatch = envContent.match(/VULTR_API_KEY=([^\r\n]+)/);
const apiKey = apiKeyMatch ? apiKeyMatch[1].trim() : null;

if (!apiKey) {
  console.error("VULTR_API_KEY not found in .env");
  process.exit(1);
}

const client = new VultrApiClient(apiKey);
try {
  console.log("Fetching instances...");
  const instances = await client.listInstances();
  console.log("Instances count:", instances.length);
  if (instances.length > 0) {
    console.log("Instances details:", JSON.stringify(instances.map(i => ({ id: i.id, label: i.label, ip: i.main_ip, status: i.status })), null, 2));
  }
} catch (error) {
  console.error("Error fetching Vultr instances:", error.message);
}
