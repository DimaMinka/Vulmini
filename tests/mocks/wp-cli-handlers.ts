// ==========================================
// VULMINI Mock Server — WP-CLI Handlers
// ==========================================
// Handles tool calls for WordPress management:
// plugins, database, backup, restore, presets, auth.

import { plugins, backups, setStagingHost, stagingHost, type Backup } from './state.js';

/** Handle WP-CLI-domain tool calls. Returns null for unknown tool names. */
export function handleWpCliTool(
  toolName: string,
  args: Record<string, any>,
): { resultText: string; isError: boolean } | null {
  let resultText = '';
  let isError = false;

  switch (toolName) {
    case 'wp_plugin_status': {
      const target: 'production' | 'staging' = args.target;
      const targetPlugins = plugins[target];
      const updatesAvailable = targetPlugins.filter((p) => p.update === 'available');
      resultText = JSON.stringify({
        total_plugins: targetPlugins.length,
        updates_available: updatesAvailable.length,
        plugins_with_updates: updatesAvailable,
        all_plugins: targetPlugins,
      }, null, 2);
      break;
    }

    case 'wp_run_update': {
      const target: 'production' | 'staging' = args.target;
      const slug = args.plugin_slug;
      const targetPlugins = plugins[target];

      let count = 0;
      targetPlugins.forEach((p) => {
        if (!slug || p.name === slug) {
          if (p.update === 'available') {
            p.update = 'none';
            if (p.update_version) {
              p.version = p.update_version;
              delete p.update_version;
            }
            count++;
          }
        }
      });

      resultText = JSON.stringify({
        target,
        plugin: slug || 'ALL',
        output: `Success: Updated ${count} of ${slug ? 1 : count} plugins.`,
        message: 'Update completed. Run wp_health_check to verify the site is healthy.',
      }, null, 2);
      break;
    }

    case 'wp_db_migrate': {
      resultText = JSON.stringify({
        target: args.target,
        output: 'Success: Database migrated and LearnDash upgrades completed.',
        message: 'Database migration complete. Run wp_health_check to verify.',
      }, null, 2);
      break;
    }

    case 'wp_health_check': {
      resultText = JSON.stringify({
        is_healthy: true,
        http_status: 200,
        fatal_errors_found: false,
        message: 'WordPress site is healthy.',
      }, null, 2);
      break;
    }

    case 'wp_run_backup': {
      const backupId = `${args.target}_backup_${Date.now()}`;
      backups.push({
        id: backupId,
        target: args.target,
        scope: args.scope,
        plugin_slug: args.plugin_slug,
        date_created: new Date().toISOString(),
      } as Backup);

      resultText = JSON.stringify({
        target: args.target,
        scope: args.scope,
        output: `Success: Backup created at /var/www/html/backups/backup_${backupId}.tar.gz`,
        message: 'Backup created. Save the backup_id for potential rollback with wp_run_restore.',
      }, null, 2);
      break;
    }

    case 'wp_run_restore': {
      const exists = backups.some(
        (b) => b.id === args.backup_id && b.target === args.target,
      );
      if (!exists) {
        isError = true;
        resultText = `Restore failed on ${args.target}: Backup not found: ${args.backup_id}`;
      } else {
        resultText = JSON.stringify({
          target: args.target,
          backup_id: args.backup_id,
          scope: args.scope,
          output: 'Success: Restore from backup completed.',
          message: 'Restore completed. Run wp_health_check to verify the site is healthy again.',
        }, null, 2);
      }
      break;
    }

    case 'set_staging_host': {
      setStagingHost(args.host);
      resultText = `Staging host set to ${args.host}. WP-CLI tools can now target 'staging'.`;
      break;
    }

    case 'wp_configure_preset': {
      const theme =
        args.preset === 'blog' ? 'generatepress'
        : args.preset === 'portfolio' ? 'oceanwp'
        : 'astra';
      resultText =
        `WordPress preset '${args.preset}' configured successfully!\n\n` +
        `Execution log:\nwp theme install ${theme} --activate -> Success\n` +
        `wp plugin install elementor --activate -> Success`;
      break;
    }

    case 'wp_create_magic_link': {
      resultText = `Success: Magic login link created!\nhttps://example.com/magic-login-token-12345`;
      break;
    }

    default:
      return null; // Not a WP-CLI tool — pass to next handler
  }

  return { resultText, isError };
}
