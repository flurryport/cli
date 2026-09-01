import { randomBytes } from 'node:crypto';
import { Command, Option } from 'commander';
import chalk from 'chalk';
import * as readline from 'readline';
import { isDefaultProdOnly, loadConfig, resolveContext } from '../lib/config.js';
import { ApiError, createApiClient } from '../lib/api.js';
import { guidToBase62 } from '../lib/base62.js';
import { isLocalTarget } from '../lib/local-target.js';
import { friendlyFetchError } from '../lib/fetch-error.js';
import { sanitizeWireLine } from '../lib/sanitize.js';
import { startSerialPoll } from '../lib/serial-poll.js';

// Server returns DateTime.UtcNow values, but EF Core reads SQL datetime
// columns as Kind=Unspecified, so the JSON serializer drops the Z suffix.
// Treat bare ISO strings as UTC.
function parseUtcDate(s: string): Date {
  return /[Zz]|[+-]\d{2}:?\d{2}$/.test(s) ? new Date(s) : new Date(s + 'Z');
}

interface Project {
  Id: string;
  Name: string;
  Slug: string;
}

interface Endpoint {
  Id: string;
  Name: string;
  Slug: string;
}

interface ReplayTarget {
  Id: string;
  Name: string;
  BaseUrl: string;
  EndpointId: string;
  AutoReplay: boolean;
}

interface CapturedRequest {
  Id: string;
  CreatedAt: string;
  HttpMethod: string;
  Headers: string;
  BodyBytes: string | null;
  ContentType: string | null;
  QueryString: string | null;
  ProviderHint: string | null;
  ProviderEventType: string | null;
  // Present when the server applied the target's custom-header overlay during
  // the fetch (i.e. ?targetId=<b62> was passed). Non-empty means one or more
  // $secrets.X references on the target's headers couldn't be resolved —
  // the CLI must refuse to forward; sending would leak the literal token.
  MissingSecrets: string[] | null;
}

interface TargetChoice {
  target: ReplayTarget;
  project: Project;
  endpoint: Endpoint;
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function discoverTargets(api: ReturnType<typeof createApiClient>): Promise<TargetChoice[]> {
  const projectsResult = await api.get('/api/v1/projects');
  const projects = (projectsResult.Projects ?? []) as Project[];
  const choices: TargetChoice[] = [];

  for (const project of projects) {
    const endpointsResult = await api.get(`/api/v1/projects/${guidToBase62(project.Id)}/endpoints`);
    const endpoints = (endpointsResult.Endpoints ?? []) as Endpoint[];

    for (const endpoint of endpoints) {
      const targetsResult = await api.get(`/api/v1/projects/${guidToBase62(project.Id)}/endpoints/${guidToBase62(endpoint.Id)}/replay-targets`);
      const targets = (targetsResult.ReplayTargets ?? []) as ReplayTarget[];

      // Classify in parallel — DNS for hostnames is the slow path, and a user
      // with many targets in one endpoint shouldn't wait sequentially.
      const classifications = await Promise.all(
        targets.map(async (target) => ({ target, isLocal: await isLocalTarget(target.BaseUrl) })),
      );
      for (const { target, isLocal } of classifications) {
        if (isLocal) {
          choices.push({ target, project, endpoint });
        }
      }
    }
  }

  return choices;
}

async function selectTarget(choices: TargetChoice[]): Promise<TargetChoice> {
  if (choices.length === 0) {
    console.error(chalk.red('No localhost replay targets found.'));
    console.error(chalk.dim('Create a replay target pointing at localhost in the FlurryPORT UI first.'));
    process.exit(1);
  }

  if (choices.length === 1) {
    console.clear();
    const c = choices[0];
    console.log(chalk.dim(`Auto-selected: ${c.target.BaseUrl} (${c.project.Slug}/${c.endpoint.Slug})`));
    return c;
  }

  console.clear();
  console.log(chalk.bold('Found localhost replay targets:\n'));
  choices.forEach((c, i) => {
    const auto = c.target.AutoReplay ? chalk.green(' auto') : '';
    console.log(`  ${chalk.bold(String(i + 1))}. ${c.target.BaseUrl}${auto}`);
    console.log(`     ${chalk.dim(`${c.project.Slug} / ${c.endpoint.Slug} - ${c.target.Name}`)}`);
  });

  const answer = await prompt(`\nAttach to (1-${choices.length}): `);
  const idx = parseInt(answer, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= choices.length) {
    console.error(chalk.red('Invalid selection.'));
    process.exit(1);
  }

  console.clear();
  return choices[idx];
}

function parseHeaders(headersJson: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const parsed = JSON.parse(headersJson) as Record<string, string[]>;
    for (const [key, values] of Object.entries(parsed)) {
      // Skip hop-by-hop and host headers
      const lower = key.toLowerCase();
      if (lower === 'host' || lower === 'transfer-encoding' || lower === 'connection') continue;
      result[key] = values.join(', ');
    }
  } catch { /* ignore */ }
  return result;
}

interface ForwardResult {
  statusCode: number;
  responseHeaders: string | null;
  responseBodyPreview: string | null;
  durationMs: number;
  error: string | null;
}

/** Exported for the precedent-#5 harness: the printed line is wire-driven and must stay escape-free. */
export async function forwardCapture(capture: CapturedRequest, forwardUrl: string): Promise<ForwardResult> {
  let body: Buffer | undefined;
  if (capture.BodyBytes) {
    body = Buffer.from(capture.BodyBytes, 'base64');
  }

  const headers = parseHeaders(capture.Headers);
  const url = capture.QueryString
    ? `${forwardUrl}?${capture.QueryString}`
    : forwardUrl;

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: capture.HttpMethod ?? 'POST',
      headers,
      body,
    });
    const duration = Date.now() - start;
    // Wire data drives this terminal line: an unauthenticated capture body can carry
    // ANSI escapes in its provider fields (precedent #5) - strip before printing.
    const provider = capture.ProviderHint ? chalk.cyan(`[${sanitizeWireLine(capture.ProviderHint)}]`) : '';
    const eventType = sanitizeWireLine(capture.ProviderEventType ?? capture.HttpMethod ?? '');
    const status = res.status < 300
      ? chalk.green(`${res.status} ${res.statusText}`)
      : chalk.red(`${res.status} ${res.statusText}`);

    const now = new Date().toLocaleTimeString();
    const captured = parseUtcDate(capture.CreatedAt).toLocaleTimeString();
    console.log(
      `${now} ${chalk.dim(`← ${captured}`)} ${provider} ${eventType} → ${status} ${chalk.dim(`(${duration}ms)`)}`,
    );

    // Capture response for recording — values as string[] to match ReplayHttpBuilder format
    const resHeaders: Record<string, string[]> = {};
    res.headers.forEach((v, k) => { resHeaders[k] = [v]; });
    const bodyText = await res.text().catch(() => null);

    return {
      statusCode: res.status,
      responseHeaders: JSON.stringify(resHeaders),
      responseBodyPreview: bodyText?.slice(0, 4096) ?? null,
      durationMs: duration,
      error: null,
    };
  } catch (err) {
    const duration = Date.now() - start;
    const message = friendlyFetchError(err as Error);
    const now = new Date().toLocaleTimeString();
    const captured = parseUtcDate(capture.CreatedAt).toLocaleTimeString();
    console.log(
      `${now} ${chalk.dim(`← ${captured}`)} ${chalk.red('✗')} ${message} ${chalk.dim(`(${duration}ms)`)}`,
    );
    return {
      statusCode: 0,
      responseHeaders: null,
      responseBodyPreview: null,
      durationMs: duration,
      error: message,
    };
  }
}

export const listenCommand = new Command('listen')
  .description('Attach to a localhost replay target and forward executions')
  .option('--interval <ms>', 'Poll interval in milliseconds', '3000')
  .option('--account <name>', 'Account to use (overrides active account)')
  // #170: hidden from help — environments are an advanced concept (matching the
  // hidden config *-env subcommands); the flag still works for those who use it.
  .addOption(new Option('--environment <name>', 'Environment to use (overrides active environment)').hideHelp())
  .action(async (opts) => {
    const config = loadConfig();
    const context = resolveContext(config, { environment: opts.environment, account: opts.account });

    // #170: on the default single-prod config, don't surface the environment concept.
    console.log(chalk.dim(!opts.environment && isDefaultProdOnly(config)
      ? `Account: ${context.accountName}\n`
      : `Environment: ${context.environmentName}  Account: ${context.accountName}\n`));

    const api = createApiClient(context);
    const interval = parseInt(opts.interval, 10);
    const startTime = new Date().toISOString();

    console.log(chalk.dim('Discovering localhost replay targets...\n'));
    const choices = await discoverTargets(api);
    const chosen = await selectTarget(choices);

    const { target, project, endpoint } = chosen;

    // Listener lease: a stable per-process holder id rides every claim/poll.
    // The server grants the lease to one live holder per target; a second
    // `flurryport listen` on the same target gets 409 instead of silently
    // splitting the execution stream.
    const holder = `cli-${randomBytes(8).toString('hex')}`;
    const leaseLost = (err: unknown): boolean =>
      err instanceof ApiError && err.status === 409;
    const exitLeaseLost = () => {
      console.error(chalk.red('Another session is attached to this target.'));
      console.error(chalk.dim('Stop the other `flurryport listen` (or MCP session) first, or wait ~30s for its lease to lapse.'));
      process.exit(1);
    };

    // Claim stale pending executions (created before CLI started)
    try {
      const claimed = await api.post(
        `/api/v1/replay-executions/claim?targetId=${guidToBase62(target.Id)}&before=${encodeURIComponent(startTime)}&holder=${holder}`,
        {},
      );
      const count = (claimed as { DeadLettered?: number }).DeadLettered ?? 0;
      if (count > 0) {
        console.log(chalk.dim(`Cleaned up ${count} stale pending execution(s).`));
      }
    } catch (err) {
      if (leaseLost(err)) exitLeaseLost();
      // Otherwise non-fatal — continue even if claim fails
    }

    console.log(chalk.green(`Listening on ${target.BaseUrl}`));
    console.log(chalk.dim(`${project.Slug}/${endpoint.Slug} → ${target.Name}`));
    console.log(chalk.dim(`Polling every ${interval}ms. Press Ctrl+C to stop.\n`));

    const seenSequences = new Set<string>();
    let runCounter = 0;

    const poll = async () => {
      try {
        // The poll doubles as the lease renewal — same holder wins every time
        // while this process is alive.
        const result = await api.get(
          `/api/v1/replay-executions/pending?targetId=${guidToBase62(target.Id)}&take=20&holder=${holder}`,
        );

        const executions = ((result.Executions ?? []) as {
          Id: string;
          CapturedRequestId: string;
          ReplayTargetId: string;
          SequenceId: string | null;
          CollectionName: string | null;
          CreatedAt: string;
        }[]);

        for (const exec of executions) {
          // Print run header when a new sequence is seen
          if (exec.SequenceId && !seenSequences.has(exec.SequenceId)) {
            seenSequences.add(exec.SequenceId);
            // Bound the set for long-lived listens (precedent #4): evict oldest
            // first - worst case a very old sequence reprints its header line.
            if (seenSequences.size > 500) {
              const oldest = seenSequences.values().next().value;
              if (oldest !== undefined) seenSequences.delete(oldest);
            }
            runCounter++;
            const label = exec.CollectionName ? sanitizeWireLine(exec.CollectionName) : `Run ${runCounter}`;
            console.log(chalk.bold.cyan(`\n── ${label} ──`));
          }

          // Fetch the original captured request WITH the target context so
          // the server applies the per-target custom-header overlay and
          // resolves $secrets.NAME references before returning. This keeps
          // the CLI dumb: it forwards whatever headers the server hands it.
          const full = await api.get(
            `/api/v1/endpoints/${guidToBase62(endpoint.Id)}/captured-requests/${guidToBase62(exec.CapturedRequestId)}?targetId=${guidToBase62(target.Id)}`,
          ) as unknown as CapturedRequest;

          // Refuse to forward when one or more secrets couldn't be resolved.
          // Surfacing this as a recorded failure mirrors the server-side
          // ProcessExecutions short-circuit and keeps the destination from
          // seeing a literal "Bearer $secrets.X".
          if (full.MissingSecrets && full.MissingSecrets.length > 0) {
            const names = full.MissingSecrets.join(', ');
            const msg = `Missing secret: ${names}`;
            const now = new Date().toLocaleTimeString();
            console.log(`${chalk.dim(now)} ${chalk.red('✗')} ${msg}`);
            try {
              await api.post('/api/v1/replay/record', {
                ExecutionId: exec.Id,
                CapturedRequestId: exec.CapturedRequestId,
                ReplayTargetId: exec.ReplayTargetId,
                ResponseStatusCode: null,
                ResponseHeaders: null,
                ResponseBodyPreview: null,
                DurationMs: 0,
                Error: msg,
              });
            } catch (recordErr) {
              console.log(chalk.dim(`  (recording failed: ${(recordErr as Error).message})`));
            }
            continue;
          }

          // Forward to localhost
          const fwdResult = await forwardCapture(full, target.BaseUrl);

          // Record result back — update the existing execution
          try {
            await api.post('/api/v1/replay/record', {
              ExecutionId: exec.Id,
              CapturedRequestId: exec.CapturedRequestId,
              ReplayTargetId: exec.ReplayTargetId,
              ResponseStatusCode: fwdResult.statusCode,
              ResponseHeaders: fwdResult.responseHeaders,
              ResponseBodyPreview: fwdResult.responseBodyPreview,
              DurationMs: fwdResult.durationMs,
              Error: fwdResult.error,
            });
          } catch (recordErr) {
            console.log(chalk.dim(`  (recording failed: ${(recordErr as Error).message})`));
          }
        }
      } catch (err) {
        if (leaseLost(err)) exitLeaseLost();
        console.error(chalk.red(`Poll error: ${(err as Error).message}`));
      }
    };

    // Precedent #4: serial polling - a batch slower than the interval must never
    // overlap the next tick and forward the same execution twice.
    startSerialPoll(poll, interval);
  });
