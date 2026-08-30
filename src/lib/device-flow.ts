import { randomBytes } from 'node:crypto';
import { AnonApiError, type AnonApiClient, type PollDeviceHandoffResponse } from './anon-api.js';
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
        this.done = true;
        this.stop();
        await this.onToken(res.Token, res);
      }
    } catch (err) {
      // 404 = the hand-off lapsed (15-min TTL) — re-register on the next tick.
      if (err instanceof AnonApiError && err.status === 404) this.registered = false;
    }
  }
}
