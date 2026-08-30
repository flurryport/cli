import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// B2.3/B2.4 lib coverage: the keystore and the pipe manifest. The manifest's
// secret-shape refusal is the safety-relevant piece - it is what keeps token
// values out of a file that gets committed to user repos.

const { readManifest, upsertManifestEntry, removeManifestEntry, findSecretMaterial, manifestPath } =
  await import('../dist/lib/pipe-manifest.js');
const { generateSigningKey, signingKeyRef, contributorKeyRef } = await import('../dist/lib/keystore.js');
const { createInviteJoinClient } = await import('../dist/lib/invite-api.js');
const { canon, sha256Hex, verifyChain } = await import('../dist/lib/hashchain.js');

const cwd = mkdtempSync(join(tmpdir(), 'fp-libs-'));

test('manifest: empty read, upsert-by-name, remove', () => {
  assert.deepEqual(readManifest(cwd), { version: 1, pipes: [] });

  upsertManifestEntry({ name: 'p1', project: 'P', endpoint: 'hook' }, cwd);
  upsertManifestEntry({ name: 'p1', project: 'P', endpoint: 'hook2' }, cwd); // upsert, not append
  upsertManifestEntry({ name: 'p2', project: 'P', endpoint: 'other' }, cwd);

  const manifest = readManifest(cwd);
  assert.equal(manifest.pipes.length, 2);
  assert.equal(manifest.pipes.find((p) => p.name === 'p1').endpoint, 'hook2');

  removeManifestEntry('p1', cwd);
  assert.deepEqual(readManifest(cwd).pipes.map((p) => p.name), ['p2']);
  assert.ok(existsSync(manifestPath(cwd)));
});

test('manifest: token-shaped values are refused in ANY field', () => {
  const shapes = [
    'fp_AAAAAAAAAAAAAAAAAAAAAAAA',            // FlurryPORT PAT
    'fpsk_' + 'a'.repeat(43),                  // signing key
    'whsec_abcdef1234',                        // provider webhook secret
    'xoxb-1234567890-abcdef',                  // Slack bot token
    'ghp_ABCDEFGHIJKLMNOP1234',                // GitHub PAT
  ];
  for (const value of shapes) {
    assert.ok(findSecretMaterial({ name: 'x', note: value }), value);
    assert.throws(
      () => upsertManifestEntry({ name: 'leaky', project: 'P', endpoint: 'e', recipe: value }, cwd),
      /secret material/,
      value,
    );
  }
  // Refs are fine - that is the whole point.
  assert.equal(findSecretMaterial({ signing: { localKeyRef: 'signing:abc123' } }), null);
});

test('keystore: signing keys are high-entropy, prefixed, and ref-addressable', () => {
  const a = generateSigningKey();
  const b = generateSigningKey();
  assert.ok(a.startsWith('fpsk_') && a.length >= 40, a.slice(0, 8));
  assert.notEqual(a, b, 'CSPRNG, not a constant');
  assert.equal(signingKeyRef('EPID'), 'signing:EPID');
});

test('manifest file on disk carries no secret material after legit writes', () => {
  upsertManifestEntry({
    name: 'kudos', project: 'P', endpoint: 'hook',
    signing: { header: 'X-Flurry-Signature', scheme: 'hmac-sha256', localKeyRef: 'signing:EP' },
  }, cwd);
  const raw = readFileSync(manifestPath(cwd), 'utf8');
  assert.equal(findSecretMaterial(JSON.parse(raw)), null);
});

// ── In-flow write grant (2026-07-20): WriteUpgradeController behavior against a
// tiny local fake of the register + poll endpoints. The controller is the client
// half of the second device-flow release: arm -> poll -> grant swaps the token /
// skip narrates read-only. Offline, loopback only.

const { WriteUpgradeController } = await import('../dist/lib/write-upgrade.js');
const { createAuthApiClient } = await import('../dist/lib/auth-api.js');
const { createServer } = await import('node:http');

function fakeGrantServer(behavior) {
  // behavior.register: (body) => [status, payload]; behavior.poll: () => [status, payload]
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const [status, payload] =
        req.url === '/api/v1/device/write-upgrade' ? behavior.register(body)
        : req.url === '/api/v1/anon/device/poll' ? behavior.poll(body)
        : [404, {}];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

function once() {
  let resolveIt;
  const promise = new Promise((r) => { resolveIt = r; });
  return { promise, resolve: resolveIt };
}

test('write-upgrade: grant releases the token once and the device code never leaves raw over query', async () => {
  let registeredCode = null;
  let polls = 0;
  const { server, baseUrl } = await fakeGrantServer({
    register: (body) => { registeredCode = body.DeviceCode; return [200, { ExpiresAt: new Date().toISOString() }]; },
    poll: (body) => {
      polls += 1;
      assert.equal(body.DeviceCode, registeredCode, 'poll uses the registered code');
      return polls < 3 ? [200, { Status: 'pending' }] : [200, { Status: 'complete', Token: 'fp_write_tok' }];
    },
  });
  const granted = once();
  const controller = new WriteUpgradeController(
    () => createAuthApiClient(baseUrl, 'fp_readonly'),
    (token) => granted.resolve(token),
    () => granted.resolve('SKIPPED?!'),
    20, // pollIntervalMs — fast for the test
  );
  controller.ensureStarted();
  controller.ensureStarted(); // idempotent — no double timers / double registration

  const token = await granted.promise;
  assert.equal(token, 'fp_write_tok');
  assert.ok(registeredCode.length >= 32, 'high-entropy device code');
  controller.stop();
  server.close();
});

test('write-upgrade: skip reports write:false exactly once and stops', async () => {
  const { server, baseUrl } = await fakeGrantServer({
    register: () => [200, { ExpiresAt: new Date().toISOString() }],
    poll: () => [200, { Status: 'skipped' }],
  });
  const skipped = once();
  const controller = new WriteUpgradeController(
    () => createAuthApiClient(baseUrl, 'fp_readonly'),
    () => skipped.resolve('GRANTED?!'),
    () => skipped.resolve('skipped'),
    20,
  );
  controller.ensureStarted();
  assert.equal(await skipped.promise, 'skipped');
  controller.stop();
  server.close();
});

test('write-upgrade: a token that already has write stops arming for good (409)', async () => {
  let registers = 0;
  const { server, baseUrl } = await fakeGrantServer({
    register: () => { registers += 1; return [409, { Error: 'already_write' }]; },
    poll: () => { throw new Error('must never poll after an already_write refusal'); },
  });
  const controller = new WriteUpgradeController(
    () => createAuthApiClient(baseUrl, 'fp_write_already'),
    () => { throw new Error('no grant expected'); },
    () => { throw new Error('no skip expected'); },
    20,
  );
  controller.ensureStarted();
  await new Promise((r) => setTimeout(r, 150));
  controller.ensureStarted(); // must stay stopped — alreadyWrite is terminal
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(registers, 1, 'one refusal is enough');
  controller.stop();
  server.close();
});

test('write-upgrade: lapsed hand-off (404 poll) re-registers on the next tick', async () => {
  let registers = 0;
  let polls = 0;
  const { server, baseUrl } = await fakeGrantServer({
    register: () => { registers += 1; return [200, { ExpiresAt: new Date().toISOString() }]; },
    poll: () => {
      polls += 1;
      if (polls === 1) return [404, {}];                       // TTL lapse
      return registers >= 2
        ? [200, { Status: 'complete', Token: 'fp_after_rearm' }]
        : [200, { Status: 'pending' }];
    },
  });
  const granted = once();
  const controller = new WriteUpgradeController(
    () => createAuthApiClient(baseUrl, 'fp_readonly'),
    (token) => granted.resolve(token),
    () => granted.resolve('SKIPPED?!'),
    20,
  );
  controller.ensureStarted();
  assert.equal(await granted.promise, 'fp_after_rearm');
  assert.ok(registers >= 2, 'controller re-registered after the 404');
  controller.stop();
  server.close();
});

// ── WS4: `flurryport join` client (invite-api) ─────────────────────────────
function fakeInviteServer(behavior) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const [status, payload] =
        /^\/api\/v1\/invites\/[^/]+\/device\/start$/.test(req.url) ? behavior.register(req.url, body)
        : req.url === '/api/v1/anon/device/poll' ? behavior.poll(body)
        : (req.method === 'GET' && /^\/api\/v1\/invites\/[^/]+$/.test(req.url) && behavior.landing)
          ? behavior.landing(req.url)
        : [404, {}];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

test('invite join: contributor keystore ref + landing url are stable and endpoint-keyed', () => {
  assert.equal(contributorKeyRef('e12345'), 'contributor:e12345');
  const c = createInviteJoinClient('https://api.example.com/'); // trailing slash trimmed
  assert.equal(c.baseUrl, 'https://api.example.com');
  assert.equal(c.landingUrl('fpi_tok'), 'https://api.example.com/api/v1/invites/fpi_tok');
});

test('invite join: producer poll parses the signing grant off the shared poll route', async () => {
  let startedToken = null;
  let deviceCode = null;
  const { server, baseUrl } = await fakeInviteServer({
    register: (url, body) => {
      startedToken = decodeURIComponent(url.split('/')[4]); // /api/v1/invites/<token>/device/start
      deviceCode = body.DeviceCode;
      return [200, { ExpiresAt: new Date().toISOString() }];
    },
    poll: (body) => {
      assert.equal(body.DeviceCode, deviceCode, 'poll uses the registered device code');
      return [200, {
        Status: 'complete',
        Token: 'fp_scoped_read',
        SigningKey: 'c2lnbmluZy1rZXk=',
        SigningScheme: 'simple',
        SigningHeader: 'X-Sig',
        ContributorEndpointId: 'ep62',
        ContributorProjectId: 'proj62',
      }];
    },
  });

  const client = createInviteJoinClient(baseUrl);
  await client.registerInviteDevice('fpi_producer_token', 'devcode-abc');
  const res = await client.pollInviteDevice('devcode-abc');

  assert.equal(startedToken, 'fpi_producer_token', 'register hit the invite-token start route');
  assert.equal(res.Status, 'complete');
  assert.equal(res.Token, 'fp_scoped_read', 'monitor read PAT rides along for the producer');
  assert.equal(res.SigningKey, 'c2lnbmluZy1rZXk=');
  assert.equal(res.ContributorEndpointId, 'ep62');
  assert.equal(res.ContributorProjectId, 'proj62', 'both opaque ids ride the grant for post_intent');
  server.close();
});

// ── discovery bridge (2026-07-24): getLanding feeds the join receipt recipeRef + role ──
// The join receipt learns the collaboration facts from the landing's agent JSON. This fetch
// is best-effort by contract: it must NEVER throw or reject, so a missing/broken landing just
// omits the discovery steer instead of failing the join the human already accepted.

test('getLanding: returns recipeRef + role from the landing agent JSON', async () => {
  let hitUrl = null;
  const { server, baseUrl } = await fakeInviteServer({
    register: () => [200, {}],
    poll: () => [200, {}],
    landing: (url) => { hitUrl = url; return [200, { recipeRef: 'flurryport:tic-tac-toe@6', role: 'joiner' }]; },
  });
  const client = createInviteJoinClient(baseUrl);
  try {
    const landing = await client.getLanding('fpi_join_token');
    assert.equal(hitUrl, '/api/v1/invites/fpi_join_token', 'fetches the landing route by invite token');
    // status + grantCollectedAt joined the shape for the ceremony-honesty checks
    // (pilot-1 ledger item 2); absent on this landing, they normalize to null.
    assert.deepEqual(landing, {
      recipeRef: 'flurryport:tic-tac-toe@6',
      role: 'joiner',
      status: null,
      grantCollectedAt: null,
    });
  } finally {
    server.close();
  }
});

test('getLanding: missing fields normalize to null (never undefined) so the receipt stays well-shaped', async () => {
  const { server, baseUrl } = await fakeInviteServer({
    register: () => [200, {}],
    poll: () => [200, {}],
    landing: () => [200, { somethingElse: true }], // a landing with no recipe/role
  });
  const client = createInviteJoinClient(baseUrl);
  try {
    const landing = await client.getLanding('fpi_bare');
    assert.deepEqual(landing, { recipeRef: null, role: null, status: null, grantCollectedAt: null });
  } finally {
    server.close();
  }
});

test('getLanding: a non-OK landing returns null rather than a partial object', async () => {
  const { server, baseUrl } = await fakeInviteServer({
    register: () => [200, {}],
    poll: () => [200, {}],
    landing: () => [404, { error: 'gone' }],
  });
  const client = createInviteJoinClient(baseUrl);
  assert.equal(await client.getLanding('fpi_missing'), null);
  server.close();
});

test('getLanding: a network failure is swallowed to null (best-effort, never breaks the join)', async () => {
  // Point at a port with nothing listening: fetch rejects, getLanding must absorb it.
  const client = createInviteJoinClient('http://127.0.0.1:1'); // port 1: connection refused
  assert.equal(await client.getLanding('fpi_unreachable'), null);
});

// ── hashchain helper (P3): the turnkey ceremony so agents never hand-roll canon/SHA ──
// The verify_chain tool is a thin wrapper over these; the canon rule here IS the recipe's rule.

test('canon: sorted keys at every level, sig excluded, no whitespace', () => {
  // Deliberately unsorted input + a sig field that must be dropped from the canonical form.
  assert.equal(
    canon({ b: 1, a: { z: 2, y: 3 }, sig: 'ignore-me' }),
    '{"a":{"y":3,"z":2},"b":1}',
  );
  assert.equal(canon([3, { k: 1 }, 'x']), '[3,{"k":1},"x"]');
});

test('verifyChain: a well-formed chain is intact and yields the next prevHash', () => {
  const e0 = { game: 'g', seq: 0, prevHash: '', player: 'X', action: 'start' };
  const h0 = sha256Hex(canon(e0));
  const e1 = { game: 'g', seq: 1, prevHash: h0, player: 'X', action: 'move' };

  const res = verifyChain([e0, e1]);
  assert.equal(res.intact, true);
  assert.equal(res.brokenAt, null);
  assert.equal(res.count, 2);
  // nextPrevHash is the hash of the last event: chaining a seq-2 off it must verify.
  const e2 = { game: 'g', seq: 2, prevHash: res.nextPrevHash, player: 'O', action: 'move' };
  assert.equal(verifyChain([e0, e1, e2]).intact, true);
});

test('verifyChain: a tampered prevHash is caught at its index', () => {
  const e0 = { game: 'g', seq: 0, prevHash: '', player: 'X', action: 'start' };
  const e1 = { game: 'g', seq: 1, prevHash: 'not-the-real-hash', player: 'X', action: 'move' };

  const res = verifyChain([e0, e1]);
  assert.equal(res.intact, false);
  assert.equal(res.brokenAt, 1);
});

test('verifyChain: honors a custom hashField and genesis', () => {
  const e0 = { seq: 0, link: 'GENESIS' };
  const h0 = sha256Hex(canon(e0));
  const e1 = { seq: 1, link: h0 };
  assert.equal(verifyChain([e0, e1], { hashField: 'link', genesisPrevHash: 'GENESIS' }).intact, true);
});
