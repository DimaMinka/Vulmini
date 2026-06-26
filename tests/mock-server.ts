// ==========================================
// VULMINI — Mock MCP Server
// ==========================================
// Lightweight Express server that simulates the
// real MCP transport for integration tests.
//
// Tool logic is split into domain handler modules:
//   - mocks/vultr-handlers.ts   (Vultr VPS / snapshots)
//   - mocks/wp-cli-handlers.ts  (WordPress / WP-CLI)
//   - mocks/telemetry-handlers.ts (system health / logs)
//
// This file owns: HTTP server, Bearer auth, SSE, JSON-RPC routing.

import express, { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';

import { resetState } from './mocks/state.js';
import { handleVultrTool } from './mocks/vultr-handlers.js';
import { handleWpCliTool } from './mocks/wp-cli-handlers.js';
import { handleTelemetryTool } from './mocks/telemetry-handlers.js';

// Re-export types and helpers for test files
export { resetState };
export type { Instance, Snapshot, Backup, Plugin } from './mocks/state.js';

// ── Timing-Safe Compare Helper ─────────────────────────────────────────────

export function timingSafeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Prevent timing leaks about length by performing dummy comparison
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ── Tool Validation Schemas ────────────────────────────────────────────────

const targetSchema = z.enum(['production', 'staging']);
const uuidSchema = z.string().uuid();
const ipSchema = z.string().ip();

const toolSchemas: Record<string, z.ZodTypeAny> = {
  list_instances:            z.object({}),
  get_instance_status:       z.object({ instance_id: uuidSchema }),
  create_snapshot:           z.object({ instance_id: uuidSchema, description: z.string().default('Vulmini auto-snapshot') }),
  get_snapshot_status:       z.object({ snapshot_id: z.string() }),
  create_ephemeral_staging:  z.object({ snapshot_id: z.string(), label: z.string().default('vulmini-staging-ephemeral') }),
  destroy_ephemeral_staging: z.object({ instance_id: uuidSchema }),
  list_snapshots:            z.object({}),
  create_production_vps:     z.object({}),
  create_clean_staging:      z.object({}),
  wp_plugin_status:          z.object({ target: targetSchema }),
  wp_run_update:             z.object({ target: targetSchema, plugin_slug: z.string().optional() }),
  wp_db_migrate:             z.object({ target: targetSchema }),
  wp_health_check:           z.object({ target: targetSchema }),
  wp_run_backup:             z.object({ target: targetSchema, scope: z.enum(['full', 'db', 'plugin']).default('full'), plugin_slug: z.string().optional() }),
  wp_run_restore:            z.object({ target: targetSchema, backup_id: z.string(), scope: z.enum(['full', 'db', 'plugins']).default('full') }),
  set_staging_host:          z.object({ host: ipSchema }),
  get_system_health:         z.object({ target: targetSchema }),
  fetch_error_logs:          z.object({ target: targetSchema, lines: z.number().int().min(10).max(500).default(100) }),
  fetch_nginx_logs:          z.object({ target: targetSchema, log_type: z.enum(['access', 'error']).default('error'), lines: z.number().int().min(10).max(500).default(50) }),
  get_docker_status:         z.object({ target: targetSchema }),
  deploy_stack:              z.object({ target: targetSchema }),
  wp_configure_preset:       z.object({ target: targetSchema, preset: z.enum(['landing', 'blog', 'portfolio', 'woocommerce']), title: z.string().optional(), admin_user: z.string().optional(), admin_password: z.string().optional(), admin_email: z.string().optional() }),
  wp_create_magic_link:      z.object({ target: targetSchema, username: z.string().default('admin') }),
};

// ── SSE Client Registry ────────────────────────────────────────────────────

let sseClients: { req: Request; res: Response }[] = [];

// ── Server Factory ─────────────────────────────────────────────────────────

export function createServer() {
  const app = express();
  app.use(express.json());

  // Bearer authentication middleware (timing-safe)
  const authenticate = (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const token = authHeader.substring(7);
    const expected = process.env.MCP_BEARER_TOKEN ?? 'test-token-12345';
    if (!timingSafeCompare(token, expected)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };

  // ── GET /mcp — SSE stream ─────────────────────────────────────────────────
  app.get('/mcp', authenticate, (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('event: endpoint\ndata: /mcp\n\n');

    const client = { req, res };
    sseClients.push(client);
    req.on('close', () => { sseClients = sseClients.filter((c) => c !== client); });
  });

  // ── POST /mcp — JSON-RPC endpoint ─────────────────────────────────────────
  app.post('/mcp', authenticate, (req: Request, res: Response) => {
    const { jsonrpc, method, params, id } = req.body;

    if (jsonrpc !== '2.0' || !method) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: id ?? null });
      return;
    }

    // ── tools/list ───────────────────────────────────────────────────────────
    if (method === 'tools/list') {
      const toolsList = buildToolsList();
      res.json({ jsonrpc: '2.0', result: { tools: toolsList }, id });
      return;
    }

    if (method !== 'tools/call') {
      res.status(404).json({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id });
      return;
    }

    // ── tools/call ───────────────────────────────────────────────────────────
    const { name: toolName, arguments: toolArgs } = params ?? {};
    if (!toolName || !toolSchemas[toolName]) {
      res.status(404).json({ jsonrpc: '2.0', error: { code: -32601, message: `Tool not found: ${toolName}` }, id });
      return;
    }

    const validation = toolSchemas[toolName].safeParse(toolArgs);
    if (!validation.success) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32602, message: 'Invalid params', data: validation.error.format() },
        id,
      });
      return;
    }

    const validatedArgs = validation.data;

    // Dispatch to domain handlers in priority order
    const result =
      handleVultrTool(toolName, validatedArgs) ??
      handleWpCliTool(toolName, validatedArgs) ??
      handleTelemetryTool(toolName, validatedArgs) ??
      { resultText: `Unknown tool: ${toolName}`, isError: true };

    res.json({
      jsonrpc: '2.0',
      result: result.isError ? undefined : { content: [{ type: 'text', text: result.resultText }] },
      error: result.isError ? { code: -32000, message: result.resultText } : undefined,
      id,
    });
  });

  // ── Error handling ────────────────────────────────────────────────────────
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && 'status' in err && (err as any).status === 400) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      return;
    }
    next(err);
  });

  // ── Utility routes ────────────────────────────────────────────────────────
  app.get('/nginx-redirect-test', (_req, res) => {
    res.redirect(301, 'https://vulmini.cdk.app/mcp');
  });

  // Reset state endpoint for multi-process test runner synchronization
  app.post('/reset', (_req, res) => {
    resetState();
    res.json({ ok: true });
  });

  return app;
}

// ── Server Lifecycle ───────────────────────────────────────────────────────

let serverInstance: ReturnType<ReturnType<typeof createServer>['listen']> | null = null;
let keepAliveInterval: NodeJS.Timeout | null = null;

export function startServer(port = 3000) {
  if (process.env.MOCK_SERVER_EXTERNAL === 'true') {
    console.log('[Mock Server] Bypassing startServer because MOCK_SERVER_EXTERNAL is true');
    return null;
  }
  const app = createServer();
  serverInstance = app.listen(port, () => {
    console.log(`[Mock Server] Running on http://localhost:${port}`);
  });

  // SSE keep-alive pings for test agility
  keepAliveInterval = setInterval(() => {
    sseClients.forEach((client) => {
      try { client.res.write(': keep-alive\n\n'); } catch { /* ignore disconnected clients */ }
    });
  }, 100);

  return serverInstance;
}

export function stopServer() {
  if (process.env.MOCK_SERVER_EXTERNAL === 'true') return;
  if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
  if (serverInstance) { serverInstance.close(); serverInstance = null; }
  sseClients.forEach((c) => { try { c.res.end(); } catch { /* ignore */ } });
  sseClients = [];
}

// ── tools/list builder ─────────────────────────────────────────────────────

function buildToolsList() {
  return Object.keys(toolSchemas).map((name) => {
    let description = '';
    let inputProperties: Record<string, unknown> = {};
    let required: string[] = [];

    const target = { type: 'string', enum: ['production', 'staging'], description: 'Target server' };

    switch (name) {
      case 'list_instances':            description = 'List all Vultr VPS instances.'; break;
      case 'get_instance_status':       description = 'Get status of a specific Vultr VPS.'; inputProperties = { instance_id: { type: 'string', format: 'uuid' } }; required = ['instance_id']; break;
      case 'create_snapshot':           description = 'Create a snapshot of a VPS.'; inputProperties = { instance_id: { type: 'string', format: 'uuid' }, description: { type: 'string', default: 'Vulmini auto-snapshot' } }; required = ['instance_id']; break;
      case 'get_snapshot_status':       description = 'Get snapshot status.'; inputProperties = { snapshot_id: { type: 'string' } }; required = ['snapshot_id']; break;
      case 'create_ephemeral_staging':  description = 'Create ephemeral staging VPS from snapshot.'; inputProperties = { snapshot_id: { type: 'string' }, label: { type: 'string', default: 'vulmini-staging-ephemeral' } }; required = ['snapshot_id']; break;
      case 'destroy_ephemeral_staging': description = 'Destroy ephemeral staging VPS.'; inputProperties = { instance_id: { type: 'string', format: 'uuid' } }; required = ['instance_id']; break;
      case 'list_snapshots':            description = 'List all snapshots.'; break;
      case 'create_production_vps':     description = 'Create production VPS.'; break;
      case 'create_clean_staging':      description = 'Create clean staging VPS.'; break;
      case 'wp_plugin_status':          description = 'List WordPress plugins and updates.'; inputProperties = { target }; required = ['target']; break;
      case 'wp_run_update':             description = 'Update WordPress plugins.'; inputProperties = { target, plugin_slug: { type: 'string' } }; required = ['target']; break;
      case 'wp_db_migrate':             description = 'Run WordPress DB migration.'; inputProperties = { target }; required = ['target']; break;
      case 'wp_health_check':           description = 'Health check for WordPress site.'; inputProperties = { target }; required = ['target']; break;
      case 'wp_run_backup':             description = 'Create a backup.'; inputProperties = { target, scope: { type: 'string', enum: ['full', 'db', 'plugin'], default: 'full' }, plugin_slug: { type: 'string' } }; required = ['target']; break;
      case 'wp_run_restore':            description = 'Restore from backup.'; inputProperties = { target, backup_id: { type: 'string' }, scope: { type: 'string', enum: ['full', 'db', 'plugins'], default: 'full' } }; required = ['target', 'backup_id']; break;
      case 'set_staging_host':          description = 'Set SSH host for staging.'; inputProperties = { host: { type: 'string', format: 'ipv4' } }; required = ['host']; break;
      case 'get_system_health':         description = 'Get system health metrics.'; inputProperties = { target }; required = ['target']; break;
      case 'fetch_error_logs':          description = 'Fetch WordPress error logs.'; inputProperties = { target, lines: { type: 'number', minimum: 10, maximum: 500, default: 100 } }; required = ['target']; break;
      case 'fetch_nginx_logs':          description = 'Fetch Nginx access or error logs.'; inputProperties = { target, log_type: { type: 'string', enum: ['access', 'error'], default: 'error' }, lines: { type: 'number', minimum: 10, maximum: 500, default: 50 } }; required = ['target']; break;
      case 'get_docker_status':         description = 'Get Docker container statuses.'; inputProperties = { target }; required = ['target']; break;
      case 'deploy_stack':              description = 'Deploy Docker stack to target server.'; inputProperties = { target }; required = ['target']; break;
      case 'wp_configure_preset':       description = 'Configure WordPress site with a preset.'; inputProperties = { target, preset: { type: 'string', enum: ['landing', 'blog', 'portfolio', 'woocommerce'] }, title: { type: 'string' }, admin_user: { type: 'string' }, admin_password: { type: 'string' }, admin_email: { type: 'string' } }; required = ['target', 'preset']; break;
      case 'wp_create_magic_link':      description = 'Create magic login link.'; inputProperties = { target, username: { type: 'string', default: 'admin' } }; required = ['target']; break;
    }

    return { name, description, inputSchema: { type: 'object', properties: inputProperties, required } };
  });
}
