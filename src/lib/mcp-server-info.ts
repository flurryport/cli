import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { peekCliUpdateNotice, recordCliNotice } from './version-nudge.js';

/**
 * get_server_info (#106 identity half, Codex round-2 preamble finding): agents asked
 * "what version of flurryport tools do you have?" searched the local PATH (nothing
 * there answers for an MCP server) and found no version anywhere in the registry
 * surface. This tool is the model-visible identity: name, CLI version, API base,
 * mode, reachability, and the server-composed staleness notice when this CLI is
 * behind LATEST_CLI_VERSION. serverInfo.name/version also ride the MCP initialize
 * response, but hosts may not expose that to the model - this tool always is.
 *
 * Registered directly on the server (like the catalog tools): mode-independent,
 * never account_required, identical in both boot modes, untouched by the claim flip.
 */

export interface ServerInfoSource {
  /** CLI package version (single source of truth: package.json, read at boot). */
  version: string;
  /** Live mode flag - the SAME object the unified toolset flips at claim. */
  mode: { authenticated: boolean };
  /** Current API base URL (mode-aware; follows the claim flip). */
  getBaseUrl: () => string;
}

const PING_TIMEOUT_MS = 3_000;

export function registerServerInfoTool(server: McpServer, source: ServerInfoSource): void {
  server.registerTool(
    'get_server_info',
    {
      title: 'Server info',
      description:
        'Identity and health of this FlurryPORT MCP server: CLI version, API base URL, session mode ' +
        '(authenticated or anonymous), server reachability, and whether a newer CLI version is available. ' +
        'Call this to answer "what version of the FlurryPORT tools do I have?" or to diagnose ' +
        'connectivity; never inspect the local PATH for that.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const apiBaseUrl = source.getBaseUrl();

      // Cheap reachability probe (#172). Uses a routed path — prod ingress only
      // forwards /api/v1/*, so a bare /health 404s at the edge and made a healthy
      // server read as unreachable. ANY HTTP response (even 404/401) proves the
      // server answered; only a network error/timeout means unreachable. Bounded so
      // a dead network answers in 3s, not an OS-level TCP timeout. The probe
      // response also refreshes the staleness latch when the server stamps the
      // notice header.
      let serverReachable = false;
      try {
        const res = await fetch(`${apiBaseUrl}/api/v1/billing/plans`, {
          signal: AbortSignal.timeout(PING_TIMEOUT_MS),
        });
        recordCliNotice(res);
        serverReachable = true;
      } catch {
        serverReachable = false;
      }

      // The server owns the staleness verdict (X-FlurryPort-Cli-Notice, latched from
      // Core responses). Present = a newer version exists and the notice text says so;
      // null = current as far as the server has said, or no Core call has answered yet.
      // Peek, never take: this surface's JOB is the verdict, so the meta builders'
      // once-per-process dedupe must not blank it.
      const notice = peekCliUpdateNotice();

      const payload = {
        name: 'FlurryPORT',
        cliVersion: source.version,
        apiBaseUrl,
        mode: source.mode.authenticated ? 'authenticated' : 'anonymous',
        serverReachable,
        updateAvailable: notice !== null,
        updateNotice: notice?.message ?? null,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
    },
  );
}
