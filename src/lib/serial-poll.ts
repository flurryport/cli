/**
 * Self-rearming poll loop (hardening precedent #4): the next run is scheduled only
 * AFTER the current one completes, so a batch slower than the interval can never
 * overlap the next tick. listen's old setInterval overlapped under load, and two
 * concurrent polls both read the same pending executions - the same capture
 * forwarded to localhost twice (the Twinkle double-order fear). Concurrency is
 * structurally capped at 1; the pattern console.ts already used, extracted.
 */
export function startSerialPoll(fn: () => Promise<void>, intervalMs: number): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = async () => {
    try {
      await fn();
    } catch {
      /* the poll owns its error reporting; a throw must not kill the loop */
    }
    if (!stopped) timer = setTimeout(() => void run(), intervalMs);
  };
  void run();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
