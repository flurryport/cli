import test from 'node:test';
import assert from 'node:assert/strict';
import { matchTargetsByUrl } from '../dist/commands/listen.js';
import { parseEchoAddress } from '../dist/commands/echo.js';

const choice = (BaseUrl, slug = 'ep') => ({ target: { BaseUrl, Name: slug }, project: { Slug: 'p' }, endpoint: { Slug: slug } });

test('listen <url> matches a local target by address, ignoring case, a trailing slash, and a default port', () => {
  const choices = [choice('http://localhost:8771/hook', 'ticketing'), choice('http://localhost:8772/hook', 'ledger'), choice('http://localhost:8771/other', 'other')];
  assert.deepEqual(matchTargetsByUrl(choices, 'http://localhost:8771/hook').map((c) => c.endpoint.Slug), ['ticketing']);
  assert.deepEqual(matchTargetsByUrl(choices, 'HTTP://LOCALHOST:8771/hook/').map((c) => c.endpoint.Slug), ['ticketing']);
  assert.deepEqual(matchTargetsByUrl(choices, 'http://localhost:8772/hook').map((c) => c.endpoint.Slug), ['ledger']);
  assert.deepEqual(matchTargetsByUrl([choice('http://localhost:80/x')], 'http://localhost/x').length, 1, 'default port is the same address');
});

test('listen <url> never matches a different path or port, and returns every endpoint at one address', () => {
  const choices = [choice('http://localhost:8771/hook', 'a'), choice('http://localhost:8771/hook', 'b'), choice('http://localhost:8779/hook', 'c')];
  assert.equal(matchTargetsByUrl(choices, 'http://localhost:8771/hook2').length, 0);
  assert.equal(matchTargetsByUrl(choices, 'http://localhost:8780/hook').length, 0);
  assert.deepEqual(matchTargetsByUrl(choices, 'http://localhost:8771/hook').map((c) => c.endpoint.Slug), ['a', 'b']);
  assert.equal(matchTargetsByUrl(choices, 'not a url').length, 0);
});

test('echo <port | url>: a bare port stays a port; a URL supplies port, host, and path; anything else is refused', () => {
  assert.deepEqual(parseEchoAddress('8765'), { port: 8765 });
  assert.deepEqual(parseEchoAddress('http://localhost:8765/hook'), { port: 8765, host: 'localhost', path: '/hook' });
  assert.deepEqual(parseEchoAddress('http://127.0.0.1:8771/'), { port: 8771, host: '127.0.0.1', path: undefined });
  assert.deepEqual(parseEchoAddress('http://localhost/x'), { port: 80, host: 'localhost', path: '/x' });
  assert.equal(parseEchoAddress('ftp://localhost:21/'), null);
  assert.equal(parseEchoAddress('not an address'), null);
});
