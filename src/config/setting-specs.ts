import { DEFAULT_BUDGET } from "../core/deadline.js";
import { bool, choice, count, seconds, type SettingSpec } from "./spec-helpers.js";
export type { SettingSpec, SettingSpecBase } from "./spec-helpers.js";
import { COMPACT_SETTING_SPECS } from "../compact-hint/setting-specs.js";
import { WEBHUB_SETTING_SPECS, FEISHU_BOT_SETTING_SPECS } from "../web-hub/agent/setting-specs.js";
import { TODO_SETTING_SPECS } from "../todo/setting-specs.js";
import { ASK_USER_SETTING_SPECS } from "../ask-user/setting-specs.js";
import { TITLE_SETTING_SPECS } from "../title/setting-specs.js";
import { MEMORY_SETTING_SPECS } from "../memory/setting-specs.js";
import { CACHE_TTL_SETTING_SPECS } from "../cache-ttl/setting-specs.js";
import { WORKFLOW_SETTING_SPECS } from "../workflow/setting-specs.js";
import { BASH_JOBS_SETTING_SPECS } from "../bash/setting-specs.js";
import { FABRIC_SETTING_SPECS } from "../fabric/setting-specs.js";
import { GOAL_SETTING_SPECS } from "../goal/setting-specs.js";
import { QUOTA_SETTING_SPECS } from "../quota/setting-specs.js";
import { LOAD_SETTING_SPECS } from "../sysload/setting-specs.js";
import { SYSTEM_PROMPT_SETTING_SPECS } from "../sysprompt/setting-specs.js";
import { TOPIC_SWITCH_SETTING_SPECS } from "../topic-switch/setting-specs.js";
import { EXTERNAL_AGENTS_SETTING_SPECS } from "../external-agent/setting-specs.js";
import { TRAFFIC_SETTING_SPECS } from "../traffic/setting-specs.js";
import { SCHEDULE_SETTING_SPECS } from "../schedule/setting-specs.js";
import { DEFAULT_SETTINGS, isTimeSettingKey, type AgentSettings } from "./settings.js";

import type { DeadlineBudget } from "../core/types.js";
import { getPath, msKeyOf, msToSeconds, secondsKeyOf, secondsToMs, setPath } from "./time-units.js";

/** One-line per-leaf descriptions for the run deadline budget. */
const BUDGET_DESCRIPTIONS: Record<keyof DeadlineBudget, string> = {
  queueWaitMs: "Max wait for a concurrency slot",
  startupMs: "Subagent process startup timeout",
  bindMs: "Session bind timeout after spawn",
  firstEventMs: "Wait for the first session event",
  idleMs: "Max silence between session events",
  modelTurnMs: "Hard cap on one model turn; 0 = unlimited",
  toolMs: "Single tool call timeout",
  compactionMs: "Context compaction timeout",
  totalMs: "Overall run cap (must be > 0; 0 falls back to the default)",
  abortGraceMs: "Grace after abort before force-kill",
  steerMs: "Steer message delivery timeout",
  reapMs: "Reaper sweep timeout",
  retrySlackMs: "Extra idle slack per startup retry",
  startupRetries: "Startup retry attempts",
  totalGraceMs: "Grace after the total budget before force-kill (default-budget runs only); 0 = off",
  maxExtensions: "Max deadline extensions per run; 0 = no extension and no grace",
  maxTotalFactor:
    "Hard ceiling as a multiple of the run's total budget, explicit timeout_s included (fixed-deadline system runs — workflow children, /goal verifier, RPC — are always 1)",
  extendStepMs:
    "Max seconds granted by a single extend_subagent_timeout call (default 3600); also widens the hard ceiling for extendable runs to total + maxExtensions × step; 0 = legacy (no per-grant cap, factor-only ceiling)",
};

const BUDGET_SPECS: Record<string, SettingSpec> = Object.fromEntries(
  (Object.keys(DEFAULT_BUDGET) as (keyof DeadlineBudget)[]).map((leaf) => {
    // 计数类（非时长）：startupRetries / maxExtensions
    if (leaf === "startupRetries" || leaf === "maxExtensions")
      return [`budget.${leaf}`, { ...count(`budget.${leaf}`, 0, BUDGET_DESCRIPTIONS[leaf]), live: true }] as [
        string,
        SettingSpec,
      ];
    // 倍数（非时长、允许小数，≥ 1）：maxTotalFactor
    if (leaf === "maxTotalFactor")
      return [
        `budget.${leaf}`,
        { kind: "number", path: `budget.${leaf}`, min: 1, live: true, description: BUDGET_DESCRIPTIONS[leaf] },
      ] as [string, SettingSpec];
    // totalMs 禁止 0（D-11）；其余时长键 min 默认 0
    if (leaf === "totalMs")
      return [
        secondsKeyOf(`budget.${leaf}`),
        seconds(`budget.${leaf}`, { live: true, min: 1, description: BUDGET_DESCRIPTIONS[leaf] }),
      ] as [string, SettingSpec];
    return [
      secondsKeyOf(`budget.${leaf}`),
      seconds(`budget.${leaf}`, { live: true, description: BUDGET_DESCRIPTIONS[leaf] }),
    ] as [string, SettingSpec];
  }),
);

export const SETTING_SPECS: Record<string, SettingSpec> = {
  ...BUDGET_SPECS,
  concurrencyLimit: { ...count("concurrencyLimit", 0, "Max concurrent subagent runs"), live: true },
  "agent.queueWhenFull": {
    ...bool(
      "agent.queueWhenFull",
      "Pool-full Agent dispatch policy: false (default) rejects immediately; true restores queue-and-wait (budget.queueWaitS)",
    ),
    live: true,
  },
  maxNestedDepth: count("maxNestedDepth", 0, "Max nested delegation depth"),
  rememberAgents: bool("rememberAgents", "Remember the agent registry across sessions"),
  fleetWidget: bool("fleetWidget", "Pin the live agent tree above the editor"),
  fleetTerminalLingerS: seconds("fleetTerminalLingerMs", {
    hint: "How long entered or undeliverable terminal rows remain visible",
    description: "Terminal row linger after context entry",
  }),
  fleetAwaitNotificationS: seconds("fleetAwaitNotificationMs", {
    hint: "Hard fallback while a notification awaits context entry; 0 = hide pending rows immediately",
    description: "Maximum wait for notification context entry",
  }),
  resultMaxChars: {
    ...count("resultMaxChars", 0, "Max chars of subagent result text returned; 0 = no cap"),
    live: true,
  },
  deliveryAttempts: count("deliveryAttempts", 1, "Notification delivery attempts"),
  deliveryBackoffS: seconds("deliveryBackoffMs", { description: "Backoff between delivery attempts" }),
  reconcileTtlS: seconds("reconcileTtlMs", { description: "Retention of delivered records for reconcile" }),
  maxReconcileRounds: count("maxReconcileRounds", 0, "Max reconcile rounds per flush"),
  maxReconcileBatch: count("maxReconcileBatch", 1, "Max deliveries reconciled per round"),
  coalesceWindowS: seconds("coalesceWindowMs", {
    max: 5,
    hint: "0 disables coalescing; max 5s",
    description: "Hold window to merge notifications",
  }),
  coalesceMaxBatch: count("coalesceMaxBatch", 1, "Max notifications per coalesced batch"),
  ackWindowS: seconds("ackWindowMs", {
    max: 5,
    hint: "0 disables the ack hold window; max 5s",
    description: "Hold window suppressing caller-acked deliveries",
  }),
  "worktree.enabled": bool("worktree.enabled", "Isolate subagents in git worktrees"),
  ...COMPACT_SETTING_SPECS,
  "extend.enabled": bool("extend.enabled", "Timeout grace + extend_subagent_timeout tool"),
  "hud.enabled": bool("hud.enabled", "Merged HUD: take over the footer (off restores pi's built-in footer)"),
  ...WEBHUB_SETTING_SPECS,
  "webSearch.enabled": bool("webSearch.enabled", "Merged web_search tool (Codex/SerpAPI/Bocha/Tavily failover)"),
  "date.enabled": bool(
    "date.enabled",
    "Inject the current date and time ([date] YYYY-MM-DD Ddd HH:MM (TZ) marker) on a session's first turn, when the day rolls over, and on a new turn after 1h without an injection (main + child sessions)",
  ),
  ...TODO_SETTING_SPECS,
  ...ASK_USER_SETTING_SPECS,
  "feishuNotify.enabled": bool("feishuNotify.enabled", "Feishu notification cards (main session only)"),
  "sessionNav.enabled": bool(
    "sessionNav.enabled",
    "Session navigation: /resume-recent 48h window, /clear, bare exit, resume-list titles",
  ),
  ...TITLE_SETTING_SPECS,
  ...MEMORY_SETTING_SPECS,
  "extend.notify": choice(
    "extend.notify",
    ["background", "always", "off"],
    "Grace notice delivery: background = skip runs a caller blocks on; always = debug only",
  ),
  fleetDeadlineWarnS: seconds("fleetDeadlineWarnMs", {
    hint: "0 disables the deadline warn tier",
    description: "Fleet row turns warn when remaining time drops below this",
  }),
  fleetWidgetMaxRows: {
    ...count("fleetWidgetMaxRows", 1, "Line budget for run lines below the agent-tree header (1-40)"),
    max: 40,
  } as SettingSpec,
  "reload.defer": bool("reload.defer", "Defer /reload until running subagents settle"),
  ...CACHE_TTL_SETTING_SPECS,
  "worktree.gitTimeoutS": seconds("worktree.gitTimeoutMs", { description: "Git command timeout for worktree ops" }),
  ...WORKFLOW_SETTING_SPECS,
  ...BASH_JOBS_SETTING_SPECS,
  ...FABRIC_SETTING_SPECS,
  ...GOAL_SETTING_SPECS,
  ...QUOTA_SETTING_SPECS,
  ...LOAD_SETTING_SPECS,
  ...SYSTEM_PROMPT_SETTING_SPECS,
  ...TOPIC_SWITCH_SETTING_SPECS,
  ...EXTERNAL_AGENTS_SETTING_SPECS,
  ...FEISHU_BOT_SETTING_SPECS,
  ...TRAFFIC_SETTING_SPECS,
  ...SCHEDULE_SETTING_SPECS,
};

/** Live settings object + persistence port, shared by the command and the editor. */
export interface SettingsStore {
  /** Live AgentSettings object — mutated in place. `budget.*` values are read
   *  at spawn time (spawn-service mergeBudget), so they apply to new runs
   *  immediately; all other settings are captured at activate/session build
   *  and take effect after `/reload`. */
  current: AgentSettings;
  /** Persist one override to the settings file (undefined = remove). Returns an error message or undefined. */
  persist: (dottedKey: string, value: unknown) => string | undefined;
  /** Settings file path, shown in messages. */
  path: string;
  /** Where a non-default settings file came from (editor title suffix); absent for the default scope. */
  pathNote?: string | undefined;
  /**
   * L1 (agent-tool pool-full plan §4): fired after `writeSetting`/`resetSetting`
   * mutate `current` in place, with the storage key and the new *live*
   * (millisecond-domain for durations) value — the seam a caller uses to push
   * a change into a running component that caches the value at construction
   * (e.g. `concurrencyLimit` → `SlotPool.setLimit`, since the pool captures
   * the limit once in its constructor and `settings.concurrencyLimit` being
   * mutated in place does not by itself reach it). Absent ⇒ no such component
   * is wired (test doubles, budgetOnly editor instances); best-effort only,
   * never throws back into the write path.
   */
  onWrite?: (key: string, liveValue: unknown) => void;
}

/** Listing order, optionally scoped to the `/agent budget` alias. */
export function settingKeys(budgetOnly = false): string[] {
  return Object.keys(SETTING_SPECS).filter((k) => !budgetOnly || k.startsWith("budget."));
}

export function isKnownSettingKey(key: string, budgetOnly = false): boolean {
  return Object.hasOwn(SETTING_SPECS, key) && (!budgetOnly || key.startsWith("budget."));
}

/** Effective default in the *stored* domain (seconds for duration keys). */
export function defaultOf(spec: SettingSpec): unknown {
  const internal = getPath(DEFAULT_SETTINGS, spec.path);
  if (internal === undefined) return spec.fallback;
  if (spec.csv && Array.isArray(internal)) return internal.join(",");
  return spec.time && typeof internal === "number" ? msToSeconds(internal) : internal;
}

/** Current value in the *stored* domain; falls back to the effective default when unset. */
export function currentOf(current: AgentSettings, spec: SettingSpec): unknown {
  const internal = getPath(current, spec.path);
  if (internal === undefined) return defaultOf(spec);
  if (spec.csv && Array.isArray(internal)) return internal.join(",");
  return spec.time && typeof internal === "number" ? msToSeconds(internal) : internal;
}

/** True when the live value differs from the effective default. */
export function isOverridden(current: AgentSettings, spec: SettingSpec): boolean {
  return formatSettingValue(currentOf(current, spec)) !== formatSettingValue(defaultOf(spec));
}

export function formatSettingValue(value: unknown): string {
  return value === undefined ? "(unset)" : String(value);
}

/** `applies to new runs immediately` (budget.*) vs `takes effect after /reload`. */
export function effectOf(spec: SettingSpec): string {
  return spec.live ? "applies to new runs immediately" : "takes effect after /reload";
}

export type ParsedSetting = { ok: true; stored: unknown; live: unknown } | { ok: false; error: string };

/**
 * Parse user input for one setting. Duration values are validated in the
 * **second** domain (integer, min/max in seconds) and only then converted, so
 * error messages match what the user typed and `coalesceWindowS`'s 5s ceiling
 * reads as `<= 5` rather than `<= 5000`.
 */
export function parseSettingValue(spec: SettingSpec, raw: string): ParsedSetting {
  switch (spec.kind) {
    case "number": {
      const min = spec.min ?? 0;
      const value = Number(raw.trim());
      const bad =
        raw.trim() === "" ||
        !Number.isFinite(value) ||
        value < min ||
        (spec.max !== undefined && value > spec.max) ||
        ((spec.integer ?? false) && !Number.isInteger(value));
      if (bad) {
        const bound = spec.max === undefined ? `>= ${min}` : `between ${min} and ${spec.max}`;
        const unit = spec.time ? " seconds" : "";
        return { ok: false, error: `expected ${spec.integer ? "an integer" : "a number"} ${bound}${unit}` };
      }
      return { ok: true, stored: value, live: spec.time ? secondsToMs(value) : value };
    }
    case "boolean": {
      const v = raw.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(v)) return { ok: true, stored: true, live: true };
      if (["false", "0", "no", "off"].includes(v)) return { ok: true, stored: false, live: false };
      return { ok: false, error: "expected true/false" };
    }
    case "enum":
      return spec.values.includes(raw)
        ? { ok: true, stored: raw, live: raw }
        : { ok: false, error: `expected one of: ${spec.values.join(", ")}` };
    case "string": {
      if (spec.csv) {
        const items = raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
        const joined = items.join(",");
        return { ok: true, stored: joined, live: items };
      }
      return raw ? { ok: true, stored: raw, live: raw } : { ok: false, error: "expected a non-empty string" };
    }
  }
}

export interface SettingWriteResult {
  key: string;
  /** Stored-domain rendering of the value before the write. */
  previous: string;
  /** Stored-domain rendering of the value after the write. */
  next: string;
  effect: string;
  /** Message from the persistence port; the in-memory change is kept regardless. */
  persistError?: string;
}

/** Mutate the live settings object and persist the stored (second-domain) value. */
export function writeSetting(
  store: SettingsStore,
  key: string,
  parsed: { stored: unknown; live: unknown },
): SettingWriteResult {
  const spec = SETTING_SPECS[key]!;
  const previous = formatSettingValue(currentOf(store.current, spec));
  setPath(store.current as unknown as Record<string, unknown>, spec.path, parsed.live);
  try {
    store.onWrite?.(key, parsed.live);
  } catch {
    // Best effort only (mirrors persist's own error containment below) — the
    // in-memory settings change is kept regardless of a downstream wiring bug.
  }
  const persistError = store.persist(key, parsed.stored);
  return {
    key,
    previous,
    next: formatSettingValue(parsed.stored),
    effect: effectOf(spec),
    ...(persistError === undefined ? {} : { persistError }),
  };
}

/** Restore the default in the live object and remove the file override. */
export function resetSetting(store: SettingsStore, key: string): SettingWriteResult {
  const spec = SETTING_SPECS[key]!;
  const previous = formatSettingValue(currentOf(store.current, spec));
  const liveDefault = getPath(DEFAULT_SETTINGS, spec.path);
  setPath(store.current as unknown as Record<string, unknown>, spec.path, liveDefault);
  try {
    store.onWrite?.(key, liveDefault);
  } catch {
    // Best effort only — see writeSetting's identical guard.
  }
  const persistError = store.persist(key, undefined);
  return {
    key,
    previous,
    next: formatSettingValue(defaultOf(spec)),
    effect: effectOf(spec),
    ...(persistError === undefined ? {} : { persistError }),
  };
}

/** Re-exported for callers that only need the storage-key rename. */
export { isTimeSettingKey, msKeyOf, secondsKeyOf };
