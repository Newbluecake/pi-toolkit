/**
 * Child-session bash no-host-view diagnostics (L1 todo #20).
 *
 * `src/tools/bash-tool.ts` and `src/bash/child.ts` used to report this via
 * `console.warn` — fine for the MAIN session (its own process's stdout), but
 * a subagent session runs in the SAME process (no subprocess boundary,
 * AGENTS.md) and a raw `console.warn` from it lands directly in the host's
 * TUI paint stream, corrupting the frame. This module gives both call sites
 * a non-TUI sink instead, reusing the SDK's own `appendEntry` — the same
 * "state persistence, never sent to the LLM, never painted unless a renderer
 * is registered for the customType" mechanism already used for silent
 * bookkeeping entries elsewhere in this codebase (`src/adapters/pi-run-log.ts`,
 * `src/hud/timing.ts`, `src/compact-hint/dynamic/wire.ts`). No renderer is
 * registered for `BASH_DIAG_CUSTOM_TYPE`, so this is inert in every mode
 * (TUI/print/RPC) — it just lands in the session's own persisted entries for
 * later inspection (session file / `pi.sessionManager.getEntries()`).
 */

export const BASH_DIAG_CUSTOM_TYPE = "subagent:bash-diag";

/** The subset of `ExtensionAPI`/`ExtensionContext` this module needs — both expose `appendEntry` with this signature. */
export interface BashDiagSink {
  appendEntry<T = unknown>(customType: string, data?: T): void;
}

/** Best-effort: a broken/throwing `appendEntry` must never break the bash call or settle-hold path it is diagnosing. */
export function recordBashDiag(sink: BashDiagSink, message: string): void {
  try {
    sink.appendEntry(BASH_DIAG_CUSTOM_TYPE, { message, at: Date.now() });
  } catch {
    /* diagnostics must never throw */
  }
}
