// ==========================================
// VULMINI — WP-CLI MCP Tools
// ==========================================
// Tools for Gemini: WordPress management
// via WP-CLI inside the Docker container.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WpCliService } from "../services/wp-cli.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function getEnvPath(dirname: string): string {
  const paths = [
    path.resolve(dirname, "../../../.env"), // dev src/tools/../../..
    path.resolve(dirname, "../../.env"), // prod dist/tools/../..
    path.resolve(dirname, "../../../../.env"),
    path.resolve(dirname, ".env"),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return paths[0];
}

const targetSchema = z
  .enum(["production", "staging"])
  .describe("Target server: 'production' or 'staging'");

export function registerWpCliTools(
  server: McpServer,
  wpCli: WpCliService,
): void {
  // ── wp_plugin_status ──
  server.tool(
    "wp_plugin_status",
    "Get a JSON list of all WordPress plugins with their status, current version, and available updates. Use this to determine which plugins need updating before running wp_run_update.",
    {
      target: targetSchema,
    },
    async ({ target }) => {
      try {
        const plugins = await wpCli.getPluginStatus(target);
        const updatesAvailable = plugins.filter(
          (p) => p.update === "available",
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  total_plugins: plugins.length,
                  updates_available: updatesAvailable.length,
                  plugins_with_updates: updatesAvailable,
                  all_plugins: plugins,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Failed to get plugin status: ${error}` },
          ],
        };
      }
    },
  );

  // ── wp_run_update ──
  server.tool(
    "wp_run_update",
    "Update a specific WordPress plugin or all plugins. In the Twin-Instance workflow, always run this on staging first, then on production after verifying with wp_health_check.",
    {
      target: targetSchema,
      plugin_slug: z
        .string()
        .optional()
        .describe(
          "Specific plugin slug to update. Omit to update ALL plugins.",
        ),
    },
    async ({ target, plugin_slug }) => {
      try {
        const output = await wpCli.updatePlugins(target, plugin_slug);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  target,
                  plugin: plugin_slug ?? "ALL",
                  output,
                  message:
                    "Update completed. Run wp_health_check to verify the site is healthy.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Plugin update failed on ${target}: ${error}`,
            },
          ],
        };
      }
    },
  );

  // ── wp_db_migrate ──
  server.tool(
    "wp_db_migrate",
    "Run WordPress core database migration (wp core update-db) and LearnDash data upgrades (wp learndash data_upgrades). Execute this on production AFTER successful plugin updates and health check on staging.",
    {
      target: targetSchema,
    },
    async ({ target }) => {
      try {
        const output = await wpCli.runDbMigration(target);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  target,
                  output,
                  message:
                    "Database migration complete. Run wp_health_check to verify.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `DB migration failed on ${target}: ${error}`,
            },
          ],
        };
      }
    },
  );

  // ── wp_health_check ──
  server.tool(
    "wp_health_check",
    "Perform a health check on the WordPress site: HTTP response test (expects 200 OK) and scan for PHP Fatal Errors in logs. Returns is_healthy boolean. Use this after every update or migration to verify the site is working correctly.",
    {
      target: targetSchema,
    },
    async ({ target }) => {
      try {
        const health = await wpCli.healthCheck(target);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(health, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Health check failed on ${target}: ${error}`,
            },
          ],
        };
      }
    },
  );

  // ── wp_run_backup ──
  server.tool(
    "wp_run_backup",
    "Create a backup of the database and/or plugins BEFORE making any changes on production. This is a critical safety step in the Twin-Instance workflow. Returns a backup_id that can be used with wp_run_restore for emergency rollback.",
    {
      target: targetSchema,
      scope: z
        .enum(["full", "db", "plugin"])
        .default("full")
        .describe(
          "Backup scope: 'full' (DB + plugins), 'db' only, or 'plugin' (specific plugin)",
        ),
      plugin_slug: z
        .string()
        .optional()
        .describe("Plugin slug when scope is 'plugin'"),
    },
    async ({ target, scope, plugin_slug }) => {
      try {
        const output = await wpCli.runBackup(target, scope, plugin_slug);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  target,
                  scope,
                  output,
                  message:
                    "Backup created. Save the backup_id for potential rollback with wp_run_restore.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Backup failed on ${target}: ${error}` },
          ],
        };
      }
    },
  );

  // ── wp_run_restore ──
  server.tool(
    "wp_run_restore",
    "EMERGENCY ROLLBACK: Restore the database and/or plugins from a previous backup. Use this when production shows errors after an update. Provide the backup_id from the wp_run_backup output.",
    {
      target: targetSchema,
      backup_id: z
        .string()
        .describe(
          "The backup_id (timestamp like '20250621_143000') from wp_run_backup",
        ),
      scope: z
        .enum(["full", "db", "plugins"])
        .default("full")
        .describe("Restore scope: 'full', 'db' only, or 'plugins' only"),
    },
    async ({ target, backup_id, scope }) => {
      try {
        const output = await wpCli.runRestore(target, backup_id, scope);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  target,
                  backup_id,
                  scope,
                  output,
                  message:
                    "Restore completed. Run wp_health_check to verify the site is healthy again.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Restore failed on ${target}: ${error}` },
          ],
        };
      }
    },
  );

  // ── set_staging_host ──
  server.tool(
    "set_staging_host",
    "Set the SSH host for the staging server. Call this after create_ephemeral_staging returns an IP address, so that WP-CLI and telemetry tools can target the staging server.",
    {
      host: z.string().ip().describe("IP address of the staging VPS"),
    },
    async ({ host }) => {
      // 1. Update in-memory WpCliService
      wpCli.setStagingHost(host);

      // 2. Update process.env for telemetry tools
      process.env.VULMINI_STAGING_HOST = host;

      // 3. Write back to .env file so it persists across restarts
      try {
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const envPath = getEnvPath(__dirname);
        if (fs.existsSync(envPath)) {
          let envContent = fs.readFileSync(envPath, "utf-8");
          if (envContent.includes("VULMINI_STAGING_HOST=")) {
            envContent = envContent.replace(
              /VULMINI_STAGING_HOST=[^\r\n]*/,
              `VULMINI_STAGING_HOST=${host}`,
            );
          } else {
            envContent += `\nVULMINI_STAGING_HOST=${host}\n`;
          }
          fs.writeFileSync(envPath, envContent, "utf-8");
        }
      } catch (err) {
        console.error(
          "[Vulmini] Failed to write staging host to .env file:",
          err,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `Staging host set to ${host}. WP-CLI and telemetry tools can now target 'staging'.`,
          },
        ],
      };
    },
  );

  // ── wp_configure_preset ──
  server.tool(
    "wp_configure_preset",
    "Quickly configure a target WordPress site (staging/production) using a predefined preset/archetype (landing, blog, portfolio, woocommerce). WARNING: This resets the database first.",
    {
      target: targetSchema,
      preset: z
        .enum(["landing", "blog", "portfolio", "woocommerce"])
        .describe("The template preset to configure"),
      title: z.string().optional().describe("New site title"),
      admin_user: z.string().optional().describe("Administrator username"),
      admin_password: z.string().optional().describe("Administrator password"),
      admin_email: z.string().optional().describe("Administrator email"),
    },
    async ({
      target,
      preset,
      title,
      admin_user,
      admin_password,
      admin_email,
    }) => {
      try {
        const result = await wpCli.configurePreset(target, {
          preset,
          title,
          adminUser: admin_user,
          adminPassword: admin_password,
          adminEmail: admin_email,
        });
        return {
          content: [
            {
              type: "text",
              text: result,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to configure preset '${preset}' on ${target}: ${error}`,
            },
          ],
        };
      }
    },
  );

  // ── wp_run_command ──
  server.tool(
    "wp_run_command",
    "Execute any arbitrary WP-CLI command on the target server (e.g. 'plugin install classic-editor --activate'). Omit 'wp' prefix from command.",
    {
      target: targetSchema,
      command: z
        .string()
        .describe(
          "The WP-CLI command to run (e.g. 'plugin install classic-editor --activate')",
        ),
    },
    async ({ target, command }) => {
      try {
        const result = await wpCli.runCommand(target, command);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  target,
                  command,
                  exit_code: result.exitCode,
                  stdout: result.stdout,
                  stderr: result.stderr,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `WP-CLI command failed on ${target}: ${error}`,
            },
          ],
        };
      }
    },
  );
}
