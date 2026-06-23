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
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

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
  let envPath = path.resolve(__dirname, "../../.env");
  if (!fs.existsSync(envPath)) {
    envPath = path.resolve(__dirname, "../.env");
  }
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

// ── Connect Server ──

const transportMode = process.env.MCP_TRANSPORT || (process.env.PORT ? "http" : "stdio");

if (transportMode === "http") {
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

  // Map to store active sessions: sessionId -> { transport, server }
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  // Helper to construct a new server + transport session
  const getOrCreateSession = async (sessionId: string) => {
    let session = sessions.get(sessionId);
    if (!session) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId
      });

      // Force the transport to be marked as initialized with the correct session ID.
      // This allows clients to reconnect seamlessly without throwing 404/400 errors after server restarts.
      const webTransport = (transport as any)._webStandardTransport;
      if (webTransport) {
        webTransport.sessionId = sessionId;
        webTransport._initialized = true;
      }

      transport.onerror = (err) => {
        console.error(`[Vulmini] ❌ Transport error for session ${sessionId}:`, err);
      };
      
      const s = new McpServer({
        name: "vulmini-mcp-server",
        version: "0.1.0",
      });
      registerVultrTools(s, vultr, {
        region: vultrRegion,
        plan: vultrPlan,
      });
      registerWpCliTools(s, wpCli);
      registerTelemetryTools(s, ssh, (target) => {
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

      await s.connect(transport);
      session = { transport, server: s };
      sessions.set(sessionId, session);
    }
    return session;
  };

  app.all(
    "/mcp",
    authenticate,
    async (req: express.Request, res: express.Response) => {
      let sessionId = req.headers["mcp-session-id"] as string | undefined;

      // If it's a POST and has no session id, check if it's an initialize request
      if (!sessionId && req.method === "POST" && req.body) {
        const body = req.body;
        const messages = Array.isArray(body) ? body : [body];
        const isInit = messages.some(msg => msg && msg.method === "initialize");
        if (isInit) {
          sessionId = crypto.randomUUID();
        }
      }

      if (!sessionId) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: Mcp-Session-Id header or initialize request is required"
          },
          id: null
        });
        return;
      }

      try {
        const session = await getOrCreateSession(sessionId);
        await session.transport.handleRequest(req, res, req.body);
      } catch (err: any) {
        console.error(`[Vulmini] ❌ Error handling request for session ${sessionId}:`, err);
        res.status(500).json({ error: err.message || "Internal Server Error" });
      }
    },
  );

  app.get("/health", (req: express.Request, res: express.Response) => {
    res.status(200).json({ status: "healthy", activeSessions: sessions.size });
  });

  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("[Vulmini] ❌ Route error:", err);
    res.status(500).json({ error: err.message || "Internal Server Error" });
  });

  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    console.error(`[Vulmini] ✅ MCP HTTP server listening on port ${port}`);
  });
} else {
  console.error("[Vulmini] 🚀 Starting MCP server in Stdio mode...");
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

