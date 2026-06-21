// ==========================================
// VULMINI — Vultr API v2 Types
// ==========================================

/** Vultr instance status */
export type InstanceStatus = "pending" | "active" | "suspended" | "resizing";

/** Vultr power status */
export type PowerStatus = "running" | "stopped";

/** Vultr instance (VPS) */
export interface VultrInstance {
  id: string;
  region: string;
  plan: string;
  hostname: string;
  label: string;
  os: string;
  ram: number;
  disk: number;
  main_ip: string;
  v6_main_ip: string;
  status: InstanceStatus;
  power_status: PowerStatus;
  server_state: string;
  date_created: string;
  tags: string[];
  internal_ip: string;
}

/** Vultr snapshot */
export interface VultrSnapshot {
  id: string;
  date_created: string;
  description: string;
  size: number;
  compressed_size: number;
  status: "pending" | "complete";
  os_id: number;
  app_id: number;
}

/** Request to create a new instance */
export interface CreateInstanceRequest {
  region: string;
  plan: string;
  snapshot_id?: string;
  os_id?: number;
  label?: string;
  hostname?: string;
  sshkey_id?: string[];
  enable_ipv6?: boolean;
  backups?: "enabled" | "disabled";
  tags?: string[];
  firewall_group_id?: string;
}

/** Request to create a snapshot */
export interface CreateSnapshotRequest {
  instance_id: string;
  description?: string;
}

/** Vultr API list response wrapper */
export interface VultrListResponse<T> {
  meta: {
    total: number;
    links: {
      next: string;
      prev: string;
    };
  };
  [key: string]: T[] | VultrListResponse<T>["meta"];
}

/** Vultr Object Storage subscription */
export interface VultrObjectStorage {
  id: string;
  date_created: string;
  cluster_id: number;
  region: string;
  label: string;
  status: string;
  s3_hostname: string;
  s3_access_key: string;
  s3_secret_key: string;
}

/** MCP server configuration for Vultr */
export interface VulminiConfig {
  vultrApiKey: string;
  vultrRegion: string;
  vultrPlan: string;
  prodInstanceId: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshPrivateKeyPath: string;
}
