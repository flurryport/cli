import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, saveConfig, getEnvironment, isDefaultProdOnly } from '../lib/config.js';

export const accountCommand = new Command('account').description('Manage accounts (PATs)');

accountCommand
  .command('list')
  .description('List stored accounts')
  .action(() => {
    const config = loadConfig();
    // #170: only surface the environment concept when the user has actually
    // created one beyond the default single prod environment.
    const plainWording = isDefaultProdOnly(config);
    const { name: envName, env } = getEnvironment(config);

    const accountNames = Object.keys(env.accounts);
    if (accountNames.length === 0) {
      console.log(chalk.dim(plainWording
        ? `No accounts yet. Add one with: flurryport login <token>`
        : `No accounts in environment "${envName}". Add one with: flurryport login <token>`));
      return;
    }

    if (!plainWording) console.log(chalk.dim(`Environment: ${envName}`));
    for (const name of accountNames) {
      const active = name === env.activeAccount ? chalk.green(' ●') : '  ';
      const key = chalk.dim(env.accounts[name].apiKey.slice(0, 12) + '...');
      console.log(`${active} ${chalk.bold(name)} ${key}`);
    }
  });

accountCommand
  .command('use')
  .description('Switch the active account')
  .argument('<name>', 'Account name')
  .action((name: string) => {
    const config = loadConfig();
    const plainWording = isDefaultProdOnly(config);
    const { name: envName, env } = getEnvironment(config);

    if (!env.accounts[name]) {
      console.error(chalk.red(plainWording
        ? `Account "${name}" not found.`
        : `Account "${name}" not found in environment "${envName}".`));
      console.error(`Available: ${Object.keys(env.accounts).join(', ') || '(none)'}`);
      process.exit(1);
    }

    env.activeAccount = name;
    saveConfig(config);
    console.log(chalk.green(`Active account: ${name}`));
  });

accountCommand
  .command('remove')
  .description('Remove an account')
  .argument('<name>', 'Account name')
  .action((name: string) => {
    const config = loadConfig();
    const plainWording = isDefaultProdOnly(config);
    const { name: envName, env } = getEnvironment(config);

    if (!env.accounts[name]) {
      console.error(chalk.red(plainWording
        ? `Account "${name}" not found.`
        : `Account "${name}" not found in environment "${envName}".`));
      process.exit(1);
    }

    delete env.accounts[name];
    if (env.activeAccount === name) {
      env.activeAccount = Object.keys(env.accounts)[0];
    }

    saveConfig(config);
    console.log(chalk.green(plainWording
      ? `Removed account "${name}".`
      : `Removed account "${name}" from environment "${envName}".`));
  });
