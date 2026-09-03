// Seat server regression net (0.5.0, #233):
//  A. Proof vector — computeSeatProof must match the server's SeatPairingCode contract
//     byte for byte (HMAC-SHA256 keyed by SHA-256 of the canonicalized code, over
//     handle.nonce.timestamp), or every redemption 404s.
//  B. Unit surface — the seat inventory is EXACTLY four tools; pre-redemption room
//     verbs answer seat_required with a seat-mode meta envelope.
//  C. HTTP drive — the first streamable-HTTP coverage in the suite: real MCP sessions
//     against `flurryport seat-server` + a fake Core API, proving the ceremony
//     (redeem -> read -> signed post), credential custody (no token or key in any
//     receipt), the proof_stale auto-retry, and principal isolation across two
//     concurrent sessions in one process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'index.js');

// Isolated HOME before dist imports: the seat server must never touch the operator's
// real ~/.flurryport (multi-principal contract), and neither may this test.
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'fp-seat-home-'));
process.env.HOME = process.env.USERPROFILE;

const { computeSeatProof, canonicalizeCode, codeHandle } = await import('../dist/lib/seat-ceremony.js');
const { registerSeatTools, buildSeatMeta, ROOM_IDLE_NOTICE_MINUTES } = await import('../dist/lib/mcp-seat-tools.js');
const { collectTools } = await import('../dist/lib/mcp-unified.js');
const { AttentionRelay } = await import('../dist/lib/attention-relay.js');
const { guidToBase62 } = await import('../dist/lib/base62.js');

// ───────────────────────── A. proof vector ─────────────────────────

test('computeSeatProof matches the server contract exactly (the guarded vector)', () => {
  const proof = computeSeatProof('7WHM-KR4P-XT2B', '7WHM', 'nonce-123456', '2026-08-13T21:00:00Z');
  // Independent derivation, straight from node:crypto: key = SHA-256(utf8(code)),
  // message = utf8("handle.nonce.timestamp"), proof = lowercase hex HMAC-SHA256.
  const key = createHash('sha256').update(Buffer.from('7WHM-KR4P-XT2B', 'utf8')).digest();
  const expected = createHmac('sha256', key)
    .update(Buffer.from('7WHM.nonce-123456.2026-08-13T21:00:00Z', 'utf8'))
    .digest('hex');
  assert.equal(proof, expected);
  assert.equal(proof.length, 64, 'lowercase hex HMAC-SHA256 is 64 chars');
  assert.equal(proof, proof.toLowerCase());
});

test('canonicalization forgives whitespace and case; the handle is the first group', () => {
  const proof = computeSeatProof('7WHM-KR4P-XT2B', '7WHM', 'n-12345678', '2026-08-13T21:00:00Z');
  assert.equal(computeSeatProof('  7whm-kr4p-xt2b ', '7WHM', 'n-12345678', '2026-08-13T21:00:00Z'), proof);
  assert.equal(canonicalizeCode(' 7whm-kr4p-xt2b'), '7WHM-KR4P-XT2B');
  assert.equal(codeHandle(' 7whm-kr4p-xt2b'), '7WHM');
});

// ───────────────────────── B. unit surface ─────────────────────────

test('seat inventory is exactly the mounted seat tools', () => {
  const tools = collectTools((s) => registerSeatTools(s, { apiBase: 'http://127.0.0.1:9' }));
  assert.deepEqual(
    [...tools.keys()].sort(),
    ['attach_standing', 'get_canon', 'get_capture', 'get_roster', 'list_captures', 'list_sections', 'ping', 'post', 'post_intent', 'read', 'redeem_seat_code', 'request_standing_credential', 'wait_for_posts'],
  );
});

test('pre-redemption room verbs answer seat_required with a seat-mode envelope', async () => {
  const tools = collectTools((s) => registerSeatTools(s, { apiBase: 'http://127.0.0.1:9' }));
  for (const name of ['list_captures', 'get_capture', 'post_intent', 'get_roster', 'wait_for_posts', 'list_sections', 'get_canon']) {
    const result = await tools.get(name).handler({});
    assert.equal(result.isError, true, `${name} must refuse before redemption`);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.error.code, 'seat_required', name);
    assert.match(payload.error.message, /redeem_seat_code/, name);
    assert.match(payload.error.message, /pairing code/, name);
    assert.equal(payload.meta.mode, 'seat', name);
  }
});

test('buildSeatMeta: ok far out, nearing_expiry with a seat_ending notice in the final hour', () => {
  const far = buildSeatMeta({ expiresAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString() });
  assert.equal(far.state, 'ok');
  assert.equal(far.notice, null);
  assert.ok(far.expiresInMinutes > 60);
  const near = buildSeatMeta({ expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() });
  assert.equal(near.state, 'nearing_expiry');
  assert.equal(near.notice.code, 'seat_ending');
  assert.match(near.notice.message, /keeps attribution/);
});

// ───────────────────────── B2. attention relay (0.5.1 slice C) ─────────────────────────

test('AttentionRelay: one-shot delivery, name normalization, urgency merge, resume replaces', () => {
  const relay = new AttentionRelay();
  // Keys normalize through the handle alphabet on both sides: the chair's roster
  // name ("Bunny") and the seat principal's minted name ("bunny") meet in the middle.
  relay.set('Bunny', { code: 'attention_hold', panic: false });
  assert.deepEqual(relay.take('bunny'), { code: 'attention_hold', panic: false });
  assert.equal(relay.take('bunny'), null, 'the take is the delivery: one shot');

  // Highest urgency wins while undelivered: panic interrupt > interrupt > hold.
  relay.set('bunny', { code: 'attention_hold', panic: false });
  relay.set('bunny', { code: 'attention_interrupt', panic: true });
  relay.set('bunny', { code: 'attention_hold', panic: false }); // a quieter follow-up never downgrades
  assert.deepEqual(relay.take('bunny'), { code: 'attention_interrupt', panic: true });

  // Resume always replaces: it clears the held notice (the stream keeps the record).
  relay.set('bunny', { code: 'attention_hold', panic: false });
  relay.set('bunny', { code: 'attention_resume', panic: false });
  assert.deepEqual(relay.take('bunny'), { code: 'attention_resume', panic: false });
});

test('buildSeatMeta relays the attention wake-up, and it outranks the seat_ending courtesy', () => {
  const relay = new AttentionRelay();
  const principal = { expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), participantName: 'envoy-alpha' };
  // No order pending: the nearing-expiry courtesy still owns the slot.
  assert.equal(buildSeatMeta(principal, relay).notice.code, 'seat_ending');
  // A pending panic interrupt outranks it; the envelope shape is unchanged (additive).
  relay.set('envoy-alpha', { code: 'attention_interrupt', panic: true });
  const meta = buildSeatMeta(principal, relay);
  assert.equal(meta.mode, 'seat');
  assert.equal(meta.state, 'nearing_expiry');
  assert.equal(meta.notice.code, 'attention_interrupt');
  assert.match(meta.notice.message, /EMERGENCY STOP/);
  assert.match(meta.notice.message, /fp:ack/);
  // Delivered means delivered: the courtesy returns on the next response.
  assert.equal(buildSeatMeta(principal, relay).notice.code, 'seat_ending');
});

// ───────────────────────── C. HTTP drive ─────────────────────────

const CODE_A = 'ABCD-EFGH-JKMN'; // alphabet-legal fixtures
const CODE_B = 'PQRS-TUVW-XYZ2';
const CAP_GUID = '01234567-89ab-cdef-0123-456789abcdef';

function verifyFakeProof(code, body) {
  const key = createHash('sha256').update(Buffer.from(code, 'utf8')).digest();
  const expected = createHmac('sha256', key)
    .update(Buffer.from(`${body.CodeHandle}.${body.Nonce}.${body.Timestamp}`, 'utf8'))
    .digest('hex');
  return expected === body.Proof;
}

/**
 * Fake Core API: seat redemption for two codes (code B answers proof_stale on its
 * first VALID proof to prove the auto-retry), the endpoint read post_intent needs,
 * the captures list/detail, and the capture URL that records signatures.
 */
function startFakeApi() {
  const state = {
    redeems: [],           // every parsed redeem body
    reads: [],             // {url, auth} for endpoint-scoped reads
    posts: [],             // {headers, body} for capture posts
    waits: [],             // {url, auth} for /wait long-poll hits (#275)
    waitQueue: [],         // scripted /wait responses, shifted per hit; empty = timeout echo
    listCreatedAt: null,   // override for idle-room clock coverage (#291)
    briefs: [],            // {url} for the #345 room-brief reads at redemption
    inviteItems: null,     // override for the roster dedupe coverage (#409)
    orientationCaptureId: CAP_GUID, // null emulates a room with no orientation
    canonRecap: 'Plain words, no hype.',
    betaStaleServed: false,
    standing: null,        // #478: extra members merged into alpha's redemption release
    exchanges: [],         // every Credential presented to the standing exchange
    exchangeAnswers: 200,  // 404 emulates a lane the server did not re-open
  };
  const release = (name) => ({
    Token: `fp_seat_${name}`,
    SigningKey: `seat-key-${name}`,
    SigningScheme: 'simple',
    SigningHeader: 'X-Flurry-Signature',
    EndpointId: 'EPSEAT',
    ProjectId: 'PSEAT',
    EndpointSlug: 'table',
    ParticipantName: `envoy-${name}`,
    SeatRef: `inv_${name}`,
    ExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/api/v1/invites/seats/redeem' && req.method === 'POST') {
        const parsed = JSON.parse(body);
        state.redeems.push(parsed);
        if (parsed.Nonce.length < 8 || Number.isNaN(Date.parse(parsed.Timestamp))) {
          return json(422, { title: 'validation', detail: 'bad redeem body' });
        }
        if (parsed.CodeHandle === 'ABCD' && verifyFakeProof(CODE_A, parsed)) {
          // #274: the server issues the join boundary WITH the redemption.
          return json(200, { ...release('alpha'), JoinedAtCursor: 'jc-boundary', ...(state.standing ?? {}) });
        }
        if (parsed.CodeHandle === 'PQRS' && verifyFakeProof(CODE_B, parsed)) {
          if (!state.betaStaleServed) {
            state.betaStaleServed = true;
            return json(400, { title: 'proof_stale', detail: 'Valid proof, stale timestamp. Recompute with a fresh nonce and timestamp and retry.' });
          }
          // #274: beta's release deliberately OMITS JoinedAtCursor - the old-server shape.
          return json(200, release('beta'));
        }
        // Unknown / wrong proof: the non-enumerable answer.
        return json(404, { title: 'not_found', detail: 'Not found' });
      }
      if (req.method === 'POST' && req.url === '/api/v1/invites/seats/standing/exchange') {
        // #478: the first-collection lane, re-opened by redemption for a handle that
        // already holds standing. Only the fresh seat token may exchange.
        const { Credential } = JSON.parse(body);
        state.exchanges.push(Credential);
        if (state.exchangeAnswers !== 200 || Credential !== 'fp_seat_alpha') {
          return json(404, { title: 'not_found', detail: 'Not found' });
        }
        return json(200, {
          ...release('alpha'),
          Token: 'fp_working_alpha_1',
          StandingKey: 'stk_alpha_1',
          Custody: 'unattended',
          JoinedAtCursor: 'jc-boundary',
          ResumeCursor: 'rc-last-ack',
        });
      }
      if (req.method === 'GET' && req.url === '/api/v1/projects/PSEAT/endpoints/EPSEAT/sections') {
        state.briefs.push({ url: req.url, auth: req.headers.authorization ?? null });
        return json(200, {
          EndpointId: 'EPSEAT',
          OrientationCaptureId: state.orientationCaptureId,
          Sections: [{ Handle: 'marketing-voice', Description: 'How we talk.' }],
          Roster: [{ Handle: 'envoy-alpha', Role: 'producer' }],
        });
      }
      if (req.method === 'GET' && req.url === '/api/v1/projects/PSEAT/endpoints/EPSEAT/canon') {
        state.briefs.push({ url: req.url, auth: req.headers.authorization ?? null });
        return json(200, {
          EndpointId: 'EPSEAT',
          OrientationCaptureId: state.orientationCaptureId,
          ETag: '"canon1"',
          Sections: [{
            SectionHandle: 'marketing-voice',
            Description: 'How we talk.',
            RecapText: state.canonRecap,
            DecisionCaptureId: CAP_GUID,
            CollateCaptureId: CAP_GUID,
            RatifiedAt: '2026-08-22T12:00:00Z',
            CollectionId: null,
            Superseded: false,
          }],
        });
      }
      if (req.method === 'GET' && req.url === '/api/v1/projects/PSEAT/endpoints/EPSEAT') {
        state.reads.push({ url: req.url, auth: req.headers.authorization ?? null });
        return json(200, { Id: 'EPSEAT', ProjectId: 'PSEAT', Name: 'Table', Slug: 'table', SigningEnabled: true, SigningHeader: 'X-Flurry-Signature' });
      }
      if (req.method === 'GET' && req.url?.startsWith('/api/v1/endpoints/EPSEAT/captured-requests/wait?')) {
        state.waits.push({ url: req.url, auth: req.headers.authorization ?? null });
        const canned = state.waitQueue.shift();
        if (canned) return json(200, canned);
        // Default: the server HOLDS (emulated briefly, capped so tests stay fast),
        // then answers its own timeout - empty page, input cursor echoed.
        const params = new URL(req.url, 'http://x').searchParams;
        const holdMs = Math.min(Number(params.get('timeoutSeconds') ?? 20), 6) * 1000;
        return setTimeout(() =>
          json(200, { Requests: [], TotalCount: 0, NextCursor: params.get('after') ?? null }), holdMs);
      }
      if (req.method === 'GET' && req.url?.startsWith('/api/v1/endpoints/EPSEAT/captured-requests?')) {
        state.reads.push({ url: req.url, auth: req.headers.authorization ?? null });
        // #268: the body-bearing page the seat filters run over. Served only when
        // includeBody rides the URL, so the older body-less assertions hold.
        if (req.url.includes('includeBody=true')) {
          const wire = (row) => JSON.stringify(row);
          const at = state.listCreatedAt ?? new Date().toISOString();
          return json(200, {
            Requests: [
              { Id: 'CAP-1', MatchedSignerLabel: 'owner', CreatedAt: at, Cursor: 'w1',
                Body: wire({ v: 1, kind: 'message', from: 'director', to: 'envoy-alpha', text: 'for you' }) },
              // #283: summary + status layers plus a member no schema names, so the
              // compact read proves unknown keys pass through (the #281 flag's seat).
              { Id: 'CAP-2', MatchedSignerLabel: 'owner', CreatedAt: at, Cursor: 'w2',
                Body: wire({ v: 1, kind: 'message', from: 'director', to: 'all', verb: 'fp:status',
                  status: { state: 'working' }, summary: 'roll call', xnote: 'unknown member' }) },
              { Id: 'CAP-3', MatchedSignerLabel: 'owner', CreatedAt: at, Cursor: 'w3',
                Body: wire({ v: 1, kind: 'message', from: 'director', to: 'other-seat', text: 'not yours' }) },
              { Id: 'CAP-4', MatchedSignerLabel: 'envoy-alpha', CreatedAt: at, Cursor: 'w4',
                Body: wire({ v: 1, kind: 'message', from: 'envoy-alpha', to: 'director', re: 'CAP-2', text: 'mine' }) },
              { Id: 'CAP-5', MatchedSignerLabel: 'owner', CreatedAt: at, Cursor: 'w5', Body: 'plain, not a wire post' },
            ],
            TotalCount: 5,
            NextCursor: 'w5',
            Scope: { ProjectId: 'PSEAT', EndpointId: 'EPSEAT', ReadAs: 'seat:envoy-alpha' },
          });
        }
        return json(200, {
          Requests: [{
            Id: CAP_GUID, HttpMethod: 'POST', ProviderHint: null, ProviderEventType: 'note',
            RejectionReason: null, CreatedAt: new Date().toISOString(), Cursor: 'c1',
          }],
          TotalCount: 1,
          NextCursor: 'c1',
          // 0.5.0 rider: the server-authoritative stamp (the single-read route below
          // deliberately omits it, exercising the client fallback on the same session).
          Scope: { ProjectId: 'PSEAT', EndpointId: 'EPSEAT', ReadAs: 'seat:envoy-alpha' },
        });
      }
      if (req.method === 'GET' && req.url === '/api/v1/endpoints/EPSEAT/invites/') {
        state.reads.push({ url: req.url, auth: req.headers.authorization ?? null });
        return json(200, {
          Items: state.inviteItems ?? [
            { Id: 'INV-A', Ref: 'inv_alpha', Status: 'accepted', GuestName: 'envoy-alpha',
              ExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), CreatedAt: new Date().toISOString() },
            { Id: 'INV-B', Ref: 'inv_old', Status: 'revoked', GuestName: 'old-hand',
              ExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), CreatedAt: new Date().toISOString() },
            { Id: 'INV-C', Ref: 'inv_bare', Status: 'pending', GuestName: null,
              ExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), CreatedAt: new Date().toISOString() },
          ],
        });
      }
      const capMatch = req.method === 'GET' && req.url?.match(/^\/api\/v1\/endpoints\/EPSEAT\/captured-requests\/([^/?]+)$/);
      if (capMatch) {
        state.reads.push({ url: req.url, auth: req.headers.authorization ?? null });
        return json(200, {
          Id: CAP_GUID, EndpointId: 'EPSEAT', HttpMethod: 'POST',
          Headers: JSON.stringify({ 'content-type': ['application/json'] }),
          QueryString: null, BodyBytes: Buffer.from('{"hello":true}', 'utf8').toString('base64'),
          ContentType: 'application/json', ContentLength: 14,
          RejectionReason: null, CreatedAt: new Date().toISOString(),
        });
      }
      if (req.url === '/api/v1/capture/PSEAT/table' && req.method === 'POST') {
        state.posts.push({ headers: { ...req.headers }, body });
        return json(200, { captureId: CAP_GUID, executions: [] });
      }
      json(404, { title: 'not_found', detail: `no fake for ${req.method} ${req.url}` });
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () => resolve({ srv, state, base: `http://127.0.0.1:${srv.address().port}` })));
}

/** Spawn `flurryport seat-server --port 0` and resolve the actual bound port from stderr. */
function startSeatServer(apiBase) {
  const env = { ...process.env };
  delete env.FLURRYPORT_API_URL; // --api-url must be what wires the fake in
  delete env.FLURRYPORT_TOKEN;
  const child = spawn(process.execPath, [CLI, 'seat-server', '--port', '0', '--api-url', apiBase], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`seat server never bound; stderr: ${stderr}`)), 15000);
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      const m = stderr.match(/http:\/\/127\.0\.0\.1:(\d+)\/mcp/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, base: `http://127.0.0.1:${m[1]}` });
      }
    });
    child.on('exit', (code) => reject(new Error(`seat server exited ${code}; stderr: ${stderr}`)));
  });
}

/** Minimal streamable-HTTP MCP session: JSON-RPC POSTs with the mcp-session-id header. */
function httpSession(base) {
  let sid = null;
  let id = 0;
  async function send(body) {
    const res = await fetch(`${base}/mcp`, {
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
  const call = async (name, args) => {
    const res = await rpc('tools/call', { name, arguments: args });
    assert.ok(res?.result?.content?.[0]?.text, `tool ${name} answered: ${JSON.stringify(res)}`);
    return JSON.parse(res.result.content[0].text);
  };
  const init = async () => {
    const res = await rpc('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'seat-test', version: '0' },
    });
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return res;
  };
  return { rpc, call, init };
}

test('seat server over streamable HTTP: ceremony, custody, signing, and session isolation', async () => {
  const { srv, state, base: apiBase } = await startFakeApi();
  const { child, base } = await startSeatServer(apiBase);
  try {
    // Session A: initialize; instructions + inventory are the seat surface.
    const a = httpSession(base);
    const initA = await a.init();
    assert.match(initA.result.instructions, /SEAT at someone else's FlurryPORT/);
    assert.equal(initA.result.serverInfo.name, 'flurryport-seat');
    const names = (await a.rpc('tools/list', {})).result.tools.map((t) => t.name).sort();
    assert.deepEqual(names.sort(), ['attach_standing', 'get_canon', 'get_capture', 'get_roster', 'list_captures', 'list_sections', 'ping', 'post', 'post_intent', 'read', 'redeem_seat_code', 'request_standing_credential', 'wait_for_posts']);

    // #288: the HTTP preflight answers with no session and no MCP handshake.
    const who = await (await fetch(`${base}/whoami`)).json();
    assert.equal(who.server, 'flurryport-seat');
    assert.equal(who.seated, false);
    assert.equal(who.room, null, 'the standalone server learns its room only at redemption');
    assert.match(who.message, /unseated/);

    // Pre-redemption: room verbs are gated.
    const gated = await a.call('list_captures', {});
    assert.equal(gated.error.code, 'seat_required');
    assert.equal(gated.meta.mode, 'seat');

    // Malformed paste refuses locally, spending nothing.
    const malformed = await a.call('redeem_seat_code', { code: 'not-a-code' });
    assert.equal(malformed.error.code, 'invalid_code_format');
    assert.equal(state.redeems.length, 0, 'no network attempt for a malformed code');

    // Redeem with sloppy human paste (lowercase + padding): canonicalization holds
    // end to end, and the fake VERIFIES the proof like the real server does.
    const seated = await a.call('redeem_seat_code', { code: `  ${CODE_A.toLowerCase()} ` });
    assert.equal(seated.status, 'seated', JSON.stringify(seated));
    assert.equal(seated.participantName, 'envoy-alpha');
    assert.equal(seated.seatRef, 'inv_alpha');
    assert.deepEqual(seated.room, { projectId: 'PSEAT', endpointId: 'EPSEAT', endpointSlug: 'table' });
    // joinedAtCursor (#274): SERVER-ISSUED on the redemption itself - the receipt
    // relays it verbatim, and no client-side read happens at all (the race window
    // between redeeming and reading is exactly what the server issuance closes).
    assert.equal(seated.joinedAtCursor, 'jc-boundary');
    // #486: the cursor is exclusive of the newest row at redemption, so the brief
    // says where orders posted between the mint and this redemption live.
    assert.match(seated.firstRead, /NO after/);
    assert.match(seated.firstRead, /addressedToMe:true/);
    assert.equal(state.reads.filter((r) => r.url.includes('/captured-requests?')).length, 0,
      'redemption must not trigger any client-side capture read');
    assert.match(seated.lifecycle, /attribution/);
    // #403 custody truth: the seat rides the MCP session; reconnecting with the
    // same mcp-session-id resumes it, and only a dead session needs a fresh code.
    assert.match(seated.custody, /this MCP session only/);
    assert.match(seated.custody, /reconnecting resumes the seat/);
    assert.doesNotMatch(seated.custody, /if the connection is lost, ask the host for a fresh code/);
    assert.equal(seated.meta.mode, 'seat');
    assert.ok(seated.meta.expiresInMinutes > 60 * 23, 'seat clock rides the meta');
    // CUSTODY: the receipt carries neither the PAT nor the signing key.
    const receiptText = JSON.stringify(seated);
    assert.ok(!receiptText.includes('fp_seat_alpha'), 'seat PAT must never reach the receipt');
    assert.ok(!receiptText.includes('seat-key-alpha'), 'signing key must never reach the receipt');

    // Session B (same process, own session): A's redemption must not leak.
    const b = httpSession(base);
    await b.init();
    const gatedB = await b.call('list_captures', {});
    assert.equal(gatedB.error.code, 'seat_required', 'session B must still be nobody');

    // A reads: the fake sees the seat PAT, and the SERVER scope stamp is
    // authoritative (0.5.0 rider) - relayed as lowercase `scope` (projectId included,
    // which the client fallback cannot produce), raw PascalCase `Scope` removed.
    const list = await a.call('list_captures', {});
    assert.ok(Array.isArray(list.Requests), JSON.stringify(list).slice(0, 300));
    // #364: bodies ride by default on the seat surface, so an unfiltered read is the
    // body-bearing page (the fake serves it only when includeBody=true is on the wire).
    assert.equal(list.TotalCount, 5);
    assert.ok(list.Requests[0].post, 'an unfiltered seat read carries parsed posts');
    assert.deepEqual(list.scope, { endpointId: 'EPSEAT', projectId: 'PSEAT', readAs: 'seat:envoy-alpha' });
    assert.equal(list.Scope, undefined, 'the raw server stamp is reconciled away');
    const listRead = state.reads.filter((r) => r.url.includes('/captured-requests?')).pop();
    assert.equal(listRead.auth, 'Bearer fp_seat_alpha', 'reads carry the seat PAT');

    // A single read: no endpointId arg needed (the room is pinned by redemption).
    // The fake omits Scope here, so the CLIENT fallback stamps - in seat vocabulary,
    // and for the first time on get_capture (0.5.0 rider).
    const one = await a.call('get_capture', { captureId: list.Requests[0].Id });
    assert.equal(one.HttpMethod, 'POST');
    assert.equal(one.body, '{"hello":true}');
    assert.deepEqual(one.scope, { endpointId: 'EPSEAT', readAs: 'seat:envoy-alpha' });

    // id is an alias for captureId (the obvious first guess every fresh agent makes).
    const oneByAlias = await a.call('get_capture', { id: list.Requests[0].Id });
    assert.equal(oneByAlias.HttpMethod, 'POST');
    assert.equal(oneByAlias.body, '{"hello":true}');
    const neither = await a.call('get_capture', {});
    assert.ok(neither.error, 'get_capture with neither captureId nor id must refuse');
    assert.match(neither.error.message, /captureId/, 'the refusal names the missing argument');

    // ── wait_for_posts (#275) ──────────────────────────────────────────────
    // Arrival during the wait: two posts land, one of them addressed to this seat;
    // addressedToMe returns exactly that one, post parsed, cursor advanced.
    const wireAt = new Date().toISOString();
    state.waitQueue.push({
      Requests: [
        { Id: 'W-OWN', MatchedSignerLabel: 'envoy-alpha', CreatedAt: wireAt, Cursor: 'wq1',
          Body: JSON.stringify({ v: 1, kind: 'message', from: 'envoy-alpha', to: 'director', text: 'mine' }) },
        { Id: 'W-DIR', MatchedSignerLabel: 'owner', CreatedAt: wireAt, Cursor: 'wq2',
          Body: JSON.stringify({ v: 1, kind: 'message', from: 'director', to: 'envoy-alpha', text: 'orders' }) },
      ],
      TotalCount: 2,
      NextCursor: 'wq2',
    });
    const w1 = await a.call('wait_for_posts', { after: 'w5', addressedToMe: true });
    assert.equal(w1.Requests.length, 1, JSON.stringify(w1).slice(0, 300));
    assert.equal(w1.Requests[0].Id, 'W-DIR');
    assert.equal(w1.Requests[0].post.text, 'orders', 'the arrival carries its parsed wire post');
    assert.equal(w1.NextCursor, 'wq2');
    assert.equal(w1.filter.matchedCount, 1);
    assert.equal(state.waits.at(-1).auth, 'Bearer fp_seat_alpha', 'the wait rides the seat PAT');
    assert.ok(state.waits.at(-1).url.includes('includeBody=true'), 'filters force bodies onto the wait');

    // A filtered-out arrival does NOT end the wait: the seat's own post lands first,
    // the loop re-enters the underlying wait on the ADVANCED cursor, and the next
    // arrival is the answer.
    state.waitQueue.push(
      { Requests: [
          { Id: 'W-MINE', MatchedSignerLabel: 'envoy-alpha', CreatedAt: wireAt, Cursor: 'wq3',
            Body: JSON.stringify({ v: 1, kind: 'message', from: 'envoy-alpha', to: 'director', text: 'still mine' }) },
        ], TotalCount: 1, NextCursor: 'wq3' },
      { Requests: [
          { Id: 'W-NEXT', MatchedSignerLabel: 'owner', CreatedAt: wireAt, Cursor: 'wq4',
            Body: JSON.stringify({ v: 1, kind: 'message', from: 'director', to: 'all', text: 'for everyone' }) },
        ], TotalCount: 1, NextCursor: 'wq4' },
    );
    const waitsBefore = state.waits.length;
    const w2 = await a.call('wait_for_posts', { after: 'wq2', excludeOwnPosts: true });
    assert.equal(w2.Requests.length, 1);
    assert.equal(w2.Requests[0].Id, 'W-NEXT');
    assert.equal(state.waits.length - waitsBefore, 2, 'a filtered-out arrival re-enters the wait');
    assert.ok(decodeURIComponent(state.waits.at(-1).url).includes('after=wq3'),
      're-entry resumes from the advanced cursor, not the caller input');

    // The 20-60 contract is schema-enforced: out-of-range totals are rejected
    // before any wire traffic.
    for (const bad of [5, 61]) {
      const rejected = await a.rpc('tools/call', { name: 'wait_for_posts', arguments: { timeoutSeconds: bad } });
      const failed = Boolean(rejected.error) || rejected.result?.isError === true;
      assert.ok(failed, `timeoutSeconds ${bad} must be rejected by the 20-60 contract`);
    }

    // Budget exhaustion: the default 20s total is served in chunks against the
    // plane (each fake hold capped at 6s), every empty chunk re-enters, and the
    // final answer is empty WITH the cursor handed back. Slow by design - this is
    // the one test that spends a real budget.
    const exhaustStarted = Date.now();
    const exhaustHitsBefore = state.waits.length;
    const w3 = await a.call('wait_for_posts', { after: 'wq4' });
    const exhaustElapsed = Date.now() - exhaustStarted;
    assert.equal(w3.Requests.length, 0);
    assert.equal(w3.NextCursor, 'wq4', 'a timeout still hands the cursor back');
    assert.ok(state.waits.length - exhaustHitsBefore >= 3,
      `the budget is spent in multiple chunks (saw ${state.waits.length - exhaustHitsBefore})`);
    assert.ok(exhaustElapsed >= 19_000 && exhaustElapsed < 26_000,
      `the total hold spends the full budget (took ${exhaustElapsed}ms)`);
    const firstChunk = state.waits[exhaustHitsBefore].url;
    assert.ok(new URL(firstChunk, 'http://x').searchParams.get('timeoutSeconds') === '20',
      'a 20s budget asks the plane for a single 20s chunk, never more than 25');

    // A posts: no ids passed - fixedScope routes it; the wire proves the HMAC.
    const intentBody = '{"kind":"hello","from":"seat"}';
    const receipt = await a.call('post_intent', { body: intentBody });
    assert.equal(receipt.status, 'accepted', JSON.stringify(receipt));
    assert.equal(receipt.signedWith.keyRef, 'seat:envoy-alpha');
    assert.equal(receipt.meta.mode, 'seat', 'seat envelope rides every room-verb response');
    assert.equal(state.posts.length, 1);
    const expectedSig = createHmac('sha256', 'seat-key-alpha')
      .update(Buffer.from(intentBody, 'utf8')).digest('hex');
    assert.equal(state.posts[0].headers['x-flurry-signature'], expectedSig,
      'the capture endpoint received the seat-key HMAC over the raw body');
    assert.ok(state.posts[0].headers['x-flurry-receipt'], 'correlation receipt requested');
    assert.equal(state.posts[0].body, intentBody);

    // B redeems code B: the fake answers proof_stale on the first valid proof, and
    // the ceremony client retries ONCE with a fresh nonce + timestamp. B's release
    // deliberately lacks JoinedAtCursor (#274): the old-server shape. The receipt must
    // OMIT the member - absent-because-old never masquerades as null-because-empty.
    const attemptsBefore = state.redeems.filter((r) => r.CodeHandle === 'PQRS').length;
    const seatedB = await b.call('redeem_seat_code', { code: CODE_B });
    assert.equal(seatedB.status, 'seated', JSON.stringify(seatedB));
    assert.equal(seatedB.participantName, 'envoy-beta');
    assert.ok(!('joinedAtCursor' in seatedB), 'an old server yields NO joinedAtCursor member, not a null');
    const betaAttempts = state.redeems.filter((r) => r.CodeHandle === 'PQRS');
    assert.equal(betaAttempts.length, attemptsBefore + 2, 'proof_stale costs exactly one retry');
    assert.notEqual(betaAttempts.at(-1).Nonce, betaAttempts.at(-2).Nonce, 'retry uses a fresh nonce');

    // Isolation both ways after both are seated: each session signs and reads as itself.
    await b.call('post_intent', { body: '{"kind":"hello","from":"beta"}' });
    const betaSig = createHmac('sha256', 'seat-key-beta')
      .update(Buffer.from('{"kind":"hello","from":"beta"}', 'utf8')).digest('hex');
    assert.equal(state.posts.at(-1).headers['x-flurry-signature'], betaSig, 'B signs with its own key');
    await a.call('list_captures', {});
    assert.equal(
      state.reads.filter((r) => r.url.includes('/captured-requests?')).pop().auth,
      'Bearer fp_seat_alpha',
      'A still reads as A after B seated',
    );

    // An unknown (but well-formed) code maps to the non-enumerable not_found.
    const c = httpSession(base);
    await c.init();
    const unknown = await c.call('redeem_seat_code', { code: 'ZZZZ-ZZZZ-ZZZZ' });
    assert.equal(unknown.error.code, 'not_found');
    assert.match(unknown.error.message, /fresh code/);
  } finally {
    child.kill();
    srv.close();
  }
});

test('in-process room: a held seat gets the wake-up on its VERY NEXT room-verb response, one shot', async () => {
  const { srv, base: apiBase } = await startFakeApi();
  try {
    // The console-hosted wiring, minus HTTP: the same registerSeatTools the room
    // server mounts, with the shared relay the console's RoomHost writes into.
    const relay = new AttentionRelay();
    const tools = collectTools((s) => registerSeatTools(s, { apiBase, attention: relay }));
    const seated = JSON.parse((await tools.get('redeem_seat_code').handler({ code: CODE_A })).content[0].text);
    assert.equal(seated.status, 'seated', JSON.stringify(seated));

    // No order pending: room verbs answer with no notice.
    const read = async () => JSON.parse((await tools.get('list_captures').handler({})).content[0].text);
    assert.equal((await read()).meta.notice, null);

    // The chair holds (the engine relays by participant name): the very next
    // tool-call response carries the wake-up, pointing the seat at the stream.
    relay.set('envoy-alpha', { code: 'attention_hold', panic: false });
    const woken = await read();
    assert.equal(woken.meta.notice.code, 'attention_hold');
    assert.match(woken.meta.notice.message, /read the stream/);
    assert.equal((await read()).meta.notice, null, 'one shot: delivered means delivered');

    // Resume clears the held notice; a panic interrupt outranks a quieter follow-up.
    relay.set('envoy-alpha', { code: 'attention_hold', panic: false });
    relay.set('envoy-alpha', { code: 'attention_resume', panic: false });
    assert.equal((await read()).meta.notice.code, 'attention_resume');
    relay.set('envoy-alpha', { code: 'attention_interrupt', panic: true });
    relay.set('envoy-alpha', { code: 'attention_hold', panic: false });
    const panicked = await read();
    assert.equal(panicked.meta.notice.code, 'attention_interrupt');
    assert.match(panicked.meta.notice.message, /EMERGENCY STOP/);
  } finally {
    srv.close();
  }
});

// ───────────────────── C2. presence truth (#266: the transport ledger) ─────────────────────

test('the seat server notes transport contact on redemption and every room-verb call (#266)', async () => {
  const { srv, base: apiBase } = await startFakeApi();
  try {
    const { PresenceLedger } = await import('../dist/lib/presence.js');
    const ledger = new PresenceLedger();
    const tools = collectTools((s) => registerSeatTools(s, { apiBase, presence: ledger }));
    assert.equal(ledger.stateFor('envoy-alpha'), 'adrift', 'nothing seen before redemption');

    const seated = JSON.parse((await tools.get('redeem_seat_code').handler({ code: CODE_A })).content[0].text);
    assert.equal(seated.status, 'seated', JSON.stringify(seated));
    assert.equal(ledger.stateFor('envoy-alpha'), 'live', 'redemption is the first transport contact');

    // Every room verb is contact too; get_roster included.
    await tools.get('list_captures').handler({});
    await tools.get('get_roster').handler({});
    assert.equal(ledger.stateFor('envoy-alpha'), 'live');
    // Somebody the transport never saw stays adrift - the ledger never invents.
    assert.equal(ledger.stateFor('old-hand'), 'adrift');
  } finally {
    srv.close();
  }
});

// ───────────────────────── D. seat QoL (#268) ─────────────────────────

test('seat list_captures: parsed post bodies, addressed-to-me, and exclude-own filters (#268)', async () => {
  const { srv, state, base: apiBase } = await startFakeApi();
  try {
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    const seated = JSON.parse((await tools.get('redeem_seat_code').handler({ code: CODE_A })).content[0].text);
    assert.equal(seated.status, 'seated', JSON.stringify(seated));
    const list = async (args) => JSON.parse((await tools.get('list_captures').handler(args)).content[0].text);

    // Plain body read: every row carries `post`, the parsed wire object; a body
    // that is not a JSON object answers post null and the raw body stands.
    const all = await list({ includeBody: true });
    assert.equal(all.Requests.length, 5);
    assert.deepEqual(all.Requests[0].post, { v: 1, kind: 'message', from: 'director', to: 'envoy-alpha', text: 'for you' });
    assert.equal(all.Requests[3].post.re, 'CAP-2', 'the re member survives the parse');
    assert.equal(all.Requests[4].post, null, 'a non-wire body parses to null');
    assert.equal(all.Requests[4].Body, 'plain, not a wire post', 'the raw body still stands');
    assert.ok(all.meta, 'the seat envelope still rides the reshaped response');

    // addressedToMe: my name and all match; other seats and shapeless bodies drop.
    // The filter forces includeBody on the underlying call.
    const mine = await list({ addressedToMe: true });
    assert.deepEqual(mine.Requests.map((r) => r.Id), ['CAP-1', 'CAP-2']);
    assert.deepEqual(mine.filter, { addressedToMe: true, excludeOwnPosts: false, matchedCount: 2 });
    assert.ok(
      state.reads.filter((r) => r.url.includes('/captured-requests?')).pop().url.includes('includeBody=true'),
      'the filter forced bodies onto the wire read',
    );

    // excludeOwnPosts: the seat's own signed rows drop; everyone else stays.
    const others = await list({ excludeOwnPosts: true });
    assert.deepEqual(others.Requests.map((r) => r.Id), ['CAP-1', 'CAP-2', 'CAP-3', 'CAP-5']);

    // Composed: what the others addressed at me.
    const catchUp = await list({ addressedToMe: true, excludeOwnPosts: true });
    assert.deepEqual(catchUp.Requests.map((r) => r.Id), ['CAP-1', 'CAP-2']);

    // #364: unfiltered now rides bodies by default - a body-less page reads as an
    // empty room, and a seat that believes that says nothing.
    const byDefault = await list({});
    assert.equal(byDefault.TotalCount, 5);
    assert.equal(byDefault.Requests[0].post.from, 'director');
    // Opting out is still possible, and still answers the older body-less shape.
    const plain = await list({ includeBody: false });
    assert.equal(plain.TotalCount, 1);
    assert.equal(plain.Requests[0].post, null);
    // A filter always wins over the opt-out: it cannot run without bodies.
    const forced = await list({ includeBody: false, addressedToMe: true });
    assert.deepEqual(forced.Requests.map((r) => r.Id), ['CAP-1', 'CAP-2']);
  } finally {
    srv.close();
  }
});

test('idle room notice uses served or accepted post timestamps on list and wait reads (#291)', async () => {
  const { srv, state, base: apiBase } = await startFakeApi();
  try {
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    await tools.get('redeem_seat_code').handler({ code: CODE_A });
    const oldAt = new Date(Date.now() - (ROOM_IDLE_NOTICE_MINUTES + 1) * 60_000).toISOString();

    state.listCreatedAt = oldAt;
    const idleList = JSON.parse((await tools.get('list_captures').handler({ includeBody: true })).content[0].text);
    assert.equal(idleList.meta.notice.code, 'room_idle');
    assert.match(idleList.meta.notice.message, /idle 16 minutes/i);
    assert.match(idleList.meta.notice.message, /disconnecting to preserve tokens/i);
    assert.match(idleList.meta.notice.message, /cursor resumes you on return/i);

    // A post accepted through this seat advances the same observed clock. Older
    // rows on a later history read can never move it backwards or claim idleness.
    const accepted = JSON.parse((await tools.get('post_intent').handler({
      body: JSON.stringify({ v: 1, kind: 'message', from: 'envoy-alpha', text: 'still here' }),
    })).content[0].text);
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.meta.notice, null);
    const freshAfterPost = JSON.parse((await tools.get('list_captures').handler({ includeBody: true })).content[0].text);
    assert.equal(freshAfterPost.meta.notice, null, 'accepted activity outranks older served history');

    // A separate seat session proves wait_for_posts applies the same clock to
    // the response it hands over; the old arrival is observed, not guessed.
    const waitingTools = collectTools((s) => registerSeatTools(s, { apiBase }));
    await waitingTools.get('redeem_seat_code').handler({ code: CODE_A });
    state.waitQueue.push({
      Requests: [{ Id: 'W-IDLE', MatchedSignerLabel: 'owner', CreatedAt: oldAt, Cursor: 'wi1',
        Body: JSON.stringify({ v: 1, kind: 'message', from: 'director', text: 'last word' }) }],
      TotalCount: 1,
      NextCursor: 'wi1',
    });
    const idleWait = JSON.parse((await waitingTools.get('wait_for_posts').handler({
      after: 'w0', compact: true,
    })).content[0].text);
    assert.equal(idleWait.meta.notice.code, 'room_idle');
  } finally {
    srv.close();
  }
});

test('seat get_capture carries the parsed post beside the raw body (#268)', async () => {
  const { srv, base: apiBase } = await startFakeApi();
  try {
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    await tools.get('redeem_seat_code').handler({ code: CODE_A });
    const one = JSON.parse((await tools.get('get_capture').handler({ captureId: 'anything' })).content[0].text);
    assert.equal(one.body, '{"hello":true}');
    assert.deepEqual(one.post, { hello: true }, 'the parsed body rides beside the raw one');
  } finally {
    srv.close();
  }
});

test('get_roster: participant names and states, nothing sensitive, seatless rows dropped (#268)', async () => {
  const { srv, state, base: apiBase } = await startFakeApi();
  try {
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    await tools.get('redeem_seat_code').handler({ code: CODE_A });
    const result = JSON.parse((await tools.get('get_roster').handler({})).content[0].text);
    assert.equal(result.you, 'envoy-alpha');
    assert.equal(result.roster.length, 2, 'the GuestName-less invite row is not a seat');
    assert.deepEqual(result.roster.map((r) => [r.participantName, r.status, r.live]), [
      ['envoy-alpha', 'accepted', true],
      ['old-hand', 'revoked', false],
    ]);
    // Nothing sensitive: no invite ids, refs, codes, or keys in the answer.
    const text = JSON.stringify(result);
    for (const secret of ['INV-A', 'inv_old', 'fp_seat_alpha', 'seat-key-alpha']) {
      assert.ok(!text.includes(secret), `${secret} must never ride the roster read`);
    }
    // The read went out under the seat PAT.
    assert.equal(state.reads.filter((r) => r.url.includes('/invites/')).pop().auth, 'Bearer fp_seat_alpha');
  } finally {
    srv.close();
  }
});

// ───────────────────── D3. compact post-only read (#283, G5 ruled) ─────────────────────

test('compact list_captures answers post-only rows: five ruled keys, layers pass through, NextCursor kept (#283)', async () => {
  const { srv, state, base: apiBase } = await startFakeApi();
  try {
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    await tools.get('redeem_seat_code').handler({ code: CODE_A });
    const list = async (args) => JSON.parse((await tools.get('list_captures').handler(args)).content[0].text);

    const compact = await list({ compact: true });
    assert.equal(compact.Requests.length, 5);
    // Every parsed row carries ONLY the five ruled fields - no HTTP members, no raw Body.
    for (const row of compact.Requests.filter((r) => r.post !== null)) {
      assert.deepEqual(Object.keys(row).sort(), ['CreatedAt', 'Cursor', 'Id', 'MatchedSignerLabel', 'post']);
    }
    // The parsed post is whole: wire members, the status and summary layers, and
    // members no schema names yet (the #281 needs-ratification flag will ride
    // through this same passthrough).
    assert.equal(compact.Requests[0].post.text, 'for you');
    assert.deepEqual(compact.Requests[1].post.status, { state: 'working' });
    assert.equal(compact.Requests[1].post.summary, 'roll call');
    assert.equal(compact.Requests[1].post.xnote, 'unknown member');
    // A non-wire body is post null; #405: the row now says WHY and what fetches
    // the whole thing, and the Id is still the path back to the raw capture.
    assert.equal(compact.Requests[4].post, null);
    assert.equal(compact.Requests[4].Id, 'CAP-5');
    assert.equal(compact.Requests[4].postUnavailableReason, 'unparseable-or-oversize');
    assert.equal(compact.Requests[4].fetchWith, 'get_capture');
    assert.ok(!('Body' in compact.Requests[4]), 'no raw body duplication, even when post is null');
    // The envelope keeps NextCursor, and compact forced bodies onto the wire read.
    assert.equal(compact.NextCursor, 'w5');
    assert.ok(
      state.reads.filter((r) => r.url.includes('/captured-requests?')).pop().url.includes('includeBody=true'),
      'compact forces includeBody on the underlying call',
    );

    // Compact composes with the seat filters: what the others addressed at me, post-only.
    const catchUp = await list({ compact: true, addressedToMe: true, excludeOwnPosts: true });
    assert.deepEqual(catchUp.Requests.map((r) => r.Id), ['CAP-1', 'CAP-2']);
    assert.deepEqual(Object.keys(catchUp.Requests[0]).sort(), ['CreatedAt', 'Cursor', 'Id', 'MatchedSignerLabel', 'post']);
    assert.equal(catchUp.filter.matchedCount, 2);
  } finally {
    srv.close();
  }
});

test('compact wait_for_posts: the arrival page is post-only and filters compose (#283)', async () => {
  const { srv, state, base: apiBase } = await startFakeApi();
  try {
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    await tools.get('redeem_seat_code').handler({ code: CODE_A });
    const at = new Date().toISOString();
    state.waitQueue.push({
      Requests: [
        { Id: 'W-SKIP', MatchedSignerLabel: 'owner', CreatedAt: at, Cursor: 'cq1',
          Body: JSON.stringify({ v: 1, kind: 'message', from: 'director', to: 'other-seat', text: 'not yours' }) },
        { Id: 'W-GO', MatchedSignerLabel: 'owner', CreatedAt: at, Cursor: 'cq2',
          Body: JSON.stringify({ v: 1, kind: 'message', from: 'director', to: 'envoy-alpha', text: 'go', summary: 'orders' }) },
      ],
      TotalCount: 2,
      NextCursor: 'cq2',
    });
    const w = JSON.parse(
      (await tools.get('wait_for_posts').handler({ after: 'w0', compact: true, addressedToMe: true })).content[0].text,
    );
    assert.equal(w.Requests.length, 1);
    assert.deepEqual(Object.keys(w.Requests[0]).sort(), ['CreatedAt', 'Cursor', 'Id', 'MatchedSignerLabel', 'post']);
    assert.equal(w.Requests[0].Id, 'W-GO');
    assert.equal(w.Requests[0].post.summary, 'orders', 'the summary layer rides the compact arrival');
    assert.equal(w.NextCursor, 'cq2', 'the envelope keeps the cursor');
    assert.ok(state.waits.at(-1).url.includes('includeBody=true'), 'compact forces bodies onto the wait');
  } finally {
    srv.close();
  }
});

// ───────────────────── D4. record control at the seat surface (#281) ─────────────────────

test('a flagged proposal rides the compact read whole: the fp:propose marker and its summary survive (#281)', async () => {
  const { srv, state, base: apiBase } = await startFakeApi();
  try {
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    await tools.get('redeem_seat_code').handler({ code: CODE_A });
    const at = new Date().toISOString();
    state.waitQueue.push({
      Requests: [
        { Id: 'W-PROP', MatchedSignerLabel: 'envoy-beta', CreatedAt: at, Cursor: 'cp1',
          Body: JSON.stringify({ v: 1, kind: 'message', from: 'envoy-beta', to: 'director',
            verb: 'fp:propose', summary: 'ratify: the closer goes echoless', text: 'full argument here' }) },
      ],
      TotalCount: 1,
      NextCursor: 'cp1',
    });
    const w = JSON.parse((await tools.get('wait_for_posts').handler({ after: 'w0', compact: true })).content[0].text);
    assert.equal(w.Requests.length, 1);
    assert.deepEqual(Object.keys(w.Requests[0]).sort(), ['CreatedAt', 'Cursor', 'Id', 'MatchedSignerLabel', 'post']);
    // The needs-ratification marker is the verb itself (#281 gavel), and the
    // required summary rides beside it - both through the compact passthrough.
    assert.equal(w.Requests[0].post.verb, 'fp:propose');
    assert.equal(w.Requests[0].post.summary, 'ratify: the closer goes echoless');
    assert.equal(w.NextCursor, 'cp1');
  } finally {
    srv.close();
  }
});

test('a proposal without a summary still posts and the receipt warns; with one it stays clean (#281)', async () => {
  const { srv, state, base: apiBase } = await startFakeApi();
  try {
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    await tools.get('redeem_seat_code').handler({ code: CODE_A });
    const post = async (body) =>
      JSON.parse((await tools.get('post_intent').handler({ body: JSON.stringify(body) })).content[0].text);

    // Warn, never refuse (G1 point 2, soft enforcement): the post lands.
    const bare = await post({ v: 1, kind: 'message', from: 'envoy-alpha', verb: 'fp:propose', text: 'the gate opens' });
    assert.equal(bare.status, 'accepted');
    assert.match(bare.proposalWarning, /summary/);
    assert.equal(state.posts.length, 1, 'the summary-less proposal was delivered, not refused');

    const good = await post({
      v: 1, kind: 'message', from: 'envoy-alpha', verb: 'fp:propose',
      summary: 'ratify: the gate opens', text: 'the gate opens',
    });
    assert.equal(good.status, 'accepted');
    assert.ok(!('proposalWarning' in good), 'a summaried proposal draws no warning');

    const plain = await post({ v: 1, kind: 'message', from: 'envoy-alpha', text: 'ordinary post' });
    assert.ok(!('proposalWarning' in plain), 'ordinary posts are untouched');
  } finally {
    srv.close();
  }
});

// ───────────────────── D2. session cursor continuity (#285) ─────────────────────

test('wait_for_posts with no after resumes from the session cursor: join boundary, then last acknowledged page (#285)', async () => {
  const { srv, state, base: apiBase } = await startFakeApi();
  try {
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    const seated = JSON.parse((await tools.get('redeem_seat_code').handler({ code: CODE_A })).content[0].text);
    assert.equal(seated.joinedAtCursor, 'jc-boundary');
    const wait = async (args) => JSON.parse((await tools.get('wait_for_posts').handler(args)).content[0].text);
    const at = new Date().toISOString();
    const arrival = (id, cursor) => ({
      Requests: [{ Id: id, MatchedSignerLabel: 'owner', CreatedAt: at, Cursor: cursor,
        Body: JSON.stringify({ v: 1, kind: 'message', from: 'director', to: 'all', text: 'go' }) }],
      TotalCount: 1, NextCursor: cursor,
    });

    // The very first uncursored wait resumes from seating time, never from scratch.
    state.waitQueue.push(arrival('R-1', 'rc-1'));
    const w1 = await wait({});
    assert.equal(w1.Requests[0].Id, 'R-1');
    assert.ok(decodeURIComponent(state.waits.at(-1).url).includes('after=jc-boundary'),
      'joinedAtCursor seeds the session cursor at redemption');

    // The next uncursored wait resumes from the last page actually handed over.
    state.waitQueue.push(arrival('R-2', 'rc-2'));
    await wait({});
    assert.ok(decodeURIComponent(state.waits.at(-1).url).includes('after=rc-1'),
      'an acknowledged page advances the session cursor');

    // list_captures pages feed the same cursor (its own no-after contract untouched).
    await tools.get('list_captures').handler({ includeBody: true }); // page ends at w5
    state.waitQueue.push(arrival('R-3', 'rc-3'));
    await wait({});
    assert.ok(decodeURIComponent(state.waits.at(-1).url).includes('after=w5'),
      'a list_captures read advances the session cursor too');

    // An explicit after always outranks the remembered cursor.
    state.waitQueue.push(arrival('R-4', 'rc-4'));
    await wait({ after: 'my-own-cursor' });
    assert.ok(decodeURIComponent(state.waits.at(-1).url).includes('after=my-own-cursor'),
      'a caller-chosen cursor is never overridden');
  } finally {
    srv.close();
  }
});

// ───────────────────── D4. ping preflight (#288) ─────────────────────

test('ping answers unseated before redemption and seated after, spending nothing (#288)', async () => {
  const { srv, state, base: apiBase } = await startFakeApi();
  try {
    const tools = collectTools((s) =>
      registerSeatTools(s, { apiBase, version: '9.9.9', room: () => 'proj/table' }));
    // Pre-redemption: the one ungated tool. Identity, the served room, the honest line.
    const before = JSON.parse((await tools.get('ping').handler({})).content[0].text);
    assert.equal(before.server, 'flurryport-seat');
    assert.equal(before.version, '9.9.9');
    assert.equal(before.api, undefined, 'the public preflight never names the internal api base');
    assert.equal(before.room, 'proj/table', 'a console-hosted room names itself');
    assert.equal(before.seated, false);
    assert.match(before.message, /unseated/);
    assert.equal(state.redeems.length, 0, 'ping spends nothing');

    await tools.get('redeem_seat_code').handler({ code: CODE_A });
    const after = JSON.parse((await tools.get('ping').handler({})).content[0].text);
    assert.equal(after.seated, true);
    assert.equal(after.participantName, 'envoy-alpha');
    assert.equal(after.room, 'table', 'seated, the room is the seat\'s endpoint');
    assert.equal(after.message, undefined, 'no unseated line once seated');
    // Nothing sensitive rides the preflight in either state.
    for (const text of [JSON.stringify(before), JSON.stringify(after)]) {
      assert.ok(!text.includes('fp_seat_alpha') && !text.includes('seat-key-alpha'));
    }

    // A server that knows no room (standalone, no version) answers honest nulls.
    const bare = collectTools((s) => registerSeatTools(s, { apiBase }));
    const nulls = JSON.parse((await bare.get('ping').handler({})).content[0].text);
    assert.equal(nulls.version, null);
    assert.equal(nulls.room, null);
  } finally {
    srv.close();
  }
});

// ───────────────────── D3. SSE keep-alive during holds (#287) ─────────────────────

test('a held SSE stream carries keep-alive comments so client read timeouts survive the hold (#287)', async () => {
  const { serveMcpHttp } = await import('../dist/lib/mcp-http.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  // A deliberately slow tool stands in for the wait_for_posts hold; the period is
  // shrunk so the test proves the mechanism without spending a real 15s.
  const handle = await serveMcpHttp({
    host: '127.0.0.1',
    port: 0,
    keepAliveMs: 100,
    log: () => {},
    build: async () => {
      const server = new McpServer({ name: 'ka-test', version: '0' });
      server.registerTool(
        'slow',
        { description: 'Holds for a moment, then answers.', inputSchema: {} },
        async () => {
          await new Promise((r) => setTimeout(r, 600));
          return { content: [{ type: 'text', text: 'done' }] };
        },
      );
      return { server, banner: 'ka-test session' };
    },
  });
  try {
    let sid = null;
    const post = async (body) => {
      const res = await fetch(handle.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(sid ? { 'mcp-session-id': sid } : {}),
        },
        body: JSON.stringify(body),
      });
      sid = res.headers.get('mcp-session-id') ?? sid;
      return res;
    };
    await (await post({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ka', version: '0' } },
    })).text();
    await (await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).text();

    const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: {} } });
    assert.ok((res.headers.get('content-type') ?? '').includes('text/event-stream'), 'the held call rides SSE');
    const text = await res.text();
    const pings = text.split('\n').filter((line) => line.startsWith(': keep-alive')).length;
    assert.ok(pings >= 2, `keep-alive comments ride the hold (saw ${pings})`);
    assert.match(text, /"result"/, 'the real answer still lands after the pings');
  } finally {
    await handle.shutdown();
  }
});

test('wait_for_posts documents the keep-alive and the client timeout guidance (#287)', () => {
  const tools = collectTools((s) => registerSeatTools(s, { apiBase: 'http://127.0.0.1:9' }));
  const desc = String(tools.get('wait_for_posts').def.description);
  assert.match(desc, /keep-alive/);
  assert.match(desc, /READ timeout/);
  assert.match(desc, /70 seconds/);
});

test('the seat instructions publish the full wire schema, re member included (#268)', async () => {
  const { seatServerInstructions } = await import('../dist/lib/mcp-server-instructions.js');
  const text = seatServerInstructions('0.0.0');
  assert.match(text, /wire schema v1/);
  assert.match(text, /v, kind, from, to, for, verb, args, re, panic, text, status/);
  assert.match(text, /for names the SECTION a post is about/, '#374: the seat instructions teach for');
  assert.match(text, /re is the feed id of the post you are answering/);
  assert.match(text, /Never send an empty string member/);
  assert.match(text, /get_roster/);
});

test('the seat instructions carry the status ceremony and the summary convention (#280, #403 slim)', async () => {
  const { seatServerInstructions } = await import('../dist/lib/mcp-server-instructions.js');
  const text = seatServerInstructions('0.0.0');
  // The ratified vocabulary stays; the key list and transition forms moved to the
  // published wire page (#403), which the block points at.
  assert.match(text, /starting, working, review, waiting, blocked-on-human, going-idle, done/);
  assert.match(text, /catalog page \/recipes\/wire/);
  // The ceremony sentences, word for word where they carry the lesson.
  assert.match(text, /before starting a task and again when it is done/);
  assert.match(text, /review BEFORE touching a diff/);
  assert.match(text, /going-idle before going quiet/);
  assert.match(text, /blocked-on-human, because no one in the room can observe your terminal/);
  // Onboarding plus the G-bonus experiment.
  assert.match(text, /read the room history once/);
  assert.match(text, /joinedAtCursor/);
  assert.match(text, /one-line summary member/);
  assert.match(text, /aiTags/);
});

test('#358: a hosted rooms server marks its posts with the rooms marker and the public host; other rooms do not', async () => {
  const { srv, state, base: apiBase } = await startFakeApi();
  try {
    const hosted = collectTools((s) => registerSeatTools(s, { apiBase, publicHost: 'dev-kraken-api.flurryport.io' }));
    await hosted.get('redeem_seat_code').handler({ code: CODE_A });
    const body = JSON.stringify({ v: 1, kind: 'message', from: 'envoy-alpha', text: 'hosted' });
    const receipt = JSON.parse((await hosted.get('post_intent').handler({ body })).content[0].text);
    assert.equal(receipt.status, 'accepted', JSON.stringify(receipt));
    const post = state.posts.at(-1);
    assert.equal(post.headers['x-flurry-rooms'], '1');
    assert.equal(post.headers['x-flurry-public-host'], 'dev-kraken-api.flurryport.io');
    const expectedSig = createHmac('sha256', 'seat-key-alpha').update(Buffer.from(body, 'utf8')).digest('hex');
    assert.equal(post.headers['x-flurry-signature'], expectedSig, 'the marker never touches the signed body');

    const plain = collectTools((s) => registerSeatTools(s, { apiBase }));
    await plain.get('redeem_seat_code').handler({ code: CODE_A });
    await plain.get('post_intent').handler({ body });
    const plainPost = state.posts.at(-1);
    assert.equal(plainPost.headers['x-flurry-rooms'], undefined, 'a console-hosted or self-hosted room posts over the public API already');
    assert.equal(plainPost.headers['x-flurry-public-host'], undefined);
  } finally {
    srv.close();
  }
});

// ───────────────────── E. the room brief (#345) and the post budget (#361) ─────────────────────

// #478: standing at redemption. The seat acts on the receipt's standing facts in
// the same step, so no human ever has to tell a seat to ask for what it holds.
test('redeem_seat_code: an older server (no standing facts) yields a plain seated receipt', async () => {
  const { srv, base: apiBase } = await startFakeApi();
  try {
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    const seated = JSON.parse((await tools.get('redeem_seat_code').handler({ code: CODE_A })).content[0].text);
    assert.equal(seated.status, 'seated');
    assert.equal('standing' in seated, false, 'absent-because-old must not masquerade as a step');
    assert.match(seated.custody, /fresh code from the host\.$/);
  } finally {
    srv.close();
  }
});

test('redeem_seat_code: a pre-authorized slot puts the consent step in the receipt, before any work', async () => {
  const { srv, base: apiBase, state } = await startFakeApi();
  try {
    state.standing = { StandingPreAuthorized: true, StandingLive: false, StandingCustody: null };
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    const seated = JSON.parse((await tools.get('redeem_seat_code').handler({ code: CODE_A })).content[0].text);
    assert.equal(seated.status, 'seated');
    assert.equal(seated.standing.state, 'pre_authorized');
    assert.match(seated.standing.next, /BEFORE any other work/);
    assert.match(seated.standing.next, /request_standing_credential/);
    assert.match(seated.custody, /or standing once the step above is done\.$/);
    assert.equal(state.exchanges.length, 0, 'no grant yet, so nothing to collect');
  } finally {
    srv.close();
  }
});

test('redeem_seat_code: a handle that already holds standing is re-attached by the redemption itself', async () => {
  const { srv, base: apiBase, state } = await startFakeApi();
  try {
    state.standing = { StandingPreAuthorized: true, StandingLive: true, StandingCustody: 'unattended' };
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    const text = (await tools.get('redeem_seat_code').handler({ code: CODE_A })).content[0].text;
    const seated = JSON.parse(text);
    assert.equal(seated.status, 'standing', text);
    assert.equal(seated.collectedAt, 'redemption');
    assert.match(seated.standingNote, /one step/);
    assert.equal(seated.standingKey, 'stk_alpha_1', 'the one credential that may surface, exactly as attach_standing hands it');
    assert.equal(seated.custodyMode, 'unattended');
    assert.equal(seated.resumeCursor, 'rc-last-ack');
    assert.deepEqual(state.exchanges, ['fp_seat_alpha'], 'the fresh seat token is the proof');
    assert.equal(text.includes('fp_working_alpha_1'), false, 'the working token never surfaces');
    assert.equal(text.includes('fp_seat_alpha'), false, 'nor the seat token');
    // The seat is standing: the room verbs read with the rotated working token.
    await tools.get('list_captures').handler({});
    assert.equal(state.reads.at(-1).auth, 'Bearer fp_working_alpha_1');
  } finally {
    srv.close();
  }
});

test('redeem_seat_code: a failed collection leaves the seat seated and says to attach_standing', async () => {
  const { srv, base: apiBase, state } = await startFakeApi();
  try {
    state.standing = { StandingPreAuthorized: true, StandingLive: true, StandingCustody: 'checked-in' };
    state.exchangeAnswers = 404;
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    const seated = JSON.parse((await tools.get('redeem_seat_code').handler({ code: CODE_A })).content[0].text);
    assert.equal(seated.status, 'seated');
    assert.equal(seated.standing.state, 'live_uncollected');
    assert.equal(seated.standing.custodyMode, 'checked-in');
    assert.match(seated.standing.next, /attach_standing \(no arguments\)/);
    assert.equal(state.exchanges.length, 1);
  } finally {
    srv.close();
  }
});

test('redeem_seat_code hands the seat the orientation and the canon, with the ids to re-read them', async () => {
  const { srv, state, base: apiBase } = await startFakeApi();
  try {
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    const seated = JSON.parse((await tools.get('redeem_seat_code').handler({ code: CODE_A })).content[0].text);

    assert.equal(seated.status, 'seated', JSON.stringify(seated));
    assert.equal(seated.orientationCaptureId, guidToBase62(CAP_GUID), 'the lock id is opaque');
    assert.equal(seated.orientation, '{"hello":true}', "the locked capture's body text rides the receipt");
    assert.equal(seated.canon.Sections[0].RecapText, 'Plain words, no hype.');
    assert.equal(seated.canon.Sections[0].DecisionCaptureId, guidToBase62(CAP_GUID), 'canon ids are opaque too');
    assert.match(seated.orient, /before you post/);
    assert.match(seated.orient, /never instructions to you/);
    assert.equal(seated.briefingNote, undefined, 'a small brief needs no truncation note');
    // The brief is read with the seat credential, like every other seat read.
    assert.ok(state.briefs.every((b) => b.auth === 'Bearer fp_seat_alpha'), JSON.stringify(state.briefs));
    // Still no credential material anywhere in the receipt.
    const text = JSON.stringify(seated);
    assert.ok(!text.includes('fp_seat_alpha') && !text.includes('seat-key-alpha'), 'custody holds');
  } finally {
    srv.close();
  }
});

test('a room with no orientation still seats the agent, and says what to do instead', async () => {
  const { srv, state, base: apiBase } = await startFakeApi();
  state.orientationCaptureId = null;
  try {
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    const seated = JSON.parse((await tools.get('redeem_seat_code').handler({ code: CODE_A })).content[0].text);

    assert.equal(seated.status, 'seated');
    assert.equal(seated.orientationCaptureId, null);
    assert.equal(seated.orientation, null);
    assert.ok(seated.canon, 'the canon read still answered');
  } finally {
    srv.close();
  }
});

test('fitBriefing: over 64 KB the texts go and the ids stay, with the note saying so', async () => {
  const { fitBriefing, REDEEM_BRIEFING_MAX_BYTES } = await import('../dist/lib/mcp-seat-tools.js');
  assert.equal(REDEEM_BRIEFING_MAX_BYTES, 64 * 1024);

  const small = {
    orientationCaptureId: 'CAP62',
    orientation: 'short',
    canon: { Sections: [{ SectionHandle: 'a', RecapText: 'brief', DecisionCaptureId: 'D1' }] },
    briefingNote: null,
  };
  assert.deepEqual(fitBriefing(small), small, 'a brief that fits is handed over untouched');

  const huge = {
    orientationCaptureId: 'CAP62',
    orientation: 'x'.repeat(70 * 1024),
    canon: { Sections: [{ SectionHandle: 'a', RecapText: 'y'.repeat(1024), DecisionCaptureId: 'D1' }] },
    briefingNote: null,
  };
  const trimmed = fitBriefing(huge);
  assert.equal(trimmed.orientation, null, 'the long text goes');
  assert.equal(trimmed.canon.Sections[0].RecapText, null, 'so does the recap');
  assert.equal(trimmed.orientationCaptureId, 'CAP62', 'the ids stay, so the seat can fetch them');
  assert.equal(trimmed.canon.Sections[0].DecisionCaptureId, 'D1');
  assert.match(trimmed.briefingNote, /ids only/);
  assert.match(trimmed.briefingNote, /get_capture/);
  assert.match(trimmed.briefingNote, /get_canon/);
});

test('the seat post tool declares the 4096-byte budget and every receipt says what is left', async () => {
  const { srv, base: apiBase } = await startFakeApi();
  try {
    const { SEAT_POST_MAX_BYTES } = await import('../dist/lib/mcp-seat-tools.js');
    assert.equal(SEAT_POST_MAX_BYTES, 4096);
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    await tools.get('redeem_seat_code').handler({ code: CODE_A });

    // #377: the budget is the receipt, not the gate. No .max on the schema; the
    // describe text states the number, and an oversize post still returns a receipt.
    const bodySchema = tools.get('post_intent').def.inputSchema.body;
    assert.equal(bodySchema._def?.checks?.find?.((c) => c.kind === 'max'), undefined, 'no schema gate');
    assert.match(String(bodySchema.description), /4096 UTF-8 bytes/);

    const body = JSON.stringify({ v: 1, kind: 'message', from: 'envoy-alpha', to: 'all', text: 'hello' });
    const receipt = JSON.parse((await tools.get('post_intent').handler({ body })).content[0].text);
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.maxBytes, 4096, 'the seat budget, not the owner one');
    assert.equal(receipt.bytesRemaining, 4096 - Buffer.byteLength(body, 'utf8'));
    assert.equal(receipt.sizeBytes, Buffer.byteLength(body, 'utf8'));

    const essay = JSON.stringify({ v: 1, kind: 'message', from: 'envoy-alpha', to: 'all', text: 'x'.repeat(5000) });
    const over = JSON.parse((await tools.get('post_intent').handler({ body: essay })).content[0].text);
    assert.equal(over.maxBytes, 4096, 'the budget still reads on an oversize receipt');
    assert.equal(over.bytesRemaining, 0, 'clamped at zero, never negative');
    assert.equal(over.sizeBytes, Buffer.byteLength(essay, 'utf8'));
    // #405: the oversize receipt is no longer quiet - it names the byte count and
    // the cost (compact readers see post null), while the post still lands.
    assert.equal(over.status, 'accepted_with_warning');
    assert.match(over.oversizeWarning, new RegExp(`${Buffer.byteLength(essay, 'utf8')} UTF-8 bytes`));
    assert.match(over.oversizeWarning, /post null/);
    assert.match(over.oversizeWarning, /get_capture/);
  } finally {
    srv.close();
  }
});

// ───────────────────── F. the rooms bash (#403/#405/#409/#411) ─────────────────────

test('post_intent accepts an object body and serializes it before signing (#405)', async () => {
  const { srv, state, base: apiBase } = await startFakeApi();
  try {
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    await tools.get('redeem_seat_code').handler({ code: CODE_A });
    const post = { v: 1, kind: 'message', from: 'envoy-alpha', to: 'all', text: 'as an object' };
    const receipt = JSON.parse((await tools.get('post_intent').handler({ body: post })).content[0].text);
    assert.equal(receipt.status, 'accepted', JSON.stringify(receipt));
    const serialized = JSON.stringify(post);
    assert.equal(state.posts.at(-1).body, serialized, 'the wrapper serialized the object once, canonically');
    // The signature covers the serialized string - the same bytes that landed.
    const expectedSig = createHmac('sha256', 'seat-key-alpha').update(Buffer.from(serialized, 'utf8')).digest('hex');
    assert.equal(state.posts.at(-1).headers['x-flurry-signature'], expectedSig);
    assert.equal(receipt.sizeBytes, Buffer.byteLength(serialized, 'utf8'));
  } finally {
    srv.close();
  }
});

test('post_intent checkOnly is a local dry-run: the report lands, nothing posts (#405)', async () => {
  const { srv, state, base: apiBase } = await startFakeApi();
  try {
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    await tools.get('redeem_seat_code').handler({ code: CODE_A });
    // A clean post: the report says so.
    const clean = JSON.parse((await tools.get('post_intent').handler({
      body: JSON.stringify({ v: 1, kind: 'message', from: 'envoy-alpha', to: 'all', text: 'short' }),
      checkOnly: true,
    })).content[0].text);
    assert.equal(clean.checkOnly, true);
    assert.equal(clean.stored, false);
    assert.equal(clean.clean, true);
    assert.deepEqual(clean.findings, []);
    // An oversize summary-less proposal: every finding named, still nothing posted.
    const dirty = JSON.parse((await tools.get('post_intent').handler({
      body: JSON.stringify({ v: 1, kind: 'message', from: 'envoy-alpha', verb: 'fp:propose', text: 'y'.repeat(5000) }),
      checkOnly: true,
    })).content[0].text);
    assert.equal(dirty.clean, false);
    assert.ok(dirty.findings.some((f) => /oversize/.test(f)), JSON.stringify(dirty.findings));
    assert.ok(dirty.findings.some((f) => /summary/.test(f)));
    assert.ok(dirty.findings.some((f) => /section/.test(f)));
    // Unparseable: the report says post null is what readers would see.
    const raw = JSON.parse((await tools.get('post_intent').handler({
      body: 'not json at all', checkOnly: true,
    })).content[0].text);
    assert.ok(raw.findings.some((f) => /does not parse/.test(f)));
    assert.equal(state.posts.length, 0, 'checkOnly stores NOTHING');
  } finally {
    srv.close();
  }
});

test('an unfiltered wait_for_posts rides bodies by default, includeBody:false opts out (#411)', async () => {
  const { srv, state, base: apiBase } = await startFakeApi();
  try {
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    await tools.get('redeem_seat_code').handler({ code: CODE_A });
    const at = new Date().toISOString();
    state.waitQueue.push({
      Requests: [{ Id: 'W-B', MatchedSignerLabel: 'owner', CreatedAt: at, Cursor: 'cb1',
        Body: JSON.stringify({ v: 1, kind: 'message', from: 'director', to: 'all', text: 'readable' }) }],
      TotalCount: 1,
      NextCursor: 'cb1',
    });
    const w = JSON.parse((await tools.get('wait_for_posts').handler({ after: 'w0' })).content[0].text);
    assert.ok(state.waits.at(-1).url.includes('includeBody=true'),
      'a bare wait carries bodies: a Body-null arrival is unreadable (#411)');
    assert.equal(w.Requests[0].post.text, 'readable');
    // The explicit opt-out still stands.
    state.waitQueue.push({
      Requests: [{ Id: 'W-NB', MatchedSignerLabel: 'owner', CreatedAt: at, Cursor: 'cb2' }],
      TotalCount: 1,
      NextCursor: 'cb2',
    });
    await tools.get('wait_for_posts').handler({ after: 'cb1', includeBody: false });
    assert.ok(!state.waits.at(-1).url.includes('includeBody=true'), 'includeBody:false opts out');
  } finally {
    srv.close();
  }
});

test('forSections is the my-sections pickup read: section posts and my orders, nothing else (#411)', async () => {
  const { srv, state, base: apiBase } = await startFakeApi();
  try {
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    await tools.get('redeem_seat_code').handler({ code: CODE_A });
    const at = new Date().toISOString();
    state.waitQueue.push({
      Requests: [
        { Id: 'S-FOR', MatchedSignerLabel: 'owner', CreatedAt: at, Cursor: 's1',
          Body: JSON.stringify({ v: 1, kind: 'message', from: 'director', for: 'marketing-voice', text: 'a need' }) },
        { Id: 'S-TO-SECTION', MatchedSignerLabel: 'owner', CreatedAt: at, Cursor: 's2',
          Body: JSON.stringify({ v: 1, kind: 'message', from: 'director', to: 'Marketing-Voice', text: 'older form' }) },
        { Id: 'S-OTHER', MatchedSignerLabel: 'owner', CreatedAt: at, Cursor: 's3',
          Body: JSON.stringify({ v: 1, kind: 'message', from: 'director', for: 'engineering', text: 'not mine' }) },
        { Id: 'S-ME', MatchedSignerLabel: 'owner', CreatedAt: at, Cursor: 's4',
          Body: JSON.stringify({ v: 1, kind: 'message', from: 'director', to: 'envoy-alpha', text: 'an order' }) },
        { Id: 'S-ELSE', MatchedSignerLabel: 'owner', CreatedAt: at, Cursor: 's5',
          Body: JSON.stringify({ v: 1, kind: 'message', from: 'director', to: 'other-seat', text: 'not addressed here' }) },
      ],
      TotalCount: 5,
      NextCursor: 's5',
    });
    const w = JSON.parse((await tools.get('wait_for_posts').handler({
      after: 'w0', forSections: ['marketing-voice'],
    })).content[0].text);
    assert.deepEqual(w.Requests.map((r) => r.Id), ['S-FOR', 'S-TO-SECTION', 'S-ME'],
      'section posts (for, and the older to form, case-blind) plus my own orders');
    assert.deepEqual(w.filter.forSections, ['marketing-voice']);
    assert.equal(w.filter.matchedCount, 3);
    assert.ok(state.waits.at(-1).url.includes('includeBody=true'), 'forSections forces bodies');

    // The same filter rides the plain read (list_captures fixture: to me, to all,
    // to another seat, my own answer, a non-wire body - only the addressed pair
    // survives a section filter naming no fixture section... and the section echo
    // rides the filter envelope there too.
    const list = JSON.parse((await tools.get('list_captures').handler({ forSections: ['marketing-voice'] })).content[0].text);
    assert.deepEqual(list.Requests.map((r) => r.Id), ['CAP-1', 'CAP-2'],
      'addressed-to-me and to-all still reach a section-filtered reader');
    assert.deepEqual(list.filter.forSections, ['marketing-voice']);
  } finally {
    srv.close();
  }
});

test('get_roster retires spent re-mint rows: one row per name, best status stands (#409)', async () => {
  const { srv, state, base: apiBase } = await startFakeApi();
  const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const later = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  state.inviteItems = [
    { Id: 'INV-1', Ref: 'inv_a1', Status: 'revoked', GuestName: 'envoy-alpha', ExpiresAt: soon, CreatedAt: soon },
    { Id: 'INV-2', Ref: 'inv_a2', Status: 'accepted', GuestName: 'envoy-alpha', ExpiresAt: later, CreatedAt: later },
    { Id: 'INV-3', Ref: 'inv_s1', Status: 'revoked', GuestName: 'scribe', ExpiresAt: soon, CreatedAt: soon },
    { Id: 'INV-4', Ref: 'inv_s2', Status: 'pending', GuestName: 'scribe', ExpiresAt: later, CreatedAt: later },
    { Id: 'INV-5', Ref: 'inv_o1', Status: 'revoked', GuestName: 'old-hand', ExpiresAt: soon, CreatedAt: soon },
  ];
  try {
    const { PresenceLedger } = await import('../dist/lib/presence.js');
    const presence = new PresenceLedger();
    const tools = collectTools((s) => registerSeatTools(s, { apiBase, presence }));
    await tools.get('redeem_seat_code').handler({ code: CODE_A });
    const result = JSON.parse((await tools.get('get_roster').handler({})).content[0].text);
    // Five invite rows, three participants: the best row per name stands.
    assert.deepEqual(result.roster.map((r) => [r.participantName, r.status, r.live]), [
      ['envoy-alpha', 'accepted', true],
      ['scribe', 'pending', false],
      ['old-hand', 'revoked', false],
    ]);
    assert.equal(result.retired, 2, 'the spent rows are counted, never listed');
    // Presence rides when the transport tracks it: this seat just polled (live);
    // the transport has never heard from the others (adrift, the honest word).
    assert.equal(result.roster[0].presence, 'live');
    assert.equal(result.roster[1].presence, 'adrift');
  } finally {
    srv.close();
  }
});

test('get_roster without a presence ledger says nothing about presence (#409)', async () => {
  const { srv, base: apiBase } = await startFakeApi();
  try {
    const tools = collectTools((s) => registerSeatTools(s, { apiBase }));
    await tools.get('redeem_seat_code').handler({ code: CODE_A });
    const result = JSON.parse((await tools.get('get_roster').handler({})).content[0].text);
    assert.equal(result.retired, 0, 'the default fixture has no re-mints');
    assert.ok(result.roster.every((r) => !('presence' in r)),
      'absent must never masquerade as adrift: no ledger, no presence member');
  } finally {
    srv.close();
  }
});
