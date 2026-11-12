import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveAuthBaseUrl } from '../lib/auth-api.js';
import { accountAuth, brandIconFiles, buildAccountServer } from '../lib/mcp-account.js';
import { serveMcpHttp } from '../lib/mcp-http.js';
import { resolveRoomsIdleMinutes } from '../lib/rooms.js';

/**
 * `flurryport account-server` - the hosted ACCOUNT connector (Track B). Streamable HTTP
 * only, and the seat server's sibling: where a seat session is nobody until a pairing code
 * is redeemed, an account session is nobody until it presents an OAuth access token from
 * the FlurryPORT authorization server. Every MCP session gets its OWN server bound to the
 * account that opened it. No operator config, no keystore, no signing secret: the API
 * validates each token and enforces everything.
 */
export const accountServerCommand = new Command('account-server')
  .description(
    'Run the FlurryPORT account connector (streamable HTTP): a hosted MCP surface where each session ' +
    "signs in with OAuth and works as that user's account",
  )
  .option(
    '--host <host>',
    'HTTP bind address. Loopback by default; front a TLS reverse proxy for remote clients and pass its ' +
    'public hostname via --allowed-hosts (or FLURRYPORT_MCP_ALLOWED_HOSTS)',
    '127.0.0.1',
  )
  .option('--port <port>', 'HTTP port', '8792')
  .option('--allowed-hosts <hosts>', 'comma-separated public hostnames accepted in the Host header')
  .option('--api-url <url>', 'FlurryPORT API base URL (FLURRYPORT_API_URL still wins; default https://api.flurryport.io)')
  .option(
    '--resource <url>',
    "this connector's public URL, the audience its tokens are issued for " +
    '(FLURRYPORT_MCP_RESOURCE still wins; default https://mcp.flurryport.io)',
  )
  .option(
    '--authorization-server <url>',
    'the OAuth authorization server issuer (FLURRYPORT_OAUTH_ISSUER still wins; default: the API base URL)',
  )
  .option('--idle-minutes <minutes>', 'Close a session that has sent nothing for this long (default 30)')
  .action(async (opts: {
    host: string;
    port: string;
    allowedHosts?: string;
    apiUrl?: string;
    resource?: string;
    authorizationServer?: string;
    idleMinutes?: string;
  }) => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };
    const apiBase = resolveAuthBaseUrl(opts.apiUrl);
    const resource = process.env.FLURRYPORT_MCP_RESOURCE ?? opts.resource ?? 'https://mcp.flurryport.io';
    const issuer = process.env.FLURRYPORT_OAUTH_ISSUER ?? opts.authorizationServer ?? apiBase;
    const idleMinutes = resolveRoomsIdleMinutes(opts.idleMinutes);

    console.error(chalk.dim(
      [
        `flurryport account-server ${pkg.version}: the hosted account connector.`,
        `Resource ${resource}, authorization server ${issuer}, API ${apiBase}.`,
        `Every /mcp request needs an OAuth bearer; idle sessions close after ${idleMinutes} min.`,
      ].join('\n'),
    ));

    const handle = await serveMcpHttp({
      host: opts.host,
      port: Number.parseInt(opts.port, 10),
      allowedHosts: opts.allowedHosts?.split(','),
      idleMs: idleMinutes * 60_000,
      auth: accountAuth(apiBase, resource, issuer),
      publicFiles: brandIconFiles(),
      build: async (bearer) => {
        // serveMcpHttp always supplies the bearer when `auth` is set.
        if (!bearer) throw new Error('account-server session opened without a bearer');
        return buildAccountServer({ apiBase, version: pkg.version, resource: resource.replace(/\/$/, '') }, bearer);
      },
      whoami: () => ({ server: 'flurryport-account', version: pkg.version, resource }),
    });
    await handle.closed;
  });
