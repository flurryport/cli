// Precedent #3 (CLAUDE.20260829.cli-hardening-brief.md): the streamable-HTTP
// transport had no Host/Origin guard - a DNS-rebinding page in the operator's
// browser could drive a loopback-bound seat server. The guard: strict Host
// allowlisting when bound to loopback (or when an allowlist is configured), and
// a present Origin header must always name an allowed host - no expected MCP
// client is a browser. /healthz stays probe-open. Session-id -> principal
// binding rides the Track B OAuth lane (no second credential exists yet).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'fp-guard-home-'));
process.env.HOME = process.env.USERPROFILE;

const { serveMcpHttp } = await import('../dist/lib/mcp-http.js');
const { buildSeatServer } = await import('../dist/lib/mcp-seat-tools.js');

function startHost(extra = {}) {
  return serveMcpHttp({
    host: '127.0.0.1',
    port: 0,
    log: () => {},
    build: async () => buildSeatServer({ apiBase: 'http://127.0.0.1:9', version: '0-test' }),
    whoami: () => ({ server: 'flurryport-seat' }),
    ...extra,
  });
}

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'guard-test', version: '0' } },
});

// fetch/undici refuses to override the Host header, so requests ride node:http
// directly - exactly what an attacker's rebinding page effectively produces.
function post(url, headers = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      },
    );
    req.on('error', reject);
    req.end(INIT_BODY);
  });
}

function get(url, headers = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: target.hostname, port: target.port, path: target.pathname, method: 'GET', headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('any present Origin is refused - foreign, null, and other-localhost-port alike; no Origin passes', async () => {
  const host = await startHost();
  try {
    const attacked = await post(host.url, { origin: 'http://attacker.example' });
    assert.equal(attacked.status, 403, 'browser cross-origin refused');
    // Review-round fixes: a sandboxed iframe sends the literal "null" Origin,
    // and a page on ANOTHER local port is still a browser - both refused now.
    const sandboxed = await post(host.url, { origin: 'null' });
    assert.equal(sandboxed.status, 403, 'Origin: null (sandboxed iframe) refused');
    const localPage = await post(host.url, { origin: `http://localhost:3000` });
    assert.equal(localPage.status, 403, 'another localhost port is still a browser');
    const legit = await post(host.url);
    assert.equal(legit.status, 200, 'a client without Origin initializes');
  } finally {
    await host.shutdown();
  }
});

test('FLURRYPORT_MCP_ALLOWED_ORIGINS admits an exact browser-client origin', async () => {
  process.env.FLURRYPORT_MCP_ALLOWED_ORIGINS = 'http://localhost:6274';
  try {
    const host = await startHost();
    try {
      const inspector = await post(host.url, { origin: 'http://localhost:6274' });
      assert.equal(inspector.status, 200, 'the deliberately allowed origin passes');
      const otherPort = await post(host.url, { origin: 'http://localhost:6275' });
      assert.equal(otherPort.status, 403, 'exact-origin match: a different port still refused');
    } finally {
      await host.shutdown();
    }
  } finally {
    delete process.env.FLURRYPORT_MCP_ALLOWED_ORIGINS;
  }

  // Round 3: browsers omit default ports in Origin, so a configured ":443"
  // must still match (URL.origin normalization on both sides).
  process.env.FLURRYPORT_MCP_ALLOWED_ORIGINS = 'https://rooms.example.com:443';
  try {
    const host = await startHost();
    try {
      const defaultPort = await post(host.url, { origin: 'https://rooms.example.com' });
      assert.equal(defaultPort.status, 200, 'a :443 allowlist entry matches the portless browser Origin');
    } finally {
      await host.shutdown();
    }
  } finally {
    delete process.env.FLURRYPORT_MCP_ALLOWED_ORIGINS;
  }
});

test('loopback bind: a rebound Host is refused, loopback Hosts pass, probes and preflight stay open', async () => {
  const host = await startHost();
  try {
    const rebound = await post(host.url, { host: 'attacker.example' });
    assert.equal(rebound.status, 403, 'DNS-rebinding Host refused');
    const localhost = await post(host.url, { host: `localhost:${host.port}` });
    assert.equal(localhost.status, 200, 'loopback Host accepted');
    // Review-round fix: the loopback definition is local-forward's shared one -
    // the whole 127/8 range and *.localhost count as this machine.
    const dotted = await post(host.url, { host: `127.0.0.5:${host.port}` });
    assert.equal(dotted.status, 200, '127/8 Hosts are loopback too');
    const probe = await get(host.url.replace('/mcp', '/healthz'), { host: 'probe.internal' });
    assert.equal(probe.status, 200, 'health probes are exempt');
    // Review-round fix: /whoami is the #288 preflight an agent hits BEFORE the
    // tunnel host is configured - exempt from the Host half (no side effects,
    // cross-origin responses unreadable), still refused for browsers.
    const preflight = await get(host.url.replace('/mcp', '/whoami'), { host: 'tunnel.not-yet-configured.example' });
    assert.equal(preflight.status, 200, 'the preflight answers through an unconfigured tunnel');
    const browserPreflight = await get(host.url.replace('/mcp', '/whoami'), { origin: 'http://attacker.example' });
    assert.equal(browserPreflight.status, 403, 'a browser still cannot use the preflight');
    // The refusal teaches the escape hatch instead of a bare 403.
    const refusalBody = await new Promise((resolve, reject) => {
      const target = new URL(host.url);
      const req = request(
        { host: target.hostname, port: target.port, path: '/mcp', method: 'POST', headers: { host: 'tunnel.example', 'content-type': 'application/json' } },
        (res) => {
          let body = '';
          res.on('data', (d) => { body += d; });
          res.on('end', () => resolve(body));
        },
      );
      req.on('error', reject);
      req.end(INIT_BODY);
    });
    assert.match(refusalBody, /FLURRYPORT_MCP_ALLOWED_HOSTS/, 'the 403 names the fix');
  } finally {
    await host.shutdown();
  }
});

test('allowedHosts and FLURRYPORT_MCP_ALLOWED_HOSTS admit the fronting host', async () => {
  const viaOption = await startHost({ allowedHosts: ['rooms.flurryport.io'] });
  try {
    const fronted = await post(viaOption.url, { host: 'rooms.flurryport.io' });
    assert.equal(fronted.status, 200, 'the configured public host passes');
    const other = await post(viaOption.url, { host: 'evil.example' });
    assert.equal(other.status, 403, 'everything else still refused');
  } finally {
    await viaOption.shutdown();
  }

  process.env.FLURRYPORT_MCP_ALLOWED_HOSTS = 'tunnel.example:443, other.example';
  try {
    const viaEnv = await startHost();
    try {
      const tunneled = await post(viaEnv.url, { host: 'tunnel.example' });
      assert.equal(tunneled.status, 200, 'the env-configured host passes (port ignored)');
      // Review-round fix: an allowed HOST is not an allowed ORIGIN - a present
      // Origin is a browser and needs the explicit origins allowlist.
      const originStillBrowser = await post(viaEnv.url, { origin: 'https://tunnel.example' });
      assert.equal(originStillBrowser.status, 403, 'allowed hosts do not admit browser origins');
    } finally {
      await viaEnv.shutdown();
    }
  } finally {
    delete process.env.FLURRYPORT_MCP_ALLOWED_HOSTS;
  }
});
