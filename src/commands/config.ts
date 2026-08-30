import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, saveConfig, getEnvironment, getConfigPath, isDefaultProdOnly, PROD_API_URL } from '../lib/config.js';

export const configCommand = new Command('config').description('View configuration');

configCommand
  .command('show')
  .description('Show current configuration')
  .action(() => {
    const config = loadConfig();
    const { name: envName, env } = getEnvironment(config);

    console.log(chalk.dim(`Config:      ${getConfigPath()}`));
    // #170: on the default single-prod config the environment name is an internal
    // detail — show the server URL without introducing the concept.
    console.log(chalk.dim(isDefaultProdOnly(config)
      ? `Server:      ${env.apiUrl}`
      : `Environment: ${envName} (${env.apiUrl})`));

    const accountNames = Object.keys(env.accounts);
    if (accountNames.length === 0) {
      console.log(chalk.dim(`Accounts:    (none — add one with "flurryport login <token>")`));
      return;
    }

    console.log(chalk.bold(`\nAccounts:`));
    for (const name of accountNames) {
      const active = name === env.activeAccount ? chalk.green(' ●') : '  ';
      const key = chalk.dim(env.accounts[name].apiKey.slice(0, 12) + '...');
      console.log(`${active} ${chalk.bold(name)} ${key}`);
    }
  });

// ─── Environment management (advanced — not in primary --help text) ────────────

configCommand
  .command('set-env', { hidden: true })
  .description('Create or update an environment (advanced)')
  .argument('<name>', 'Environment name')
  .argument('<url>', 'API base URL')
  .action((name: string, url: string) => {
    const config = loadConfig();
    if (config.environments[name]) {
      config.environments[name].apiUrl = url;
    } else {
      config.environments[name] = { apiUrl: url, accounts: {} };
    }
    saveConfig(config);
    console.log(chalk.green(`Environment "${name}" → ${url}`));
  });

configCommand
  .command('use-env', { hidden: true })
  .description('Switch the active environment (advanced)')
  .argument('<name>', 'Environment name')
  .action((name: string) => {
    const config = loadConfig();
    if (!config.environments[name]) {
      console.error(chalk.red(`Environment "${name}" does not exist.`));
      console.error(`Create with: flurryport config set-env ${name} <url>`);
      process.exit(1);
    }
    config.activeEnvironment = name;
    saveConfig(config);
    const env = config.environments[name];
    console.log(chalk.green(`Active environment: ${name} (${env.apiUrl})`));
  });

configCommand
  .command('list-env', { hidden: true })
  .description('List all environments (advanced)')
  .action(() => {
    const config = loadConfig();
    for (const [name, env] of Object.entries(config.environments)) {
      const active = name === config.activeEnvironment ? chalk.green(' ●') : '  ';
      const accountCount = Object.keys(env.accounts).length;
      const accounts = accountCount === 0 ? chalk.dim('no accounts') : chalk.dim(`${accountCount} account${accountCount === 1 ? '' : 's'}`);
      const isProd = env.apiUrl === PROD_API_URL ? chalk.dim(' [prod]') : '';
      console.log(`${active} ${chalk.bold(name)} — ${env.apiUrl} (${accounts})${isProd}`);
    }
  });

configCommand
  .command('remove-env', { hidden: true })
  .description('Remove an environment (advanced)')
  .argument('<name>', 'Environment name')
  .action((name: string) => {
    const config = loadConfig();
    if (!config.environments[name]) {
      console.error(chalk.red(`Environment "${name}" does not exist.`));
      process.exit(1);
    }
    if (config.activeEnvironment === name) {
      console.error(chalk.red(`Cannot remove the active environment. Switch first with: flurryport config use-env <other>`));
      process.exit(1);
    }
    delete config.environments[name];
    saveConfig(config);
    console.log(chalk.green(`Removed environment "${name}".`));
  });
