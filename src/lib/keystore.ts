import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Multi-credential keystore (7a follow-on): `~/.flurryport/keystore.json`, a keyed
 * map {ref -> credential} rather than "one token" — the manifest's localKeyRef
 * already assumed this shape. v1 holds endpoint signing keys (7c: born here,
 * sent once to the dedicated signing endpoint, NEVER passed through tool
 * args/results); v2 adds guest per-endpoint contributor tokens additively.
 *
 * Posture (7c, honest): permissions-restricted file (0600 where the platform
 * supports it), OS-keychain deferred.
 */

export interface StoredCredential {
  /** 'signing' today; 'contributor' arrives with v2 intake-auth. */
  type: string;
  value: string;
  createdAt: string;
}

interface KeystoreFile {
  version: 1;
  credentials: Record<string, StoredCredential>;
}

const KEYSTORE_PATH = join(homedir(), '.flurryport', 'keystore.json');

function load(): KeystoreFile {
  try {
    if (existsSync(KEYSTORE_PATH)) {
      const parsed = JSON.parse(readFileSync(KEYSTORE_PATH, 'utf8')) as KeystoreFile;
      if (parsed && parsed.credentials) return parsed;
    }
  } catch {
    /* corrupt keystore reads as empty; the next save rewrites it */
  }
  return { version: 1, credentials: {} };
}

function save(store: KeystoreFile): void {
  const dir = join(homedir(), '.flurryport');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(KEYSTORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
  try {
    chmodSync(KEYSTORE_PATH, 0o600); // writeFileSync mode is ignored on an existing file
  } catch {
    /* best-effort on platforms without POSIX modes (Windows ACLs) */
  }
}

export function getCredential(ref: string): StoredCredential | null {
  return load().credentials[ref] ?? null;
}

/**
 * Facts-only listing for `flurryport keys list` (0.3.0 keystore floor): refs, types,
 * and timestamps — NEVER values. The value stays a write-only secret from the human
 * surface too.
 */
export function listCredentials(): Array<{ ref: string; type: string; createdAt: string }> {
  return Object.entries(load().credentials)
    .map(([ref, cred]) => ({ ref, type: cred.type, createdAt: cred.createdAt }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

export function getKeystorePath(): string {
  return KEYSTORE_PATH;
}

export function putCredential(ref: string, credential: StoredCredential): void {
  const store = load();
  store.credentials[ref] = credential;
  save(store);
}

export function deleteCredential(ref: string): void {
  const store = load();
  if (ref in store.credentials) {
    delete store.credentials[ref];
    save(store);
  }
}

/** Keystore ref for an endpoint's signing key — mirrors the server's per-endpoint name. */
export function signingKeyRef(endpointId: string): string {
  return `signing:${endpointId}`;
}

/**
 * Keystore ref for a per-contributor intake signing key received via `flurryport join`
 * (invite rail, producer role). Keyed by endpoint so one machine can hold contributor
 * keys for several endpoints at once. The stored credential's `type` is 'contributor'.
 */
export function contributorKeyRef(endpointId: string): string {
  return `contributor:${endpointId}`;
}

/**
 * 32 bytes of CSPRNG entropy, base64url, `fpsk_` prefixed. Born in-process (7c:
 * device-flow precedent) — the value goes to the keystore and once to the server
 * over TLS, and never into tool args or results.
 */
export function generateSigningKey(): string {
  return 'fpsk_' + randomBytes(32).toString('base64url');
}
