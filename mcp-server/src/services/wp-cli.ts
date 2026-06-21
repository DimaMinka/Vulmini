// ==========================================
// VULMINI — WP-CLI Service
// ==========================================
// Wrapper for WP-CLI to execute WordPress commands
// via SSH inside the vulmini_app Docker container.

import type { SshExecutor, SshCommandResult } from "./ssh-executor.js";
import type {
  WpPlugin,
  WpHealthCheck,
  BackupResult,
  RestoreResult,
  ServerTarget,
} from "../types/wordpress.js";

/** Map of server targets to SSH hosts */
export interface TargetHostMap {
  production: string;
  staging?: string;
}

export class WpCliService {
  private ssh: SshExecutor;
  private targets: TargetHostMap;
  private containerName = "vulmini_app";

  constructor(ssh: SshExecutor, targets: TargetHostMap) {
    this.ssh = ssh;
    this.targets = targets;
  }

  /**
   * Set staging host dynamically (after creating ephemeral staging VPS)
   */
  setStagingHost(host: string): void {
    this.targets.staging = host;
  }

  /**
   * Clear staging host (after destroying staging VPS)
   */
  clearStagingHost(): void {
    this.targets.staging = undefined;
  }

  /**
   * Resolve target to SSH host
   */
  private getHost(target: ServerTarget): string {
    if (target === "staging") {
      if (!this.targets.staging) {
        throw new Error(
          "Staging host not set. Create an ephemeral staging instance first.",
        );
      }
      return this.targets.staging;
    }
    return this.targets.production;
  }

  /**
   * Execute a WP-CLI command on the target server.
   * Commands are run inside the vulmini_app Docker container.
   */
  private async wp(
    target: ServerTarget,
    command: string,
    timeoutMs?: number,
  ): Promise<SshCommandResult> {
    const host = this.getHost(target);
    return this.ssh.executeInContainer(
      this.containerName,
      `wp ${command} --allow-root`,
      { host, timeoutMs },
    );
  }

  // ── Plugin Management ──

  /** Get list of all plugins with their status and updates */
  async getPluginStatus(target: ServerTarget): Promise<WpPlugin[]> {
    const result = await this.wp(
      target,
      "plugin list --format=json --fields=name,status,update,version,update_version,auto_update",
    );
    if (result.exitCode !== 0) {
      throw new Error(`WP-CLI plugin list failed: ${result.stderr}`);
    }
    return JSON.parse(result.stdout) as WpPlugin[];
  }

  /** Update a specific plugin or all plugins */
  async updatePlugins(
    target: ServerTarget,
    pluginSlug?: string,
  ): Promise<string> {
    const slugArg = pluginSlug ?? "--all";
    const result = await this.wp(
      target,
      `plugin update ${slugArg}`,
      300_000, // 5 min timeout for updates
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Plugin update failed: ${result.stderr}\n${result.stdout}`,
      );
    }
    return result.stdout;
  }

  // ── Database Migration ──

  /** Run WordPress core database migration + LearnDash data upgrades */
  async runDbMigration(target: ServerTarget): Promise<string> {
    const host = this.getHost(target);
    const results: string[] = [];

    // 1. WordPress core DB update
    const coreResult = await this.wp(target, "core update-db", 120_000);
    results.push(
      `[core update-db] exit=${coreResult.exitCode}\n${coreResult.stdout}`,
    );

    // 2. LearnDash data upgrades
    const ldResult = await this.ssh.executeInContainer(
      this.containerName,
      "wp learndash data_upgrades --allow-root 2>&1 || echo 'LearnDash data_upgrades not available'",
      { host, timeoutMs: 300_000 },
    );
    results.push(
      `[learndash data_upgrades] exit=${ldResult.exitCode}\n${ldResult.stdout}`,
    );

    return results.join("\n\n");
  }

  // ── Health Check ──

  /** Perform HTTP health check + check logs for fatal errors */
  async healthCheck(target: ServerTarget): Promise<WpHealthCheck> {
    const host = this.getHost(target);

    // 1. HTTP response check (follow redirect, ignore self-signed SSL errors)
    const curlResult = await this.ssh.execute(
      `curl -sL -k -o /dev/null -w '{"http_status":%{http_code},"response_time_ms":%{time_total}}' --max-time 30 http://localhost`,
      { host },
    );

    let httpStatus = 0;
    let responseTimeMs = 0;
    try {
      const curlData = JSON.parse(curlResult.stdout);
      httpStatus = curlData.http_status;
      responseTimeMs = Math.round(curlData.response_time_ms * 1000);
    } catch {
      httpStatus = 0;
      responseTimeMs = 0;
    }

    // 2. Check for PHP Fatal Errors in logs
    const logResult = await this.ssh.executeInContainer(
      this.containerName,
      "sh -c \"cat /var/www/html/wp-content/debug.log 2>/dev/null | tail -50 | grep -i 'Fatal error' || echo ''\"",
      { host },
    );
    const hasFatalErrors = logResult.stdout.trim().length > 0;
    const fatalExcerpt = hasFatalErrors
      ? logResult.stdout.trim().slice(0, 500)
      : undefined;

    // 3. Get WP and PHP versions
    const versionResult = await this.wp(target, "core version");
    const phpResult = await this.ssh.executeInContainer(
      this.containerName,
      'php -r "echo PHP_VERSION;"',
      { host },
    );

    return {
      http_status: httpStatus,
      response_time_ms: responseTimeMs,
      has_fatal_errors: hasFatalErrors,
      fatal_error_excerpt: fatalExcerpt,
      php_version: phpResult.stdout.trim(),
      wp_version: versionResult.stdout.trim(),
      is_healthy: httpStatus === 200 && !hasFatalErrors,
    };
  }

  // ── Backup / Restore ──

  /** Run backup script on the target server */
  async runBackup(
    target: ServerTarget,
    scope: "full" | "db" | "plugin",
    pluginSlug?: string,
  ): Promise<string> {
    const host = this.getHost(target);
    const args =
      scope === "plugin" && pluginSlug ? `plugin ${pluginSlug}` : scope;

    const result = await this.ssh.executeInContainer(
      this.containerName,
      `sh /var/www/html/wp-content/../scripts/backup.sh ${args}`,
      { host, timeoutMs: 300_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Backup failed: ${result.stderr}\n${result.stdout}`);
    }
    return result.stdout;
  }

  /** Run restore script on the target server */
  async runRestore(
    target: ServerTarget,
    backupId: string,
    scope: "full" | "db" | "plugins" = "full",
  ): Promise<string> {
    const host = this.getHost(target);
    const result = await this.ssh.executeInContainer(
      this.containerName,
      `sh /var/www/html/wp-content/../scripts/restore.sh ${backupId} ${scope}`,
      { host, timeoutMs: 300_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Restore failed: ${result.stderr}\n${result.stdout}`);
    }
    return result.stdout;
  }
}
