import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isLoopbackHost } from './local-forward.js';

/**
 * The Streamable HTTP face of an MCP server (CLAUDE.chatgpt-mcp-requirements.md,
 * phase 1 / path A). stdio serves one session per process; HTTP serves many, so
 * every MCP session gets its OWN McpServer from the factory: its own anon session,
 * device-flow watcher, and claim flip, exactly the per-process state a stdio boot
 * would have had.
 *
 * Single-user semantics by design: concurrent sessions share the operator's
 * ~/.flurryport (anon-session resume, stored accounts) the same way two stdio
 * processes would. A multi-tenant hosted deployment needs per-session stores and a
 * stripped toolset (forward_to_localhost is SSRF from a pod). That is phase 3,
 * deliberately NOT this file.
 *
 * Binding defaults to loopback so nothing is exposed without an explicit --host;
 * the expected remote path is a tunnel (ngrok / a cloud provider's MCP tunnel)
 * fronting 127.0.0.1.
 *
 * 0.5.1 (#253): callable AS A LIBRARY. serveMcpHttp returns a handle whose
 * shutdown() the caller may own; registerSignalHandlers: false hands teardown to
 * the caller entirely (the console hosts the room in-process and drives shutdown
 * from its own exit paths). Standalone commands keep the default signal handling
 * and simply await handle.closed.
 */

export interface McpHttpOptions {
  host: string;
  port: number;
  /**
   * Builds a fresh per-session server; the banner describes its boot mode.
   * expiresAt (#346) reads the session's own end, if it has one: a seat server
   * reports its principal's seat expiry once redeemed, null before. The sweep
   * closes the session at that instant even if it is not idle.
   */
  build: () => Promise<{
    server: McpServer;
    banner: string;
    expiresAt?: () => string | null;
    /**
     * #409 slice 6: the session's OWN idle window, if it differs from the host
     * default. Read per sweep like expiresAt: null = use the host idleMs;
     * Infinity = never idle-reap (a standing seat: expiry is the one reaper).
     */
    idleMs?: () => number | null;
  }>;
  /**
   * Default true: the server registers its own SIGINT/SIGTERM handlers (the
   * standalone-command behavior). false = the caller owns teardown and calls
   * handle.shutdown() itself (#253: the console hosts the room and its exit paths
   * are the room's exit paths).
   */
  registerSignalHandlers?: boolean;
  /** Replaces the default stderr logger; the console routes these above its prompt. */
  log?: (line: string) => void;
  /**
   * The named refusal for requests that arrive while shutdown is draining
   * (the #245 friendly-errors family; the room passes THE CHAIR LEFT here).
   */
  drainNotice?: string;
  /**
   * Keep-alive period for held SSE streams (#287), milliseconds. A long tool
   * call (wait_for_posts holds 20-60s) writes nothing until it resolves, and
   * client sockets with a read timeout die mid-hold - a watcher was lost to
   * exactly that. Every open event-stream response gets an SSE comment line
   * (": keep-alive") on this period; comments are protocol-invisible to SSE
   * parsers and only keep the socket warm. Default 15000; tests shrink it.
   */
  keepAliveMs?: number;
  /**
   * Unauthenticated preflight payload served at GET /whoami (#288): server
   * identity, the room it serves, and the you-are-unseated line - reachable
   * with a bare GET, no MCP handshake, so an agent can prove the address it was
   * handed works BEFORE spending its single-use pairing code (a wrong-host
   * handoff nearly lost a seat permanently). Absent = /whoami 404s as before.
   */
  whoami?: () => Record<string, unknown>;
  /**
   * Idle eviction (#346, hosted rooms): a session that has sent nothing for this
   * many milliseconds is closed and dropped by the periodic sweep. Default 30
   * minutes. A hosted pod serves many seats for many sittings and nothing else
   * ever reaps a silent one; the standalone and console rooms inherit the same
   * bound, which is far beyond any real pause between calls.
   */
  idleMs?: number;
  /** Sweep period for eviction, milliseconds. Default 60000; tests shrink it. */
  sweepMs?: number;
  /**
   * Extra hostnames accepted in the Host and Origin headers (hardening precedent
   * #3): the tunnel or public room host this server is fronted by. Loopback names
   * and the bind host are always accepted. FLURRYPORT_MCP_ALLOWED_HOSTS
   * (comma-separated) adds more at run time. See the guard note below for when
   * the Host check is strict.
   */
  allowedHosts?: string[];
  /**
   * Exact origins (scheme://host[:port]) allowed to send an Origin header - i.e.
   * browser-based MCP clients the operator deliberately points here (MCP
   * Inspector). Any OTHER present Origin is refused, 'null' included.
   * FLURRYPORT_MCP_ALLOWED_ORIGINS (comma-separated) adds more at run time.
   */
  allowedOrigins?: string[];
}

export interface McpHttpHandle {
  /** The MCP endpoint URL with the ACTUAL bound port (port 0 asks the OS). */
  url: string;
  port: number;
  /**
   * Graceful teardown, idempotent: drain (close every live session transport and
   * server properly), then close the listener and sever lingering keep-alive
   * sockets. Never throws.
   */
  shutdown: () => Promise<void>;
  /** Resolves once the server is fully down, whether by signal or by shutdown(). */
  closed: Promise<void>;
  /** Live session count (#346): what the eviction sweep has not yet reaped. */
  activeSessions: () => number;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** The one guarded closer both the per-session and shutdown paths use (#254). */
  close: () => Promise<void>;
  /** Last request seen on this session, epoch ms (#346 idle eviction). */
  lastActivity: number;
  /** The session's own end, if the server knows one (a redeemed seat's expiry). */
  expiresAt?: () => string | null;
  /** The session's own idle window (#409): null = host default; Infinity = no idle reaping. */
  idleMs?: () => number | null;
}

const DEFAULT_DRAIN_NOTICE = 'The server is shutting down; no new requests are accepted.';

/** #287: default SSE keep-alive period. Under common 30-60s socket read timeouts. */
const DEFAULT_KEEPALIVE_MS = 15000;

/** #346: default idle life of a session before the sweep closes it. */
const DEFAULT_IDLE_MS = 30 * 60_000;

/** #346: how often the sweep looks for idle or expired sessions. */
const DEFAULT_SWEEP_MS = 60_000;

/**
 * Arm the keep-alive on one response (#287): while the response is an OPEN SSE
 * stream, write a comment frame every period. Comment lines (leading ':') are
 * ignored by every SSE parser, so nothing changes on the protocol - the bytes
 * only reset the client socket's read timer during a long tool hold. JSON
 * responses never match the content-type check and are untouched; the timer
 * dies with the response.
 */
function armKeepAlive(res: ServerResponse, periodMs: number): void {
  // The SDK's transport hands its headers straight to writeHead (via hono's
  // request listener), so res.getHeader never sees them - the content-type is
  // sniffed as it goes past instead.
  let sse = false;
  const markIfSse = (value: unknown): void => {
    const text = Array.isArray(value) ? value.join(',') : String(value ?? '');
    if (text.includes('text/event-stream')) sse = true;
  };
  const sniffHeaders = (arg: unknown): void => {
    if (arg === null || typeof arg !== 'object') return;
    if (Array.isArray(arg)) {
      // The raw [name, value, name, value] and [[name, value], ...] forms.
      for (let i = 0; i < arg.length; i++) {
        const entry: unknown = arg[i];
        if (Array.isArray(entry) && String(entry[0]).toLowerCase() === 'content-type') markIfSse(entry[1]);
        else if (typeof entry === 'string' && entry.toLowerCase() === 'content-type') markIfSse(arg[i + 1]);
      }
      return;
    }
    for (const [name, value] of Object.entries(arg as Record<string, unknown>)) {
      if (name.toLowerCase() === 'content-type') markIfSse(value);
    }
  };
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = ((...args: unknown[]) => {
    for (const arg of args.slice(1)) sniffHeaders(arg);
    return (originalWriteHead as (...a: unknown[]) => ServerResponse)(...args);
  }) as typeof res.writeHead;
  const originalSetHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: unknown) => {
    if (String(name).toLowerCase() === 'content-type') markIfSse(value);
    return (originalSetHeader as (n: string, v: unknown) => ServerResponse)(name, value);
  }) as typeof res.setHeader;

  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(timer);
      return;
    }
    if (!res.headersSent || !sse) return;
    res.write(': keep-alive\n\n');
  }, periodMs);
  timer.unref?.();
  res.once('close', () => clearInterval(timer));
}

/** Hostname out of a Host header value or origin URL; null when unparseable. */
function headerHostname(rawHost: string): string | null {
  try {
    return new URL(`http://${rawHost}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * ONE origin normalization for both the allowlist build and the incoming-header
 * check (round 3): URL.origin drops default ports, so an operator who configures
 * "https://rooms.example.com:443" still matches the browser's Origin header,
 * which omits the default port. Unparseable values keep their trimmed form
 * (they can then only match an identically-unparseable configured value).
 */
function normalizeOrigin(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/\/$/, '');
  try {
    return new URL(trimmed).origin.toLowerCase();
  } catch {
    return trimmed;
  }
}

export async function serveMcpHttp(opts: McpHttpOptions): Promise<McpHttpHandle> {
  const sessions = new Map<string, SessionEntry>();
  const log = opts.log ?? ((line: string) => console.error(chalk.dim(line)));
  const drainNotice = opts.drainNotice ?? DEFAULT_DRAIN_NOTICE;
  const keepAliveMs = opts.keepAliveMs ?? DEFAULT_KEEPALIVE_MS;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  let draining = false;

  // ── Transport guard (hardening precedent #3, tightened by the review round) ──
  // DNS rebinding drives a victim's BROWSER at a loopback-bound server under an
  // attacker-controlled Host; no expected MCP client is a browser at all.
  //
  // HOST: strict when bound to loopback (the rebinding-vulnerable case; loopback
  // per local-forward's shared isLoopbackHost - 127/8, *.localhost, ::1) or when
  // an allowlist is configured. Loopback names, the bind host, allowedHosts, and
  // FLURRYPORT_MCP_ALLOWED_HOSTS pass; the refusal names the escape hatch, since
  // a tunnel-fronted loopback server (the documented remote topology) forwards
  // the public hostname and MUST configure it. A non-loopback bind with no
  // allowlist keeps accepting any Host (the hosted pod sits behind ingress+TLS).
  //
  // ORIGIN: any PRESENT Origin header is a browser talking to us and is refused
  // - including the literal "null" (sandboxed iframes, data:/file: pages) and
  // including loopback origins (a page on another local port is still a browser)
  // - unless the exact origin is allowlisted via allowedOrigins /
  // FLURRYPORT_MCP_ALLOWED_ORIGINS (full-origin match, for browser-based tools
  // like the MCP Inspector that the operator deliberately points here).
  //
  // Session-id -> principal binding is the Track B OAuth lane; until an account
  // credential exists there is nothing second to bind a session to.
  const extraHosts = new Set(
    [
      ...(opts.allowedHosts ?? []),
      ...(process.env.FLURRYPORT_MCP_ALLOWED_HOSTS ?? '').split(','),
    ]
      .map((h) => headerHostname(h.trim()))
      .filter((h): h is string => !!h),
  );
  const allowedOrigins = new Set(
    [
      ...(opts.allowedOrigins ?? []),
      ...(process.env.FLURRYPORT_MCP_ALLOWED_ORIGINS ?? '').split(','),
    ]
      .map((o) => (o.trim() ? normalizeOrigin(o) : ''))
      .filter(Boolean),
  );
  const bindHost = opts.host.toLowerCase();
  const strictHostCheck = isLoopbackHost(bindHost) || extraHosts.size > 0;
  const hostAllowed = (hostname: string | null): boolean =>
    hostname !== null && (isLoopbackHost(hostname) || hostname === bindHost || extraHosts.has(hostname));

  const HOST_REFUSAL_HINT =
    ' If this server is fronted by a tunnel or reverse proxy, allow its public hostname via ' +
    'FLURRYPORT_MCP_ALLOWED_HOSTS (comma-separated) or the --allowed-hosts flag.';

  /** Refusal reason for a request that fails the guard, or null to proceed. */
  function refuseTransport(req: IncomingMessage, checkHost: boolean): string | null {
    if (checkHost && strictHostCheck) {
      const host = headerHostname(firstHeader(req.headers.host) ?? '');
      if (!hostAllowed(host)) {
        return `Host "${host ?? '(unparseable)'}" is not allowed on this server.` + HOST_REFUSAL_HINT;
      }
    }
    const origin = firstHeader(req.headers.origin);
    if (origin && !allowedOrigins.has(normalizeOrigin(origin))) {
      return (
        'Browser requests are not accepted by this server. If you are deliberately using a ' +
        'browser-based MCP client, allow its exact origin via FLURRYPORT_MCP_ALLOWED_ORIGINS.'
      );
    }
    return null;
  }

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log(`mcp http: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    // Precedent #3: everything past the health probe passes the transport guard.
    // /whoami skips only the HOST half: it is the #288 preflight an agent hits
    // BEFORE the operator has necessarily configured the tunnel host, it has no
    // side effects, and a rebound browser cannot read the cross-origin response
    // anyway - the Origin half (browsers refused) still applies to it.
    const refusal = refuseTransport(req, url.pathname !== '/whoami');
    if (refusal) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: refusal }, id: null }));
      return;
    }
    // #288: the unauthenticated preflight. Cheap by design - no session, no MCP
    // handshake, nothing spent - so a joining agent can verify reachability and
    // identity before redeeming. GET only; anything else falls through to the
    // 404 below like every other unknown path.
    if (url.pathname === '/whoami' && opts.whoami && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(opts.whoami()));
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found (MCP endpoint is /mcp)');
      return;
    }

    // #287: every /mcp response that turns into a held SSE stream (a long tool
    // call, the standalone GET channel) gets periodic keep-alive comments.
    armKeepAlive(res, keepAliveMs);

    // Draining: the room is going down. Anything still arriving gets the named
    // refusal instead of a severed socket (#253 rider, #245 family).
    if (draining) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: drainNotice }, id: null }));
      return;
    }

    const sessionId = firstHeader(req.headers['mcp-session-id']);
    if (sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found; reinitialize.' },
          id: null,
        }));
        return;
      }
      entry.lastActivity = Date.now();
      await entry.transport.handleRequest(req, res);
      return;
    }

    // No session header: only an initialize POST may open a session.
    if (req.method !== 'POST') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Missing mcp-session-id; POST an initialize request to open a session.' },
        id: null,
      }));
      return;
    }

    const { server, banner, expiresAt, idleMs: sessionIdleMs } = await opts.build();
    let entry: SessionEntry;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, entry);
        log(`mcp session ${sid.slice(0, 8)}… opened: ${banner} (${sessions.size} active)`);
      },
      onsessionclosed: (sid) => {
        sessions.delete(sid);
        log(`mcp session ${sid.slice(0, 8)}… closed (${sessions.size} active)`);
      },
    });
    // #254: transport.onclose used to call server.close() directly, and the SDK's
    // Server.close() closes the transport, which re-fires onclose. Mutual recursion,
    // RangeError at SIGINT with a session open. The guard is twofold: a closing
    // flag makes the closer idempotent, and clearing transport.onclose BEFORE
    // server.close() means the SDK's own transport close can never re-enter. Both
    // the per-session path (client DELETE / transport error) and the shutdown path
    // run through this one closer.
    let closing = false;
    entry = {
      transport,
      server,
      lastActivity: Date.now(),
      expiresAt,
      idleMs: sessionIdleMs,
      close: async () => {
        if (closing) return;
        closing = true;
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
        transport.onclose = undefined;
        try { await transport.close(); } catch { /* already closed */ }
        try { await server.close(); } catch { /* already closed */ }
      },
    };
    transport.onclose = () => { void entry.close(); };

    await server.connect(transport);
    await transport.handleRequest(req, res);
    // A POST that was not a valid initialize never assigned a session id; reap the
    // orphan server instead of leaking one per bad request.
    if (!transport.sessionId) void entry.close();
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, opts.host, resolve);
  });
  // Report the ACTUAL bound port: --port 0 asks the OS for an ephemeral one.
  const bound = httpServer.address();
  const boundPort = bound !== null && typeof bound === 'object' ? bound.port : opts.port;
  const url = `http://${opts.host}:${boundPort}/mcp`;
  log(
    `flurryport mcp: streamable HTTP on ${url} (health: /healthz). ` +
    'Loopback by default; front a tunnel for remote clients.',
  );

  // #346: the eviction sweep. Idle past the limit, or a seat past its own expiry,
  // runs through the same guarded closer a client DELETE would. unref so the
  // timer never holds a process open on its own; shutdown clears it anyway.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of sessions) {
      const idle = now - entry.lastActivity;
      const end = entry.expiresAt?.() ?? null;
      const endMs = end === null ? Number.NaN : Date.parse(end);
      const expired = Number.isFinite(endMs) && endMs <= now;
      // #409: a session may carry its OWN idle window (a standing seat answers
      // Infinity — expiry is its one reaper); null falls back to the host default.
      const sessionIdle = entry.idleMs?.() ?? null;
      const idleLimit = sessionIdle ?? idleMs;
      if (idle < idleLimit && !expired) continue;
      const why = expired ? 'seat expired' : `idle ${Math.round(idle / 60_000)} min`;
      log(`mcp session ${sid.slice(0, 8)}… evicted (${why}; ${sessions.size - 1} active)`);
      void entry.close();
    }
  }, opts.sweepMs ?? DEFAULT_SWEEP_MS);
  sweep.unref?.();

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      draining = true;
      clearInterval(sweep);
      // Drain: every live session transport and server closes PROPERLY, so
      // in-flight SSE streams and responses terminate instead of being severed
      // mid-write. The guarded closer makes this safe against #254 re-entry.
      await Promise.all([...sessions.values()].map((entry) => entry.close().catch(() => undefined)));
      sessions.clear();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        // Lingering keep-alive sockets would hold close() open forever; their
        // requests were already answered (or refused by the drain gate).
        httpServer.closeIdleConnections();
        httpServer.closeAllConnections();
      });
      resolveClosed();
    })();
    return shutdownPromise;
  };

  if (opts.registerSignalHandlers !== false) {
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
  }

  return { url, port: boundPort, shutdown, closed, activeSessions: () => sessions.size };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
