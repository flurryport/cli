import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, resolveContext } from '../lib/config.js';
import { AuthApiError, createAuthApiClient, resolveAuthBaseUrl } from '../lib/auth-api.js';
import { guidToBase62 } from '../lib/base62.js';
import { friendlyFetchError } from '../lib/fetch-error.js';
import { sanitizeGuestName } from '../lib/console-handles.js';
import { consoleMessages } from '../lib/console-messages.js';
import { codeMinutesLeft, mintSeatInvite } from '../lib/seat-mint.js';

/**
 * `flurryport seat` — mint a tier-3 seat pairing code (the host's half of the 0.5.0
 * ceremony). The command prints the code for the HUMAN to ferry; the joining agent
 * redeems it through a seat server (or any client that speaks the redemption proof).
 * The code is the only thing that crosses between people: the seat's credentials are
 * minted server-side at redemption and never appear here.
 */
export const seatCommand = new Command('seat')
  .description('Mint a seat pairing code for this endpoint (single use, expires in minutes)')
  .argument('<guest-name>', 'The participant name the seat signs under (its byline on every post)')
  .option('--project <id>', 'Project id (defaults to the single project on the account)')
  .option('--endpoint <id>', 'Endpoint id (defaults to the single endpoint in the project)')
  .option('--hours <n>', 'Seat life in hours, 1 to 168 (default 24)')
  .option('--code-minutes <n>', 'How long the unredeemed pairing code lives, 1 to 1440 minutes (default 10; never past the seat end)')
  .option('--display-name <name>', 'Host wording for landing copy ("Gene invited you to ...")')
  .option('--recipe <ref>', 'Catalog provenance (publisher:slug@version)')
  .option('--account <name>', 'Use a specific stored account for this mint')
  .option('--environment <name>', 'Use a specific environment for this mint')
  .action(async (guestName: string, opts: {
    project?: string;
    endpoint?: string;
    hours?: string;
    codeMinutes?: string;
    displayName?: string;
    recipe?: string;
    account?: string;
    environment?: string;
  }) => {
    // #284a: mint-surface hygiene - a quoted or padded name would mint literally
    // and the console grammar could never address it (quotes are outside the
    // handle alphabet).
    guestName = sanitizeGuestName(guestName);
    if (guestName.length === 0) {
      console.error(chalk.red(consoleMessages.guestNameEmptyArg));
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
              ? 'This account has no projects.'
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

      const hours = opts.hours === undefined ? undefined : Number(opts.hours);
      if (hours !== undefined && (!Number.isInteger(hours) || hours < 1 || hours > 168)) {
        console.error(chalk.red('--hours must be a whole number from 1 to 168.'));
        process.exit(1);
      }

      // #351: the code's own clock, for a handoff that will take longer than ten minutes.
      const codeMinutesOpt = opts.codeMinutes === undefined ? undefined : Number(opts.codeMinutes);
      if (codeMinutesOpt !== undefined && (!Number.isInteger(codeMinutesOpt) || codeMinutesOpt < 1 || codeMinutesOpt > 1440)) {
        console.error(chalk.red('--code-minutes must be a whole number from 1 to 1440.'));
        process.exit(1);
      }

      // The shared mint call (#297): one wire shape for every chair surface.
      const release = await mintSeatInvite(client, endpointId, guestName, {
        displayName: opts.displayName ?? null,
        recipeRef: opts.recipe ?? null,
        expiresInHours: hours ?? null,
        codeMinutes: codeMinutesOpt ?? null,
      });

      const codeMinutes = codeMinutesLeft(release.codeExpiresAt);
      console.log('');
      console.log(`  ${chalk.bold(release.pairingCode)}`);
      console.log('');
      console.log(`Seat minted for ${chalk.bold(release.participantName)} (ref ${release.ref}).`);
      // Refinement 7's required warning: paste-conditioning is the inverted attack.
      console.log(chalk.yellow('Give this code only to the person whose agent should take the seat. It is single use'));
      console.log(chalk.yellow(`and dies in about ${codeMinutes} minutes; their agent redeems it, you never need it again.`));
      console.log(`The seat itself ends ${new Date(release.expiresAt).toISOString()}; posting and reading stop then, the log keeps its bylines forever.`);
      console.log('Their agent redeems it at the room address on the pass: the hosted room by default, a self-hosted ' +
        `${chalk.bold('flurryport seat-server')} only when you run your own.`);
      // #288ii: the wrong-host handoff lesson, spoken at the moment of the mint.
      console.log(consoleMessages.mintReachabilityHint);
    } catch (err) {
      if (err instanceof AuthApiError) {
        if (err.code === 'producer_requires_signing') {
          console.error(chalk.red('This endpoint has no inbound signing configured, so a seat could not be attributed.'));
          console.error(chalk.red('Enable signing first (MCP set_endpoint_signing), then mint the seat.'));
        } else if (err.status === 401 || err.status === 403) {
          console.error(chalk.red('This account cannot mint seats here. Seats are minted by the endpoint owner (or an account-wide token).'));
        } else {
          console.error(chalk.red(err.detail || `Mint failed (${err.status}).`));
        }
        process.exit(1);
      }
      console.error(chalk.red(friendlyFetchError(err instanceof Error ? err : new Error(String(err)))));
      process.exit(1);
    }
  });
