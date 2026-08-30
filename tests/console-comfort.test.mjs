// Console comfort regression net (0.5.1 slice D): the feed spec (two-line rows,
// wrap on full words, byline dedup, [time] [id] [actor]), the :create born-signed
// verbs (#242), the :me identity family (#247), :collection/:tag curation (#251),
// the capability-aware palette, and the #245 friendly-errors map. Engine driven
// through a fake RoomApi; the renderer tested pure with chalk forced colorless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated HOME before dist imports: console view state persists under
// ~/.flurryport, and a leaked real profile boots the CLI authed against PROD.
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'fp-console-comfort-home-'));
process.env.HOME = process.env.USERPROFILE;

const chalk = (await import('chalk')).default;
chalk.level = 0; // plain strings: renderer assertions read text, not ANSI

const { parseLine } = await import('../dist/lib/console-parser.js');
const { ConsoleEngine, CHAIR_FROM } = await import('../dist/lib/console-engine.js');
const {
  CONSOLE_COLORS,
  ALL_CONSOLE_COLORS,
  EXTENDED_COLORS,
  getChairProfile,
  putChairProfile,
  putChairIdentity,
} = await import('../dist/lib/console-view-state.js');
const { wrapText, renderEvent, supportedPalette, effectiveColor, feedTime, FEED_INDENT } = await import(
  '../dist/commands/console-render.js'
);
const { consoleMessages: msg } = await import('../dist/lib/console-messages.js');
const { AuthApiError } = await import('../dist/lib/auth-api.js');
const { createRoomApi } = await import('../dist/lib/console-room.js');
const { friendlyFetchError } = await import('../dist/lib/fetch-error.js');

putChairIdentity(CHAIR_FROM);

/** Fake RoomApi with the slice-D write surface: creates, signing, collections. */
function fakeRoom() {
  const calls = { posts: [], mints: [], revokes: [], creates: [], signings: [], collectionCreates: [], collectionAdds: [] };
  const seats = [
    { inviteId: 'inv-bunny', ref: 'seat-r1', guestName: 'Bunny', status: 'accepted', expiresAt: '2026-08-15T00:00:00Z', createdAt: '2026-08-14T01:00:00Z' },
    { inviteId: 'inv-bard', ref: 'seat-r2', guestName: 'The Tall Bard', status: 'accepted', expiresAt: '2026-08-15T00:00:00Z', createdAt: '2026-08-14T02:00:00Z' },
    { inviteId: 'inv-fable', ref: 'seat-r3', guestName: 'fable', status: 'accepted', expiresAt: '2026-08-15T00:00:00Z', createdAt: '2026-08-14T03:00:00Z' },
  ];
  let captures = [];
  const collections = []; // { id, name, itemCount }
  const api = {
    async listProjects() {
      return [{ id: 'p1', name: 'Foo', slug: 'foo', suspended: false }];
    },
    async listEndpoints(projectId) {
      return projectId === 'p1' ? [{ id: 'e1', projectId: 'p1', name: 'Room', slug: 'room' }] : [];
    },
    async createEndpoint(projectId, name, slug) {
      calls.creates.push({ projectId, name, slug });
      return { id: `ep-${slug}`, slug, captureUrlPath: `/api/v1/capture/${projectId}/${slug}` };
    },
    async enableSigning(projectId, endpointId) {
      calls.signings.push({ projectId, endpointId });
      return { header: 'X-Flurry-Signature' };
    },
    async listCollections() {
      return collections.map((c) => ({ ...c }));
    },
    async createCollection(projectId, endpointId, name, captureIds) {
      calls.collectionCreates.push({ projectId, endpointId, name, captureIds });
      const row = { id: `col-${collections.length + 1}`, name, itemCount: captureIds.length };
      collections.push(row);
      return { id: row.id, name: row.name };
    },
    async addToCollection(projectId, endpointId, collectionId, captureIds) {
      calls.collectionAdds.push({ projectId, endpointId, collectionId, captureIds });
      const row = collections.find((c) => c.id === collectionId);
      if (row) row.itemCount += captureIds.length;
      return { addedCount: captureIds.length };
    },
    async getEndpointDetail() {
      return { slug: 'room', signingEnabled: true, signingHeader: 'X-Flurry-Signature' };
    },
    async listSeats(endpointId) {
      return endpointId === 'e1' ? seats.map((s) => ({ ...s })) : [];
    },
    async mintSeat(endpointId, guestName) {
      calls.mints.push({ endpointId, guestName });
      return {
        pairingCode: '7WHM-KR4P-XT2B', ref: 'seat-r9', participantName: guestName,
        expiresAt: '2026-08-15T00:00:00Z', codeExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
    },
    async revokeInvite(endpointId, inviteId) {
      calls.revokes.push({ endpointId, inviteId });
    },
    async waitCaptures() {
      return { rows: [], nextCursor: null, readAs: null };
    },
    async listCaptures() {
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
    _collections: collections,
  };
  return { api, calls };
}

async function boundEngine(opts = {}) {
  const room = fakeRoom();
  const engine = new ConsoleEngine(room.api, null, opts);
  await engine.execute(':set project foo');
  await engine.execute(':set endpoint room');
  return { engine, ...room };
}

// ───────────────────────── A. wrap on full words ─────────────────────────

test('wrapText breaks on whitespace at the measured width, never inside a word', () => {
  assert.deepEqual(wrapText('the quick brown fox jumps', 10), ['the quick', 'brown fox', 'jumps']);
  // A word that fits exactly stays whole.
  assert.deepEqual(wrapText('abcdefghij xy', 10), ['abcdefghij', 'xy']);
  // Width wider than the text: one line.
  assert.deepEqual(wrapText('short line', 80), ['short line']);
  // Runs of spaces collapse (words, not columns).
  assert.deepEqual(wrapText('a    b', 10), ['a b']);
});

test('unbreakable tokens longer than the width hard-break as the fallback', () => {
  assert.deepEqual(wrapText('xxxxxxxxxxxx', 5), ['xxxxx', 'xxxxx', 'xx']);
  // A long token mid-sentence flushes the current line first, then chunks.
  assert.deepEqual(wrapText('see https://example.invalid/very/long ok', 12), [
    'see', 'https://exam', 'ple.invalid/', 'very/long ok',
  ]);
});

test('embedded newlines are paragraph breaks: multi-line bodies come free', () => {
  assert.deepEqual(wrapText('line one\nline two', 20), ['line one', 'line two']);
  assert.deepEqual(wrapText('a\n\nb', 20), ['a', '', 'b']);
});

// ───────────────────────── B. two-line rows (the feed spec) ─────────────────────────

function feedItem(overrides = {}) {
  return {
    type: 'feed',
    item: {
      at: '2026-08-14T03:00:00Z', id: 'c1a2b3', byline: 'Bunny (bunny)', color: null,
      channel: 'room', to: null, text: 'hello there', mine: false,
      verb: null, re: null, panic: false, status: null, tags: [],
      ...overrides,
    },
  };
}

test('every feed row renders two-line: meta [time] [id] [actor] first, the message indented below', () => {
  const lines = renderEvent(feedItem(), 80);
  assert.equal(lines.length, 2);
  // Meta line: time, id, actor - and never the message text.
  assert.match(lines[0], /\d\d:\d\d:\d\d c1a2b3 Bunny \(bunny\)/);
  assert.ok(!lines[0].includes('hello there'), 'the message never rides the meta line');
  assert.equal(lines[1], `${FEED_INDENT}hello there`);
});

test('continuations align under the MESSAGE indent (hanging indent), and long tokens hard-break', () => {
  const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
  const width = 30;
  const lines = renderEvent(feedItem({ text }), width);
  assert.ok(lines.length > 2, 'the message wrapped');
  for (const l of lines.slice(1)) {
    assert.ok(l.startsWith(FEED_INDENT), `continuation "${l}" aligns under the message indent`);
    assert.ok(l.length <= width, `wrapped line "${l}" fits the width`);
  }
  // Reassembled, nothing was lost.
  assert.equal(lines.slice(1).map((l) => l.trim()).join(' '), text);
  // The hard-break fallback rides the same path.
  const hard = renderEvent(feedItem({ text: 'x'.repeat(60) }), 30);
  assert.ok(hard.slice(1).every((l) => l.length <= 30));
  assert.equal(hard.slice(1).map((l) => l.trim()).join(''), 'x'.repeat(60));
});

test('a verb act renders verb meta on the meta line; a bare act is meta only; whisper and tags stay meta-side', () => {
  const order = renderEvent(feedItem({ verb: { raw: 'fp:install', display: 'install', recipe: false, args: ['slack-post'] }, text: 'take this one' }), 80);
  assert.equal(order.length, 2);
  assert.match(order[0], /install slack-post/);
  assert.equal(order[1], `${FEED_INDENT}take this one`);
  // Bare verb act (a hold, an ack): one meta line, no message line.
  const bare = renderEvent(feedItem({ verb: { raw: 'fp:hold', display: 'hold', recipe: false, args: [] }, text: '' }), 80);
  assert.equal(bare.length, 1);
  // Channel marker and render-and-tag notes ride the meta line.
  const whisper = renderEvent(feedItem({ channel: 'whisper', to: 'director', tags: ['schema v2'] }), 80);
  assert.match(whisper[0], /whispers to director/);
  assert.match(whisper[0], /\[schema v2\]/);
  assert.equal(whisper[1], `${FEED_INDENT}hello there`);
});

test('the status ticker renders one dim line; pure transitions are the whole row; repeats collapse (#280)', () => {
  const ticker = (over = {}) => ({ state: 'working', detail: null, pure: true, repeated: false, ...over });
  // A pure fp:status transition: ONE line - time, id, byline, state, detail.
  const pure = renderEvent(
    feedItem({
      text: '',
      verb: { raw: 'fp:status', display: 'status', recipe: false, args: [] },
      status: { state: 'working', reason: 'compiling' },
      statusTicker: ticker({ detail: 'compiling' }),
    }),
    80,
  );
  assert.equal(pure.length, 1);
  assert.match(pure[0], /c1a2b3 Bunny \(bunny\) working: compiling/);
  chalk.level = 1;
  const blocked = renderEvent(
    feedItem({
      text: '',
      status: { state: 'blocked-on-human', reason: 'permission needed' },
      statusTicker: ticker({ state: 'blocked-on-human', detail: 'permission needed' }),
    }),
    80,
  );
  chalk.level = 0;
  assert.match(blocked[0], /\x1b\[31m/, 'blocked-on-human rings in terminal red');
  // A repeated pure transition collapses to nothing at all.
  assert.deepEqual(renderEvent(feedItem({ text: '', statusTicker: ticker({ repeated: true }) }), 80), []);
  // Riding a content post: meta + body + the one-liner replacing the stanza dump.
  const riding = renderEvent(
    feedItem({
      status: { state: 'review', reason: 'diff up', tests: '12/12' },
      statusTicker: ticker({ state: 'review', detail: 'diff up', pure: false }),
    }),
    80,
  );
  assert.equal(riding.length, 3);
  assert.equal(riding[1], `${FEED_INDENT}hello there`);
  assert.equal(riding[2], `${FEED_INDENT}${FEED_INDENT}review: diff up`);
  // A repeat on a content post drops only the ticker line; the message stays.
  const repeatRiding = renderEvent(feedItem({ statusTicker: ticker({ pure: false, repeated: true }) }), 80);
  assert.equal(repeatRiding.length, 2);
  // No protocol state, no ticker: the generic key: value stanza stands untouched.
  const generic = renderEvent(feedItem({ status: { task: 'warming up' } }), 80);
  assert.equal(generic[2], `${FEED_INDENT}${FEED_INDENT}task: warming up`);
});

test('the raw channel is two-line too, and the re mark rides the meta line', () => {
  const raw = renderEvent(feedItem({ channel: 'raw', text: 'not json at all', re: '7VCvNe' }), 80);
  assert.equal(raw.length, 2);
  assert.match(raw[0], /\[re 7VCvNe\]/);
  assert.equal(raw[1], `${FEED_INDENT}not json at all`);
});

// ───────────────── C. byline dedup + [id] off the engine ─────────────────

test('the feed byline renders GuestName (handle) only when they differ; fable (fable) is fable', async () => {
  putChairIdentity(CHAIR_FROM);
  putChairProfile({ name: '', color: '' });
  const { engine, api } = await boundEngine();
  api._setCaptures([
    // newest-first, as the server pages
    { id: 'c3', createdAt: '2026-08-14T03:00:00Z', signerLabel: 'fable', body: JSON.stringify({ v: 1, kind: 'message', from: 'fable', text: 'parser is mine' }), contentType: 'application/json' },
    { id: 'c2', createdAt: '2026-08-14T02:30:00Z', signerLabel: 'The Tall Bard', body: JSON.stringify({ v: 1, kind: 'message', from: 'the-tall-bard', text: 'hi' }), contentType: 'application/json' },
    { id: 'c1', createdAt: '2026-08-14T02:00:00Z', signerLabel: 'owner', body: JSON.stringify({ v: 1, kind: 'message', from: 'director', text: 'welcome' }), contentType: 'application/json' },
  ]);
  const feed = (await engine.pollFeed(1)).filter((e) => e.type === 'feed');
  assert.equal(feed.length, 3);
  assert.equal(feed[0].item.byline, CHAIR_FROM, 'the chair renders its byline alone');
  assert.equal(feed[1].item.byline, 'The Tall Bard (the-tall-bard)', 'a pretty name earns the parenthetical');
  assert.equal(feed[2].item.byline, 'fable', 'a name that normalizes to itself renders alone');
  // The short capture id rides every item: captures are addressable objects.
  assert.deepEqual(feed.map((e) => e.item.id), ['c1', 'c2', 'c3']);
});

// ───────────────── D. :create (#242, born signed) ─────────────────

test('parser: :create endpoint takes one kebab token; project takes a name; usage errors are friendly', () => {
  assert.deepEqual(parseLine(':create endpoint war-room'), { kind: 'create', what: 'endpoint', slug: 'war-room' });
  assert.deepEqual(parseLine(':create project My Grand Plan'), { kind: 'create', what: 'project', name: 'My Grand Plan' });
  assert.equal(parseLine(':create').code, 'create_usage');
  assert.equal(parseLine(':create endpoint').code, 'create_usage');
  assert.equal(parseLine(':create endpoint two words').code, 'create_usage');
  assert.equal(parseLine(':create banana x').code, 'create_usage');
  assert.deepEqual(parseLine(':create help'), { kind: 'help', topic: 'create' });
});

test(':create endpoint is an API act with a feed receipt: born signed, wire-nothing', async () => {
  const { engine, calls } = await boundEngine();
  const events = await engine.execute(':create endpoint war-room');
  // The two calls of the born-signed act, in order: create, then enable signing
  // on the endpoint just created - signing exists before the first capture can.
  assert.deepEqual(calls.creates, [{ projectId: 'p1', name: 'war-room', slug: 'war-room' }]);
  assert.deepEqual(calls.signings, [{ projectId: 'p1', endpointId: 'ep-war-room' }]);
  // Wire-nothing: a context-class write never posts to the stream.
  assert.equal(calls.posts.length, 0);
  // The receipt is clear for the nerds: signing on from birth, 401 from birth.
  const text = events.map((e) => e.text).join('\n');
  assert.match(text, /born signed/);
  assert.match(text, /enabled at creation/);
  assert.match(text, /401/);
  assert.match(text, /:set endpoint war-room/);
  assert.ok(events.every((e) => e.type === 'info'));
});

test(':create endpoint without a set project teaches the bind; :create project says what is missing honestly', async () => {
  const room = fakeRoom();
  const engine = new ConsoleEngine(room.api);
  const events = await engine.execute(':create endpoint war-room');
  assert.equal(events[0].type, 'error');
  assert.match(events[0].text, /:set project/);
  assert.equal(room.calls.creates.length, 0);
  const project = await engine.execute(':create project Grand Plan');
  assert.match(project[0].text, /not available from the console yet/);
});

test('a signing failure after creation renders the honest partial receipt, never a false born-signed claim', async () => {
  const { engine, api } = await boundEngine();
  api.enableSigning = async () => {
    throw new AuthApiError(403, 'forbidden', 'Read-only token.');
  };
  const events = await engine.execute(':create endpoint war-room');
  assert.equal(events[0].type, 'error');
  assert.match(events[0].text, /war-room was created/);
  assert.match(events[0].text, /NOT born signed/);
  assert.ok(!events.some((e) => e.text?.includes('born signed:')), 'no born-signed claim');
});

test('plan-limit refusals on create render the API message honestly', async () => {
  const apiText = 'Endpoint limit reached for this plan (2 of 2 used).';
  const { engine, api } = await boundEngine();
  api.createEndpoint = async () => {
    throw new AuthApiError(409, 'endpoint_limit', apiText);
  };
  const events = await engine.execute(':create endpoint war-room');
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].text, apiText);
});

// ───────────────── E. :me (#247, the identity family) ─────────────────

test('parser: :me splits into name/color/auto (#269); help stays reachable', () => {
  assert.deepEqual(parseLine(':me'), { kind: 'me', action: 'show' });
  // The explicit halves.
  assert.deepEqual(parseLine(':me name starlord'), { kind: 'me', action: 'name', value: 'starlord' });
  assert.deepEqual(parseLine(':me name Star Lord'), { kind: 'me', action: 'name', value: 'Star Lord' });
  assert.equal(parseLine(':me name').code, 'me_name_needs_name');
  assert.deepEqual(parseLine(':me color purple'), { kind: 'me', action: 'color', value: 'purple' });
  assert.equal(parseLine(':me color').code, 'me_color_needs_color');
  assert.equal(parseLine(':me color one two').code, 'me_color_needs_color');
  // A bare :me <x> is the AUTO form: the engine disambiguates against the color set.
  assert.deepEqual(parseLine(':me starlord'), { kind: 'me', action: 'auto', value: 'starlord' });
  assert.deepEqual(parseLine(':me Star Lord'), { kind: 'me', action: 'auto', value: 'Star Lord' });
  assert.deepEqual(parseLine(':me purple'), { kind: 'me', action: 'auto', value: 'purple' });
  assert.deepEqual(parseLine(':me help'), { kind: 'help', topic: 'me' });
});

test('bare :me with a color word sets COLOR and says so; anything else sets the byline and says so (#269)', async () => {
  putChairIdentity('gene');
  putChairProfile({ name: '', color: '' });
  const { engine } = await boundEngine({ palette: ALL_CONSOLE_COLORS });

  // The 08-15 wound, healed: :me purple paints, it does not rename the chair.
  const colored = await engine.execute(':me purple');
  assert.match(colored[0].text, /Your posts now render purple/);
  assert.match(colored[1].text, /Read as a color/);
  assert.match(colored[1].text, /:me name purple/);
  assert.equal(getChairProfile().color, 'purple');
  assert.notEqual(getChairProfile().name, 'purple', 'the chair did not become purple');

  // A non-color word is the byline, and the reply says which reading was taken.
  const named = await engine.execute(':me starlord');
  assert.match(named[0].text, /byline is now starlord/);
  assert.match(named[1].text, /Read as a byline/);
  assert.match(named[1].text, /:me color <color>/);
  assert.equal(getChairProfile().name, 'starlord');

  // Multi-word can never be a color: straight to the byline.
  const multi = await engine.execute(':me Star Lord');
  assert.match(multi[0].text, /byline is now star-lord/);
});

test('the explicit halves never guess: :me name purple names the chair purple deliberately (#269)', async () => {
  putChairIdentity('gene');
  putChairProfile({ name: '', color: '' });
  const { engine } = await boundEngine({ palette: ALL_CONSOLE_COLORS });
  const named = await engine.execute(':me name purple');
  assert.match(named[0].text, /byline is now purple/);
  assert.equal(named.length, 1, 'an explicit act carries no which-reading note');
  assert.equal(getChairProfile().name, 'purple');
  const colored = await engine.execute(':me color teal');
  assert.match(colored[0].text, /Your posts now render teal/);
  assert.equal(colored.length, 1);
  assert.equal(getChairProfile().color, 'teal');
});

test(':me sets the byline: from changes on the wire, the seeded address does not move', async () => {
  putChairIdentity('gene');
  putChairProfile({ name: '', color: '' });
  const { engine, calls } = await boundEngine();
  const events = await engine.execute(':me starlord');
  assert.match(events[0].text, /byline is now starlord/);
  assert.match(events[0].text, /byline is claim, signature is custody/);
  assert.equal(getChairProfile().name, 'starlord', 'persisted console-local');

  await engine.execute('hello room');
  assert.equal(JSON.parse(calls.posts[0].body).from, 'starlord', 'the wire byline follows :me');

  // The seeded ADDRESS is untouched: the boarding pass still routes to gene.
  const mint = await engine.execute(':seat New Guest');
  const pairing = mint.find((e) => e.type === 'pairing');
  assert.match(pairing.passLines.join('\n'), /The chair is gene/);
});

test(':me names normalize through the handle alphabet; reserved words and namespaces are refused', async () => {
  putChairProfile({ name: '', color: '' });
  const { engine } = await boundEngine();
  const multi = await engine.execute(':me Star Lord');
  assert.match(multi[0].text, /byline is now star-lord/);
  assert.equal(getChairProfile().name, 'star-lord');
  for (const bad of [':me all', ':me exit', ':me fp:boss', ':me tag']) {
    const events = await engine.execute(bad);
    assert.equal(events[0].type, 'error', `${bad} refused`);
    assert.match(events[0].text, /cannot be your byline/);
  }
  assert.equal(getChairProfile().name, 'star-lord', 'a refused name changes nothing');
});

test(':me color paints the chair (persisted); :me bare shows name and color; feed rows carry it', async () => {
  putChairIdentity(CHAIR_FROM);
  putChairProfile({ name: '', color: '' });
  const { engine, api } = await boundEngine({ palette: ALL_CONSOLE_COLORS });
  const colored = await engine.execute(':me color purple');
  assert.match(colored[0].text, /render purple/);
  assert.equal(getChairProfile().color, 'purple');
  const show = await engine.execute(':me');
  assert.match(show[0].text, new RegExp(`byline is ${CHAIR_FROM}`));
  assert.match(show[0].text, /rendered purple/);
  api._setCaptures([
    { id: 'c1', createdAt: '2026-08-14T02:00:00Z', signerLabel: 'owner', body: JSON.stringify({ v: 1, kind: 'message', from: CHAIR_FROM, text: 'mine' }), contentType: 'application/json' },
  ]);
  const feed = (await engine.pollFeed(1)).filter((e) => e.type === 'feed');
  assert.equal(feed[0].item.color, 'purple', "the chair's own rows wear the :me color");
});

// ───────────── F. capability-aware palette (ratified: grows with the terminal) ─────────────

test('supportedPalette: 16-color terminals keep the safe eight; 256+/truecolor unlock purple and friends', () => {
  assert.deepEqual([...supportedPalette(0)], [...CONSOLE_COLORS]);
  assert.deepEqual([...supportedPalette(1)], [...CONSOLE_COLORS]);
  assert.deepEqual([...supportedPalette(2)], [...ALL_CONSOLE_COLORS]);
  assert.deepEqual([...supportedPalette(3)], [...ALL_CONSOLE_COLORS]);
  assert.ok(supportedPalette(2).includes('purple'), 'Gene wanted purple');
});

test('effectiveColor degrades gracefully: purple renders magenta on 16-color, itself on 256+', () => {
  assert.equal(effectiveColor('purple', 1), 'magenta');
  assert.equal(effectiveColor('purple', 2), 'purple');
  assert.equal(effectiveColor('purple', 3), 'purple');
  assert.equal(effectiveColor('cyan', 1), 'cyan');
  for (const c of EXTENDED_COLORS) {
    assert.ok(CONSOLE_COLORS.includes(effectiveColor(c, 1)), `${c} has a 16-color understudy`);
  }
});

test('the engine gates NEW color choices on the palette in effect, with the friendly capability line', async () => {
  // A 16-color session: purple is a real name, refused with the capability line.
  const base = await boundEngine();
  const refused = await base.engine.execute(':bunny color purple');
  assert.equal(refused[0].type, 'error');
  assert.match(refused[0].text, /256-color or truecolor/);
  const meRefused = await base.engine.execute(':me color purple');
  assert.match(meRefused[0].text, /256-color or truecolor/);
  // Nonsense stays the palette line.
  const plaid = await base.engine.execute(':bunny color plaid');
  assert.match(plaid[0].text, /No color named plaid/);
  // :colors shows what THIS terminal renders.
  const colors = await base.engine.execute(':colors');
  assert.deepEqual([...colors[0].colors], [...CONSOLE_COLORS]);

  // A 256+/truecolor session: the extended names work and persist.
  const ext = await boundEngine({ palette: ALL_CONSOLE_COLORS });
  const ok = await ext.engine.execute(':bunny color purple');
  assert.match(ok[0].text, /bunny now renders purple/);
  const roster = await ext.engine.execute(':list seats');
  assert.equal(roster[0].rows.find((r) => r.handle === 'bunny').color, 'purple');
  const extColors = await ext.engine.execute(':colors');
  assert.deepEqual([...extColors[0].colors], [...ALL_CONSOLE_COLORS]);
});

// ───────────── G. :collection / :tag (#251, curation from the chair) ─────────────

test('parser: collection takes the rest of the line; tag takes id then optional collection', () => {
  assert.deepEqual(parseLine(':collection scene canon'), { kind: 'collection', name: 'scene canon' });
  assert.equal(parseLine(':collection').code, 'collection_needs_name');
  assert.deepEqual(parseLine(':tag c1a2b3 scene canon'), { kind: 'tag', id: 'c1a2b3', collection: 'scene canon' });
  assert.deepEqual(parseLine(':tag c1a2b3'), { kind: 'tag', id: 'c1a2b3' });
  assert.equal(parseLine(':tag').code, 'tag_needs_id');
  assert.deepEqual(parseLine(':collection help'), { kind: 'help', topic: 'collection' });
  assert.deepEqual(parseLine(':tag help'), { kind: 'help', topic: 'tag' });
});

test(':collection binds an existing collection or notes a fresh name for lazy creation (the server refuses empty)', async () => {
  const { engine, api, calls } = await boundEngine();
  api._collections.push({ id: 'col-old', name: 'canon', itemCount: 3 });
  const bound = await engine.execute(':collection canon');
  assert.match(bound[0].text, /canon bound for this session \(3 captures pinned\)/);
  const fresh = await engine.execute(':collection scene two');
  assert.match(fresh[0].text, /No collection named scene two here yet/);
  assert.match(fresh[0].text, /created.*first time/);
  // Neither act posted to the stream or created anything yet.
  assert.equal(calls.posts.length, 0);
  assert.equal(calls.collectionCreates.length, 0);
});

test(':tag <id> <collection> creates on first tag (the capture rides the create), then appends', async () => {
  const { engine, calls } = await boundEngine();
  await engine.execute(':collection canon');
  const first = await engine.execute(':tag c1a2b3 canon');
  assert.deepEqual(calls.collectionCreates, [{ projectId: 'p1', endpointId: 'e1', name: 'canon', captureIds: ['c1a2b3'] }]);
  const firstText = first.map((e) => e.text).join('\n');
  assert.match(firstText, /canon created/);
  assert.match(firstText, /c1a2b3 tagged into canon/);
  assert.match(firstText, /pinned/);
  assert.match(firstText, /retention exempt/);

  const second = await engine.execute(':tag c9z8y7 canon');
  assert.deepEqual(calls.collectionAdds, [{ projectId: 'p1', endpointId: 'e1', collectionId: 'col-1', captureIds: ['c9z8y7'] }]);
  assert.match(second[0].text, /c9z8y7 tagged into canon/);
  // Wire-nothing throughout.
  assert.equal(calls.posts.length, 0);
});

test(':tag into a server-known name works without :collection first; addedCount 0 is honest', async () => {
  const { engine, api, calls } = await boundEngine();
  api._collections.push({ id: 'col-old', name: 'canon', itemCount: 1 });
  await engine.execute(':tag c1a2b3 canon');
  assert.equal(calls.collectionCreates.length, 0, 'existing collection: no create');
  assert.equal(calls.collectionAdds[0].collectionId, 'col-old');
  api.addToCollection = async () => ({ addedCount: 0 });
  const dup = await engine.execute(':tag c1a2b3 canon');
  assert.match(dup[0].text, /already in canon/);
});

test('bare :tag <id> opens the numbered picker: a number picks, a name creates, enter cancels', async () => {
  const { engine, api, calls } = await boundEngine();
  api._collections.push({ id: 'col-old', name: 'canon', itemCount: 1 });
  await engine.execute(':collection drafts'); // pending name joins the picker

  const ask = await engine.execute(':tag c1a2b3');
  assert.equal(ask[0].type, 'ask');
  assert.match(ask[0].text, /Tag capture c1a2b3/);
  assert.match(ask[0].text, /1\. drafts \(created on first tag\)/);
  assert.match(ask[0].text, /2\. canon/);
  assert.match(ask[0].text, /number.*new collection name/);

  // A listed number picks that collection.
  const picked = await engine.execute('2');
  assert.match(picked[0].text, /tagged into canon/);
  assert.equal(calls.collectionAdds[0].collectionId, 'col-old');

  // Enter alone cancels.
  await engine.execute(':tag c1a2b3');
  const cancelled = await engine.execute('');
  assert.match(cancelled[0].text, /Nothing tagged/);

  // Free text is a new collection: created with this capture.
  await engine.execute(':tag c1a2b3');
  const created = await engine.execute('keepers');
  assert.match(created.map((e) => e.text).join('\n'), /keepers created/);
  assert.deepEqual(calls.collectionCreates.at(-1), { projectId: 'p1', endpointId: 'e1', name: 'keepers', captureIds: ['c1a2b3'] });
});

test('collection verbs while unbound teach the bind, like every room act', async () => {
  const room = fakeRoom();
  const engine = new ConsoleEngine(room.api);
  for (const line of [':collection canon', ':tag c1a2b3 canon', ':tag c1a2b3']) {
    const events = await engine.execute(line);
    assert.equal(events[0].type, 'error');
    assert.match(events[0].text, /not bound/);
  }
});

test('a garbled capture id renders the friendly id line through the real room client, never a stack trace', async () => {
  const fakeClient = {
    baseUrl: 'http://x',
    async get() { return {}; },
    async post() { return {}; },
    async put() { return {}; },
    async delete() { return {}; },
  };
  const api = createRoomApi(fakeClient);
  await assert.rejects(
    () => api.createCollection('p1', 'e1', 'canon', ['!!!not-base62!!!']),
    (err) => err instanceof AuthApiError && /not a capture id/.test(err.detail) && /feed line/.test(err.detail),
  );
});

// ───────────── H. friendly net errors (#245: the map) ─────────────

test('API failures reachable from a typed line map to the friendly status lines', async () => {
  const cases = [
    [401, msg.http401, /rejected your token \(401\)/],
    [403, null, /permissions this token does not have \(403\)/],
    [404, null, /does not know that resource \(404\)/],
    [429, msg.http429, /slow down \(429\)/],
  ];
  for (const [status, exact, pattern] of cases) {
    const { engine, api } = await boundEngine();
    api.listCollections = async () => {
      throw new AuthApiError(status, 'x', status === 403 ? 'Read-only token.' : '');
    };
    const events = await engine.execute(':collection canon');
    assert.equal(events[0].type, 'error', `status ${status} is an error event`);
    assert.match(events[0].text, pattern);
    if (exact) assert.equal(events[0].text, exact);
    assert.ok(!/^AuthApiError/.test(events[0].text), 'no raw error names in the feed');
  }
  // Other statuses keep the server's words.
  const { engine, api } = await boundEngine();
  api.listCollections = async () => {
    throw new AuthApiError(500, 'x', 'The teapot is on fire.');
  };
  const events = await engine.execute(':collection canon');
  assert.equal(events[0].text, 'The teapot is on fire.');
});

test('a throttled capture URL (429) renders the friendly post line, not a raw status dump', async () => {
  const { engine, api } = await boundEngine();
  api.post = async () => ({ httpStatus: 429, ok: false, durationMs: 1, sizeBytes: 0, errorText: 'Too Many Requests', captureId: null, executions: null });
  const events = await engine.execute('hello room');
  assert.equal(events[0].type, 'error');
  assert.match(events[0].text, /slow down \(429\)/);
  assert.match(events[0].text, /did not land/);
});

test('friendlyFetchError names the undici codes in plain words', () => {
  const withCause = (code) => Object.assign(new Error('fetch failed'), { cause: { code } });
  assert.match(friendlyFetchError(withCause('UND_ERR_CONNECT_TIMEOUT')), /timed out before the server answered/);
  assert.match(friendlyFetchError(withCause('UND_ERR_HEADERS_TIMEOUT')), /went quiet mid-response/);
  assert.match(friendlyFetchError(withCause('UND_ERR_BODY_TIMEOUT')), /went quiet mid-response/);
  assert.match(friendlyFetchError(withCause('UND_ERR_SOCKET')), /dropped mid-request/);
  assert.match(friendlyFetchError(withCause('ECONNREFUSED')), /connection refused/);
  // AggregateError causes keep working (the pre-existing shape).
  assert.match(friendlyFetchError(Object.assign(new Error('fetch failed'), { cause: { errors: [{ code: 'ECONNREFUSED' }] } })), /connection refused/);
  // No cause: the message passes through untouched.
  assert.equal(friendlyFetchError(new Error('plain failure')), 'plain failure');
});

// ───────────── I. reserved words grew with the grammar ─────────────

test('create, me, collection, and tag are reserved: seats named after them bind suffixed', async () => {
  const { RESERVED_WORDS } = await import('../dist/lib/console-parser.js');
  const { assignHandles } = await import('../dist/lib/console-handles.js');
  for (const word of ['create', 'me', 'collection', 'tag']) {
    assert.ok(RESERVED_WORDS.has(word), `${word} is reserved`);
  }
  const rows = assignHandles([{ guestName: 'Tag' }, { guestName: 'Me' }]);
  assert.deepEqual(rows.map((r) => r.handle), ['tag-2', 'me-2']);
});

// ───────────── J. backfill history reads as history ─────────────

test('feedTime dates anything older than today and leaves live rows narrow', () => {
  // Fixtures built in LOCAL time on purpose: the row displays a local clock, so
  // same-day is a local question. UTC literals here would flip day in any
  // negative-offset zone and test the runner's timezone instead of the rule.
  const now = new Date(2026, 7, 14, 12, 0, 0);
  const sameDay = new Date(2026, 7, 14, 9, 30, 0);
  const dayBefore = new Date(2026, 7, 13, 16, 37, 32);

  // Today: time only - the live case keeps the ratified narrow meta column.
  assert.match(feedTime(sameDay.toISOString(), now), /^\d{2}:\d{2}:\d{2}$/);
  // Older: MM-DD prefix, so a day-old backfill cannot pass for live traffic
  // (found 08-14: a 08-13 writers-room backfill read as if it were happening now).
  assert.equal(feedTime(dayBefore.toISOString(), now), '08-13 16:37:32');
  // Unparseable timestamps still pass through untouched.
  assert.equal(feedTime('not-a-date', now), 'not-a-date');
});

// ───────────── K. binding is forgiving (the 08-14 five-attempt trail) ─────────────

test('every form the chair actually typed on 08-14 now binds or fails loudly', async () => {
  // Attempt 1: singular noun on :list - accepted, canon spelling is still plural.
  assert.deepEqual(parseLine(':list endpoint'), { kind: 'list', what: 'endpoints' });
  assert.deepEqual(parseLine(':list project'), { kind: 'list', what: 'projects' });
  assert.deepEqual(parseLine(':list seat'), { kind: 'list', what: 'seats' });
  assert.deepEqual(parseLine(':list roster'), { kind: 'list', what: 'seats' });

  // Attempts 2, 3, 4: two slugs are project then endpoint, noun or not.
  const bind = { kind: 'bind', project: 'flurryport-operations', endpoint: 'writers-room' };
  assert.deepEqual(parseLine(':set flurryport-operations writers-room'), bind);
  assert.deepEqual(parseLine(':set project flurryport-operations writers-room'), bind);
  assert.deepEqual(parseLine(':set endpoint flurryport-operations writers-room'), bind);
  // The pasted form :list endpoints prints, which was never accepted before.
  assert.deepEqual(parseLine(':set flurryport-operations/writers-room'), bind);
  assert.deepEqual(parseLine(':set project flurryport-operations/writers-room'), bind);

  // Attempt 5: the one-at-a-time forms are untouched.
  assert.deepEqual(parseLine(':set endpoint writers-room'), { kind: 'set', what: 'endpoint', slug: 'writers-room' });
  assert.deepEqual(parseLine(':set project foo'), { kind: 'set', what: 'project', slug: 'foo' });

  // One bare slug stays a usage error: it cannot say which half it is.
  assert.equal(parseLine(':set writers-room').kind, 'error');
  // Three slugs is a typo, not a binding - refused rather than silently trimmed.
  assert.equal(parseLine(':set a b c').kind, 'error');
});

test('the two-slug bind sets both halves, and a bad project stops before the endpoint', async () => {
  const { api } = fakeRoom();
  const engine = new ConsoleEngine(api, null, {});
  const events = await engine.execute(':set foo/room');
  assert.ok(events.some((e) => e.type === 'info' && /Bound to foo\/room/.test(e.text)), 'binds in one act');
  assert.ok(!events.some((e) => e.type === 'error'));

  // A bad project must not report a confusing "no endpoint with slug <project>".
  const engine2 = new ConsoleEngine(fakeRoom().api, null, {});
  const bad = await engine2.execute(':set nope/room');
  assert.equal(bad.filter((e) => e.type === 'error').length, 1);
  assert.match(bad.find((e) => e.type === 'error').text, /No project with slug nope/);
});

test('a project slug where an endpoint belongs names the one-shot form', async () => {
  const { api } = fakeRoom();
  const engine = new ConsoleEngine(api, null, {});
  const events = await engine.execute(':set endpoint foo'); // foo is a PROJECT slug
  const err = events.find((e) => e.type === 'error');
  assert.match(err.text, /foo is a project, not an endpoint/);
  assert.match(err.text, /:set foo\/<endpoint>/);
});

test('a one-shot bind that half-lands says where it left the console', async () => {
  const { api } = fakeRoom();
  const engine = new ConsoleEngine(api, null, {});
  // foo is a real project; 'nope' is not one of its endpoints.
  const events = await engine.execute(':set foo/nope');
  const err = events.find((e) => e.type === 'error');
  // The miss names the SCOPE it searched, not a bare "no endpoint with slug".
  assert.match(err.text, /No endpoint nope in foo/);
  // And the surviving project change is said out loud, never left to be discovered.
  const kept = events.find((e) => e.type === 'info' && /Project is set to foo/.test(e.text));
  assert.ok(kept, `no half-landed notice; got ${JSON.stringify(events.map((e) => e.text))}`);
  assert.match(kept.text, /the room is still unbound/);
});

// ───────────── L. #259: bare-exit swallow + capture-id prefixes ─────────────

test('parser: :say posts the rest of the line literally, and say is reserved', async () => {
  const { RESERVED_WORDS } = await import('../dist/lib/console-parser.js');
  assert.deepEqual(parseLine(':say exit'), { kind: 'say', text: 'exit' });
  assert.deepEqual(parseLine(':say quit please'), { kind: 'say', text: 'quit please' });
  assert.equal(parseLine(':say').code, 'say_what');
  assert.deepEqual(parseLine(':say help'), { kind: 'help', topic: 'say' });
  assert.ok(RESERVED_WORDS.has('say'), 'say is a command word now');
});

test('a bare exit or quit never posts: the hint renders and :say exit still reaches the room', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine, calls } = await boundEngine();
  for (const word of ['exit', 'quit', '  exit  ']) {
    const events = await engine.execute(word);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'info');
    assert.equal(events[0].text, msg.bareExitHint(word.trim()));
  }
  assert.equal(calls.posts.length, 0, 'a bare leave word reached the wire');
  // The literal word still posts through :say.
  await engine.execute(':say exit');
  assert.equal(calls.posts.length, 1);
  assert.equal(JSON.parse(calls.posts[0].body).text, 'exit');
  // More than the bare word is an ordinary post, untouched.
  await engine.execute('exit now');
  assert.equal(calls.posts.length, 2);
  assert.equal(JSON.parse(calls.posts[1].body).text, 'exit now');
});

test('the swallow leaves :exit alone and answers even while unbound', async () => {
  const { engine } = await boundEngine();
  const exit = await engine.execute(':exit');
  assert.equal(exit[0].type, 'exit');

  const unbound = new ConsoleEngine(fakeRoom().api, null, {});
  const events = await unbound.execute('quit');
  assert.equal(events[0].type, 'info');
  assert.match(events[0].text, /:exit leaves the console/);
});

/** Two captures sharing a six-char prefix, plus a poll to prime the id pool. */
async function primedEngine() {
  const bound = await boundEngine();
  bound.api._setCaptures([
    { id: 'AbCdEfGh01', createdAt: '2026-08-15T10:01:00Z', signerLabel: 'Bunny', body: '{"v":1,"kind":"message","from":"bunny","text":"one"}' },
    { id: 'AbCdEfXy02', createdAt: '2026-08-15T10:00:00Z', signerLabel: 'Bunny', body: '{"v":1,"kind":"message","from":"bunny","text":"two"}' },
  ]);
  await bound.engine.pollFeed(1);
  return bound;
}

test(':tag takes a git-style unique prefix and resolves it to the full cached id', async () => {
  const { engine, calls } = await primedEngine();
  const events = await engine.execute(':tag AbCdEfG regressions');
  assert.match(events.map((e) => e.text).join('\n'), /Capture AbCdEfGh01 tagged into regressions/);
  assert.deepEqual(calls.collectionCreates[0].captureIds, ['AbCdEfGh01']);
});

test('an ambiguous prefix is refused with the collision count, before any API act', async () => {
  const { engine, calls } = await primedEngine();
  const events = await engine.execute(':tag AbCdEf regressions');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].text, msg.captureIdAmbiguous('AbCdEf', 2));
  assert.equal(calls.collectionCreates.length, 0);
  assert.equal(calls.collectionAdds.length, 0);
});

test('below the floor and outside the pool a token passes through verbatim', async () => {
  const { engine, calls } = await primedEngine();
  // Five characters: under the floor, never prefix-matched even though it would be ambiguous.
  await engine.execute(':tag AbCdE shorts');
  assert.deepEqual(calls.collectionCreates[0].captureIds, ['AbCdE']);
  // A token matching nothing cached: the server may still know it.
  await engine.execute(':tag ZzZzZz01 shorts');
  assert.deepEqual(calls.collectionAdds[0].captureIds, ['ZzZzZz01']);
});

test('the prefix pool dies with the bind, like every other piece of room state', async () => {
  const { engine, calls } = await primedEngine();
  await engine.execute(':set endpoint room'); // rebind clears room state
  await engine.execute(':tag AbCdEfG fresh');
  // No pool, no resolution: the token goes through as typed.
  assert.deepEqual(calls.collectionCreates[0].captureIds, ['AbCdEfG']);
});

test('the bare picker resolves the prefix too: the ask names the full id', async () => {
  const { engine } = await primedEngine();
  const events = await engine.execute(':tag AbCdEfX');
  assert.equal(events[0].type, 'ask');
  assert.match(events[0].text, /Tag capture AbCdEfXy02 into which collection\?/);
  await engine.execute(''); // enter alone cancels the picker
});

// ───────────── M. #263: the addressee wears a color on the meta line ─────────────

test('a to naming a roster handle carries that seat color; the chair wears its own; all stays null', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine, api } = await boundEngine();
  await engine.execute(':me color red');
  await engine.execute(':bunny recolor green'); // #278 alias spelling, exercised on purpose
  api._setCaptures([
    { id: 'to-1', createdAt: '2026-08-15T10:00:00Z', signerLabel: 'fable', body: '{"v":1,"kind":"message","from":"fable","to":"bunny","text":"a"}' },
    { id: 'to-2', createdAt: '2026-08-15T10:01:00Z', signerLabel: 'Bunny', body: '{"v":1,"kind":"message","from":"bunny","to":"director","text":"b"}' },
    { id: 'to-3', createdAt: '2026-08-15T10:02:00Z', signerLabel: 'owner', body: '{"v":1,"kind":"message","from":"director","to":"all","text":"c"}' },
    { id: 'to-4', createdAt: '2026-08-15T10:03:00Z', signerLabel: 'Bunny', body: '{"v":1,"kind":"message","from":"bunny","to":"nobody-here","text":"d"}' },
    { id: 'to-5', createdAt: '2026-08-15T10:04:00Z', signerLabel: 'Bunny', body: '{"v":1,"kind":"message","from":"bunny","text":"e"}' },
  ]);
  const feed = (await engine.pollFeed(1)).filter((e) => e.type === 'feed');
  const byId = Object.fromEntries(feed.map((e) => [e.item.id, e.item]));
  assert.equal(byId['to-1'].toColor, 'green'); // the seat's own color
  assert.equal(byId['to-2'].toColor, 'red'); // the chair's wire address wears the chair color
  assert.equal(byId['to-3'].toColor, null); // all is a range, not a seat
  assert.equal(byId['to-4'].toColor, null); // an unknown name falls back to meta style
  assert.equal(byId['to-5'].toColor, null); // no addressee at all
});

test('the chair :me byline is an address too, and a colorless chair stays null', async () => {
  putChairIdentity(CHAIR_FROM);
  const { engine, api } = await boundEngine();
  await engine.execute(':me color red');
  await engine.execute(':me boss');
  api._setCaptures([
    { id: 'to-6', createdAt: '2026-08-15T10:00:00Z', signerLabel: 'Bunny', body: '{"v":1,"kind":"message","from":"bunny","to":"boss","text":"a"}' },
  ]);
  const feed = (await engine.pollFeed(1)).filter((e) => e.type === 'feed');
  assert.equal(feed[0].item.toColor, 'red');

  // A chair that never chose a color has none to lend its addresses.
  putChairProfile({ name: null, color: null });
  const bare = await boundEngine();
  bare.api._setCaptures([
    { id: 'to-7', createdAt: '2026-08-15T10:00:00Z', signerLabel: 'Bunny', body: '{"v":1,"kind":"message","from":"bunny","to":"director","text":"b"}' },
  ]);
  const rows = (await bare.engine.pollFeed(1)).filter((e) => e.type === 'feed');
  assert.equal(rows[0].item.toColor, null);
});

test('a suffixed handle (author-2) wears its own seat color as an addressee', async () => {
  putChairIdentity(CHAIR_FROM);
  const { api } = fakeRoom();
  api.listSeats = async (endpointId) =>
    endpointId === 'e1'
      ? [
          { inviteId: 'i1', ref: 'r1', guestName: 'Author', status: 'accepted', expiresAt: '2026-08-16T00:00:00Z', createdAt: '2026-08-14T01:00:00Z' },
          { inviteId: 'i2', ref: 'r2', guestName: 'Author', status: 'accepted', expiresAt: '2026-08-16T00:00:00Z', createdAt: '2026-08-14T02:00:00Z' },
        ]
      : [];
  const engine = new ConsoleEngine(api, null, {});
  await engine.execute(':set foo/room');
  await engine.execute(':author-2 color yellow');
  api._setCaptures([
    { id: 'to-8', createdAt: '2026-08-15T10:00:00Z', signerLabel: 'Author', body: '{"v":1,"kind":"message","from":"author","to":"author-2","text":"hi"}' },
  ]);
  const feed = (await engine.pollFeed(1)).filter((e) => e.type === 'feed');
  // The wire never carries the console's collision suffix; the roster does.
  assert.equal(feed[0].item.toColor, 'yellow');
});
