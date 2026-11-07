/**
 * title · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { count, bool } from "../config/spec-helpers.js";
import type { SettingSpec } from "../config/spec-helpers.js";

export const TITLE_SETTING_SPECS: Record<string, SettingSpec> = {
  // 会话标题模型生成 v2（任务 #12 + 随任务动态刷新）：全部非 live（activate 时捕获，改后 /reload）。
  "title.enabled": bool(
    "title.enabled",
    "Auto-generate and refresh a short session title as the task progresses (main session only, silent on failure)",
  ),
  "title.model": {
    kind: "string",
    path: "title.model",
    description: 'Strict provider/id for title generation, or "" to follow the session model',
  },
  "title.refreshEveryInputs": count(
    "title.refreshEveryInputs",
    0,
    "Refresh the title once this many new user inputs land since the last generation; 0 disables this trigger",
  ),
  "title.refreshAfterMinutes": count(
    "title.refreshAfterMinutes",
    0,
    "Refresh the title once >=1 new input and this many cumulative agent-run minutes have passed; 0 disables this trigger",
  ),
  "title.refreshWindowMinutes": count(
    "title.refreshWindowMinutes",
    0,
    "Rolling window (minutes) that maxRefreshes counts refreshes within; 0 = legacy lifetime cap for the whole session",
  ),
  "title.maxRefreshes": count(
    "title.maxRefreshes",
    0,
    "Max refreshes per refreshWindowMinutes window (or per session when the window is 0); 0 = first title only, never refresh",
  ),
};
