import { parseLine, RESERVED_WORDS, type ParsedLine, type ParseErrorCode } from './console-parser.js';
import { assignHandles, handleBase, sanitizeGuestName } from './console-handles.js';
import { participantAccountName } from './config.js';
import {
  ALL_CONSOLE_COLORS,
  CONSOLE_COLORS,
  clearSeatView,
  getChairIdentity,
  getChairProfile,
  getSeatView,
  isSeatDeleted,
  putChairIdentity,
  putChairProfile,
  putSeatDeleted,
  putSeatView,
  type ConsoleColor,
} from './console-view-state.js';
import { consoleMessages as msg, helpListing, verbHelp } from './console-messages.js';
import { sanitizeStanza, sanitizeWireLine, sanitizeWireText } from './sanitize.js';
import { AuthApiError } from './auth-api.js';
import type { RoomApi, RoomCanonRow, RoomCollection, RoomEndpoint, RoomMap, RoomProject, RoomSeat, RoomSection } from './console-room.js';
import { verifyChain } from './hashchain.js';
import type { AttentionOrder } from './attention-relay.js';
import type { PresenceLedger } from './presence.js';

/**
 * The console ENGINE: parser dispatch, room state (context, roster, feed cursor),
 * and the verb semantics - everything the chair does, with NOTHING about how it
 * looks. The engine emits render-agnostic events; the terminal frontend (and the
 * future `console --rpc` frontend) consumes them. No readline, no ANSI, no chalk
 * in this module or its imports - that seam is a structural requirement, not
 * taste.
 */

/**
 * The virgin-config FALLBACK for the chair's wire address and byline (wire schema
 * v1 §4, ruling 1). The real address is asked on the first :seat mint and persisted
 * in the console view-state file; this constant only fills in until then.
 */
export const CHAIR_FROM = 'director';

/** The closed fp: platform verb registry, wire schema v1 (additions are gavel acts). */
export const FP_VERBS: ReadonlySet<string> = new Set([
  'fp:hold',
  'fp:resume',
  'fp:interrupt',
  'fp:ack',
  'fp:refuse',
  'fp:status',
  'fp:install',
  // #266: the seat's sign-off. A post carrying fp:bye reads the seat as departed
  // until it posts again; delete (#267) is unlocked on a departed seat.
  'fp:bye',
  // The record-control family (#281, gaveled 2026-08-17). The proposal marker is
  // a VERB (fp:propose), not a kind and not a flag: verbs are the wire's channel
  // for acts on the record (fp:ack, fp:refuse, fp:status all ride it), and
  // flagging a post as needing ratification IS an act demanding disposition -
  // whereas kind discriminates channels (message/whisper) and a bare flag member
  // would be a second marker mechanism beside the one the registry already has.
  // fp:ratify is the chair's ruling, re-linked to the proposal; fp:retract nulls
  // by reference (a proposal withdraws, a referenced ruling un-rules) - it ships
  // in the same gaveled work item with its own wire form, so its registry row
  // rides the same gavel.
  'fp:propose',
  'fp:ratify',
  'fp:retract',
  // #282 (G3, same gavel): the propagating un-say. A verb, consistently with
  // fp:propose - striking a post is an act on the record demanding every
  // reader's obedience, re-linked to what it unsays. (Scratch, by contrast, is
  // a KIND: it changes how a post reads, not what anyone must do - kinds
  // discriminate channels, verbs carry acts.) The registry addition rides the
  // #282 gavel per the ruling's own terms.
  'fp:strike',
  // #499 gap 5 (room-verb parity, built on Gene's word 2026-09-23): the review
  // family the live rooms write. fp:review carries a `verdict` member re-linked
  // to the proposal; fp:note is commentary on the record; fp:open opens a
  // section for proposals. Known here so the feed stops tagging them unknown
  // and the ledger can read a verdict off them.
  'fp:review',
  'fp:note',
  'fp:open',
]);

/** The review verdict words the ledger reads (#499 gap 5), off fp:review's verdict or an r: verb. */
const REVIEW_WORDS: ReadonlySet<string> = new Set(['proceed', 'hold', 'finding', 'resolved', 'satisfied']);

/**
 * The console's in-process room server, behind an injected seam (#253): the
 * FRONTEND constructs it (it owns serveMcpHttp, signals, and teardown); the engine
 * only ever asks for the room lazily, on the first :seat mint. A console that
 * never mints never binds a port. The engine stays free of readline, ANSI, and
 * the HTTP server alike; null host = the standalone seat-server flow.
 */
export interface RoomHost {
  /** Start the room if it is not up; started is true only on the first call. */
  ensureStarted(): Promise<{ url: string; started: boolean }>;
  /**
   * Attention relay (slice C): pass the chair's attention orders, per participant
   * name, into the in-process room server's meta assembly so the targeted seat's
   * very next tool-call response carries the wake-up nudge. Optional by design:
   * the standalone `flurryport seat-server` flow has no console and no orders.
   */
  orderAttention?(participantNames: string[], order: AttentionOrder): void;
}

/** A rendered order/receipt verb on a feed line (§2 rule 3: render and tag, never obey). */
export interface FeedVerb {
  raw: string;
  /** Display form: fp:/r: prefix stripped. */
  display: string;
  /** True for r: verbs, rendered marked as recipe verbs. */
  recipe: boolean;
  args: string[];
}

export type ConsoleEvent =
  | { type: 'info'; text: string }
  | { type: 'error'; text: string }
  | { type: 'help'; lines: string[] }
  | { type: 'projects'; rows: RoomProject[] }
  | { type: 'endpoints'; rows: Array<{ projectSlug: string; slug: string; name: string }> }
  | {
      type: 'roster';
      rows: Array<{
        handle: string;
        guestName: string;
        status: string;
        live: boolean;
        /** Session-local held mark (slice C): the chair's hold stands until resume/release. */
        held: boolean;
        /**
         * Post-mortem grey (#267/#266): a revoked, expired, or departed seat
         * stays on the roster GREYED - the log keeps its bylines - instead of
         * vanishing. Renderers paint the whole row muted when this is true.
         */
        greyed: boolean;
        /**
         * Presence truth (#266): live / idle / adrift off the transport ledger,
         * departed off an fp:bye sign-off. Null when the seat is not accepted
         * (the status word speaks) or the console has no transport knowledge -
         * renderers keep their pre-#266 words on null.
         */
        presence: 'live' | 'idle' | 'adrift' | 'departed' | null;
        color: ConsoleColor;
        hidden: boolean;
        endpointSlug: string;
        /**
         * #499 gap 4: the room map's role for this handle (chair, host, producer,
         * monitor, relayed) when the orientation roster names it; null for a
         * minted seat the map does not mention. A map-only handle has no seat:
         * its status IS the role word, live false, presence null.
         */
        role: string | null;
      }>;
    }
  /**
   * A read view (#499 gap 4/6): sections, the orientation, the canon, delivery
   * receipts, the chain check. A title line then plain rows; renderers paint the
   * title as info and the rows dim, exactly like help. Kept generic on purpose:
   * the reads are for eyes, and every frontend renders them the same way.
   */
  /**
   * Where the console IS (#499 gap 9): the bound room, or all null when the bind
   * is cleared. The terminal already says it in the `bound` line, so its renderer
   * prints nothing; a driving frontend (the nvim plugin) paints it somewhere
   * persistent, because a feed of bylines never says which room they posted in.
   */
  | { type: 'room'; projectSlug: string | null; endpointSlug: string | null; name: string | null }
  | { type: 'view'; title: string; lines: string[] }
  /**
   * The status facts table (#246, layers 1+2): server/roster facts the room cannot
   * be wrong about, rendered instantly, plus the seat's latest volunteered stanza.
   */
  | {
      type: 'status';
      rows: Array<{
        handle: string;
        guestName: string;
        /** live | held | idle from engine state, or the raw invite status when not accepted. */
        state: string;
        expiresAt: string;
        lastPostAt: string | null;
        posts: number;
        /** The recipe-declared status object off the seat's latest signed post; console-opaque. */
        stanza: Record<string, unknown> | null;
        stanzaAt: string | null;
      }>;
    }
  /**
   * The decision ledger (#295, G4 carried): EVERY proposal ever flagged,
   * chronological, one row each, states derived from the log - never stored
   * beside it. The console prints it for :list decisions; the nvim frontend
   * repaints its decisions panel from the same event, exactly as the roster
   * event drives the presence strip. Emitted whenever a record-control act or
   * a backfill changes the ledger (the #279 immediate-repaint pattern), and
   * once, empty, at bind so no panel outlives its room.
   */
  | {
      type: 'decisions';
      rows: Array<{
        /** The proposal post's full feed id: what re-links and threads key on. */
        id: string;
        /** The first 8 characters, the record-reference width (#281). */
        ref: string;
        state: 'needs-ratification' | 'ratified' | 'retracted' | 'struck';
        /** The sanitized summary, else the post text collapsed to one line. */
        summary: string;
        /** The ratifying post's 8 character reference, when the log named one. */
        ratifiedBy: string | null;
        /** Disposition arrival time; the nvim glance fades settled rows from this clock. */
        settledAt: string | null;
        /**
         * #499 gap 5: the latest review verdict the log carried for this row
         * (proceed, hold, finding, resolved, satisfied), null when unreviewed.
         * A pending proposal with a proceed is a different state from a bare one.
         */
        verdict: string | null;
      }>;
    }
  | { type: 'colors'; colors: readonly string[] }
  | { type: 'confirm'; text: string }
  /** A plain question owning the next input line (the chair-identity ask). */
  | { type: 'ask'; text: string }
  /**
   * The chair is leaving (#253): the FRONTEND performs teardown and exit; the
   * engine only ever announces it. No process.exit lives on this side of the seam.
   */
  | { type: 'exit' }
  | { type: 'pairing'; code: string; chairLines: string[]; passLines: string[] }
  | {
      type: 'feed';
      item: {
        at: string;
        /**
         * The short capture id (feed spec, ratified): captures are ADDRESSABLE
         * OBJECTS from the chair - this id is what :tag consumes and what re
         * answers. Renderers put it in the meta line, [time] [id] [actor].
         */
        id: string;
        /**
         * The deduped byline (feed spec, ratified): GuestName (handle) only when
         * they differ after normalization; a name that normalizes to itself
         * renders alone ("fable (fable)" is just "fable").
         */
        byline: string;
        color: ConsoleColor | null;
        /** 'scratch' (#282): the chair's out-of-band channel, rendered marked. */
        channel: 'room' | 'mention' | 'whisper' | 'scratch' | 'raw';
        to: string | null;
        /**
         * The addressee's color (#263): the seat color when `to` names a roster
         * handle (suffixed handles included), the chair's own color when it
         * names the chair's wire address or :me byline, null otherwise (all,
         * unknown names). Renderers fall back to their meta style on null.
         */
        toColor: ConsoleColor | null;
        text: string;
        mine: boolean;
        /** Present when the post carries a verb: an order/receipt line. */
        verb: FeedVerb | null;
        /** The capture id this post answers (§1 row 7); renderers show it in the meta line. */
        re: string | null;
        /** #499 gap 13: the section the post is about (`for`); renderers show it in the meta line. */
        for: string | null;
        /**
         * #499 gap 9/10: the wire `from` claim, raw. The frontend arms a post with
         * it: answering the post addresses this name. On a signed room the signer
         * label is the authority (byline); on an unsigned room this is all there is.
         */
        from: string | null;
        /** The ! flag on the wire; renderers mark panic posts loudly. */
        panic: boolean;
        /** The recipe-declared status stanza riding this post; rendered generically. */
        status: Record<string, unknown> | null;
        /**
         * The status ticker (#280b): present when the status object carries the
         * ratified protocol shape (a string `state`). Renderers paint it as ONE
         * dim line: state, then reason or task when present. `pure` marks a bare
         * fp:status transition (no text): the one-liner IS the whole row.
         * `repeated` marks a consecutive same-seat same-state ticker: renderers
         * collapse it instead of stacking. (Named `repeated` because `repeat` is
         * a Lua keyword and the nvim renderer reads this shape verbatim.)
         */
        statusTicker: { state: string; detail: string | null; pure: boolean; repeated: boolean } | null;
        /** Render-and-tag notes (§2): schema version, unknown kind, unknown verb. */
        tags: string[];
      };
    };

interface RosterEntry extends RoomSeat {
  handle: string;
}

interface BoundRoom {
  project: RoomProject;
  endpoint: RoomEndpoint;
  endpointSlug: string;
  signingEnabled: boolean;
  signingHeader: string | null;
}

const FEED_BACKFILL_ROWS = 10;

/**
 * The git-style floor on capture-id prefixes (#259): shorter than this a token
 * is taken verbatim, never prefix-matched. Six characters keeps accidental
 * matches out of a base62 id space while staying half the width of a full id.
 */
export const CAPTURE_ID_PREFIX_FLOOR = 6;

/**
 * How much of a shapeless body stands in for a missing `text` field. §2's raw
 * passthrough is ratified for non-JSON and non-object bodies and stays untouched;
 * this cap covers the third case the rule never named - a JSON OBJECT carrying no
 * `text` - where an uncapped fallback dumps the whole payload into the feed.
 * Found live 08-14: ten writers-room `draft` rows, ~1.2k chars each, buried the room.
 */
const FEED_RAW_PREVIEW_CHARS = 220;

/**
 * The pending-queue picker's reference width (#281, ruled): the first 8 chars of
 * the post's sign - its feed id - which the engine's existing prefix resolution
 * (floor 6) takes back as an argument, so what the picker shows always resolves.
 */
export const RECORD_REF_CHARS = 8;

/**
 * How much summary a picker row shows (#281): `  12. [abcd1234] ` spends about
 * 17 columns, so 60 keeps a row inside an 80-column line with room for a
 * two-digit ordinal.
 */
export const RECORD_SUMMARY_CHARS = 60;

/**
 * One pending-queue entry (#281, G4): DERIVED state, a view over the log -
 * flagged posts minus those ratified/retracted - never a side structure. The
 * map key is the proposal post's feed id.
 */
interface ProposalRecord {
  /** The sanitized one-line summary member, null when the proposal broke the rule. */
  summary: string | null;
  /** What pickers render: the summary, else the post text collapsed to one line. */
  preview: string;
  /** The proposer's roster handle when the signer holds a seat; null otherwise. */
  handle: string | null;
  at: string;
  /**
   * struck (#295): a struck proposal keeps its ledger row wearing the state
   * instead of vanishing - the ledger lists every proposal EVER flagged. The
   * pending queue still loses it, and no disposition can move it again.
   */
  state: 'pending' | 'ratified' | 'retracted' | 'struck';
  settledAt: string | null;
  /** #499 gap 3: the section the proposal named (`for`), what the gavel carries forward. */
  section: string | null;
  /** #499 gap 3: who to address the ruling to - the seat handle, else the wire from claim. */
  author: string | null;
  /** #499 gap 5: the latest review verdict off the log. */
  verdict: string | null;
}

/** What this session knows about one post on the feed (#499): the facts the acts reuse. */
interface FeedPostFacts {
  /** The wire from claim, raw. */
  from: string | null;
  /** The roster handle when the signer holds a seat. */
  handle: string | null;
  mine: boolean;
  section: string | null;
  text: string;
  summary: string | null;
  /** The parsed body when it was a JSON object; :verify walks these for a chain. */
  body: Record<string, unknown> | null;
  signerLabel: string | null;
  /** The wire `re`, raw: for a proposal, the standing post it changes (the rooms' convention). */
  re: string | null;
}

function info(text: string): ConsoleEvent {
  return { type: 'info', text };
}

function error(text: string): ConsoleEvent {
  return { type: 'error', text };
}

function parseErrorText(code: ParseErrorCode, token?: string): string {
  switch (code) {
    case 'unknown_command': return msg.unknownCommand(token ?? '');
    case 'create_usage': return msg.createUsage;
    case 'me_color_needs_color': return msg.meColorNeedsColor;
    case 'me_name_needs_name': return msg.meNameNeedsName;
    case 'collection_needs_name': return msg.collectionNeedsName;
    case 'tag_needs_id': return msg.tagNeedsId;
    case 're_needs_text': return msg.reNeedsText;
    case 'scratch_needs_text': return msg.scratchNeedsText;
    case 'strike_needs_ref': return msg.strikeNeedsRef;
    case 'verb_needs_target': return msg.verbNeedsTarget(token ?? '');
    case 'verb_takes_nothing': return msg.verbTakesNothing(token ?? '');
    case 'install_needs_recipe': return msg.installNeedsRecipe(token ?? '');
    case 'install_no_all': return msg.installNoAll(token ?? '');
    case 'say_what': return msg.sayWhat;
    case 'whisper_needs_text': return msg.whisperNeedsText;
    case 'color_needs_color': return msg.colorNeedsColor;
    case 'seat_needs_name': return msg.seatNeedsName;
    case 'exit_usage': return msg.exitUsage;
    case 'list_usage': return msg.listUsage;
    case 'set_usage': return msg.setUsage;
    case 'invalid_handle': return msg.invalidHandle(token ?? '');
    case 'for_usage': return msg.forUsage;
    case 'sections_usage': return msg.sectionsUsage;
    case 'pin_usage': return msg.pinUsage;
    case 'canon_usage': return msg.canonUsage;
  }
}

export class ConsoleEngine {
  private readonly api: RoomApi;
  private readonly host: RoomHost | null;
  private project: RoomProject | null = null;
  private room: BoundRoom | null = null;
  private roster: RosterEntry[] = [];
  private cursor: string | null = null;
  private feedPrimed = false;
  private pendingRevoke: { handles: string[] } | null = null;
  private pendingIdentity: { guestName: string } | null = null;
  /** The re-seat y/N (#499 gap 16): the next line answers for the named live seat. */
  private pendingReseat: { guestName: string; inviteId: string; handle: string } | null = null;
  /**
   * The room map (#499 gap 1/4): sections and the orientation roster, loaded at
   * bind and refreshed by the read verbs. Null when the server has none (an
   * older server, or a room never oriented).
   */
  private roomMap: RoomMap | null = null;
  /** Per-post facts this session's feed carried (#499), by capture id. */
  private feedPosts = new Map<string, FeedPostFacts>();
  /** The last capture this console posted (#499 gap 6): what bare :receipts reads. */
  private lastPosted: string | null = null;
  /** Boarding passes minted this session, by console handle (#499 gap 16: :seat <handle> pass). */
  private passes = new Map<string, Extract<ConsoleEvent, { type: 'pairing' }>>();
  /** The section a :for modifier is filing the current line for (#499 gap 2); transient. */
  private forSection: string | null = null;
  /** The :tag picker (#251): the next line answers with a number or a new name. */
  private pendingTag: { captureId: string; options: Array<{ name: string; id: string | null }> } | null = null;
  /** undefined = not yet loaded from the view-state file. */
  private identityCache: string | null | undefined = undefined;
  /** The :me profile (#247), cached like the identity; invalidated on writes. */
  private profileCache: { name: string | null; color: ConsoleColor | null } | undefined = undefined;
  /**
   * The palette IN EFFECT: the frontend measures the terminal's color capability
   * and hands the engine what it can actually render (capability-aware palette,
   * ratified). Persisted extended names on a lesser terminal degrade at paint
   * time in the frontend; the engine only gates NEW choices.
   */
  private readonly palette: readonly ConsoleColor[];
  /** Collections this session knows: name -> id, or null while creation waits for the first :tag. */
  private collections = new Map<string, string | null>();
  // ── attention + status state (slice C, session-local by design) ────────────
  /** Seats the chair holds. hold marks, resume/release clears. */
  private held = new Set<string>();
  /** Seats hard-stopped by a bare interrupt: idling for fresh orders. */
  private idle = new Set<string>();
  /** Per-handle feed history facts (#246 layer 1): what THIS console observed. */
  private feedSeen = new Map<string, { lastPostAt: string; posts: number }>();
  /**
   * Every capture id this session's feed has carried, hidden rows included
   * (#259): the resolution pool for git-style id prefixes. Insertion ordered.
   */
  private feedIds = new Set<string>();
  /** Per-handle latest status stanza off the stream (#246 layer 2). */
  private latestStanza = new Map<string, { at: string; stanza: Record<string, unknown> }>();
  /**
   * Seats signed off with fp:bye (#266). Session-local like held/idle; a later
   * post from the seat clears it (chronological replay keeps backfill honest).
   */
  private departed = new Set<string>();
  // ── record control (#281): every field here is a VIEW over the log (G4) ────
  /** Flagged posts by feed id, dispositions applied as the log carries them. */
  private proposals = new Map<string, ProposalRecord>();
  /** Chair ratification posts observed on the log: ruling post id -> proposal id. */
  private ratifications = new Map<string, string>();
  /** What bare :ratify with nothing pending renews (ratify-again REPLACES). */
  private lastRatification: { proposalId: string } | null = null;
  /** The bare-:ratify y/N (G1 point 4): the next line answers for all pending. */
  private pendingRatifyAll: { ids: string[] } | null = null;
  /**
   * The pending-queue picker (G1 point 3): the closest honest readline
   * equivalent of the ruled tab-through - a numbered pick, the :tag idiom. The
   * next input line answers with a number; `text` is the chair's prose held
   * for the picked act (the :re message, or ratify/retract scoping prose).
   */
  private pendingRecordPick: { mode: 'ratify' | 'retract' | 're' | 'review'; ids: string[]; text: string | null; verdict?: string } | null = null;
  /**
   * Posts the log has struck (#282): fp:strike re-links carry it, and the
   * console's own :strike applies it optimistically. A struck id re-delivered
   * (cursor overlap, backfill) renders wearing the struck mark.
   */
  private struck = new Set<string>();
  /**
   * Bumped by every mutation the decision ledger can see (#295): propose adds,
   * dispositions, strikes - console acts and log derivation alike. pollFeed and
   * the record acts compare it around their work and emit ONE decisions event
   * when it moved, so every frontend repaints the moment the ledger changes and
   * never otherwise.
   */
  private ledgerVersion = 0;
  /**
   * The last status ticker RENDERED (#280b): consecutive repeats of the same
   * seat+state collapse instead of stacking. Any visible non-ticker row resets
   * the run (consecutive means consecutive on the chair's screen).
   */
  private lastTicker: { key: string; state: string } | null = null;
  /**
   * The transport ledger (#266): the seat server writes contact into it, the
   * roster and status tables read live/idle/adrift out of it. Null = this
   * console has no transport knowledge (no hosted room), and presence stays
   * null on accepted seats rather than guessing.
   */
  private readonly presence: PresenceLedger | null;

  constructor(
    api: RoomApi,
    host: RoomHost | null = null,
    opts: { palette?: readonly ConsoleColor[]; presence?: PresenceLedger } = {},
  ) {
    this.api = api;
    this.host = host;
    this.palette = opts.palette ?? CONSOLE_COLORS;
    this.presence = opts.presence ?? null;
  }

  isBound(): boolean {
    return this.room !== null;
  }

  /** The bound room, for surfaces that name it (the #288 preflight); null while unbound. */
  /**
   * The bound room as an event, for frontends that show it persistently rather
   * than in the scroll (#499 gap 9). Null members mean no room is bound.
   */
  roomEvent(): ConsoleEvent {
    return this.room
      ? {
          type: 'room',
          projectSlug: this.room.project.slug,
          endpointSlug: this.room.endpointSlug,
          name: this.room.endpoint.name ?? null,
        }
      : { type: 'room', projectSlug: null, endpointSlug: null, name: null };
  }

  roomInfo(): { projectSlug: string; endpointSlug: string } | null {
    return this.room ? { projectSlug: this.room.project.slug, endpointSlug: this.room.endpointSlug } : null;
  }

  /**
   * Clean-shutdown record (#292): the chair dismisses every seat on the shared
   * log before the in-process room drains. The command owns WHEN this runs; the
   * engine owns the signed wire shape and chair identity.
   */
  async dismissRoom(): Promise<ConsoleEvent[]> {
    return this.post({
      kind: 'message',
      to: 'all',
      verb: 'fp:bye',
      text: msg.roomDismissal,
    });
  }

  /** The seeded chair address (persisted), or null before the first-ever ask. */
  private chairAddress(): string | null {
    if (this.identityCache === undefined) this.identityCache = getChairIdentity();
    return this.identityCache;
  }

  /** Deterministic default seat color: roster position cycles the palette IN EFFECT. */
  private paletteDefault(rosterIndex: number): ConsoleColor {
    return this.palette[((rosterIndex % this.palette.length) + this.palette.length) % this.palette.length];
  }

  /** The :me profile, loaded once and refreshed on :me writes. */
  private profile(): { name: string | null; color: ConsoleColor | null } {
    if (this.profileCache === undefined) this.profileCache = getChairProfile();
    return this.profileCache;
  }

  /**
   * The chair's byline (`from` on every posted body): the :me name when set
   * (#247, byline only - never the wire address), else the seeded chair address,
   * else the fallback.
   */
  private fromName(): string {
    return this.profile().name ?? this.mapChairHandle() ?? this.chairAddress() ?? CHAIR_FROM;
  }

  /**
   * #499 gap 8: the handle the room map names as chair, when it names one. With
   * no :me name set the console posts under it, so the record reads the way the
   * orientation does (every live room named the chair gene while the console
   * stamped director).
   */
  private mapChairHandle(): string | null {
    return this.roomMap?.roster.find((r) => r.role === 'chair')?.handle ?? null;
  }

  /** The section handles the room publishes; empty when it publishes no map. */
  private sectionHandles(): string[] {
    return this.roomMap?.sections.map((x) => x.handle) ?? [];
  }

  /** Run one input line to completion; the returned events are the whole answer. */
  async execute(line: string): Promise<ConsoleEvent[]> {
    // A pending ask owns the next line: the answer becomes the seeded chair address.
    if (this.pendingIdentity) {
      const pending = this.pendingIdentity;
      this.pendingIdentity = null;
      return this.answerIdentity(line, pending.guestName);
    }
    // The re-seat y/N (#499 gap 16) owns the next line: y revokes and re-mints.
    if (this.pendingReseat) {
      const pending = this.pendingReseat;
      this.pendingReseat = null;
      const answer = line.trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') return [info(msg.reseatCancelled)];
      try {
        return await this.performReseat(pending.guestName, pending.inviteId, pending.handle);
      } catch (err) {
        if (err instanceof AuthApiError) return [error(this.httpErrorText(err))];
        throw err;
      }
    }
    // A pending y/N owns the next line: y runs the revoke, anything else cancels.
    if (this.pendingRevoke) {
      const pending = this.pendingRevoke;
      this.pendingRevoke = null;
      const answer = line.trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') return this.performRevoke(pending.handles);
      return [info(msg.revokeCancelled)];
    }
    // The ratify-all y/N (#281, G1 point 4) owns the next line.
    if (this.pendingRatifyAll) {
      const pending = this.pendingRatifyAll;
      this.pendingRatifyAll = null;
      const answer = line.trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') return [info(msg.ratifyCancelled)];
      try {
        const events: ConsoleEvent[] = [];
        for (const id of pending.ids) events.push(...(await this.performRatify(id, null, false)));
        return events;
      } catch (err) {
        if (err instanceof AuthApiError) return [error(this.httpErrorText(err))];
        throw err;
      }
    }
    // The pending-queue picker (#281) owns the next line: a number picks, empty
    // or anything else cancels (a miskey must never gavel the wrong item).
    if (this.pendingRecordPick) {
      const pending = this.pendingRecordPick;
      this.pendingRecordPick = null;
      const answer = line.trim();
      const n = /^\d+$/.test(answer) ? Number(answer) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > pending.ids.length) return [info(msg.recordPickerCancelled)];
      try {
        return await this.answerRecordPick(pending.mode, pending.ids[n - 1], pending.text, pending.verdict);
      } catch (err) {
        if (err instanceof AuthApiError) return [error(this.httpErrorText(err))];
        throw err;
      }
    }
    // The :tag picker owns the next line: a number picks, text names, empty cancels.
    if (this.pendingTag) {
      const pending = this.pendingTag;
      this.pendingTag = null;
      try {
        return await this.answerTagPicker(line, pending);
      } catch (err) {
        if (err instanceof AuthApiError) return [error(this.httpErrorText(err))];
        throw err;
      }
    }

    // The bare-exit swallow (#259, ruled): a line that is EXACTLY exit or quit
    // never posts - four of these reached the permanent log in two days. The
    // hint names the door (:exit) and the literal form (:say exit). Only BARE
    // lines are intercepted; :say and the :exit family are untouched.
    const bare = line.trim();
    if (bare === 'exit' || bare === 'quit') return [info(msg.bareExitHint(bare))];

    const parsed = parseLine(line);
    try {
      return await this.dispatch(parsed);
    } catch (err) {
      // #245: every API failure reachable from a typed line renders a short
      // friendly sentence, never a raw status or a stack trace in the feed.
      if (err instanceof AuthApiError) return [error(this.httpErrorText(err))];
      throw err;
    }
  }

  /** The #245 status map: 401/403/404/429 get named lines; the rest keep the server's words. */
  private httpErrorText(err: AuthApiError): string {
    switch (err.status) {
      case 401: return msg.http401;
      case 403: return msg.http403(err.detail);
      case 404: return msg.http404(err.detail);
      case 429: return msg.http429;
      default: return msg.httpOther(err.status, err.detail);
    }
  }

  private async dispatch(parsed: ParsedLine): Promise<ConsoleEvent[]> {
    switch (parsed.kind) {
      case 'empty': return [];
      case 'error': return [error(parseErrorText(parsed.code, parsed.token))];
      case 'help': return [this.help(parsed.topic)];
      case 'colors': return [{ type: 'colors', colors: this.palette }];
      case 'create':
        return parsed.what === 'endpoint' ? this.createEndpoint(parsed.slug) : [info(msg.createProjectUnavailable)];
      case 'me': return this.me(parsed);
      case 'collection': return this.bindCollection(parsed.name);
      case 'tag': return this.tag(parsed.id, parsed.collection ?? null);
      case 'ratify': return this.ratify(parsed.token ?? null, parsed.text ?? null);
      case 'retract': return this.retract(parsed.token ?? null, parsed.text ?? null);
      case 're': return this.replyPending(parsed.text);
      case 'scratch': return this.scratch(parsed.text, parsed.implied === true);
      case 'strike': return this.strike(parsed.token, parsed.text ?? null);
      case 'list':
        if (parsed.what === 'projects') return this.listProjects();
        if (parsed.what === 'endpoints') return this.listEndpoints();
        if (parsed.what === 'decisions') return this.listDecisions();
        return this.listSeats();
      case 'set':
        return parsed.what === 'project' ? this.setProject(parsed.slug) : this.setEndpoint(parsed.slug, parsed.force === true);
      case 'bind': return this.bindRoom(parsed.project, parsed.endpoint);
      case 'seat': return this.mintSeat(parsed.guestName, parsed.force === true);
      case 'seat-pass': return this.reprintPass(parsed.handle);
      case 'exit': return [{ type: 'exit' }];
      case 'say': return this.post({ kind: 'message', text: parsed.text, to: null });
      case 'targeted': return this.targeted(parsed);
      // #499 (room-verb parity)
      case 'for': return this.filedFor(parsed.section, parsed.line);
      case 'none': return [info(msg.noneHint)];
      case 'sections': return parsed.open || parsed.remove ? this.writeSections(parsed.open ?? null, parsed.remove ?? null) : this.viewSections();
      case 'orient': return this.viewOrientation();
      case 'canon': return this.viewCanon(parsed.section ?? null);
      case 'verify': return this.verifyFeed();
      case 'receipts': return this.viewReceipts(parsed.token ?? null);
      case 'pin': return this.pin(parsed.token, parsed.section, parsed.text ?? null);
      case 'review': return this.review(parsed.verdict, parsed.token ?? null, parsed.text ?? null);
    }
  }

  // ── :for (#499 gap 2): the section modifier ────────────────────────────────

  /**
   * `:for <section> <line>`: the rest re-parses as a whole line and every post it
   * makes carries `for`. The section is checked against the published map when
   * there is one (the server would refuse a proposal naming an unknown section;
   * the console refuses every post the same way, before anything is sent).
   */
  private async filedFor(section: string, line: string): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    const handles = this.sectionHandles();
    if (handles.length > 0 && !handles.includes(section)) return [error(msg.forUnknownSection(section, handles))];
    const inner = parseLine(line);
    if (inner.kind === 'for') return [error(msg.forUsage)];
    this.forSection = section;
    try {
      return await this.dispatch(inner);
    } finally {
      this.forSection = null;
    }
  }

  // ── help ─────────────────────────────────────────────────────────────────

  private help(topic?: string): ConsoleEvent {
    if (!topic) {
      const lines: string[] = [msg.helpHeader, ''];
      for (const group of helpListing) {
        lines.push(group.group);
        for (const l of group.lines) lines.push(`  ${l}`);
        lines.push('');
      }
      lines.push(msg.helpAllNote);
      return { type: 'help', lines };
    }
    // Family-scoped help (`:list help`) and single-verb help share the same rows.
    if (topic === 'list') {
      return { type: 'help', lines: [verbHelp.list, '  :list projects  every project the chair sees', '  :list endpoints  all endpoints, or the set project\'s', '  :list seats  the roster: handle, byline, liveness (:list roster is the same)', '  :list decisions  the decision ledger: every flagged proposal with its derived state'] };
    }
    const entry = verbHelp[topic];
    if (!entry) return { type: 'help', lines: [msg.helpUnknownTopic(topic)] };
    return { type: 'help', lines: [entry] };
  }

  // ── context verbs ────────────────────────────────────────────────────────

  private async listProjects(): Promise<ConsoleEvent[]> {
    const rows = await this.api.listProjects();
    if (rows.length === 0) return [error(msg.noProjects)];
    return [{ type: 'projects', rows }];
  }

  /** Every endpoint on the account (#499 gap 15): the widened search space. */
  private async allEndpoints(): Promise<Array<RoomEndpoint & { projectSlug: string }>> {
    const out: Array<RoomEndpoint & { projectSlug: string }> = [];
    for (const p of await this.api.listProjects()) {
      for (const e of await this.api.listEndpoints(p.id)) out.push({ ...e, projectSlug: p.slug });
    }
    return out;
  }

  /**
   * The room map (#499 gap 1/4), best effort: a server without the sections read
   * (404) or a room never oriented leaves it null and nothing else changes.
   */
  private async refreshRoomMap(): Promise<void> {
    if (!this.room) return;
    try {
      this.roomMap = await this.api.getRoomMap(this.room.project.id, this.room.endpoint.id);
    } catch {
      this.roomMap = null;
    }
  }

  private async scopedEndpoints(): Promise<Array<RoomEndpoint & { projectSlug: string }>> {
    const projects = this.project ? [this.project] : await this.api.listProjects();
    const out: Array<RoomEndpoint & { projectSlug: string }> = [];
    for (const p of projects) {
      const endpoints = await this.api.listEndpoints(p.id);
      for (const e of endpoints) out.push({ ...e, projectSlug: p.slug });
    }
    return out;
  }

  private async listEndpoints(): Promise<ConsoleEvent[]> {
    const endpoints = await this.scopedEndpoints();
    if (endpoints.length === 0) return [error(msg.noEndpoints(this.project?.slug ?? null))];
    return [{ type: 'endpoints', rows: endpoints.map((e) => ({ projectSlug: e.projectSlug, slug: e.slug, name: e.name })) }];
  }

  private async listSeats(): Promise<ConsoleEvent[]> {
    if (this.room) {
      await this.refreshRoster();
      await this.refreshRoomMap();
      return [this.rosterEvent(this.roster, this.room.endpointSlug, this.room.endpoint.id)];
    }
    // Unbound: aggregate the set scope (project, or everything) the same way.
    const endpoints = await this.scopedEndpoints();
    const rows: Array<RoomSeat & { endpointSlug: string; endpointId: string }> = [];
    for (const e of endpoints) {
      const seats = await this.api.listSeats(e.id);
      for (const s of seats) rows.push({ ...s, endpointSlug: e.slug, endpointId: e.id });
    }
    if (rows.length === 0) return [info(msg.noSeats)];
    const assigned = assignHandles(
      sortSeats(rows.filter((r) => !isSeatDeleted(r.endpointId, r.inviteId))),
      this.reservedAddresses(),
    );
    return [
      {
        type: 'roster',
        rows: assigned.map((s, i) => ({
          handle: s.handle,
          guestName: s.guestName,
          status: s.status,
          live: s.status === 'accepted',
          held: false, // holds are room-session state; unbound aggregates have none
          greyed: this.seatGreyed(s),
          presence: this.seatPresence(s),
          color: getSeatView(s.endpointId, s.handle).color ?? this.paletteDefault(i),
          hidden: getSeatView(s.endpointId, s.handle).hidden === true,
          endpointSlug: s.endpointSlug,
          role: null,
        })),
      },
    ];
  }

  /** The map's role for a minted handle, null when the map does not name it. */
  private mapRole(handle: string): string | null {
    return this.roomMap?.roster.find((r) => r.handle === handle)?.handle === handle
      ? (this.roomMap?.roster.find((r) => r.handle === handle)?.role ?? null)
      : null;
  }

  /**
   * #499 gap 4: the room map's handles that hold no minted seat (the chair, the
   * host, hosted routines, or every handle on an unsigned room where no seat can
   * exist). They render as roster rows wearing the role word for a status.
   */
  private mapOnlyHandles(): Array<{ handle: string; role: string }> {
    if (!this.roomMap) return [];
    const minted = new Set(this.roster.flatMap((s) => [s.handle, handleBase(s.guestName)]));
    return this.roomMap.roster.filter((r) => !minted.has(r.handle));
  }

  /**
   * :list decisions (#295): the room's derived decision ledger. A VIEW over the
   * log (G4) - the same proposals map every record act and every backfill row
   * already maintains - so listing it stores nothing and can never disagree
   * with the feed.
   */
  private listDecisions(): ConsoleEvent[] {
    if (!this.room) return [error(msg.unbound)];
    if (this.proposals.size === 0) return [info(msg.noDecisions)];
    return [this.decisionsEvent()];
  }

  /**
   * The ledger as an event (#295): every proposal ever flagged, chronological
   * (the map keeps first-observed order), states read off the derived view.
   * ratifiedBy names the latest ruling the log carried for a ratified row; a
   * console-side ratify that has not echoed back yet has no ruling id to name.
   */
  private decisionsEvent(): ConsoleEvent {
    const rulings = new Map<string, string>();
    for (const [rulingId, proposalId] of this.ratifications) rulings.set(proposalId, rulingId);
    return {
      type: 'decisions',
      rows: [...this.proposals.entries()].map(([id, rec]) => ({
        id,
        ref: id.slice(0, RECORD_REF_CHARS),
        state: rec.state === 'pending' ? ('needs-ratification' as const) : rec.state,
        summary: rec.summary ?? rec.preview,
        ratifiedBy:
          rec.state === 'ratified' && rulings.has(id) ? rulings.get(id)!.slice(0, RECORD_REF_CHARS) : null,
        settledAt: rec.settledAt,
        verdict: rec.verdict,
      })),
    };
  }

  /**
   * The post-mortem grey (#267/#266): revoked, expired, and departed seats stay
   * ON the surfaces, muted, until the chair deletes them. Greyed is a rendering
   * fact, not a state machine - the status or presence word still says which
   * post-mortem state it is.
   */
  private seatGreyed(seat: { status: string; handle: string }): boolean {
    return seat.status === 'revoked' || seat.status === 'expired' || this.departed.has(seat.handle);
  }

  /**
   * Presence truth (#266): departed (fp:bye) outranks the transport ledger;
   * live/idle/adrift come from the ledger when this console has one; null
   * otherwise - and null on any seat that is not accepted, where the invite
   * status word already tells the truth.
   */
  private seatPresence(seat: { status: string; guestName: string; handle: string }): 'live' | 'idle' | 'adrift' | 'departed' | null {
    if (seat.status !== 'accepted') return null;
    if (this.departed.has(seat.handle)) return 'departed';
    return this.presence ? this.presence.stateFor(seat.guestName) : null;
  }

  private rosterEvent(roster: RosterEntry[], endpointSlug: string, endpointId: string): ConsoleEvent {
    const mapOnly = this.mapOnlyHandles();
    if (roster.length === 0 && mapOnly.length === 0) return info(msg.noSeats);
    return {
      type: 'roster',
      rows: [
        ...roster.map((s, i) => ({
          handle: s.handle,
          guestName: s.guestName,
          status: s.status,
          live: s.status === 'accepted',
          held: this.held.has(s.handle),
          greyed: this.seatGreyed(s),
          presence: this.seatPresence(s),
          color: getSeatView(endpointId, s.handle).color ?? this.paletteDefault(i),
          hidden: getSeatView(endpointId, s.handle).hidden === true,
          endpointSlug,
          role: this.mapRole(s.handle),
        })),
        // Map-only handles (#499 gap 4): no seat, so the status IS the role word.
        ...mapOnly.map((r, i) => ({
          handle: r.handle,
          guestName: r.handle,
          status: r.role,
          live: false,
          held: false,
          greyed: false,
          presence: null,
          color: getSeatView(endpointId, r.handle).color ?? this.paletteDefault(roster.length + i),
          hidden: getSeatView(endpointId, r.handle).hidden === true,
          endpointSlug,
          role: r.role,
        })),
      ],
    };
  }

  private async setProject(slug: string): Promise<ConsoleEvent[]> {
    const projects = await this.api.listProjects();
    const match = projects.find((p) => p.slug === slug);
    if (!match) return [error(msg.unknownProject(slug))];
    const events: ConsoleEvent[] = [];
    if (this.room && this.room.project.id !== match.id) {
      this.room = null;
      this.roster = [];
      this.cursor = null;
      this.feedPrimed = false;
      this.clearRoomState();
      events.push(info(msg.projectCleared));
      events.push(this.roomEvent());
    }
    this.project = match;
    events.push(info(msg.projectSet(slug)));
    return events;
  }

  /**
   * Both halves in one act. The project must land first - a bad project slug stops
   * here rather than reporting a confusing "no endpoint with slug <project>", which
   * is exactly the trail a chair leaves when the two-slug form is refused (08-14).
   */
  private async bindRoom(projectSlug: string, endpointSlug: string): Promise<ConsoleEvent[]> {
    const projectEvents = await this.setProject(projectSlug);
    if (projectEvents.some((e) => e.type === 'error')) return projectEvents;
    const endpointEvents = await this.setEndpoint(endpointSlug);
    // The project half already landed. On an endpoint miss the console is somewhere
    // the chair did not ask to be, so the state gets said out loud rather than left
    // for them to discover from the next command's scope.
    if (endpointEvents.some((e) => e.type === 'error')) {
      return [...endpointEvents, info(msg.bindProjectKept(projectSlug))];
    }
    return [...projectEvents, ...endpointEvents];
  }

  /**
   * #499 gap 15 (agreed by Gene 2026-09-23): the room by partial name, across
   * every project. Resolution order: exact slug in the set project; exact slug in
   * any project; unique prefix of slug or name in any project; unique substring.
   * Several candidates list in the form :set takes back; `!` takes the first.
   */
  /**
   * Write the room map (#499 gap 17): open a topic, redescribe one, or close one.
   * The chair could read the map here since gap 4 but had to leave the console to
   * change it, which made opening a topic a trip through MCP. The seats' guard is
   * untouched: they still refuse anything not on the map, so this moves the map,
   * never the rule.
   *
   * The server takes the map WHOLE, so this is read-modify-write off the copy the
   * bind already fetched; `stateOnly` keeps the orientation lock where it is.
   */
  private async writeSections(
    open: { handle: string; description: string } | null,
    remove: string | null,
  ): Promise<ConsoleEvent[]> {
    // Unreachable in practice (the unbound guard answers first), kept so a future
    // caller cannot write the map with no room bound.
    if (!this.room) return [error(msg.unbound)];
    await this.refreshRoomMap();
    const current = this.roomMap?.sections ?? [];
    let next: RoomSection[];
    let done: ConsoleEvent;
    if (remove) {
      if (!current.some((x) => x.handle === remove)) {
        return [error(msg.sectionUnknown(remove, current.map((x) => x.handle)))];
      }
      next = current.filter((x) => x.handle !== remove);
      done = info(msg.sectionClosed(remove));
    } else if (open) {
      const existing = current.some((x) => x.handle === open.handle);
      next = existing
        ? current.map((x) => (x.handle === open.handle ? { ...x, description: open.description } : x))
        : [...current, { handle: open.handle, description: open.description }];
      done = info(existing ? msg.sectionRedescribed(open.handle) : msg.sectionOpened(open.handle));
    } else {
      return [error(msg.sectionsUsage)];
    }
    try {
      await this.api.setSections(this.room.project.id, this.room.endpoint.id, next);
    } catch (e) {
      // Owner-only on the server, so a seat or member answers 404: a whose-act
      // answer, not a missing room. Everything else goes through the #245 map,
      // which is where the read-only wall is said in the chair's own terms. The
      // raw server text there is written for an agent that cannot widen its own
      // grant, and in this console the reader IS the user it tells you to ask.
      if (e instanceof AuthApiError) {
        return [error(e.status === 404 ? msg.sectionsNotYours : this.httpErrorText(e))];
      }
      const text = e instanceof Error ? e.message : String(e);
      return [error(/404|not found/i.test(text) ? msg.sectionsNotYours : text)];
    }
    await this.refreshRoomMap();
    // Say what stands now, not just what changed: the map is small and the chair
    // is about to post against it.
    return [done, ...(await this.viewSections())];
  }

  private async setEndpoint(slug: string, force = false): Promise<ConsoleEvent[]> {
    const wanted = slug.toLowerCase();
    const scoped = await this.scopedEndpoints();
    let candidates = scoped.filter((e) => e.slug === slug);
    let widened = false;
    if (candidates.length === 0 && this.project) {
      // Exact slug anywhere: the set project is a default, never a wall.
      const all = await this.allEndpoints();
      candidates = all.filter((e) => e.slug === slug);
      widened = candidates.length > 0;
    }
    if (candidates.length === 0) {
      const all = this.project ? await this.allEndpoints() : scoped;
      const lower = (e: RoomEndpoint) => ({ slug: e.slug.toLowerCase(), name: (e.name ?? '').toLowerCase() });
      // A slug match outranks a name match at each step, so `!` and the listing
      // order both prefer the room whose address was typed.
      const bySlugFirst = (test: (l: { slug: string; name: string }) => boolean, testName: (l: { slug: string; name: string }) => boolean) => [
        ...all.filter((e) => test(lower(e))),
        ...all.filter((e) => !test(lower(e)) && testName(lower(e))),
      ];
      const prefix = bySlugFirst((l) => l.slug.startsWith(wanted), (l) => l.name.startsWith(wanted));
      candidates = prefix.length > 0
        ? prefix
        : bySlugFirst((l) => l.slug.includes(wanted), (l) => l.name.includes(wanted));
      widened = candidates.length > 0;
    }
    if (candidates.length === 0) {
      // A PROJECT slug here is the trail a chair leaves reaching for the whole
      // room at once; point at the form that does that instead of repeating no.
      const projects = await this.api.listProjects();
      if (projects.some((p) => p.slug === slug)) return [error(msg.endpointSlugIsProject(slug))];
      return [error(this.project ? msg.unknownEndpointInProject(slug, this.project.slug) : msg.unknownEndpoint(slug))];
    }
    if (candidates.length > 1 && !force) {
      return [
        info(msg.endpointCandidatesHeader(slug, candidates.length)),
        ...candidates.map((e) => info(msg.endpointCandidateRow(e.projectSlug, e.slug, e.name))),
      ];
    }
    const endpoint = candidates[0];
    const matchNote = widened || candidates.length > 1 ? [info(msg.endpointMatchedBy(slug, endpoint.projectSlug, endpoint.slug))] : [];
    if (!this.project || this.project.id !== endpoint.projectId) {
      const projects = await this.api.listProjects();
      this.project = projects.find((p) => p.id === endpoint.projectId) ?? this.project;
    }
    const detail = await this.api.getEndpointDetail(endpoint.projectId, endpoint.id);
    this.room = {
      project: this.project as RoomProject,
      endpoint,
      endpointSlug: detail.slug || endpoint.slug,
      signingEnabled: detail.signingEnabled,
      signingHeader: detail.signingHeader,
    };
    this.cursor = null;
    this.feedPrimed = false;
    this.clearRoomState();
    await this.refreshRoster();
    await this.refreshRoomMap();
    const events: ConsoleEvent[] = [...matchNote, info(msg.bound(this.room.project.slug, this.room.endpointSlug, this.roster.length))];
    events.push(this.roomEvent());
    // #499 gap 8: the map's chair handle is the byline when no :me name is set.
    const chair = this.mapChairHandle();
    if (chair && this.profile().name === null) events.push(info(msg.postingAsChair(chair)));
    if (this.room.signingEnabled && !this.api.hasSigningKey(endpoint.id)) {
      events.push(error(msg.noSigningKey));
    }
    // The ledger is room state (#295): a fresh bind says so out loud - empty -
    // so no frontend's decisions panel outlives the room it belonged to.
    events.push(this.decisionsEvent());
    return events;
  }

  // ── :create (#242: context-class WRITE verb - API act, feed receipt, no post) ─

  /**
   * :create endpoint <slug>, BORN SIGNED (ratified): the endpoint is created and
   * inbound HMAC signing enabled in the same act, before the first capture can
   * exist - rooms only make sense signed. Two API calls; a signing failure
   * renders an honest partial receipt (the endpoint exists, the room is not born
   * signed yet), never a false claim.
   */
  private async createEndpoint(slug: string): Promise<ConsoleEvent[]> {
    if (!this.project) return [error(msg.createNeedsProject)];
    const created = await this.api.createEndpoint(this.project.id, slug, slug);
    try {
      await this.api.enableSigning(this.project.id, created.id);
    } catch (err) {
      const detail = err instanceof AuthApiError ? this.httpErrorText(err) : err instanceof Error ? err.message : String(err);
      return [error(msg.endpointCreatedSigningFailed(created.slug, detail))];
    }
    return [info(msg.endpointCreatedBornSigned(created.slug)), info(msg.endpointCreatedNext(created.slug, created.captureUrlPath))];
  }

  // ── :me (#247: the identity family - byline and own color, console local) ──

  private me(cmd: Extract<ParsedLine, { kind: 'me' }>): ConsoleEvent[] {
    switch (cmd.action) {
      case 'show':
        return [info(msg.meShow(this.fromName(), this.profile().color))];
      case 'name':
        return this.meName(cmd.value, false);
      case 'color':
        return this.meColor(cmd.value, false);
      case 'auto': {
        // The split's tie-breaker (#269): one token that names a known color reads
        // as a color, anything else is the byline - and the reply says which
        // reading was taken (the chair became 'purple' once while seeking a color).
        const trimmed = cmd.value.trim();
        const isColor = !/\s/.test(trimmed) && (ALL_CONSOLE_COLORS as readonly string[]).includes(trimmed.toLowerCase());
        return isColor ? this.meColor(trimmed, true) : this.meName(cmd.value, true);
      }
    }
  }

  /** Set the byline; `auto` appends the which-reading note (#269). */
  private meName(value: string, auto: boolean): ConsoleEvent[] {
    // Same validation family as the identity ask: normalize through the
    // handle alphabet, refuse reserved words and the verb namespaces.
    const name = participantAccountName(value);
    if (name.length === 0 || RESERVED_WORDS.has(name) || /^(?:fp:|r:)/.test(name)) {
      return [error(msg.meNameInvalid(value))];
    }
    putChairProfile({ name });
    this.profileCache = undefined;
    const events = [info(msg.meNamed(name))];
    if (auto) events.push(info(msg.meReadAsName(value)));
    return events;
  }

  /** Set the chair's own color; `auto` appends the which-reading note (#269). */
  private meColor(value: string, auto: boolean): ConsoleEvent[] {
    const check = this.checkColor(value);
    if (check) return [check];
    const color = value.toLowerCase() as ConsoleColor;
    putChairProfile({ color });
    this.profileCache = undefined;
    const events = [info(msg.meColored(color))];
    if (auto) events.push(info(msg.meReadAsColor(color)));
    return events;
  }

  /**
   * Gate a NEW color choice on the palette in effect: a real extended name on a
   * 16-color terminal gets the capability line, anything else the palette line.
   */
  private checkColor(raw: string): ConsoleEvent | null {
    const color = raw.toLowerCase();
    if ((this.palette as readonly string[]).includes(color)) return null;
    if ((ALL_CONSOLE_COLORS as readonly string[]).includes(color)) return error(msg.colorNotSupported(color));
    return error(msg.unknownColor(raw, [...this.palette]));
  }

  // ── :collection / :tag (#251: curation from the chair, API acts + receipts) ─

  /**
   * :collection <name>: bind an existing collection for the session, or note the
   * name for creation. The server refuses an EMPTY collection, so a fresh name
   * is created lazily with the first :tag into it - the receipt says so honestly.
   */
  private async bindCollection(name: string): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    const existing = await this.findCollection(name);
    if (existing) {
      this.collections.set(existing.name, existing.id);
      return [info(msg.collectionBound(existing.name, existing.itemCount))];
    }
    this.collections.set(name, null);
    return [info(msg.collectionPending(name))];
  }

  /** Case-insensitive server lookup; the server's casing wins for the session key. */
  private async findCollection(name: string): Promise<RoomCollection | null> {
    if (!this.room) return null;
    const rows = await this.api.listCollections(this.room.project.id, this.room.endpoint.id);
    return rows.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  /**
   * Resolve a typed capture-id token against the cached feed (#259): an exact
   * id wins outright; at or above the floor an unambiguous prefix resolves like
   * a short git hash; an ambiguous one is refused with the collision count. A
   * token matching nothing passes through verbatim - the server may still know
   * a capture this session's feed never showed.
   */
  private resolveCaptureId(token: string): { id: string } | { error: ConsoleEvent } {
    if (this.feedIds.has(token)) return { id: token };
    if (token.length >= CAPTURE_ID_PREFIX_FLOOR) {
      const matches = [...this.feedIds].filter((id) => id.startsWith(token));
      if (matches.length === 1) return { id: matches[0] };
      if (matches.length > 1) return { error: error(msg.captureIdAmbiguous(token, matches.length)) };
    }
    return { id: token };
  }

  /** :tag <id> <collection>, or bare :tag <id> for the numbered picker. */
  private async tag(captureId: string, collectionName: string | null): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    const resolved = this.resolveCaptureId(captureId);
    if ('error' in resolved) return [resolved.error];
    captureId = resolved.id;
    if (collectionName) return this.performTag(captureId, collectionName);
    // The picker (ratified: curation never requires remembering names): this
    // session's known collections plus the server's, numbered, create by typing.
    const options = new Map<string, string | null>(this.collections);
    for (const c of await this.api.listCollections(this.room.project.id, this.room.endpoint.id)) {
      options.set(c.name, c.id);
    }
    const rows = [...options.entries()].map(([name, id]) => ({ name, id }));
    this.pendingTag = { captureId, options: rows };
    const lines = [
      msg.tagPickerHeader(captureId),
      ...rows.map((r, i) => msg.tagPickerRow(i + 1, r.name, r.id === null)),
      msg.tagPickerPrompt,
    ];
    return [{ type: 'ask', text: lines.join('\n') }];
  }

  /** The picker's answer: empty cancels, a listed number picks, anything else is a name. */
  private async answerTagPicker(
    line: string,
    pending: { captureId: string; options: Array<{ name: string; id: string | null }> },
  ): Promise<ConsoleEvent[]> {
    const answer = line.trim();
    if (answer.length === 0) return [info(msg.tagPickerCancelled)];
    const n = /^\d+$/.test(answer) ? Number(answer) : NaN;
    if (Number.isInteger(n) && n >= 1 && n <= pending.options.length) {
      return this.performTag(pending.captureId, pending.options[n - 1].name);
    }
    return this.performTag(pending.captureId, answer);
  }

  /** Resolve the collection (session, then server, then create-with-this-capture) and pin. */
  private async performTag(captureId: string, collectionName: string): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    const known = this.collections.get(collectionName);
    let id = known ?? null;
    if (id === null && known === undefined) {
      const existing = await this.findCollection(collectionName);
      if (existing) {
        id = existing.id;
        collectionName = existing.name;
        this.collections.set(existing.name, existing.id);
      }
    }
    if (id === null) {
      // Fresh (or pending) name: creation IS the first tag - the server refuses
      // empty collections, so the capture rides the create call.
      const created = await this.api.createCollection(this.room.project.id, this.room.endpoint.id, collectionName, [captureId]);
      this.collections.set(created.name, created.id);
      return [info(msg.collectionCreated(created.name)), info(msg.tagged(captureId, created.name))];
    }
    const { addedCount } = await this.api.addToCollection(this.room.project.id, this.room.endpoint.id, id, [captureId]);
    if (addedCount === 0) return [info(msg.alreadyTagged(captureId, collectionName))];
    return [info(msg.tagged(captureId, collectionName))];
  }

  // ── record control (#281: the ratify family; the queue is a view over the log) ─

  /** The pending queue (G4), chronological: flagged posts minus those dispositioned. */
  private pendingProposalIds(): string[] {
    return [...this.proposals.entries()].filter(([, r]) => r.state === 'pending').map(([id]) => id);
  }

  /** A picker row's preview, cut to the ruled width. */
  private proposalPreview(id: string): string | null {
    const rec = this.proposals.get(id);
    if (!rec) return null;
    const shown = rec.summary ?? rec.preview;
    return shown.length > 0 ? shown.slice(0, RECORD_SUMMARY_CHARS) : null;
  }

  /**
   * Resolve a wire `re` against the ids this feed has carried: exact match, then
   * a unique prefix at the git-style floor. Null when the log never showed it.
   */
  private resolveLogRef(token: string): string | null {
    if (this.feedIds.has(token)) return token;
    if (token.length >= CAPTURE_ID_PREFIX_FLOOR) {
      const matches = [...this.feedIds].filter((id) => id.startsWith(token));
      if (matches.length === 1) return matches[0];
    }
    return null;
  }

  /**
   * The pending-queue picker (G1 point 3): entries render [first 8 of the sign]
   * then the summary. The ruled UX is a tab-through; readline has no clean tab
   * cycling on a shared prompt, so this is the closest honest equivalent - the
   * :tag idiom, a numbered pick on the next line. Only a number acts; anything
   * else cancels, because a miskey must never gavel the wrong item.
   */
  private recordPicker(mode: 'ratify' | 'retract' | 're' | 'review', ids: string[], text: string | null, verdict?: string): ConsoleEvent[] {
    this.pendingRecordPick = { mode, ids, text, ...(verdict ? { verdict } : {}) };
    const lines = [
      mode === 'review' ? msg.reviewPickerHeader(verdict ?? 'review') : msg.recordPickerHeader(mode),
      ...ids.map((id, i) => msg.recordPickerRow(i + 1, id.slice(0, RECORD_REF_CHARS), this.proposalPreview(id) ?? '')),
      msg.recordPickerPrompt,
    ];
    return [{ type: 'ask', text: lines.join('\n') }];
  }

  /** The picked entry routes to the mode's act, the held prose riding along. */
  private async answerRecordPick(mode: 'ratify' | 'retract' | 're' | 'review', id: string, text: string | null, verdict?: string): Promise<ConsoleEvent[]> {
    if (mode === 'ratify') return this.performRatify(id, text, false);
    if (mode === 'retract') return this.performRetract(id, text);
    if (mode === 'review') return this.performReview(verdict ?? 'proceed', id, text);
    return this.performReply(id, text ?? '');
  }

  /**
   * :ratify (G1/G2 ruled): bare with items pending prompts to ratify them all;
   * bare with nothing pending renews the previous ratification (ratify-again
   * REPLACES; the chair's prose is the reading that stands); a roster handle
   * takes that seat's pending proposals; a feed reference is explicit.
   */
  private async ratify(token: string | null, text: string | null): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    const pending = this.pendingProposalIds();
    if (token !== null) {
      // G2: the handle form resolves to that seat's pending proposals.
      if (this.roster.some((s) => s.handle === token)) {
        const theirs = pending.filter((id) => this.proposals.get(id)?.handle === token);
        if (theirs.length === 0) return [info(msg.noPendingFrom(token))];
        if (theirs.length === 1) return this.performRatify(theirs[0], text, false);
        return this.recordPicker('ratify', theirs, text);
      }
      // An explicit reference. The gavel is sovereign: any post the feed has
      // carried can be ratified, flagged or not - but an id the log never
      // showed is refused, because a ruling must reference the record.
      const resolved = this.resolveCaptureId(token);
      if ('error' in resolved) return [resolved.error];
      if (!this.feedIds.has(resolved.id)) return [error(msg.unknownRecordRef(token))];
      return this.performRatify(resolved.id, text, false);
    }
    if (pending.length > 0) {
      this.pendingRatifyAll = { ids: pending };
      return [{ type: 'confirm', text: msg.confirmRatifyAll(pending.length) }];
    }
    if (this.lastRatification) return this.performRatify(this.lastRatification.proposalId, text, true);
    return [info(msg.nothingToRatify)];
  }

  /**
   * The ruling: a chair post carrying fp:ratify, re-linked to the ratified post.
   * The disposition is applied optimistically AND derived from the log's echo -
   * the same mutation keyed by the same ids, so the view stays a view (G4).
   */
  private async performRatify(proposalId: string, text: string | null, again: boolean): Promise<ConsoleEvent[]> {
    const ledgerBefore = this.ledgerVersion;
    // #499 gap 3: the gavel carries the proposal's section and addresses its
    // author, so the ruling files where the proposal was and wakes who made it.
    const facts = this.feedPosts.get(proposalId);
    const section = this.forSection ?? this.proposals.get(proposalId)?.section ?? facts?.section ?? null;
    const { events, ok } = await this.deliver({
      kind: 'message',
      to: this.authorAddress(proposalId),
      for: section,
      verb: 'fp:ratify',
      re: proposalId,
      ...(text ? { text } : {}),
    });
    if (!ok) return events;
    const rec = this.proposals.get(proposalId);
    if (rec && rec.state !== 'struck' && rec.state !== 'ratified') {
      rec.state = 'ratified';
      rec.settledAt = new Date().toISOString();
      this.ledgerVersion++;
    }
    this.lastRatification = { proposalId };
    const ref = proposalId.slice(0, RECORD_REF_CHARS);
    events.push(info(again ? msg.reRatified(ref, this.proposalPreview(proposalId)) : msg.ratified(ref, this.proposalPreview(proposalId))));
    // The canon swap (#499 gap 3): pin the ruling for its section and file the
    // receipt the canon derives from. The ruling is already on the record; a
    // failure here says so and never unwinds it.
    if (section) {
      try {
        events.push(...(await this.fileCanon(proposalId, section, text ?? rec?.summary ?? facts?.text ?? null)));
      } catch (err) {
        const detail = err instanceof AuthApiError ? this.httpErrorText(err) : err instanceof Error ? err.message : String(err);
        events.push(error(msg.ratifyCanonFailed(detail)));
      }
    } else if (this.sectionHandles().length > 0) {
      events.push(info(msg.ratifyNoSection(ref)));
    }
    if (this.ledgerVersion !== ledgerBefore) events.push(this.decisionsEvent());
    return events;
  }

  /**
   * Who to address a re-linked act to (#499 gap 10): the post's seat handle
   * when the signer holds a seat, else the wire from claim; null when the post
   * was the chair's own. The address comes from the post, not the roster, so an
   * unsigned author is reachable.
   */
  private authorAddress(postId: string): string | null {
    const facts = this.feedPosts.get(postId);
    if (!facts || facts.mine) return null;
    const from = facts.handle ?? facts.from;
    if (!from) return null;
    if (from.toLowerCase() === (this.chairAddress() ?? CHAIR_FROM).toLowerCase()) return null;
    if (from.toLowerCase() === this.fromName().toLowerCase()) return null;
    return from;
  }

  // ── the canon pin (#499 gap 3): pin plus the r:collate receipt ─────────────

  /** :pin <ref> <section> [recap]: file any post as what stands in a section. */
  private async pin(token: string, section: string, text: string | null): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    const handles = this.sectionHandles();
    if (handles.length > 0 && !handles.includes(section)) return [error(msg.canonUnknownSection(section, handles))];
    const resolved = this.resolveCaptureId(token);
    if ('error' in resolved) return [resolved.error];
    if (!this.feedIds.has(resolved.id)) return [error(msg.unknownRecordRef(token))];
    const facts = this.feedPosts.get(resolved.id);
    return this.fileCanon(resolved.id, section, text ?? facts?.summary ?? facts?.text ?? null);
  }

  /**
   * The canon swap, in the order the server derives it (#359): the ruling joins
   * the section's collection (the row's collection when one stands, else the
   * session-bound collection, else one named canon created on the spot); the
   * previous standing item leaves it; then the r:collate receipt posts, `to`
   * canon, `for` the section, args [section, collectionId, decisionId], re the
   * decision, text the recap. The canon read derives from the newest such
   * receipt and checks the pin, so both halves matter.
   */
  private async fileCanon(decisionId: string, section: string, recap: string | null): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    const events: ConsoleEvent[] = [];
    const projectId = this.room.project.id;
    const endpointId = this.room.endpoint.id;
    let standing: RoomCanonRow | null = null;
    let roomCollectionId: string | null = null;
    try {
      const canon = await this.api.getCanon(projectId, endpointId);
      standing = canon.sections.find((r) => r.sectionHandle === section) ?? null;
      // One canon collection per room is the convention (the launch kit's "Launch
      // kit"): a section with nothing standing files where the others already do.
      roomCollectionId = canon.sections.find((r) => r.collectionId !== null)?.collectionId ?? null;
    } catch {
      standing = null;
    }
    // Which collection: the standing row's, else the room's canon collection,
    // else the newest session-bound one with an id, else canon (created with
    // this capture as its first item).
    let collectionId = standing?.collectionId ?? roomCollectionId ?? null;
    let collectionName: string | null = null;
    if (collectionId === null) {
      for (const [name, id] of [...this.collections.entries()].reverse()) {
        if (id !== null) { collectionId = id; collectionName = name; break; }
      }
    }
    if (collectionId === null) {
      // A room with exactly ONE collection files into it (the launch-kit room's
      // "Launch kit" was pinned by hand, so no receipt names it yet); only a
      // room with none or several falls through to a collection named canon.
      const rows = await this.api.listCollections(projectId, endpointId);
      const existing = rows.length === 1 ? rows[0] : rows.find((c) => c.name.toLowerCase() === 'canon') ?? null;
      if (existing) {
        collectionId = existing.id;
        collectionName = existing.name;
        this.collections.set(existing.name, existing.id);
      } else {
        const created = await this.api.createCollection(projectId, endpointId, 'canon', [decisionId]);
        this.collections.set(created.name, created.id);
        collectionId = created.id;
        collectionName = created.name;
        events.push(info(msg.collectionCreated(created.name)));
      }
    }
    if (collectionName === null) {
      const rows = await this.api.listCollections(projectId, endpointId);
      collectionName = rows.find((c) => c.id === collectionId)?.name ?? collectionId;
    }
    await this.api.addToCollection(projectId, endpointId, collectionId, [decisionId]);
    const ref = decisionId.slice(0, RECORD_REF_CHARS);
    events.push(info(msg.pinned(ref, section, collectionName)));
    // What leaves the collection: the section's standing ruling when the canon
    // names one; else the post the proposal re-links to, which by the rooms'
    // convention IS the standing post it changes (the launch-kit room was
    // pinned by hand, so its canon names nothing and only the re knows).
    const facts = this.feedPosts.get(decisionId);
    const reTarget = facts?.re ? (this.resolveLogRef(facts.re) ?? (facts.re.length >= CAPTURE_ID_PREFIX_FLOOR ? facts.re : null)) : null;
    const previous = standing?.decisionCaptureId ?? reTarget;
    if (previous && previous !== decisionId && (standing?.decisionCaptureId === null || standing?.decisionCaptureId === undefined || standing.collectionId === collectionId)) {
      const { removedCount } = await this.api.removeFromCollection(projectId, endpointId, collectionId, [previous]);
      if (removedCount > 0) events.push(info(msg.pinReplaced(previous.slice(0, RECORD_REF_CHARS))));
    }
    const { events: receipt, ok } = await this.deliver({
      kind: 'message',
      to: 'canon',
      for: section,
      verb: 'r:collate',
      args: [section, collectionId, decisionId],
      re: decisionId,
      ...(recap ? { text: recap } : {}),
    });
    events.push(...receipt);
    if (ok) events.push(info(msg.collateFiled(section)));
    return events;
  }

  // ── review verdicts (#499 gap 5) ───────────────────────────────────────────

  /**
   * :proceed | :hold | :finding | :resolved | :satisfied [ref] [prose]: a verdict
   * on a proposal, short of the gavel. Wire form fp:review with a `verdict`
   * member, re-linked, addressed to the author, filed for the section. The
   * ledger keeps the latest verdict beside the pending row.
   */
  private async review(verdict: string, token: string | null, text: string | null): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    if (token !== null) {
      const resolved = this.resolveCaptureId(token);
      if ('error' in resolved) return [resolved.error];
      if (!this.feedIds.has(resolved.id)) return [error(msg.unknownRecordRef(token))];
      return this.performReview(verdict, resolved.id, text);
    }
    const pending = this.pendingProposalIds();
    if (pending.length === 0) return [info(msg.nothingPendingReview(verdict))];
    if (pending.length === 1) return this.performReview(verdict, pending[0], text);
    return this.recordPicker('review', pending, text, verdict);
  }

  private async performReview(verdict: string, postId: string, text: string | null): Promise<ConsoleEvent[]> {
    const ledgerBefore = this.ledgerVersion;
    const facts = this.feedPosts.get(postId);
    const { events, ok } = await this.deliver({
      kind: 'message',
      to: this.authorAddress(postId),
      for: this.forSection ?? this.proposals.get(postId)?.section ?? facts?.section ?? null,
      verb: 'fp:review',
      verdict,
      re: postId,
      ...(text ? { text } : {}),
    });
    if (!ok) return events;
    this.applyVerdict(postId, verdict);
    events.push(info(msg.reviewed(verdict, postId.slice(0, RECORD_REF_CHARS))));
    if (this.ledgerVersion !== ledgerBefore) events.push(this.decisionsEvent());
    return events;
  }

  /** The verdict mutation, shared by the console act and the log's derivation (idempotent). */
  private applyVerdict(postId: string, verdict: string): void {
    const rec = this.proposals.get(postId);
    if (!rec || rec.verdict === verdict) return;
    rec.verdict = verdict;
    this.ledgerVersion++;
  }

  // ── the read side (#499 gap 4) ─────────────────────────────────────────────

  private async viewSections(): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    await this.refreshRoomMap();
    const map = this.roomMap;
    if (!map || (map.sections.length === 0 && map.roster.length === 0)) return [info(msg.noSections)];
    return [{ type: 'view', title: msg.sectionsHeader, lines: this.mapLines(map) }];
  }

  private mapLines(map: RoomMap): string[] {
    const lines = map.sections.map((x) => msg.sectionRow(x.handle, x.description));
    if (map.roster.length > 0) {
      lines.push('', msg.rosterMapHeader, ...map.roster.map((r) => msg.rosterMapRow(r.handle, r.role)));
    }
    return lines.map(sanitizeWireLine);
  }

  private async viewOrientation(): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    await this.refreshRoomMap();
    const map = this.roomMap;
    if (!map?.orientationCaptureId) return [info(msg.noOrientation)];
    const raw = await this.api.getCaptureBody(this.room.endpoint.id, map.orientationCaptureId);
    let text = raw ?? '';
    try {
      const parsed = JSON.parse(raw ?? '') as { text?: unknown };
      if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') text = parsed.text;
    } catch {
      /* a non-JSON orientation renders raw */
    }
    const lines = sanitizeWireText(text).split('\n').map((l) => `  ${l}`);
    if (map.sections.length > 0 || map.roster.length > 0) lines.push('', ...this.mapLines(map));
    return [{ type: 'view', title: msg.orientationHeader(map.orientationCaptureId), lines }];
  }

  private async viewCanon(section: string | null): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    const canon = await this.api.getCanon(this.room.project.id, this.room.endpoint.id);
    if (section !== null) {
      const row = canon.sections.find((r) => r.sectionHandle === section);
      if (!row) return [error(msg.canonUnknownSection(section, canon.sections.map((r) => r.sectionHandle)))];
      const lines = [msg.canonRow(row.sectionHandle, row.decisionCaptureId?.slice(0, RECORD_REF_CHARS) ?? null, row.ratifiedAt, row.superseded)];
      if (row.recapText) lines.push(...sanitizeWireText(row.recapText).split('\n').map((l) => `    ${l}`));
      return [{ type: 'view', title: msg.canonHeader, lines: lines.map(sanitizeWireLine) }];
    }
    if (canon.sections.every((r) => r.recapText === null && r.decisionCaptureId === null)) return [info(msg.noCanon)];
    const lines = canon.sections.flatMap((row) => {
      const head = msg.canonRow(row.sectionHandle, row.decisionCaptureId?.slice(0, RECORD_REF_CHARS) ?? null, row.ratifiedAt, row.superseded);
      const recap = row.recapText ? sanitizeWireLine(row.recapText.split('\n')[0]).slice(0, RECORD_SUMMARY_CHARS) : null;
      return recap ? [head, `    ${recap}`] : [head];
    });
    return [{ type: 'view', title: msg.canonHeader, lines: lines.map(sanitizeWireLine) }];
  }

  // ── receipts and the chain (#499 gap 6) ────────────────────────────────────

  private async viewReceipts(token: string | null): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    let id: string;
    if (token === null) {
      if (!this.lastPosted) return [info(msg.noReceiptsTarget)];
      id = this.lastPosted;
    } else {
      const resolved = this.resolveCaptureId(token);
      if ('error' in resolved) return [resolved.error];
      id = resolved.id;
    }
    const rows = await this.api.listExecutions(this.room.endpoint.id, id);
    const ref = id.slice(0, RECORD_REF_CHARS);
    if (rows.length === 0) return [info(msg.noReceipts(ref))];
    return [{
      type: 'view',
      title: msg.receiptsHeader(ref),
      lines: rows.map((r) => sanitizeWireLine(msg.receiptRow(r.targetId, r.status, r.responseStatusCode, r.durationMs))),
    }];
  }

  /**
   * :verify: attribution over this session's feed (owner, seats, unsigned) and,
   * when the posts carry a prevHash pointer, the hash chain over them in feed
   * order, through the same verifyChain the catalog tool runs.
   */
  private verifyFeed(): ConsoleEvent[] {
    if (!this.room) return [error(msg.unbound)];
    if (this.feedPosts.size === 0) return [info(msg.verifyEmpty)];
    let owner = 0;
    let seats = 0;
    let unsigned = 0;
    const chained: Record<string, unknown>[] = [];
    for (const facts of this.feedPosts.values()) {
      if (facts.mine) owner++;
      else if (facts.signerLabel) seats++;
      else unsigned++;
      if (facts.body && typeof facts.body.prevHash === 'string') chained.push(facts.body);
    }
    const lines = [msg.verifyAttribution(owner, seats, unsigned, this.feedPosts.size)];
    if (chained.length === 0) {
      lines.push(msg.verifyNoChain);
    } else {
      const result = verifyChain(chained);
      lines.push(result.intact ? msg.verifyChainIntact(result.count) : msg.verifyChainBroken(result.brokenAt ?? 0));
    }
    return [{ type: 'view', title: 'Verify:', lines: lines.map((l) => `  ${l}`) }];
  }

  /**
   * :retract (G1 point 6, standing-rooms carry): null by explicit reference,
   * the same 8 character mechanism. A referenced PROPOSAL withdraws (out of the
   * queue without a ruling); a referenced RULING un-rules (its proposal is
   * pending again). Bare :retract offers the pending picker.
   */
  private async retract(token: string | null, text: string | null): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    if (token !== null) {
      const resolved = this.resolveCaptureId(token);
      if ('error' in resolved) return [resolved.error];
      if (!this.feedIds.has(resolved.id)) return [error(msg.unknownRecordRef(token))];
      return this.performRetract(resolved.id, text);
    }
    const pending = this.pendingProposalIds();
    if (pending.length === 0) return [info(msg.nothingPendingRetract)];
    if (pending.length === 1) return this.performRetract(pending[0], text);
    return this.recordPicker('retract', pending, text);
  }

  private async performRetract(refId: string, text: string | null): Promise<ConsoleEvent[]> {
    const ledgerBefore = this.ledgerVersion;
    const { events, ok } = await this.deliver({
      kind: 'message',
      to: null,
      verb: 'fp:retract',
      re: refId,
      ...(text ? { text } : {}),
    });
    if (!ok) return events;
    events.push(info(this.applyRetract(refId)));
    if (this.ledgerVersion !== ledgerBefore) events.push(this.decisionsEvent());
    return events;
  }

  /**
   * The retract disposition, shared by the console act and the log's derivation
   * (idempotent: both apply the same mutation). Returns the receipt line; the
   * feed derivation discards it.
   */
  private applyRetract(refId: string, settledAt = new Date().toISOString()): string {
    const ref = refId.slice(0, RECORD_REF_CHARS);
    const ruled = this.ratifications.get(refId);
    if (ruled !== undefined) {
      const rec = this.proposals.get(ruled);
      if (rec && rec.state === 'ratified') {
        rec.state = 'pending';
        rec.settledAt = null;
        this.ledgerVersion++;
      }
      if (this.lastRatification?.proposalId === ruled) this.lastRatification = null;
      return msg.rulingNulled(ref);
    }
    const rec = this.proposals.get(refId);
    // A struck row is beyond disposition (#295): the flag itself was unsaid.
    if (rec && rec.state !== 'struck') {
      rec.state = 'retracted';
      rec.settledAt = settledAt;
      this.ledgerVersion++;
      if (this.lastRatification?.proposalId === refId) this.lastRatification = null;
      return msg.retractedProposal(ref, this.proposalPreview(refId));
    }
    return msg.retractPosted(ref);
  }

  /**
   * :re (G1 point 7): the chair's middle move - reply WITHOUT disposition. A
   * plain content post with re set to the picked proposal (pure console sugar,
   * no verb); the item STAYS pending. Bare routing is scoped to the pending
   * queue; a leading token that resolves to ANY ledger decision is an explicit
   * pick (#295: the nvim panel arms dispositioned decisions as reply targets
   * through exactly this form).
   */
  private async replyPending(text: string): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    const pending = this.pendingProposalIds();
    const space = text.search(/\s/);
    if (space > 0) {
      const tok = text.slice(0, space);
      const rest = text.slice(space).trim();
      const resolved = this.resolveCaptureId(tok);
      // #499 gap 9/10: any post the feed carried is a reply target, not only a
      // proposal - the frontend arms a post header the same way it arms a decision.
      if (!('error' in resolved) && this.feedIds.has(resolved.id) && rest.length > 0) {
        return this.performReply(resolved.id, rest);
      }
    }
    if (pending.length === 0) return [info(msg.nothingPendingReply)];
    if (pending.length === 1) return this.performReply(pending[0], text);
    return this.recordPicker('re', pending, text);
  }

  private async performReply(proposalId: string, text: string): Promise<ConsoleEvent[]> {
    // The word gavel (#295, the manner ruling this sitting proved four times):
    // a reply whose text is EXACTLY one ratify-word performs the act on the
    // referenced decision instead of posting discussion - the chair answered a
    // proposal with the single word, and the seat treated manner as ruling.
    // STRICT guard: exact single word only, case-insensitive; any additional
    // words keep the ruled "plain re-linked reply is discussion" reading. Every
    // :re route funnels here, so the armed-selection form (:re <ref> <text>),
    // the typed explicit form, and the picker all gavel the same way. The
    // teaching echo names what happened before the act's own receipts.
    const word = text.trim();
    const lowered = word.toLowerCase();
    if (lowered === 'ratify' || lowered === 'ratified') {
      return [info(msg.wordGavelRatify(word)), ...(await this.performRatify(proposalId, null, false))];
    }
    if (lowered === 'retract' || lowered === 'retracted') {
      return [info(msg.wordGavelRetract(word)), ...(await this.performRetract(proposalId, null))];
    }
    // #499 gap 10: the reply addresses the post's author (the seat handle, else
    // the wire from claim), so a re-linked answer also wakes who asked.
    const { events, ok } = await this.deliver({
      kind: 'message',
      to: this.authorAddress(proposalId),
      for: this.forSection ?? this.proposals.get(proposalId)?.section ?? this.feedPosts.get(proposalId)?.section ?? null,
      re: proposalId,
      text,
    });
    if (!ok) return events;
    const ref = proposalId.slice(0, RECORD_REF_CHARS);
    // A pending item keeps its no-disposition receipt; a reply against an
    // already-dispositioned decision (#295: the armed panel target) must not
    // claim the item is pending when it is not.
    const state = this.proposals.get(proposalId)?.state;
    events.push(info(state === undefined || state === 'pending' ? msg.repliedStaysPending(ref) : msg.repliedRe(ref)));
    return events;
  }

  // ── scratch + strike (#282, G3: the family's other half) ───────────────────

  /**
   * :scratch, and the keystroke-leak catch: the post rides kind 'scratch' - the
   * out-of-band channel seats filter from orders. `implied` marks a bare line
   * that led with a command-shaped word; the receipt teaches instead of letting
   * a missed colon read as direction (the color purple contamination).
   */
  private async scratch(text: string, implied: boolean): Promise<ConsoleEvent[]> {
    const { events, ok } = await this.deliver({ kind: 'scratch', to: null, text });
    if (!ok) return events;
    events.push(info(implied ? msg.scratchLeakCaught(text.split(/\s+/)[0]) : msg.scratchPosted));
    return events;
  }

  /**
   * :strike <ref>: the propagating un-say. The wire form is fp:strike re-linked
   * to the struck post, so every seat reading the feed can apply it; the
   * console applies it optimistically and again from the log's echo.
   */
  private async strike(token: string, text: string | null): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    const resolved = this.resolveCaptureId(token);
    if ('error' in resolved) return [resolved.error];
    if (!this.feedIds.has(resolved.id)) return [error(msg.unknownRecordRef(token))];
    const ledgerBefore = this.ledgerVersion;
    const { events, ok } = await this.deliver({
      kind: 'message',
      to: null,
      verb: 'fp:strike',
      re: resolved.id,
      ...(text ? { text } : {}),
    });
    if (!ok) return events;
    events.push(info(this.applyStrike(resolved.id)));
    if (this.ledgerVersion !== ledgerBefore) events.push(this.decisionsEvent());
    return events;
  }

  /**
   * The strike disposition, shared by the console act and the log's derivation
   * (idempotent). A struck PROPOSAL leaves the pending queue entirely - the
   * flag itself was unsaid, not dispositioned - but its LEDGER row stays,
   * wearing the struck state (#295): struck means unsaid, not deleted, on the
   * ledger exactly as in the feed, and a re-delivered propose row can never
   * resurrect it into the queue. A struck RULING un-rules like a retract.
   */
  private applyStrike(id: string): string {
    this.struck.add(id);
    const ruled = this.ratifications.get(id);
    if (ruled !== undefined) {
      const rec = this.proposals.get(ruled);
      if (rec && rec.state === 'ratified') {
        rec.state = 'pending';
        rec.settledAt = null;
        this.ledgerVersion++;
      }
      if (this.lastRatification?.proposalId === ruled) this.lastRatification = null;
      this.ratifications.delete(id);
    } else {
      const rec = this.proposals.get(id);
      if (rec && rec.state !== 'struck') {
        rec.state = 'struck';
        this.ledgerVersion++;
      }
      if (this.lastRatification?.proposalId === id) this.lastRatification = null;
    }
    return msg.struckReceipt(id.slice(0, RECORD_REF_CHARS));
  }

  /** The chair's address in effect can never be claimed by a seat (§4: fixed at mint). */
  private reservedAddresses(): string[] {
    return [this.chairAddress() ?? CHAIR_FROM];
  }

  /** Session room state dies with the bind: holds, idles, feed history, and collections are per room. */
  private clearRoomState(): void {
    this.held.clear();
    this.idle.clear();
    this.feedSeen.clear();
    this.latestStanza.clear();
    this.feedIds.clear();
    this.collections.clear();
    this.departed.clear();
    this.pendingTag = null;
    this.proposals.clear();
    this.ratifications.clear();
    this.lastRatification = null;
    this.pendingRatifyAll = null;
    this.pendingRecordPick = null;
    this.struck.clear();
    this.feedPosts.clear();
    this.lastPosted = null;
    this.passes.clear();
    this.pendingReseat = null;
    this.roomMap = null;
  }

  /** Handles are assigned at bind over a stable sort, so a handle means one seat all session. */
  private async refreshRoster(): Promise<void> {
    if (!this.room) return;
    const endpointId = this.room.endpoint.id;
    // Deleted seats (#267) leave the assignment pool entirely: that is what frees
    // the display name for a fresh mint, no collision suffix.
    const seats = (await this.api.listSeats(endpointId)).filter((s) => !isSeatDeleted(endpointId, s.inviteId));
    this.roster = assignHandles(sortSeats(seats), this.reservedAddresses());
  }

  // ── stream verbs ─────────────────────────────────────────────────────────

  /**
   * The v1 writer (wire schema §1): canonical member order v, kind, from, to, verb,
   * args, re, panic, text; `v: 1` always stamped; the empty-string ban means an
   * empty member is OMITTED, never written as "" (absent-vs-present is a
   * load-bearing discriminator, §5: bare interrupt = hard stop). panic is only
   * ever written as true (§1 row 8); args ride only with a verb.
   */
  private buildBody(opts: {
    /** 'scratch' (#282) is the out-of-band channel: chair commentary, never direction. */
    kind: 'message' | 'whisper' | 'scratch';
    to: string | null;
    /** #499 gap 2: the section the post is about; the :for modifier fills it when absent. */
    for?: string | null;
    verb?: string;
    /** #499 gap 5: the review verdict word, only ever beside fp:review. */
    verdict?: string;
    args?: string[];
    re?: string;
    panic?: boolean;
    text?: string;
  }): string {
    const body: Record<string, unknown> = { v: 1, kind: opts.kind, from: this.fromName() };
    if (opts.to) body.to = opts.to;
    const section = opts.for ?? this.forSection;
    if (section) body.for = section;
    if (opts.verb) body.verb = opts.verb;
    if (opts.verb === 'fp:review' && opts.verdict) body.verdict = opts.verdict;
    if (opts.verb && opts.args && opts.args.length > 0) body.args = opts.args;
    if (opts.re) body.re = opts.re;
    if (opts.panic) body.panic = true;
    if (opts.text) body.text = opts.text;
    return JSON.stringify(body);
  }

  /** Deliver one signed post; callers that need the outcome (attention marks, relay) read ok. */
  private async deliver(opts: Parameters<ConsoleEngine['buildBody']>[0]): Promise<{ events: ConsoleEvent[]; ok: boolean }> {
    if (!this.room) return { events: [error(msg.unbound)], ok: false };
    const signed = this.api.hasSigningKey(this.room.endpoint.id);
    if (this.room.signingEnabled && !signed) return { events: [error(msg.noSigningKey)], ok: false };

    const delivery = await this.api.post({
      projectId: this.room.project.id,
      endpointId: this.room.endpoint.id,
      endpointSlug: this.room.endpointSlug,
      body: this.buildBody(opts),
      signingHeader: this.room.signingHeader,
    });

    if (delivery.httpStatus === 401) return { events: [error(msg.signingWall)], ok: false };
    if (delivery.httpStatus === 429) return { events: [error(msg.postThrottled)], ok: false };
    if (!delivery.ok) return { events: [error(msg.postFailed(delivery.httpStatus, delivery.errorText))], ok: false };
    const events: ConsoleEvent[] = [info(msg.posted(signed, delivery.captureId))];
    if (delivery.captureId) this.lastPosted = delivery.captureId;
    const section = opts.for ?? this.forSection;
    if (section) events.push(info(msg.postedFor(section)));
    // #284b: the receipt warns when to matches nobody's wire name. Warning only,
    // never a refusal - the post already landed on the shared stream.
    const missed = this.wireAddressMiss(opts.to);
    if (missed !== null) events.push(info(msg.toReachesNobody(missed)));
    // #499 gap 6: a standing binding fired off this post; the receipt says so.
    if (delivery.executions && delivery.executions.length > 0) events.push(info(msg.deliveredTo(delivery.executions.length)));
    return { events, ok: true };
  }

  /**
   * An outgoing `to` that matches nobody's WIRE name (#284b). Seats filter
   * arrivals by their participant name (and its normalized handle form) plus
   * all; a console-side collision suffix (editor-2) is a name the wire never
   * carries, so a post addressed to it lands in the log and in nobody's filter -
   * a seat named that way reached nobody for two sittings. The chair's own
   * address and byline pass: seats answer there.
   */
  private wireAddressMiss(to: string | null | undefined): string | null {
    if (!to || to === 'all' || to === 'canon') return null;
    const target = to.toLowerCase();
    // #499 gap 1: a handle the room map names is an address the room answers to
    // (a hosted routine woken by a binding on to, the chair, the host).
    if (this.roomMap?.roster.some((r) => r.handle.toLowerCase() === target)) return null;
    for (const seat of this.roster) {
      if (seat.guestName.toLowerCase() === target || handleBase(seat.guestName) === target) return null;
    }
    if (target === (this.chairAddress() ?? CHAIR_FROM).toLowerCase()) return null;
    if (target === this.fromName().toLowerCase()) return null;
    return to;
  }

  private async post(opts: Parameters<ConsoleEngine['buildBody']>[0]): Promise<ConsoleEvent[]> {
    return (await this.deliver(opts)).events;
  }

  private async mintSeat(guestName: string, force = false): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    // #284a: quote-strip and trim BEFORE anything else sees the name - a quoted
    // seat is unaddressable by the console grammar (the handle alphabet excludes
    // quotes), so the literal form must never reach the server.
    guestName = sanitizeGuestName(guestName);
    if (guestName.length === 0) return [error(msg.seatNameEmpty)];
    // Ruling 1: the FIRST :seat mint ever asks the chair for their wire address.
    // The engine emits the ask as an event; only the frontend touches readline.
    if (this.chairAddress() === null) {
      this.pendingIdentity = { guestName };
      return [{ type: 'ask', text: msg.identityAsk(CHAIR_FROM) }];
    }
    // #499 gap 16 (agreed by Gene 2026-09-23): a name that already holds a live
    // seat is a re-seat, never a suffixed twin. y/N, or ! to skip the ask: the
    // old seat is revoked, a fresh code minted under the same handle.
    await this.refreshRoster(); // the server's truth, not the roster as of the last poll
    const wire = handleBase(guestName);
    const live = this.roster.find(
      (s) => (s.status === 'accepted' || s.status === 'pending') && (handleBase(s.guestName) === wire || s.handle === wire),
    );
    if (live) {
      if (force) return this.performReseat(guestName, live.inviteId, live.handle);
      this.pendingReseat = { guestName, inviteId: live.inviteId, handle: live.handle };
      return [{ type: 'confirm', text: msg.confirmReseat(live.handle) }];
    }
    return this.performMint(guestName);
  }

  /** The re-seat (#499 gap 16): revoke, then mint under the same name; the new pass follows. */
  private async performReseat(guestName: string, inviteId: string, handle: string): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    await this.api.revokeInvite(this.room.endpoint.id, inviteId);
    // #267: the revoked row leaves the assignment pool so the fresh mint keeps
    // the handle instead of collision-suffixing beside its own corpse.
    putSeatDeleted(this.room.endpoint.id, inviteId);
    this.held.delete(handle);
    this.idle.delete(handle);
    this.departed.delete(handle);
    await this.refreshRoster();
    return [info(msg.reseated(handle)), ...(await this.performMint(guestName))];
  }

  /** :seat <handle> pass (#499 gap 16): the pass as minted this session, or where to get one. */
  private reprintPass(handle: string): ConsoleEvent[] {
    if (!this.room) return [error(msg.unbound)];
    const pass = this.passes.get(handle) ?? this.passes.get(handleBase(handle));
    if (!pass) return [error(msg.noPassFor(handle))];
    return [info(msg.passReprinted(handle)), pass];
  }

  /**
   * The answer to the identity ask: empty takes the offered default, anything else
   * normalizes through the handle alphabet. Reserved words and the fp:/r: verb
   * namespaces can never be the address (§1 charset law); a bad answer re-asks.
   */
  private async answerIdentity(line: string, guestName: string): Promise<ConsoleEvent[]> {
    const def = this.chairAddress() ?? CHAIR_FROM;
    const trimmed = line.trim();
    const name = trimmed.length === 0 ? def : participantAccountName(trimmed);
    if (RESERVED_WORDS.has(name) || /^(?:fp:|r:)/.test(name)) {
      this.pendingIdentity = { guestName };
      return [error(msg.identityInvalid(trimmed)), { type: 'ask', text: msg.identityAsk(def) }];
    }
    putChairIdentity(name);
    this.identityCache = name;
    return [info(msg.identitySeeded(name)), ...(await this.performMint(guestName))];
  }

  private async performMint(guestName: string): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    const chairAddress = this.chairAddress() ?? CHAIR_FROM;
    // LAZY START (#253, ratified over flag/always): the room server starts on the
    // FIRST :seat mint; a console that never mints never binds a port. A start
    // failure degrades to the standalone-flow pass rather than losing the mint.
    const events: ConsoleEvent[] = [];
    let seatServerUrl: string | null = null;
    if (this.host) {
      try {
        const room = await this.host.ensureStarted();
        seatServerUrl = room.url;
        if (room.started) events.push(info(msg.roomHosted(room.url)));
      } catch (err) {
        events.push(error(msg.roomStartFailed(err instanceof Error ? err.message : String(err))));
      }
    }
    const mint = await this.api.mintSeat(this.room.endpoint.id, guestName);
    await this.refreshRoster();
    // The console-side handle still rides the mint receipt (§8: the seat cannot
    // derive its collision suffix). Match by ref, falling back to the newest
    // same-name row.
    const seatRow =
      this.roster.find((s) => s.ref === mint.ref) ??
      [...this.roster].reverse().find((s) => s.guestName === guestName) ??
      null;
    // #284c: the pass carries the name the SERVER actually assigned, normalized
    // through the handle alphabet - never a console-side collision suffix. The
    // editor-2 pass against an editor assignment left a seat filtering for a
    // name the wire never carried, for two sittings.
    const wireName = handleBase(mint.participantName);
    const handle = seatRow?.handle ?? wireName;
    const codeMinutes = Math.max(1, Math.round((new Date(mint.codeExpiresAt).getTime() - Date.now()) / 60_000));
    // The code renders IN THE FEED with the ferry warning, mirroring `flurryport seat`;
    // the pass itself is the paste-ready ferry payload (#244), carrying the
    // in-process room URL when this console hosts the room (#253).
    const pairing: Extract<ConsoleEvent, { type: 'pairing' }> = {
      type: 'pairing',
      code: mint.pairingCode,
      chairLines: [
        msg.seatMinted(mint.participantName, mint.ref, handle),
        ...(handle === wireName ? [] : [msg.seatHandleDiffers(handle, wireName)]),
        msg.ferryWarning(codeMinutes),
        ...(mint.seatLink ? [msg.seatWebLink(mint.seatLink)] : []),
        msg.seatEnds(new Date(mint.expiresAt).toISOString()),
        msg.boardingPassHeader,
      ],
      passLines: msg.boardingPass({
        code: mint.pairingCode,
        handle: wireName,
        consoleHandle: handle,
        chairAddress,
        seatServerUrl,
        room: this.room ? `${this.room.project.slug}/${this.room.endpointSlug}` : undefined,
      }),
    };
    this.passes.set(handle, pairing);
    events.push(pairing);
    return events;
  }

  private async targeted(cmd: Extract<ParsedLine, { kind: 'targeted' }>): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];

    // Verb-first forgiveness (#277): the parser's auto-swap is honored only when
    // the handle is on the live roster; otherwise the line answers exactly what
    // it answered before the swap existed, the verb_needs_target usage error.
    // The echo teaches the canonical spelling before the act's own receipts.
    if (cmd.verbFirst !== undefined) {
      if (!this.roster.some((s) => s.handle === cmd.target)) {
        // #499 gap 5: bare `:hold <ref>` is the review verdict when the token is
        // a post this feed carried, never a seat.
        if (cmd.verb === 'hold' && !cmd.all) {
          const resolved = this.resolveCaptureId(cmd.target);
          if (!('error' in resolved) && this.feedIds.has(resolved.id)) {
            return this.performReview('hold', resolved.id, cmd.text ?? null);
          }
        }
        return [error(msg.verbNeedsTarget(cmd.verb))];
      }
      const swapped: Extract<ParsedLine, { kind: 'targeted' }> = { ...cmd };
      delete swapped.verbFirst;
      return [info(msg.verbFirstEcho(cmd.verbFirst)), ...(await this.targeted(swapped))];
    }

    const targets = cmd.all
      ? this.roster.map((s) => s.handle)
      : this.roster.some((s) => s.handle === cmd.target)
        ? [cmd.target]
        : null;
    if (!targets) {
      // #499 gap 1/12: a handle the room map names, or on an unsigned room the
      // name as typed, is an address for a mention or a whisper. The other verbs
      // (hold, status, revoke, ...) still need a minted seat.
      if (cmd.verb === 'mention' || cmd.verb === 'whisper') {
        const mapped = this.roomMap?.roster.some((r) => r.handle === cmd.target) === true;
        const typed = !mapped && !this.room.signingEnabled;
        if (mapped || typed) {
          const { events, ok } = await this.deliver({
            kind: cmd.verb === 'whisper' ? 'whisper' : 'message',
            text: cmd.text ?? '',
            to: cmd.target,
          });
          if (ok && typed) events.push(info(msg.typedAddress(cmd.target)));
          return events;
        }
        return [error(this.roomMap ? msg.unknownAddress(cmd.target) : msg.unknownHandle(cmd.target))];
      }
      return [error(msg.unknownHandle(cmd.target))];
    }
    if (cmd.all && targets.length === 0) return [info(msg.noSeats)];

    switch (cmd.verb) {
      case 'mention': {
        // Ruled 2: a plain mention at a HELD seat resolves at the console - the wire
        // carries fp:interrupt + text (redirect-release), and the hold ends here.
        if (!cmd.all && this.held.has(cmd.target)) {
          return this.interruptAct([cmd.target], false, cmd.text ?? '', false, true);
        }
        const { events, ok } = await this.deliver({ kind: 'message', text: cmd.text ?? '', to: cmd.all ? 'all' : cmd.target });
        // Fresh orders end an idle (post-hard-stop) mark.
        if (ok) for (const h of targets) this.idle.delete(h);
        return events;
      }
      case 'whisper':
        return this.post({ kind: 'whisper', text: cmd.text ?? '', to: cmd.all ? 'all' : cmd.target });
      case 'hold':
      case 'resume':
        return this.attentionState(cmd.verb, targets, cmd.all, cmd.force);
      case 'interrupt':
        return this.interruptAct(targets, cmd.all, cmd.text ?? '', cmd.force, false);
      case 'status':
        return this.statusAct(targets, cmd.all, cmd.force);
      case 'install':
      case 'upgrade':
        return this.installAct(cmd.target, cmd.verb === 'upgrade', cmd.recipe ?? '', cmd.force);
      case 'color': {
        const check = this.checkColor(cmd.color ?? '');
        if (check) return [check];
        const color = (cmd.color ?? '').toLowerCase() as ConsoleColor;
        for (const h of targets) putSeatView(this.room.endpoint.id, h, { color });
        // Re-emit the roster immediately so pinned clients repaint from the new
        // view state. Waiting for their periodic `:list seats` left the old
        // palette default visible (often green) after a successful recolor.
        return [
          ...targets.map((h) => info(msg.colored(h, color))),
          this.rosterEvent(this.roster, this.room.endpointSlug, this.room.endpoint.id),
        ];
      }
      case 'hide':
        for (const h of targets) putSeatView(this.room.endpoint.id, h, { hidden: true });
        return [
          ...targets.map((h) => info(msg.hidden(h))),
          this.rosterEvent(this.roster, this.room.endpointSlug, this.room.endpoint.id),
        ];
      case 'show':
        for (const h of targets) putSeatView(this.room.endpoint.id, h, { hidden: false });
        return [
          ...targets.map((h) => info(msg.shown(h))),
          this.rosterEvent(this.roster, this.room.endpointSlug, this.room.endpoint.id),
        ];
      case 'revoke': {
        const revocable = targets.filter((h) => {
          const seat = this.roster.find((s) => s.handle === h);
          return seat !== undefined && seat.status !== 'revoked' && seat.status !== 'expired';
        });
        if (revocable.length === 0) return [error(msg.nothingToRevoke)];
        if (cmd.force) return this.performRevoke(revocable); // panic: no confirm
        this.pendingRevoke = { handles: revocable };
        return [{ type: 'confirm', text: msg.confirmRevoke(revocable) }];
      }
      case 'delete':
        return this.deleteAct(targets, cmd.all);
    }
  }

  // ── :delete (#267: post-mortem cleanup, not part of the ladder) ────────────

  /**
   * Delete a revoked (or expired) seat: off the roster and presence surfaces,
   * view state dropped, and the display name freed so a fresh mint reuses it
   * cleanly. Console-local by design - the server already knows the seat is
   * dead; what delete removes is the corpse from the chair's surfaces. The log
   * keeps its bylines. A LIVE seat refuses: revoke first (the ladder ends at
   * revoke; delete comes after the funeral).
   */
  private async deleteAct(targets: string[], all: boolean): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    const endpointId = this.room.endpoint.id;
    const events: ConsoleEvent[] = [];
    const deletable: RosterEntry[] = [];
    for (const handle of targets) {
      const seat = this.roster.find((s) => s.handle === handle);
      if (!seat) {
        events.push(error(msg.unknownHandle(handle)));
        continue;
      }
      if (!this.seatDeletable(seat)) {
        // :all sweeps quietly past live seats; a named live target gets the lesson.
        if (!all) events.push(error(msg.deleteNeedsRevoke(handle)));
        continue;
      }
      deletable.push(seat);
    }
    if (deletable.length === 0) return events.length > 0 ? events : [error(msg.nothingToDelete)];
    for (const seat of deletable) {
      putSeatDeleted(endpointId, seat.inviteId);
      clearSeatView(endpointId, seat.handle);
      this.held.delete(seat.handle);
      this.idle.delete(seat.handle);
      this.feedSeen.delete(seat.handle);
      this.latestStanza.delete(seat.handle);
      this.departed.delete(seat.handle);
      events.push(info(msg.deleted(seat.handle)));
    }
    await this.refreshRoster();
    return events;
  }

  /** What delete may touch (#267): the post-mortem states - revoked, expired, or departed (#266). */
  private seatDeletable(seat: RosterEntry): boolean {
    return seat.status === 'revoked' || seat.status === 'expired' || this.departed.has(seat.handle);
  }

  // ── attention verbs (slice C: hold/resume = state, interrupt = act) ────────

  /** Hand the order to the in-process room's meta relay, when this console hosts one. */
  private relayAttention(handles: string[], order: AttentionOrder): void {
    if (!this.host?.orderAttention) return;
    const names = handles
      .map((h) => this.roster.find((s) => s.handle === h)?.guestName)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    if (names.length > 0) this.host.orderAttention(names, order);
  }

  /**
   * hold / resume: the stateful pair (§5). One signed post (to:"all" is a single
   * post - one capture, one label); the held mark is engine state, session-local.
   */
  private async attentionState(verb: 'hold' | 'resume', targets: string[], all: boolean, panic: boolean): Promise<ConsoleEvent[]> {
    const to = all ? 'all' : targets[0];
    const { events, ok } = await this.deliver({
      kind: 'message',
      to,
      verb: verb === 'hold' ? 'fp:hold' : 'fp:resume',
      panic,
    });
    if (!ok) return events;
    for (const h of targets) {
      if (verb === 'hold') {
        this.held.add(h);
        this.idle.delete(h);
      } else {
        this.held.delete(h);
      }
    }
    this.relayAttention(targets, { code: verb === 'hold' ? 'attention_hold' : 'attention_resume', panic });
    events.push(info(verb === 'hold' ? (all ? msg.heldAll : msg.held(to)) : all ? msg.resumedAll : msg.resumed(to)));
    return events;
  }

  /**
   * interrupt (§5, ruled 3): bare = hard stop, NO text member on the wire (the seat
   * idles); with a message = redirect (new orders in the same signed act). Either
   * way any hold on the target ends. `translated` marks the ruled-2 path: a plain
   * mention at a held seat, resolved here into the act it is.
   */
  private async interruptAct(targets: string[], all: boolean, text: string, panic: boolean, translated: boolean): Promise<ConsoleEvent[]> {
    const to = all ? 'all' : targets[0];
    const { events, ok } = await this.deliver({
      kind: 'message',
      to,
      verb: 'fp:interrupt',
      panic,
      ...(text ? { text } : {}),
    });
    if (!ok) return events;
    for (const h of targets) {
      this.held.delete(h);
      if (text) this.idle.delete(h);
      else this.idle.add(h);
    }
    this.relayAttention(targets, { code: 'attention_interrupt', panic });
    events.push(
      info(translated ? msg.heldMentionSent(to) : text ? msg.interruptedRedirect(to) : msg.interruptedHard(to)),
    );
    return events;
  }

  // ── status (#246: the layered verb) ────────────────────────────────────────

  /**
   * Layer 1: the facts table, instant and authoritative (engine + roster state).
   * Layer 2: the latest volunteered stanza per seat, freshness labeled by the
   * renderer. Layer 3: the addressed wire act - fp:status posts so the seat owes
   * an answer; :all status is the roll call (one post, to:"all").
   */
  private async statusAct(targets: string[], all: boolean, panic: boolean): Promise<ConsoleEvent[]> {
    const rows = targets.flatMap((h) => {
      const seat = this.roster.find((s) => s.handle === h);
      if (!seat) return [];
      const seen = this.feedSeen.get(h);
      const stanza = this.latestStanza.get(h);
      return [{
        handle: h,
        guestName: seat.guestName,
        // The ladder (#246, #266): invite status > held > departed > engine idle
        // (post-hard-stop) > transport truth > the pre-#266 default. Held keeps
        // overlaying exactly as before; departed is the fp:bye sign-off.
        state:
          seat.status !== 'accepted'
            ? seat.status
            : this.held.has(h)
              ? 'held'
              : this.departed.has(h)
                ? 'departed'
                : this.idle.has(h)
                  ? 'idle'
                  : this.presence
                    ? this.presence.stateFor(seat.guestName)
                    : 'live',
        expiresAt: seat.expiresAt,
        lastPostAt: seen?.lastPostAt ?? null,
        posts: seen?.posts ?? 0,
        stanza: stanza?.stanza ?? null,
        stanzaAt: stanza?.at ?? null,
      }];
    });
    const events: ConsoleEvent[] = [{ type: 'status', rows }];
    const { events: postEvents, ok } = await this.deliver({
      kind: 'message',
      to: all ? 'all' : targets[0],
      verb: 'fp:status',
      panic,
    });
    events.push(...postEvents);
    if (ok) events.push(info(msg.statusRequested(all ? 'all' : targets[0])));
    return events;
  }

  // ── addressed install / upgrade (#249: the verb commissions, never performs) ─

  /**
   * One signed order to ONE steward. :upgrade is console sugar over the same
   * commissioning act: fp:install with the recipe as the machine token and the
   * upgrade instruction as prose text (fp:upgrade is not in the v1 registry;
   * args stay machine tokens, prose rides text - see the gavel-record note).
   */
  private async installAct(handle: string, upgrade: boolean, recipe: string, panic: boolean): Promise<ConsoleEvent[]> {
    const { events, ok } = await this.deliver({
      kind: 'message',
      to: handle,
      verb: 'fp:install',
      args: [recipe],
      panic,
      ...(upgrade ? { text: msg.upgradeInstruction } : {}),
    });
    if (!ok) return events;
    events.push(info(msg.installOrdered(handle, recipe, upgrade)));
    return events;
  }

  private async performRevoke(handles: string[]): Promise<ConsoleEvent[]> {
    if (!this.room) return [error(msg.unbound)];
    const events: ConsoleEvent[] = [];
    for (const handle of handles) {
      const seat = this.roster.find((s) => s.handle === handle);
      if (!seat) {
        events.push(error(msg.unknownHandle(handle)));
        continue;
      }
      await this.api.revokeInvite(this.room.endpoint.id, seat.inviteId);
      events.push(info(msg.revoked(handle)));
    }
    await this.refreshRoster();
    return events;
  }

  // ── feed ─────────────────────────────────────────────────────────────────

  /**
   * One tail step: backfill the latest few rows on the first call, then long-poll
   * for what is new. The frontend loops this while accepting input; hidden seats
   * are dropped here so every frontend agrees on what the chair muted. The signal
   * lets teardown abort an in-flight long-poll cleanly (#253 graceful exit).
   */
  async pollFeed(timeoutSeconds = 20, signal?: AbortSignal): Promise<ConsoleEvent[]> {
    if (!this.room) return [];
    const events: ConsoleEvent[] = [];
    let page;
    if (!this.feedPrimed) {
      page = await this.api.listCaptures(this.room.endpoint.id, FEED_BACKFILL_ROWS);
      page = { ...page, rows: [...page.rows].reverse() }; // newest-first page, chronological feed
      this.feedPrimed = true;
      if (page.readAs) events.push(info(msg.readingAs(page.readAs)));
    } else {
      page = await this.api.waitCaptures(this.room.endpoint.id, this.cursor, timeoutSeconds, signal);
    }
    if (page.nextCursor) this.cursor = page.nextCursor;
    const ledgerBefore = this.ledgerVersion;
    for (const row of page.rows) {
      // The prefix pool (#259) learns every id, hidden rows included: a muted
      // seat's capture is still addressable, exactly like the status facts.
      this.feedIds.add(row.id);
      const item = this.feedItem(row);
      if (item) events.push(item);
    }
    // The decision ledger repaints the moment the log changes it (#295, the
    // #279 immediate-repaint pattern): one event per poll, after the whole page.
    if (this.ledgerVersion !== ledgerBefore) events.push(this.decisionsEvent());
    return events;
  }

  /**
   * The v1 reader (wire schema §2): v absent reads as 1 and any other v renders
   * TAGGED; channel discrimination is unchanged from v0; an unknown kind renders
   * tagged, never dropped; a verb renders as an order/receipt line, tagged when
   * unknown or unprefixed, and is NEVER executed. Non-JSON, non-object, and
   * truncated bodies render raw exactly as v0 did.
   */
  private feedItem(row: { id: string; createdAt: string; signerLabel: string | null; body: string | null }): ConsoleEvent | null {
    if (!this.room) return null;
    const mine = row.signerLabel === 'owner';
    const seat = mine
      ? null
      : this.roster.find((s) => s.guestName === row.signerLabel) ?? null;
    const rosterIndex = seat ? this.roster.indexOf(seat) : -1;
    const view = seat ? getSeatView(this.room.endpoint.id, seat.handle) : {};
    // Feed-history facts update BEFORE the hidden check: the status table stays
    // truthful about a muted seat (hidden is the chair's eyes only).
    if (seat) {
      const seen = this.feedSeen.get(seat.handle);
      this.feedSeen.set(seat.handle, { lastPostAt: row.createdAt, posts: (seen?.posts ?? 0) + 1 });
    }

    let channel: 'room' | 'mention' | 'whisper' | 'scratch' | 'raw' = 'raw';
    let to: string | null = null;
    let text = row.body ?? '';
    let verb: FeedVerb | null = null;
    let re: string | null = null;
    let panic = false;
    let status: Record<string, unknown> | null = null;
    /** The one-line summary member (#281 G1 point 2 / G-bonus), sanitized. */
    let summary: string | null = null;
    /** #499: the section (`for`), the from claim, the review verdict, and the parsed body. */
    let section: string | null = null;
    let from: string | null = null;
    let verdict: string | null = null;
    let parsedBody: Record<string, unknown> | null = null;
    const tags: string[] = [];
    try {
      const parsed = JSON.parse(row.body ?? '') as {
        v?: unknown;
        kind?: unknown;
        from?: unknown;
        to?: unknown;
        for?: unknown;
        text?: unknown;
        verb?: unknown;
        verdict?: unknown;
        args?: unknown;
        re?: unknown;
        panic?: unknown;
        status?: unknown;
        summary?: unknown;
      };
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        parsedBody = parsed as Record<string, unknown>;
        re = typeof parsed.re === 'string' && parsed.re.length > 0 ? parsed.re : null;
        panic = parsed.panic === true;
        section = typeof parsed.for === 'string' && parsed.for.length > 0 ? parsed.for.toLowerCase() : null;
        from = typeof parsed.from === 'string' && parsed.from.length > 0 ? parsed.from : null;
        verdict = typeof parsed.verdict === 'string' && REVIEW_WORDS.has(parsed.verdict.toLowerCase()) ? parsed.verdict.toLowerCase() : null;
        if (typeof parsed.summary === 'string' && parsed.summary.length > 0) {
          summary = sanitizeWireLine(parsed.summary);
        }
        // The status stanza (§1 row 10): recipe-declared interior, console-opaque -
        // carried generically, and remembered as the seat's latest (#246 layer 2).
        if (typeof parsed.status === 'object' && parsed.status !== null && !Array.isArray(parsed.status)) {
          // Cleaned before it is REMEMBERED: the stanza outlives this row in the
          // status table (#246 layer 2), so it must not carry escapes forward.
          status = sanitizeStanza(parsed.status as Record<string, unknown>);
          if (seat) this.latestStanza.set(seat.handle, { at: row.createdAt, stanza: status });
        }
        // v absent reads as 1; unknown or higher versions still render, tagged.
        if (parsed.v !== undefined && parsed.v !== 1) tags.push(msg.feedSchemaTag(String(parsed.v)));
        to = typeof parsed.to === 'string' && parsed.to.length > 0 ? parsed.to : null;
        // 'scratch' (#282) is a known kind now: the out-of-band channel wins the
        // discrimination outright (a scratch is never a mention, whoever it names).
        channel = parsed.kind === 'whisper' ? 'whisper' : parsed.kind === 'scratch' ? 'scratch' : to ? 'mention' : 'room';
        if (parsed.kind !== undefined && parsed.kind !== 'message' && parsed.kind !== 'whisper' && parsed.kind !== 'scratch') {
          tags.push(msg.feedUnknownKind(String(parsed.kind)));
        }
        if (typeof parsed.verb === 'string') {
          const raw = parsed.verb;
          const args = Array.isArray(parsed.args) ? parsed.args.filter((a): a is string => typeof a === 'string') : [];
          if (raw.startsWith('fp:')) {
            verb = { raw, display: raw.slice(3) || raw, recipe: false, args };
            if (!FP_VERBS.has(raw)) tags.push(msg.feedUnknownVerb(raw));
          } else if (raw.startsWith('r:')) {
            verb = { raw, display: raw.slice(2) || raw, recipe: true, args };
          } else {
            verb = { raw, display: raw, recipe: false, args };
            tags.push(msg.feedUnknownVerb(raw));
          }
          // A verb post with no text is a complete act (§5): meta line only.
          text = typeof parsed.text === 'string' ? parsed.text : '';
        } else if (typeof parsed.text === 'string') {
          text = parsed.text;
        } else {
          // A JSON object with no `text` has no message to show, so the raw body
          // stands in - TRIMMED, and tagged so the trim is never silent. The full
          // payload is still one capture-id fetch away (the id is on the meta line).
          const raw = row.body ?? '';
          if (raw.length > FEED_RAW_PREVIEW_CHARS) {
            text = raw.slice(0, FEED_RAW_PREVIEW_CHARS) + '...';
            tags.push(msg.feedBodyTrimmed(FEED_RAW_PREVIEW_CHARS, raw.length));
          } else {
            text = raw;
          }
        }
      }
    } catch {
      /* non-JSON payloads (including truncated oversize bodies) render raw */
    }

    // The sign-off (#266): fp:bye reads the seat as departed; any later post from
    // the same seat clears it. Chronological replay keeps backfill honest - an
    // old bye followed by newer posts nets out to present.
    if (seat) {
      if (verb?.raw === 'fp:bye') this.departed.add(seat.handle);
      else this.departed.delete(seat.handle);
    }

    // ── record control (#281, G4): the pending queue derives from the LOG - flagged
    // posts in, dispositions out. Idempotent with the console's optimistic marks:
    // both apply the same mutations keyed by the same post ids, so the chair's own
    // acts echoing back through the feed re-state facts already known, and a
    // backfill replays the whole record into the same view.
    // #499: the facts every act reuses, kept per post (bounded by the feed).
    this.feedPosts.set(row.id, {
      from,
      handle: seat?.handle ?? null,
      mine,
      section,
      text: sanitizeWireLine(text).slice(0, RECORD_SUMMARY_CHARS),
      summary,
      body: parsedBody,
      signerLabel: row.signerLabel,
      re,
    });

    if (verb?.raw === 'fp:propose') {
      if (!this.proposals.has(row.id)) {
        this.proposals.set(row.id, {
          summary,
          preview: summary ?? sanitizeWireLine(text).slice(0, RECORD_SUMMARY_CHARS),
          handle: seat?.handle ?? null,
          at: row.createdAt,
          state: 'pending',
          settledAt: null,
          section,
          author: seat?.handle ?? from,
          verdict: null,
        });
        this.ledgerVersion++;
      }
      // The feed mark (ruled: visible, subtle): the render-and-tag idiom carries
      // it to every frontend. At live render a proposal is pending; a backfill
      // row already dispositioned earlier in the replay says so instead. A
      // struck row wears only the struck mark below (#295): the flag was unsaid.
      const state = this.proposals.get(row.id)!.state;
      if (state !== 'struck') {
        tags.push(
          state === 'pending'
            ? msg.proposalPendingMark
            : state === 'ratified'
              ? msg.proposalRatifiedMark
              : msg.proposalRetractedMark,
        );
      }
    // The envelope signer is authority; `from` is only a display byline. A seat
    // claiming `from: director` must never be able to gavel or unsay the record.
    } else if (mine && verb?.raw === 'fp:ratify' && re !== null) {
      const target = this.resolveLogRef(re);
      if (target !== null) {
        const rec = this.proposals.get(target);
        if (rec && rec.state !== 'struck') {
          rec.state = 'ratified';
          rec.settledAt = row.createdAt;
          // The ruling id is ledger-visible too (ratifiedBy), so a replacing
          // re-ratification still repaints (#295).
          this.ledgerVersion++;
        }
        this.ratifications.set(row.id, target);
        this.lastRatification = { proposalId: target };
      }
    } else if (mine && verb?.raw === 'fp:retract' && re !== null) {
      const target = this.resolveLogRef(re);
      if (target !== null) this.applyRetract(target, row.createdAt);
    } else if (mine && verb?.raw === 'fp:strike' && re !== null) {
      // #282: the un-say propagates BECAUSE it rides the log - any reader
      // applying this same derivation sees the post struck.
      const target = this.resolveLogRef(re);
      if (target !== null) this.applyStrike(target);
    } else if (re !== null && verb !== null) {
      // #499 gap 5: a review verdict from ANY signer rides the ledger - fp:review
      // with a verdict member, or the r:proceed family the rooms write.
      const word = verb.raw === 'fp:review' ? verdict : verb.recipe && REVIEW_WORDS.has(verb.display.toLowerCase()) ? verb.display.toLowerCase() : null;
      if (word !== null) {
        const target = this.resolveLogRef(re);
        if (target !== null) this.applyVerdict(target, word);
      }
    }
    // A struck id re-delivered (backfill, cursor overlap) wears the mark (#282).
    if (this.struck.has(row.id)) tags.push(msg.struckMark);

    // Hidden drops the LINE only, after the history facts above were recorded.
    if (view.hidden === true) return null;

    // The status ticker (#280b): a protocol-shaped status (string `state`)
    // renders as a dim one-liner, and consecutive same-seat same-state repeats
    // collapse. Tracked AFTER the hidden drop, because consecutive means
    // consecutive on the chair's screen - a muted seat cannot break a run it
    // was never part of. The stanza was cleaned above; the ticker halves are
    // forced to ONE line each (a status value may legitimately span lines).
    let statusTicker: { state: string; detail: string | null; pure: boolean; repeated: boolean } | null = null;
    if (status && typeof status.state === 'string' && status.state.length > 0) {
      const detail =
        typeof status.reason === 'string' && status.reason.length > 0
          ? status.reason
          : typeof status.task === 'string' && status.task.length > 0
            ? status.task
            : null;
      const key = seat?.handle ?? row.signerLabel ?? 'unsigned';
      const repeated =
        this.lastTicker !== null && this.lastTicker.key === key && this.lastTicker.state === status.state;
      this.lastTicker = { key, state: status.state };
      statusTicker = {
        state: sanitizeWireLine(status.state),
        detail: detail === null ? null : sanitizeWireLine(detail),
        pure: verb?.raw === 'fp:status' && text.length === 0,
        repeated,
      };
    } else {
      this.lastTicker = null;
    }

    // Byline dedup (feed spec, ratified): GuestName (handle) only when they
    // DIFFER - a name already IN normalized form is its own handle and renders
    // alone ("fable (fable)" is just "fable"); a pretty name or a collision
    // suffix earns the parenthetical, because the handle is what you type.
    const byline = mine
      ? this.fromName()
      : seat
        ? seat.guestName === seat.handle
          ? seat.guestName
          : `${seat.guestName} (${seat.handle})`
        : (row.signerLabel ?? 'unsigned');
    // The addressee's color (#263): match `to` by ROSTER HANDLE (wire bylines
    // may differ from console handles, and suffixed handles like author-2 are
    // console-side facts the wire never carries); the chair answers to both the
    // wire address and the :me byline, in the chair's own color. Anything else,
    // all included, stays null and renders in the meta style.
    let toColor: ConsoleColor | null = null;
    if (to !== null) {
      const targetIndex = this.roster.findIndex((s) => s.handle === to);
      if (targetIndex >= 0) {
        toColor = getSeatView(this.room.endpoint.id, to).color ?? this.paletteDefault(targetIndex);
      } else if (to === (this.chairAddress() ?? CHAIR_FROM) || to === this.fromName()) {
        toColor = this.profile().color;
      }
    }
    // ── the untrusted boundary ────────────────────────────────────────────────
    // Everything below was written by somebody else. It leaves here cleaned ONCE,
    // for every surface: a terminal obeys ANSI, and a seat that can repaint the
    // chair's screen can forge a meta line carrying the chair's own byline.
    // Bylines, addressees, verbs and tags are one-line strings; only the message
    // body may span lines (paragraph breaks are ratified feed behavior).
    return {
      type: 'feed',
      item: {
        at: row.createdAt,
        id: row.id,
        byline: sanitizeWireLine(byline),
        color: mine ? this.profile().color : seat ? (view.color ?? this.paletteDefault(rosterIndex)) : null,
        channel,
        to: to === null ? null : sanitizeWireLine(to),
        toColor,
        text: sanitizeWireText(text),
        mine,
        verb: verb === null ? null : {
          ...verb,
          display: sanitizeWireLine(verb.display),
          args: verb.args.map(sanitizeWireLine),
        },
        re: re === null ? null : sanitizeWireLine(re),
        for: section === null ? null : sanitizeWireLine(section),
        from: from === null ? null : sanitizeWireLine(from),
        panic,
        status,
        statusTicker,
        tags: tags.map(sanitizeWireLine),
      },
    };
  }
}

/** Stable roster order: CreatedAt then ref - the collision-suffix determinism anchor. */
function sortSeats<T extends { createdAt: string; ref: string }>(seats: T[]): T[] {
  return [...seats].sort((a, b) =>
    a.createdAt === b.createdAt ? a.ref.localeCompare(b.ref) : a.createdAt.localeCompare(b.createdAt),
  );
}
