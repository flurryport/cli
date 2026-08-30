import { randomBytes } from 'node:crypto';
import { Command } from 'commander';
import { loadConfig, saveConfig, getEnvironment, isDefaultProdOnly } from '../lib/config.js';
import { createAnonApiClient } from '../lib/anon-api.js';
import { resolveWebBaseUrl } from '../lib/mcp-meta.js';
import chalk from 'chalk';

/**
 * Store the token under the account name and report activation state, the same way
 * for a pasted token and a device-flow release.
 */
function storeAccount(token: string, name: string, use: boolean | undefined): void {
  const config = loadConfig();
  // #170: suppress the environment clause on the default single-prod config —
  // first-run users never created an "environment" and shouldn't meet the concept.
  const plainWording = isDefaultProdOnly(config);
  const { name: envName, env } = getEnvironment(config);

  env.accounts[name] = { apiKey: token };
  if (!env.activeAccount || use) env.activeAccount = name;

  saveConfig(config);
  console.log(chalk.green(plainWording
    ? `Account "${name}" saved.`
    : `Account "${name}" saved in environment "${envName}".`));
  if (env.activeAccount === name) {
    console.log(chalk.dim(`This is now the active account.`));
  } else {
    // #109: storing without activating silently leaves every command (and the
    // MCP server) on the OLD token — say so loudly and give the exact fix.
    console.log(chalk.yellow(
      `Saved, but NOT active: "${env.activeAccount}" is still the active account, ` +
      `so commands and the MCP server keep using its token.`));
    console.log(chalk.yellow(`Activate it with: flurryport account use ${name}`));
    console.log(chalk.dim(`(or re-run login with --use to activate in one step)`));
  }
}

/**
 * #388 device login: the custody-clean path for a session whose only input channel is
 * a conversation (a cloud container, a remote agent). Two locally generated codes: the
 * DEVICE code stays in this process and keys the poll; the APPROVAL code rides the
 * printed URL. The human approves in a browser already signed in as themselves, and
 * the server releases a freshly minted token straight to this process — the token
 * never appears in any conversation, and the two printed values are useless without
 * the human's own browser session.
 */
async function deviceLogin(opts: { name: string; use?: boolean }): Promise<void> {
  const client = createAnonApiClient();
  const deviceCode = randomBytes(32).toString('base64url');
  const approvalCode = randomBytes(24).toString('base64url');

  const registration = await client.registerDeviceLogin(deviceCode, approvalCode);
  const url = `${resolveWebBaseUrl()}/login?deviceLogin=${approvalCode}`;
  const expiresAt = new Date(registration.ExpiresAt);

  console.log(chalk.bold('Approve this login in your browser:'));
  console.log('');
  console.log(`  ${chalk.cyan(url)}`);
  console.log('');
  console.log(chalk.dim(
    'Sign in as yourself, pick the access this session gets (read-only or read-write), and approve. ' +
    'The token is minted server-side and lands here directly; it never appears on screen or in any chat.'));
  console.log(chalk.dim(`The link expires ${expiresAt.toLocaleTimeString()} (about 10 minutes). Waiting...`));

  const intervalMs = Math.max(2, registration.PollIntervalSeconds || 3) * 1000;
  const deadline = expiresAt.getTime();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    let poll;
    try {
      poll = await client.pollDeviceHandoff(deviceCode);
    } catch {
      // Unknown/expired/denied all answer 404 by design. Denied and expired are
      // indistinguishable on purpose; the deadline message covers both honestly.
      break;
    }
    if (poll.Status === 'complete' && poll.Token) {
      const scope = poll.GrantedScope ? ` (${poll.GrantedScope})` : '';
      console.log(chalk.green(`Approved${scope}.`));
      storeAccount(poll.Token, opts.name, opts.use);
      return;
    }
  }

  console.error(chalk.red(
    'The login was not approved in time (the link expired, or the approval was declined). ' +
    'Run "flurryport login" again for a fresh link.'));
  process.exit(1);
}

export const loginCommand = new Command('login')
  .description('Sign in: approve in your browser (no token to paste), or store a pasted personal access token')
  .argument('[token]', 'Optional: a FlurryPORT personal access token (fp_...). Omit it to approve in the browser instead - the token then never transits this conversation.')
  .option('--name <name>', 'Account name (default: "default")', 'default')
  .option('--use', 'Activate this account immediately (make it the one commands and the MCP server use)')
  .action(async (token: string | undefined, opts: { name: string; use?: boolean }) => {
    if (!token) {
      await deviceLogin(opts);
      return;
    }

    if (!token.startsWith('fp_')) {
      console.error(chalk.red('Token must start with "fp_". Generate one in Settings → Access Tokens, or run "flurryport login" with no token to approve in the browser.'));
      process.exit(1);
    }

    storeAccount(token, opts.name, opts.use);
  });
