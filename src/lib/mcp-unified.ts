import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadStoredSession } from './anon-session.js';
import { buildAnonMeta, claimUrl } from './mcp-meta.js';

/**
 * Lesson 24 (harbor-pilot): the client's tool list is a SNAPSHOT, not a
 * subscription. Codex Desktop never processes tools/list_changed, so the old
 * remove-anon-tools/register-authed-tools flip left every newly registered tool
 * invisible for the rest of the session — the agent concluded its granted write
 * access "never arrived" and escalated to driving the web UI.
 *
 * This module makes the tool surface STABLE for the whole session lifecycle:
 * the FULL toolset (the authed inventory — the anon set is a strict name-subset)
 * is registered exactly once at boot with the authed schemas, and a mode flag
 * decides what each call DOES:
 *   - overlap tools (captures, watches, secret setup, echo, catalog riders):
 *     anonymous mode dispatches to the anon-island implementation;
 *   - authed-only tools (projects/endpoints reads, the write plane, replay,
 *     signing): anonymous mode answers a structured `account_required` that
 *     routes into the consent gate / claim flow.
 * The claim flip and the write grant mutate handlers' context objects — the tool
 * list NEVER changes, so a frozen client keeps working and a compliant client
 * sees nothing to re-fetch.
 */

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

interface CollectedTool {
  def: Record<string, unknown>;
  handler: ToolHandler;
}

/** Fake-server shim: records registrations instead of performing them. */
export function collectTools(register: (server: McpServer) => unknown): Map<string, CollectedTool> {
  const collected = new Map<string, CollectedTool>();
  const fake = {
    registerTool(name: string, def: Record<string, unknown>, handler: ToolHandler) {
      collected.set(name, { def, handler });
      return { remove() {/* never registered for real */} };
    },
  };
  register(fake as unknown as McpServer);
  return collected;
}

export interface UnifiedMode {
  authenticated: boolean;
}

/**
 * The anonymous-mode answer for authed-only tools. Structured and teaching
 * (lessons 6/23): says WHY, names BOTH exits, and promises the invariant a
 * frozen client needs to hear — the tool list will not change.
 */
function accountRequired(toolName: string) {
  const stored = loadStoredSession();
  const payload = {
    error: {
      code: 'account_required',
      message:
        `${toolName} works on a claimed FlurryPORT account; this session is still anonymous. ` +
        'Two ways forward: (1) wiring a catalog recipe that stores a credential or delivers externally? ' +
        'Call request_secret_setup with its recipeRef - the user consents and converts in their browser, ' +
        'and THIS connection upgrades automatically. (2) Otherwise the user can claim this session at ' +
        `${stored ? claimUrl(stored) : 'the claim link from get_capture_url'} . ` +
        'Either way the tool list does NOT change: after the upgrade this exact tool succeeds. ' +
        'Anonymous capture tools (get_capture_url, list_captures, send_test_event, forward_to_localhost) ' +
        'keep working meanwhile.',
    },
    ...(stored ? { meta: buildAnonMeta(stored) } : {}),
  };
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }], isError: true };
}

/** Per-name arg shims for anon impls receiving authed-shaped args. */
const ANON_ARG_SHIMS: Record<string, (args: Record<string, unknown>) => Record<string, unknown>> = {
  // The authed schema accepts `limit` as a take alias; the anon impl only reads take.
  list_captures: (args) => ({ ...args, take: args.take ?? args.limit }),
};

/**
 * Pilot-1 ledger item 7 (priority): anon impls operate on the session's OWN temporary
 * endpoint and used to IGNORE an explicit endpointId/projectId - so an agent asking
 * about someone else's endpoint got that other room silently rescoped to its own,
 * usually-empty one ("0 captures, state ok"): a fabricated empty room, exactly where a
 * verification read must never lie. An addressed read this session cannot honor is
 * REFUSED, never rescoped.
 */
function scopedReadRefused(toolName: string, args: Record<string, unknown>) {
  const named = ['endpointId', 'projectId']
    .filter((k) => typeof args[k] === 'string' && (args[k] as string).length > 0)
    .map((k) => `${k} "${args[k] as string}"`)
    .join(' and ');
  const payload = {
    error: {
      code: 'scoped_read_unavailable',
      message:
        `${toolName} was called with ${named}, but this session is ANONYMOUS: it can only operate on its ` +
        'own temporary endpoint and cannot address that one. Refusing rather than silently answering from ' +
        'the wrong room - an answer here would fabricate an empty stream, not read the one you named. ' +
        'If you were invited to that endpoint, call join_invite with your invite; if you have an account ' +
        'credential, restart the MCP server signed in (flurryport login / --account). To use THIS ' +
        "session's own endpoint instead, call the tool again without endpointId/projectId.",
    },
  };
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }], isError: true };
}

/**
 * Register the union toolset ONCE. `mode.authenticated` is read per call, so the
 * flip is a field write, never a re-registration.
 */
export function registerUnifiedTools(
  server: McpServer,
  mode: UnifiedMode,
  authTools: Map<string, CollectedTool>,
  anonTools: Map<string, CollectedTool>,
): void {
  for (const [name, auth] of authTools) {
    const anon = anonTools.get(name);
    const shim = ANON_ARG_SHIMS[name];
    server.registerTool(name, auth.def as never, (async (args: Record<string, unknown>) => {
      if (mode.authenticated) return auth.handler(args);
      if (anon) {
        // Ledger item 7: an explicit endpointId/projectId names a room the anon impl
        // cannot reach - refuse instead of silently rescoping to the session's own.
        const addressed = ['endpointId', 'projectId'].some(
          (k) => typeof args[k] === 'string' && (args[k] as string).length > 0);
        if (addressed) return scopedReadRefused(name, args);
        return anon.handler(shim ? shim(args) : args);
      }
      return accountRequired(name);
    }) as never);
  }
}
