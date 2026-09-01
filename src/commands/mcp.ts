import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAnonApiClient } from '../lib/anon-api.js';
import { registerAnonTools } from '../lib/mcp-tools.js';
import { registerCatalogTools } from '../lib/mcp-catalog-tools.js';
import { registerInviteTools } from '../lib/mcp-invite-tools.js';
import { AuthApiError, createAuthApiClient, resolveAuthBaseUrl, type AuthApiClient } from '../lib/auth-api.js';
import { makeRoutingClient, type ScopedCredential } from '../lib/credential-router.js';
import { announceClaim, announceWriteDecision, createAuthSessionState, registerAuthTools, type AuthToolContext } from '../lib/mcp-auth-tools.js';
import { collectTools, registerUnifiedTools } from '../lib/mcp-unified.js';
import { DeviceFlowController } from '../lib/device-flow.js';
import { WriteUpgradeController } from '../lib/write-upgrade.js';
import { clearStoredSession } from '../lib/anon-session.js';
import { isDefaultProdOnly, loadConfig, saveConfig } from '../lib/config.js';
import { guidToBase62 } from '../lib/base62.js';
import { anonServerInstructions, authServerInstructions } from '../lib/mcp-server-instructions.js';
import { registerServerInfoTool } from '../lib/mcp-server-info.js';
import { serveMcpHttp } from '../lib/mcp-http.js';

/**
 * `flurryport mcp` — stdio MCP server (spec §2). Two auth modes auto-select:
 * anonymous (no PAT: the zero-signup wedge over the anon island) and authenticated
 * (PAT present: ships in v1a). v0 serves the anonymous toolset.
 *
 * stdio discipline: stdout belongs to the MCP transport exclusively — every human
 * message goes to stderr.
 */
export const mcpCommand = new Command('mcp')
  .description('Run the FlurryPORT MCP server (stdio, or streamable HTTP with --http) for AI editors - capture and inspect webhooks with no signup')
  .option('--allow-lan', 'permit forward_to_localhost to target private LAN addresses (RFC1918), not just loopback', false)
  .option('--anon-url <url>', 'override the anonymous capture base URL (default https://flurryport.dev or FLURRYPORT_ANON_URL)')
  .option(
    '--ref <source>',
    'attribution source recorded on anon session start (registry listings set this, e.g. --ref smithery); or FLURRYPORT_REF. ' +
    'Attribution ONLY: it does not bind or accept an invite, and the session still boots anonymous - ' +
    'to accept an invite use the join_invite tool (or `flurryport join`)',
  )
  .option(
    '--account <name>',
    "boot as a specific stored CLI account (a joined invite grant parks under its participant name, or 'guest' when unnamed) without changing the active account; or FLURRYPORT_ACCOUNT",
  )
  .option(
    '--http',
    'serve streamable HTTP instead of stdio: remote MCP clients (ChatGPT connectors, hosted agents) connect to /mcp; each MCP session gets its own server state',
    false,
  )
  .option('--port <port>', 'HTTP port (with --http)', '8790')
  .option(
    '--host <host>',
    'HTTP bind address (with --http). Loopback by default so nothing is exposed without an explicit choice; front a tunnel for remote clients ' +
    'and pass the tunnel hostname via --allowed-hosts (or FLURRYPORT_MCP_ALLOWED_HOSTS)',
    '127.0.0.1',
  )
  .option(
    '--allowed-hosts <hosts>',
    'comma-separated public hostnames accepted in the Host header (with --http): the tunnel or reverse-proxy host in front of this server. ' +
    'Loopback names always pass; FLURRYPORT_MCP_ALLOWED_HOSTS also adds to this list',
  )
  .action(async (opts: McpCommandOptions) => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };

    if (opts.http) {
      // Standalone behavior unchanged: default signal handling, block until down.
      const handle = await serveMcpHttp({
        host: opts.host,
        port: Number.parseInt(opts.port, 10),
        allowedHosts: opts.allowedHosts?.split(','),
        build: () => buildMcpServer(opts, pkg.version),
      });
      await handle.closed;
      return;
    }

    const { server, banner } = await buildMcpServer(opts, pkg.version);
    await server.connect(new StdioServerTransport());
    console.error(chalk.dim(banner));
  });

interface McpCommandOptions {
  allowLan: boolean;
  anonUrl?: string;
  ref?: string;
  account?: string;
  http: boolean;
  port: string;
  host: string;
  allowedHosts?: string;
}

/**
 * Builds one fully-wired McpServer (mode detection, toolset, claim flip, invite
 * tools) WITHOUT connecting a transport. stdio connects it once per process; the
 * HTTP listener calls this once per MCP session so concurrent remote sessions get
 * the same per-process state a stdio boot would have had.
 */
async function buildMcpServer(
  opts: { allowLan: boolean; anonUrl?: string; ref?: string; account?: string },
  version: string,
): Promise<{ server: McpServer; banner: string }> {
    // Mode detection (spec §2). Peek without resolveContext() — that helper exits the
    // process when no account exists, which is the NORMAL anonymous-mode case here.
    const pat = detectPat(opts.account || process.env.FLURRYPORT_ACCOUNT || undefined);
    // serverInfo name/version ride the MCP initialize response (hosts may not surface
    // them to the model, so get_server_info below is the model-visible identity path).
    const server = new McpServer(
      { name: 'flurryport', version },
      { instructions: pat ? authServerInstructions(version) : anonServerInstructions(version) },
    );

    // Catalog agent surface (B3.3): mode-independent anonymous reads, registered once in
    // both modes and untouched by the claim flip.
    registerCatalogTools(server);

    // ── Lesson 24: ONE toolset for the whole session lifecycle ─────────────────
    // The full (authed-shaped) inventory is registered exactly once, whatever the
    // boot mode. `mode.authenticated` is read per call: the claim flip and the
    // write grant are field writes on shared context objects, never registration
    // changes — a client that snapshots the tool list at connect (Codex Desktop
    // ignores tools/list_changed entirely) stays fully functional across both
    // transitions.
    const mode = { authenticated: Boolean(pat) };

    if (pat) {
      // Authenticated boot: PAT via env or the CLI's active account. The DEFAULT
      // credential lives in a holder so flips (switchSession, write upgrade) swap it
      // without re-wiring handlers; ctx.client is the ROUTING facade over it plus every
      // stored invite grant — the credential router (0.3.0) that retires the
      // account-switch dance. Reads of a joined endpoint answer as its guest grant on
      // every boot, with nothing to switch and nothing lost on restart.
      const inner = { value: createAuthApiClient(pat.apiUrl, pat.token) };
      const scoped = loadScopedCredentials(pat.apiUrl, pat.token);
      const ctx: AuthToolContext = {
        client: makeRoutingClient(() => inner.value, scoped),
        allowLan: opts.allowLan,
        session: createAuthSessionState(),
        joinedGrants: () => scoped.map((c) => ({ projectId: c.projectId, endpointId: c.endpointId, accountName: c.accountName })),
      };
      if (scoped.length > 0) {
        console.error(chalk.dim(
          `Credential router: also holding ${scoped.map((s) => `'${s.accountName}'`).join(', ')} for joined endpoints.`));
      }

      // Authed boot: an already-signed-in user CAN accept an invite, but we must not hijack
      // their own session with a guest credential scoped to somebody else's endpoint. The
      // grant parks under its participant name and joins the ROUTER immediately, so reads
      // of the joined endpoint work with no switch and no restart ('routed'). switchSession
      // (rung 2) remains the explicit full-repoint opt-in, in process memory only.
      let parkedGuestToken: string | null = null;
      const switchToGuest = (token: string): void => {
        inner.value = createAuthApiClient(pat.apiUrl, token);
        console.error(chalk.green(
          'Switched this session to the invite grant (in-process only; a restart boots back as your account).'));
      };
      registerInviteTools(server, {
        resolveBaseUrl: () => resolveInviteBaseUrl(pat.apiUrl),
        onJoined: async (release, { switchSession, accountName }) => {
          try {
            saveJoinedAccount(release.Token!, accountName, {
              endpointId: release.ContributorEndpointId,
              projectId: release.ContributorProjectId,
            });
          } catch {
            /* config write is best-effort; the keystore write already happened */
          }
          if (switchSession) {
            switchToGuest(release.Token!);
            return 'session_switched';
          }
          parkedGuestToken = release.Token!;
          if (release.ContributorEndpointId) {
            upsertScoped(scoped, {
              endpointId: release.ContributorEndpointId,
              projectId: release.ContributorProjectId ?? undefined,
              accountName,
              client: createAuthApiClient(pat.apiUrl, release.Token!),
            });
            return 'routed';
          }
          return 'stored_only';
        },
        onSwitchToGuest: async () => {
          if (!parkedGuestToken) return false;
          switchToGuest(parkedGuestToken);
          return true;
        },
      });

      // In-flow write grant: request_secret_setup arms this; the server refuses
      // tokens that already have write, so arming is always safe.
      wireWriteUpgrade(ctx, inner);
      registerServerInfoTool(server, { version, mode, getBaseUrl: () => inner.value.baseUrl });
      registerUnifiedTools(server, mode, collectTools((s) => registerAuthTools(s, ctx)), new Map());
      return {
        server,
        banner:
          `flurryport mcp ${version} - authenticated mode against ${inner.value.baseUrl}` +
          (opts.allowLan ? ' (LAN forwarding enabled)' : ''),
      };
    }

    // Anonymous boot, with the device-flow watcher armed (spec §6): the moment the
    // user claims the session in the browser, the server releases a read-only PAT
    // to this process and the SAME tools start answering from the account.
    // Attribution ref (WS-0): flag wins over env; sanitized to the server's contract
    // ([A-Za-z0-9._-]{1,64}) so a malformed value degrades to organic, never a 422.
    const rawRef = opts.ref ?? process.env.FLURRYPORT_REF;
    const attributionRef = rawRef && /^[A-Za-z0-9._-]{1,64}$/.test(rawRef) ? rawRef : undefined;
    const client = createAnonApiClient(opts.anonUrl, attributionRef);
    // Set when the agent requests Flow 2 secret setup pre-claim — the flip then arms
    // the write-upgrade wait immediately, so the grant screen's click releases fast.
    let secretSetupRequested = false;

    // The auth context exists from boot; its DEFAULT client is a pre-flip stub the mode
    // guard makes unreachable, held behind the same routing facade as an authed boot so
    // grants joined mid-session enter the router. The flip swaps the holder.
    const anonInner = { value: preFlipStub() };
    const anonScoped: ScopedCredential[] = [];
    const authCtx: AuthToolContext = {
      client: makeRoutingClient(() => anonInner.value, anonScoped),
      allowLan: opts.allowLan,
      session: createAuthSessionState(),
      joinedGrants: () => anonScoped.map((c) => ({ projectId: c.projectId, endpointId: c.endpointId, accountName: c.accountName })),
    };
    wireWriteUpgrade(authCtx, anonInner);

    const deviceFlow = new DeviceFlowController(client, async (token, release) => {
      try {
        saveMintedToken(token);
      } catch {
        /* config write is best-effort — the in-process flip below still works */
      }
      clearStoredSession();
      anonInner.value = createAuthApiClient(resolveAuthBaseUrl(), token);
      // Migration breadcrumb (0.2.3): orient the agent to the claimed data so it
      // skips the post-flip project/endpoint rediscovery entirely.
      if (release.MigratedProjectId && release.MigratedEndpointId) {
        announceClaim(authCtx.session, {
          projectId: guidToBase62(release.MigratedProjectId),
          endpointId: guidToBase62(release.MigratedEndpointId),
          endpointSlug: release.MigratedEndpointSlug ?? '',
          captureCount: release.MigratedCaptureCount ?? 0,
        });
      }
      mode.authenticated = true; // THE FLIP — a field write; the tool list never changes
      if (secretSetupRequested) authCtx.armWriteUpgrade?.();
      console.error(chalk.green(`Claimed! Same tools, now answering from the account at ${authCtx.client.baseUrl}.`));
    });

    // Anonymous boot: an invitee usually arrives with no account at all, so joining is the
    // moment this session becomes somebody. Reuse the proven claim flip (F6) — swap the auth
    // client and set mode.authenticated, a field write that leaves the tool list untouched.
    registerInviteTools(server, {
      resolveBaseUrl: () => resolveInviteBaseUrl(resolveAuthBaseUrl()),
      onJoined: async (release, { accountName }) => {
        try {
          // A cold invitee has no account at all: the joined grant IS their identity,
          // so it becomes the active account (next boot comes up authenticated as it).
          saveJoinedAccount(release.Token!, accountName, {
            endpointId: release.ContributorEndpointId,
            projectId: release.ContributorProjectId,
          }, { makeActiveIfUnset: true });
        } catch {
          /* best-effort persistence; the in-process flip below still works */
        }
        clearStoredSession();
        anonInner.value = createAuthApiClient(resolveAuthBaseUrl(), release.Token!);
        mode.authenticated = true; // THE FLIP — same tools, now the guest credential
        console.error(chalk.green('Invite accepted. Same tools, now scoped to the endpoint you joined.'));
        return 'session_upgraded';
      },
    });

    // Identity follows the flip: anonymous reachability probes the anon island,
    // a claimed session probes the authed API it now answers from.
    registerServerInfoTool(server, {
      version,
      mode,
      getBaseUrl: () => (mode.authenticated ? anonInner.value.baseUrl : client.baseUrl),
    });

    const anonTools = collectTools((s) =>
      registerAnonTools(s, {
        client,
        allowLan: opts.allowLan,
        deviceFlow,
        onSecretSetupRequested: () => {
          secretSetupRequested = true;
        },
      }));
    registerUnifiedTools(server, mode, collectTools((s) => registerAuthTools(s, authCtx)), anonTools);
    return {
      server,
      banner:
        `flurryport mcp ${version} - anonymous mode against ${client.baseUrl}` +
        (opts.allowLan ? ' (LAN forwarding enabled)' : ''),
    };
}

/**
 * Unreachable-by-design client for the pre-flip auth context (the mode guard
 * routes anonymous-mode calls away from auth handlers). Throwing a structured
 * 401 instead of exploding keeps any future guard bug survivable.
 */
function preFlipStub(): AuthApiClient {
  const refuse = (): never => {
    throw new AuthApiError(401, 'unauthorized', 'Session not claimed yet.');
  };
  return { baseUrl: resolveAuthBaseUrl(), get: refuse, post: refuse, put: refuse, delete: refuse };
}

/**
 * In-flow write grant plumbing (2026-07-20): binds a WriteUpgradeController to a live
 * auth context. Every tool handler closes over the ctx OBJECT, so granting swaps
 * ctx.client in place — the running toolset upgrades mid-conversation, no restart,
 * no re-registration. The outcome lands as a one-time write_granted / write_skipped
 * meta notice on the next authed response.
 */
function wireWriteUpgrade(ctx: AuthToolContext, inner: { value: AuthApiClient }): void {
  const controller = new WriteUpgradeController(
    () => inner.value,
    async (token) => {
      try {
        saveUpgradedToken(token);
      } catch {
        /* config write is best-effort — the in-process swap below still works */
      }
      // Swap the DEFAULT credential in its holder; the routing facade (ctx.client)
      // stays stable, so every tool handler upgrades in place.
      inner.value = createAuthApiClient(inner.value.baseUrl, token);
      announceWriteDecision(ctx.session, true);
      console.error(chalk.green('Write access granted - switched to the read-write token in place.'));
    },
    async () => {
      announceWriteDecision(ctx.session, false);
      console.error(chalk.dim('Write access skipped by the user - staying read-only.'));
    },
  );
  ctx.armWriteUpgrade = () => controller.ensureStarted();
}

/** Persist the device-flow token as a named account so future runs start authenticated. */
/**
 * Where the invite + device routes live. They ride the API host (the same one the landing is
 * served from), so the auth base is the right default; FLURRYPORT_API_URL overrides it for
 * dev and self-hosted instances.
 */
function resolveInviteBaseUrl(fallback: string): string {
  return (process.env.FLURRYPORT_API_URL || fallback).replace(/\/$/, '');
}

/**
 * Boot-time router table: every stored account with an endpoint binding, except the one
 * booting the session. This is what makes joined grants restart-proof — the roster on
 * disk rebuilds the router with zero human action.
 */
function loadScopedCredentials(apiUrl: string, bootToken: string): ScopedCredential[] {
  // Round 3: no catch - a locked config silently dropping every joined grant is
  // the same identity downgrade as detectPat's; the boot path handles the throw.
  {
    const config = loadConfig();
    const env = config.environments[config.activeEnvironment];
    if (!env) return [];
    return Object.entries(env.accounts)
      .filter(([, acc]) => acc.scopeEndpointId && acc.apiKey !== bootToken)
      .map(([name, acc]) => ({
        endpointId: acc.scopeEndpointId,
        projectId: acc.scopeProjectId,
        accountName: name,
        client: createAuthApiClient(apiUrl, acc.apiKey),
      }));
  }
}

/** Register (or refresh) a grant in the live router table, keyed by endpoint. */
function upsertScoped(table: ScopedCredential[], entry: ScopedCredential): void {
  const existing = table.findIndex((c) => c.endpointId === entry.endpointId);
  if (existing >= 0) table[existing] = entry;
  else table.push(entry);
}

/**
 * Park a joined guest credential under the invite's participant name (finding 23: one
 * identity across signer label, watch label, and CLI account) WITHOUT touching
 * activeAccount on an authed boot. The endpoint binding rides along so the credential
 * router can answer joined-endpoint reads from this account on every future boot.
 */
function saveJoinedAccount(
  token: string,
  accountName: string,
  scope: { endpointId?: string | null; projectId?: string | null },
  opts?: { makeActiveIfUnset?: boolean },
): void {
  const config = loadConfig();
  const env = config.environments[config.activeEnvironment];
  if (!env) return;
  env.accounts[accountName] = {
    apiKey: token,
    ...(scope.endpointId ? { scopeEndpointId: scope.endpointId } : {}),
    ...(scope.projectId ? { scopeProjectId: scope.projectId } : {}),
  };
  if (opts?.makeActiveIfUnset && !env.activeAccount) env.activeAccount = accountName;
  saveConfig(config);
}

function saveMintedToken(token: string): void {
  const config = loadConfig();
  const env = config.environments[config.activeEnvironment];
  if (!env) return;
  env.accounts['mcp'] = { apiKey: token };
  if (!env.activeAccount) env.activeAccount = 'mcp';
  saveConfig(config);
}

/**
 * Persist the write-upgraded token over the ACTIVE account (falling back to 'mcp')
 * so the next session starts with the scope the user granted, not the stale
 * read-only sibling. FLURRYPORT_TOKEN env users keep their env value — the swap is
 * in-process only for them, which is the best we can honestly do.
 */
function saveUpgradedToken(token: string): void {
  const config = loadConfig();
  const env = config.environments[config.activeEnvironment];
  if (!env) return;
  const name = env.activeAccount && env.accounts[env.activeAccount] ? env.activeAccount : 'mcp';
  env.accounts[name] = { apiKey: token };
  if (!env.activeAccount) env.activeAccount = name;
  saveConfig(config);
}

function detectPat(accountName?: string): { token: string; apiUrl: string } | null {
  // Invitee-boot rung 3: an explicitly named account (--account / FLURRYPORT_ACCOUNT) is the
  // sharpest identity statement, so it outranks FLURRYPORT_TOKEN and resolves ONLY from stored
  // accounts. A miss is a loud exit: a boot pinned to 'guest' that silently fell back to the
  // operator's account would recreate exactly the stored_only fallthrough this ladder fixes.
  if (accountName) {
    // Round 3: loadConfig throws ONLY on a locked/unreadable config now - swallowing
    // that produced the WRONG loud exit ('account not stored') or, below, a silent
    // anonymous boot with a stored PAT present. Let it propagate: the top-level
    // handler prints it cleanly, and an HTTP per-session build answers 500.
    const config = loadConfig();
    const env = config.environments[config.activeEnvironment];
    const apiKey = env?.accounts[accountName]?.apiKey;
    if (apiKey) return { token: apiKey, apiUrl: resolveAuthBaseUrl(env.apiUrl) };
    // #170: only mention "environment" when the user has a non-default config.
    const plainWording = isDefaultProdOnly(config);
    console.error(chalk.red(
      (plainWording
        ? `Account '${accountName}' is not stored. `
        : `Account '${accountName}' is not stored in the active environment. `) +
      "Run 'flurryport account list' to see stored accounts; a joined invite grant parks under " +
      "the participant name the host gave it (or 'guest' when unnamed)."));
    process.exit(1);
  }
  const envToken = process.env.FLURRYPORT_TOKEN;
  if (envToken && envToken.startsWith('fp_')) {
    return { token: envToken, apiUrl: resolveAuthBaseUrl() };
  }
  // Round 3: no catch - a locked config must fail the boot loudly, never boot
  // this server ANONYMOUS while a stored PAT exists (silent identity downgrade).
  const config = loadConfig();
  const env = config.environments[config.activeEnvironment];
  const active = env?.activeAccount;
  const apiKey = active ? env.accounts[active]?.apiKey : undefined;
  if (apiKey) return { token: apiKey, apiUrl: resolveAuthBaseUrl(env.apiUrl) };
  return null;
}
