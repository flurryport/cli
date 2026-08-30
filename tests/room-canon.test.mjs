// #359 get_canon on the owner surface. One fake Core API, one authed MCP session:
// the wire contract is what is under test - which route the tool drives, what the
// model passes versus what the server receives (opaque id in, GUID out), and that a
// section with nothing ratified still lists.
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
const COLLATE_GUID = randomUUID();
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
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'canon-test', version: '0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  };
  return { rpc, call, init };
}

const hits = { canon: [] };

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
      if (req.url === `${base}/canon` && req.method === 'GET') {
        hits.canon.push({ url: req.url, auth: req.headers.authorization ?? null });
        return json(200, {
          EndpointId: EID_GUID,
          OrientationCaptureId: null,
          ETag: '"abc123"',
          Sections: [
            {
              SectionHandle: 'marketing-voice',
              Description: 'How we talk.',
              RecapText: 'Plain words, no hype.',
              DecisionCaptureId: RULING_GUID,
              CollateCaptureId: COLLATE_GUID,
              RatifiedAt: '2026-08-22T12:00:00Z',
              CollectionId: COLLECTION_GUID,
              Superseded: false,
            },
            {
              SectionHandle: 'copy-mechanics',
              Description: 'Punctuation.',
              RecapText: null,
              DecisionCaptureId: null,
              CollateCaptureId: null,
              RatifiedAt: null,
              CollectionId: null,
              Superseded: false,
            },
          ],
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
      USERPROFILE: mkdtempSync(join(tmpdir(), 'fp-test-canon-')),
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

// ───────────────────────── #359 get_canon ─────────────────────────

test('get_canon reads the canon route and hands back opaque ids', async () => {
  const out = await mcp.call('get_canon', {});

  assert.equal(hits.canon.length, 1);
  assert.equal(hits.canon[0].auth, 'Bearer fp_testtoken');
  assert.equal(out.EndpointId, EB62);
  assert.equal(out.ETag, '"abc123"');
  const standing = out.Sections[0];
  assert.equal(standing.SectionHandle, 'marketing-voice');
  assert.equal(standing.RecapText, 'Plain words, no hype.');
  assert.equal(standing.DecisionCaptureId, guidToBase62(RULING_GUID), 'ids come back opaque');
  assert.equal(standing.CollateCaptureId, guidToBase62(COLLATE_GUID));
  assert.equal(standing.CollectionId, CB62);
  assert.equal(standing.Superseded, false);
});

test('get_canon lists a section with nothing ratified rather than hiding it', async () => {
  const out = await mcp.call('get_canon', { projectId: PB62, endpointId: EB62 });

  const empty = out.Sections.find((s) => s.SectionHandle === 'copy-mechanics');
  assert.equal(empty.RecapText, null);
  assert.equal(empty.DecisionCaptureId, null);
});

test('get_canon is a read tool whose description is a contract, not doctrine', async () => {
  const tools = (await mcp.rpc('tools/list', {})).result.tools;
  const tool = tools.find((t) => t.name === 'get_canon');
  assert.ok(tool, 'get_canon must be in the authed inventory');
  assert.equal(tool.annotations.readOnlyHint, true);
  for (const word of ['sectionHandle', 'recapText', 'decisionCaptureId', 'collateCaptureId', 'ratifiedAt', 'collectionId', 'superseded']) {
    assert.ok(tool.description.includes(word), `names the ${word} output`);
  }
  assert.ok(tool.description.includes('projectId'), 'names its inputs');
  assert.ok(!tool.description.includes('—'), 'no em dashes in user-facing copy');
});
