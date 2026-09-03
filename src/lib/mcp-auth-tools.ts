import { randomUUID } from 'node:crypto';
import { isLocalTarget } from './local-target.js';
import { generateSigningKey, putCredential, signingKeyRef } from './keystore.js';
import { chooseIntentKey, deliverIntent } from './intent-post.js';
import { manifestPath, readManifest, removeManifestEntry, upsertManifestEntry } from './pipe-manifest.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  AuthApiError,
  opaqueIds,
  type AuthApiClient,
  type CapturedRequestDetail,
  type ProjectPlanInfo,
} from './auth-api.js';
import { base62ToGuid, guidToBase62 } from './base62.js';
import { fetchPlanCatalog, resolveBillingBaseUrl } from './plans-api.js';
import type { AnyMetaEnvelope, LimitOption, MetaBurst, MetaEnvelope, MetaNotice, McpErrorPayload } from './mcp-meta.js';
import { burstFromPing, minutesUntil, resolveWebBaseUrl } from './mcp-meta.js';
import { sanitizeOutboundError } from './fetch-error.js';
import { fail, ok } from './mcp-response.js';
import { takeCliUpdateNotice } from './version-nudge.js';
import { toUtcIso, utcMs } from './time.js';
import { forwardCaptureToLocal, validateLocalUrl } from './local-forward.js';
import { DEFAULT_EVENT_TYPES, sendTestEventBatch, type TestProvider } from './mcp-test-events.js';
import { ensureEchoServer } from './echo-server.js';
import { buildReceipt, diagnoseForward, successNextAction, swapAttempt } from './forward-insights.js';
import { humanAction, workspacePath, type HumanAction } from './human-action.js';
import { handleBase, sanitizeGuestName } from './console-handles.js';
import { consoleMessages } from './console-messages.js';
import { resolveRoomsUrl } from './rooms.js';
import { getChairIdentity } from './console-view-state.js';
import { codeMinutesLeft, mintSeatInvite } from './seat-mint.js';
import { toolTitle } from './tool-title.js';

/**
 * Authenticated-mode tools (spec §5 / §12.4-12.5): Tier-1 reads + forward_to_localhost
 * run inside the read-only ("no-egress") PAT scope, so the default minted token powers
 * them. replay_to_target is the one server-mutating tool: enforcement is all
 * server-side (readonly PAT → 403, DomainVerified, per-PAT limiter, idempotency key),
 * and destructiveHint:true is the HITL signal to the client.
 */

// #112 (Codex round-2): the behavioral rules that used to ride every description here
// (SHARED_RULES) now live ONCE in mcp-server-instructions.ts (SHARED_TOOL_RULES).
// Tool descriptions carry only tool-specific behavior.

export interface ClaimHandoffInfo {
  /** Opaque (base62) ids, ready for tool args and API routes. */
  projectId: string;
  endpointId: string;
  endpointSlug: string;
  captureCount: number;
}

export interface AuthToolContext {
  client: AuthApiClient;
  allowLan: boolean;
  /**
   * This SESSION's mutable state (precedent #1): claim scope, one-time notices,
   * scope-discovery cache. REQUIRED so no construction site can fall back to
   * shared module state - one process hosts many sessions over HTTP.
   */
  session: AuthSessionState;
  /** Present when this toolset was activated by a device-flow claim (0.2.3 breadcrumb). */
  claimHandoff?: ClaimHandoffInfo;
  /**
   * Arms the in-flow write grant's poll (WriteUpgradeController). Called from
   * request_secret_setup so the wait is live before the human reaches the grant
   * screen; the decision is durable server-side, so order never matters.
   */
  armWriteUpgrade?: () => void;

  // ── Seat-server seams (0.5.0, #233) — ONE TOOL CODEBASE ─────────────────────
  // The seat surface mounts the SAME registered handlers; these optional seams swap
  // the per-operator machine state (scope discovery, disk keystore, plan quota, meta
  // envelope) for per-session seat principal state. All optional: when absent, every
  // default behavior is unchanged (the stdio inventory locks prove it).

  /** Pinned room: scope resolution answers this instead of discovery/claim fallback. */
  fixedScope?: { projectId: string; endpointId: string; endpointSlug?: string };
  /** post_intent's signing key source, replacing the disk keystore's chooseIntentKey. */
  intentKey?: () => { key: string; header?: string; keyRef?: string } | null;
  /** 'none' skips plan reads and the session's plan cache entirely (authMeta(null) degrades safely). */
  quota?: 'none';
  /** Consulted FIRST by authMeta: the returned envelope replaces the authed one wholesale. */
  metaOverride?: () => AnyMetaEnvelope;
  /**
   * #358: headers post_intent adds to every capture post. The hosted rooms service
   * sets its provenance marker and the public host it presents, so Core stores the
   * capture as if it arrived at the public API and no cluster address reaches a seat.
   */
  captureHeaders?: Record<string, string>;
  /**
   * #370: the live router table's joined invite grants (base62 ids). request_seat
   * resolves its default scope from these, never from the operator's own endpoints:
   * the room a monitor asks in is by definition one it was invited to.
   */
  joinedGrants?: () => Array<{ projectId?: string; endpointId?: string; accountName: string }>;
}

/**
 * Per-SESSION mutable state (hardening precedent #1). One process may host MANY
 * concurrent sessions (--http, the seat server, the Track B account principal), so
 * nothing session-scoped may live at module level: a module-global claim scope let
 * session A's claim leak into session B's default scope (cross-tenant reads and
 * writes on A's endpoint when B omitted ids), and B's next response consumed A's
 * one-time notices. Every AuthToolContext carries its own instance; stdio mode
 * simply has one.
 */
export interface AuthSessionState {
  /** Post-claim default scope (0.2.3): claimed ids answer omitted-id tools. */
  claimScope: ClaimHandoffInfo | null;
  /** One-time session_claimed notice, consumed by this session's next meta. */
  pendingClaimNotice: MetaNotice | null;
  /** One-time write-grant outcome notice (in-flow write grant, 2026-07-20). */
  pendingWriteNotice: MetaNotice | null;
  /** Default-scope discovery cache + last diagnosis (run-5 finding 29). */
  discoveredScope: { value: ScopeDiscovery; fetchedAt: number } | null;
  lastScopeDiagnosis: ScopeDiscovery | null;
  /** Plan + slug caches, PER SESSION (review finding 4): one process may host many
   * principals, and quota/slug data is tenant data - it must never render in
   * another session's meta or links. */
  planCache: Map<string, { plan: ProjectPlanInfo; fetchedAt: number }>;
  slugCache: Map<string, { slug: string; fetchedAt: number }>;
}

export function createAuthSessionState(): AuthSessionState {
  return {
    claimScope: null,
    pendingClaimNotice: null,
    pendingWriteNotice: null,
    discoveredScope: null,
    lastScopeDiagnosis: null,
    planCache: new Map(),
    slugCache: new Map(),
  };
}

function takeClaimNotice(session: AuthSessionState): MetaNotice | null {
  const notice = session.pendingClaimNotice;
  session.pendingClaimNotice = null;
  return notice;
}

/**
 * Arm the one-time session_claimed notice + claimed default scope. Called at the
 * claim flip (mcp.ts) — under the unified toolset (lesson 24) the flip re-registers
 * NOTHING, so this is the only registration-independent way the breadcrumb lands.
 */
export function announceClaim(session: AuthSessionState, handoff: ClaimHandoffInfo): void {
  session.claimScope = handoff;
  const { captureCount, endpointSlug } = handoff;
  session.pendingClaimNotice = {
    code: 'session_claimed',
    message:
      `Anonymous session claimed. ${captureCount} capture${captureCount === 1 ? '' : 's'} migrated to ` +
      `endpoint "${endpointSlug}" (ids in this response are the NEW authenticated ids; every anonymous ` +
      'id is now invalid). The tool list has NOT changed - the same tools now run against the account. ' +
      'Tools accept the new ids from list_* calls, or omit ids to use the claimed endpoint. ' +
      'get_capture_url returns the new permanent capture URL.',
  };
}

/**
 * One-time write-grant outcome notice (in-flow write grant, 2026-07-20) — the
 * session_claimed pattern: the next authed response carries it exactly once.
 * Called by the WriteUpgradeController callbacks in mcp.ts.
 */
export function announceWriteDecision(session: AuthSessionState, granted: boolean): void {
  session.pendingWriteNotice = granted
    ? {
        code: 'write_granted',
        message:
          'The user granted write access on the setup page. This connection now uses the read-write token ' +
          '"AI editor (read-write)" - no restart happened and the tool list has NOT changed: the SAME ' +
          'tools you already have (create_endpoint, create_replay_target, update_replay_target, ' +
          'create_transformation, bind_transformation, set_endpoint_signing, set_orientation, post_intent) simply succeed ' +
          'now. Do not re-list tools or wait; continue wiring where you left off.',
      }
    : {
        code: 'write_skipped',
        message:
          'The user chose to keep this session read-only. Tell them plainly what stays manual in the web app: ' +
          'creating or arming delivery targets, binding transformations, and signing setup. They can grant ' +
          'write access later by generating a read-write token in Settings, or by running secret setup again ' +
          'and choosing Grant.',
      };
}

function takeWriteNotice(session: AuthSessionState): MetaNotice | null {
  const notice = session.pendingWriteNotice;
  session.pendingWriteNotice = null;
  return notice;
}

/**
 * Default-scope discovery with a DIAGNOSIS (run-5 finding 29, finding-19 family):
 * partial knowledge is kept (a one-project account resolves projectId even with many
 * endpoints) and failures say what is actually true instead of guessing "more than one
 * project exists" at a scoped guest credential or an empty account.
 */
interface ScopeDiscovery {
  projectId: string | null;
  endpointId: string | null;
  endpointSlug: string | null;
  problem: 'no_projects' | 'many_projects' | 'no_endpoints' | 'many_endpoints' | 'unreachable' | null;
}
const SCOPE_TTL_MS = 5 * 60_000;

async function discoverScope(ctx: AuthToolContext): Promise<ScopeDiscovery> {
  // Seat sessions (0.5.0): the room is pinned by redemption, and a seat credential
  // cannot enumerate projects anyway — never touch discovery or the claim fallback.
  if (ctx.fixedScope) {
    return {
      projectId: ctx.fixedScope.projectId,
      endpointId: ctx.fixedScope.endpointId,
      endpointSlug: ctx.fixedScope.endpointSlug ?? null,
      problem: null,
    };
  }
  const session = ctx.session;
  const claimScope = session.claimScope;
  if (claimScope) {
    return { projectId: claimScope.projectId, endpointId: claimScope.endpointId, endpointSlug: claimScope.endpointSlug, problem: null };
  }
  if (session.discoveredScope && Date.now() - session.discoveredScope.fetchedAt < SCOPE_TTL_MS) {
    return session.discoveredScope.value;
  }
  let value: ScopeDiscovery;
  try {
    const projects = (await ctx.client.get('/api/v1/projects')) as { Projects?: Array<{ Id: string }> };
    const list = projects.Projects ?? [];
    if (list.length === 0) {
      value = { projectId: null, endpointId: null, endpointSlug: null, problem: 'no_projects' };
    } else if (list.length > 1) {
      value = { projectId: null, endpointId: null, endpointSlug: null, problem: 'many_projects' };
    } else {
      const projectId = guidToBase62(list[0].Id);
      const endpoints = (await ctx.client.get(`/api/v1/projects/${projectId}/endpoints`)) as {
        Endpoints?: Array<{ Id: string; Slug: string }>;
      };
      const eps = endpoints.Endpoints ?? [];
      value =
        eps.length === 1
          ? { projectId, endpointId: guidToBase62(eps[0].Id), endpointSlug: eps[0].Slug, problem: null }
          : { projectId, endpointId: null, endpointSlug: null, problem: eps.length === 0 ? 'no_endpoints' : 'many_endpoints' };
    }
  } catch {
    // Not cached: a transient failure (or a scoped credential that cannot enumerate)
    // should not poison five minutes of scope resolution.
    session.lastScopeDiagnosis = { projectId: null, endpointId: null, endpointSlug: null, problem: 'unreachable' };
    return session.lastScopeDiagnosis;
  }
  session.discoveredScope = { value, fetchedAt: Date.now() };
  session.lastScopeDiagnosis = value;
  return value;
}

async function resolveDefaultScope(ctx: AuthToolContext): Promise<Omit<ClaimHandoffInfo, 'captureCount'> | null> {
  const d = await discoverScope(ctx);
  return d.projectId && d.endpointId
    ? { projectId: d.projectId, endpointId: d.endpointId, endpointSlug: d.endpointSlug ?? '' }
    : null;
}

/**
 * Read-scope attribution (pilot-1 ledger item 7): every endpoint read stamps WHICH
 * endpoint answered and AS WHOM (the routed scoped account, or the signed-in default),
 * so a "0 captures" answer is attributable instead of an ambient fabricated-empty-room
 * - the difference between "this stream is empty" and "you read the wrong stream as
 * the wrong identity", which severed an agent's verification chain in pilot-1.
 */
function readScope(ctx: AuthToolContext, endpointId: string, path: string): { endpointId: string; readAs: string } {
  return {
    endpointId,
    readAs: ctx.client.credentialFor?.(path) ?? 'signed-in account',
  };
}

/**
 * Server-authoritative scope reconciliation (0.5.0 rider, #233): read responses may
 * now carry a PascalCase `Scope` stamp ({ProjectId, EndpointId, ReadAs} - base62 ids,
 * ReadAs in the principal vocabulary: owner / member:{role} / seat:{name} / service /
 * scoped). When present it IS the truth - the server resolved the credential - so it
 * becomes the relayed lowercase `scope` and the raw key is dropped. When absent
 * (older server) the client-side fallback stamp answers, exactly as before.
 */
function stampedScope(
  payload: Record<string, unknown>,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  const raw = payload.Scope as
    | { ProjectId?: string | null; EndpointId?: string | null; ReadAs?: unknown }
    | null
    | undefined;
  if (raw && typeof raw.ReadAs === 'string') {
    const { Scope: _serverStamp, ...rest } = payload;
    return {
      ...rest,
      scope: {
        ...(raw.EndpointId ? { endpointId: raw.EndpointId } : {}),
        ...(raw.ProjectId ? { projectId: raw.ProjectId } : {}),
        readAs: raw.ReadAs,
      },
    };
  }
  return { ...payload, scope: fallback };
}

/** Accurate ambiguous_scope error from the last discovery — never a guessed diagnosis. */
function scopeFailure(ctx: AuthToolContext, need: 'project' | 'endpoint'): { code: string; message: string } {
  const p = ctx.session.lastScopeDiagnosis?.problem ?? null;
  const message =
    p === 'no_projects'
      ? 'This account has no projects yet, so there is nothing to scope to.'
      : p === 'no_endpoints'
        ? 'The project has no endpoints yet. Create one with create_endpoint.'
        : p === 'many_projects'
          ? (need === 'project'
              ? 'More than one project exists. Pass projectId from list_projects.'
              : 'More than one project exists. Pass projectId and endpointId (list_projects, then list_endpoints).')
          : p === 'many_endpoints'
            ? 'The project has more than one endpoint. Pass endpointId from list_endpoints.'
            : p === 'unreachable'
              ? 'Could not enumerate projects to infer scope: this credential may be endpoint-scoped (a joined ' +
                'guest reads its projectId and endpointId from the join_invite receipt) or the API was ' +
                'unreachable. Pass the ids explicitly.'
              : (need === 'project'
                  ? 'Pass projectId from list_projects.'
                  : 'Pass endpointId from list_endpoints.');
  return { code: 'ambiguous_scope', message };
}

/**
 * Complete, self-contained walkthrough for minting + installing a write-scoped
 * token. In-band on purpose: not every MCP host has a web-fetch tool, and the
 * ones that do usually gate it behind a permission prompt - the docs URL at the
 * end is for the USER to open, never something you need to fetch.
 */
function writeTokenGuide(): string {
  const web = resolveWebBaseUrl();
  return (
    'If a recipe secret-setup ceremony is in flight, prefer the in-flow grant: the setup page offers ' +
    '[Grant write access] after the secrets are saved, and this connection upgrades automatically ' +
    '(write_granted notice, no restart). Otherwise walk the user through the manual path: ' +
    `(1) open ${web}/settings and under Access Tokens click ` +
    `Generate token with the "Read-only" checkbox UNCHECKED - the token is shown ONCE, ` +
    `copy it immediately; (2) install it with \`flurryport login <token>\` (or set ` +
    `FLURRYPORT_TOKEN in this MCP server's registration); (3) restart the MCP server - ` +
    `token scope is read at startup, so the toolset will not change until then. ` +
    `Docs for the user: ${web}/docs/cli`
  );
}

/**
 * #353: slugs for the workspace deep link. The tools speak opaque ids and the
 * workspace routes on slugs, so a link needs both names for the same thing. Reads are
 * cached for the process because a slug changes about as often as a project is renamed,
 * and they only happen on paths that already ended in a human doing something.
 */
const SLUG_TTL_MS = 5 * 60_000;

async function slugFor(ctx: AuthToolContext, path: string, cacheKey: string): Promise<string | null> {
  const cached = ctx.session.slugCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SLUG_TTL_MS) return cached.slug;
  try {
    const row = (await ctx.client.get(path)) as { Slug?: string };
    if (typeof row.Slug === 'string' && row.Slug.length > 0) {
      ctx.session.slugCache.set(cacheKey, { slug: row.Slug, fetchedAt: Date.now() });
      return row.Slug;
    }
  } catch { /* a link is a courtesy; never let it break the answer */ }
  return null;
}

/**
 * The deepest workspace page that exists for this scope, as a HumanAction. Falls back
 * to the project page, then the dashboard, so the answer always carries a link that
 * opens something real.
 */
async function endpointAction(
  ctx: AuthToolContext,
  label: string,
  targetId: string,
  projectId: string,
  endpointId?: string,
  captureId?: string,
): Promise<HumanAction> {
  const projectSlug = await slugFor(ctx, `/api/v1/projects/${projectId}`, `p:${projectId}`);
  if (!projectSlug) return humanAction(label, workspacePath.dashboard(), targetId);
  const endpointSlug = endpointId
    ? await slugFor(ctx, `/api/v1/projects/${projectId}/endpoints/${endpointId}`, `e:${endpointId}`)
    : null;
  if (!endpointSlug) return humanAction(label, workspacePath.project(projectSlug), targetId);
  return humanAction(
    label,
    captureId
      ? workspacePath.capture(projectSlug, endpointSlug, captureId)
      : workspacePath.endpoint(projectSlug, endpointSlug),
    targetId,
  );
}

/** Plan cache: authenticated meta needs plan quota without a per-call round-trip. */
const PLAN_TTL_MS = 5 * 60_000;

async function getPlan(ctx: AuthToolContext, projectId: string): Promise<ProjectPlanInfo | null> {
  // Seat sessions (quota 'none') never read plans and never touch the shared cache —
  // the cache is keyed by project and one process serves many seat principals.
  if (ctx.quota === 'none') return null;
  const cached = ctx.session.planCache.get(projectId);
  if (cached && Date.now() - cached.fetchedAt < PLAN_TTL_MS) return cached.plan;
  try {
    const plan = (await ctx.client.get(`/api/v1/projects/${projectId}/plan`)) as unknown as ProjectPlanInfo;
    ctx.session.planCache.set(projectId, { plan, fetchedAt: Date.now() });
    return plan;
  } catch {
    return cached?.plan ?? null;
  }
}

/**
 * capturesUsed staleness fix (Codex round-2 item 5): a fire that just LANDED a capture
 * must not report the pre-fire count from the 5-minute plan cache - the receipt's meta
 * is exactly where an agent looks to confirm the fire consumed quota. Bust the cache
 * and refetch (one GET per fire; fires are rare relative to reads). Falls back to the
 * stale plan when the refetch fails - a receipt must never fail over its meta garnish.
 */
async function freshPlanAfterCapture(ctx: AuthToolContext, projectId: string): Promise<ProjectPlanInfo | null> {
  if (ctx.quota === 'none') return null; // seat sessions: no plan reads, no shared-cache writes
  ctx.session.planCache.delete(projectId);
  return getPlan(ctx, projectId);
}

const NEARING_CAP_RATIO = 0.9;

/** Authenticated meta (spec §5 note + §12.2): plan quota + retention deadline + upgrade upsell. */
function authMeta(
  ctx: AuthToolContext,
  plan: ProjectPlanInfo | null,
  opts: { throttled?: boolean; retryAfterSeconds?: number; oldestCaptureAt?: string; burst?: MetaBurst | null } = {},
): AnyMetaEnvelope {
  // Seat sessions (0.5.0): the seat envelope replaces the authed one wholesale, and
  // it replaces it HERE so envelope assembly stays in one place — callers never
  // re-parse emitted JSON, and the one-time notice latches below stay unconsumed.
  if (ctx.metaOverride) return ctx.metaOverride();
  const used = plan?.CurrentMonthCaptures ?? 0;
  const cap = plan && plan.MaxMonthlyCaptures > 0 ? plan.MaxMonthlyCaptures : null;
  const remaining = cap !== null ? Math.max(0, cap - used) : null;
  const billingUrl = `${resolveWebBaseUrl()}/billing`;

  // at_cap outranks throttled: a throttle clears on its own, the cap waits for a reset or upgrade.
  let state: MetaEnvelope['state'] = 'ok';
  if (cap !== null && used >= cap) state = 'at_cap';
  else if (opts.throttled) state = 'throttled';
  else if (cap !== null && used >= cap * NEARING_CAP_RATIO) state = 'nearing_cap';

  const deadlines: MetaEnvelope['deadlines'] = [];
  if (plan && plan.RetentionDays > 0 && opts.oldestCaptureAt) {
    const deleteAt = new Date(
      utcMs(opts.oldestCaptureAt) + plan.RetentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    deadlines.push({
      kind: 'retention_deletion',
      at: deleteAt,
      inMinutes: minutesUntil(deleteAt),
      affects: `captures from ${opts.oldestCaptureAt} onward (rolling ${plan.RetentionDays}-day retention)`,
      message:
        `Captures are deleted ${plan.RetentionDays} days after arrival on this plan. ` +
        'A higher tier keeps them longer.',
      url: billingUrl,
    });
  }

  const actions: MetaEnvelope['actions'] =
    cap !== null
      ? [
          {
            kind: 'upgrade_plan',
            label: 'Upgrade plan',
            url: billingUrl,
            cost: 'paid',
            effect: 'Raises the monthly capture cap and retention (get_upgrade_options has the plan catalog).',
            recommended: state === 'at_cap' || state === 'nearing_cap',
          },
        ]
      : [];

  let upsell: MetaEnvelope['upsell'] = null;
  if (state === 'at_cap' && cap !== null) {
    upsell = {
      message:
        `You've used all ${cap} captures for this month. New captures are rejected ` +
        'until the month resets or the plan is upgraded.',
      url: billingUrl,
    };
  } else if (state === 'nearing_cap' && cap !== null) {
    upsell = {
      message: `You've used ${used} of ${cap} captures this month. A higher tier raises the monthly cap and retention.`,
      url: billingUrl,
    };
  }

  return {
    mode: 'authenticated',
    capturesUsed: used,
    capturesCap: cap,
    capturesRemaining: remaining,
    expiresAt: null,
    expiresInMinutes: null,
    state,
    retryAfterSeconds: opts.throttled ? (opts.retryAfterSeconds ?? 30) : null,
    burst: opts.burst ?? null,
    actions,
    deadlines,
    upsell,
    // Claim outranks write-grant when both are somehow pending; each fires once. The
    // staleness nudge is lowest precedence and re-fires while the server keeps sending it.
    notice: takeClaimNotice(ctx.session) ?? takeWriteNotice(ctx.session) ?? takeCliUpdateNotice(),
  };
}

function mapAuthError(ctx: AuthToolContext, err: unknown, plan: ProjectPlanInfo | null) {
  if (err instanceof AuthApiError) {
    if (err.status === 429) {
      return fail(
        { code: 'throttled', message: err.detail || 'Rate limited. Slow down.', retryAfterSeconds: 30 },
        authMeta(ctx, plan, { throttled: true, retryAfterSeconds: 30 }),
      );
    }
    // 404 is also the cross-tenant / bad-id answer (spec §12.7) — non-enumerable.
    return fail({ code: err.code, message: err.detail || err.message }, authMeta(ctx, plan));
  }
  // Precedent #8: an unknown error's raw message can name internal cluster hosts.
  return fail(sanitizeOutboundError(err), authMeta(ctx, plan));
}

/** Register a plain read tool: GET the path, opaque the ids, wrap in meta. */
function read(
  server: McpServer,
  ctx: AuthToolContext,
  name: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  pathFor: (args: Record<string, unknown>) => string,
  planProjectId?: (args: Record<string, unknown>) => string | undefined,
) {
  server.registerTool(
    name,
    {
      title: toolTitle(name),
      description: description,
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args: Record<string, unknown>) => {
      const projectId = planProjectId?.(args);
      const plan = projectId ? await getPlan(ctx, projectId) : null;
      try {
        const result = await ctx.client.get(pathFor(args));
        return ok(opaqueIds(result), authMeta(ctx, plan));
      } catch (err) {
        return mapAuthError(ctx, err, plan);
      }
    },
  );
}

/**
 * Collection edits (#348) address a collection through its project and endpoint. Both
 * tools resolve the pair the same way: what the caller passed, else the claimed or only
 * room. Returns the pair, or the ready-made refusal when neither is knowable.
 */
async function resolveCollectionScope(
  ctx: AuthToolContext,
  projectId: string | undefined,
  endpointId: string | undefined,
): Promise<{ projectId: string; endpointId: string } | { error: ReturnType<typeof fail> }> {
  if (projectId && endpointId) return { projectId, endpointId };
  const scope = await resolveDefaultScope(ctx);
  if (!scope) {
    return {
      error: fail(
        { code: 'ambiguous_scope', message: 'Pass projectId and endpointId from list_projects / list_endpoints.' },
        authMeta(ctx, await anyCachedPlan(ctx)),
      ),
    };
  }
  return { projectId: projectId ?? scope.projectId, endpointId: endpointId ?? scope.endpointId };
}

/**
 * #361/#377: the post budget the owner surface declares, in UTF-8 bytes. The budget is
 * the receipt, never the gate: no schema or handler rejects a post for size. The only
 * size rejection anywhere is Core's plan payload cap, which stores the oversize post as
 * a rejected capture.
 */
const POST_INTENT_MAX_BYTES = 256 * 1024;

/**
 * #377: the budget an owner receipt reports, so it matches what Core enforces: the
 * declared budget capped at the plan's MaxPayloadBytes. With no plan in hand (or an
 * unlimited cap) the declared budget stands.
 */
function ownerMaxBytes(plan: ProjectPlanInfo | null): number {
  const cap = plan?.MaxPayloadBytes;
  return typeof cap === 'number' && cap > 0 ? Math.min(POST_INTENT_MAX_BYTES, cap) : POST_INTENT_MAX_BYTES;
}

/** Bytes left in a post budget after this body. Never negative. */
export function bytesRemaining(maxBytes: number, sizeBytes: number): number {
  return Math.max(0, maxBytes - sizeBytes);
}

/** #365: the wire verb a seat request carries, so a host watch can match on it. */
const REQUEST_SEAT_VERB = 'fp:request-seat';

/** #365: a seat request is one paragraph of reason, not a document. */
const REQUEST_SEAT_MAX_REASON = 2000;

/**
 * #365: who a seat request is addressed to. The roster's host if it names one,
 * otherwise the open-room address - both are audiences the capture path already
 * accepts, so the ask is never refused for where it was sent.
 */
function hostAddress(roster?: Array<{ Handle?: string; Role?: string }> | null): string {
  const host = (roster ?? []).find(
    (r) => typeof r.Handle === 'string' && r.Handle.length > 0 && (r.Role ?? '').trim().toLowerCase() === 'host');
  return host?.Handle ?? 'all';
}

export function registerAuthTools(server: McpServer, ctx: AuthToolContext): void {
  const id = z.string().describe('Opaque id from a prior list_* call, verbatim.');

  if (ctx.claimHandoff) announceClaim(ctx.session, ctx.claimHandoff);

  server.registerTool(
    'get_capture_url',
    {
      title: 'Get capture URL',
      description:
        "Return a capture URL the user pastes into their webhook provider (Stripe/GitHub/etc.), plus the web app " +
        'URL for browsing captures. Works the same before and after claiming. Omit ids to use the claimed or ' +
        'only endpoint; pass projectId + endpointId to target a specific one.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to auto-pick the claimed or only project.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to auto-pick the claimed or only endpoint.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, endpointId }) => {
      const plan = projectId ? await getPlan(ctx, projectId) : await anyCachedPlan(ctx);
      try {
        let scope: { projectId: string; endpointId: string; endpointSlug: string } | null = null;
        if (projectId && endpointId) {
          const endpoint = (await ctx.client.get(`/api/v1/projects/${projectId}/endpoints/${endpointId}`)) as { Slug: string };
          scope = { projectId, endpointId, endpointSlug: endpoint.Slug };
        } else {
          scope = await resolveDefaultScope(ctx);
        }
        if (!scope) {
          return fail(
scopeFailure(ctx, 'endpoint'),
            authMeta(ctx, plan),
          );
        }
        return ok(
          {
            captureUrl: `${ctx.client.baseUrl}/api/v1/capture/${scope.projectId}/${scope.endpointSlug}`,
            webUrl: `${resolveWebBaseUrl()}/dashboard`,
            projectId: scope.projectId,
            endpointId: scope.endpointId,
            endpointSlug: scope.endpointSlug,
            // Durable orientation (run-4 feedback): the one-time session_claimed notice can be
            // consumed mid-batch and never surfaced; this block survives being missed.
            ...(ctx.session.claimScope ? { claimed: { endpointSlug: ctx.session.claimScope.endpointSlug, migratedCaptureCount: ctx.session.claimScope.captureCount } } : {}),
            hint:
              'Point the webhook provider at captureUrl. Captures are permanent and encrypted on this account; ' +
              'browse them at webUrl or via list_captures.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'start_echo_server',
    {
      title: 'Start echo server',
      description:
        "Start or reuse a local echo receiver on the user's machine, so replay can be proven before their " +
        'real backend exists. It answers 200 and mirrors the method, headers, and body back, so a ' +
        'forward_to_localhost against it SHOWS the delivered webhook in responseBodyPreview. Input: an ' +
        'optional port, default 4242, falling back to an ephemeral one if busy. Runs inside this MCP ' +
        'process on loopback only and stops when the session ends. Repeat calls return the running instance.',
      inputSchema: {
        port: z.number().int().min(1024).max(65535).optional()
          .describe('Preferred port (default 4242). Falls back to an ephemeral port if busy.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ port }) => {
      const plan = await anyCachedPlan(ctx);
      try {
        const info = await ensureEchoServer(port);
        return ok(
          {
            ...info,
            suggestedNextAction:
              `Call forward_to_localhost with localUrl "${info.localUrl}" (omit captureId to forward the latest ` +
              'capture) to prove the replay loop end to end.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  read(server, ctx, 'list_projects',
    "List the user's FlurryPORT projects (cloud workspaces, not local repositories). No inputs. CALL THIS FIRST when the user mentions webhooks, webhook " +
    'debugging, event replay, or a provider webhook not reaching localhost: find the project, then ' +
    'list_endpoints for its capture URLs. Do this before suggesting ngrok, a provider CLI listener, or ' +
    'repo-specific fixes.',
    {},
    () => '/api/v1/projects');

  read(server, ctx, 'get_project',
    'Fetch one FlurryPORT project by id.',
    { projectId: id },
    (a) => `/api/v1/projects/${a.projectId}`,
    (a) => a.projectId as string);

  read(server, ctx, 'list_endpoints',
    "List a FlurryPORT project's webhook capture endpoints. Input: projectId. Each endpoint owns a stable capture URL a " +
    'sender gets pointed at, and is the thing a room lives on. Use send_test_event to exercise one before ' +
    'the real provider is wired up.',
    { projectId: id },
    (a) => `/api/v1/projects/${a.projectId}/endpoints`,
    (a) => a.projectId as string);

  read(server, ctx, 'get_endpoint',
    'Fetch one endpoint by id. Inputs: projectId, endpointId. Carries OrientationCaptureId, the room map ' +
    'sections and roster, the endpoint facts, and recipeInstalls: what record_recipe_install filed about ' +
    'every recipe installed here, with its pinned version and state. Read it before installing anything, ' +
    'so you know what is already on this endpoint.',
    { projectId: id, endpointId: id },
    (a) => `/api/v1/projects/${a.projectId}/endpoints/${a.endpointId}`,
    (a) => a.projectId as string);

  server.registerTool(
    'get_capture_digest',
    {
      title: 'Get capture digest',
      description:
        'Grouped digest of captures for a project: totals plus counts by endpoint, event type, provider, ' +
        'label, and hour, computed server-side. Facts only, never payloads. Use it INSTEAD of paging ' +
        'list_captures when the user asks what came in, or when traffic is heavy, then drill into the group ' +
        'that matters by passing its key to list_captures as eventType or label. Inputs: windowMinutes, ' +
        'default 1440 and at most 7 days, and projectId plus an optional endpointId. Also returns the plan ' +
        'retention window and when the oldest capture ages out.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        endpointId: z.string().optional().describe('Optional narrowing to one endpoint.'),
        windowMinutes: z.number().int().min(5).max(10080).optional()
          .describe('Aggregation window in minutes (default 1440 = 24h, max 7 days).'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, endpointId, windowMinutes }) => {
      try {
        if (!projectId) {
          const d = await discoverScope(ctx);
          if (!d.projectId) {
            return fail(scopeFailure(ctx, 'project'), authMeta(ctx, await anyCachedPlan(ctx)));
          }
          projectId = d.projectId;
        }
        const qs =
          (endpointId ? `endpointId=${endpointId}&` : '') + `windowMinutes=${windowMinutes ?? 1440}`;
        const path = `/api/v1/projects/${projectId}/captures/digest?${qs}`;
        const result = (await ctx.client.get(path)) as { Retention?: { OldestRetainedAt?: string } };
        return ok(
          stampedScope(result as unknown as Record<string, unknown>, {
            projectId,
            ...(endpointId ? { endpointId } : {}),
            readAs: ctx.client.credentialFor?.(path) ?? 'signed-in account',
          }),
          authMeta(ctx, await anyCachedPlan(ctx), { oldestCaptureAt: result.Retention?.OldestRetainedAt }),
        );
      } catch (err) {
        return mapAuthError(ctx, err, await anyCachedPlan(ctx));
      }
    },
  );

  server.registerTool(
    'register_watch',
    {
      title: 'Register watch',
      description:
        'Register a standing watch on an endpoint: a JSONata predicate over $body, $headers, and $query, ' +
        'evaluated server-side against every future capture. Use it when the user wants specific events ' +
        'flagged without polling payloads. Inputs: name, predicate, an optional label, and endpointId. ' +
        'Matches are counted, and a label is stamped onto matching captures so the digest ByLabel group ' +
        'and the list_captures label filter pick them up. A predicate may NOT reference $secrets. Example ' +
        'predicate: $body.type = "charge.failed".',
      inputSchema: {
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        name: z.string().min(1).max(200).describe('Human-readable watch name.'),
        predicate: z.string().min(1).max(2000).describe('JSONata predicate over $body/$headers/$query.'),
        label: z.string().max(200).optional()
          .describe('Label stamped onto matching captures (drives digest ByLabel + drill-down).'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ endpointId, name, predicate, label }) => {
      try {
        if (!endpointId) {
          const scope = await resolveDefaultScope(ctx);
          if (!scope) {
            return fail(
              scopeFailure(ctx, 'endpoint'),
              authMeta(ctx, await anyCachedPlan(ctx)),
            );
          }
          endpointId = scope.endpointId;
        }
        const result = await ctx.client.post(`/api/v1/endpoints/${endpointId}/watches`, {
          Name: name,
          Predicate: predicate,
          Label: label ?? null,
        });
        return ok(
          {
            ...opaqueIds(result),
            hint: 'The watch now runs against every new capture on this endpoint. Check matches with list_watches or get_capture_digest.',
          },
          authMeta(ctx, await anyCachedPlan(ctx)),
        );
      } catch (err) {
        return mapAuthError(ctx, err, await anyCachedPlan(ctx));
      }
    },
  );

  server.registerTool(
    'list_watches',
    {
      title: 'List watches',
      description:
        'List the watches on an endpoint with their facts: enabled state, match count, last match time, and ' +
        'last predicate error, since a broken watch shows its error here instead of failing captures. Use ' +
        'it after register_watch, or when the user asks what is being watched or whether anything matched. ' +
        'On a guest credential each predicate reads null, so the host\'s matching logic stays private; it ' +
        'still works for a joined guest as the stream roster, since watch labels are the participant names.',
      inputSchema: {
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ endpointId }) => {
      try {
        if (!endpointId) {
          const scope = await resolveDefaultScope(ctx);
          if (!scope) {
            return fail(
              scopeFailure(ctx, 'endpoint'),
              authMeta(ctx, await anyCachedPlan(ctx)),
            );
          }
          endpointId = scope.endpointId;
        }
        const path = `/api/v1/endpoints/${endpointId}/watches`;
        const result = await ctx.client.get(path);
        return ok(
          stampedScope(opaqueIds(result), readScope(ctx, endpointId, path)),
          authMeta(ctx, await anyCachedPlan(ctx)),
        );
      } catch (err) {
        return mapAuthError(ctx, err, await anyCachedPlan(ctx));
      }
    },
  );

  server.registerTool(
    'set_watch_enabled',
    {
      title: 'Enable or disable watch',
      description:
        'Enable or disable a watch by id (disable keeps its history and counters; there is no hard delete). ' +
        'Get ids from list_watches.',
      inputSchema: {
        endpointId: id,
        watchId: id,
        enabled: z.boolean(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ endpointId, watchId, enabled }) => {
      try {
        const result = await ctx.client.put(
          `/api/v1/endpoints/${endpointId}/watches/${watchId}/enabled`,
          { Enabled: enabled },
        );
        return ok(opaqueIds(result), authMeta(ctx, await anyCachedPlan(ctx)));
      } catch (err) {
        return mapAuthError(ctx, err, await anyCachedPlan(ctx));
      }
    },
  );

  server.registerTool(
    'list_captures',
    {
      title: 'List captures',
      description:
        'Read an endpoint: the captures it holds, newest first, as summaries. Inputs: includeBody to ' +
        'inline each body, skip and take for paging with limit accepted as an alias for take, after for ' +
        'catch-up polling, and endpointId, or omit it for the claimed or only endpoint. Pass after, an ' +
        'opaque cursor from a prior NextCursor, to get ONLY what landed since, oldest first, in one cheap ' +
        'call with no per-capture get_capture. Rows ride the server DTO shape, Requests[] with PascalCase ' +
        'keys, in every mode. The response carries NextCursor spelled exactly that way, and each row ' +
        'carries its own Cursor: pass either as after on your next poll.',
      inputSchema: {
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        skip: z.number().int().min(0).optional().describe('Rows to skip (default 0). Ignored when after is set.'),
        take: z.number().int().min(1).max(100).optional().describe('Rows to return (default 20).'),
        limit: z.number().int().min(1).max(100).optional().describe('Alias for take.'),
        eventType: z.string().max(200).optional()
          .describe('Digest drill-down: exact ByEventType key from get_capture_digest.'),
        label: z.string().max(200).optional()
          .describe('Digest drill-down: exact ByLabel key from get_capture_digest.'),
        after: z.string().max(500).optional()
          .describe('Opaque cursor from a prior response NextCursor (or a row Cursor): return only captures AFTER it, oldest-first (catch_up). Ignores skip.'),
        includeBody: z.boolean().optional()
          .describe('Inline each capture body (decrypted, bounded, redacted on redact-scoped tokens) so you skip the per-row get_capture.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ endpointId, skip, take, limit, eventType, label, after, includeBody }) => {
      try {
        if (!endpointId) {
          const scope = await resolveDefaultScope(ctx);
          if (!scope) {
            return fail(
              scopeFailure(ctx, 'endpoint'),
              authMeta(ctx, await anyCachedPlan(ctx)),
            );
          }
          endpointId = scope.endpointId;
        }
        const filters =
          (eventType ? `&eventType=${encodeURIComponent(eventType)}` : '') +
          (label ? `&label=${encodeURIComponent(label)}` : '') +
          (after ? `&after=${encodeURIComponent(after)}` : '') +
          (includeBody ? '&includeBody=true' : '');
        const path = `/api/v1/endpoints/${endpointId}/captured-requests?skip=${skip ?? 0}&take=${take ?? limit ?? 20}${filters}`;
        const result = await ctx.client.get(path);
        // Retention deadline rides when we can see the oldest capture in this page.
        const items = Object.values(result).find(Array.isArray) as { CreatedAt?: string }[] | undefined;
        const oldest = items?.length ? items[items.length - 1]?.CreatedAt : undefined;
        return ok(
          stampedScope(opaqueIds(result), readScope(ctx, endpointId, path)),
          authMeta(ctx, await anyCachedPlan(ctx), { oldestCaptureAt: oldest }),
        );
      } catch (err) {
        return mapAuthError(ctx, err, await anyCachedPlan(ctx));
      }
    },
  );

  server.registerTool(
    'wait_for_captures',
    {
      title: 'Wait for captures',
      description:
        'Block until a new capture lands on the endpoint or the timeout elapses, then return what is new ' +
        'since your cursor with bodies inline, exactly like list_captures with after. Use it for a ' +
        'DEDICATED monitor whose only job is to follow a stream; to check between other work, prefer ' +
        'list_captures with after, which returns immediately. Inputs: after, a NextCursor from any read, ' +
        'timeoutSeconds up to 25, includeBody, and endpointId. Returns immediately if captures already ' +
        'landed since the cursor, so you never miss events between calls.',
      inputSchema: {
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        after: z.string().max(500).optional()
          .describe('Opaque cursor from a prior NextCursor: return only captures after it (oldest-first).'),
        timeoutSeconds: z.number().int().min(1).max(25).optional()
          .describe('How long to hold before returning empty (default 20, max 25); re-call to keep waiting.'),
        includeBody: z.boolean().optional()
          .describe('Inline each capture body so you skip a follow-up get_capture per row.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ endpointId, after, timeoutSeconds, includeBody }) => {
      try {
        if (!endpointId) {
          const scope = await resolveDefaultScope(ctx);
          if (!scope) {
            return fail(
              scopeFailure(ctx, 'endpoint'),
              authMeta(ctx, await anyCachedPlan(ctx)),
            );
          }
          endpointId = scope.endpointId;
        }
        const qs =
          (after ? `after=${encodeURIComponent(after)}&` : '') +
          `timeoutSeconds=${timeoutSeconds ?? 20}` +
          (includeBody ? '&includeBody=true' : '');
        const path = `/api/v1/endpoints/${endpointId}/captured-requests/wait?${qs}`;
        const result = await ctx.client.get(path);
        const items = Object.values(result).find(Array.isArray) as { CreatedAt?: string }[] | undefined;
        const oldest = items?.length ? items[items.length - 1]?.CreatedAt : undefined;
        return ok(
          stampedScope(opaqueIds(result), readScope(ctx, endpointId, path)),
          authMeta(ctx, await anyCachedPlan(ctx), { oldestCaptureAt: oldest }),
        );
      } catch (err) {
        return mapAuthError(ctx, err, await anyCachedPlan(ctx));
      }
    },
  );

  server.registerTool(
    'get_capture',
    {
      title: 'Get capture',
      description:
        'Fetch one capture in full by id: headers, query string, and body. Inputs: captureId, with id ' +
        'accepted as an alias, and endpointId. The body is decrypted on read and returned as text when ' +
        'printable, and bodyEncoding says which. On a scoped credential holding the redact-PII scope, ' +
        'common PII patterns are masked best-effort and the response carries redacted true: do not treat ' +
        'a masked value as the real payload. The true payload still reaches the user\'s app on forward. On ' +
        'a signed endpoint the response also carries MatchedSigningRef and MatchedSignerLabel for signer ' +
        'attribution, plus any watch-stamped UserLabel.',
      inputSchema: {
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        captureId: id.optional(),
        id: z.string().optional().describe('Alias for captureId.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ endpointId, captureId, id: captureIdAlias }) => {
      captureId = captureId ?? captureIdAlias;
      if (!captureId) {
        return fail(
          { code: 'not_found', message: 'Pass captureId (or its alias id) from a prior list_captures row, verbatim.' },
          authMeta(ctx, await anyCachedPlan(ctx)),
        );
      }
      try {
        if (!endpointId) {
          const scope = await resolveDefaultScope(ctx);
          if (!scope) {
            return fail(
              scopeFailure(ctx, 'endpoint'),
              authMeta(ctx, await anyCachedPlan(ctx)),
            );
          }
          endpointId = scope.endpointId;
        }
        const path = `/api/v1/endpoints/${endpointId}/captured-requests/${captureId}`;
        const raw = (await ctx.client.get(path)) as unknown as CapturedRequestDetail;
        const { body, bodyEncoding } = decodeBody(raw.BodyBytes);
        // 0.5.0 rider: the single read is stamped too (server Scope when present,
        // client fallback otherwise) - it was the one read without attribution.
        return ok(
          stampedScope(
            {
              ...opaqueIds({ ...raw, BodyBytes: undefined }),
              body,
              bodyEncoding,
              headers: safeParseHeaders(raw.Headers),
              redacted: raw.Redacted === true,
            },
            readScope(ctx, endpointId, path),
          ),
          authMeta(ctx, await anyCachedPlan(ctx)),
        );
      } catch (err) {
        return mapAuthError(ctx, err, await anyCachedPlan(ctx));
      }
    },
  );

  read(server, ctx, 'get_capture_executions',
    'Replay history for one capture (which targets it went to, status codes, durations).',
    { endpointId: id, captureId: id },
    (a) => `/api/v1/endpoints/${a.endpointId}/captured-requests/${a.captureId}/executions`);

  read(server, ctx, 'list_replay_executions',
    "A project's replay executions, newest first (paged).",
    {
      projectId: id,
      skip: z.number().int().min(0).optional(),
      take: z.number().int().min(1).max(100).optional(),
    },
    (a) => `/api/v1/projects/${a.projectId}/replay-executions?skip=${a.skip ?? 0}&take=${a.take ?? 20}`,
    (a) => a.projectId as string);

  server.registerTool(
    'get_replay_execution',
    {
      title: toolTitle('get_replay_execution'),
      description:
        'One replay execution in detail, including the response body. Inputs: projectId, executionId. The ' +
        'body is full when the plan includes FullResponseBody, otherwise a 4KB preview, so check ' +
        'ResponseBodyTruncated before parsing. A "No CLI connected" failure carries the listener steps.',
      inputSchema: { projectId: id, executionId: id },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (a: Record<string, unknown>) => {
      const plan = await getPlan(ctx, a.projectId as string);
      try {
        const result = opaqueIds(
          await ctx.client.get(`/api/v1/projects/${a.projectId}/replay-executions/${a.executionId}`),
        ) as Record<string, unknown>;
        const error = typeof result.Error === 'string' ? result.Error : '';
        if (/no cli connected/i.test(error)) {
          return ok(
            { ...result, hint: LOCAL_LISTENER_HINT, steps: LOCAL_LISTENER_STEPS },
            authMeta(ctx, plan),
          );
        }
        return ok(result, authMeta(ctx, plan));
      } catch (err) {
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  read(server, ctx, 'list_replay_targets',
    "An endpoint's replay targets. Inputs: projectId, endpointId. Targets are the ONLY destinations " +
    'server-side replay can send to. Rows count against the per-project MaxReplayTargets quota whether ' +
    'armed or not, and deleting one is human-only, so read this with get_project_plan to check headroom ' +
    'before create_replay_target.',
    { projectId: id, endpointId: id },
    (a) => `/api/v1/projects/${a.projectId}/endpoints/${a.endpointId}/replay-targets`,
    (a) => a.projectId as string);

  read(server, ctx, 'get_transformations',
    "An endpoint's transformation roster: per transformation the id, name, latest version number and " +
    'frozen flag, step count, and standing binding count. Inputs: projectId, endpointId. Use it to check ' +
    'transformation and binding headroom before create_transformation and bind_transformation, to pick ' +
    'the one to revise with update_transformation instead of creating another, and to verify after a ' +
    'human removes a routing rule that the transformation survived: bindingCount drops and the row ' +
    'remains, while a deleted transformation is gone from the roster entirely.',
    { projectId: id, endpointId: id },
    (a) => `/api/v1/projects/${a.projectId}/endpoints/${a.endpointId}/transformations`,
    (a) => a.projectId as string);

  // ---- Collections: the pin (control plane durable, data plane rolling) ----
  // Ratified model (run-4 brief): a collection GROUPS captures under a name and PINS
  // them - items become retention-exempt fixtures, so pinned canon survives while
  // ordinary captures roll off with the plan's retention. These four verbs close the
  // gap where only a human clicking "Save collection" in the workspace could pin
  // (writers-room constitutions were rolling off under their own agents). Deletion
  // stays human-only by design, like every other MCP surface.

  read(server, ctx, 'list_collections',
    "An endpoint's capture collections: named, durable groups of pinned captures. A collection is the " +
    'pin, so every capture in one is retention-exempt and survives while ordinary captures roll off on ' +
    'the plan\'s schedule. Inputs: projectId and endpointId. Rows carry id, name, description, and ' +
    'itemCount. Read headroom against get_project_plan MaxCollections and MaxCollectionItems before ' +
    'create_collection.',
    { projectId: id, endpointId: id },
    (a) => `/api/v1/projects/${a.projectId}/endpoints/${a.endpointId}/collections`,
    (a) => a.projectId as string);

  read(server, ctx, 'get_collection',
    'One collection in full: its items in ordinalPosition order, each with the capture id, method, ' +
    'provider hint, event type, and label. Items are summaries, so fetch a body with get_capture using ' +
    'the capturedRequestId. The order is the collection\'s replay order. Inputs: collectionId, with ' +
    'projectId and endpointId.',
    { projectId: id, endpointId: id, collectionId: id },
    (a) => `/api/v1/projects/${a.projectId}/endpoints/${a.endpointId}/collections/${a.collectionId}`,
    (a) => a.projectId as string);

  server.registerTool(
    'create_collection',
    {
      title: 'Create collection',
      description:
        'Create a named collection from one or more captures, PINNING them: members become ' +
        'retention-exempt and survive the plan\'s capture retention. Use it to preserve decisions, room ' +
        'canon, or regression fixtures that must outlive the rolling data plane. Inputs: name, an optional ' +
        'description, captureIds with at least one and the order becoming the collection order, and ' +
        'projectId plus endpointId. Read-write token. A collection cannot be empty. Items come out again ' +
        'with remove_from_collection, or swap in place with replace_collection_item, both owner only. ' +
        'Deleting a collection is human-only, in the workspace.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        name: z.string().min(1).max(100).describe('Collection name shown in the workspace.'),
        description: z.string().max(500).optional().describe('What this collection preserves and why.'),
        captureIds: z.array(z.string()).min(1).max(200)
          .describe('Capture ids to pin, verbatim from list_captures - at least one; order becomes the collection order.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ projectId, endpointId, name, description, captureIds }) => {
      if (!projectId || !endpointId) {
        const scope = await resolveDefaultScope(ctx);
        if (!scope) {
          return fail(
            { code: 'ambiguous_scope', message: 'Pass projectId and endpointId from list_projects / list_endpoints.' },
            authMeta(ctx, await anyCachedPlan(ctx)),
          );
        }
        projectId = projectId ?? scope.projectId;
        endpointId = endpointId ?? scope.endpointId;
      }
      const plan = await getPlan(ctx, projectId);
      let captureGuids: string[];
      try {
        captureGuids = (captureIds as string[]).map(base62ToGuid);
      } catch {
        return fail(
          { code: 'validation', message: 'A captureId is not a valid id. Pass ids verbatim from list_captures.' },
          authMeta(ctx, plan),
        );
      }
      try {
        const result = await ctx.client.post(
          `/api/v1/projects/${projectId}/endpoints/${endpointId}/collections`,
          { Name: name, Description: description ?? null, CapturedRequestIds: captureGuids },
        );
        return ok(
          {
            ...opaqueIds(result),
            hint:
              'Collection created and its captures are PINNED (retention-exempt). Verify membership with ' +
              'get_collection; add later captures with add_to_collection.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'creating collections');
        if (isLimitError(err)) return failLimit(err, plan, projectId, { endpointId });
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'add_to_collection',
    {
      title: 'Add to collection',
      description:
        'Append captures to an existing collection, PINNING them: the incremental half of ' +
        'create_collection, for a canon that grows over time. Inputs: collectionId, captureIds appended ' +
        'in the given order, and projectId plus endpointId. Returns addedCount, which counts only the ' +
        'ones that actually joined. Read-write token, and the captures must belong to the collection\'s ' +
        'own endpoint. The per-collection item cap applies server-side: a refusal names the cap, the ' +
        'options, and a humanAction pointing at the collection so a person can free a slot. To replace ' +
        'what a section holds, use replace_collection_item rather than adding beside the old item.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        collectionId: z.string().describe('Opaque collection id from list_collections / create_collection, verbatim.'),
        captureIds: z.array(z.string()).min(1).max(200)
          .describe('Capture ids to append, verbatim from list_captures; appended in the given order.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ projectId, endpointId, collectionId, captureIds }) => {
      if (!projectId || !endpointId) {
        const scope = await resolveDefaultScope(ctx);
        if (!scope) {
          return fail(
            { code: 'ambiguous_scope', message: 'Pass projectId and endpointId from list_projects / list_endpoints.' },
            authMeta(ctx, await anyCachedPlan(ctx)),
          );
        }
        projectId = projectId ?? scope.projectId;
        endpointId = endpointId ?? scope.endpointId;
      }
      const plan = await getPlan(ctx, projectId);
      let captureGuids: string[];
      try {
        captureGuids = (captureIds as string[]).map(base62ToGuid);
      } catch {
        return fail(
          { code: 'validation', message: 'A captureId is not a valid id. Pass ids verbatim from list_captures.' },
          authMeta(ctx, plan),
        );
      }
      try {
        const result = await ctx.client.post(
          `/api/v1/projects/${projectId}/endpoints/${endpointId}/collections/${collectionId}/captures`,
          { CapturedRequestIds: captureGuids },
        );
        return ok(
          {
            ...opaqueIds(result),
            hint:
              'addedCount is how many actually joined (captures already in the collection are not ' +
              'double-added). The appended captures are now pinned. Verify with get_collection.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'adding to collections');
        if (isLimitError(err)) return failLimit(err, plan, projectId, { endpointId, targetId: collectionId });
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  // ── #348 the owner-only collection edits. A canon collection holds one item per
  // section, so re-ratifying means the new ruling takes the old one's place. Neither
  // tool is mounted on the seat server, and the routes are IRequireCollectionOwnership
  // with no membership marker, so a seat or member answers 404 rather than an oracle.

  server.registerTool(
    'remove_from_collection',
    {
      title: 'Remove from collection',
      description:
        'Take one capture out of a collection. Use it to retire a pin that no longer belongs; to swap one ' +
        'for another, use replace_collection_item instead so the section is never momentarily empty. ' +
        'Owner only, and it needs a read-write token. Inputs: collectionId, captureId, and optionally ' +
        'projectId and endpointId. Returns removedCount, plus a humanAction link to the collection when ' +
        'the workspace is still where the rest of the tidy-up happens. A capture that leaves its last ' +
        'collection stops being retention-exempt and ages out under the plan. ' +
        'New in 0.6.0: notes that do not mention it are stale.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        collectionId: z.string().describe('Opaque collection id from list_collections, verbatim.'),
        captureId: z.string().describe('Opaque capture id to remove, verbatim from get_collection.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ projectId, endpointId, collectionId, captureId }) => {
      const scoped = await resolveCollectionScope(ctx, projectId, endpointId);
      if ('error' in scoped) return scoped.error;
      const plan = await getPlan(ctx, scoped.projectId);
      let captureGuid: string;
      try {
        captureGuid = base62ToGuid(captureId);
      } catch {
        return fail(
          { code: 'validation', message: 'captureId is not a valid id. Pass it verbatim from get_collection.' },
          authMeta(ctx, plan),
        );
      }
      try {
        const result = await ctx.client.post(
          `/api/v1/projects/${scoped.projectId}/endpoints/${scoped.endpointId}/collections/${collectionId}/remove-captures`,
          { CapturedRequestIds: [captureGuid] },
        );
        return ok(
          {
            ...opaqueIds(result),
            // #353: removal is where the cold host ran out of road. The rest of the
            // tidy-up (deleting the collection, re-ordering it, checking what is left)
            // is workspace work, so say which page and which collection.
            humanAction: await endpointAction(
              ctx,
              'Open the endpoint Collections tab to see what this collection holds now',
              collectionId,
              scoped.projectId,
              scoped.endpointId,
            ),
            hint:
              'Removed. If that capture is in no other collection it is no longer a fixture, so plan ' +
              'retention applies to it again. Verify the collection with get_collection.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'removing from collections');
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'replace_collection_item',
    {
      title: 'Replace collection item',
      description:
        'Swap one capture for another in a collection, in one call: the replacement takes the slot the ' +
        'previous item held, then the previous item is removed. Use it when a section is re-ratified and ' +
        'the collection should hold the new ruling instead of the old one. The collection never holds both ' +
        'and never holds neither, and the swap does not count against the per-collection item cap. Owner ' +
        'only, and it needs a read-write token. Inputs: collectionId, previousCaptureId, ' +
        'replacementCaptureId, an optional sectionLabel echoed on the receipt, and optionally projectId ' +
        'and endpointId. Returns collectionId, removed, added, wasAlreadyPresent, and itemCount. Answers ' +
        'collection_item_absent with a 409 when the previous capture is not in the collection: read it ' +
        'with get_collection and replace what it actually holds. ' +
        'New in 0.6.0: notes that do not mention it are stale.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        collectionId: z.string().describe('Opaque collection id from list_collections, verbatim.'),
        sectionLabel: z.string().max(40).optional().describe('The section this swap is for; echoed on the receipt.'),
        previousCaptureId: z.string().describe('Opaque id of the capture being replaced, verbatim from get_collection.'),
        replacementCaptureId: z.string().describe('Opaque id of the capture taking its place, verbatim from list_captures.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ projectId, endpointId, collectionId, sectionLabel, previousCaptureId, replacementCaptureId }) => {
      const scoped = await resolveCollectionScope(ctx, projectId, endpointId);
      if ('error' in scoped) return scoped.error;
      const plan = await getPlan(ctx, scoped.projectId);
      let previousGuid: string;
      let replacementGuid: string;
      try {
        previousGuid = base62ToGuid(previousCaptureId);
        replacementGuid = base62ToGuid(replacementCaptureId);
      } catch {
        return fail(
          { code: 'validation', message: 'A capture id is not a valid id. Pass ids verbatim from get_collection / list_captures.' },
          authMeta(ctx, plan),
        );
      }
      try {
        const result = await ctx.client.post(
          `/api/v1/projects/${scoped.projectId}/endpoints/${scoped.endpointId}/collections/${collectionId}/replace-item`,
          {
            SectionLabel: sectionLabel ?? null,
            PreviousCapturedRequestId: previousGuid,
            ReplacementCapturedRequestId: replacementGuid,
          },
        );
        return ok(
          {
            ...opaqueIds(result),
            hint:
              'Swapped in one act: the replacement is pinned and the previous item is out. itemCount is ' +
              'the size after the swap, so it should match what it was before.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'editing collections');
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'get_replay_target',
    {
      title: 'Get replay target',
      description:
        'One replay target in detail, with its deliveryHeaders: the custom headers applied on top of the ' +
        'captured headers at delivery, whose values may be $secrets.NAME vault references resolved ' +
        'server-side at send time. Use it to verify wiring after set_target_headers. Inputs: projectId, ' +
        'endpointId, targetId. A literal credential value a user pasted in the browser comes back masked ' +
        'as "***", which is expected rather than missing data.',
      inputSchema: { projectId: id, endpointId: id, targetId: id },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, endpointId, targetId }) => {
      const plan = await getPlan(ctx, projectId as string);
      try {
        const base = `/api/v1/projects/${projectId}/endpoints/${endpointId}/replay-targets/${targetId}`;
        const target = await ctx.client.get(base);
        let deliveryHeaders: unknown = [];
        try {
          const h = (await ctx.client.get(`${base}/headers`)) as { Headers?: unknown };
          deliveryHeaders = h.Headers ?? [];
        } catch { /* advisory: a header-read failure must not hide the target itself */ }
        return ok(opaqueIds({ ...(target as Record<string, unknown>), deliveryHeaders }), authMeta(ctx, plan));
      } catch (err) {
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  read(server, ctx, 'get_project_plan',
    "The project's plan, its limits, and current usage, including MaxWatchesPerEndpoint, the watch budget " +
    'to check before register_watch. Use it to explain a quota or feature-gate error. Input: projectId.',
    { projectId: id },
    (a) => `/api/v1/projects/${a.projectId}/plan`,
    (a) => a.projectId as string);

  server.registerTool(
    'capture_count',
    {
      title: 'Count captures',
      description:
        'Cheap progress check: monthly quota usage, plus the accepted and rejected split, the latest ' +
        'capture timestamps, and the per-minute burst window when scoped with projectId and endpointId. ' +
        'Use it while an external sender is generating webhooks, to report progress and pace batches ' +
        'without eating 429s.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; required together with endpointId for endpoint-scoped stats.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; include to get burst window + accepted/rejected for one endpoint.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, endpointId }) => {
      // Auto-scope to the claimed or only endpoint when ids are omitted (agent feedback:
      // the common single-endpoint case should not require id archaeology).
      if (!projectId || !endpointId) {
        const scope = await resolveDefaultScope(ctx);
        if (scope) {
          projectId = projectId ?? scope.projectId;
          endpointId = endpointId ?? scope.endpointId;
        }
      }
      const plan = projectId ? await getPlan(ctx, projectId) : await anyCachedPlan(ctx);
      try {
        const totals = (await ctx.client.get('/api/v1/captures/my-count')) as { Count?: number };
        const cap = plan && plan.MaxMonthlyCaptures > 0 ? plan.MaxMonthlyCaptures : null;
        const used = plan?.CurrentMonthCaptures ?? null;
        const payload: Record<string, unknown> = {
          capturesThisMonth: used,
          monthlyCap: cap,
          capturesRemaining: cap !== null && used !== null ? Math.max(0, cap - used) : null,
          totalCapturesAllTime: totals.Count ?? null,
          ...(ctx.session.claimScope ? { claimed: { endpointSlug: ctx.session.claimScope.endpointSlug, migratedCaptureCount: ctx.session.claimScope.captureCount } } : {}),
        };
        let burst: MetaBurst | null = null;
        if (projectId && endpointId) {
          const stats = (await ctx.client.get(
            `/api/v1/projects/${projectId}/endpoints/${endpointId}/capture-stats`,
          )) as {
            AcceptedCount: number; RejectedCount: number;
            LatestCaptureAt?: string | null; LatestRejectedAt?: string | null;
            BurstLimit: number; BurstUsed: number; BurstResetsInSeconds: number;
          };
          burst = burstFromPing(stats);
          payload.endpoint = {
            accepted: stats.AcceptedCount,
            rejected: stats.RejectedCount,
            totalAttempts: stats.AcceptedCount + stats.RejectedCount,
            latestCaptureAt: stats.LatestCaptureAt ? toUtcIso(stats.LatestCaptureAt) : null,
            latestRejectedAt: stats.LatestRejectedAt ? toUtcIso(stats.LatestRejectedAt) : null,
          };
          // Inline the newest few summaries so the common "what just arrived?" path
          // needs no second call (agent feedback, 0.2.3).
          try {
            const latest = (await ctx.client.get(
              `/api/v1/endpoints/${endpointId}/captured-requests?skip=0&take=3`,
            )) as Record<string, unknown>;
            const items = Object.values(latest).find(Array.isArray) as
              | Array<{ Id: string; HttpMethod?: string; ProviderHint?: string | null; ProviderEventType?: string | null; RejectionReason?: string | null; CreatedAt?: string }>
              | undefined;
            payload.latestCaptures = (items ?? []).map((c) => ({
              id: guidToBase62(c.Id),
              method: c.HttpMethod ?? null,
              providerHint: c.ProviderHint ?? null,
              providerEventType: c.ProviderEventType ?? null,
              rejected: c.RejectionReason != null,
              createdAt: c.CreatedAt ? toUtcIso(c.CreatedAt) : null,
            }));
          } catch {
            /* summaries are a convenience — never fail the count over them */
          }
        }
        return ok(payload, authMeta(ctx, plan, { burst }));
      } catch (err) {
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'send_test_event',
    {
      title: 'Send test event',
      description:
        "Send provider-shaped TEST webhooks to one of the user's capture endpoints, so they can exercise " +
        'the capture loop before the real provider is wired up. Bodies and headers light up provider and ' +
        'event-type detection, but the signature headers are placeholders: they will NOT pass signature ' +
        'verification, and an endpoint with signature validation configured stores the sends as rejected. ' +
        'Prefer pointing the real provider at the capture URL once the scaffolding works. Sends count ' +
        'against the monthly plan quota and the tool refuses up front when count exceeds what remains. ' +
        'Each delivery returns a syntheticEventId and a testId, also sent as the x-flurryport-test-id ' +
        'header, for correlation with list_captures.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        provider: z.enum(['stripe', 'github', 'shopify', 'slack', 'twilio'])
          .describe('Which provider the test events should imitate.'),
        eventType: z.string().optional()
          .describe(`Provider event type. Defaults: ${JSON.stringify(DEFAULT_EVENT_TYPES)}`),
        bodyOverrides: z.record(z.string(), z.unknown()).optional()
          .describe('Deep-merged into the template body (objects merge, other values replace). Twilio merges into the form fields.'),
        count: z.number().int().min(1).max(25).optional()
          .describe('How many events to send (default 1, max 25).'),
        pace: z.enum(['auto', 'none']).optional()
          .describe('auto (default): wait out the burst window inside the call. none: refuse if the batch cannot be sent immediately.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ projectId, endpointId, provider, eventType, bodyOverrides, count, pace }) => {
      const requested = count ?? 1;
      const paceMode = pace ?? 'auto';
      let plan: ProjectPlanInfo | null = null;
      try {
        if (!projectId || !endpointId) {
          const scope = await resolveDefaultScope(ctx);
          if (!scope) {
            return fail(
scopeFailure(ctx, 'endpoint'),
              authMeta(ctx, await anyCachedPlan(ctx)),
            );
          }
          projectId = projectId ?? scope.projectId;
          endpointId = endpointId ?? scope.endpointId;
        }
        // Fresh plan + stats (not the 5-minute cache): refuse-before-send needs live numbers.
        plan = (await ctx.client.get(`/api/v1/projects/${projectId}/plan`)) as ProjectPlanInfo;
        ctx.session.planCache.set(projectId, { plan, fetchedAt: Date.now() });
        const statsPath = `/api/v1/projects/${projectId}/endpoints/${endpointId}/capture-stats`;
        let stats = (await ctx.client.get(statsPath)) as {
          AcceptedCount: number; RejectedCount: number;
          BurstLimit: number; BurstUsed: number; BurstResetsInSeconds: number;
        };
        let burst = burstFromPing(stats);

        const cap = plan.MaxMonthlyCaptures > 0 ? plan.MaxMonthlyCaptures : null;
        const remaining = cap !== null ? Math.max(0, cap - plan.CurrentMonthCaptures) : null;
        if (remaining !== null && requested > remaining) {
          return fail(
            {
              code: 'cap_would_exceed',
              message:
                remaining === 0
                  ? 'The monthly capture cap is used up. Nothing was sent. See meta.actions for upgrade options.'
                  : `Only ${remaining} captures remain on this month's plan quota. Nothing was sent. Send at most ${remaining}, or see meta.actions for upgrade options.`,
            },
            authMeta(ctx, plan, { burst }),
          );
        }
        if (paceMode === 'none' && burst && requested > burst.remaining) {
          return fail(
            {
              code: 'burst_would_exceed',
              message:
                `The burst window allows ${burst.remaining} more sends this minute (resets in ${burst.resetsInSeconds}s). ` +
                'Nothing was sent. Send fewer, wait for the reset, or use pace "auto".',
              retryAfterSeconds: burst.resetsInSeconds,
            },
            authMeta(ctx, plan, { burst }),
          );
        }

        const endpoint = (await ctx.client.get(`/api/v1/projects/${projectId}/endpoints/${endpointId}`)) as { Slug: string };
        const { deliveries, paced, totalWaitMs } = await sendTestEventBatch({
          captureUrl: `${ctx.client.baseUrl}/api/v1/capture/${projectId}/${endpoint.Slug}`,
          provider: provider as TestProvider,
          eventType,
          bodyOverrides,
          requested,
          paceMode,
          burst,
        });

        // Fresh server truth after the batch, so the meta the agent relays is current.
        plan = (await ctx.client.get(`/api/v1/projects/${projectId}/plan`)) as ProjectPlanInfo;
        ctx.session.planCache.set(projectId, { plan, fetchedAt: Date.now() });
        stats = (await ctx.client.get(statsPath)) as typeof stats;
        burst = burstFromPing(stats);

        return ok(
          {
            requested,
            sent: deliveries.filter((d) => d.statusCode === 200).length,
            paced,
            totalWaitMs,
            deliveries,
            endpoint: { accepted: stats.AcceptedCount, rejected: stats.RejectedCount },
            capturesRemaining:
              plan.MaxMonthlyCaptures > 0 ? Math.max(0, plan.MaxMonthlyCaptures - plan.CurrentMonthCaptures) : null,
            note:
              'Signature headers are shape-realistic placeholders and will not pass real signature verification. ' +
              'Point the real provider at the capture URL for end-to-end testing.',
          },
          authMeta(ctx, plan, { burst }),
        );
      } catch (err) {
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'forward_to_localhost',
    {
      title: 'Forward to localhost',
      description:
        "Forward captured webhooks to a URL on the user's OWN machine, such as " +
        'http://localhost:3000/webhook or the start_echo_server URL. The CLI delivers locally and the ' +
        'FlurryPORT server never makes this call. Inputs: localUrl, captureId for one specific capture or ' +
        'omit it for the latest accepted, latestCount for up to 10 newest in one call, and endpointId. ' +
        'CONFIRM the port and path with the user before calling. The payload is delivered as THIS ' +
        'credential reads it: a redact-PII scoped credential forwards masked bodies, the receipt says ' +
        'redacted true, and provider signatures will not verify. A non-redacting credential forwards the ' +
        'raw original bytes with signatures intact; to forward raw, the user mints a token without the ' +
        'redact option in Settings and runs flurryport login. The stored capture is intact on the server either way.',
      inputSchema: {
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        captureId: z.string().optional().describe('Opaque capture id; omit to forward the latest accepted capture(s).'),
        latestCount: z.number().int().min(1).max(10).optional()
          .describe('When captureId is omitted: how many of the newest accepted captures to forward (default 1, max 10).'),
        localUrl: z.string().describe("Loopback URL on the user's machine. The CLI re-validates this."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ endpointId, captureId, latestCount, localUrl }) => {
      const plan = await anyCachedPlan(ctx);
      const verdict = validateLocalUrl(localUrl, ctx.allowLan);
      if (!verdict.ok) return fail({ code: 'validation', message: verdict.reason }, authMeta(ctx, plan));
      try {
        if (!endpointId) {
          const scope = await resolveDefaultScope(ctx);
          if (!scope) {
            return fail(
              scopeFailure(ctx, 'endpoint'),
              authMeta(ctx, plan),
            );
          }
          endpointId = scope.endpointId;
        }

        let captureIds: string[];
        if (captureId) {
          captureIds = [captureId];
        } else {
          // Latest accepted first: over-fetch a page and drop rejected rows.
          const wanted = latestCount ?? 1;
          const page = (await ctx.client.get(
            `/api/v1/endpoints/${endpointId}/captured-requests?skip=0&take=${Math.min(wanted + 10, 50)}`,
          )) as Record<string, unknown>;
          const items = (Object.values(page).find(Array.isArray) as
            | Array<{ Id: string; RejectionReason?: string | null }>
            | undefined) ?? [];
          captureIds = items
            .filter((c) => c.RejectionReason == null)
            .slice(0, wanted)
            .map((c) => guidToBase62(c.Id));
          if (captureIds.length === 0) {
            return fail(
              { code: 'not_found', message: 'No accepted captures on this endpoint yet. Send or capture one first.' },
              authMeta(ctx, plan),
            );
          }
        }

        const forwarded: Array<Record<string, unknown>> = [];
        for (const cid of captureIds) {
          const raw = (await ctx.client.get(
            `/api/v1/endpoints/${endpointId}/captured-requests/${cid}`,
          )) as unknown as CapturedRequestDetail;
          if (raw.RejectionReason != null) {
            forwarded.push({ captureId: cid, skipped: true, reason: `rejected on ingest (${raw.RejectionReason})` });
            continue;
          }
          const result = await forwardCaptureToLocal(
            {
              Id: raw.Id,
              HttpMethod: raw.HttpMethod,
              Headers: raw.Headers,
              QueryString: raw.QueryString ?? null,
              Body: raw.BodyBytes,
              ContentType: raw.ContentType ?? null,
              ContentLength: raw.ContentLength ?? null,
              CreatedAt: raw.CreatedAt,
            },
            verdict.url,
          );
          const provider = (raw as { ProviderHint?: string | null }).ProviderHint ?? null;
          forwarded.push({
            captureId: cid,
            ...result,
            receipt: {
              ...buildReceipt({
                provider,
                eventType: (raw as { ProviderEventType?: string | null }).ProviderEventType ?? null,
                headersJson: raw.Headers,
                bodyText: Buffer.from(raw.BodyBytes ?? '', 'base64').toString('utf8'),
              }),
              ...(raw.Redacted === true ? { redacted: true } : {}),
            },
            diagnosis: diagnoseForward({
              statusCode: result.statusCode,
              responseBodyPreview: result.responseBodyPreview,
              provider,
              postedUrl: verdict.url.toString(),
            }),
            previousAttempt: swapAttempt(cid, result.statusCode, result.durationMs),
          });
        }
        const last = forwarded[forwarded.length - 1] as { statusCode?: number };
        const suggestedNextAction = successNextAction(verdict.url.toString(), last.statusCode ?? 0);
        return ok(
          captureIds.length === 1 && captureId
            ? ({ ...(forwarded[0] as Record<string, unknown>), suggestedNextAction } as Record<string, unknown>)
            : { forwarded, suggestedNextAction },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof Error && (err.name === 'AbortError' || err instanceof TypeError)) {
          return fail(
            { code: 'local_unreachable', message: `Could not reach ${localUrl}. Is the user's app running on that port?` },
            authMeta(ctx, plan),
          );
        }
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  // #485: local-class targets are delivered by a `flurryport listen` session, which
  // this server does not run. Name the steps instead of queueing a doomed execution.
  const LOCAL_LISTENER_HINT =
    'This target resolves to a local or private address. Local delivery is carried by a ' +
    '`flurryport listen` session in a terminal on the machine that owns that address, which this ' +
    'server does not run, so a queued replay fails with "No CLI connected". forward_to_localhost ' +
    'delivers a capture to localhost from here with no listener at all.';
  const LOCAL_LISTENER_STEPS = [
    'Open a terminal and run: npx flurryport login   (it prints an approval link to open in the browser; no token is pasted anywhere)',
    'Run: npx flurryport listen   (it attaches to the local target, creating one if none exists; leave that window open)',
    'Replay again, with allowLocal: true.',
  ];
  server.registerTool(
    'replay_to_target',
    {
      title: 'Replay to target',
      description:
        'Replay one capture to a registered replay target, server-side. Inputs: captureId, targetId from ' +
        'list_replay_targets, and idempotencyKey. You CANNOT supply an arbitrary URL. ALWAYS confirm the ' +
        'specific target with the user before calling. CAUTION on live pipes: if the capture matches a ' +
        'standing binding on an armed target, auto-forward already fired or will, so a manual replay lands ' +
        'a DUPLICATE at the real destination. Never use this to verify a standing pipe. Read ' +
        'get_capture_executions instead, and reach for manual replay only when auto-forward did not apply. ' +
        'Read-write token; the default is read-only and this answers forbidden with the setup walkthrough ' +
        'to relay. Delivery is queued, so poll get_replay_execution for the outcome, and pass the returned ' +
        'idempotencyKey back on a retry so it cannot double-deliver. With projectId and endpointId a ' +
        'local-address target is refused up front with the listener steps; allowLocal skips that guard.',
      inputSchema: {
        captureId: id,
        targetId: id,
        projectId: id.optional().describe('Enables the local-address guard with endpointId.'),
        endpointId: id.optional().describe('Enables the local-address guard with projectId.'),
        allowLocal: z.boolean().optional().describe('Queue to a local target anyway (flurryport listen is attached).'),
        idempotencyKey: z.string().max(64).optional()
          .describe('Dedup key. Omit on first call (one is generated and returned); pass it back verbatim when retrying.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ captureId, targetId, idempotencyKey, projectId, endpointId, allowLocal }) => {
      const plan = await anyCachedPlan(ctx);
      // #485: refuse a local-class target before the queue does, with the steps named.
      if (projectId && endpointId && allowLocal !== true) {
        try {
          const target = (await ctx.client.get(
            `/api/v1/projects/${projectId}/endpoints/${endpointId}/replay-targets/${targetId}`,
          )) as { BaseUrl?: string; Name?: string };
          if (typeof target.BaseUrl === 'string' && (await isLocalTarget(target.BaseUrl))) {
            return fail(
              {
                code: 'local_listener_required',
                message: `Target ${target.Name ?? targetId} (${target.BaseUrl}) was not queued. ${LOCAL_LISTENER_HINT}`,
                hint: `Steps for the human: ${LOCAL_LISTENER_STEPS.join(' ')} Or call forward_to_localhost with the same captureId to deliver it to localhost right now.`,
              },
              authMeta(ctx, plan),
            );
          }
        } catch {
          /* best effort: the enqueue path answers for real */
        }
      }
      // The enqueue body takes RAW GUIDs; the model holds opaque base62 ids.
      let captureGuid: string, targetGuid: string;
      try {
        captureGuid = base62ToGuid(captureId);
        targetGuid = base62ToGuid(targetId);
      } catch {
        return fail(
          { code: 'validation', message: 'captureId or targetId is not a valid id. Pass ids verbatim from prior list_* results.' },
          authMeta(ctx, plan),
        );
      }
      const key = idempotencyKey ?? `mcp-${randomUUID()}`;
      try {
        const result = (await ctx.client.post('/api/v1/replay/enqueue', {
          CapturedRequestId: captureGuid,
          ReplayTargetIds: [targetGuid],
          IdempotencyKey: key,
        })) as { ExecutionIds?: string[] };
        return ok(
          {
            executionIds: (result.ExecutionIds ?? []).map(guidToBase62),
            idempotencyKey: key,
            status: 'queued',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) {
          return fail(
            {
              code: 'forbidden',
              message:
                'This token is read-only, so server-side replay is blocked. ' + writeTokenGuide(),
            },
            authMeta(ctx, plan),
          );
        }
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  // ── B2.2 write tools (7b): the agent provisions its own pipe. All of these are
  // write-PAT gated SERVER-side (AllowPat without the read-only tier) — a read-only
  // token gets a 403 that we turn into the mint-a-write-token walkthrough. None of
  // them can touch delivery secrets (7a invariant #1: secret VALUES are browser-only).

  const failReadOnly = (plan: ProjectPlanInfo | null, what: string) =>
    fail(
      {
        code: 'forbidden',
        message: `This token is read-only, so ${what} is blocked. ` + writeTokenGuide(),
      },
      authMeta(ctx, plan),
    );

  // ── Limit-error enrichment (lesson 49): a plan-limit refusal enumerates the FULL
  // option space as data - agent-performable tools, human-only workspace actions, and
  // the FALSE options (freesSlot:false) agents otherwise burn calls discovering.
  // Quota semantics are encoded here so no agent ever derives them:
  //   - MaxEndpoints counts NON-SUSPENDED endpoints (suspending frees an endpoint slot).
  //   - MaxReplayTargets counts ALL target rows per project - endpoint suspension and
  //     autoReplay-off do NOT free target slots; only delete (human-only), a different
  //     project (human-only), or an upgrade resolves it.
  //   - binding slots count STANDING bindings per endpoint (removing a routing rule is human-only).
  //   - auto_replay_limit is a separate ARMED-count cap (disarming one frees it).

  const LIMIT_CODES = new Set([
    'endpoint_limit_exceeded',
    'replay_target_limit_exceeded',
    'transformation_limit_exceeded',
    'binding_limit_exceeded',
    'auto_replay_limit',
    'envoy_limit',
    'collection_limit_exceeded',
    'collection_item_limit_exceeded',
  ]);

  function limitOptionsFor(code: string): LimitOption[] {
    const web = resolveWebBaseUrl();
    const dashboard = `${web}/dashboard`;
    const upgrade = (what: string): LimitOption => ({
      kind: 'upgrade_plan',
      actor: 'human',
      url: `${web}/billing`,
      cost: 'paid',
      effect: `Raises ${what} (get_upgrade_options lists the tiers).`,
    });
    const newProject = (what: string): LimitOption => ({
      kind: 'new_project',
      actor: 'human',
      url: dashboard,
      freesSlot: false,
      effect:
        `A separate project has its own ${what} quota. Placement is a user decision: ` +
        'ASK which project this pipe belongs in, never default to whatever fits.',
    });
    switch (code) {
      case 'replay_target_limit_exceeded':
        return [
          {
            kind: 'delete_replay_target', actor: 'human', url: dashboard, freesSlot: true,
            effect:
              'Deleting a target row frees a slot immediately. Target slots count EVERY row in the ' +
              'project, armed or not - occupants[] lists the rows currently holding them.',
          },
          newProject('replay-target'),
          {
            kind: 'suspend_endpoint', actor: 'human', url: dashboard, freesSlot: false,
            effect:
              'Does NOT help here: suspending an endpoint frees an ENDPOINT slot, but its target ' +
              'rows still count against the project target quota.',
          },
          {
            kind: 'disable_auto_replay', actor: 'agent', tool: 'update_replay_target', freesSlot: false,
            effect:
              'Does NOT help here: disarming (autoReplay false) frees an ARMED slot only - the ' +
              'target row still counts against the project target quota.',
          },
          upgrade('MaxReplayTargets'),
        ];
      case 'endpoint_limit_exceeded':
        return [
          {
            kind: 'suspend_endpoint', actor: 'human', url: dashboard, freesSlot: true,
            effect:
              'Endpoint quota counts NON-SUSPENDED endpoints only, so suspending an idle endpoint ' +
              'frees a slot. Its capture URL stops accepting until unsuspended, and its replay ' +
              'targets still count against the target quota.',
          },
          {
            kind: 'delete_endpoint', actor: 'human', url: dashboard, freesSlot: true,
            effect:
              'Frees a slot but permanently deletes the endpoint with its captures, targets, and pipes.',
          },
          newProject('endpoint'),
          upgrade('MaxEndpoints'),
        ];
      case 'binding_limit_exceeded':
        return [
          {
            kind: 'remove_routing_rule', actor: 'human', url: dashboard, freesSlot: true,
            effect:
              'The workspace action is "Remove routing rule" (the trash on a pipe row INSIDE the ' +
              'Routing dialog): it removes one routing rule, the transformation and its versions ' +
              'survive, and re-binding later is cheap. Slots count STANDING bindings per endpoint. ' +
              'The hint on this error carries the exact workspace walkthrough to relay.',
          },
          {
            kind: 'new_endpoint', actor: 'agent', tool: 'create_endpoint', freesSlot: false,
            effect:
              'Binding slots are per ENDPOINT: a pipe serving a different stream belongs on its own ' +
              'endpoint, which has its own slots (endpoint quota applies).',
          },
          upgrade('standing-binding slots per endpoint'),
        ];
      case 'transformation_limit_exceeded':
        return [
          {
            kind: 'update_transformation', actor: 'agent', tool: 'update_transformation', freesSlot: false,
            effect:
              'Revise an existing transformation in place instead of creating another - ' +
              'get_transformations lists the roster; copy-on-write forks a draft if the latest ' +
              'version is frozen.',
          },
          {
            kind: 'delete_transformation', actor: 'human', url: dashboard, freesSlot: true,
            effect:
              'Deletes the whole transformation and every version with it (the trash on the ' +
              'transformation ROW in the workspace); frees a slot. Cascade: ALL of its routing ' +
              'rules go with it and the endpoint\'s recipe-provenance chip clears; past ' +
              'executions survive.',
          },
          upgrade('transformations per endpoint'),
        ];
      case 'auto_replay_limit':
        return [
          {
            kind: 'disable_auto_replay', actor: 'agent', tool: 'update_replay_target', freesSlot: true,
            effect:
              'Disarm another armed target (autoReplay false) to free an ARMED slot, then retry. ' +
              'list_replay_targets shows which targets are armed.',
          },
          upgrade('how many targets may be armed at once'),
        ];
      case 'collection_limit_exceeded':
        return [
          {
            kind: 'delete_collection', actor: 'human', freesSlot: true,
            url: `${resolveWebBaseUrl()}/dashboard`,
            effect:
              'Only a human can delete a collection (workspace: endpoint Collections tab). Deleting one ' +
              'frees a slot; its captures survive but lose the retention pin unless another collection ' +
              'holds them.',
          },
          upgrade('collections per endpoint'),
        ];
      case 'collection_item_limit_exceeded':
        return [
          {
            kind: 'new_collection', actor: 'agent', tool: 'create_collection', freesSlot: false,
            effect:
              'The item cap is PER COLLECTION: if the pinned set has grown past one collection\'s worth, ' +
              'a second collection (when the plan has collection headroom) holds the overflow. ASK the ' +
              'user how to split - the grouping is their canon, not a packing problem.',
          },
          upgrade('items per collection'),
        ];
      case 'envoy_limit':
        return [
          {
            kind: 'revoke_member', actor: 'agent', tool: 'revoke_member', freesSlot: true,
            effect:
              'The envoy meter counts DISTINCT people holding a producer seat across ALL the ' +
              "host's endpoints (account-level; the same person on several streams counts once; " +
              'monitors are free). Only the HOST\'s agent can revoke, and revocation is a user ' +
              'decision: ASK which producer to remove, never pick one. A seat frees only when ' +
              'that person holds no producer membership anywhere on the account.',
          },
          {
            kind: 'reinvite_as_monitor', actor: 'agent', tool: 'create_invite', freesSlot: false,
            effect:
              'Monitors are free and unlimited: if this participant only needs to READ the ' +
              'stream, a monitor invite sidesteps the meter entirely. Producers post; ' +
              'monitors watch.',
          },
          upgrade('the envoy roster (producer seats across the account)'),
        ];
      default:
        return [];
    }
  }

  /**
   * Best-effort quota snapshot + slot occupants for a limit refusal. A few extra GETs
   * on this rare failure path buy the agent the whole picture in one turn; any fetch
   * failure degrades to a partial (or absent) snapshot, never a worse error.
   */
  async function limitEvidence(
    projectId: string,
    wantOccupants: boolean,
  ): Promise<{ headroom: Record<string, string>; occupants?: Array<Record<string, unknown>> }> {
    const headroom: Record<string, string> = {};
    const cap = (max: number | undefined) => (max == null ? '?' : max > 0 ? String(max) : 'unlimited');
    const plan = await getPlan(ctx, projectId);
    try {
      const projects = (await ctx.client.get('/api/v1/projects')) as { Projects?: unknown[] };
      headroom.projects = `${(projects.Projects ?? []).length}/${cap(plan?.MaxProjects)}`;
    } catch { /* partial snapshot is fine */ }
    let endpointRows: Array<{ Id: string; Slug?: string; Suspended?: boolean }> = [];
    try {
      const endpoints = (await ctx.client.get(`/api/v1/projects/${projectId}/endpoints`)) as {
        Endpoints?: Array<{ Id: string; Slug?: string; Suspended?: boolean }>;
      };
      endpointRows = endpoints.Endpoints ?? [];
      const active = endpointRows.filter((e) => e.Suspended !== true).length;
      headroom.endpointsThisProject = `${active}/${cap(plan?.MaxEndpoints)}`;
    } catch { /* partial snapshot is fine */ }
    let occupants: Array<Record<string, unknown>> | undefined;
    if (endpointRows.length > 0) {
      try {
        // Bounded fan-out: target slots count per PROJECT, so sum across endpoints.
        // Plans cap endpoints low; 8 bounds the failure-path cost on big accounts.
        const scanned = endpointRows.slice(0, 8);
        interface TargetRow {
          Id?: string; EndpointId?: string; Name?: string; BaseUrl?: string;
          AutoReplay?: boolean; DomainVerified?: boolean; MissingSecrets?: string[];
          EndpointSlug?: string | null;
        }
        const perEndpoint = await Promise.all(
          scanned.map(async (e) => {
            const eb62 = guidToBase62(e.Id);
            const res = (await ctx.client.get(
              `/api/v1/projects/${projectId}/endpoints/${eb62}/replay-targets`,
            )) as { ReplayTargets?: TargetRow[] };
            return (res.ReplayTargets ?? []).map((t): TargetRow => ({ ...t, EndpointSlug: e.Slug ?? null }));
          }),
        );
        const all = perEndpoint.flat();
        const counted = scanned.length < endpointRows.length ? `${all.length}+` : String(all.length);
        headroom.targetsThisProject = `${counted}/${cap(plan?.MaxReplayTargets)}`;
        if (wantOccupants) {
          occupants = all.map((t) =>
            opaqueIds({
              Id: t.Id,
              EndpointId: t.EndpointId,
              endpointSlug: t.EndpointSlug,
              name: t.Name,
              baseUrl: t.BaseUrl,
              autoReplay: t.AutoReplay,
              domainVerified: t.DomainVerified,
              missingSecrets: t.MissingSecrets ?? [],
            }) as Record<string, unknown>,
          );
        }
      } catch { /* partial snapshot is fine */ }
    }
    return { headroom, occupants };
  }

  /**
   * #353: the label and the thing a person acts on, per limit code. The URL is
   * resolved from the scope the refusing call already had.
   */
  const LIMIT_HUMAN_LABEL: Record<string, string> = {
    endpoint_limit_exceeded: 'Suspend or delete an endpoint in the workspace to free a slot',
    replay_target_limit_exceeded: 'Delete a replay target in the workspace to free a slot',
    transformation_limit_exceeded: 'Delete a transformation in the workspace to free a slot',
    binding_limit_exceeded: 'Open the Transformations tab, click Routing, and remove one routing rule',
    auto_replay_limit: 'Disarm an auto-forward target in the workspace',
    envoy_limit: 'Review the roster in the workspace and decide which producer to remove',
    collection_limit_exceeded: 'Open the Collections tab and delete a collection to free a slot',
    collection_item_limit_exceeded: 'Open the Collections tab and take an item out of this collection',
  };

  /** Every write-tool catch funnels limit codes here: one enrichment path, one shape. */
  async function failLimit(
    err: AuthApiError,
    plan: ProjectPlanInfo | null,
    projectId: string | undefined,
    scope?: { endpointId?: string; targetId?: string },
  ) {
    const error: McpErrorPayload['error'] = { code: err.code, message: err.detail || err.message };
    if (err.code === 'binding_limit_exceeded') {
      // Slot limit is a dead end for the agent (no MCP tool removes a routing rule, and
      // DELETE /bindings is cookie-auth only) - the recovery is the USER freeing a slot
      // in the workspace. Hand the agent a relay-able walkthrough instead of a bare
      // refusal, in the UI's OWN vocabulary ("remove routing rule" / "delete
      // transformation" - the word "unbind" appears nowhere in the workspace).
      error.hint =
        'Every standing pipe slot on this endpoint is taken, and no MCP tool removes a routing rule - freeing ' +
        `a slot is a deliberate human action. Walk the user through it EXACTLY: open the workspace (${resolveWebBaseUrl()}/dashboard), ` +
        'expand the project and endpoint, go to the Transformations tab, click "Routing" on the transformation ' +
        'to open its routing dialog, and use the trash icon on a pipe row INSIDE that dialog (the confirm reads ' +
        '"Remove this routing rule?"). Warn them about the near-miss: the transformation row itself also has a ' +
        'trash icon (beside the "Routing" button) and it is a different control - it DELETES the whole ' +
        'transformation, behind a confirm people click through, and the delete cascades: every version, ALL of ' +
        'its routing rules, and the endpoint\'s recipe-provenance chip go with it (past executions survive). ' +
        'Only the dialog trash frees a slot non-destructively: it removes just the routing rule, the ' +
        'transformation and its versions survive, and re-binding later is cheap. Once the user confirms, retry ' +
        'bind_transformation; the slot frees immediately. If that retry returns 404 for the transformation id, ' +
        'the user hit the row trash and the transformation is gone - recreate it with create_transformation and ' +
        'bind the new draftVersionId (get_transformations shows what survived). Slots are per ENDPOINT: if this ' +
        'pipe serves a different stream than the ones already bound, it belongs on its own endpoint ' +
        '(create_endpoint), which has its own slots. If they want more pipes on THIS stream, ' +
        'get_upgrade_options lists tiers with more slots.';
    }
    const options = limitOptionsFor(err.code);
    if (options.length > 0) error.options = options;
    // #353: a limit refusal always ends with a person clicking something. Name it,
    // and point at the page that holds the thing rather than at the workspace.
    const label = LIMIT_HUMAN_LABEL[err.code];
    if (label && projectId) {
      error.humanAction = await endpointAction(
        ctx,
        label,
        scope?.targetId ?? scope?.endpointId ?? projectId,
        projectId,
        scope?.endpointId,
      );
    } else if (label) {
      error.humanAction = humanAction(label, workspacePath.dashboard(), scope?.targetId ?? 'dashboard');
    }
    if (projectId) {
      try {
        const wantOccupants =
          err.code === 'replay_target_limit_exceeded' || err.code === 'auto_replay_limit';
        const evidence = await limitEvidence(projectId, wantOccupants);
        if (Object.keys(evidence.headroom).length > 0) error.headroom = evidence.headroom;
        if (evidence.occupants?.length) error.occupants = evidence.occupants;
      } catch { /* enrichment must never make the error worse */ }
    }
    return fail(error, authMeta(ctx, plan));
  }

  const isLimitError = (err: unknown): err is AuthApiError =>
    err instanceof AuthApiError && LIMIT_CODES.has(err.code);

  server.registerTool(
    'create_endpoint',
    {
      title: 'Create webhook endpoint',
      description:
        'Create a FlurryPORT webhook capture endpoint on a project: a stable inbound URL a sender gets pointed at, and the ' +
        'thing a room lives on. Use it when wiring a pipe that needs its own intake. Inputs: name, slug ' +
        'which must be url-safe and unique in the project, and projectId. Returns the endpoint id and its ' +
        'capture URL path. Read-write token, and endpoint plan limits apply server-side.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        name: z.string().min(1).max(100).describe('Human-readable endpoint name.'),
        slug: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/,
          'lowercase letters, digits, and hyphens').describe('URL-safe slug, unique within the project.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ projectId, name, slug }) => {
      if (!projectId) {
        const d = await discoverScope(ctx);
        if (!d.projectId) {
          return fail(scopeFailure(ctx, 'project'), authMeta(ctx, await anyCachedPlan(ctx)));
        }
        projectId = d.projectId;
      }
      const plan = await getPlan(ctx, projectId);
      try {
        const result = (await ctx.client.post(`/api/v1/projects/${projectId}/endpoints`, {
          Name: name,
          Slug: slug,
        })) as { Id?: string; ProjectId?: string; Slug?: string };
        return ok(
          {
            ...opaqueIds(result),
            captureUrlPath: `/api/v1/capture/${projectId}/${result.Slug}`,
            hint: 'Point the webhook provider at the capture URL (apex host + captureUrlPath), or wire a pipe: create_replay_target, then create_transformation + bind_transformation.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'creating endpoints');
        if (isLimitError(err)) return failLimit(err, plan, projectId);
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'create_transformation',
    {
      title: 'Create transformation',
      description:
        'Create a named JSONata transformation on an endpoint: the reshape step that turns a capture into ' +
        'the exact shape one destination expects. Inputs: name, an optional description, expression, and ' +
        'projectId plus endpointId. The expression may reference $body, $headers, $query, and $secrets.NAME ' +
        'by name. A recipe expression that says $install.NAME is a TEMPLATE and there is no runtime ' +
        '$install: materialize each one before creating, either by asking the user for the value or by ' +
        'reading it from the intent as $body.NAME. Returns the transformation id and draftVersionId, and ' +
        'bind_transformation pins that exact version. Read-write token.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        name: z.string().min(1).max(100).describe('Human-readable transformation name.'),
        description: z.string().max(500).optional().describe('What this transformation is for.'),
        expression: z.string().min(1).max(10000).describe('JSONata expression over $body/$headers/$query/$secrets.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ projectId, endpointId, name, description, expression }) => {
      if (!projectId || !endpointId) {
        const scope = await resolveDefaultScope(ctx);
        if (!scope) {
          return fail(
            { code: 'ambiguous_scope', message: 'Pass projectId and endpointId from list_projects / list_endpoints.' },
            authMeta(ctx, await anyCachedPlan(ctx)),
          );
        }
        projectId = projectId ?? scope.projectId;
        endpointId = endpointId ?? scope.endpointId;
      }
      const plan = await getPlan(ctx, projectId);
      try {
        const result = await ctx.client.post(
          `/api/v1/projects/${projectId}/endpoints/${endpointId}/transformations`,
          { Name: name, Description: description ?? null, Expression: expression },
        );
        return ok(
          {
            ...opaqueIds(result),
            hint: 'Pin it live with bind_transformation (transformationId + draftVersionId + a replay target). Preview against a real capture first via the workspace, or bind with standing=false to test manually.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'creating transformations');
        if (isLimitError(err)) return failLimit(err, plan, projectId, { endpointId });
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'update_transformation',
    {
      title: 'Update transformation',
      description:
        "Update an existing transformation's expression, name, or description instead of creating another. " +
        'Plans cap transformations per endpoint, so revising the one you have is the right move when a ' +
        'draft was wrong. Inputs: transformationId, an optional name, description, and expression, and ' +
        'projectId. Versioning is copy-on-write: when the latest version is frozen by a standing binding, ' +
        'the update FORKS a new draft, so check forkedNewVersion and re-bind with the returned ' +
        'latestVersionId. Materialize $install.NAME placeholders before saving; binding refuses an ' +
        'unmaterialized template. Read-write token.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        transformationId: z.string().describe('Opaque id from create_transformation or the workspace, verbatim.'),
        name: z.string().min(1).max(100).optional().describe('New name; omit to keep.'),
        description: z.string().max(500).optional().describe('New description; omit to keep.'),
        expression: z.string().min(1).max(10000).optional()
          .describe('New JSONata expression over $body/$headers/$query/$secrets; omit to keep.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ projectId, transformationId, name, description, expression }) => {
      if (!projectId) {
        const d = await discoverScope(ctx);
        if (!d.projectId) {
          return fail(scopeFailure(ctx, 'project'), authMeta(ctx, await anyCachedPlan(ctx)));
        }
        projectId = d.projectId;
      }
      const plan = await getPlan(ctx, projectId);
      try {
        const result = (await ctx.client.put(
          `/api/v1/projects/${projectId}/transformations/${transformationId}`,
          { Name: name ?? null, Description: description ?? null, Expression: expression ?? null },
        )) as { ForkedNewVersion?: boolean };
        return ok(
          {
            ...opaqueIds(result),
            hint: result.ForkedNewVersion
              ? 'The previous version was frozen, so this forked a NEW draft version. Standing bindings still ' +
                'pin the old version - re-bind with bind_transformation using the returned latestVersionId to go live.'
              : 'Draft updated in place. Bindings pinning this draft pick the change up on their next run.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'updating transformations');
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'bind_transformation',
    {
      title: 'Bind transformation',
      description:
        'Arm a pipe: bind a transformation version to an endpoint and a replay target, so a capture ' +
        'matching the predicate runs the pinned version and delivers the result. Inputs: transformationId, ' +
        'versionId, replayTargetId, predicate where "true" matches everything, standing, armTarget, ' +
        'passThroughOnFailure, and projectId plus endpointId. standing true makes it a live pipe on every ' +
        'future capture and freezes the pinned version; standing false keeps it manual. Read-write token. ' +
        'Binding answers unmaterialized_install_params when the pinned version still references ' +
        '$install.NAME, and the error names them. Check headroom with get_project_plan and ' +
        'get_transformations, which shows binding counts, rather than discovering the cap by failing. ' +
        'binding_limit_exceeded is recoverable: the error carries options[] with an actor and freesSlot for ' +
        'each way out, plus a humanAction for the routing rule only a person can remove.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        transformationId: z.string().describe('Opaque id from create_transformation, verbatim.'),
        versionId: z.string().describe('Opaque draftVersionId from create_transformation, verbatim.'),
        replayTargetId: z.string().describe('Opaque id from create_replay_target / list_replay_targets, verbatim.'),
        predicate: z.string().min(1).max(1024).describe('JSONata predicate over $body/$headers/$query; "true" = every capture.'),
        standing: z.boolean().describe('true = runs on every future capture (live pipe); false = manual only.'),
        armTarget: z.boolean().optional()
          .describe('true = also ARM the bound target (autoReplay on) in this same call when it is disarmed - ' +
            'a standing binding only delivers through an ARMED target, so this closes the enabled-but-ineffective ' +
            'gap without a follow-up update_replay_target. If arming fails (e.g. the armed-target plan cap), the ' +
            'binding still stands and armNote says what to do.'),
        passThroughOnFailure: z.boolean().optional()
          .describe('When the transformation errors: true = deliver the original capture untransformed; false (default) = skip delivery.'),
        recipeRef: z.string().regex(/^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*@\d+$/).optional()
          .describe('When installing from a catalog recipe: its publisher:slug@version ref (e.g. flurryport:discord-post@2) - ' +
            'the canonical pin format everywhere (no +hash suffix; the server records the applied version hash itself). ' +
            'Recorded on the PIPE (binding) as install provenance - the workspace lists one chip per installed recipe on the endpoint. Omit for hand-wired pipes.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ projectId, endpointId, transformationId, versionId, replayTargetId, predicate, standing, armTarget, passThroughOnFailure, recipeRef }) => {
      if (!projectId || !endpointId) {
        const scope = await resolveDefaultScope(ctx);
        if (!scope) {
          return fail(
            { code: 'ambiguous_scope', message: 'Pass projectId and endpointId from list_projects / list_endpoints.' },
            authMeta(ctx, await anyCachedPlan(ctx)),
          );
        }
        projectId = projectId ?? scope.projectId;
        endpointId = endpointId ?? scope.endpointId;
      }
      const plan = await getPlan(ctx, projectId);
      try {
        const result = await ctx.client.post(
          `/api/v1/projects/${projectId}/endpoints/${endpointId}/bindings`,
          {
            TransformationId: base62ToGuid(transformationId),
            PinnedVersionId: base62ToGuid(versionId),
            ReplayTargetId: base62ToGuid(replayTargetId),
            Predicate: predicate,
            Standing: standing,
            PassThroughOnFailure: passThroughOnFailure ?? false,
            RecipeRef: recipeRef ?? null,
          },
        );
        // Truthfulness check: a standing binding only delivers through an ARMED target.
        // #111: armTarget closes the enabled-but-ineffective gap in the same flow -
        // arming failure never undoes the binding, it reports as armNote instead.
        let targetArmed: boolean | null = null;
        let armNote: string | null = null;
        if (standing) {
          const targetBase = `/api/v1/projects/${projectId}/endpoints/${endpointId}/replay-targets/${replayTargetId}`;
          try {
            const target = (await ctx.client.get(targetBase)) as
              { Name: string; BaseUrl: string; AutoReplay?: boolean };
            targetArmed = target.AutoReplay === true;
            if (armTarget && targetArmed === false) {
              try {
                const armed = (await ctx.client.put(targetBase, {
                  Name: target.Name,
                  BaseUrl: target.BaseUrl,
                  AutoReplay: true,
                })) as { AutoReplay?: boolean };
                targetArmed = armed.AutoReplay === true;
                if (targetArmed) armNote = 'armTarget: the bound target was disarmed and is now ARMED - the pipe delivers.';
              } catch (armErr) {
                armNote =
                  'armTarget failed - the binding stands but the target is still DISARMED (' +
                  (armErr instanceof AuthApiError
                    ? `${armErr.code || armErr.status}: ${armErr.detail || armErr.message}`
                    : String(armErr)) +
                  '). Arm it with update_replay_target { targetId, autoReplay: true }; plans cap how many ' +
                  'targets may be armed at once, so disarming another may be needed first.';
              }
            }
          } catch { /* advisory only */ }
        }
        return ok(
          {
            ...opaqueIds(result),
            targetArmed,
            ...(armNote ? { armNote } : {}),
            hint: standing
              ? (targetArmed === false
                  ? 'Binding created, but the bound target is DISARMED (autoReplay off) - nothing will deliver. Arm it with update_replay_target { targetId, autoReplay: true } to go live (or pass armTarget: true on bind_transformation to do both in one call).'
                  : 'The pipe is live: matching captures now transform and deliver automatically. The pinned ' +
                    'version is frozen; editing forks a new draft you re-bind. Do NOT "verify" a live pipe ' +
                    'with replay_to_target - the automatic delivery already handles matching captures, and a ' +
                    'manual replay lands a SECOND copy at the real destination. Verify by reading ' +
                    'get_capture_executions after the next capture instead.')
              : 'Manual binding created. Fire it via batch or collection runs; flip to standing later from the workspace.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'binding transformations');
        if (isLimitError(err)) return failLimit(err, plan, projectId, { endpointId });
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'request_secret_setup',
    {
      title: 'Request secret setup',
      description:
        'Ask FlurryPORT to email the endpoint owner a one-hour, single-use page where they paste the ' +
        'secret values a pipe references as $secrets.NAME. Inputs: checkOnly, recipeRef, secretNames, and ' +
        'projectId plus endpointId. You never see the email address, the link, or the values. Returns the ' +
        'masked address to relay so the user knows which inbox to check, the secret names with their ' +
        'set-flags, allSet, and a humanAction pointing at the page when the human has to act. Poll with ' +
        'checkOnly true until allSet, then keep wiring. checkOnly works on a read-only token; sending the ' +
        'email needs a read-write token, and sends are limited to one per endpoint per 5 minutes. The ' +
        'setup page may also offer the user a write grant: if they grant, this connection upgrades ' +
        'automatically and a write_granted notice says so, with no restart. In an anonymous session this ' +
        'same tool is the consent gate: pass recipeRef or secretNames and relay the consent question verbatim.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        checkOnly: z.boolean().optional()
          .describe('true = just report which secrets are set/missing (no email). Use this to poll after sending.'),
        recipeRef: z.string().max(200).optional()
          .describe('ANONYMOUS mode only: the catalog ref exactly as get_recipe returns it. Ignored once claimed ' +
            '(the account flow derives names from the wired pipe).'),
        secretNames: z.array(z.string().min(1).max(100)).max(5).optional()
          .describe('ANONYMOUS mode only, custom pipes without a catalog recipe: the secret NAMES needed. ' +
            'Names only, never values. Ignored once claimed.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ projectId, endpointId, checkOnly }) => {
      // (recipeRef/secretNames are anonymous-mode args — the unified dispatcher routes
      // pre-claim calls to the anon gate implementation; here they are simply unused.)
      // Arm the write-upgrade wait on every secret-setup touch (send or poll): the
      // grant decision is durable server-side, so arming early just means the click
      // releases instantly. Idempotent; a token that already has write stops itself.
      ctx.armWriteUpgrade?.();
      if (!projectId || !endpointId) {
        const scope = await resolveDefaultScope(ctx);
        if (!scope) {
          // The preflight trap (vetting run 2026-07-31): agents probe checkOnly mid-preflight,
          // before placement exists. Point them back at the flow instead of a generic refusal.
          return fail(
            {
              code: 'ambiguous_scope',
              message: 'Pass projectId and endpointId from list_projects / list_endpoints.',
              hint:
                'This tool is placement-scoped: it reports the $secrets refs already WIRED on one ' +
                'endpoint, so it cannot answer before a placement is chosen. Mid-preflight, put the ' +
                "recipe's secretNames on your consolidated requirements list instead, and run " +
                'checkOnly after the user picks the project/endpoint and the refs are wired.',
            },
            authMeta(ctx, await anyCachedPlan(ctx)),
          );
        }
        projectId = projectId ?? scope.projectId;
        endpointId = endpointId ?? scope.endpointId;
      }
      const plan = await getPlan(ctx, projectId);
      const base = `/api/v1/projects/${projectId}/endpoints/${endpointId}`;
      try {
        if (checkOnly) {
          const status = (await ctx.client.get(`${base}/secret-requirements`)) as {
            Secrets: Array<{ Name: string; UsedBy: string[]; IsSet: boolean }>;
            AllSet: boolean;
            ReferencedSecretCount?: number;
            Status?: string;
          };
          // #104: zero wired references must NEVER read as success. Older servers
          // omit Status and report a vacuous AllSet:true — derive the real state
          // from the (empty) Secrets list so the false positive dies here too.
          const referencedSecretCount = status.ReferencedSecretCount ?? status.Secrets.length;
          const state =
            status.Status ??
            (referencedSecretCount === 0 ? 'no_secret_references' : status.AllSet ? 'all_set' : 'missing_values');
          return ok(
            {
              secrets: status.Secrets.map((s) => ({ name: s.Name, usedBy: s.UsedBy, isSet: s.IsSet })),
              allSet: state === 'all_set',
              referencedSecretCount,
              status: state,
              // #353: missing_values means the answer is with a person, not a retry.
              ...(state === 'missing_values'
                ? {
                    humanAction: await endpointAction(
                      ctx,
                      'Open the emailed setup link and paste the remaining secret values',
                      endpointId,
                      projectId,
                      endpointId,
                    ),
                  }
                : {}),
              hint:
                state === 'no_secret_references'
                  ? 'No secret references are wired on this endpoint yet - nothing is configured. Wire $secrets.NAME references on the target URL/headers (set_target_headers / update_replay_target), then re-check.'
                  : state === 'all_set'
                    ? 'Every referenced secret is set - the pipe is ready. Continue wiring or fire a test intent.'
                    : 'Still waiting on the user. Poll again in ~30s; if they lost the email, call again without checkOnly to re-send (5 min cooldown applies).',
            },
            authMeta(ctx, plan),
          );
        }

        const result = (await ctx.client.post(`${base}/secret-setup-requests`, {})) as {
          MissingSecrets: string[];
          MaskedEmail: string | null;
          ExpiresAt: string;
        };
        return ok(
          {
            missingSecrets: result.MissingSecrets,
            maskedEmail: result.MaskedEmail,
            expiresAt: result.ExpiresAt,
            // #353: the values only a person can supply. The emailed page is
            // single use and we never see its URL, so the link is the endpoint the
            // secrets belong to, which is where they verify the wiring afterwards.
            humanAction: await endpointAction(
              ctx,
              result.MaskedEmail
                ? `Open the setup link emailed to ${result.MaskedEmail} and paste the secret values`
                : 'Set the secret values on the workspace Secrets page for this endpoint',
              endpointId,
              projectId,
              endpointId,
            ),
            hint: result.MaskedEmail
              ? `Setup link emailed to ${result.MaskedEmail}. Tell your user to open that inbox and follow the link (valid 1 hour, single use). Then poll with checkOnly=true until allSet.`
              : 'The setup request was recorded but the email could not be sent. Ask your user to set the secrets on the workspace Secrets page instead.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        // #104: keep the two "nothing to email" cases distinct — zero wired
        // references is NOT configured, and must not echo allSet:true.
        if (err instanceof AuthApiError && err.status === 400 && /no_secret_references/i.test(`${err.code} ${err.detail}`)) {
          return fail(
            {
              code: 'no_secret_references',
              message: 'No secret references are wired on this endpoint yet.',
              hint:
                'Nothing is configured - there are no $secrets.NAME references on the target URL/headers, ' +
                'so there is nothing to request. Wire the references first (set_target_headers / ' +
                'update_replay_target), then request setup or re-check with checkOnly=true.',
            },
            authMeta(ctx, plan),
          );
        }
        if (err instanceof AuthApiError && err.status === 400 && /no_missing_secrets|already set/i.test(`${err.code} ${err.detail}`)) {
          return ok(
            { allSet: true, status: 'all_set', hint: 'Every referenced secret is already set - nothing to request. The pipe is ready.' },
            authMeta(ctx, plan),
          );
        }
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'requesting secret setup');
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'create_invite',
    {
      title: 'Create invite',
      description:
        'Mint an invite link so another PERSON and their agent can join an endpoint you own. NOT for ' +
        'seating an AI agent in a room: agents join by pairing code (mint_seat); seat connectors cannot ' +
        'redeem invite links. Inputs: role ' +
        '"producer" to send events in or "monitor" to read only, displayName for who the invite is from, ' +
        'guestName for what to call the participant, recipeRef for the recipe the landing page should ' +
        'name, and endpointId, or omit it for the claimed or only endpoint. ASK YOUR USER for displayName ' +
        'and guestName; never invent either. Returns inviteUrl, shown ONCE, so relay it to the user immediately. ' +
        'Invites last 7 days and the owner can revoke them with revoke_invite. You never see or supply an ' +
        'email address; sharing the link is the user\'s job.',
      inputSchema: {
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        role: z.enum(['producer', 'monitor'])
          .describe('producer = the friend sends events into the endpoint; monitor = read only.'),
        displayName: z.string().min(1).max(100).optional()
          .describe('Who the invite is from, as the landing page should show it (a first name or team name). ' +
            'Ask the user; never invent one.'),
        guestName: z.string().min(1).max(100).optional()
          .describe('What to call the PARTICIPANT being invited - their one identity across signer label, ' +
            'watch label, and their CLI account name. Ask the user; never invent one. Not the host\'s ' +
            'name (that is displayName).'),
        recipeRef: z.string().max(200).optional()
          .describe('The catalog ref exactly as get_recipe / search_recipes returns it - the landing page ' +
            'routes the friend\'s agent to this recipe.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ endpointId, role, displayName, guestName, recipeRef }) => {
      if (!endpointId) {
        const scope = await resolveDefaultScope(ctx);
        if (!scope) {
          return fail(
            { code: 'ambiguous_scope', message: 'Pass endpointId from list_endpoints.' },
            authMeta(ctx, await anyCachedPlan(ctx)),
          );
        }
        endpointId = scope.endpointId;
      }
      const plan = await anyCachedPlan(ctx);
      try {
        const res = (await ctx.client.post(`/api/v1/endpoints/${endpointId}/invites`, {
          Role: role,
          DisplayName: displayName ?? null,
          RecipeRef: recipeRef ?? null,
          GuestName: guestName ?? null,
        })) as {
          InviteToken: string;
          TokenPrefix: string;
          Ref: string;
          Role: string;
          ExpiresAt: string;
          LandingPath: string;
          SeatFlowNote?: string | null;
        };
        return ok(
          {
            inviteUrl: `${ctx.client.baseUrl}${res.LandingPath}`,
            ref: res.Ref,
            role: res.Role,
            expiresAt: res.ExpiresAt,
            // Server-side invite-vs-pairing-code distinction (2026-08-31 incident):
            // present when recipeRef resolved to a room recipe. Relay it.
            ...(res.SeatFlowNote ? { seatFlowNote: res.SeatFlowNote } : {}),
            hint:
              'Give inviteUrl to your user to share with the invited PERSON now - this is the only time ' +
              'it is shown. The person accepts it in a browser as themselves; their agent then collects ' +
              'its credential through the landing page\'s JSON rendering. An invite never seats an AI ' +
              'agent in a room (that is mint_seat\'s pairing code). The ref identifies this invite in ' +
              'the endpoint\'s invite list; the owner can revoke it from there.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'minting an invite');
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  // ── mint_seat (#297): the chair's agent mints the pass. Most chairs drive rooms
  // through their primary agent over MCP, not the console - this is the same
  // /invites/seat mint the console :seat verb and `flurryport seat` make (the
  // shared seat-mint call), returning the ratified slim boarding pass to relay.
  // The chair address on the pass is honest or absent: the explicit argument
  // wins, else the address the console seeded on this machine (ruling 1 persists
  // it user-level), else the pass omits the chair sentence - a mint surface
  // never invents an address the room will not answer to.
  server.registerTool(
    'mint_seat',
    {
      title: 'Mint seat',
      description:
        'Mint a seat pairing code so ANOTHER AI agent can take a seat in a room on an endpoint you own. ' +
        'Inputs: guestName for the seat\'s byline on every post, hours for the seat life, codeMinutes for ' +
        'how long the unredeemed code lives, lifecycle for the pass\'s stay-or-go rule (standing or ' +
        'burst), senderName for the pass preamble (ask your user; omit for a neutral opening), ' +
        'seatServerUrl, and projectId plus endpointId. ASK YOUR USER ' +
        'for guestName; never invent one. Returns the pairing code plus passText, the boarding pass: relay ' +
        'passText to your user VERBATIM to ferry to the joining agent. The code is single use and dies 10 ' +
        'minutes after the mint by default; raise codeMinutes when the handoff will take longer, and it ' +
        'never outlives the seat. The seat\'s credentials are minted server-side at redemption and never ' +
        'appear here. Give the code only to the person whose agent should take the seat. The pass carries ' +
        'the hosted room address by default, so the joining agent can redeem from anywhere; pass ' +
        'seatServerUrl ONLY for a self-hosted room, whose host runs `flurryport seat-server` and knows its ' +
        'own address.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        guestName: z.string().min(1).max(100)
          .describe('What to call the SEAT being minted - its identity on every post (the wire name ' +
            'derives from it). Ask the user; never invent one. Surrounding quotes and whitespace are ' +
            'stripped before minting.'),
        hours: z.number().int().min(1).max(168).optional()
          .describe('Seat life in hours, 1 to 168; default 24. The pairing code has its own clock ' +
            '(codeMinutes).'),
        codeMinutes: z.number().int().min(1).max(1440).optional()
          .describe('How long the unredeemed pairing code lives, in minutes, 1 to 1440; default 10. ' +
            'Extend it when the pass will take longer to hand over. Clipped to the seat\'s own end.'),
        seatServerUrl: z.string().optional()
          .describe('Only for a self-hosted room: that seat server\'s MCP url (ends /mcp). Omit and ' +
            'the pass carries the hosted room address, {api base}/rooms/mcp (FLURRYPORT_ROOMS_URL ' +
            'overrides the default; an explicit value here wins over both).'),
        chairAddress: z.string().optional()
          .describe('The chair\'s wire address printed on the pass (the name seats send answers to). ' +
            'Omit to use the address the console seeded on this machine; if neither exists the pass ' +
            'omits the chair sentence.'),
        senderName: z.string().max(100).optional()
          .describe('Human sender\'s name for the pass preamble. Ask your user, never invent it; ' +
            'omitted, the neutral fallback opens.'),
        lifecycle: z.enum(['standing', 'burst']).optional()
          .describe('The stay-or-go rule printed on the pass; default standing (post going-idle between ' +
            'tasks, stay seated). burst: deliver this turn, sign off with fp:bye, fresh code next turn.'),
        standing: z.boolean().optional()
          .describe('Pre-authorize this handle\'s STANDING-CREDENTIAL slot (#409, distinct from ' +
            'lifecycle): when the seat later asks and its human accepts the consent email, the ' +
            'promotion completes immediately instead of parking for the chair.'),
        standingCheckedInOnly: z.boolean().optional()
          .describe('With standing: pin consent to checked-in custody.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ projectId, endpointId, guestName, hours, codeMinutes: codeMinutesOpt, seatServerUrl, chairAddress, senderName, lifecycle, standing, standingCheckedInOnly }) => {
      // #284a mint-surface hygiene: a quoted or padded name would mint literally and
      // the console grammar could never address it. Same rule, every mint surface.
      const cleaned = sanitizeGuestName(guestName);
      const plan = await anyCachedPlan(ctx);
      if (cleaned.length === 0) {
        return fail(
          {
            code: 'empty_guest_name',
            message:
              'Nothing is left of guestName once the surrounding quotes and whitespace are stripped. ' +
              'Pass a real name for the seat.',
          },
          authMeta(ctx, plan),
        );
      }
      try {
        if (!endpointId) {
          const scope = await resolveDefaultScope(ctx);
          if (!scope) return fail(scopeFailure(ctx, 'endpoint'), authMeta(ctx, plan));
          endpointId = scope.endpointId;
          projectId = projectId ?? scope.projectId;
        }
        const mint = await mintSeatInvite(ctx.client, endpointId, cleaned, {
          expiresInHours: hours ?? null,
          codeMinutes: codeMinutesOpt ?? null,
          standing: standing ?? false,
          standingCheckedInOnly: standingCheckedInOnly ?? false,
        });
        // Room slug for the pass's opening sentence, best-effort: the mint already
        // succeeded, so a slug lookup failure degrades to the generic opener.
        let room: string | undefined;
        if (projectId) {
          try {
            const [project, endpoint] = await Promise.all([
              ctx.client.get(`/api/v1/projects/${projectId}`) as Promise<{ Slug?: string }>,
              ctx.client.get(`/api/v1/projects/${projectId}/endpoints/${endpointId}`) as Promise<{ Slug?: string }>,
            ]);
            if (project.Slug && endpoint.Slug) room = `${project.Slug}/${endpoint.Slug}`;
          } catch {
            room = undefined;
          }
        }
        // #284c: the pass carries the name the SERVER assigned, normalized through
        // the handle alphabet - never a guess from the input.
        const wireName = handleBase(mint.participantName);
        const chair = chairAddress ?? getChairIdentity();
        const codeMinutes = codeMinutesLeft(mint.codeExpiresAt);
        return ok(
          {
            pairingCode: mint.pairingCode,
            ref: mint.ref,
            wireName,
            seatExpiresAt: mint.expiresAt,
            codeExpiresAt: mint.codeExpiresAt,
            codeExpiresInMinutes: codeMinutes,
            lifecycle: lifecycle ?? 'standing',
            ...(standing ? { standingPreAuthorized: mint.standingPreAuthorized } : {}),
            passText: consoleMessages
              .boardingPass({
                code: mint.pairingCode,
                handle: wireName,
                chairAddress: chair,
                // #346: the hosted rooms address unless the chair named a self-hosted one.
                seatServerUrl: resolveRoomsUrl(ctx.client.baseUrl, seatServerUrl),
                room,
                // #412: the stay-or-go rule is structural on every pass.
                lifecycle: lifecycle ?? 'standing',
                // Pass-copy sitting 2026-08-31: the preamble's one fill slot.
                senderName: senderName ?? null,
                // #478: the pass tells the seat its standing step exists.
                standingPreAuthorized: standing === true && mint.standingPreAuthorized,
              })
              .join('\n'),
            hint:
              'Relay passText to your user now to ferry to the joining agent - the code is shown only ' +
              `here, is single use, and dies in about ${codeMinutes} minute${codeMinutes === 1 ? '' : 's'}. ` +
              'Give it only to the person whose agent should take the seat. The seat itself ends at ' +
              'seatExpiresAt; posting and reading stop then, the log keeps its bylines. The joining agent ' +
              'redeems at the seat server address the pass names. Then HOLD THE ROOM: call ' +
              'wait_for_captures (or list_captures) so you see the guest arrive - its first post is ' +
              'addressed to you, and nobody will prompt you to look.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.code === 'producer_requires_signing') {
          return fail(
            {
              code: err.code,
              message:
                'This endpoint has no inbound signing configured, so a seat could not be attributed. ' +
                'Enable signing first with set_endpoint_signing, then mint the seat.',
            },
            authMeta(ctx, plan),
          );
        }
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'minting a seat');
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'authorize_standing',
    {
      title: 'Authorize standing',
      description:
        "Chair gate (#409): authorize a handle's standing-credential slot on an endpoint you own. " +
        'A parked ceremony (the human accepted; no slot) completes immediately - the steward never ' +
        're-opens the link. Pre-authorizing at mint is the standing flag on mint_seat instead.',
      inputSchema: {
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        handle: z.string().min(1).max(100).describe('The participant name to authorize, as the roster shows it.'),
        checkedInOnly: z.boolean().optional()
          .describe('true pins consent to checked-in custody, false lifts the pin, omitted leaves it.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ endpointId, handle, checkedInOnly }) => {
      const plan = await anyCachedPlan(ctx);
      try {
        if (!endpointId) {
          const scope = await resolveDefaultScope(ctx);
          if (!scope) return fail(scopeFailure(ctx, 'endpoint'), authMeta(ctx, plan));
          endpointId = scope.endpointId;
        }
        const answer = await ctx.client.post(
          `/api/v1/endpoints/${endpointId}/standing-authorizations`,
          { Handle: handle, ...(checkedInOnly !== undefined ? { CheckedInOnly: checkedInOnly } : {}) });
        return ok(
          {
            handle: answer.Handle,
            authorizedAt: answer.AuthorizedAt,
            completedPending: answer.CompletedPending ?? false,
            ...(answer.StandingExpiresAt ? { standingExpiresAt: answer.StandingExpiresAt } : {}),
            ...(answer.CheckedInOnly ? { checkedInOnly: true } : {}),
            hint: answer.CompletedPending
              ? 'A parked ceremony completed: the seat is standing now and its agent collects the key ' +
                'with attach_standing on its next call.'
              : 'The slot is authorized. When the handle asks and its human accepts the consent email, ' +
                'the promotion completes on its own.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'authorizing standing');
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'list_members',
    {
      title: 'List members',
      description:
        'List who holds access to an endpoint you own: accepted members with their participant name, role, ' +
        'and join date, plus every pending and past invite with its status. This is the host\'s roster. ' +
        'Use it when the user asks who is on a stream, before minting a new invite, or to find the ids ' +
        'revoke_member and revoke_invite take. Input: endpointId, or omit it for the claimed or only ' +
        'endpoint. A missing guestName means the invite predates participant naming.',
      inputSchema: {
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ endpointId }) => {
      try {
        if (!endpointId) {
          const scope = await resolveDefaultScope(ctx);
          if (!scope) {
            return fail(
              scopeFailure(ctx, 'endpoint'),
              authMeta(ctx, await anyCachedPlan(ctx)),
            );
          }
          endpointId = scope.endpointId;
        }
        const [members, invites] = await Promise.all([
          ctx.client.get(`/api/v1/endpoints/${endpointId}/memberships`),
          ctx.client.get(`/api/v1/endpoints/${endpointId}/invites`),
        ]);
        return ok(
          {
            members: opaqueIds(members),
            invites: opaqueIds(invites),
            hint:
              'members = accepted collaborators (revoke with revoke_member using the membership id; this also ' +
              'revokes their scoped tokens). invites = every minted invite with its status; revoke_invite ' +
              'kills a pending one and also unseats a redeemed seat invite (Tier seat, Status accepted) - ' +
              'seats live on this rail, not in members.',
          },
          authMeta(ctx, await anyCachedPlan(ctx)),
        );
      } catch (err) {
        return mapAuthError(ctx, err, await anyCachedPlan(ctx));
      }
    },
  );

  server.registerTool(
    'revoke_invite',
    {
      title: 'Revoke invite',
      description:
        'Revoke an invite on an endpoint you own: a pending invite\'s link stops working, and a redeemed ' +
        'SEAT invite is unseated on the spot - posting and reading stop, the log keeps its bylines, no ' +
        'web login needed. Person-memberships are revoke_member\'s job. Inputs: inviteId from ' +
        'list_members, and endpointId. Confirm with your user first: this cannot be undone; changing ' +
        'their mind takes a fresh create_invite or mint_seat.',
      inputSchema: {
        endpointId: id,
        inviteId: z.string().describe('Opaque invite id from list_members.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ endpointId, inviteId }) => {
      const plan = await anyCachedPlan(ctx);
      try {
        const result = await ctx.client.delete(`/api/v1/endpoints/${endpointId}/invites/${inviteId}`);
        return ok(
          {
            ...opaqueIds(result),
            revokedBy: 'this session\'s account',
            hint: 'The invite link is dead. The endpoint\'s Members panel and list_members reflect it immediately.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'revoking an invite');
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'revoke_member',
    {
      title: 'Revoke member',
      description:
        'Remove an accepted member from an endpoint you own: the membership row is deleted, their ' +
        'endpoint-scoped credentials are revoked, and their reads stop answering. Captures they already ' +
        'signed keep their attribution. Inputs: membershipId from list_members, and endpointId. Confirm ' +
        'with your user first, naming the participant back to them; re-inviting later takes a fresh invite.',
      inputSchema: {
        endpointId: id,
        membershipId: z.string().describe('Opaque membership id from list_members.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ endpointId, membershipId }) => {
      const plan = await anyCachedPlan(ctx);
      try {
        const result = await ctx.client.delete(`/api/v1/endpoints/${endpointId}/memberships/${membershipId}`);
        return ok(
          {
            ...opaqueIds(result),
            revokedBy: 'this session\'s account',
            hint:
              'Membership and its scoped tokens are revoked; the participant\'s reads now answer not-found. ' +
              'Their past signed captures keep their attribution. Re-inviting takes a fresh create_invite.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'revoking a membership');
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'create_replay_target',
    {
      title: 'Create replay target',
      description:
        'Register a delivery destination, a replay target, on an endpoint. ASK the user which project and ' +
        'endpoint the pipe belongs on when placement is not obvious. Inputs: name, baseUrl, ' +
        'autoReplay, and projectId plus endpointId. Returns the target id and domainVerified. Read-write ' +
        'token. Destination trust is by provenance: loopback is always allowed, a destination declared by ' +
        'a catalog recipe is vetted by the catalog, and any other external URL needs domain verification ' +
        'first. An unverified target is created but auto-forward skips it until the user verifies the ' +
        'domain in the workspace, so check domainVerified. autoReplay true arms the target: armed and ' +
        'unbound forwards every future capture raw, armed with standing bindings delivers only captures ' +
        'a binding predicate matched. Target rows count per PROJECT whether armed or not, and only a human ' +
        'can delete one, so check headroom against get_project_plan MaxReplayTargets and list_replay_targets ' +
        'first. A limit refusal carries options[], headroom, the occupant rows, and a humanAction link.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        name: z.string().min(1).max(100).describe('Human-readable target name.'),
        baseUrl: z.string().min(1).max(2000).describe('Destination URL (http[s]://host[:port]/path).'),
        autoReplay: z.boolean().optional().describe('Forward every future capture automatically (default false).'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ projectId, endpointId, name, baseUrl, autoReplay }) => {
      if (!projectId || !endpointId) {
        const scope = await resolveDefaultScope(ctx);
        if (!scope) {
          return fail(
            { code: 'ambiguous_scope', message: 'Pass projectId and endpointId from list_projects / list_endpoints.' },
            authMeta(ctx, await anyCachedPlan(ctx)),
          );
        }
        projectId = projectId ?? scope.projectId;
        endpointId = endpointId ?? scope.endpointId;
      }
      const plan = await getPlan(ctx, projectId);
      try {
        const result = (await ctx.client.post(
          `/api/v1/projects/${projectId}/endpoints/${endpointId}/replay-targets`,
          { Name: name, BaseUrl: baseUrl, AutoReplay: autoReplay ?? false },
        )) as { DomainVerified?: boolean };
        const verified = result.DomainVerified === true;
        return ok(
          {
            ...opaqueIds(result),
            hint: !verified
              ? 'Target created with an UNVERIFIED external domain (domainVerified false). Domain verification ' +
                'is ONLY for domains the user OWNS - never send them off to verify a third-party recipe ' +
                'destination like api.telegram.org, which they cannot do. Whether unverified targets are ' +
                'skipped by auto-delivery is plan policy, so for a catalog recipe install just proceed and ' +
                'prove the pipe with its first delivery receipt (get_capture_executions). If the destination ' +
                `is the user's own arbitrary URL, they verify it at ${resolveWebBaseUrl()}/domains.`
              : (autoReplay ?? false)
                ? 'Target is ARMED (autoReplay on): captures fan out to it automatically. Bind a transformation to it (bind_transformation) to deliver transformed payloads.'
                : 'Target created DISARMED (autoReplay off): standing bindings will NOT deliver through it until you arm it with update_replay_target { autoReplay: true }. Manual replay_to_target still works.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'creating replay targets');
        if (isLimitError(err)) return failLimit(err, plan, projectId, { endpointId });
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'update_replay_target',
    {
      title: 'Update replay target',
      description:
        'Update a replay target in place, most importantly ARMING it with autoReplay true so standing ' +
        'bindings and fan-out deliver through it, or disarming it. Inputs: targetId, autoReplay, name, ' +
        'baseUrl, and projectId plus endpointId. Any omitted field is left unchanged. Use it instead of ' +
        'creating another target: bindings stay attached and plan limits count targets. Plans cap how many ' +
        'targets may be ARMED at once, so disarm one before arming another if the server refuses. ' +
        'Read-write token.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        targetId: z.string().describe('Opaque replay-target id from list_replay_targets / create_replay_target.'),
        autoReplay: z.boolean().optional().describe('true = arm (deliveries flow), false = disarm. Omit to leave unchanged.'),
        name: z.string().min(1).max(100).optional().describe('New name; omit to keep.'),
        baseUrl: z.string().min(1).max(2000).optional().describe('New destination URL; omit to keep.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, endpointId, targetId, autoReplay, name, baseUrl }) => {
      if (!projectId || !endpointId) {
        const scope = await resolveDefaultScope(ctx);
        if (!scope) {
          return fail(
            { code: 'ambiguous_scope', message: 'Pass projectId and endpointId from list_projects / list_endpoints.' },
            authMeta(ctx, await anyCachedPlan(ctx)),
          );
        }
        projectId = projectId ?? scope.projectId;
        endpointId = endpointId ?? scope.endpointId;
      }
      const plan = await getPlan(ctx, projectId);
      const base = `/api/v1/projects/${projectId}/endpoints/${endpointId}/replay-targets/${targetId}`;
      try {
        // The API is full-replace: read current, merge the provided fields.
        const current = (await ctx.client.get(base)) as { Name: string; BaseUrl: string; AutoReplay: boolean };
        const merged = {
          Name: name ?? current.Name,
          BaseUrl: baseUrl ?? current.BaseUrl,
          AutoReplay: autoReplay ?? current.AutoReplay,
        };
        const result = (await ctx.client.put(base, merged)) as { AutoReplay?: boolean };
        return ok(
          {
            ...opaqueIds(result),
            hint: result.AutoReplay
              ? 'Target is ARMED: standing bindings and capture fan-out now deliver through it.'
              : 'Target is DISARMED: no automatic delivery. Manual replay_to_target still works.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'updating replay targets');
        if (isLimitError(err)) return failLimit(err, plan, projectId, { endpointId, targetId });
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'set_target_headers',
    {
      title: 'Set target headers',
      description:
        'Set the COMPLETE custom header set on a replay target. Full replace: include every header you ' +
        'want kept, and an empty array clears them all. Inputs: targetId, headers in send order, and ' +
        'projectId plus endpointId. This is how a recipe targetTemplate.headers get wired. Delivery ' +
        'applies them on top of the captured request headers, overriding case-insensitively. CREDENTIALS ' +
        'NEVER GO IN LITERALLY: write the vault reference $secrets.NAME for the secret part. Scheme words ' +
        'stay literal, so "Bearer $secrets.SLACK_BOT_TOKEN" is right and a pasted token is refused ' +
        'server-side. Then call request_secret_setup so the user supplies the value. Benign literals such ' +
        'as Content-Type and version pins are fine. Verify with get_replay_target deliveryHeaders. ' +
        'Read-write token.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        targetId: z.string().describe('Opaque replay-target id from list_replay_targets / create_replay_target.'),
        headers: z.array(z.object({
          name: z.string().min(1).max(100).describe('Header name (RFC 7230 token characters).'),
          value: z.string().max(1024).describe('Header value; use $secrets.NAME for any credential part.'),
        })).max(20).describe('The full header set, in send order. Replaces whatever was there; [] clears all.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, endpointId, targetId, headers }) => {
      if (!projectId || !endpointId) {
        const scope = await resolveDefaultScope(ctx);
        if (!scope) {
          return fail(
            { code: 'ambiguous_scope', message: 'Pass projectId and endpointId from list_projects / list_endpoints.' },
            authMeta(ctx, await anyCachedPlan(ctx)),
          );
        }
        projectId = projectId ?? scope.projectId;
        endpointId = endpointId ?? scope.endpointId;
      }
      const plan = await getPlan(ctx, projectId);
      const base = `/api/v1/projects/${projectId}/endpoints/${endpointId}/replay-targets/${targetId}/headers`;
      try {
        await ctx.client.put(base, {
          Headers: headers.map((h, i) => ({ HeaderName: h.name, HeaderValue: h.value, Order: i })),
        });
        // Read back what the server stored so the agent verifies the wiring it
        // just did (PAT reads mask browser-pasted literals; refs stay visible).
        let saved: unknown = [];
        try {
          const readBack = (await ctx.client.get(base)) as { Headers?: unknown };
          saved = readBack.Headers ?? [];
        } catch { /* advisory */ }
        const anyRefs = headers.some((h) => h.value.includes('$secrets.'));
        return ok(
          {
            ...opaqueIds({ targetId, deliveryHeaders: saved }),
            hint: anyRefs
              ? 'Headers reference the vault. If any secret is not set yet, call request_secret_setup - the ' +
                'USER supplies values on the emailed secure page; then deliveries resolve them at send time.'
              : 'Headers set. None reference $secrets - which is FINE when the credential rides the target ' +
                'URL instead (telegram-style bot tokens): this check reads headers only, while ' +
                'request_secret_setup checkOnly reports usedBy across BOTH the URL and headers, so trust ' +
                'that. Do not invent a header the recipe does not declare. If this pipe genuinely needs a ' +
                'header credential, use "$secrets.NAME" in the value and call request_secret_setup.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'setting target headers');
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  // ── B2.3 signing automation (7c): the key is born HERE, lives in the local
  // keystore, transits once to the dedicated server endpoint over TLS, and never
  // appears in tool arguments or results — it never enters the model's context.

  server.registerTool(
    'set_endpoint_signing',
    {
      title: 'Set endpoint signing',
      description:
        'Set up or rotate signed-intent posting for an endpoint. Inputs: an optional header the signature ' +
        'rides in, and projectId plus endpointId. A high-entropy signing key is generated LOCALLY, stored ' +
        'in the CLI keystore, and registered with the server in one atomic step, so the key value never ' +
        'appears in this conversation. Afterwards post_intent signs automatically and the endpoint rejects ' +
        'an unsigned post with 401 before storage. Re-running ROTATES the key, and anything still signing ' +
        'with the old one breaks at that moment. Read-write token.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        header: z.string().max(200).optional()
          .describe('HTTP header the signature rides in (default X-Flurry-Signature).'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ projectId, endpointId, header }) => {
      if (!projectId || !endpointId) {
        const scope = await resolveDefaultScope(ctx);
        if (!scope) {
          return fail(
            { code: 'ambiguous_scope', message: 'Pass projectId and endpointId from list_projects / list_endpoints.' },
            authMeta(ctx, await anyCachedPlan(ctx)),
          );
        }
        projectId = projectId ?? scope.projectId;
        endpointId = endpointId ?? scope.endpointId;
      }
      const plan = await getPlan(ctx, projectId);
      const signingHeader = header?.trim() || 'X-Flurry-Signature';
      const key = generateSigningKey();
      try {
        const result = (await ctx.client.put(
          `/api/v1/projects/${projectId}/endpoints/${endpointId}/signing-key`,
          { Key: key, SigningHeader: signingHeader, SignatureScheme: 'simple' },
        )) as { Rotated?: boolean };
        // Persist locally only after the server accepted — the pair can't drift.
        try {
          putCredential(signingKeyRef(endpointId), {
            type: 'signing',
            value: key,
            createdAt: new Date().toISOString(),
          });
        } catch (persistErr) {
          // Round 3: the server ALREADY accepted the rotation - a generic error here
          // would hide that every existing signer just broke while the only copy of
          // the new key was lost. Name the state and the recovery exactly.
          return fail(
            {
              code: 'key_persist_failed',
              message:
                `The server accepted the signing change - the endpoint now requires the NEW key - but it could ` +
                `not be stored locally (${(persistErr as Error).message}) so this machine does not hold it. ` +
                'Run set_endpoint_signing again once ~/.flurryport is writable: another rotation stores a fresh pair.',
            },
            authMeta(ctx, plan),
          );
        }
        return ok(
          {
            endpointId,
            header: signingHeader,
            scheme: 'simple',
            keyRef: signingKeyRef(endpointId),
            rotated: result.Rotated === true,
            hint:
              (result.Rotated
                ? 'Key ROTATED: previous signers of this endpoint are now rejected. '
                : 'Signing is live. ') +
              'Unsigned posts to this endpoint bounce 401. Use post_intent to send signed events; the key stays in the local keystore.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'configuring signing');
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  // ── #354 the install record. A cold host installed a recipe through two full
  // ratification cycles and found that nothing on the server knew it had happened:
  // InstalledRecipeRefs stayed empty, and a ref on a binding says only that a pipe
  // came from a recipe. This is the record: version, hash, choices, resources, state.
  server.registerTool(
    'record_recipe_install',
    {
      title: 'Record recipe install',
      description:
        'File the owner-side record of a recipe install, at the END of host setup, once the pipe is ' +
        'wired. Inputs: ref as publisher:slug, version as the pinned recipe version, contentHash from ' +
        'get_recipe, state from draft, ready, degraded, or outdated, parameters as the install-time ' +
        'values a human chose, resources as what the install created, an optional note, remove to drop a ' +
        'row, and projectId plus endpointId for placement. Upsert by ref: recording the same recipe again ' +
        'REPLACES its row, so a re-install or a state change never leaves two rows claiming to be current. ' +
        'Returns the recorded row and the whole roster, which get_endpoint also carries as recipeInstalls. ' +
        'Owner only, read-write token. NEVER put a secret value in a parameter: a secret is a name you ' +
        'wire as $secrets.NAME and a value the user pastes on the setup page, and this call is refused if ' +
        'a value looks like a credential. Record state draft while wiring, ready once you have proven ' +
        'delivery end to end, and degraded when it is installed but not delivering. ' +
        'New in 0.6.0: notes that do not mention it are stale.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        ref: z.string().max(201).describe('publisher:slug, no @version suffix.'),
        version: z.number().int().min(1).optional().describe('Pinned recipe version. Required unless remove.'),
        contentHash: z.string().max(128).optional().describe("get_recipe's contentHash for that version."),
        state: z.enum(['draft', 'ready', 'degraded', 'outdated']).optional().describe('Default draft.'),
        parameters: z.array(z.object({
          name: z.string().max(100),
          value: z.string().max(500),
        })).max(50).optional().describe('The choices this install was made with. Never a credential.'),
        resources: z.array(z.object({
          kind: z.enum(['replayTarget', 'transformation', 'binding', 'watch', 'collection', 'signingKey', 'endpoint']),
          id: z.string().max(64),
        })).max(50).optional().describe('What this install created, by opaque id.'),
        note: z.string().max(500).optional(),
        remove: z.boolean().optional().describe('Drop the row for this ref instead of recording one.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, endpointId, ref, version, contentHash, state, parameters, resources, note, remove }) => {
      if (!projectId || !endpointId) {
        const scope = await resolveDefaultScope(ctx);
        if (!scope) {
          return fail(
            { code: 'ambiguous_scope', message: 'Pass projectId and endpointId from list_projects / list_endpoints.' },
            authMeta(ctx, await anyCachedPlan(ctx)),
          );
        }
        projectId = projectId ?? scope.projectId;
        endpointId = endpointId ?? scope.endpointId;
      }
      const plan = await getPlan(ctx, projectId);
      try {
        const result = await ctx.client.put(
          `/api/v1/projects/${projectId}/endpoints/${endpointId}/recipe-installs`,
          {
            Ref: ref,
            Version: version ?? 0,
            ContentHash: contentHash ?? null,
            State: state ?? 'draft',
            Parameters: (parameters ?? []).map((p) => ({ Name: p.name, Value: p.value })),
            Resources: (resources ?? []).map((r) => ({ Kind: r.kind, Id: r.id })),
            Note: note ?? null,
            Remove: remove === true,
          },
        );
        return ok(
          {
            ...opaqueIds(result),
            hint: remove === true
              ? 'Install record removed. get_endpoint no longer lists it under recipeInstalls.'
              : 'Recorded. get_endpoint carries it under recipeInstalls, so the next agent on this ' +
                'endpoint reads which version is pinned instead of guessing from the wiring.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'recording a recipe install');
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  // ── #343 orientation lock (ruled 2026-08-21): one retention-exempt capture per
  // room on every plan, no collection slot spent. One pointer on the endpoint that
  // follows the newest orientation. Owner-only server-side (tenant isolation with no
  // membership marker): a seat or member answers 404, never an oracle.

  server.registerTool(
    'set_orientation',
    {
      title: 'Set orientation',
      description:
        'Set the room map. Marks captureId as the endpoint\'s current ORIENTATION, the one ' +
        'retention-exempt capture every room keeps on every plan, and stores sections and roster beside ' +
        'it. Owner only, read-write token. A new orientation releases the previous one, and seats read it ' +
        'from get_endpoint OrientationCaptureId then get_capture. sections and roster come back from ' +
        'list_sections, get_canon, and get_endpoint, so a reader never parses the orientation post. Pass ' +
        'clear true with no captureId to release the orientation, or sections or roster alone to edit the ' +
        'map without moving it. Omitting one leaves it as it is; an empty array clears it.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        captureId: z.string().optional()
          .describe('Capture id to orient on, verbatim from list_captures. Omit only together with clear: true.'),
        clear: z.boolean().optional()
          .describe('true releases the current orientation without setting a new one. Mutually exclusive with captureId.'),
        sections: z.array(z.object({
          handle: z.string().min(1).max(40).describe('Section address: lowercase letters and digits joined by single dashes.'),
          description: z.string().max(200).describe('What belongs in this section.'),
        })).max(50).optional()
          .describe('The whole section map, not a diff. Handles must be unique. An empty array clears the map.'),
        roster: z.array(z.object({
          handle: z.string().min(1).max(40).describe('Participant handle: lowercase letters and digits joined by single dashes.'),
          role: z.enum(['host', 'chair', 'producer', 'monitor', 'relayed']).describe('Role at the table.'),
        })).max(100).optional()
          .describe('The whole roster, not a diff. Handles must be unique. An empty array clears it.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, endpointId, captureId, clear, sections, roster }) => {
      if (captureId && clear) {
        return fail(
          { code: 'validation', message: 'captureId and clear: true are mutually exclusive - pass one or the other.' },
          authMeta(ctx, await anyCachedPlan(ctx)),
        );
      }
      // #363: the orientation lock and the room state are separately settable. A call
      // that names neither moves nothing, and is a mistake worth saying out loud.
      const stateOnly = !captureId && !clear;
      if (stateOnly && sections === undefined && roster === undefined) {
        return fail(
          {
            code: 'validation',
            message:
              'Nothing to set. Pass captureId (to orient on a capture), clear: true (to release the ' +
              'orientation), or sections / roster (to set the room state).',
          },
          authMeta(ctx, await anyCachedPlan(ctx)),
        );
      }
      if (!projectId || !endpointId) {
        const scope = await resolveDefaultScope(ctx);
        if (!scope) {
          return fail(
            { code: 'ambiguous_scope', message: 'Pass projectId and endpointId from list_projects / list_endpoints.' },
            authMeta(ctx, await anyCachedPlan(ctx)),
          );
        }
        projectId = projectId ?? scope.projectId;
        endpointId = endpointId ?? scope.endpointId;
      }
      const plan = await getPlan(ctx, projectId);
      let captureGuid: string | null = null;
      if (captureId) {
        try {
          captureGuid = base62ToGuid(captureId);
        } catch {
          return fail(
            { code: 'validation', message: 'captureId is not a valid id. Pass it verbatim from list_captures.' },
            authMeta(ctx, plan),
          );
        }
      }
      try {
        const result = (await ctx.client.put(
          `/api/v1/projects/${projectId}/endpoints/${endpointId}/orientation`,
          {
            CapturedRequestId: captureGuid,
            StateOnly: stateOnly,
            Sections: sections ? sections.map((x) => ({ Handle: x.handle, Description: x.description })) : null,
            Roster: roster ? roster.map((x) => ({ Handle: x.handle, Role: x.role })) : null,
          },
        )) as { PreviousOrientationCaptureId?: string | null };
        const released = result.PreviousOrientationCaptureId ? 'The previous orientation is released and ages out under plan retention unless it is also pinned in a collection. ' : '';
        return ok(
          {
            ...opaqueIds(result),
            hint: stateOnly
              ? 'Room state stored; the orientation lock was not touched. Readers get sections and roster from list_sections, get_canon, or get_endpoint.'
              : captureGuid
                ? `Orientation set. ${released}Seats read OrientationCaptureId from get_endpoint, then get_capture for the content.`
                : `Orientation released. ${released}The room has no orientation until set_orientation is called again.`,
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 403) return failReadOnly(plan, 'setting the orientation');
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  // ── #363 read side: the section map and roster as server state, one call, for
  // owners and seats alike (the seat server mounts this same registration).

  server.registerTool(
    'list_sections',
    {
      title: 'List sections',
      description:
        'Read the room state: the section map, each handle with what belongs there, the roster, each handle ' +
        'with its role of host, chair, producer, monitor, or relayed, and the current orientation capture ' +
        'id. Use it before posting, to learn which section a post is addressed to and who is at the table. ' +
        'Inputs: projectId and endpointId, or neither to use the room you are in. Returns sections[], ' +
        'roster[], and orientationCaptureId, null when the room has no orientation. ' +
        'New in 0.6.0: notes that do not mention it are stale.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed, only, or seated room.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed, only, or seated room.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, endpointId }) => {
      if (!projectId || !endpointId) {
        const scope = await resolveDefaultScope(ctx);
        if (!scope) {
          return fail(
            { code: 'ambiguous_scope', message: 'Pass projectId and endpointId from list_projects / list_endpoints.' },
            authMeta(ctx, await anyCachedPlan(ctx)),
          );
        }
        projectId = projectId ?? scope.projectId;
        endpointId = endpointId ?? scope.endpointId;
      }
      const plan = await getPlan(ctx, projectId);
      try {
        const result = await ctx.client.get(`/api/v1/projects/${projectId}/endpoints/${endpointId}/sections`);
        return ok(opaqueIds(result), authMeta(ctx, plan));
      } catch (err) {
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'get_canon',
    {
      title: 'Get canon',
      description:
        'Read what currently stands in each section of the room: one ratified recap per section, derived ' +
        'from the newest filing receipt for that section and checked against the collection the ruling is ' +
        'pinned in. Use it before proposing anything, so a proposal answers the standing text instead of ' +
        'repeating it. Inputs: projectId and endpointId, or neither to use the room you are in. Returns ' +
        'sections[] with sectionHandle, recapText, decisionCaptureId, collateCaptureId, ratifiedAt, ' +
        'collectionId, and superseded (true when the ruling is no longer in that collection, so the recap ' +
        'is stale), plus an etag for cheap re-reads. A section with nothing ratified lists with null ' +
        'members. New in 0.6.0: notes that do not mention it are stale.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed, only, or seated room.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed, only, or seated room.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, endpointId }) => {
      if (!projectId || !endpointId) {
        const scope = await resolveDefaultScope(ctx);
        if (!scope) {
          return fail(
            { code: 'ambiguous_scope', message: 'Pass projectId and endpointId from list_projects / list_endpoints.' },
            authMeta(ctx, await anyCachedPlan(ctx)),
          );
        }
        projectId = projectId ?? scope.projectId;
        endpointId = endpointId ?? scope.endpointId;
      }
      const plan = await getPlan(ctx, projectId);
      try {
        const result = await ctx.client.get(`/api/v1/projects/${projectId}/endpoints/${endpointId}/canon`);
        return ok(opaqueIds(result), authMeta(ctx, plan));
      } catch (err) {
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  server.registerTool(
    'post_intent',
    {
      title: 'Post intent',
      description:
        'Speak into an endpoint: fire a pipe, or say something in a room. Inputs: body (a JSON string), ' +
        'contentType, and projectId plus endpointId, or neither for the claimed or only endpoint. On a ' +
        'signed endpoint the payload is HMAC-signed with the keystore key and the key never enters this ' +
        'conversation; with signing disabled the post goes unsigned and the receipt says so. Returns ' +
        'captureId, executions[] one per matched standing binding, and the budget as sizeBytes, ' +
        'maxBytes, bytesRemaining (UTF-8 bytes). The budget is the receipt, not a gate: nothing here ' +
        'rejects for size; a post over the plan payload cap is stored by Core as a rejected capture, ' +
        'reported as status rejected. A post with verb fp:propose, a re reference, and a named section ' +
        '(for, or a to that is a section handle) earns postDiff {section, linesAdded, linesRemoved, ' +
        'linesChanged, unchanged, oversize} against the standing recap. On a room with published ' +
        'sections a proposal must name its section: set for to a handle from list_sections; to stays ' +
        'the addressee, never gated; naming no section is refused before storage and the error names ' +
        'the handles.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the claimed or only endpoint.'),
        body: z.string().min(1)
          .describe(
            `The intent payload, as a JSON string. Budget ${POST_INTENT_MAX_BYTES} UTF-8 bytes, capped ` +
            'at the plan payload limit; never rejected here for size.'),
        contentType: z.string().max(200).optional().describe('Content-Type (default application/json).'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ projectId, endpointId, body, contentType }) => {
      if (!projectId || !endpointId) {
        const scope = await resolveDefaultScope(ctx);
        if (!scope) {
          return fail(
            { code: 'ambiguous_scope', message: 'Pass projectId and endpointId from list_projects / list_endpoints.' },
            authMeta(ctx, await anyCachedPlan(ctx)),
          );
        }
        projectId = projectId ?? scope.projectId;
        endpointId = endpointId ?? scope.endpointId;
      }
      const plan = await getPlan(ctx, projectId);

      // Owner key (set_endpoint_signing) first, then the invite-rail CONTRIBUTOR key
      // (flurryport join) — a producer signs its intents with the per-endpoint key the
      // join handed it, exactly like an owner, no hand-rolled HMAC. Shared with the
      // `flurryport post` CLI verb via intent-post.ts. Seat sessions (0.5.0) provide
      // the key through the ctx seam instead: the seat key lives in session memory,
      // never in the operator's disk keystore.
      const seatKey = ctx.intentKey?.() ?? null;
      let chosen: ReturnType<typeof chooseIntentKey>;
      try {
        chosen = ctx.intentKey
          ? (seatKey
              ? { keyRef: seatKey.keyRef ?? 'seat-key', credential: { type: 'signing', value: seatKey.key, createdAt: '' } }
              : null)
          : chooseIntentKey(endpointId);
      } catch (err) {
        // Round 3: this read ran BEFORE the try below, so a locked keystore's raw
        // ErrnoException (absolute path, username) escaped to the SDK and reached
        // the remote client verbatim. The typed error's message is clean.
        return fail(
          { code: 'keystore_unavailable', message: `${(err as Error).message} Try the call again shortly.` },
          authMeta(ctx, plan),
        );
      }
      const usedKeyRef = chosen?.keyRef ?? null;
      const credential = chosen?.credential ?? null;

      try {
        // Endpoint lookup for the capture-URL slug + configured header + signing
        // posture. Looked up BEFORE the key gate: with no local key, SigningEnabled
        // decides between the teaching refusal (signed stream, key missing) and the
        // unsigned fallback (run-4 finding #11 / lesson 45 candidate — provider
        // streams run signing OFF by design, and without this path the recipe step
        // "post the orientation" is reachable only through a shell).
        const endpoint = (await ctx.client.get(
          `/api/v1/projects/${projectId}/endpoints/${endpointId}`,
        )) as { Slug?: string; SigningHeader?: string | null; SigningEnabled?: boolean | null };
        if (!endpoint.Slug) {
          return fail({ code: 'not_found', message: 'Endpoint not found.' }, authMeta(ctx, plan));
        }

        if (!credential || !usedKeyRef) {
          // Fail closed unless the server EXPLICITLY reports signing disabled —
          // undefined means an older server, and guessing unsigned there could
          // throw agent posts at a 401 wall with a misleading receipt.
          if (endpoint.SigningEnabled !== false) {
            return fail(
              {
                code: 'signing_not_configured',
                message:
                  'No signing key in the local keystore for this endpoint. If you own it, run ' +
                  'set_endpoint_signing. If you were invited as a producer, run "flurryport join <token>" ' +
                  'to accept the invite and store the contributor key - both without exposing the value here.',
              },
              authMeta(ctx, plan),
            );
          }

          const delivery = await deliverIntent({
            baseUrl: ctx.client.baseUrl,
            projectId,
            endpointSlug: endpoint.Slug,
            body,
            contentType,
            extraHeaders: ctx.captureHeaders,
          });

          if (!delivery.ok) {
            return fail(
              { code: `http_${delivery.httpStatus}`, message: delivery.errorText || `Capture URL answered ${delivery.httpStatus}.` },
              authMeta(ctx, plan),
            );
          }

          // #377: the budget is the receipt. Core enforces only the plan payload cap,
          // storing an oversize post as a rejected capture; the receipt must say so.
          const unsignedBudget = ownerMaxBytes(plan);
          const unsignedOversize = delivery.sizeBytes > unsignedBudget;
          return ok(
            {
              status: unsignedOversize ? 'rejected' : 'accepted',
              signedWith: null,
              posture: 'unsigned',
              httpStatus: delivery.httpStatus,
              durationMs: delivery.durationMs,
              postedAt: new Date().toISOString(),
              sizeBytes: delivery.sizeBytes,
              maxBytes: unsignedBudget,
              bytesRemaining: bytesRemaining(unsignedBudget, delivery.sizeBytes),
              // Correlation ids (null on servers that predate the receipt): the capture
              // this post landed as, and the execution row per matched standing binding.
              captureId: delivery.captureId,
              executions: delivery.executions,
              // #360b: what a re-linked proposal changes against the standing recap.
              postDiff: delivery.postDiff,
              hint: unsignedOversize
                ? 'This post exceeded the payload budget, so Core stored it as a REJECTED capture with an ' +
                  'empty body: nothing was delivered and no binding fired. Trim the body under maxBytes ' +
                  'and post again.'
                : 'Posted UNSIGNED: this endpoint runs with signing disabled, so possession of the capture ' +
                  'URL is the only write credential and nothing cryptographically distinguishes writers. ' +
                  'That is the normal trust model for provider streams (see /recipes/security). If this ' +
                  'stream should be signed, the owner runs set_endpoint_signing - after which unsigned ' +
                  'posts like this one bounce 401.',
            },
            authMeta(ctx, await freshPlanAfterCapture(ctx, projectId)),
          );
        }

        const headerName = endpoint.SigningHeader || 'X-Flurry-Signature';
        const delivery = await deliverIntent({
          baseUrl: ctx.client.baseUrl,
          projectId,
          endpointSlug: endpoint.Slug,
          body,
          contentType,
          signingKey: credential.value,
          headerName,
          extraHeaders: ctx.captureHeaders,
        });

        if (delivery.httpStatus === 401) {
          return fail(
            {
              code: 'signature_rejected',
              message:
                'The endpoint rejected the signature (401). The local key no longer matches the server - ' +
                'run set_endpoint_signing again to rotate the pair back into sync.',
            },
            authMeta(ctx, plan),
          );
        }
        if (!delivery.ok) {
          return fail(
            { code: `http_${delivery.httpStatus}`, message: delivery.errorText || `Capture URL answered ${delivery.httpStatus}.` },
            authMeta(ctx, plan),
          );
        }

        // #377: same budget-as-receipt rule as the unsigned path.
        const signedBudget = ownerMaxBytes(plan);
        const signedOversize = delivery.sizeBytes > signedBudget;
        return ok(
          {
            status: signedOversize ? 'rejected' : 'accepted',
            signedWith: { keyRef: usedKeyRef, header: headerName, scheme: 'simple' },
            httpStatus: delivery.httpStatus,
            durationMs: delivery.durationMs,
            postedAt: new Date().toISOString(),
            sizeBytes: delivery.sizeBytes,
            maxBytes: signedBudget,
            bytesRemaining: bytesRemaining(signedBudget, delivery.sizeBytes),
            // Correlation ids (null on servers that predate the receipt): the capture
            // this post landed as, and the execution row per matched standing binding.
            captureId: delivery.captureId,
            executions: delivery.executions,
            // #360b: what a re-linked proposal changes against the standing recap.
            postDiff: delivery.postDiff,
            hint: signedOversize
              ? 'This post exceeded the payload budget, so Core stored it as a REJECTED capture with an ' +
                'empty body: nothing was delivered and no binding fired. Trim the body under maxBytes ' +
                'and post again.'
              : delivery.executions && delivery.executions.length > 0
                ? 'The intent was captured and signature-verified. Standing bindings enqueued the ' +
                  'executions above; follow each with get_replay_execution.'
                : 'The intent was captured and signature-verified. Standing bindings on this endpoint now ' +
                  'transform and deliver it; check outcomes with list_replay_executions or get_capture_digest.',
          },
          authMeta(ctx, await freshPlanAfterCapture(ctx, projectId)),
        );
      } catch (err) {
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  // ── #365 (0.6.0): the monitor rail's one verb ────────────────────────────────
  // A monitor reads a room and cannot post, so until now the ask for a seat had to
  // leave the room entirely: the agent told its human, the human found the host in
  // some other channel, and the room held no record that anyone ever asked. This
  // lands the ask INSIDE the room as an ordinary capture, so the host's watches label
  // it and any standing binding carries it onward like every other post.
  //
  // Signing decision (#365, 2026-08-22): a monitor holds NO key — the invite rail
  // releases a contributor key only to producers — and CaptureRequestHandler fails
  // closed on a signed endpoint (unsigned post -> stored rejected capture + 401). The
  // platform has no unattributed-system-post lane through that path, and inventing one
  // would be a hole in the very rule signing exists to enforce. So on a signed room the
  // verb is REFUSED, and the refusal tells the human to carry the ask.
  server.registerTool(
    'request_seat',
    {
      title: 'Request seat',
      description:
        'Ask for a seat in a room you are only watching. A monitor reads but cannot post, so this lands ' +
        'the ask inside the room instead of out of band: an ordinary capture to the host on the roster ' +
        '(or all when it names none), verb fp:request-seat, your reason as text, so host watches label ' +
        'it and standing bindings carry it onward. Inputs: reason, and projectId plus endpointId, or ' +
        'neither for the one joined room; the default is the joined grant, never your own endpoints. ' +
        'Monitor credentials only: an owner or a seat posts instead. On a room with signing on it is ' +
        'refused FOR NOW: there is no platform-signed lane yet, so your human carries the ask to the ' +
        'host. New in 0.6.0: notes that do not mention it are stale.',
      inputSchema: {
        projectId: z.string().optional().describe('Opaque project id; omit to use the joined project.'),
        endpointId: z.string().optional().describe('Opaque endpoint id; omit to use the joined endpoint.'),
        reason: z.string().min(1).max(REQUEST_SEAT_MAX_REASON)
          .describe('Why you are asking for a seat, in your own words. Lands as the message text.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ projectId, endpointId, reason }) => {
      // #370: the default scope is the JOINED grant. resolveDefaultScope discovers the
      // operator's own endpoints, which is exactly the room a monitor is NOT asking in.
      if (!projectId || !endpointId) {
        const grants = (ctx.joinedGrants?.() ?? []).filter((g) => g.projectId && g.endpointId);
        if (grants.length === 1) {
          projectId = projectId ?? grants[0].projectId;
          endpointId = endpointId ?? grants[0].endpointId;
        }
        if (!projectId || !endpointId) {
          return fail(
            {
              code: 'ambiguous_scope',
              message:
                grants.length === 0
                  ? 'No joined room found. request_seat runs on a monitor grant: join the room first ' +
                    '("flurryport join <link>"), or pass projectId and endpointId from the join receipt.'
                  : 'More than one joined room. Pass projectId and endpointId from the join receipt of ' +
                    'the room you are asking in.',
            },
            authMeta(ctx, await anyCachedPlan(ctx)),
          );
        }
      }
      const plan = await getPlan(ctx, projectId);
      const path = `/api/v1/projects/${projectId}/endpoints/${endpointId}`;

      // Monitor gate. A seat session (ctx.intentKey) and a producer (contributor key in
      // the keystore) both speak in the room already; the operator's own credential owns
      // it. Only a joined grant with no key is the monitor rail.
      const notAMonitor = (who: string, verb: string) =>
        fail(
          {
            code: 'not_a_monitor',
            message:
              `request_seat is the monitor rail's one verb, and this credential is ${who}. ` +
              `Say it in the room with ${verb} instead - you can already post here.`,
          },
          authMeta(ctx, plan),
        );
      if (ctx.intentKey) return notAMonitor('a seat at the table', 'post');
      // Deliberately the endpoint-only path form: the router falls back to a PROJECT
      // match when a path names one, so asking with the project-keyed path would call
      // an operator's own sibling endpoint "joined" whenever a grant shares its project.
      // A seat request is about THIS room, so only an endpoint-scoped grant counts.
      const readAs = ctx.client.credentialFor?.(`/api/v1/endpoints/${endpointId}`) ?? null;
      if (!readAs) {
        return notAMonitor(
          'the signed-in account, not a joined grant',
          'post_intent (or mint_seat, if you are the host handing one out)');
      }
      try {
        if (chooseIntentKey(endpointId)) return notAMonitor('a producer holding a contributor key', 'post_intent');
      } catch (err) {
        // Round 3: same pre-try keystore read - surface the clean message, never the raw path.
        return fail(
          { code: 'keystore_unavailable', message: `${(err as Error).message} Try the call again shortly.` },
          authMeta(ctx, await anyCachedPlan(ctx)),
        );
      }

      try {
        const endpoint = (await ctx.client.get(path)) as {
          Slug?: string;
          SigningEnabled?: boolean | null;
          Roster?: Array<{ Handle?: string; Role?: string }> | null;
        };
        if (!endpoint.Slug) {
          return fail({ code: 'not_found', message: 'Endpoint not found.' }, authMeta(ctx, plan));
        }

        // Fail closed exactly like post_intent: undefined means an older server, and
        // guessing unsigned there throws the ask at a 401 wall with a cheerful receipt.
        if (endpoint.SigningEnabled !== false) {
          return fail(
            {
              code: 'signing_on_no_key',
              message:
                'This room runs with signing on and a monitor holds no signing key, so a post from here ' +
                'would be rejected at the door (401) and stored as a refusal. Nothing was sent. There is ' +
                'no platform-signed lane for this yet: not yet, carry the ask. Tell your human to take it ' +
                'to the host directly; the host mints a pairing code with mint_seat and hands it back, ' +
                'and redeeming it gives you a seat that can post signed.',
            },
            authMeta(ctx, plan),
          );
        }

        const to = hostAddress(endpoint.Roster);
        const body = JSON.stringify({
          v: 1,
          kind: 'message',
          from: readAs,
          to,
          verb: REQUEST_SEAT_VERB,
          text: reason,
          summary: `Seat request from ${readAs}`,
        });

        const delivery = await deliverIntent({
          baseUrl: ctx.client.baseUrl,
          projectId,
          endpointSlug: endpoint.Slug,
          body,
          extraHeaders: ctx.captureHeaders,
        });

        if (delivery.httpStatus === 429) {
          return fail(
            {
              code: 'throttled',
              message:
                'The room is rate limiting posts right now, so the ask did not land. Wait and call ' +
                'request_seat once more; do not loop on it.',
            },
            authMeta(ctx, plan),
          );
        }
        if (!delivery.ok) {
          return fail(
            { code: `http_${delivery.httpStatus}`, message: delivery.errorText || `Capture URL answered ${delivery.httpStatus}.` },
            authMeta(ctx, plan),
          );
        }

        return ok(
          {
            status: 'asked',
            from: readAs,
            to,
            verb: REQUEST_SEAT_VERB,
            captureId: delivery.captureId,
            postedAt: new Date().toISOString(),
            httpStatus: delivery.httpStatus,
            durationMs: delivery.durationMs,
            sizeBytes: delivery.sizeBytes,
            maxBytes: ownerMaxBytes(plan),
            bytesRemaining: bytesRemaining(ownerMaxBytes(plan), delivery.sizeBytes),
            hint:
              `The ask is in the room, addressed to ${to}. Keep reading with list_captures: a host who ` +
              'agrees mints a pairing code and gets it to you, and you redeem it for a seat that posts. ' +
              'Nothing here grants a seat by itself, and asking twice does not make one arrive sooner.',
          },
          authMeta(ctx, await freshPlanAfterCapture(ctx, projectId)),
        );
      } catch (err) {
        return mapAuthError(ctx, err, plan);
      }
    },
  );

  // ── B2.4 pipe manifest (slice 5): .flurryport/pipes.json — a portable,
  // regenerable projection of pipe state that travels with the user's repo.
  // Server state is the source of truth; the manifest is documentation +
  // distribution (a teammate's agent reads it and offers to connect).

  server.registerTool(
    'read_pipe_manifest',
    {
      title: 'Read pipe manifest',
      description:
        'Read .flurryport/pipes.json from the working directory: the committed record of the pipes this ' +
        'repo delivers through, holding name, endpoint, recipe, transformation, intent schema, and signing ' +
        'refs, never key material. No inputs. Use it at session start to discover existing pipes, or when ' +
        'the user asks what is wired up. Server state is the source of truth: if they disagree, trust ' +
        'list_endpoints and list_replay_targets.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const manifest = readManifest();
      return ok(
        {
          path: manifestPath(),
          version: manifest.version,
          pipes: manifest.pipes,
          hint: manifest.pipes.length === 0
            ? 'No pipes recorded yet. After wiring one (create_endpoint -> create_transformation -> bind_transformation -> set_endpoint_signing), record it with write_pipe_manifest so it travels with the repo.'
            : 'Verify against server state before firing: ids in the manifest may lag reality (server wins).',
        },
        authMeta(ctx, await anyCachedPlan(ctx)),
      );
    },
  );

  server.registerTool(
    'write_pipe_manifest',
    {
      title: 'Write pipe manifest',
      description:
        'Record or remove a pipe entry in .flurryport/pipes.json, upserting by name, so the wiring survives ' +
        'restarts and travels with the repo. NEVER put a key or token value in any field: a signing key is ' +
        'referenced by localKeyRef only, and the write is refused if anything token-shaped appears. Mark ' +
        'draft true while wiring, and clear it once the pipe is verified.',
      inputSchema: {
        name: z.string().min(1).max(100).describe('Pipe name - the upsert key within the manifest.'),
        remove: z.boolean().optional().describe('true = delete the named entry instead of upserting.'),
        projectId: z.string().optional().describe('Opaque project id; omit to use the claimed or only project.'),
        endpointSlug: z.string().optional().describe('Endpoint slug the pipe rides on.'),
        recipe: z.string().max(200).optional().describe('Catalog recipe ref (publisher:slug@version), when installed from one.'),
        transformationId: z.string().optional().describe('Opaque transformation id, from create_transformation.'),
        intentSchema: z.record(z.string(), z.unknown()).optional()
          .describe('JSON schema (or informal shape) of the intent payload post_intent callers author.'),
        signingKeyRef: z.string().max(200).optional()
          .describe('Keystore ref from set_endpoint_signing (e.g. "signing:<endpointId>") - a NAME, never a value.'),
        signingHeader: z.string().max(200).optional().describe('Signature header (default X-Flurry-Signature).'),
        draft: z.boolean().optional().describe('true while the pipe is being wired / not yet verified.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, remove, projectId, endpointSlug, recipe, transformationId, intentSchema, signingKeyRef, signingHeader, draft }) => {
      const plan = await anyCachedPlan(ctx);
      try {
        if (remove) {
          const manifest = removeManifestEntry(name);
          return ok(
            { path: manifestPath(), removed: name, pipes: manifest.pipes.map((p) => p.name) },
            authMeta(ctx, plan),
          );
        }
        if (!projectId || !endpointSlug) {
          const scope = await resolveDefaultScope(ctx);
          projectId = projectId ?? scope?.projectId;
          endpointSlug = endpointSlug ?? scope?.endpointSlug;
        }
        if (!projectId || !endpointSlug) {
          return fail(
            { code: 'ambiguous_scope', message: 'Pass projectId and endpointSlug (from list_projects / list_endpoints).' },
            authMeta(ctx, plan),
          );
        }
        const entry = {
          name,
          project: projectId,
          endpoint: endpointSlug,
          ...(recipe ? { recipe } : {}),
          ...(transformationId ? { transformation: { id: transformationId } } : {}),
          ...(intentSchema ? { intentSchema } : {}),
          ...(signingKeyRef
            // 'simple' matches what set_endpoint_signing registers server-side and what
            // post_intent receipts report - the manifest must name the same scheme.
            ? { signing: { header: signingHeader ?? 'X-Flurry-Signature', scheme: 'simple', localKeyRef: signingKeyRef } }
            : {}),
          ...(draft !== undefined ? { draft } : {}),
          createdBy: 'mcp-agent',
          createdAt: new Date().toISOString().slice(0, 10),
        };
        const manifest = upsertManifestEntry(entry);
        return ok(
          {
            path: manifestPath(),
            written: name,
            pipes: manifest.pipes.map((p) => p.name),
            hint: 'Safe to commit: the manifest carries refs, never key material. A teammate\'s agent can read it and offer to connect with their own token.',
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        return fail({ code: 'manifest_rejected', message: (err as Error).message }, authMeta(ctx, plan));
      }
    },
  );

  server.registerTool(
    'get_upgrade_options',
    {
      title: 'Get upgrade options',
      description:
        'NOT for webhook debugging. Call it only when the user asks about pricing, plan limits, or ' +
        'upgrading, or hits a cap error. No inputs. Returns the live plan catalog: every plan with its ' +
        'limits including local and external auto-forward slots, monthly and yearly subscription pricing, ' +
        'short-term day passes, currentPlanTierId when known, upgradeUrl, and a humanAction pointing at ' +
        'the billing page. It is the same source of truth the pricing page uses, so compare their current ' +
        'plan against the alternatives and name the concrete differences and prices. Buying is human-only: ' +
        'relay the humanAction link and wait.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const plan = await anyCachedPlan(ctx);
      try {
        const catalog = await fetchPlanCatalog(resolveBillingBaseUrl(ctx.client.baseUrl));
        return ok(
          {
            ...catalog,
            currentPlanTierId: plan?.PlanTierId ?? null,
            upgradeUrl: `${resolveWebBaseUrl()}/billing`,
            // #353: nothing here is buyable by an agent. Name the click and the page.
            humanAction: humanAction(
              'Choose a plan or a day pass on the billing page',
              workspacePath.billing(),
              plan?.PlanTierId != null ? String(plan.PlanTierId) : 'billing',
            ),
          },
          authMeta(ctx, plan),
        );
      } catch (err) {
        return fail(
          { code: 'unavailable', message: `Plan catalog is unreachable right now: ${(err as Error).message}` },
          authMeta(ctx, plan),
        );
      }
    },
  );
}

/** Best-effort plan for meta on project-less calls: any cached plan (single-project accounts dominate). */
function anyCachedPlan(ctx: AuthToolContext): ProjectPlanInfo | null {
  const first = ctx.session.planCache.values().next();
  return first.done ? null : first.value.plan;
}

function decodeBody(bodyBase64: string): { body: string; bodyEncoding: 'text' | 'base64' } {
  if (!bodyBase64) return { body: '', bodyEncoding: 'text' };
  const bytes = Buffer.from(bodyBase64, 'base64');
  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(bytes) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
    return { body: text, bodyEncoding: 'text' };
  }
  return { body: bodyBase64, bodyEncoding: 'base64' };
}

function safeParseHeaders(headersJson: string): Record<string, string[]> {
  try {
    return JSON.parse(headersJson) as Record<string, string[]>;
  } catch {
    return {};
  }
}
