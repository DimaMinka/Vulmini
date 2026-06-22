#!/usr/bin/env node
// ==========================================
// VULMINI — MCP Server Entry Point
// ==========================================
// Entry point for the Vulmini MCP server.
// Registers all tools and connects
// via stdio transport to Gemini (Antigravity CLI).
//
// Execution:
//   node dist/index.js       — production
//   npx tsx src/index.ts      — development
//   npx @modelcontextprotocol/inspector node dist/index.js — debug

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VultrApiClient } from "./services/vultr-api.js";
import { SshExecutor } from "./services/ssh-executor.js";
import { WpCliService } from "./services/wp-cli.js";

import { registerVultrTools } from "./tools/vultr-tools.js";
import { registerWpCliTools } from "./tools/wp-cli-tools.js";
import { registerTelemetryTools } from "./tools/telemetry-tools.js";

// ── Load Environment Variables from .env ──
try {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(__dirname, "../../.env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    envContent.split(/\r?\n/).forEach((line) => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || "";
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        } else if (value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }
        process.env[key] = value.trim();
      }
    });
  }
} catch (e) {
  console.error("[Vulmini] Error loading .env file:", e);
}

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

const sshHost = optionalEnv("SSH_HOST", "");
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
    try {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const envPath = path.resolve(__dirname, "../../.env");
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, "utf-8");
        envContent.split(/\r?\n/).forEach((line) => {
          const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
          if (match) {
            const key = match[1];
            let value = match[2] || "";
            if (value.startsWith('"') && value.endsWith('"')) {
              value = value.slice(1, -1);
            } else if (value.startsWith("'") && value.endsWith("'")) {
              value = value.slice(1, -1);
            }
            process.env[key] = value.trim();
          }
        });
      }
    } catch (e) {
      console.error("[Vulmini] Error reloading .env file:", e);
    }

    const stagingHost = process.env.VULMINI_STAGING_HOST;
    if (!stagingHost) {
      throw new Error(
        "Staging host not configured. Use set_staging_host tool first.",
      );
    }
    return stagingHost;
  }
  return sshHost;
});

// ── Connect Server ──

const useHttp =
  process.env.TRANSPORT === "http" || process.argv.includes("--http");

if (useHttp) {
  console.error("[Vulmini] 🚀 Starting MCP server in HTTP mode...");
  const app = express();
  app.use(express.json());

  // Timing-safe Bearer Authentication Middleware
  const authenticate = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const token = authHeader.substring(7);
    const expectedToken = process.env.MCP_BEARER_TOKEN;
    if (!expectedToken) {
      console.error(
        "[Vulmini] ❌ MCP_BEARER_TOKEN is not configured in environment",
      );
      res.status(500).json({ error: "Server Configuration Error" });
      return;
    }

    const aBuf = Buffer.from(token);
    const bBuf = Buffer.from(expectedToken);
    let equal = true;
    if (aBuf.length !== bBuf.length) {
      crypto.timingSafeEqual(aBuf, aBuf);
      equal = false;
    } else {
      equal = crypto.timingSafeEqual(aBuf, bBuf);
    }

    if (!equal) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };

  const transport = new StreamableHTTPServerTransport();
  await server.connect(transport);

  app.all(
    "/mcp",
    authenticate,
    async (req: express.Request, res: express.Response) => {
      await transport.handleRequest(req, res, req.body);
    },
  );

  app.get("/health", (req: express.Request, res: express.Response) => {
    res.status(200).json({ status: "healthy" });
  });

  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    console.error(`[Vulmini] ✅ MCP HTTP server listening on port ${port}`);
  });
} else {
  console.error("[Vulmini] 🚀 Starting MCP server in Stdio mode...");
  console.error(`[Vulmini]   Region: ${vultrRegion}`);
  console.error(`[Vulmini]   Plan: ${vultrPlan}`);
  console.error(`[Vulmini]   SSH: ${sshUser}@${sshHost}:${sshPort}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[Vulmini] ✅ MCP server connected and ready via stdio");
}
