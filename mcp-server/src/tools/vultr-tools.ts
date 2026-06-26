// ==========================================
// VULMINI — Vultr MCP Tools
// ==========================================
// Tools for Gemini: VPS and snapshot management
// via Vultr API v2. Core of the "Twin-Instance" pattern.
//
// Sections:
//   1. Instance Management
//   2. Snapshot Management
//   3. Ephemeral Staging
//   4. Production VPS Provisioning

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { VultrApiClient } from '../services/vultr-api.js';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Wrap any value as MCP tool text content. */
function jsonContent(data: unknown): { content: [{ type: 'text'; text: string }] } {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

/** Wrap an error string as a failed MCP tool response. */
function errorContent(message: string): {
  isError: true;
  content: [{ type: 'text'; text: string }];
} {
  return { isError: true as const, content: [{ type: 'text' as const, text: message }] };
}

function getEnvPath(dirname: string): string {
  const paths = [
    path.resolve(dirname, '../../../.env'), // dev src/tools/../../..
    path.resolve(dirname, '../../.env'), // prod dist/tools/../..
    path.resolve(dirname, '../../../../.env'),
    path.resolve(dirname, '.env'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return paths[0];
}

export function registerVultrTools(
  server: McpServer,
  vultr: VultrApiClient,
  defaultConfig: { region: string; plan: string }
): void {
  // ── 1. Instance Management ───────────────────────────────────────────────────

  // ── list_instances ──
  server.tool(
    'list_instances',
    'List all Vultr VPS instances with their status, IP, and region',
    {},
    async () => {
      try {
        const instances = await vultr.listInstances();
        return jsonContent(
          instances.map((i) => ({
            id: i.id,
            label: i.label,
            ip: i.main_ip,
            region: i.region,
            plan: i.plan,
            status: i.status,
            power: i.power_status,
            tags: i.tags,
          }))
        );
      } catch (error) {
        return errorContent(`Failed to list instances: ${error}`);
      }
    }
  );

  // ── get_instance_status ──
  server.tool(
    'get_instance_status',
    'Get detailed status of a specific Vultr VPS instance',
    {
      instance_id: z.string().uuid().describe('Vultr instance UUID'),
    },
    async ({ instance_id }) => {
      try {
        const instance = await vultr.getInstance(instance_id);
        return {
          content: [{ type: 'text', text: JSON.stringify(instance, null, 2) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to get instance: ${error}` }],
        };
      }
    }
  );

  // ── 2. Snapshot Management ────────────────────────────────────────────────

  // ── create_snapshot ──
  server.tool(
    'create_snapshot',
    'Create a snapshot of a Vultr VPS instance. Use this before creating a staging environment. Returns immediately — use get_snapshot_status to check progress.',
    {
      instance_id: z.string().uuid().describe('Instance UUID to snapshot'),
      description: z
        .string()
        .default('Vulmini auto-snapshot')
        .describe('Human-readable description for the snapshot'),
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
              type: 'text',
              text: JSON.stringify(
                {
                  snapshot_id: snapshot.id,
                  status: snapshot.status,
                  description: snapshot.description,
                  message:
                    'Snapshot creation started. Use get_snapshot_status to monitor progress. It may take 5-30 minutes.',
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
          content: [{ type: 'text', text: `Failed to create snapshot: ${error}` }],
        };
      }
    }
  );

  // ── get_snapshot_status ──
  server.tool(
    'get_snapshot_status',
    'Check the status of a Vultr snapshot (pending/complete)',
    {
      snapshot_id: z.string().describe('Snapshot UUID'),
    },
    async ({ snapshot_id }) => {
      try {
        const snapshot = await vultr.getSnapshot(snapshot_id);
        return {
          content: [
            {
              type: 'text',
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
          content: [{ type: 'text', text: `Failed to get snapshot: ${error}` }],
        };
      }
    }
  );

  // ── 3. Ephemeral Staging ───────────────────────────────────────────────────

  // ── create_ephemeral_staging ──
  server.tool(
    'create_ephemeral_staging',
    "Create a temporary staging VPS from a production snapshot. This is step 1 of the Twin-Instance update loop. The staging server will be an exact clone of production. Returns the new instance ID and IP — wait for status 'active' before running commands.",
    {
      snapshot_id: z.string().describe('Snapshot ID to deploy from'),
      label: z
        .string()
        .default('vulmini-staging-ephemeral')
        .describe('Label for the staging instance'),
    },
    async ({ snapshot_id, label }) => {
      try {
        const instance = await vultr.createInstance({
          region: defaultConfig.region,
          plan: defaultConfig.plan,
          snapshot_id,
          label,
          tags: ['vulmini', 'staging', 'ephemeral'],
          enable_ipv6: true,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  instance_id: instance.id,
                  ip: instance.main_ip,
                  status: instance.status,
                  label: instance.label,
                  region: instance.region,
                  plan: instance.plan,
                  message:
                    'Staging VPS created. It will take 1-5 minutes to become active. Use get_instance_status to check. Once active, you can run WP-CLI commands on it.',
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
          content: [{ type: 'text', text: `Failed to create staging: ${error}` }],
        };
      }
    }
  );

  // ── destroy_ephemeral_staging ──
  server.tool(
    'destroy_ephemeral_staging',
    'Permanently destroy an ephemeral staging VPS after testing is complete. This is the final step of the Twin-Instance update loop. WARNING: This action is irreversible.',
    {
      instance_id: z.string().uuid().describe('UUID of the staging instance to destroy'),
    },
    async ({ instance_id }) => {
      try {
        // Safety check: verify it's tagged as ephemeral staging
        const instance = await vultr.getInstance(instance_id);
        if (!instance.tags.includes('ephemeral') && !instance.tags.includes('staging')) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `SAFETY CHECK FAILED: Instance ${instance_id} (${instance.label}) is NOT tagged as 'ephemeral' or 'staging'. Refusing to destroy. Tags: [${instance.tags.join(', ')}]`,
              },
            ],
          };
        }

        await vultr.deleteInstance(instance_id);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  destroyed: instance_id,
                  label: instance.label,
                  message: 'Staging VPS destroyed successfully. Resources freed.',
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
          content: [{ type: 'text', text: `Failed to destroy staging: ${error}` }],
        };
      }
    }
  );

  // ── list_snapshots ──
  server.tool(
    'list_snapshots',
    'List all Vultr snapshots with their status and size',
    {},
    async () => {
      try {
        const snapshots = await vultr.listSnapshots();
        return {
          content: [
            {
              type: 'text',
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
          content: [{ type: 'text', text: `Failed to list snapshots: ${error}` }],
        };
      }
    }
  );

  // ── 4. Production VPS Provisioning ───────────────────────────────────────────

  // ── create_production_vps ──
  server.tool(
    'create_production_vps',
    'Deploy a new production VPS on Vultr, set up SSH key, wait for activation, and update project .env file with the IP',
    {},
    async () => {
      try {
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const envPath = getEnvPath(__dirname);
        let envContent = '';
        try {
          envContent = fs.readFileSync(envPath, 'utf-8');
        } catch (e) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Could not read .env file at ${envPath}: ${e}`,
              },
            ],
          };
        }

        const getEnvVal = (name: string) => {
          const match = envContent.match(new RegExp(`${name}=([^\\r\\n]*)`));
          return match ? match[1].trim() : null;
        };

        const sshKeyPathRaw = getEnvVal('SSH_PRIVATE_KEY_PATH') || '~/.ssh/vulmini_rsa';
        const sshKeyPath = sshKeyPathRaw.replace(/^~/, homedir());
        const pubKeyPath = sshKeyPath + '.pub';

        if (!fs.existsSync(pubKeyPath)) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `SSH public key not found at: ${pubKeyPath}. Please generate it first or check your SSH_PRIVATE_KEY_PATH in .env`,
              },
            ],
          };
        }

        const sshPublicKeyContent = fs.readFileSync(pubKeyPath, 'utf-8').trim();

        // 1. Check SSH Keys on Vultr
        const keysData = await vultr.listSshKeys();
        let sshKeyId = null;

        const existingKey = keysData.ssh_keys.find(
          (k) => k.name === 'vulmini-key' || k.ssh_key.includes(sshPublicKeyContent.slice(10, 50))
        );

        if (existingKey) {
          sshKeyId = existingKey.id;
        } else {
          const newKey = await vultr.createSshKey('vulmini-key', sshPublicKeyContent);
          sshKeyId = newKey.ssh_key.id;
        }

        // 2. Create Instance
        const plan = getEnvVal('VULTR_PROD_PLAN') || defaultConfig.plan;
        const region = getEnvVal('VULTR_PROD_REGION') || defaultConfig.region || 'tlv';

        const instance = await vultr.createInstance({
          region: region,
          plan: plan,
          os_id: 2284, // Ubuntu 24.04
          label: 'vulmini-prod',
          hostname: 'vulmini-prod',
          sshkey_id: [sshKeyId],
          enable_ipv6: true,
          tags: ['vulmini', 'production'],
        });

        const instanceId = instance.id;

        // 3. Wait for it to become active
        const activeInstance = await vultr.waitForInstanceActive(instanceId);
        const ip = activeInstance.main_ip;

        // 4. Update .env
        envContent = envContent.replace(/SSH_HOST=[^\r\n]*/, `SSH_HOST=${ip}`);
        envContent = envContent.replace(
          /VULTR_PROD_INSTANCE_ID=[^\r\n]*/,
          `VULTR_PROD_INSTANCE_ID=${instanceId}`
        );
        fs.writeFileSync(envPath, envContent, 'utf-8');

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  instance_id: instanceId,
                  ip: ip,
                  status: activeInstance.status,
                  message: `Production VPS deployed successfully! Configuration in .env updated with SSH_HOST=${ip} and VULTR_PROD_INSTANCE_ID=${instanceId}.`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to create production VPS: ${msg}` }],
        };
      }
    }
  );

  // ── create_clean_staging ──
  server.tool(
    'create_clean_staging',
    'Deploy a new clean staging VPS from scratch on Vultr (not from a snapshot), set up SSH key, wait for activation, and return the IP',
    {},
    async () => {
      try {
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const envPath = getEnvPath(__dirname);
        let envContent = '';
        try {
          envContent = fs.readFileSync(envPath, 'utf-8');
        } catch (e) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Could not read .env file at ${envPath}: ${e}`,
              },
            ],
          };
        }

        const getEnvVal = (name: string) => {
          const match = envContent.match(new RegExp(`${name}=([^\\r\\n]*)`));
          return match ? match[1].trim() : null;
        };

        const sshKeyPathRaw = getEnvVal('SSH_PRIVATE_KEY_PATH') || '~/.ssh/vulmini_rsa';
        const sshKeyPath = sshKeyPathRaw.replace(/^~/, homedir());
        const pubKeyPath = sshKeyPath + '.pub';

        if (!fs.existsSync(pubKeyPath)) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `SSH public key not found at: ${pubKeyPath}. Please generate it first or check your SSH_PRIVATE_KEY_PATH in .env`,
              },
            ],
          };
        }

        const sshPublicKeyContent = fs.readFileSync(pubKeyPath, 'utf-8').trim();

        // 1. Check SSH Keys on Vultr
        const keysData = await vultr.listSshKeys();
        let sshKeyId = null;

        const existingKey = keysData.ssh_keys.find(
          (k) => k.name === 'vulmini-key' || k.ssh_key.includes(sshPublicKeyContent.slice(10, 50))
        );

        if (existingKey) {
          sshKeyId = existingKey.id;
        } else {
          const newKey = await vultr.createSshKey('vulmini-key', sshPublicKeyContent);
          sshKeyId = newKey.ssh_key.id;
        }

        const stagePlan = getEnvVal('VULTR_STAGE_PLAN') || defaultConfig.plan;
        const stageRegion = getEnvVal('VULTR_STAGE_REGION') || 'lhr';

        // 2. Create Instance
        const instance = await vultr.createInstance({
          region: stageRegion,
          plan: stagePlan,
          os_id: 2284, // Ubuntu 24.04
          label: 'vulmini-stage',
          hostname: 'vulmini-stage',
          sshkey_id: [sshKeyId],
          enable_ipv6: true,
          tags: ['vulmini', 'staging'],
        });

        const instanceId = instance.id;

        // 3. Wait for it to become active
        const activeInstance = await vultr.waitForInstanceActive(instanceId);
        const ip = activeInstance.main_ip;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  instance_id: instanceId,
                  ip: ip,
                  status: activeInstance.status,
                  message: `Staging VPS deployed successfully! IP is ${ip}. The VPS is currently clean. Remember to run set_staging_host with this IP, and then run the deploy_stack tool to install Docker and start the containers.`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to create staging VPS: ${msg}` }],
        };
      }
    }
  );
}
