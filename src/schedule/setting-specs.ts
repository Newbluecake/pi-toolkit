/**
 * schedule · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { seconds, bool } from "../config/spec-helpers.js";
import type { SettingSpec } from "../config/spec-helpers.js";

export const SCHEDULE_SETTING_SPECS: Record<string, SettingSpec> = {
  // scheduled-reports plan r3 §10.3 (S0): default off ⇒ zero surface; all non-live. `schedule.dir`
  // is JSON-only (bashJobs.dir precedent). Fixed values (tolerance 60s, message/handoff run max
  // 3600s, 8 tasks, 64 pending reports, 14d retention, 24h report window, E1 missed policy, Feishu
  // budgets) are deliberately NOT settings (§10.3).
  "schedule.enabled": bool(
    "schedule.enabled",
    "Scheduled tasks: schedule tool, /schedule, session-scoped timers (change: /reload; hub side also /webhub restart)",
  ),
  "schedule.defaultTimeoutS": seconds("schedule.defaultTimeoutMs", {
    min: 60,
    max: 14_400,
    description: "Scheduled tasks: default background run timeout in seconds, 60-14400 (change: /reload)",
  }),
  "schedule.maxTimeoutS": seconds("schedule.maxTimeoutMs", {
    min: 60,
    max: 14_400,
    description: "Scheduled tasks: max background run timeout a task may request, 60-14400 (change: /reload)",
  }),
};
