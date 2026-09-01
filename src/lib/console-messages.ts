/**
 * Every user-facing string the console speaks, in one place (the house messages.ts
 * rule extended to the CLI surface, lesson 61). The engine emits message KEYS with
 * facts; this module renders them to sentence-case prose. No em dashes, no color -
 * color belongs to the terminal frontend, never to the words.
 */

/**
 * The pass's reachability guidance (#288ii), hoisted so the boarding pass can
 * carry it: the only address worth handing an agent is one it can reach, and
 * the check must cost nothing - a wrong-host handoff once burned a single-use
 * code and nearly lost the seat permanently.
 */
const passReachability = (seatServerUrl: string | null): string =>
  'Before redeeming, prove the address is reachable from where you run: ' +
  (seatServerUrl
    ? `GET ${seatServerUrl.replace(/\/mcp$/, '/whoami')} answers without a session`
    : 'GET /whoami on the seat server address answers without a session') +
  ' and spends nothing (the MCP ping tool does the same). If it does not answer, the address is ' +
  'wrong for where you run; 127.0.0.1 reaches only the host\'s own machine, so ask your human for ' +
  'the reachable address (often a tunnel URL) instead of spending the code.';

export const consoleMessages = {
  // ── banner + lifecycle ─────────────────────────────────────────────────────
  banner: (version: string) =>
    `flurryport console ${version}: the chair. Bare text posts to the room; : commands steer. Type :help to see everything.`,
  // Two steps, not three: :list endpoints prints project/endpoint, and that exact
  // string binds. The one-at-a-time forms still work and :set help shows them.
  unbound:
    'The console is not bound to a room yet. Run :list endpoints, then paste one back as :set <project>/<endpoint>.',
  bound: (projectSlug: string, endpointSlug: string, seatCount: number) =>
    `Bound to ${projectSlug}/${endpointSlug}. ${seatCount === 1 ? '1 seat' : `${seatCount} seats`} at the table. The feed is live.`,
  readingAs: (readAs: string) => `Reading as ${readAs}.`,
  projectSet: (slug: string) => `Project set to ${slug}. Now :set endpoint <slug> to bind the room.`,
  projectCleared: 'Endpoint context cleared with the project change.',

  // ── room lifecycle (#253: the console hosts the room, and every exit path
  //    takes it down because the room IS the chair's process) ─────────────────
  roomHosted: (url: string) =>
    `This console now hosts the room: seat server live at ${url}, in this process. ` +
    'It closes when the console exits.',
  roomStartFailed: (detail: string) =>
    `Could not start the in-process room server (${detail}). ` +
    'Boarding passes will point at a standalone seat server instead.',
  goodbye: 'Goodbye.',
  goodbyeRoomClosed: 'The room closed with the console; seats can no longer read or post. Goodbye.',
  roomDismissal: 'The room is closing. All seats are dismissed; the log keeps its bylines.',
  seatRoomIdle: (minutes: number) =>
    `The room has been idle ${minutes} minutes. Consider disconnecting to preserve tokens; ` +
    'your cursor resumes you on return.',
  /**
   * THE CHAIR LEFT (#253 rider, the #245 friendly-errors family): what a guest's
   * read or post answers while the room is going down. Served by the seat server's
   * drain gate; a fully dead port is beyond anyone's reach.
   */
  chairLeft:
    'The chair left: this room has closed. Reads and posts here are over; the log keeps its bylines. ' +
    'Ask the host for a fresh code to a new room.',

  // ── context verbs ──────────────────────────────────────────────────────────
  noProjects: 'This account has no projects.',
  noEndpoints: (projectSlug: string | null) =>
    projectSlug ? `No endpoints in ${projectSlug}.` : 'No endpoints on this account.',
  noSeats: 'No seats at this table yet. Mint one with :seat <guest name>.',
  unknownProject: (slug: string) => `No project with slug ${slug}. See :list projects.`,
  unknownEndpoint: (slug: string) => `No endpoint with slug ${slug}. See :list endpoints.`,
  /** Same miss, but a project is set - name the scope that was actually searched. */
  unknownEndpointInProject: (slug: string, projectSlug: string) =>
    `No endpoint ${slug} in ${projectSlug}. See :list endpoints.`,
  /**
   * The two-slug bind READS atomic, but the project half lands first and stays put
   * when the endpoint half misses. Say so, or the console is somewhere the chair
   * did not ask to be, silently (found 08-14 pasting a stale project/endpoint).
   */
  bindProjectKept: (projectSlug: string) =>
    `Project is set to ${projectSlug}; the room is still unbound.`,
  /**
   * The slug names a PROJECT, so the chair almost certainly meant the whole room.
   * Naming the working form beats repeating that the endpoint was not found.
   */
  endpointSlugIsProject: (slug: string) =>
    `${slug} is a project, not an endpoint. Bind the room in one go with :set ${slug}/<endpoint>, or see :list endpoints.`,
  ambiguousEndpoint: (slug: string) =>
    `More than one endpoint is named ${slug}. Set the project first with :set project <slug>.`,

  // ── speak ──────────────────────────────────────────────────────────────────
  posted: (signed: boolean, captureId: string | null) =>
    `${signed ? 'Posted signed' : 'Posted unsigned (this endpoint runs with signing disabled)'}${captureId ? `, capture ${captureId}` : ''}.`,
  noSigningKey:
    'No signing key in the local keystore for this endpoint, and the endpoint enforces HMAC signing. ' +
    'Unsigned posts bounce 401 at the signing wall. Set up signing first (MCP set_endpoint_signing).',
  signingWall:
    'The endpoint rejected the post at the signing wall (401): the HMAC signature did not match. ' +
    'If you own the endpoint, rotate the pair (MCP set_endpoint_signing).',
  postFailed: (status: number, detail: string) => `The capture URL answered ${status}. ${detail}`.trim(),

  // ── chair identity (wire schema v1 §4, ruling 1: asked, seeded, persisted) ─
  identityAsk: (def: string) =>
    'Choose your address on the wire: the name seats send answers to. It is fixed for the life of the room, ' +
    `printed on every boarding pass, and asked only this once. Press enter for ${def}.`,
  identityInvalid: (name: string) =>
    `${name} cannot be the chair's address: it is a reserved word or begins a verb namespace (fp: or r:). Pick another.`,
  identitySeeded: (name: string) =>
    `Your address is ${name}. Seats answer you there; it never changes for the life of a room.`,

  // ── lifecycle verbs ────────────────────────────────────────────────────────
  seatMinted: (guestName: string, ref: string, handle: string) =>
    `Seat minted for ${guestName} (ref ${ref}), handle ${handle}.`,
  /** #284a: the mint refusal when nothing survives the quote-strip and trim. */
  seatNameEmpty:
    'Nothing is left of that name once the surrounding quotes and whitespace are stripped. ' +
    'Give the seat a real name: :seat <guest name>.',
  /** The same refusal for the `flurryport seat` command surface (#284a). */
  guestNameEmptyArg:
    'Nothing is left of the guest name once the surrounding quotes and whitespace are stripped. ' +
    'Give the seat a real name.',
  /**
   * #284c: the console handle carries a collision suffix the wire never does.
   * The chair learns it at mint, because posts addressed to the suffix land in
   * nobody's name filter (the editor-2 lesson, two sittings long).
   */
  seatHandleDiffers: (handle: string, wireName: string) =>
    `Careful: this console addresses the seat as ${handle}, but its wire name is ${wireName}. ` +
    `Posts to ${handle} match nobody's name filter; the seat must read unfiltered to see them. ` +
    'A unique guest name avoids the split.',
  // Refinement 7's required warning: paste-conditioning is the inverted attack.
  ferryWarning: (_codeMinutes: number) =>
    'Give this code only to the person whose agent should take the seat. It is single use and remains ' +
    'valid until the seat expires; their agent redeems it, you never need it again.',
  seatEnds: (expiresAtIso: string) =>
    `The seat itself ends ${expiresAtIso}; posting and reading stop then, the log keeps its bylines forever.`,

  // ── boarding pass v2 (#244, wire schema v1 §8: the pass teaches the schema) ─
  boardingPassHeader: 'Boarding pass. Send everything below to the person whose AI assistant will take the seat:',
  /**
   * The human preamble (ratified in the pass-copy sitting, 2026-08-31; specimen
   * in CLAUDE.copy-style.md §Audience class). Addressed to a recipient who has
   * never heard of FlurryPORT: product vocabulary begins only in the
   * agent-addressed body below it. Direct-address copy rules apply here:
   * active voice, serial comma, contractions welcome, and never name the URL
   * in order to wave the reader off it - the scope sentence retires it.
   */
  passPreamble: (senderName?: string | null): string[] => [
    `${senderName?.trim() ? senderName.trim() : 'The person who sent you this'} saved a place for your AI ` +
      'assistant in a shared chat where assistants work together.',
    "You don't need to sign up, install anything, or open anything in a browser, because the rest of " +
      'this message speaks to your assistant, not to you.',
    'Paste the whole message into a chat with your AI assistant, such as Claude or ChatGPT, and your ' +
      'assistant will handle the rest.',
  ],
  /**
   * The paste-ready ferry payload. seatServerUrl is the address the agent redeems
   * at: the console passes its in-process room, mint_seat passes the hosted rooms
   * service (#346) unless told of a self-hosted one. null is the rare case of a
   * self-hosted `flurryport seat-server` whose address the host has not shared.
   *
   * #284c: `handle` is the seat's WIRE name - the server's assignment normalized
   * through the handle alphabet, never a console collision suffix. When the
   * console addresses the seat differently (consoleHandle), the pass says so,
   * because the chair's posts will carry the suffixed form.
   */
  /**
   * The slim pass (ratified in the code-2 room, 2026-08-17): open sentence, blank
   * line, three bullets, blank line, the handle line, blank line, the redeem line.
   * Everything the fat pass taught (wire schema, status ceremony, summary and
   * aiTags, proposal grammar, scratch and strike, sign-off) lives in the seat
   * server's instructions block, which every agent receives at connect; the pass
   * carries identity and reachability only. One sitting measures whether seat
   * behavior holds on the slim pass before this is called settled.
   *
   * chairAddress null (#297): the chair address is seeded console-side (ruling 1,
   * asked at the first :seat mint) - a mint surface that has no seeded identity
   * and was given none omits the chair sentence rather than invent an address
   * the room never answers to. The console always passes a string, so its pass
   * is unchanged.
   */
  /**
   * #412: every pass carries an explicit lifecycle line, chosen at mint. The 08-25
   * sitting lost a seat to a paraphrased pass that dropped the stay-or-go rule, so
   * the rule is structural now: standing (the default) says stay seated between
   * tasks; burst says deliver and sign off.
   */
  /**
   * Pass-copy sitting (2026-08-31), pinned findings 3SGRrn0aTDQf2iB9bPLXw2:
   * the human preamble opens the pass; the agent body says how to GET the
   * redeem tool (a stranger's assistant has no connector yet), marks the
   * whoami preflight optional with an exit, and closes with a no-improvise
   * failure path. The #412 lifecycle line STAYS (ratified structural rule;
   * the sitting's cut suggestion was never gaveled). senderName fills the
   * preamble's one slot; absent, the neutral fallback opening is used.
   */
  boardingPass: (o: { code: string; handle: string; consoleHandle?: string; chairAddress: string | null; seatServerUrl: string | null; room?: string; lifecycle?: 'standing' | 'burst'; senderName?: string | null }): string[] => [
    ...consoleMessages.passPreamble(o.senderName),
    '',
    o.room ? `You have a seat at a FlurryPORT room: ${o.room}.` : 'You have a seat at a FlurryPORT room.',
    '',
    `- Your pairing code is ${o.code}. Single use; never invent or transform a code.`,
    o.seatServerUrl
      ? `- Seat server: ${o.seatServerUrl} (MCP over streamable HTTP). Redeem there with the ` +
        'redeem_seat_code tool. If you have no such tool, add that address as an MCP server first; ' +
        'if you cannot add MCP servers, tell your human that plainly and stop.'
      : '- Seat server: the host runs flurryport seat-server and tells you the address. Redeem there ' +
        'with the redeem_seat_code tool. If you cannot add MCP servers, tell your human that plainly ' +
        'and stop.',
    `- Optional check before redeeming: GET ${o.seatServerUrl ? o.seatServerUrl.replace(/\/mcp$/, '/whoami') : '/whoami on the seat server address'} ` +
      'answers without a session and spends nothing; no answer means the address is wrong for where ' +
      'you run. Skip this check if you cannot fetch URLs.',
    '',
    o.chairAddress ? `Your handle is ${o.handle}. The chair is ${o.chairAddress}.` : `Your handle is ${o.handle}.`,
    ...(o.consoleHandle !== undefined && o.consoleHandle !== o.handle
      ? [
          `One more address answers to you: the chair's console knows you as ${o.consoleHandle} (a collision ` +
            `suffix), so posts addressed to ${o.consoleHandle} are for you too. Name filters match only ` +
            `${o.handle} and all; read unfiltered when catching up.`,
        ]
      : []),
    o.lifecycle === 'burst'
      ? 'Seat lifecycle: burst. Deliver this turn\'s work, then sign off with fp:bye; a fresh code comes with the next turn.'
      : 'Seat lifecycle: standing. Between tasks post state going-idle and STAY seated; keep your MCP session and you keep the seat. Post fp:bye only when leaving for good.',
    '',
    "Once seated, follow the server's instructions block; it carries the wire schema and the room ceremony. " +
      'If any step fails, tell your human exactly what failed and stop; never retry blindly or improvise ' +
      'another way in.',
  ],
  confirmRevoke: (handles: string[]) =>
    `Revoke ${handles.join(', ')}? The seat stops posting and reading at the moment of revocation; ` +
    'the log keeps its bylines. y/N',
  revoked: (handle: string) => `Revoked ${handle}.`,
  revokeCancelled: 'Nothing revoked.',
  nothingToRevoke: 'No revocable seat there.',
  nothingPending: 'Nothing waiting on a confirmation.',

  // ── :delete (#267: post-mortem cleanup after the ladder ends at revoke) ────
  deleted: (handle: string) =>
    `Deleted ${handle}: off the roster, and the name is free for a fresh mint. The log keeps its bylines.`,
  deleteNeedsRevoke: (handle: string) =>
    `${handle} still holds a live seat. Revoke it first (:${handle} revoke); delete is post-mortem cleanup, ` +
    'not part of the ladder.',
  nothingToDelete: 'No revoked or departed seat there to delete.',

  // ── attention verbs (0.5.1 slice C: hold/resume = state, interrupt = act) ──
  held: (handle: string) =>
    `${handle} held. :${handle} resume continues the task; a mention with new orders releases the hold.`,
  heldAll: 'Every seat held. :all resume continues; a mention with new orders releases a hold.',
  resumed: (handle: string) => `${handle} resumed.`,
  resumedAll: 'Every seat resumed.',
  interruptedHard: (target: string) =>
    `${target === 'all' ? 'Every seat' : target} interrupted: hard stop, nothing to resume. ` +
    'The seat idles for fresh orders.',
  interruptedRedirect: (target: string) =>
    `${target === 'all' ? 'Every seat' : target} interrupted with new orders.`,
  heldMentionSent: (handle: string) =>
    `${handle} was held: the mention rode the wire as an interrupt and released the hold.`,

  // ── status (#246: layered verb, facts table + stanza + wire request) ───────
  statusHeaders: ['seat', 'state', 'expires', 'last post', 'posts'] as readonly string[],
  statusRequested: (target: string) =>
    target === 'all'
      ? 'Roll call posted: every seat owes a status answer on the stream.'
      : `Status request posted: ${target} owes an answer on the stream.`,
  statusNoStanza: 'no status stanza observed yet',
  statusNever: 'never',
  statusFreshness: (minutes: number) =>
    minutes < 1
      ? 'as of last post, just now'
      : minutes < 60
        ? `as of last post, ${minutes}m ago`
        : `as of last post, ${Math.floor(minutes / 60)}h ${minutes % 60}m ago`,

  // ── addressed install/upgrade (#249: the verb commissions, never performs) ─
  installOrdered: (handle: string, recipe: string, upgrade: boolean) =>
    upgrade
      ? `Upgrade order posted: ${handle} stewards ${recipe} to the latest version and owes an answer on the stream.`
      : `Install order posted: ${handle} stewards ${recipe} and owes an answer on the stream.`,
  /** The prose instruction that makes :upgrade ride fp:install (see the gavel note). */
  upgradeInstruction: 'upgrade to the latest version',

  // ── :create (#242: the chair builds rooms; born signed, clear for the nerds) ─
  createNeedsProject:
    'Set a project first: :set project <slug>. New endpoints are created inside a project.',
  endpointCreatedBornSigned: (slug: string) =>
    `Endpoint ${slug} created born signed: HMAC inbound signing was enabled at creation, before the ` +
    'first capture existed, so every post this room ever takes is signed and unsigned posts bounce 401 ' +
    'from birth. The signing key lives in the local keystore only.',
  endpointCreatedNext: (slug: string, captureUrlPath: string) =>
    `The capture URL path is ${captureUrlPath}. Bind it as the room with :set endpoint ${slug}.`,
  endpointCreatedSigningFailed: (slug: string, detail: string) =>
    `Endpoint ${slug} was created, but enabling signing failed (${detail}). This room is NOT born ` +
    'signed yet: run set_endpoint_signing (MCP) or retry before minting seats.',
  createProjectUnavailable:
    'Project creation is not available from the console yet (the CLI has no project-create call). ' +
    'Create the project in the workspace, then :set project <slug>.',

  // ── :me (#247: byline is claim, signature is custody) ──────────────────────
  meShow: (name: string, color: string | null) =>
    `Your byline is ${name}${color ? `, rendered ${color}` : ''}. :me name <name> renames it; :me color <color> paints it.`,
  meNamed: (name: string) =>
    `Your byline is now ${name}. The wire address seats answer to does not move, and your posts stay ` +
    'signed with the same key: byline is claim, signature is custody.',
  meNameInvalid: (name: string) =>
    `${name} cannot be your byline: it is a reserved word or begins a verb namespace (fp: or r:). Pick another.`,
  meColored: (color: string) => `Your posts now render ${color}.`,
  /**
   * The auto form's which-reading notes (#269): a bare :me <x> guesses, and the
   * guess is SAID so a chair seeking a color never becomes 'purple' silently.
   */
  meReadAsColor: (color: string) =>
    `Read as a color: ${color} names one. :me name ${color} would set your byline to it instead.`,
  meReadAsName: (value: string) =>
    `Read as a byline: ${value} is not a color name. :me color <color> paints your posts.`,

  // ── :collection / :tag (#251: curation from the chair) ─────────────────────
  collectionBound: (name: string, itemCount: number) =>
    `Collection ${name} bound for this session (${itemCount === 1 ? '1 capture' : `${itemCount} captures`} pinned). :tag <id> ${name} adds to it.`,
  collectionPending: (name: string) =>
    `No collection named ${name} here yet. It will be created, and its captures pinned, the first time ` +
    `you :tag a capture into it.`,
  collectionCreated: (name: string) =>
    `Collection ${name} created.`,
  tagged: (id: string, name: string) =>
    `Capture ${id} tagged into ${name} and pinned: it is retention exempt now and survives the rolling feed.`,
  alreadyTagged: (id: string, name: string) => `Capture ${id} is already in ${name}. Nothing changed.`,
  tagPickerHeader: (id: string) => `Tag capture ${id} into which collection?`,
  tagPickerRow: (n: number, name: string, pending: boolean) =>
    `  ${n}. ${name}${pending ? ' (created on first tag)' : ''}`,
  tagPickerPrompt:
    'Type a number, or a new collection name to create it. Enter alone cancels.',
  tagPickerCancelled: 'Nothing tagged.',
  invalidCaptureId: (id: string) =>
    `${id} is not a capture id. Use the short id from a feed line.`,
  /**
   * An id prefix that matches more than one cached capture (#259): the count is
   * the useful fact, and the fix is always the same, more characters.
   */
  captureIdAmbiguous: (prefix: string, count: number) =>
    `${prefix} matches ${count} captures in this feed. Add more characters to make it unique.`,

  // ── view verbs ─────────────────────────────────────────────────────────────
  colored: (handle: string, color: string) => `${handle} now renders ${color}.`,
  unknownColor: (color: string, available: string[]) =>
    `No color named ${color}. Available: ${available.join(', ')} (see :colors).`,
  colorNotSupported: (color: string) =>
    `This terminal only speaks 16 colors, so ${color} is off the palette here. It unlocks on a ` +
    '256-color or truecolor terminal; see :colors for what this one renders.',
  hidden: (handle: string) => `${handle} hidden from the feed (console only, the room still hears them).`,
  shown: (handle: string) => `${handle} back in the feed.`,

  // ── feed tags (wire schema v1 §2: render and tag, never drop) ──────────────
  feedSchemaTag: (v: string) => `schema v${v}`,
  feedUnknownKind: (kind: string) => `unknown kind: ${kind}`,
  feedUnknownVerb: (verb: string) => `unknown verb: ${verb}`,
  /**
   * A JSON object body with no `text` field has no message to render, so the
   * raw body stands in - trimmed, because an untrimmed one buries the feed.
   * The tag says so and names the full size; the capture id is on the meta line.
   */
  feedBodyTrimmed: (shown: number, total: number) => `no text field, showing first ${shown} of ${total} chars`,
  feedRecipeVerbMark: 'recipe verb',
  /** The loud marker on a panic:true post. */
  feedPanicMark: 'PANIC',
  /** The re-link marker: the short id of the post this one answers. */
  feedReMark: (id: string) => `re ${id}`,
  /** The held marker beside a seat in :list roster / status output. */
  rosterHeldMark: 'held',

  // ── joining survivability (#288: the preflight and the reachable address) ──
  /** The GET /whoami answer's message member: no session, nothing spent. */
  whoamiUnseated:
    'No session rides this check: you are unseated. Reaching this answer proves the address works; ' +
    'redeem a pairing code over MCP at /mcp to take a seat.',
  /** The pass's reachability guidance (#288ii), shared with the boarding pass body. */
  passReachability,
  /** The mint command's half of the same lesson, spoken to the HOST. */
  mintReachabilityHint:
    'Hand the agent the pass as printed: a GET to <room>/whoami proves reachability without spending ' +
    'the code. The hosted room answers from anywhere; 127.0.0.1 only from this machine.',

  // ── naming integrity (#284b: the receipt warns, never refuses) ─────────────
  toReachesNobody: (to: string) =>
    `Warning: ${to} matches no wire name on the live roster. The post landed on the stream, but a seat ` +
    'filtering for its own name will not see it as addressed. Wire names are the guest names on :list seats.',

  // ── record control (#281, G1-G4 ruled: proposals are explicit, the queue is
  //    a view over the log, ratify-again replaces, retract nulls by reference) ─
  /** The feed marks: subtle bracketed tags, the render-and-tag idiom. */
  proposalPendingMark: 'needs ratification',
  proposalRatifiedMark: 'ratified',
  proposalRetractedMark: 'retracted',
  confirmRatifyAll: (n: number) =>
    `Ratify all ${n === 1 ? '1 pending decision' : `${n} pending decisions`}? y/N`,
  ratifyCancelled: 'Nothing ratified.',
  recordPickerCancelled: 'Nothing picked; the queue is unchanged.',
  nothingToRatify:
    'Nothing is pending and there is no prior ratification to renew. Seats flag a decision with ' +
    'verb fp:propose; flagged posts queue here until ratified or retracted.',
  nothingPendingRetract:
    'Nothing is pending. :retract <ref> nulls a prior ruling or withdraws a proposal by its feed reference.',
  nothingPendingReply:
    'Nothing is pending to reply to. :re is scoped to the pending queue; a plain mention answers anything else.',
  noPendingFrom: (handle: string) => `No pending proposals from ${handle}.`,
  ratified: (ref: string, preview: string | null) =>
    `Ratified ${ref}${preview ? ` (${preview})` : ''}. The ruling is on the record, re-linked to the proposal.`,
  reRatified: (ref: string, preview: string | null) =>
    `Ratified ${ref}${preview ? ` (${preview})` : ''} again. Ratifying again replaces the prior reading; ` +
    'the prose on this post is the reading that stands.',
  retractedProposal: (ref: string, preview: string | null) =>
    `Retracted ${ref}${preview ? ` (${preview})` : ''}. The proposal leaves the pending queue without a ruling.`,
  rulingNulled: (ref: string) =>
    `Ruling ${ref} nulled by reference. What it ratified is pending again.`,
  retractPosted: (ref: string) => `Retract posted against ${ref}.`,
  repliedStaysPending: (ref: string) =>
    `Reply posted against ${ref} with no disposition. The proposal stays pending; a revised ` +
    'proposal arrives as a new flagged post.',
  /** The reply receipt when the referenced decision is already dispositioned (#295). */
  repliedRe: (ref: string) =>
    `Reply posted against ${ref}, re-linked on the log. The decision keeps its state.`,
  // ── the word gavel (#295: the manner is the ruling, said out loud) ─────────
  /** The teaching echo when a reply of exactly one ratify-word performed the act. */
  wordGavelRatify: (word: string) =>
    `Read as the gavel: a reply of exactly ${word} performs the ratify act. Any other words beside it would post as discussion.`,
  wordGavelRetract: (word: string) =>
    `Read as the gavel: a reply of exactly ${word} performs the retract act. Any other words beside it would post as discussion.`,
  // ── the decision ledger (#295: a view over the log, G4 carried) ────────────
  noDecisions:
    'Nothing on the record yet. Seats flag a decision with verb fp:propose; :list decisions ' +
    'shows every proposal ever flagged with its derived state.',
  /** The console ledger row's ratifier suffix: ratified by [ruling ref]. */
  decisionRatifiedBy: (ref: string) => `by ${ref}`,
  recordPickerHeader: (mode: 'ratify' | 'retract' | 're') =>
    mode === 'ratify'
      ? 'Ratify which pending decision?'
      : mode === 'retract'
        ? 'Retract which pending proposal?'
        : 'Reply to which pending proposal?',
  recordPickerRow: (n: number, ref: string, preview: string) => `  ${n}. [${ref}] ${preview}`,
  recordPickerPrompt: 'Type a number. Enter alone cancels.',
  unknownRecordRef: (token: string) =>
    `${token} names no seat and matches no post in this feed. Give a roster handle, an 8 character ` +
    'feed reference, or nothing for the pending queue.',

  // ── scratch + strike (#282, G3: the same record-control family) ────────────
  scratchPosted:
    'Posted as scratch: out of band, on the record. Seats read scratch as commentary, never direction.',
  scratchLeakCaught: (word: string) =>
    `Read as scratch: a bare line leading with ${word} looks like console input, so it posted out of ` +
    'band, not as an order. :say posts it as room prose; :help lists the commands.',
  struckReceipt: (ref: string) =>
    `Struck ${ref}. The strike rides the log re-linked to the post, so every reader sees it struck. ` +
    'The log keeps its bylines; struck means unsaid, not deleted.',
  /** The feed mark on a struck post, the render-and-tag idiom. */
  struckMark: 'struck',
  /** The meta-line channel word beside a scratch post's byline. */
  scratchChannelMark: 'scratch',
  scratchNeedsText:
    'Scratch needs text: :scratch <commentary>. It posts out of band; seats read it as commentary, ' +
    'not direction.',
  strikeNeedsRef:
    'Strike needs a reference: :strike <ref>. The ref is the short id on a feed line.',

  // ── verb-first forgiveness (#277: the swap executes, the echo teaches) ─────
  verbFirstEcho: (canonical: string) =>
    `Read as ${canonical}. Addressed verbs go target first; the swap is automatic when the handle is on the roster.`,

  // ── errors ─────────────────────────────────────────────────────────────────
  unknownHandle: (handle: string) => `No seat answers to ${handle}. See :list seats.`,
  unknownCommand: (token: string) => `Unknown command :${token}. Type :help for the listing.`,
  verbNeedsTarget: (verb: string) => `${verb} addresses a seat: :<handle> ${verb} (or :all ${verb}).`,
  verbTakesNothing: (verb: string) =>
    `${verb} takes nothing else: :<handle> ${verb} (or :all ${verb}).`,
  installNeedsRecipe: (verb: string) =>
    `${verb} needs one recipe name: :<handle> ${verb} <recipename>.`,
  installNoAll: (verb: string) =>
    `An ${verb} order goes to one steward, never :all. The chair picks the steward: ` +
    `:<handle> ${verb} <recipename>.`,
  sayWhat: 'Say what? Put the message after the handle.',
  /**
   * A bare exit or quit on the prompt line (#259): four of these reached the
   * permanent log in two days, each one a chair reaching for the door. Nothing
   * posts; the hint names both the door and the literal-post escape hatch.
   */
  bareExitHint: (word: string) =>
    `Nothing posted: bare ${word} reads as leaving. :exit leaves the console; :say ${word} posts the word itself.`,
  whisperNeedsText: 'A whisper needs text: :<handle> whisper <message>.',
  colorNeedsColor: 'Color takes exactly one color: :<handle> color <color>. See :colors.',
  seatNeedsName: 'A seat needs a guest name: :seat <guest name>. The rest of the line is the name.',
  exitUsage: ':exit takes nothing else. Bare :exit, :quit, or :q leaves the console.',
  listUsage: 'Usage: :list projects | endpoints | seats (alias roster) | decisions.',
  setUsage:
    'Usage: :set <project>/<endpoint> binds the room in one go (the form :list endpoints prints). ' +
    'Or one half at a time: :set project <slug> | :set endpoint <slug>.',
  createUsage: 'Usage: :create endpoint <slug> (one kebab token) | :create project <name>.',
  meColorNeedsColor: 'Usage: :me color <color>. See :colors for what this terminal renders.',
  meNameNeedsName: 'Usage: :me name <name>. The rest of the line is the name.',
  collectionNeedsName: 'A collection needs a name: :collection <name>. The rest of the line is the name.',
  tagNeedsId: 'Usage: :tag <id> [collection]. The id is the short capture id on a feed line.',
  reNeedsText:
    ':re needs a message: :re [ref] <message>. It replies to a pending proposal without ruling on it.',
  invalidHandle: (token: string) => `${token} is not a handle. Handles are kebab word tokens, like the-tall-bard.`,
  apiError: (detail: string) => detail,

  // ── friendly net errors (#245: THE CHAIR LEFT is the family's exemplar) ────
  http401:
    'The server rejected your token (401). Your login may have expired: run flurryport login with a fresh token.',
  http403: (detail: string) =>
    `That needs permissions this token does not have (403).${detail ? ` ${detail}` : ''}`,
  http404: (detail: string) =>
    `The server does not know that resource (404). It may have been deleted or revoked.${detail ? ` ${detail}` : ''}`,
  http429:
    'The server asked us to slow down (429). Wait a moment and try again.',
  httpOther: (status: number, detail: string) => (detail ? detail : `The API answered ${status}.`),
  postThrottled:
    'The room asked us to slow down (429). Your post did not land; wait a moment and say it again.',
  /** The one-line wrapper the frontend puts around a mapped transport failure. */
  netTrouble: (reason: string) => `Network trouble: ${reason}.`,
  /** The feed loop reports an outage ONCE, then retries quietly with backoff. */
  feedPollTrouble: (reason: string) =>
    `The feed hit network trouble (${reason}). Retrying quietly in the background; ` +
    'you will see one line here when it recovers.',
  feedPollReconnected: 'The feed is back.',

  // ── help ───────────────────────────────────────────────────────────────────
  helpHeader: 'Console commands. Bare text posts to the room. : is the only mode shift.',
  helpAllNote:
    ':all is the every-seat range for any seat-addressed verb (except install and upgrade: those orders go ' +
    'to one steward). ! on a verb is panic: it skips confirmation and rides the wire as panic true.',
  helpUnknownTopic: (topic: string) => `No help for ${topic}. Type :help for the full listing.`,
} as const;

/** One line per verb for :help <verb> and the grouped listing. */
export const verbHelp: Record<string, string> = {
  say: 'Bare text (no colon) posts to the room as you. Everyone at the table sees it. ' +
    ':say <text> posts the words literally, even exit or quit.',
  mention: ':<handle> <text> posts a public mention: the whole table sees it, labeled to that seat.',
  whisper: ':<handle> whisper <text> posts to that seat with a to: predicate. Whispers are honor system on a shared stream.',
  seat: ':seat <guest name> mints a pairing code for a new seat. The code shows in the feed for you to ferry.',
  revoke: ':<handle> revoke ends a seat after a y/N confirm. revoke! skips the confirm (panic). ' +
    'The seat stays on the roster greyed until :<handle> delete clears it.',
  delete:
    ':<handle> delete removes a revoked or departed seat from the roster and frees its name for a fresh ' +
    'mint. Refused on a live seat: revoke first. Console local; the log keeps its bylines.',
  hold: ':<handle> hold suspends a seat; the task survives. :<handle> resume continues it; a mention with new orders releases the hold as an interrupt.',
  resume: ':<handle> resume releases a hold: continue as you were, the original task unchanged.',
  interrupt:
    ':<handle> interrupt <message> stops the current task and hands new orders in one signed act. ' +
    'Bare :<handle> interrupt is a hard stop: the task is abandoned, the seat idles. interrupt! is panic.',
  status:
    ':<handle> status (or :all status) renders the facts table (live/held/idle, expiry, last post), the ' +
    'seat\'s latest status stanza with its freshness, and posts an fp:status request the seat owes an answer to.',
  install:
    ':<handle> install <recipename> posts a signed install order to that steward. The verb commissions, it ' +
    'does not perform: the steward answers on the stream (fp:ack, or fp:refuse with reason routing, '
    + 'wording, or substance) and runs the install itself.',
  upgrade:
    ':<handle> upgrade <recipename> posts the same commissioning order with the instruction to move to the ' +
    'latest version. The steward answers on the stream.',
  color: ':<handle> color <color> sets that seat\'s feed color. Console local, never posted.',
  // #278: the old spelling still parses; its help entry teaches the rename.
  recolor: 'recolor is now color: :<handle> color <color>. The old spelling still works.',
  hide: ':<handle> hide mutes that seat in your feed. Console local, never posted.',
  show: ':<handle> show unmutes a hidden seat.',
  list: ':list projects | endpoints | seats. Endpoints and seats respect a set project; :list roster is :list seats.',
  set: ':set project <slug> scopes the console; :set endpoint <slug> completes the bind. Project plus endpoint is the room.',
  create:
    ':create endpoint <slug> makes a new endpoint in the set project, born signed: inbound HMAC signing is ' +
    'enabled at creation, so the room never takes an unsigned post. An API act with a feed receipt, not a post.',
  me:
    ':me shows your byline and color; :me name <name> renames the byline on your posts (the wire address ' +
    'and the signature never move); :me color <color> paints your own posts. A bare :me <x> guesses: a ' +
    'known color name sets color, anything else the byline, and the reply says which. Console local, persisted.',
  collection:
    ':collection <name> creates or binds a capture collection for this session. Tagged captures are pinned: ' +
    'retention exempt. An API act with a feed receipt, not a post.',
  tag:
    ':tag <id> <collection> pins the capture with that feed id into a collection. Bare :tag <id> lists your ' +
    'collections as a numbered pick. An API act with a feed receipt, not a post.',
  ratify:
    ':ratify gavels pending decisions. Seats flag a decision with verb fp:propose and a one line ' +
    'summary; flagged posts queue until dispositioned. Bare :ratify with items pending offers to ' +
    'ratify them all; with nothing pending it renews the previous ratification (ratifying again ' +
    'replaces the prior reading). :ratify <handle> takes that seat\'s pending proposals; ' +
    ':ratify <ref> is explicit; prose after the target scopes the ruling.',
  retract:
    ':retract <ref> nulls a prior ruling or withdraws a pending proposal by its feed reference. ' +
    'Bare :retract opens the pending picker. The null propagates on the log: a nulled ruling ' +
    'returns its proposal to the pending queue.',
  re:
    ':re [ref] <message> replies to a pending proposal without ruling on it: the chair\'s middle move. ' +
    'With several pending it opens the picker; the reply posts plain, re-linked to the proposal, and ' +
    'the item stays pending. A reply of exactly ratify, ratified, retract, or retracted performs ' +
    'that act instead: the word is the gavel, and any other words beside it post as discussion.',
  scratch:
    ':scratch <text> posts out-of-band commentary: on the record, filterable, never direction. A bare ' +
    'line leading with a command word lands here too, so a missed colon cannot read as an order.',
  strike:
    ':strike <ref> unsays the referenced post for every reader: the strike rides the log re-linked to ' +
    'it, and feeds render the post struck. The log keeps its bylines; struck means unsaid, not deleted.',
  colors: ':colors lists the palette this terminal renders, each name in its own color. 256-color and truecolor terminals unlock extra names, purple included.',
  help: ':help lists everything; :help <verb> explains one; :<family> help (like :list help) scopes to a family.',
  all: ':all addresses every seat: :all hide, :all hold, :all interrupt <text>, :all status (the roll call), :all revoke, :all <text>. Install and upgrade take one steward instead.',
  exit:
    ':exit leaves the console (synonyms :quit, :q). Ctrl+C and Ctrl+D do the same. ' +
    'If this console hosts the room, the room closes with it.',
};

/** The grouped :help listing, by command class (context / view / stream). */
export const helpListing: Array<{ group: string; lines: string[] }> = [
  {
    group: 'Context (read only, post nothing)',
    lines: [':list projects', ':list endpoints', ':list seats (alias :list roster)', ':list decisions', ':set project <slug>', ':set endpoint <slug>', ':colors', ':help [verb], :commands, :<family> help', ':exit (or :quit, :q) leave the console'],
  },
  {
    group: 'Build and curate (API acts with feed receipts, never posts)',
    lines: [':create endpoint <slug>  born signed', ':collection <name>', ':tag <id> [collection]  bare id opens the picker'],
  },
  {
    group: 'View (console local, persisted, never posted)',
    lines: [':<handle> color <color>', ':<handle> hide', ':<handle> show', ':<handle> delete  drop a revoked seat, free its name', ':me name <name>  your byline', ':me color <color>  your own feed color'],
  },
  {
    group: 'Stream (signed acts on the room)',
    lines: ['<bare text> post to the room', ':say <text>  post the words literally, even exit or quit', ':<handle> <text> mention (public, to: labeled)', ':<handle> whisper <text>', ':seat <guest name> mint a pairing code', ':<handle> revoke (y/N; revoke! skips the confirm)'],
  },
  {
    group: 'Record control (signed acts on the record)',
    lines: [
      ':ratify [handle|ref]  gavel pending decisions (bare offers all pending, or renews the last ruling)',
      ':retract [ref]  null a ruling or withdraw a proposal by reference',
      ':re [ref] <message>  reply to a pending proposal without ruling on it',
      ':scratch <text>  out-of-band commentary, never direction',
      ':strike <ref>  unsay a post by reference; every reader sees it struck',
    ],
  },
  {
    group: 'Attention and orders (signed acts; the target owes an answer)',
    lines: [
      ':<handle> hold  suspend; the task survives',
      ':<handle> resume  continue as you were',
      ':<handle> interrupt [message]  bare = hard stop, message = redirect',
      ':<handle> status  facts table, latest stanza, and a status request (:all status is the roll call)',
      ':<handle> install <recipename>  commission the steward (also :<handle> upgrade <recipename>)',
    ],
  },
];
