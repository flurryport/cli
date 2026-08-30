// #355 CLI half: version pins on the catalog read surface.
//
// Until today get_recipe STRIPPED the @version suffix and its description said so out
// loud - so a manifest pinned at @3, the versioned ref the invite landing hands out,
// and bind_transformation's recipeRef all read back as whatever latest happened to be,
// silently. The pin now travels to the catalog, and the answer says which version this
// is, which one stands today, and whether the publisher withdrew it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'fp-version-pins-home-'));
process.env.HOME = process.env.USERPROFILE;
process.env.FLURRYPORT_WEB_URL = 'https://flurryport.io';

const fake = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  asked.push({ path: url.pathname, version: url.searchParams.get('version'), includeDocs: url.searchParams.get('includeDocs') });

  if (url.pathname === '/api/v1/catalog/recipes') {
    return json(200, {
      Items: [{
        Ref: 'flurryport:slack-post', PublisherSlug: 'flurryport', Slug: 'slack-post', Kind: 'delivery',
        DestServiceSlug: 'slack', SourceServiceSlug: null, ListingSummary: 'Post to Slack.',
        LatestVersion: 5, PublishedAt: '2026-08-20T10:00:00Z',
      }],
    });
  }
  if (url.pathname === '/api/v1/catalog/recipes/flurryport/slack-post') {
    const v = url.searchParams.get('version');
    if (v === '0') {
      return json(400, { title: 'validation', detail: 'Version must be 1 or greater.' });
    }
    if (v === '9') {
      return json(404, { title: 'not_found', detail: 'Version 9 of flurryport:slack-post is not published; the latest is 5.' });
    }
    const version = v ? Number(v) : 5;
    return json(200, {
      Ref: 'flurryport:slack-post', Kind: 'delivery', DestServiceSlug: 'slack', SourceServiceSlug: null,
      ListingSummary: 'Post to Slack.', Version: version, ContentHash: `sha256:v${version}`,
      ContentJson: JSON.stringify({ name: 'slack-post', version }),
      PublishedAt: '2026-08-20T10:00:00Z', TokenKind: 'write', HasDocs: false,
      LatestVersion: 5,
      Yanked: version === 3,
      YankedReason: version === 3 ? 'Sent to the wrong channel on threaded replies.' : null,
    });
  }
  json(404, { title: 'not_found', detail: `no fake for ${req.url}` });
});

const asked = [];

await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.FLURRYPORT_CATALOG_URL = `http://127.0.0.1:${fake.address().port}`;

const { collectTools } = await import('../dist/lib/mcp-unified.js');
const { registerCatalogTools } = await import('../dist/lib/mcp-catalog-tools.js');

const tools = collectTools((s) => registerCatalogTools(s));
const call = async (name, args) => JSON.parse((await tools.get(name).handler(args)).content[0].text);

test.after(() => fake.close());

test('an exact pin travels to the catalog and resolves that immutable version', async () => {
  asked.length = 0;
  const out = await call('get_recipe', { ref: 'flurryport:slack-post@2' });

  assert.equal(asked.at(-1).version, '2', 'the pin reached the catalog');
  assert.equal(out.version, 2);
  assert.equal(out.latestVersion, 5);
  assert.equal(out.pinned, true);
  assert.equal(out.contentHash, 'sha256:v2', 'a pinned version carries its own hash');
  assert.match(out.versionNote, /pinned version 2/);
  assert.match(out.versionNote, /5 today/);
});

test('an unpinned ref still reads the latest published version, and says nothing extra', async () => {
  asked.length = 0;
  const out = await call('get_recipe', { ref: 'flurryport:slack-post' });

  assert.equal(asked.at(-1).version, null, 'no version parameter when nothing was pinned');
  assert.equal(out.version, 5);
  assert.equal(out.latestVersion, 5);
  assert.equal(out.pinned, false);
  assert.equal(out.yanked, false);
  assert.equal(out.versionNote, null);
});

test('a yanked pin resolves, is flagged, and carries the publisher reason', async () => {
  const out = await call('get_recipe', { ref: 'flurryport:slack-post@3' });

  assert.equal(out.version, 3);
  assert.equal(out.yanked, true);
  assert.match(out.yankedReason, /threaded replies/);
  assert.match(out.versionNote, /YANKED/);
  assert.match(out.versionNote, /Tell your human/);
});

test('a pin that was never published fails with the sentence naming what is', async () => {
  const out = await call('get_recipe', { ref: 'flurryport:slack-post@9' });

  assert.equal(out.error.status, 404);
  assert.match(out.error.message, /the latest is 5/, 'the server answer is relayed, not swallowed');
});

test('version 0 is a 400 the caller can fix, not a catalog outage', async () => {
  const out = await call('get_recipe', { ref: 'flurryport:slack-post@0' });

  assert.equal(out.error.status, 400);
  assert.match(out.error.message, /1 or greater/);
  assert.match(out.error.hint, /versions start at 1/);
});

test('search rows carry latestVersion and publishedAt, so a pin needs no second call', async () => {
  const out = await call('search_recipes', {});

  assert.equal(out.recipes.length, 1);
  assert.equal(out.recipes[0].latestVersion, 5);
  assert.equal(out.recipes[0].publishedAt, '2026-08-20T10:00:00Z');
  assert.equal(out.recipes[0].ref, 'flurryport:slack-post');
});

test('the descriptions no longer promise to ignore the suffix', async () => {
  const getDef = tools.get('get_recipe').def;
  const searchDef = tools.get('search_recipes').def;
  const refDescription = String(getDef.inputSchema.ref.description ?? '');

  assert.ok(!refDescription.includes('accepted and ignored'), refDescription);
  assert.match(refDescription, /exact immutable version/);
  assert.match(getDef.description, /latestVersion/);
  assert.match(getDef.description, /yanked/);
  assert.match(searchDef.description, /latestVersion/);
});
