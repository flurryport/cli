import {
  AnonApiError,
  type PollDeviceHandoffResponse,
  type RegisterDeviceHandoffResponse,
} from './anon-api.js';
import { parseErrorResponse } from './fetch-error.js';
import { recordCliNotice, versionHeader } from './version-nudge.js';

/**
 * Client half of the invite-rail acceptance device flow (`flurryport join`). The joiner's
 * CLI registers a high-entropy device code against the invite token, then polls the shared
 * device-poll route until the human's magic-link acceptance releases the grant: the scoped
 * read PAT for a monitor, plus the per-contributor signing key for a producer.
 *
 * The device code is the only key to the release and never leaves this process except to the
 * register/poll endpoints. The invite token (fpi_) is the possession credential; the release
 * is one-shot server-side.
 */

const jsonHeaders = { 'Content-Type': 'application/json', Accept: 'application/json', ...versionHeader() };

async function parse<T>(res: Response): Promise<T> {
  // Latch the server's version-staleness notice (if any) for the meta builders.
  recordCliNotice(res);
  if (!res.ok) {
    const { code, detail } = await parseErrorResponse(res);
    throw new AnonApiError(res.status, code, detail);
  }
  return (await res.json()) as T;
}

/**
 * The landing facts the ceremony's honesty checks read. `grantCollectedAt` is the one
 * signal that cannot lie about a finished ceremony (pilot-1 rider, 2026-08-13): the
 * server stamps it only when a device channel actually collected the grant.
 */
export interface InviteLandingFacts {
  recipeRef?: string | null;
  role?: string | null;
  status?: string | null;
  grantCollectedAt?: string | null;
}

/**
 * Classify what a device-channel death (or a stuck wait) actually means, from the
 * landing's own facts. Pilot-1 ledger item 2: rounds 2-4 reported `channel_expired`
 * every 20-30 seconds when the truth was a dead invite; the round-5 healthy control
 * (25 minutes, zero errors) proved the states are distinguishable. This is the
 * distinguisher, shared by `flurryport join` and the MCP `join_invite` tool.
 *
 *  - 'invite_gone'         landing unreachable/404: expired, revoked, or never existed
 *  - 'grant_collected'     a channel already collected the grant - this ceremony is over
 *  - 'accepted_no_release' accepted, but no grant will ever release to this channel:
 *                          the owner-accept void signature (ledger item 1), or another
 *                          device's ceremony - either way, terminal for this one
 *  - 'live'                the invite still stands; a channel death here is a real TTL lapse
 */
export type CeremonyState = 'invite_gone' | 'grant_collected' | 'accepted_no_release' | 'live';

export function classifyCeremonyState(landing: InviteLandingFacts | null): CeremonyState {
  if (!landing) return 'invite_gone';
  if (landing.grantCollectedAt) return 'grant_collected';
  if (landing.status === 'accepted') return 'accepted_no_release';
  return 'live';
}

export interface InviteJoinClient {
  /** Arm the device channel on the invite token. Kind (monitor vs producer) is server-chosen from the invite's role. */
  registerInviteDevice(inviteToken: string, deviceCode: string): Promise<RegisterDeviceHandoffResponse>;
  /** Poll the shared device-poll route; 'complete' carries the PAT (+ signing key for producers). */
  pollInviteDevice(deviceCode: string): Promise<PollDeviceHandoffResponse>;
  /** Browser URL the human opens to accept the invite with their email (the dual-legible landing). */
  landingUrl(inviteToken: string): string;
  /**
   * Fetch the landing's agent JSON: the discovery facts (recipeRef, role) plus the
   * ceremony-honesty facts (status, grantCollectedAt). Best-effort: a null return
   * means the landing itself is gone or unreachable, never a thrown error.
   */
  getLanding(inviteToken: string): Promise<InviteLandingFacts | null>;
  readonly baseUrl: string;
}

export function createInviteJoinClient(baseUrl: string): InviteJoinClient {
  const base = baseUrl.replace(/\/$/, '');
  return {
    baseUrl: base,
    landingUrl: (inviteToken) => `${base}/api/v1/invites/${inviteToken}`,

    async registerInviteDevice(inviteToken, deviceCode) {
      const res = await fetch(`${base}/api/v1/invites/${inviteToken}/device/start`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ DeviceCode: deviceCode }),
      });
      return parse<RegisterDeviceHandoffResponse>(res);
    },

    async pollInviteDevice(deviceCode) {
      // The poll route is shared across every device-flow Kind and dispatches server-side.
      const res = await fetch(`${base}/api/v1/anon/device/poll`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ DeviceCode: deviceCode }),
      });
      return parse<PollDeviceHandoffResponse>(res);
    },

    async getLanding(inviteToken) {
      try {
        const res = await fetch(`${base}/api/v1/invites/${inviteToken}`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return null;
        const j = (await res.json()) as InviteLandingFacts;
        return {
          recipeRef: j.recipeRef ?? null,
          role: j.role ?? null,
          status: j.status ?? null,
          grantCollectedAt: j.grantCollectedAt ?? null,
        };
      } catch {
        // Never let a discovery-hint fetch break the join.
        return null;
      }
    },
  };
}
