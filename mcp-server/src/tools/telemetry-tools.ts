// ==========================================
// VULMINI — Telemetry MCP Tools
// ==========================================
// Monitoring tools: CPU, RAM, disk, logs,
// and Docker container status.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SshExecutor } from "../services/ssh-executor.js";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const targetSchema = z
  .enum(["production", "staging"])
  .describe("Target server: 'production' or 'staging'");

export function registerTelemetryTools(
  server: McpServer,
  ssh: SshExecutor,
  getHost: (target: "production" | "staging") => string,
): void {
  // ── get_system_health ──
  server.tool(
    "get_system_health",
    "Get system health metrics: CPU usage, RAM usage, disk usage, load average, and uptime. Use this to monitor server resources before and after updates.",
    {
      target: targetSchema,
    },
    async ({ target }) => {
      try {
        const host = getHost(target);
        const result = await ssh.execute(
          `cat << 'HEALTH_EOF'
{
  "cpu_cores": $(nproc),
  "load_average": "$(cat /proc/loadavg | awk '{print $1, $2, $3}')",
  "memory": "$(free -m | awk '/Mem:/ {printf "%d %d %.1f", $3, $2, $3/$2*100}')",
  "disk": "$(df -BG / | awk 'NR==2 {gsub("G",""); printf "%d %d %.1f", $3, $2, $5}')",
  "uptime_seconds": $(cat /proc/uptime | awk '{print int($1)}')
}
HEALTH_EOF`,
          { host },
        );

        // Parse the raw output into structured JSON
        try {
          const raw = JSON.parse(result.stdout);
          const loadParts = raw.load_average.split(" ").map(Number);
          const memParts = raw.memory.split(" ").map(Number);
          const diskParts = raw.disk.split(" ").map(Number);

          const health = {
            cpu_cores: raw.cpu_cores,
            load_average: loadParts,
            memory_used_mb: memParts[0],
            memory_total_mb: memParts[1],
            memory_usage_percent: memParts[2],
            disk_used_gb: diskParts[0],
            disk_total_gb: diskParts[1],
            disk_usage_percent: diskParts[2],
            uptime_seconds: raw.uptime_seconds,
            uptime_human: formatUptime(raw.uptime_seconds),
          };

          return {
            content: [{ type: "text", text: JSON.stringify(health, null, 2) }],
          };
        } catch {
          // If parsing fails, return raw output
          return {
            content: [{ type: "text", text: result.stdout }],
          };
        }
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Failed to get system health: ${error}` },
          ],
        };
      }
    },
  );

  // ── fetch_error_logs ──
  server.tool(
    "fetch_error_logs",
    "Fetch the tail of WordPress error logs (wp-content/debug.log). Use this to diagnose issues after a failed update or when wp_health_check reports fatal errors.",
    {
      target: targetSchema,
      lines: z
        .number()
        .int()
        .min(10)
        .max(500)
        .default(100)
        .describe("Number of log lines to fetch (10-500)"),
    },
    async ({ target, lines }) => {
      try {
        const host = getHost(target);
        const result = await ssh.executeInContainer(
          "vulmini_app",
          `sh -c "tail -n ${lines} /var/www/html/wp-content/debug.log 2>/dev/null || echo 'No debug.log found (WP_DEBUG may be off)'"`,
          { host },
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  target,
                  lines_requested: lines,
                  log_content: result.stdout,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Failed to fetch error logs: ${error}` },
          ],
        };
      }
    },
  );

  // ── fetch_nginx_logs ──
  server.tool(
    "fetch_nginx_logs",
    "Fetch the tail of Nginx access or error logs. Use to diagnose HTTP errors (5xx, 4xx) or traffic patterns.",
    {
      target: targetSchema,
      log_type: z
        .enum(["access", "error"])
        .default("error")
        .describe("Which Nginx log to fetch"),
      lines: z
        .number()
        .int()
        .min(10)
        .max(500)
        .default(50)
        .describe("Number of log lines to fetch"),
    },
    async ({ target, log_type, lines }) => {
      try {
        const host = getHost(target);
        const logFile =
          log_type === "access"
            ? "/var/log/nginx/access.log"
            : "/var/log/nginx/error.log";

        const result = await ssh.executeInContainer(
          "vulmini_web",
          `tail -n ${lines} ${logFile} 2>/dev/null || echo 'Log file not found'`,
          { host },
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  target,
                  log_type,
                  lines_requested: lines,
                  log_content: result.stdout,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Failed to fetch nginx logs: ${error}` },
          ],
        };
      }
    },
  );

  // ── get_docker_status ──
  server.tool(
    "get_docker_status",
    "Get the status of all Docker containers in the Vulmini stack (vulmini_db, vulmini_cache, vulmini_app, vulmini_web, vulmini_cron). Shows running state and health status.",
    {
      target: targetSchema,
    },
    async ({ target }) => {
      try {
        const host = getHost(target);
        const result = await ssh.execute(
          `docker ps --format '{"name":"{{.Names}}","state":"{{.State}}","status":"{{.Status}}","health":"{{.Label "com.docker.compose.service"}}"}' --filter "label=com.docker.compose.project" | head -20`,
          { host },
        );

        // Parse each line as JSON
        const containers = result.stdout
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return { raw: line };
            }
          });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { target, containers, total: containers.length },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Failed to get Docker status: ${error}` },
          ],
        };
      }
    },
  );

  // ── deploy_stack ──
  server.tool(
    "deploy_stack",
    "Deploy/Redeploy the Docker stack (WordPress, MariaDB, Nginx, PHP, Cron) to the target server. Packages local project configuration, uploads it, installs Docker if needed, and starts the container stack.",
    {
      target: targetSchema,
    },
    async ({ target }) => {
      const tarFile = "vulmini_deploy.tar.gz";
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      // Dynamic project root resolution
      let projectRoot = path.resolve(__dirname, "../../");
      while (
        projectRoot !== "/" &&
        !fs.existsSync(path.join(projectRoot, "package.json")) &&
        !fs.existsSync(path.join(projectRoot, "docker-compose.yml"))
      ) {
        projectRoot = path.dirname(projectRoot);
      }
      if (
        projectRoot === "/" ||
        !fs.existsSync(path.join(projectRoot, "docker-compose.yml"))
      ) {
        // Fallback for VPS structure: check if we are in /var/www/vulmini-mcp and have /root/vulmini
        if (fs.existsSync("/root/vulmini/docker-compose.yml")) {
          projectRoot = "/root/vulmini";
        } else {
          projectRoot = path.resolve(__dirname, "../../../");
        }
      }
      const localTarPath = path.join(projectRoot, tarFile);
      const host = getHost(target);

      try {
        // 1. Pack project files locally
        execSync(
          `tar -czf "${localTarPath}" -C "${projectRoot}" docker-compose.yml .env nginx php scripts`,
          { stdio: "pipe" },
        );
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to package local project files: ${err}`,
            },
          ],
        };
      }

      try {
        // 2. Check/Install Docker on remote host
        const checkDocker = await ssh.execute(
          "which docker || echo 'missing'",
          { host },
        );
        if (checkDocker.stdout.includes("missing")) {
          // Install Docker
          await ssh.execute(
            "curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh",
            { host, timeoutMs: 300_000 },
          );
        }

        // 3. Upload tarball
        const remoteTar = "/root/vulmini.tar.gz";
        await ssh.uploadFile(localTarPath, remoteTar, { host });

        // 4. Extract tarball
        await ssh.execute(
          "mkdir -p /root/vulmini && tar -xzf /root/vulmini.tar.gz -C /root/vulmini",
          { host },
        );

        // 5. Run Docker Compose
        // Define services based on target to prevent trying to build vulmini_mcp on staging/prod
        const services = target === "staging" || target === "production"
          ? "vulmini_db vulmini_cache vulmini_app vulmini_cron vulmini_web vulmini_certbot"
          : ""; // up everything if it's mcp target
        
        const composeResult = await ssh.execute(
          `cd /root/vulmini && docker compose down && docker compose up -d ${services}`.trim(),
          { host, timeoutMs: 300_000 },
        );

        return {
          content: [
            {
              type: "text",
              text: `Docker Stack deployed successfully to ${target} (${host})!\n\nOutput:\n${composeResult.stdout}`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Deployment failed on ${target}: ${error}` },
          ],
        };
      } finally {
        // Clean up local tarball
        if (fs.existsSync(localTarPath)) {
          fs.unlinkSync(localTarPath);
        }
      }
    },
  );

  // ── fetch_mcp_server_logs ──
  server.tool(
    "fetch_mcp_server_logs",
    "Fetch the tail of the MCP server's own systemd/journalctl logs. Use this to diagnose connection issues, transport errors, or tool failures without needing to SSH into the MCP server VPS.",
    {
      lines: z
        .number()
        .int()
        .min(10)
        .max(500)
        .default(100)
        .describe("Number of log lines to fetch (10-500)"),
    },
    async ({ lines }) => {
      try {
        const { execSync } = await import("node:child_process");
        const stdout = execSync(
          `journalctl -u vulmini-mcp -n ${lines} --no-pager`,
          { encoding: "utf-8" },
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  lines_requested: lines,
                  log_content: stdout,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to fetch MCP server logs: ${error.message || error}`,
            },
          ],
        };
      }
    },
  );
}

/** Format uptime seconds to human-readable string */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  return parts.join(" ") || "< 1m";
}
