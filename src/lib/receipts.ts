/**
 * Locker receipt verification (slice 2 of the platform pass, 2026-11-05): the one
 * TypeScript implementation of Core/docs/receipts/locker-receipt-chain.md. WebCrypto only
 * (globalThis.crypto), so the same module runs in Node 22 (this CLI's verify_receipt tool),
 * in a browser (Common.Web's copy behind the public /receipts/{id} page), and in the export
 * bundle. Core/docs/receipts/locker-receipt-vectors.json locks it to the C# writer.
 *
 * A receipt proves that FlurryPORT recorded these bytes at this position in this install's
 * chain and signed that statement with the install's key. It does not prove who posted the
 * bytes and it is not a timestamp authority.
 */

export interface ReceiptJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export interface ReceiptCore {
  schema: string;
  receiptId: string;
  installId: string;
  chainIndex: number;
  prevHash: string;
  bodySha256: string;
  leafRoot: string;
  capturedAt: string;
  keyId: string;
}

export interface SignedReceipt extends ReceiptCore {
  hash: string;
  signature: string;
  publicKey: ReceiptJwk;
}

export const RECEIPT_SCHEMA = 'locker.receipt/1';
export const DISCLOSURE_SCHEMA = 'locker.disclosure/1';
export const GENESIS_PREV_HASH = '';

const subtle = (): SubtleCrypto => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error('WebCrypto is not available in this runtime.');
  return c.subtle;
};

// ── encodings ──────────────────────────────────────────────────────────────────

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const b of u) out += b.toString(16).padStart(2, '0');
  return out;
}

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of u) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── JCS (RFC 8785) ─────────────────────────────────────────────────────────────

/** Canonical JSON: sorted keys at every level, no whitespace, JSON.stringify's escapes and numbers. */
export function jcs(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('JCS cannot serialize NaN or Infinity.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(jcs).join(',') + ']';
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + jcs(o[k])).join(',') + '}';
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  return hex(await subtle().digest('SHA-256', bytes as BufferSource));
}

async function hmacSha256Hex(key: Uint8Array, data: Uint8Array): Promise<string> {
  const k = await subtle().importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await subtle().sign('HMAC', k, data as BufferSource));
}

// ── the receipt core ───────────────────────────────────────────────────────────

export function canonicalCore(r: ReceiptCore): string {
  return jcs({
    schema: r.schema,
    receiptId: r.receiptId,
    installId: r.installId,
    chainIndex: r.chainIndex,
    prevHash: r.prevHash,
    bodySha256: r.bodySha256,
    leafRoot: r.leafRoot,
    capturedAt: r.capturedAt,
    keyId: r.keyId,
  });
}

export function receiptHash(r: ReceiptCore): Promise<string> {
  return sha256Hex(canonicalCore(r));
}

/** RFC 7638 thumbprint: base64url(SHA-256(JCS of crv, kty, x, y)). */
export async function thumbprint(jwk: ReceiptJwk): Promise<string> {
  const digest = await subtle().digest(
    'SHA-256',
    utf8(jcs({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })) as BufferSource,
  );
  return base64UrlEncode(digest);
}

export function parseReceipt(input: unknown): SignedReceipt | null {
  const o = typeof input === 'string' ? safeJson(input) : input;
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : null);
  const pk = r.publicKey as Record<string, unknown> | undefined;
  if (r.schema !== RECEIPT_SCHEMA || typeof r.chainIndex !== 'number' || !pk || typeof pk !== 'object') return null;
  for (const k of [
    'receiptId',
    'installId',
    'prevHash',
    'bodySha256',
    'leafRoot',
    'capturedAt',
    'keyId',
    'hash',
    'signature',
  ]) {
    if (str(k) === null) return null;
  }
  if (pk.kty !== 'EC' || pk.crv !== 'P-256' || typeof pk.x !== 'string' || typeof pk.y !== 'string') return null;
  return {
    schema: RECEIPT_SCHEMA,
    receiptId: str('receiptId')!,
    installId: str('installId')!,
    chainIndex: r.chainIndex as number,
    prevHash: str('prevHash')!,
    bodySha256: str('bodySha256')!,
    leafRoot: str('leafRoot')!,
    capturedAt: str('capturedAt')!,
    keyId: str('keyId')!,
    hash: str('hash')!,
    signature: str('signature')!,
    publicKey: { kty: 'EC', crv: 'P-256', x: pk.x, y: pk.y },
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function verifySignature(r: SignedReceipt, pinned?: ReceiptJwk): Promise<boolean> {
  const jwk = pinned ?? r.publicKey;
  try {
    if ((await thumbprint(jwk)) !== r.keyId) return false;
    const key = await subtle().importKey('jwk', { ...jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'verify',
    ]);
    const sig = base64UrlDecode(r.signature);
    if (sig.length !== 64) return false;
    return await subtle().verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      sig as BufferSource,
      utf8(canonicalCore(r)) as BufferSource,
    );
  } catch {
    return false;
  }
}

export interface VerifyReceiptsResult {
  intact: boolean;
  signaturesValid: boolean;
  brokenAt: number | null;
  count: number;
  nextPrevHash: string;
  keyIds: string[];
  /** The index of every receipt whose signature failed; empty when signaturesValid. */
  badSignatures: number[];
}

/** Walks a run of receipts oldest first: linkage, hashes, signatures (spec section 9). */
export async function verifyReceipts(
  receipts: SignedReceipt[],
  opts: { publicKey?: ReceiptJwk; genesisPrevHash?: string } = {},
): Promise<VerifyReceiptsResult> {
  let prev = opts.genesisPrevHash ?? GENESIS_PREV_HASH;
  const badSignatures: number[] = [];
  const keyIds = new Set<string>();
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    keyIds.add(r.keyId);
    if (r.prevHash !== prev || (await receiptHash(r)) !== r.hash) {
      return {
        intact: false,
        signaturesValid: badSignatures.length === 0,
        brokenAt: i,
        count: receipts.length,
        nextPrevHash: prev,
        keyIds: [...keyIds],
        badSignatures,
      };
    }
    if (!(await verifySignature(r, opts.publicKey))) badSignatures.push(i);
    prev = r.hash;
  }
  return {
    intact: true,
    signaturesValid: badSignatures.length === 0,
    brokenAt: null,
    count: receipts.length,
    nextPrevHash: prev,
    keyIds: [...keyIds],
    badSignatures,
  };
}

// ── salted leaves ──────────────────────────────────────────────────────────────

export interface Leaf {
  path: string;
  value: unknown;
}

export function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Every leaf (scalar, empty object, empty array) by JSON Pointer, in code-unit order of path. */
export function enumerateLeaves(root: unknown): Leaf[] {
  const out: Leaf[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) {
      if (v.length === 0) {
        out.push({ path, value: v });
        return;
      }
      v.forEach((item, i) => walk(item, path + '/' + i));
      return;
    }
    if (v !== null && typeof v === 'object') {
      const keys = Object.keys(v as Record<string, unknown>);
      if (keys.length === 0) {
        out.push({ path, value: v });
        return;
      }
      for (const k of keys) walk((v as Record<string, unknown>)[k], path + '/' + escapePointerToken(k));
      return;
    }
    out.push({ path, value: v });
  };
  walk(root, '');
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function leafSalt(leafSecret: Uint8Array, path: string): Promise<string> {
  return hmacSha256Hex(leafSecret, utf8(path));
}

export function leafHash(salt: string, path: string, canonicalValue: string): Promise<string> {
  return sha256Hex(salt + '\n' + path + '\n' + canonicalValue);
}

export async function leafRootOf(entries: Array<{ path: string; hash: string }>): Promise<string> {
  const map: Record<string, string> = {};
  for (const e of entries) map[e.path] = e.hash;
  return sha256Hex(jcs(map));
}

/** The leaf root of a full body under a known leaf secret (what the server computed at write time). */
export async function leafRootOfBody(body: unknown, leafSecret: Uint8Array): Promise<string> {
  const entries = [];
  for (const leaf of enumerateLeaves(body)) {
    const salt = await leafSalt(leafSecret, leaf.path);
    entries.push({ path: leaf.path, hash: await leafHash(salt, leaf.path, jcs(leaf.value)) });
  }
  return leafRootOf(entries);
}

export function isDisclosure(doc: unknown): doc is { schema: string; leaves: unknown[] } {
  return (
    !!doc &&
    typeof doc === 'object' &&
    (doc as Record<string, unknown>).schema === DISCLOSURE_SCHEMA &&
    Array.isArray((doc as Record<string, unknown>).leaves)
  );
}

/** The leaf root of a disclosure document: disclosed leaves recomputed, redacted leaves taken as given. */
export async function leafRootOfDisclosure(doc: unknown): Promise<string | null> {
  if (!isDisclosure(doc)) return null;
  const entries: Array<{ path: string; hash: string }> = [];
  for (const raw of doc.leaves) {
    const leaf = raw as Record<string, unknown>;
    if (typeof leaf.path !== 'string') return null;
    if (typeof leaf.hash === 'string') entries.push({ path: leaf.path, hash: leaf.hash });
    else if (typeof leaf.salt === 'string')
      entries.push({ path: leaf.path, hash: await leafHash(leaf.salt, leaf.path, jcs(leaf.value)) });
    else return null;
  }
  return leafRootOf(entries);
}

export function redactedPathsOf(doc: unknown): string[] {
  if (!isDisclosure(doc)) return [];
  return doc.leaves
    .map((l) => l as Record<string, unknown>)
    .filter((l) => typeof l.hash === 'string')
    .map((l) => l.path as string);
}

export interface BodyCheck {
  mode: 'raw' | 'disclosure';
  bodySha256Matches: boolean;
  leafRootMatches: boolean | null;
  redactedPaths: string[];
}

/** Checks the bytes in hand against a receipt: raw bytes by bodySha256, a disclosure document by leafRoot. */
export async function verifyBody(r: ReceiptCore, body: Uint8Array | string): Promise<BodyCheck> {
  const bytes = typeof body === 'string' ? utf8(body) : body;
  const bodySha256Matches = (await sha256Hex(bytes)) === r.bodySha256;
  const text = typeof body === 'string' ? body : new TextDecoder().decode(bytes);
  const doc = safeJson(text);
  if (isDisclosure(doc)) {
    const root = await leafRootOfDisclosure(doc);
    return {
      mode: 'disclosure',
      bodySha256Matches,
      leafRootMatches: root === r.leafRoot,
      redactedPaths: redactedPathsOf(doc),
    };
  }
  return { mode: 'raw', bodySha256Matches, leafRootMatches: null, redactedPaths: [] };
}
