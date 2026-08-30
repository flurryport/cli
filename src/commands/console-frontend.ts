import * as readline from 'node:readline';
import chalk from 'chalk';
import type { ConsoleEvent } from '../lib/console-engine.js';
import { renderEvent } from './console-render.js';

/**
 * The console's FRONTEND seam. `console.ts` owns the session - config, the engine,
 * the in-process room (#253), the poll loop, teardown - and never touches stdin or
 * stdout directly. Everything a human or a plugin sees passes through here.
 *
 * Two implementations today:
 *  - terminal: readline in, ANSI out (the chair's shell, unchanged behavior)
 *  - json: NDJSON out, bare lines in (the nvim plugin and any future frontend)
 *
 * The JSON contract is deliberately narrow: EVERY stdout line is one JSON object,
 * and with one exception it is a ConsoleEvent verbatim - the same typed union the
 * engine already emits. The exception is the first line, a `hello`, so a client
 * can check the version it is talking to before it interprets anything else.
 */
export interface ConsoleFrontend {
  /** Opening lines, before any input is accepted. */
  greet(version: string, lines: string[]): void;
  /** Engine output. */
  emit(events: ConsoleEvent[]): void;
  /** An incidental line from the session (room server chatter, feed recovery). */
  note(text: string): void;
  /** A failure line. */
  fail(text: string): void;
  /** Invite the next input. A no-op where there is no prompt to draw. */
  ready(): void;
  onLine(handler: (line: string) => void): void;
  /** Ctrl+C, Ctrl+D, or stdin ending - every graceful-exit trigger. */
  onQuit(handler: () => void): void;
  /** Stop accepting input; teardown is under way. */
  close(): void;
  /** The last thing written, then hand back so the session can exit. */
  farewell(text: string, done: () => void): void;
}

/**
 * The chair's shell. Feed lines print ABOVE the prompt and the prompt is redrawn
 * with whatever was typed, so arriving posts never eat input in progress.
 */
export function terminalFrontend(): ConsoleFrontend {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  let closed = false;

  // Width is measured at print time and applies FORWARD only (append-only feed,
  // ratified): printed lines never re-wrap on resize.
  const printAbove = (lines: string[]): void => {
    if (lines.length === 0) return;
    process.stdout.write('\r\x1b[K' + lines.join('\n') + '\n');
    if (!closed) rl.prompt(true);
  };

  return {
    greet(_version, lines) {
      for (const line of lines) console.log(chalk.dim(line));
    },
    emit(events) {
      printAbove(events.flatMap((e) => renderEvent(e, process.stdout.columns ?? 80)));
    },
    note(text) {
      printAbove([chalk.dim(text)]);
    },
    fail(text) {
      printAbove([chalk.red(text)]);
    },
    ready() {
      if (!closed) rl.prompt();
    },
    onLine(handler) {
      rl.on('line', handler);
    },
    onQuit(handler) {
      // readline traps SIGINT once listened; 'close' covers Ctrl+D and stdin end.
      rl.on('SIGINT', handler);
      rl.on('close', handler);
    },
    close() {
      closed = true;
      rl.close();
    },
    farewell(text, done) {
      process.stdout.write('\r\x1b[K' + chalk.dim(text) + '\n', done);
    },
  };
}

/**
 * NDJSON out, bare command lines in. Built for a driving program (the nvim plugin
 * first): no ANSI, no prompt, no width - the client owns presentation entirely.
 *
 * stdin is usually a pipe here, not a TTY, so readline never sees SIGINT; the
 * process-level handler is what carries Ctrl+C into the same graceful teardown.
 */
export function jsonFrontend(): ConsoleFrontend {
  const rl = readline.createInterface({ input: process.stdin }); // no output: nothing echoes
  let closed = false;

  const write = (payload: unknown): void => {
    if (closed) return;
    process.stdout.write(JSON.stringify(payload) + '\n');
  };

  return {
    greet(version, lines) {
      write({ type: 'hello', version });
      for (const text of lines) write({ type: 'info', text });
    },
    emit(events) {
      for (const event of events) write(event);
    },
    note(text) {
      write({ type: 'info', text });
    },
    fail(text) {
      write({ type: 'error', text });
    },
    ready() {
      /* no prompt to draw: the client decides when it is ready for more */
    },
    onLine(handler) {
      rl.on('line', handler);
    },
    onQuit(handler) {
      rl.on('close', handler);
      process.on('SIGINT', handler);
    },
    close() {
      closed = true;
      rl.close();
    },
    farewell(text, done) {
      // Written before `closed` blocks further output, so the last word gets out.
      process.stdout.write(JSON.stringify({ type: 'info', text }) + '\n', done);
    },
  };
}
