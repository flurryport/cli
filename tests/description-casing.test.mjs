// Docs-contract guard (#273): tool descriptions must spell response keys exactly as
// the wire spells them. Two independent agents (the coder seat's poller and the
// reviewer vendor's debrief, 2026-08-16) read "nextCursor" in a description, looked
// up that key on the response, found nothing, and misdiagnosed the server as
// returning null - the response key is NextCursor (PascalCase, like every key on the
// DTO). The lowercase spelling may only ever name an INPUT argument (after), never
// the response member. This scans the MCP tool sources so the docs cannot drift
// from the wire again; extend the banned list if another key grows a wrong-case twin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib');

// Response members whose casing descriptions have historically gotten wrong,
// mapped to the one true wire spelling.
const RESPONSE_KEYS = [{ wrong: /nextCursor/g, right: 'NextCursor' }];

test('MCP tool sources never name a response key with casing the wire does not use', () => {
  const offenders = [];
  for (const file of readdirSync(libDir)) {
    if (!file.startsWith('mcp-') || !file.endsWith('.ts')) continue;
    const text = readFileSync(join(libDir, file), 'utf8');
    for (const { wrong, right } of RESPONSE_KEYS) {
      for (const match of text.matchAll(wrong)) {
        const line = text.slice(0, match.index).split('\n').length;
        offenders.push(`${file}:${line} says "${match[0]}" - the wire spells it ${right}`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('; '));
});
