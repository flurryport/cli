// #348 the owner-only collection edits: remove_from_collection and the atomic
// replace_collection_item. One fake Core API, one authed MCP session: which route
// each tool drives, what the model passes versus what the server receives (opaque
// id in, GUID out), and that a 409 refusal is relayed rather than reinterpreted.
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
const COLLECTION_GUID = randomUUID();
const RULING_GUID = randomUUID();
const REPLACEMENT_GUID = randomUUID();
const PB62 = guidToBase62(PID_GUID);
const EB62 = guidToBase62(EID_GUID);
const CB62 = guidToBase62(COLLECTION_GUID);

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
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'collection-edits-test', version: '0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  };
  return { rpc, call, init };
}

const hits = { removes: [], replaces: [] };
let replaceStatus = 200;

function makeFake() {
  return createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const base = `/api/v1/projects/${PB62}/endpoints/${EB62}`;

      if (req.url === '/api/v1/projects') {
        return json(200, { Projects: [{ Id: PID_GUID, Name: 'P', Slug: 'p', Suspended: false, CreatedAt: new Date().toISOString() }] });
      }
      if (req.url === `/api/v1/projects/${PB62}/endpoints`) {
        return json(200, { Endpoints: [{ Id: EID_GUID, Slug: 'room', Name: 'Room' }] });
      }
      if (req.url === `/api/v1/projects/${PB62}/plan`) {
        return json(200, { PlanTierId: 1, MaxMonthlyCaptures: 2500, CurrentMonthCaptures: 0, RetentionDays: 3 });
      }
      if (req.url === `${base}/collections/${CB62}/remove-captures` && req.method === 'POST') {
        hits.removes.push(JSON.parse(body));
        return json(200, { RemovedCount: 1 });
      }
      if (req.url === `${base}/collections/${CB62}/replace-item` && req.method === 'POST') {
        hits.replaces.push(JSON.parse(body));
        if (replaceStatus === 409) {
          return json(409, { title: 'collection_item_absent', detail: 'The capture to replace is not in this collection.' });
        }
        return json(200, {
          CollectionId: COLLECTION_GUID,
          SectionLabel: 'marketing-voice',
          RemovedCaptureId: RULING_GUID,
          AddedCaptureId: REPLACEMENT_GUID,
          WasAlreadyPresent: false,
          ItemCount: 2,
        });
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
      USERPROFILE: mkdtempSync(join(tmpdir(), 'fp-test-collection-edits-')),
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

// ───────────────────────── #348 collection edits ─────────────────────────

test('remove_from_collection sends GUIDs to the remove route', async () => {
  const out = await mcp.call('remove_from_collection', { collectionId: CB62, captureId: guidToBase62(RULING_GUID) });

  assert.equal(hits.removes.length, 1);
  assert.deepEqual(hits.removes[0].CapturedRequestIds, [RULING_GUID]);
  assert.equal(out.RemovedCount, 1);
  assert.ok(out.hint.includes('retention'), 'the receipt says what unpinning means');
});

test('replace_collection_item drives one call carrying both ids and the section label', async () => {
  const out = await mcp.call('replace_collection_item', {
    collectionId: CB62,
    sectionLabel: 'marketing-voice',
    previousCaptureId: guidToBase62(RULING_GUID),
    replacementCaptureId: guidToBase62(REPLACEMENT_GUID),
  });

  assert.equal(hits.replaces.length, 1);
  const sent = hits.replaces[0];
  assert.equal(sent.PreviousCapturedRequestId, RULING_GUID);
  assert.equal(sent.ReplacementCapturedRequestId, REPLACEMENT_GUID);
  assert.equal(sent.SectionLabel, 'marketing-voice');
  assert.equal(out.RemovedCaptureId, guidToBase62(RULING_GUID), "ids come back opaque");
  assert.equal(out.AddedCaptureId, guidToBase62(REPLACEMENT_GUID));
  assert.equal(out.ItemCount, 2);
});

test('replace_collection_item relays the 409 when the previous capture is not there', async () => {
  replaceStatus = 409;
  try {
    const out = await mcp.call('replace_collection_item', {
      collectionId: CB62,
      sectionLabel: 'marketing-voice',
      previousCaptureId: guidToBase62(RULING_GUID),
      replacementCaptureId: guidToBase62(REPLACEMENT_GUID),
    });
    assert.equal(out.error.code, 'collection_item_absent');
    assert.match(out.error.message, /not in this collection/);
  } finally {
    replaceStatus = 200;
  }
});

test('a malformed id is refused locally, with nothing sent', async () => {
  const before = hits.replaces.length;

  const bad = await mcp.call('replace_collection_item', {
    collectionId: CB62,
    previousCaptureId: 'not-an-id!!',
    replacementCaptureId: guidToBase62(REPLACEMENT_GUID),
  });

  assert.equal(bad.error.code, 'validation');
  assert.equal(hits.replaces.length, before, 'nothing went over the wire');
});

test('the collection edits are write tools, owner-only by their route, and say so', async () => {
  const tools = (await mcp.rpc('tools/list', {})).result.tools;
  for (const name of ['remove_from_collection', 'replace_collection_item']) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} must be in the authed inventory`);
    assert.equal(tool.annotations.readOnlyHint, false, name);
    assert.ok(tool.description.toLowerCase().includes('owner'), `${name} names the owner boundary`);
    assert.ok(!tool.description.includes('—'), `${name}: no em dashes in user-facing copy`);
  }
});
