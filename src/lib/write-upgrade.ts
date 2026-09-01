import { randomBytes } from 'node:crypto';
import { AuthApiError, type AuthApiClient } from './auth-api.js';
import { BoundedDelivery } from './one-shot-delivery.js';

/**
 * Client half of the in-flow write grant (ratified 2026-07-20): once authenticated
 * (read-only), the MCP server arms a SECOND device-flow hand-off and quietly polls.
 * When the human clicks [Grant write access] on the secret-setup page, the server
 * releases a read-write sibling PAT exactly once — onGranted swaps the running
 * toolset's client in place, no restart. [Skip] arrives as onSkipped exactly once,
 * so the agent can narrate what stays manual.
 *
 * Same custody discipline as DeviceFlowController: the device code never leaves this
 * process except to the register/poll endpoints. Registration is authenticated (the
 * read-only PAT may ASK to wait; only the human's click releases anything) and the
 * server refuses tokens that already have write (409 — we stop arming for good).
 *
 * The grant decision is DURABLE server-side, so arming and clicking can happen in
 * either order; the poll finds the decision whenever it lands.
 */
export class WriteUpgradeController {
  private readonly deviceCode = randomBytes(32).toString('base64url');
  private timer: ReturnType<typeof setInterval> | null = null;
  private registered = false;
  private done = false;
  private alreadyWrite = false;
  private startedAt = 0;
  /**
   * A granted token whose onGranted callback has not succeeded yet (hardening
   * precedent #7): the release is one-shot, so it is held in memory and the
   * callback retried each tick rather than discarded on a persist throw.
   */
  private pendingGrant: string | null = null;
  /** In-flight latch + bounded retry for delivery (shared protocol, round 3). */
  private readonly delivery = new BoundedDelivery();

  constructor(
    private readonly getClient: () => AuthApiClient,
    private readonly onGranted: (token: string) => void | Promise<void>,
    private readonly onSkipped: () => void | Promise<void>,
    private readonly pollIntervalMs = 5_000,
    /** Give up after this long with no decision; a later arm re-starts the wait. */
    private readonly maxWaitMs = 2 * 60 * 60 * 1000,
  ) {}

  /** Idempotent — called whenever a secret-setup ceremony is (or may be) in flight. */
  ensureStarted(): void {
    if (this.timer || this.done || this.alreadyWrite) return;
    this.startedAt = Date.now();
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    // Never hold the process open just to poll — stdio closing should end the CLI.
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.done) return;
    // A delivery in flight, or a one-shot grant collected but not yet delivered:
    // never re-poll a release the server will not repeat. The concurrency guard
    // itself lives INSIDE deliverGrant (round 3: a tick-entry-only latch missed
    // already-in-flight poll responses).
    if (this.delivery.inFlight) return;
    if (this.pendingGrant) {
      await this.deliverGrant(this.pendingGrant);
      return;
    }
    if (Date.now() - this.startedAt > this.maxWaitMs) {
      // Nothing decided in hours — stand down. registered stays false so a later
      // ensureStarted arms a fresh wait against the (re-registerable) hand-off.
      this.stop();
      this.registered = false;
      return;
    }

    if (!this.registered) {
      try {
        await this.getClient().post('/api/v1/device/write-upgrade', { DeviceCode: this.deviceCode });
        this.registered = true;
      } catch (err) {
        if (err instanceof AuthApiError && err.status === 409) {
          // already_write: this token has nothing to upgrade — stop for good.
          this.alreadyWrite = true;
          this.stop();
        }
        return; // network hiccup or auth issue — retry next tick
      }
    }

    try {
      const res = (await this.getClient().post('/api/v1/anon/device/poll', { DeviceCode: this.deviceCode })) as {
        Status?: string;
        Token?: string | null;
      };
      if (res.Status === 'complete' && res.Token) {
        this.pendingGrant = res.Token;
        await this.deliverGrant(res.Token);
      } else if (res.Status === 'skipped') {
        this.done = true;
        this.stop();
        await this.onSkipped();
      }
    } catch (err) {
      // 404 = the hand-off lapsed (30-min TTL) — re-register on the next tick.
      if (err instanceof AuthApiError && err.status === 404) this.registered = false;
    }
  }

  /**
   * Complete the grant through the shared bounded-delivery protocol
   * (one-shot-delivery.ts): done/stop only after onGranted succeeds; failures
   * retry from memory under a cap; a second in-flight poll's response is
   * skipped, never a concurrent second invocation of the callback.
   */
  private async deliverGrant(token: string): Promise<void> {
    if (this.done) return;
    const outcome = await this.delivery.run(() => this.onGranted(token), {
      retry: (reason) => `Write grant collected but activating it failed (${reason}); retrying.`,
      giveUp: (reason) =>
        `Write grant collected but activating it kept failing (${reason}). ` +
        'Giving up: check that ~/.flurryport is writable, then generate a read-write token in Settings and ' +
        'install it with `flurryport login <token>`.',
    });
    if (outcome === 'done' || outcome === 'gave_up') {
      this.pendingGrant = null;
      this.done = true;
      this.stop();
    }
  }
}
