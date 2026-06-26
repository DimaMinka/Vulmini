// ==========================================
// VULMINI — WordPress / WP-CLI Types
// ==========================================

/** WordPress plugin info from WP-CLI `wp plugin list --format=json` */
export interface WpPlugin {
  name: string;
  status: 'active' | 'inactive' | 'must-use' | 'dropin';
  update: 'available' | 'none';
  version: string;
  update_version?: string;
  auto_update: 'on' | 'off';
}

/** WordPress core info from WP-CLI `wp core version --extra` */
export interface WpCoreInfo {
  version: string;
  db_version: string;
  locale: string;
  wp_dir: string;
}

/** WordPress health check result */
export interface WpHealthCheck {
  http_status: number;
  response_time_ms: number;
  has_fatal_errors: boolean;
  fatal_error_excerpt?: string;
  php_version: string;
  wp_version: string;
  is_healthy: boolean;
}

/** Backup result */
export interface BackupResult {
  backup_id: string;
  scope: 'full' | 'db' | 'plugin';
  files: string[];
  timestamp: string;
}

/** Restore result */
export interface RestoreResult {
  backup_id: string;
  scope: 'full' | 'db' | 'plugins';
  success: boolean;
  message: string;
}

/** System health metrics */
export interface SystemHealth {
  cpu_usage_percent: number;
  memory_used_mb: number;
  memory_total_mb: number;
  memory_usage_percent: number;
  disk_used_gb: number;
  disk_total_gb: number;
  disk_usage_percent: number;
  load_average: [number, number, number];
  uptime_seconds: number;
}

/** Docker container status */
export interface DockerContainerStatus {
  name: string;
  state: string;
  status: string;
  health?: string;
}

/** Target server for commands */
export type ServerTarget = 'production' | 'staging';
