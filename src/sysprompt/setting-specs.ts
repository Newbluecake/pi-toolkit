/**
 * sysprompt · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { bool, choice } from "../config/spec-helpers.js";
import type { SettingSpec } from "../config/spec-helpers.js";

export const SYSTEM_PROMPT_SETTING_SPECS: Record<string, SettingSpec> = {
  // systemPrompt（sysprompt-stable plan §3.2/§3.5）：三态模式与唤醒回放。
  "systemPrompt.mode": choice(
    "systemPrompt.mode",
    ["stable", "live", "legacy"],
    "System prompt sections: stable=frozen snapshot, live=refresh every turn, legacy=raw live behavior",
  ),
  "systemPrompt.wakeReplay": bool(
    "systemPrompt.wakeReplay",
    "Replay the user run's forced system-prompt bytes onto notification wake runs (cache-stable request head)",
  ),
  "systemPrompt.adoptForeignForcedPrompt": bool(
    "systemPrompt.adoptForeignForcedPrompt",
    "Adopt text appended by a later extension to the forced system prompt",
  ),
};
