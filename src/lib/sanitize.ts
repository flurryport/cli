/**
 * Untrusted-text cleaning for anything that arrives over the wire.
 *
 * Every string in a feed row is written by somebody else - a seat's post text, the
 * participant name on their invite, a recipe-declared verb or status stanza. The
 * console then hands those strings to a surface that OBEYS control characters: a
 * terminal executes ANSI escapes, so an unsanitized post can repaint the screen,
 * move the cursor, set the window title, or paint a counterfeit meta line with the
 * chair's own byline on it. Found live 08-14 by posting a color escape from a seat.
 *
 * This lives at the ENGINE boundary, not in a renderer, because there are now
 * several surfaces (terminal, --json for the nvim plugin, a web view someday) and
 * each would otherwise re-learn the same lesson. Clean once, where the wire is read.
 *
 * The MCP server instructions already say captured content is untrusted data; this
 * is that rule enforced in code rather than asserted in prose.
 */

/** CSI sequences: ESC [ ... final byte. Colors, cursor moves, erases. */
const CSI = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]/g;
/** OSC sequences: ESC ] ... BEL or ST. Window titles, hyperlinks, clipboard writes. */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
/** Anything else introduced by ESC, including a lone trailing ESC. */
const ESC_OTHER = /\x1b[@-_]?[0-?]*[ -/]*[@-~]?/g;
/** C0 controls except tab and newline, DEL, and the C1 block. */
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Clean text that is allowed to span lines. Newlines survive because the feed spec
 * ratified embedded newlines as paragraph breaks; tabs become single spaces so they
 * cannot fake column alignment. Everything that can drive a terminal is removed.
 */
export function sanitizeWireText(value: string): string {
  return value
    .replace(CSI, '')
    .replace(OSC, '')
    .replace(ESC_OTHER, '')
    .replace(/\t/g, ' ')
    .replace(CONTROLS, '');
}

/**
 * Clean a string that must stay on ONE line: a byline, handle, or addressee. A
 * newline here would break the two-line row invariant and let a seat forge a meta
 * line, so newlines collapse to spaces rather than surviving.
 */
export function sanitizeWireLine(value: string): string {
  return sanitizeWireText(value).replace(/\r?\n/g, ' ').trim();
}

/**
 * Clean a recipe-declared status stanza. The interior is console-opaque by design
 * (#246), so keys and string values are cleaned without any shape assumption;
 * non-strings pass through untouched for the renderer to stringify.
 */
export function sanitizeStanza(stanza: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stanza)) {
    out[sanitizeWireLine(key)] = typeof value === 'string' ? sanitizeWireLine(value) : value;
  }
  return out;
}
