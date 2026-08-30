// Record control (#281/#282, gaveled 2026-08-17): the ratify family - proposals
// as explicit protocol objects, the pending queue as a VIEW over the log (G4),
// ratify/retract/re at the chair - driven through the parser and a fake RoomApi
// exactly like console.test.mjs. No network, no real profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated HOME before dist imports: console view state persists under
// ~/.flurryport, and a leaked real profile boots the CLI authed against PROD.
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'fp-record-home-'));
process.env.HOME = process.env.USERPROFILE;

const { parseLine, RESERVED_WORDS } = await import('../dist/lib/console-parser.js');
const { ConsoleEngine, CHAIR_FROM, FP_VERBS } = await import('../dist/lib/console-engine.js');
const { putChairIdentity } = await import('../dist/lib/console-view-state.js');

putChairIdentity(CHAIR_FROM);

// ───────────────────────── parser ─────────────────────────

test('the record heads parse: bare, token, token plus prose, help, and :re (#281)', () => {
  assert.deepEqual(parseLine(':ratify'), { kind: 'ratify' });
  assert.deepEqual(parseLine(':ratify fable'), { kind: 'ratify', token: 'fable' });
  assert.deepEqual(parseLine(':ratify prop0001 the reading that stands'), {
    kind: 'ratify', token: 'prop0001', text: 'the reading that stands',
  });
  assert.deepEqual(parseLine(':retract'), { kind: 'retract' });
  assert.deepEqual(parseLine(':retract prop0001'), { kind: 'retract', token: 'prop0001' });
  assert.deepEqual(parseLine(':re look at the second clause'), { kind: 're', text: 'look at the second clause' });
  assert.equal(parseLine(':re').code, 're_needs_text');
  assert.deepEqual(parseLine(':ratify help'), { kind: 'help', topic: 'ratify' });
  assert.deepEqual(parseLine(':retract help'), { kind: 'help', topic: 'retract' });
  assert.deepEqual(parseLine(':re help'), { kind: 'help', topic: 're' });
  for (const w of ['ratify', 'retract', 're']) {
    assert.ok(RESERVED_WORDS.has(w), `${w} is reserved: no seat can claim a record head`);
  }
});

test('the gaveled registry rows are present (#281): fp:propose, fp:ratify, fp:retract', () => {
  for (const v of ['fp:propose', 'fp:ratify', 'fp:retract']) {
    assert.ok(FP_VERBS.has(v), `${v} is in the closed registry`);
  }
});

// ───────────────────────── engine harness ─────────────────────────

/** Fake RoomApi: one project/endpoint, two live seats, scripted wait pages. */
function fakeRoom(backfillRows = []) {
  const calls = { posts: [] };
  const seats = [
    { inviteId: 'inv-fable', ref: 'seat-r1', guestName: 'fable', status: 'accepted', expiresAt: '2026-08-18T00:00:00Z', createdAt: '2026-08-17T01:00:00Z' },
    { inviteId: 'inv-codex', ref: 'seat-r2', guestName: 'codex', status: 'accepted', expiresAt: '2026-08-18T00:00:00Z', createdAt: '2026-08-17T02:00:00Z' },
  ];
  const waits = [];
  const api = {
    async listProjects() { return [{ id: 'p1', name: 'Foo', slug: 'foo', suspended: false }]; },
    async listEndpoints() { return [{ id: 'e1', projectId: 'p1', name: 'Room', slug: 'room' }]; },
    async getEndpointDetail() { return { slug: 'room', signingEnabled: true, signingHeader: 'X-Flurry-Signature' }; },
    async listSeats() { return seats.map((s) => ({ ...s })); },
    async revokeInvite() {},
    async waitCaptures() { return waits.shift() ?? { rows: [], nextCursor: null, readAs: null }; },
    async listCaptures() { return { rows: backfillRows, nextCursor: 'cur-0', readAs: 'owner' }; },
    hasSigningKey() { return true; },
    async post(opts) {
      calls.posts.push(opts);
      return { httpStatus: 200, ok: true, durationMs: 1, sizeBytes: opts.body.length, errorText: '', captureId: 'cap-post', executions: null };
    },
    _queueWait(rows) { waits.push({ rows, nextCursor: null, readAs: null }); },
  };
  return { api, calls };
}

async function boundEngine(backfillRows = []) {
  const room = fakeRoom(backfillRows);
  const engine = new ConsoleEngine(room.api);
  await engine.execute(':set foo/room');
  await engine.pollFeed(); // prime from backfill; waits carry the live log
  return { engine, ...room };
}

/** Feed one page of chronological wire rows through the long-poll path. */
async function feed(engine, api, rows) {
  api._queueWait(rows);
  return engine.pollFeed();
}

const wire = (o) => JSON.stringify({ v: 1, kind: 'message', ...o });
const propose = (id, from, summary, text) => ({
  id,
  createdAt: '2026-08-17T03:00:00Z',
  signerLabel: from,
  body: wire({ from, verb: 'fp:propose', ...(summary ? { summary } : {}), text }),
});
const disposition = (id, signerLabel, verb, re) => ({
  id,
  createdAt: '2026-08-17T04:00:00Z',
  signerLabel,
  body: wire({ from: signerLabel === 'owner' ? 'director' : signerLabel, verb, re }),
});
const lastBody = (calls) => JSON.parse(calls.posts.at(-1).body);

const P1 = 'prop0001AAAA';
const P2 = 'prop0002BBBB';
const P3 = 'prop0003CCCC';

// ───────────────────────── derivation + marks ─────────────────────────

test('a flagged post joins the pending queue and its feed line wears the mark', async () => {
  const { engine, api } = await boundEngine();
  const events = await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'the long argument')]);
  const item = events.find((e) => e.type === 'feed').item;
  assert.ok(item.tags.includes('needs ratification'), 'the pending mark rides the render-and-tag idiom');
});

test('a re-delivered proposal row wears its disposition mark, never pending again (cursor overlap)', async () => {
  const { engine, api, calls } = await boundEngine();
  await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'argument')]);
  await engine.execute(`:ratify ${P1}`);
  assert.equal(lastBody(calls).verb, 'fp:ratify');
  const again = await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'argument')]);
  const item = again.find((e) => e.type === 'feed').item;
  assert.ok(item.tags.includes('ratified'), 'the view over the log is idempotent');
});

test('a seat-signed ratify renders but cannot change the queue, ledger, or ledger version (#300)', async () => {
  const { engine, api } = await boundEngine();
  await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'argument')]);
  const events = await feed(engine, api, [disposition('fakeRuleAAAA', 'fable', 'fp:ratify', P1)]);
  assert.ok(events.some((e) => e.type === 'feed'), 'the non-binding disposition still renders as content');
  assert.ok(!events.some((e) => e.type === 'decisions'), 'the forged ruling does not bump the ledger version');

  const again = await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'argument')]);
  assert.ok(again.find((e) => e.type === 'feed').item.tags.includes('needs ratification'));
  const ledger = (await engine.execute(':list decisions')).find((e) => e.type === 'decisions');
  assert.equal(ledger.rows[0].state, 'needs-ratification');
  assert.equal(ledger.rows[0].ratifiedBy, null);

  const pending = await engine.execute(':ratify');
  assert.equal(pending[0].type, 'confirm', 'the proposal remains pending');
  await engine.execute('n');
});

test('chair ratify and retract disposition; seat retract cannot, and a forgery cannot seed ratify-again (#300)', async () => {
  const { engine, api } = await boundEngine();
  await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'argument')]);
  await feed(engine, api, [disposition('fakeRuleAAAA', 'fable', 'fp:ratify', P1)]);
  await feed(engine, api, [disposition('fakeRetractB', 'fable', 'fp:retract', P1)]);
  let ledger = (await engine.execute(':list decisions')).find((e) => e.type === 'decisions');
  assert.equal(ledger.rows[0].state, 'needs-ratification', 'a seat-signed retract changes nothing');

  await feed(engine, api, [disposition('chairRetract', 'owner', 'fp:retract', P1)]);
  ledger = (await engine.execute(':list decisions')).find((e) => e.type === 'decisions');
  assert.equal(ledger.rows[0].state, 'retracted', 'the chair signature still retracts');
  const bare = await engine.execute(':ratify');
  assert.match(bare[0].text, /no prior ratification/, 'a forged ratify never becomes ratify-again history');

  await feed(engine, api, [propose(P2, 'fable', 'ratify: the second gate opens', 'argument')]);
  await feed(engine, api, [disposition('chairRuleBBB', 'owner', 'fp:ratify', P2)]);
  ledger = (await engine.execute(':list decisions')).find((e) => e.type === 'decisions');
  assert.equal(ledger.rows[1].state, 'ratified', 'the chair signature still ratifies');
  assert.equal(ledger.rows[1].ratifiedBy, 'chairRul');
});

test('only a chair-signed strike marks a proposal struck (#300)', async () => {
  const { engine, api } = await boundEngine();
  const proposal = propose(P1, 'fable', 'ratify: the gate opens', 'argument');
  await feed(engine, api, [proposal]);
  await feed(engine, api, [disposition('fakeStrikeCC', 'fable', 'fp:strike', P1)]);
  let again = await feed(engine, api, [proposal]);
  assert.ok(!again.find((e) => e.type === 'feed').item.tags.includes('struck'), 'the target remains unmarked');
  let ledger = (await engine.execute(':list decisions')).find((e) => e.type === 'decisions');
  assert.equal(ledger.rows[0].state, 'needs-ratification', 'the target remains in the ledger');

  await feed(engine, api, [disposition('chairStrikeD', 'owner', 'fp:strike', P1)]);
  again = await feed(engine, api, [proposal]);
  assert.ok(again.find((e) => e.type === 'feed').item.tags.includes('struck'));
  ledger = (await engine.execute(':list decisions')).find((e) => e.type === 'decisions');
  assert.equal(ledger.rows[0].state, 'struck', 'the chair signature still strikes');
});

test('the first-page backfill also ignores seat-signed dispositions (#300)', async () => {
  const proposal = propose(P1, 'fable', 'ratify: the gate opens', 'argument');
  const forged = disposition('fakeRuleAAAA', 'fable', 'fp:ratify', P1);
  const { engine } = await boundEngine([forged, proposal]); // API page is newest-first.
  const ledger = (await engine.execute(':list decisions')).find((e) => e.type === 'decisions');
  assert.equal(ledger.rows[0].state, 'needs-ratification');
  assert.equal((await engine.execute(':ratify'))[0].type, 'confirm');
});

// ───────────────────────── bare :ratify (G1 points 4 + 5) ─────────────────────────

test('bare :ratify with items pending prompts y/N; y gavels them all, anything else cancels', async () => {
  const { engine, api, calls } = await boundEngine();
  await feed(engine, api, [
    propose(P1, 'fable', 'ratify: the gate opens', 'a'),
    propose(P2, 'codex', 'ratify: the closer goes echoless', 'b'),
  ]);
  const ask = await engine.execute(':ratify');
  assert.equal(ask[0].type, 'confirm');
  assert.match(ask[0].text, /2 pending decisions\? y\/N/);
  const cancelled = await engine.execute('nope');
  assert.match(cancelled[0].text, /Nothing ratified/);
  assert.equal(calls.posts.filter((p) => p.body.includes('fp:ratify')).length, 0);

  await engine.execute(':ratify');
  const done = await engine.execute('y');
  const rulings = calls.posts.map((p) => JSON.parse(p.body)).filter((b) => b.verb === 'fp:ratify');
  assert.deepEqual(rulings.map((b) => b.re), [P1, P2], 'one ruling per pending item, chronological');
  assert.ok(done.some((e) => e.type === 'info' && e.text.includes('Ratified prop0001')));
});

test('bare :ratify with nothing pending renews the previous ratification; with no history it teaches', async () => {
  const { engine, api, calls } = await boundEngine();
  const virgin = await engine.execute(':ratify');
  assert.match(virgin[0].text, /no prior ratification/);

  await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'a')]);
  await engine.execute(`:ratify ${P1} the first reading`);
  const renewed = await engine.execute(':ratify');
  const body = lastBody(calls);
  assert.equal(body.verb, 'fp:ratify');
  assert.equal(body.re, P1, 'ratify-again re-links the same proposal: it REPLACES');
  assert.ok(renewed.some((e) => e.type === 'info' && /again/.test(e.text)));
});

// ───────────────────────── :ratify <handle> (G2) and explicit refs ─────────────────────────

test(':ratify <handle> takes that seat\'s pending queue: one acts, several open the picker', async () => {
  const { engine, api, calls } = await boundEngine();
  await feed(engine, api, [
    propose(P1, 'fable', 'ratify: the gate opens', 'a'),
    propose(P2, 'codex', 'ratify: the closer goes echoless', 'b'),
    propose(P3, 'codex', 'ratify: cast swap stands', 'c'),
  ]);
  await engine.execute(':ratify fable');
  assert.equal(lastBody(calls).re, P1, 'exactly one pending from that seat: ratified outright');

  const ask = await engine.execute(':ratify codex');
  assert.equal(ask[0].type, 'ask');
  assert.match(ask[0].text, /Ratify which pending decision\?/);
  assert.match(ask[0].text, /1\. \[prop0002\] ratify: the closer goes echoless/);
  assert.match(ask[0].text, /2\. \[prop0003\] ratify: cast swap stands/);
  await engine.execute('2');
  assert.equal(lastBody(calls).re, P3, 'the numbered pick gavels the picked item');

  const none = await engine.execute(':ratify fable');
  assert.match(none[0].text, /No pending proposals from fable/);
});

test('an explicit reference gavels with prose riding, prefixes resolve, unknown refs are refused', async () => {
  const { engine, api, calls } = await boundEngine();
  await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'a')]);
  await engine.execute(':ratify prop0001 the reading that stands');
  const body = lastBody(calls);
  assert.equal(body.re, P1, 'the 8 character reference resolves like a short git hash');
  assert.equal(body.text, 'the reading that stands', 'chair prose scopes the matter');

  const bad = await engine.execute(':ratify zzzzzz99');
  assert.equal(bad[0].type, 'error');
  assert.match(bad[0].text, /matches no post/);
});

// ───────────────────────── :retract (G1 point 6) ─────────────────────────

test(':retract withdraws a pending proposal by reference; the queue empties without a ruling', async () => {
  const { engine, api, calls } = await boundEngine();
  await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'a')]);
  const done = await engine.execute(':retract prop0001');
  const body = lastBody(calls);
  assert.equal(body.verb, 'fp:retract');
  assert.equal(body.re, P1);
  assert.ok(done.some((e) => e.type === 'info' && /leaves the pending queue/.test(e.text)));
  const after = await engine.execute(':ratify');
  assert.match(after[0].text, /no prior ratification/, 'retracted, not ratified: nothing to renew');
});

test('retracting a ruling post nulls it by reference and its proposal is pending again', async () => {
  const { engine, api, calls } = await boundEngine();
  await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'a')]);
  // The ruling arrives ON THE LOG (the chair's own echo): the view derives it.
  await feed(engine, api, [{
    id: 'rule0001DDDD', createdAt: '2026-08-17T04:00:00Z', signerLabel: 'owner',
    body: wire({ from: 'director', verb: 'fp:ratify', re: P1 }),
  }]);
  const noneLeft = await engine.execute(':retract');
  assert.match(noneLeft[0].text, /Nothing is pending/, 'the log echo dispositioned the proposal');

  const nulled = await engine.execute(':retract rule0001');
  assert.equal(lastBody(calls).re, 'rule0001DDDD');
  assert.ok(nulled.some((e) => e.type === 'info' && /pending again/.test(e.text)));
  const ask = await engine.execute(':ratify');
  assert.equal(ask[0].type, 'confirm', 'the nulled ruling returned its proposal to the queue');
  assert.match(ask[0].text, /1 pending decision\? y\/N/);
  await engine.execute('n');
});

// ───────────────────────── :re (G1 point 7) ─────────────────────────

test(':re replies without disposition: a plain re-linked chair post, and the item stays pending', async () => {
  const { engine, api, calls } = await boundEngine();
  await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'a')]);
  const done = await engine.execute(':re look again at clause two');
  const body = lastBody(calls);
  assert.equal(body.re, P1);
  assert.equal(body.text, 'look again at clause two');
  assert.equal(body.verb, undefined, 'pure console sugar: no verb on the wire');
  assert.ok(done.some((e) => e.type === 'info' && /stays pending/.test(e.text)));
  const ask = await engine.execute(':ratify');
  assert.equal(ask[0].type, 'confirm', 'the reply left the item pending');
  await engine.execute('n');
});

test(':re with several pending opens the picker; a leading reference picks directly', async () => {
  const { engine, api, calls } = await boundEngine();
  await feed(engine, api, [
    propose(P1, 'fable', 'ratify: the gate opens', 'a'),
    propose(P2, 'codex', 'ratify: the closer goes echoless', 'b'),
  ]);
  const ask = await engine.execute(':re which of these two');
  assert.equal(ask[0].type, 'ask');
  assert.match(ask[0].text, /Reply to which pending proposal\?/);
  await engine.execute('1');
  let body = lastBody(calls);
  assert.equal(body.re, P1);
  assert.equal(body.text, 'which of these two');

  await engine.execute(':re prop0002 the second one then');
  body = lastBody(calls);
  assert.equal(body.re, P2, 'a leading token resolving to a pending proposal is an explicit pick');
  assert.equal(body.text, 'the second one then');

  const cancel = await engine.execute(':re still thinking');
  assert.equal(cancel[0].type, 'ask');
  const out = await engine.execute('x');
  assert.match(out[0].text, /Nothing picked/);
});

// ───────────────────────── previews + empty-queue teaching ─────────────────────────

test('a summary-less proposal previews its text in the picker (warned at the seat, never dropped)', async () => {
  const { engine, api } = await boundEngine();
  await feed(engine, api, [
    propose(P1, 'fable', null, 'use the text as the preview then'),
    propose(P2, 'codex', 'ratify: something else', 'b'),
  ]);
  const ask = await engine.execute(':re answering');
  assert.match(ask[0].text, /\[prop0001\] use the text as the preview then/);
  await engine.execute('');
});

test('empty-queue :retract and :re teach instead of acting', async () => {
  const { engine } = await boundEngine();
  const retract = await engine.execute(':retract');
  assert.match(retract[0].text, /Nothing is pending/);
  const re = await engine.execute(':re hello there');
  assert.match(re[0].text, /Nothing is pending to reply to/);
});

// ───────────────────────── scratch + strike (#282) ─────────────────────────

test('scratch parses: deliberate, short keystroke leaks, and reserved-word prose untouched (#282, #293)', () => {
  assert.deepEqual(parseLine(':scratch thinking aloud here'), { kind: 'scratch', text: 'thinking aloud here' });
  assert.equal(parseLine(':scratch').code, 'scratch_needs_text');
  // The keystroke leak: a bare line leading with a command-shaped word is
  // console input missing its colon, never a room order.
  assert.deepEqual(parseLine('color red'), { kind: 'scratch', text: 'color red', implied: true });
  assert.deepEqual(parseLine('color purple'), { kind: 'scratch', text: 'color purple', implied: true });
  assert.deepEqual(parseLine('y'), { kind: 'scratch', text: 'y', implied: true });
  assert.deepEqual(parseLine('N'), { kind: 'scratch', text: 'N', implied: true });
  assert.deepEqual(parseLine('yes'), { kind: 'scratch', text: 'yes', implied: true });
  assert.deepEqual(parseLine('no'), { kind: 'scratch', text: 'no', implied: true });
  assert.deepEqual(parseLine('help'), { kind: 'scratch', text: 'help', implied: true });
  // Bare prose is the ratified room post, untouched.
  assert.deepEqual(parseLine('nice work everyone'), { kind: 'say', text: 'nice work everyone' });
  assert.deepEqual(parseLine('Show me an example of proposed new agent instruction block'), {
    kind: 'say', text: 'Show me an example of proposed new agent instruction block',
  });
  assert.deepEqual(parseLine('delete everything we said about spacing'), {
    kind: 'say', text: 'delete everything we said about spacing',
  });
  assert.deepEqual(parseLine(':strike prop0001'), { kind: 'strike', token: 'prop0001' });
  assert.deepEqual(parseLine(':strike prop0001 said too much'), {
    kind: 'strike', token: 'prop0001', text: 'said too much',
  });
  assert.equal(parseLine(':strike').code, 'strike_needs_ref');
  assert.ok(FP_VERBS.has('fp:strike'), 'the strike verb rides the #282 gavel');
  for (const w of ['scratch', 'strike']) assert.ok(RESERVED_WORDS.has(w));
});

test('a scratch posts on the out-of-band kind; the leak catch teaches; the reader knows the kind (#282)', async () => {
  const { engine, api, calls } = await boundEngine();
  const leak = await engine.execute('color red');
  let body = lastBody(calls);
  assert.equal(body.kind, 'scratch');
  assert.equal(body.text, 'color red');
  assert.equal(body.to, undefined, 'scratch is never addressed');
  assert.ok(leak.some((e) => e.type === 'info' && /Read as scratch/.test(e.text)));

  await engine.execute(':scratch thinking aloud');
  body = lastBody(calls);
  assert.equal(body.kind, 'scratch');
  assert.equal(body.text, 'thinking aloud');

  const events = await feed(engine, api, [{
    id: 'scr00001AAAA', createdAt: '2026-08-17T05:00:00Z', signerLabel: 'owner',
    body: wire({ kind: 'scratch', from: 'director', text: 'ignore me, seats' }),
  }]);
  const item = events.find((e) => e.type === 'feed').item;
  assert.equal(item.channel, 'scratch');
  assert.deepEqual(item.tags, [], 'scratch is a known kind, never tagged unknown');
});

test(':strike unsays by reference: the wire re-links, redelivery wears the mark, unknown refs refuse (#282)', async () => {
  const { engine, api, calls } = await boundEngine();
  const row = {
    id: 'post0001AAAA', createdAt: '2026-08-17T05:00:00Z', signerLabel: 'fable',
    body: wire({ from: 'fable', text: 'the vault code is 1234' }),
  };
  await feed(engine, api, [row]);
  const done = await engine.execute(':strike post0001 said too much');
  const body = lastBody(calls);
  assert.equal(body.verb, 'fp:strike');
  assert.equal(body.re, 'post0001AAAA');
  assert.equal(body.text, 'said too much');
  assert.ok(done.some((e) => e.type === 'info' && /Struck post0001/.test(e.text)));

  const again = await feed(engine, api, [row]);
  assert.ok(again.find((e) => e.type === 'feed').item.tags.includes('struck'));

  const bad = await engine.execute(':strike zzzzzz99');
  assert.equal(bad[0].type, 'error', 'a strike must reference the record');
});

test('a struck proposal leaves the queue entirely; a strike arriving on the log derives the same (#282)', async () => {
  const { engine, api } = await boundEngine();
  await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'a')]);
  await engine.execute(':strike prop0001');
  const after = await engine.execute(':ratify');
  assert.match(after[0].text, /no prior ratification/, 'the flag was unsaid, not dispositioned');

  await feed(engine, api, [propose(P2, 'codex', 'ratify: something else', 'b')]);
  await feed(engine, api, [{
    id: 'strk0001AAAA', createdAt: '2026-08-17T06:00:00Z', signerLabel: 'owner',
    body: wire({ from: 'director', verb: 'fp:strike', re: P2 }),
  }]);
  const bare = await engine.execute(':ratify');
  assert.match(bare[0].text, /no prior ratification/, 'the log-derived strike emptied the queue');
});

// ───────────────────────── the decision ledger (#295) ─────────────────────────

const P4 = 'prop0004EEEE';

test(':list decisions parses, singular included; the ledger needs a room', async () => {
  assert.deepEqual(parseLine(':list decisions'), { kind: 'list', what: 'decisions' });
  assert.deepEqual(parseLine(':list decision'), { kind: 'list', what: 'decisions' });
  const room = fakeRoom();
  const engine = new ConsoleEngine(room.api);
  const unbound = await engine.execute(':list decisions');
  assert.equal(unbound[0].type, 'error');
});

test('an empty ledger teaches; the listing never stores beside the log (G4)', async () => {
  const { engine } = await boundEngine();
  const empty = await engine.execute(':list decisions');
  assert.equal(empty[0].type, 'info');
  assert.match(empty[0].text, /Nothing on the record yet/);
});

test('the ledger lists EVERY proposal ever flagged, chronological, all four states (#295)', async () => {
  const { engine, api } = await boundEngine();
  await feed(engine, api, [
    propose(P1, 'fable', 'open the gate at dawn tomorrow morning sharp', 'a'),
    propose(P2, 'codex', 'ratify: the closer goes echoless', 'b'),
    propose(P3, 'codex', 'ratify: cast swap stands', 'c'),
    propose(P4, 'fable', 'ratify: one more for the queue', 'd'),
  ]);
  // The ruling arrives ON THE LOG so the ledger can name the ratifying post.
  await feed(engine, api, [{
    id: 'rule0001DDDD', createdAt: '2026-08-17T04:00:00Z', signerLabel: 'owner',
    body: wire({ from: 'director', verb: 'fp:ratify', re: P1 }),
  }]);
  await engine.execute(`:retract ${P2}`);
  await engine.execute(`:strike ${P3}`);

  const events = await engine.execute(':list decisions');
  const ledger = events.find((e) => e.type === 'decisions');
  assert.ok(ledger, 'the listing is a decisions event, the shape both frontends render');
  assert.deepEqual(ledger.rows.map((r) => r.ref), ['prop0001', 'prop0002', 'prop0003', 'prop0004'],
    'chronological, one row each, struck included: every proposal ever flagged');
  assert.deepEqual(ledger.rows.map((r) => r.state),
    ['ratified', 'retracted', 'struck', 'needs-ratification']);
  assert.equal(ledger.rows[0].ratifiedBy, 'rule0001', 'a ratified row may name the ratifying post');
  assert.equal(ledger.rows[3].ratifiedBy, null);
  assert.equal(ledger.rows[0].summary, 'open the gate at dawn tomorrow morning sharp');
  assert.equal(ledger.rows[0].id, P1, 'the full id rides for threads and re-links');
});

test('the ledger repaints live: acts and backfill emit a decisions event, quiet polls do not (#295/#279)', async () => {
  const { engine, api } = await boundEngine();
  const flagged = await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'a')]);
  assert.ok(flagged.some((e) => e.type === 'decisions'), 'a backfilled flag repaints the ledger');
  const quiet = await feed(engine, api, [{
    id: 'talk0001AAAA', createdAt: '2026-08-17T05:00:00Z', signerLabel: 'fable',
    body: wire({ from: 'fable', text: 'nothing for the record here' }),
  }]);
  assert.ok(!quiet.some((e) => e.type === 'decisions'), 'plain talk never repaints the ledger');
  const ruled = await engine.execute(`:ratify ${P1}`);
  assert.ok(ruled.some((e) => e.type === 'decisions'), 'the console act repaints immediately');
  const struck = await engine.execute(`:strike ${P1}`);
  assert.ok(struck.some((e) => e.type === 'decisions'), 'so does a strike');
});

test('a fresh bind resets every panel: the bind events carry an empty ledger (#295)', async () => {
  const { engine, api } = await boundEngine();
  await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'a')]);
  const rebound = await engine.execute(':set foo/room');
  const ledger = rebound.find((e) => e.type === 'decisions');
  assert.ok(ledger, 'binding says the ledger out loud');
  assert.equal(ledger.rows.length, 0, 'nothing survives the rebind: room state died with the room');
});

test(':re <ref> reaches ANY ledger decision - the armed panel target - and the receipt stays honest (#295)', async () => {
  const { engine, api, calls } = await boundEngine();
  await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'a')]);
  await feed(engine, api, [{
    id: 'rule0001DDDD', createdAt: '2026-08-17T04:00:00Z', signerLabel: 'owner',
    body: wire({ from: 'director', verb: 'fp:ratify', re: P1 }),
  }]);
  const done = await engine.execute(':re prop0001 revisiting the dawn clause');
  const body = lastBody(calls);
  assert.equal(body.re, P1, 'the ratified decision took the reply by reference');
  assert.equal(body.text, 'revisiting the dawn clause');
  assert.equal(body.verb, undefined, 'still pure console sugar');
  assert.ok(done.some((e) => e.type === 'info' && /keeps its state/.test(e.text)),
    'a dispositioned decision never claims to be pending');
  assert.ok(!done.some((e) => e.type === 'info' && /stays pending/.test(e.text)));
});

test('the console renders the ledger rows in the picker idiom (#295)', async () => {
  const { renderEvent } = await import('../dist/commands/console-render.js');
  const { engine, api } = await boundEngine();
  await feed(engine, api, [
    propose(P1, 'fable', 'ratify: the gate opens', 'a'),
    propose(P2, 'codex', 'ratify: the closer goes echoless', 'b'),
  ]);
  await engine.execute(`:strike ${P2}`);
  const events = await engine.execute(':list decisions');
  const lines = renderEvent(events.find((e) => e.type === 'decisions'), 80);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[prop0001\]/);
  assert.match(lines[0], /needs-ratification/);
  assert.match(lines[0], /ratify: the gate opens/);
  assert.match(lines[1], /\[prop0002\]/);
  assert.match(lines[1], /struck/);
});

// ───────────────────────── the word gavel (#295: the word is the gavel) ─────────────────────────

test('a reply of exactly one ratify-word performs the act, case-insensitive (#295)', async () => {
  const { engine, api, calls } = await boundEngine();
  await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'a')]);
  const done = await engine.execute(`:re ${P1} Ratified`);
  const body = lastBody(calls);
  assert.equal(body.verb, 'fp:ratify', 'the exact word performed the ratify act');
  assert.equal(body.re, P1);
  assert.equal(body.text, undefined, 'the word was the gavel, never prose on the wire');
  assert.ok(done.some((e) => e.type === 'info' && /Read as the gavel/.test(e.text)),
    'the teaching echo names what happened');
  assert.ok(done.some((e) => e.type === 'info' && /Ratified prop0001/.test(e.text)));
  const renewed = await engine.execute(':ratify');
  assert.equal(lastBody(calls).re, P1, 'the ruling stood: bare :ratify renews it');
  assert.ok(renewed.some((e) => e.type === 'info' && /again/.test(e.text)));
});

test('the bare-word gavel reaches a single pending item through :re too (#295)', async () => {
  const { engine, api, calls } = await boundEngine();
  await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'a')]);
  await engine.execute(':re ratify');
  const body = lastBody(calls);
  assert.equal(body.verb, 'fp:ratify', 'every :re route funnels through the same gavel check');
  assert.equal(body.re, P1);
});

test('any additional words stay a plain discussion reply: the strict guard (#295)', async () => {
  const { engine, api, calls } = await boundEngine();
  await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'a')]);
  const done = await engine.execute(`:re ${P1} Ratified, and also tighten clause two`);
  const body = lastBody(calls);
  assert.equal(body.verb, undefined, 'a sentence is discussion, never a gavel');
  assert.equal(body.text, 'Ratified, and also tighten clause two');
  assert.ok(done.some((e) => e.type === 'info' && /stays pending/.test(e.text)));
  assert.ok(!done.some((e) => e.type === 'info' && /Read as the gavel/.test(e.text)));
  const ask = await engine.execute(':ratify');
  assert.equal(ask[0].type, 'confirm', 'the item is still pending');
  await engine.execute('n');
});

test('the retract-word nulls the referenced proposal the same way (#295)', async () => {
  const { engine, api, calls } = await boundEngine();
  await feed(engine, api, [propose(P1, 'fable', 'ratify: the gate opens', 'a')]);
  const done = await engine.execute(`:re ${P1} retracted`);
  const body = lastBody(calls);
  assert.equal(body.verb, 'fp:retract');
  assert.equal(body.re, P1);
  assert.equal(body.text, undefined);
  assert.ok(done.some((e) => e.type === 'info' && /Read as the gavel/.test(e.text)));
  assert.ok(done.some((e) => e.type === 'info' && /leaves the pending queue/.test(e.text)));
  const after = await engine.execute(':retract');
  assert.match(after[0].text, /Nothing is pending/, 'the word withdrew the proposal');
});

test('the console meta line marks a scratch row (#282)', async () => {
  const { renderEvent } = await import('../dist/commands/console-render.js');
  const { engine, api } = await boundEngine();
  const events = await feed(engine, api, [{
    id: 'scr00002BBBB', createdAt: '2026-08-17T05:00:00Z', signerLabel: 'owner',
    body: wire({ kind: 'scratch', from: 'director', text: 'out loud, out of band' }),
  }]);
  const lines = renderEvent(events.find((e) => e.type === 'feed'), 80);
  assert.match(lines[0], /\(scratch\)/);
});
