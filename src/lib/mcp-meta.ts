import { saveStoredSession, type StoredAnonSession } from './anon-session.js';
import { toUtcIso, utcMs } from './time.js';
import { takeCliUpdateNotice } from './version-nudge.js';

/**
 * The meta envelope that rides EVERY MCP tool response (spec §3.6 / §12.2). Absolute
 * timestamps, not relative seconds — the model often reasons from a meta block fetched
 * hours earlier in its context, and an absolute `expiresAt` stays true where a
 * countdown goes stale (§8.2). Each absolute timestamp is PAIRED with a relative
 * `...InMinutes` companion computed at response time: models routinely misread ISO-UTC
 * as local time (observed: a 60-minute session relayed as "expires at 2:02 PM MDT,
 * 7.5 hours from now"), and the relative value needs no timezone math. The absolute
 * form stays true in stale context; the relative form is re-emitted fresh on every
 * response — prefer it when telling the user how long they have. Legibility here is a
 * cooperation/UX feature, NOT a security control: the server enforces every limit
 * regardless. Expose the user's own quota; never anti-abuse tripwires.
 */
export interface MetaDeadline {
  kind: 'session_expiry' | 'retention_deletion' | 'pass_expiry';
  at: string;
  /** Minutes from THIS response until `at` (fresh each response; 0 when past due). */
  inMinutes: number;
  affects: string;
  message: string;
  url: string;
}

/**
 * A structured continuation the agent can recommend without paraphrasing marketing copy.
 * Shape suggested by a live agent driving the /try funnel: kind is machine-readable,
 * label/cost/effect are ready to relay verbatim. `recommended` flips true when the
 * current state makes this THE next move (at_cap, nearing_cap, nearing_expiry).
 */
export interface MetaAction {
  kind: 'claim_session' | 'upgrade_plan';
  label: string;
  url: string;
  cost: 'free' | 'paid';
  effect: string;
  recommended: boolean;
}

/**
 * Per-minute burst window (agent feedback, 0.2.2): lets a sender plan batch sizes
 * before eating 429s. Present only when the response had fresh ping data; null means
 * "unknown", not "unlimited".
 */
export interface MetaBurst {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
  resetsInSeconds: number;
}

/**
 * One-time milestone notice with a STABLE code (agents key on codes, not prose).
 * Fires once per session per code — "make polling rewarding, not merely instructed":
 * a poll that returns a notice is a poll the agent relays to the user.
 */
export interface MetaNotice {
  code:
    | 'plaintext_session'
    | 'first_capture'
    | 'half_cap'
    | 'nearing_cap'
    | 'at_cap'
    | 'session_claimed'
    | 'write_granted'
    | 'write_skipped'
    | 'cli_update_available'
    | 'seat_ending'
    | 'room_idle'
    | 'attention_hold'
    | 'attention_interrupt'
    | 'attention_resume';
  message: string;
  viewerUrl?: string;
}

/**
 * The attention wake-up notices (0.5.1 slice C): the seat-facing prose for the
 * chair's fp:hold / fp:interrupt / fp:resume orders, centralized here in the
 * meta home (lesson 61). Every message points the seat AT THE STREAM - the
 * signed post is the obligation, this notice is only the wake-up.
 */
export function attentionNotice(order: { code: 'attention_hold' | 'attention_interrupt' | 'attention_resume'; panic: boolean }): MetaNotice {
  switch (order.code) {
    case 'attention_hold':
      return {
        code: order.code,
        message:
          'The chair ordered a hold on your seat. Pause after the current step and read the stream: ' +
          'the signed order post is the obligation, this notice is only the wake-up. ' +
          'Wait for a resume or new orders.',
      };
    case 'attention_interrupt':
      return {
        code: order.code,
        message: order.panic
          ? 'EMERGENCY STOP from the chair. Stop everything and read the stream now: answer the ' +
            'interrupt post with an fp:ack (or an fp:refuse carrying reason routing, wording, or substance) '
            + 'post, re-linked to its id, before anything else.'
          : 'The chair interrupted your seat. Stop the current task and read the stream now: ' +
            'the newest signed post addressed to you carries your orders.',
      };
    case 'attention_resume':
      return {
        code: order.code,
        message:
          'The chair resumed your seat: continue the task you were holding. The stream has the record.',
      };
  }
}

export interface MetaEnvelope {
  mode: 'anonymous' | 'authenticated';
  capturesUsed: number;
  capturesCap: number | null;
  /** Captures left before the cap (fresh each response; null when uncapped). */
  capturesRemaining: number | null;
  expiresAt: string | null;
  /** Minutes from THIS response until `expiresAt` (fresh each response; null when no expiry). */
  expiresInMinutes: number | null;
  state: 'ok' | 'nearing_cap' | 'at_cap' | 'nearing_expiry' | 'throttled';
  retryAfterSeconds: number | null;
  burst: MetaBurst | null;
  deadlines: MetaDeadline[];
  actions: MetaAction[];
  upsell: { message: string; url: string } | null;
  notice: MetaNotice | null;
}

/**
 * The seat server's envelope (0.5.0, #233): a seat principal has no capture quota,
 * claim ladder, or upsell rail - only its own expiry. Deliberately minimal; the fields
 * it shares with MetaEnvelope keep their exact semantics (absolute timestamp paired
 * with a fresh relative companion on every response).
 */
export interface SeatMetaEnvelope {
  mode: 'seat';
  expiresAt: string | null;
  expiresInMinutes: number | null;
  state: 'ok' | 'nearing_expiry';
  notice: MetaNotice | null;
}

/** Every envelope shape a tool response may carry. */
export type AnyMetaEnvelope = MetaEnvelope | SeatMetaEnvelope;

/** Whole minutes from now until an ISO timestamp, floored at 0 (past due). */
export function minutesUntil(atIso: string): number {
  return Math.max(0, Math.round((utcMs(atIso) - Date.now()) / 60_000));
}

const NEARING_CAP_RATIO = 0.8;
const NEARING_EXPIRY_MS = 22.5 * 60 * 1000; // 22.5m — a quarter of the 90m anon SlidingTtl, so a fresh session isn't born nearing expiry

/** Where signup/claim happens — the authenticated product, not the anon island. */
export function resolveWebBaseUrl(): string {
  return (process.env.FLURRYPORT_WEB_URL ?? 'https://flurryport.io').replace(/\/$/, '');
}

export function claimUrl(session: StoredAnonSession): string {
  // Users.Web register persists ?anonToken= and claims after verify (the browser claim
  // flow — deliberately cookie-only server-side; the agent can only surface this URL).
  return `${resolveWebBaseUrl()}/register?anonToken=${session.token}`;
}

const PLAINTEXT_NOTICE =
  'Anonymous sessions are plaintext. Do not send real production or PII data.';

/**
 * Milestone ladder, ascending. The HIGHEST newly-reached milestone fires as this
 * response's notice; everything at or below it is marked notified so a session that
 * jumps 0→100 in one poll emits one at_cap notice, not the whole ladder in sequence.
 * Dedupe state persists in the session file (single MCP process per session is the
 * norm; a concurrent process would at worst repeat a notice, never lose one).
 */
/** session_claimed / write_granted / write_skipped are authed-mode notices (device-flow flip + in-flow write grant); cli_update_available is the server-driven staleness nudge; seat_ending and the attention_* wake-ups are the seat server's. None are part of the anon ladder. */
type AnonMilestone = Exclude<
  MetaNotice['code'],
  | 'session_claimed'
  | 'write_granted'
  | 'write_skipped'
  | 'cli_update_available'
  | 'seat_ending'
  | 'room_idle'
  | 'attention_hold'
  | 'attention_interrupt'
  | 'attention_resume'
>;

const MILESTONES: AnonMilestone[] = ['plaintext_session', 'first_capture', 'half_cap', 'nearing_cap', 'at_cap'];

function milestoneReached(code: AnonMilestone, used: number, cap: number): boolean {
  switch (code) {
    case 'plaintext_session': return true;
    case 'first_capture': return used >= 1;
    case 'half_cap': return cap > 0 && used >= cap / 2;
    case 'nearing_cap': return cap > 0 && used >= cap * NEARING_CAP_RATIO;
    case 'at_cap': return cap > 0 && used >= cap;
  }
}

function milestoneNotice(code: AnonMilestone, session: StoredAnonSession, used: number, cap: number): MetaNotice {
  switch (code) {
    case 'plaintext_session':
      return { code, message: PLAINTEXT_NOTICE };
    case 'first_capture':
      return {
        code,
        message: 'First webhook captured. Remind the user they can watch events land live in the browser.',
        viewerUrl: sessionViewerUrl(session),
      };
    case 'half_cap':
      return { code, message: `Half the anonymous capture cap is used (${used} of ${cap}).` };
    case 'nearing_cap':
      return { code, message: `Only ${Math.max(0, cap - used)} captures remain on this anonymous session.` };
    case 'at_cap':
      return { code, message: 'The anonymous capture cap is full. New webhooks are rejected until the session is claimed.' };
  }
}

/** Mirrors anon-session's viewerUrl without importing it (avoids a module cycle). */
function sessionViewerUrl(session: StoredAnonSession): string {
  const base = (process.env.FLURRYPORT_VIEWER_URL ?? session.anonBaseUrl).replace(/\/$/, '');
  return `${base}/v/${session.token}/${session.endpointSlug}`;
}

/**
 * Pick this response's one-time notice and persist the dedupe state. Skipped for
 * dead placeholder sessions (no token = nothing to persist against).
 */
function takeNotice(session: StoredAnonSession, used: number, cap: number): MetaNotice | null {
  if (!session.token) return null;
  const already = new Set(session.notifiedMilestones ?? []);
  const reached = MILESTONES.filter((code) => milestoneReached(code, used, cap));
  const fresh = reached.filter((code) => !already.has(code));
  if (fresh.length === 0) return null;

  const fire = fresh[fresh.length - 1];
  reached.forEach((code) => already.add(code));
  try {
    saveStoredSession({ ...session, notifiedMilestones: [...already] });
  } catch {
    /* dedupe persistence is best-effort — worst case a notice repeats */
  }
  return milestoneNotice(fire, session, used, cap);
}

export function buildAnonMeta(
  session: StoredAnonSession,
  overrides: { throttled?: boolean; retryAfterSeconds?: number; burst?: MetaBurst | null } = {},
): MetaEnvelope {
  const used = session.captureCount;
  const cap = session.capturesCap;
  const remaining = cap > 0 ? Math.max(0, cap - used) : null;
  const expiresAtMs = utcMs(session.expiresAt);
  const url = claimUrl(session);

  // at_cap outranks throttled: a throttle clears on its own, the cap does not.
  let state: MetaEnvelope['state'] = 'ok';
  if (cap > 0 && used >= cap) state = 'at_cap';
  else if (overrides.throttled) state = 'throttled';
  else if (cap > 0 && used >= cap * NEARING_CAP_RATIO) state = 'nearing_cap';
  else if (expiresAtMs - Date.now() < NEARING_EXPIRY_MS) state = 'nearing_expiry';

  let upsell: MetaEnvelope['upsell'] = null;
  if (state === 'at_cap') {
    upsell = {
      message:
        `This anonymous session is at its capture cap (${used} of ${cap}). ` +
        `New webhooks are rejected until it is claimed. Claiming is free and keeps every capture.`,
      url,
    };
  } else if (state === 'nearing_cap') {
    upsell = {
      message:
        `You've used ${used} of ${cap} captures on this anonymous session. ` +
        `Sign up (free) to keep them - they'll be re-encrypted into your account - and remove the cap.`,
      url,
    };
  } else if (state === 'nearing_expiry') {
    upsell = {
      message:
        `This anonymous session expires soon and won't persist. ` +
        `Claim it free to keep your captures and turn on encryption.`,
      url,
    };
  }

  const actions: MetaAction[] = [
    {
      kind: 'claim_session',
      label: 'Claim this session',
      url,
      cost: 'free',
      effect:
        `Keeps ${used > 0 ? `all ${used} capture${used === 1 ? '' : 's'}` : 'everything captured so far'}, ` +
        'removes the anonymous cap, turns on encryption, and starts the free tier ' +
        '(get_upgrade_options has current tier limits).',
      recommended: state === 'at_cap' || state === 'nearing_cap' || state === 'nearing_expiry',
    },
  ];

  return {
    mode: 'anonymous',
    capturesUsed: used,
    capturesCap: cap,
    capturesRemaining: remaining,
    expiresAt: toUtcIso(session.expiresAt),
    expiresInMinutes: minutesUntil(session.expiresAt),
    state,
    retryAfterSeconds: overrides.throttled ? (overrides.retryAfterSeconds ?? 30) : null,
    burst: overrides.burst ?? null,
    actions,
    deadlines: [
      {
        kind: 'session_expiry',
        at: toUtcIso(session.expiresAt),
        inMinutes: minutesUntil(session.expiresAt),
        affects:
          used > 0 ? `this session's ${used} captured webhook${used === 1 ? '' : 's'}` : 'this capture URL',
        message:
          'Everything on this anonymous session is deleted at this time unless it is claimed into a free account first.',
        url,
      },
    ],
    upsell,
    // One-time milestones outrank the staleness nudge; the nudge re-fires on every
    // other response while the server keeps answering with the notice header.
    notice: takeNotice(session, used, cap) ?? takeCliUpdateNotice(),
  };
}

/** Convert the server's ping burst fields into the meta burst block. */
export function burstFromPing(pong: {
  BurstLimit?: number;
  BurstUsed?: number;
  BurstResetsInSeconds?: number;
}): MetaBurst | null {
  if (pong.BurstLimit == null || pong.BurstUsed == null || pong.BurstResetsInSeconds == null) return null;
  return {
    limit: pong.BurstLimit,
    used: pong.BurstUsed,
    remaining: Math.max(0, pong.BurstLimit - pong.BurstUsed),
    resetsAt: new Date(Date.now() + pong.BurstResetsInSeconds * 1000).toISOString(),
    resetsInSeconds: pong.BurstResetsInSeconds,
  };
}

/**
 * One resolution path out of a plan-limit refusal (lesson 49: limit errors enumerate
 * the option space). False options ship on purpose with freesSlot:false — preempting
 * the wrong guess (e.g. "suspend an endpoint to free a target slot") is the point.
 */
export interface LimitOption {
  /** Stable machine kind, e.g. upgrade_plan, delete_replay_target, new_endpoint. */
  kind: string;
  /** Who can perform it: 'agent' = a tool on this server; 'human' = workspace-only. */
  actor: 'agent' | 'human';
  /** The MCP tool that performs it (actor 'agent' only). */
  tool?: string;
  /** Where the human does it (actor 'human' only). */
  url?: string;
  /** What doing it changes, including when it does NOT help. */
  effect: string;
  /** Whether this action frees a slot counted by THIS limit. */
  freesSlot?: boolean;
  cost?: 'free' | 'paid';
}

/** §12.7 error shape — structured result the model can reason over, not a bare failure. */
export interface McpErrorPayload {
  error: {
    code: string;
    message: string;
    retryAfterSeconds?: number;
    hint?: string;
    /** Plan-limit refusals: every way out, agent-performable or human-only (lesson 49). */
    options?: LimitOption[];
    /** Quota snapshot as "used/max" strings, e.g. { targetsThisProject: "3/3" }. */
    headroom?: Record<string, string>;
    /** The rows currently filling the exhausted slots (target limits only). */
    occupants?: Array<Record<string, unknown>>;
    /** #353: the exact page a person opens to finish what no tool can. */
    humanAction?: { label: string; url: string; targetId: string };
  };
  meta: MetaEnvelope;
}
