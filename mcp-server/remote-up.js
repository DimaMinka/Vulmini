import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read target target
const target = process.argv[2] || 'mcp';
if (!['mcp', 'stage', 'prod'].includes(target)) {
  console.error(`❌ Invalid target: ${target}. Must be mcp, stage, or prod.`);
  process.exit(1);
}

function runScript(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    console.log(`\n========================================`);
    console.log(`Running: ${path.basename(scriptPath)} ${args.join(' ')}`);
    console.log(`========================================\n`);

    const proc = spawn('node', [scriptPath, ...args], {
      cwd: __dirname,
      stdio: 'inherit'
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Script ${path.basename(scriptPath)} exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

async function main() {
  try {
    // 1. Deploy the VPS
    await runScript(path.resolve(__dirname, 'deploy-vps.js'), [target]);

    // 2. Deploy the stack on that VPS (NodeJS for mcp, Docker for others)
    const deployScript = target === 'mcp' ? 'deploy-node.js' : 'deploy-docker.js';
    await runScript(path.resolve(__dirname, deployScript), [target]);

    console.log(`\n🎉 Remote VPS creation and deployment for target '${target}' complete!`);
  } catch (err) {
    console.error(`\n❌ Error during remote-up execution for '${target}':`, err.message);
    process.exit(1);
  }
}

main();
