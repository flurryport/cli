// Slice 3 regression net (#360, #357, #364):
//  A. #360b — the post receipt relays the server-computed diff summary for a
//     re-linked proposal, and stays silent for every other post.
//  B. #357 — fp:refuse carries a reason from the closed vocabulary
//     routing | wording | substance, everywhere the wire schema is documented.
//  C. #364 — the seat small things: bodies by default, the 60-second wait warning,
//     the kind vocabulary told straight, the `finding` status state, and `since`
//     notes on the verbs that are new in 0.6.0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'index.js');

process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'fp-slice3-home-'));
process.env.HOME = process.env.USERPROFILE;

const { parseCaptureReceipt } = await import('../dist/lib/intent-post.js');
const { registerSeatTools } = await import('../dist/lib/mcp-seat-tools.js');
const { registerAuthTools } = await import('../dist/lib/mcp-auth-tools.js');
const { collectTools } = await import('../dist/lib/mcp-unified.js');
const { seatServerInstructions } = await import('../dist/lib/mcp-server-instructions.js');
const { consoleMessages, verbHelp } = await import('../dist/lib/console-messages.js');

// ───────────────────── A. #360b the diff summary on the receipt ─────────────────────

test('parseCaptureReceipt relays postDiff, and answers null for the shapes that carry none', async () => {
  const res = (obj) => new Response(JSON.stringify(obj), { status: 200 });
  const withDiff = await parseCaptureReceipt(res({
    captureId: '11111111-1111-1111-1111-111111111111',
    executions: [],
    postDiff: { section: 'marketing-voice', linesAdded: 2, linesRemoved: 1, linesChanged: 3, unchanged: false, oversize: false },
  }));
  assert.deepEqual(withDiff.postDiff, {
    section: 'marketing-voice', linesAdded: 2, linesRemoved: 1, linesChanged: 3, unchanged: false, oversize: false,
  });

  // An ordinary post carries none, and an older server carries no member at all.
  assert.equal((await parseCaptureReceipt(res({ captureId: null, executions: [] }))).postDiff, null);
  assert.equal((await parseCaptureReceipt(res({ postDiff: 'nonsense' }))).postDiff, null);
  assert.equal((await parseCaptureReceipt(new Response('', { status: 200 }))).postDiff, null);
});

function startCaptureFake(receipt) {
  const seen = [];
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/api/v1/projects/P1/plan') {
        return json(200, { PlanTierId: 1, MaxMonthlyCaptures: 2500, CurrentMonthCaptures: 0, RetentionDays: 3 });
      }
      if (req.url === '/api/v1/projects/P1/endpoints/EP1') {
        return json(200, { Id: 'EP1', ProjectId: 'P1', Name: 'room', Slug: 'room', SigningEnabled: false, SigningHeader: null });
      }
      if (req.url === '/api/v1/capture/P1/room' && req.method === 'POST') {
        seen.push(body);
        return json(200, receipt(body));
      }
      json(404, { title: 'not_found', detail: `no fake for ${req.method} ${req.url}` });
    });
  });
  return { srv, seen };
}

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
    return new Promise((resolve, reject) => {
      pend.set(i, resolve);
      setTimeout(() => reject(new Error(`timeout ${method}`)), 30000);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    });
  };
  return {
    call: async (name, args) => JSON.parse((await rpc('tools/call', { name, arguments: args })).result.content[0].text),
    init: async () => {
      await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'slice3', version: '0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    },
  };
}

test('post_intent: a re-linked proposal receipt carries postDiff; an ordinary post does not', async () => {
  // The server decides: it answers postDiff only for the proposal, and the tool
  // relays what it was told without ever diffing anything itself.
  const { srv, seen } = startCaptureFake((body) =>
    body.includes('fp:propose')
      ? { captureId: '11111111-1111-1111-1111-111111111111', executions: [], postDiff: { section: 'marketing-voice', linesAdded: 1, linesRemoved: 0, linesChanged: 2, unchanged: false, oversize: false } }
      : { captureId: '22222222-2222-2222-2222-222222222222', executions: [], postDiff: null });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, [CLI, 'mcp'], {
    env: {
      ...process.env,
      FLURRYPORT_API_URL: `http://127.0.0.1:${srv.address().port}`,
      FLURRYPORT_TOKEN: 'fp_testtoken',
      USERPROFILE: mkdtempSync(join(tmpdir(), 'fp-slice3-mcp-')),
      HOME: process.env.USERPROFILE,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const mcp = mcpClient(child);
  try {
    await mcp.init();
    const proposal = await mcp.call('post_intent', {
      projectId: 'P1', endpointId: 'EP1',
      body: JSON.stringify({ v: 1, kind: 'message', from: 'envoy-alpha', to: 'marketing-voice', verb: 'fp:propose', re: '7VCvNe', text: 'plain words' }),
    });
    assert.equal(proposal.status, 'accepted');
    assert.equal(proposal.postDiff.section, 'marketing-voice');
    assert.equal(proposal.postDiff.linesChanged, 2);
    assert.equal(proposal.postDiff.unchanged, false);

    const chatter = await mcp.call('post_intent', {
      projectId: 'P1', endpointId: 'EP1',
      body: JSON.stringify({ v: 1, kind: 'message', from: 'envoy-alpha', to: 'all', text: 'just talking' }),
    });
    assert.equal(chatter.postDiff, null, 'an ordinary post earns no diff');
    assert.equal(seen.length, 2);
  } finally {
    child.kill();
    srv.close();
  }
});

test('post_intent describes the routing refusal and the diff on both surfaces (#360)', () => {
  const owner = collectTools((s) => registerAuthTools(s, { client: { baseUrl: 'http://127.0.0.1:9', get: async () => ({}) }, quota: 'none' }));
  const ownerDesc = String(owner.get('post_intent').def.description);
  assert.match(ownerDesc, /postDiff \{section, linesAdded, linesRemoved, linesChanged, unchanged, oversize\}/);
  // #374: the refusal is about naming a section with `for`; `to` is never gated.
  assert.match(ownerDesc, /refused before storage and the error names the handles/);
  assert.match(ownerDesc, /never gated/);

  const seat = collectTools((s) => registerSeatTools(s, { apiBase: 'http://127.0.0.1:9' }));
  const seatDesc = String(seat.get('post_intent').def.description);
  assert.match(seatDesc, /section handle from list_sections/);
  assert.match(seatDesc, /earns postDiff on the receipt/);
});

// ───────────────────── B. #357 the refuse reason vocabulary ─────────────────────

test('fp:refuse carries a reason from the closed vocabulary, wherever the wire is documented (#357)', async () => {
  // #403 slim: the block keeps the vocabulary itself; the per-reason glosses live
  // on the published wire page the block points at.
  const block = seatServerInstructions('0.6.0');
  assert.match(block, /fp:refuse with a reason member: routing, wording, or substance/);
  assert.match(block, /catalog page \/recipes\/wire/);

  // The attention wake-up teaches the same answer shape.
  const { attentionNotice } = await import('../dist/lib/mcp-meta.js');
  const panic = attentionNotice({ code: 'attention_interrupt', panic: true });
  assert.match(panic.message, /fp:refuse carrying reason routing, wording, or substance/);

  // And the console's own help for the verb that expects an answer.
  assert.match(verbHelp.install, /fp:refuse with reason routing, wording, or substance/);
  assert.ok(consoleMessages, 'the console message table still loads');
});

// ───────────────────── C. #364 the seat small things ─────────────────────

test('seat list_captures says bodies ride by default (#364a)', () => {
  const seat = collectTools((s) => registerSeatTools(s, { apiBase: 'http://127.0.0.1:9' }));
  const desc = String(seat.get('list_captures').def.description);
  assert.match(desc, /bodies ride by DEFAULT here \(includeBody:true unless you pass false\)/);
  assert.match(desc, /reads as an empty room/);
});

test('wait_for_posts warns that the hold can outlast a harness shell timeout (#364b)', () => {
  const seat = collectTools((s) => registerSeatTools(s, { apiBase: 'http://127.0.0.1:9' }));
  const desc = String(seat.get('wait_for_posts').def.description);
  assert.match(desc, /can hold for a full 60 seconds/);
  assert.match(desc, /default command timeout some agent harnesses put on a shell/);
});

test('the kind vocabulary is told straight: no decision kind, the verb marks the act (#364c, #403 slim)', () => {
  const block = seatServerInstructions('0.6.0');
  assert.match(block, /kind is message, whisper, or scratch, and nothing else/);
  assert.match(block, /the verb marks the act/);
});

test('the status vocabulary keeps finding, with the detail on the wire page (#364d, #403 slim)', () => {
  const block = seatServerInstructions('0.6.0');
  assert.match(block, /starting, working, review, waiting, blocked-on-human, going-idle, done, finding/);
  assert.match(block, /catalog page \/recipes\/wire/);
});

test('the verbs new in 0.6.0 say so, so stale notes self-correct (#364e)', () => {
  const owner = collectTools((s) => registerAuthTools(s, { client: { baseUrl: 'http://127.0.0.1:9', get: async () => ({}) }, quota: 'none' }));
  for (const name of ['get_canon', 'list_sections', 'remove_from_collection', 'replace_collection_item']) {
    const desc = String(owner.get(name).def.description);
    assert.match(desc, /New in 0\.6\.0: notes that do not mention it are stale\./, name);
  }
  // The seat mounts the same registrations, so the note rides there too.
  const seat = collectTools((s) => registerSeatTools(s, { apiBase: 'http://127.0.0.1:9' }));
  for (const name of ['get_canon', 'list_sections']) {
    assert.match(String(seat.get(name).def.description), /New in 0\.6\.0/, name);
  }
});
