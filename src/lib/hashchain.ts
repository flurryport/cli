import { createHash } from 'node:crypto';

/**
 * The turnkey ceremony helper for FlurryPORT's hash-chained event streams (tic-tac-toe today;
 * chess, RPG, git-activity next). It exists so an agent NEVER hand-rolls canonical JSON or a
 * SHA-256 chain — the classic failure (run 1 stalled on a human-sorted canonical string that put
 * prevHash before player). Compute it with this, never by hand.
 *
 * Canonicalization is RFC 8785 (JCS)-equivalent for these payloads: keys sorted lexicographically
 * at every level, the `sig` field excluded, UTF-8, no insignificant whitespace.
 */

export function canon(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => k !== 'sig').sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export interface VerifyChainResult {
  /** Every event's prevHash chained correctly off the prior event's canonical hash. */
  intact: boolean;
  /** 0-based index of the first event whose prevHash did not match (null when intact). */
  brokenAt: number | null;
  count: number;
  /** SHA-256 of the last verified event's canonical form — the prevHash for YOUR next post. */
  nextPrevHash: string;
}

/**
 * Verify a hash chain in one pass, and hand back the prevHash for the caller's next event. Events
 * must be the parsed bodies in sequence order. `hashField` defaults to the prevHash pointer name;
 * `genesisPrevHash` is what the first event's pointer must equal (empty string by convention).
 */
export function verifyChain(
  events: unknown[],
  opts?: { hashField?: string; genesisPrevHash?: string },
): VerifyChainResult {
  const hashField = opts?.hashField ?? 'prevHash';
  const genesis = opts?.genesisPrevHash ?? '';
  let prev = genesis;
  for (let i = 0; i < events.length; i++) {
    const e = (events[i] ?? {}) as Record<string, unknown>;
    const declared = typeof e[hashField] === 'string' ? (e[hashField] as string) : '';
    if (declared !== prev) {
      return { intact: false, brokenAt: i, count: events.length, nextPrevHash: prev };
    }
    prev = sha256Hex(canon(e));
  }
  return { intact: true, brokenAt: null, count: events.length, nextPrevHash: prev };
}
