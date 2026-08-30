/**
 * Node's fetch() throws an opaque `TypeError: fetch failed` when the underlying
 * undici client can't connect; the real reason lives on `error.cause` (or
 * `error.cause.errors` for AggregateError). This pulls the useful bit out and
 * turns common system errors into human-readable strings so the CLI's failure
 * line tells you why instead of "fetch failed".
 */
export function friendlyFetchError(err: Error): string {
  const cause = (err as { cause?: unknown }).cause as
    | { code?: string; hostname?: string; message?: string; errors?: Array<{ code?: string }> }
    | undefined;
  if (!cause) return err.message;
  const code = cause.code ?? cause.errors?.[0]?.code;

  switch (code) {
    case 'ECONNREFUSED':
      return 'connection refused (is your local server running?)';
    case 'ENOTFOUND':
      return `host not found (${cause.hostname ?? '?'})`;
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
      return code ? `${code}: ${cause.message ?? err.message}` : err.message;
  }
}
