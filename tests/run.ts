import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startServer, stopServer } from "./mock-server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

async function main() {
  console.log("[Test Runner] Starting mock server on port 3000...");
  process.env.MCP_BEARER_TOKEN = "my-secure-token";
  startServer(3000);

  console.log("[Test Runner] Spawning E2E tests...");

  const testFiles = [
    "tests/gateway-routing.test.ts",
    "tests/protocol-compliance.test.ts",
    "tests/docker-ssh-integration.test.ts",
    "tests/workflow.test.ts",
  ];

  // Spawn the Node.js native test runner using tsx from project root
  const testProcess = spawn("npx", ["tsx", "--test", ...testFiles], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "test",
      NODE_PATH: path.resolve(projectRoot, "mcp-server/node_modules"),
      MOCK_SERVER_EXTERNAL: "true",
    },
  });

  testProcess.on("close", (code) => {
    console.log("[Test Runner] Stopping mock server...");
    stopServer();
    console.log(`[Test Runner] Tests finished with exit code: ${code}`);
    process.exit(code ?? 0);
  });

  testProcess.on("error", (err) => {
    console.error("[Test Runner] Failed to start tests:", err);
    stopServer();
    process.exit(1);
  });
}

main().catch((err) => {
  console.error("[Test Runner] Error in test runner:", err);
  stopServer();
  process.exit(1);
});
