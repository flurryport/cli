import type { AuthApiClient } from './auth-api.js';

/**
 * Credential router (0.3.0, ratified 2026-07-28): one MCP session holds the operator's
 * credential AND every joined invite grant at once, routing each request by the opaque
 * ids in its path. Retires the account-switch dance: reads of a joined endpoint answer
 * as the guest credential, everything else answers as the default (operator) credential,
 * with nothing to switch and nothing lost on restart (scoped accounts persist in the CLI
 * config with their endpoint binding).
 *
 * Deterministic by construction — the path either names a scoped endpoint/project or it
 * does not. No 404-then-retry guessing, so a real not_found stays a real not_found.
 */

export interface ScopedCredential {
  /** Base62 endpoint id the credential is scoped to (from the release receipt). */
  endpointId?: string;
  /** Base62 project id of that endpoint — some read paths are project-keyed. */
  projectId?: string;
  /** CLI account name the grant is parked under (receipts name it). */
  accountName: string;
  client: AuthApiClient;
}

/**
 * Opaque ids as they appear in API paths. Width is deliberately loose — routing only
 * happens on EQUALITY with a stored scope id, so a wider capture can never misroute.
 */
const ENDPOINT_SEG = /\/endpoints\/([A-Za-z0-9]{1,32})(?=\/|$|\?)/;
const PROJECT_SEG = /\/projects\/([A-Za-z0-9]{1,32})(?=\/|$|\?)/;

/**
 * Pick the scoped credential a path belongs to, or null for the default credential.
 * Endpoint match outranks project match (an endpoint-keyed path is the sharper claim).
 */
export function matchScopedPath(path: string, table: ScopedCredential[]): ScopedCredential | null {
  const endpointId = ENDPOINT_SEG.exec(path)?.[1];
  if (endpointId) {
    const hit = table.find((c) => c.endpointId === endpointId);
    if (hit) return hit;
  }
  const projectId = PROJECT_SEG.exec(path)?.[1];
  if (projectId) {
    const hit = table.find((c) => c.projectId === projectId);
    if (hit) return hit;
  }
  return null;
}

/**
 * A stable AuthApiClient facade over (default credential, scoped table). The default is
 * read through a thunk so the claim flip / write upgrade / switchSession can swap it
 * without re-wiring tool handlers; the table can grow mid-session (a join registers its
 * grant immediately, so reads work with no restart and no switch).
 */
export function makeRoutingClient(
  getDefault: () => AuthApiClient,
  table: ScopedCredential[],
): AuthApiClient {
  const pick = (path: string): AuthApiClient => matchScopedPath(path, table)?.client ?? getDefault();
  return {
    get baseUrl() {
      return getDefault().baseUrl;
    },
    // opts carries the AbortSignal (#253 long-poll drain) - dropping it here left
    // hung fetches on session switch/shutdown (cleanup C9).
    get: (path, opts) => pick(path).get(path, opts),
    post: (path, body) => pick(path).post(path, body),
    put: (path, body) => pick(path).put(path, body),
    delete: (path) => pick(path).delete(path),
    // Attribution for read receipts: the scoped account a path routes to, or null
    // for the default credential (ledger item 7 - empty rooms must be attributable).
    credentialFor: (path) => matchScopedPath(path, table)?.accountName ?? null,
  };
}
