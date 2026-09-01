// Precedent #1 regression lock (CLAUDE.20260829.cli-hardening-brief.md): session
// state must be PER SESSION, never module-global. One process hosts many concurrent
// sessions over HTTP (--http, the seat server, the coming account principal); before
// the fix, claimScope / pendingClaimNotice / pendingWriteNotice / the discovery cache
// were module `let`s, so session A's claim leaked into session B's default scope
// (cross-tenant reads and writes on A's endpoint whenever B omitted ids) and B's
// next response consumed A's one-time session_claimed notice.
//
// The harness stands up TWO AuthToolContexts in ONE module instance - exactly the
// multi-session process shape - and proves nothing crosses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated HOME before dist imports: nothing here may touch the operator's profile.
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'fp-isolation-home-'));
process.env.HOME = process.env.USERPROFILE;
process.env.FLURRYPORT_WEB_URL = 'https://flurryport.io';

const { collectTools } = await import('../dist/lib/mcp-unified.js');
const { registerAuthTools, createAuthSessionState, announceClaim, announceWriteDecision } =
  await import('../dist/lib/mcp-auth-tools.js');

/** A client whose project listing is ambiguous - B must ASK, never borrow A's scope. */
function twoProjectClient() {
  return {
    baseUrl: 'http://b.example',
    async get(path) {
      if (path === '/api/v1/projects') {
        return {
          Projects: [
            { Id: '11111111-1111-1111-1111-111111111111' },
            { Id: '22222222-2222-2222-2222-222222222222' },
          ],
        };
      }
      return {};
    },
    async post() { return {}; },
    async put() { return {}; },
    async delete() { return {}; },
  };
}

function sessionTools(client) {
  const ctx = { session: createAuthSessionState(), client, allowLan: false };
  const tools = collectTools((s) => registerAuthTools(s, ctx));
  const call = async (name, args) => JSON.parse((await tools.get(name).handler(args)).content[0].text);
  return { ctx, call };
}

test('a claim on session A never leaks scope or notice into session B', async () => {
  const a = sessionTools({ baseUrl: 'http://a.example', async get() { return {}; }, async post() { return {}; } });
  const b = sessionTools(twoProjectClient());

  // A claims: its session gets the default scope and the one-time notice.
  announceClaim(a.ctx.session, {
    projectId: 'PA',
    endpointId: 'EA',
    endpointSlug: 'room-a',
    captureCount: 3,
  });

  // B, omitting ids, must diagnose ITS OWN account (two projects -> ask), never
  // answer with A's claimed endpoint. Before the fix this returned room-a's URL.
  const bAnswer = await b.call('get_capture_url', {});
  assert.equal(bAnswer.error?.code, 'ambiguous_scope', 'B asks instead of borrowing A\'s scope');
  assert.ok(!JSON.stringify(bAnswer).includes('room-a'), 'nothing of A\'s room reaches B');
  // ...and B's meta must NOT have consumed A's one-time session_claimed notice.
  assert.notEqual(bAnswer.meta?.notice?.code, 'session_claimed', 'A\'s notice is not B\'s to consume');

  // A still holds its own scope AND its own notice, exactly once.
  const aAnswer = await a.call('get_capture_url', {});
  assert.equal(aAnswer.endpointSlug, 'room-a', 'A answers from its claimed scope');
  assert.equal(aAnswer.meta?.notice?.code, 'session_claimed', 'A\'s notice fires on A');
  const aSecond = await a.call('get_capture_url', {});
  assert.ok(!aSecond.meta?.notice || aSecond.meta.notice.code !== 'session_claimed',
    'the notice is one-shot on A');
});

test('a write-grant decision on session A never surfaces on session B', async () => {
  const a = sessionTools(twoProjectClient());
  const b = sessionTools(twoProjectClient());

  announceWriteDecision(a.ctx.session, true);

  const bAnswer = await b.call('get_capture_url', {});
  assert.notEqual(bAnswer.meta?.notice?.code, 'write_granted', 'A\'s grant is not B\'s notice');

  const aAnswer = await a.call('get_capture_url', {});
  assert.equal(aAnswer.meta?.notice?.code, 'write_granted', 'the grant notice lands on A');
});

// Review finding 4: the plan cache is tenant data and must be per session too -
// before the fix, anyCachedPlan() handed the FIRST plan any session in the
// process cached into every other session's meta envelope.
test('one session\'s cached plan never renders in another session\'s meta', async () => {
  const aClient = {
    baseUrl: 'http://a.example',
    async get(path) {
      if (path.endsWith('/plan')) {
        return { PlanTierId: 4, MaxMonthlyCaptures: 250000, CurrentMonthCaptures: 133777, RetentionDays: 45 };
      }
      if (path.includes('/endpoints/')) return { Slug: 'plan-room' };
      return {};
    },
  };
  const a = sessionTools(aClient);
  const b = sessionTools(twoProjectClient());

  const aAnswer = await a.call('get_capture_url', { projectId: 'PA', endpointId: 'EA' });
  assert.equal(aAnswer.meta?.capturesUsed, 133777, 'A sees its own plan numbers');

  const bAnswer = await b.call('get_capture_url', {});
  assert.equal(bAnswer.error?.code, 'ambiguous_scope');
  assert.notEqual(bAnswer.meta?.capturesUsed, 133777, 'B\'s meta does not carry A\'s usage');
  assert.notEqual(bAnswer.meta?.capturesCap, 250000, 'B\'s meta does not carry A\'s cap');
});

// Precedent #8, proven through the real tool path: a transport error from the API
// client must reach the agent sanitized, never with the cluster address in it.
test('a transport error surfaces without internal host detail', async () => {
  const brokenClient = {
    baseUrl: 'http://a.example',
    async get() {
      const err = new Error('fetch failed');
      err.cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 10.0.12.34:8083' };
      throw err;
    },
  };
  const s = sessionTools(brokenClient);
  const silenced = console.error;
  console.error = () => {};
  let answer;
  try {
    answer = await s.call('get_capture_url', { projectId: 'P1', endpointId: 'E1' });
  } finally {
    console.error = silenced;
  }
  assert.equal(answer.error?.code, 'upstream_unreachable');
  assert.ok(!JSON.stringify(answer).includes('10.0.12.34'), 'no internal IP in the tool result');
});

test('scope discovery caches per session, not per process', async () => {
  // A resolves a single-project account; B has two projects. If the discovery cache
  // were shared, whichever ran first would answer for both.
  const aClient = {
    baseUrl: 'http://a.example',
    async get(path) {
      if (path === '/api/v1/projects') return { Projects: [{ Id: '33333333-3333-3333-3333-333333333333' }] };
      if (path.endsWith('/endpoints')) return { Endpoints: [{ Id: '44444444-4444-4444-4444-444444444444', Slug: 'only-room' }] };
      return {};
    },
  };
  const a = sessionTools(aClient);
  const b = sessionTools(twoProjectClient());

  const aAnswer = await a.call('get_capture_url', {});
  assert.equal(aAnswer.endpointSlug, 'only-room', 'A discovers its own single endpoint');

  const bAnswer = await b.call('get_capture_url', {});
  assert.equal(bAnswer.error?.code, 'ambiguous_scope', 'B does not inherit A\'s cached discovery');
  assert.ok(!JSON.stringify(bAnswer).includes('only-room'), 'A\'s discovered room never reaches B');
});
