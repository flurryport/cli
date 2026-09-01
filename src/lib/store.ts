import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * THE ~/.flurryport store (hardening C4 + precedent 10): one read/write discipline
 * for every file under the CLI's home directory, replacing four hand-rolled
 * mkdir+serialize+write copies that had drifted apart on permissions - config.json
 * holds fp_ PATs and was written with the default umask (world-readable) while
 * keystore.json set 0600 for the same secret class.
 *
 * Guarantees:
 *  - directory created 0o700, file written 0o600 (POSIX; Windows ACLs are best-effort)
 *  - ATOMIC writes: serialize to a temp file in the same directory, then rename over
 *    the target - a crash mid-write can no longer truncate the file and wipe stored
 *    PATs/keys (the old writeFileSync-in-place corruption window)
 *  - an existing file's lax mode is healed on every save (the rename replaces the
 *    inode with the 0o600 temp file)
 */

/** ~/.flurryport, resolved at call time (tests re-point HOME/USERPROFILE). */
export function flurryStoreDir(): string {
  return join(homedir(), '.flurryport');
}

export function flurryStorePath(fileName: string): string {
  return join(flurryStoreDir(), fileName);
}

/** File-lock errors that clear in milliseconds (Windows AV/indexer holds). */
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EAGAIN', 'EACCES', 'EMFILE', 'ENFILE']);

/** Synchronous sleep for the lock-retry path - the store API is sync by design. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Round 3: most "locked" reads/writes clear within milliseconds (an AV scan, an
 * indexer pass), so the store absorbs them itself with three quick retries
 * instead of pushing lock handling to every one of its dozen callers. Only a
 * PERSISTENT failure escapes.
 */
function withLockRetries<T>(fn: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 2 || !code || !TRANSIENT_FS_CODES.has(code)) throw err;
      sleepSync(30);
    }
  }
}

/**
 * Parse a JSON store file; null when ABSENT or corrupt (the next save rewrites
 * it). A file that exists but cannot be read right now (EPERM/EBUSY) is retried
 * briefly, then THROWS (review finding 9): before this, a transient lock on
 * config.json read as a virgin config, and the next load-then-save path
 * atomically overwrote stored PATs with defaults. Secret stores let that throw
 * propagate loudly; presentation/convenience stores pass { lenient: true } and
 * degrade to null instead - the named option exists so the next convenience
 * store reaches for it rather than re-hand-rolling a try/catch.
 */
export function readJsonStore<T>(path: string, opts?: { lenient?: boolean }): T | null {
  let raw: string;
  try {
    raw = withLockRetries(() => readFileSync(path, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (opts?.lenient) return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJsonStore(path: string, data: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else {
    try {
      chmodSync(dir, 0o700); // heal a pre-discipline directory's lax mode
    } catch {
      /* best-effort on platforms without POSIX modes (Windows ACLs) */
    }
  }
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  withLockRetries(() => writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }));
  try {
    // The rename gets the same brief lock retries: on Windows a scanner holding
    // the TARGET fails the replace with EPERM even though the write succeeded.
    withLockRetries(() => renameSync(tmp, path));
  } catch (err) {
    try {
      unlinkSync(tmp); // never leave a secret-bearing temp file behind
    } catch {
      /* already gone */
    }
    throw err;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort on platforms without POSIX modes (Windows ACLs) */
  }
}

/** Remove a store file; absent is success. */
export function deleteStoreFile(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best-effort */
  }
}
