// ==========================================
// VULMINI Mock Server — Shared State
// ==========================================
// All stateful in-memory data for the mock server.
// Imported by domain handler modules.

import crypto from 'node:crypto';

// ── Types ──────────────────────────────────────────────────────────────────

export interface Instance {
  id: string;
  label: string;
  main_ip: string;
  region: string;
  plan: string;
  status: 'pending' | 'active';
  power_status: 'running' | 'stopped';
  tags: string[];
}

export interface Snapshot {
  id: string;
  description: string;
  status: 'pending' | 'complete';
  size: number;
  date_created: string;
}

export interface Backup {
  id: string;
  target: 'production' | 'staging';
  scope: 'full' | 'db' | 'plugin';
  plugin_slug?: string;
  date_created: string;
}

export interface Plugin {
  name: string;
  status: 'active' | 'inactive';
  update: 'available' | 'none';
  version: string;
  update_version?: string;
}

// ── Default plugin fixtures ─────────────────────────────────────────────────

const defaultPlugins = (): Record<'production' | 'staging', Plugin[]> => ({
  production: [
    { name: 'sfwd-lms', status: 'active', update: 'available', version: '4.10.0', update_version: '4.11.0' },
    { name: 'classic-editor', status: 'active', update: 'none', version: '1.6.3' },
  ],
  staging: [
    { name: 'sfwd-lms', status: 'active', update: 'available', version: '4.10.0', update_version: '4.11.0' },
    { name: 'classic-editor', status: 'active', update: 'none', version: '1.6.3' },
  ],
});

// ── Mutable state ──────────────────────────────────────────────────────────

export let instances: Instance[] = [];
export let snapshots: Snapshot[] = [];
export let backups: Backup[] = [];
export let stagingHost: string | null = null;
export let plugins: Record<'production' | 'staging', Plugin[]> = defaultPlugins();

/** Reset all state to defaults (called between test suites). */
export function resetState(): void {
  instances = [];
  snapshots = [];
  backups = [];
  stagingHost = null;
  plugins = defaultPlugins();
}

/** Set staging host (called by set_staging_host tool mock). */
export function setStagingHost(host: string): void {
  stagingHost = host;
}

export { crypto };
