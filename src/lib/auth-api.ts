import { guidToBase62 } from './base62.js';
import { appendFieldErrors } from './anon-api.js';
import { recordCliNotice, versionHeader } from './version-nudge.js';

/**
 * Authenticated client for the MCP server's Tier-1 reads (spec §5 / §12.4).
 * Differs from lib/api.ts in two load-bearing ways: it NEVER calls process.exit
 * (a 401/403/429 is a structured tool result in a long-lived server, not a fatal
 * CLI error), and it converts response GUIDs to base62 at the boundary so the
 * model only ever sees the same opaque ids it must pass back in URLs.
 */

export class AuthApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail: string,
  ) {
    super(detail || `HTTP ${status}`);
    this.name = 'AuthApiError';
  }
}

/** PascalCase mirrors the server DTOs (Core.Web/src/generated). Ids are raw GUIDs. */
interface GetProjectsResponse {
  Projects: { Id: string; Name: string; Slug: string; Suspended: boolean; CreatedAt: string }[];
}

interface EndpointItem {
  Id: string;
  ProjectId: string;
  Name: string;
  Slug: string;
  Suspended?: boolean;
  CreatedAt: string;
  [key: string]: unknown;
}

interface GetCapturedRequestsResponse {
  CapturedRequests?: unknown;
  Items?: unknown;
  [key: string]: unknown;
}

export interface CapturedRequestDetail {
  Id: string;
  EndpointId: string;
  HttpMethod: string;
  Headers: string;
  QueryString?: string | null;
  /** Base64 of the decrypted raw bytes. */
  BodyBytes: string;
  ContentType?: string | null;
  ContentLength?: number | null;
  CreatedAt: string;
  ProviderHint?: string | null;
  ProviderEventType?: string | null;
  RejectionReason?: string | null;
  [key: string]: unknown;
}

export interface ProjectPlanInfo {
  PlanTierId: number;
  MaxMonthlyCaptures: number;
  CurrentMonthCaptures: number;
  RetentionDays: number;
  MaxEndpoints: number;
  MaxReplayTargets: number;
  MaxAutoReplayTargets: number;
  MaxLocalAutoReplayTargets: number;
  MaxProjects: number;
  /** #377: the payload cap Core actually enforces; the owner post budget reports min(budget, this). */
  MaxPayloadBytes?: number;
  Suspended: boolean;
  [key: string]: unknown;
}

export interface AuthApiClient {
  readonly baseUrl: string;
  /** opts.signal aborts an in-flight request (the console's long-poll drain, #253). */
  get(path: string, opts?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  put(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  delete(path: string): Promise<Record<string, unknown>>;
  /**
   * Which stored credential a request to this path answers as: a scoped account name
   * from the credential router, or null for the default (signed-in) credential.
   * Read tools stamp this on responses so an EMPTY answer is always attributable
   * (pilot-1 ledger item 7: an empty room must say whose empty room it is).
   */
  credentialFor?(path: string): string | null;
}

/** FLURRYPORT_API_URL wins over the config's apiUrl — lets a prod-configured account be pointed at a local stack for testing. */
export function resolveAuthBaseUrl(configUrl?: string): string {
  return (process.env.FLURRYPORT_API_URL ?? configUrl ?? 'https://api.flurryport.io').replace(/\/$/, '');
}

export function createAuthApiClient(
  baseUrl: string,
  token: string,
  opts: {
    /**
     * false = never write the module-global CLI-notice latch (version-nudge). The
     * latch is per-operator machine state; the seat server is multi-principal (one
     * process, many sessions), so seat clients must not touch it. Default true.
     */
    trackCliNotices?: boolean;
  } = {},
): AuthApiClient {
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}`, ...versionHeader() };
  const trackNotices = opts.trackCliNotices !== false;

  async function handle(res: Response): Promise<Record<string, unknown>> {
    // Latch the server's version-staleness notice (if any) for the meta builders.
    if (trackNotices) recordCliNotice(res);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let code =
        res.status === 401 ? 'unauthorized'
        : res.status === 403 ? 'forbidden'
        : res.status === 404 ? 'not_found'
        : res.status === 429 ? 'throttled'
        : 'error';
      let detail = text;
      try {
        const raw = JSON.parse(text) as Record<string, unknown>;
        detail = (raw.detail as string) ?? (raw.Error as string) ?? (raw.title as string) ?? text;
        detail = appendFieldErrors(detail, raw.errors);
        // TypedApplicationResult problems carry the machine error code in "type"/"title"
        // (e.g. binding_limit_exceeded) — surface it so tools can key recovery hints
        // off the code instead of matching message prose. Mirrors anon-api's parse.
        if (typeof raw.type === 'string' && !raw.type.startsWith('http')) code = raw.type;
        else if (typeof raw.title === 'string' && /^[a-z_]+$/.test(raw.title)) code = raw.title;
      } catch {
        /* not JSON */
      }
      throw new AuthApiError(res.status, code, detail);
    }
    return res.json() as Promise<Record<string, unknown>>;
  }

  return {
    baseUrl,
    async get(path: string, getOpts?: { signal?: AbortSignal }) {
      return handle(await fetch(`${baseUrl}${path}`, { headers, signal: getOpts?.signal }));
    },
    async post(path: string, body: Record<string, unknown>) {
      return handle(
        await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    },
    async put(path: string, body: Record<string, unknown>) {
      return handle(
        await fetch(`${baseUrl}${path}`, {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    },
    async delete(path: string) {
      const res = await fetch(`${baseUrl}${path}`, { method: 'DELETE', headers });
      // Deletes may answer 204/empty — treat no body as an empty receipt, not a parse error.
      if (res.ok && (res.status === 204 || res.headers.get('content-length') === '0')) {
        if (trackNotices) recordCliNotice(res);
        return {};
      }
      return handle(res);
    },
  };
}

/** Convert any string that looks like a GUID to base62; pass everything else through. */
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export function toOpaqueId(value: unknown): unknown {
  return typeof value === 'string' && GUID_RE.test(value) ? guidToBase62(value) : value;
}

/**
 * Deep-map a response object, converting every GUID-shaped string field named like an
 * id (Id, *Id) to base62 so the model's view matches the URL ids it passes back.
 */
export function opaqueIds<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => opaqueIds(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === 'Id' || k.endsWith('Id') ? toOpaqueId(v) : opaqueIds(v);
    }
    return out as unknown as T;
  }
  return value;
}

export type { GetProjectsResponse, EndpointItem, GetCapturedRequestsResponse };
