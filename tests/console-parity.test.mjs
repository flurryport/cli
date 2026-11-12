// Room-verb parity (#499, built on Gene's word 2026-09-23): everything a room
// does, from the console. Gaps 1 to 16 of the continue brief's parts 3 and 4,
// engine side, driven through the parser and a fake RoomApi exactly like
// console.test.mjs. The nvim half (the arm) lives in nvim/tests/fp_arm.lua.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'fp-parity-home-'));
process.env.HOME = process.env.USERPROFILE;

const { parseLine, RESERVED_WORDS, REVIEW_VERDICTS } = await import('../dist/lib/console-parser.js');
const { ConsoleEngine, CHAIR_FROM, FP_VERBS } = await import('../dist/lib/console-engine.js');
const { putChairIdentity } = await import('../dist/lib/console-view-state.js');
const { helpListing, verbHelp } = await import('../dist/lib/console-messages.js');

putChairIdentity(CHAIR_FROM);

// ───────────────────────── parser ─────────────────────────

test('the parity heads parse (#499): for, none, sections, orient, canon, verify, receipts, pin, the verdicts', () => {
  assert.deepEqual(parseLine(':for tagline shorter please'), { kind: 'for', section: 'tagline', line: 'shorter please' });
  assert.deepEqual(parseLine(':for tagline :re abc123 shorter'), { kind: 'for', section: 'tagline', line: ':re abc123 shorter' });
  assert.equal(parseLine(':for tagline').code, 'for_usage');
  assert.equal(parseLine(':for').code, 'for_usage');
  assert.deepEqual(parseLine(':none'), { kind: 'none' });
  assert.deepEqual(parseLine(':sections'), { kind: 'sections' });
  assert.deepEqual(parseLine(':orient'), { kind: 'orient' });
  assert.deepEqual(parseLine(':canon'), { kind: 'canon' });
  assert.deepEqual(parseLine(':canon tagline'), { kind: 'canon', section: 'tagline' });
  assert.equal(parseLine(':canon a b').code, 'canon_usage');
  assert.deepEqual(parseLine(':verify'), { kind: 'verify' });
  assert.deepEqual(parseLine(':receipts'), { kind: 'receipts' });
  assert.deepEqual(parseLine(':receipts abc123'), { kind: 'receipts', token: 'abc123' });
  assert.deepEqual(parseLine(':pin abc123 tagline'), { kind: 'pin', token: 'abc123', section: 'tagline' });
  assert.deepEqual(parseLine(':pin abc123 tagline the recap'), { kind: 'pin', token: 'abc123', section: 'tagline', text: 'the recap' });
  assert.equal(parseLine(':pin abc123').code, 'pin_usage');
  for (const v of REVIEW_VERDICTS) {
    assert.deepEqual(parseLine(`:${v}`), { kind: 'review', verdict: v });
    assert.deepEqual(parseLine(`:${v} abc123 looks right`), { kind: 'review', verdict: v, token: 'abc123', text: 'looks right' });
    assert.deepEqual(parseLine(`:${v} help`), { kind: 'help', topic: v });
  }
  for (const w of ['for', 'none', 'sections', 'orient', 'canon', 'verify', 'receipts', 'pin', 'proceed', 'finding', 'resolved', 'satisfied']) {
    assert.ok(RESERVED_WORDS.has(w), `${w} is reserved`);
  }
  // Every new head has a help entry (gap 14's acceptance line).
  for (const w of ['for', 'none', 'sections', 'orient', 'canon', 'verify', 'receipts', 'pin', 'proceed', 'finding', 'resolved', 'satisfied']) {
    assert.ok(typeof verbHelp[w] === 'string' && verbHelp[w].length > 0, `:help ${w} explains it`);
  }
  const listing = helpListing.flatMap((g) => g.lines).join('\n');
  for (const w of [':sections', ':orient', ':canon', ':verify', ':receipts', ':pin', ':for', ':none', ':proceed', ':seat <handle> pass']) {
    assert.ok(listing.includes(w), `${w} is in the :help listing`);
  }
});

test(':seat and :set endpoint grow their forms (#499 gaps 15, 16)', () => {
  assert.deepEqual(parseLine(':seat Bunny!'), { kind: 'seat', guestName: 'Bunny', force: true });
  assert.deepEqual(parseLine(':seat Bunny'), { kind: 'seat', guestName: 'Bunny' });
  assert.deepEqual(parseLine(':seat bunny pass'), { kind: 'seat-pass', handle: 'bunny' });
  assert.deepEqual(parseLine(':set endpoint launch!'), { kind: 'set', what: 'endpoint', slug: 'launch', force: true });
  assert.deepEqual(parseLine(':set endpoint launch'), { kind: 'set', what: 'endpoint', slug: 'launch' });
});

test('the review family is registry-known (#499 gap 5): fp:review, fp:note, fp:open', () => {
  for (const v of ['fp:review', 'fp:note', 'fp:open']) assert.ok(FP_VERBS.has(v));
});

// ───────────────────────── engine harness ─────────────────────────

/**
 * Fake RoomApi: two projects; the room `ops/launch-kit` is UNSIGNED with a room
 * map (chair gene, host code, producers writer and reviewer) and a canon; the
 * room `foo/room` is signed with one seat and no map.
 */
function fakeRoom(opts = {}) {
  const calls = { posts: [], collections: [], adds: [], removes: [], revokes: [], mapWrites: [] };
  const seats = { e1: [
    { inviteId: 'inv-fable', ref: 'seat-r1', guestName: 'fable', status: 'accepted', expiresAt: '2026-09-24T00:00:00Z', createdAt: '2026-09-23T01:00:00Z' },
  ], e2: [] };
  const maps = {
    e1: null,
    e2: {
      sections: [{ handle: 'tagline', description: 'The one-liner.' }, { handle: 'maker-comment', description: 'The comment.' }],
      roster: [{ handle: 'gene', role: 'chair' }, { handle: 'code', role: 'host' }, { handle: 'writer', role: 'producer' }, { handle: 'reviewer', role: 'producer' }],
      orientationCaptureId: 'orient0001AA',
    },
  };
  let canonRows = [
    { sectionHandle: 'tagline', description: 'The one-liner.', recapText: 'Webhooks with receipts.', decisionCaptureId: 'rule0001AAAA', collateCaptureId: 'coll0001AAAA', ratifiedAt: '2026-09-22T10:00:00Z', collectionId: 'col-kit', superseded: false },
    { sectionHandle: 'maker-comment', description: 'The comment.', recapText: null, decisionCaptureId: null, collateCaptureId: null, ratifiedAt: null, collectionId: null, superseded: false },
  ];
  let captures = [];
  const waits = [];
  const api = {
    async listProjects() {
      return [{ id: 'p1', name: 'Foo', slug: 'foo', suspended: false }, { id: 'p2', name: 'Operations', slug: 'ops', suspended: false }];
    },
    async listEndpoints(projectId) {
      if (projectId === 'p1') return [{ id: 'e1', projectId: 'p1', name: 'Room', slug: 'room' }, { id: 'e3', projectId: 'p1', name: 'Launch notes', slug: 'notes' }];
      return [{ id: 'e2', projectId: 'p2', name: 'Launch kit', slug: 'launch-kit' }, { id: 'e4', projectId: 'p2', name: 'Room', slug: 'room' }];
    },
    async getEndpointDetail(projectId, endpointId) {
      return endpointId === 'e2'
        ? { slug: 'launch-kit', signingEnabled: false, signingHeader: null }
        : { slug: endpointId === 'e1' ? 'room' : endpointId === 'e3' ? 'notes' : 'room', signingEnabled: true, signingHeader: 'X-Flurry-Signature' };
    },
    async listSeats(endpointId) { return (seats[endpointId] ?? []).map((s) => ({ ...s })); },
    async mintSeat() { throw new Error('not in this suite'); },
    async revokeInvite(endpointId, inviteId) { calls.revokes.push({ endpointId, inviteId }); },
    async waitCaptures() { return waits.shift() ?? { rows: [], nextCursor: null, readAs: null }; },
    async listCaptures() { return { rows: [...captures], nextCursor: 'cur-0', readAs: 'owner' }; },
    hasSigningKey(endpointId) { return endpointId !== 'e2'; },
    async post(o) {
      calls.posts.push(o);
      return { httpStatus: 200, ok: true, durationMs: 1, sizeBytes: o.body.length, errorText: '', captureId: `cap-${calls.posts.length}`, executions: opts.executions ?? null, postDiff: null };
    },
    async getRoomMap(projectId, endpointId) {
      const m = maps[endpointId];
      if (!m) throw Object.assign(new Error('404'), { status: 404 });
      return m;
    },
    async setSections(projectId, endpointId, sections) {
      const m = maps[endpointId];
      if (!m) throw Object.assign(new Error('404'), { status: 404 });
      if (opts.mapWriteDenied) throw Object.assign(new Error('Request failed with status 404'), { status: 404 });
      calls.mapWrites.push({ endpointId, sections: sections.map((x) => x.handle) });
      m.sections = sections.map((x) => ({ ...x }));
    },
    async getCanon() { return { orientationCaptureId: 'orient0001AA', sections: canonRows }; },
    async getCaptureBody(endpointId, id) {
      return id === 'orient0001AA' ? JSON.stringify({ v: 1, kind: 'message', from: 'code', text: 'Rules:\nOne point per post.' }) : null;
    },
    async listExecutions(endpointId, id) {
      return id === 'cap-1' ? [{ id: 'x1', targetId: 'tgt-writer', status: 'Success', responseStatusCode: 200, durationMs: 829, createdAt: '2026-09-23T15:53:00Z' }] : [];
    },
    async listCollections() { return [{ id: 'col-kit', name: 'Launch kit', itemCount: 6 }]; },
    async createCollection(p, e, name, ids) { calls.collections.push({ name, ids }); return { id: 'col-new', name }; },
    async addToCollection(p, e, collectionId, ids) { calls.adds.push({ collectionId, ids }); return { addedCount: ids.length }; },
    async removeFromCollection(p, e, collectionId, ids) { calls.removes.push({ collectionId, ids }); return { removedCount: ids.length }; },
    _setCaptures(rows) { captures = rows; },
    _queueWait(rows) { waits.push({ rows, nextCursor: null, readAs: null }); },
    _setCanon(rows) { canonRows = rows; },
  };
  return { api, calls };
}

const wire = (o) => JSON.stringify({ v: 1, kind: 'message', ...o });
const row = (id, signerLabel, body, at = '2026-09-23T15:00:00Z') => ({ id, createdAt: at, signerLabel, body });
const lastBody = (calls) => JSON.parse(calls.posts.at(-1).body);
const bodies = (calls) => calls.posts.map((p) => JSON.parse(p.body));

async function launchKit(opts) {
  const room = fakeRoom(opts);
  const engine = new ConsoleEngine(room.api);
  const bind = await engine.execute(':set ops/launch-kit');
  await engine.pollFeed(); // prime from backfill; queued waits carry the live log
  return { engine, bind, ...room };
}

async function signedRoom() {
  const room = fakeRoom();
  const engine = new ConsoleEngine(room.api);
  await engine.execute(':set foo/room');
  await engine.pollFeed();
  return { engine, ...room };
}

// ───────────────────────── gap 15: :set endpoint by partial name ─────────────────────────

test(':set endpoint resolves across projects: exact elsewhere, unique prefix, substring, candidates, and ! (#499 gap 15)', async () => {
  const { api } = fakeRoom();
  const engine = new ConsoleEngine(api);
  await engine.execute(':set project foo');
  // Exact slug in ANOTHER project adopts that project.
  let events = await engine.execute(':set endpoint launch-kit');
  assert.match(events.map((e) => e.text ?? '').join('\n'), /Bound to ops\/launch-kit/);
  // A unique prefix of a slug or a NAME resolves.
  events = await engine.execute(':set endpoint laun');
  assert.match(events[0].text, /laun matches 2 rooms/, 'launch-kit and Launch notes both start with laun');
  assert.match(events.map((e) => e.text).join('\n'), /ops\/launch-kit  Launch kit/);
  assert.match(events.map((e) => e.text).join('\n'), /foo\/notes  Launch notes/);
  assert.ok(!events.some((e) => /Bound to/.test(e.text ?? '')), 'several candidates bind nothing');
  events = await engine.execute(':set endpoint laun!');
  assert.match(events[0].text, /laun matched ops\/launch-kit/, '! takes the first');
  assert.match(events.map((e) => e.text ?? '').join('\n'), /Bound to ops\/launch-kit/);
  // A substring when no prefix matches.
  events = await engine.execute(':set endpoint otes');
  assert.match(events.map((e) => e.text ?? '').join('\n'), /Bound to foo\/notes/);
  // Exact slug in the SET project still wins over a same-slug room elsewhere.
  await engine.execute(':set project ops');
  events = await engine.execute(':set endpoint room');
  assert.match(events.map((e) => e.text ?? '').join('\n'), /Bound to ops\/room/);
  // Nothing at all still names the scope searched.
  events = await engine.execute(':set endpoint zzz');
  assert.equal(events[0].type, 'error');
});

// ───────────────────────── gaps 1, 4, 8, 12: the room map ─────────────────────────

test('binding loads the room map: map-only handles ride the roster with their role; the byline is the map\'s chair (#499 gaps 4, 8)', async () => {
  const { engine, bind, calls } = await launchKit();
  assert.match(bind.map((e) => e.text ?? '').join('\n'), /Posting as gene, the chair handle/);
  const [roster] = await engine.execute(':list roster');
  assert.equal(roster.type, 'roster');
  const byHandle = Object.fromEntries(roster.rows.map((r) => [r.handle, r]));
  assert.deepEqual(Object.keys(byHandle), ['gene', 'code', 'writer', 'reviewer'], 'an unsigned room has no seats, so every row is a map handle');
  assert.equal(byHandle.writer.status, 'producer', 'the status word is the role');
  assert.equal(byHandle.writer.role, 'producer');
  assert.equal(byHandle.writer.live, false);
  assert.equal(byHandle.gene.role, 'chair');
  await engine.execute('hello room');
  assert.equal(lastBody(calls).from, 'gene', 'the chair posts under the map\'s chair handle');
});

test('a minted seat the map also names wears its role; a signed room without a map is unchanged', async () => {
  const { engine } = await signedRoom();
  const [roster] = await engine.execute(':list roster');
  assert.equal(roster.rows.length, 1);
  assert.equal(roster.rows[0].handle, 'fable');
  assert.equal(roster.rows[0].role, null);
});

test(':<handle> addresses a room-map handle, and on an unsigned room the name as typed (#499 gaps 1, 12)', async () => {
  const { engine, calls } = await launchKit();
  let events = await engine.execute(':writer draft the maker comment');
  assert.match(events[0].text, /Posted unsigned/);
  assert.equal(lastBody(calls).to, 'writer');
  assert.ok(!events.some((e) => /matches no wire name/.test(e.text ?? '')), 'a map handle is an address the room answers to');
  // Typed fallback: nobody by that name anywhere, the room is unsigned, so it rides as typed.
  events = await engine.execute(':claude-host are you there');
  assert.equal(lastBody(calls).to, 'claude-host');
  assert.ok(events.some((e) => /carries to: claude-host as typed/.test(e.text ?? '')), 'the receipt says the address was typed');
  // The other verbs still need a minted seat.
  events = await engine.execute(':writer hold');
  assert.equal(events[0].type, 'error');
});

test('on a SIGNED room a name that is neither a seat nor on the map is refused (#499 gap 12)', async () => {
  const { engine, calls } = await signedRoom();
  const events = await engine.execute(':nobody hello');
  assert.equal(events[0].type, 'error');
  assert.match(events[0].text, /No seat answers to nobody/);
  assert.equal(calls.posts.length, 0);
});

// ───────────────────────── gap 2: :for ─────────────────────────

test(':for <section> <line> files any line for a section; an unknown section is refused before sending (#499 gap 2)', async () => {
  const { engine, calls } = await launchKit();
  let events = await engine.execute(':for tagline :writer make it shorter');
  assert.equal(lastBody(calls).for, 'tagline');
  assert.equal(lastBody(calls).to, 'writer');
  assert.ok(events.some((e) => /Filed for tagline/.test(e.text ?? '')));
  await engine.execute(':for maker-comment plain room text');
  assert.equal(lastBody(calls).for, 'maker-comment');
  assert.equal(lastBody(calls).to, undefined);
  const before = calls.posts.length;
  events = await engine.execute(':for nowhere text');
  assert.equal(events[0].type, 'error');
  assert.match(events[0].text, /nowhere is not a section of this room \(tagline, maker-comment\)/);
  assert.equal(calls.posts.length, before, 'nothing was sent');
  // Without a published map any handle counts.
  const signed = await signedRoom();
  await signed.engine.execute(':for anything hello');
  assert.equal(lastBody(signed.calls).for, 'anything');
});

// ───────────────────────── gaps 9, 10: replies address the author ─────────────────────────

test(':re <ref> on ANY post carries re and addresses the author: the seat handle, else the wire from claim (#499 gaps 9, 10)', async () => {
  const { engine, api, calls } = await launchKit();
  api._queueWait([
    row('post0001AAAA', null, wire({ from: 'writer', for: 'tagline', text: 'draft two' })),
    row('post0002AAAA', 'owner', wire({ from: 'gene', text: 'noted' })),
  ]);
  const feed = await engine.pollFeed();
  const item = feed.find((e) => e.type === 'feed' && e.item.id === 'post0001AAAA').item;
  assert.equal(item.from, 'writer', 'the feed item carries the from claim for the frontend to arm');
  assert.equal(item.for, 'tagline', 'and the section');
  await engine.execute(':re post0001 tighter');
  let body = lastBody(calls);
  assert.equal(body.re, 'post0001AAAA');
  assert.equal(body.to, 'writer', 'the reply addresses the post\'s author');
  assert.equal(body.for, 'tagline', 'and keeps its section');
  // A reply to the chair's own post addresses nobody.
  await engine.execute(':re post0002 self note');
  body = lastBody(calls);
  assert.equal(body.re, 'post0002AAAA');
  assert.equal(body.to, undefined);
  // On a signed room the seat handle is the address, not the from claim.
  const signed = await signedRoom();
  signed.api._queueWait([row('seat0001AAAA', 'fable', wire({ from: 'somebody-else', text: 'hi' }))]);
  await signed.engine.pollFeed();
  await signed.engine.execute(':re seat0001 hello');
  assert.equal(lastBody(signed.calls).to, 'fable');
});

// ───────────────────────── gap 3: ratify carries for and to, and files the canon ─────────────────────────

test(':ratify carries the proposal\'s for and to, pins the ruling, and posts the r:collate receipt (#499 gap 3)', async () => {
  const { engine, api, calls } = await launchKit();
  api._queueWait([row('prop0001AAAA', null, wire({ from: 'writer', verb: 'fp:propose', for: 'tagline', summary: 'new tagline', text: 'Hands and receipts.' }))]);
  await engine.pollFeed();
  const events = await engine.execute(':ratify prop0001 the reading that stands');
  const posted = bodies(calls);
  assert.equal(posted.length, 2, 'the ruling, then the collate receipt');
  assert.equal(posted[0].verb, 'fp:ratify');
  assert.equal(posted[0].re, 'prop0001AAAA');
  assert.equal(posted[0].for, 'tagline');
  assert.equal(posted[0].to, 'writer');
  assert.deepEqual(calls.adds, [{ collectionId: 'col-kit', ids: ['prop0001AAAA'] }], 'pinned into the section\'s standing collection');
  assert.deepEqual(calls.removes, [{ collectionId: 'col-kit', ids: ['rule0001AAAA'] }], 'the previous standing item left it');
  assert.equal(posted[1].verb, 'r:collate');
  assert.equal(posted[1].to, 'canon');
  assert.equal(posted[1].for, 'tagline');
  assert.deepEqual(posted[1].args, ['tagline', 'col-kit', 'prop0001AAAA']);
  assert.equal(posted[1].re, 'prop0001AAAA');
  assert.equal(posted[1].text, 'the reading that stands', 'the chair\'s prose is the recap');
  const text = events.map((e) => e.text ?? '').join('\n');
  assert.match(text, /Ratified prop0001/);
  assert.match(text, /Pinned prop0001 as the standing item for tagline in Launch kit/);
  assert.match(text, /previous item rule0001 left/);
  assert.match(text, /Filed the r:collate receipt for tagline/);
});

test('a proposal with no section on a mapped room ratifies but files nothing, and says so; :pin files it (#499 gap 3)', async () => {
  const { engine, api, calls } = await launchKit();
  api._queueWait([row('prop0002AAAA', null, wire({ from: 'writer', verb: 'fp:propose', summary: 'unfiled', text: 'A comment.' }))]);
  await engine.pollFeed();
  let events = await engine.execute(':ratify prop0002');
  assert.equal(calls.posts.length, 1, 'only the ruling posted');
  assert.match(events.map((e) => e.text ?? '').join('\n'), /names no section, so nothing was filed.*:pin prop0002 <section>/);
  // :pin into a section with nothing standing: no previous item to remove, the
  // recap defaults to the post's summary.
  events = await engine.execute(':pin prop0002 maker-comment');
  const collate = lastBody(calls);
  assert.equal(collate.verb, 'r:collate');
  assert.equal(collate.for, 'maker-comment');
  assert.equal(collate.text, 'unfiled');
  assert.deepEqual(calls.adds.at(-1), { collectionId: 'col-kit', ids: ['prop0002AAAA'] }, 'the room canon collection, where other sections file, stands in when the section has none');
  assert.equal(calls.removes.length, 0);
  events = await engine.execute(':pin prop0002 nowhere');
  assert.equal(events[0].type, 'error');
});

test('when the canon names no ruling, the post a proposal re-links to leaves the collection (the rooms re convention, live 2026-09-23)', async () => {
  const { engine, api, calls } = await launchKit();
  api._setCanon([
    { sectionHandle: 'tagline', description: 'The one-liner.', recapText: null, decisionCaptureId: null, collateCaptureId: null, ratifiedAt: null, collectionId: null, superseded: false },
  ]);
  // The standing pin was never on this session's feed: the re rides verbatim.
  api._queueWait([row('prop0010AAAA', null, wire({ from: 'writer', verb: 'fp:propose', for: 'tagline', re: '6ZqiTI4Whbc2AxK4chTao4', summary: 'tighter', text: 'x' }))]);
  await engine.pollFeed();
  const events = await engine.execute(':ratify prop0010');
  assert.deepEqual(calls.adds.at(-1), { collectionId: 'col-kit', ids: ['prop0010AAAA'] });
  assert.deepEqual(calls.removes.at(-1), { collectionId: 'col-kit', ids: ['6ZqiTI4Whbc2AxK4chTao4'] }, 'the re-linked standing post left the collection');
  assert.ok(events.some((e) => /previous item 6ZqiTI4W left/.test(e.text ?? '')));
});

test('a room whose canon names no collection files into its ONLY collection, never a fresh one (live finding 2026-09-23)', async () => {
  const { engine, api, calls } = await launchKit();
  api._setCanon([
    { sectionHandle: 'tagline', description: 'The one-liner.', recapText: null, decisionCaptureId: null, collateCaptureId: null, ratifiedAt: null, collectionId: null, superseded: false },
  ]);
  api._queueWait([row('prop0009AAAA', null, wire({ from: 'writer', verb: 'fp:propose', for: 'tagline', summary: 'first filing', text: 'x' }))]);
  await engine.pollFeed();
  await engine.execute(':ratify prop0009');
  assert.equal(calls.collections.length, 0, 'no collection was created');
  assert.deepEqual(calls.adds.at(-1), { collectionId: 'col-kit', ids: ['prop0009AAAA'] }, "the room's only collection took the pin");
  assert.deepEqual(lastBody(calls).args, ['tagline', 'col-kit', 'prop0009AAAA']);
});

// ───────────────────────── gap 5: review verdicts ─────────────────────────

test('review verdicts post fp:review with a verdict, re-linked and addressed; the ledger shows the latest (#499 gap 5)', async () => {
  const { engine, api, calls } = await launchKit();
  api._queueWait([row('prop0003AAAA', null, wire({ from: 'writer', verb: 'fp:propose', for: 'tagline', summary: 'third', text: 'x' }))]);
  await engine.pollFeed();
  let events = await engine.execute(':proceed prop0003 ship it');
  const body = lastBody(calls);
  assert.equal(body.verb, 'fp:review');
  assert.equal(body.verdict, 'proceed');
  assert.equal(body.re, 'prop0003AAAA');
  assert.equal(body.to, 'writer');
  assert.equal(body.for, 'tagline');
  assert.equal(body.text, 'ship it');
  const ledger = events.find((e) => e.type === 'decisions');
  assert.ok(ledger, 'the ledger repaints');
  assert.equal(ledger.rows[0].state, 'needs-ratification', 'a review is not the gavel');
  assert.equal(ledger.rows[0].verdict, 'proceed');
  // Bare :hold <ref> is the review when the token is a post, never a seat.
  events = await engine.execute(':hold prop0003 wait for the sixth image');
  assert.equal(lastBody(calls).verdict, 'hold');
  assert.equal(events.find((e) => e.type === 'decisions').rows[0].verdict, 'hold');
  // The single pending proposal is the bare form's target.
  await engine.execute(':satisfied');
  assert.equal(lastBody(calls).re, 'prop0003AAAA');
  // Derived from the log too: fp:review with a verdict, and the r:proceed family.
  api._queueWait([
    row('revw0001AAAA', null, wire({ from: 'reviewer', verb: 'fp:review', verdict: 'finding', re: 'prop0003AAAA', text: 'one more' })),
  ]);
  let feed = await engine.pollFeed();
  assert.equal(feed.find((e) => e.type === 'decisions').rows[0].verdict, 'finding');
  const reviewItem = feed.find((e) => e.type === 'feed' && e.item.id === 'revw0001AAAA').item;
  assert.ok(!reviewItem.tags.some((t) => /unknown verb/.test(t)), 'fp:review renders as a known verb');
  api._queueWait([row('revw0002AAAA', null, wire({ from: 'reviewer', verb: 'r:resolved', re: 'prop0003', text: 'done' }))]);
  feed = await engine.pollFeed();
  assert.equal(feed.find((e) => e.type === 'decisions').rows[0].verdict, 'resolved');
});

// ───────────────────────── gap 4: the read side ─────────────────────────

test(':sections, :orient, and :canon read the room (#499 gap 4)', async () => {
  const { engine } = await launchKit();
  let [view] = await engine.execute(':sections');
  assert.equal(view.type, 'view');
  assert.equal(view.title, 'Sections:');
  let text = view.lines.join('\n');
  assert.match(text, /tagline  The one-liner\./);
  assert.match(text, /Room map roster:/);
  assert.match(text, /writer  producer/);

  [view] = await engine.execute(':orient');
  assert.equal(view.type, 'view');
  assert.match(view.title, /Orientation orient0001AA/);
  text = view.lines.join('\n');
  assert.match(text, /Rules:/);
  assert.match(text, /One point per post\./, 'the orientation text member, not the raw JSON');
  assert.match(text, /gene  chair/);

  [view] = await engine.execute(':canon');
  assert.equal(view.type, 'view');
  text = view.lines.join('\n');
  assert.match(text, /tagline  \[rule0001\]/);
  assert.match(text, /Webhooks with receipts\./);
  assert.match(text, /maker-comment  \(nothing ratified\)/);

  [view] = await engine.execute(':canon tagline');
  assert.match(view.lines.join('\n'), /Webhooks with receipts\./);
  const [err] = await engine.execute(':canon nowhere');
  assert.equal(err.type, 'error');
  assert.match(err.text, /No section nowhere here\. Sections: tagline, maker-comment/);

  // A room with no map says so instead of an empty view.
  const signed = await signedRoom();
  const [none] = await signed.engine.execute(':sections');
  assert.equal(none.type, 'info');
  assert.match(none.text, /publishes no section map/);
});

// ───────────────────────── gap 6: receipts and the chain ─────────────────────────

test('a post that fired a binding says so; :receipts lists deliveries; :verify reads attribution and the chain (#499 gap 6)', async () => {
  const { engine, api } = await launchKit({ executions: [{ executionId: 'x1', targetId: 'tgt-writer' }] });
  const posted = await engine.execute(':writer wake up');
  assert.ok(posted.some((e) => /One delivery fired off this post/.test(e.text ?? '')));
  let [view] = await engine.execute(':receipts');
  assert.equal(view.type, 'view', 'bare :receipts reads the last post made');
  assert.match(view.title, /Deliveries for cap-1/);
  assert.match(view.lines.join('\n'), /tgt-writer  Success  200  829ms/);
  // Before any post, :verify has nothing; after a feed, it counts by signer.
  api._queueWait([
    row('c1', 'owner', wire({ from: 'gene', text: 'a' })),
    row('c2', 'fable', wire({ from: 'fable', text: 'b' })),
    row('c3', null, wire({ from: 'writer', text: 'c' })),
  ]);
  await engine.pollFeed();
  [view] = await engine.execute(':verify');
  assert.equal(view.type, 'view');
  assert.match(view.lines.join('\n'), /3 posts this session: 1 signed by the owner, 1 by seats, 1 unsigned\./);
  assert.match(view.lines.join('\n'), /No prevHash chain/);
  // A chained log verifies through the same verifyChain the catalog tool runs.
  const { sha256Hex, canon } = await import('../dist/lib/hashchain.js');
  const e1 = { v: 1, kind: 'message', from: 'writer', text: 'one', prevHash: '' };
  const e2 = { v: 1, kind: 'message', from: 'writer', text: 'two', prevHash: sha256Hex(canon(e1)) };
  api._queueWait([row('h1', null, JSON.stringify(e1)), row('h2', null, JSON.stringify(e2))]);
  await engine.pollFeed();
  [view] = await engine.execute(':verify');
  assert.match(view.lines.join('\n'), /Hash chain intact across 2 chained posts/);
  api._queueWait([row('h3', null, JSON.stringify({ ...e2, text: 'forged', prevHash: 'nope' }))]);
  await engine.pollFeed();
  [view] = await engine.execute(':verify');
  assert.match(view.lines.join('\n'), /Hash chain BREAKS at chained post 2/);
});

test(':none only teaches from the engine: the arm lives in the editor', async () => {
  const { engine } = await launchKit();
  const [hint] = await engine.execute(':none');
  assert.equal(hint.type, 'info');
  assert.match(hint.text, /the arm lives in the editor/);
});

// ───────────────────────── gap 9: the console says where it IS ─────────────────────────

test('binding emits a room event, and clearing the bind emits an empty one (#499 gap 9)', async () => {
  const { api } = fakeRoom();
  const engine = new ConsoleEngine(api);
  await engine.execute(':set project foo');

  const bound = await engine.execute(':set endpoint launch-kit');
  const room = bound.find((e) => e.type === 'room');
  assert.ok(room, 'a bind must announce the room it bound');
  assert.equal(room.projectSlug, 'ops');
  assert.equal(room.endpointSlug, 'launch-kit');
  assert.ok(room.name !== undefined, 'the display name rides the event (null when the endpoint has none)');

  // Moving to another project drops the room; the frontend must be told, or a
  // stale room name outlives the bind that earned it.
  const cleared = await engine.execute(':set project foo');
  const empty = cleared.find((e) => e.type === 'room');
  assert.ok(empty, 'clearing the bind must announce the empty room');
  assert.equal(empty.projectSlug, null);
  assert.equal(empty.endpointSlug, null);
});

// ───────────────────────── gap 17: the chair writes the map ─────────────────────────

test(':sections opens, redescribes and closes a topic, and the map is sent WHOLE (#499 gap 17)', async () => {
  const { api, calls } = fakeRoom();
  const engine = new ConsoleEngine(api);
  await engine.execute(':set ops/launch-kit');

  // Bare :sections is the view it has always been - no write.
  await engine.execute(':sections');
  assert.equal(calls.mapWrites.length, 0, 'reading the map must not write it');

  // Open one. The whole map goes up, not a diff, or the server drops the rest.
  let events = await engine.execute(':sections reddit  Reddit launch posts: the post, the subreddit rules, what not to link.');
  assert.equal(calls.mapWrites.length, 1);
  assert.deepEqual(calls.mapWrites[0].sections, ['tagline', 'maker-comment', 'reddit'],
    'the existing sections must ride along with the new one');
  assert.match(events.map((e) => e.text ?? '').join(' '), /Section reddit is open/);

  // And the section is live for :for immediately, which is the whole point.
  const filed = await engine.execute(':for reddit draft a post for r/sideproject');
  assert.ok(!filed.some((e) => e.type === 'error'), 'the new section must accept a post at once');
  assert.equal(JSON.parse(calls.posts.at(-1).body).for, 'reddit');

  // Redescribing replaces the text, never duplicates the handle.
  events = await engine.execute(':sections reddit  Tighter rules now.');
  assert.match(events.map((e) => e.text ?? '').join(' '), /redescribed/);
  assert.deepEqual(calls.mapWrites.at(-1).sections, ['tagline', 'maker-comment', 'reddit']);

  // Close it, and the guard comes straight back.
  events = await engine.execute(':sections rm reddit');
  assert.match(events.map((e) => e.text ?? '').join(' '), /Section reddit is closed/);
  assert.deepEqual(calls.mapWrites.at(-1).sections, ['tagline', 'maker-comment']);
  const after = await engine.execute(':for reddit try again');
  assert.ok(after.some((e) => e.type === 'error'), 'a closed section refuses posts again');
});

test(':sections refuses what it cannot do: no room, unknown handle to close, and a seat token (#499 gap 17)', async () => {
  const unbound = new ConsoleEngine(fakeRoom().api);
  let events = await unbound.execute(':sections reddit  nope');
  assert.match(events.map((e) => e.text ?? '').join(' '), /not bound to a room yet/);

  const { api } = fakeRoom();
  const engine = new ConsoleEngine(api);
  await engine.execute(':set ops/launch-kit');
  events = await engine.execute(':sections rm nosuch');
  assert.match(events.map((e) => e.text ?? '').join(' '), /No section nosuch to close/);

  // The server is owner-only, so a seat's 404 must read as whose act it is.
  const denied = fakeRoom({ mapWriteDenied: true });
  const seatEngine = new ConsoleEngine(denied.api);
  await seatEngine.execute(':set ops/launch-kit');
  events = await seatEngine.execute(':sections reddit  Reddit posts.');
  assert.match(events.map((e) => e.text ?? '').join(' '), /Only the room owner can change the map/);
});

test('the read-only wall is said in the chair\'s terms, not the agent\'s (#499 gap 17)', async () => {
  const { helpListing } = await import('../dist/lib/console-messages.js');
  const { consoleMessages } = await import('../dist/lib/console-messages.js');
  const serverText =
    'This token is read-only. Write access is granted by the USER, never obtained by you: ' +
    'during recipe secret setup the setup page offers [Grant write access], or they can generate ' +
    'a read-write token under Settings > Access tokens. Ask them, then simply retry.';
  const said = consoleMessages.http403(serverText);
  assert.match(said, /read-only token/, 'the chair is told the console is read-only');
  assert.match(said, /flurryport login/, 'and the remedy they can actually take');
  assert.ok(!/Ask them/.test(said), 'never tell the chair to ask themselves');
  assert.ok(helpListing, 'help listing still builds');

  // An ordinary 403 keeps the server's detail; only the read-only wall is re-voiced.
  assert.match(consoleMessages.http403('Endpoint is suspended.'), /Endpoint is suspended\./);
});
