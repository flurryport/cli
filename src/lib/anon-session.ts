import { homedir } from 'os';
import { join } from 'path';
import type { AnonApiClient } from './anon-api.js';
import { deleteStoreFile, readJsonStore, writeJsonStore } from './store.js';
import { utcMs } from './time.js';

/**
 * Anonymous-session persistence (MCP spec §9 #9 — resume across restarts). The token
 * lives in its own file, NOT config.json: it's ephemeral by design (sessions cap at
 * 24h) and must never migrate into the account/PAT structure. A client/editor crash
 * shouldn't cost the user their session; resume-vs-new makes no abuse difference
 * because the session caps are server-side either way.
 */
export interface StoredAnonSession {
  token: string;
  sessionSlug: string;
  endpointSlug: string;
  /** ISO-8601 — refreshed from every server response that carries an expiry. */
  expiresAt: string;
  captureCount: number;
  capturesCap: number;
  /** The base URL this session was minted on; a different target invalidates resume. */
  anonBaseUrl: string;
  createdAt: string;
  /** Milestone-notice codes already fired for this session (one-time notices, spec 0.2.2). */
  notifiedMilestones?: string[];
}

const SESSION_DIR = join(homedir(), '.flurryport');
const SESSION_FILE = join(SESSION_DIR, 'anon-session.json');

export function loadStoredSession(): StoredAnonSession | null {
  // A locked/unreadable file degrades to no-session (a fresh mint) - the anon
  // session is a resume convenience, not a secret store worth crashing over.
  const parsed = readJsonStore<StoredAnonSession>(SESSION_FILE, { lenient: true });
  if (!parsed?.token || !parsed?.endpointSlug || !parsed?.expiresAt) return null;
  return parsed;
}

// The token is a capability: the shared store writes it 0600 and atomically.
export function saveStoredSession(session: StoredAnonSession): void {
  writeJsonStore(SESSION_FILE, session);
}

export function clearStoredSession(): void {
  deleteStoreFile(SESSION_FILE);
}

/** Funnel-attribution marker posted once per minted session (spec §9 #10). */
export const MCP_LANDING_URL = 'mcp://cli';

/** True when a stored session can be resumed against this client (60s safety margin). */
export function hasLiveStoredSession(client: AnonApiClient): boolean {
  const stored = loadStoredSession();
  return !!stored
    && stored.anonBaseUrl === client.baseUrl
    && utcMs(stored.expiresAt) > Date.now() + 60_000;
}

/**
 * Resume the stored session when it is still live on the same base URL; otherwise
 * mint a fresh one (and post the MCP attribution marker). A 60s safety margin avoids
 * handing the model a session that expires mid-turn. `ref` (invite/registry
 * attribution) applies ONLY when a new session is minted — resume never re-attributes.
 */
export async function ensureSession(client: AnonApiClient, ref?: string): Promise<StoredAnonSession> {
  const stored = loadStoredSession();
  if (
    stored &&
    stored.anonBaseUrl === client.baseUrl &&
    utcMs(stored.expiresAt) > Date.now() + 60_000
  ) {
    return stored;
  }

  const created = await client.createSession(ref);
  const session: StoredAnonSession = {
    token: created.Token,
    sessionSlug: created.SessionSlug,
    endpointSlug: created.EndpointSlug,
    expiresAt: created.ExpiresAt,
    captureCount: created.CaptureCount,
    capturesCap: created.CapturesCap,
    anonBaseUrl: client.baseUrl,
    createdAt: new Date().toISOString(),
  };
  saveStoredSession(session);
  await client.recordTelemetry(session.token, MCP_LANDING_URL);
  return session;
}

/** Compose the URL webhook providers post to. */
export function captureUrl(session: StoredAnonSession): string {
  return `${session.anonBaseUrl}/api/v1/anon/${session.token}/${session.endpointSlug}`;
}

/**
 * Compose the human "watch it live" browser viewer URL. The viewer route's slug is the
 * ENDPOINT slug, not the session slug — Anon.Web passes it straight into the captures
 * poll (`/{token}/{endpointSlug}/captures`), matching how the /try landing routes.
 *
 * In prod the viewer SPA and the anon API share a host (nginx on flurryport.dev), so
 * the API base doubles as the viewer base. Local dev splits them (API 8083, Vite SPA
 * 5174) — FLURRYPORT_VIEWER_URL overrides the base so the emitted link actually opens.
 */
export function viewerUrl(session: StoredAnonSession): string {
  const base = (process.env.FLURRYPORT_VIEWER_URL ?? session.anonBaseUrl).replace(/\/$/, '');
  return `${base}/v/${session.token}/${session.endpointSlug}`;
}
