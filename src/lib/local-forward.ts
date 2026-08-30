import type { GetAnonCaptureResponse } from './anon-api.js';

/**
 * Client-side forward of one capture to the user's own machine (spec §4 / §12.6).
 * The server never sees this call, so the destination check lives HERE — acceptable
 * because the CLI is the user's trusted local process; the untrusted party is the
 * MODEL, which can only pass parameters this code validates. Default is loopback-only;
 * RFC1918 LAN targets require the human's explicit --allow-lan opt-in on the mcp
 * command. Link-local (169.254.x — cloud IMDS) is never allowed.
 */
export interface ForwardResult {
  statusCode: number;
  statusText: string;
  durationMs: number;
  responseHeaders: Record<string, string>;
  /** First 2KB of the response body as text — enough to debug, small enough for context. */
  responseBodyPreview: string;
  /** Parsed preview when it is complete JSON (echo mirrors always are); undefined otherwise. */
  responseJson?: unknown;
}

export type LocalUrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

export function validateLocalUrl(rawUrl: string, allowLan: boolean): LocalUrlVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `Not a valid URL: ${rawUrl}` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, reason: `Only http/https URLs are allowed (got ${url.protocol})` };

  const host = url.hostname.toLowerCase();

  if (isLoopbackHost(host)) return { ok: true, url };

  if (allowLan && isPrivateLanHost(host)) return { ok: true, url };

  return {
    ok: false,
    reason: allowLan
      ? `${host} is not a loopback or private-LAN address. forward_to_localhost only delivers to the user's own machine or LAN.`
      : `${host} is not a loopback address. forward_to_localhost only delivers to the user's own machine (localhost / 127.x / [::1]). Start the MCP server with --allow-lan to permit private LAN addresses.`,
  };
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '[::1]') return true;
  // 127.0.0.0/8
  const m = host.match(/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  return m !== null;
}

function isPrivateLanHost(host: string): boolean {
  // Literal RFC1918 only — DNS names (which could resolve anywhere) are never accepted,
  // and 169.254.0.0/16 (link-local / cloud metadata) is always refused.
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const m172 = host.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (m172) {
    const second = Number(m172[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

/** Hop-by-hop / transport headers that must not be replayed verbatim. */
const SKIP_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'accept-encoding',
  'keep-alive',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
]);

/**
 * Deliver the RAW captured bytes to the validated local URL with the original method
 * and headers. Faithful replay is sacred (spec §5.2a): whatever the provider sent is
 * what the local app receives — signatures stay verifiable.
 */
export async function forwardCaptureToLocal(
  capture: GetAnonCaptureResponse,
  url: URL,
  timeoutMs = 10_000,
): Promise<ForwardResult> {
  const headers: Record<string, string> = {};
  try {
    const parsed = JSON.parse(capture.Headers) as Record<string, string[]>;
    for (const [name, values] of Object.entries(parsed)) {
      if (!SKIP_HEADERS.has(name.toLowerCase())) headers[name] = values.join(', ');
    }
  } catch {
    /* unparseable headers — forward body-only */
  }

  const method = capture.HttpMethod.toUpperCase();
  const bodyAllowed = method !== 'GET' && method !== 'HEAD';
  const body = bodyAllowed && capture.Body ? Buffer.from(capture.Body, 'base64') : undefined;

  // Replay the original query string onto the local target.
  const target = new URL(url.toString());
  if (capture.QueryString && !target.search) target.search = capture.QueryString;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const res = await fetch(target, {
      method,
      headers,
      body: body as BodyInit | undefined,
      signal: controller.signal,
    });

    const durationMs = Date.now() - startedAt;
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });

    let fullText = '';
    try {
      fullText = await res.text();
    } catch {
      /* opaque body */
    }
    const preview = fullText.slice(0, 2048);

    // When the local response is JSON (echo mirrors always are), hand the agent the
    // parsed object too - the escaped preview is painful to relay cleanly. Parse the
    // FULL text, not the preview: truncation would break the parse.
    let responseJson: unknown;
    try {
      responseJson = JSON.parse(fullText) as unknown;
    } catch {
      /* non-JSON - preview stands alone */
    }

    return {
      statusCode: res.status,
      statusText: res.statusText,
      durationMs,
      responseHeaders,
      responseBodyPreview: preview,
      responseJson,
    };
  } finally {
    clearTimeout(timer);
  }
}
