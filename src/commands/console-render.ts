import chalk from 'chalk';
import { RECORD_SUMMARY_CHARS, type ConsoleEvent } from '../lib/console-engine.js';
import { consoleMessages as msg } from '../lib/console-messages.js';
import { sanitizeWireLine } from '../lib/sanitize.js';
import {
  ALL_CONSOLE_COLORS,
  CONSOLE_COLORS,
  EXTENDED_COLORS,
  type ConsoleColor,
} from '../lib/console-view-state.js';

/**
 * The terminal FRONTEND's rendering half (the engine/render seam's render side):
 * chalk, width measurement, and word wrapping all live HERE and only here - the
 * engine keeps emitting structured events. Split from commands/console.ts so the
 * feed spec (two-line rows, wrap on full words, capability palette) is testable
 * without spawning a terminal; readline and process stay in console.ts.
 *
 * Width is measured AT RENDER TIME and applies forward only: the feed is append
 * only, printed lines never re-wrap on resize (ratified).
 */

/** The message indent under a meta line; continuations align under the MESSAGE, not the meta. */
export const FEED_INDENT = '  ';

// ── capability-aware palette (ratified: the palette grows with the terminal) ──

/** chalk.level: 0 none, 1 = 16 colors, 2 = 256, 3 = truecolor. */
export function supportedPalette(level: number = chalk.level): readonly ConsoleColor[] {
  return level >= 2 ? ALL_CONSOLE_COLORS : CONSOLE_COLORS;
}

const BASE_FNS: Record<(typeof CONSOLE_COLORS)[number], (s: string) => string> = {
  cyan: chalk.cyan,
  magenta: chalk.magenta,
  yellow: chalk.yellow,
  green: chalk.green,
  blue: chalk.blue,
  red: chalk.red,
  white: chalk.white,
  gray: chalk.gray,
};

/** The extended names as truecolor hex; chalk degrades these to 256-color itself at level 2. */
const EXTENDED_HEX: Record<(typeof EXTENDED_COLORS)[number], string> = {
  purple: '#a855f7',
  orange: '#ff8c00',
  pink: '#ff6ec7',
  teal: '#14b8a6',
};

/** Graceful degradation on a 16-color terminal (ratified: purple renders magenta). */
const EXTENDED_FALLBACK: Record<(typeof EXTENDED_COLORS)[number], (typeof CONSOLE_COLORS)[number]> = {
  purple: 'magenta',
  orange: 'yellow',
  pink: 'magenta',
  teal: 'cyan',
};

/**
 * The base name a color actually renders as at the given capability: extended
 * names pass through on 256+/truecolor and degrade to their understudy on 16.
 */
export function effectiveColor(color: ConsoleColor, level: number = chalk.level): ConsoleColor {
  if ((CONSOLE_COLORS as readonly string[]).includes(color)) return color;
  return level >= 2 ? color : EXTENDED_FALLBACK[color as (typeof EXTENDED_COLORS)[number]];
}

export function paint(color: ConsoleColor | null, s: string, level: number = chalk.level): string {
  if (!color) return s;
  const shown = effectiveColor(color, level);
  if ((CONSOLE_COLORS as readonly string[]).includes(shown)) {
    return BASE_FNS[shown as (typeof CONSOLE_COLORS)[number]](s);
  }
  return chalk.hex(EXTENDED_HEX[shown as (typeof EXTENDED_COLORS)[number]])(s);
}

// ── wrap on full words (ratified feed spec) ──────────────────────────────────

/**
 * Word wrap at the given width: break on whitespace only; a token longer than
 * the width hard-breaks as the fallback; embedded newlines are paragraph breaks
 * (multi-line bodies come free in the two-line layout). Pure - the caller owns
 * indent prefixes and width measurement.
 */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter((t) => t.length > 0);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (let word of words) {
      while (word.length > w) {
        // Unbreakable token longer than the width: flush, then hard-break.
        if (line) {
          lines.push(line);
          line = '';
        }
        lines.push(word.slice(0, w));
        word = word.slice(w);
      }
      if (word.length === 0) continue;
      if (!line) line = word;
      else if (line.length + 1 + word.length <= w) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

// ── shared small renderers ───────────────────────────────────────────────────

/**
 * Time for today's rows, MM-DD prefixed for anything older. Backfill reaches back
 * as far as the room is quiet, so a bare clock made a day-old room read as live
 * (found 08-14: a 08-13 writers-room backfill looked like it was happening now).
 * Live rows - the common case - keep the narrow two-line meta column unchanged.
 */
export function feedTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toTimeString().slice(0, 8);
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return time;
  const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${stamp} ${time}`;
}

/** Whole minutes since an ISO timestamp (UTC-forgiving like feedTime), floored at 0. */
function minutesSince(iso: string): number {
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? 0 : Math.max(0, Math.round((Date.now() - d.getTime()) / 60_000));
}

/** The status stanza rendered generically: key: value lines, no shape assumptions. */
function stanzaLines(stanza: Record<string, unknown>, indent: string): string[] {
  return Object.entries(stanza).map(
    ([k, v]) => chalk.dim(`${indent}${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`),
  );
}

/** Simple aligned columns, the :list formatting family (#243/#246): padEnd, no boxes. */
function tableLines(headers: readonly string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const render = (cells: readonly string[]) => '  ' + cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [chalk.dim(render(headers)), ...rows.map((r) => render(r))];
}

/**
 * Render one engine event to lines of styled text. `width` is the terminal
 * width measured by the caller AT PRINT TIME (append-only feed: a resize only
 * shapes what prints next).
 */
export function renderEvent(event: ConsoleEvent, width: number): string[] {
  switch (event.type) {
    case 'info':
      return [chalk.dim(event.text)];
    case 'error':
      return [chalk.red(event.text)];
    case 'exit':
      // The announcement carries no words of its own; the goodbye line is teardown's.
      return [];
    case 'help':
      return event.lines;
    case 'colors':
      // The palette is its own swatch card: each name rendered in its own color -
      // exactly what THIS terminal renders, extended names included when spoken.
      return [event.colors.map((c) => paint(c as ConsoleColor, c)).join('  ')];
    case 'projects':
      return event.rows.map((p) => `  ${chalk.bold(p.slug)}  ${p.name}${p.suspended ? chalk.red('  suspended') : ''}`);
    case 'endpoints':
      return event.rows.map((e) => `  ${chalk.dim(e.projectSlug + '/')}${chalk.bold(e.slug)}  ${e.name}`);
    case 'roster':
      return event.rows.map((s) => {
        // The state word: presence truth (#266) when the engine has it - live /
        // idle / adrift / departed - else the invite status exactly as before.
        const stateWord = s.presence ?? s.status;
        // Post-mortem grey (#267/#266): a revoked, expired, or departed seat
        // keeps its row but loses its color - the whole line mutes until
        // :<handle> delete clears it.
        if (s.greyed) {
          const heldGrey = s.held ? '  ' + msg.rosterHeldMark : '';
          const hiddenGrey = s.hidden ? '  hidden' : '';
          return chalk.gray(`  :${s.handle}  ${sanitizeWireLine(s.guestName)}  ${stateWord}${heldGrey}${hiddenGrey}`);
        }
        const liveness =
          s.presence === 'live'
            ? chalk.green(stateWord)
            : s.presence === 'idle'
              ? chalk.yellow(stateWord)
              : s.presence === 'adrift'
                ? chalk.dim(stateWord)
                : s.live
                  ? chalk.green(stateWord)
                  : chalk.dim(stateWord);
        const held = s.held ? chalk.dim('  ' + msg.rosterHeldMark) : '';
        const hidden = s.hidden ? chalk.dim('  hidden') : '';
        return `  ${paint(s.color, ':' + s.handle)}  ${sanitizeWireLine(s.guestName)}  ${liveness}${held}${hidden}`;
      });
    case 'decisions':
      // The decision ledger (#295): every flagged proposal, chronological, in
      // the picker's [ref] idiom. The state word carries the color exactly like
      // the roster's liveness words: yellow needs the gavel, green is ruled,
      // dim is done with (retracted and struck rows mute whole).
      return event.rows.map((d) => {
        const shown = d.summary.slice(0, RECORD_SUMMARY_CHARS);
        const state =
          d.state === 'needs-ratification'
            ? chalk.yellow(d.state)
            : d.state === 'ratified'
              ? chalk.green(d.state) + (d.ratifiedBy ? ' ' + chalk.dim(msg.decisionRatifiedBy(d.ratifiedBy)) : '')
              : chalk.dim(d.state);
        const summary = d.state === 'retracted' || d.state === 'struck' ? chalk.dim(shown) : shown;
        return `  ${chalk.dim(`[${d.ref}]`)} ${state}  ${summary}`;
      });
    case 'status': {
      // Layer 1: the facts table. Layer 2: each seat's latest stanza, freshness labeled.
      const lines = tableLines(
        msg.statusHeaders,
        event.rows.map((r) => [
          r.handle,
          r.state,
          r.expiresAt.slice(0, 16).replace('T', ' '),
          r.lastPostAt ? feedTime(r.lastPostAt) : msg.statusNever,
          String(r.posts),
        ]),
      );
      for (const r of event.rows) {
        if (r.stanza && r.stanzaAt) {
          lines.push(chalk.dim(`  ${r.handle}  ${msg.statusFreshness(minutesSince(r.stanzaAt))}`));
          lines.push(...stanzaLines(r.stanza, '    '));
        } else {
          lines.push(chalk.dim(`  ${r.handle}  ${msg.statusNoStanza}`));
        }
      }
      return lines;
    }
    case 'confirm':
    case 'ask':
      return [chalk.yellow(event.text)];
    case 'pairing':
      // Chair-facing lines first (mint receipt + ferry warning), then the paste-ready
      // boarding pass rendered plain so a terminal copy carries no styling.
      return [
        '',
        `  ${chalk.bold(event.code)}`,
        '',
        ...event.chairLines.map((l, i) => (i === 0 ? l : chalk.yellow(l))),
        '',
        ...event.passLines,
      ];
    case 'feed': {
      // TWO-LINE ROWS (ratified): line one is the scannable meta column,
      // [time] [id] [actor] plus channel/verb/panic/re/tags; the message text is
      // ALWAYS on the following line(s), wrapped on full words with a hanging
      // indent under the MESSAGE indent. Multi-line bodies come free.
      const { item } = event;
      // The status ticker (#280b): a protocol status renders as ONE dim line -
      // seat, state, then reason or task. A bare fp:status transition (pure) IS
      // that line, whole row; a consecutive same-seat same-state repeat
      // collapses to nothing new instead of stacking.
      const ticker = item.statusTicker;
      const paintTicker = ticker?.state === 'blocked-on-human' ? chalk.red : chalk.dim;
      if (ticker?.pure) {
        if (ticker.repeated) return [];
        return [
          paintTicker(
            `${feedTime(item.at)} ${item.id} ${item.byline} ${ticker.state}${ticker.detail ? ': ' + ticker.detail : ''}`,
          ),
        ];
      }
      const time = chalk.dim(feedTime(item.at));
      const id = chalk.dim(item.id);
      const byline = item.mine ? (item.color ? chalk.bold(paint(item.color, item.byline)) : chalk.bold(item.byline)) : paint(item.color, item.byline);
      const marker =
        item.channel === 'whisper'
          ? chalk.dim(` whispers to ${item.to ?? ''}`)
          : item.channel === 'scratch'
            // #282: the out-of-band channel wears its name, dim - commentary, not direction.
            ? chalk.dim(` (${msg.scratchChannelMark})`)
            : item.channel === 'mention' && item.to
              ? chalk.dim(` to ${item.to}`)
              : '';
      const tags = item.tags.length > 0 ? ' ' + chalk.dim(item.tags.map((t) => `[${t}]`).join(' ')) : '';
      // Panic renders loudly; a re-link shows the answered post's short id in the meta.
      const panicMark = item.panic ? chalk.bgRed.white.bold(` ${msg.feedPanicMark} `) + ' ' : '';
      const reMark = item.re ? ' ' + chalk.dim(`[${msg.feedReMark(item.re)}]`) : '';
      // A ticker riding a content post replaces the key: value stanza dump with
      // the same dim one-liner (collapsed when repeated); a status WITHOUT the
      // protocol `state` keeps the generic stanza rendering.
      const stanza = ticker
        ? ticker.repeated
          ? []
          : [paintTicker(`${FEED_INDENT}${FEED_INDENT}${ticker.state}${ticker.detail ? ': ' + ticker.detail : ''}`)]
        : item.status
          ? stanzaLines(item.status, FEED_INDENT + FEED_INDENT)
          : [];
      let meta = `${time} ${id} ${byline}${marker}`;
      if (item.verb) {
        // Order/receipt meta (wire schema v1 §2 rule 3): verb + args ride the meta line.
        const verbMeta = chalk.bold(item.verb.display + (item.verb.args.length > 0 ? ` ${item.verb.args.join(' ')}` : ''));
        const recipeMark = item.verb.recipe ? ' ' + chalk.dim(`(${msg.feedRecipeVerbMark})`) : '';
        meta += `  ${panicMark}${verbMeta}${recipeMark}`;
      } else if (panicMark) {
        meta += `  ${panicMark.trimEnd()}`;
      }
      meta += `${reMark}${tags}`;
      const body = item.text
        ? wrapText(item.text, Math.max(20, width - FEED_INDENT.length)).map((l) => FEED_INDENT + l)
        : [];
      return [meta, ...body, ...stanza];
    }
  }
}
