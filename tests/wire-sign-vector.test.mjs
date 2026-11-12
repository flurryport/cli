// The shared signing vector (browser seats, 2026-09-29). The browser (Common.Web
// scripts/test-room-kit.mjs), this CLI, and Core (SeatClaimProofTests) all assert the same
// digest for the same key and body, so a seat's post signs identically from a terminal,
// the hosted seat server, or a browser tab. The body carries non-ASCII on purpose: the
// signature is over UTF-8 bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const { deliverIntent } = await import('../dist/lib/intent-post.js');

const VECTOR = {
  key: 'c2VhdC1rZXktMzItYnl0ZXMtb2YtZW50cm9weS0hIQ==',
  body: '{"verb":"fp:propose","to":"all","for":"tagline","text":"Every action receipted. Café ☕"}',
  postSignature: 'a9c824fe7823d4d20a469d3cdd76257ce3dfd3c108688f5da5f3764055fa7390',
};

test('deliverIntent signs the shared vector byte for byte', async () => {
  let seen;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen = { url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"captureId":"00000000-0000-0000-0000-000000000001","executions":[]}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const out = await deliverIntent({
      baseUrl: `http://127.0.0.1:${port}`,
      projectId: 'P62',
      endpointSlug: 'launch-room',
      body: VECTOR.body,
      signingKey: VECTOR.key,
      headerName: 'X-Flurry-Signature',
    });
    assert.equal(out.ok, true);
    assert.equal(seen.url, '/api/v1/capture/P62/launch-room');
    assert.equal(seen.headers['x-flurry-signature'], VECTOR.postSignature);
    assert.equal(seen.body.toString('utf8'), VECTOR.body);
  } finally {
    server.close();
  }
});
