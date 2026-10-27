/**
 * external-agent · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { bool, choice } from "../config/spec-helpers.js";
import type { SettingSpec } from "../config/spec-helpers.js";

export const EXTERNAL_AGENTS_SETTING_SPECS: Record<string, SettingSpec> = {
  // external-agent plan §6.2 P4a 验收③：TUI 只暴露这三个叶子。其余
  // `externalAgents.droid.*`（binary / models / advertiseMax / pricing / 各超时）
  // 是 JSON-only 设置（写入 settings 文件即可，非 live），故意不进本表。
  "externalAgents.droid.enabled": bool(
    "externalAgents.droid.enabled",
    "Route subagent runs to the external Factory droid CLI as virtual provider droid/<model> (default off)",
  ),
  "externalAgents.droid.injectMemory": bool(
    "externalAgents.droid.injectMemory",
    "Inject the project memory block into external agent runs (child-session profile)",
  ),
  "externalAgents.droid.protocolCheck": choice(
    "externalAgents.droid.protocolCheck",
    ["strict", "warn"],
    "Droid protocol version check: strict = fail the provider on mismatch, warn = degrade and continue",
  ),
};
