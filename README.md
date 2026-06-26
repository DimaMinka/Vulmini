# Vulmini Ecosystem

[![VibeTalent Badge](https://www.vibetalent.work/api/badge/dimaminka)](https://www.vibetalent.work/profile/dimaminka)

AI-managed WordPress infrastructure on Vultr VPS. Employs a **Twin-Instance** model (parallel staging) for safe, autonomous updates, testing, and data migrations.

---

## 01. Docker Stack Configuration

A high-performance 6-container stack optimized for Vultr High-Frequency (Tel-Aviv NVMe) drives:

- **`vulmini_app` (WordPress + PHP 8.4 FPM):** System core. Built-in WP-Cron is disabled, and Redis Object Cache is integrated.
- **`vulmini_db` (MariaDB 11.4):** InnoDB parameters (`flush-method`, `buffer-pool`, `log-file-size`) are strictly tuned for NVMe performance.
- **`vulmini_cron` (Dedicated Scheduler):** Separate lightweight PHP container running `wp-cron.php` every minute to offload tasks from the web server.
- **`vulmini_cache` (Redis 7.2):** Object caching engine configured to cache database queries and transient records.
- **`vulmini_web` (Nginx 1.27):** High-performance web server with custom FastCGI caching rules and security hardening.
- **`vulmini_certbot` (Let's Encrypt):** Automated SSL certificate rotation for secure, encrypted connections.

---

## 02. Vulmini MCP Server (TypeScript)

A Model Context Protocol (MCP) server providing the AI agent with direct tools for infrastructure management.

### Core Services

- **`VultrApiClient`:** Vultr API v2 client managing VPS deployment, snapshot polling, and billing.
- **`SshExecutor`:** Executes commands inside Docker containers on remote hosts via SSH.
- **`WpCliService`:** Wrapper for executing WP-CLI commands inside the running containers.

### Registered AI Tools (18)

#### ☁️ Vultr VPS Tools

- `list_instances` — List all Vultr VPS instances with their status, IP, and region.
- `get_instance_status` — Get detailed status of a specific Vultr VPS instance.
- `create_snapshot` — Create a snapshot of a Vultr VPS instance.
- `get_snapshot_status` — Check the status of a Vultr snapshot.
- `create_production_vps` — Deploy a new production VPS on Vultr and configure SSH keys.
- `create_clean_staging` — Deploy a clean staging VPS from scratch on Vultr.
- `create_ephemeral_staging` — Create a temporary staging VPS from a production snapshot.
- `destroy_ephemeral_staging` — Permanently destroy an ephemeral staging VPS.

#### ⚙️ WP-CLI Tools

- `wp_plugin_status` — Get list of plugins, versions, and available updates.
- `wp_run_update` — Update a specific plugin or all plugins.
- `wp_db_migrate` — Run WordPress database migrations and LearnDash upgrades.
- `wp_health_check` — Perform HTTP response and PHP error log diagnostics.
- `wp_run_backup` — Create database and plugin backups before making changes.
- `wp_run_restore` — Restore database and plugins from a previous backup (rollback).
- `set_staging_host` — Set the SSH host IP address for the staging server.
- `wp_run_command` — Execute any arbitrary WP-CLI command on the target server.

#### 📊 Telemetry & Deploy Tools

- `get_system_health` — Get system health metrics (CPU, RAM, disk, load average).
- `fetch_error_logs` — Fetch the tail of WordPress error logs (`debug.log`).
- `fetch_nginx_logs` — Fetch the tail of Nginx access or error logs.
- `fetch_mcp_server_logs` — Fetch the tail of the MCP server's systemd journalctl logs.
- `get_docker_status` — Get the status of all Docker containers in the Vulmini stack.
- `deploy_stack` — Package project configuration, upload it, and boot up the Docker Compose stack.

---

## 03. System Scripts & Configurations

- **`scripts/backup.sh` / `scripts/restore.sh`:** Handles automated DB and plugin backups for safety rollbacks.
- **`php/pool.conf`:** Custom PHP-FPM worker tuning.
- **`nginx/default.conf`:** Nginx server block configurations with FastCGI caching, rate limiting, and security headers.
