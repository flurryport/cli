import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { MetaNotice } from './mcp-meta.js';

/**
 * Version-staleness nudge (ratified 2026-08-03). The CLI stamps its own package version
 * on every Core API request; when the server's LATEST_CLI_VERSION says this CLI is
 * stale, it answers with a ready-to-relay notice header. The API clients latch the
 * header here and the meta builders surface it as `meta.notice` on EVERY tool response
 * (no dedupe - the experiment is whether agents act on it unprompted, so it must stay
 * visible, not fire once and vanish). The server owns both the verdict and the message
 * text; this module adds no coaching of its own.
 */

/** Request header carrying this CLI's package version. */
export const CLI_VERSION_HEADER = 'X-FlurryPort-Cli-Version';

/** Response header carrying the server-composed staleness notice. */
export const CLI_NOTICE_HEADER = 'X-FlurryPort-Cli-Notice';

// Read version from package.json so there's a single source of truth (same rationale
// as index.ts's --version: a forgotten literal shipped 0.1.5 printing 0.1.4).
// dist/lib/version-nudge.js -> package root is two levels up.
function readOwnVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    // Unreadable package.json reads as stale server-side - a nudge, never a crash.
    return '0.0.0';
  }
}

const ownVersion = readOwnVersion();

/** Header block the API clients spread into every request's headers. */
export function versionHeader(): Record<string, string> {
  return { [CLI_VERSION_HEADER]: ownVersion };
}

/**
 * The latch mirrors the most recent Core response: header present = notice on, header
 * absent = notice off (server flipped the feature off, or this CLI is current again).
 */
let latchedNotice: string | null = null;

/** Called by the API clients on every Core response. */
export function recordCliNotice(res: Response): void {
  latchedNotice = res.headers.get(CLI_NOTICE_HEADER);
}

/** Numeric-dotted semver compare; returns negative/zero/positive like a comparator. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Self-nag guard (pilot-1 ledger item 9: a 0.3.3 CLI was nagged to upgrade to 0.3.3).
 * The server owns the verdict, but when its message NAMES target versions and none of
 * them is newer than this CLI, relaying it would coach an upgrade to nowhere - drop it.
 * A message naming no version at all is passed through untouched (the server may have
 * a reason we cannot parse).
 */
function isSelfNag(message: string): boolean {
  const versions = message.match(/\d+\.\d+\.\d+/g);
  if (!versions || versions.length === 0) return false;
  return versions.every((v) => compareVersions(v, ownVersion) <= 0);
}

/**
 * The meta builders' lowest-precedence notice: fills the slot whenever no one-time
 * notice (milestone, claim, write-grant) claimed it, so a stale CLI sees it on
 * effectively every call.
 */
export function takeCliUpdateNotice(): MetaNotice | null {
  if (!latchedNotice || isSelfNag(latchedNotice)) return null;
  return { code: 'cli_update_available', message: latchedNotice };
}
