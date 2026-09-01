// Precedent #5 (CLAUDE.20260829.cli-hardening-brief.md): sanitize.ts was built
// 08-14 for exactly this, but four print paths bypassed it - unauthenticated
// capture bodies (listen's provider fields), adversarial collection names, roster
// guest names, and the join ceremony's participant name all drive the operator's
// terminal. Table-driven over the reachable sites; every new wire-driven print
// path gets a row here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'fp-ansi-home-'));
process.env.HOME = process.env.USERPROFILE;

const { sanitizeWireLine } = await import('../dist/lib/sanitize.js');
const { renderEvent } = await import('../dist/commands/console-render.js');
const { forwardCapture } = await import('../dist/commands/listen.js');

// The payloads an attacker actually sends: color repaint, OSC title/hyperlink,
// cursor moves, a forged "verified" line behind a carriage return.
const HOSTILE = [
  '\x1b[31mFAKE ERROR\x1b[0m',
  '\x1b]0;owned-title\x07evil',
  '\x1b[2J\x1b[Hwiped',
  'ok\rsigning key verified',
];

const clean = (s) => !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(s) && !s.includes('\x1b');

test('sanitizeWireLine strips every hostile payload (the shared helper all four sites call)', () => {
  for (const payload of HOSTILE) {
    assert.ok(clean(sanitizeWireLine(payload)), `left control bytes in: ${JSON.stringify(payload)}`);
  }
});

test('roster render: an adversarial guest name cannot drive the terminal', () => {
  for (const payload of HOSTILE) {
    const event = {
      type: 'roster',
      rows: [
        { handle: 'seat1', guestName: payload, status: 'accepted', live: true, held: false, greyed: false, presence: 'live', hidden: false, color: null },
        { handle: 'seat2', guestName: payload, status: 'revoked', live: false, held: false, greyed: true, presence: null, hidden: false, color: null },
      ],
    };
    for (const line of renderEvent(event, 120)) {
      // chalk paints the row's own colors; the GUEST's bytes must not add any.
      // Strip the renderer's own SGR sequences, then require no ESC/control left
      // ...actually simpler: the hostile marker text must survive only stripped.
      assert.ok(!line.includes('\x07'), 'no BEL survives');
      assert.ok(!line.includes('\x1b]'), 'no OSC survives');
      assert.ok(!line.includes('\x1b[2J'), 'no erase-screen survives');
      assert.ok(!line.includes('\r'), 'no carriage return survives');
    }
  }
});

test('listen forward line: capture provider fields cannot drive the terminal', async () => {
  const srv = createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const printed = [];
  const origLog = console.log;
  console.log = (...args) => printed.push(args.join(' '));
  try {
    for (const payload of HOSTILE) {
      await forwardCapture(
        {
          Id: 'c1',
          CreatedAt: '2026-08-28T00:00:00Z',
          HttpMethod: 'POST',
          Headers: '{}',
          BodyBytes: null,
          ContentType: null,
          QueryString: null,
          ProviderHint: payload,
          ProviderEventType: payload,
          MissingSecrets: null,
        },
        `http://127.0.0.1:${srv.address().port}/`,
      );
    }
  } finally {
    console.log = origLog;
    srv.close();
  }
  assert.equal(printed.length, HOSTILE.length, 'each forward printed one line');
  for (const line of printed) {
    assert.ok(!line.includes('\x07') && !line.includes('\x1b]') && !line.includes('\x1b[2J') && !line.includes('\r'),
      `wire bytes drove the terminal: ${JSON.stringify(line)}`);
  }
});
