/**
 * A single throttled `aria-live="polite"` announcer (vue-plan.md v2.1 §3.5, §3.12, §5.2 — P1).
 * §3.12 calls for one sr-only `role="status"` region, updated at most every `minIntervalMs`
 * (default 2s); §3.5 extends the hidden-page render rule to it: while `doc.hidden`, announcements
 * are queued (merged — only the latest text survives) rather than written, and flushed once on
 * return to visibility instead of replaying every intermediate message.
 */

export interface AnnouncerDocument {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface AnnouncerWindow {
  addEventListener(type: "pageshow" | "focus", listener: () => void): void;
  removeEventListener(type: "pageshow" | "focus", listener: () => void): void;
}

export interface AnnouncerOptions<TTimer = ReturnType<typeof setTimeout>> {
  /** Writes the merged text into the live region (the only DOM touch point — owned by the caller). */
  render(text: string): void;
  doc: AnnouncerDocument;
  win: AnnouncerWindow;
  setTimeout(fn: () => void, ms: number): TTimer;
  clearTimeout(handle: TTimer): void;
  now(): number;
  /** Default 2000ms. */
  minIntervalMs?: number;
}

export interface AnnouncerHandle {
  announce(text: string): void;
  dispose(): void;
}

export function createAnnouncer<TTimer = ReturnType<typeof setTimeout>>(
  opts: AnnouncerOptions<TTimer>,
): AnnouncerHandle {
  const minIntervalMs = opts.minIntervalMs ?? 2000;
  let lastAt = -Infinity;
  let pendingText: string | null = null;
  let timer: TTimer | null = null;
  let disposed = false;

  function flush(): void {
    if (disposed || pendingText === null || opts.doc.hidden) return;
    const text = pendingText;
    pendingText = null;
    lastAt = opts.now();
    opts.render(text);
  }

  function scheduleFlush(delay: number): void {
    if (timer !== null) return;
    timer = opts.setTimeout(() => {
      timer = null;
      flush();
    }, delay);
  }

  function onVisible(): void {
    if (!opts.doc.hidden) flush();
  }

  opts.doc.addEventListener("visibilitychange", onVisible);
  opts.win.addEventListener("pageshow", onVisible);
  opts.win.addEventListener("focus", onVisible);

  return {
    announce(text) {
      if (disposed) return;
      pendingText = text; // merge: only the latest text matters, no queue of stale announcements
      if (opts.doc.hidden) return; // flushed on return to visibility
      const elapsed = opts.now() - lastAt;
      if (elapsed >= minIntervalMs) flush();
      else scheduleFlush(minIntervalMs - elapsed);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) opts.clearTimeout(timer);
      opts.doc.removeEventListener("visibilitychange", onVisible);
      opts.win.removeEventListener("pageshow", onVisible);
      opts.win.removeEventListener("focus", onVisible);
    },
  };
}
