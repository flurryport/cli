/**
 * Bounded one-shot delivery (review round 3). A device-flow release is handed out
 * by the server exactly ONCE, so the persist callback that stores it must be:
 *  - never invoked concurrently (round 3: the tick-entry latch alone missed
 *    already-in-flight polls, whose responses land after the latch check and
 *    would run the callback a second time against the same token),
 *  - retried on failure from memory (precedent #7: never re-poll a release the
 *    server will not repeat),
 *  - BOUNDED (round 2 finding 3: a deterministic persist failure must stand down
 *    with the manual path named, not retry and print forever).
 *
 * One implementation, shared by DeviceFlowController and WriteUpgradeController -
 * the two hand copies had already begun to drift, exactly like the five
 * ProblemDetails parses this hardening pass consolidated.
 */
export class BoundedDelivery {
  private delivering = false;
  private attempts = 0;

  constructor(private readonly maxAttempts = 5) {}

  /** True while a delivery attempt is in flight - poll ticks should skip. */
  get inFlight(): boolean {
    return this.delivering;
  }

  /**
   * Run one delivery attempt.
   *  - 'done': fn succeeded - the caller finalizes (clear pending, done, stop).
   *  - 'retrying': fn failed under the cap - the caller keeps the payload pending.
   *  - 'gave_up': the cap is reached - the caller finalizes WITHOUT the payload
   *    (the giveUp line already told the human the manual path).
   *  - 'skipped': another delivery is in flight (a second in-flight poll landed) -
   *    the caller does nothing.
   */
  async run(
    fn: () => void | Promise<void>,
    lines: { retry: (reason: string) => string; giveUp: (reason: string) => string },
  ): Promise<'done' | 'retrying' | 'gave_up' | 'skipped'> {
    if (this.delivering) return 'skipped';
    this.delivering = true;
    try {
      await fn();
      return 'done';
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.attempts += 1;
      if (this.attempts >= this.maxAttempts) {
        console.error(lines.giveUp(reason));
        return 'gave_up';
      }
      console.error(lines.retry(reason));
      return 'retrying';
    } finally {
      this.delivering = false;
    }
  }
}
