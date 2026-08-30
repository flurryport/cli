import test from 'node:test';
import assert from 'node:assert/strict';
import { matchScopedPath, makeRoutingClient } from '../dist/lib/credential-router.js';

// The credential router (0.3.0): deterministic path-based credential selection. These
// lock the matcher's contract — endpoint match outranks project match, non-matching
// paths fall through to the default credential, and no fuzzy/retry behavior exists.

const guest = { endpointId: 'ep111111111111', projectId: 'pr111111111111', accountName: 'tom', client: fake('guest') };
const other = { endpointId: 'ep222222222222', projectId: 'pr222222222222', accountName: 'bunny', client: fake('other') };
const table = [guest, other];

function fake(name) {
  return {
    baseUrl: `https://${name}`,
    get: async (path) => ({ via: name, path }),
    post: async (path) => ({ via: name, path }),
    put: async (path) => ({ via: name, path }),
    delete: async (path) => ({ via: name, path }),
  };
}

test('endpoint-keyed path routes to its scoped credential', () => {
  const hit = matchScopedPath('/api/v1/endpoints/ep111111111111/captured-requests?take=10', table);
  assert.equal(hit?.accountName, 'tom');
});

test('project-keyed path routes via the scope project id', () => {
  const hit = matchScopedPath('/api/v1/projects/pr222222222222/replay-executions', table);
  assert.equal(hit?.accountName, 'bunny');
});

test('unknown ids fall through to the default credential (no guessing)', () => {
  assert.equal(matchScopedPath('/api/v1/endpoints/epUNMATCHED9999/watches', table), null);
  assert.equal(matchScopedPath('/api/v1/projects', table), null);
  assert.equal(matchScopedPath('/api/v1/recipes/search', table), null);
});

test('endpoint match outranks project match on a path naming both', () => {
  // tom's endpoint under bunny's project id (cannot happen live, but the precedence
  // must be fixed): the endpoint is the sharper claim.
  const hit = matchScopedPath('/api/v1/projects/pr222222222222/endpoints/ep111111111111/watches', table);
  assert.equal(hit?.accountName, 'tom');
});

test('routing facade dispatches by path and follows default swaps', async () => {
  let def = fake('operator');
  const client = makeRoutingClient(() => def, table);

  assert.equal((await client.get('/api/v1/endpoints/ep111111111111/watches')).via, 'guest');
  assert.equal((await client.get('/api/v1/projects/prOWN/endpoints/epOWN/watches')).via, 'operator');
  assert.equal(client.baseUrl, 'https://operator');

  // The write-upgrade / claim flip swaps the DEFAULT in place; routed entries are untouched.
  def = fake('upgraded');
  assert.equal((await client.get('/api/v1/projects/prOWN')).via, 'upgraded');
  assert.equal((await client.get('/api/v1/endpoints/ep222222222222/captured-requests')).via, 'other');
  assert.equal(client.baseUrl, 'https://upgraded');
});
