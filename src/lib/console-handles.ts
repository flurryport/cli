import { participantAccountName } from './config.js';
import { RESERVED_WORDS } from './console-parser.js';

/**
 * Handle assignment for the console roster (ratified): the handle derives from
 * GuestName through the SAME normalizer the CLI already uses for account names
 * (participantAccountName), collisions resolve at BIND time with deterministic
 * suffixes (bard, bard-2), and reserved words can never be handles. GuestName
 * stays the pretty byline; the handle is what you type.
 *
 * Wire schema v1 additions (§1 charset law): handles may never BEGIN `fp:` or
 * `r:` (the verb namespaces - a prefix rule, not a word list), and callers pass
 * extra reserved words (the seeded chair address) that no seat can normalize onto.
 */

const HANDLE_MAX = 40;

/** The verb-namespace prefixes a handle may never begin with (wire schema v1 §1). */
const BANNED_PREFIXES = /^(?:fp:|r:)+/;

/** Deterministic suffixing: base, base-2, base-3 ... always within the length cap. */
function suffixed(base: string, n: number): string {
  if (n === 1) return base;
  const suffix = `-${n}`;
  return base.slice(0, HANDLE_MAX - suffix.length) + suffix;
}

/** The normalizer with the v1 prefix rule applied: strip banned prefixes, refuse empty. */
export function handleBase(guestName: string): string {
  const stripped = participantAccountName(guestName).replace(BANNED_PREFIXES, '');
  return stripped.length > 0 ? stripped : 'guest';
}

/**
 * Mint-surface guest-name hygiene (#284a): trim whitespace and strip SURROUNDING
 * quote marks, repeatedly, so `:seat 'coder'` mints coder and never the literal
 * quoted form (the handle alphabet excludes quotes, so a quoted seat is
 * unaddressable by the console grammar and only :all ever reaches it - found
 * live, twice). Interior quotes are content and survive (o'brien stays o'brien).
 * Every mint surface runs its input through here before the server sees it.
 */
export function sanitizeGuestName(raw: string): string {
  let name = raw.trim();
  for (;;) {
    const stripped = name.replace(/^['"`]+/, '').replace(/['"`]+$/, '').trim();
    if (stripped === name) return name;
    name = stripped;
  }
}

/**
 * Assign handles to roster rows IN THE GIVEN ORDER (callers sort by CreatedAt then
 * ref so the assignment is stable for the life of a session). A reserved word
 * counts as already taken, so a seat named "Seat" binds as seat-2. Extra reserved
 * words (the seeded chair address at mint) count the same way.
 */
export function assignHandles<T extends { guestName: string }>(
  rows: T[],
  extraReserved: Iterable<string> = [],
): Array<T & { handle: string }> {
  const taken = new Set<string>([...RESERVED_WORDS, ...extraReserved]);
  return rows.map((row) => {
    const base = handleBase(row.guestName);
    let n = 1;
    let handle = suffixed(base, n);
    while (taken.has(handle)) {
      n += 1;
      handle = suffixed(base, n);
    }
    taken.add(handle);
    return { ...row, handle };
  });
}
