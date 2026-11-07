/**
 * compact-hint · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { count, bool, choice } from "../config/spec-helpers.js";
import type { SettingSpec } from "../config/spec-helpers.js";

export const COMPACT_SETTING_SPECS: Record<string, SettingSpec> = {
  "compact.enabled": bool("compact.enabled", "Allow the model to trigger context compaction"),
  // compact-hint dynamic（dynamic-threshold-plan.md §10.4）：5 键全部非 live（activate 捕获，改后 /reload）。
  "compact.dynamicThreshold.mode": choice(
    "compact.dynamicThreshold.mode",
    ["off", "shadow", "on"],
    "Price-aware dynamic hint line (default on; when usable it fires INSTEAD OF the static hint line, which becomes a fallback for when it isn't; shadow = compute + telemetry only)",
  ),
  "compact.dynamicThreshold.minHintPercent": {
    ...count("compact.dynamicThreshold.minHintPercent", 0, "Never hint before this share of the window"),
    max: 100,
  } as SettingSpec,
  "compact.dynamicThreshold.maxQualityPercent": {
    ...count(
      "compact.dynamicThreshold.maxQualityPercent",
      0,
      "Quality ceiling (uncalibrated safety cap); never hint later than this — the static threshold no longer overrides it while dynamic is usable",
    ),
    max: 100,
  } as SettingSpec,
  "compact.dynamicThreshold.rediscoveryUsd": {
    kind: "number",
    path: "compact.dynamicThreshold.rediscoveryUsd",
    min: 0,
    description: "Assumed rediscovery cost per switch, USD (uncalibrated empirical prior)",
  },
  "compact.dynamicThreshold.unknownPriceMode": choice(
    "compact.dynamicThreshold.unknownPriceMode",
    ["static", "quality"],
    "Fallback when the route reports no cache-read price",
  ),
  // child-context-switch plan §4: child-session switch_context wiring + per-run switch cap.
  "compact.childSessions": bool(
    "compact.childSessions",
    "Register switch_context (boundary mode) + compact-hint in child/subagent sessions",
  ),
  "compact.childMaxSwitches": {
    ...count("compact.childMaxSwitches", 1, "Max switch_context calls per subagent run (counted from the branch)"),
    max: 20,
  } as SettingSpec,
};
