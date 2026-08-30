import { createHash, createHmac, randomBytes } from 'node:crypto';
import { toUtcIso } from './time.js';

/**
 * The pairing-code ceremony, joining half (0.5.0 slice A + B, #233). The inviting
 * host mints a short single-use code; the HUMAN ferries it between conversations -
 * the human is the trusted channel. The joining side proves POSSESSION via
 * HMAC-SHA256(key = SHA-256(code), message = handle.nonce.timestamp) so the raw code
 * never rides the wire. This module mirrors the server's SeatPairingCode contract
 * EXACTLY (Core.Logic/Features/Seats/SeatPairingCode.cs) - the proof-vector test in
 * tests/seat-server.test.mjs guards the byte-for-byte agreement.
 */

/** No 0/O/1/I/L - three groups of four, dash-joined, e.g. 7WHM-KR4P-XT2B. */
export const PAIRING_CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}(-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}){2}$/;

/** Humans paste codes with stray whitespace and lowercase; the ceremony forgives both. */
export function canonicalizeCode(rawCode: string): string {
  return rawCode.trim().toUpperCase();
}

/** The cleartext lookup handle: the first group of the canonicalized code. */
export function codeHandle(rawCode: string): string {
  return canonicalizeCode(rawCode).split('-')[0] ?? '';
}

/**
 * The proof the joining side sends: lowercase hex HMAC-SHA256 over
 * `${handle}.${nonce}.${timestamp}`, keyed by SHA-256 of the canonicalized full code.
 */
export function computeSeatProof(code: string, handle: string, nonce: string, timestamp: string): string {
  const key = createHash('sha256').update(Buffer.from(canonicalizeCode(code), 'utf8')).digest();
  return createHmac('sha256', key)
    .update(Buffer.from(`${handle}.${nonce}.${timestamp}`, 'utf8'))
    .digest('hex');
}

/** Typed redemption failure carrying the server's machine code (§12.7 discipline). */
export class SeatRedeemError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail: string,
  ) {
    super(detail || `HTTP ${status}`);
    this.name = 'SeatRedeemError';
  }
}

/**
 * The redemption release, camelCased for in-process use. Token and signingKey are
 * CREDENTIALS: they live in the seat server's session memory and must never appear
 * in any tool result or log line.
 */
export interface SeatRelease {
  token: string;
  signingKey: string;
  signingScheme: string;
  signingHeader: string | null;
  endpointId: string;
  projectId: string;
  endpointSlug: string;
  participantName: string;
  seatRef: string;
  expiresAt: string;
  /**
   * The server-issued feed boundary at the moment of seating (#274). Three states,
   * kept distinct on purpose: a string cursor (pass as `after`, catch-up starts at
   * join), null (the server says the room had no history), undefined (an older
   * server whose redemption response predates the field - the receipt must OMIT
   * the member, never fake a null).
   */
  joinedAtCursor: string | null | undefined;
}

interface RedeemSeatWire {
  Token: string;
  SigningKey: string;
  SigningScheme: string;
  SigningHeader?: string | null;
  EndpointId: string;
  ProjectId: string;
  EndpointSlug: string;
  ParticipantName: string;
  SeatRef: string;
  ExpiresAt: string;
  JoinedAtCursor?: string | null;
}

async function attemptRedeem(apiBase: string, code: string): Promise<SeatRelease> {
  const canonical = canonicalizeCode(code);
  const handle = codeHandle(canonical);
  const nonce = randomBytes(16).toString('base64url');
  const timestamp = new Date().toISOString();
  const proof = computeSeatProof(canonical, handle, nonce, timestamp);

  const res = await fetch(`${apiBase}/api/v1/invites/seats/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ CodeHandle: handle, Nonce: nonce, Timestamp: timestamp, Proof: proof }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Machine code out of ProblemDetails, the auth-api parse: "type" (non-http) wins,
    // then a code-shaped "title"; otherwise the status maps to a generic code.
    let redemptionCode =
      res.status === 404 ? 'not_found'
      : res.status === 429 ? 'throttled'
      : res.status === 409 ? 'conflict'
      : 'error';
    let detail = text;
    try {
      const raw = JSON.parse(text) as Record<string, unknown>;
      detail = (raw.detail as string) ?? (raw.Error as string) ?? (raw.title as string) ?? text;
      if (typeof raw.type === 'string' && !raw.type.startsWith('http')) redemptionCode = raw.type;
      else if (typeof raw.title === 'string' && /^[a-z_]+$/.test(raw.title)) redemptionCode = raw.title;
    } catch {
      /* not JSON */
    }
    throw new SeatRedeemError(res.status, redemptionCode, detail);
  }

  const wire = (await res.json()) as RedeemSeatWire;
  return {
    token: wire.Token,
    signingKey: wire.SigningKey,
    signingScheme: wire.SigningScheme,
    signingHeader: wire.SigningHeader ?? null,
    endpointId: wire.EndpointId,
    projectId: wire.ProjectId,
    endpointSlug: wire.EndpointSlug,
    participantName: wire.ParticipantName,
    seatRef: wire.SeatRef,
    expiresAt: toUtcIso(wire.ExpiresAt),
    joinedAtCursor: 'JoinedAtCursor' in wire ? (wire.JoinedAtCursor ?? null) : undefined,
  };
}

/**
 * Redeem a pairing code: one round trip, fresh client nonce + timestamp per attempt.
 * Exactly ONE automatic retry, and only on proof_stale (a valid proof outside the
 * clock-skew window - recomputing with a fresh timestamp is the server's own advice).
 * Every other failure surfaces as a typed SeatRedeemError for the tool to map.
 */
export async function redeemSeatCode(apiBase: string, code: string): Promise<SeatRelease> {
  try {
    return await attemptRedeem(apiBase, code);
  } catch (err) {
    if (err instanceof SeatRedeemError && err.code === 'proof_stale') {
      return attemptRedeem(apiBase, code);
    }
    throw err;
  }
}

/**
 * A standing exchange's release (#409 mechanism A): the SeatRelease shape plus the
 * agent-held durable EXCHANGE key and the byline's resume cursor. standingKey is the
 * ONE credential that may reach the agent's conversation - it proves the next
 * re-attach and rotates on every exchange; token and signingKey keep unchanged seat
 * custody (session memory only). Custody (#427): 'unattended' carries a standingKey;
 * 'checked-in' carries NULL - the steward's login-and-approve is the re-entry and
 * the agent holds nothing.
 */
export interface StandingRelease extends SeatRelease {
  standingKey: string | null;
  custody: 'checked-in' | 'unattended';
  resumeCursor: string | null;
}

interface ExchangeStandingWire extends RedeemSeatWire {
  StandingKey: string | null;
  Custody?: string;
  ResumeCursor?: string | null;
}

/**
 * The standing re-attach exchange: one anonymous round trip, exactly like
 * redemption - possession of the credential (the current standing key, or the live
 * seat token for the FIRST collection) is the proof; every dead state answers 404;
 * each exchange rotates both the working token and the standing key.
 */
export async function exchangeStandingSession(apiBase: string, credential: string): Promise<StandingRelease> {
  const res = await fetch(`${apiBase}/api/v1/invites/seats/standing/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ Credential: credential }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let code =
      res.status === 404 ? 'not_found'
      : res.status === 429 ? 'throttled'
      : 'error';
    let detail = text;
    try {
      const raw = JSON.parse(text) as Record<string, unknown>;
      detail = (raw.detail as string) ?? (raw.title as string) ?? text;
      if (typeof raw.type === 'string' && !raw.type.startsWith('http')) code = raw.type;
      else if (typeof raw.title === 'string' && /^[a-z_]+$/.test(raw.title)) code = raw.title;
    } catch {
      /* not JSON */
    }
    throw new SeatRedeemError(res.status, code, detail);
  }

  const wire = (await res.json()) as ExchangeStandingWire;
  return {
    token: wire.Token,
    signingKey: wire.SigningKey,
    signingScheme: wire.SigningScheme,
    signingHeader: wire.SigningHeader ?? null,
    endpointId: wire.EndpointId,
    projectId: wire.ProjectId,
    endpointSlug: wire.EndpointSlug,
    participantName: wire.ParticipantName,
    seatRef: wire.SeatRef,
    expiresAt: toUtcIso(wire.ExpiresAt),
    joinedAtCursor: 'JoinedAtCursor' in wire ? (wire.JoinedAtCursor ?? null) : undefined,
    standingKey: wire.StandingKey ?? null,
    custody: wire.Custody === 'checked-in' ? 'checked-in' : 'unattended',
    resumeCursor: wire.ResumeCursor ?? null,
  };
}

interface StandingReleaseStartWire {
  ApprovalUrl: string;
  ExpiresAt: string;
  PollIntervalSeconds: number;
}

/**
 * #427 checked-in re-attach, the arm half: a fresh session (nothing durable in hand -
 * checked-in custody's point) names its room + handle and two locally generated
 * codes; the server arms only for a standing-live checked-in account-bound identity
 * and answers with the approval URL the agent relays to its steward.
 */
export async function startStandingRelease(
  apiBase: string,
  endpointId: string,
  handle: string,
  deviceCode: string,
  approvalCode: string,
): Promise<{ approvalUrl: string; expiresAt: string; pollIntervalSeconds: number }> {
  const res = await fetch(`${apiBase}/api/v1/anon/device/standing-release/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ EndpointId: endpointId, Handle: handle, DeviceCode: deviceCode, ApprovalCode: approvalCode }),
  });
  if (!res.ok) {
    const code = res.status === 404 ? 'not_found' : res.status === 429 ? 'throttled' : 'error';
    throw new SeatRedeemError(res.status, code, await res.text().catch(() => ''));
  }
  const wire = (await res.json()) as StandingReleaseStartWire;
  return {
    approvalUrl: wire.ApprovalUrl,
    expiresAt: toUtcIso(wire.ExpiresAt),
    pollIntervalSeconds: wire.PollIntervalSeconds,
  };
}

interface StandingReleasePollWire {
  Status: string;
  Token?: string | null;
  SigningKey?: string | null;
  SigningScheme?: string | null;
  SigningHeader?: string | null;
  ContributorEndpointId?: string | null;
  ContributorProjectId?: string | null;
  ParticipantName?: string | null;
  EndpointSlug?: string | null;
  SeatRef?: string | null;
  StandingExpiresAt?: string | null;
  JoinedAtCursor?: string | null;
  ResumeCursor?: string | null;
  Custody?: string | null;
}

/**
 * #427 checked-in re-attach, the collect half: the SESSION polls with its device code
 * (the shared kind-dispatched poll route). Pending until the bound steward's
 * login-and-approve; Complete hands the full seat release into this process's memory
 * - no credential of any kind reaches the agent's conversation.
 */
export async function pollStandingRelease(
  apiBase: string,
  deviceCode: string,
): Promise<{ status: 'pending' } | { status: 'complete'; release: StandingRelease }> {
  const res = await fetch(`${apiBase}/api/v1/anon/device/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ DeviceCode: deviceCode }),
  });
  if (!res.ok) {
    const code = res.status === 404 ? 'not_found' : res.status === 429 ? 'throttled' : 'error';
    throw new SeatRedeemError(res.status, code, await res.text().catch(() => ''));
  }
  const wire = (await res.json()) as StandingReleasePollWire;
  if (wire.Status !== 'complete') return { status: 'pending' };
  return {
    status: 'complete',
    release: {
      token: wire.Token ?? '',
      signingKey: wire.SigningKey ?? '',
      signingScheme: wire.SigningScheme ?? 'simple',
      signingHeader: wire.SigningHeader ?? null,
      endpointId: wire.ContributorEndpointId ?? '',
      projectId: wire.ContributorProjectId ?? '',
      endpointSlug: wire.EndpointSlug ?? '',
      participantName: wire.ParticipantName ?? 'seat',
      seatRef: wire.SeatRef ?? '',
      expiresAt: toUtcIso(wire.StandingExpiresAt ?? new Date().toISOString()),
      joinedAtCursor: wire.JoinedAtCursor ?? null,
      standingKey: null,
      custody: 'checked-in',
      resumeCursor: wire.ResumeCursor ?? null,
    },
  };
}
