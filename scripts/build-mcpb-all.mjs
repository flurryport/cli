#!/usr/bin/env node
/**
 * Build one .mcpb per distribution channel, each carrying its own --ref (#464, the
 * per-channel attribution gavel of 2026-08-31). A bundle is a frozen snapshot, so
 * every channel goes stale on every release; run this on each release and re-upload.
 *
 * Usage: npm run build:mcpb:all               (default channels below)
 *        node scripts/build-mcpb-all.mjs smithery anthropic-directory
 * Output: mcpb-dist/flurryport-<channel>-<version>.mcpb per channel.
 * The compiled dist is built once by the npm script chain; this only stages and packs.
 */
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CHANNELS = ['smithery', 'anthropic-directory'];
const channels = process.argv.slice(2).filter(Boolean);
const list = channels.length ? channels : DEFAULT_CHANNELS;

for (const ref of list) {
  if (!/^[a-z0-9-]+$/.test(ref)) {
    console.error(`Refusing channel "${ref}": refs are lower-case slugs.`);
    process.exit(1);
  }
  console.log(`
=== ${ref} ===`);
  execSync('node scripts/build-mcpb.mjs', { cwd: root, stdio: 'inherit', env: { ...process.env, MCPB_REF: ref } });
}
console.log(`
Built ${list.length} bundle(s): ${list.join(', ')}`);
