// The shared ~/.flurryport store (hardening C4 + precedent 10): 0700 dir / 0600
// file discipline and ATOMIC writes for every file under the CLI home - config.json
// (fp_ PATs) was written world-readable before this, and an in-place write could be
// truncated by a crash, wiping stored keys. Mode assertions are POSIX-only (Windows
// uses ACLs); the atomic/round-trip/heal behaviors assert everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated HOME before dist imports (module-level path constants read it once).
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'fp-store-home-'));
process.env.HOME = process.env.USERPROFILE;

const { flurryStoreDir, flurryStorePath, readJsonStore, writeJsonStore, deleteStoreFile } =
  await import('../dist/lib/store.js');
const { loadConfig, saveConfig, getConfigPath } = await import('../dist/lib/config.js');
const { putCredential, getCredential, getKeystorePath } = await import('../dist/lib/keystore.js');

const posix = process.platform !== 'win32';
const mode = (path) => statSync(path).mode & 0o777;

test('writeJsonStore: round trip, tight modes, no temp residue', () => {
  const path = flurryStorePath('store-test.json');
  writeJsonStore(path, { hello: 'world', n: 2 });
  assert.deepEqual(readJsonStore(path), { hello: 'world', n: 2 });
  if (posix) {
    assert.equal(mode(path), 0o600, 'file is owner-only');
    assert.equal(mode(flurryStoreDir()), 0o700, 'dir is owner-only');
  }
  const residue = readdirSync(flurryStoreDir()).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(residue, [], 'no temp file left behind');
});

test('writeJsonStore heals a pre-discipline world-readable file on save', { skip: !posix }, () => {
  const path = flurryStorePath('store-heal.json');
  writeFileSync(path, '{}', { mode: 0o644 });
  assert.equal(mode(path), 0o644);
  writeJsonStore(path, { healed: true });
  assert.equal(mode(path), 0o600, 'the lax mode did not survive the save');
});

test('readJsonStore: absent and corrupt both read as null', () => {
  assert.equal(readJsonStore(flurryStorePath('never-written.json')), null);
  const path = flurryStorePath('store-corrupt.json');
  writeFileSync(path, '{"truncated": ');
  assert.equal(readJsonStore(path), null);
  deleteStoreFile(path);
  assert.ok(!existsSync(path));
  deleteStoreFile(path); // absent is success, not an error
});

// Review finding 9: "exists but unreadable right now" must NOT read as absent -
// a locked config.json read as a virgin config, and the next save atomically
// overwrote stored PATs with defaults. A directory at the path is the portable
// stand-in for an unreadable file (EISDIR/EPERM, never ENOENT).
test('readJsonStore: an unreadable existing path throws instead of reading as empty', () => {
  const path = flurryStorePath('store-unreadable.json');
  mkdirSync(path, { recursive: true });
  assert.throws(() => readJsonStore(path), 'a lock/permission failure is not an empty store');
});

// Precedent #10 itself, proven through the real consumer: config.json holds fp_
// PATs and must come out of saveConfig with the keystore's discipline.
test('config.json (fp_ PATs) is written owner-only', { skip: !posix }, () => {
  const config = loadConfig();
  config.environments.prod.accounts.tester = { apiKey: 'fp_store_test' };
  saveConfig(config);
  assert.equal(mode(getConfigPath()), 0o600, 'the PAT file is no longer world-readable');
  assert.equal(loadConfig().environments.prod.accounts.tester.apiKey, 'fp_store_test');
});

test('keystore keeps its round trip through the shared store', () => {
  putCredential('signing:test-ep', { type: 'signing', value: 'fpsk_x', createdAt: '2026-08-28T00:00:00Z' });
  assert.equal(getCredential('signing:test-ep').value, 'fpsk_x');
  if (posix) assert.equal(mode(getKeystorePath()), 0o600);
});
