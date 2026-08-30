/**
 * Client for the anonymous capture island (`/api/v1/anon/*` on flurryport.dev).
 * No auth header — the session token rides the path and IS the capability.
 * Unlike lib/api.ts this never calls process.exit: it serves the long-lived MCP
 * server, where a 404/429 is a structured tool result, not a fatal CLI error.
 */

import { recordCliNotice, versionHeader } from './version-nudge.js';

export const DEFAULT_ANON_URL = 'https://flurryport.dev';

/** Env override for self-hosted / local dev (e.g. http://localhost:8083). */
export function resolveAnonBaseUrl(override?: string): string {
  return (override ?? process.env.FLURRYPORT_ANON_URL ?? DEFAULT_ANON_URL).replace(/\/$/, '');
}

export class AnonApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail: string,
  ) {
    super(detail || `HTTP ${status}`);
    this.name = 'AnonApiError';
  }
}

// PascalCase mirrors the server DTOs (see Users/Anon.Web/src/generated/anonymous/dtos).
export interface GenerateAnonEndpointResponse {
  Token: string;
  SessionSlug: string;
  EndpointSlug: string;
  ExpiresAt: string;
  CaptureCount: number;
  CapturesCap: number;
  /** Echo of the accepted attribution ref (absent/null = organic). */
  Ref?: string | null;
}

export interface GetAnonCapturesItem {
  Id: string;
  HttpMethod: string;
  ProviderHint?: string | null;
  ProviderEventType?: string | null;
  BodySize: number;
  ContentType?: string | null;
  RejectionReason?: string | null;
  CreatedAt: string;
}

export interface GetAnonCapturesResponse {
  Captures: GetAnonCapturesItem[];
  ExpiresAt: string;
  CaptureCount: number;
  CapturesCap: number;
}

export interface AnonDigestGroup {
  Key: string;
  Count: number;
  LastAt: string;
}

export interface AnonDigestBucket {
  BucketStartUtc: string;
  Count: number;
}

export interface GetAnonCaptureDigestResponse {
  TotalCount: number;
  RejectedCount: number;
  ByEventType: AnonDigestGroup[];
  ByProvider: AnonDigestGroup[];
  ByHour: AnonDigestBucket[];
  ExpiresAt: string;
  CaptureCount: number;
  CapturesCap: number;
}

export interface GetAnonCaptureResponse {
  Id: string;
  HttpMethod: string;
  /** JSON-serialized Record<string, string[]>. */
  Headers: string;
  QueryString?: string | null;
  /** Base64 of the raw captured bytes. */
  Body: string;
  ContentType?: string | null;
  ContentLength?: number | null;
  ProviderHint?: string | null;
  ProviderEventType?: string | null;
  RejectionReason?: string | null;
  CreatedAt: string;
}

export interface RegisterAnonWatchResponse {
  Id: string;
  Name: string;
  Predicate: string;
  Label?: string | null;
  WatchCount: number;
  WatchesCap: number;
}

export interface GetAnonWatchesItem {
  Id: string;
  Name: string;
  Predicate: string;
  Label?: string | null;
  CreatedAt: string;
}

export interface GetAnonWatchesResponse {
  Watches: GetAnonWatchesItem[];
  WatchesCap: number;
}

export interface PingAnonSessionResponse {
  ExpiresAt: string;
  CaptureCount: number;
  CapturesCap: number;
  // Burst window + rejection accounting (server 0.2.2+; optional so an older server
  // keeps working — the CLI degrades to burst:null and omits the counts).
  BurstLimit?: number;
  BurstUsed?: number;
  BurstResetsInSeconds?: number;
  RejectedCount?: number;
  LatestCaptureAt?: string | null;
  LatestRejectedAt?: string | null;
}

export interface RegisterDeviceHandoffResponse {
  ExpiresAt: string;
}

/** #388 device login: the register half's receipt. */
export interface RegisterDeviceLoginResponse {
  ExpiresAt: string;
  PollIntervalSeconds: number;
}

export interface PollDeviceHandoffResponse {
  /** 'skipped' is WriteUpgrade hand-offs only: the owner explicitly kept read-only. */
  Status: 'pending' | 'complete' | 'skipped';
  Token?: string | null;
  // Migration breadcrumb (server 0.2.3+): where the claimed captures live now. Optional
  // so older servers keep working; the CLI just skips the orientation notice without it.
  MigratedProjectId?: string | null;
  MigratedEndpointId?: string | null;
  MigratedEndpointSlug?: string | null;
  MigratedCaptureCount?: number | null;
  // Login hand-offs only (#388): which scope the human granted on the consent screen.
  GrantedScope?: string | null;
  // ContributorKey hand-offs only (invite rail, producer role — server Phase 3+): the
  // per-contributor signing key revealed ONCE alongside the scoped read PAT (Token).
  // Scheme/Header tell the CLI how to sign; ContributorEndpointId is the keystore path.
  // Absent on every other Kind and on older servers (monitor joins simply ignore them).
  SigningKey?: string | null;
  SigningScheme?: string | null;
  SigningHeader?: string | null;
  ContributorEndpointId?: string | null;
  ContributorProjectId?: string | null;
  // Invite lanes (server 0.3.0+): the invite's guest name — who this participant IS on
  // the stream. The CLI parks the grant under this account name; absent on older
  // servers and unnamed invites (falls back to 'guest').
  ParticipantName?: string | null;
}

export interface RequestAnonSecretSetupResponse {
  Code: string;
  Explanation: string;
  UserPrompt: string;
  ConsentInstruction: string;
  EscapeHatch: string;
  EntryPath: string;
  SecretNames: string[];
  RecipeRef: string | null;
  FreeSecretLimit: number;
  LimitWarning: string | null;
}

export interface CreateAnonInviteResponse {
  /** Raw fpi_ token — shown ONCE here; only its hash exists server-side. */
  InviteToken: string;
  TokenPrefix: string;
  /** inv_ attribution ref — the durable handle for revoke + funnel queries. */
  Ref: string;
  Role: string;
  ExpiresAt: string;
  /** Relative landing path; compose the absolute URL from the session's base. */
  LandingPath: string;
  InviteCount: number;
  InvitesCap: number;
}

export interface AnonApiClient {
  /** `ref` overrides the client-level attribution ref for THIS mint (runtime ref attach). */
  createSession(ref?: string): Promise<GenerateAnonEndpointResponse>;
  listCaptures(token: string, endpointSlug: string, take: number): Promise<GetAnonCapturesResponse>;
  getDigest(token: string, endpointSlug: string): Promise<GetAnonCaptureDigestResponse>;
  registerWatch(
    token: string,
    endpointSlug: string,
    name: string,
    predicate: string,
    label?: string | null,
  ): Promise<RegisterAnonWatchResponse>;
  listWatches(token: string, endpointSlug: string): Promise<GetAnonWatchesResponse>;
  getCapture(token: string, endpointSlug: string, captureId: string): Promise<GetAnonCaptureResponse>;
  ping(token: string): Promise<PingAnonSessionResponse>;
  /** Best-effort funnel attribution — never throws. */
  recordTelemetry(token: string, landingUrl: string): Promise<void>;
  /** Flow 2 consent gate: declares needed secret NAMES; returns platform-owned copy + entry path. */
  requestSecretSetup(token: string, secretNames: string[], recipeRef?: string | null): Promise<RequestAnonSecretSetupResponse>;
  /** Invite rail: mint an anon-tier invite on this session (the token is the authority). */
  createInvite(token: string, role: string, displayName?: string | null, recipeRef?: string | null): Promise<CreateAnonInviteResponse>;
  /** Device-flow (spec §6): the anon token authorizes; the secret device code keys. */
  registerDeviceHandoff(token: string, deviceCode: string): Promise<RegisterDeviceHandoffResponse>;
  /** #388 device login for an existing account: no token exists yet, the two codes key everything. */
  registerDeviceLogin(deviceCode: string, approvalCode: string): Promise<RegisterDeviceLoginResponse>;
  pollDeviceHandoff(deviceCode: string): Promise<PollDeviceHandoffResponse>;
  readonly baseUrl: string;
}

/**
 * Fold a ValidationProblem `errors` dict ({ Field: ["msg", ...] }) into the detail
 * string so validation failures TEACH the expected shape instead of answering
 * "Validation error" (agents self-correct from field messages; they cannot from a
 * label). Shared by the anon and authed clients.
 */
export function appendFieldErrors(detail: string, errors: unknown): string {
  if (!errors || typeof errors !== 'object') return detail;
  const parts: string[] = [];
  for (const [field, messages] of Object.entries(errors as Record<string, unknown>)) {
    const list = Array.isArray(messages) ? messages.filter((m) => typeof m === 'string') : [];
    if (list.length) parts.push(`${field}: ${list.join(' ')}`);
  }
  return parts.length ? `${detail} ${parts.join(' | ')}`.trim() : detail;
}

async function parse<T>(res: Response): Promise<T> {
  // Latch the server's version-staleness notice (if any) for the meta builders.
  recordCliNotice(res);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let code = res.status === 404 ? 'not_found' : res.status === 429 ? 'throttled' : 'error';
    let detail = text;
    try {
      const raw = JSON.parse(text) as Record<string, unknown>;
      // TypedApplicationResult problems carry the error code in "type"/"title"; ProblemDetails uses "detail".
      detail = (raw.detail as string) ?? (raw.title as string) ?? text;
      // ValidationProblem bodies carry the actual field errors in `errors` — without
      // them the agent sees a bare "Validation error" and cannot self-correct
      // (Codex run 6: two blind retries, then it improvised off-funnel).
      detail = appendFieldErrors(detail, raw.errors);
      if (typeof raw.type === 'string' && !raw.type.startsWith('http')) code = raw.type;
      else if (typeof raw.title === 'string' && /^[a-z_]+$/.test(raw.title)) code = raw.title;
    } catch {
      /* not JSON */
    }
    throw new AnonApiError(res.status, code, detail);
  }
  return res.json() as Promise<T>;
}

export function createAnonApiClient(baseUrlOverride?: string, attributionRef?: string): AnonApiClient {
  const baseUrl = resolveAnonBaseUrl(baseUrlOverride);
  const anon = `${baseUrl}/api/v1/anon`;
  const mintUrl = attributionRef
    ? `${anon}/sessions?ref=${encodeURIComponent(attributionRef)}`
    : `${anon}/sessions`;
  const jsonHeaders = { Accept: 'application/json', 'Content-Type': 'application/json', ...versionHeader() };
  const getHeaders = { Accept: 'application/json', ...versionHeader() };

  return {
    baseUrl,

    async createSession(ref?: string) {
      const url = ref ? `${anon}/sessions?ref=${encodeURIComponent(ref)}` : mintUrl;
      const res = await fetch(url, { method: 'POST', headers: jsonHeaders });
      return parse<GenerateAnonEndpointResponse>(res);
    },

    async listCaptures(token, endpointSlug, take) {
      const res = await fetch(`${anon}/${token}/${endpointSlug}/captures?take=${take}`, {
        headers: getHeaders,
      });
      return parse<GetAnonCapturesResponse>(res);
    },

    async getCapture(token, endpointSlug, captureId) {
      const res = await fetch(`${anon}/${token}/${endpointSlug}/captures/${captureId}`, {
        headers: getHeaders,
      });
      return parse<GetAnonCaptureResponse>(res);
    },

    async getDigest(token, endpointSlug) {
      const res = await fetch(`${anon}/${token}/${endpointSlug}/captures/digest`, {
        headers: getHeaders,
      });
      return parse<GetAnonCaptureDigestResponse>(res);
    },

    async registerWatch(token, endpointSlug, name, predicate, label) {
      const res = await fetch(`${anon}/${token}/${endpointSlug}/watches`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ Name: name, Predicate: predicate, Label: label ?? null }),
      });
      return parse<RegisterAnonWatchResponse>(res);
    },

    async listWatches(token, endpointSlug) {
      const res = await fetch(`${anon}/${token}/${endpointSlug}/watches`, {
        headers: getHeaders,
      });
      return parse<GetAnonWatchesResponse>(res);
    },

    async ping(token) {
      const res = await fetch(`${anon}/${token}/ping`, { method: 'POST', headers: jsonHeaders });
      return parse<PingAnonSessionResponse>(res);
    },

    async recordTelemetry(token, landingUrl) {
      try {
        await fetch(`${anon}/${token}/telemetry`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ LandingUrl: landingUrl, Referrer: null }),
        });
      } catch {
        /* attribution is advisory */
      }
    },

    async requestSecretSetup(token, secretNames, recipeRef) {
      const res = await fetch(`${anon}/${token}/secret-setup-consent`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ SecretNames: secretNames, RecipeRef: recipeRef ?? null }),
      });
      return parse<RequestAnonSecretSetupResponse>(res);
    },

    async createInvite(token, role, displayName, recipeRef) {
      const res = await fetch(`${anon}/${token}/invites`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ Role: role, DisplayName: displayName ?? null, RecipeRef: recipeRef ?? null }),
      });
      return parse<CreateAnonInviteResponse>(res);
    },

    async registerDeviceHandoff(token, deviceCode) {
      const res = await fetch(`${anon}/device/start`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ Token: token, DeviceCode: deviceCode }),
      });
      return parse<RegisterDeviceHandoffResponse>(res);
    },

    async registerDeviceLogin(deviceCode, approvalCode) {
      const res = await fetch(`${anon}/device/login/start`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ DeviceCode: deviceCode, ApprovalCode: approvalCode }),
      });
      return parse<RegisterDeviceLoginResponse>(res);
    },

    async pollDeviceHandoff(deviceCode) {
      const res = await fetch(`${anon}/device/poll`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ DeviceCode: deviceCode }),
      });
      return parse<PollDeviceHandoffResponse>(res);
    },
  };
}
