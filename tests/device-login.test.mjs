// #388 device login: `flurryport login` with no token walks the device rail — two
// locally generated codes, one printed URL, a poll that receives the server-minted
// token directly. The token never appears in stdout, and the pasted-token path is
// unchanged. One fake anon API drives register + poll.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'dist', 'index.js');

// Mutable fake state the tests drive.
let approved = false;
let registered = null; // { DeviceCode, ApprovalCode }
let pollCount = 0;

function makeFake() {
  return createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/api/v1/anon/device/login/start') {
        registered = body;
        return json(200, { ExpiresAt: new Date(Date.now() + 60_000).toISOString(), PollIntervalSeconds: 1 });
      }
      if (req.url === '/api/v1/anon/device/poll') {
        pollCount++;
        if (body.DeviceCode !== registered?.DeviceCode) return json(404, { title: 'not_found' });
        if (!approved) return json(200, { Status: 'pending' });
        return json(200, { Status: 'complete', Token: 'fp_device_released', GrantedScope: 'read-write' });
      }
      json(404, { title: 'not_found', detail: `no fake for ${req.url}` });
    });
  });
}

function runLogin(env, args = ['login']) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  return {
    child,
    output: () => out,
    done: new Promise((resolve) => child.on('exit', (code) => resolve(code))),
  };
}

test('login with no token prints the approval URL, waits, and stores the released token', async () => {
  approved = false;
  registered = null;
  pollCount = 0;
  const fake = makeFake();
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${fake.address().port}`;
  const home = mkdtempSync(join(tmpdir(), 'fp-test-device-login-'));

  try {
    const run = runLogin({
      ...process.env,
      FLURRYPORT_ANON_URL: apiUrl,
      FLURRYPORT_WEB_URL: 'https://web.example',
      USERPROFILE: home,
      HOME: home,
    });

    // Wait for registration, then approve after at least one pending poll.
    await new Promise((resolve) => {
      const t = setInterval(() => { if (registered && pollCount >= 1) { clearInterval(t); resolve(); } }, 50);
    });
    approved = true;
    const code = await run.done;
    const out = run.output();

    assert.equal(code, 0, out);
    // The printed URL carries the APPROVAL code, never the device code.
    assert.match(out, /https:\/\/web\.example\/login\?deviceLogin=/);
    assert.ok(out.includes(registered.ApprovalCode), 'approval code rides the URL');
    assert.ok(!out.includes(registered.DeviceCode), 'the device code never prints');
    // The released token never prints either - custody is the whole point.
    assert.ok(!out.includes('fp_device_released'), 'the token never appears in the conversation');
    assert.match(out, /read-write/);

    const config = JSON.parse(readFileSync(join(home, '.flurryport', 'config.json'), 'utf8'));
    const env = config.environments[config.activeEnvironment];
    assert.equal(env.accounts.default.apiKey, 'fp_device_released');
    assert.equal(env.activeAccount, 'default');

    // Both codes are distinct and high-entropy.
    assert.notEqual(registered.DeviceCode, registered.ApprovalCode);
    assert.ok(registered.DeviceCode.length >= 32);
    assert.ok(registered.ApprovalCode.length >= 20);
  } finally {
    fake.close();
  }
});

test('an expired (or denied) hand-off exits nonzero with the fresh-link message', async () => {
  approved = false;
  registered = null;
  const fake = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/api/v1/anon/device/login/start') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Already-expired window: the CLI must not spin.
        res.end(JSON.stringify({ ExpiresAt: new Date(Date.now() - 1000).toISOString(), PollIntervalSeconds: 1 }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ title: 'not_found' }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const home = mkdtempSync(join(tmpdir(), 'fp-test-device-login-exp-'));

  try {
    const run = runLogin({
      ...process.env,
      FLURRYPORT_ANON_URL: `http://127.0.0.1:${fake.address().port}`,
      USERPROFILE: home,
      HOME: home,
    });
    const code = await run.done;

    assert.notEqual(code, 0);
    assert.match(run.output(), /not approved in time/);
    assert.ok(!existsSync(join(home, '.flurryport', 'config.json')), 'nothing stored on failure');
  } finally {
    fake.close();
  }
});

test('the pasted-token path is unchanged', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fp-test-device-login-paste-'));
  const run = runLogin({ ...process.env, USERPROFILE: home, HOME: home }, ['login', 'fp_pasted_token']);
  const code = await run.done;

  assert.equal(code, 0, run.output());
  const config = JSON.parse(readFileSync(join(home, '.flurryport', 'config.json'), 'utf8'));
  assert.equal(config.environments[config.activeEnvironment].accounts.default.apiKey, 'fp_pasted_token');
});
