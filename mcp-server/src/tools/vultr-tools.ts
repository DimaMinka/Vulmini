// ==========================================
// VULMINI — Vultr MCP Tools
// ==========================================
// Инструменты для Gemini: управление VPS и снапшотами
// через Vultr API v2. Ядро паттерна «Близнецов».

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VultrApiClient } from "../services/vultr-api.js";

export function registerVultrTools(
  server: McpServer,
  vultr: VultrApiClient,
  defaultConfig: { region: string; plan: string }
): void {
  // ── list_instances ──
  server.tool(
    "list_instances",
    "List all Vultr VPS instances with their status, IP, and region",
    {},
    async () => {
      try {
        const instances = await vultr.listInstances();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                instances.map((i) => ({
                  id: i.id,
                  label: i.label,
                  ip: i.main_ip,
                  region: i.region,
                  plan: i.plan,
                  status: i.status,
                  power: i.power_status,
                  tags: i.tags,
                })),
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to list instances: ${error}` }],
        };
      }
    }
  );

  // ── get_instance_status ──
  server.tool(
    "get_instance_status",
    "Get detailed status of a specific Vultr VPS instance",
    {
      instance_id: z.string().uuid().describe("Vultr instance UUID"),
    },
    async ({ instance_id }) => {
      try {
        const instance = await vultr.getInstance(instance_id);
        return {
          content: [{ type: "text", text: JSON.stringify(instance, null, 2) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to get instance: ${error}` }],
        };
      }
    }
  );

  // ── create_snapshot ──
  server.tool(
    "create_snapshot",
    "Create a snapshot of a Vultr VPS instance. Use this before creating a staging environment. Returns immediately — use get_snapshot_status to check progress.",
    {
      instance_id: z.string().uuid().describe("Instance UUID to snapshot"),
      description: z
        .string()
        .default("Vulmini auto-snapshot")
        .describe("Human-readable description for the snapshot"),
    },
    async ({ instance_id, description }) => {
      try {
        const snapshot = await vultr.createSnapshot({
          instance_id,
          description,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  snapshot_id: snapshot.id,
                  status: snapshot.status,
                  description: snapshot.description,
                  message:
                    "Snapshot creation started. Use get_snapshot_status to monitor progress. It may take 5-30 minutes.",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to create snapshot: ${error}` }],
        };
      }
    }
  );

  // ── get_snapshot_status ──
  server.tool(
    "get_snapshot_status",
    "Check the status of a Vultr snapshot (pending/complete)",
    {
      snapshot_id: z.string().describe("Snapshot UUID"),
    },
    async ({ snapshot_id }) => {
      try {
        const snapshot = await vultr.getSnapshot(snapshot_id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: snapshot.id,
                  status: snapshot.status,
                  description: snapshot.description,
                  size_gb: (snapshot.size / 1_073_741_824).toFixed(2),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to get snapshot: ${error}` }],
        };
      }
    }
  );

  // ── create_ephemeral_staging ──
  server.tool(
    "create_ephemeral_staging",
    "Create a temporary staging VPS from a production snapshot. This is step 1 of the Twin-Instance update loop. The staging server will be an exact clone of production. Returns the new instance ID and IP — wait for status 'active' before running commands.",
    {
      snapshot_id: z.string().describe("Snapshot ID to deploy from"),
      label: z
        .string()
        .default("vulmini-staging-ephemeral")
        .describe("Label for the staging instance"),
    },
    async ({ snapshot_id, label }) => {
      try {
        const instance = await vultr.createInstance({
          region: defaultConfig.region,
          plan: defaultConfig.plan,
          snapshot_id,
          label,
          tags: ["vulmini", "staging", "ephemeral"],
          enable_ipv6: true,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  instance_id: instance.id,
                  ip: instance.main_ip,
                  status: instance.status,
                  label: instance.label,
                  region: instance.region,
                  plan: instance.plan,
                  message:
                    "Staging VPS created. It will take 1-5 minutes to become active. Use get_instance_status to check. Once active, you can run WP-CLI commands on it.",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Failed to create staging: ${error}` },
          ],
        };
      }
    }
  );

  // ── destroy_ephemeral_staging ──
  server.tool(
    "destroy_ephemeral_staging",
    "Permanently destroy an ephemeral staging VPS after testing is complete. This is the final step of the Twin-Instance update loop. WARNING: This action is irreversible.",
    {
      instance_id: z
        .string()
        .uuid()
        .describe("UUID of the staging instance to destroy"),
    },
    async ({ instance_id }) => {
      try {
        // Safety check: verify it's tagged as ephemeral staging
        const instance = await vultr.getInstance(instance_id);
        if (
          !instance.tags.includes("ephemeral") &&
          !instance.tags.includes("staging")
        ) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `SAFETY CHECK FAILED: Instance ${instance_id} (${instance.label}) is NOT tagged as 'ephemeral' or 'staging'. Refusing to destroy. Tags: [${instance.tags.join(", ")}]`,
              },
            ],
          };
        }

        await vultr.deleteInstance(instance_id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  destroyed: instance_id,
                  label: instance.label,
                  message: "Staging VPS destroyed successfully. Resources freed.",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Failed to destroy staging: ${error}` },
          ],
        };
      }
    }
  );

  // ── list_snapshots ──
  server.tool(
    "list_snapshots",
    "List all Vultr snapshots with their status and size",
    {},
    async () => {
      try {
        const snapshots = await vultr.listSnapshots();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                snapshots.map((s) => ({
                  id: s.id,
                  description: s.description,
                  status: s.status,
                  size_gb: (s.size / 1_073_741_824).toFixed(2),
                  created: s.date_created,
                })),
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to list snapshots: ${error}` }],
        };
      }
    }
  );
}
