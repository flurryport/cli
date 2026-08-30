import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `.flurryport/pipes.json` — the pipe manifest (slice 5 / B2.4): a PORTABLE,
 * REGENERABLE projection of server-side pipe state, committed to the user's
 * project repo. Server-side bindings/transformations/secrets are the runtime
 * source of truth; this file is the Terraform-config-vs-running-state side —
 * on conflict, the server wins.
 *
 * Distribution property: a teammate clones the repo, their agent reads the
 * manifest and offers to connect with their own token (device flow). That only
 * works if the file is safe to commit — hence the hard rule below.
 *
 * RULE: NO SECRET MATERIAL IN THE FILE. `signing.localKeyRef` NAMES a key in
 * the local CLI keystore; delivery secrets live server-side only. Writes are
 * scanned and refused if anything token-shaped appears.
 */

export interface PipeManifestEntry {
  /** Human name, unique within the manifest — the upsert key. */
  name: string;
  /** Opaque (base62) project id. */
  project: string;
  /** Endpoint slug (stable across environments; ids are per-install). */
  endpoint: string;
  /** Catalog recipe ref (publisher:slug@version) when installed from one. */
  recipe?: string;
  transformation?: { id: string; version?: number };
  /** The intent payload contract post_intent callers author against. */
  intentSchema?: unknown;
  signing?: { header: string; scheme: string; localKeyRef: string };
  /** True while the pipe is being wired — not yet verified end-to-end. */
  draft?: boolean;
  createdBy?: string;
  createdAt?: string;
}

export interface PipeManifest {
  version: 1;
  pipes: PipeManifestEntry[];
}

const MANIFEST_DIR = '.flurryport';
const MANIFEST_FILE = 'pipes.json';

export function manifestPath(cwd: string = process.cwd()): string {
  return join(cwd, MANIFEST_DIR, MANIFEST_FILE);
}

export function readManifest(cwd: string = process.cwd()): PipeManifest {
  const path = manifestPath(cwd);
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as PipeManifest;
      if (parsed && Array.isArray(parsed.pipes)) return { version: 1, pipes: parsed.pipes };
    }
  } catch {
    /* unreadable manifest reads as empty; a write will rewrite it */
  }
  return { version: 1, pipes: [] };
}

/**
 * Token-shaped strings that must never land in a committed file: FlurryPORT
 * PATs and signing keys, provider webhook secrets, common bearer shapes.
 */
const SECRET_PATTERNS = [
  /fp_[A-Za-z0-9_-]{16,}/,
  /fpsk_[A-Za-z0-9_-]{16,}/,
  /whsec_[A-Za-z0-9]{8,}/,
  /xox[baprs]-[A-Za-z0-9-]{8,}/,
  /gh[pousr]_[A-Za-z0-9]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Returns the first secret-shaped match found anywhere in the value, or null. */
export function findSecretMaterial(value: unknown): string | null {
  const json = JSON.stringify(value) ?? '';
  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.exec(json);
    if (match) return match[0].slice(0, 12) + '…';
  }
  return null;
}

/** Upsert by entry name. Throws on secret material — the caller surfaces it. */
export function upsertManifestEntry(entry: PipeManifestEntry, cwd: string = process.cwd()): PipeManifest {
  const leaked = findSecretMaterial(entry);
  if (leaked) {
    throw new Error(
      `Refusing to write the manifest: value looks like secret material (${leaked}). ` +
      'The manifest is committed to the repo — reference keys by localKeyRef, never by value.',
    );
  }
  const manifest = readManifest(cwd);
  const index = manifest.pipes.findIndex((p) => p.name === entry.name);
  if (index >= 0) manifest.pipes[index] = entry;
  else manifest.pipes.push(entry);
  save(manifest, cwd);
  return manifest;
}

export function removeManifestEntry(name: string, cwd: string = process.cwd()): PipeManifest {
  const manifest = readManifest(cwd);
  manifest.pipes = manifest.pipes.filter((p) => p.name !== name);
  save(manifest, cwd);
  return manifest;
}

function save(manifest: PipeManifest, cwd: string): void {
  const dir = join(cwd, MANIFEST_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath(cwd), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}
