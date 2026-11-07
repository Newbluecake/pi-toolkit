/**
 * todo · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { count, bool } from "../config/spec-helpers.js";
import type { SettingSpec } from "../config/spec-helpers.js";

export const TODO_SETTING_SPECS: Record<string, SettingSpec> = {
  "todo.enabled": bool("todo.enabled", "Merged task tools (TaskCreate/List/Get/Update/Delete + /tasklist widget)"),
  // Main-session todo staleness nudge (todo-nudge plan): all four keys are
  // plain turn counts, never durations — no `time: true`, no seconds/ms split.
  "todo.nudge.enabled": bool(
    "todo.nudge.enabled",
    "Main-session todo staleness nudge: hidden reminder when in_progress tasks go stale (off = zero new handlers)",
  ),
  "todo.nudge.graceTurns": count(
    "todo.nudge.graceTurns",
    1,
    "Turns to wait after the first completion/git evidence before nudging",
  ),
  "todo.nudge.fallbackTurns": count(
    "todo.nudge.fallbackTurns",
    1,
    "Turns with zero evidence before the fallback nudge fires",
  ),
  "todo.nudge.cooldownTurns": count(
    "todo.nudge.cooldownTurns",
    1,
    "Turns to suppress re-nudging after a nudge fires (doubles per consecutive no-touch nudge, capped at 4x)",
  ),
  // todo-archive plan §2/D1 (user ruling 2026-10-15): completed-task auto-archive. Both knobs are
  // turn/compaction counts, never durations — no `time: true`. Non-live: needs /reload.
  "todo.archive.onCompact": bool(
    "todo.archive.onCompact",
    "todo archive: archive every completed task when the session compacts (default on; non-live, needs /reload)",
  ),
  "todo.archive.afterTurns": count(
    "todo.archive.afterTurns",
    0,
    "todo archive: archive a completed task N turns (turn_end events) after its completion, 0 disables (default 30; turns are finer-grained than user requests; non-live, needs /reload)",
  ),
};
