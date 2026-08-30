/**
 * #350 measurement harness: how big is the surface an agent meets on connect?
 *
 * Builds the same tool inventories the real servers register (owner/unified, seat)
 * without a transport, serializes each one the way a tools/list response does
 * (name + description + JSON Schema), and reports characters plus an estimated token
 * count for the server instructions block and for every tool, ranked largest first.
 *
 * Run: node scripts/measure-tool-surface.mjs [--json]
 */
import { z } from 'zod';

const { collectTools } = await import('../dist/lib/mcp-unified.js');
const { registerAuthTools } = await import('../dist/lib/mcp-auth-tools.js');
const { registerCatalogTools } = await import('../dist/lib/mcp-catalog-tools.js');
const { registerInviteTools } = await import('../dist/lib/mcp-invite-tools.js');
const { registerServerInfoTool } = await import('../dist/lib/mcp-server-info.js');
const { registerSeatTools } = await import('../dist/lib/mcp-seat-tools.js');
const instructions = await import('../dist/lib/mcp-server-instructions.js');

const VERSION = '0.6.0';
export const estTokens = (chars) => Math.round(chars / 4);

const fakeClient = {
  baseUrl: 'https://api.flurryport.io',
  get: async () => ({}),
  post: async () => ({}),
  del: async () => ({}),
  patch: async () => ({}),
  put: async () => ({}),
};

function sink(collected) {
  return {
    registerTool(name, def, handler) {
      collected.set(name, { def, handler });
      return { remove() {} };
    },
  };
}

/** One tools/list entry, as the SDK serializes it over the wire. */
function wireEntry(name, def) {
  let inputSchema = { type: 'object' };
  try {
    const shape = def.inputSchema ?? {};
    inputSchema = z.toJSONSchema(z.object(shape), { io: 'input', unrepresentable: 'any' });
  } catch {
    inputSchema = { type: 'object' };
  }
  return {
    name,
    description: def.description ?? '',
    inputSchema,
    ...(def.annotations ? { annotations: def.annotations } : {}),
  };
}

export function measure(label, tools) {
  const rows = [];
  for (const [name, entry] of tools) {
    const def = entry.def ?? entry;
    const wire = wireEntry(name, def);
    const descChars = (def.description ?? '').length;
    const total = JSON.stringify(wire).length;
    rows.push({ name, descChars, schemaChars: total - descChars, total });
  }
  rows.sort((a, b) => b.total - a.total);
  const totalChars = rows.reduce((s, r) => s + r.total, 0);
  const descTotal = rows.reduce((s, r) => s + r.descChars, 0);
  return { label, count: rows.length, totalChars, descTotal, totalTokens: estTokens(totalChars), rows };
}

export function ownerTools() {
  const collected = new Map();
  const s = sink(collected);
  registerCatalogTools(s);
  registerServerInfoTool(s, { version: VERSION, mode: { authenticated: true }, getBaseUrl: () => fakeClient.baseUrl });
  registerInviteTools(s, {
    resolveBaseUrl: () => fakeClient.baseUrl,
    onJoined: async () => 'routed',
    onSwitchToGuest: async () => false,
  });
  for (const [name, entry] of collectTools((x) => registerAuthTools(x, { client: fakeClient, allowLan: false }))) {
    collected.set(name, entry);
  }
  return collected;
}

export function seatTools() {
  return collectTools((s) => registerSeatTools(s, { apiBase: 'http://127.0.0.1:9' }));
}

export function instructionBlocks() {
  return [
    ['authServerInstructions', instructions.authServerInstructions(VERSION)],
    ['anonServerInstructions', instructions.anonServerInstructions(VERSION)],
    ['seatServerInstructions', instructions.seatServerInstructions(VERSION)],
  ];
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('measure-tool-surface.mjs')) {
  const blocks = instructionBlocks();
  const surfaces = [measure('owner (authenticated)', ownerTools()), measure('seat server', seatTools())];
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      instructions: blocks.map(([name, text]) => ({ name, chars: text.length, tokens: estTokens(text.length) })),
      surfaces,
    }, null, 2));
  } else {
    console.log('INSTRUCTIONS BLOCKS');
    for (const [name, text] of blocks) {
      console.log(`  ${name.padEnd(24)} ${String(text.length).padStart(7)} chars  ~${estTokens(text.length)} tokens`);
    }
    for (const s of surfaces) {
      console.log(`\nTOOLS/LIST: ${s.label} — ${s.count} tools, ${s.totalChars} chars (${s.descTotal} description), ~${s.totalTokens} tokens`);
      for (const r of s.rows) {
        console.log(`  ${String(r.total).padStart(6)}  ${String(r.descChars).padStart(6)}d ${String(r.schemaChars).padStart(5)}s  ${r.name}`);
      }
    }
  }
}
