/**
 * Node's fetch() throws an opaque `TypeError: fetch failed` when the underlying
 * undici client can't connect; the real reason lives on `error.cause` (or
 * `error.cause.errors` for AggregateError). This pulls the useful bit out and
 * turns common system errors into human-readable strings so the CLI's failure
 * line tells you why instead of "fetch failed".
 */
/**
 * Fold a ValidationProblem `errors` dict ({ Field: ["msg", ...] }) into the detail
 * string so validation failures TEACH the expected shape instead of answering
 * "Validation error" (agents self-correct from field messages; they cannot from a
 * label). Shared by every API client's error parse.
 */
export function appendFieldErrors(detail: string, errors: unknown): string {
  if (!errors || typeof errors !== 'object') return detail;
  const parts: string[] = [];
  for (const [field, messages] of Object.entries(errors as Record<string, unknown>)) {
    const list = Array.isArray(messages) ? messages.filter((m) => typeof m === 'string') : [];
    if (list.length) parts.push(`${field}: ${list.join(' ')}`);
  }
  return parts.length ? `${detail} ${parts.join(' | ')}`.trim() : detail;
}

export interface ParsedProblem {
  /** Machine error code: the server's own (e.g. proof_stale) or a status-derived fallback. */
  code: string;
  /** Human-readable detail, with any ValidationProblem field errors folded in. Always a string. */
  detail: string;
  /**
   * True when the body parsed as a JSON object - detail is then server-authored
   * prose. False means detail is the RAW body text (an ingress HTML error page,
   * a proxy string): fine for logs, not for quoting as "the server's sentence".
   */
  isJson: boolean;
}

const STATUS_FALLBACK_CODES: Record<number, string> = {
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'throttled',
};

/**
 * THE ProblemDetails parse - the one place the server's error body becomes
 * {code, detail}. Every API client in this CLI must route non-OK bodies through
 * here; the five hand-rolled copies this replaces had drifted apart (dropped
 * machine codes, dropped field errors, dropped title fallbacks), which left the
 * standing-release paths unable to tell authorization_pending from a dead grant.
 *
 * TypedApplicationResult problems carry the machine code in "type" (non-URL) or a
 * code-shaped "title"; plain ProblemDetails carries prose in "detail"/"title";
 * some legacy endpoints answer { Error }. Non-JSON bodies keep the raw text.
 */
export function parseProblemDetails(status: number, text: string): ParsedProblem {
  let code = STATUS_FALLBACK_CODES[status] ?? 'error';
  let detail = text;
  let isJson = false;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw !== null && typeof raw === 'object') {
      isJson = true;
      // Round 3: only STRING fields become the detail - a drifted endpoint or
      // proxy answering {"detail": {...}} used to flow the object through the
      // cast and blow up the first .trim() downstream.
      const candidates = [raw.detail, raw.Error, raw.title].filter(
        (v): v is string => typeof v === 'string',
      );
      detail = candidates[0] ?? text;
      detail = appendFieldErrors(detail, raw.errors);
      if (typeof raw.type === 'string' && !raw.type.startsWith('http')) code = raw.type;
      else if (typeof raw.title === 'string' && /^[a-z_]+$/.test(raw.title)) code = raw.title;
    }
  } catch {
    /* not JSON - keep the raw text as the detail */
  }
  return { code, detail, isJson };
}

/** parseProblemDetails over a fetch Response whose !res.ok already fired. */
export async function parseErrorResponse(res: Response): Promise<ParsedProblem> {
  const text = await res.text().catch(() => '');
  return parseProblemDetails(res.status, text);
}

/**
 * The system/undici error code buried in an error or its cause chain; null when
 * none. THE one cause-walk (review finding 6's rider) - friendlyFetchError and
 * sanitizeOutboundError both read it, so a new undici error layout gets learned
 * in one place.
 */
export function systemErrorCode(err: unknown): string | null {
  const cause =
    err instanceof Error
      ? ((err as { cause?: unknown }).cause as { code?: string; errors?: Array<{ code?: string }> } | undefined)
      : undefined;
  const code = cause?.code ?? cause?.errors?.[0]?.code ?? (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : null;
}

/**
 * Codes that genuinely mean "the network/upstream failed" - retrying can help.
 * Undici codes are enumerated, NOT matched by prefix (round 3): the UND_ERR
 * family also contains permanent programming errors (UND_ERR_INVALID_ARG,
 * UND_ERR_REQ_CONTENT_LENGTH_MISMATCH) that must not invite a retry loop.
 */
const TRANSPORT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

// Where the real error surfaces for the OPERATOR (review finding 7): stderr by
// default (pod logs, stdio MCP's log channel), but the in-process console room
// re-points this at its frontend note line so raw errors never splatter across
// the readline UI mid-session.
let outboundErrorLog: (line: string) => void = (line) => console.error(line);
export function setOutboundErrorLog(log: (line: string) => void): void {
  outboundErrorLog = log;
}

/**
 * Outbound-safe rendering of an UNKNOWN error for a tool result (hardening
 * precedent #8). Typed API errors (AuthApiError, AnonApiError, SeatRedeemError)
 * carry server-authored detail and stay verbatim - this is for everything else:
 * a raw undici/system error's message names internal infrastructure
 * ("connect ECONNREFUSED 10.0.x.x:8083"), and on the hosted seat server that
 * message would reach a remote seated party, bypassing the #358 publicHost
 * guard. Only KNOWN transport codes map to the retryable upstream_unreachable
 * (review finding 6: any other coded error - ERR_INVALID_URL, ERR_INVALID_ARG_TYPE -
 * is a permanent bug and must not invite a retry loop); everything else stays a
 * generic error. The real error goes to the operator log, never into the result.
 */
export function sanitizeOutboundError(err: unknown): { code: string; message: string } {
  outboundErrorLog(`[outbound-error] ${err instanceof Error ? err.message : String(err)}`);
  const code = systemErrorCode(err);
  if (code && TRANSPORT_ERROR_CODES.has(code)) {
    return {
      code: 'upstream_unreachable',
      message: 'Could not reach the API from this server (connection failed). Try again shortly.',
    };
  }
  return { code: 'error', message: 'An unexpected error occurred on this server.' };
}

export function friendlyFetchError(err: Error): string {
  // Round 3: no early return on a missing cause - systemErrorCode also reads a
  // top-level err.code, so a bare ECONNREFUSED error gets the friendly words too.
  const cause = (err as { cause?: unknown }).cause as { hostname?: string; message?: string } | undefined;
  const code = systemErrorCode(err);

  switch (code) {
    case 'ECONNREFUSED':
      return 'connection refused (is your local server running?)';
    case 'ENOTFOUND':
      return `host not found (${cause?.hostname ?? '?'})`;
    case 'ETIMEDOUT':
      return 'connection timed out';
    case 'ECONNRESET':
      return 'connection reset by peer';
    case 'EHOSTUNREACH':
      return 'host unreachable';
    case 'ENETUNREACH':
      return 'network unreachable';
    case 'EAI_AGAIN':
      return 'DNS temporary failure (try again)';
    // Undici's own codes (Node's fetch engine) - the raw names are noise to a
    // human, so they map to the same plain words as their syscall cousins.
    case 'UND_ERR_CONNECT_TIMEOUT':
      return 'connection timed out before the server answered';
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return 'the server went quiet mid-response (timeout)';
    case 'UND_ERR_SOCKET':
      return 'the connection dropped mid-request';
    default:
      return code ? `${code}: ${cause?.message ?? err.message}` : err.message;
  }
}
