// mint_seat (#297): the chair's agent mints the pass over MCP. The tool rides the
// SAME hoisted /invites/seat call as console :seat and `flurryport seat`
// (seat-mint.ts), sanitizes guestName with the #284a rule, and returns the
// ratified slim boarding pass (identity + reachability only). These tests drive
// the registered handler against a fake AuthApiClient - offline, loopback-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated HOME before dist imports: the chairAddress fallback reads the
// console's seeded identity from ~/.flurryport/console.json, and nothing here
// may touch (or boot authed against) the operator's real config.
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'fp-mint-seat-home-'));
process.env.HOME = process.env.USERPROFILE;

const { collectTools } = await import('../dist/lib/mcp-unified.js');
const { registerAuthTools } = await import('../dist/lib/mcp-auth-tools.js');
const { putChairIdentity } = await import('../dist/lib/console-view-state.js');

const CODE = '7WHM-KR4P-XT2B';

/** Fake AuthApiClient recording every call; route answers are per-fixture. */
function fakeClient(routes = {}) {
  const calls = [];
  const answer = (method, path, body) => {
    calls.push({ method, path, body });
    const hit = routes[`${method} ${path}`];
    if (hit === undefined) throw new Error(`unrouted ${method} ${path}`);
    return typeof hit === 'function' ? hit(body) : hit;
  };
  return {
    calls,
    baseUrl: 'http://127.0.0.1:9',
    get: async (path) => answer('GET', path),
    post: async (path, body) => answer('POST', path, body),
    put: async (path, body) => answer('PUT', path, body),
    delete: async (path) => answer('DELETE', path),
  };
}

const mintRelease = {
  PairingCode: CODE,
  Ref: 'REF1',
  ParticipantName: 'Coder',
  ExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  CodeExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
};

function mintTool(routes) {
  const client = fakeClient(routes);
  const tools = collectTools((s) => registerAuthTools(s, { client, allowLan: false }));
  return { client, handler: tools.get('mint_seat').handler };
}

const roomRoutes = () => ({
  'POST /api/v1/endpoints/E1/invites/seat': mintRelease,
  'GET /api/v1/projects/P1': { Slug: 'acme' },
  'GET /api/v1/projects/P1/endpoints/E1': { Slug: 'hook' },
});

test('mint_seat happy path: same wire body as the seat command, pass carries code, room, and wire name', async () => {
  const { client, handler } = mintTool(roomRoutes());
  const result = await handler({
    projectId: 'P1', endpointId: 'E1', guestName: 'Coder', hours: 6, chairAddress: 'gene',
  });
  assert.ok(!result.isError, result.content[0].text);
  const payload = JSON.parse(result.content[0].text);

  // The one shared mint call, hours passed through as ExpiresInHours.
  const mint = client.calls.find((c) => c.method === 'POST');
  assert.equal(mint.path, '/api/v1/endpoints/E1/invites/seat');
  assert.deepEqual(mint.body, { GuestName: 'Coder', DisplayName: null, RecipeRef: null, ExpiresInHours: 6, CodeMinutes: null, Standing: false, StandingCheckedInOnly: false });

  assert.equal(payload.pairingCode, CODE);
  assert.equal(payload.ref, 'REF1');
  // #284c: the wire name is the SERVER's assignment through the handle alphabet.
  assert.equal(payload.wireName, 'coder');
  assert.equal(payload.seatExpiresAt, mintRelease.ExpiresAt);
  assert.ok(payload.codeExpiresInMinutes >= 1);

  // The slim pass: room slug in the opener, the code, the chair sentence.
  assert.match(payload.passText, /a FlurryPORT room: acme\/hook\./);
  assert.match(payload.passText, new RegExp(`Your pairing code is ${CODE}`));
  assert.match(payload.passText, /Your handle is coder\. The chair is gene\./);
  assert.match(payload.passText, /redeem_seat_code/);
  assert.equal(payload.meta.mode, 'authenticated');
});

test('mint_seat #284a: a name that is nothing but quotes and whitespace refuses before any API call', async () => {
  const { client, handler } = mintTool(roomRoutes());
  const result = await handler({ projectId: 'P1', endpointId: 'E1', guestName: ' "\'" ' });
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.error.code, 'empty_guest_name');
  assert.match(payload.error.message, /quotes and whitespace/);
  assert.equal(client.calls.length, 0, 'the server must never see the empty mint');
});

test('mint_seat #284a: surrounding quotes are stripped, interior ones survive', async () => {
  const { client, handler } = mintTool({
    ...roomRoutes(),
    'POST /api/v1/endpoints/E1/invites/seat': (body) => ({ ...mintRelease, ParticipantName: body.GuestName }),
  });
  await handler({ projectId: 'P1', endpointId: 'E1', guestName: ' "o\'brien" ' });
  const mint = client.calls.find((c) => c.method === 'POST');
  assert.equal(mint.body.GuestName, "o'brien");
});

test('mint_seat without seatServerUrl: the pass carries the hosted rooms address beside the API (#346)', async () => {
  delete process.env.FLURRYPORT_ROOMS_URL;
  const { handler } = mintTool(roomRoutes());
  const result = await handler({ projectId: 'P1', endpointId: 'E1', guestName: 'coder', chairAddress: 'gene' });
  const payload = JSON.parse(result.content[0].text);
  assert.match(payload.passText, /Seat server: http:\/\/127\.0\.0\.1:9\/rooms\/mcp \(MCP over streamable HTTP\)\./);
  assert.match(payload.passText, /GET http:\/\/127\.0\.0\.1:9\/rooms\/whoami/);
  assert.doesNotMatch(payload.passText, /the host runs flurryport seat-server/);
});

test('mint_seat with seatServerUrl: the pass names the server and derives its /whoami preflight', async () => {
  const { handler } = mintTool(roomRoutes());
  const result = await handler({
    projectId: 'P1', endpointId: 'E1', guestName: 'coder',
    seatServerUrl: 'http://10.0.0.5:8791/mcp', chairAddress: 'gene',
  });
  const payload = JSON.parse(result.content[0].text);
  assert.match(payload.passText, /Seat server: http:\/\/10\.0\.0\.5:8791\/mcp \(MCP over streamable HTTP\)\./);
  assert.match(payload.passText, /GET http:\/\/10\.0\.0\.5:8791\/whoami/);
});

test('mint_seat chair fallback: no argument and no seeded identity omits the chair sentence honestly', async () => {
  const { handler } = mintTool(roomRoutes());
  const result = await handler({ projectId: 'P1', endpointId: 'E1', guestName: 'coder' });
  const payload = JSON.parse(result.content[0].text);
  assert.match(payload.passText, /Your handle is coder\.\n/);
  assert.ok(!payload.passText.includes('The chair is'), 'a mint surface never invents a chair address');
});

test('mint_seat chair fallback: the console-seeded identity answers when no argument is given', async () => {
  putChairIdentity('gene');
  try {
    const { handler } = mintTool(roomRoutes());
    const result = await handler({ projectId: 'P1', endpointId: 'E1', guestName: 'coder' });
    const payload = JSON.parse(result.content[0].text);
    assert.match(payload.passText, /The chair is gene\./);
  } finally {
    putChairIdentity('');
  }
});

test('mint_seat room slug is best-effort: a failed slug lookup degrades to the generic opener, never fails the mint', async () => {
  const { handler } = mintTool({
    'POST /api/v1/endpoints/E1/invites/seat': mintRelease,
    // No project/endpoint GET routes: the lookups throw, the mint already happened.
  });
  const result = await handler({ projectId: 'P1', endpointId: 'E1', guestName: 'coder', chairAddress: 'gene' });
  assert.ok(!result.isError, result.content[0].text);
  const payload = JSON.parse(result.content[0].text);
  assert.match(payload.passText, /^You have a seat at a FlurryPORT room\.\n/);
  assert.equal(payload.pairingCode, CODE);
});

test('mint_seat #351: codeMinutes rides the wire as CodeMinutes; omitted sends null (server default 10)', async () => {
  const { client, handler } = mintTool(roomRoutes());
  await handler({ projectId: 'P1', endpointId: 'E1', guestName: 'coder', codeMinutes: 45 });
  const mint = client.calls.find((c) => c.method === 'POST');
  assert.equal(mint.body.CodeMinutes, 45);

  const plain = mintTool(roomRoutes());
  await plain.handler({ projectId: 'P1', endpointId: 'E1', guestName: 'coder' });
  const plainMint = plain.client.calls.find((c) => c.method === 'POST');
  assert.equal(plainMint.body.CodeMinutes, null, 'no option means the server decides the code life');
});

test('mint_seat #351: the tool description states the default and the option', async () => {
  const tools = collectTools((s) => registerAuthTools(s, { client: fakeClient(), allowLan: false }));
  const description = String(tools.get('mint_seat').def.description);
  assert.match(description, /10 minutes/);
  assert.match(description, /codeMinutes/);
});

test('mint_seat #412: every pass carries the stay-or-go rule, standing by default', async () => {
  const { handler } = mintTool(roomRoutes());
  const standing = JSON.parse((await handler({
    projectId: 'P1', endpointId: 'E1', guestName: 'coder', chairAddress: 'gene',
  })).content[0].text);
  assert.equal(standing.lifecycle, 'standing');
  assert.match(standing.passText, /Seat lifecycle: standing\./);
  assert.match(standing.passText, /going-idle and STAY seated/);
  assert.match(standing.passText, /keep your MCP session and you keep the seat/);
  assert.match(standing.passText, /fp:bye only when leaving for good/);

  const burst = JSON.parse((await mintTool(roomRoutes()).handler({
    projectId: 'P1', endpointId: 'E1', guestName: 'coder', chairAddress: 'gene', lifecycle: 'burst',
  })).content[0].text);
  assert.equal(burst.lifecycle, 'burst');
  assert.match(burst.passText, /Seat lifecycle: burst\./);
  assert.match(burst.passText, /sign off with fp:bye/);
  assert.match(burst.passText, /fresh code comes with the next turn/);
  assert.doesNotMatch(burst.passText, /Seat lifecycle: standing/);
});
