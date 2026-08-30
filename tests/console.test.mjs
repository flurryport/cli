// Console regression net (tier 1, #241): the parser is the testable heart, the
// engine is driven through a fake RoomApi, and NOTHING here touches the network
// or the operator's real profile. Sections:
//  A. Parser - bare vs ':' mode shift, target-first vs verb-first, :all, '!',
//     whisper vs mention, help from both directions, usage errors.
//  B. Handles - the participantAccountName derivation, reserved words, and
//     deterministic collision suffixes.
//  C. Engine - context scoping, bind, speak, lifecycle (mint + confirm/panic
//     revoke), view verbs, and the feed's byline/color/hidden behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated HOME before dist imports: console view state persists under
// ~/.flurryport, and a leaked real profile boots the CLI authed against PROD.
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'fp-console-home-'));
process.env.HOME = process.env.USERPROFILE;

const { parseLine, RESERVED_WORDS } = await import('../dist/lib/console-parser.js');
const { assignHandles, sanitizeGuestName } = await import('../dist/lib/console-handles.js');
const { ConsoleEngine, CHAIR_FROM, FP_VERBS } = await import('../dist/lib/console-engine.js');
const { PresenceLedger, PRESENCE_LIVE_SECONDS, PRESENCE_IDLE_SECONDS } = await import('../dist/lib/presence.js');
const { CONSOLE_COLORS, getChairIdentity, putChairIdentity } = await import('../dist/lib/console-view-state.js');

// Most tests run with the chair address seeded to the fallback so the first-mint
// ask (wire schema v1 §4) stays out of their way; the identity tests at the end
// manage the virgin state themselves. putChairIdentity('') is the virgin reset.
putChairIdentity(CHAIR_FROM);

// ───────────────────────── A. parser ─────────────────────────

test('bare text is the room; the colon is the only mode shift', () => {
  assert.deepEqual(parseLine('nice work everyone'), { kind: 'say', text: 'nice work everyone' });
  assert.deepEqual(parseLine('   '), { kind: 'empty' });
  assert.equal(parseLine(':list projects').kind, 'list');
});

test('target-first default verb is mention; verb-first :seat takes the rest of the line', () => {
  assert.deepEqual(parseLine(':bunny nice move'), {
    kind: 'targeted', target: 'bunny', all: false, verb: 'mention', text: 'nice move', force: false,
  });
  assert.deepEqual(parseLine(':seat The Tall Bard'), { kind: 'seat', guestName: 'The Tall Bard' });
});

test('whisper is the explicit deliberate act; mention stays the default', () => {
  const w = parseLine(':bunny whisper the vault code is fake');
  assert.equal(w.verb, 'whisper');
  assert.equal(w.text, 'the vault code is fake');
  assert.equal(parseLine(':bunny whisper').code, 'whisper_needs_text');
  // A mention whose text happens to start with a non-verb word stays a mention.
  assert.equal(parseLine(':bunny whispering is rude').verb, 'mention');
});

test(':all is the universal range across verb classes', () => {
  assert.deepEqual(parseLine(':all hide'), { kind: 'targeted', target: 'all', all: true, verb: 'hide', force: false });
  assert.equal(parseLine(':all revoke').verb, 'revoke');
  const mention = parseLine(':all table is closing in ten');
  assert.equal(mention.verb, 'mention');
  assert.equal(mention.all, true);
});

test('! is panic: it attaches to the verb and only to the verb', () => {
  const forced = parseLine(':bunny revoke!');
  assert.equal(forced.verb, 'revoke');
  assert.equal(forced.force, true);
  assert.equal(parseLine(':bunny revoke').force, false);
  // '!' in mention text is just punctuation, not force.
  const bang = parseLine(':bunny well done!');
  assert.equal(bang.verb, 'mention');
  assert.equal(bang.force, false);
});

test('verbs without a range and order verbs answer usage errors, not mysteries', () => {
  assert.equal(parseLine(':revoke').code, 'verb_needs_target');
  assert.equal(parseLine(':hide').code, 'verb_needs_target');
  // Attention and order verbs are built now (slice C): verb-first is a range error,
  // exactly like every other seat-addressed verb (the verb-first :install form is DROPPED).
  assert.equal(parseLine(':hold').code, 'verb_needs_target');
  // #277: ':interrupt now' is a plausible verb-first shape (now could be a seat),
  // so it parses as a swap candidate; the ENGINE keeps today's usage error when
  // no seat named now is on the roster (section L covers the fall-through).
  assert.equal(parseLine(':interrupt now').verbFirst, ':now interrupt');
  assert.equal(parseLine(':status').code, 'verb_needs_target');
  assert.equal(parseLine(':install slack-post').code, 'verb_needs_target');
  assert.equal(parseLine(':upgrade slack-post').code, 'verb_needs_target');
  assert.equal(parseLine(':b@d handle').code, 'invalid_handle');
  assert.equal(parseLine(':list nonsense').code, 'list_usage');
  assert.equal(parseLine(':set project').code, 'set_usage');
  assert.equal(parseLine(':seat').code, 'seat_needs_name');
  assert.equal(parseLine(':bunny color').code, 'color_needs_color');
  // #278: the compat alias parses to the same canonical verb and error.
  assert.equal(parseLine(':bunny recolor').code, 'color_needs_color');
  assert.equal(parseLine(':bunny recolor cyan').verb, 'color');
  assert.equal(parseLine(':bunny').code, 'say_what');
});

test('help is reachable from both directions; :help list and :commands are the full listing', () => {
  assert.deepEqual(parseLine(':help'), { kind: 'help' });
  assert.deepEqual(parseLine(':commands'), { kind: 'help' });
  // ':help list' is a SYNONYM of the full listing (ratified), not list-family help.
  assert.deepEqual(parseLine(':help list'), { kind: 'help' });
  assert.deepEqual(parseLine(':help revoke'), { kind: 'help', topic: 'revoke' });
  // Suffix form: family-scoped help.
  assert.deepEqual(parseLine(':list help'), { kind: 'help', topic: 'list' });
  assert.deepEqual(parseLine(':set help'), { kind: 'help', topic: 'set' });
  assert.deepEqual(parseLine(':seat help'), { kind: 'help', topic: 'seat' });
  assert.deepEqual(parseLine(':colors help'), { kind: 'help', topic: 'colors' });
});

test(':list roster is an alias of :list seats; :colors is a command', () => {
  assert.deepEqual(parseLine(':list roster'), { kind: 'list', what: 'seats' });
  assert.deepEqual(parseLine(':list seats'), { kind: 'list', what: 'seats' });
  assert.deepEqual(parseLine(':colors'), { kind: 'colors' });
});

// ───────────────────────── B. handles ─────────────────────────

test('handles derive through participantAccountName and collide to deterministic suffixes', () => {
  const rows = assignHandles([
    { guestName: 'The Tall Bard' },
    { guestName: 'Bunny' },
    { guestName: 'the tall  bard' }, // normalizes identically
  ]);
  assert.deepEqual(rows.map((r) => r.handle), ['the-tall-bard', 'bunny', 'the-tall-bard-2']);
});

test('reserved words can never be handles - a seat named after one binds suffixed', () => {
  for (const word of ['all', 'help', 'seat', 'revoke', 'list', 'exit', 'quit', 'q']) {
    assert.ok(RESERVED_WORDS.has(word), `${word} is reserved`);
  }
  const rows = assignHandles([{ guestName: 'Seat' }, { guestName: 'All' }]);
  assert.deepEqual(rows.map((r) => r.handle), ['seat-2', 'all-2']);
});

test('the seeded chair address and the verb namespaces can never be handles (v1 charset law)', () => {
  // Extra reserved words (the chair's address at mint) count as taken.
  const rows = assignHandles([{ guestName: 'Gene' }], ['gene']);
  assert.deepEqual(rows.map((r) => r.handle), ['gene-2']);
  // Handles never BEGIN fp: or r: - the prefix strips through the normalizer.
  const prefixed = assignHandles([{ guestName: 'fp:boss' }, { guestName: 'r:runner' }, { guestName: 'fp:' }]);
  assert.deepEqual(prefixed.map((r) => r.handle), ['boss', 'runner', 'guest']);
});

// ───────────────────────── C. engine ─────────────────────────

/** Fake RoomApi: two projects, endpoints, seats; records every write. */
function fakeRoom() {
  const calls = { posts: [], mints: [], revokes: [] };
  const seats = [
    { inviteId: 'inv-bunny', ref: 'seat-r1', guestName: 'Bunny', status: 'accepted', expiresAt: '2026-08-15T00:00:00Z', createdAt: '2026-08-14T01:00:00Z' },
    { inviteId: 'inv-bard', ref: 'seat-r2', guestName: 'The Tall Bard', status: 'accepted', expiresAt: '2026-08-15T00:00:00Z', createdAt: '2026-08-14T02:00:00Z' },
  ];
  let captures = [];
  const api = {
    async listProjects() {
      return [
        { id: 'p1', name: 'Foo', slug: 'foo', suspended: false },
        { id: 'p2', name: 'Bar', slug: 'bar', suspended: false },
      ];
    },
    async listEndpoints(projectId) {
      if (projectId === 'p1') return [{ id: 'e1', projectId: 'p1', name: 'Room', slug: 'room' }];
      return [{ id: 'e2', projectId: 'p2', name: 'Other', slug: 'other' }];
    },
    async getEndpointDetail() {
      return { slug: 'room', signingEnabled: true, signingHeader: 'X-Flurry-Signature' };
    },
    async listSeats(endpointId) {
      return endpointId === 'e1' ? seats.map((s) => ({ ...s })) : [];
    },
    async mintSeat(endpointId, guestName) {
      calls.mints.push({ endpointId, guestName });
      seats.push({
        inviteId: `inv-${seats.length}`, ref: `seat-r${seats.length + 1}`, guestName,
        status: 'pending', expiresAt: '2026-08-15T00:00:00Z', createdAt: `2026-08-14T0${3 + seats.length}:00:00Z`,
      });
      return {
        pairingCode: '7WHM-KR4P-XT2B', ref: 'seat-r9', participantName: guestName,
        expiresAt: '2026-08-15T00:00:00Z', codeExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
    },
    async revokeInvite(endpointId, inviteId) {
      calls.revokes.push({ endpointId, inviteId });
      const seat = seats.find((s) => s.inviteId === inviteId);
      if (seat) seat.status = 'revoked';
    },
    async waitCaptures() {
      return { rows: [], nextCursor: null, readAs: null };
    },
    async listCaptures() {
      // Newest-first, exactly as the server pages; the engine owns the reversing.
      return { rows: [...captures], nextCursor: 'cur-1', readAs: 'owner' };
    },
    hasSigningKey() {
      return true;
    },
    async post(opts) {
      calls.posts.push(opts);
      return { httpStatus: 200, ok: true, durationMs: 1, sizeBytes: opts.body.length, errorText: '', captureId: 'cap-1', executions: null };
    },
    _setCaptures(rows) { captures = rows; },
  };
  return { api, calls, seats };
}

async function boundEngine() {
  const room = fakeRoom();
  const engine = new ConsoleEngine(room.api);
  await engine.execute(':set project foo');
  await engine.execute(':set endpoint room');
  return { engine, ...room };
}

test('speaking while unbound degrades to the bind prompt, never a crash', async () => {
  const { api } = fakeRoom();
  const engine = new ConsoleEngine(api);
  const events = await engine.execute('hello room');
  assert.equal(events[0].type, 'error');
  assert.match(events[0].text, /not bound/);
});

test('context scoping: :list endpoints respects a set project', async () => {
  const { api } = fakeRoom();
  const engine = new ConsoleEngine(api);
  const all = await engine.execute(':list endpoints');
  assert.equal(all[0].type, 'endpoints');
  assert.deepEqual(all[0].rows.map((r) => r.slug).sort(), ['other', 'room']);

  await engine.execute(':set project foo');
  const scoped = await engine.execute(':list endpoints');
  assert.deepEqual(scoped[0].rows.map((r) => r.slug), ['room']);
});

test(':set endpoint binds the room and the roster gets session handles', async () => {
  const { engine } = await boundEngine();
  assert.equal(engine.isBound(), true);
  const events = await engine.execute(':list seats');
  assert.equal(events[0].type, 'roster');
  assert.deepEqual(events[0].rows.map((r) => r.handle), ['bunny', 'the-tall-bard']);
  assert.deepEqual(events[0].rows.map((r) => r.live), [true, true]);
  // :list roster is the same surface.
  const roster = await engine.execute(':list roster');
  assert.equal(roster[0].type, 'roster');
});

test('bare input posts to the room signed as the chair, stamped v1', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine, calls } = await boundEngine();
  const events = await engine.execute('nice work everyone');
  assert.equal(events[0].type, 'info');
  assert.match(events[0].text, /Posted signed/);
  assert.equal(calls.posts.length, 1);
  const body = JSON.parse(calls.posts[0].body);
  assert.deepEqual(body, { v: 1, kind: 'message', from: CHAIR_FROM, text: 'nice work everyone' });
  // Canonical member order (§1): v, kind, from, to, text.
  assert.deepEqual(Object.keys(body), ['v', 'kind', 'from', 'text']);
});

test('mention is public and to: labeled; whisper rides the to: predicate with its own kind', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine, calls } = await boundEngine();
  await engine.execute(':bunny nice move');
  await engine.execute(':bunny whisper check the vault');
  const mention = JSON.parse(calls.posts[0].body);
  const whisper = JSON.parse(calls.posts[1].body);
  assert.deepEqual(mention, { v: 1, kind: 'message', from: CHAIR_FROM, to: 'bunny', text: 'nice move' });
  assert.deepEqual(whisper, { v: 1, kind: 'whisper', from: CHAIR_FROM, to: 'bunny', text: 'check the vault' });
  assert.deepEqual(Object.keys(mention), ['v', 'kind', 'from', 'to', 'text']);
  assert.deepEqual(Object.keys(whisper), ['v', 'kind', 'from', 'to', 'text']);
});

test('the writer never emits an empty string member - it omits it (the empty-string ban)', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine } = await boundEngine();
  // The engine's writer is the single body factory; the ban holds for every member.
  const noText = JSON.parse(engine.buildBody({ kind: 'message', to: 'bunny', text: '' }));
  assert.deepEqual(noText, { v: 1, kind: 'message', from: CHAIR_FROM, to: 'bunny' });
  const noTo = JSON.parse(engine.buildBody({ kind: 'message', to: '', text: 'hello' }));
  assert.deepEqual(noTo, { v: 1, kind: 'message', from: CHAIR_FROM, text: 'hello' });
});

test(':seat mints from the chair and displays the code with the ferry warning', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine, calls } = await boundEngine();
  const events = await engine.execute(':seat The Quiet Scribe');
  assert.deepEqual(calls.mints, [{ endpointId: 'e1', guestName: 'The Quiet Scribe' }]);
  assert.equal(events[0].type, 'pairing');
  assert.equal(events[0].code, '7WHM-KR4P-XT2B');
  assert.match(events[0].chairLines.join('\n'), /single use/);
  // The mint receipt names the seat's own handle (§8: it cannot derive its suffix).
  assert.match(events[0].chairLines[0], /handle the-quiet-scribe/);
  // The fresh seat joins the roster with a derived handle.
  const roster = await engine.execute(':list seats');
  assert.ok(roster[0].rows.some((r) => r.handle === 'the-quiet-scribe'));
});

test('the boarding pass is the SLIM paste-ready payload: identity and reachability only (ratified 2026-08-17)', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine } = await boundEngine();
  const events = await engine.execute(':seat The Quiet Scribe');
  assert.equal(events[0].type, 'pairing');
  const lines = events[0].passLines;
  const pass = lines.join('\n');
  // The ratified layout: open sentence, blank line, three bullets, blank line,
  // the handle line, blank line, the redeem line.
  assert.match(lines[0], /^You have a seat at a FlurryPORT room/);
  assert.equal(lines[1], '');
  assert.match(lines[2], /^- Your pairing code is 7WHM-KR4P-XT2B\. Single use/);
  assert.match(lines[3], /^- Seat server: .*flurryport seat-server|^- Seat server: http/);
  assert.match(lines[4], /^- Before redeeming, GET .*whoami/);
  assert.equal(lines[5], '');
  assert.match(pass, /Your handle is the-quiet-scribe\. The chair is director\./);
  assert.match(pass, /redeem_seat_code/); // the redeem line still names the tool
  assert.match(pass, /instructions block; it carries the wire schema and the room ceremony/);
  // #412: the stay-or-go rule is structural on every pass, standing by default.
  assert.match(pass, /Seat lifecycle: standing\./);
  assert.match(pass, /STAY seated; keep your MCP session and you keep the seat/);
  // The diet still holds: none of the ceremony rides the pass (the lifecycle
  // line's fp:bye is the one ruled exception, #412).
  assert.doesNotMatch(pass, /fp:propose|fp:status|aiTags|4096|scratch/);
});

test('the instructions block carries what the slim pass dropped, at #403 depth: digest + /recipes/wire pointer', async () => {
  // The wire half of the ruling: fp:status was ratified into the closed registry
  // (it arrived with #246; the gavel confirms it stays).
  assert.ok(FP_VERBS.has('fp:status'), 'fp:status is registry-known');
  const { seatServerInstructions } = await import('../dist/lib/mcp-server-instructions.js');
  const block = seatServerInstructions('0.5.2');
  // The schema digest and answering rules.
  assert.match(block, /"v":1,"kind":"message"/);
  assert.match(block, /or all is addressed to you/);
  assert.match(block, /fp:ack/);
  assert.match(block, /4096/);
  assert.match(block, /Markdown does not render/);
  assert.match(block, /keep polling; do not wait to be prompted/);
  // The status protocol, #403 compressed: the vocabulary and the ceremony stay;
  // the key list and transition forms live on the published wire page now.
  assert.match(block, /starting, working, review, waiting, blocked-on-human, going-idle, done/);
  assert.match(block, /catalog page \/recipes\/wire/);
  // The ceremony sentences.
  assert.match(block, /before starting a task and again when it is done/);
  assert.match(block, /review BEFORE touching a diff/);
  assert.match(block, /going-idle before going quiet/);
  assert.match(block, /blocked-on-human, because no one in the room can observe your terminal/);
  // Onboarding, summary/aiTags, sign-off.
  assert.match(block, /read the room history once/);
  assert.match(block, /joinedAtCursor/);
  assert.match(block, /one-line summary member/);
  assert.match(block, /aiTags is reserved for content retrieval/);
  assert.match(block, /fp:bye/);
  // Record flagging stays platform-level: proposals, scratch and strike.
  assert.match(block, /fp:propose/);
  assert.match(block, /required on proposals/);
  assert.match(block, /kind is scratch is out-of-band commentary/);
  assert.match(block, /fp:strike/);
  // #403: governance is the orientation's, and the block says so instead of
  // teaching chair doctrine to chairless rooms.
  assert.doesNotMatch(block, /fp:ratify or fp:retract/);
  assert.match(block, /the ORIENTATION declares who presides/);
  assert.match(block, /the orientation governs/);
});

test('revoke confirms y/N; y revokes, anything else cancels', async () => {
  const { engine, calls } = await boundEngine();
  const ask = await engine.execute(':the-tall-bard revoke');
  assert.equal(ask[0].type, 'confirm');
  const done = await engine.execute('y');
  assert.match(done[0].text, /Revoked the-tall-bard/);
  assert.deepEqual(calls.revokes, [{ endpointId: 'e1', inviteId: 'inv-bard' }]);

  const ask2 = await engine.execute(':bunny revoke');
  assert.equal(ask2[0].type, 'confirm');
  const cancelled = await engine.execute('n');
  assert.match(cancelled[0].text, /Nothing revoked/);
  assert.equal(calls.revokes.length, 1);
});

test('revoke! is panic: no confirm, straight to the API', async () => {
  const { engine, calls } = await boundEngine();
  const events = await engine.execute(':bunny revoke!');
  assert.equal(events[0].type, 'info');
  assert.match(events[0].text, /Revoked bunny/);
  assert.deepEqual(calls.revokes, [{ endpointId: 'e1', inviteId: 'inv-bunny' }]);
});

test('a revoked seat is not revocable again; unknown handles answer with the roster hint', async () => {
  const { engine } = await boundEngine();
  await engine.execute(':bunny revoke!');
  const again = await engine.execute(':bunny revoke!');
  assert.equal(again[0].type, 'error');
  assert.match(again[0].text, /No revocable seat/);
  const unknown = await engine.execute(':nobody hello there');
  assert.equal(unknown[0].type, 'error');
  assert.match(unknown[0].text, /No seat answers to nobody/);
});

test(':all works as the range for view and stream verbs alike', async () => {
  const { engine, calls } = await boundEngine();
  const hidden = await engine.execute(':all hide');
  assert.equal(hidden.length, 3);
  assert.equal(hidden[2].type, 'roster', 'hide must repaint pinned roster clients immediately');
  assert.deepEqual(hidden[2].rows.map((r) => r.hidden), [true, true]);
  const roster = await engine.execute(':list seats');
  assert.deepEqual(roster[0].rows.map((r) => r.hidden), [true, true]);
  const shown = await engine.execute(':all show');
  assert.equal(shown.length, 3);
  assert.equal(shown[2].type, 'roster', 'show must repaint pinned roster clients immediately');
  assert.deepEqual(shown[2].rows.map((r) => r.hidden), [false, false]);
  await engine.execute(':all revoke!');
  assert.equal(calls.revokes.length, 2);
});

test('color validates against the palette and persists; :colors lists every name', async () => {
  const { engine } = await boundEngine();
  const bad = await engine.execute(':bunny color plaid');
  assert.equal(bad[0].type, 'error');
  assert.match(bad[0].text, /No color named plaid/);
  const good = await engine.execute(':bunny color cyan');
  assert.match(good[0].text, /bunny now renders cyan/);
  assert.equal(good[1].type, 'roster', 'color must repaint pinned roster clients immediately');
  assert.equal(good[1].rows.find((r) => r.handle === 'bunny').color, 'cyan');
  const roster = await engine.execute(':list seats');
  assert.equal(roster[0].rows.find((r) => r.handle === 'bunny').color, 'cyan');
  const colors = await engine.execute(':colors');
  assert.equal(colors[0].type, 'colors');
  assert.deepEqual([...colors[0].colors], [...CONSOLE_COLORS]);
});

test('the feed resolves bylines through the roster, honors hidden, and reports the read scope', async () => {
  const { engine, api } = await boundEngine();
  await engine.execute(':all show'); // earlier tests persist hidden state in the shared view file
  api._setCaptures([
    // newest-first, as the server pages
    { id: 'c3', createdAt: '2026-08-14T03:00:00Z', signerLabel: 'owner', body: JSON.stringify({ kind: 'message', from: 'director', text: 'welcome' }), contentType: 'application/json' },
    { id: 'c2', createdAt: '2026-08-14T02:30:00Z', signerLabel: 'The Tall Bard', body: JSON.stringify({ kind: 'whisper', from: 'the-tall-bard', to: 'director', text: 'psst' }), contentType: 'application/json' },
    { id: 'c1', createdAt: '2026-08-14T02:00:00Z', signerLabel: 'Bunny', body: JSON.stringify({ kind: 'message', from: 'bunny', text: 'hi' }), contentType: 'application/json' },
  ]);
  await engine.execute(':bunny hide');
  const events = await engine.pollFeed(1);
  assert.match(events[0].text, /Reading as owner/);
  const feed = events.filter((e) => e.type === 'feed');
  // Bunny is hidden; chronological order; whisper labeled; owner is the chair.
  assert.equal(feed.length, 2);
  // Ratified byline order: GuestName (handle), the parenthetical only when they differ.
  assert.match(feed[0].item.byline, /The Tall Bard \(the-tall-bard\)/);
  assert.equal(feed[0].item.channel, 'whisper');
  assert.equal(feed[0].item.to, 'director');
  assert.equal(feed[1].item.byline, CHAIR_FROM);
  assert.equal(feed[1].item.mine, true);
});

test('the reader takes v absent as 1 and renders any other v tagged, never dropped', async () => {
  const { engine, api } = await boundEngine();
  await engine.execute(':all show'); // earlier tests persist hidden state in the shared view file
  api._setCaptures([
    { id: 'c2', createdAt: '2026-08-14T02:30:00Z', signerLabel: 'Bunny', body: JSON.stringify({ v: 2, kind: 'message', from: 'bunny', text: 'from the future' }), contentType: 'application/json' },
    { id: 'c1', createdAt: '2026-08-14T02:00:00Z', signerLabel: 'Bunny', body: JSON.stringify({ kind: 'message', from: 'bunny', text: 'v0 shape' }), contentType: 'application/json' },
  ]);
  const feed = (await engine.pollFeed(1)).filter((e) => e.type === 'feed');
  assert.equal(feed.length, 2);
  // v absent = 1: no tag, plain room post.
  assert.equal(feed[0].item.channel, 'room');
  assert.deepEqual(feed[0].item.tags, []);
  // v 2: still renders, tagged.
  assert.equal(feed[1].item.text, 'from the future');
  assert.deepEqual(feed[1].item.tags, ['schema v2']);
});

test('an unknown kind renders tagged with unchanged channel discrimination', async () => {
  const { engine, api } = await boundEngine();
  await engine.execute(':all show'); // earlier tests persist hidden state in the shared view file
  api._setCaptures([
    { id: 'c2', createdAt: '2026-08-14T02:30:00Z', signerLabel: 'Bunny', body: JSON.stringify({ v: 1, kind: 'banana', to: 'director', text: 'odd but addressed' }), contentType: 'application/json' },
    { id: 'c1', createdAt: '2026-08-14T02:00:00Z', signerLabel: 'Bunny', body: JSON.stringify({ v: 1, kind: 'banana', text: 'odd' }), contentType: 'application/json' },
  ]);
  const feed = (await engine.pollFeed(1)).filter((e) => e.type === 'feed');
  assert.equal(feed[0].item.channel, 'room');
  assert.deepEqual(feed[0].item.tags, ['unknown kind: banana']);
  assert.equal(feed[0].item.text, 'odd');
  // to present keeps the mention channel (discrimination unchanged); the tag rides along.
  assert.equal(feed[1].item.channel, 'mention');
  assert.deepEqual(feed[1].item.tags, ['unknown kind: banana']);
});

test('a verb renders as an order/receipt line: fp: stripped, r: marked, unknown tagged, never executed', async () => {
  const { engine, api, calls } = await boundEngine();
  await engine.execute(':all show');
  api._setCaptures([
    // newest-first, as the server pages
    { id: 'c4', createdAt: '2026-08-14T02:40:00Z', signerLabel: 'Bunny', body: JSON.stringify({ v: 1, kind: 'message', from: 'bunny', to: 'director', verb: 'ack', re: 'c9' }), contentType: 'application/json' },
    { id: 'c3', createdAt: '2026-08-14T02:30:00Z', signerLabel: 'Bunny', body: JSON.stringify({ v: 1, kind: 'message', from: 'bunny', to: 'director', verb: 'fp:dance' }), contentType: 'application/json' },
    { id: 'c2', createdAt: '2026-08-14T02:20:00Z', signerLabel: 'Bunny', body: JSON.stringify({ v: 1, kind: 'message', from: 'bunny', to: 'director', verb: 'r:triage', args: ['inbox'] }), contentType: 'application/json' },
    { id: 'c1', createdAt: '2026-08-14T02:10:00Z', signerLabel: 'owner', body: JSON.stringify({ v: 1, kind: 'message', from: 'director', to: 'bunny', verb: 'fp:install', args: ['slack-post'], text: 'take this one' }), contentType: 'application/json' },
  ]);
  const feed = (await engine.pollFeed(1)).filter((e) => e.type === 'feed');
  assert.equal(feed.length, 4);

  // fp: registry verb: prefix stripped for display, args carried, text below, no tag.
  assert.deepEqual(feed[0].item.verb, { raw: 'fp:install', display: 'install', recipe: false, args: ['slack-post'] });
  assert.equal(feed[0].item.text, 'take this one');
  assert.deepEqual(feed[0].item.tags, []);

  // r: verb: open space, marked as a recipe verb, never tagged unknown.
  assert.deepEqual(feed[1].item.verb, { raw: 'r:triage', display: 'triage', recipe: true, args: ['inbox'] });
  assert.deepEqual(feed[1].item.tags, []);
  // A verb post with no text renders meta only, not the raw body.
  assert.equal(feed[1].item.text, '');

  // Unknown fp: verb and unprefixed verb: rendered, tagged, never obeyed.
  assert.deepEqual(feed[2].item.tags, ['unknown verb: fp:dance']);
  assert.equal(feed[2].item.verb.display, 'dance');
  assert.deepEqual(feed[3].item.tags, ['unknown verb: ack']);
  assert.equal(feed[3].item.verb.display, 'ack');

  // Render only: nothing on the feed ever caused a write.
  assert.equal(calls.posts.length, 0);
  assert.equal(calls.revokes.length, 0);
});

test('non-JSON, non-object, and truncated bodies still render raw (v0 behavior kept)', async () => {
  const { engine, api } = await boundEngine();
  const truncated = JSON.stringify({ v: 1, kind: 'message', text: 'x'.repeat(50) }).slice(0, 40);
  api._setCaptures([
    { id: 'c3', createdAt: '2026-08-14T02:30:00Z', signerLabel: 'Bunny', body: '[1,2,3]', contentType: 'application/json' },
    { id: 'c2', createdAt: '2026-08-14T02:20:00Z', signerLabel: 'Bunny', body: truncated, contentType: 'application/json' },
    { id: 'c1', createdAt: '2026-08-14T02:10:00Z', signerLabel: 'Bunny', body: 'plain words', contentType: 'text/plain' },
  ]);
  const feed = (await engine.pollFeed(1)).filter((e) => e.type === 'feed');
  assert.equal(feed[0].item.channel, 'raw');
  assert.equal(feed[0].item.text, 'plain words');
  assert.equal(feed[1].item.channel, 'raw'); // truncated JSON fails parse
  assert.equal(feed[1].item.text, truncated);
  assert.equal(feed[2].item.channel, 'raw'); // a JSON array is not an object
});

test('a JSON object with no text field renders a TRIMMED stand-in, tagged with the full size', async () => {
  const { engine, api } = await boundEngine();
  await engine.execute(':all show');
  // The shape found live on 08-14: writers-room rows are objects with no `text`,
  // so the raw body stands in. Uncapped, ten of these buried the room.
  const big = JSON.stringify({ seat: 'envoy-shelves-intake', kind: 'draft', category: 'games', prose: 'z'.repeat(1200) });
  const small = JSON.stringify({ kind: 'draft', note: 'short enough to stand whole' });
  api._setCaptures([
    { id: 'c2', createdAt: '2026-08-14T02:20:00Z', signerLabel: 'Bunny', body: small, contentType: 'application/json' },
    { id: 'c1', createdAt: '2026-08-14T02:10:00Z', signerLabel: 'Bunny', body: big, contentType: 'application/json' },
  ]);
  const feed = (await engine.pollFeed(1)).filter((e) => e.type === 'feed');

  // Over the cap: trimmed to exactly the preview, ellipsis appended, trim declared.
  assert.equal(feed[0].item.text, big.slice(0, 220) + '...');
  assert.ok(feed[0].item.tags.includes(`no text field, showing first 220 of ${big.length} chars`));
  // §2 still holds around the trim: the unknown kind is tagged, never dropped.
  assert.ok(feed[0].item.tags.includes('unknown kind: draft'));

  // Under the cap: stands whole, and nothing claims a trim that did not happen.
  assert.equal(feed[1].item.text, small);
  assert.ok(!feed[1].item.tags.some((t) => t.startsWith('no text field')));
});

// ─────────────────── D. chair identity (ask, persist, seed) ───────────────────

test('the first :seat mint ever asks for the chair address, persists it, and posts carry it', async () => {
  putChairIdentity(''); // virgin config
  const { engine, calls } = await boundEngine();
  const ask = await engine.execute(':seat Bunny Guest');
  assert.equal(ask[0].type, 'ask');
  assert.match(ask[0].text, new RegExp(`enter for ${CHAIR_FROM}`));
  assert.equal(calls.mints.length, 0); // nothing minted until the answer lands

  const done = await engine.execute('Gene B!');
  assert.match(done[0].text, /Your address is gene-b/); // normalized through the handle alphabet
  assert.equal(done[1].type, 'pairing'); // the held mint proceeds
  assert.equal(calls.mints.length, 1);
  assert.equal(getChairIdentity(), 'gene-b'); // persisted

  // The byline follows the seeded address; the wire carries it as from.
  await engine.execute('hello room');
  const body = JSON.parse(calls.posts[0].body);
  assert.equal(body.from, 'gene-b');
  assert.match(done[1].passLines.join('\n'), /The chair is gene-b/);
});

test('later sessions seed from config silently - the ask happens once ever', async () => {
  assert.equal(getChairIdentity(), 'gene-b'); // left by the previous test
  const { engine, calls } = await boundEngine(); // a fresh engine = a new session
  const events = await engine.execute(':seat Another Guest');
  assert.equal(events[0].type, 'pairing'); // no ask
  assert.equal(calls.mints.length, 1);
});

test('the seeded address is reserved at mint: a seat can never normalize onto it', async () => {
  assert.equal(getChairIdentity(), 'gene-b');
  const { engine } = await boundEngine();
  await engine.execute(':seat Gene B');
  const roster = await engine.execute(':list seats');
  // gene-b is the chair's; the seat lands suffixed.
  assert.ok(roster[0].rows.some((r) => r.handle === 'gene-b-2'));
  assert.ok(!roster[0].rows.some((r) => r.handle === 'gene-b'));
});

test('reserved words and verb namespaces are refused as the address; empty takes the default', async () => {
  putChairIdentity(''); // virgin again
  const { engine } = await boundEngine();
  await engine.execute(':seat Bunny Guest');
  const refused = await engine.execute('all');
  assert.equal(refused[0].type, 'error');
  assert.match(refused[0].text, /cannot be the chair's address/);
  assert.equal(refused[1].type, 'ask'); // re-asked, the mint still held
  const seeded = await engine.execute('');
  assert.match(seeded[0].text, new RegExp(`Your address is ${CHAIR_FROM}`));
  assert.equal(seeded[1].type, 'pairing');
  assert.equal(getChairIdentity(), CHAIR_FROM);
});

test('rebinding to another project clears the endpoint context', async () => {
  const { engine } = await boundEngine();
  const events = await engine.execute(':set project bar');
  assert.match(events.map((e) => e.text).join('\n'), /Endpoint context cleared/);
  assert.equal(engine.isBound(), false);
});

// ─────────────────── E. exit verbs (#253: leave words, engine announces) ───────────────────

test(':exit, :quit, and :q are bare synonyms; arguments are a usage error, help stays reachable', () => {
  assert.deepEqual(parseLine(':exit'), { kind: 'exit' });
  assert.deepEqual(parseLine(':quit'), { kind: 'exit' });
  assert.deepEqual(parseLine(':q'), { kind: 'exit' });
  assert.deepEqual(parseLine(':EXIT'), { kind: 'exit' }); // command words are case-forgiving
  assert.equal(parseLine(':exit now').code, 'exit_usage');
  assert.equal(parseLine(':q please').code, 'exit_usage');
  assert.deepEqual(parseLine(':exit help'), { kind: 'help', topic: 'exit' });
});

test('the leave words can never be handles: exit/quit/q seats bind suffixed (the lock)', () => {
  for (const word of ['exit', 'quit', 'q']) assert.ok(RESERVED_WORDS.has(word), `${word} is reserved`);
  const rows = assignHandles([{ guestName: 'Exit' }, { guestName: 'Quit' }, { guestName: 'Q' }]);
  assert.deepEqual(rows.map((r) => r.handle), ['exit-2', 'quit-2', 'q-2']);
});

test('the engine announces exit and never exits: the event is the whole answer', async () => {
  const { engine, calls } = await boundEngine();
  const events = await engine.execute(':exit');
  assert.deepEqual(events, [{ type: 'exit' }]);
  assert.equal(calls.posts.length, 0);
  // Works unbound too: leaving needs no room.
  const fresh = new ConsoleEngine(fakeRoom().api);
  assert.deepEqual(await fresh.execute(':quit'), [{ type: 'exit' }]);
});

// ─────────────── F. lazy room start (#253: the console hosts the room) ───────────────

/** Fake RoomHost: counts calls; started is true only on the first. */
function fakeHost(url = 'http://127.0.0.1:9999/mcp') {
  return {
    calls: 0,
    async ensureStarted() {
      this.calls += 1;
      return { url, started: this.calls === 1 };
    },
  };
}

test('lazy start: the room host is untouched until the first :seat mint', async () => {
  putChairIdentity(CHAIR_FROM);
  const room = fakeRoom();
  const host = fakeHost();
  const engine = new ConsoleEngine(room.api, host);
  await engine.execute(':list projects');
  await engine.execute(':set project foo');
  await engine.execute(':set endpoint room');
  await engine.pollFeed(1);
  await engine.execute('hello room');
  assert.equal(host.calls, 0, 'a console that never mints never binds a port');

  const events = await engine.execute(':seat Bunny Guest');
  assert.equal(host.calls, 1, 'the first mint starts the room');
  assert.equal(events[0].type, 'info');
  assert.match(events[0].text, /hosts the room/);
  assert.ok(events[0].text.includes('http://127.0.0.1:9999/mcp'));
  // The boarding pass carries the in-process room URL (the slice-A seam, filled).
  const pairing = events.find((e) => e.type === 'pairing');
  assert.ok(pairing.passLines.join('\n').includes("Seat server: http://127.0.0.1:9999/mcp"));

  // A second mint reuses the running room: no second hosting banner.
  const again = await engine.execute(':seat Second Guest');
  assert.equal(host.calls, 2);
  assert.equal(again[0].type, 'pairing');
});

test('a room start failure degrades to the standalone pass and never loses the mint', async () => {
  putChairIdentity(CHAIR_FROM);
  const room = fakeRoom();
  const host = { async ensureStarted() { throw new Error('the port is on fire'); } };
  const engine = new ConsoleEngine(room.api, host);
  await engine.execute(':set project foo');
  await engine.execute(':set endpoint room');
  const events = await engine.execute(':seat Bunny Guest');
  assert.equal(events[0].type, 'error');
  assert.match(events[0].text, /Could not start the in-process room server/);
  const pairing = events.find((e) => e.type === 'pairing');
  assert.ok(pairing, 'the mint still happens');
  assert.match(pairing.passLines.join('\n'), /flurryport seat-server/); // the standalone pointer
});

// ─────────────── G. attention verbs (slice C: hold/resume = state, interrupt = act) ───────────────

test('parser: attention verbs are target-first; hold and resume are bare; interrupt takes the rest of the line', () => {
  assert.deepEqual(parseLine(':bunny hold'), { kind: 'targeted', target: 'bunny', all: false, verb: 'hold', force: false });
  assert.deepEqual(parseLine(':bunny resume'), { kind: 'targeted', target: 'bunny', all: false, verb: 'resume', force: false });
  assert.equal(parseLine(':bunny hold the line').code, 'verb_takes_nothing');
  assert.equal(parseLine(':bunny resume now').code, 'verb_takes_nothing');
  // Bare interrupt = hard stop (no text field at all); with a message = redirect.
  assert.deepEqual(parseLine(':bunny interrupt'), { kind: 'targeted', target: 'bunny', all: false, verb: 'interrupt', force: false });
  assert.deepEqual(parseLine(':bunny interrupt drop the parser, take the feed'), {
    kind: 'targeted', target: 'bunny', all: false, verb: 'interrupt', text: 'drop the parser, take the feed', force: false,
  });
  // ! attaches to the verb; :all ranges every attention verb.
  assert.deepEqual(parseLine(':all interrupt!'), { kind: 'targeted', target: 'all', all: true, verb: 'interrupt', force: true });
  assert.deepEqual(parseLine(':all hold'), { kind: 'targeted', target: 'all', all: true, verb: 'hold', force: false });
});

test('attention wire shapes are exact (§5): fp:hold / fp:resume / bare-vs-text fp:interrupt / panic', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine, calls } = await boundEngine();

  await engine.execute(':bunny hold');
  assert.deepEqual(JSON.parse(calls.posts[0].body), { v: 1, kind: 'message', from: CHAIR_FROM, to: 'bunny', verb: 'fp:hold' });
  assert.deepEqual(Object.keys(JSON.parse(calls.posts[0].body)), ['v', 'kind', 'from', 'to', 'verb']);

  await engine.execute(':bunny resume');
  assert.deepEqual(JSON.parse(calls.posts[1].body), { v: 1, kind: 'message', from: CHAIR_FROM, to: 'bunny', verb: 'fp:resume' });

  // Bare interrupt = hard stop: NO text member (ruled 3; the empty-string ban makes this safe).
  await engine.execute(':bunny interrupt');
  const hard = JSON.parse(calls.posts[2].body);
  assert.deepEqual(hard, { v: 1, kind: 'message', from: CHAIR_FROM, to: 'bunny', verb: 'fp:interrupt' });
  assert.ok(!('text' in hard), 'a hard stop carries no text member');

  await engine.execute(':bunny interrupt drop the parser, take the feed');
  const redirect = JSON.parse(calls.posts[3].body);
  assert.deepEqual(redirect, {
    v: 1, kind: 'message', from: CHAIR_FROM, to: 'bunny', verb: 'fp:interrupt', text: 'drop the parser, take the feed',
  });
  assert.deepEqual(Object.keys(redirect), ['v', 'kind', 'from', 'to', 'verb', 'text']);

  // Panic: ! sets panic:true and the member order is canonical (§1).
  await engine.execute(':all interrupt! stop everything');
  const panic = JSON.parse(calls.posts[4].body);
  assert.deepEqual(panic, {
    v: 1, kind: 'message', from: CHAIR_FROM, to: 'all', verb: 'fp:interrupt', panic: true, text: 'stop everything',
  });
  assert.deepEqual(Object.keys(panic), ['v', 'kind', 'from', 'to', 'verb', 'panic', 'text']);
});

test(':all attention acts are ONE post to:"all" on the wire (one capture, one label), never N posts', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine, calls } = await boundEngine();
  await engine.execute(':all hold');
  assert.equal(calls.posts.length, 1, ':all hold is a single post');
  assert.equal(JSON.parse(calls.posts[0].body).to, 'all');
  const roster = await engine.execute(':list roster');
  assert.deepEqual(roster[0].rows.map((r) => r.held), [true, true], 'every seat carries the held mark');
  await engine.execute(':all resume');
  assert.equal(calls.posts.length, 2, ':all resume is a single post');
  const after = await engine.execute(':list roster');
  assert.deepEqual(after[0].rows.map((r) => r.held), [false, false]);
});

test('a plain mention at a HELD seat translates to fp:interrupt + text and releases the hold (ruled 2)', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine, calls } = await boundEngine();
  await engine.execute(':bunny hold');
  const roster = await engine.execute(':list roster');
  assert.equal(roster[0].rows.find((r) => r.handle === 'bunny').held, true);

  const events = await engine.execute(':bunny take the feed instead');
  const body = JSON.parse(calls.posts[1].body);
  assert.deepEqual(body, {
    v: 1, kind: 'message', from: CHAIR_FROM, to: 'bunny', verb: 'fp:interrupt', text: 'take the feed instead',
  });
  assert.match(events.map((e) => e.text).join('\n'), /released the hold/);

  // The hold ended: the next mention is a plain mention again.
  await engine.execute(':bunny nice work');
  const plain = JSON.parse(calls.posts[2].body);
  assert.deepEqual(plain, { v: 1, kind: 'message', from: CHAIR_FROM, to: 'bunny', text: 'nice work' });
});

test('resume is the other way out of a hold: after it, mentions are plain again', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine, calls } = await boundEngine();
  await engine.execute(':bunny hold');
  await engine.execute(':bunny resume');
  await engine.execute(':bunny carry on');
  const body = JSON.parse(calls.posts[2].body);
  assert.equal(body.verb, undefined, 'a resumed seat takes plain mentions');
  assert.equal(body.text, 'carry on');
});

test('the engine hands attention orders to the RoomHost seam by participant name', async () => {
  putChairIdentity(CHAIR_FROM);
  const room = fakeRoom();
  const host = {
    orders: [],
    async ensureStarted() { return { url: 'http://127.0.0.1:9999/mcp', started: false }; },
    orderAttention(names, order) { this.orders.push({ names, order }); },
  };
  const engine = new ConsoleEngine(room.api, host);
  await engine.execute(':set project foo');
  await engine.execute(':set endpoint room');

  await engine.execute(':bunny hold');
  assert.deepEqual(host.orders[0], { names: ['Bunny'], order: { code: 'attention_hold', panic: false } });
  await engine.execute(':all interrupt! stop everything');
  assert.deepEqual(host.orders[1], {
    names: ['Bunny', 'The Tall Bard'],
    order: { code: 'attention_interrupt', panic: true },
  });
  await engine.execute(':bunny resume');
  assert.deepEqual(host.orders[2], { names: ['Bunny'], order: { code: 'attention_resume', panic: false } });
});

// ─────────────── H. status (#246: the layered verb + tables) ───────────────

test('parser: status is bare and ranges; extra words are a usage error', () => {
  assert.deepEqual(parseLine(':bunny status'), { kind: 'targeted', target: 'bunny', all: false, verb: 'status', force: false });
  assert.deepEqual(parseLine(':all status'), { kind: 'targeted', target: 'all', all: true, verb: 'status', force: false });
  assert.equal(parseLine(':bunny status report').code, 'verb_takes_nothing');
});

test(':bunny status renders the facts table instantly AND posts the fp:status request', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine, calls } = await boundEngine();
  const events = await engine.execute(':bunny status');
  assert.equal(events[0].type, 'status');
  assert.deepEqual(events[0].rows, [{
    handle: 'bunny', guestName: 'Bunny', state: 'live', expiresAt: '2026-08-15T00:00:00Z',
    lastPostAt: null, posts: 0, stanza: null, stanzaAt: null,
  }]);
  // Layer 3: the addressed wire act - the seat owes an answer.
  assert.deepEqual(JSON.parse(calls.posts[0].body), { v: 1, kind: 'message', from: CHAIR_FROM, to: 'bunny', verb: 'fp:status' });
  assert.match(events.map((e) => e.text ?? '').join('\n'), /owes an answer/);
});

test('the status table reads live/held/idle from engine state', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine } = await boundEngine();
  await engine.execute(':bunny hold');
  let rows = (await engine.execute(':bunny status'))[0].rows;
  assert.equal(rows[0].state, 'held');
  await engine.execute(':bunny interrupt'); // bare = hard stop: the seat idles
  rows = (await engine.execute(':bunny status'))[0].rows;
  assert.equal(rows[0].state, 'idle');
  await engine.execute(':bunny new orders'); // fresh orders end the idle
  rows = (await engine.execute(':bunny status'))[0].rows;
  assert.equal(rows[0].state, 'live');
});

test('the stanza off the latest signed post rides the status table, and the feed carries it generically', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine, api } = await boundEngine();
  await engine.execute(':all show');
  api._setCaptures([
    // newest-first, as the server pages
    { id: 'c2', createdAt: '2026-08-14T03:00:00Z', signerLabel: 'Bunny', body: JSON.stringify({ v: 1, kind: 'message', from: 'bunny', to: 'director', verb: 'fp:ack', re: 'c9', status: { task: 'installing slack-post', blockers: [] } }), contentType: 'application/json' },
    { id: 'c1', createdAt: '2026-08-14T02:00:00Z', signerLabel: 'Bunny', body: JSON.stringify({ v: 1, kind: 'message', from: 'bunny', text: 'hi', status: { task: 'warming up' } }), contentType: 'application/json' },
  ]);
  const feed = (await engine.pollFeed(1)).filter((e) => e.type === 'feed');
  // The status member is console-opaque and rendered generically off the feed item.
  assert.deepEqual(feed[0].item.status, { task: 'warming up' });
  assert.deepEqual(feed[1].item.status, { task: 'installing slack-post', blockers: [] });
  // Re-linked reply: the referenced short id rides the item for the meta line.
  assert.equal(feed[1].item.re, 'c9');
  assert.equal(feed[1].item.verb.display, 'ack');

  const rows = (await engine.execute(':bunny status'))[0].rows;
  assert.equal(rows[0].posts, 2, 'post count from feed history');
  assert.equal(rows[0].lastPostAt, '2026-08-14T03:00:00Z');
  assert.deepEqual(rows[0].stanza, { task: 'installing slack-post', blockers: [] }, 'the LATEST stanza wins');
  assert.equal(rows[0].stanzaAt, '2026-08-14T03:00:00Z');
});

test('a protocol status rides the feed as a ticker; consecutive same-seat same-state repeats collapse (#280)', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine, api } = await boundEngine();
  await engine.execute(':all show');
  const wire = (o) => JSON.stringify({ v: 1, kind: 'message', ...o });
  api._setCaptures([
    // newest-first, as the server pages (the engine replays chronologically t1..t6)
    { id: 't6', createdAt: '2026-08-14T03:50:00Z', signerLabel: 'Bunny', body: wire({ from: 'bunny', verb: 'fp:status', status: { state: 'review' } }) },
    { id: 't5', createdAt: '2026-08-14T03:40:00Z', signerLabel: 'Bunny', body: wire({ from: 'bunny', text: 'found it', status: { state: 'working' } }) },
    { id: 't4', createdAt: '2026-08-14T03:30:00Z', signerLabel: 'fable', body: wire({ from: 'fable', verb: 'fp:status', status: { state: 'working' } }) },
    { id: 't3', createdAt: '2026-08-14T03:20:00Z', signerLabel: 'Bunny', body: wire({ from: 'bunny', verb: 'fp:status', status: { state: 'working', task: 'still compiling' } }) },
    { id: 't2', createdAt: '2026-08-14T03:10:00Z', signerLabel: 'Bunny', body: wire({ from: 'bunny', verb: 'fp:status', status: { state: 'working', reason: 'compiling' } }) },
    { id: 't1', createdAt: '2026-08-14T03:00:00Z', signerLabel: 'Bunny', body: wire({ from: 'bunny', text: 'hello', status: { task: 'no protocol state' } }) },
  ]);
  const feed = (await engine.pollFeed(1)).filter((e) => e.type === 'feed').map((e) => e.item);

  // t1: a stanza WITHOUT the protocol state is no ticker - the generic path stands.
  assert.equal(feed[0].statusTicker, null);
  assert.deepEqual(feed[0].status, { task: 'no protocol state' });
  // t2: a bare fp:status transition is a pure ticker; reason rides as the detail.
  assert.deepEqual(feed[1].statusTicker, { state: 'working', detail: 'compiling', pure: true, repeated: false });
  // t3: same seat, same state, back to back - the repeat collapses (task is the detail fallback).
  assert.deepEqual(feed[2].statusTicker, { state: 'working', detail: 'still compiling', pure: true, repeated: true });
  // t4: another seat in the same state is NOT a repeat.
  assert.equal(feed[3].statusTicker.repeated, false);
  // t5: a status riding a content post is a ticker too, but not pure - the text renders.
  assert.equal(feed[4].statusTicker.pure, false);
  assert.equal(feed[4].text, 'found it');
  // t6: the same seat moving to a NEW state is not a repeat.
  assert.deepEqual(feed[5].statusTicker, { state: 'review', detail: null, pure: true, repeated: false });
});

test(':all status is the roll call: every row in the table plus ONE post to all', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine, calls } = await boundEngine();
  const events = await engine.execute(':all status');
  assert.equal(events[0].type, 'status');
  assert.deepEqual(events[0].rows.map((r) => r.handle), ['bunny', 'the-tall-bard']);
  assert.equal(calls.posts.length, 1);
  assert.deepEqual(JSON.parse(calls.posts[0].body), { v: 1, kind: 'message', from: CHAIR_FROM, to: 'all', verb: 'fp:status' });
  // The panic roll call rides the same act with panic:true (comparable records, ruled 4).
  await engine.execute(':all status!');
  assert.deepEqual(JSON.parse(calls.posts[1].body), { v: 1, kind: 'message', from: CHAIR_FROM, to: 'all', verb: 'fp:status', panic: true });
});

// ─────────────── I. addressed install / upgrade (#249: the verb commissions) ───────────────

test('parser: install and upgrade are addressed, take exactly one recipe name, and refuse :all', () => {
  assert.deepEqual(parseLine(':fable install slack-post'), {
    kind: 'targeted', target: 'fable', all: false, verb: 'install', recipe: 'slack-post', force: false,
  });
  assert.deepEqual(parseLine(':fable upgrade slack-post'), {
    kind: 'targeted', target: 'fable', all: false, verb: 'upgrade', recipe: 'slack-post', force: false,
  });
  assert.equal(parseLine(':fable install').code, 'install_needs_recipe');
  assert.equal(parseLine(':fable install one two').code, 'install_needs_recipe');
  // An order to install goes to ONE steward: the chair picks (:all refused, friendly usage).
  assert.equal(parseLine(':all install slack-post').code, 'install_no_all');
  assert.equal(parseLine(':all upgrade slack-post').code, 'install_no_all');
});

test('install and upgrade emit fp:install orders; upgrade is sugar carrying the prose instruction', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine, calls } = await boundEngine();
  const events = await engine.execute(':bunny install slack-post');
  const install = JSON.parse(calls.posts[0].body);
  assert.deepEqual(install, { v: 1, kind: 'message', from: CHAIR_FROM, to: 'bunny', verb: 'fp:install', args: ['slack-post'] });
  assert.deepEqual(Object.keys(install), ['v', 'kind', 'from', 'to', 'verb', 'args']);
  assert.match(events.map((e) => e.text ?? '').join('\n'), /stewards slack-post/);

  // fp:upgrade is NOT in the v1 registry: :upgrade rides fp:install, args stay machine
  // tokens, the upgrade instruction is prose in text (flagged for the gavel record).
  await engine.execute(':bunny upgrade slack-post');
  const upgrade = JSON.parse(calls.posts[1].body);
  assert.deepEqual(upgrade, {
    v: 1, kind: 'message', from: CHAIR_FROM, to: 'bunny', verb: 'fp:install', args: ['slack-post'],
    text: 'upgrade to the latest version',
  });
  assert.deepEqual(Object.keys(upgrade), ['v', 'kind', 'from', 'to', 'verb', 'args', 'text']);
});

test('the :all install refusal renders the friendly steward line', async () => {
  const { engine } = await boundEngine();
  const events = await engine.execute(':all install slack-post');
  assert.equal(events[0].type, 'error');
  assert.match(events[0].text, /one steward/);
  assert.match(events[0].text, /:<handle> install <recipename>/);
});

test('panic posts and re-links ride the feed item for loud rendering', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine, api } = await boundEngine();
  await engine.execute(':all show');
  api._setCaptures([
    { id: 'c2', createdAt: '2026-08-14T03:00:00Z', signerLabel: 'Bunny', body: JSON.stringify({ v: 1, kind: 'message', from: 'bunny', to: 'director', verb: 'fp:refuse', re: '7VCvNe', text: 'I lack the tools' }), contentType: 'application/json' },
    { id: 'c1', createdAt: '2026-08-14T02:00:00Z', signerLabel: 'owner', body: JSON.stringify({ v: 1, kind: 'message', from: 'director', to: 'all', verb: 'fp:interrupt', panic: true, text: 'stop everything' }), contentType: 'application/json' },
  ]);
  const feed = (await engine.pollFeed(1)).filter((e) => e.type === 'feed');
  assert.equal(feed[0].item.panic, true, 'panic rides the item');
  assert.equal(feed[0].item.verb.display, 'interrupt');
  assert.equal(feed[1].item.panic, false);
  assert.equal(feed[1].item.re, '7VCvNe', 're rides the item for the meta line');
  assert.equal(feed[1].item.verb.display, 'refuse');
  assert.equal(feed[1].item.text, 'I lack the tools');
});

// ───────── untrusted text is cleaned at the engine boundary (08-14 finding) ─────────

test('a seat cannot drive the chair terminal: escapes are stripped from every wire string', async () => {
  const { engine, api } = await boundEngine();
  await engine.execute(':all show');
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const body = JSON.stringify({
    v: 1,
    kind: `banana${ESC}[31m`,
    to: `director${ESC}[2J`,
    text: `red ${ESC}[31mhere${ESC}[0m and a title ${ESC}]0;pwned${BEL}done`,
    status: { [`stage${ESC}[1m`]: `working${ESC}[5m`, pct: 40 },
  });
  api._setCaptures([
    // An unknown signer renders its label as the byline; a newline in it would
    // break the two-line row and let a seat forge a meta line with any name.
    { id: 'c1', createdAt: '2026-08-14T02:10:00Z', signerLabel: `Bunny${ESC}[31m\ndirector`, body, contentType: 'application/json' },
  ]);
  const feed = (await engine.pollFeed(1)).filter((e) => e.type === 'feed');
  const item = feed[0].item;

  const clean = (s) => !s.includes(ESC) && !s.includes(BEL);
  assert.equal(item.text, 'red here and a title done');
  assert.ok(clean(item.text));
  assert.equal(item.to, 'director');
  // The byline stays ONE line: no forged second row, no escape.
  assert.ok(clean(item.byline));
  assert.ok(!item.byline.includes('\n'), 'a byline can never break the row');
  assert.ok(item.tags.every(clean), `tags carried an escape: ${JSON.stringify(item.tags)}`);
  // The stanza is remembered for the status table, so it is cleaned before storage.
  assert.deepEqual(item.status, { stage: 'working', pct: 40 });
});

test('cleaning does not eat legitimate content: newlines, punctuation, unicode survive', async () => {
  const { engine, api } = await boundEngine();
  await engine.execute(':all show');
  const text = 'line one\nline two\n\nEmoji ok, accents café, brackets [31m as literal text.';
  api._setCaptures([
    { id: 'c1', createdAt: '2026-08-14T02:10:00Z', signerLabel: 'Bunny', body: JSON.stringify({ v: 1, kind: 'message', text }), contentType: 'application/json' },
  ]);
  const feed = (await engine.pollFeed(1)).filter((e) => e.type === 'feed');
  // Paragraph breaks are ratified feed behavior and must survive the cleaner.
  assert.equal(feed[0].item.text, text);
});

// ─────────────── J. revoke greys + :delete (#267: post-mortem cleanup) ───────────────

/**
 * A dedicated fake on its OWN endpoint id: delete persists in the shared view
 * file keyed endpointId:inviteId, so these tests must never touch e1 - a leaked
 * deletion there would silently thin every other test's roster.
 */
function deleteFake() {
  const calls = { revokes: [], mints: [] };
  const seats = [
    { inviteId: 'del-ghost', ref: 'seat-d1', guestName: 'Ghost', status: 'accepted', expiresAt: '2026-08-15T00:00:00Z', createdAt: '2026-08-14T01:00:00Z' },
    { inviteId: 'del-keeper', ref: 'seat-d2', guestName: 'Keeper', status: 'accepted', expiresAt: '2026-08-15T00:00:00Z', createdAt: '2026-08-14T02:00:00Z' },
  ];
  let nextInvite = 3;
  const api = {
    async listProjects() { return [{ id: 'pdel', name: 'Del', slug: 'del', suspended: false }]; },
    async listEndpoints() { return [{ id: 'edel', projectId: 'pdel', name: 'Morgue', slug: 'morgue' }]; },
    async getEndpointDetail() { return { slug: 'morgue', signingEnabled: true, signingHeader: 'X-Flurry-Signature' }; },
    async listSeats(endpointId) { return endpointId === 'edel' ? seats.map((s) => ({ ...s })) : []; },
    async mintSeat(endpointId, guestName) {
      calls.mints.push({ endpointId, guestName });
      const inviteId = `del-${nextInvite}`;
      seats.push({
        inviteId, ref: `seat-d${nextInvite}`, guestName,
        status: 'accepted', expiresAt: '2026-08-15T00:00:00Z', createdAt: `2026-08-14T0${nextInvite}:00:00Z`,
      });
      nextInvite += 1;
      return {
        pairingCode: '7WHM-KR4P-XT2B', ref: `seat-d${nextInvite - 1}`, participantName: guestName,
        expiresAt: '2026-08-15T00:00:00Z', codeExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
    },
    async revokeInvite(endpointId, inviteId) {
      calls.revokes.push({ endpointId, inviteId });
      const seat = seats.find((s) => s.inviteId === inviteId);
      if (seat) seat.status = 'revoked';
    },
    async waitCaptures() { return { rows: [], nextCursor: null, readAs: null }; },
    async listCaptures() { return { rows: [], nextCursor: null, readAs: 'owner' }; },
    hasSigningKey() { return true; },
    async post() { return { httpStatus: 200, ok: true, durationMs: 1, sizeBytes: 0, errorText: '', captureId: 'cap-1', executions: null }; },
  };
  return { api, calls, seats };
}

async function deleteEngine() {
  const room = deleteFake();
  const engine = new ConsoleEngine(room.api);
  await engine.execute(':set del/morgue');
  return { engine, ...room };
}

test('parser: delete is a bare target verb like revoke; verb-first is a range error; delete is reserved', () => {
  assert.deepEqual(parseLine(':ghost delete'), { kind: 'targeted', target: 'ghost', all: false, verb: 'delete', force: false });
  assert.deepEqual(parseLine(':all delete'), { kind: 'targeted', target: 'all', all: true, verb: 'delete', force: false });
  assert.equal(parseLine(':delete').code, 'verb_needs_target');
  assert.ok(RESERVED_WORDS.has('delete'), 'delete is reserved');
  const rows = assignHandles([{ guestName: 'Delete' }]);
  assert.deepEqual(rows.map((r) => r.handle), ['delete-2']);
});

test('a revoked seat stays on the roster GREYED instead of vanishing', async () => {
  const { engine } = await deleteEngine();
  await engine.execute(':ghost revoke!');
  const roster = await engine.execute(':list seats');
  const ghost = roster[0].rows.find((r) => r.handle === 'ghost');
  assert.ok(ghost, 'the revoked seat keeps its row');
  assert.equal(ghost.status, 'revoked');
  assert.equal(ghost.live, false);
  assert.equal(ghost.greyed, true, 'revoked renders greyed');
  assert.equal(roster[0].rows.find((r) => r.handle === 'keeper').greyed, false, 'live seats keep their color');
});

test('delete refuses a live seat with the revoke-first lesson; the ladder is untouched', async () => {
  const { engine } = await deleteEngine();
  const refused = await engine.execute(':keeper delete');
  assert.equal(refused[0].type, 'error');
  assert.match(refused[0].text, /still holds a live seat/);
  assert.match(refused[0].text, /Revoke it first/);
  const roster = await engine.execute(':list seats');
  assert.ok(roster[0].rows.some((r) => r.handle === 'keeper'), 'nothing was deleted');
});

test('delete removes a revoked seat from the roster and frees the name for a clean fresh mint', async () => {
  const { engine } = await deleteEngine();
  await engine.execute(':ghost revoke!');
  const done = await engine.execute(':ghost delete');
  assert.equal(done[0].type, 'info');
  assert.match(done[0].text, /Deleted ghost/);
  assert.match(done[0].text, /log keeps its bylines/);
  const roster = await engine.execute(':list seats');
  assert.ok(!roster[0].rows.some((r) => r.handle === 'ghost'), 'the deleted seat is off the roster');

  // The freed name: a fresh mint binds as ghost, NOT ghost-2 - the whole point.
  await engine.execute(':seat Ghost');
  const fresh = await engine.execute(':list seats');
  const handles = fresh[0].rows.map((r) => r.handle);
  assert.ok(handles.includes('ghost'), `fresh mint reuses the clean name: ${handles}`);
  assert.ok(!handles.includes('ghost-2'), 'no corpse suffix');
});

test('deleting nothing deletable answers the friendly line; :all delete sweeps only the dead', async () => {
  const { engine, calls } = await deleteEngine();
  const nothing = await engine.execute(':all delete');
  assert.equal(nothing[0].type, 'error');
  assert.match(nothing[0].text, /No revoked or departed seat/);

  await engine.execute(':keeper revoke!');
  const swept = await engine.execute(':all delete');
  assert.equal(swept.length, 1, ':all delete sweeps the one dead seat and passes the living quietly');
  assert.match(swept[0].text, /Deleted keeper/);
  // Delete is console-local cleanup: no API act rode the sweep beyond the revoke.
  assert.equal(calls.revokes.length, 1);
});

// ─────────────── K. presence truth (#266: live / idle / adrift / departed) ───────────────

/** A dedicated fake on its own endpoint (epres): delete persists in the view file. */
function presenceFake() {
  const seats = [
    { inviteId: 'pres-bunny', ref: 'seat-p1', guestName: 'Bunny', status: 'accepted', expiresAt: '2026-08-15T00:00:00Z', createdAt: '2026-08-14T01:00:00Z' },
    { inviteId: 'pres-bard', ref: 'seat-p2', guestName: 'Bard', status: 'accepted', expiresAt: '2026-08-15T00:00:00Z', createdAt: '2026-08-14T02:00:00Z' },
  ];
  let captures = [];
  const api = {
    async listProjects() { return [{ id: 'ppres', name: 'Pres', slug: 'pres', suspended: false }]; },
    async listEndpoints() { return [{ id: 'epres', projectId: 'ppres', name: 'Deck', slug: 'deck' }]; },
    async getEndpointDetail() { return { slug: 'deck', signingEnabled: true, signingHeader: 'X-Flurry-Signature' }; },
    async listSeats(endpointId) { return endpointId === 'epres' ? seats.map((s) => ({ ...s })) : []; },
    async revokeInvite(endpointId, inviteId) {
      const seat = seats.find((s) => s.inviteId === inviteId);
      if (seat) seat.status = 'revoked';
    },
    async waitCaptures() { return { rows: [...captures], nextCursor: null, readAs: null }; },
    async listCaptures() { return { rows: [...captures], nextCursor: 'cur-1', readAs: 'owner' }; },
    hasSigningKey() { return true; },
    async post() { return { httpStatus: 200, ok: true, durationMs: 1, sizeBytes: 0, errorText: '', captureId: 'cap-1', executions: null }; },
    _setCaptures(rows) { captures = rows; },
  };
  return { api };
}

test('PresenceLedger: live within the poll window, idle past it, adrift on a long gap or never', () => {
  const now = 1_700_000_000_000;
  const ledger = new PresenceLedger();
  assert.equal(ledger.stateFor('bunny', now), 'adrift', 'never seen reads adrift: the transport has no contact');
  ledger.notePoll('Bunny', now - (PRESENCE_LIVE_SECONDS - 5) * 1000);
  assert.equal(ledger.stateFor('bunny', now), 'live', 'roster name and minted name meet in the normalizer');
  ledger.notePoll('bunny', now - (PRESENCE_IDLE_SECONDS - 5) * 1000);
  assert.equal(ledger.stateFor('bunny', now), 'live', 'an out-of-order older contact never regresses the ledger');
  const other = new PresenceLedger();
  other.notePoll('bard', now - (PRESENCE_LIVE_SECONDS + 5) * 1000);
  assert.equal(other.stateFor('bard', now), 'idle');
  other.notePoll('crow', now - (PRESENCE_IDLE_SECONDS + 5) * 1000);
  assert.equal(other.stateFor('crow', now), 'adrift');
});

test('the roster and status read presence truth off the ledger; without one, presence stays null', async () => {
  const room = presenceFake();
  const ledger = new PresenceLedger();
  ledger.notePoll('Bunny'); // contact just now: live
  const engine = new ConsoleEngine(room.api, null, { presence: ledger });
  await engine.execute(':set pres/deck');
  const roster = await engine.execute(':list seats');
  const byHandle = Object.fromEntries(roster[0].rows.map((r) => [r.handle, r]));
  assert.equal(byHandle.bunny.presence, 'live');
  assert.equal(byHandle.bard.presence, 'adrift', 'never polled: the transport truly lost them');
  assert.equal(byHandle.bard.greyed, false, 'adrift is not post-mortem: the seat may come back');

  // The status table speaks the same truth, and held keeps overlaying it.
  assert.equal((await engine.execute(':bard status'))[0].rows[0].state, 'adrift');
  await engine.execute(':bard hold');
  assert.equal((await engine.execute(':bard status'))[0].rows[0].state, 'held');

  // No ledger: presence is null and nothing guesses; the pre-#266 words stand.
  const blind = new ConsoleEngine(presenceFake().api);
  await blind.execute(':set pres/deck');
  const nul = await blind.execute(':list seats');
  assert.equal(nul[0].rows[0].presence, null);
  assert.equal((await blind.execute(':bunny status'))[0].rows[0].state, 'live');
});

test('fp:bye is registry-known and marks the seat departed; a later post returns it', async () => {
  assert.ok(FP_VERBS.has('fp:bye'), 'fp:bye joined the closed registry');
  const room = presenceFake();
  const engine = new ConsoleEngine(room.api);
  await engine.execute(':set pres/deck');
  room.api._setCaptures([
    { id: 'pb1', createdAt: '2026-08-14T02:00:00Z', signerLabel: 'Bunny', body: JSON.stringify({ v: 1, kind: 'message', from: 'bunny', to: 'director', verb: 'fp:bye' }), contentType: 'application/json' },
  ]);
  const feed = (await engine.pollFeed(1)).filter((e) => e.type === 'feed');
  assert.deepEqual(feed[0].item.tags, [], 'fp:bye never renders tagged unknown');
  assert.equal(feed[0].item.verb.display, 'bye');

  let bunny = (await engine.execute(':list seats'))[0].rows.find((r) => r.handle === 'bunny');
  assert.equal(bunny.presence, 'departed');
  assert.equal(bunny.greyed, true, 'departed rides the post-mortem grey (#267)');
  assert.equal((await engine.execute(':bunny status'))[0].rows[0].state, 'departed');

  // Speaking again clears the sign-off: the seat is present, not a ghost.
  room.api._setCaptures([
    { id: 'pb2', createdAt: '2026-08-14T03:00:00Z', signerLabel: 'Bunny', body: JSON.stringify({ v: 1, kind: 'message', from: 'bunny', text: 'back' }), contentType: 'application/json' },
  ]);
  await engine.pollFeed(1);
  bunny = (await engine.execute(':list seats'))[0].rows.find((r) => r.handle === 'bunny');
  assert.equal(bunny.presence, null, 'no ledger here: back to null, never a guess');
  assert.equal(bunny.greyed, false);
});

test('delete unlocks on a departed seat without a revoke: sign-off is a funeral too', async () => {
  const room = presenceFake();
  const engine = new ConsoleEngine(room.api);
  await engine.execute(':set pres/deck');
  room.api._setCaptures([
    { id: 'pb3', createdAt: '2026-08-14T02:00:00Z', signerLabel: 'Bard', body: JSON.stringify({ v: 1, kind: 'message', from: 'bard', verb: 'fp:bye' }), contentType: 'application/json' },
  ]);
  await engine.pollFeed(1);
  const done = await engine.execute(':bard delete');
  assert.match(done[0].text, /Deleted bard/);
  const roster = await engine.execute(':list seats');
  assert.ok(!roster[0].rows.some((r) => r.handle === 'bard'), 'the departed seat is gone after delete');
});

// ─────────────── L. verb-first forgiveness (#277: swap, echo, fall through) ───────────────

test('parser: the exact shape verb handle [args...] swaps to the canonical addressed form', () => {
  assert.deepEqual(parseLine(':color fable cyan'), {
    kind: 'targeted', target: 'fable', all: false, verb: 'color', color: 'cyan', force: false,
    verbFirst: ':fable color cyan',
  });
  assert.deepEqual(parseLine(':whisper fable check the vault'), {
    kind: 'targeted', target: 'fable', all: false, verb: 'whisper', text: 'check the vault', force: false,
    verbFirst: ':fable whisper check the vault',
  });
  // Bare attention verbs swap too; force rides the verb through the swap.
  assert.deepEqual(parseLine(':hold fable'), {
    kind: 'targeted', target: 'fable', all: false, verb: 'hold', force: false, verbFirst: ':fable hold',
  });
  assert.equal(parseLine(':color! fable cyan').force, true);
  assert.equal(parseLine(':color! fable cyan').verbFirst, ':fable color! cyan');
  // The echo teaches the canonical spelling: recolor normalizes to color (#278).
  assert.equal(parseLine(':recolor fable cyan').verbFirst, ':fable color cyan');
});

test('parser: a swap that does not parse to a complete act falls through to the usage error', () => {
  // Missing the color argument: the swapped form would be a color_needs_color, so
  // the line keeps answering exactly what it answered before the swap existed.
  assert.equal(parseLine(':color fable').code, 'verb_needs_target');
  assert.equal(parseLine(':whisper fable').code, 'verb_needs_target');
  assert.equal(parseLine(':install fable one two').code, 'verb_needs_target');
  // A token the handle alphabet refuses never swaps.
  assert.equal(parseLine(':color b@d cyan').code, 'verb_needs_target');
  // Mention-default untouched: a mention whose text starts with a non-verb word
  // stays a mention, and target-first parsing is byte-for-byte what it was.
  assert.equal(parseLine(':bunny colorful move').verb, 'mention');
  assert.equal(parseLine(':bunny whispering is rude').verb, 'mention');
  assert.equal(parseLine(':bunny nice move').verbFirst, undefined, 'target-first lines never carry the swap mark');
});

test('engine: the swap executes with the teaching echo when the handle is on the live roster', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine, calls } = await boundEngine();
  const events = await engine.execute(':color bunny cyan');
  assert.equal(events[0].type, 'info');
  assert.match(events[0].text, /Read as :bunny color cyan/);
  assert.match(events[1].text, /bunny now renders cyan/);
  const roster = await engine.execute(':list seats');
  assert.equal(roster[0].rows.find((r) => r.handle === 'bunny').color, 'cyan');

  // Stream verbs ride the swap too: the wire shape is the canonical act's.
  const whisper = await engine.execute(':whisper bunny check the vault');
  assert.match(whisper[0].text, /Read as :bunny whisper check the vault/);
  assert.deepEqual(JSON.parse(calls.posts.at(-1).body), {
    v: 1, kind: 'whisper', from: CHAIR_FROM, to: 'bunny', text: 'check the vault',
  });
});

test('engine: an unknown handle falls through to the verb_needs_target error, never a swap', async () => {
  const { engine, calls } = await boundEngine();
  const events = await engine.execute(':color nobody cyan');
  assert.equal(events[0].type, 'error');
  assert.match(events[0].text, /color addresses a seat/);
  assert.equal(calls.posts.length, 0, 'nothing executed on the fall-through');
});

// ─────────────── M. naming integrity batch (#284: mint hygiene, to warning, wire-true pass) ───────────────

test('sanitizeGuestName strips surrounding quotes and whitespace; interior quotes are content', () => {
  assert.equal(sanitizeGuestName("'coder'"), 'coder');
  assert.equal(sanitizeGuestName('  "coder"  '), 'coder');
  assert.equal(sanitizeGuestName('`coder`'), 'coder');
  assert.equal(sanitizeGuestName('"\'coder\'"'), 'coder', 'nested quoting strips all the way down');
  assert.equal(sanitizeGuestName("o'brien"), "o'brien", 'an interior quote is content');
  assert.equal(sanitizeGuestName('  The Tall Bard  '), 'The Tall Bard');
  assert.equal(sanitizeGuestName("''"), '', 'nothing left is the caller-refusal signal');
});

test(':seat strips quotes at mint, and an all-quote name is refused, not minted', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine, calls } = await boundEngine();
  const events = await engine.execute(":seat 'Coder'");
  assert.equal(events[0].type, 'pairing');
  assert.deepEqual(calls.mints, [{ endpointId: 'e1', guestName: 'Coder' }], 'the server never sees the quotes');

  const refused = await engine.execute(":seat ''");
  assert.equal(refused[0].type, 'error');
  assert.match(refused[0].text, /real name/);
  assert.equal(calls.mints.length, 1, 'nothing was minted for the empty husk');
});

test('a collision mint tells the truth: the pass carries the WIRE name, the chair learns the split', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine } = await boundEngine();
  // Bunny already holds a seat; a second Bunny binds bunny-2 at the console, but
  // the server assigned the name Bunny - the wire never carries the suffix.
  const events = await engine.execute(':seat Bunny');
  assert.equal(events[0].type, 'pairing');
  const pass = events[0].passLines.join('\n');
  assert.match(pass, /Your handle is bunny\./, 'the pass teaches the server-assigned wire name');
  // The schema digest left the pass with the slim ruling; the instructions block carries it generically.
  assert.match(pass, /console knows you as bunny-2/, 'the console-side suffix is named, not hidden');
  assert.match(pass, /read unfiltered/, 'the filter limitation is taught with the split');
  assert.match(events[0].chairLines.join('\n'), /wire name is bunny/, 'the chair learns the split at mint');
});

test('an uncollided mint carries no split warning: one name, no extra lines', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine } = await boundEngine();
  const events = await engine.execute(':seat The Quiet Scribe');
  const pass = events[0].passLines.join('\n');
  assert.match(pass, /Your handle is the-quiet-scribe/);
  assert.ok(!pass.includes('console knows you as'), 'no split, no warning');
  assert.ok(!events[0].chairLines.join('\n').includes('Careful'), 'no chair warning either');
});

// ─────────────── N. joining survivability (#288: pass reachability guidance) ───────────────

test('the boarding pass teaches the /whoami preflight before the code is spent', async () => {
  putChairIdentity(CHAIR_FROM);
  const room = fakeRoom();
  const host = fakeHost();
  const engine = new ConsoleEngine(room.api, host);
  await engine.execute(':set project foo');
  await engine.execute(':set endpoint room');
  const events = await engine.execute(':seat Bunny Guest');
  const pass = events.find((e) => e.type === 'pairing').passLines.join('\n');
  assert.match(pass, /GET http:\/\/127\.0\.0\.1:9999\/whoami/, 'the whoami URL derives from the room URL');
  assert.match(pass, /it answers without a session and spends nothing/);
  assert.match(pass, /ask your human/);

  // The standalone pass (no hosted room URL) keeps the generic form of the lesson.
  const bare = new ConsoleEngine(fakeRoom().api);
  await bare.execute(':set project foo');
  await bare.execute(':set endpoint room');
  const barePass = (await bare.execute(':seat Bunny Guest')).find((e) => e.type === 'pairing').passLines.join('\n');
  assert.match(barePass, /GET \/whoami on the seat server address/);
});

test('the post receipt warns when to matches nobody wire name, and stays quiet when it does', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine } = await boundEngine();
  await engine.execute(':seat Bunny'); // bunny-2 at the console, Bunny on the wire
  const missed = await engine.execute(':bunny-2 new orders');
  assert.match(missed[0].text, /Posted signed/);
  assert.match(missed[1].text, /matches no wire name/, 'the receipt carries the warning');
  assert.equal(missed[1].type, 'info', 'a warning, never a refusal');

  const reached = await engine.execute(':bunny carry on');
  assert.equal(reached.filter((e) => /matches no wire name/.test(e.text ?? '')).length, 0);
  // A pretty guest name reaches through its normalized form: no false warning.
  const pretty = await engine.execute(':the-tall-bard well done');
  assert.equal(pretty.filter((e) => /matches no wire name/.test(e.text ?? '')).length, 0);
  // all is the universal range, never a miss.
  const everyone = await engine.execute(':all hold');
  assert.equal(everyone.filter((e) => /matches no wire name/.test(e.text ?? '')).length, 0);
});
