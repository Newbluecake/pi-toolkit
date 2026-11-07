/**
 * todo · settings (#56 batch 2 ⑧): the `todo` block's types (staleness nudge + completed-task archive),
 * frozen defaults and never-throws parsers. `src/config/settings.ts` imports ONLY this module for the block.
 */
import type { EnabledGroup } from "../config/enabled-group.js";

/**
 * Main-session todo staleness nudge (L1 feature). All four counters are turn
 * counts, never durations, so they are excluded from the time-unit `*Ms`/`*S`
 * migration — a plain integer setting stays a plain integer setting.
 * `enabled:false` registers zero new handlers/messages (behavior identical to
 * before the feature existed); the nudge tracker is main-session only
 * (child subagent sessions never enable it — src/index.ts's `isChildSession`).
 */
export interface TodoNudgeSettings {
  enabled: boolean;
  /** Turns to wait, from the FIRST unconfirmed E1/E2 evidence, before firing the evidence-based trigger. */
  graceTurns: number;
  /** Turns with zero evidence before the fallback trigger fires. */
  fallbackTurns: number;
  /** Turns to suppress re-nudging after a nudge fires; doubles per consecutive no-touch nudge, capped at 4x. */
  cooldownTurns: number;
}

/** Merged plugins: TaskCreate/List/Get/Update/Delete + /tasklist widget, plus the staleness nudge sub-block. */
export interface TodoSettings extends EnabledGroup {
  nudge: TodoNudgeSettings;
  /** Completed-task auto-archive (todo-archive plan D1). Both knobs are non-live (/reload). */
  archive: TodoArchiveSettings;
}

/**
 * Completed-task auto-archive (todo-archive plan §2, user ruling 2026-10-15): `onCompact` sweeps
 * every completed task when the session compacts; `afterTurns` archives a completed task on the
 * Nth `turn_end` after its completion (turns are finer-grained than user requests — tune N
 * accordingly). Both are turn/compaction-count semantics, never durations, so like the nudge
 * block they stay out of the `*Ms`/`*S` time-unit migration. Non-live: read at wiring time only.
 */
export interface TodoArchiveSettings {
  /** Archive all completed tasks on session compaction. Default true. */
  onCompact: boolean;
  /** Archive a completed task after this many turn_end events; 0 disables the per-turn sweeper. Default 30, min 0. */
  afterTurns: number;
}

/**
 * Parse the `todo` settings block: `enabled` is the existing EnabledGroup
 * semantics, `nudge` is a nested sub-block (todo-nudge plan) that falls back
 * field-by-field to DEFAULT_TODO_SETTINGS.nudge — all four fields are plain
 * turn counts (not durations), positive integers required, illegal/missing
 * values fall back individually; never throws.
 */
export function parseTodoSettings(input: unknown): TodoSettings {
  const defaults = DEFAULT_TODO_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ...defaults, nudge: { ...defaults.nudge }, archive: { ...defaults.archive } };
  const record = input as Record<string, unknown>;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
    nudge: parseTodoNudgeSettings(record.nudge, defaults.nudge),
    archive: parseTodoArchiveSettings(record.archive, defaults.archive),
  };
}

/** todo-archive plan §2: field-by-field fallback to DEFAULT_TODO_SETTINGS.archive; `afterTurns`
 * accepts integers >= 0 (0 = off); never throws. */
function parseTodoArchiveSettings(input: unknown, defaults: TodoArchiveSettings): TodoArchiveSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const record = input as Record<string, unknown>;
  const afterTurns = record.afterTurns;
  return {
    onCompact: typeof record.onCompact === "boolean" ? record.onCompact : defaults.onCompact,
    afterTurns:
      typeof afterTurns === "number" && Number.isFinite(afterTurns) && Number.isInteger(afterTurns) && afterTurns >= 0
        ? afterTurns
        : defaults.afterTurns,
  };
}

function parseTodoNudgeSettings(input: unknown, defaults: TodoNudgeSettings): TodoNudgeSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const record = input as Record<string, unknown>;
  const positiveInt = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : fallback;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
    graceTurns: positiveInt(record.graceTurns, defaults.graceTurns),
    fallbackTurns: positiveInt(record.fallbackTurns, defaults.fallbackTurns),
    cooldownTurns: positiveInt(record.cooldownTurns, defaults.cooldownTurns),
  };
}

export const DEFAULT_TODO_SETTINGS: TodoSettings = {
  enabled: true,
  nudge: { enabled: true, graceTurns: 2, fallbackTurns: 20, cooldownTurns: 8 },
  archive: { onCompact: true, afterTurns: 30 },
};
