import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthToolContext } from './mcp-auth-tools.js';
import type { AnyMetaEnvelope } from './mcp-meta.js';
import { resolveWebBaseUrl } from './mcp-meta.js';
import { fail, ok } from './mcp-response.js';
import { parseReceipt } from './receipts.js';

/**
 * Locker (slice 2 of the platform pass, 2026-11-05): the five account tools of the signed
 * run archive. Registered from registerAuthTools so the unified local server and the hosted
 * connector pick them up alike; the seat server mounts none of them (a seat is a guest at a
 * room, Locker installs belong to an account). verify_receipt, the fifth, is a catalog tool:
 * pure computation, no account.
 *
 * The install key never enters a tool result: create_locker_install returns where the key
 * is (the vault secret name, the key page), and an agent install has no key at all.
 */

const MAX_RUN_BYTES = 1_048_576;
export const LOCKER_TOOL_NAMES = ['archive_run', 'get_locker_run', 'list_locker_installs', 'create_locker_install', 'find_locker_runs'] as const;

export interface LockerToolSeams {
  /** The authed meta envelope for this session (plan-less: Locker has its own allowance). */
  meta: () => AnyMetaEnvelope;
  /** mapAuthError, shared so a 429 or a 404 reads the same as on every other tool. */
  mapError: (err: unknown) => ReturnType<typeof fail>;
  /** The MCP client's name from the initialize handshake; names the agent install. */
  clientName: () => string | null;
  /** 'local' or 'hosted': the agent block on the run document says which surface wrote it. */
  surface: string;
  version: string;
}

type Allowance = {
  State: string; RunsIncluded: number; RunsUsed: number; RunsRemaining: number;
  DaysIncluded: number; DaysRemaining: number; StartedAt: string; EndsAt: string; Exhausted: boolean; PlanUrl: string;
};

function allowanceOut(a: Allowance | undefined) {
  if (!a) return null;
  return {
    state: a.State, runsIncluded: a.RunsIncluded, runsUsed: a.RunsUsed, runsRemaining: a.RunsRemaining,
    daysRemaining: a.DaysRemaining, endsAt: a.EndsAt, exhausted: a.Exhausted, planUrl: a.PlanUrl,
  };
}

function readerUrl(installId: string): string {
  return `${resolveWebBaseUrl()}/locker?install=${encodeURIComponent(installId)}`;
}

function keyPageUrl(installId: string): string {
  return `${resolveWebBaseUrl()}/locker?install=${encodeURIComponent(installId)}&key=1`;
}

const runShape = {
  workflow: z.object({
    id: z.string().max(200).optional(),
    name: z.string().max(200).describe('What the human would call this task or workflow.'),
  }),
  id: z.string().max(200).optional().describe('Your own run or task id. It is the idempotency key: resending the same id with the same document returns the first receipt.'),
  status: z.enum(['success', 'error', 'cancelled', 'waiting', 'running', 'unknown']),
  startedAt: z.string().max(40).optional().describe('ISO 8601.'),
  finishedAt: z.string().max(40).optional().describe('ISO 8601.'),
  error: z.string().max(2000).optional(),
  inputs: z.unknown().optional().describe('What went in: the brief, the arguments. Any JSON.'),
  outputs: z.unknown().optional().describe('What came out: what was delivered, the ids of anything created. Any JSON.'),
  labels: z.record(z.string().max(64), z.string().max(256)).optional().describe('At most 20 string pairs: captureIds, PR numbers, a client name.'),
};

export function registerLockerTools(server: McpServer, ctx: AuthToolContext, seams: LockerToolSeams): void {
  server.registerTool(
    'list_locker_installs',
    {
      title: 'List locker installs',
      description:
        'List the Locker installs this account owns or holds a membership in: the signed run archive, one ' +
        'install per connector (any-HTTP, agent; Zapier, Make and n8n later). Returns installId, endpointId, ' +
        'platform, name, relation (owner or member), runs kept, the chain head, the allowance pooled across ' +
        'the account, and actions (the reader, the key page, the plan page). Read-only. The runs themselves ' +
        'are captures on the install\'s endpointId, so list_captures and get_capture read them too; get_locker_run ' +
        'reads one with its receipt.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const res = await ctx.client.get('/api/v1/locker/installs') as {
          Installs: Array<Record<string, unknown>>; InstalledPlugin: boolean; Allowance: Allowance;
        };
        const installs = (res.Installs ?? []).map((i) => {
          const installId = String(i.InstallId);
          const owner = i.Relation === 'owner';
          const actions = [{ label: 'Open the reader', effect: 'Shows this install\'s runs and receipts.', url: readerUrl(installId) }];
          if (owner && i.Platform === 'http') actions.push({ label: 'Show the install key', effect: 'The owner reads the key once, for a script or a target header.', url: keyPageUrl(installId) });
          return {
            installId, endpointId: i.EndpointId, projectId: i.ProjectId, slug: i.Slug, name: i.Name, platform: i.Platform,
            relation: i.Relation, role: i.Role ?? null, runsKept: i.RunsKept, bytesKept: i.BytesKept, lastRunAt: i.LastRunAt ?? null,
            chainHead: { position: i.ChainIndex, hash: i.ChainHash }, keyId: i.KeyId ?? null, installKeyPrefix: i.InstallKeyPrefix ?? null,
            createdAt: i.CreatedAt, actions,
          };
        });
        const allowance = allowanceOut(res.Allowance);
        return ok({
          installs,
          installedPlugin: res.InstalledPlugin,
          allowance: allowance ? { ...allowance, planUrl: allowance.planUrl } : null,
          hint: installs.length === 0
            ? 'No Locker installs yet. archive_run with no installId creates this agent\'s own install on the free allowance; create_locker_install makes one for a script.'
            : `${installs.length} install(s). archive_run with an installId archives into that chain; a member sees only the installs shared with them.`,
        }, seams.meta());
      } catch (err) {
        return seams.mapError(err);
      }
    },
  );

  server.registerTool(
    'create_locker_install',
    {
      title: 'Create locker install',
      description:
        'Create a Locker install for the any-HTTP connector (platform http: a script, Pipedream, Power Automate, ' +
        'anything that posts JSON with the install key) or for this agent (platform agent: no key, the session ' +
        'is the principal). Returns where the key is, never the key: by default the server writes it into the ' +
        'owner\'s project vault as LOCKER_INSTALL_KEY_{SLUG} so a pipe can use it as $secrets.NAME, and the human ' +
        'reads it once on keyPageUrl. The first install on an account installs Locker on its free allowance ' +
        '(250 runs over 14 days); say so to your human, since a new aside entry appeared. Zapier, Make and n8n ' +
        'installs are created by their own connectors, not here.',
      inputSchema: {
        name: z.string().min(1).max(100).describe('What the installer calls it: the client, the workflow, the script.'),
        platform: z.enum(['http', 'agent']),
        storeKeyAsSecret: z.boolean().optional().describe('Default true. False for a script that will hold the key itself (a vault slot nobody uses would be spent for nothing).'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ name, platform, storeKeyAsSecret }) => {
      try {
        const res = await ctx.client.post('/api/v1/locker/installs', { Name: name, Platform: platform, StoreKeyAsSecret: storeKeyAsSecret ?? true }) as Record<string, unknown>;
        const installId = String(res.InstallId);
        const actions = [{ label: 'Open the reader', effect: 'Shows this install\'s runs and receipts.', url: readerUrl(installId) }];
        if (platform === 'http') actions.push({ label: 'Show the install key', effect: 'The owner reads the key once on the key page.', url: keyPageUrl(installId) });
        return ok({
          installId, endpointId: res.EndpointId, projectId: res.ProjectId, slug: res.Slug, name: res.Name, platform: res.Platform,
          secretName: res.SecretName ?? null,
          keyPageUrl: platform === 'http' ? keyPageUrl(installId) : null,
          installKeyPrefix: res.InstallKeyPrefix ?? null,
          keyId: res.KeyId,
          installedPlugin: res.InstalledPlugin,
          allowance: allowanceOut(res.Allowance as Allowance),
          actions,
          hint: platform === 'agent'
            ? 'Agent install ready: archive_run with this installId. No key exists; the session is the principal.'
            : res.SecretName
              ? `Install ready. The key is in the vault as $secrets.${res.SecretName}; for a script, send the human to keyPageUrl to read it once. Runs post to /api/v1/locker/runs with it as the bearer.`
              : 'Install ready. The key was shown once on the create response the server sent and is not stored; the human reads it on keyPageUrl only if it was stored.',
        }, seams.meta());
      } catch (err) {
        return seams.mapError(err);
      }
    },
  );

  server.registerTool(
    'archive_run',
    {
      title: 'Archive run',
      description:
        'Archive one run into a Locker install and get its signed receipt. Omit installId to use this agent\'s own ' +
        'install, created on first use and named after this MCP client. Archive a whole task (workflow = the task ' +
        'name, inputs = the brief, outputs = what you delivered, labels = the ids of anything you created) or one ' +
        'consequential act; never every tool call. Never blocks on the allowance: past it the run is still kept ' +
        'and allowance.state says so; the plan page is a human act. run.id is the idempotency key (same id and ' +
        'same document: the first receipt, duplicate true; same id, different document: refused). Over 1 MB is ' +
        'refused before storage: resend with digests in place of bodies. The receipt proves FlurryPORT recorded ' +
        'this document at this chain position under this install; it does not prove this agent held a key. ' +
        'Check any receipt offline with verify_receipt.',
      inputSchema: {
        installId: z.string().max(64).optional().describe('From list_locker_installs or create_locker_install; omit for this agent\'s own install.'),
        run: z.object(runShape),
        platform: z.enum(['http', 'agent']).optional().describe('Default agent.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ installId, run, platform }) => {
      try {
        let target = installId;
        let ensured: Record<string, unknown> | null = null;
        if (!target) {
          const name = seams.clientName() ?? 'MCP agent';
          ensured = await ctx.client.post('/api/v1/locker/installs/ensure', { Platform: 'agent', Name: name });
          target = String(ensured.InstallId);
        }
        const doc = {
          schema: 'locker.run/1',
          platform: platform ?? 'agent',
          client: { name: 'flurryport', version: seams.version },
          agent: { name: seams.clientName(), surface: seams.surface },
          workflow: run.workflow,
          run: {
            id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error ?? null,
          },
          inputs: run.inputs ?? null,
          outputs: run.outputs ?? null,
          labels: run.labels ?? {},
        };
        const bytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
        if (bytes > MAX_RUN_BYTES) {
          return fail({
            code: 'locker_run_too_large',
            message: `The run document is ${bytes} bytes; the cap is ${MAX_RUN_BYTES}. Put a SHA-256 digest where inputs or outputs were and resend.`,
          }, seams.meta());
        }
        const res = await ctx.client.post(`/api/v1/locker/installs/${encodeURIComponent(target)}/runs`, doc) as Record<string, unknown>;
        const receipt = parseReceipt(res.Receipt);
        const allowance = allowanceOut(res.Allowance as Allowance);
        return ok({
          receiptId: res.ReceiptId,
          verifyUrl: res.VerifyUrl,
          chain: { position: res.ChainIndex, hash: res.Hash, prevHash: res.PrevHash, installId: res.InstallId },
          receipt,
          stored: { bytes: res.StoredBytes },
          duplicate: res.Duplicate === true,
          allowance,
          ...(ensured ? { install: { installId: target, created: ensured.Created === true, installedPlugin: ensured.InstalledPlugin === true } } : {}),
          hint: res.Duplicate === true
            ? 'Already archived: this is the first receipt for that run id. Nothing was added to the chain.'
            : ensured?.InstalledPlugin === true
              ? 'Archived, and this is the account\'s first Locker install: Locker now has an aside entry in the workspace. Tell your human. The receipt verifies offline with verify_receipt.'
              : allowance?.exhausted
                ? 'Archived and kept; the free allowance is used up, so the reader will lock past it once Billing lands. Relay allowance.planUrl to your human.'
                : 'Archived. Hand the receipt (or verifyUrl) to anyone who should be able to check it; verify_receipt checks it with no account.',
        }, seams.meta());
      } catch (err) {
        return seams.mapError(err);
      }
    },
  );

  server.registerTool(
    'get_locker_run',
    {
      title: 'Get locker run',
      description:
        'Read one archived run with its receipt: the stored document (or its disclosure document after a ' +
        'redaction, or nothing once the body aged out), the chain position, the signature, the install\'s public ' +
        'key, the redacted paths, and the verify URL. The receipt names its canonicalization (RFC 8785) so ' +
        'verify_receipt can check it offline. A member of the install\'s endpoint reads it; a stranger gets 404.',
      inputSchema: {
        receiptId: z.string().max(64),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ receiptId }) => {
      try {
        const res = await ctx.client.get(`/api/v1/locker/runs/${encodeURIComponent(receiptId)}`) as Record<string, unknown>;
        let body: unknown = null;
        if (typeof res.Body === 'string') {
          try { body = JSON.parse(res.Body); } catch { body = res.Body; }
        }
        const receipt = parseReceipt(res.Receipt);
        return ok({
          receiptId: res.ReceiptId,
          kind: res.Kind,
          run: body,
          bodyPurged: res.BodyPurged === true,
          isDisclosure: res.IsDisclosure === true,
          redactions: res.RedactedPaths ?? [],
          facts: { workflowName: res.WorkflowName, runId: res.RunId, status: res.Status, startedAt: res.StartedAt, finishedAt: res.FinishedAt, platform: res.Platform },
          receipt: receipt ? { ...receipt, canonicalization: 'RFC8785', anchor: null } : null,
          chain: { position: res.ChainIndex, hash: res.Hash, prevHash: res.PrevHash },
          install: { id: res.InstallId, name: res.InstallName, slug: res.InstallSlug, platform: res.Platform },
          archivedAt: res.CapturedAt,
          verifyUrl: res.VerifyUrl,
          hint: res.BodyPurged === true
            ? 'The body aged out at the retention window; the receipt still verifies by its hash, signature and chain position.'
            : res.IsDisclosure === true
              ? 'This run was redacted: the document is in disclosure form. verify_receipt with this document checks leafRoot; the redacted leaves verify by their hashes.'
              : 'verify_receipt with this receipt and the run document checks the signature, the chain hash and bodySha256 with no server.',
        }, seams.meta());
      } catch (err) {
        return seams.mapError(err);
      }
    },
  );

  server.registerTool(
    'find_locker_runs',
    {
      title: 'Find locker runs',
      description:
        'Find a value in an install\'s kept runs: the first step of removing something that must not stay ' +
        '(a person\'s email, an order number). The server decrypts the newest runs in the window and walks ' +
        'every JSON leaf; a string or number whose text contains the value matches, case-insensitively. Returns ' +
        'each matching run with the JSON Pointer paths that held it, so a redaction can name exactly those ' +
        'paths. At most 2,000 runs are scanned per call; truncated true with scannedThrough says where it ' +
        'stopped, so narrow the window with since and until. Already-redacted leaves never match. The owner or ' +
        'a member of the install searches it; an install key cannot.',
      inputSchema: {
        installId: z.string().max(64).describe('From list_locker_installs.'),
        value: z.string().min(2).max(200).describe('The text to find, 2 to 200 characters.'),
        since: z.string().max(40).optional().describe('ISO 8601: runs archived at or after this instant.'),
        until: z.string().max(40).optional().describe('ISO 8601: runs archived at or before this instant.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ installId, value, since, until }) => {
      try {
        const q = new URLSearchParams({ q: value });
        if (since) q.set('since', since);
        if (until) q.set('until', until);
        const res = await ctx.client.get(`/api/v1/locker/installs/${encodeURIComponent(installId)}/search?${q.toString()}`) as {
          Matches: Array<Record<string, unknown>>; Scanned: number; Truncated: boolean; ScannedThrough: string | null;
        };
        const matches = (res.Matches ?? []).map((x) => ({
          receiptId: x.ReceiptId, chainPosition: x.ChainIndex, archivedAt: x.CapturedAt,
          workflowName: x.WorkflowName ?? null, runId: x.RunId ?? null, status: x.Status ?? null,
          redacted: x.Redacted === true, paths: x.Paths ?? [],
        }));
        const summary = `${matches.length} matching run(s) in ${res.Scanned} scanned` + (res.Truncated ? `; stopped at ${res.ScannedThrough}, the window holds older runs` : '');
        return ok({
          matches,
          scanned: res.Scanned,
          truncated: res.Truncated === true,
          scannedThrough: res.ScannedThrough ?? null,
          summary,
          hint: res.Truncated === true
            ? 'The scan hit its cap. Pass until = scannedThrough (or a narrower since/until) and call again for the older runs.'
            : matches.length === 0
              ? 'Nothing in the window holds that value. Widen the window or try another spelling.'
              : 'To remove the value, the install\'s owner redacts each run by its paths in the reader (Redact these); get_locker_run reads any of them with its receipt.',
        }, seams.meta());
      } catch (err) {
        return seams.mapError(err);
      }
    },
  );
}
