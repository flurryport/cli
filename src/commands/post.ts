import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import chalk from 'chalk';
import { loadConfig, resolveContext } from '../lib/config.js';
import { AuthApiError, createAuthApiClient, resolveAuthBaseUrl } from '../lib/auth-api.js';
import { guidToBase62 } from '../lib/base62.js';
import { chooseIntentKey, deliverIntent } from '../lib/intent-post.js';
import { friendlyFetchError } from '../lib/fetch-error.js';

/**
 * `flurryport post` — send an intent to an endpoint from the terminal (pilot-1 ledger
 * item 5: posting used to be reachable only through the MCP tool surface, so seats
 * without an MCP host had to hand-roll stdio JSON-RPC to participate).
 *
 * Same delivery core as the MCP post_intent tool (lib/intent-post.ts): the body is
 * HMAC-signed with the local keystore key when one exists (the owner key from
 * set_endpoint_signing, or the per-endpoint contributor key from `flurryport join`),
 * and goes unsigned only when the endpoint explicitly runs with signing disabled.
 * The key never appears in output or arguments.
 */
export const postCommand = new Command('post')
  .description('Post an intent to an endpoint, signed with your stored key (owner or contributor)')
  .argument('[body]', 'The intent payload as a JSON string (or use --file, or pipe via stdin)')
  .option('--project <id>', 'Project id (from a join receipt or the MCP list_projects)')
  .option('--endpoint <id>', 'Endpoint id (from a join receipt or the MCP list_endpoints)')
  .option('--file <path>', 'Read the payload from a file instead of the argument')
  .option('--content-type <type>', 'Content-Type header (default: application/json)')
  .option('--account <name>', 'Use a specific stored account for this post')
  .option('--environment <name>', 'Use a specific environment for this post')
  .action(async (bodyArg: string | undefined, opts: {
    project?: string;
    endpoint?: string;
    file?: string;
    contentType?: string;
    account?: string;
    environment?: string;
  }) => {
    // Payload source precedence: --file, then the argument, then piped stdin.
    let body: string | null = null;
    if (opts.file) {
      try {
        body = readFileSync(opts.file, 'utf8');
      } catch {
        console.error(chalk.red(`Could not read ${opts.file}.`));
        process.exit(1);
      }
    } else if (bodyArg !== undefined) {
      body = bodyArg;
    } else if (!process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      body = Buffer.concat(chunks).toString('utf8');
    }
    if (!body || body.trim().length === 0) {
      console.error(chalk.red('No payload. Pass it as an argument, with --file, or pipe it via stdin.'));
      process.exit(1);
    }

    const config = loadConfig();
    const context = resolveContext(config, { environment: opts.environment, account: opts.account });
    const client = createAuthApiClient(resolveAuthBaseUrl(context.apiUrl), context.apiKey);

    let projectId = opts.project;
    let endpointId = opts.endpoint;
    try {
      // No ids: resolve the single project + endpoint, or say exactly what to pass.
      if (!projectId || !endpointId) {
        const projects = (await client.get('/api/v1/projects')) as { Projects?: Array<{ Id: string }> };
        const list = projects.Projects ?? [];
        if (!projectId) {
          if (list.length !== 1) {
            console.error(chalk.red(list.length === 0
              ? 'This account has no projects. Pass --project and --endpoint from your join receipt.'
              : 'More than one project exists. Pass --project (and --endpoint).'));
            process.exit(1);
          }
          projectId = guidToBase62(list[0].Id);
        }
        if (!endpointId) {
          const endpoints = (await client.get(`/api/v1/projects/${projectId}/endpoints`)) as {
            Endpoints?: Array<{ Id: string }>;
          };
          const eps = endpoints.Endpoints ?? [];
          if (eps.length !== 1) {
            console.error(chalk.red(eps.length === 0
              ? 'The project has no endpoints.'
              : 'The project has more than one endpoint. Pass --endpoint.'));
            process.exit(1);
          }
          endpointId = guidToBase62(eps[0].Id);
        }
      }

      const endpoint = (await client.get(`/api/v1/projects/${projectId}/endpoints/${endpointId}`)) as {
        Slug?: string;
        SigningHeader?: string | null;
        SigningEnabled?: boolean | null;
      };
      if (!endpoint.Slug) {
        console.error(chalk.red('Endpoint not found.'));
        process.exit(1);
      }

      const chosen = chooseIntentKey(endpointId);
      if (!chosen && endpoint.SigningEnabled !== false) {
        // Fail closed unless the server EXPLICITLY reports signing disabled — same
        // rule as post_intent. Plain HTTP is NOT sufficient against a signed endpoint.
        console.error(chalk.red('No signing key in the local keystore for this endpoint, and the endpoint enforces HMAC signing.'));
        console.error(chalk.red('Unsigned posts bounce 401 at the signing wall. If you own the endpoint, set up signing (MCP set_endpoint_signing); if you were invited as a producer, run "flurryport join <token>" to store the contributor key.'));
        process.exit(1);
      }

      const delivery = await deliverIntent({
        baseUrl: client.baseUrl,
        projectId,
        endpointSlug: endpoint.Slug,
        body,
        contentType: opts.contentType,
        signingKey: chosen?.credential.value ?? null,
        headerName: endpoint.SigningHeader || 'X-Flurry-Signature',
      });

      if (delivery.httpStatus === 401) {
        console.error(chalk.red('The endpoint rejected the post at the signing wall (401): the HMAC signature did not match.'));
        console.error(chalk.red(chosen
          ? 'The local key no longer matches the server. If you own the endpoint, rotate the pair (MCP set_endpoint_signing); if you are a contributor, ask for a fresh invite.'
          : 'This endpoint enforces HMAC signing; plain HTTP is not sufficient. Join as a producer or set up signing first.'));
        process.exit(1);
      }
      if (!delivery.ok) {
        console.error(chalk.red(`Capture URL answered ${delivery.httpStatus}. ${delivery.errorText}`.trim()));
        process.exit(1);
      }

      console.log(chalk.green(chosen
        ? `Posted SIGNED (${delivery.sizeBytes} bytes in ${delivery.durationMs}ms).`
        : `Posted UNSIGNED - this endpoint runs with signing disabled (${delivery.sizeBytes} bytes in ${delivery.durationMs}ms).`));
      if (delivery.captureId) console.log(`  captureId: ${delivery.captureId}`);
      if (delivery.executions && delivery.executions.length > 0) {
        for (const e of delivery.executions) {
          console.log(`  execution: ${e.executionId} (target ${e.targetId})`);
        }
      }
      // #360b: a re-linked proposal earns a server-computed summary of what it revises.
      if (delivery.postDiff) {
        const d = delivery.postDiff;
        console.log(`  diff vs ${d.section}: ${
          d.oversize
            ? 'too large to compare'
            : d.unchanged
              ? 'unchanged'
              : `+${d.linesAdded} -${d.linesRemoved} ~${d.linesChanged} lines`
        }`);
      }
    } catch (err) {
      if (err instanceof AuthApiError) {
        console.error(chalk.red(err.status === 404
          ? 'Not found: the project or endpoint id is wrong, or this account cannot see it.'
          : err.detail || `The API answered ${err.status}.`));
      } else {
        console.error(chalk.red(friendlyFetchError(err as Error)));
      }
      process.exit(1);
    }
  });
