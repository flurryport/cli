// The shared ProblemDetails parse (cleanup C1 of the 2026-08-29 hardening brief):
// ONE place a server error body becomes {code, detail}, replacing five drifted
// hand-rolled copies (api.ts, anon-api.ts, auth-api.ts, invite-api.ts, and the
// seat-ceremony standing paths that had dropped machine codes entirely). These
// tables are the drift lock: every client now inherits exactly this behavior.
import test from 'node:test';
import assert from 'node:assert/strict';

const { parseProblemDetails, appendFieldErrors, sanitizeOutboundError } = await import('../dist/lib/fetch-error.js');
const { startStandingRelease, pollStandingRelease, SeatRedeemError } = await import(
  '../dist/lib/seat-ceremony.js'
);
const { createServer } = await import('node:http');

test('machine code: non-URL "type" wins over everything', () => {
  const parsed = parseProblemDetails(
    400,
    JSON.stringify({ type: 'binding_limit_exceeded', title: 'Bad Request', detail: 'Too many bindings.' }),
  );
  assert.equal(parsed.code, 'binding_limit_exceeded');
  assert.equal(parsed.detail, 'Too many bindings.');
});

test('machine code: a code-shaped title is used when "type" is a URL', () => {
  const parsed = parseProblemDetails(
    404,
    JSON.stringify({ type: 'https://httpstatuses.io/404', title: 'standing_not_found' }),
  );
  assert.equal(parsed.code, 'standing_not_found');
});

test('status fallbacks cover the auth statuses uniformly', () => {
  assert.equal(parseProblemDetails(401, '{}').code, 'unauthorized');
  assert.equal(parseProblemDetails(403, '{}').code, 'forbidden');
  assert.equal(parseProblemDetails(404, '{}').code, 'not_found');
  assert.equal(parseProblemDetails(409, '{}').code, 'conflict');
  assert.equal(parseProblemDetails(429, '{}').code, 'throttled');
  assert.equal(parseProblemDetails(500, '{}').code, 'error');
});

test('detail falls back detail -> Error -> title -> raw text', () => {
  assert.equal(parseProblemDetails(400, JSON.stringify({ Error: 'legacy shape' })).detail, 'legacy shape');
  assert.equal(parseProblemDetails(400, JSON.stringify({ title: 'Bad Request' })).detail, 'Bad Request');
  assert.equal(parseProblemDetails(502, 'upstream said no').detail, 'upstream said no');
  assert.equal(parseProblemDetails(502, 'upstream said no').code, 'error');
});

test('ValidationProblem field errors are folded into the detail (agents self-correct)', () => {
  const body = JSON.stringify({
    title: 'Validation error',
    errors: { Name: ['Name is required.'], Url: ['Must be absolute.', 'Must be https.'] },
  });
  const parsed = parseProblemDetails(400, body);
  assert.match(parsed.detail, /Name: Name is required\./);
  assert.match(parsed.detail, /Url: Must be absolute\. Must be https\./);
});

// Round 3: type-hardening of the shared parse.
test('non-string detail fields are skipped, never flowed through as objects', () => {
  const objectDetail = parseProblemDetails(404, JSON.stringify({ detail: { message: 'nested' }, title: 'Not Found' }));
  assert.equal(typeof objectDetail.detail, 'string', 'detail is always a string');
  assert.equal(objectDetail.detail, 'Not Found', 'falls through to the next string candidate');
  const falseDetail = parseProblemDetails(400, JSON.stringify({ detail: false }));
  assert.equal(typeof falseDetail.detail, 'string');
});

test('isJson distinguishes a server sentence from a raw proxy body', () => {
  assert.equal(parseProblemDetails(502, '<html>ingress error page</html>').isJson, false);
  assert.equal(parseProblemDetails(404, JSON.stringify({ detail: 'no' })).isJson, true);
  assert.equal(parseProblemDetails(500, '42').isJson, false, 'a bare JSON scalar is not a ProblemDetails body');
});

test('catalog errors: a non-JSON upstream body falls back to the status line, never raw HTML', async () => {
  const server = createServer((req, res) => {
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html><body>nginx 502 Bad Gateway</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.FLURRYPORT_CATALOG_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const { getRecipe, CatalogApiError } = await import('../dist/lib/catalog-api.js');
    await assert.rejects(
      () => getRecipe('flurryport:anything'),
      (err) => {
        assert.ok(err instanceof CatalogApiError);
        assert.ok(!err.message.includes('<html>'), 'no raw upstream HTML in the message');
        assert.match(err.message, /502/, 'the clean status line answers instead');
        return true;
      },
    );
  } finally {
    delete process.env.FLURRYPORT_CATALOG_URL;
    server.close();
  }
});

test('appendFieldErrors ignores non-dict shapes and empty lists', () => {
  assert.equal(appendFieldErrors('base', null), 'base');
  assert.equal(appendFieldErrors('base', 'nope'), 'base');
  assert.equal(appendFieldErrors('base', { Field: [] }), 'base');
  assert.equal(appendFieldErrors('base', { Field: [42] }), 'base');
});

// Precedent #8: a raw undici/system error names internal infrastructure; on the
// hosted seat server that message reached a remote seated party verbatim,
// bypassing the #358 publicHost guard. The outbound sanitizer must never let a
// host or IP through, transport or otherwise.
test('sanitizeOutboundError: internal hosts and IPs never reach a tool result', () => {
  const silenced = console.error; // the helper logs the real error to stderr
  console.error = () => {};
  try {
    const undiciErr = new Error('fetch failed');
    undiciErr.cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 10.0.12.34:8083' };
    const transport = sanitizeOutboundError(undiciErr);
    assert.equal(transport.code, 'upstream_unreachable');
    assert.ok(!transport.message.includes('10.0.12.34'), 'no internal IP');
    assert.ok(!/ECONNREFUSED/.test(transport.message), 'no raw syscall code');

    const dnsErr = new Error('fetch failed');
    dnsErr.cause = { errors: [{ code: 'ENOTFOUND' }], hostname: 'core-api.core.svc.cluster.local' };
    const dns = sanitizeOutboundError(dnsErr);
    assert.ok(!dns.message.includes('cluster.local'), 'no cluster DNS name');

    const weird = sanitizeOutboundError(new Error('boom at http://core-api.core.svc:8083/api'));
    assert.equal(weird.code, 'error');
    assert.ok(!weird.message.includes('core-api'), 'unknown errors stay generic');

    // Review finding 6: a coded NON-transport error (permanent bug) must not be
    // advertised as a retryable transport failure.
    const invalidUrl = new TypeError('Invalid URL');
    invalidUrl.code = 'ERR_INVALID_URL';
    const permanent = sanitizeOutboundError(invalidUrl);
    assert.equal(permanent.code, 'error', 'ERR_INVALID_URL is not upstream_unreachable');
    assert.ok(!/try again/i.test(permanent.message), 'no retry invitation on a permanent error');

    const undiciTimeout = new Error('fetch failed');
    undiciTimeout.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
    assert.equal(sanitizeOutboundError(undiciTimeout).code, 'upstream_unreachable', 'undici codes stay transport');
  } finally {
    console.error = silenced;
  }
});

// Review finding 10: catalog-api was the sixth hand-rolled ProblemDetails parse -
// it dropped machine codes and field errors. It rides the shared parse now.
test('catalog errors carry the machine code and field errors through the shared parse', async () => {
  const server = createServer((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'version_not_published',
      detail: 'Version 9 is not published; the latest is 5.',
      errors: { Version: ['Must be a published version.'] },
    }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.FLURRYPORT_CATALOG_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const { getRecipe, CatalogApiError } = await import('../dist/lib/catalog-api.js');
    await assert.rejects(
      () => getRecipe('flurryport:nope@9'),
      (err) => {
        assert.ok(err instanceof CatalogApiError);
        assert.equal(err.code, 'version_not_published', 'the machine code survives');
        assert.match(err.detail ?? '', /latest is 5/, 'the server sentence survives');
        assert.match(err.detail ?? '', /Must be a published version\./, 'field errors folded in');
        return true;
      },
    );
  } finally {
    delete process.env.FLURRYPORT_CATALOG_URL;
    server.close();
  }
});

// The #6 lock: the standing-release paths (the checked-in re-attach rail) must carry
// the server's machine code, not collapse to 'error'/'not_found'. One-shot fake
// server per case.
async function withOneShotServer(status, body, fn) {
  const server = createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('startStandingRelease surfaces the server machine code', async () => {
  await withOneShotServer(400, { type: 'standing_not_checked_in', detail: 'Wrong custody.' }, async (base) => {
    await assert.rejects(
      () => startStandingRelease(base, 'ep1', 'engineering', 'dev', 'appr'),
      (err) => {
        assert.ok(err instanceof SeatRedeemError);
        assert.equal(err.code, 'standing_not_checked_in');
        assert.equal(err.detail, 'Wrong custody.');
        return true;
      },
    );
  });
});

test('pollStandingRelease surfaces the server machine code and folds field errors', async () => {
  await withOneShotServer(
    400,
    { title: 'Validation error', errors: { DeviceCode: ['DeviceCode is required.'] } },
    async (base) => {
      await assert.rejects(
        () => pollStandingRelease(base, ''),
        (err) => {
          assert.ok(err instanceof SeatRedeemError);
          assert.match(err.detail, /DeviceCode is required\./);
          return true;
        },
      );
    },
  );
});
