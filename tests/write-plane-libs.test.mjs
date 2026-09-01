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

// Precedent #7 (hardening brief): done/stop used to run BEFORE the persist
// callback, so a callback throw discarded the one-shot released PAT and the
// poller never ran again - the human authenticated in the browser and was left
// silently unauthenticated. The release must be held in memory and the callback
// retried; the server is never re-polled for a release it will not repeat.
test('write-upgrade: a failing onGranted is retried from memory, not discarded', async () => {
  let releaseServed = 0;
  let pollsAfterRelease = 0;
  const { server, baseUrl } = await fakeGrantServer({
    register: () => [200, { ExpiresAt: new Date().toISOString() }],
    poll: () => {
      if (releaseServed) { pollsAfterRelease += 1; return [404, {}]; } // one-shot: gone
      releaseServed = 1;
      return [200, { Status: 'complete', Token: 'fp_fragile_grant' }];
    },
  });
  const granted = once();
  let attempts = 0;
  const silenced = console.error;
  console.error = () => {};
  const controller = new WriteUpgradeController(
    () => createAuthApiClient(baseUrl, 'fp_readonly'),
    (token) => {
      attempts += 1;
      if (attempts === 1) throw new Error('config write failed');
      granted.resolve(token);
    },
    () => granted.resolve('SKIPPED?!'),
    20,
  );
  try {
    controller.ensureStarted();
    assert.equal(await granted.promise, 'fp_fragile_grant', 'the grant survived the persist failure');
    assert.equal(attempts, 2, 'the callback was retried');
    assert.equal(pollsAfterRelease, 0, 'the one-shot release was never re-polled');
  } finally {
    console.error = silenced;
    controller.stop();
    server.close();
  }
});

test('device-flow: a failing onToken is retried from memory, not discarded', async () => {
  const { createAnonApiClient } = await import('../dist/lib/anon-api.js');
  const { DeviceFlowController } = await import('../dist/lib/device-flow.js');
  let releaseServed = 0;
  let pollsAfterRelease = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const json = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/api/v1/anon/device/start') return json(200, { ExpiresAt: new Date().toISOString() });
      if (req.url === '/api/v1/anon/device/poll') {
        if (releaseServed) { pollsAfterRelease += 1; return json(404, {}); }
        releaseServed = 1;
        return json(200, { Status: 'complete', Token: 'fp_claimed_once' });
      }
      return json(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = createAnonApiClient(`http://127.0.0.1:${server.address().port}`);
  const claimed = once();
  let attempts = 0;
  const silenced = console.error;
  console.error = () => {};
  const controller = new DeviceFlowController(
    client,
    (token) => {
      attempts += 1;
      if (attempts === 1) throw new Error('config write failed');
      claimed.resolve(token);
    },
    20,
  );
  try {
    controller.ensureStarted({ token: 'anontok', sessionSlug: 's', endpointSlug: 'e', expiresAt: new Date(Date.now() + 3600e3).toISOString(), captureCount: 0, capturesCap: 250, anonBaseUrl: client.baseUrl, createdAt: new Date().toISOString() });
    assert.equal(await claimed.promise, 'fp_claimed_once', 'the claim survived the persist failure');
    assert.equal(attempts, 2, 'the callback was retried');
    assert.equal(pollsAfterRelease, 0, 'the one-shot release was never re-polled');
  } finally {
    console.error = silenced;
    controller.stop();
    server.close();
  }
});

// Review finding 3 (the round-2 pass): the pending-delivery retry must neither
// re-enter a slow callback (double-invoking on the same one-shot token) nor
// retry a deterministic failure forever.
test('write-upgrade: a slow onGranted is never invoked concurrently and runs once', async () => {
  const { server, baseUrl } = await fakeGrantServer({
    register: () => [200, { ExpiresAt: new Date().toISOString() }],
    poll: () => [200, { Status: 'complete', Token: 'fp_slow_grant' }],
  });
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const granted = once();
  const controller = new WriteUpgradeController(
    () => createAuthApiClient(baseUrl, 'fp_readonly'),
    async (token) => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 120)); // far slower than the 15ms interval
      inFlight -= 1;
      granted.resolve(token);
    },
    () => granted.resolve('SKIPPED?!'),
    15,
  );
  try {
    controller.ensureStarted();
    assert.equal(await granted.promise, 'fp_slow_grant');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(maxInFlight, 1, 'no concurrent deliveries of the one-shot grant');
    assert.equal(calls, 1, 'the callback ran exactly once');
  } finally {
    controller.stop();
    server.close();
  }
});

test('write-upgrade: a deterministically failing onGranted stands down after the attempt cap', async () => {
  const { server, baseUrl } = await fakeGrantServer({
    register: () => [200, { ExpiresAt: new Date().toISOString() }],
    poll: () => [200, { Status: 'complete', Token: 'fp_cursed_grant' }],
  });
  let attempts = 0;
  const silenced = console.error;
  const lines = [];
  console.error = (line) => lines.push(String(line));
  const controller = new WriteUpgradeController(
    () => createAuthApiClient(baseUrl, 'fp_readonly'),
    () => { attempts += 1; throw new Error('disk says no'); },
    () => { throw new Error('no skip expected'); },
    10,
  );
  try {
    controller.ensureStarted();
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(attempts, 5, 'exactly the attempt cap, then no more');
    assert.ok(lines.some((l) => /Giving up/.test(l)), 'the stand-down names the manual path');
  } finally {
    console.error = silenced;
    controller.stop();
    server.close();
  }
});

// Round 3: the tick-entry latch alone missed polls ALREADY in flight when the
// release landed - two overlapping poll responses both reached deliverGrant and
// ran the callback twice on the one-shot token. The guard lives inside the
// shared BoundedDelivery now; this drives the real race: slow poll responses,
// fast interval, the server answering 'complete' to every in-flight poll.
test('write-upgrade: overlapping in-flight polls cannot double-run the one-shot callback', async () => {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const answer = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/api/v1/device/write-upgrade') return answer(200, { ExpiresAt: new Date().toISOString() });
      // Every poll answers complete - but SLOWLY (60ms), far beyond the 10ms
      // interval, so several polls are in flight when the first release lands.
      if (req.url === '/api/v1/anon/device/poll') {
        setTimeout(() => answer(200, { Status: 'complete', Token: 'fp_raced_grant' }), 60);
        return;
      }
      answer(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const granted = once();
  const controller = new WriteUpgradeController(
    () => createAuthApiClient(baseUrl, 'fp_readonly'),
    async (token) => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 80)); // slow persist: the race window
      inFlight -= 1;
      granted.resolve(token);
    },
    () => granted.resolve('SKIPPED?!'),
    10,
  );
  try {
    controller.ensureStarted();
    assert.equal(await granted.promise, 'fp_raced_grant');
    await new Promise((r) => setTimeout(r, 150)); // let straggler poll responses land
    assert.equal(maxInFlight, 1, 'no concurrent invocation from in-flight poll responses');
    assert.equal(calls, 1, 'the one-shot callback ran exactly once');
  } finally {
    controller.stop();
    server.close();
  }
});

// Precedent #4 (hardening brief): listen's setInterval overlapped when a batch ran
// slower than the interval - two concurrent polls read the same pending executions
// and forwarded the same capture twice. startSerialPoll schedules the next run only
// after the current one completes: concurrency is structurally 1.
test('startSerialPoll: a poll slower than the interval never overlaps itself', async () => {
  const { startSerialPoll } = await import('../dist/lib/serial-poll.js');
  let inFlight = 0;
  let maxInFlight = 0;
  let runs = 0;
  const loop = startSerialPoll(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    runs += 1;
    await new Promise((r) => setTimeout(r, 40)); // slower than the 5ms interval
    inFlight -= 1;
  }, 5);
  await new Promise((r) => setTimeout(r, 220));
  loop.stop();
  const runsAtStop = runs;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(maxInFlight, 1, 'no overlapping polls');
  assert.ok(runs >= 3, 'the loop kept re-arming');
  assert.ok(runs <= runsAtStop + 1, 'stop() stops the loop');
});

test('startSerialPoll: a throwing poll still re-arms', async () => {
  const { startSerialPoll } = await import('../dist/lib/serial-poll.js');
  let runs = 0;
  const loop = startSerialPoll(async () => {
    runs += 1;
    throw new Error('poll error');
  }, 5);
  await new Promise((r) => setTimeout(r, 60));
  loop.stop();
  assert.ok(runs >= 2, 'a throw does not kill the loop');
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

test('canon: sorted keys at every level, TOP-LEVEL sig excluded, no whitespace', () => {
  // Deliberately unsorted input + a sig field that must be dropped from the canonical form.
  assert.equal(
    canon({ b: 1, a: { z: 2, y: 3 }, sig: 'ignore-me' }),
    '{"a":{"y":3,"z":2},"b":1}',
  );
  assert.equal(canon([3, { k: 1 }, 'x']), '[3,{"k":1},"x"]');
});

// Precedent #2 (hardening brief): the old canon filtered sig at EVERY depth, so a
// nested payload.sig / moves[n].sig could be tampered while the chain read intact.
// Only the top-level signature envelope may be excluded from its own hash.
test('canon: NESTED sig fields are part of the canonical form', () => {
  const a = canon({ move: 3, payload: { sig: 'inner-1', v: 1 }, sig: 'outer' });
  const b = canon({ move: 3, payload: { sig: 'TAMPERED', v: 1 }, sig: 'outer' });
  assert.notEqual(a, b, 'a tampered nested sig must change the canonical form');
  assert.match(a, /inner-1/, 'the nested sig is hashed');
  assert.ok(!a.includes('outer'), 'the top-level sig still is not');
  // ...and inside arrays too (the moves[3].sig shape).
  const c = canon({ moves: [{ sig: 's0', to: 'a1' }] });
  assert.match(c, /"sig":"s0"/);
});

test('verifyChain: a tampered NESTED sig breaks the chain at the next event', () => {
  const e0 = { game: 'g', seq: 0, prevHash: '', payload: { sig: 'inner', v: 1 } };
  const e1 = { game: 'g', seq: 1, prevHash: sha256Hex(canon(e0)) };
  assert.equal(verifyChain([e0, e1]).intact, true);
  const tampered = { ...e0, payload: { sig: 'FORGED', v: 1 } };
  const res = verifyChain([tampered, e1]);
  assert.equal(res.intact, false, 'the forged nested sig no longer hashes to e1.prevHash');
  assert.equal(res.brokenAt, 1);
});

// Review finding 5: a chain recorded under the pre-0.6.4 rules must read as
// LEGACY (disclosed), never as tampered - and a genuinely tampered legacy chain
// must not hide behind the disclosure.
test('verifyChain: legacy chains disclose legacyIntact instead of reading as tampered', () => {
  // Build a chain the OLD rules would have produced: nested sig excluded from
  // the hash, so hash e0 with the nested sig stripped.
  const e0 = { seq: 0, prevHash: '', payload: { sig: 'inner', v: 1 } };
  const legacyHash0 = sha256Hex(canon({ seq: 0, prevHash: '', payload: { v: 1 } }));
  const e1 = { seq: 1, prevHash: legacyHash0 };
  const res = verifyChain([e0, e1]);
  assert.equal(res.intact, false, 'strict rules still refuse - no silent acceptance');
  assert.equal(res.legacyIntact, true, 'but the legacy rules vouch: not tampering');

  // Round-3 fix: nextPrevHash on a legacy-intact chain is the LEGACY tail hash,
  // so following the tool's own advice keeps the chain verifiable - before, it
  // was the strict hash at the break point and extending poisoned the chain
  // into broken-under-both.
  const legacyTail = sha256Hex(canon(e1)); // e1 has no nested sig, so canon == canonLegacy for it
  assert.equal(res.nextPrevHash, legacyTail, 'nextPrevHash is the legacy tail hash');
  const e2 = { seq: 2, prevHash: res.nextPrevHash };
  const extended = verifyChain([e0, e1, e2]);
  assert.equal(extended.legacyIntact, true, 'extending with nextPrevHash keeps the chain legacy-verifiable');

  // A pointerless genesis (old coercion) is the other legacy shape.
  const g0 = { seq: 0, player: 'X' };
  const g1 = { seq: 1, prevHash: sha256Hex(canon(g0)) };
  const g = verifyChain([g0, g1]);
  assert.equal(g.intact, false);
  assert.equal(g.legacyIntact, true, 'pointerless genesis reads as legacy, not tampered');

  // Genuinely tampered data verifies under NEITHER rule set.
  const t = verifyChain([e0, { seq: 1, prevHash: 'forged' }]);
  assert.equal(t.intact, false);
  assert.equal(t.legacyIntact, false, 'tampering cannot hide behind the legacy disclosure');

  // An intact strict chain carries no legacy field at all.
  const s0 = { seq: 0, prevHash: '' };
  const s1 = { seq: 1, prevHash: sha256Hex(canon(s0)) };
  assert.equal(verifyChain([s0, s1]).legacyIntact, undefined);
});

test('verifyChain: a pointerless event fails, genesis included', () => {
  // Before the fix a missing/non-string pointer coerced to '' and verified as
  // genesis under the empty-string convention.
  assert.equal(verifyChain([{ seq: 0, player: 'X' }]).intact, false, 'no prevHash field at genesis');
  assert.equal(verifyChain([{ seq: 0, prevHash: 42 }]).intact, false, 'non-string pointer');
  const e0 = { seq: 0, prevHash: '' };
  const stray = { seq: 1 }; // pointerless mid-chain
  const res = verifyChain([e0, stray]);
  assert.equal(res.intact, false);
  assert.equal(res.brokenAt, 1);
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
