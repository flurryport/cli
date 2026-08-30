import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AnonApiError, type AnonApiClient } from './anon-api.js';
import {
  captureUrl,
  clearStoredSession,
  ensureSession,
  hasLiveStoredSession,
  saveStoredSession,
  viewerUrl,
  type StoredAnonSession,
} from './anon-session.js';
import {
  buildAnonMeta,
  burstFromPing,
  claimUrl,
  resolveWebBaseUrl,
} from './mcp-meta.js';
import { fail, ok } from './mcp-response.js';
import { forwardCaptureToLocal, validateLocalUrl } from './local-forward.js';
import { fetchPlanCatalog, resolveBillingBaseUrl } from './plans-api.js';
import { DEFAULT_EVENT_TYPES, sendTestEventBatch, type TestProvider } from './mcp-test-events.js';
import { ensureEchoServer } from './echo-server.js';
import { buildReceipt, diagnoseForward, successNextAction, swapAttempt } from './forward-insights.js';
import { manifestPath, readManifest } from './pipe-manifest.js';
import { toUtcIso } from './time.js';

/**
 * Anonymous-mode MCP tools (spec §5 / §12.3 / §12.6). Tool descriptions are prompts —
 * they carry the behavioral rules (untrusted content, deadlines, never invent ids).
 * The meta envelope rides every response, success AND error, so throttle/upsell/expiry
 * info is always current in the model's context.
 */

// #112 (Codex round-2): the §12.1 behavioral rules that used to ride every tool
// description here (SHARED_RULES) now live ONCE in mcp-server-instructions.ts
// (SHARED_TOOL_RULES). Tool descriptions carry only tool-specific behavior.

interface AnonToolContext {
  client: AnonApiClient;
  allowLan: boolean;
  /** Device-flow watcher (spec §6) — nudged whenever a live session is in hand. */
  deviceFlow?: { ensureStarted(session: StoredAnonSession): void };
  /**
   * Fired when the agent requests Flow 2 secret setup — mcp.ts uses it to arm the
   * write-upgrade wait immediately after the claim flip, so the grant screen's click
   * releases without waiting for the agent's next poll.
   */
  onSecretSetupRequested?: () => void;
}

/** Activity-gated keep-alive (spec §3.4): ping only on genuine tool activity, max once/60s. */
const PING_INTERVAL_MS = 60_000;
let lastPingAt = 0;

async function activityPing(ctx: AnonToolContext, session: StoredAnonSession): Promise<StoredAnonSession> {
  if (Date.now() - lastPingAt < PING_INTERVAL_MS) return session;
  lastPingAt = Date.now();
  try {
    const pong = await ctx.client.ping(session.token);
    const updated: StoredAnonSession = {
      ...session,
      expiresAt: pong.ExpiresAt,
      captureCount: pong.CaptureCount,
      capturesCap: pong.CapturesCap,
    };
    saveStoredSession(updated);
    return updated;
  } catch {
    return session; // keep-alive is best-effort; the next real call surfaces any 404
  }
}

/** Map an AnonApiError to the §12.7 structured error result. */
function mapAnonError(err: unknown, session: StoredAnonSession) {
  if (err instanceof AnonApiError) {
    if (err.status === 404) {
      // The session died (expired/swept/claimed). Clear the resume slot so the next
      // get_capture_url mints a fresh one instead of looping on a dead token.
      clearStoredSession();
      return fail(
        {
          code: 'session_expired',
          message:
            'This anonymous session no longer exists (expired or already claimed). ' +
            'Call get_capture_url to start a fresh session; captures on the old one are gone.',
        },
        buildAnonMeta({ ...session, captureCount: 0 }),
      );
    }
    if (err.status === 429) {
      return fail(
        { code: 'throttled', message: err.detail || 'Rate limited. Slow down.', retryAfterSeconds: 30 },
        buildAnonMeta(session, { throttled: true, retryAfterSeconds: 30 }),
      );
    }
    return fail({ code: err.code, message: err.detail || err.message }, buildAnonMeta(session));
  }
  const message = err instanceof Error ? err.message : String(err);
  return fail({ code: 'error', message }, buildAnonMeta(session));
}

/** Decode the base64 body to text when it is printable; otherwise pass base64 through. */
function decodeBody(bodyBase64: string): { body: string; bodyEncoding: 'text' | 'base64' } {
  if (!bodyBase64) return { body: '', bodyEncoding: 'text' };
  const bytes = Buffer.from(bodyBase64, 'base64');
  const text = bytes.toString('utf8');
  // Reject if the round-trip mangled bytes (real binary) or control chars dominate.
  if (Buffer.from(text, 'utf8').equals(bytes) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
    return { body: text, bodyEncoding: 'text' };
  }
  return { body: bodyBase64, bodyEncoding: 'base64' };
}

/** Returns the registered tools so a mode flip can remove them (SDK emits tools/list_changed). */
export function registerAnonTools(server: McpServer, ctx: AnonToolContext): RegisteredTool[] {
  const registered: RegisteredTool[] = [];

  registered.push(server.registerTool(
    'get_capture_url',
    {
      description:
        "Return this anonymous session's live capture URL (paste into Stripe/GitHub/etc. as the webhook destination) " +
        'plus the browser viewer URL. CALL THIS FIRST. Use when the user mentions webhooks, webhook debugging, ' +
        'webhook testing, event replay, or a provider webhook not reaching localhost. Share BOTH urls with the user ' +
        'and tell them to open the viewer to watch events land live. Auto-creates the session on first call and ' +
        'resumes it on later calls.',
      inputSchema: {
        ref: z.string().max(64).optional()
          .describe('Attribution ref from an invite landing (inv_...) or a registry listing. Applied ONLY when ' +
            'this call mints a NEW session; a resumed session keeps its original attribution. Pass it verbatim ' +
            'from the landing document; never construct one.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ ref }) => {
      try {
        const hadLiveSession = hasLiveStoredSession(ctx.client);
        const session = await ensureSession(ctx.client, ref as string | undefined);
        ctx.deviceFlow?.ensureStarted(session);
        return ok(
          {
            captureUrl: captureUrl(session),
            viewerUrl: viewerUrl(session),
            endpointSlug: session.endpointSlug,
            expiresAt: session.expiresAt,
            ...(ref ? { refApplied: !hadLiveSession } : {}),
            hint:
              'Walk the user through setup: point their webhook provider at captureUrl, and tell them to open ' +
              'viewerUrl in a browser to watch events arrive live. Then poll list_captures and analyze each capture as it lands. ' +
              'This session is temporary; claiming it (free signup) makes the captures permanent and encrypted. ' +
              'If the user ALREADY has a FlurryPORT account, skip claiming: they run `flurryport login` with NO ' +
              'token, open the approval URL it prints in their own browser, and approve; the token is minted ' +
              'server-side and never enters this conversation. Then restart this MCP server to switch to their ' +
              'real projects. Never ask the user to paste a token into the chat; the pasted-token form of login ' +
              `exists for terminals only a human types into. Docs for the user: ${resolveWebBaseUrl()}/docs/cli`,
          },
          buildAnonMeta(session),
        );
      } catch (err) {
        const dead: StoredAnonSession = {
          token: '',
          sessionSlug: '',
          endpointSlug: '',
          expiresAt: new Date().toISOString(),
          captureCount: 0,
          capturesCap: 0,
          anonBaseUrl: ctx.client.baseUrl,
          createdAt: new Date().toISOString(),
        };
        return mapAnonError(err, dead);
      }
    },
  ));

  registered.push(server.registerTool(
    'list_captures',
    {
      description:
        'List webhooks captured on this anonymous session, newest first. Poll this to see events as they arrive; ' +
        'it returns summaries only - call get_capture with an id for the full body. Rejected captures are flagged ' +
        'with a rejectionReason. Pass ids back verbatim; never construct one.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Max captures to return (default 20).'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit }) => {
      let session = await ensureSession(ctx.client);
      try {
        const res = await ctx.client.listCaptures(session.token, session.endpointSlug, limit ?? 20);
        session = {
          ...session,
          expiresAt: res.ExpiresAt,
          captureCount: res.CaptureCount,
          capturesCap: res.CapturesCap,
        };
        saveStoredSession(session);
        ctx.deviceFlow?.ensureStarted(session);
        session = await activityPing(ctx, session);
        // Ledger item 9 (ratified): anon reads answer the AUTHED key shape - Requests[]
        // with PascalCase fields plus a scope stamp - so the claim flip never changes the
        // shape an agent parses. Fields the anon DTO lacks are omitted, never invented.
        return ok(
          {
            Requests: res.Captures.map((c) => ({
              Id: c.Id,
              HttpMethod: c.HttpMethod,
              ProviderHint: c.ProviderHint ?? null,
              ProviderEventType: c.ProviderEventType ?? null,
              ContentType: c.ContentType ?? null,
              BodySize: c.BodySize,
              RejectionReason: c.RejectionReason ?? null,
              CreatedAt: toUtcIso(c.CreatedAt),
            })),
            TotalCount: res.CaptureCount,
            // The anon session's only endpoint identity is its slug; readAs speaks the
            // same vocabulary the authed readScope stamp uses.
            scope: { endpointId: session.endpointSlug, readAs: 'anon-session' },
          },
          buildAnonMeta(session),
        );
      } catch (err) {
        return mapAnonError(err, session);
      }
    },
  ));

  registered.push(server.registerTool(
    'get_capture_digest',
    {
      description:
        'Grouped digest of this session\'s captures: totals plus counts by event type, by provider, and by hour ' +
        '(facts only, never payloads). Use this INSTEAD of listing everything when the user asks "what came in", ' +
        'when captures pile up during bulk generation, or to spot the noisy event type before drilling down. ' +
        'Follow up with list_captures / get_capture on the group that matters.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      let session = await ensureSession(ctx.client);
      try {
        const res = await ctx.client.getDigest(session.token, session.endpointSlug);
        session = {
          ...session,
          expiresAt: res.ExpiresAt,
          captureCount: res.CaptureCount,
          capturesCap: res.CapturesCap,
        };
        saveStoredSession(session);
        ctx.deviceFlow?.ensureStarted(session);
        session = await activityPing(ctx, session);
        return ok(
          {
            totalCount: res.TotalCount,
            rejectedCount: res.RejectedCount,
            byEventType: res.ByEventType.map((g) => ({ key: g.Key, count: g.Count, lastAt: toUtcIso(g.LastAt) })),
            byProvider: res.ByProvider.map((g) => ({ key: g.Key, count: g.Count, lastAt: toUtcIso(g.LastAt) })),
            byHour: res.ByHour.map((b) => ({ bucketStartUtc: toUtcIso(b.BucketStartUtc), count: b.Count })),
            hint: 'Drill down with list_captures, then get_capture by id. Session captures expire with the session; see meta.deadlines.',
          },
          buildAnonMeta(session),
        );
      } catch (err) {
        return mapAnonError(err, session);
      }
    },
  ));

  registered.push(server.registerTool(
    'register_watch',
    {
      description:
        'Register a watch on this anonymous session: a JSONata predicate over $body/$headers/$query, plus an ' +
        'optional label. IMPORTANT: this watch SLEEPS until the session is claimed - it is stored, validated, ' +
        'and does nothing while anonymous. When the user signs up and claims the session, the watch wakes up on ' +
        'their real endpoint and starts matching every new capture (enabled up to their plan limit; extras carry ' +
        'over disabled). Use when the user says "watch for X" or "tell me when X happens" - register it now so ' +
        'nothing is lost at signup. Predicates may NOT reference $secrets. ' +
        'Example predicate: $body.type = "charge.failed".',
      inputSchema: {
        name: z.string().min(1).max(200).describe('Human-readable watch name.'),
        predicate: z.string().min(1).max(2000).describe('JSONata predicate over $body/$headers/$query.'),
        label: z.string().max(200).optional()
          .describe('Label the woken watch will stamp onto matching captures after claim.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ name, predicate, label }) => {
      let session = await ensureSession(ctx.client);
      try {
        const res = await ctx.client.registerWatch(session.token, session.endpointSlug, name, predicate, label);
        ctx.deviceFlow?.ensureStarted(session);
        session = await activityPing(ctx, session);
        return ok(
          {
            id: res.Id,
            name: res.Name,
            predicate: res.Predicate,
            label: res.Label ?? null,
            dormant: true,
            watchCount: res.WatchCount,
            watchesCap: res.WatchesCap,
            hint:
              'Stored, validated, and dormant: this watch does nothing until the session is claimed. ' +
              'Claiming (free signup, claimUrl in meta.deadlines) wakes it on the real endpoint.',
          },
          buildAnonMeta(session),
        );
      } catch (err) {
        return mapAnonError(err, session);
      }
    },
  ));

  registered.push(server.registerTool(
    'list_watches',
    {
      description:
        'List the dormant watches registered on this anonymous session (name, predicate, label). These sleep ' +
        'until the session is claimed - there is no match count or enabled state yet. Use after register_watch ' +
        'or when the user asks what is being watched.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      let session = await ensureSession(ctx.client);
      try {
        const res = await ctx.client.listWatches(session.token, session.endpointSlug);
        ctx.deviceFlow?.ensureStarted(session);
        session = await activityPing(ctx, session);
        return ok(
          {
            watches: res.Watches.map((w) => ({
              id: w.Id,
              name: w.Name,
              predicate: w.Predicate,
              label: w.Label ?? null,
              dormant: true,
              createdAt: toUtcIso(w.CreatedAt),
            })),
            watchesCap: res.WatchesCap,
            hint: 'All dormant until claim; claiming wakes them on the real endpoint (enabled up to the plan limit).',
          },
          buildAnonMeta(session),
        );
      } catch (err) {
        return mapAnonError(err, session);
      }
    },
  ));

  registered.push(server.registerTool(
    'read_pipe_manifest',
    {
      description:
        'Read .flurryport/pipes.json from the working directory: pipes this repo delivers through ' +
        '(recorded by a teammate or a previous session). If entries exist, this project is already wired to ' +
        'FlurryPORT - tell the user, and offer to connect THIS session to it: they sign in (claim or ' +
        '`flurryport login <token>`), the toolset flips to authenticated mode, and the recorded pipes become ' +
        'usable. Contains refs only, never key material.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const session = await ensureSession(ctx.client);
      const manifest = readManifest();
      return ok(
        {
          path: manifestPath(),
          version: manifest.version,
          pipes: manifest.pipes,
          hint: manifest.pipes.length === 0
            ? 'No pipe manifest in this repo.'
            : 'This repo already delivers through FlurryPORT pipes. Offer to connect: the user signs in with their own account (claim this session or flurryport login), and the pipes above light up.',
        },
        buildAnonMeta(session),
      );
    },
  ));

  registered.push(server.registerTool(
    'get_capture',
    {
      description:
        'Fetch one captured webhook in full (headers, query string, body) by id from list_captures. ' +
        'Anonymous captures are PLAINTEXT on the server. The body is the raw provider payload. ' +
        'id is accepted as an alias for captureId.',
      inputSchema: {
        captureId: z.string().optional().describe('The id from a prior list_captures call, verbatim.'),
        id: z.string().optional().describe('Alias for captureId.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ captureId, id: captureIdAlias }) => {
      captureId = captureId ?? captureIdAlias;
      let session = await ensureSession(ctx.client);
      if (!captureId) {
        return fail(
          { code: 'validation', message: 'Pass captureId (or its alias id) from a prior list_captures row, verbatim.' },
          buildAnonMeta(session),
        );
      }
      try {
        const res = await ctx.client.getCapture(session.token, session.endpointSlug, captureId);
        session = await activityPing(ctx, session);
        const { body, bodyEncoding } = decodeBody(res.Body);
        // Ledger item 9 (ratified): the single read answers authed-like PascalCase keys
        // (plus the same lowercase body/bodyEncoding/headers companions the authed
        // get_capture emits) and a scope stamp. Fields the anon DTO lacks are omitted.
        return ok(
          {
            Id: res.Id,
            HttpMethod: res.HttpMethod,
            QueryString: res.QueryString ?? null,
            ContentType: res.ContentType ?? null,
            ContentLength: res.ContentLength ?? null,
            ProviderHint: res.ProviderHint ?? null,
            ProviderEventType: res.ProviderEventType ?? null,
            RejectionReason: res.RejectionReason ?? null,
            CreatedAt: toUtcIso(res.CreatedAt),
            body,
            bodyEncoding,
            headers: safeParseHeaders(res.Headers),
            scope: { endpointId: session.endpointSlug, readAs: 'anon-session' },
          },
          buildAnonMeta(session),
        );
      } catch (err) {
        return mapAnonError(err, session);
      }
    },
  ));

  registered.push(server.registerTool(
    'forward_to_localhost',
    {
      description:
        "Forward (replay) one captured webhook to a URL on the user's OWN machine, e.g. http://localhost:3000/webhook. " +
        'The CLI delivers it locally; the FlurryPORT server never makes this call. The full RAW payload and original ' +
        'headers are delivered faithfully, so provider signatures stay verifiable. Returns only the local response ' +
        "status and a short preview so you can help debug how the user's app handled it. Confirm the port/path with " +
        'the user before calling.',
      inputSchema: {
        captureId: z.string().optional()
          .describe('The id from a prior list_captures call, verbatim. Omit to forward the latest accepted capture(s).'),
        latestCount: z.number().int().min(1).max(10).optional()
          .describe('When captureId is omitted: how many of the newest accepted captures to forward (default 1, max 10).'),
        localUrl: z
          .string()
          .describe('Loopback URL on the user\'s machine (localhost / 127.x / [::1]). The CLI re-validates this.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ captureId, latestCount, localUrl }) => {
      let session = await ensureSession(ctx.client);
      const verdict = validateLocalUrl(localUrl, ctx.allowLan);
      if (!verdict.ok) {
        return fail({ code: 'validation', message: verdict.reason }, buildAnonMeta(session));
      }
      try {
        let captureIds: string[];
        if (captureId) {
          captureIds = [captureId];
        } else {
          const wanted = latestCount ?? 1;
          const page = await ctx.client.listCaptures(session.token, session.endpointSlug, Math.min(wanted + 10, 50));
          captureIds = page.Captures.filter((c) => c.RejectionReason == null)
            .slice(0, wanted)
            .map((c) => c.Id);
          if (captureIds.length === 0) {
            return fail(
              { code: 'not_found', message: 'No accepted captures on this session yet. Send or capture one first.' },
              buildAnonMeta(session),
            );
          }
        }

        const forwarded: Array<Record<string, unknown>> = [];
        for (const cid of captureIds) {
          const capture = await ctx.client.getCapture(session.token, session.endpointSlug, cid);
          if (capture.RejectionReason != null) {
            forwarded.push({ captureId: cid, skipped: true, reason: `rejected on ingest (${capture.RejectionReason})` });
            continue;
          }
          const result = await forwardCaptureToLocal(capture, verdict.url);
          const { body } = decodeBody(capture.Body);
          forwarded.push({
            captureId: cid,
            statusCode: result.statusCode,
            statusText: result.statusText,
            durationMs: result.durationMs,
            responseHeaders: result.responseHeaders,
            responseBodyPreview: result.responseBodyPreview,
            responseJson: result.responseJson,
            receipt: buildReceipt({
              provider: capture.ProviderHint ?? null,
              eventType: capture.ProviderEventType ?? null,
              headersJson: capture.Headers,
              bodyText: body,
            }),
            diagnosis: diagnoseForward({
              statusCode: result.statusCode,
              responseBodyPreview: result.responseBodyPreview,
              provider: capture.ProviderHint ?? null,
              postedUrl: verdict.url.toString(),
            }),
            previousAttempt: swapAttempt(cid, result.statusCode, result.durationMs),
          });
        }
        session = await activityPing(ctx, session);
        const last = forwarded[forwarded.length - 1] as { statusCode?: number };
        const suggestedNextAction = successNextAction(verdict.url.toString(), last.statusCode ?? 0);
        return ok(
          captureId && forwarded.length === 1
            ? ({ ...(forwarded[0] as Record<string, unknown>), suggestedNextAction } as Record<string, unknown>)
            : { forwarded, suggestedNextAction },
          buildAnonMeta(session),
        );
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return fail(
            {
              code: 'local_unreachable',
              message: `No response from ${localUrl} within 10s. Is the user's app running on that port?`,
            },
            buildAnonMeta(session),
          );
        }
        if (err instanceof TypeError) {
          return fail(
            {
              code: 'local_unreachable',
              message: `Could not connect to ${localUrl}. Is the user's app running on that port?`,
            },
            buildAnonMeta(session),
          );
        }
        return mapAnonError(err, session);
      }
    },
  ));

  registered.push(server.registerTool(
    'capture_count',
    {
      description:
        'Cheap progress check: accepted/rejected counts, remaining cap, and the per-minute burst window for this ' +
        'anonymous session. Use it while an external sender (stripe CLI, curl, a provider dashboard) is generating ' +
        'webhooks to report progress and pace batches without eating 429s.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      let session = await ensureSession(ctx.client);
      try {
        const pong = await ctx.client.ping(session.token);
        session = {
          ...session,
          expiresAt: pong.ExpiresAt,
          captureCount: pong.CaptureCount,
          capturesCap: pong.CapturesCap,
        };
        saveStoredSession(session);
        ctx.deviceFlow?.ensureStarted(session);
        const burst = burstFromPing(pong);
        const accepted = pong.CaptureCount;
        const rejected = pong.RejectedCount ?? 0;
        return ok(
          {
            accepted,
            rejected,
            totalAttempts: accepted + rejected,
            capturesRemaining: Math.max(0, pong.CapturesCap - accepted),
            latestCaptureAt: pong.LatestCaptureAt ? toUtcIso(pong.LatestCaptureAt) : null,
            latestRejectedAt: pong.LatestRejectedAt ? toUtcIso(pong.LatestRejectedAt) : null,
            viewerUrl: viewerUrl(session),
          },
          buildAnonMeta(session, { burst }),
        );
      } catch (err) {
        return mapAnonError(err, session);
      }
    },
  ));

  registered.push(server.registerTool(
    'send_test_event',
    {
      description:
        'Send provider-shaped TEST webhooks to this session\'s capture URL so the user can exercise the capture ' +
        'loop before their real provider is wired up. Bodies and headers are realistic enough to light up provider ' +
        'and event-type detection, but signature headers are placeholders: they will NOT pass signature verification ' +
        'in the user\'s app. Prefer pointing the real provider at the captureUrl once scaffolding works. ' +
        'Refuses up front if count exceeds the remaining capture cap. With pace "auto" (default) it waits out the ' +
        'burst window inside the call and reports totalWaitMs; with pace "none" it refuses instead of waiting. ' +
        'Each delivery returns a syntheticEventId and a testId (also sent as the x-flurryport-test-id header) for ' +
        'correlation with list_captures.',
      inputSchema: {
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
    async ({ provider, eventType, bodyOverrides, count, pace }) => {
      let session = await ensureSession(ctx.client);
      const requested = count ?? 1;
      const paceMode = pace ?? 'auto';
      try {
        let pong = await ctx.client.ping(session.token);
        session = {
          ...session,
          expiresAt: pong.ExpiresAt,
          captureCount: pong.CaptureCount,
          capturesCap: pong.CapturesCap,
        };
        saveStoredSession(session);
        ctx.deviceFlow?.ensureStarted(session);
        let burst = burstFromPing(pong);

        // Refuse-before-send (agent feedback): partial sends create explanation debt.
        const remaining = Math.max(0, pong.CapturesCap - pong.CaptureCount);
        if (requested > remaining) {
          return fail(
            {
              code: 'cap_would_exceed',
              message:
                remaining === 0
                  ? 'The anonymous capture cap is full. Nothing was sent. Claim the session (see meta.actions) to keep capturing.'
                  : `Only ${remaining} captures remain on this session. Nothing was sent. Send at most ${remaining}, or claim the session (see meta.actions) to remove the cap.`,
            },
            buildAnonMeta(session, { burst }),
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
            buildAnonMeta(session, { burst }),
          );
        }

        const { deliveries, paced, totalWaitMs } = await sendTestEventBatch({
          captureUrl: captureUrl(session),
          provider: provider as TestProvider,
          eventType,
          bodyOverrides,
          requested,
          paceMode,
          burst,
        });

        // Fresh server truth after the batch, so the meta the agent relays is current.
        pong = await ctx.client.ping(session.token);
        session = {
          ...session,
          expiresAt: pong.ExpiresAt,
          captureCount: pong.CaptureCount,
          capturesCap: pong.CapturesCap,
        };
        saveStoredSession(session);
        burst = burstFromPing(pong);

        return ok(
          {
            requested,
            sent: deliveries.filter((d) => d.statusCode === 200).length,
            paced,
            totalWaitMs,
            deliveries,
            capturesRemaining: Math.max(0, pong.CapturesCap - pong.CaptureCount),
            note:
              'Signature headers are shape-realistic placeholders and will not pass real signature verification. ' +
              'Point the real provider at the captureUrl for end-to-end testing.',
          },
          buildAnonMeta(session, { burst }),
        );
      } catch (err) {
        return mapAnonError(err, session);
      }
    },
  ));

  registered.push(server.registerTool(
    'start_echo_server',
    {
      description:
        "Start (or reuse) a local echo receiver on the user's machine so replay can be proven before their real " +
        'backend exists: it answers 200 and mirrors the method, headers, and body back, so a forward_to_localhost ' +
        'against it SHOWS the delivered webhook in responseBodyPreview. Runs inside this MCP process on loopback ' +
        'only and stops when the session ends. Idempotent: repeat calls return the running instance.',
      inputSchema: {
        port: z.number().int().min(1024).max(65535).optional()
          .describe('Preferred port (default 4242). Falls back to an ephemeral port if busy.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ port }) => {
      const session = await ensureSession(ctx.client);
      try {
        const info = await ensureEchoServer(port);
        return ok(
          {
            ...info,
            suggestedNextAction:
              `Call forward_to_localhost with localUrl "${info.localUrl}" (omit captureId to forward the latest ` +
              'capture) to prove the replay loop end to end.',
          },
          buildAnonMeta(session),
        );
      } catch (err) {
        return mapAnonError(err, session);
      }
    },
  ));

  registered.push(server.registerTool(
    'get_upgrade_options',
    {
      description:
        'NOT for webhook debugging. Only call when the user asks about pricing, plan limits, upgrades, or ' +
        'hitting a usage cap. Live plan catalog and pricing from the FlurryPORT billing API: every tier with its limits, ' +
        'monthly and yearly subscription pricing, and short-term day passes. Call this whenever the user ' +
        'asks about pricing, limits, or upgrading, or hits a cap, so you can tell them exactly what each ' +
        'option costs and unlocks. The data is live - the same source of truth the pricing page uses. ' +
        'This session is anonymous: claiming it (free signup, claimUrl in meta.deadlines) comes first; ' +
        'paid tiers and day passes apply to the account after. All purchases happen in the web app.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      // Pricing must not depend on a session mint succeeding — fall back to a
      // dead-session meta (same shape get_capture_url uses on mint failure).
      let session: StoredAnonSession;
      try {
        session = await ensureSession(ctx.client);
      } catch {
        session = {
          token: '',
          sessionSlug: '',
          endpointSlug: '',
          expiresAt: new Date().toISOString(),
          captureCount: 0,
          capturesCap: 0,
          anonBaseUrl: ctx.client.baseUrl,
          createdAt: new Date().toISOString(),
        };
      }
      try {
        const catalog = await fetchPlanCatalog(resolveBillingBaseUrl());
        return ok(
          { ...catalog, pricingUrl: `${resolveWebBaseUrl()}/pricing` },
          buildAnonMeta(session),
        );
      } catch (err) {
        return fail(
          { code: 'unavailable', message: `Plan catalog is unreachable right now: ${(err as Error).message}` },
          buildAnonMeta(session),
        );
      }
    },
  ));

  registered.push(server.registerTool(
    'request_secret_setup',
    {
      description:
        'Call this when a recipe you are wiring STORES A CREDENTIAL or DELIVERS EXTERNALLY - that needs a free ' +
        'FlurryPORT account (anonymous sessions never hold secrets). Prefer passing recipeRef alone. The ' +
        'response is the platform consent gate with three parts: explanation (background you may paraphrase), ' +
        'askTheUser (the consent QUESTION - ask it verbatim and WAIT for a clear yes), and agentInstructions ' +
        '(choreography for YOU - never show it). If they agree, show entryUrl - the user opens it and types ' +
        'their OWN email there; NEVER supply, guess, or ask for the email yourself. One click on the emailed ' +
        'link then creates or signs in their account, migrates this ' +
        'session (captures and watches survive), and opens the secret entry boxes. When that completes, this ' +
        'connection upgrades to their account automatically (you will see a session_claimed notice with the ' +
        'migrated ids) - then poll request_secret_setup with checkOnly=true until allSet and continue wiring. ' +
        'If they already have an account, offer the escapeHatch instead.',
      inputSchema: {
        recipeRef: z.string().max(200).optional()
          .describe('PREFERRED: the catalog ref exactly as get_recipe returns it (publisher:slug; @version and ' +
            '+hash suffixes are accepted and ignored - resolution always uses the latest published version). ' +
            'The platform resolves the secret names from the published recipe itself - you cannot and need ' +
            'not declare them.'),
        secretNames: z.array(z.string().min(1).max(100)).max(5).optional()
          .describe('ONLY for a custom pipe with no catalog recipe: the secret NAMES it needs. Names only, never values. Ignored when recipeRef is set.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ secretNames, recipeRef }) => {
      let session = await ensureSession(ctx.client);
      if (!recipeRef && (!secretNames || secretNames.length === 0)) {
        return fail(
          { code: 'nothing_declared', message: 'Pass recipeRef for a catalog recipe (names resolve automatically) or secretNames for a custom pipe.' },
          buildAnonMeta(session),
        );
      }
      try {
        const gate = await ctx.client.requestSecretSetup(session.token, secretNames ?? [], recipeRef ?? null);
        // The conversion lands via the device-flow poll - make sure it is armed so the
        // claim flips this server to the new account without a restart.
        ctx.deviceFlow?.ensureStarted(session);
        // Remember that a wiring ceremony is in flight: the post-claim toolset arms
        // the write-upgrade wait right at the flip (in-flow write grant).
        ctx.onSecretSetupRequested?.();
        session = await activityPing(ctx, session);
        return ok(
          {
            code: gate.Code,
            explanation: gate.Explanation,
            askTheUser: gate.UserPrompt,
            agentInstructions: gate.ConsentInstruction,
            escapeHatch: gate.EscapeHatch,
            entryUrl: `${resolveWebBaseUrl()}${gate.EntryPath}`,
            secretNames: gate.SecretNames,
            recipeRef: gate.RecipeRef,
            freeSecretLimit: gate.FreeSecretLimit,
            limitWarning: gate.LimitWarning,
            hint:
              'Ask the user askTheUser VERBATIM and WAIT for explicit consent - do not print agentInstructions ' +
              'or this hint. On yes: show entryUrl and stop - the human does the rest in their browser and ' +
              'inbox. You will be notified here when the account exists and the session has migrated.',
          },
          buildAnonMeta(session),
        );
      } catch (err) {
        return mapAnonError(err, session);
      }
    },
  ));

  registered.push(server.registerTool(
    'create_invite',
    {
      description:
        'Mint an invite link so ANOTHER PERSON (and their AI agent) can join this session - for example to ' +
        'play a game recipe or send events into the shared inbox. Returns inviteUrl: give it to your user to ' +
        'send to their friend however they like; the friend opens it in a browser, or their agent fetches it ' +
        'as JSON and onboards itself (recipe, capture URLs, attribution ref - everything needed, no account). ' +
        'Pass role "producer" when the friend should SEND events in (games, shared intake) or "monitor" when ' +
        'they should only READ. Pass displayName (e.g. the host\'s first name or team) and recipeRef (from ' +
        'get_recipe / search_recipes) so the landing page tells the friend who invited them and which recipe ' +
        'to follow. The invite dies with this session and the host can revoke it. The raw invite link is ' +
        'shown ONCE in this response - relay it to the user immediately.',
      inputSchema: {
        role: z.enum(['producer', 'monitor'])
          .describe('producer = the friend sends events into the shared inbox; monitor = read only.'),
        displayName: z.string().min(1).max(100).optional()
          .describe('Who the invite is from, as the landing page should show it (a first name or team name). ' +
            'Ask the user; never invent one.'),
        recipeRef: z.string().max(200).optional()
          .describe('The catalog ref exactly as get_recipe / search_recipes returns it - the landing page ' +
            'routes the friend\'s agent to this recipe.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ role, displayName, recipeRef }) => {
      let session = await ensureSession(ctx.client);
      try {
        const res = await ctx.client.createInvite(session.token, role as string, displayName as string | undefined, recipeRef as string | undefined);
        ctx.deviceFlow?.ensureStarted(session);
        session = await activityPing(ctx, session);
        return ok(
          {
            inviteUrl: `${session.anonBaseUrl}${res.LandingPath}`,
            ref: res.Ref,
            role: res.Role,
            expiresAt: res.ExpiresAt,
            inviteCount: res.InviteCount,
            invitesCap: res.InvitesCap,
            hint:
              'Give inviteUrl to your user to share with their friend now - this is the only time it is shown. ' +
              'The friend\'s agent fetches it as JSON and sets itself up; a browser shows a human explanation. ' +
              'The ref identifies this invite in future responses. The invite expires with this session.',
          },
          buildAnonMeta(session),
        );
      } catch (err) {
        return mapAnonError(err, session);
      }
    },
  ));

  return registered;
}

function safeParseHeaders(headersJson: string): Record<string, string[]> {
  try {
    return JSON.parse(headersJson) as Record<string, string[]>;
  } catch {
    return {};
  }
}

/** Exposed for the claim/upsell hint in command help text. */
export { claimUrl };
