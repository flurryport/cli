// Pilot-1 CLI hardening regression net (2026-08-14, the writers-room run's ledger):
//  A. classifyCeremonyState — ledger item 2: the dead-invite kill must be
//     distinguishable from a TTL channel expiry, off the landing's honest signals
//     (grantCollectedAt / status), never a catch-all channel_expired.
//  B. Anon addressed-read guard — ledger item 7 (priority): an explicit
//     endpointId/projectId in anonymous mode is REFUSED, never silently rescoped
//     to the session's own (usually empty) room.
//  C. Version-nudge self-nag guard — ledger item 9: a CLI must never relay a
//     server notice that tells it to upgrade to its own (or an older) version.
//  D. deliverIntent — ledger items 5+8: the shared delivery core signs when given
//     a key, sends the receipt header, and parses the correlation receipt; the
//     `flurryport post` verb and the MCP post_intent tool ride this one path.
//  E. Credential-router attribution — ledger item 7's read-receipt half: the
//     routing client names WHICH stored credential a path answers as.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';

const { classifyCeremonyState } = await import('../dist/lib/invite-api.js');
const { collectTools, registerUnifiedTools } = await import('../dist/lib/mcp-unified.js');
const { recordCliNotice, takeCliUpdateNotice, CLI_NOTICE_HEADER } = await import('../dist/lib/version-nudge.js');
const { deliverIntent } = await import('../dist/lib/intent-post.js');
const { makeRoutingClient } = await import('../dist/lib/credential-router.js');

// ───────────────────────── A. ceremony state classifier ─────────────────────────

test('ceremony: a missing landing is invite_gone', () => {
  assert.equal(classifyCeremonyState(null), 'invite_gone');
});

test('ceremony: grantCollectedAt set means the grant went to another channel', () => {
  assert.equal(
    classifyCeremonyState({ status: 'accepted', grantCollectedAt: '2026-08-13T17:00:00Z' }),
    'grant_collected');
});

test('ceremony: accepted with no release is the owner-accept void signature', () => {
  assert.equal(
    classifyCeremonyState({ status: 'accepted', grantCollectedAt: null }),
    'accepted_no_release');
});

test('ceremony: a pending landing is live - a channel death there is a real TTL lapse', () => {
  assert.equal(classifyCeremonyState({ status: 'pending', grantCollectedAt: null }), 'live');
  assert.equal(classifyCeremonyState({}), 'live');
});

// ───────────────────────── B. anon addressed-read guard ─────────────────────────

/** Fake McpServer capturing registrations, mirroring collectTools' shim. */
function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, def, handler) {
      tools.set(name, { def, handler });
      return { remove() {} };
    },
  };
}

function unifiedFixture(mode) {
  const calls = [];
  const authTools = collectTools((s) =>
    s.registerTool('list_captures', { description: 'auth' }, async (args) => {
      calls.push(['auth', args]);
      return { ok: true, from: 'auth' };
    }));
  const anonTools = collectTools((s) =>
    s.registerTool('list_captures', { description: 'anon' }, async (args) => {
      calls.push(['anon', args]);
      return { ok: true, from: 'anon' };
    }));
  const server = fakeServer();
  registerUnifiedTools(server, mode, authTools, anonTools);
  return { server, calls };
}

test('anon guard: explicit endpointId in anonymous mode is refused, not rescoped', async () => {
  const { server, calls } = unifiedFixture({ authenticated: false });
  const result = await server.tools.get('list_captures').handler({ endpointId: '2n9AbCd' });
  assert.equal(calls.length, 0, 'the anon impl must never run for an addressed read');
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.error.code, 'scoped_read_unavailable');
  assert.match(payload.error.message, /ANONYMOUS/);
  assert.match(payload.error.message, /join_invite/);
});

test('anon guard: projectId alone also refuses', async () => {
  const { server } = unifiedFixture({ authenticated: false });
  const result = await server.tools.get('list_captures').handler({ projectId: 'p1X' });
  assert.equal(JSON.parse(result.content[0].text).error.code, 'scoped_read_unavailable');
});

test('anon guard: unaddressed calls still reach the anon impl', async () => {
  const { server, calls } = unifiedFixture({ authenticated: false });
  const result = await server.tools.get('list_captures').handler({ limit: 5 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'anon');
  assert.equal(result.from, 'anon');
});

test('anon guard: authenticated mode passes addressed reads through untouched', async () => {
  const { server, calls } = unifiedFixture({ authenticated: true });
  const result = await server.tools.get('list_captures').handler({ endpointId: '2n9AbCd' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'auth');
  assert.equal(result.from, 'auth');
});

// ───────────────────────── C. version-nudge self-nag guard ─────────────────────────

const noticeResponse = (message) =>
  new Response('', { headers: message === null ? {} : { [CLI_NOTICE_HEADER]: message } });

test('nudge: a notice naming only this (or an older) version is suppressed', () => {
  const own = process.env.npm_package_version ?? null;
  // The dist package.json version is what the module read; use literal older versions.
  recordCliNotice(noticeResponse('flurryport 0.3.3 is out of date; upgrade to 0.3.3 (npm i -g flurryport).'));
  assert.equal(takeCliUpdateNotice(), null, `self-nag must be dropped (own version: ${own})`);
  recordCliNotice(noticeResponse('upgrade to 0.1.0'));
  assert.equal(takeCliUpdateNotice(), null);
});

test('nudge: a notice naming a NEWER version still relays', () => {
  recordCliNotice(noticeResponse('flurryport 99.0.0 is available; upgrade with npm i -g flurryport.'));
  const notice = takeCliUpdateNotice();
  assert.ok(notice);
  assert.equal(notice.code, 'cli_update_available');
});

test('nudge: a version-free notice passes through (the server may know better)', () => {
  recordCliNotice(noticeResponse('Your CLI is out of date.'));
  assert.ok(takeCliUpdateNotice());
  recordCliNotice(noticeResponse(null));
  assert.equal(takeCliUpdateNotice(), null);
});

// ───────────────────────── D. deliverIntent core ─────────────────────────

const CAPTURE_GUID = '01234567-89ab-cdef-0123-456789abcdef';

function captureServer(onRequest) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => onRequest(req, body, res));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('deliverIntent: signs with the given key on the given header and parses the receipt', async () => {
  let seen = null;
  const srv = await captureServer((req, body, res) => {
    seen = { url: req.url, headers: req.headers, body };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ captureId: CAPTURE_GUID, executions: [] }));
  });
  const { port } = srv.address();
  try {
    const delivery = await deliverIntent({
      baseUrl: `http://127.0.0.1:${port}`,
      projectId: 'p1X',
      endpointSlug: 'writers-room',
      body: '{"seat":"envoy-haiku"}',
      signingKey: 'k-test',
      headerName: 'X-Flurry-Signature',
    });
    assert.equal(seen.url, '/api/v1/capture/p1X/writers-room');
    assert.equal(seen.headers['x-flurry-receipt'], '1');
    const expected = createHmac('sha256', 'k-test').update(Buffer.from('{"seat":"envoy-haiku"}', 'utf8')).digest('hex');
    assert.equal(seen.headers['x-flurry-signature'], expected);
    assert.equal(delivery.ok, true);
    assert.equal(typeof delivery.captureId, 'string', 'GUID receipt converts to an opaque id');
  } finally {
    srv.close();
  }
});

test('deliverIntent: no key means no signature header, and a 401 surfaces honestly', async () => {
  let seen = null;
  const srv = await captureServer((req, body, res) => {
    seen = { headers: req.headers };
    res.writeHead(401);
    res.end();
  });
  const { port } = srv.address();
  try {
    const delivery = await deliverIntent({
      baseUrl: `http://127.0.0.1:${port}`,
      projectId: 'p1X',
      endpointSlug: 'writers-room',
      body: '{}',
    });
    assert.equal(seen.headers['x-flurry-signature'], undefined);
    assert.equal(delivery.ok, false);
    assert.equal(delivery.httpStatus, 401, 'the signing wall answer is reported, never masked');
  } finally {
    srv.close();
  }
});

// ───────────────────────── E. router attribution ─────────────────────────

test('router: credentialFor names the scoped account for its endpoint, null for the default', () => {
  const table = [
    { endpointId: 'eSCOPED1', projectId: 'pSCOPED1', accountName: 'spillcoffee-claude', client: {} },
  ];
  const routing = makeRoutingClient(() => ({ baseUrl: 'x' }), table);
  assert.equal(routing.credentialFor('/api/v1/endpoints/eSCOPED1/captured-requests?take=5'), 'spillcoffee-claude');
  assert.equal(routing.credentialFor('/api/v1/endpoints/eFOREIGN/captured-requests?take=5'), null);
});

// ───────────────────── F. accept-race grace (round-7 finding, 0.4.1) ─────────────────────
// Round 6 live failure: the landing shows accepted-with-no-collection in the seconds
// between the human's click and the next collecting poll, and 0.4.0 declared that state
// terminal on first sight - killing a healthy ceremony. The fix: first sight starts a
// grace clock (accepted_collecting, ok:true); only persistence past the grace window is
// the honest accepted_without_release death.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname2 = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = pathJoin(__dirname2, '..', 'dist', 'index.js');

function mcpClient(child) {
  let buf = ''; const pend = new Map(); let id = 0;
  child.stdout.on('data', (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); }
    }
  });
  const rpc = (method, params) => {
    const i = ++id;
    return new Promise((res, rej) => {
      pend.set(i, res);
      setTimeout(() => rej(new Error(`timeout ${method}`)), 30000);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    });
  };
  const call = async (name, args) => JSON.parse((await rpc('tools/call', { name, arguments: args })).result.content[0].text);
  const init = async () => {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pilot1-race-test', version: '0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  };
  return { rpc, call, init };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake invite rail: device/start 200, poll behavior switchable, landing accepted+uncollected. */
function raceFixture() {
  const state = { pollComplete: false };
  const srv = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const expires = new Date(Date.now() + 3600_000).toISOString();
      if (/\/api\/v1\/invites\/[^/]+\/device\/start$/.test(req.url)) return json(200, { ExpiresAt: expires });
      if (req.url === '/api/v1/anon/device/poll') {
        return state.pollComplete
          ? json(200, {
              Status: 'complete', Token: 'fp_racetest', SigningKey: 'c2ln', ParticipantName: 'envoy-haiku',
              ContributorEndpointId: 'EPRACE', ContributorProjectId: 'PRACE',
            })
          : json(200, { Status: 'pending' });
      }
      if (req.method === 'GET' && /\/api\/v1\/invites\/[^/]+$/.test(req.url)) {
        return json(200, { status: 'accepted', grantCollectedAt: null, role: 'producer', recipeRef: null });
      }
      if (req.url === '/api/v1/projects') return json(200, { Projects: [] });
      json(404, { title: 'not_found' });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, state, base: `http://127.0.0.1:${srv.address().port}` })));
}

function spawnMcp(base, graceMs) {
  const home = mkdtempSync(pathJoin(tmpdir(), 'fp-race-'));
  return spawn(process.execPath, [CLI_BIN, 'mcp'], {
    env: {
      ...process.env,
      FLURRYPORT_ANON_URL: base,
      FLURRYPORT_API_URL: base,
      USERPROFILE: home,
      HOME: home,
      FLURRYPORT_TOKEN: '',
      FLURRYPORT_LANDING_CHECK_MS: '50',
      FLURRYPORT_ACCEPT_GRACE_MS: String(graceMs),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

test('accept-race: accepted-but-uncollected is a grace state, and the grant collects on a later call', async () => {
  const { srv, state, base } = await raceFixture();
  const child = spawnMcp(base, 60_000);
  const mcp = mcpClient(child);
  try {
    await mcp.init();
    const armed = await mcp.call('join_invite', { invite: 'fpi_racetoken' });
    assert.equal(armed.status, 'awaiting_human');
    await sleep(80); // let the landing-check throttle (50ms) lapse
    const racing = await mcp.call('join_invite', { invite: 'fpi_racetoken' });
    assert.equal(racing.ok, true, `first sight of accepted+uncollected must NOT be terminal: ${JSON.stringify(racing)}`);
    assert.equal(racing.status, 'accepted_collecting');
    state.pollComplete = true; // the grant releases
    const joined = await mcp.call('join_invite', { invite: 'fpi_racetoken' });
    assert.equal(joined.status, 'joined', JSON.stringify(joined));
    assert.equal(joined.signingConfigured, true);
  } finally {
    child.kill();
    srv.close();
  }
});

test('accept-race: a grant still unreleased after the grace window dies honestly', async () => {
  const { srv, state, base } = await raceFixture();
  const child = spawnMcp(base, 400);
  const mcp = mcpClient(child);
  try {
    await mcp.init();
    await mcp.call('join_invite', { invite: 'fpi_racetoken2' });
    await sleep(80);
    const racing = await mcp.call('join_invite', { invite: 'fpi_racetoken2' });
    assert.equal(racing.status, 'accepted_collecting');
    await sleep(500); // exceed the 400ms grace with the poll still pending
    const dead = await mcp.call('join_invite', { invite: 'fpi_racetoken2' });
    assert.equal(dead.ok, false);
    assert.equal(dead.error.code, 'accepted_without_release', JSON.stringify(dead));
    void state;
  } finally {
    child.kill();
    srv.close();
  }
});
