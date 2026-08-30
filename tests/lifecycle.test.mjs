// Room lifecycle net (0.5.1 slice B, #253 + #254): the FIRST real lifecycle tests.
//  A. #254 regression - a real MCP session open, then shutdown: no mutual-recursion
//     stack overflow (transport.onclose <-> server.close), sessions closed properly,
//     the port actually released, shutdown idempotent. Client-driven session close
//     (DELETE) rides the same guarded closer.
//  B. The drain gate - THE CHAIR LEFT answers requests that arrive while the room
//     is going down, before the port closes.
//  C. Signal opt-out - registerSignalHandlers:false leaves the process signal table
//     alone (the console owns teardown; the shutdown closure is handed to the caller).
//  D. The console end to end - spawn `flurryport console` against a fake API:
//     lazy start (no room until the first :seat mint), the boarding pass carries the
//     in-process room URL, :exit drains an in-flight long-poll and exits 0, the room
//     dies with the console; Ctrl+D (stdin end) rides the same graceful path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'index.js');

// Isolated HOME before dist imports: a leaked real profile boots the CLI authed
// against PROD, and nothing in this file may touch the operator's ~/.flurryport.
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'fp-lifecycle-home-'));
process.env.HOME = process.env.USERPROFILE;

const { serveMcpHttp } = await import('../dist/lib/mcp-http.js');
const { buildSeatServer } = await import('../dist/lib/mcp-seat-tools.js');
const { consoleMessages } = await import('../dist/lib/console-messages.js');

/** In-process room server with the console's posture: caller-owned teardown, quiet. */
function startRoom(overrides = {}) {
  return serveMcpHttp({
    host: '127.0.0.1',
    port: 0,
    registerSignalHandlers: false,
    log: () => {},
    build: async () => buildSeatServer({ apiBase: 'http://127.0.0.1:9', version: '0.0.0-test' }),
    ...overrides,
  });
}

/** Minimal streamable-HTTP MCP session: JSON-RPC POSTs with the mcp-session-id header. */
function httpSession(url) {
  let sid = null;
  let id = 0;
  async function send(body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sid ? { 'mcp-session-id': sid } : {}),
      },
      body: JSON.stringify(body),
    });
    sid = res.headers.get('mcp-session-id') ?? sid;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/event-stream')) {
      const text = await res.text();
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const msg = JSON.parse(line.slice(5).trim());
        if (msg.id === body.id) return msg;
      }
      return null;
    }
    if (ct.includes('application/json')) return res.json();
    return null; // 202 for notifications
  }
  const rpc = (method, params) => send({ jsonrpc: '2.0', id: ++id, method, params });
  const init = async () => {
    const res = await rpc('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'lifecycle-test', version: '0' },
    });
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return res;
  };
  return { rpc, init, sid: () => sid };
}

// ───────────────────────── A. #254 regression ─────────────────────────

test('#254: shutdown with a live MCP session never recurses; the port closes clean', async () => {
  const handle = await startRoom();
  const session = httpSession(handle.url);
  const init = await session.init();
  assert.equal(init.result.serverInfo.name, 'flurryport-seat');

  // 0.5.0 crashed HERE: transport.onclose called server.close(), the SDK closed the
  // transport, onclose re-fired - RangeError stack overflow. The guarded closer must
  // resolve cleanly with the session open.
  await handle.shutdown();
  await handle.closed;

  // The port is actually released: a fresh connection is refused, not served.
  await assert.rejects(fetch(handle.url.replace('/mcp', '/healthz')));
  // Idempotent: a second shutdown resolves immediately instead of re-closing anything.
  await handle.shutdown();
});

test('#254: a client-driven session close (DELETE) rides the same guarded closer', async () => {
  const handle = await startRoom();
  try {
    const session = httpSession(handle.url);
    await session.init();
    assert.ok(session.sid(), 'the session opened');

    const res = await fetch(handle.url, { method: 'DELETE', headers: { 'mcp-session-id': session.sid() } });
    assert.ok(res.ok, `session DELETE answered ${res.status}`);

    // The session is gone (per-session close path), the server itself still lives.
    const stale = await fetch(handle.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session.sid(),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }),
    });
    assert.equal(stale.status, 404);
    const health = await fetch(handle.url.replace('/mcp', '/healthz'));
    assert.equal(await health.text(), 'ok');
  } finally {
    await handle.shutdown();
  }
});

// ───────────────────────── B. the drain gate ─────────────────────────

test('THE CHAIR LEFT: requests arriving while the room drains get the named refusal', async () => {
  let releaseClose;
  const gate = new Promise((resolve) => { releaseClose = resolve; });
  const handle = await startRoom({
    drainNotice: consoleMessages.chairLeft,
    build: async () => {
      const built = buildSeatServer({ apiBase: 'http://127.0.0.1:9', version: '0.0.0-test' });
      // Hold the drain window open: shutdown cannot finish until the gate lifts,
      // so the listener is still up while draining is already true.
      const origClose = built.server.close.bind(built.server);
      built.server.close = async () => { await gate; return origClose(); };
      return built;
    },
  });
  try {
    const session = httpSession(handle.url);
    await session.init();

    const shutdownDone = handle.shutdown(); // draining flips synchronously
    const res = await fetch(handle.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error.message, /The chair left/);
    assert.match(body.error.message, /the log keeps its bylines/);

    releaseClose();
    await shutdownDone;
  } finally {
    releaseClose();
    await handle.shutdown();
  }
});

// ───────────────────────── C. signal opt-out ─────────────────────────

test('registerSignalHandlers:false leaves the process signal table alone', async () => {
  const sigintBefore = process.listenerCount('SIGINT');
  const sigtermBefore = process.listenerCount('SIGTERM');
  const handle = await startRoom();
  assert.equal(process.listenerCount('SIGINT'), sigintBefore, 'no SIGINT handler registered');
  assert.equal(process.listenerCount('SIGTERM'), sigtermBefore, 'no SIGTERM handler registered');
  // The caller received the shutdown closure instead; it works.
  await handle.shutdown();
  await handle.closed;
});

// ───────────────────────── D. the console end to end ─────────────────────────

const P_GUID = '11111111-1111-1111-1111-111111111111';
const E_GUID = '22222222-2222-2222-2222-222222222222';

/**
 * Fake Core API for the console: bind reads, an empty roster, a mint, and a
 * long-poll wait that is HELD OPEN forever - the graceful-teardown target.
 */
function startFakeConsoleApi() {
  let waitArrivedResolve;
  const state = {
    waits: 0,
    posts: [],
    waitArrived: new Promise((resolve) => { waitArrivedResolve = resolve; }),
  };
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      const json = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET' && url === '/api/v1/projects') {
        return json({ Projects: [{ Id: P_GUID, Name: 'Foo', Slug: 'foo', Suspended: false, CreatedAt: new Date().toISOString() }] });
      }
      if (req.method === 'GET' && /^\/api\/v1\/projects\/[^/]+\/endpoints$/.test(url)) {
        return json({ Endpoints: [{ Id: E_GUID, ProjectId: P_GUID, Name: 'Room', Slug: 'room' }] });
      }
      if (req.method === 'GET' && /^\/api\/v1\/projects\/[^/]+\/endpoints\/[^/]+$/.test(url)) {
        return json({ Id: E_GUID, Slug: 'room', SigningEnabled: false, SigningHeader: null });
      }
      if (req.method === 'GET' && /^\/api\/v1\/endpoints\/[^/]+\/invites\/$/.test(url)) {
        return json({ Items: [] });
      }
      if (req.method === 'POST' && /^\/api\/v1\/endpoints\/[^/]+\/invites\/seat$/.test(url)) {
        return json({
          PairingCode: '7WHM-KR4P-XT2B',
          Ref: 'inv_1',
          ParticipantName: 'Bunny',
          ExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          CodeExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        });
      }
      if (req.method === 'POST' && /^\/api\/v1\/capture\/[^/]+\/room$/.test(url)) {
        state.posts.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        return json({});
      }
      if (req.method === 'GET' && url.includes('/captured-requests/wait')) {
        state.waits += 1;
        waitArrivedResolve();
        return; // held open: the long-poll in flight during teardown
      }
      if (req.method === 'GET' && url.includes('/captured-requests')) {
        return json({ Requests: [], TotalCount: 0, NextCursor: null, Scope: { ReadAs: 'owner' } });
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: `no fake for ${req.method} ${url}` }));
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () => resolve({ srv, state, base: `http://127.0.0.1:${srv.address().port}` })));
}

/** Spawn `flurryport console` with its own isolated home wired at the fake API. */
function spawnConsole(apiBase, args = []) {
  const home = mkdtempSync(join(tmpdir(), 'fp-console-e2e-'));
  mkdirSync(join(home, '.flurryport'), { recursive: true });
  writeFileSync(join(home, '.flurryport', 'config.json'), JSON.stringify({
    activeEnvironment: 'test',
    environments: { test: { apiUrl: apiBase, activeAccount: 'me', accounts: { me: { apiKey: 'fp_test_token' } } } },
  }));
  // Chair identity pre-seeded: the first-mint ask is covered by the engine tests.
  writeFileSync(join(home, '.flurryport', 'console.json'), JSON.stringify({ version: 1, identity: 'director', seats: {} }));
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  delete env.FLURRYPORT_API_URL;
  delete env.FLURRYPORT_TOKEN;
  const child = spawn(process.execPath, [CLI, 'console', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const waitFor = (pattern, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const check = () => {
      const m = out.match(pattern);
      if (m) { cleanup(); resolve(m); }
    };
    const iv = setInterval(check, 50);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${pattern}; output so far:\n${out}`));
    }, timeoutMs);
    const cleanup = () => { clearInterval(iv); clearTimeout(timer); };
    check();
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, waitFor, exited, output: () => out };
}

test('console end to end: lazy start, room URL on the pass, :exit drains and the room dies', async () => {
  const { srv, state, base } = await startFakeConsoleApi();
  const con = spawnConsole(base);
  try {
    await con.waitFor(/not bound to a room yet/);
    con.child.stdin.write(':set project foo\n');
    con.child.stdin.write(':set endpoint room\n');
    await con.waitFor(/Bound to foo\/room/);
    // The feed long-poll is now IN FLIGHT (the fake holds it open forever) ...
    await state.waitArrived;
    // ... and no room server exists yet: lazy start means no port before the mint.
    assert.ok(!/hosts the room/.test(con.output()), 'no room before the first mint');

    con.child.stdin.write(':seat Bunny\n');
    const m = await con.waitFor(/seat server live at (http:\/\/127\.0\.0\.1:\d+\/mcp)/);
    const roomUrl = m[1];
    await con.waitFor(/Boarding pass/);
    assert.ok(
      con.output().includes(`Seat server: ${roomUrl}`),
      'the boarding pass points a guest at the in-process room',
    );
    // The room is really up, in the console's process.
    const health = await fetch(roomUrl.replace('/mcp', '/healthz'));
    assert.equal(await health.text(), 'ok');

    con.child.stdin.write(':exit\n');
    const code = await con.exited;
    assert.equal(code, 0, `console exited ${code}; output:\n${con.output()}`);
    assert.match(con.output(), /The room closed with the console/);
    assert.equal(state.posts.length, 1, 'clean exit posts one dismissal before teardown');
    assert.deepEqual(state.posts[0], {
      v: 1,
      kind: 'message',
      from: 'director',
      to: 'all',
      verb: 'fp:bye',
      text: 'The room is closing. All seats are dismissed; the log keeps its bylines.',
    });
    // The abandoned long-poll never surfaced as an error: the drain worked.
    assert.ok(!/AbortError|aborted|fetch failed/i.test(con.output()), 'no teardown error noise');
    // The room died with the console (every exit path takes the room down).
    await assert.rejects(fetch(roomUrl.replace('/mcp', '/healthz')));
  } finally {
    con.child.kill();
    srv.closeAllConnections?.();
    srv.close();
  }
});

test('Ctrl+D (stdin end) rides the same graceful path: goodbye and exit 0 mid-long-poll', async () => {
  const { srv, state, base } = await startFakeConsoleApi();
  const con = spawnConsole(base);
  try {
    await con.waitFor(/not bound to a room yet/);
    con.child.stdin.write(':set project foo\n');
    con.child.stdin.write(':set endpoint room\n');
    await con.waitFor(/Bound to foo\/room/);
    await state.waitArrived; // the long-poll is in flight
    con.child.stdin.end(); // Ctrl+D
    const code = await con.exited;
    assert.equal(code, 0, `console exited ${code}; output:\n${con.output()}`);
    assert.match(con.output(), /Goodbye\./);
    assert.ok(!/hosts the room/.test(con.output()), 'never minted, never hosted');
    assert.ok(!/AbortError|aborted|fetch failed/i.test(con.output()), 'no teardown error noise');
  } finally {
    con.child.kill();
    srv.closeAllConnections?.();
    srv.close();
  }
});

/**
 * --json is the frontend the nvim plugin drives (0.5.2). Two properties matter to
 * a driving program and neither is visible to a human at a prompt:
 *  1. every stdout line is one JSON object - the contract, no ANSI, no prose
 *  2. commands complete IN ORDER, and stdin ending drains what it already accepted
 * Property 2 was broken on the first --json run: ":list projects" then ":exit"
 * raced, and the listing was lost because exit won while the read was in flight.
 */
test('--json: every line is one event, commands finish in order, EOF drains', async () => {
  const { srv, base } = await startFakeConsoleApi();
  const con = spawnConsole(base, ['--json']);
  try {
    // Both commands together, then EOF immediately behind them - the racing shape.
    con.child.stdin.write(':list projects\n:exit\n');
    con.child.stdin.end();
    const code = await con.exited;
    assert.equal(code, 0, `console exited ${code}; output:\n${con.output()}`);

    const lines = con.output().split('\n').filter((l) => l.trim().length > 0);
    const events = lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        assert.fail(`non-JSON line on stdout under --json: ${JSON.stringify(l)}`);
      }
    });

    // The opening hello names the version a client is talking to.
    assert.equal(events[0].type, 'hello');
    assert.match(events[0].version, /^\d+\.\d+\.\d+$/);

    // The listing SURVIVED the exit racing it, and landed before the exit.
    const projectsAt = events.findIndex((e) => e.type === 'projects');
    const exitAt = events.findIndex((e) => e.type === 'exit');
    assert.ok(projectsAt > 0, `no projects event; got ${events.map((e) => e.type).join(',')}`);
    assert.ok(exitAt > projectsAt, 'the accepted command finished before teardown');
    assert.deepEqual(events[projectsAt].rows.map((r) => r.slug), ['foo']);

    // Structured rows, not rendered text: the whole point of the frontend.
    assert.equal(typeof events[projectsAt].rows[0].id, 'string');
    assert.ok(!/\x1b\[/.test(con.output()), 'no ANSI escapes under --json');
  } finally {
    con.child.kill();
    srv.closeAllConnections?.();
    srv.close();
  }
});
