// The hosted ACCOUNT connector (Track B, mcp.flurryport.io).
//  A. the transport's authorization: the MCP-spec 401 + protected-resource metadata,
//     the open-time check against the API, session-to-account binding, bearer refresh.
//  B. the remote toolset: the allowlist mounts, machine-local tools never do, and the
//     server instructions name no tool the surface lacks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated HOME before dist imports: nothing here may touch the operator's own config.
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'fp-account-server-home-'));
process.env.HOME = process.env.USERPROFILE;

const { serveMcpHttp, resourceMetadataUrl } = await import('../dist/lib/mcp-http.js');
const { ACCOUNT_TOOLS, accountAuth, brandIconFiles, buildAccountServer } = await import('../dist/lib/mcp-account.js');
const { BRAND_ICON_PNG } = await import('../dist/lib/brand-icon.js');
const { collectTools } = await import('../dist/lib/mcp-unified.js');
const { registerCatalogTools } = await import('../dist/lib/mcp-catalog-tools.js');

const RESOURCE = 'https://mcp.example.test';
const ISSUER = 'https://api.example.test';
const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';

/** An unsigned JWT-shaped bearer: the transport only peeks; the (fake) API is the authority. */
function bearer(sub, { expInSeconds = 900, nonce = 'a' } = {}) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + expInSeconds;
  return `${part({ alg: 'HS256' })}.${part({ sub, exp, jti: nonce })}.sig`;
}

/** A fake API that accepts exactly the bearers in `accepted` and records what it saw. */
async function startFakeApi() {
  const accepted = new Set();
  const seen = [];
  const server = createServer((req, res) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    seen.push({ path: req.url, token });
    if (!accepted.has(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { accepted, seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

async function startConnector(api) {
  return serveMcpHttp({
    host: '127.0.0.1',
    port: 0,
    registerSignalHandlers: false,
    log: () => {},
    auth: accountAuth(api.url, `${RESOURCE}/`, ISSUER),
    publicFiles: brandIconFiles(),
    build: async (b) => buildAccountServer({ apiBase: api.url, version: '0.0.0-test', resource: RESOURCE }, b),
  });
}

async function rpc(url, body, { token, sessionId } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text.split('\n').find((l) => l.startsWith('data:'));
  let json = null;
  try { json = JSON.parse(data ? data.slice(5) : text); } catch { /* empty 202 */ }
  return { res, json };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

async function openSession(url, token) {
  const { res, json } = await rpc(url, INITIALIZE, { token });
  assert.equal(res.status, 200);
  const sessionId = res.headers.get('mcp-session-id');
  assert.ok(sessionId, 'initialize assigns a session id');
  await rpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, { token, sessionId });
  return { sessionId, instructions: json.result.instructions, serverInfo: json.result.serverInfo };
}

// ───────────────────────── A. authorization ─────────────────────────

test('resourceMetadataUrl: RFC 9728 inserts the well-known segment before the resource path', () => {
  assert.equal(resourceMetadataUrl('https://mcp.example.test'),
    'https://mcp.example.test/.well-known/oauth-protected-resource');
  assert.equal(resourceMetadataUrl('https://mcp.example.test/mcp'),
    'https://mcp.example.test/.well-known/oauth-protected-resource/mcp');
  assert.equal(resourceMetadataUrl('https://mcp.example.test/mcp/'),
    'https://mcp.example.test/.well-known/oauth-protected-resource/mcp');
});

test('no bearer: 401 whose WWW-Authenticate names the protected-resource metadata, and no error code', async () => {
  const api = await startFakeApi();
  const handle = await startConnector(api);
  try {
    const { res } = await rpc(handle.url, INITIALIZE);
    assert.equal(res.status, 401);
    assert.equal(
      res.headers.get('www-authenticate'),
      `Bearer resource_metadata="${RESOURCE}/.well-known/oauth-protected-resource"`,
      'a bare challenge carries no error (RFC 6750 3.1); the trailing slash on the resource is trimmed');
    assert.equal(api.seen.length, 0, 'the API is never asked about a request with no token');
  } finally {
    await handle.shutdown();
    api.close();
  }
});

test('protected-resource metadata: public at both well-known paths, pointing at the authorization server', async () => {
  const api = await startFakeApi();
  const handle = await startConnector(api);
  const origin = handle.url.replace(/\/mcp$/, '');
  try {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await fetch(origin + path);
      assert.equal(res.status, 200, path);
      assert.deepEqual(await res.json(), {
        resource: RESOURCE,
        authorization_servers: [ISSUER],
        scopes_supported: ['mcp:read', 'mcp:write'],
        bearer_methods_supported: ['header'],
      });
    }
  } finally {
    await handle.shutdown();
    api.close();
  }
});

test('an unreadable, expired, or API-refused bearer: 401 invalid_token and no session', async () => {
  const api = await startFakeApi();
  const handle = await startConnector(api);
  try {
    const refused = bearer(ALICE); // well-formed, but the API does not accept it
    for (const [label, token] of [
      ['not a JWT', 'fp_some_pat_shaped_thing'],
      ['expired', bearer(ALICE, { expInSeconds: -5 })],
      ['refused by the API', refused],
    ]) {
      const { res } = await rpc(handle.url, INITIALIZE, { token });
      assert.equal(res.status, 401, label);
      assert.match(res.headers.get('www-authenticate'), /error="invalid_token"/, label);
    }
    assert.deepEqual(api.seen.map((s) => s.token), [refused], 'only a plausible, unexpired token reaches the API');
    assert.equal(handle.activeSessions(), 0);
  } finally {
    await handle.shutdown();
    api.close();
  }
});

test('a session answers only to the account that opened it; a refreshed bearer is what the API sees next', async () => {
  const api = await startFakeApi();
  const handle = await startConnector(api);
  try {
    const first = bearer(ALICE, { nonce: 'first' });
    const refreshed = bearer(ALICE, { nonce: 'refreshed' });
    const bobs = bearer(BOB);
    for (const t of [first, refreshed, bobs]) api.accepted.add(t);

    const { sessionId } = await openSession(handle.url, first);

    const hijack = await rpc(handle.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { token: bobs, sessionId });
    assert.equal(hijack.res.status, 404, "another account holding the session id meets 'session not found'");

    const stale = await rpc(handle.url, { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { token: bearer(ALICE, { expInSeconds: -5 }), sessionId });
    assert.equal(stale.res.status, 401, 'a stale token mid-session is an HTTP 401, so the client refreshes');

    api.seen.length = 0;
    const call = await rpc(handle.url,
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_projects', arguments: {} } },
      { token: refreshed, sessionId });
    assert.equal(call.res.status, 200);
    assert.ok(api.seen.length > 0, 'the tool reached the API');
    assert.ok(api.seen.every((s) => s.token === refreshed), 'every API call rides the CURRENT bearer, never the opening one');
  } finally {
    await handle.shutdown();
    api.close();
  }
});

// ───────────────────────── B. the remote toolset ─────────────────────────

test('the toolset is the allowlist plus the catalog reads; machine-local tools never mount', async () => {
  const api = await startFakeApi();
  const handle = await startConnector(api);
  try {
    const token = bearer(ALICE);
    api.accepted.add(token);
    const { sessionId, instructions } = await openSession(handle.url, token);
    const { json } = await rpc(handle.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { token, sessionId });
    const names = json.result.tools.map((t) => t.name);

    // The catalog reads (mode-independent, anonymous) and get_server_info mount on every surface.
    const catalog = [...collectTools((s) => registerCatalogTools(s)).keys()];
    assert.deepEqual(
      [...names].sort(),
      [...ACCOUNT_TOOLS, ...catalog, 'get_server_info'].sort(),
      'exactly the allowlist, the catalog reads, and get_server_info');

    const local = ['forward_to_localhost', 'start_echo_server', 'set_endpoint_signing', 'request_seat',
      'read_pipe_manifest', 'write_pipe_manifest', 'join_invite'];
    for (const name of local) {
      assert.ok(!names.includes(name), `${name} needs the user's machine and must not mount`);
      assert.ok(!instructions.includes(name), `the instructions must not send an agent to ${name}`);
    }
  } finally {
    await handle.shutdown();
    api.close();
  }
});

// ───────────────────────── C. the logo on the install card ─────────────────────────

test('the connector serves its logo unauthenticated at /icon.png and /favicon.ico, and advertises it in serverInfo', async () => {
  const api = await startFakeApi();
  const handle = await startConnector(api);
  const origin = handle.url.replace(/\/mcp$/, '');
  try {
    for (const path of ['/icon.png', '/favicon.ico']) {
      const res = await fetch(origin + path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('content-type'), 'image/png', path);
      assert.equal(Buffer.from(await res.arrayBuffer()).equals(BRAND_ICON_PNG), true, `${path} is the embedded PNG`);
    }
    assert.equal((await fetch(origin + '/icon.png', { method: 'POST' })).status, 404, 'GET only: any other method is an unknown path');

    const token = bearer(ALICE);
    api.accepted.add(token);
    const { serverInfo } = await openSession(handle.url, token);
    assert.equal(serverInfo.title, 'FlurryPORT');
    assert.equal(serverInfo.websiteUrl, 'https://flurryport.io');
    assert.deepEqual(serverInfo.icons, [{ src: `${RESOURCE}/icon.png`, mimeType: 'image/png', sizes: ['512x512'] }]);
  } finally {
    await handle.shutdown();
    api.close();
  }
});
