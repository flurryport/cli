import { participantAccountName } from './config.js';

/**
 * Presence truth (#266): what the room's TRANSPORT actually knows about each
 * seat, kept as a ledger the seat server writes and the engine reads. A seat is
 * an agent on a poll loop; the seat server sees every one of its tool calls, so
 * recency of contact is a fact, not a guess. The obligation ledger (the stream)
 * is untouched - this is presence, not attribution.
 *
 * Pure state, no I/O, the AttentionRelay pattern: the console frontend owns one
 * instance and hands it to both sides. The standalone `flurryport seat-server`
 * can carry one too; a console with no hosted room simply has an empty ledger,
 * and every accepted seat reads adrift - which is the truth: this console has
 * no transport contact with them.
 *
 * Keys normalize through the same alphabet as handles (participantAccountName),
 * so the chair's roster names and the seat principal's minted name meet in the
 * middle, exactly as the attention relay does.
 */

/**
 * The presence policy (#266), in seconds. Seats are told to keep polling
 * (long-poll reads run every 20-25 seconds), so:
 *  - contact within PRESENCE_LIVE_SECONDS reads live: two missed cycles of
 *    slack, because a busy agent finishes a thought before its next read;
 *  - contact within PRESENCE_IDLE_SECONDS reads idle: the agent is seated but
 *    not attending - a long tool run, a distracted harness;
 *  - anything older (or never seen) reads adrift: the transport has genuinely
 *    lost them, and the chair should assume nothing is listening.
 */
export const PRESENCE_LIVE_SECONDS = 120;
export const PRESENCE_IDLE_SECONDS = 900;

/** The transport-derived states. departed is the ENGINE's word (fp:bye), not ours. */
export type TransportPresence = 'live' | 'idle' | 'adrift';

export class PresenceLedger {
  /** Latest contact per normalized participant name, epoch ms. */
  private lastSeen = new Map<string, number>();

  /** Record transport contact. Monotonic: an out-of-order note never regresses. */
  notePoll(participantName: string, atMs: number = Date.now()): void {
    const key = participantAccountName(participantName);
    const prev = this.lastSeen.get(key) ?? 0;
    if (atMs > prev) this.lastSeen.set(key, atMs);
  }

  /** The policy applied to the ledger: live, idle, or adrift (never seen = adrift). */
  stateFor(participantName: string, nowMs: number = Date.now()): TransportPresence {
    const seen = this.lastSeen.get(participantAccountName(participantName));
    if (seen === undefined) return 'adrift';
    const ageSeconds = (nowMs - seen) / 1000;
    if (ageSeconds <= PRESENCE_LIVE_SECONDS) return 'live';
    if (ageSeconds <= PRESENCE_IDLE_SECONDS) return 'idle';
    return 'adrift';
  }
}
