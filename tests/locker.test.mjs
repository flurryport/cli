// Locker (slice 2 of the platform pass, 2026-11-05). Two locks: the receipt vector file the
// C# writer generated (Core/docs/receipts/locker-receipt-vectors.json) verifies byte for
// byte through the TypeScript module, so the two implementations of the spec cannot drift;
// and the five tools drive the Locker routes with the shapes the server emits, with the
// install key never leaving the tool layer and the agent install named after the MCP client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'dist', 'index.js');
const receipts = await import('../dist/lib/receipts.js');
const { guidToBase62 } = await import('../dist/lib/base62.js');

const VECTORS = JSON.parse(readFileSync(join(__dirname, '..', '..', 'docs', 'receipts', 'locker-receipt-vectors.json'), 'utf8'));

// ───────────────────────── A. the vector lock ─────────────────────────

test('jcs matches the RFC 8785 sample and the number vectors', () => {
  assert.equal(receipts.jcs(JSON.parse(VECTORS.jcs.rfcSample.input)), VECTORS.jcs.rfcSample.canonical);
  for (const n of VECTORS.jcs.numbers) {
    assert.equal(receipts.jcs(JSON.parse(n.input)), n.output, `number ${n.input}`);
  }
});

test('the leaf tree reproduces every salt, hash and the root, and the disclosure document keeps the root', async () => {
  const leaf = VECTORS.leafTree;
  const secret = Uint8Array.from(Buffer.from(leaf.leafSecret, 'hex'));
  const body = JSON.parse(leaf.body);
  assert.equal(await receipts.sha256Hex(leaf.body), leaf.bodySha256);

  const leaves = receipts.enumerateLeaves(body);
  assert.deepEqual(leaves.map((l) => l.path), [...leaf.leaves.map((l) => l.path)].sort(), 'the same leaves; the verifier sorts by path, the root does too');
  for (const l of leaf.leaves) {
    const salt = await receipts.leafSalt(secret, l.path);
    assert.equal(salt, l.salt, `salt for ${l.path}`);
    const value = leaves.find((x) => x.path === l.path).value;
    assert.equal(receipts.jcs(value), l.canonicalValue, `canonical value for ${l.path}`);
    assert.equal(await receipts.leafHash(salt, l.path, receipts.jcs(value)), l.hash, `hash for ${l.path}`);
  }
  assert.equal(await receipts.leafRootOfBody(body, secret), leaf.leafRoot);

  const disclosure = JSON.parse(leaf.disclosure);
  assert.ok(receipts.isDisclosure(disclosure));
  assert.equal(await receipts.leafRootOfDisclosure(disclosure), leaf.leafRoot, 'a redacted field still verifies');
  assert.deepEqual(receipts.redactedPathsOf(disclosure).sort(), [...leaf.redactPaths].sort());
  assert.ok(!leaf.disclosure.includes('pat@example.com'), 'the redacted value is gone');

  const tampered = JSON.parse(leaf.disclosure.replace('"Order to invoice"', '"Order to nowhere"'));
  assert.notEqual(await receipts.leafRootOfDisclosure(tampered), leaf.leafRoot);
});

test('the signed receipts verify, link, and the tampered one fails', async () => {
  const chain = VECTORS.chain;
  const parsed = chain.receipts.map((r) => receipts.parseReceipt(r));
  assert.ok(parsed.every(Boolean), 'every vector receipt parses');
  parsed.forEach((r, i) => assert.equal(receipts.canonicalCore(r), chain.canonicals[i], `canonical core ${i}`));
  for (const r of parsed) {
    assert.equal(await receipts.receiptHash(r), r.hash);
    assert.ok(await receipts.verifySignature(r), `signature on receipt ${r.chainIndex}`);
  }
  assert.equal(await receipts.thumbprint(chain.publicKeyJwk), chain.keyId);

  const run = await receipts.verifyReceipts(parsed);
  assert.equal(run.intact, true);
  assert.equal(run.signaturesValid, true);
  assert.equal(run.nextPrevHash, chain.nextPrevHash);
  assert.deepEqual(run.keyIds, [chain.keyId]);

  // Pinned to the right key it passes; pinned to a different key it fails on every receipt.
  assert.equal((await receipts.verifyReceipts(parsed, { publicKey: chain.publicKeyJwk })).signaturesValid, true);
  const other = { ...chain.publicKeyJwk, x: chain.publicKeyJwk.y, y: chain.publicKeyJwk.x };
  assert.equal((await receipts.verifyReceipts(parsed, { publicKey: other })).signaturesValid, false);

  const tampered = receipts.parseReceipt(chain.tampered);
  assert.notEqual(await receipts.receiptHash(tampered), tampered.hash, 'the body hash changed after signing');
  assert.equal(await receipts.verifySignature(tampered), false);
  const broken = await receipts.verifyReceipts([parsed[0], tampered]);
  assert.equal(broken.intact, false);
  assert.equal(broken.brokenAt, 1);

  // The body checks: raw bytes by bodySha256, a disclosure document by leafRoot.
  const raw = await receipts.verifyBody(parsed[0], VECTORS.leafTree.body);
  assert.deepEqual({ mode: raw.mode, sha: raw.bodySha256Matches, root: raw.leafRootMatches }, { mode: 'raw', sha: true, root: null });
  const disc = await receipts.verifyBody(parsed[0], VECTORS.leafTree.disclosure);
  assert.deepEqual({ mode: disc.mode, sha: disc.bodySha256Matches, root: disc.leafRootMatches }, { mode: 'disclosure', sha: false, root: true });
  const redaction = await receipts.verifyBody(parsed[1], chain.redactionBody);
  assert.equal(redaction.bodySha256Matches, true, 'the redaction receipt names the redaction body');
});

// ───────────────────────── B. the tools ─────────────────────────

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
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Claude Code', version: '0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  };
  return { rpc, call, init };
}

const INSTALL_GUID = randomUUID();
const AGENT_GUID = randomUUID();
const ENDPOINT_GUID = randomUUID();
const PROJECT_GUID = randomUUID();
const RUN_GUID = randomUUID();
const INSTALL = guidToBase62(INSTALL_GUID);
const AGENT = guidToBase62(AGENT_GUID);
const RECEIPT = guidToBase62(RUN_GUID);
const allowance = { State: 'free', RunsIncluded: 250, RunsUsed: 1, RunsRemaining: 249, DaysIncluded: 14, DaysRemaining: 13, StartedAt: '2026-11-05T00:00:00Z', EndsAt: '2026-11-19T00:00:00Z', Exhausted: false, PlanUrl: 'http://web/billing' };
const vectorReceipt = JSON.stringify(VECTORS.chain.receipts[0]);
const hits = { creates: [], ensures: [], runs: [], searches: [] };

function makeFake() {
  return createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/api/v1/projects') return json(200, { Projects: [{ Id: PROJECT_GUID, Name: 'Locker', Slug: 'locker', Suspended: false, CreatedAt: new Date().toISOString() }] });
      if (req.url === '/api/v1/locker/installs' && req.method === 'GET') {
        return json(200, {
          Installs: [{ InstallId: INSTALL, EndpointId: guidToBase62(ENDPOINT_GUID), ProjectId: guidToBase62(PROJECT_GUID), ProjectSlug: 'locker', EndpointSlug: 'run-abc', Slug: 'http-nightly', Name: 'Nightly', Platform: 'http', Relation: 'owner', Role: null, RunsKept: 3, BytesKept: 900, LastRunAt: null, ChainIndex: 3, ChainHash: 'abc', KeyId: 'k', InstallKeyPrefix: 'fp_abc', CreatedAt: '2026-11-05T00:00:00Z' }],
          InstalledPlugin: true,
          Allowance: allowance,
        });
      }
      if (req.url === '/api/v1/locker/installs' && req.method === 'POST') {
        hits.creates.push(JSON.parse(body));
        return json(200, { InstallId: INSTALL, EndpointId: guidToBase62(ENDPOINT_GUID), ProjectId: guidToBase62(PROJECT_GUID), Slug: 'http-nightly', Name: 'Nightly', Platform: 'http', InstallKey: 'fp_THE_SECRET_KEY', InstallKeyPrefix: 'fp_THE_SECRE', SecretName: 'LOCKER_INSTALL_KEY_HTTP_NIGHTLY', InstalledPlugin: true, KeyId: 'k', KeyPageUrl: 'http://web/locker?install=' + INSTALL, Allowance: allowance });
      }
      if (req.url === '/api/v1/locker/installs/ensure' && req.method === 'POST') {
        hits.ensures.push(JSON.parse(body));
        return json(200, { InstallId: AGENT, EndpointId: guidToBase62(ENDPOINT_GUID), ProjectId: guidToBase62(PROJECT_GUID), Slug: 'agent-claude-code', Name: 'Claude Code', Platform: 'agent', Created: true, InstalledPlugin: true, KeyId: 'k', Allowance: allowance });
      }
      if (req.url === `/api/v1/locker/installs/${AGENT}/runs` && req.method === 'POST') {
        hits.runs.push({ headers: req.headers, body: JSON.parse(body) });
        return json(201, { ReceiptId: RECEIPT, VerifyUrl: 'http://web/receipts/' + RECEIPT, ChainIndex: 1, Hash: VECTORS.chain.receipts[0].hash, PrevHash: '', InstallId: AGENT, Receipt: vectorReceipt, StoredBytes: body.length, Duplicate: false, Allowance: allowance });
      }
      if (req.url.startsWith(`/api/v1/locker/installs/${INSTALL}/search?`) && req.method === 'GET') {
        hits.searches.push(req.url);
        return json(200, { Matches: [{ ReceiptId: RECEIPT, ChainIndex: 1, CapturedAt: '2026-11-05T18:02:13.004Z', WorkflowName: 'Slice 2', RunId: 'task-1', Status: 'success', SizeBytes: 120, Redacted: false, Paths: ['/inputs/email'] }], Scanned: 3, Truncated: false, ScannedThrough: '2026-11-05T18:02:13.004Z' });
      }
      if (req.url === `/api/v1/locker/runs/${RECEIPT}` && req.method === 'GET') {
        return json(200, { ReceiptId: RECEIPT, InstallId: AGENT, InstallName: 'Claude Code', InstallSlug: 'agent-claude-code', Platform: 'agent', Kind: 'run', WorkflowName: 'Slice 2', RunId: 'task-1', Status: 'success', StartedAt: null, FinishedAt: null, CapturedAt: '2026-11-05T18:02:13.004Z', Body: VECTORS.leafTree.body, BodyPurged: false, IsDisclosure: false, RedactedPaths: [], Receipt: vectorReceipt, ChainIndex: 1, Hash: VECTORS.chain.receipts[0].hash, PrevHash: '', BodySha256: VECTORS.leafTree.bodySha256, LeafRoot: VECTORS.leafTree.leafRoot, KeyId: VECTORS.chain.keyId, VerifyUrl: 'http://web/receipts/' + RECEIPT });
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
      USERPROFILE: mkdtempSync(join(tmpdir(), 'fp-test-locker-')),
      HOME: process.env.USERPROFILE,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  mcp = mcpClient(child);
  await mcp.init();
});

test.after(() => { child?.kill(); fake?.close(); });

test('the six tools are registered on the local server', async () => {
  const { result } = await mcp.rpc('tools/list', {});
  const names = result.tools.map((t) => t.name);
  for (const n of ['archive_run', 'get_locker_run', 'verify_receipt', 'list_locker_installs', 'create_locker_install', 'find_locker_runs']) {
    assert.ok(names.includes(n), `${n} registered`);
  }
});

test('find_locker_runs relays the matches with their paths and the scan facts', async () => {
  const out = await mcp.call('find_locker_runs', { installId: INSTALL, value: 'jane', since: '2026-11-01T00:00:00Z' });
  assert.equal(out.matches.length, 1);
  assert.equal(out.matches[0].receiptId, RECEIPT);
  assert.deepEqual(out.matches[0].paths, ['/inputs/email']);
  assert.equal(out.scanned, 3);
  assert.equal(out.truncated, false);
  assert.ok(out.summary.startsWith('1 matching run(s) in 3 scanned'));
  assert.ok(hits.searches[0].includes('q=jane') && hits.searches[0].includes('since=2026-11-01'), 'the value and the window go on the query string');
});

test('list_locker_installs relays the installs, the allowance and the actions', async () => {
  const out = await mcp.call('list_locker_installs', {});
  assert.equal(out.installs.length, 1);
  assert.equal(out.installs[0].installId, INSTALL);
  assert.equal(out.installs[0].relation, 'owner');
  assert.deepEqual(out.installs[0].chainHead, { position: 3, hash: 'abc' });
  assert.equal(out.allowance.runsRemaining, 249);
  assert.ok(out.installs[0].actions.some((a) => a.label === 'Show the install key'), 'the owner of an http install gets the key page');
  assert.ok(out.installs[0].actions.every((a) => typeof a.url === 'string' && a.effect));
});

test('create_locker_install never returns the key, only where it is', async () => {
  const out = await mcp.call('create_locker_install', { name: 'Nightly', platform: 'http' });
  const text = JSON.stringify(out);
  assert.ok(!text.includes('fp_THE_SECRET_KEY'), 'the install key must not reach the conversation');
  assert.equal(out.secretName, 'LOCKER_INSTALL_KEY_HTTP_NIGHTLY');
  assert.ok(out.keyPageUrl.includes(INSTALL));
  assert.equal(out.installedPlugin, true);
  assert.equal(hits.creates[0].StoreKeyAsSecret, true);
});

test('archive_run with no installId ensures the agent install named after the MCP client and posts the document', async () => {
  const out = await mcp.call('archive_run', {
    run: { workflow: { name: 'Slice 2' }, id: 'task-1', status: 'success', inputs: { brief: 'build it' }, outputs: { prs: 3 }, labels: { pr: '1343' } },
  });
  assert.equal(hits.ensures.length, 1);
  assert.deepEqual(hits.ensures[0], { Platform: 'agent', Name: 'Claude Code' });
  assert.equal(hits.runs.length, 1);
  const doc = hits.runs[0].body;
  assert.equal(doc.schema, 'locker.run/1');
  assert.equal(doc.platform, 'agent');
  assert.equal(doc.agent.name, 'Claude Code');
  assert.equal(doc.agent.surface, 'local');
  assert.equal(doc.run.id, 'task-1');
  assert.deepEqual(doc.inputs, { brief: 'build it' });
  assert.equal(doc.labels.pr, '1343');
  assert.equal(hits.runs[0].headers['content-type'], 'application/json');

  assert.equal(out.receiptId, RECEIPT);
  assert.equal(out.chain.position, 1);
  assert.equal(out.receipt.schema, 'locker.receipt/1');
  assert.equal(out.install.created, true);
  assert.equal(out.duplicate, false);
  assert.ok(out.hint.includes('aside entry'), 'the first install is announced to the human');
});

test('archive_run refuses an oversized document before posting', async () => {
  const before = hits.runs.length;
  const out = await mcp.call('archive_run', { installId: AGENT, run: { workflow: { name: 'big' }, status: 'success', inputs: 'x'.repeat(1_100_000) } });
  assert.equal(out.error.code, 'locker_run_too_large');
  assert.equal(hits.runs.length, before);
});

test('get_locker_run returns the document, the receipt with its canonicalization, and verify_receipt checks it offline', async () => {
  const run = await mcp.call('get_locker_run', { receiptId: RECEIPT });
  assert.equal(run.run.schema, 'locker.run/1');
  assert.equal(run.receipt.canonicalization, 'RFC8785');
  assert.equal(run.install.name, 'Claude Code');

  const ok = await mcp.call('verify_receipt', { receipts: [run.receipt], body: JSON.stringify(run.run) });
  assert.equal(ok.intact, true);
  assert.equal(ok.signaturesValid, true);
  assert.equal(ok.body.bodySha256Matches, true, 'the stored document hashes to the receipt');

  const two = await mcp.call('verify_receipt', { receipts: VECTORS.chain.receipts });
  assert.equal(two.intact, true);
  assert.equal(two.count, 2);
  assert.equal(two.nextPrevHash, VECTORS.chain.nextPrevHash);

  const bad = await mcp.call('verify_receipt', { receipts: [VECTORS.chain.receipts[0], VECTORS.chain.tampered] });
  assert.equal(bad.intact, false);
  assert.equal(bad.brokenAt, 1);

  const disclosure = await mcp.call('verify_receipt', { receipts: [VECTORS.chain.receipts[0]], body: VECTORS.leafTree.disclosure });
  assert.equal(disclosure.body.mode, 'disclosure');
  assert.equal(disclosure.body.leafRootMatches, true);
  assert.equal(disclosure.body.redactedPaths.length, 2);
});
