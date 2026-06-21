// ==========================================
// VULMINI — Telemetry MCP Tools
// ==========================================
// Инструменты мониторинга: CPU, RAM, диск, логи,
// статус Docker-контейнеров.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SshExecutor } from "../services/ssh-executor.js";

const targetSchema = z
  .enum(["production", "staging"])
  .describe("Target server: 'production' or 'staging'");

export function registerTelemetryTools(
  server: McpServer,
  ssh: SshExecutor,
  getHost: (target: "production" | "staging") => string
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
          { host }
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
    }
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
          { host }
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
                2
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
    }
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
          { host }
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
                2
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
    }
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
          { host }
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
                2
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
    }
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
