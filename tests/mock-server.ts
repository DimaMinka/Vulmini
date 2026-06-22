import express, { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { z } from "zod";

// ── Timing-Safe Compare Helper ──
export function timingSafeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Prevent timing leaks about length by performing dummy comparison
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ── Types ──
export interface Instance {
  id: string;
  label: string;
  main_ip: string;
  region: string;
  plan: string;
  status: "pending" | "active";
  power_status: "running" | "stopped";
  tags: string[];
}

export interface Snapshot {
  id: string;
  description: string;
  status: "pending" | "complete";
  size: number;
  date_created: string;
}

export interface Backup {
  id: string;
  target: "production" | "staging";
  scope: "full" | "db" | "plugin";
  plugin_slug?: string;
  date_created: string;
}

export interface Plugin {
  name: string;
  status: "active" | "inactive";
  update: "available" | "none";
  version: string;
  update_version?: string;
}

// ── Stateful In-Memory Infrastructure ──
let instances: Instance[] = [];
let snapshots: Snapshot[] = [];
let backups: Backup[] = [];
let stagingHost: string | null = null;
let plugins: Record<"production" | "staging", Plugin[]> = {
  production: [
    { name: "sfwd-lms", status: "active", update: "available", version: "4.10.0", update_version: "4.11.0" },
    { name: "classic-editor", status: "active", update: "none", version: "1.6.3" }
  ],
  staging: [
    { name: "sfwd-lms", status: "active", update: "available", version: "4.10.0", update_version: "4.11.0" },
    { name: "classic-editor", status: "active", update: "none", version: "1.6.3" }
  ]
};

export function resetState() {
  instances = [];
  snapshots = [];
  backups = [];
  stagingHost = null;
  plugins = {
    production: [
      { name: "sfwd-lms", status: "active", update: "available", version: "4.10.0", update_version: "4.11.0" },
      { name: "classic-editor", status: "active", update: "none", version: "1.6.3" }
    ],
    staging: [
      { name: "sfwd-lms", status: "active", update: "available", version: "4.10.0", update_version: "4.11.0" },
      { name: "classic-editor", status: "active", update: "none", version: "1.6.3" }
    ]
  };
}

// Zod schemas for validation
const targetSchema = z.enum(["production", "staging"]);
const uuidSchema = z.string().uuid();
const ipSchema = z.string().ip();

const toolSchemas: Record<string, z.ZodTypeAny> = {
  list_instances: z.object({}),
  get_instance_status: z.object({
    instance_id: uuidSchema
  }),
  create_snapshot: z.object({
    instance_id: uuidSchema,
    description: z.string().default("Vulmini auto-snapshot")
  }),
  get_snapshot_status: z.object({
    snapshot_id: z.string()
  }),
  create_ephemeral_staging: z.object({
    snapshot_id: z.string(),
    label: z.string().default("vulmini-staging-ephemeral")
  }),
  destroy_ephemeral_staging: z.object({
    instance_id: uuidSchema
  }),
  list_snapshots: z.object({}),
  create_production_vps: z.object({}),
  create_clean_staging: z.object({}),
  wp_plugin_status: z.object({
    target: targetSchema
  }),
  wp_run_update: z.object({
    target: targetSchema,
    plugin_slug: z.string().optional()
  }),
  wp_db_migrate: z.object({
    target: targetSchema
  }),
  wp_health_check: z.object({
    target: targetSchema
  }),
  wp_run_backup: z.object({
    target: targetSchema,
    scope: z.enum(["full", "db", "plugin"]).default("full"),
    plugin_slug: z.string().optional()
  }),
  wp_run_restore: z.object({
    target: targetSchema,
    backup_id: z.string(),
    scope: z.enum(["full", "db", "plugins"]).default("full")
  }),
  set_staging_host: z.object({
    host: ipSchema
  }),
  get_system_health: z.object({
    target: targetSchema
  }),
  fetch_error_logs: z.object({
    target: targetSchema,
    lines: z.number().int().min(10).max(500).default(100)
  }),
  fetch_nginx_logs: z.object({
    target: targetSchema,
    log_type: z.enum(["access", "error"]).default("error"),
    lines: z.number().int().min(10).max(500).default(50)
  }),
  get_docker_status: z.object({
    target: targetSchema
  }),
  deploy_stack: z.object({
    target: targetSchema
  })
};

// SSE clients list
let sseClients: { req: Request; res: Response }[] = [];

export function createServer() {
  const app = express();
  app.use(express.json());

  // Timing-safe Bearer Authentication Middleware
  const authenticate = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const token = authHeader.substring(7);
    const expectedToken = process.env.MCP_BEARER_TOKEN || "test-token-12345";
    if (!timingSafeCompare(token, expectedToken)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };

  // GET /mcp — Establish SSE stream
  app.get("/mcp", authenticate, (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });

    // Write handshake event
    res.write("event: endpoint\ndata: /mcp\n\n");

    const client = { req, res };
    sseClients.push(client);

    req.on("close", () => {
      sseClients = sseClients.filter(c => c !== client);
    });
  });

  // POST /mcp — JSON-RPC Endpoint
  app.post("/mcp", authenticate, (req: Request, res: Response) => {
    const { jsonrpc, method, params, id } = req.body;

    // Validate JSON-RPC structure
    if (jsonrpc !== "2.0" || !method) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid Request" },
        id: id || null
      });
      return;
    }

    if (method === "tools/list") {
      // Return tools list with schemas
      const toolsList = Object.keys(toolSchemas).map(name => {
        let description = "";
        let inputProperties: Record<string, any> = {};
        let required: string[] = [];

        // Descriptions & structures matching the actual code
        switch (name) {
          case "list_instances":
            description = "List all Vultr VPS instances with their status, IP, and region";
            break;
          case "get_instance_status":
            description = "Get detailed status of a specific Vultr VPS instance";
            inputProperties = { instance_id: { type: "string", description: "Vultr instance UUID" } };
            required = ["instance_id"];
            break;
          case "create_snapshot":
            description = "Create a snapshot of a Vultr VPS instance.";
            inputProperties = {
              instance_id: { type: "string", description: "Instance UUID to snapshot" },
              description: { type: "string", default: "Vulmini auto-snapshot", description: "Human-readable description" }
            };
            required = ["instance_id"];
            break;
          case "get_snapshot_status":
            description = "Check the status of a Vultr snapshot (pending/complete)";
            inputProperties = { snapshot_id: { type: "string", description: "Snapshot UUID" } };
            required = ["snapshot_id"];
            break;
          case "create_ephemeral_staging":
            description = "Create a temporary staging VPS from a production snapshot.";
            inputProperties = {
              snapshot_id: { type: "string", description: "Snapshot ID to deploy from" },
              label: { type: "string", default: "vulmini-staging-ephemeral", description: "Label for the staging instance" }
            };
            required = ["snapshot_id"];
            break;
          case "destroy_ephemeral_staging":
            description = "Permanently destroy an ephemeral staging VPS after testing is complete.";
            inputProperties = { instance_id: { type: "string", description: "UUID of the staging instance to destroy" } };
            required = ["instance_id"];
            break;
          case "list_snapshots":
            description = "List all Vultr snapshots with their status and size";
            break;
          case "create_production_vps":
            description = "Deploy a new production VPS on Vultr, set up SSH key, wait for activation, and update project .env file with the IP";
            break;
          case "create_clean_staging":
            description = "Deploy a new clean staging VPS from scratch on Vultr (not from a snapshot), set up SSH key, wait for activation, and return the IP";
            break;
          case "wp_plugin_status":
            description = "Get a JSON list of all WordPress plugins with their status, current version, and available updates.";
            inputProperties = { target: { type: "string", enum: ["production", "staging"], description: "Target server" } };
            required = ["target"];
            break;
          case "wp_run_update":
            description = "Update a specific WordPress plugin or all plugins.";
            inputProperties = {
              target: { type: "string", enum: ["production", "staging"], description: "Target server" },
              plugin_slug: { type: "string", description: "Specific plugin slug to update" }
            };
            required = ["target"];
            break;
          case "wp_db_migrate":
            description = "Run WordPress core database migration and LearnDash data upgrades.";
            inputProperties = { target: { type: "string", enum: ["production", "staging"], description: "Target server" } };
            required = ["target"];
            break;
          case "wp_health_check":
            description = "Perform a health check on the WordPress site.";
            inputProperties = { target: { type: "string", enum: ["production", "staging"], description: "Target server" } };
            required = ["target"];
            break;
          case "wp_run_backup":
            description = "Create a backup of the database and/or plugins BEFORE making any changes on production.";
            inputProperties = {
              target: { type: "string", enum: ["production", "staging"], description: "Target server" },
              scope: { type: "string", enum: ["full", "db", "plugin"], default: "full" },
              plugin_slug: { type: "string", description: "Plugin slug when scope is 'plugin'" }
            };
            required = ["target"];
            break;
          case "wp_run_restore":
            description = "EMERGENCY ROLLBACK: Restore the database and/or plugins from a previous backup.";
            inputProperties = {
              target: { type: "string", enum: ["production", "staging"], description: "Target server" },
              backup_id: { type: "string", description: "The backup_id from wp_run_backup" },
              scope: { type: "string", enum: ["full", "db", "plugins"], default: "full" }
            };
            required = ["target", "backup_id"];
            break;
          case "set_staging_host":
            description = "Set the SSH host for the staging server.";
            inputProperties = { host: { type: "string", description: "IP address of the staging VPS" } };
            required = ["host"];
            break;
          case "get_system_health":
            description = "Get system health metrics.";
            inputProperties = { target: { type: "string", enum: ["production", "staging"], description: "Target server" } };
            required = ["target"];
            break;
          case "fetch_error_logs":
            description = "Fetch the tail of WordPress error logs.";
            inputProperties = {
              target: { type: "string", enum: ["production", "staging"], description: "Target server" },
              lines: { type: "number", minimum: 10, maximum: 500, default: 100 }
            };
            required = ["target"];
            break;
          case "fetch_nginx_logs":
            description = "Fetch the tail of Nginx access or error logs.";
            inputProperties = {
              target: { type: "string", enum: ["production", "staging"], description: "Target server" },
              log_type: { type: "string", enum: ["access", "error"], default: "error" },
              lines: { type: "number", minimum: 10, maximum: 500, default: 50 }
            };
            required = ["target"];
            break;
          case "get_docker_status":
            description = "Get the status of all Docker containers in the Vulmini stack.";
            inputProperties = { target: { type: "string", enum: ["production", "staging"], description: "Target server" } };
            required = ["target"];
            break;
          case "deploy_stack":
            description = "Deploy/Redeploy the Docker stack to the target server.";
            inputProperties = { target: { type: "string", enum: ["production", "staging"], description: "Target server" } };
            required = ["target"];
            break;
        }

        return {
          name,
          description,
          inputSchema: {
            type: "object",
            properties: inputProperties,
            required
          }
        };
      });

      res.json({
        jsonrpc: "2.0",
        result: { tools: toolsList },
        id
      });
      return;
    }

    if (method !== "tools/call") {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32601, message: "Method not found" },
        id
      });
      return;
    }

    const { name: toolName, arguments: toolArgs } = params || {};
    if (!toolName || !toolSchemas[toolName]) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32601, message: `Tool not found: ${toolName}` },
        id
      });
      return;
    }

    // Validate parameters using Zod
    const schema = toolSchemas[toolName];
    const validationResult = schema.safeParse(toolArgs);
    if (!validationResult.success) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32602,
          message: "Invalid params",
          data: validationResult.error.format()
        },
        id
      });
      return;
    }

    const validatedArgs = validationResult.data;

    // Execute stateful logic per tool
    let resultText = "";
    let isError = false;

    switch (toolName) {
      case "list_instances": {
        resultText = JSON.stringify(
          instances.map(i => ({
            id: i.id,
            label: i.label,
            ip: i.main_ip,
            region: i.region,
            plan: i.plan,
            status: i.status,
            power: i.power_status,
            tags: i.tags
          })),
          null,
          2
        );
        break;
      }

      case "get_instance_status": {
        const inst = instances.find(i => i.id === validatedArgs.instance_id);
        if (!inst) {
          isError = true;
          resultText = `Failed to get instance: Instance not found: ${validatedArgs.instance_id}`;
        } else {
          resultText = JSON.stringify(inst, null, 2);
        }
        break;
      }

      case "create_snapshot": {
        const inst = instances.find(i => i.id === validatedArgs.instance_id);
        if (!inst) {
          isError = true;
          resultText = `Failed to create snapshot: Instance not found: ${validatedArgs.instance_id}`;
        } else {
          const snapshot: Snapshot = {
            id: crypto.randomUUID(),
            description: validatedArgs.description,
            status: "pending",
            size: 16106127360, // 15 GB
            date_created: new Date().toISOString()
          };
          snapshots.push(snapshot);

          // Auto-transition to complete after 100ms
          setTimeout(() => {
            snapshot.status = "complete";
          }, 100);

          resultText = JSON.stringify(
            {
              snapshot_id: snapshot.id,
              status: snapshot.status,
              description: snapshot.description,
              message: "Snapshot creation started. Use get_snapshot_status to monitor progress. It may take 5-30 minutes."
            },
            null,
            2
          );
        }
        break;
      }

      case "get_snapshot_status": {
        const snap = snapshots.find(s => s.id === validatedArgs.snapshot_id);
        if (!snap) {
          isError = true;
          resultText = `Failed to get snapshot: Snapshot not found: ${validatedArgs.snapshot_id}`;
        } else {
          resultText = JSON.stringify(
            {
              id: snap.id,
              status: snap.status,
              description: snap.description,
              size_gb: (snap.size / 1_073_741_824).toFixed(2)
            },
            null,
            2
          );
        }
        break;
      }

      case "create_ephemeral_staging": {
        const snap = snapshots.find(s => s.id === validatedArgs.snapshot_id);
        if (!snap) {
          isError = true;
          resultText = `Failed to create staging: Snapshot not found: ${validatedArgs.snapshot_id}`;
        } else if (snap.status !== "complete") {
          isError = true;
          resultText = `Failed to create staging: Snapshot ${validatedArgs.snapshot_id} is still pending`;
        } else {
          const inst: Instance = {
            id: crypto.randomUUID(),
            label: validatedArgs.label,
            main_ip: "192.0.2.2",
            region: "tlv",
            plan: "vhf-2c-4gb",
            status: "pending",
            power_status: "running",
            tags: ["vulmini", "staging", "ephemeral"]
          };
          instances.push(inst);

          // Auto-transition to active
          setTimeout(() => {
            inst.status = "active";
          }, 100);

          resultText = JSON.stringify(
            {
              instance_id: inst.id,
              ip: inst.main_ip,
              status: inst.status,
              label: inst.label,
              region: inst.region,
              plan: inst.plan,
              message: "Staging VPS created. It will take 1-5 minutes to become active. Use get_instance_status to check. Once active, you can run WP-CLI commands on it."
            },
            null,
            2
          );
        }
        break;
      }

      case "destroy_ephemeral_staging": {
        const instIdx = instances.findIndex(i => i.id === validatedArgs.instance_id);
        if (instIdx === -1) {
          isError = true;
          resultText = `Failed to destroy staging: Instance not found: ${validatedArgs.instance_id}`;
        } else {
          const inst = instances[instIdx];
          if (!inst.tags.includes("ephemeral") && !inst.tags.includes("staging")) {
            isError = true;
            resultText = `SAFETY CHECK FAILED: Instance ${inst.id} (${inst.label}) is NOT tagged as 'ephemeral' or 'staging'. Refusing to destroy. Tags: [${inst.tags.join(", ")}]`;
          } else {
            instances.splice(instIdx, 1);
            resultText = JSON.stringify(
              {
                destroyed: inst.id,
                label: inst.label,
                message: "Staging VPS destroyed successfully. Resources freed."
              },
              null,
              2
            );
          }
        }
        break;
      }

      case "list_snapshots": {
        resultText = JSON.stringify(
          snapshots.map(s => ({
            id: s.id,
            description: s.description,
            status: s.status,
            size_gb: (s.size / 1_073_741_824).toFixed(2),
            created: s.date_created
          })),
          null,
          2
        );
        break;
      }

      case "create_production_vps": {
        const inst: Instance = {
          id: crypto.randomUUID(),
          label: "vulmini-prod",
          main_ip: "192.0.2.1",
          region: "tlv",
          plan: "vhf-2c-4gb",
          status: "pending",
          power_status: "running",
          tags: ["vulmini", "production"]
        };
        instances.push(inst);

        // Auto-transition to active
        setTimeout(() => {
          inst.status = "active";
        }, 100);

        resultText = JSON.stringify(
          {
            instance_id: inst.id,
            ip: inst.main_ip,
            status: inst.status,
            message: `Production VPS deployed successfully! Configuration in .env updated with SSH_HOST=${inst.main_ip} and VULTR_PROD_INSTANCE_ID=${inst.id}.`
          },
          null,
          2
        );
        break;
      }

      case "create_clean_staging": {
        const inst: Instance = {
          id: crypto.randomUUID(),
          label: "vulmini-stage",
          main_ip: "192.0.2.2",
          region: "tlv",
          plan: "vhf-2c-4gb",
          status: "pending",
          power_status: "running",
          tags: ["vulmini", "staging"]
        };
        instances.push(inst);

        // Auto-transition to active
        setTimeout(() => {
          inst.status = "active";
        }, 100);

        resultText = JSON.stringify(
          {
            instance_id: inst.id,
            ip: inst.main_ip,
            status: inst.status,
            message: `Staging VPS deployed successfully! IP is ${inst.main_ip}. The VPS is currently clean. Remember to run set_staging_host with this IP, and then run the deploy_stack tool to install Docker and start the containers.`
          },
          null,
          2
        );
        break;
      }

      case "wp_plugin_status": {
        const target: "production" | "staging" = validatedArgs.target;
        const targetPlugins = plugins[target];
        const updatesAvailable = targetPlugins.filter(p => p.update === "available");
        resultText = JSON.stringify(
          {
            total_plugins: targetPlugins.length,
            updates_available: updatesAvailable.length,
            plugins_with_updates: updatesAvailable,
            all_plugins: targetPlugins
          },
          null,
          2
        );
        break;
      }

      case "wp_run_update": {
        const target: "production" | "staging" = validatedArgs.target;
        const slug = validatedArgs.plugin_slug;
        const targetPlugins = plugins[target];

        let count = 0;
        targetPlugins.forEach(p => {
          if (!slug || p.name === slug) {
            if (p.update === "available") {
              p.update = "none";
              if (p.update_version) {
                p.version = p.update_version;
                delete p.update_version;
              }
              count++;
            }
          }
        });

        resultText = JSON.stringify(
          {
            target,
            plugin: slug || "ALL",
            output: `Success: Updated ${count} of ${slug ? 1 : count} plugins.`,
            message: "Update completed. Run wp_health_check to verify the site is healthy."
          },
          null,
          2
        );
        break;
      }

      case "wp_db_migrate": {
        resultText = JSON.stringify(
          {
            target: validatedArgs.target,
            output: "Success: Database migrated and LearnDash upgrades completed.",
            message: "Database migration complete. Run wp_health_check to verify."
          },
          null,
          2
        );
        break;
      }

      case "wp_health_check": {
        resultText = JSON.stringify(
          {
            is_healthy: true,
            http_status: 200,
            fatal_errors_found: false,
            message: "WordPress site is healthy."
          },
          null,
          2
        );
        break;
      }

      case "wp_run_backup": {
        const backupId = `${validatedArgs.target}_backup_${Date.now()}`;
        backups.push({
          id: backupId,
          target: validatedArgs.target,
          scope: validatedArgs.scope,
          plugin_slug: validatedArgs.plugin_slug,
          date_created: new Date().toISOString()
        });

        resultText = JSON.stringify(
          {
            target: validatedArgs.target,
            scope: validatedArgs.scope,
            output: `Success: Backup created at /var/www/html/backups/backup_${backupId}.tar.gz`,
            message: "Backup created. Save the backup_id for potential rollback with wp_run_restore."
          },
          null,
          2
        );
        break;
      }

      case "wp_run_restore": {
        const backupExists = backups.some(b => b.id === validatedArgs.backup_id && b.target === validatedArgs.target);
        if (!backupExists) {
          isError = true;
          resultText = `Restore failed on ${validatedArgs.target}: Backup not found: ${validatedArgs.backup_id}`;
        } else {
          resultText = JSON.stringify(
            {
              target: validatedArgs.target,
              backup_id: validatedArgs.backup_id,
              scope: validatedArgs.scope,
              output: "Success: Restore from backup completed.",
              message: "Restore completed. Run wp_health_check to verify the site is healthy again."
            },
            null,
            2
          );
        }
        break;
      }

      case "set_staging_host": {
        stagingHost = validatedArgs.host;
        resultText = `Staging host set to ${validatedArgs.host}. WP-CLI tools can now target 'staging'.`;
        break;
      }

      case "get_system_health": {
        resultText = JSON.stringify(
          {
            cpu_cores: 2,
            load_average: [0.05, 0.08, 0.1],
            memory_used_mb: 1200,
            memory_total_mb: 4096,
            memory_usage_percent: 29.3,
            disk_used_gb: 15,
            disk_total_gb: 80,
            disk_usage_percent: 18.8,
            uptime_seconds: 3600,
            uptime_human: "1h"
          },
          null,
          2
        );
        break;
      }

      case "fetch_error_logs": {
        resultText = JSON.stringify(
          {
            target: validatedArgs.target,
            lines_requested: validatedArgs.lines,
            log_content: `[21-Jun-2026 18:13:00 UTC] PHP Notice: Simulated debug.log tail on ${validatedArgs.target}.`
          },
          null,
          2
        );
        break;
      }

      case "fetch_nginx_logs": {
        resultText = JSON.stringify(
          {
            target: validatedArgs.target,
            log_type: validatedArgs.log_type,
            lines_requested: validatedArgs.lines,
            log_content: `Simulated Nginx ${validatedArgs.log_type} log tail on ${validatedArgs.target}.`
          },
          null,
          2
        );
        break;
      }

      case "get_docker_status": {
        resultText = JSON.stringify(
          {
            target: validatedArgs.target,
            containers: [
              { name: "vulmini_db", state: "running", status: "Up 2 hours (healthy)", health: "db" },
              { name: "vulmini_cache", state: "running", status: "Up 2 hours (healthy)", health: "cache" },
              { name: "vulmini_app", state: "running", status: "Up 2 hours (healthy)", health: "app" },
              { name: "vulmini_web", state: "running", status: "Up 2 hours (healthy)", health: "web" },
              { name: "vulmini_cron", state: "running", status: "Up 2 hours (healthy)", health: "cron" }
            ],
            total: 5
          },
          null,
          2
        );
        break;
      }

      case "deploy_stack": {
        resultText = `Docker Stack deployed successfully to ${validatedArgs.target} (${validatedArgs.target === "production" ? "192.0.2.1" : stagingHost || "192.0.2.2"})!`;
        break;
      }
    }

    res.json({
      jsonrpc: "2.0",
      result: isError ? undefined : { content: [{ type: "text", text: resultText }] },
      error: isError ? { code: -32000, message: resultText } : undefined,
      id
    });
  });

  // Custom Error Handling Middleware for JSON parsing errors
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && "status" in err && err.status === 400) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null
      });
      return;
    }
    next(err);
  });

  // Nginx redirection / proxy simulation logic:
  // e.g. redirecting GET / to /mcp or redirecting HTTP to HTTPS simulation
  app.get("/nginx-redirect-test", (req, res) => {
    // Return 301 Redirect to simulate HTTPS / endpoint routing
    res.redirect(301, "https://vulmini.cdk.app/mcp");
  });

  // Reset state endpoint for multi-process test runner synchronization
  app.post("/reset", (req, res) => {
    resetState();
    res.json({ ok: true });
  });

  return app;
}

let serverInstance: any = null;
let keepAliveInterval: NodeJS.Timeout | null = null;

export function startServer(port = 3000) {
  if (process.env.MOCK_SERVER_EXTERNAL === "true") {
    console.log(`[Mock Server] Bypassing startServer because MOCK_SERVER_EXTERNAL is true`);
    return null;
  }
  const app = createServer();
  serverInstance = app.listen(port, () => {
    console.log(`[Mock Server] Running on http://localhost:${port}`);
  });

  // Set up SSE keep-alive stream comments to simulate active keep-alive
  keepAliveInterval = setInterval(() => {
    sseClients.forEach(client => {
      try {
        client.res.write(": keep-alive\n\n");
      } catch (err) {
        // Ignore write failures to disconnected clients
      }
    });
  }, 100); // 100ms interval for test agility

  return serverInstance;
}

export function stopServer() {
  if (process.env.MOCK_SERVER_EXTERNAL === "true") {
    return;
  }
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
  sseClients.forEach(c => {
    try {
      c.res.end();
    } catch {
      // Ignore
    }
  });
  sseClients = [];
}
