import { Command } from 'commander';
import chalk from 'chalk';
import { deleteCredential, getCredential, getKeystorePath, listCredentials } from '../lib/keystore.js';

/**
 * `flurryport keys` — the keystore's human surface (0.3.0 keystore floor, ratified
 * 2026-07-28: list + remove, values never shown). Before this, revocation hygiene
 * meant hand-editing keystore.json.
 *
 * Refs are `signing:<endpointId>` (an endpoint's own inbound key) and
 * `contributor:<endpointId>` (a per-contributor key received via an invite).
 */
export const keysCommand = new Command('keys')
  .description('Inspect and manage locally stored signing keys (values are never shown)');

keysCommand
  .command('list')
  .description('List stored keys: ref, type, and when each was saved - never the value')
  .action(() => {
    const rows = listCredentials();
    if (rows.length === 0) {
      console.log(chalk.dim(`No keys stored. (${getKeystorePath()})`));
      return;
    }
    console.log(chalk.bold(`Stored keys (${getKeystorePath()}):`));
    for (const row of rows) {
      const [kind, endpointId] = row.ref.includes(':') ? row.ref.split(':', 2) : [row.ref, ''];
      const what =
        kind === 'contributor' ? 'contributor signing key (joined via invite)'
        : kind === 'signing' ? 'endpoint inbound signing key'
        : row.type;
      console.log(`  ${chalk.cyan(row.ref)}`);
      console.log(chalk.dim(`    ${what}${endpointId ? `, endpoint ${endpointId}` : ''}, saved ${row.createdAt}`));
    }
    console.log(chalk.dim("\nRemove one with 'flurryport keys remove <ref>'."));
  });

keysCommand
  .command('remove <ref>')
  .description('Delete a stored key by ref (from "keys list"). The key on the server is unaffected.')
  .action((ref: string) => {
    if (!getCredential(ref)) {
      console.error(chalk.red(`No key stored under '${ref}'. Run 'flurryport keys list' to see refs.`));
      process.exit(1);
    }
    deleteCredential(ref);
    console.log(chalk.green(`Removed '${ref}' from the local keystore.`));
    console.log(chalk.dim(
      'This only forgets the local copy: signing with it stops from this machine, but any server-side ' +
      'registration stands until the host revokes the membership or rotates the endpoint key.'));
  });
