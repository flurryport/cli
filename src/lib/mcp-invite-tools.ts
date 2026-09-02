import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AnonApiError, type PollDeviceHandoffResponse } from './anon-api.js';
import { classifyCeremonyState, createInviteJoinClient, type CeremonyState } from './invite-api.js';
import { contributorKeyRef, putCredential } from './keystore.js';
import { participantAccountName } from './config.js';

/**
 * `join_invite` — the AGENT's door into the invite rail (F0, 2026-07-23).
 *
 * Why this tool exists, and why it is not just a convenience:
 * accepting an invite used to be reachable ONLY as `flurryport join`, a CLI command. An
 * agent cannot call a CLI command from its tool surface, so agents did the obvious thing
 * instead: drove the raw device flow over HTTP, where the poll response hands back the raw
 * contributor signing key. That put key material straight into model context, contradicting
 * the custody promise on /recipes/security. The fix is to make the custody-preserving path
 * REACHABLE: this tool runs the whole ceremony inside the MCP server process, writes the key
 * to the local keystore, and returns a receipt carrying NO credential of any kind.
 *
 * Honest scope: this does not (and cannot) prevent an agent from polling the raw endpoint
 * itself — the agent is the invitee's own software, acting with the invitee's authority, and
 * the server cannot tell one poller from another. What it does is make the good path the easy
 * path, and guarantee that OUR tool surface never emits key material. The landing copy points
 * here rather than at the raw poll URL.
 *
 * Resumable rather than blocking: the first call arms the channel and returns the human
 * acceptance URL; later calls poll briefly and report progress. Nothing here blocks an MCP
 * request for the length of a human's inbox round trip.
 */

export interface InviteToolContext {
  /** Base URL for the invite/device routes; the landing's own host. */
  resolveBaseUrl: () => string;
  /**
   * Called once a grant is released. Implementations persist the scoped PAT and, when the
   * session is anonymous, flip it to authenticated so the SAME tools answer from the guest
   * credential (F6). Returns how the session was affected, for the receipt. On an authed
   * boot, `switchSession` is the caller's explicit opt-in (rung 2) to swap the in-process
   * client to the guest grant instead of only parking it.
   */
  onJoined: (
    release: PollDeviceHandoffResponse,
    opts: { switchSession: boolean; accountName: string },
  ) => Promise<SessionEffect>;
  /**
   * Rung 2 (run-2 finding #1): an authed boot that parked a grant can honor a LATER
   * switchSession request without re-running the (one-shot) ceremony. Returns true when the
   * in-process client now answers as the guest grant. Absent on boots that cannot park.
   */
  onSwitchToGuest?: () => Promise<boolean>;
}

// 'routed' (0.3.0 credential router): the grant parked AND joined this session's router,
// so reads of the joined endpoint answer as the guest credential with no switch and no
// restart — the signed-in identity stays the default for everything else.
export type SessionEffect = 'session_upgraded' | 'stored_only' | 'session_switched' | 'routed';

/** Device codes live for the process lifetime, keyed by invite token, so a second call resumes. */
const pending = new Map<string, {
  deviceCode: string;
  baseUrl: string;
  startedAt: number;
  lastLandingCheckAt: number;
  /** Set when the landing first showed accepted-but-uncollected: the accept-race grace clock. */
  acceptedSeenAt?: number;
  /**
   * A release already collected from the server but not yet fully persisted
   * (round 3): the release is ONE-SHOT - a keystore lock during putCredential
   * must not lose the contributor key forever. Held in memory; the next
   * join_invite call retries the persist from here instead of re-polling a
   * channel the server already closed.
   */
  collected?: PollDeviceHandoffResponse;
}>();

/** How often a pending poll may double-check the landing's honest signals. (Env knob is for tests.) */
const LANDING_CHECK_INTERVAL_MS = Number(process.env.FLURRYPORT_LANDING_CHECK_MS) || 30_000;

/**
 * Accept-race grace (round-7 finding, 2026-08-13): accepted-with-no-collection is ALSO
 * the normal transient state between the human's click and the next collecting poll.
 * Round 6 died healthy because the first sight of that state was declared terminal.
 * Now it starts a grace clock instead; only persistence past this window is death.
 * (Env knob is for tests.)
 */
const ACCEPT_COLLECT_GRACE_MS = Number(process.env.FLURRYPORT_ACCEPT_GRACE_MS) || 30_000;

/**
 * The terminal answer for a ceremony that cannot complete on this channel, by landing
 * state. Every branch says what is KNOWN and what to do - never the old catch-all
 * channel_expired (pilot-1 ledger item 2).
 */
function ceremonyDeathAnswer(state: CeremonyState) {
  switch (state) {
    case 'grant_collected':
      return fail('grant_already_collected',
        'This invite\'s grant was already collected - by another device\'s ceremony, not this one. ' +
        'The release is one-shot, so this channel can never complete. If that other collection was ' +
        'yours, use the credential it stored; otherwise ask your host for a fresh invite.');
    case 'accepted_no_release':
      return fail('accepted_without_release',
        'The invite shows as ACCEPTED but no grant released to this channel, and none ever will. ' +
        'The known cause: the endpoint OWNER accepted their own invite, which silently voids the ' +
        'grant (the landing page permits it and says nothing). Ask your host to mint a fresh invite ' +
        'and have it accepted by an account that does NOT own the endpoint.');
    case 'invite_gone':
      return fail('invite_not_valid',
        'That invite is no longer valid: expired, revoked, or never existed (one answer by design). ' +
        'Ask whoever invited you for a fresh link.');
    case 'live':
      return fail('channel_expired',
        'The credential channel expired before acceptance, but the invite itself still stands. ' +
        'Call join_invite again with the same invite to arm a fresh channel, then have your human accept.');
  }
}

/**
 * Completed joins, keyed by invite token. Invites are one-shot on the server, so a re-call
 * after collection must answer from memory (the idempotency the tool already declares), and a
 * re-call with switchSession true is the rung-2 post-hoc opt-in: switch this session to the
 * already-parked grant. Holds receipt facts only - never key material or the token itself.
 */
interface CompletedJoin {
  projectId: string | null;
  endpointId: string | null;
  recipeRef: string | null;
  role: string;
  signingConfigured: boolean;
  sessionEffect: SessionEffect;
  /** CLI account the grant parked under — the invite's participant name, or 'guest'. */
  accountName: string;
  /** The participant name as the host gave it (null on unnamed invites / older servers). */
  participantName: string | null;
}
const completed = new Map<string, CompletedJoin>();

/** Accept a bare fpi_ token or any landing URL containing one. */
function extractToken(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.startsWith('fpi_')) return trimmed.split(/[?#\s]/)[0] ?? null;
  const match = trimmed.match(/fpi_[A-Za-z0-9_-]+/);
  return match ? match[0] : null;
}

export function registerInviteTools(server: McpServer, ctx: InviteToolContext): RegisteredTool[] {
  const registered: RegisteredTool[] = [];

  registered.push(server.registerTool(
    'join_invite',
    {
      title: 'Join invite',
      description:
        'Accept a collaboration invite your human was given, either a link or an fpi_ token, and set THIS ' +
        'session up to use it. Two calls: the first arms a credential channel and returns the URL your ' +
        'human opens to accept with their own email, the second collects the grant after they say they ' +
        'accepted. Inputs: invite, pasted exactly as received, and switchSession. Returns the endpoint you ' +
        'may now use, never a token and never a key. A producer invite also writes a signing key into the ' +
        'local keystore, so post_intent signs from then on. Never submit an email address yourself. If you ' +
        'are holding raw key material, you took a path that was not this one.',
      inputSchema: {
        invite: z.string().min(4).max(2000)
          .describe('The invite link or the fpi_ token from it. Paste it exactly as you received it.'),
        switchSession: z.boolean().optional()
          .describe(
            'Only meaningful when this MCP session booted already signed in to a FlurryPORT account ' +
            '(the join receipt would say session "stored_only"): pass true to switch THIS session to ' +
            'the guest grant in-process, so reads of the joined endpoint work here immediately. ' +
            'Memory-only: nothing about the signed-in account changes on disk, and restarting the ' +
            'MCP server boots back as that account. Works on the collecting call, or on a call AFTER ' +
            'a stored_only receipt. Omit to keep answering as the signed-in account (the grant still ' +
            'parks as a CLI account named for the participant, or "guest" when unnamed).'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ invite, switchSession }) => {
      const token = extractToken(invite);
      if (!token) {
        return fail('invalid_invite',
          'That does not contain a FlurryPORT invite token. An invite token starts with "fpi_"; ' +
          'paste the whole link you were given.');
      }

      // Re-calls after collection answer from memory: the ceremony is one-shot server-side, so
      // re-arming would only refuse. This is also rung 2's post-hoc opt-in moment: a join that
      // went stored_only can be switched later by re-calling with switchSession true.
      const done = completed.get(token);
      if (done) {
        if (switchSession && (done.sessionEffect === 'stored_only' || done.sessionEffect === 'routed')
          && ctx.onSwitchToGuest && (await ctx.onSwitchToGuest())) {
          done.sessionEffect = 'session_switched';
        }
        return ok(joinedReceipt(done));
      }

      const baseUrl = ctx.resolveBaseUrl();
      const client = createInviteJoinClient(baseUrl);
      let entry = pending.get(token);

      // First call: arm the channel and hand the human step back to the agent's user.
      if (!entry) {
        const deviceCode = randomBytes(32).toString('base64url');
        try {
          await client.registerInviteDevice(token, deviceCode);
        } catch (err) {
          return mapError(err);
        }
        entry = { deviceCode, baseUrl, startedAt: Date.now(), lastLandingCheckAt: Date.now() };
        pending.set(token, entry);
        return ok({
          status: 'awaiting_human',
          acceptanceUrl: client.landingUrl(token),
          nextStep:
            'Ask your human to open acceptanceUrl, enter THEIR OWN email, and click the link they receive. ' +
            'The email step is theirs: do not type an address into any form yourself. The acceptor must NOT ' +
            'be the endpoint owner - an owner accepting their own invite silently voids the grant. When ' +
            'they say they have accepted, call join_invite again with the same invite to collect the grant.',
        });
      }

      // Later calls: poll once. Pending is the normal answer before the human clicks.
      // A release already collected but not persisted (round 3) skips the poll and
      // retries the persist from memory - the server will not repeat the release.
      let release: PollDeviceHandoffResponse;
      if (entry.collected) {
        release = entry.collected;
      } else {
      try {
        release = await client.pollInviteDevice(entry.deviceCode);
      } catch (err) {
        if (err instanceof AnonApiError && err.status === 404) {
          // The channel died. Pilot-1 ledger item 2: this used to be reported as
          // channel_expired unconditionally, when the usual cause was a DEAD INVITE
          // (spent, voided by owner-accept, or collected by another device) killing the
          // channel within seconds of arming. Ask the landing what actually happened -
          // grantCollectedAt/status are the honest ceremony signals - and only call it
          // a TTL expiry when the invite still stands.
          pending.delete(token);
          const landing = await client.getLanding(token).catch(() => null);
          // Null landing = unknown (network blip): answer channel_expired so the agent
          // re-arms; a truly dead invite refuses the re-arm loudly on the next call.
          return ceremonyDeathAnswer(landing ? classifyCeremonyState(landing) : 'live');
        }
        return mapError(err);
      }

      if (release.Status !== 'complete' || !release.Token) {
        // Acceptance already seen: we are in the accept-race grace. The collecting poll
        // above just returned pending; either the grant releases within the grace window
        // (the next call collects it) or the death is real.
        if (entry.acceptedSeenAt) {
          if (Date.now() - entry.acceptedSeenAt >= ACCEPT_COLLECT_GRACE_MS) {
            pending.delete(token);
            return ceremonyDeathAnswer('accepted_no_release');
          }
          return ok({
            status: 'accepted_collecting',
            waitedSeconds: Math.round((Date.now() - entry.startedAt) / 1000),
            nextStep:
              'Acceptance is recorded; the grant has not released to this channel yet, which is normal ' +
              'for a few seconds after the click. Call join_invite again right away to collect. If this ' +
              'state persists past about 30 seconds, the ceremony is declared dead honestly.',
          });
        }
        // Still pending on OUR channel - but the ceremony may already be over elsewhere
        // (rounds 1-3 of pilot-1: the owner accepted their own invite and every poll sat
        // on "pending" forever). Check the landing's honest signals before promising the
        // human step is still worth waiting on - at most every 30s, so the extra GET
        // never crowds the invite routes' throttle. A null landing read is UNKNOWN
        // (network blip), never a verdict.
        if (Date.now() - entry.lastLandingCheckAt >= LANDING_CHECK_INTERVAL_MS) {
          entry.lastLandingCheckAt = Date.now();
          const landing = await client.getLanding(token).catch(() => null);
          if (landing) {
            const landingState = classifyCeremonyState(landing);
            if (landingState === 'grant_collected') {
              pending.delete(token);
              return ceremonyDeathAnswer(landingState);
            }
            if (landingState === 'accepted_no_release') {
              // Start the grace clock and poll once more immediately - the common case
              // is a grant released milliseconds ago, collectable right now.
              entry.acceptedSeenAt = Date.now();
              try {
                const retry = await client.pollInviteDevice(entry.deviceCode);
                if (retry.Status === 'complete' && retry.Token) release = retry;
              } catch {
                /* the grace path above handles persistence; a poll error here is not terminal */
              }
              if (release.Status !== 'complete' || !release.Token) {
                return ok({
                  status: 'accepted_collecting',
                  waitedSeconds: Math.round((Date.now() - entry.startedAt) / 1000),
                  nextStep:
                    'Acceptance is recorded; the grant is releasing to this channel. Call join_invite ' +
                    'again right away to collect it.',
                });
              }
            }
          }
        }
        if (release.Status !== 'complete' || !release.Token) {
          return ok({
            status: 'awaiting_human',
            acceptanceUrl: client.landingUrl(token),
            waitedSeconds: Math.round((Date.now() - entry.startedAt) / 1000),
            nextStep:
              'Not accepted yet. Your human still needs to open acceptanceUrl, enter their own email, and ' +
              'click the emailed link. IMPORTANT: the acceptor must NOT be the endpoint owner - an owner ' +
              'accepting their own invite silently voids the grant. Give them a few seconds and call ' +
              'join_invite again rather than polling in a tight loop.',
          });
        }
      }
      }

      // Released. The key stops here: keystore, never the response. The pending
      // entry survives (holding the release) until BOTH persists succeed - the
      // release is one-shot and must never be lost to a transient keystore lock.
      entry.collected = release;
      let signingConfigured = false;
      if (release.SigningKey && release.ContributorEndpointId) {
        try {
          putCredential(contributorKeyRef(release.ContributorEndpointId), {
            type: 'contributor',
            value: release.SigningKey,
            createdAt: new Date().toISOString(),
          });
        } catch (persistErr) {
          return fail(
            'credential_store_failed',
            `The grant was collected but the contributor key could not be stored (${(persistErr as Error).message}). ` +
            'Nothing is lost: the grant is held in memory for this session. Call join_invite again with the ' +
            'same invite to retry storing it.',
          );
        }
        signingConfigured = true;
      }
      pending.delete(token);

      const accountName = participantAccountName(release.ParticipantName);
      const sessionEffect = await ctx.onJoined(release, {
        switchSession: Boolean(switchSession),
        accountName,
      });

      // Discovery bridge (2026-07-24, from the producer runs): agents joined and then posted
      // WITHOUT reading the recipe, because nothing walked them from "this invite names recipe
      // X" to get_recipe(X). They improvised a schema and, not knowing their role, opened games
      // they should have waited on - which raced two agents into two parallel games. Surface the
      // recipeRef here and steer to get_recipe FIRST, so the protocol, roles, first-mover, and
      // canonicalization are learned before the first post. Best-effort; a missing landing just
      // omits the ref.
      const landing = await client.getLanding(token).catch(() => null);
      const recipeRef = landing?.recipeRef ?? null;

      const facts: CompletedJoin = {
        projectId: release.ContributorProjectId ?? null,
        endpointId: release.ContributorEndpointId ?? null,
        recipeRef,
        role: landing?.role ?? (signingConfigured ? 'producer' : 'monitor'),
        signingConfigured,
        sessionEffect,
        accountName,
        participantName: release.ParticipantName ?? null,
      };
      completed.set(token, facts);
      return ok(joinedReceipt(facts));
    },
  ));

  return registered;
}

/** Build the joined receipt from stored facts - one shape for fresh joins and idempotent re-calls. */
function joinedReceipt(facts: CompletedJoin): Record<string, unknown> {
  // A release without a signing key IS the guest-grant (monitor) lane regardless of how
  // the landing labels the role - only producers ride the ContributorKey channel.
  const isMonitor = facts.role === 'monitor'
    || (!facts.signingConfigured && facts.role !== 'producer');
  // Run-3 blocker: older servers release a monitor grant WITHOUT its endpoint binding,
  // and a receipt that says "the endpointId above" while both ids are null sends the
  // agent to guess among endpoints it cannot enumerate (it rightly refused). Every
  // steer below must degrade to "ask your host" when the ids are absent.
  const idsKnown = Boolean(facts.projectId && facts.endpointId);
  const whereToRead = idsKnown
    ? 'using the projectId and endpointId in this receipt'
    : 'once you have its ids - this receipt did not carry the endpoint binding (an older ' +
      'server), so ask the human who invited you for the projectId and endpointId of the ' +
      'endpoint you were granted';

  // Role-specific steer (run-3 debrief): a monitor must never receive producer setup -
  // posting, signing, or "who moves first" guidance. It reads and reports.
  const readFirst = isMonitor
    ? (facts.recipeRef
        ? `The collaboration you are watching follows a recipe: call get_recipe with recipeRef ` +
          `"${facts.recipeRef}" to learn its message schema and participants, so your reports use ` +
          'the protocol\'s own vocabulary. '
        : '') +
      'You are a monitor: ' +
      (facts.sessionEffect === 'stored_only'
        ? 'once this session switches to the grant (see above), read'
        : 'read') +
      ` the endpoint with list_captures ${whereToRead}; monitors do not send events.`
    : facts.recipeRef
      ? `Before you post anything, call get_recipe with recipeRef "${facts.recipeRef}" and follow it: it ` +
        'defines the message schema, WHICH PARTICIPANT YOU ARE, who moves first, and the exact ' +
        'canonicalization (how to hash or sign). You are the INVITEE who just joined - do not assume ' +
        'you open or move first; the recipe says who does. If get_recipe fails, post a plain note to ' +
        'the endpoint saying you could not read the protocol and wait for the host, rather than ' +
        'inventing a schema.'
      : 'Before you post, read the protocol this collaboration follows (the invite named a recipe; ' +
        'fetch it with get_recipe or search_recipes). You are the INVITEE who just joined - do not ' +
        'assume you open or move first. If you cannot find the protocol, post a plain note saying so ' +
        'and wait for the host rather than inventing a schema.';

  // Invitee-boot rung 1 (run-2 finding #1): on an authed boot the grant is PARKED
  // (stored_only) and this session keeps answering as the original account, so reads of
  // the joined endpoint return not_found with no explanation - the likeliest real invitee
  // is an EXISTING user, and this fallthrough has cost a live human ~20 minutes three runs
  // in a row. Say exactly what happened and the ways out, in the receipt itself. Rung 2:
  // the switch is available in-session, but ONLY as an explicit switchSession opt-in -
  // never silently.
  const sessionNotice = facts.sessionEffect === 'routed'
    ? 'THIS SESSION now reads the joined endpoint automatically: requests naming the ' +
      'endpointId in this receipt route through the guest grant (the credential router), ' +
      'while everything else keeps answering as the signed-in account. No switching, no ' +
      `restart; the grant is parked as CLI account '${facts.accountName}' and the routing ` +
      'survives restarts. ' +
      (facts.signingConfigured
        ? 'post_intent signs with the locally stored key as before. '
        : '') +
      'If you ever need the WHOLE session repointed at the grant instead, call join_invite ' +
      'again with switchSession true.'
    : facts.sessionEffect === 'stored_only'
    ? 'THIS SESSION DID NOT SWITCH to the invite grant: it still answers as the account that ' +
      'was already signed in here (a signed-in session is never silently repointed at a guest ' +
      'credential). Reads of the joined endpoint from this session (list_captures, get_endpoint, ' +
      'wait_for_captures) will return not_found - that is this session\'s scope, not a broken ' +
      'invite. ' +
      (facts.signingConfigured
        ? 'post_intent still works from here: it signs with the locally stored key and posts to ' +
          'the public intake. '
        : 'As a monitor, this session cannot see the joined endpoint at all until the switch ' +
          'below happens. ') +
      `The grant is parked as CLI account '${facts.accountName}'. To read the joined endpoint, call join_invite ` +
      'again with the same invite and switchSession true to switch THIS session to the grant ' +
      '(memory-only; restarting the MCP server boots back as the signed-in account). Or your ' +
      `human runs 'flurryport account use ${facts.accountName}' and restarts this MCP server (switching back ` +
      "afterwards with 'flurryport account use <their account>'), or boots a second MCP server " +
      `pinned to the grant with 'flurryport mcp --account ${facts.accountName}' (or env FLURRYPORT_ACCOUNT=${facts.accountName}), ` +
      'which never touches their active account.'
    : facts.sessionEffect === 'session_switched'
      ? 'THIS SESSION SWITCHED to the invite grant: it now answers as a guest credential scoped ' +
        'to the joined endpoint' +
        (idsKnown
          ? ', so use the projectId and endpointId in this receipt. '
          : '. This receipt did not carry the endpoint binding (an older server); ask the human ' +
            'who invited you for the projectId and endpointId. ') +
        `The signed-in account is untouched on disk (the grant is also parked as CLI account '${facts.accountName}'), ` +
        'and restarting this MCP server boots back as that account; until then, reads of that ' +
        "account's own projects from here answer not_found." +
        (facts.signingConfigured
          ? ' post_intent signs with the locally stored key as before.'
          : '')
      : null;

  return {
    status: 'joined',
    projectId: facts.projectId,
    endpointId: facts.endpointId,
    recipeRef: facts.recipeRef,
    role: facts.role,
    // Who you ARE on this stream: the host named this participant, and the same name is
    // the signer label on posts, the watch label others orient by, and the CLI account.
    participantName: facts.participantName,
    accountName: facts.accountName,
    signingConfigured: facts.signingConfigured,
    session: facts.sessionEffect,
    ...(sessionNotice ? { sessionNotice } : {}),
    nextStep:
      (sessionNotice ? sessionNotice + ' ' : '') +
      readFirst +
      (facts.signingConfigured
        ? ' Once you know the protocol, send events with post_intent using the projectId and ' +
          'endpointId above; it signs with the stored key automatically, so you never handle the key.'
        : ''),
  };
}

function ok(payload: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...payload }, null, 2) }] };
}

function fail(code: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: { code, message } }, null, 2) }],
    isError: true as const,
  };
}

function mapError(err: unknown) {
  if (err instanceof AnonApiError) {
    if (err.status === 404) {
      // 404-not-an-oracle: revoked, expired and never-existed are one answer by design.
      return fail('invite_not_valid',
        'That invite is not valid. It may have expired, been revoked, or never existed. Ask whoever ' +
        'invited you for a fresh link.');
    }
    if (err.status === 429) {
      return fail('throttled', 'Too many attempts against this invite. Wait a moment and try again.');
    }
    return fail(err.code || 'error', err.detail || 'The invite service refused that request.');
  }
  return fail('unreachable',
    `Could not reach the FlurryPORT invite service: ${(err as Error).message}`);
}
