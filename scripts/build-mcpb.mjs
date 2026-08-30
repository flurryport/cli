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

const manifest = {
  manifest_version: '0.3',
  name: 'flurryport',
  display_name: 'FlurryPORT',
  version: pkg.version,
  description: 'Capture, inspect, and replay webhooks with no signup; install signed delivery recipes from the catalog.',
  long_description:
    'FlurryPORT gives your AI agent webhook tools: mint a capture URL, watch events land, ' +
    'forward them to localhost, replay them, and register standing watches. The catalog adds ' +
    'signed delivery recipes (Slack, GitHub, Telegram, ntfy and more) where credentials stay ' +
    'server-side and every delivery returns a receipt. Anonymous sessions work instantly; ' +
    'claiming one in the browser upgrades the same tools to your account.',
  author: { name: 'Spill Coffee LLC', url: 'https://flurryport.io' },
  homepage: 'https://flurryport.io',
  documentation: 'https://flurryport.io/docs/cli',
  license: 'SEE LICENSE ON https://flurryport.io',
  keywords: ['webhooks', 'mcp', 'capture', 'replay', 'agents'],
  server: {
    type: 'node',
    entry_point: 'server/dist/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/dist/index.js', 'mcp'],
    },
  },
};
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));

// The official packer validates the manifest and zips the stage.
const bundlePath = join(out, 'flurryport.mcpb');
execSync(`npx -y @anthropic-ai/mcpb@2 pack "${stage}" "${bundlePath}"`, {
  cwd: root,
  stdio: 'inherit',
});
console.log(`\nBundle written: ${bundlePath} (v${pkg.version})`);
