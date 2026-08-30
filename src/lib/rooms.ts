/**
 * Hosted rooms (#346): the seat server runs as a FlurryPORT service behind the
 * API host, at {api base}/rooms/mcp (the ingress maps the /rooms prefix onto the
 * service, so /rooms/whoami is the same preflight the standalone server answers
 * at /whoami). A boarding pass therefore carries a reachable address by default
 * instead of the host laptop's loopback; dev, qa, and prod each point at
 * themselves because the address derives from the API base the CLI is already
 * talking to. Resolution order, most specific first:
 *
 *   1. an explicit seatServerUrl (a self-hosted `flurryport seat-server`, or the
 *      console's in-process room), which always wins;
 *   2. FLURRYPORT_ROOMS_URL, a full MCP url ending /mcp, for pointing a stack at
 *      a rooms service that is not beside its API;
 *   3. {api base}/rooms/mcp.
 */
export const ROOMS_MCP_PATH = '/rooms/mcp';

export function resolveRoomsUrl(apiBase: string, explicit?: string | null): string {
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const fromEnv = process.env.FLURRYPORT_ROOMS_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  return `${apiBase.replace(/\/$/, '')}${ROOMS_MCP_PATH}`;
}

/** The host the hosted rooms service presents on its captures in production (#358). */
export const DEFAULT_PUBLIC_API_HOST = 'api.flurryport.io';

/**
 * #358: the public API host the hosted rooms service names on every capture it
 * posts (X-Flurry-Public-Host beside the X-Flurry-Rooms marker). The service
 * reaches core-api over the cluster network, so without this Core would store
 * the cluster hostname and pod addresses where every seat can read them.
 * FLURRYPORT_PUBLIC_API_HOST per environment (dev-kraken-api, qa-barnacle-api,
 * api). ONLY the hosted service sets it: a self-hosted or console-hosted seat
 * server posts over the public API already and must not mark its posts, so with
 * nothing set this answers null and no marker is sent. A bare host, optionally
 * with a port; anything else (a scheme, a path, spaces) also answers null, and
 * the server says so at boot rather than presenting a host nobody configured.
 */
export function resolvePublicApiHost(explicit?: string | null): string | null {
  const candidate = (explicit ?? process.env.FLURRYPORT_PUBLIC_API_HOST ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9.-]*(:\d+)?$/.test(candidate) ? candidate : null;
}

/** Default idle life of a hosted seat session, minutes (#346). */
export const DEFAULT_ROOMS_IDLE_MINUTES = 30;

/**
 * Idle limit for the seat server: the explicit value (a --idle-minutes flag)
 * wins, then FLURRYPORT_ROOMS_IDLE_MINUTES, then the default. Anything that is
 * not a positive number falls through to the next source rather than disabling
 * eviction by accident.
 */
export function resolveRoomsIdleMinutes(explicit?: string | number | null): number {
  for (const candidate of [explicit, process.env.FLURRYPORT_ROOMS_IDLE_MINUTES]) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const minutes = typeof candidate === 'number' ? candidate : Number.parseFloat(candidate);
    if (Number.isFinite(minutes) && minutes > 0) return minutes;
  }
  return DEFAULT_ROOMS_IDLE_MINUTES;
}

/**
 * #409 slice 6 (Q5, gaveled): the idle window for STANDING sessions. Default NONE —
 * "the user should be able to come back every day for months"; the standing expiry
 * is the one reaper. FLURRYPORT_ROOMS_STANDING_IDLE_MINUTES lets ops bound it; a
 * non-positive or unparseable value keeps the no-reaping default.
 */
export function resolveRoomsStandingIdleMinutes(explicit?: string | number | null): number | null {
  for (const candidate of [explicit, process.env.FLURRYPORT_ROOMS_STANDING_IDLE_MINUTES]) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const minutes = typeof candidate === 'number' ? candidate : Number.parseFloat(candidate);
    if (Number.isFinite(minutes) && minutes > 0) return minutes;
  }
  return null;
}
