import { Command } from 'commander';
import { randomBytes } from 'node:crypto';
import chalk from 'chalk';
import { loadConfig, saveConfig, getEnvironment, isDefaultProdOnly, participantAccountName } from '../lib/config.js';
import { classifyCeremonyState, createInviteJoinClient, type CeremonyState } from '../lib/invite-api.js';
import { AnonApiError } from '../lib/anon-api.js';
import { friendlyFetchError } from '../lib/fetch-error.js';
import { sanitizeWireLine } from '../lib/sanitize.js';
import { contributorKeyRef, putCredential } from '../lib/keystore.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How often the wait loop re-reads the landing's honest signals and echoes state. */
const LANDING_CHECK_INTERVAL_MS = 30_000;

/**
 * Accept-race grace (round-7 finding, 2026-08-13): "accepted with no grant collected"
 * is ALSO the normal transient state in the seconds between the human's click and the
 * next collecting poll. Declaring accepted_without_release on first sight killed a
 * healthy ceremony (round 6). Seeing acceptance now starts a grace clock; only a grant
 * still unreleased after this window is declared dead.
 */
const ACCEPT_COLLECT_GRACE_MS = 30_000;

/**
 * `flurryport join <fpi_token>` — accept an invite from either role in one command.
 *
 * Arms a device channel on the invite token, points the human at the landing page to
 * accept with their email, and polls until the server releases the grant one-shot:
 *   monitor  → an endpoint-scoped read-only PAT, stored as an account (watch the inbox);
 *   producer → that same read PAT PLUS a per-contributor signing key, written to the
 *              keystore so the contributor can sign the captures it sends in.
 *
 * The invitee never types anyone's email into a tool and never sees a raw key in a tool
 * arg or result: the human accepts in a browser, the key is released only to this process.
 *
 * Honesty hardening (pilot-1, 2026-08-13): the wait is WINDOWED (--window, default 30
 * minutes), echoes its state as it goes, and when the ceremony dies it reports what the
 * landing says actually happened (grant collected elsewhere, owner-accept void, invite
 * gone) instead of polling forever or mislabeling everything a channel expiry.
 */
export const joinCommand = new Command('join')
  .description(
    'Accept a FlurryPORT invite (monitor or producer) and store the credential. ' +
    'Interactive: for a human at a terminal. Agents: connect the MCP server (flurryport mcp) ' +
    'and call the join_invite tool instead - the same custody-preserving ceremony, resumable per call.')
  .argument('<token>', 'The invite token from your link (fpi_...)')
  .option('--name <name>', 'Account name to store the access token under (default: the participant name the host gave this invite, or "guest")')
  .option('--interval <ms>', 'Poll interval in milliseconds (default: 5000)', '5000')
  .option('--window <minutes>', 'How long to wait for acceptance before giving up (default: 30)', '30')
  .option('--url <baseUrl>', 'Override the API base URL (default: the active environment)')
  .action(async (token: string, opts: { name?: string; interval: string; window: string; url?: string }) => {
    if (!token.startsWith('fpi_')) {
      console.error(chalk.red('That does not look like an invite token. It should start with "fpi_".'));
      process.exit(1);
    }

    const config = loadConfig();
    const { name: envName, env } = getEnvironment(config);
    const baseUrl = opts.url ?? env.apiUrl;
    const intervalMs = Math.max(1000, Number.parseInt(opts.interval, 10) || 5000);
    const windowMs = Math.max(1, Number.parseInt(opts.window, 10) || 30) * 60_000;

    const client = createInviteJoinClient(baseUrl);
    const deviceCode = randomBytes(32).toString('base64url');

    /** Terminal report for a ceremony that cannot complete on this channel. */
    const reportDeath = (state: CeremonyState): never => {
      switch (state) {
        case 'grant_collected':
          console.error(chalk.red('\nThis invite\'s grant was already collected by another device\'s ceremony.'));
          console.error(chalk.red('The release is one-shot, so this wait can never complete. If that collection was yours, use the credential it stored; otherwise ask your host for a fresh invite.'));
          break;
        case 'accepted_no_release':
          console.error(chalk.red('\nThe invite shows as ACCEPTED but no grant released to this device.'));
          console.error(chalk.red('Known cause: the endpoint OWNER accepted their own invite, which silently voids the grant. Ask your host for a fresh invite, accepted by an account that does NOT own the endpoint.'));
          break;
        case 'invite_gone':
          console.error(chalk.red('\nThe invite is no longer valid (expired, revoked, or never existed).'));
          break;
        case 'live':
          console.error(chalk.red('\nThe credential channel expired, but the invite still stands. Run the same command again to arm a fresh channel.'));
          break;
      }
      process.exit(1);
    };

    // Arm the channel. A dead/unknown invite answers 404 (non-enumerable) — say so plainly.
    try {
      await client.registerInviteDevice(token, deviceCode);
    } catch (err) {
      if (err instanceof AnonApiError) {
        console.error(chalk.red(err.status === 404 ? 'That invite is not valid (expired, revoked, or never existed).' : err.detail));
      } else {
        console.error(chalk.red(`Could not reach ${baseUrl}: ${friendlyFetchError(err as Error)}`));
      }
      process.exit(1);
    }

    console.log(chalk.bold('\nTo accept this invite:'));
    console.log(`  1. Open ${chalk.cyan(client.landingUrl(token))}`);
    console.log(`  2. Sign in with your email and confirm.`);
    console.log(chalk.yellow('     The acceptor must NOT be the endpoint owner - an owner accepting their own invite silently voids the grant.\n'));
    console.log(chalk.dim(`Waiting for you to accept (polling every ${Math.round(intervalMs / 1000)}s for up to ${Math.round(windowMs / 60_000)} min, Ctrl+C to stop)...`));

    const startedAt = Date.now();
    let lastLandingCheckAt = Date.now();
    let acceptedSeenAt: number | null = null;

    // Poll until acceptance releases the grant, the window exhausts, or the landing's
    // honest signals say the ceremony is already over elsewhere. A null landing read is
    // UNKNOWN (network blip), never a verdict - only real landing facts may kill the wait.
    for (;;) {
      await sleep(intervalMs);

      if (Date.now() - startedAt >= windowMs) {
        const landing = await client.getLanding(token).catch(() => null);
        if (landing) {
          const state = classifyCeremonyState(landing);
          if (state !== 'live') reportDeath(state);
        }
        console.error(chalk.red(`\nGave up after ${Math.round(windowMs / 60_000)} minutes with no acceptance. The invite still stands - run the same command again to keep waiting (or pass --window for a longer wait).`));
        process.exit(1);
      }

      // Accept-race grace: acceptance was seen but the grant has not released yet. Keep
      // the collecting polls running; only a grant still missing after the grace window
      // is the honest accepted_without_release death.
      if (acceptedSeenAt && Date.now() - acceptedSeenAt >= ACCEPT_COLLECT_GRACE_MS) {
        reportDeath('accepted_no_release');
      }

      // Periodic state echo + honesty check: the landing's grantCollectedAt/status are
      // the signals that catch a ceremony that died without our channel ever knowing.
      if (!acceptedSeenAt && Date.now() - lastLandingCheckAt >= LANDING_CHECK_INTERVAL_MS) {
        lastLandingCheckAt = Date.now();
        const landing = await client.getLanding(token).catch(() => null);
        if (landing) {
          const state = classifyCeremonyState(landing);
          if (state === 'grant_collected' || state === 'invite_gone') reportDeath(state);
          if (state === 'accepted_no_release') {
            acceptedSeenAt = Date.now();
            console.log(chalk.green('  acceptance recorded - collecting the grant...'));
          }
        }
        if (!acceptedSeenAt) {
          console.log(chalk.dim(`  still waiting (${Math.round((Date.now() - startedAt) / 1000)}s elapsed; invite status: ${landing?.status ?? 'unknown'})`));
        }
      }

      let res;
      try {
        res = await client.pollInviteDevice(deviceCode);
      } catch (err) {
        if (err instanceof AnonApiError && err.status === 404) {
          // The channel died. Ask the landing what actually happened before deciding
          // between a quiet re-arm (real TTL lapse) and a terminal honest report. A null
          // landing here is unknown - fall through to the re-arm, which itself fails
          // loudly if the invite is truly gone.
          const landing = await client.getLanding(token).catch(() => null);
          if (landing) {
            const state = classifyCeremonyState(landing);
            if (state === 'grant_collected' || state === 'invite_gone') reportDeath(state);
            if (state === 'accepted_no_release' && !acceptedSeenAt) acceptedSeenAt = Date.now();
          }
          try {
            await client.registerInviteDevice(token, deviceCode);
            console.log(chalk.dim('  channel lapsed and was re-armed; still waiting...'));
          } catch {
            console.error(chalk.red('\nThe invite is no longer valid.'));
            process.exit(1);
          }
          continue;
        }
        // Transient (network / throttle) — keep waiting rather than dropping the ceremony.
        continue;
      }

      if (res.Status !== 'complete' || !res.Token) continue;

      // Store the scoped read PAT as an account in the active environment. The account
      // name IS the participant identity the host gave this invite (finding 23) unless
      // --name overrode it; the endpoint binding rides along for the credential router.
      const accountName = opts.name ?? participantAccountName(res.ParticipantName);
      env.accounts[accountName] = {
        apiKey: res.Token,
        ...(res.ContributorEndpointId ? { scopeEndpointId: res.ContributorEndpointId } : {}),
        ...(res.ContributorProjectId ? { scopeProjectId: res.ContributorProjectId } : {}),
      };
      if (!env.activeAccount) env.activeAccount = accountName;
      saveConfig(config);
      // #170: suppress the environment clause on the default single-prod config.
      console.log(chalk.green(isDefaultProdOnly(config)
        ? `\nAccepted. Access token stored as account "${accountName}".`
        : `\nAccepted. Access token stored as account "${accountName}" in environment "${envName}".`));
      if (res.ParticipantName) {
        // An adversarial room owner names the participant: strip terminal escapes
        // before printing during the join ceremony, when the user is primed to
        // trust what the CLI says (precedent #5).
        console.log(chalk.dim(`  You are "${sanitizeWireLine(res.ParticipantName)}" on this stream: the same name labels your posts and watches.`));
      }

      if (res.SigningKey && res.ContributorEndpointId) {
        // Producer grant: keep the signing key in the keystore, keyed by endpoint.
        // Round 3: the release is ONE-SHOT and the invite is already consumed - a
        // keystore lock here must not crash the ceremony with a raw stack and lose
        // the key silently. The store already retried; a persistent failure gets
        // the honest consequence and the recovery named.
        try {
          putCredential(contributorKeyRef(res.ContributorEndpointId), {
            type: 'contributor',
            value: res.SigningKey,
            createdAt: new Date().toISOString(),
          });
        } catch (persistErr) {
          console.error(chalk.red(
            `The producer signing key could not be stored (${(persistErr as Error).message}).`));
          console.error(chalk.red(
            'The invite is already consumed and the key cannot be re-collected: your account works as a ' +
            'MONITOR (reads), but signed posting needs a fresh invite - ask the host to revoke this seat ' +
            'and mint a new one once ~/.flurryport is writable.'));
          return;
        }
        console.log(chalk.green('You joined as a producer. A signing key was saved for this endpoint.'));
        console.log(chalk.dim('  Send signed events without touching crypto: `flurryport post` signs with this key'));
        console.log(chalk.dim('  automatically, as does the MCP post_intent tool (npx -y flurryport mcp).'));
        if (res.ContributorProjectId && res.ContributorEndpointId) {
          console.log(chalk.dim(`  post ids -> projectId: ${res.ContributorProjectId}  endpointId: ${res.ContributorEndpointId}`));
        }
      } else {
        console.log(chalk.dim('You joined as a monitor. Use the account to read the endpoint you were invited to.'));
      }
      return;
    }
  });
