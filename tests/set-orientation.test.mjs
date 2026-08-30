// #343 orientation lock (ruled 2026-08-21): set_orientation drives
// PUT /api/v1/projects/{p}/endpoints/{e}/orientation with { CapturedRequestId }.
// One retention-exempt capture per room on every plan; the pointer follows the
// newest orientation and null releases it. Owner-only is enforced server-side
// (404 for a seat or member), so here we lock the wire contract: the id the
// model passes (base62) arrives at the server as the GUID, ids come back opaque,
// the set/clear arguments are mutually exclusive, and a 404 is relayed verbatim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'dist', 'index.js');
const { guidToBase62 } = await import('../dist/lib/base62.js');

const PID_GUID = randomUUID();
const EID_GUID = randomUUID();
const PB62 = guidToBase62(PID_GUID);
const EB62 = guidToBase62(EID_GUID);
const FOREIGN_EB62 = guidToBase62(randomUUID());

const jsonRes = (res) => (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

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
  const call = async (name, args) => JSON.parse((await rpc('tools/call', { name, arguments: args })).result.content[0].text);
  const init = async () => {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'orientation-test', version: '0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  };
  return { rpc, call, init };
}

// The fake keeps the pointer like the real endpoint row does, so "previous" is real.
const puts = [];
let orientation = null;
// #363: the fake keeps the room state the way the endpoint row does, so a read after
// a write answers what was actually stored.
const state = { sections: [], roster: [] };

function makeFake() {
  return createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const json = jsonRes(res);
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.url === '/api/v1/projects') {
        return json(200, { Projects: [{ Id: PID_GUID, Name: 'P', Slug: 'p', Suspended: false, CreatedAt: new Date().toISOString() }] });
      }
      if (req.url === `/api/v1/projects/${PB62}/endpoints`) {
        return json(200, { Endpoints: [{ Id: EID_GUID, Slug: 'room', Name: 'Room' }] });
      }
      if (req.url === `/api/v1/projects/${PB62}/plan`) {
        return json(200, { PlanTierId: 1, MaxMonthlyCaptures: 2500, CurrentMonthCaptures: 0, RetentionDays: 3 });
      }
      if (req.url === `/api/v1/projects/${PB62}/endpoints/${EB62}/orientation` && req.method === 'PUT') {
        const parsed = JSON.parse(body);
        puts.push({ headers: { ...req.headers }, body: parsed });
        const previous = parsed.StateOnly ? null : orientation;
        if (!parsed.StateOnly) orientation = parsed.CapturedRequestId ?? null;
        if (parsed.Sections) state.sections = parsed.Sections;
        if (parsed.Roster) state.roster = parsed.Roster;
        return json(200, {
          EndpointId: EID_GUID,
          OrientationCaptureId: orientation,
          PreviousOrientationCaptureId: previous,
          Sections: state.sections,
          Roster: state.roster,
        });
      }
      if (req.url === `/api/v1/projects/${PB62}/endpoints/${EB62}/sections` && req.method === 'GET') {
        return json(200, {
          EndpointId: EID_GUID,
          OrientationCaptureId: orientation,
          Sections: state.sections,
          Roster: state.roster,
        });
      }
      if (req.url === `/api/v1/projects/${PB62}/endpoints/${FOREIGN_EB62}/orientation` && req.method === 'PUT') {
        // Non-owner (seat/member) or foreign endpoint: tenant isolation answers 404.
        return json(404, { title: 'not_found', detail: 'Not found.' });
      }
      json(404, { title: 'not_found', detail: `no fake for ${req.method} ${req.url}` });
    });
  });
}

let fake; let child; let mcp;

test.before(async () => {
  fake = makeFake();
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  child = spawn(process.execPath, [CLI, 'mcp'], {
    env: {
      ...process.env,
      FLURRYPORT_API_URL: `http://127.0.0.1:${fake.address().port}`,
      FLURRYPORT_TOKEN: 'fp_testtoken',
      USERPROFILE: mkdtempSync(join(tmpdir(), 'fp-test-orientation-')),
      HOME: process.env.USERPROFILE,
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

test('set_orientation is registered as a write tool with the orientation vocabulary', async () => {
  const tools = (await mcp.rpc('tools/list', {})).result.tools;
  const tool = tools.find((t) => t.name === 'set_orientation');
  assert.ok(tool, 'set_orientation must be in the authed inventory');
  assert.ok(tool.description.includes('ORIENTATION'));
  assert.ok(tool.description.includes('OrientationCaptureId'), 'names the get_endpoint field seats read');
  assert.ok(!tool.description.includes('—'), 'no em dashes in user-facing copy');
  assert.equal(tool.annotations.readOnlyHint, false);
});

test('set_orientation: a base62 captureId reaches the server as the GUID; ids come back opaque', async () => {
  const captureGuid = randomUUID();
  const captureB62 = guidToBase62(captureGuid);

  const out = await mcp.call('set_orientation', { captureId: captureB62 });

  assert.equal(puts.length, 1, 'exactly one PUT');
  assert.equal(puts[0].body.CapturedRequestId, captureGuid, 'wire carries the GUID, not the opaque id');
  assert.equal(puts[0].headers.authorization, 'Bearer fp_testtoken');
  assert.equal(out.EndpointId, EB62, 'scope resolved to the only endpoint; id opaque');
  assert.equal(out.OrientationCaptureId, captureB62);
  assert.equal(out.PreviousOrientationCaptureId, null);
  assert.ok(out.hint.includes('Orientation set'));
  assert.ok(out.meta, 'meta block present');
});

test('set_orientation: moving to a newer capture reports the released previous id', async () => {
  const first = puts[0].body.CapturedRequestId;
  const second = randomUUID();

  const out = await mcp.call('set_orientation', { projectId: PB62, endpointId: EB62, captureId: guidToBase62(second) });

  assert.equal(puts.length, 2);
  assert.equal(out.OrientationCaptureId, guidToBase62(second));
  assert.equal(out.PreviousOrientationCaptureId, guidToBase62(first), 'the lock follows the newest orientation');
  assert.ok(out.hint.includes('released'));
});

test('set_orientation: clear: true sends null and releases the pointer', async () => {
  const current = puts[1].body.CapturedRequestId;

  const out = await mcp.call('set_orientation', { clear: true });

  assert.equal(puts.length, 3);
  assert.equal(puts[2].body.CapturedRequestId, null);
  assert.equal(out.OrientationCaptureId, null);
  assert.equal(out.PreviousOrientationCaptureId, guidToBase62(current));
  assert.ok(out.hint.includes('Orientation released'));
});

test('set_orientation: captureId and clear are mutually exclusive and one is required (no PUT)', async () => {
  const before = puts.length;

  const neither = await mcp.call('set_orientation', {});
  const both = await mcp.call('set_orientation', { captureId: guidToBase62(randomUUID()), clear: true });
  const bad = await mcp.call('set_orientation', { captureId: 'not-an-id!!' });

  assert.equal(neither.error.code, 'validation');
  assert.equal(both.error.code, 'validation');
  assert.equal(bad.error.code, 'validation');
  assert.equal(puts.length, before, 'nothing went over the wire');
});

test('set_orientation: a non-owner (seat or member) gets the server 404 relayed, never an oracle', async () => {
  const out = await mcp.call('set_orientation', { projectId: PB62, endpointId: FOREIGN_EB62, captureId: guidToBase62(randomUUID()) });

  assert.equal(out.error.code, 'not_found');
});

// ───────────────────────── #363 room state ─────────────────────────

test('set_orientation: sections and roster ride the same PUT in server casing', async () => {
  const before = puts.length;

  const out = await mcp.call('set_orientation', {
    clear: true,
    sections: [{ handle: 'marketing-voice', description: 'How we talk about the product.' }],
    roster: [{ handle: 'claude-code-mkt', role: 'producer' }],
  });

  assert.equal(puts.length, before + 1);
  const sent = puts.at(-1).body;
  assert.deepEqual(sent.Sections, [{ Handle: 'marketing-voice', Description: 'How we talk about the product.' }]);
  assert.deepEqual(sent.Roster, [{ Handle: 'claude-code-mkt', Role: 'producer' }]);
  assert.equal(sent.StateOnly, false, 'clear: true still moves the lock');
  assert.equal(out.Sections.length, 1);
});

test('set_orientation: sections alone is a state-only call that leaves the lock alone', async () => {
  const capture = randomUUID();
  await mcp.call('set_orientation', { captureId: guidToBase62(capture) });
  const before = puts.length;

  const out = await mcp.call('set_orientation', { sections: [{ handle: 'copy-mechanics', description: 'Punctuation and casing.' }] });

  assert.equal(puts.length, before + 1);
  const sent = puts.at(-1).body;
  assert.equal(sent.StateOnly, true, 'no captureId and no clear means the lock is untouched');
  assert.equal(sent.CapturedRequestId, null);
  assert.equal(sent.Roster, null, 'an omitted roster is null, not an empty list');
  assert.equal(out.OrientationCaptureId, guidToBase62(capture), 'the lock survived the state edit');
});

test('set_orientation: an empty sections array clears the map', async () => {
  await mcp.call('set_orientation', { sections: [] });

  assert.deepEqual(puts.at(-1).body.Sections, []);
});

test('set_orientation: the schema names the handle grammar and the closed role set', async () => {
  const tools = (await mcp.rpc('tools/list', {})).result.tools;
  const tool = tools.find((t) => t.name === 'set_orientation');
  const roles = tool.inputSchema.properties.roster.items.properties.role.enum;
  assert.deepEqual(roles, ['host', 'chair', 'producer', 'monitor', 'relayed']);
  assert.equal(tool.inputSchema.properties.sections.items.properties.handle.maxLength, 40);
  assert.equal(tool.inputSchema.properties.sections.items.properties.description.maxLength, 200);
  assert.ok(!tool.description.includes('—'), 'no em dashes in user-facing copy');
});

test('list_sections reads the room state back, ids opaque', async () => {
  await mcp.call('set_orientation', {
    sections: [{ handle: 'marketing-voice', description: 'How we talk.' }],
    roster: [{ handle: 'ann', role: 'chair' }],
  });

  const out = await mcp.call('list_sections', {});

  assert.equal(out.EndpointId, EB62, 'ids come back opaque');
  assert.deepEqual(out.Sections, [{ Handle: 'marketing-voice', Description: 'How we talk.' }]);
  assert.deepEqual(out.Roster, [{ Handle: 'ann', Role: 'chair' }]);
});

test('list_sections is a read tool whose description states inputs and outputs', async () => {
  const tools = (await mcp.rpc('tools/list', {})).result.tools;
  const tool = tools.find((t) => t.name === 'list_sections');
  assert.ok(tool, 'list_sections must be in the authed inventory');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.ok(tool.description.includes('sections[]'), 'names its outputs');
  assert.ok(tool.description.includes('projectId'), 'names its inputs');
  assert.ok(!tool.description.includes('—'), 'no em dashes in user-facing copy');
});
