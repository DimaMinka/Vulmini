// ==========================================
// VULMINI — Shared Zod Schema Utilities
// ==========================================
// Common Zod schemas reused across all *-tools.ts registrations.
// Import from here to avoid duplication between tool files.

import { z } from 'zod';

// ── Target Server ────────────────────────────────────────────────────────────

/**
 * Shared target schema used by all tools that operate on a specific
 * WordPress environment (production or staging).
 */
export const targetSchema = z
  .enum(['production', 'staging'])
  .describe("Target server: 'production' or 'staging'");

// ── Vultr Resource IDs ───────────────────────────────────────────────────────

/** Vultr instance UUID parameter. */
export const instanceIdSchema = z.string().uuid().describe('Vultr instance UUID');

/** Vultr snapshot UUID parameter. */
export const snapshotIdSchema = z.string().uuid().describe('Snapshot UUID');

// ── Network ──────────────────────────────────────────────────────────────────

/** IPv4 address parameter (for SSH host overrides etc.). */
export const ipAddressSchema = z.string().ip().describe('IP address of the VPS');

// ── Common Tool Response Builder ─────────────────────────────────────────────

/**
 * Wraps a plain text or JSON payload into the MCP tool content format.
 * @param data - String or object to return as tool content.
 */
export function textContent(data: string | object): { content: [{ type: 'text'; text: string }] } {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Returns a standardised error response for MCP tools.
 * @param error - The caught error value.
 */
export function errorContent(error: unknown): { content: [{ type: 'text'; text: string }] } {
  const message = error instanceof Error ? error.message : String(error);
  return textContent({ error: message });
}
