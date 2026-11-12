import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AuthApiError, createAuthApiClient, type AuthApiClient } from './auth-api.js';
import { BRAND_ICON_MIME, BRAND_ICON_PNG, BRAND_ICON_SIZES } from './brand-icon.js';
import { createAuthSessionState, registerAuthTools, type AuthToolContext } from './mcp-auth-tools.js';
import { registerCatalogTools } from './mcp-catalog-tools.js';
import type { McpHttpAuth, SessionBearer } from './mcp-http.js';
import { registerServerInfoTool } from './mcp-server-info.js';
import { accountServerInstructions } from './mcp-server-instructions.js';
import { collectTools } from './mcp-unified.js';

/**
 * The hosted ACCOUNT connector (Track B, mcp.flurryport.io): one MCP session = one
 * FlurryPORT account, authenticated by the OAuth access token the client presents.
 *
 * ONE TOOL CODEBASE, like the seat surface: the handlers are the authed stdio handlers,
 * mounted through collectTools. So the meta envelope (throttle, notices, actions) is the
 * same code on every surface and a remote session cannot fork it. What differs is only
 * where the credential comes from (the session's live bearer, never a stored PAT) and
 * which tools mount.
 *
 * This process holds no signing secret and enforces nothing: every call carries the
 * bearer to the API, which validates the token and applies scope, tenant isolation,
 * the PAT allowlist, redaction, and the per-account rate limit.
 */

/**
 * The remote toolset is an ALLOWLIST, so a machine-local tool added to the authed
 * inventory later stays off this surface until someone decides it belongs here.
 * Deliberately absent because they need the user's own machine or its disk:
 * forward_to_localhost, start_echo_server (loopback); set_endpoint_signing, request_seat
 * (the CLI keystore); read_pipe_manifest, write_pipe_manifest (a local file);
 * join_invite (keystore + config).
 */
export const ACCOUNT_TOOLS: readonly string[] = [
  // reads
  'list_projects', 'get_project', 'get_project_plan', 'get_upgrade_options',
  'list_endpoints', 'get_endpoint', 'get_capture_url',
  'list_captures', 'get_capture', 'get_capture_digest', 'get_capture_executions',
  'capture_count', 'wait_for_captures',
  'list_replay_targets', 'get_replay_target', 'list_replay_executions', 'get_replay_execution',
  'list_collections', 'get_collection', 'get_transformations', 'list_watches',
  // delivery + pipes
  'replay_to_target', 'send_test_event', 'create_endpoint',
  'create_replay_target', 'update_replay_target', 'set_target_headers',
  'create_transformation', 'update_transformation', 'bind_transformation',
  'request_secret_setup', 'record_recipe_install', 'register_watch', 'set_watch_enabled',
  // rooms
  'post_intent', 'get_canon', 'list_sections', 'set_orientation',
  'create_collection', 'add_to_collection', 'remove_from_collection', 'replace_collection_item',
  'mint_seat', 'authorize_standing', 'create_invite', 'revoke_invite', 'list_members', 'revoke_member',
  // Locker (slice 2, 2026-11-05): every call is an API call with the session bearer, and the
  // receipt's signature is the server's per-install key, so a hosted archive_run is exactly as
  // signed as a local one. verify_receipt rides the catalog set.
  'list_locker_installs', 'create_locker_install', 'archive_run', 'get_locker_run',
  // 0.6.14 (2026-11-06): the find-a-value scan; read-only, refused for an install key.
  'find_locker_runs',
];

export const ACCOUNT_SCOPES = ['mcp:read', 'mcp:write'];

/** An API client that answers as the session's CURRENT bearer (the client refreshes it every 15 minutes). */
function bearerClient(apiBase: string, bearer: SessionBearer): AuthApiClient {
  // Multi-principal process: never touch the module-global CLI-notice latch.
  const now = (): AuthApiClient => createAuthApiClient(apiBase, bearer.current(), { trackCliNotices: false });
  return {
    baseUrl: apiBase,
    get: (path, opts) => now().get(path, opts),
    post: (path, body) => now().post(path, body),
    put: (path, body) => now().put(path, body),
    delete: (path) => now().delete(path),
    credentialFor: () => null,
  };
}

export interface AccountServerOptions {
  apiBase: string;
  version: string;
  /** This connector's public URL (no trailing slash): where its icon is served from. */
  resource: string;
}

/** The connector's logo, served at both paths clients try while rendering the install card. */
export function brandIconFiles(): Record<string, { contentType: string; body: Buffer }> {
  const file = { contentType: BRAND_ICON_MIME, body: BRAND_ICON_PNG };
  return { '/icon.png': file, '/favicon.ico': file };
}

export function buildAccountServer(
  opts: AccountServerOptions,
  bearer: SessionBearer,
): { server: McpServer; banner: string } {
  const server = new McpServer(
    {
      name: 'flurryport',
      title: 'FlurryPORT',
      version: opts.version,
      websiteUrl: 'https://flurryport.io',
      // The logo the client shows for this connector (MCP icons, 2025-11 spec).
      icons: [{ src: `${opts.resource}/icon.png`, mimeType: BRAND_ICON_MIME, sizes: BRAND_ICON_SIZES }],
    },
    { instructions: accountServerInstructions(opts.version) },
  );
  registerCatalogTools(server);
  registerServerInfoTool(server, {
    version: opts.version,
    mode: { authenticated: true },
    getBaseUrl: () => opts.apiBase,
  });

  const ctx: AuthToolContext = {
    client: bearerClient(opts.apiBase, bearer),
    allowLan: false,
    session: createAuthSessionState(),
    // No disk keystore on a hosted pod: post_intent posts unsigned, and a signed
    // endpoint answers with its own honest 401.
    intentKey: () => null,
    clientName: () => server.server.getClientVersion()?.name ?? null,
    surface: 'hosted',
    version: opts.version,
  };
  const registry = collectTools((s) => registerAuthTools(s, ctx));
  for (const name of ACCOUNT_TOOLS) {
    const tool = registry.get(name);
    // A renamed or removed tool must fail the boot loudly, never thin the surface silently.
    if (!tool) throw new Error(`account toolset names "${name}", which the authed inventory does not register`);
    server.registerTool(name, tool.def as never, tool.handler as never);
  }

  return { server, banner: `account ${bearer.subject.slice(0, 8)}… against ${opts.apiBase}` };
}

/**
 * The transport's authorization config. verify() is the authoritative open-time check:
 * one cheap read as the bearer. 401/403 = not a usable token; anything else (a 5xx, a
 * network fault) is the API's trouble and is surfaced, never mistaken for a bad token.
 */
export function accountAuth(apiBase: string, resource: string, authorizationServer: string): McpHttpAuth {
  return {
    resource: resource.replace(/\/$/, ''),
    authorizationServer: authorizationServer.replace(/\/$/, ''),
    scopesSupported: ACCOUNT_SCOPES,
    verify: async (token) => {
      try {
        await createAuthApiClient(apiBase, token, { trackCliNotices: false }).get('/api/v1/projects');
        return true;
      } catch (err) {
        if (err instanceof AuthApiError && (err.status === 401 || err.status === 403)) return false;
        throw err;
      }
    },
  };
}
