import { randomBytes } from 'node:crypto';
import { AnonApiError, type AnonApiClient, type PollDeviceHandoffResponse } from './anon-api.js';
import { BoundedDelivery } from './one-shot-delivery.js';
import type { StoredAnonSession } from './anon-session.js';

/**
 * Client half of the device-flow hand-off (spec §6): the moment an anon session exists,
 * register a CLI-generated high-entropy device code and quietly poll for the claim.
 * When the user signs up in the browser and the claim lands, the server releases a
 * read-only PAT exactly once — onToken flips the MCP server to authenticated mode.
 *
 * The device code is the ONLY key to that release and never leaves this process except
 * to the register/poll endpoints. It is deliberately NOT the anon session token, which
 * is public by design (it rides the capture URL handed to webhook providers).
 */
export class DeviceFlowController {
  private readonly deviceCode = randomBytes(32).toString('base64url');
  private timer: ReturnType<typeof setInterval> | null = null;
  private session: StoredAnonSession | null = null;
  private registered = false;
  private done = false;
  /**
   * A collected release whose onToken callback has not succeeded yet (hardening
   * precedent #7). The server releases the PAT exactly ONCE - if the persist
   * callback throws after collection, the token would otherwise be discarded and
   * the human left silently unauthenticated. Held in memory and retried each tick.
   */
  private pendingRelease: PollDeviceHandoffResponse | null = null;
  /** In-flight latch + bounded retry for delivery (shared protocol, round 3). */
  private readonly delivery = new BoundedDelivery();

  constructor(
    private readonly client: AnonApiClient,
    private readonly onToken: (token: string, release: PollDeviceHandoffResponse) => void | Promise<void>,
    private readonly pollIntervalMs = 10_000,
  ) {}

  /** Idempotent — called from tool handlers whenever a live session is in hand. */
  ensureStarted(session: StoredAnonSession): void {
    this.session = session;
    if (this.timer || this.done) return;
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
    if (this.done || !this.session) return;
    // A delivery in flight, or a one-shot release collected but not yet
    // delivered: never re-poll a release the server will not repeat. The
    // concurrency guard itself lives INSIDE deliver (round 3: a tick-entry-only
    // latch missed already-in-flight poll responses).
    if (this.delivery.inFlight) return;
    if (this.pendingRelease) {
      await this.deliver(this.pendingRelease);
      return;
    }

    if (!this.registered) {
      try {
        await this.client.registerDeviceHandoff(this.session.token, this.deviceCode);
        this.registered = true;
      } catch {
        return; // session gone or network hiccup — retry next tick
      }
    }

    try {
      const res = await this.client.pollDeviceHandoff(this.deviceCode);
      if (res.Status === 'complete' && res.Token) {
        this.pendingRelease = res;
        await this.deliver(res);
      }
    } catch (err) {
      // 404 = the hand-off lapsed (15-min TTL) — re-register on the next tick.
      if (err instanceof AnonApiError && err.status === 404) this.registered = false;
    }
  }

  /**
   * Complete the hand-off through the shared bounded-delivery protocol
   * (one-shot-delivery.ts): done/stop only after onToken succeeds; failures
   * retry from memory under a cap; a second in-flight poll's response is
   * skipped, never a concurrent second invocation of the callback.
   */
  private async deliver(release: PollDeviceHandoffResponse): Promise<void> {
    if (this.done) return;
    const outcome = await this.delivery.run(() => this.onToken(release.Token!, release), {
      retry: (reason) => `Claim collected but activating it failed (${reason}); retrying.`,
      giveUp: (reason) =>
        `Claim collected but activating it kept failing (${reason}). ` +
        'Giving up: check that ~/.flurryport is writable, then run `flurryport login <token>` with a token ' +
        'from Settings (the claimed account exists; only this session could not store it).',
    });
    if (outcome === 'done' || outcome === 'gave_up') {
      this.pendingRelease = null;
      this.done = true;
      this.stop();
    }
  }
}
