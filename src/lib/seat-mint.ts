import type { AuthApiClient } from './auth-api.js';

/**
 * The one seat mint call every chair surface makes (#297): console `:seat`,
 * `flurryport seat`, and the MCP `mint_seat` tool all POST the same
 * /invites/seat body and read the same release. Hoisted so the wire shape
 * lives in exactly one place - a surface can differ in ceremony (asks, passes,
 * warnings) but never in what it sends or what it believes came back.
 *
 * The release carries the pairing code SHOWN ONCE; the seat's credentials are
 * minted server-side at redemption and never transit this call.
 */

export interface SeatMintRelease {
  pairingCode: string;
  ref: string;
  /** The server's assigned participant name (post-sanitize, pre handle-alphabet). */
  participantName: string;
  /** When the SEAT ends (posting and reading stop; the log keeps its bylines). */
  expiresAt: string;
  /** When the pairing CODE dies - minutes, not hours. */
  codeExpiresAt: string;
  /** #409: true when the mint also pre-authorized the handle's standing-credential slot. */
  standingPreAuthorized: boolean;
}

export interface SeatMintOptions {
  displayName?: string | null;
  recipeRef?: string | null;
  /** Seat life in hours, 1 to 168; null takes the server default (24). */
  expiresInHours?: number | null;
  /**
   * #351: how long the unredeemed pairing code lives, in minutes, 1 to 1440; null
   * takes the server default (10). The server clips it to the seat's own end.
   */
  codeMinutes?: number | null;
  /**
   * #409 slice 8 (Q6's normal working path): pre-authorize this handle's
   * STANDING-CREDENTIAL slot at mint, so the steward's later consent-page
   * acceptance promotes the seat immediately instead of parking for the chair.
   */
  standing?: boolean;
  /**
   * #427 chair constraint (with standing): pin this handle's consent page to
   * checked-in custody only.
   */
  standingCheckedInOnly?: boolean;
}

export async function mintSeatInvite(
  client: AuthApiClient,
  endpointId: string,
  guestName: string,
  opts: SeatMintOptions = {},
): Promise<SeatMintRelease> {
  const res = (await client.post(`/api/v1/endpoints/${endpointId}/invites/seat`, {
    GuestName: guestName,
    DisplayName: opts.displayName ?? null,
    RecipeRef: opts.recipeRef ?? null,
    ExpiresInHours: opts.expiresInHours ?? null,
    CodeMinutes: opts.codeMinutes ?? null,
    Standing: opts.standing ?? false,
    StandingCheckedInOnly: opts.standingCheckedInOnly ?? false,
  })) as {
    PairingCode: string;
    Ref: string;
    ParticipantName: string;
    ExpiresAt: string;
    CodeExpiresAt: string;
    StandingPreAuthorized?: boolean;
  };
  return {
    pairingCode: res.PairingCode,
    ref: res.Ref,
    participantName: res.ParticipantName,
    expiresAt: res.ExpiresAt,
    codeExpiresAt: res.CodeExpiresAt,
    standingPreAuthorized: res.StandingPreAuthorized ?? false,
  };
}

/** Whole minutes until the pairing code dies, floored at 1 (the ferry warning's number). */
export function codeMinutesLeft(codeExpiresAt: string, now: number = Date.now()): number {
  return Math.max(1, Math.round((new Date(codeExpiresAt).getTime() - now) / 60_000));
}
