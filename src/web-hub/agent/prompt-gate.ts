/**
 * Optional, late-bound web-prompt claim port (topic-switch plan P4, D2/#5; arch §15 r2 row 1).
 *
 * `commands.ts`'s `handlePrompt` calls `PromptGatePort.tryClaim` synchronously, before the
 * hold-driver branch and the native `sendUserMessage` dispatch, for every idle prompt. A `true`
 * return means the web-hub side is done for this cmd — it does not dispatch now and has already
 * replied to the HTTP caller (an "observed/idle" result, so the browser sees the usual shape).
 * The caller (topic-switch) owns the request from that point on and settles it exactly once via
 * the `release` callback it was handed:
 *
 *  - `release.current()`: re-dispatch into the CURRENT session through the same no-reply path
 *    `dispatchHeld` uses (ledger write, origin entry, `sendUserMessage`). Preconditions (a live
 *    ctx, the same session the request was claimed under, not mid-manual-compaction) are
 *    re-checked at CALL time, not at claim time — a release that lands after the session moved on
 *    (new session, `/reload`, a dead connection generation) is refused rather than dispatching
 *    into a stale session.
 *  - `release.elsewhere()`: the request was delivered into a DIFFERENT session (topic-switch's own
 *    `ctx.newSession` hop) — this session's ledger entry is frozen at `consumed` so its bubble in
 *    the browser stops looking "pending" forever.
 *
 *  - `release.handedOff(kind)` (todo #8): the session ended (`session_shutdown`) BEFORE the user
 *    decided, and topic-switch handed the request to its own crash/reload recovery (persisted
 *    `pending` + in-process transfer) instead of settling it. The recovery re-delivers through the
 *    content path, never through this release, so the ledger entry is moved to a state the NEXT
 *    session/module instance can still finish: `"reload"` (the same session comes back and
 *    recovery auto-redelivers) re-arms it as `dispatched` with its owner dropped, so the
 *    re-delivered `input`/`message_start` pair is attributed to this cmdId as usual (⇒ `consumed`,
 *    the browser row clears); `"session"` (new/resume/fork/quit — recovery puts the text back into
 *    the terminal editor at most) ends it as `dropped{session}`, unbound from any session so the
 *    next session's ctl slot still projects it.
 *
 * `current()`/`elsewhere()`/`handedOff()` settle at most once in total: whichever is called first
 * wins, every later call (any method, any order) is a no-op.
 *
 * This port is purely a type contract (pi-free) — `src/index.ts` (frozen, owned by package P3b)
 * wires a late-bound getter (`promptGate: () => promptGateRef.current`) into `WebHubDeps`, and
 * `src/topic-switch/wire.ts` (also P3b) is what ever actually assigns `promptGateRef.current` to
 * a real `PromptGatePort`. Undefined (topic-switch off, or not wired yet) ⇒ `commands.ts` never
 * calls `tryClaim` at all — byte-identical to pre-feature behavior.
 */
export interface WebPromptRelease {
  /** Re-dispatch into the session the request was claimed under. Returns `"dispatched"` only when
   * the underlying `sendUserMessage` call was actually attempted; `"refused"` otherwise (stale
   * ctx, session changed, mid-compaction, or this release already settled). */
  current(): "dispatched" | "refused";
  /** The request was delivered elsewhere (a different session); freeze this session's ledger
   * entry so its bubble stops looking pending. No-op if this release already settled. */
  elsewhere(): void;
  /** todo #8: the request was handed to topic-switch's shutdown recovery before any decision (see
   * the file header). Optional so pre-#8 implementers (test doubles) still type-check; the real
   * `commands.ts` release always implements it. No-op if this release already settled. */
  handedOff?(kind: "reload" | "session"): void;
}

export interface PromptGatePort {
  /**
   * Called synchronously, only while the session is idle, before any dispatch. `ctx` is the live
   * `ExtensionContext` (typed `unknown` here to keep this file pi-free — the real caller always
   * passes pi's `ExtensionContext`). Must not throw for long; a throw is treated exactly like
   * returning `false` (fail-open: the native/hold dispatch path runs as if nothing claimed it).
   *
   * Returning `true` claims the request: `commands.ts` replies immediately (no dispatch) and
   * ownership of eventually calling `release.current()`/`release.elsewhere()` passes to this
   * port's owner. Returning `false` leaves the request on the native/hold path untouched.
   */
  tryClaim(req: { cmdId: string; text: string }, ctx: unknown, release: WebPromptRelease): boolean;
}
