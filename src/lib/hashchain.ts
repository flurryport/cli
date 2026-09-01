import { createHash } from 'node:crypto';

/**
 * The turnkey ceremony helper for FlurryPORT's hash-chained event streams (tic-tac-toe today;
 * chess, RPG, git-activity next). It exists so an agent NEVER hand-rolls canonical JSON or a
 * SHA-256 chain — the classic failure (run 1 stalled on a human-sorted canonical string that put
 * prevHash before player). Compute it with this, never by hand.
 *
 * Canonicalization is RFC 8785 (JCS)-equivalent for these payloads: keys sorted lexicographically
 * at every level, the TOP-LEVEL `sig` field excluded (the signature envelope signs the rest of the
 * event, so it cannot cover itself), UTF-8, no insignificant whitespace.
 *
 * `sig` is excluded at the top level ONLY (hardening precedent #2): the old recursive filter
 * dropped every nested `sig` (payload.sig, moves[3].sig) from the hash at all depths, so nested
 * signatures could be tampered while the chain read intact.
 */

export function canon(v: unknown): string {
  return canonAt(v, true);
}

function canonAt(v: unknown, isRoot: boolean): string {
  if (Array.isArray(v)) return '[' + v.map((item) => canonAt(item, false)).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => !(isRoot && k === 'sig'))
      .sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonAt(o[k], false)).join(',') + '}';
  }
  return JSON.stringify(v);
}

/**
 * The PRE-0.6.4 canonical form, kept ONLY so verifyChain can tell "legacy chain"
 * from "tampered chain" (review finding 5): the old rules excluded `sig` at every
 * depth. Never used for new hashes.
 */
function canonLegacy(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonLegacy).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => k !== 'sig').sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonLegacy(o[k])).join(',') + '}';
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
  /**
   * The prevHash for YOUR next post: the strict tail hash on an intact chain; on
   * a legacy-intact chain (legacyIntact true) the LEGACY tail hash, so extending
   * keeps the chain verifiable under the rules that vouch for it. On a chain
   * broken under both rule sets it is the strict hash at the break - do not extend.
   */
  nextPrevHash: string;
  /**
   * Present only when the STRICT verification broke (review finding 5): true means
   * the chain verifies intact under the pre-0.6.4 rules (all-depth sig exclusion,
   * missing pointer read as genesis) - a legitimate legacy chain, NOT tampering.
   * False means it is broken under both rule sets. intact/brokenAt always report
   * the strict rules; disclosure never silently accepts.
   */
  legacyIntact?: boolean;
}

/**
 * Verify a hash chain in one pass, and hand back the prevHash for the caller's next event. Events
 * must be the parsed bodies in sequence order. `hashField` defaults to the prevHash pointer name;
 * `genesisPrevHash` is what the first event's pointer must equal (empty string by convention).
 *
 * The pointer field must be PRESENT as a string on every event, genesis included (hardening
 * precedent #2): the old coercion of a missing/non-string pointer to '' let a pointerless event
 * verify as genesis under the empty-string convention.
 */
export function verifyChain(
  events: unknown[],
  opts?: { hashField?: string; genesisPrevHash?: string },
): VerifyChainResult {
  const hashField = opts?.hashField ?? 'prevHash';
  const genesis = opts?.genesisPrevHash ?? '';
  const strict = runChain(events, hashField, genesis, canon, true);
  if (strict.intact) return strict;
  // Broken under the current rules: check the pre-0.6.4 rules so a chain
  // recorded by an older CLI reads as "legacy", not as tampered. Disclosure
  // only - the strict verdict (intact/brokenAt) stands. nextPrevHash, though,
  // must be USABLE (round-3 finding: strict's hash-at-the-break-point poisoned
  // any continuation into broken-under-both): a legacy-intact chain hands back
  // the LEGACY tail hash, so extending keeps the whole chain verifiable under
  // the rules that vouch for it - still disclosed as legacy on every verify.
  const legacy = runChain(events, hashField, genesis, canonLegacy, false);
  return {
    ...strict,
    legacyIntact: legacy.intact,
    ...(legacy.intact ? { nextPrevHash: legacy.nextPrevHash } : {}),
  };
}

function runChain(
  events: unknown[],
  hashField: string,
  genesis: string,
  canonFn: (v: unknown) => string,
  requirePointer: boolean,
): VerifyChainResult {
  let prev = genesis;
  for (let i = 0; i < events.length; i++) {
    const e = (events[i] ?? {}) as Record<string, unknown>;
    const raw = e[hashField];
    const broken = { intact: false, brokenAt: i, count: events.length, nextPrevHash: prev };
    if (typeof raw !== 'string') {
      // Strict: the pointer field must be present. Legacy: the old coercion to ''
      // let a pointerless event pass ONLY where '' was the expected value (genesis).
      if (requirePointer || prev !== '') return broken;
    } else if (raw !== prev) {
      return broken;
    }
    prev = sha256Hex(canonFn(e));
  }
  return { intact: true, brokenAt: null, count: events.length, nextPrevHash: prev };
}
