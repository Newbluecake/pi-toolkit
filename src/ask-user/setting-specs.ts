/**
 * ask-user · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { seconds, count, bool } from "../config/spec-helpers.js";
import type { SettingSpec } from "../config/spec-helpers.js";

export const ASK_USER_SETTING_SPECS: Record<string, SettingSpec> = {
  "askUser.enabled": bool("askUser.enabled", "Interactive ask_user question tool (main session only)"),
  // ask-user-async plan §6.1 (P2): background-completion interrupt knobs. The
  // four durations are stored/edited as integer seconds (`*S` keys) over
  // internal `*Ms` paths (TIME_SETTING_MS_PATHS); maxPerQuestion is a plain
  // count (1–10, count() has no max ⇒ spread + override, memory.byteCap 同款).
  "askUser.backgroundInterrupt.enabled": bool(
    "askUser.backgroundInterrupt.enabled",
    "ask_user: pause the dialog when background subagent/workflow/bash completions arrive (main-session TUI)",
  ),
  "askUser.backgroundInterrupt.delayS": seconds("askUser.backgroundInterrupt.delayMs", {
    max: 10,
    description: "ask_user interrupt: merge window after the first background completion (0 = next macrotask)",
  }),
  "askUser.backgroundInterrupt.quietS": seconds("askUser.backgroundInterrupt.quietMs", {
    max: 30,
    description: "ask_user interrupt: quiet period after the last keystroke before pausing (0 = no typing protection)",
  }),
  "askUser.backgroundInterrupt.maxDeferS": seconds("askUser.backgroundInterrupt.maxDeferMs", {
    max: 120,
    description: "ask_user interrupt: max extra deferral while the user keeps typing (clamped >= quietS)",
  }),
  "askUser.backgroundInterrupt.reaskDwellS": seconds("askUser.backgroundInterrupt.reaskDwellMs", {
    max: 60,
    description: "ask_user interrupt: dwell period after a re-asked dialog mounts (0 = no dwell)",
  }),
  "askUser.backgroundInterrupt.maxPerQuestion": {
    ...count(
      "askUser.backgroundInterrupt.maxPerQuestion",
      1,
      "ask_user interrupt: per-question interrupt budget; exhausted = back to blocking (accepted degradation)",
    ),
    max: 10,
  } as SettingSpec,
  "askUser.backgroundInterrupt.rpc": bool(
    "askUser.backgroundInterrupt.rpc",
    "ask_user interrupt in RPC mode too (default off; known limitation: no client-side dialog retraction)",
  ),
};
