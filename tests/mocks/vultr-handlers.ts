// ==========================================
// VULMINI Mock Server — Vultr Handlers
// ==========================================
// Handles tool calls for Vultr instance and
// snapshot management (Twin-Instance pattern).

import crypto from 'node:crypto';
import { instances, snapshots, type Instance, type Snapshot } from './state.js';

/** Handle Vultr-domain tool calls. Returns null for unknown tool names. */
export function handleVultrTool(
  toolName: string,
  args: Record<string, any>,
): { resultText: string; isError: boolean } | null {
  let resultText = '';
  let isError = false;

  switch (toolName) {
    case 'list_instances': {
      resultText = JSON.stringify(
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
        2,
      );
      break;
    }

    case 'get_instance_status': {
      const inst = instances.find((i) => i.id === args.instance_id);
      if (!inst) {
        isError = true;
        resultText = `Failed to get instance: Instance not found: ${args.instance_id}`;
      } else {
        resultText = JSON.stringify(inst, null, 2);
      }
      break;
    }

    case 'create_snapshot': {
      const inst = instances.find((i) => i.id === args.instance_id);
      if (!inst) {
        isError = true;
        resultText = `Failed to create snapshot: Instance not found: ${args.instance_id}`;
      } else {
        const snapshot: Snapshot = {
          id: crypto.randomUUID(),
          description: args.description,
          status: 'pending',
          size: 16_106_127_360, // 15 GB
          date_created: new Date().toISOString(),
        };
        snapshots.push(snapshot);

        // Auto-transition to complete after 100ms
        setTimeout(() => { snapshot.status = 'complete'; }, 100);

        resultText = JSON.stringify({
          snapshot_id: snapshot.id,
          status: snapshot.status,
          description: snapshot.description,
          message: 'Snapshot creation started. Use get_snapshot_status to monitor progress. It may take 5-30 minutes.',
        }, null, 2);
      }
      break;
    }

    case 'get_snapshot_status': {
      const snap = snapshots.find((s) => s.id === args.snapshot_id);
      if (!snap) {
        isError = true;
        resultText = `Failed to get snapshot: Snapshot not found: ${args.snapshot_id}`;
      } else {
        resultText = JSON.stringify({
          id: snap.id,
          status: snap.status,
          description: snap.description,
          size_gb: (snap.size / 1_073_741_824).toFixed(2),
        }, null, 2);
      }
      break;
    }

    case 'create_ephemeral_staging': {
      const snap = snapshots.find((s) => s.id === args.snapshot_id);
      if (!snap) {
        isError = true;
        resultText = `Failed to create staging: Snapshot not found: ${args.snapshot_id}`;
      } else if (snap.status !== 'complete') {
        isError = true;
        resultText = `Failed to create staging: Snapshot ${args.snapshot_id} is still pending`;
      } else {
        const inst: Instance = {
          id: crypto.randomUUID(),
          label: args.label,
          main_ip: '192.0.2.2',
          region: 'tlv',
          plan: 'vhf-2c-4gb',
          status: 'pending',
          power_status: 'running',
          tags: ['vulmini', 'staging', 'ephemeral'],
        };
        instances.push(inst);
        setTimeout(() => { inst.status = 'active'; }, 100);

        resultText = JSON.stringify({
          instance_id: inst.id,
          ip: inst.main_ip,
          status: inst.status,
          label: inst.label,
          region: inst.region,
          plan: inst.plan,
          message: 'Staging VPS created. It will take 1-5 minutes to become active. Use get_instance_status to check. Once active, you can run WP-CLI commands on it.',
        }, null, 2);
      }
      break;
    }

    case 'destroy_ephemeral_staging': {
      const idx = instances.findIndex((i) => i.id === args.instance_id);
      if (idx === -1) {
        isError = true;
        resultText = `Failed to destroy staging: Instance not found: ${args.instance_id}`;
      } else {
        const inst = instances[idx];
        if (!inst.tags.includes('ephemeral') && !inst.tags.includes('staging')) {
          isError = true;
          resultText = `SAFETY CHECK FAILED: Instance ${inst.id} (${inst.label}) is NOT tagged as 'ephemeral' or 'staging'. Refusing to destroy. Tags: [${inst.tags.join(', ')}]`;
        } else {
          instances.splice(idx, 1);
          resultText = JSON.stringify({
            destroyed: inst.id,
            label: inst.label,
            message: 'Staging VPS destroyed successfully. Resources freed.',
          }, null, 2);
        }
      }
      break;
    }

    case 'list_snapshots': {
      resultText = JSON.stringify(
        snapshots.map((s) => ({
          id: s.id,
          description: s.description,
          status: s.status,
          size_gb: (s.size / 1_073_741_824).toFixed(2),
          created: s.date_created,
        })),
        null,
        2,
      );
      break;
    }

    case 'create_production_vps': {
      const inst: Instance = {
        id: crypto.randomUUID(),
        label: 'vulmini-prod',
        main_ip: '192.0.2.1',
        region: 'tlv',
        plan: 'vhf-2c-4gb',
        status: 'pending',
        power_status: 'running',
        tags: ['vulmini', 'production'],
      };
      instances.push(inst);
      setTimeout(() => { inst.status = 'active'; }, 100);

      resultText = JSON.stringify({
        instance_id: inst.id,
        ip: inst.main_ip,
        status: inst.status,
        message: `Production VPS deployed successfully! Configuration in .env updated with SSH_HOST=${inst.main_ip} and VULTR_PROD_INSTANCE_ID=${inst.id}.`,
      }, null, 2);
      break;
    }

    case 'create_clean_staging': {
      const inst: Instance = {
        id: crypto.randomUUID(),
        label: 'vulmini-stage',
        main_ip: '192.0.2.2',
        region: 'tlv',
        plan: 'vhf-2c-4gb',
        status: 'pending',
        power_status: 'running',
        tags: ['vulmini', 'staging'],
      };
      instances.push(inst);
      setTimeout(() => { inst.status = 'active'; }, 100);

      resultText = JSON.stringify({
        instance_id: inst.id,
        ip: inst.main_ip,
        status: inst.status,
        message: `Staging VPS deployed successfully! IP is ${inst.main_ip}. The VPS is currently clean. Remember to run set_staging_host with this IP, and then run the deploy_stack tool to install Docker and start the containers.`,
      }, null, 2);
      break;
    }

    default:
      return null; // Not a Vultr tool — pass to next handler
  }

  return { resultText, isError };
}
