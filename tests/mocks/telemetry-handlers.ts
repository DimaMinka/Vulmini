// ==========================================
// VULMINI Mock Server — Telemetry Handlers
// ==========================================
// Handles tool calls for system monitoring:
// health, logs, Docker status, and deployment.

import { stagingHost } from './state.js';

/** Handle telemetry-domain tool calls. Returns null for unknown tool names. */
export function handleTelemetryTool(
  toolName: string,
  args: Record<string, any>,
): { resultText: string; isError: boolean } | null {
  let resultText = '';
  let isError = false;

  switch (toolName) {
    case 'get_system_health': {
      resultText = JSON.stringify({
        cpu_cores: 2,
        load_average: [0.05, 0.08, 0.1],
        memory_used_mb: 1200,
        memory_total_mb: 4096,
        memory_usage_percent: 29.3,
        disk_used_gb: 15,
        disk_total_gb: 80,
        disk_usage_percent: 18.8,
        uptime_seconds: 3600,
        uptime_human: '1h',
      }, null, 2);
      break;
    }

    case 'fetch_error_logs': {
      resultText = JSON.stringify({
        target: args.target,
        lines_requested: args.lines,
        log_content: `[21-Jun-2026 18:13:00 UTC] PHP Notice: Simulated debug.log tail on ${args.target}.`,
      }, null, 2);
      break;
    }

    case 'fetch_nginx_logs': {
      resultText = JSON.stringify({
        target: args.target,
        log_type: args.log_type,
        lines_requested: args.lines,
        log_content: `Simulated Nginx ${args.log_type} log tail on ${args.target}.`,
      }, null, 2);
      break;
    }

    case 'get_docker_status': {
      resultText = JSON.stringify({
        target: args.target,
        containers: [
          { name: 'vulmini_db',    state: 'running', status: 'Up 2 hours (healthy)', health: 'db' },
          { name: 'vulmini_cache', state: 'running', status: 'Up 2 hours (healthy)', health: 'cache' },
          { name: 'vulmini_app',   state: 'running', status: 'Up 2 hours (healthy)', health: 'app' },
          { name: 'vulmini_web',   state: 'running', status: 'Up 2 hours (healthy)', health: 'web' },
          { name: 'vulmini_cron',  state: 'running', status: 'Up 2 hours (healthy)', health: 'cron' },
        ],
        total: 5,
      }, null, 2);
      break;
    }

    case 'deploy_stack': {
      const ip = args.target === 'production' ? '192.0.2.1' : stagingHost ?? '192.0.2.2';
      resultText = `Docker Stack deployed successfully to ${args.target} (${ip})!`;
      break;
    }

    default:
      return null; // Not a telemetry tool — pass to next handler
  }

  return { resultText, isError };
}
