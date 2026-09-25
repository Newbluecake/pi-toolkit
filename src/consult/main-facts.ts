/**
 * consult (docs/dev/consult/plan.md §16 "consult the main session via the
 * reserved expert id \"main\""): the live facts about the HOST main session a
 * `consult("main", …)` call needs — read fresh, on demand, never cached
 * inside this module. A background subagent may call `consult("main", …)`
 * at any point long after `Agent({ experts: ["main"] })` dispatch, so every
 * field here must reflect "right now", not "at dispatch time" (plan §16
 * rules 3/4).
 *
 * Production wiring (`stack.ts`) reads these straight off the
 * `ExtensionContext` captured once at `session_start` — the same accessors
 * `src/hud/footer.ts`'s `installFooter` already reads on every later
 * render from that very reference, which is the existing proof in this
 * codebase that the captured `ctx` stays live for the whole session rather
 * than freezing at capture time.
 */

export interface MainSessionFacts {
  /** `undefined` ⇒ the host session runs with `--no-session` (no persisted file) — main cannot be consulted. */
  sessionFile?: string;
  model?: { provider: string; id: string };
  /** Mirrors `ContextUsageInfo.tokens` — `undefined`/`null` = unknown right now (e.g. just after compaction). */
  contextTokens?: number | null;
  /** Mirrors `ContextUsageInfo.percent` — `undefined`/`null` = unknown right now. */
  contextPercent?: number | null;
}

/** Must never throw — every failure folds into `{}` (nothing known right now). */
export type MainSessionFactsProvider = () => MainSessionFacts;
