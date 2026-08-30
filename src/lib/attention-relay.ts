import { participantAccountName } from './config.js';

/**
 * The attention relay (0.5.1 slice C): the seam between the chair's attention
 * orders and the in-process room server's meta assembly. The obligation ALWAYS
 * lives in the signed post on the stream (run-6 receipt: meta-borne notices get
 * ignored, bodies get relayed); what rides here is only the WAKE-UP - a one-shot
 * MetaNotice delivered on the targeted seat's very next tool-call response
 * (the staleness-nudge pattern, zero Core changes).
 *
 * Pure state, no I/O: the console frontend owns one instance and hands it to
 * both sides - the engine's RoomHost seam writes orders in, the seat server's
 * meta assembly takes them out. The standalone `flurryport seat-server` has no
 * console attached and therefore no relay: orders still land on the stream and
 * are read by polling, they just get no meta nudge.
 *
 * Keys are participant names, normalized through the same alphabet as handles
 * (participantAccountName) on both the set and take sides, so the chair's
 * roster names and the seat principal's minted name meet in the middle.
 */

export type AttentionCode = 'attention_hold' | 'attention_interrupt' | 'attention_resume';

export interface AttentionOrder {
  code: AttentionCode;
  /** The `!` flag: a panic interrupt outranks everything and renders loudly. */
  panic: boolean;
}

/** Urgency ladder for pending-order merges: panic interrupt > interrupt > hold. */
function rank(order: AttentionOrder): number {
  switch (order.code) {
    case 'attention_resume': return 0;
    case 'attention_hold': return 1;
    case 'attention_interrupt': return order.panic ? 3 : 2;
  }
}

export class AttentionRelay {
  private pending = new Map<string, AttentionOrder>();

  /**
   * Record the chair's order for a participant. One notice per response, highest
   * urgency wins: an undelivered lower-urgency order is superseded, a higher one
   * survives a quieter follow-up. Resume always replaces - it clears the held
   * notice (the stream keeps the full record either way).
   */
  set(participantName: string, order: AttentionOrder): void {
    const key = participantAccountName(participantName);
    if (order.code === 'attention_resume') {
      this.pending.set(key, order);
      return;
    }
    const current = this.pending.get(key);
    if (current && rank(current) > rank(order)) return;
    this.pending.set(key, order);
  }

  /** Take the one-shot pending order for a participant; the take is the delivery. */
  take(participantName: string): AttentionOrder | null {
    const key = participantAccountName(participantName);
    const order = this.pending.get(key) ?? null;
    if (order) this.pending.delete(key);
    return order;
  }
}
