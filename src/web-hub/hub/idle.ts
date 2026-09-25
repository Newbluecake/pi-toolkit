/**
 * Idle self-exit monitor (plan §包 B, arch §3.3): no agent connection, no SSE
 * client and no headless child for `idleMs` ⇒ `onIdle()` exactly once.
 * Checked every `checkMs` (default 30s) on an unref'd interval.
 */

export const DEFAULT_IDLE_CHECK_MS = 30_000;

export function createIdleMonitor(opts: {
  counts: () => { agents: number; sse: number; headless: number };
  idleMs: number;
  checkMs?: number;
  now: () => number;
  onIdle: () => void;
}): { stop(): void } {
  let idleSince = opts.now();
  let stopped = false;

  const check = (): void => {
    if (stopped) return;
    let busy = true;
    try {
      const c = opts.counts();
      busy = c.agents > 0 || c.sse > 0 || c.headless > 0;
    } catch {
      busy = true; // a failing probe must never trigger an exit
    }
    const now = opts.now();
    if (busy) {
      idleSince = now;
      return;
    }
    if (now - idleSince >= opts.idleMs) {
      stop();
      opts.onIdle();
    }
  };

  const timer = setInterval(check, opts.checkMs ?? DEFAULT_IDLE_CHECK_MS);
  timer.unref();

  function stop(): void {
    stopped = true;
    clearInterval(timer);
  }

  return { stop };
}
