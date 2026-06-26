// ==========================================
// VULMINI — WP-CLI Service
// ==========================================
// Wrapper for WP-CLI to execute WordPress commands
// via SSH inside the vulmini_app Docker container.

import fs from "node:fs";
import path from "node:path";
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
    try {
      const paths = [
        path.resolve(process.cwd(), ".env"),
        path.resolve(process.cwd(), "../.env"),
        "/var/www/vulmini-mcp/.env",
      ];
      let envPath = "";
      for (const p of paths) {
        if (fs.existsSync(p)) {
          envPath = p;
          break;
        }
      }
      if (envPath) {
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
      console.error("[Vulmini] Error reloading .env in getHost:", e);
    }

    if (target === "staging") {
      const stagingHost = process.env.VULMINI_STAGING_HOST;
      if (!stagingHost) {
        throw new Error(
          "Staging host not set. Create an ephemeral staging instance first.",
        );
      }
      return stagingHost;
    }
    
    const prodHost = process.env.SSH_HOST;
    if (!prodHost) {
      throw new Error(
        "Production host not configured under SSH_HOST in .env",
      );
    }
    return prodHost;
  }

  /**
   * Execute a WP-CLI command on the target server.
   * Commands are run inside the vulmini_app Docker container.
   */
  async runCommand(
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

  /**
   * Execute a WP-CLI command on the target server.
   * Commands are run inside the vulmini_app Docker container.
   */
  private async wp(
    target: ServerTarget,
    command: string,
    timeoutMs?: number,
  ): Promise<SshCommandResult> {
    return this.runCommand(target, command, timeoutMs);
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

  /** Configure a WordPress site with a predefined preset/archetype */
  async configurePreset(
    target: ServerTarget,
    options: {
      preset: "landing" | "blog" | "portfolio" | "woocommerce";
      title?: string;
      adminUser?: string;
      adminPassword?: string;
      adminEmail?: string;
    },
  ): Promise<string> {
    const host = this.getHost(target);
    const title = options.title || "Vulmini WordPress Site";
    const adminUser = options.adminUser || "admin";
    const adminPassword = options.adminPassword || "VulminiAdminSecurePass123!";
    const adminEmail = options.adminEmail || "admin@example.com";

    // 1. Get current site URL before reset
    let siteUrl = "http://localhost";
    try {
      const urlRes = await this.ssh.executeInContainer(
        this.containerName,
        "wp option get siteurl --allow-root",
        { host },
      );
      if (urlRes.exitCode === 0 && urlRes.stdout.trim()) {
        siteUrl = urlRes.stdout.trim();
      }
    } catch {
      // Ignore and use default
    }

    try {
      // 2. Reset database
      console.log(`[Vulmini] Resetting database on target ${target}...`);
      const resetRes = await this.ssh.executeInContainer(
        this.containerName,
        "wp db reset --yes --allow-root",
        { host },
      );
      if (resetRes.exitCode !== 0) {
        throw new Error(`Database reset failed: ${resetRes.stderr}`);
      }

      // 3. Reinstall WordPress core
      console.log(`[Vulmini] Reinstalling WordPress core...`);
      const installRes = await this.ssh.executeInContainer(
        this.containerName,
        `wp core install --url="${siteUrl}" --title="${title}" --admin_user="${adminUser}" --admin_password="${adminPassword}" --admin_email="${adminEmail}" --skip-email --allow-root`,
        { host },
      );
      if (installRes.exitCode !== 0) {
        throw new Error(`WordPress core install failed: ${installRes.stderr}`);
      }

      // 4. Configure specific preset
      console.log(`[Vulmini] Running preset configuration: ${options.preset}...`);
      let presetLogs = "";

      if (options.preset === "landing") {
        const cmds = [
          "theme install astra --activate",
          "plugin install elementor --activate",
          "plugin install wpforms-lite --activate",
          "rewrite structure '/%postname%/'",
          "post create --post_type=page --post_title='Home' --post_status=publish --post_name=home --post_content='Welcome to our landing page!'",
          "option update show_on_front page",
        ];
        for (const cmd of cmds) {
          const res = await this.ssh.executeInContainer(
            this.containerName,
            `wp ${cmd} --allow-root`,
            { host },
          );
          if (res.exitCode !== 0) {
            throw new Error(`Command failed: wp ${cmd} - Error: ${res.stderr}`);
          }
          presetLogs += `wp ${cmd} -> Success\n`;
        }
        // Set page_on_front to the ID of the new Home page
        const homeIdRes = await this.ssh.executeInContainer(
          this.containerName,
          "wp post list --post_type=page --name=home --field=ID --allow-root",
          { host },
        );
        const homeId = homeIdRes.stdout.trim();
        if (homeId) {
          await this.ssh.executeInContainer(
            this.containerName,
            `wp option update page_on_front ${homeId} --allow-root`,
            { host },
          );
        }
      } else if (options.preset === "blog") {
        const cmds = [
          "theme install generatepress --activate",
          "plugin install classic-editor --activate",
          "plugin install wp-super-cache --activate",
          "rewrite structure '/%postname%/'",
          "option update show_on_front posts",
        ];
        for (const cmd of cmds) {
          const res = await this.ssh.executeInContainer(
            this.containerName,
            `wp ${cmd} --allow-root`,
            { host },
          );
          if (res.exitCode !== 0) {
            throw new Error(`Command failed: wp ${cmd} - Error: ${res.stderr}`);
          }
          presetLogs += `wp ${cmd} -> Success\n`;
        }
      } else if (options.preset === "portfolio") {
        const cmds = [
          "theme install oceanwp --activate",
          "plugin install elementor --activate",
          "rewrite structure '/%postname%/'",
          "post create --post_type=page --post_title='Home' --post_status=publish --post_name=home",
          "post create --post_type=page --post_title='Portfolio' --post_status=publish --post_name=portfolio",
          "post create --post_type=page --post_title='Contact' --post_status=publish --post_name=contact",
          "option update show_on_front page",
        ];
        for (const cmd of cmds) {
          const res = await this.ssh.executeInContainer(
            this.containerName,
            `wp ${cmd} --allow-root`,
            { host },
          );
          if (res.exitCode !== 0) {
            throw new Error(`Command failed: wp ${cmd} - Error: ${res.stderr}`);
          }
          presetLogs += `wp ${cmd} -> Success\n`;
        }
        const homeIdRes = await this.ssh.executeInContainer(
          this.containerName,
          "wp post list --post_type=page --name=home --field=ID --allow-root",
          { host },
        );
        const homeId = homeIdRes.stdout.trim();
        if (homeId) {
          await this.ssh.executeInContainer(
            this.containerName,
            `wp option update page_on_front ${homeId} --allow-root`,
            { host },
          );
        }
      } else if (options.preset === "woocommerce") {
        const cmds = [
          "theme install astra --activate",
          "plugin install woocommerce --activate",
          "rewrite structure '/%postname%/'",
        ];
        for (const cmd of cmds) {
          const res = await this.ssh.executeInContainer(
            this.containerName,
            `wp ${cmd} --allow-root`,
            { host },
          );
          if (res.exitCode !== 0) {
            throw new Error(`Command failed: wp ${cmd} - Error: ${res.stderr}`);
          }
          presetLogs += `wp ${cmd} -> Success\n`;
        }
      }

      return `WordPress preset '${options.preset}' configured successfully!\n\nExecution log:\n${presetLogs}`;
    } catch (err) {
      console.error(
        `[Vulmini] Error applying preset: ${err}. Resetting DB to clean state...`,
      );
      // Rollback database to clean reset state
      await this.ssh.executeInContainer(
        this.containerName,
        "wp db reset --yes --allow-root",
        { host },
      );
      throw err;
    }
  }
}
