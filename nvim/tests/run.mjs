// Headless harness for flurryport.nvim: run every fp_*.lua in this directory
// under `nvim --headless -l`, with FP_NVIM pointing at the plugin root. Each test
// appends FP_NVIM to the runtimepath itself, asserts, and prints a final `... OK`
// line; a nonzero exit or a missing OK line is a failure.
//
// Every test here is PURE: fake events in, buffer text out, no console spawned,
// no network. Tests that drive the real `flurryport console --json` against a
// live account stay out of this suite by design.
//
//   node nvim/tests/run.mjs          (or: npm run test:nvim)

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const plugin = join(here, '..');

const tests = readdirSync(here)
  .filter((f) => f.startsWith('fp_') && f.endsWith('.lua'))
  .sort();

let failures = 0;
for (const test of tests) {
  const result = spawnSync('nvim', ['--headless', '-u', 'NONE', '-i', 'NONE', '-l', join(here, test)], {
    env: { ...process.env, FP_NVIM: plugin },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const ok = result.status === 0 && / OK\s*$/.test(output.trim());
  if (ok) {
    console.log(`ok - ${test}`);
  } else {
    failures += 1;
    console.log(`FAIL - ${test} (exit ${result.status})`);
    console.log(output.trim());
  }
}

console.log(`# nvim tests: ${tests.length}, failed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
