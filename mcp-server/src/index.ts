#!/usr/bin/env node
// ==========================================
// VULMINI — MCP Server Entry Point
// ==========================================
// Точка входа для MCP-сервера Vulmini.
// Регистрирует все инструменты и подключается
// через stdio-транспорт к Gemini (Antigravity CLI).
//
// Запуск:
//   node dist/index.js       — production
//   npx tsx src/index.ts      — development
//   npx @modelcontextprotocol/inspector node dist/index.js — debug

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { VultrApiClient } from "./services/vultr-api.js";
import { SshExecutor } from "./services/ssh-executor.js";
import { WpCliService } from "./services/wp-cli.js";

import { registerVultrTools } from "./tools/vultr-tools.js";
import { registerWpCliTools } from "./tools/wp-cli-tools.js";
import { registerTelemetryTools } from "./tools/telemetry-tools.js";

// ── Configuration from Environment ──

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[Vulmini] ❌ Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

// ── Initialize Services ──

const vultrApiKey = requireEnv("VULTR_API_KEY");
const vultrRegion = optionalEnv("VULTR_REGION", "tlv");
const vultrPlan = optionalEnv("VULTR_PLAN", "vhf-2c-4gb");

const sshHost = requireEnv("SSH_HOST");
const sshPort = parseInt(optionalEnv("SSH_PORT", "22"), 10);
const sshUser = optionalEnv("SSH_USER", "root");
const sshKeyPath = optionalEnv("SSH_PRIVATE_KEY_PATH", "~/.ssh/vulmini_rsa");

// Services
const vultr = new VultrApiClient(vultrApiKey);

const ssh = new SshExecutor({
  host: sshHost,
  port: sshPort,
  username: sshUser,
  privateKeyPath: sshKeyPath,
});

const wpCli = new WpCliService(ssh, {
  production: sshHost,
});

// ── Create MCP Server ──

const server = new McpServer({
  name: "vulmini-mcp-server",
  version: "0.1.0",
});

// ── Register All Tool Groups ──

// 1. Vultr API tools (create/destroy VPS, snapshots)
registerVultrTools(server, vultr, {
  region: vultrRegion,
  plan: vultrPlan,
});

// 2. WP-CLI tools (plugin management, DB migration, health checks, backup/restore)
registerWpCliTools(server, wpCli);

// 3. Telemetry tools (system health, logs, Docker status)
registerTelemetryTools(server, ssh, (target) => {
  if (target === "staging") {
    const stagingHost = process.env.VULMINI_STAGING_HOST;
    if (!stagingHost) {
      throw new Error(
        "Staging host not configured. Use set_staging_host tool first."
      );
    }
    return stagingHost;
  }
  return sshHost;
});

// ── Connect via stdio ──

console.error("[Vulmini] 🚀 Starting MCP server...");
console.error(`[Vulmini]   Region: ${vultrRegion}`);
console.error(`[Vulmini]   Plan: ${vultrPlan}`);
console.error(`[Vulmini]   SSH: ${sshUser}@${sshHost}:${sshPort}`);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error("[Vulmini] ✅ MCP server connected and ready");
