import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import chalk from 'chalk';
import { loadConfig, resolveContext } from '../lib/config.js';
import { AuthApiError, createAuthApiClient, resolveAuthBaseUrl } from '../lib/auth-api.js';
import { createRoomApi } from '../lib/console-room.js';
import { ConsoleEngine, type RoomHost } from '../lib/console-engine.js';
import { consoleMessages as msg } from '../lib/console-messages.js';
import { friendlyFetchError, setOutboundErrorLog } from '../lib/fetch-error.js';
import { serveMcpHttp, type McpHttpHandle } from '../lib/mcp-http.js';
import { buildSeatServer } from '../lib/mcp-seat-tools.js';
import { resolveRoomsStandingIdleMinutes } from '../lib/rooms.js';
import { AttentionRelay } from '../lib/attention-relay.js';
import { PresenceLedger } from '../lib/presence.js';
import { supportedPalette } from './console-render.js';
import { jsonFrontend, terminalFrontend, type ConsoleFrontend } from './console-frontend.js';

/**
 * `flurryport console` - the chair (Refinement 8, tier 1, #241). This file owns
 * the SESSION and nothing else: config, the engine, the in-process room, the feed
 * poll, teardown. It never touches stdin or stdout - every byte a human or a
 * plugin sees goes through a ConsoleFrontend (console-frontend.ts), so a second
 * frontend costs a file and changes nothing here.
 *
 * `--json` is that second frontend (0.5.2): NDJSON out, bare lines in, built for
 * the nvim plugin. Every stdout line is one ConsoleEvent, the same typed union the
 * engine already emits, after an opening `hello` carrying the version.
 *
 * THE CONSOLE HOSTS THE ROOM (#253, 0.5.1): this file also owns the in-process
 * seat server handle - serveMcpHttp called as a library, NEVER a spawned child
 * (Windows orphan grounds; the CLI stays child_process free). The engine asks for
 * the room through the injected RoomHost seam on the first :seat mint; signals,
 * teardown, and process.exit all live HERE, on this side of the engine seam.
 *
 * Deliberately agent-free (ratified): the console renders and relays; nothing in
 * it generates content. It is the one surface that never hallucinates.
 */

/** The familiar seat-server port; a busy port falls back to an OS-picked one. */
const ROOM_DEFAULT_PORT = 8791;

/** The feed poll's backoff ladder on transient trouble (#245): report once, retry quietly. */
const POLL_BACKOFF_BASE_MS = 5000;
const POLL_BACKOFF_MAX_MS = 60000;

/** How long teardown lets already-accepted commands finish before it stops waiting. */
const SHUTDOWN_DRAIN_MS = 10000;

/**
 * The bare reason for a failure (#245): API answers map by status, transport
 * failures through the undici-aware fetch mapper. Raw stacks never hit the feed.
 */
function errorReason(err: unknown): string {
  if (err instanceof AuthApiError) {
    switch (err.status) {
      case 401: return msg.http401;
      case 403: return msg.http403(err.detail);
      case 404: return msg.http404(err.detail);
      case 429: return msg.http429;
      default: return msg.httpOther(err.status, err.detail);
    }
  }
  return friendlyFetchError(err instanceof Error ? err : new Error(String(err)));
}

/** The standalone friendly line: transport reasons get the net-trouble wrapper. */
function describeError(err: unknown): string {
  return err instanceof AuthApiError ? errorReason(err) : msg.netTrouble(errorReason(err));
}

export const consoleCommand = new Command('console')
  .description('Open the room console (the chair): tail the feed, post as yourself, seat and steer the crew')
  .option('--account <name>', 'Use a specific stored account for this session')
  .option('--environment <name>', 'Use a specific environment for this session')
  .option('--json', 'Speak NDJSON instead of drawing a terminal: one ConsoleEvent per line, bare command lines in')
  .action(async (opts: { account?: string; environment?: string; json?: boolean }) => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };

    const config = loadConfig();
    const context = resolveContext(config, { environment: opts.environment, account: opts.account });
    const apiBase = resolveAuthBaseUrl(context.apiUrl);
    const client = createAuthApiClient(apiBase, context.apiKey);

    const frontend: ConsoleFrontend = opts.json ? jsonFrontend() : terminalFrontend();
    let closed = false;

    frontend.greet(pkg.version, [msg.banner(pkg.version), msg.unbound]);

    // ── the in-process room (#253) ─────────────────────────────────────────────
    // Lazy: nothing binds until the engine's first :seat mint asks. serveMcpHttp
    // runs with signal handling OFF; this file owns teardown, so every exit path
    // takes the room down because the room IS this process.
    let roomHandle: McpHttpHandle | null = null;
    // The attention relay (slice C): shared between the engine's orders (via the
    // RoomHost seam below) and the in-process seat server's meta assembly.
    const attention = new AttentionRelay();
    // The presence ledger (#266): the seat server writes transport contact in,
    // the engine reads live/idle/adrift out - the same two-sided seam as the relay.
    const presence = new PresenceLedger();
    // The #288 preflight names the room this console serves; the engine is
    // constructed below, and the room only ever starts from an engine act, so
    // the lazy read can never run before it exists.
    const boundRoom = (): string | null => {
      const room = engine.roomInfo();
      return room ? `${room.projectSlug}/${room.endpointSlug}` : null;
    };
    // Review finding 7: sanitized outbound errors log through the same seam as
    // the room's own lines - never raw stderr across the readline UI mid-session.
    setOutboundErrorLog((line) => frontend.note(line));
    const startRoom = (port: number): Promise<McpHttpHandle> =>
      serveMcpHttp({
        host: '127.0.0.1',
        port,
        registerSignalHandlers: false,
        drainNotice: msg.chairLeft,
        log: (line) => frontend.note(line),
        build: async () => buildSeatServer({ apiBase, version: pkg.version, attention, presence, room: boundRoom, standingIdleMinutes: resolveRoomsStandingIdleMinutes() }),
        // #288: the unauthenticated preflight, room-aware when this console hosts.
        // #358 class: the preflight is unauthenticated, so it names the room and
        // never the API base behind it (the seat-server command dropped it in 0.5.5).
        whoami: () => ({
          server: 'flurryport-seat',
          version: pkg.version,
          room: boundRoom(),
          seated: false,
          message: msg.whoamiUnseated,
        }),
      });
    const roomHost: RoomHost = {
      async ensureStarted() {
        if (roomHandle) return { url: roomHandle.url, started: false };
        try {
          roomHandle = await startRoom(ROOM_DEFAULT_PORT);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          if (code !== 'EADDRINUSE') throw err;
          roomHandle = await startRoom(0); // busy port: let the OS pick, the pass tells the truth
        }
        return { url: roomHandle.url, started: true };
      },
      orderAttention(participantNames, order) {
        for (const name of participantNames) attention.set(name, order);
      },
    };

    // The engine gets the palette the CLIENT can render (capability aware,
    // ratified). Under --json that client is not this terminal - stdout is a pipe
    // and chalk would report 16 colors - so the full set goes out and the driving
    // program decides what it can paint.
    const engine = new ConsoleEngine(createRoomApi(client), roomHost, {
      palette: supportedPalette(opts.json ? 3 : chalk.level),
      presence,
    });

    // ── graceful teardown (#253): :exit, :quit, :q, Ctrl+C, and Ctrl+D all ride
    // this ONE path - drain the long-poll, shut the room down, say goodbye, exit.
    // Commands run ONE AT A TIME, in the order they arrive: readline fires 'line'
    // the moment a line lands, so without this chain a driving program that sends
    // two commands together races them (found on the first --json run: ":list
    // projects" then ":exit" lost the listing entirely).
    let queue: Promise<void> = Promise.resolve();
    let pollController: AbortController | null = null;
    let shuttingDown = false;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      // Commands already ACCEPTED get to finish. stdin ending is how a driving
      // program says "no more input", not "abandon what I just sent" - a piped
      // session hits EOF a microsecond behind its last command. Bounded, so a
      // wedged command cannot hold the room open. An :exit calling in from the
      // queue is safe: it fires this without awaiting, so its own item resolves.
      await Promise.race([queue.catch(() => undefined), sleep(SHUTDOWN_DRAIN_MS)]);
      closed = true;
      const hosted = roomHandle !== null;
      // #292: clean exits leave their reason on the durable room log. This must
      // ride before aborting the feed and before the room's drain gate closes,
      // so holding seats can observe the chair's fp:bye dismissal.
      if (hosted) {
        try {
          frontend.emit(await engine.dismissRoom());
        } catch {
          /* a farewell must never strand teardown when the API is unavailable */
        }
      }
      pollController?.abort(); // the in-flight long-poll resolves its abort cleanly
      if (roomHandle) {
        try {
          await roomHandle.shutdown(); // live session transports close properly
        } catch {
          /* teardown never throws */
        }
      }
      frontend.close();
      frontend.farewell(hosted ? msg.goodbyeRoomClosed : msg.goodbye, () => process.exit(0));
    };

    frontend.onLine((line) => {
      queue = queue.then(async () => {
        try {
          const events = await engine.execute(line);
          const wantsExit = events.some((e) => e.type === 'exit');
          frontend.emit(events);
          if (wantsExit) {
            void shutdown(); // fire, never await: this item must resolve for the drain
            return;
          }
        } catch (err) {
          frontend.fail(describeError(err));
        }
        if (!closed) frontend.ready();
      });
    });

    // Ctrl+C and Ctrl+D / stdin end both ride the graceful path; without this the
    // close path was a bare process.exit(0) mid-await (the latent v0 gap, shut).
    frontend.onQuit(() => {
      void shutdown();
    });

    // The feed tail: long-poll whenever bound; idle cheaply while unbound.
    // Transient network trouble is reported ONCE, then the loop retries quietly
    // with exponential backoff and says one line when the feed is back (#245) -
    // an outage never crashes the loop and never spams the feed.
    let pollFailStreak = 0;
    void (async () => {
      while (!closed) {
        if (!engine.isBound()) {
          await sleep(500);
          continue;
        }
        pollController = new AbortController();
        try {
          const events = await engine.pollFeed(20, pollController.signal);
          if (pollFailStreak > 0) frontend.note(msg.feedPollReconnected);
          pollFailStreak = 0;
          frontend.emit(events);
        } catch (err) {
          if (closed) break; // an aborted wait during teardown is the drain working
          pollFailStreak += 1;
          if (pollFailStreak === 1) frontend.fail(msg.feedPollTrouble(errorReason(err)));
          await sleep(Math.min(POLL_BACKOFF_BASE_MS * 2 ** (pollFailStreak - 1), POLL_BACKOFF_MAX_MS));
        } finally {
          pollController = null;
        }
      }
    })();

    frontend.ready();
  });
