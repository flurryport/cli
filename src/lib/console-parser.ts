/**
 * The console's ex-style command parser (Refinement 8 addendum 2, ratified blocks
 * of 2026-08-13/14): bare typing is the room, `:` is the only mode shift, the
 * TARGET is the range (`:bunny nice move`), `:all` is the universal range, `!` is
 * panic. PURE SYNTAX ONLY - no roster, no API, no rendering. Handle existence,
 * collision suffixes, and scope live in the engine; readline and ANSI live in the
 * terminal frontend. This module is the testable heart and the future RPC mode's
 * shared grammar.
 */

/** Verbs that address a seat (target-first grammar). Mention is the ratified default.
 * `color` is the canonical spelling (#278: "set seat to color", prior state irrelevant);
 * `recolor` stays parseable as its silent compatibility alias. */
export const TARGET_VERBS = ['whisper', 'revoke', 'color', 'recolor', 'hide', 'show', 'delete'] as const;

/** The attention verbs (ratified 2026-08-14, built in 0.5.1 slice C): state vs act. */
export const ATTENTION_VERBS = ['hold', 'resume', 'interrupt'] as const;

/** Addressed order verbs (slice C): status (#246) and install/upgrade (#249). */
export const ORDER_VERBS = ['status', 'install', 'upgrade'] as const;

// 'recolor' is parse-only (#278): the parser normalizes it to 'color' before anything
// downstream sees it, so the alias is excluded here and exhaustive switches stay honest.
export type TargetVerb =
  | Exclude<(typeof TARGET_VERBS)[number], 'recolor'>
  | (typeof ATTENTION_VERBS)[number]
  | (typeof ORDER_VERBS)[number]
  | 'mention';

/**
 * Words a seat can never claim as a handle: the command words, every verb name,
 * and the #253 leave words (canon: reserved words grow; wire schema v1 §1 lists
 * them all).
 */
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'all',
  'help',
  'commands',
  'colors',
  'list',
  'set',
  'seat',
  'roster',
  'mention',
  // #259: :say posts its argument literally, so the bare-exit swallow always
  // leaves a way to post the word itself. A command word, so reserved.
  'say',
  'exit',
  'quit',
  'q',
  // Slice D context/identity verbs (ratified: reserved words grow with the grammar).
  'create',
  'me',
  'collection',
  'tag',
  // The record-control family (#281/#282, G1/G3 ruled 2026-08-17): chair command heads.
  'ratify',
  'retract',
  're',
  'scratch',
  'strike',
  ...TARGET_VERBS,
  ...ATTENTION_VERBS,
  ...ORDER_VERBS,
]);

/** Handles are kebab word tokens through the participantAccountName alphabet, no quoting form. */
const HANDLE_RE = /^[a-z0-9:._-]+$/;

export type ParsedLine =
  | { kind: 'empty' }
  /** Bare text: post to the room. */
  | { kind: 'say'; text: string }
  /** :help / :commands / :help <verb> / :<family> help. topic absent = the full grouped listing. */
  | { kind: 'help'; topic?: string }
  | { kind: 'colors' }
  | { kind: 'list'; what: 'projects' | 'endpoints' | 'seats' | 'decisions' }
  | { kind: 'set'; what: 'project' | 'endpoint'; slug: string }
  /** Both halves in one act: the "project/endpoint" form :list endpoints prints. */
  | { kind: 'bind'; project: string; endpoint: string }
  | { kind: 'seat'; guestName: string }
  /** :exit / :quit / :q (synonyms, #253): bare verbs, no target, no args. */
  | { kind: 'exit' }
  /** :create endpoint <slug> / :create project <name> (#242): context-class WRITE verbs. */
  | { kind: 'create'; what: 'endpoint'; slug: string }
  | { kind: 'create'; what: 'project'; name: string }
  /**
   * :me family (#247, split #269): bare shows; :me name <x> and :me color <c> are
   * the explicit halves; a bare :me <x> is AUTO - the engine matches it against
   * the known color set (a color name sets color, anything else sets the byline)
   * and says which reading it took.
   */
  | { kind: 'me'; action: 'show' }
  | { kind: 'me'; action: 'name'; value: string }
  | { kind: 'me'; action: 'color'; value: string }
  | { kind: 'me'; action: 'auto'; value: string }
  /** :collection <name> (#251): create or bind a collection for the room session. */
  | { kind: 'collection'; name: string }
  /** :tag <id> [collection] (#251): collection absent = the numbered picker. */
  | { kind: 'tag'; id: string; collection?: string }
  /**
   * The record-control family (#281, G1/G2 ruled): pure shapes only. `token` is
   * the first argument when present - the ENGINE disambiguates a roster handle
   * from an 8 character feed reference (the parser cannot see the roster); the
   * rest of the line rides as the chair's scoping prose. Bare :ratify is the
   * ratify-all prompt (items pending) or the re-ratify (nothing pending).
   */
  | { kind: 'ratify'; token?: string; text?: string }
  /** :retract [ref] [prose]: null a ruling or withdraw a proposal by reference. */
  | { kind: 'retract'; token?: string; text?: string }
  /** :re <message> (G1 point 7): reply to a pending proposal without disposition. */
  | { kind: 're'; text: string }
  /**
   * :scratch <text> (#282, G3): out-of-band chair commentary, NOT direction.
   * `implied` marks the keystroke-leak catch: a BARE line leading with a
   * command-shaped word (any reserved word, or a stray y/n confirm answer)
   * lands as scratch instead of posting as a room order - the chair's most
   * likely real failure mode is saying something not meant as direction.
   */
  | { kind: 'scratch'; text: string; implied?: boolean }
  /** :strike <ref> (#282): unsay by reference; the strike propagates on the log. */
  | { kind: 'strike'; token: string; text?: string }
  /** A seat-addressed act. target is the raw handle token ('all' rides the all flag). */
  | {
      kind: 'targeted';
      target: string;
      all: boolean;
      verb: TargetVerb;
      text?: string;
      color?: string;
      /** The single recipe-name token of an install/upgrade order. */
      recipe?: string;
      force: boolean;
      /**
       * Verb-first forgiveness (#277): present only when the typed line led with
       * the verb (`:color fable cyan`) and the parser auto-swapped it into this
       * canonical addressed form. The value is the canonical spelling for the
       * engine's teaching echo. The parser cannot see the roster, so the ENGINE
       * honors the swap only when the target is a live roster handle and falls
       * back to the verb_needs_target usage error otherwise (today's behavior).
       */
      verbFirst?: string;
    }
  | { kind: 'error'; code: ParseErrorCode; token?: string };

export type ParseErrorCode =
  | 'unknown_command'
  | 'verb_needs_target'
  | 'verb_takes_nothing'
  | 'install_needs_recipe'
  | 'install_no_all'
  | 'say_what'
  | 'whisper_needs_text'
  | 'color_needs_color'
  | 'seat_needs_name'
  | 'exit_usage'
  | 'list_usage'
  | 'set_usage'
  | 'create_usage'
  | 'me_color_needs_color'
  | 'me_name_needs_name'
  | 'collection_needs_name'
  | 'tag_needs_id'
  | 're_needs_text'
  | 'scratch_needs_text'
  | 'strike_needs_ref'
  | 'invalid_handle';

/**
 * Stray confirm answers (#282): y/N leftovers typed after a prompt stopped
 * pending. Bare lines leading with these (or any reserved word) are the
 * keystroke leak - they land as scratch, never as a room order.
 */
const CONFIRM_WORDS: ReadonlySet<string> = new Set(['y', 'n', 'yes', 'no']);

/** Strip one trailing '!' (panic) from a verb token. */
function splitForce(token: string): { verb: string; force: boolean } {
  return token.endsWith('!') && token.length > 1
    ? { verb: token.slice(0, -1), force: true }
    : { verb: token, force: false };
}

/** The rest of the raw line after the given token count, original spacing kept. */
function restAfter(body: string, tokens: string[], count: number): string {
  let idx = 0;
  for (let i = 0; i < count; i++) {
    idx = body.indexOf(tokens[i], idx) + tokens[i].length;
  }
  return body.slice(idx).trim();
}

/** Parse what follows a resolved range (a handle or all): default verb is mention. */
function parseTargeted(target: string, all: boolean, body: string, tokens: string[], offset: number): ParsedLine {
  const rest = tokens.slice(offset);
  if (rest.length === 0) return { kind: 'error', code: 'say_what' };

  const { verb, force } = splitForce(rest[0]);

  if ((ATTENTION_VERBS as readonly string[]).includes(verb)) {
    const args = restAfter(body, tokens, offset + 1);
    // Bare interrupt = hard stop (no text member on the wire); interrupt with a
    // message = redirect (ruled 3). hold and resume are bare state verbs.
    if (verb === 'interrupt') {
      return args
        ? { kind: 'targeted', target, all, verb: 'interrupt', text: args, force }
        : { kind: 'targeted', target, all, verb: 'interrupt', force };
    }
    if (args) return { kind: 'error', code: 'verb_takes_nothing', token: verb };
    return { kind: 'targeted', target, all, verb: verb as TargetVerb, force };
  }

  if (verb === 'status') {
    const args = restAfter(body, tokens, offset + 1);
    if (args) return { kind: 'error', code: 'verb_takes_nothing', token: verb };
    return { kind: 'targeted', target, all, verb: 'status', force };
  }

  if (verb === 'install' || verb === 'upgrade') {
    // An install order goes to ONE steward (the chair picks); :all is refused.
    if (all) return { kind: 'error', code: 'install_no_all', token: verb };
    const args = restAfter(body, tokens, offset + 1);
    const parts = args ? args.split(/\s+/) : [];
    if (parts.length !== 1) return { kind: 'error', code: 'install_needs_recipe', token: verb };
    return { kind: 'targeted', target, all: false, verb, recipe: parts[0], force };
  }

  if ((TARGET_VERBS as readonly string[]).includes(verb)) {
    const args = restAfter(body, tokens, offset + 1);
    switch (verb as (typeof TARGET_VERBS)[number]) {
      case 'whisper':
        if (!args) return { kind: 'error', code: 'whisper_needs_text' };
        return { kind: 'targeted', target, all, verb: 'whisper', text: args, force };
      case 'color':
      case 'recolor': // compat alias (#278) - normalized so downstream knows one spelling
        if (!args || args.split(/\s+/).length !== 1) return { kind: 'error', code: 'color_needs_color' };
        return { kind: 'targeted', target, all, verb: 'color', color: args, force };
      case 'revoke':
      case 'hide':
      case 'show':
      // #267: delete is bare like revoke - post-mortem cleanup takes no arguments.
      case 'delete':
        return { kind: 'targeted', target, all, verb: verb as TargetVerb, force };
    }
  }

  // Default addressed verb = MENTION (ratified 2026-08-14 taste-call round).
  return { kind: 'targeted', target, all, verb: 'mention', text: restAfter(body, tokens, offset), force: false };
}

export function parseLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: 'empty' };
  if (!trimmed.startsWith(':')) {
    // The keystroke-leak catch (#282, tightened by #293): only a short command
    // fragment is console input missing its colon. A reserved word by itself or
    // with one argument ("help", "color red") has that shape; a sentence that
    // merely starts with a reserved word is room prose. Confirmations are only
    // scratch when they are the whole line. Exact bare exit/quit stay the
    // engine's swallow, upstream.
    const words = trimmed.split(/\s+/);
    const first = words[0].toLowerCase();
    const impliedCommand = RESERVED_WORDS.has(first) && words.length <= 2;
    const impliedConfirmation = CONFIRM_WORDS.has(first) && words.length === 1;
    if (impliedCommand || impliedConfirmation) {
      return { kind: 'scratch', text: trimmed, implied: true };
    }
    return { kind: 'say', text: trimmed };
  }

  const body = trimmed.slice(1).trim();
  if (body.length === 0) return { kind: 'error', code: 'unknown_command', token: '' };
  const tokens = body.split(/\s+/);
  const head = tokens[0].toLowerCase();

  switch (head) {
    case 'help': {
      // Bare :help, :help list, and :commands are SYNONYMS (ratified refinement).
      if (tokens.length === 1 || tokens[1].toLowerCase() === 'list') return { kind: 'help' };
      return { kind: 'help', topic: tokens[1].toLowerCase() };
    }
    case 'commands':
      return { kind: 'help' };
    case 'colors':
      if (tokens[1]?.toLowerCase() === 'help') return { kind: 'help', topic: 'colors' };
      return { kind: 'colors' };
    case 'list': {
      const raw = tokens[1]?.toLowerCase();
      if (raw === 'help') return { kind: 'help', topic: 'list' };
      if (raw === 'roster' || raw === 'rosters') return { kind: 'list', what: 'seats' }; // the lane-name alias
      // Singular is what people type under pressure; plural stays the canon spelling.
      const what = raw === undefined ? undefined : raw.endsWith('s') ? raw : `${raw}s`;
      if (what === 'projects' || what === 'endpoints' || what === 'seats' || what === 'decisions') return { kind: 'list', what };
      return { kind: 'error', code: 'list_usage' };
    }
    case 'set': {
      const lead = tokens[1]?.toLowerCase();
      if (lead === 'help') return { kind: 'help', topic: 'set' };
      // The noun is optional, and ":list endpoints" PRINTS "project/endpoint" - so
      // that pasted form binds in one act. One slug still needs its noun to say
      // which half it is; two slugs are always project then endpoint.
      const noun = lead === 'project' || lead === 'endpoint' ? lead : null;
      const slugs = tokens
        .slice(noun ? 2 : 1)
        .flatMap((t) => t.split('/'))
        .filter((t) => t.length > 0);
      if (slugs.length === 2) return { kind: 'bind', project: slugs[0], endpoint: slugs[1] };
      if (slugs.length === 1 && noun) return { kind: 'set', what: noun, slug: slugs[0] };
      return { kind: 'error', code: 'set_usage' };
    }
    case 'seat': {
      if (tokens[1]?.toLowerCase() === 'help' && tokens.length === 2) return { kind: 'help', topic: 'seat' };
      const guestName = restAfter(body, tokens, 1);
      if (!guestName) return { kind: 'error', code: 'seat_needs_name' };
      return { kind: 'seat', guestName };
    }
    case 'say': {
      // #259: post the rest of the line LITERALLY. This is how a bare word the
      // console intercepts (exit, quit) still reaches the room when meant.
      if (tokens[1]?.toLowerCase() === 'help' && tokens.length === 2) return { kind: 'help', topic: 'say' };
      const text = restAfter(body, tokens, 1);
      if (!text) return { kind: 'error', code: 'say_what' };
      return { kind: 'say', text };
    }
    case 'create': {
      // #242: the chair BUILDS rooms. Endpoint slugs are one kebab token; a
      // project name is free text (the rest of the line).
      const what = tokens[1]?.toLowerCase();
      if (what === 'help' && tokens.length === 2) return { kind: 'help', topic: 'create' };
      if (what === 'endpoint' && tokens.length === 3) return { kind: 'create', what: 'endpoint', slug: tokens[2] };
      if (what === 'project' && tokens[2]) return { kind: 'create', what: 'project', name: restAfter(body, tokens, 2) };
      return { kind: 'error', code: 'create_usage' };
    }
    case 'me': {
      // #247/#269: the identity family, name and color split. Bare shows;
      // `name <x>` and `color <c>` are explicit; anything else is the AUTO form
      // the engine disambiguates against the known color set (the chair became
      // 'purple' once while seeking a color - never again silently).
      if (tokens.length === 1) return { kind: 'me', action: 'show' };
      if (tokens[1].toLowerCase() === 'help' && tokens.length === 2) return { kind: 'help', topic: 'me' };
      if (tokens[1].toLowerCase() === 'color') {
        if (tokens.length !== 3) return { kind: 'error', code: 'me_color_needs_color' };
        return { kind: 'me', action: 'color', value: tokens[2] };
      }
      if (tokens[1].toLowerCase() === 'name') {
        const value = restAfter(body, tokens, 2);
        if (!value) return { kind: 'error', code: 'me_name_needs_name' };
        return { kind: 'me', action: 'name', value };
      }
      return { kind: 'me', action: 'auto', value: restAfter(body, tokens, 1) };
    }
    case 'collection': {
      // #251: curation from the chair. The rest of the line is the name (server
      // collection names are free text).
      if (tokens[1]?.toLowerCase() === 'help' && tokens.length === 2) return { kind: 'help', topic: 'collection' };
      const name = restAfter(body, tokens, 1);
      if (!name) return { kind: 'error', code: 'collection_needs_name' };
      return { kind: 'collection', name };
    }
    case 'tag': {
      // #251: the id is the feed's short capture id; a missing collection name
      // reaches the engine as the picker form.
      if (tokens[1]?.toLowerCase() === 'help' && tokens.length === 2) return { kind: 'help', topic: 'tag' };
      if (!tokens[1]) return { kind: 'error', code: 'tag_needs_id' };
      const collection = restAfter(body, tokens, 2);
      return collection ? { kind: 'tag', id: tokens[1], collection } : { kind: 'tag', id: tokens[1] };
    }
    case 'ratify':
    case 'retract': {
      // #281: bare = the queue act (ratify-all prompt / re-ratify, or the
      // retract picker); one leading token is a handle or feed reference the
      // engine resolves; anything after it is the chair's scoping prose.
      if (tokens[1]?.toLowerCase() === 'help' && tokens.length === 2) return { kind: 'help', topic: head };
      if (tokens.length === 1) return { kind: head as 'ratify' | 'retract' };
      const text = restAfter(body, tokens, 2);
      return text
        ? { kind: head as 'ratify' | 'retract', token: tokens[1], text }
        : { kind: head as 'ratify' | 'retract', token: tokens[1] };
    }
    case 're': {
      // #281 (G1 point 7): the chair's middle move. The whole rest of the line is
      // the message; the engine peels a leading feed reference when one resolves.
      if (tokens[1]?.toLowerCase() === 'help' && tokens.length === 2) return { kind: 'help', topic: 're' };
      const text = restAfter(body, tokens, 1);
      if (!text) return { kind: 'error', code: 're_needs_text' };
      return { kind: 're', text };
    }
    case 'scratch': {
      // #282: deliberate out-of-band commentary. The rest of the line is the text.
      if (tokens[1]?.toLowerCase() === 'help' && tokens.length === 2) return { kind: 'help', topic: 'scratch' };
      const text = restAfter(body, tokens, 1);
      if (!text) return { kind: 'error', code: 'scratch_needs_text' };
      return { kind: 'scratch', text };
    }
    case 'strike': {
      // #282: unsay by reference. One ref token; anything after rides as prose.
      if (tokens[1]?.toLowerCase() === 'help' && tokens.length === 2) return { kind: 'help', topic: 'strike' };
      if (!tokens[1]) return { kind: 'error', code: 'strike_needs_ref' };
      const text = restAfter(body, tokens, 2);
      return text ? { kind: 'strike', token: tokens[1], text } : { kind: 'strike', token: tokens[1] };
    }
    case 'exit':
    case 'quit':
    case 'q': {
      // #253: three synonyms, all bare. The suffix-help form stays reachable; any
      // other argument is a usage error, never a mystery.
      if (tokens[1]?.toLowerCase() === 'help' && tokens.length === 2) return { kind: 'help', topic: 'exit' };
      if (tokens.length > 1) return { kind: 'error', code: 'exit_usage' };
      return { kind: 'exit' };
    }
    case 'all': {
      if (tokens[1]?.toLowerCase() === 'help' && tokens.length === 2) return { kind: 'help', topic: 'all' };
      return parseTargeted('all', true, body, tokens, 1);
    }
    default: {
      // A known verb with no range is a usage error, not a mystery. This covers
      // the dropped verb-first :install form too (install is ADDRESSED, ruled).
      const { verb } = splitForce(head);
      if (
        (TARGET_VERBS as readonly string[]).includes(verb) ||
        (ATTENTION_VERBS as readonly string[]).includes(verb) ||
        (ORDER_VERBS as readonly string[]).includes(verb) ||
        verb === 'mention'
      ) {
        // Verb-first forgiveness (#277): the exact shape `verb handle [args...]`
        // auto-swaps to the canonical `handle verb [args...]` form, original arg
        // spacing kept. Only a swap that parses to a COMPLETE targeted act rides;
        // anything short of that (missing color, extra install tokens) falls
        // through to the usage error exactly as before. Mention is excluded:
        // there is no verb-first mention shape to forgive.
        const handleTok = tokens[1]?.toLowerCase();
        if (verb !== 'mention' && handleTok !== undefined && HANDLE_RE.test(handleTok)) {
          const args = restAfter(body, tokens, 2);
          const canonicalBody = `${handleTok} ${head}${args ? ` ${args}` : ''}`;
          const swapped = parseTargeted(handleTok, false, canonicalBody, canonicalBody.split(/\s+/), 1);
          if (swapped.kind === 'targeted') {
            // The echo teaches the canonical spelling (recolor already normalized to color).
            return {
              ...swapped,
              verbFirst: `:${handleTok} ${swapped.verb}${swapped.force ? '!' : ''}${args ? ` ${args}` : ''}`,
            };
          }
        }
        return { kind: 'error', code: 'verb_needs_target', token: verb };
      }
      if (!HANDLE_RE.test(head)) return { kind: 'error', code: 'invalid_handle', token: tokens[0] };
      return parseTargeted(head, false, body, tokens, 1);
    }
  }
}
