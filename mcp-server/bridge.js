import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read token and host from .env
const envPath = path.resolve(__dirname, '../.env');
let token = 'my-secure-token';
let host = '';

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const tokenMatch = envContent.match(/MCP_BEARER_TOKEN=([^\r\n]*)/);
  if (tokenMatch) token = tokenMatch[1].trim();
  const hostMatch = envContent.match(/VULTR_MCP_HOST=([^\r\n]*)/);
  if (hostMatch) host = hostMatch[1].trim();
}

if (!host) {
  console.error("Error: VULTR_MCP_HOST is not defined in the .env file. No remote MCP host is configured.");
  process.exit(1);
}


async function main() {
  const url = new URL(`http://${host}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }
  });

  transport.onmessage = (message) => {
    // Print the JSON-RPC message received from the remote server to stdout, followed by a newline
    process.stdout.write(JSON.stringify(message) + '\n');
  };

  transport.onerror = (error) => {
    console.error(`[Streamable HTTP Transport Error]:`, error);
  };

  transport.onclose = () => {
    process.exit(0);
  };

  // Start the connection
  await transport.start();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line);
      await transport.send(message);
    } catch (err) {
      console.error(`[Bridge Error] Failed to send message:`, err.message);
    }
  });
}

main().catch(err => {
  console.error(`[Bridge Main Error]:`, err);
  process.exit(1);
});
