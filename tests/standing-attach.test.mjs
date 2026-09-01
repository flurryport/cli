// Standing re-attach (#409 slice 5, mechanism A):
//  A. resolveRoomsStandingIdleMinutes — no-reaping default (Q5), env-bounded override.
//  B. HTTP drive against a fake Core API — the whole standing lifecycle in one
//     process: redeem a guest seat, COLLECT the first standing key from the live
//     session (attach_standing, no argument, seat PAT presented server-side),
//     re-attach a FRESH session with the saved key (no pairing code, cursor
//     continuity via ResumeCursor), rotation (each attach returns a NEW key and
//     kills the old one - the single active chain), and custody (the working PAT
//     never appears in any receipt; standingKey is the ONE surfaced credential).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated HOME before dist imports (the multi-principal contract).
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'fp-standing-home-'));
process.env.HOME = process.env.USERPROFILE;

const { buildSeatServer } = await import('../dist/lib/mcp-seat-tools.js');
const { serveMcpHttp } = await import('../dist/lib/mcp-http.js');
const { resolveRoomsStandingIdleMinutes } = await import('../dist/lib/rooms.js');

// ───────────────────────── A. the standing idle rule ─────────────────────────

test('standing idle default is NO reaping (Q5: expiry is the one reaper)', () => {
  delete process.env.FLURRYPORT_ROOMS_STANDING_IDLE_MINUTES;
  assert.equal(resolveRoomsStandingIdleMinutes(), null);
});

test('FLURRYPORT_ROOMS_STANDING_IDLE_MINUTES bounds it; junk keeps the default', () => {
  try {
    process.env.FLURRYPORT_ROOMS_STANDING_IDLE_MINUTES = '720';
    assert.equal(resolveRoomsStandingIdleMinutes(), 720);
    process.env.FLURRYPORT_ROOMS_STANDING_IDLE_MINUTES = '-5';
    assert.equal(resolveRoomsStandingIdleMinutes(), null);
    process.env.FLURRYPORT_ROOMS_STANDING_IDLE_MINUTES = 'soon';
    assert.equal(resolveRoomsStandingIdleMinutes(), null);
  } finally {
    delete process.env.FLURRYPORT_ROOMS_STANDING_IDLE_MINUTES;
  }
});

// ───────────────────────── B. the lifecycle drive ─────────────────────────

/**
 * Fake Core API: redemption hands out a guest seat; the standing exchange routes on
 * the credential exactly as the server does - the live seat PAT (first collection)
 * or the CURRENT standing key; anything else (including every rotated-away key) 404s.
 */
function startFakeApi() {
  const state = {
    seatToken: 'fp_seat_live_1',
    currentStandingKey: null, // set by the first exchange
    mint: 0,
    exchangeCredentials: [],
  };
  const release = (n) => ({
    Token: `fp_standing_pat_${n}`,
    SigningKey: `sig_${n}`,
    SigningScheme: 'simple',
    SigningHeader: 'X-Flurry-Signature',
    EndpointId: 'ep111',
    ProjectId: 'pr111',
    EndpointSlug: 'dispatch-test',
    ParticipantName: 'engineering',
    SeatRef: 'inv_standing1',
    ExpiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    JoinedAtCursor: 'J-boundary',
    ResumeCursor: 'R-lastack',
    StandingKey: `sk_rotated_${n}`,
  });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const json = (code, payload) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'POST' && req.url === '/api/v1/invites/seats/redeem') {
        return json(200, {
          Token: state.seatToken,
          SigningKey: 'sig_seat',
          SigningScheme: 'simple',
          SigningHeader: 'X-Flurry-Signature',
          EndpointId: 'ep111',
          ProjectId: 'pr111',
          EndpointSlug: 'dispatch-test',
          ParticipantName: 'engineering',
          SeatRef: 'inv_standing1',
          ExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          JoinedAtCursor: 'J-guest',
        });
      }
      if (req.method === 'POST' && req.url === '/api/v1/invites/seats/standing/exchange') {
        const { Credential } = JSON.parse(body);
        state.exchangeCredentials.push(Credential);
        const firstCollect = state.currentStandingKey === null && Credential === state.seatToken;
        const reAttach = state.currentStandingKey !== null && Credential === state.currentStandingKey;
        if (!firstCollect && !reAttach) return json(404, { type: 'not_found', detail: 'no standing' });
        state.mint += 1;
        const wire = release(state.mint);
        state.currentStandingKey = wire.StandingKey;
        return json(200, wire);
      }
      if (req.method === 'POST' && req.url === '/api/v1/endpoints/ep111/standing-credential-requests') {
        const { StewardEmail } = JSON.parse(body);
        state.askedFor = StewardEmail;
        return json(200, {
          MaskedEmail: 'g***@example.com',
          ExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          RequestedDays: 90,
        });
      }
      // Briefing reads (orientation/sections/canon) are best-effort - a 404 leaves
      // the seat seated with null briefing members, which is exactly the contract.
      return json(404, { type: 'not_found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ state, server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/** Minimal streamable-HTTP MCP session (the seat-server test's helper, trimmed). mcpUrl is the FULL /mcp url. */
function httpSession(mcpUrl) {
  let sid = null;
  let id = 0;
  async function send(body) {
    const res = await fetch(mcpUrl, {
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
    return null;
  }
  const rpc = (method, params) => send({ jsonrpc: '2.0', id: ++id, method, params });
  const call = async (name, args) => {
    const res = await rpc('tools/call', { name, arguments: args });
    assert.ok(res?.result?.content?.[0]?.text, `tool ${name} answered: ${JSON.stringify(res)}`);
    return JSON.parse(res.result.content[0].text);
  };
  const init = async () => {
    await rpc('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'standing-test', version: '0' },
    });
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  };
  return { call, init };
}

test('the standing lifecycle: collect from a live seat, re-attach by key, rotate, refuse the dead key', async () => {
  const api = await startFakeApi();
  const host = await serveMcpHttp({
    host: '127.0.0.1',
    port: 0,
    log: () => {},
    build: async () => buildSeatServer({ apiBase: api.base, version: '0-test' }),
  });
  try {
    // 1. Guest seating, the last ferried code of the flow.
    const first = httpSession(host.url);
    await first.init();
    const seated = await first.call('redeem_seat_code', { code: '7WHM-KR4P-XT2B' });
    assert.equal(seated.status, 'seated');

    // 1b. THE ASK (slice 7): on the human's word, the seat names their email; the
    //     answer is a MASK and an expiry, never the address back, never a grant.
    const asked = await first.call('request_standing_credential', { stewardEmail: 'gene@example.com' });
    assert.equal(asked.status, 'consent_mailed');
    assert.equal(asked.maskedEmail, 'g***@example.com');
    assert.equal(api.state.askedFor, 'gene@example.com', 'the literal address rides only the wire to Core');
    assert.match(asked.next, /attach_standing/);

    // 2. FIRST COLLECTION from the live session: no argument - the seat PAT is
    //    presented server-side, never by (or to) the agent.
    const collected = await first.call('attach_standing', {});
    assert.equal(collected.status, 'standing');
    assert.equal(collected.standingKey, 'sk_rotated_1');
    assert.equal(api.state.exchangeCredentials[0], 'fp_seat_live_1',
      'the first collection presents the live seat PAT in-cluster');
    // Custody: the working PAT appears in NO receipt.
    assert.ok(!JSON.stringify(collected).includes('fp_standing_pat_'),
      'the working credential never surfaces; standingKey is the one surfaced credential');

    // 3. Session dies (a restart, an eviction). A FRESH session re-attaches with
    //    the saved key: no pairing code, no human, cursor continuity.
    const second = httpSession(host.url);
    await second.init();
    const reattached = await second.call('attach_standing', { key: 'sk_rotated_1' });
    assert.equal(reattached.status, 'standing');
    assert.equal(reattached.participantName, 'engineering', 'the same identity, by identity');
    assert.equal(reattached.standingKey, 'sk_rotated_2', 'every attach rotates');
    assert.equal(reattached.resumeCursor, 'R-lastack', 'the byline resumes where its last tenure acknowledged');

    // 4. The rotated-away key is dead: the single active chain.
    const third = httpSession(host.url);
    await third.init();
    const refused = await third.call('attach_standing', { key: 'sk_rotated_1' });
    assert.equal(refused.error.code, 'standing_not_found');
    assert.match(refused.error.message, /rotated away|expired|never granted/);

    // 5. And with neither a key nor a live seat, the tool teaches the ceremony.
    const fourth = httpSession(host.url);
    await fourth.init();
    const unseated = await fourth.call('attach_standing', {});
    assert.equal(unseated.error.code, 'seat_required');
  } finally {
    await host.shutdown();
    api.server.close();
  }
});

// ───────────────────────── C. checked-in custody (#427) ─────────────────────────

/**
 * Fake Core API for the CHECKED-IN lane: the exchange releases with Custody
 * 'checked-in' and a NULL StandingKey; re-entry is the steward-approved device-flow
 * release (start arms, the shared poll releases once approved). The device code the
 * session generated must reach the server and NEVER any tool result.
 */
function startCheckedInFakeApi() {
  const state = {
    seatToken: 'fp_seat_live_ci',
    approved: false,
    armedDeviceCode: null,
    released: false,
    // Queue of one-shot poll failures: each entry is [status, body] answered
    // (and consumed) before the normal poll logic runs. Lets a test prove a
    // transient failure does not abort a pending ceremony.
    pollFailures: [],
  };
  const releaseFields = (n) => ({
    SigningKey: `sig_ci_${n}`,
    SigningScheme: 'simple',
    SigningHeader: 'X-Flurry-Signature',
    ParticipantName: 'engineering',
    ExpiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
  });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const json = (code, payload) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'POST' && req.url === '/api/v1/invites/seats/redeem') {
        return json(200, {
          Token: state.seatToken, EndpointId: 'ep222', ProjectId: 'pr222', EndpointSlug: 'dispatch-test',
          SeatRef: 'inv_ci1', JoinedAtCursor: 'J-ci', ...releaseFields(0),
          ExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (req.method === 'POST' && req.url === '/api/v1/invites/seats/standing/exchange') {
        const { Credential } = JSON.parse(body);
        if (Credential !== state.seatToken) return json(404, { type: 'not_found' });
        return json(200, {
          Token: 'fp_working_ci_1', EndpointId: 'ep222', ProjectId: 'pr222', EndpointSlug: 'dispatch-test',
          SeatRef: 'inv_ci1', JoinedAtCursor: 'J-ci', ResumeCursor: null,
          StandingKey: null, Custody: 'checked-in', ...releaseFields(1),
        });
      }
      if (req.method === 'POST' && req.url === '/api/v1/anon/device/standing-release/start') {
        const { EndpointId, Handle, DeviceCode } = JSON.parse(body);
        if (EndpointId !== 'ep222' || Handle !== 'engineering') return json(404, { type: 'not_found' });
        state.armedDeviceCode = DeviceCode;
        return json(200, {
          ApprovalUrl: 'http://app.example/standing-approve?code=xyz',
          ExpiresAt: new Date(Date.now() + 600_000).toISOString(),
          PollIntervalSeconds: 3,
        });
      }
      if (req.method === 'POST' && req.url === '/api/v1/anon/device/poll') {
        if (state.pollFailures.length) {
          const [failStatus, failBody] = state.pollFailures.shift();
          return json(failStatus, failBody);
        }
        const { DeviceCode } = JSON.parse(body);
        if (DeviceCode !== state.armedDeviceCode || state.released) return json(404, { type: 'not_found' });
        if (!state.approved) return json(200, { Status: 'pending', Token: null });
        state.released = true;
        return json(200, {
          Status: 'complete', Token: 'fp_working_ci_2',
          ContributorEndpointId: 'ep222', ContributorProjectId: 'pr222', EndpointSlug: 'dispatch-test',
          SeatRef: 'inv_ci1', StandingExpiresAt: new Date(Date.now() + 89 * 86_400_000).toISOString(),
          JoinedAtCursor: 'J-ci', ResumeCursor: 'R-ci-lastack', Custody: 'checked-in', ...releaseFields(2),
        });
      }
      return json(404, { type: 'not_found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ state, server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('checked-in custody: keyless collect, steward-approved re-entry, no credential ever surfaces', async () => {
  const api = await startCheckedInFakeApi();
  const host = await serveMcpHttp({
    host: '127.0.0.1',
    port: 0,
    log: () => {},
    build: async () => buildSeatServer({ apiBase: api.base, version: '0-test' }),
  });
  try {
    // 1. Guest seating + first collection on the live session: the release says
    //    checked-in, so NO standingKey rides the result - the agent holds nothing.
    const first = httpSession(host.url);
    await first.init();
    const seated = await first.call('redeem_seat_code', { code: '7WHM-KR4P-XT2B' });
    assert.equal(seated.status, 'seated');
    const collected = await first.call('attach_standing', {});
    assert.equal(collected.status, 'standing');
    assert.equal(collected.custodyMode, 'checked-in');
    assert.ok(!('standingKey' in collected), 'checked-in collect hands the agent no key');
    assert.match(collected.custody, /steward approves/);
    assert.ok(!JSON.stringify(collected).includes('fp_working_ci_'), 'the working credential never surfaces');

    // 2. Session loss. The fresh session holds NOTHING - it names handle + room
    //    and gets an approval URL to relay. The device code stays in the closure.
    const second = httpSession(host.url);
    await second.init();
    const armed = await second.call('attach_standing', { handle: 'engineering', endpointId: 'ep222' });
    assert.equal(armed.status, 'approval_pending');
    assert.match(armed.approvalUrl, /standing-approve/);
    assert.ok(api.state.armedDeviceCode, 'the session generated and sent a device code');
    assert.ok(!JSON.stringify(armed).includes(api.state.armedDeviceCode),
      'the device code never reaches a tool result - the session is the collector');

    // 3. Not approved yet: calling again just re-teaches the wait.
    const stillWaiting = await second.call('attach_standing', {});
    assert.equal(stillWaiting.status, 'approval_pending');

    // 4. The steward approves (out of band); the next call collects the seat.
    api.state.approved = true;
    const reseated = await second.call('attach_standing', {});
    assert.equal(reseated.status, 'standing');
    assert.equal(reseated.custodyMode, 'checked-in');
    assert.ok(!('standingKey' in reseated), 'still keyless after re-entry');
    assert.equal(reseated.resumeCursor, 'R-ci-lastack', 'cursor continuity survives the approval hop');
    assert.equal(reseated.participantName, 'engineering');

    // 5. An unknown handle/room 404s non-enumerably.
    const third = httpSession(host.url);
    await third.init();
    const refused = await third.call('attach_standing', { handle: 'stranger', endpointId: 'ep222' });
    assert.equal(refused.error.code, 'standing_not_found');
  } finally {
    await host.shutdown();
    api.server.close();
  }
});

// Precedent #9 (hardening brief): a 500/timeout on the briefing reads must NOT read
// as "this room published no orientation" - the fabricated-empty receipt #343's
// orientation lock exists to prevent. Only a 404 means the feature is absent.
test('a server error on the room reads yields briefingNote, not a fabricated empty room', async () => {
  const makeApi = (sectionsStatus) => new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const json = (code, payload) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (req.method === 'POST' && req.url === '/api/v1/invites/seats/redeem') {
          return json(200, {
            Token: 'fp_seat_b9', SigningKey: 'sig', SigningScheme: 'simple',
            SigningHeader: 'X-Flurry-Signature', EndpointId: 'ep9', ProjectId: 'pr9',
            EndpointSlug: 'locked-room', ParticipantName: 'probe', SeatRef: 'inv9',
            ExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          });
        }
        if (req.url?.endsWith('/sections')) return json(sectionsStatus, { detail: 'boom' });
        return json(404, { type: 'not_found' });
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });

  for (const [status, expectNote] of [[500, true], [404, false]]) {
    const api = await makeApi(status);
    const host = await serveMcpHttp({
      host: '127.0.0.1', port: 0, log: () => {},
      build: async () => buildSeatServer({ apiBase: api.base, version: '0-test' }),
    });
    try {
      const session = httpSession(host.url);
      await session.init();
      const seated = await session.call('redeem_seat_code', { code: '7WHM-KR4P-XT2B' });
      assert.equal(seated.status, 'seated', 'a briefing failure never blocks the seat');
      if (expectNote) {
        assert.match(seated.briefingNote ?? '', /not an empty room/,
          'a 500 on sections is named as unavailable');
      } else {
        assert.ok(!seated.briefingNote, 'a 404 is a legitimately absent feature - no note');
      }
    } finally {
      await host.shutdown();
      api.server.close();
    }
  }
});

// Precedent #6 regression (CLAUDE.20260829.cli-hardening-brief.md): a TRANSIENT poll
// failure (throttle, server error) must not abort a pending steward approval - the
// steward may already hold the relayed URL. Before the fix, ANY poll error cleared
// the pending release, orphaning the approval; and the collapsed 'error' code hid
// what actually happened. Only a 404 (denied/expired/used) closes the ceremony.
test('checked-in poll: transient failures carry their code and keep the ceremony alive; 404 closes it', async () => {
  const api = await startCheckedInFakeApi();
  const host = await serveMcpHttp({
    host: '127.0.0.1',
    port: 0,
    log: () => {},
    build: async () => buildSeatServer({ apiBase: api.base, version: '0-test' }),
  });
  try {
    const session = httpSession(host.url);
    await session.init();
    const armed = await session.call('attach_standing', { handle: 'engineering', endpointId: 'ep222' });
    assert.equal(armed.status, 'approval_pending');

    // A throttle and a server blip, each surfaced with a real code - not 'error',
    // and NOT release_closed (the ceremony is still live).
    api.state.pollFailures.push([429, { type: 'throttled', detail: 'Slow down.' }]);
    const throttled = await session.call('attach_standing', {});
    assert.equal(throttled.error.code, 'throttled', 'the machine code survives the parse');
    api.state.pollFailures.push([500, { detail: 'boom' }]);
    const blipped = await session.call('attach_standing', {});
    assert.notEqual(blipped.error?.code, 'release_closed', 'a 500 must not read as a closed window');

    // The pending release SURVIVED both failures: approval now releases the seat
    // without re-arming (the same device code collects).
    api.state.approved = true;
    const reseated = await session.call('attach_standing', {});
    assert.equal(reseated.status, 'standing', 'the ceremony survived the transient failures');
    assert.equal(reseated.custodyMode, 'checked-in');

    // And a real 404 after release IS terminal: a fresh session arms, then the
    // already-consumed release answers 404 - window closed, re-arm taught.
    const fresh = httpSession(host.url);
    await fresh.init();
    const gone = await fresh.call('attach_standing', { handle: 'engineering', endpointId: 'ep222' });
    assert.equal(gone.status, 'approval_pending', 're-armed a fresh ceremony');
    const closed = await fresh.call('attach_standing', {});
    assert.equal(closed.error.code, 'release_closed', 'a 404 still closes the ceremony');
  } finally {
    await host.shutdown();
    api.server.close();
  }
});
