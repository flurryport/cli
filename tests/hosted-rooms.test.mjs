// Hosted rooms (#346): the seat server runs as a FlurryPORT service at
// {api base}/rooms/mcp, so a boarding pass carries a reachable address by default
// instead of the host laptop's loopback, and the HTTP host reaps sessions that go
// quiet or whose seat has ended (a pod serves many sittings; nothing else would).
//  A. resolveRoomsUrl precedence: explicit > FLURRYPORT_ROOMS_URL > {api}/rooms/mcp.
//  B. mint_seat rides that precedence into passText, offline against a fake client.
//  C. serveMcpHttp eviction: idle past the limit closes and removes the session,
//     an active one survives, and a seat past its own expiry closes even if busy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated HOME before dist imports: mint_seat reads the console's seeded chair
// identity from ~/.flurryport, and nothing here may touch the operator's own.
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'fp-hosted-rooms-home-'));
process.env.HOME = process.env.USERPROFILE;

const { resolveRoomsUrl, resolveRoomsIdleMinutes, resolvePublicApiHost, ROOMS_MCP_PATH } = await import('../dist/lib/rooms.js');
const { collectTools } = await import('../dist/lib/mcp-unified.js');
const { registerAuthTools } = await import('../dist/lib/mcp-auth-tools.js');
const { serveMcpHttp } = await import('../dist/lib/mcp-http.js');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');

const PROD_API = 'https://api.flurryport.io';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── A. the address rule ─────────────────────────

test('resolveRoomsUrl: the API base grows /rooms/mcp, trailing slashes forgiven', () => {
  delete process.env.FLURRYPORT_ROOMS_URL;
  assert.equal(ROOMS_MCP_PATH, '/rooms/mcp');
  assert.equal(resolveRoomsUrl(PROD_API), 'https://api.flurryport.io/rooms/mcp');
  assert.equal(resolveRoomsUrl(`${PROD_API}/`), 'https://api.flurryport.io/rooms/mcp');
  // Each stack points at itself: dev and qa derive from their own API base.
  assert.equal(resolveRoomsUrl('https://api.dev.flurryport.io'), 'https://api.dev.flurryport.io/rooms/mcp');
  assert.equal(resolveRoomsUrl('http://127.0.0.1:8083'), 'http://127.0.0.1:8083/rooms/mcp');
});

test('resolveRoomsUrl: FLURRYPORT_ROOMS_URL beats the derived default; an explicit url beats both', () => {
  process.env.FLURRYPORT_ROOMS_URL = 'https://rooms.example.test/mcp/';
  try {
    assert.equal(resolveRoomsUrl(PROD_API), 'https://rooms.example.test/mcp');
    assert.equal(resolveRoomsUrl(PROD_API, 'http://10.0.0.5:8791/mcp'), 'http://10.0.0.5:8791/mcp');
    // Blank or null explicit values are not a choice; they fall through.
    assert.equal(resolveRoomsUrl(PROD_API, ''), 'https://rooms.example.test/mcp');
    assert.equal(resolveRoomsUrl(PROD_API, null), 'https://rooms.example.test/mcp');
  } finally {
    delete process.env.FLURRYPORT_ROOMS_URL;
  }
});

test('resolveRoomsIdleMinutes: explicit, then env, then 30; junk never disables eviction', () => {
  delete process.env.FLURRYPORT_ROOMS_IDLE_MINUTES;
  assert.equal(resolveRoomsIdleMinutes(), 30);
  assert.equal(resolveRoomsIdleMinutes('5'), 5);
  assert.equal(resolveRoomsIdleMinutes(0), 30);
  assert.equal(resolveRoomsIdleMinutes('never'), 30);
  process.env.FLURRYPORT_ROOMS_IDLE_MINUTES = '12';
  try {
    assert.equal(resolveRoomsIdleMinutes(), 12);
    assert.equal(resolveRoomsIdleMinutes('7'), 7);
  } finally {
    delete process.env.FLURRYPORT_ROOMS_IDLE_MINUTES;
  }
});

test('resolvePublicApiHost (#358): only the hosted service sets it; a self-hosted seat server sends no marker', () => {
  delete process.env.FLURRYPORT_PUBLIC_API_HOST;
  assert.equal(resolvePublicApiHost(), null, 'nothing set: no marker, no presented host');
  assert.equal(resolvePublicApiHost('qa-barnacle-api.flurryport.io'), 'qa-barnacle-api.flurryport.io');
  assert.equal(resolvePublicApiHost('localhost:8083'), 'localhost:8083', 'a port is a bare host still');
  assert.equal(resolvePublicApiHost('https://api.flurryport.io'), null, 'a scheme is not a host');
  assert.equal(resolvePublicApiHost('api.flurryport.io/rooms'), null, 'a path is not a host');
  process.env.FLURRYPORT_PUBLIC_API_HOST = 'dev-kraken-api.flurryport.io';
  try {
    assert.equal(resolvePublicApiHost(), 'dev-kraken-api.flurryport.io');
  } finally {
    delete process.env.FLURRYPORT_PUBLIC_API_HOST;
  }
});

// ───────────────────────── B. mint_seat carries it ─────────────────────────

const CODE = '7WHM-KR4P-XT2B';
const mintRelease = {
  PairingCode: CODE,
  Ref: 'REF1',
  ParticipantName: 'Coder',
  ExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  CodeExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
};

function fakeClient(baseUrl) {
  const routes = {
    'POST /api/v1/endpoints/E1/invites/seat': mintRelease,
    'GET /api/v1/projects/P1': { Slug: 'acme' },
    'GET /api/v1/projects/P1/endpoints/E1': { Slug: 'hook' },
  };
  const answer = (method, path) => {
    const hit = routes[`${method} ${path}`];
    if (hit === undefined) throw new Error(`unrouted ${method} ${path}`);
    return hit;
  };
  return {
    baseUrl,
    get: async (path) => answer('GET', path),
    post: async (path) => answer('POST', path),
    put: async (path) => answer('PUT', path),
    delete: async (path) => answer('DELETE', path),
  };
}

async function mintPass(baseUrl, args) {
  const tools = collectTools((s) => registerAuthTools(s, { client: fakeClient(baseUrl), allowLan: false }));
  const result = await tools.get('mint_seat').handler({ projectId: 'P1', endpointId: 'E1', guestName: 'coder', chairAddress: 'gene', ...args });
  assert.ok(!result.isError, result.content[0].text);
  return JSON.parse(result.content[0].text).passText;
}

test('mint_seat default: the pass names {api base}/rooms/mcp and its /rooms/whoami preflight', async () => {
  delete process.env.FLURRYPORT_ROOMS_URL;
  const pass = await mintPass(PROD_API, {});
  assert.match(pass, /- Seat server: https:\/\/api\.flurryport\.io\/rooms\/mcp \(MCP over streamable HTTP\)\./);
  assert.match(pass, /- Before redeeming, GET https:\/\/api\.flurryport\.io\/rooms\/whoami;/);
  assert.doesNotMatch(pass, /127\.0\.0\.1/, 'no loopback address rides a default pass');
  assert.doesNotMatch(pass, /the host runs flurryport seat-server/);
});

test('mint_seat env override: FLURRYPORT_ROOMS_URL replaces the derived address', async () => {
  process.env.FLURRYPORT_ROOMS_URL = 'https://rooms.example.test/mcp';
  try {
    const pass = await mintPass(PROD_API, {});
    assert.match(pass, /- Seat server: https:\/\/rooms\.example\.test\/mcp /);
    assert.match(pass, /GET https:\/\/rooms\.example\.test\/whoami;/);
  } finally {
    delete process.env.FLURRYPORT_ROOMS_URL;
  }
});

test('mint_seat explicit seatServerUrl: a self-hosted room wins over env and default alike', async () => {
  process.env.FLURRYPORT_ROOMS_URL = 'https://rooms.example.test/mcp';
  try {
    const pass = await mintPass(PROD_API, { seatServerUrl: 'http://10.0.0.5:8791/mcp' });
    assert.match(pass, /- Seat server: http:\/\/10\.0\.0\.5:8791\/mcp /);
    assert.doesNotMatch(pass, /rooms\.example\.test|api\.flurryport\.io\/rooms/);
  } finally {
    delete process.env.FLURRYPORT_ROOMS_URL;
  }
});

test('mint_seat description teaches the hosted default and reserves seatServerUrl for self-hosting', () => {
  const tools = collectTools((s) => registerAuthTools(s, { client: fakeClient(PROD_API), allowLan: false }));
  const tool = tools.get('mint_seat');
  assert.match(tool.def.description, /hosted room address by default/);
  assert.match(tool.def.description, /seatServerUrl ONLY for a self-hosted room/);
});

// ───────────────────────── C. eviction ─────────────────────────

/** A tiny session host: one no-op tool, an optional expiry (and per-session idle) the build reports. */
async function startHost({ idleMs, sweepMs, expiresAt, sessionIdleMs }) {
  return serveMcpHttp({
    host: '127.0.0.1',
    port: 0,
    idleMs,
    sweepMs,
    log: () => {},
    build: async () => {
      const server = new McpServer({ name: 'evict-test', version: '0' });
      server.registerTool('noop', { description: 'Answers.', inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: 'ok' }],
      }));
      return {
        server,
        banner: 'evict-test session',
        expiresAt: expiresAt ?? (() => null),
        ...(sessionIdleMs ? { idleMs: sessionIdleMs } : {}),
      };
    },
  });
}

/** Minimal streamable-HTTP client: returns the raw response, remembers the session id. */
function client(url) {
  let sid = null;
  let id = 0;
  const post = async (body) => {
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
    await res.text();
    return res;
  };
  return {
    init: async () => {
      await post({
        jsonrpc: '2.0', id: ++id, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'evict', version: '0' } },
      });
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    call: () => post({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'noop', arguments: {} } }),
  };
}

test('idle eviction: a silent session is closed and removed; one that keeps calling survives', async () => {
  const handle = await startHost({ idleMs: 400, sweepMs: 50 });
  try {
    const quiet = client(handle.url);
    const busy = client(handle.url);
    await quiet.init();
    await busy.init();
    assert.equal(handle.activeSessions(), 2);

    // The busy one calls every 100ms, well inside the 400ms idle limit; the quiet
    // one says nothing for long enough that several sweeps see it idle.
    for (let i = 0; i < 8; i++) {
      await sleep(100);
      assert.equal((await busy.call()).status, 200, 'the active session keeps answering');
    }
    assert.equal(handle.activeSessions(), 1, 'only the silent session was reaped');
    assert.equal((await quiet.call()).status, 404, 'the evicted session is gone; the client must reinitialize');
    assert.equal((await busy.call()).status, 200);
  } finally {
    await handle.shutdown();
  }
});

test('seat expiry: a session whose seat has ended is closed at the sweep even while active', async () => {
  // The build reports an expiry 300ms out, as a redeemed seat would report its
  // own; the idle limit is far away, so only the expiry can close it.
  const end = new Date(Date.now() + 300).toISOString();
  const handle = await startHost({ idleMs: 60_000, sweepMs: 50, expiresAt: () => end });
  try {
    const seat = client(handle.url);
    await seat.init();
    assert.equal((await seat.call()).status, 200);
    for (let i = 0; i < 6; i++) {
      await sleep(100);
      await seat.call(); // activity does not save a seat that has ended
    }
    assert.equal(handle.activeSessions(), 0);
    assert.equal((await seat.call()).status, 404);
  } finally {
    await handle.shutdown();
  }
});

test('no expiry and no idleness: nothing is evicted', async () => {
  const handle = await startHost({ idleMs: 60_000, sweepMs: 50 });
  try {
    const seat = client(handle.url);
    await seat.init();
    await sleep(250);
    assert.equal(handle.activeSessions(), 1);
    assert.equal((await seat.call()).status, 200);
  } finally {
    await handle.shutdown();
  }
});

test('per-session idle override (#409): a standing session outlives the host idle limit', async () => {
  // The build reports Infinity as this session's OWN idle window, the way
  // buildSeatServer answers once attach_standing flips the session to standing
  // (Q5: expiry is the one reaper; no idle reaping for standing). The host limit
  // is tiny, so a DEFAULT session would be reaped several sweeps over.
  const handle = await startHost({ idleMs: 200, sweepMs: 50, sessionIdleMs: () => Number.POSITIVE_INFINITY });
  try {
    const standing = client(handle.url);
    await standing.init();
    await sleep(600); // three host idle-lifetimes of silence
    assert.equal(handle.activeSessions(), 1, 'the standing session is never idle-reaped');
    assert.equal((await standing.call()).status, 200);
  } finally {
    await handle.shutdown();
  }
});
