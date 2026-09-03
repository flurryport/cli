#!/usr/bin/env node
/**
 * Build flurryport.mcpb — the one-click Claude Desktop bundle (0.3.0 gate item 7,
 * ratified 2026-07-28). Claude Desktop supplies its own Node runtime, so a user
 * installing this bundle needs NOTHING preinstalled: no node, no npm, no config
 * surgery. The npx line remains the universal door for every other stdio client.
 *
 * Pipeline: stage (manifest + compiled dist + production node_modules) -> pack with
 * the official @anthropic-ai/mcpb packer (validates the manifest, manifest_version
 * 0.3). Output: mcpb-dist/flurryport.mcpb, hosted at a stable URL on the static site
 * and linked from the capability-branch copy (see the scoping brief).
 *
 * Run: npm run build:mcpb   (builds dist first via the script chain)
 * Verify: open the .mcpb with Claude Desktop (Settings > Extensions > install from
 * file) and confirm the flurryport tools appear in a fresh conversation.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const stage = join(root, 'mcpb-stage');
const out = join(root, 'mcpb-dist');

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'server'), { recursive: true });
mkdirSync(out, { recursive: true });

// The compiled CLI is the server; Desktop invokes it with its own Node.
cpSync(join(root, 'dist'), join(stage, 'server', 'dist'), { recursive: true });
// The dist reads ../../package.json for its version banner (mcp.ts), so the bundle
// carries the same file the npm package does.
writeFileSync(join(stage, 'server', 'package.json'), JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  type: pkg.type,
  dependencies: pkg.dependencies,
}, null, 2));

// Production dependencies only, resolved fresh inside the stage so the archive is
// self-contained (Desktop does not npm-install on the user's behalf).
execSync('npm install --omit=dev --no-audit --no-fund --no-package-lock', {
  cwd: join(stage, 'server'),
  stdio: 'inherit',
});

// Per-channel attribution (Gene, 2026-08-31 gavel, board #465): a bundle is a
// frozen snapshot, so every directory that hosts one gets its own build with its
// own --ref. Set MCPB_REF=smithery (etc.) when building for a channel; with it
// unset the bundle carries no --ref and its installs are invisible in the funnel.
const ref = process.env.MCPB_REF?.trim();
if (!ref) console.warn('\nWARNING: MCPB_REF is not set; this bundle will carry no --ref attribution.\n');

// Description strings follow the 09-01 ladder: `description` is the short form
// (shared with server.json, under the official registry's 100-char cap) and
// `long_description` is the paragraph form. Keywords mirror package.json.
const manifest = {
  manifest_version: '0.3',
  name: 'flurryport',
  display_name: 'FlurryPORT',
  version: pkg.version,
  description: 'Webhook capture and replay, delivery pipes, and signed multi-agent rooms. No signup to start.',
  long_description:
    'FlurryPORT captures incoming webhooks exactly as they arrive, headers and body and query ' +
    'string, byte for byte, and replays them to your machine with the signature still valid. ' +
    'The same capture can drive an action: an agent sends a typed intent, FlurryPORT holds the ' +
    'credential and makes the call, and hands back what the service actually said, with a ' +
    'receipt. Rooms give several agents and their people one endpoint to write to, so the ' +
    'record of a decision is the same record for everyone who was in it. Anonymous sessions ' +
    'work instantly; claiming one in the browser upgrades the same tools to your account.',
  author: { name: 'Spill Coffee LLC', url: 'https://flurryport.io' },
  homepage: 'https://flurryport.io',
  documentation: 'https://flurryport.io/docs/cli',
  // #479: the Anthropic directory wants an icon and a privacy policy on the
  // manifest. The icon is the site favicon (both-theme plate), staged beside it.
  icon: 'icon.png',
  privacy_policies: ['https://flurryport.io/privacy'],
  license: pkg.license,
  keywords: pkg.keywords,
  // #479 / Codex reviewer run 2026-09-02: a Desktop reviewer has no terminal step,
  // so the optional write token is an extension setting (sensitive, stored by
  // Desktop's keychain) injected as FLURRYPORT_TOKEN, the env the CLI already reads.
  // Left blank the server starts anonymous exactly as before.
  user_config: {
    token: {
      type: 'string',
      title: 'Personal access token (optional)',
      description:
        'Leave blank to start without an account. To let the agent create endpoints and replay, ' +
        'generate a token on flurryport.io/settings with Read-only unchecked and paste it here.',
      sensitive: true,
      required: false,
    },
  },
  server: {
    type: 'node',
    entry_point: 'server/dist/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/dist/index.js', 'mcp', ...(ref ? ['--ref', ref] : [])],
      env: { FLURRYPORT_TOKEN: '${user_config.token}' },
    },
  },
};
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
cpSync(join(root, 'assets', 'icon.png'), join(stage, 'icon.png'));

// The official packer validates the manifest and zips the stage.
// One bundle per channel (#464/#465): the ref is baked into the archive, so each
// directory gets its own file, named for it, and an unattributed build keeps the
// plain name so it cannot be mistaken for a channel build.
const bundlePath = join(out, ref ? `flurryport-${ref}-${pkg.version}.mcpb` : `flurryport-${pkg.version}.mcpb`);
execSync(`npx -y @anthropic-ai/mcpb@2 pack "${stage}" "${bundlePath}"`, {
  cwd: root,
  stdio: 'inherit',
});
console.log(`\nBundle written: ${bundlePath} (v${pkg.version})`);
