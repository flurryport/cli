// #365 request_seat: the monitor rail's one verb. A monitor reads a room and cannot
// post, so the ask for a pairing code used to leave the room and never come back.
// This lands it inside the room as an ordinary capture the host's watches can label.
//
// One fake Core API, one authed MCP session holding a monitor grant in the credential
// router: who may call it, what body lands on the capture URL, where it is addressed,
// and the refusal on a signed room (a monitor holds no key, so an unsigned post would
// bounce 401 and be stored as a refusal - the ask travels with the human instead).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'dist', 'index.js');
const { guidToBase62 } = await import('../dist/lib/base62.js');

const PID_GUID = randomUUID();
const EID_GUID = randomUUID();
const OWN_EID_GUID = randomUUID();
const CAPTURE_GUID = randomUUID();
const PB62 = guidToBase62(PID_GUID);
const EB62 = guidToBase62(EID_GUID);
const OWN_EB62 = guidToBase62(OWN_EID_GUID);

const MONITOR_TOKEN = 'fp_watcher_grant';
const OPERATOR_TOKEN = 'fp_operator';

function mcpClient(child) {
  let buf = ''; const pend = new Map(); let id = 0;
  child.stdout.on('data', (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); }
    }
  });
  const rpc = (method, params) => {
    const i = ++id;
    return new Promise((res, rej) => {
      pend.set(i, res);
      setTimeout(() => rej(new Error(`timeout ${method}`)), 30000);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    });
  };
  const call = async (name, args) =>
    JSON.parse((await rpc('tools/call', { name, arguments: args })).result.content[0].text);
  const init = async () => {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'request-seat-test', version: '0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  };
  return { rpc, call, init };
}

// Mutable room posture the individual tests drive.
let signingEnabled = false;
let roster = [{ Handle: 'director', Role: 'host' }, { Handle: 'envoy-alpha', Role: 'relayed' }];
let captureStatus = 200;
const posts = [];
const endpointReads = [];

function makeFake() {
  return createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

      if (req.url === `/api/v1/projects/${PB62}/plan`) {
        return json(200, { PlanTierId: 1, MaxMonthlyCaptures: 2500, CurrentMonthCaptures: 0, RetentionDays: 3 });
      }
      if (req.url === `/api/v1/projects/${PB62}/endpoints/${EB62}`) {
        endpointReads.push({ auth });
        return json(200, {
          Id: EID_GUID, ProjectId: PID_GUID, Name: 'Room', Slug: 'room',
          SigningEnabled: signingEnabled, Sections: [], Roster: roster,
        });
      }
      if (req.url === `/api/v1/projects/${PB62}/endpoints/${OWN_EB62}`) {
        return json(200, { Id: OWN_EID_GUID, ProjectId: PID_GUID, Name: 'Mine', Slug: 'mine', SigningEnabled: false, Roster: [] });
      }
      if (req.url === `/api/v1/capture/${PB62}/room` && req.method === 'POST') {
        posts.push({ body: JSON.parse(body), headers: req.headers });
        if (captureStatus === 429) return json(429, { title: 'throttled', detail: 'Slow down.' });
        return json(200, { captureId: CAPTURE_GUID, executions: [] });
      }
      json(404, { title: 'not_found', detail: `no fake for ${req.method} ${req.url}` });
    });
  });
}

let fake; let child; let mcp;

test.before(async () => {
  fake = makeFake();
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${fake.address().port}`;

  // A joined monitor grant on disk: the credential router rebuilds it at every boot,
  // which is exactly the session a monitor is sitting in.
  const home = mkdtempSync(join(tmpdir(), 'fp-test-request-seat-'));
  mkdirSync(join(home, '.flurryport'), { recursive: true });
  writeFileSync(join(home, '.flurryport', 'config.json'), JSON.stringify({
    activeEnvironment: 'test',
    environments: {
      test: {
        apiUrl,
        activeAccount: 'operator',
        accounts: {
          operator: { apiKey: OPERATOR_TOKEN },
          watcher: { apiKey: MONITOR_TOKEN, scopeEndpointId: EB62, scopeProjectId: PB62 },
        },
      },
    },
  }));

  child = spawn(process.execPath, [CLI, 'mcp'], {
    env: {
      ...process.env,
      FLURRYPORT_API_URL: apiUrl,
      FLURRYPORT_TOKEN: OPERATOR_TOKEN,
      USERPROFILE: home,
      HOME: home,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  mcp = mcpClient(child);
  await mcp.init();
});

test.after(() => {
  child?.kill();
  fake?.close();
});

test('a monitor lands an ordinary capture addressed to the host on the roster', async () => {
  posts.length = 0;
  const out = await mcp.call('request_seat', {
    projectId: PB62, endpointId: EB62,
    reason: 'I have been reading the sitting and can take the copy-mechanics section.',
  });

  assert.equal(out.status, 'asked', JSON.stringify(out));
  assert.equal(out.captureId, guidToBase62(CAPTURE_GUID));
  assert.equal(out.to, 'director', 'the roster names a host, so the ask is addressed to it');
  assert.equal(out.from, 'watcher', 'the monitor speaks under the participant name its grant parks as');

  assert.equal(posts.length, 1);
  const wire = posts[0].body;
  assert.equal(wire.v, 1);
  assert.equal(wire.kind, 'message');
  assert.equal(wire.verb, 'fp:request-seat');
  assert.equal(wire.from, 'watcher');
  assert.equal(wire.to, 'director');
  assert.match(wire.text, /copy-mechanics/);
  assert.equal(wire.summary, 'Seat request from watcher');
  assert.ok(!('signature' in posts[0].headers), 'a monitor holds no key, so nothing is signed');
  assert.equal(posts[0].headers['x-flurry-signature'], undefined);
});

test('the endpoint read answers as the monitor grant, not the signed-in account', async () => {
  assert.ok(endpointReads.length > 0);
  assert.equal(endpointReads.at(-1).auth, MONITOR_TOKEN);
});

test('with no host on the roster the ask goes to the open room', async () => {
  posts.length = 0;
  roster = [{ Handle: 'envoy-alpha', Role: 'relayed' }];
  try {
    const out = await mcp.call('request_seat', { projectId: PB62, endpointId: EB62, reason: 'Asking the room.' });
    assert.equal(out.to, 'all');
    assert.equal(posts[0].body.to, 'all');
  } finally {
    roster = [{ Handle: 'director', Role: 'host' }, { Handle: 'envoy-alpha', Role: 'relayed' }];
  }
});

test('omitting ids resolves the one JOINED grant, never the operator scope (#370)', async () => {
  posts.length = 0;
  const out = await mcp.call('request_seat', { reason: 'No ids: the joined room is the scope.' });

  assert.equal(out.status, 'asked', JSON.stringify(out));
  assert.equal(posts.length, 1, 'the ask landed on the JOINED room');
  assert.equal(posts[0].body.verb, 'fp:request-seat');
  assert.equal(out.from, 'watcher', 'resolved to the grant, so the read answers as the monitor');
});

test('a signed room refuses the verb and sends nothing, saying not yet: carry the ask (#370)', async () => {
  posts.length = 0;
  signingEnabled = true;
  try {
    const out = await mcp.call('request_seat', { projectId: PB62, endpointId: EB62, reason: 'Please.' });
    assert.equal(out.error.code, 'signing_on_no_key', JSON.stringify(out));
    assert.match(out.error.message, /mint_seat/);
    assert.match(out.error.message, /Nothing was sent/);
    // #370: the refusal says the lane does not exist YET, never that it is by design.
    assert.match(out.error.message, /no platform-signed lane for this yet/);
    assert.match(out.error.message, /carry the ask/);
    assert.equal(posts.length, 0, 'a post that would bounce 401 is never made');
  } finally {
    signingEnabled = false;
  }
});

test('an owner credential is refused: it already speaks in its own room', async () => {
  posts.length = 0;
  const out = await mcp.call('request_seat', { projectId: PB62, endpointId: OWN_EB62, reason: 'Let me in.' });

  assert.equal(out.error.code, 'not_a_monitor', JSON.stringify(out));
  assert.match(out.error.message, /post_intent/);
  assert.equal(posts.length, 0);
});

test('a throttled capture path is relayed as throttled, not retried', async () => {
  posts.length = 0;
  captureStatus = 429;
  try {
    const out = await mcp.call('request_seat', { projectId: PB62, endpointId: EB62, reason: 'Once more.' });
    assert.equal(out.error.code, 'throttled', JSON.stringify(out));
    assert.equal(posts.length, 1, 'one attempt, no loop');
  } finally {
    captureStatus = 200;
  }
});

test('request_seat is in the authed inventory and says what it is', async () => {
  const tools = (await mcp.rpc('tools/list', {})).result.tools;
  const tool = tools.find((t) => t.name === 'request_seat');
  assert.ok(tool, 'request_seat must be in the authed inventory');
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.match(tool.description, /monitor/);
  assert.match(tool.description, /New in 0\.6\.0/);
  assert.ok(!tool.description.includes('—'), 'no em dashes in user-facing copy');
});
