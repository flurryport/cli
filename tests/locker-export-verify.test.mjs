// Locker export bundle (slice 4, 2026-11-07): the offline verifier that ships in every bundle
// (Core.Logic/Resources/locker-verify.mjs, embedded and written into the zip) is run here under
// node against a bundle folder built from the receipt vector file, so the file that leaves
// with a customer is the one that is tested, byte for byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERIFIER = join(__dirname, '..', '..', 'Core.Logic', 'Resources', 'locker-verify.mjs');
const VECTORS = JSON.parse(readFileSync(join(__dirname, '..', '..', 'docs', 'receipts', 'locker-receipt-vectors.json'), 'utf8'));
const { verifyBundle } = await import(pathToFileURL(VERIFIER).href);

function bundle(receipts, documents = {}, withInstall = true) {
  const dir = mkdtempSync(join(tmpdir(), 'locker-export-'));
  writeFileSync(join(dir, 'receipts.jsonl'), receipts.map((r) => JSON.stringify(r)).join('\n') + '\n');
  mkdirSync(join(dir, 'runs'));
  for (const [index, body] of Object.entries(documents)) writeFileSync(join(dir, 'runs', `${String(index).padStart(8, '0')}.json`), body);
  if (withInstall)
    writeFileSync(
      join(dir, 'install.json'),
      JSON.stringify({ schema: 'locker.export/1', installId: receipts[0].installId, keyId: VECTORS.chain.keyId, publicKey: VECTORS.chain.publicKeyJwk, chainHead: receipts.length }),
    );
  return dir;
}

test('the vector chain with its documents is intact: receipts link, fingerprint and verify; the run file and the disclosure match', async () => {
  const chain = VECTORS.chain.receipts;
  // Receipt 1 is the leaf-tree body; its disclosure document keeps the same fields root.
  assert.equal(chain[0].bodySha256, VECTORS.leafTree.bodySha256);
  const dir = bundle(chain, { 1: VECTORS.leafTree.body });
  const result = await verifyBundle(dir);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.receipts, chain.length);
  assert.equal(result.documents, 1);

  // The vector file keeps the disclosure document as JSON text already.
  const redacted = bundle(chain, { 1: VECTORS.leafTree.disclosure });
  const r2 = await verifyBundle(redacted);
  assert.equal(r2.ok, true, r2.reason);
  assert.equal(r2.documents, 1);
});

test('the tampered receipt from the vectors is self-consistent, so the chain breaks at the receipt after it', async () => {
  // The vector's tampered receipt is re-hashed and re-signed over changed contents: on its own
  // it verifies, and the break shows where receipt 2 no longer links to it.
  const chain = VECTORS.chain.receipts;
  const dir = bundle([VECTORS.chain.tampered, ...chain.slice(1)]);
  const result = await verifyBundle(dir);
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.equal(result.chainIndex, 2);
  assert.match(result.reason, /does not link/);
});

test('a document that is not the one receipted is named', async () => {
  const dir = bundle(VECTORS.chain.receipts, { 1: JSON.stringify({ changed: true }) });
  const result = await verifyBundle(dir);
  assert.equal(result.ok, false);
  assert.match(result.reason, /runs\/00000001\.json/);
});

test('a public key in install.json that is not the signer refuses every receipt', async () => {
  const chain = VECTORS.chain.receipts;
  const dir = bundle(chain, {}, false);
  writeFileSync(join(dir, 'install.json'), JSON.stringify({ publicKey: { ...VECTORS.chain.publicKeyJwk, x: VECTORS.chain.publicKeyJwk.y, y: VECTORS.chain.publicKeyJwk.x } }));
  const result = await verifyBundle(dir);
  assert.equal(result.ok, false);
  assert.match(result.reason, /signature|fingerprint/);
});

test('a chain cut short, a receipt dropped from the middle, an empty bundle and a wrong chain hash are all refused (Codex review, 2026-11-12)', async () => {
  const chain = VECTORS.chain.receipts;
  const manifest = (extra) => JSON.stringify({ schema: 'locker.export/1', installId: chain[0].installId, keyId: VECTORS.chain.keyId, publicKey: VECTORS.chain.publicKeyJwk, ...extra });

  // The last receipt and its document deleted, install.json untouched: the manifest still names the full head.
  const cut = bundle(chain.slice(0, -1));
  writeFileSync(join(cut, 'install.json'), manifest({ chainHead: chain.length, receipts: chain.length }));
  const r1 = await verifyBundle(cut);
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /lists \d+ receipts|chain head/);

  // The first receipt dropped, the chain starting at 2: its prevHash names a receipt that is not there.
  const late = bundle(chain.slice(1));
  const r2 = await verifyBundle(late);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /does not link/);

  // Every receipt deleted, receipts.jsonl left empty.
  const empty = bundle([], {}, false);
  const r3 = await verifyBundle(empty);
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /no receipts/);

  // The manifest's chain hash is not the last receipt's.
  const wrongHash = bundle(chain);
  writeFileSync(join(wrongHash, 'install.json'), manifest({ chainHead: chain.length, chainHash: 'f'.repeat(64) }));
  const r4 = await verifyBundle(wrongHash);
  assert.equal(r4.ok, false);
  assert.match(r4.reason, /chain hash/);

  // And the honest manifest, with every field the export writes, still passes.
  const full = bundle(chain);
  writeFileSync(join(full, 'install.json'), manifest({ chainHead: chain.length, chainHash: chain[chain.length - 1].hash, receipts: chain.length }));
  const r5 = await verifyBundle(full);
  assert.equal(r5.ok, true, r5.reason);
});

test('run as a command: exit 0 on an intact bundle, 1 on a broken one, 2 without receipts', () => {
  const ok = spawnSync(process.execPath, [VERIFIER, bundle(VECTORS.chain.receipts, { 1: VECTORS.leafTree.body })], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(ok.stdout, /intact/);
  const broken = spawnSync(process.execPath, [VERIFIER, bundle([VECTORS.chain.tampered, ...VECTORS.chain.receipts.slice(1)])], { encoding: 'utf8' });
  assert.equal(broken.status, 1);
  const empty = spawnSync(process.execPath, [VERIFIER, mkdtempSync(join(tmpdir(), 'locker-empty-'))], { encoding: 'utf8' });
  assert.equal(empty.status, 2);
});
