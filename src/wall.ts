/**
 * Sleep-aware wall clock for SDK calls.
 *
 * A plain setTimeout counts wall time, but a closed laptop suspends the whole
 * process tree — SDK subprocess included. That time is not a hang: the pass
 * simply resumes when the machine wakes. Counting it turns every overnight
 * pass into a phantom timeout that fires on the morning's first maintenance
 * wake (which is exactly what struck out the entire fleet on 2026-08-04:
 * "process aborted by user" × three per stream, all night).
 *
 * So the wall ticks every 30s and only counts a tick as awake time when the
 * interval fired roughly on schedule; a large jump means the machine was
 * suspended, and suspended time is free.
 */
export function armWall(
  abort: AbortController,
  ms: number,
  label: string,
): { fired: () => boolean; disarm: () => void } {
  const TICK = 30_000;
  let awakeMs = 0;
  let last = Date.now();
  let fired = false;
  const timer = setInterval(() => {
    const now = Date.now();
    const delta = now - last;
    last = now;
    if (delta < TICK * 3) awakeMs += delta;
    if (awakeMs >= ms && !fired) {
      fired = true;
      abort.abort(new Error(`${label} wall (${Math.round(ms / 60_000)}m awake) — aborted; retry is free`));
    }
  }, TICK);
  timer.unref?.();
  return { fired: () => fired, disarm: () => clearInterval(timer) };
}
