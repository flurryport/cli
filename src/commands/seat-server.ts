import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveAuthBaseUrl } from '../lib/auth-api.js';
import { buildSeatServer } from '../lib/mcp-seat-tools.js';
import { serveMcpHttp } from '../lib/mcp-http.js';
import { consoleMessages } from '../lib/console-messages.js';
import { resolvePublicApiHost, resolveRoomsIdleMinutes, resolveRoomsStandingIdleMinutes } from '../lib/rooms.js';

/**
 * `flurryport seat-server` — the hosted-agent surface (0.5.0, #233). Streamable HTTP
 * only: every MCP session gets its OWN seat server (buildSeatServer per initialize),
 * so one process serves many principals with nothing shared between them. This is
 * deliberately NOT `flurryport mcp --http`: no operator config, no keystore, no anon
 * session — a session is nobody until its human ferries a pairing code in.
 */
export const seatServerCommand = new Command('seat-server')
  .description(
    'Run the FlurryPORT seat server (streamable HTTP): a hosted-agent MCP surface with room verbs only - ' +
    'each session redeems a seat pairing code and posts/reads as that seat',
  )
  .option(
    '--host <host>',
    'HTTP bind address. Loopback by default so nothing is exposed without an explicit choice; front ' +
    'a TLS tunnel or reverse proxy for remote clients and pass its public hostname via --allowed-hosts ' +
    '(or FLURRYPORT_MCP_ALLOWED_HOSTS)',
    '127.0.0.1',
  )
  .option('--port <port>', 'HTTP port', '8791')
  .option(
    '--allowed-hosts <hosts>',
    'comma-separated public hostnames accepted in the Host header: the tunnel or reverse-proxy host ' +
    'in front of this server. Loopback names always pass; FLURRYPORT_MCP_ALLOWED_HOSTS also adds to this list',
  )
  .option(
    '--api-url <url>',
    'FlurryPORT API base URL (FLURRYPORT_API_URL still wins; default https://api.flurryport.io)',
  )
  .option(
    '--idle-minutes <minutes>',
    'Close a session that has sent nothing for this long (FLURRYPORT_ROOMS_IDLE_MINUTES still wins; ' +
    'default 30). A redeemed seat also closes when the seat itself ends',
  )
  .action(async (opts: { host: string; port: string; apiUrl?: string; idleMinutes?: string; allowedHosts?: string }) => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };
    const apiBase = resolveAuthBaseUrl(opts.apiUrl);
    // #346: env wins over the flag, the same precedence --api-url gives FLURRYPORT_API_URL.
    const idleMinutes = resolveRoomsIdleMinutes(process.env.FLURRYPORT_ROOMS_IDLE_MINUTES ?? opts.idleMinutes);
    // #409 slice 6 (Q5): standing sessions are expiry-bounded only by default —
    // no idle reaping; FLURRYPORT_ROOMS_STANDING_IDLE_MINUTES can bound it.
    const standingIdleMinutes = resolveRoomsStandingIdleMinutes();
    // #358: the host this server presents on the captures it posts. Set only by
    // the hosted rooms service (FLURRYPORT_PUBLIC_API_HOST per environment); a
    // self-hosted seat server posts over the public API already and sends no marker.
    const publicHost = resolvePublicApiHost();

    console.error(chalk.dim(
      [
        `flurryport seat-server ${pkg.version}: the hosted-agent surface.`,
        'Room verbs only (list_captures, get_capture, post_intent) behind the pairing ceremony:',
        'each MCP session redeems its own seat code, and its credentials stay server-side for the',
        `session's life. API: ${apiBase}${publicHost ? ` (captures present ${publicHost})` : ''}. Idle sessions close after ${idleMinutes} min. Loopback by default; front with TLS for remote clients.`,
      ].join('\n'),
    ));

    // Standalone behavior unchanged: default signal handling stays ON, and the
    // command blocks until the server is down. THE CHAIR LEFT (#253 rider, #245
    // family) is the named refusal guests see while shutdown drains.
    const handle = await serveMcpHttp({
      host: opts.host,
      port: Number.parseInt(opts.port, 10),
      allowedHosts: opts.allowedHosts?.split(','),
      drainNotice: consoleMessages.chairLeft,
      idleMs: idleMinutes * 60_000,
      build: async () => buildSeatServer({ apiBase, version: pkg.version, publicHost, standingIdleMinutes }),
      // #288: the unauthenticated preflight. The standalone server learns its
      // room only at redemption, so room is honestly null here.
      whoami: () => ({
        server: 'flurryport-seat',
        version: pkg.version,
        room: null,
        seated: false,
        message: consoleMessages.whoamiUnseated,
      }),
    });
    await handle.closed;
  });
