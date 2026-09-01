#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listenCommand } from './commands/listen.js';
import { loginCommand } from './commands/login.js';
import { joinCommand } from './commands/join.js';
import { configCommand } from './commands/config.js';
import { accountCommand } from './commands/account.js';
import { targetCommand } from './commands/target.js';
import { postCommand } from './commands/post.js';
import { echoCommand } from './commands/echo.js';
import { mcpCommand } from './commands/mcp.js';
import { seatServerCommand } from './commands/seat-server.js';
import { seatCommand } from './commands/seat.js';
import { consoleCommand } from './commands/console.js';
import { keysCommand } from './commands/keys.js';

// Read version from package.json so there's a single source of truth.
// Avoids the "bumped package.json but forgot the literal in index.ts" bug
// that shipped 0.1.5 with `--version` printing 0.1.4.
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };

const program = new Command();

program
  .name('flurryport')
  .description('FlurryPORT CLI - forward webhook captures to your local machine')
  .version(pkg.version);

program.addCommand(loginCommand);
program.addCommand(joinCommand);
program.addCommand(accountCommand);
program.addCommand(configCommand);
program.addCommand(listenCommand);
program.addCommand(targetCommand);
program.addCommand(postCommand);
program.addCommand(echoCommand);
program.addCommand(keysCommand);
program.addCommand(mcpCommand);
program.addCommand(seatServerCommand);
program.addCommand(seatCommand);
program.addCommand(consoleCommand);

// Round 3: one friendly floor for errors no command handled - notably the store's
// locked-config throw (finding 9's loud-by-design contract). A clean one-line
// message beats an unhandled-rejection stack for the operator.
void program.parseAsync().catch((err: unknown) => {
  console.error(`flurryport: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
