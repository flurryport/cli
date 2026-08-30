import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

/**
 * Mirrors Core.Logic's UrlDeliveryClassifier: returns true for any URL whose
 * host resolves to a loopback / RFC1918 / link-local / CGNAT / ULA / IPv4-mapped /
 * NAT64-translated address. The server uses the same rule to decide which
 * replay executions go on the CLI work queue vs. the standalone (server-side)
 * processor. The CLI's discovery step has to match so users see every target
 * the server expects them to forward.
 *
 * DNS resolution is via the OS resolver. Unresolvable hosts return false
 * (let the server's dead-letter sweep handle them).
 */
export async function isLocalTarget(url: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (!host) return false;

  // `localhost` is a magic name in every OS resolver; shortcut without a lookup.
  if (host.toLowerCase() === 'localhost') return true;

  // IP literal — classify directly.
  const family = isIP(host);
  if (family !== 0) return isLocalIp(host);

  // Otherwise resolve via DNS and check every returned address.
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.some((a) => isLocalIp(a.address));
  } catch {
    return false;
  }
}

function isLocalIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isLocalIPv4(ip);
  if (family === 6) return isLocalIPv6(ip);
  return false;
}

function isLocalIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  // 0.0.0.0/8 — "this network"
  if (a === 0) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 10.0.0.0/8 — RFC1918
  if (a === 10) return true;
  // 172.16.0.0/12 — RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — RFC1918
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local (includes cloud IMDS 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 — CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isLocalIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // ::1 — loopback (Node sometimes returns the compressed form, sometimes "::1")
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  // ::ffff:x.x.x.x — IPv4-mapped (some OS resolvers return loopback this way)
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7);
    if (isIP(v4) === 4) return isLocalIPv4(v4);
  }
  // Parse the first hextet for fe80::/10 and fc00::/7 prefix checks.
  const firstColon = lower.indexOf(':');
  const head = parseInt(firstColon === -1 ? lower : lower.slice(0, firstColon), 16);
  if (Number.isNaN(head)) return false;
  // fe80::/10 — link-local
  if ((head & 0xffc0) === 0xfe80) return true;
  // fc00::/7 — unique-local
  if ((head & 0xfe00) === 0xfc00) return true;
  return false;
}
