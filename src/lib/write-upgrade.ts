import { randomBytes } from 'node:crypto';
import { AuthApiError, type AuthApiClient } from './auth-api.js';

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
        this.done = true;
        this.stop();
        await this.onGranted(res.Token);
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
}
