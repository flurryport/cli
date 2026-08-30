import type { AnyMetaEnvelope, McpErrorPayload } from './mcp-meta.js';

/**
 * The single MCP response envelope (pilot-1 ledger item 9): one ok/fail pair shared
 * by the anon island, the authed toolset, and the seat server, so payload + meta
 * assembly can never drift between surfaces. The body shape is load-bearing - agents
 * parse `{...payload, meta}` / `{error, meta}` out of the text content - so this
 * module owns the bytes and nobody re-implements them.
 */

export function ok(payload: Record<string, unknown>, meta?: AnyMetaEnvelope) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ...payload, meta }, null, 2) }] };
}

export function fail(error: McpErrorPayload['error'], meta?: AnyMetaEnvelope) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error, meta }, null, 2) }], isError: true };
}
