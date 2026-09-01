import { Command, Option } from 'commander';
import chalk from 'chalk';
import { isDefaultProdOnly, loadConfig, resolveContext } from '../lib/config.js';
import { createApiClient, ApiError, ApiClient } from '../lib/api.js';
import { guidToBase62 } from '../lib/base62.js';
import { prompt, pickFromList } from '../lib/prompt.js';

interface Project {
  Id: string;
  Name: string;
  Slug: string;
}

interface Endpoint {
  Id: string;
  Name: string;
  Slug: string;
  ProjectId: string;
}

export const targetCommand = new Command('target').description('Manage replay targets');

targetCommand
  .command('create')
  .description('Create a replay target on an endpoint')
  .argument('[url]', 'Target URL (e.g. http://localhost:3000/webhooks)')
  .option('--endpoint <slug>', 'Endpoint slug (skip prompt)')
  .option('--project <slug>', 'Project slug (use to disambiguate or skip prompt)')
  .option('--name <name>', 'Target name (default: derived from URL)')
  .option('--account <name>', 'Account to use (overrides active account)')
  // #170: hidden from help — environments are an advanced concept (matching the
  // hidden config *-env subcommands); the flag still works for those who use it.
  .addOption(new Option('--environment <name>', 'Environment to use (overrides active environment)').hideHelp())
  .action(async (urlArg: string | undefined, opts) => {
    const config = loadConfig();
    const context = resolveContext(config, { environment: opts.environment, account: opts.account });
    const api = createApiClient(context);

    // #170: on the default single-prod config, don't surface the environment concept.
    console.log(chalk.dim(!opts.environment && isDefaultProdOnly(config)
      ? `Account: ${context.accountName}`
      : `Environment: ${context.environmentName}  Account: ${context.accountName}`));

    // ─── Pick project ────────────────────────────────────────────────────────
    const projects = await fetchProjects(api);
    if (projects.length === 0) {
      console.error(chalk.red('No projects available for this account.'));
      process.exit(1);
    }

    const project = await selectProject(projects, opts.project);

    // ─── Pick endpoint ───────────────────────────────────────────────────────
    const endpoints = await fetchEndpoints(api, project.Id);
    if (endpoints.length === 0) {
      console.error(chalk.red(`Project "${project.Slug}" has no endpoints.`));
      process.exit(1);
    }

    const endpoint = await selectEndpoint(endpoints, opts.endpoint);

    // ─── URL ────────────────────────────────────────────────────────────────
    let url = urlArg ?? (await prompt('Target URL (http://): '));
    if (!url) {
      console.error(chalk.red('Target URL is required.'));
      process.exit(1);
    }
    if (!/^https?:\/\//i.test(url)) {
      url = `http://${url}`;
    }

    // ─── Name ───────────────────────────────────────────────────────────────
    const defaultName = deriveName(url);
    let name: string;
    if (opts.name) {
      name = opts.name;
    } else {
      const entered = await prompt(`Target name [${defaultName}]: `);
      name = entered || defaultName;
    }

    // ─── Create ─────────────────────────────────────────────────────────────
    const b62Project = guidToBase62(project.Id);
    const b62Endpoint = guidToBase62(endpoint.Id);
    const body = { Name: name, BaseUrl: url, AutoReplay: false };

    try {
      const result = (await api.post(
        `/api/v1/projects/${b62Project}/endpoints/${b62Endpoint}/replay-targets`,
        body,
      )) as { Name: string; BaseUrl: string; AutoReplay: boolean };

      console.log(chalk.green(`\nCreated replay target "${result.Name}"`));
      console.log(`  Project:  ${project.Name} (${project.Slug})`);
      console.log(`  Endpoint: ${endpoint.Name} (${endpoint.Slug})`);
      console.log(`  Target:   ${result.BaseUrl}`);
      console.log(chalk.dim(`\nRun "flurryport listen" to start forwarding captures locally.`));
    } catch (err) {
      if (err instanceof ApiError) {
        console.error(chalk.red(`\nFailed to create replay target (${err.status}): ${err.detail}`));
        if (err.status === 403) {
          console.error(chalk.dim(
            'Your token is likely read-only: it can read captures and forward locally, but cannot create ' +
            'persistent replay targets. Generate a token WITHOUT the "Read-only" checkbox in Settings ' +
            '(Access Tokens) and run "flurryport login <token>", or create the target in the web UI.',
          ));
        } else if (err.status === 400 && /(limit|plan|allow)/i.test(err.detail)) {
          console.error(chalk.dim('Ask the project owner to remove an unused target or upgrade their plan.'));
        }
      } else {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed to create replay target: ${message}`));
      }
      process.exit(1);
    }
  });

async function fetchProjects(api: ApiClient): Promise<Project[]> {
  const res = (await api.get('/api/v1/projects')) as { Projects?: Project[] };
  return res.Projects ?? [];
}

async function fetchEndpoints(api: ApiClient, projectId: string): Promise<Endpoint[]> {
  const b62 = guidToBase62(projectId);
  const res = (await api.get(`/api/v1/projects/${b62}/endpoints`)) as { Endpoints?: Endpoint[] };
  return res.Endpoints ?? [];
}

async function selectProject(projects: Project[], slug: string | undefined): Promise<Project> {
  if (slug) {
    const match = projects.find((p) => p.Slug === slug);
    if (!match) {
      console.error(chalk.red(`Project "${slug}" not found.`));
      console.error(`Available: ${projects.map((p) => p.Slug).join(', ')}`);
      process.exit(1);
    }
    console.log(chalk.dim(`Project:  ${match.Slug} (${match.Name})`));
    return match;
  }
  if (projects.length === 1) {
    console.log(chalk.dim(`Project:  ${projects[0].Slug} (${projects[0].Name}) - only one available`));
    return projects[0];
  }
  return pickFromList('Pick a project:', projects, (p) => `${p.Slug} ${chalk.dim(`(${p.Name})`)}`);
}

async function selectEndpoint(endpoints: Endpoint[], slug: string | undefined): Promise<Endpoint> {
  if (slug) {
    const match = endpoints.find((e) => e.Slug === slug);
    if (!match) {
      console.error(chalk.red(`Endpoint "${slug}" not found in this project.`));
      console.error(`Available: ${endpoints.map((e) => e.Slug).join(', ')}`);
      process.exit(1);
    }
    console.log(chalk.dim(`Endpoint: ${match.Slug} (${match.Name})`));
    return match;
  }
  if (endpoints.length === 1) {
    console.log(chalk.dim(`Endpoint: ${endpoints[0].Slug} (${endpoints[0].Name}) - only one available`));
    return endpoints[0];
  }
  return pickFromList('Pick an endpoint:', endpoints, (e) => `${e.Slug} ${chalk.dim(`(${e.Name})`)}`);
}

function deriveName(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`.slice(0, 100);
  } catch {
    return url.slice(0, 100);
  }
}
