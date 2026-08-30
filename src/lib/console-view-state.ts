import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Console-local presentation state (the VIEW verb class, ratified): per-seat color
 * and hidden flags, persisted in `~/.flurryport/console.json`. These are the
 * chair's eyes only - nothing here posts, nothing here is a credential. Colors
 * are stored as palette NAMES; the terminal frontend owns the escape codes.
 */

/** The safe eight, ANSI-16 clean so every terminal renders every name. */
export const CONSOLE_COLORS = ['cyan', 'magenta', 'yellow', 'green', 'blue', 'red', 'white', 'gray'] as const;

/**
 * The extended names a 256-color/truecolor terminal unlocks (ratified: the
 * palette grows with the terminal - purple included, magenta was only ever its
 * understudy). The FRONTEND measures capability and hands the engine the palette
 * in effect; a persisted extended color read on a 16-color terminal degrades at
 * paint time (purple renders magenta), never errors.
 */
export const EXTENDED_COLORS = ['purple', 'orange', 'pink', 'teal'] as const;

/** Every color name the console can ever persist, capability aside. */
export const ALL_CONSOLE_COLORS = [...CONSOLE_COLORS, ...EXTENDED_COLORS] as const;
export type ConsoleColor = (typeof ALL_CONSOLE_COLORS)[number];

export interface SeatViewState {
  color?: ConsoleColor;
  hidden?: boolean;
}

interface ConsoleViewFile {
  version: 1;
  /**
   * The chair's wire address (wire schema v1 §4, ruling 1): asked once ever on the
   * first :seat mint, then seeded silently into every later room. USER level, not
   * per endpoint - one human, one address. Decoupled from :me, which changes the
   * byline only; this address never moves for the life of a room.
   */
  identity?: string;
  /**
   * The chair's :me identity family (#247): the BYLINE (`from` on posted bodies,
   * a courtesy claim, never the wire address) and the chair's own feed color.
   * Console-local persistence like every view preference; USER level like the
   * identity - one human, one byline default across rooms.
   */
  me?: { name?: string; color?: ConsoleColor };
  /** Keyed `${endpointId}:${handle}` so state survives rebinds to the same room. */
  seats: Record<string, SeatViewState>;
  /**
   * Deleted seats (#267): post-mortem cleanup after a revoke. Keyed
   * `${endpointId}:${inviteId}` - the invite id, NOT the handle, because the
   * whole point of delete is that the handle goes back into circulation for a
   * fresh mint. A deleted seat drops off roster and presence surfaces; the log
   * keeps its bylines.
   */
  deleted?: Record<string, true>;
}

const VIEW_STATE_FILE = () => join(homedir(), '.flurryport', 'console.json');

function load(): ConsoleViewFile {
  try {
    if (existsSync(VIEW_STATE_FILE())) {
      const parsed = JSON.parse(readFileSync(VIEW_STATE_FILE(), 'utf8')) as ConsoleViewFile;
      if (parsed && parsed.seats) return parsed;
    }
  } catch {
    /* corrupt view state reads as empty; the next save rewrites it */
  }
  return { version: 1, seats: {} };
}

function save(file: ConsoleViewFile): void {
  const dir = join(homedir(), '.flurryport');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(VIEW_STATE_FILE(), JSON.stringify(file, null, 2), 'utf-8');
}

export function getSeatView(endpointId: string, handle: string): SeatViewState {
  return load().seats[`${endpointId}:${handle}`] ?? {};
}

export function putSeatView(endpointId: string, handle: string, patch: SeatViewState): void {
  const file = load();
  const key = `${endpointId}:${handle}`;
  file.seats[key] = { ...file.seats[key], ...patch };
  save(file);
}

/** Drop a seat's view state (#267): a deleted seat's color and hidden flag must
 * not haunt the next seat that mints onto the same freed handle. */
export function clearSeatView(endpointId: string, handle: string): void {
  const file = load();
  delete file.seats[`${endpointId}:${handle}`];
  save(file);
}

/** Has the chair deleted this seat (#267)? Keyed by invite id; survives rebinds. */
export function isSeatDeleted(endpointId: string, inviteId: string): boolean {
  return load().deleted?.[`${endpointId}:${inviteId}`] === true;
}

/** Mark a seat deleted (#267). One way by design: delete is post-mortem cleanup. */
export function putSeatDeleted(endpointId: string, inviteId: string): void {
  const file = load();
  file.deleted = { ...file.deleted, [`${endpointId}:${inviteId}`]: true };
  save(file);
}

/** Deterministic default color: roster position cycles the palette. */
export function defaultColor(rosterIndex: number): ConsoleColor {
  return CONSOLE_COLORS[rosterIndex % CONSOLE_COLORS.length];
}

/** The seeded chair address, or null on a virgin config (the ask has not happened yet). */
export function getChairIdentity(): string | null {
  const identity = load().identity;
  return typeof identity === 'string' && identity.length > 0 ? identity : null;
}

/** Persist the chair's address. Written once at the first :seat mint, then only re-offered as the default. */
export function putChairIdentity(identity: string): void {
  const file = load();
  file.identity = identity;
  save(file);
}

/** The chair's :me profile: byline name and own feed color, either absent until set. */
export function getChairProfile(): { name: string | null; color: ConsoleColor | null } {
  const me = load().me ?? {};
  return {
    name: typeof me.name === 'string' && me.name.length > 0 ? me.name : null,
    color: typeof me.color === 'string' && me.color.length > 0 ? me.color : null,
  };
}

/** Persist part of the :me profile (name and/or color); untouched members survive. */
export function putChairProfile(patch: { name?: string; color?: ConsoleColor }): void {
  const file = load();
  file.me = { ...file.me, ...patch };
  save(file);
}
