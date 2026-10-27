/**
 * memory · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { seconds, count, bool, choice } from "../config/spec-helpers.js";
import type { SettingSpec } from "../config/spec-helpers.js";

export const MEMORY_SETTING_SPECS: Record<string, SettingSpec> = {
  // Merged armory-memory (memory-plan §3.3): all nine keys are non-live
  // (captured at activate; change → /reload). byteCap needs a max that
  // count() cannot express (Nit 1) ⇒ spread + override.
  "memory.enabled": bool("memory.enabled", "Merged project memory: injection + memory tool + /mem"),
  "memory.injectInChildSessions": bool(
    "memory.injectInChildSessions",
    "Inject the ## Memory block in child subagent sessions too",
  ),
  "memory.allowWriteInChildSessions": bool(
    "memory.allowWriteInChildSessions",
    "Allow memory write/append in child sessions (default read-only)",
  ),
  "memory.freezeInjectionAfterWrite": bool(
    "memory.freezeInjectionAfterWrite",
    "Freeze the injected block after a write (takes effect next session; keeps prompt cache stable)",
  ),
  "memory.inlineMax": count("memory.inlineMax", 0, "Memory files inlined in full (pinned first); 0 = index only"),
  "memory.byteCap": {
    // Nit 1: count() has no max parameter ⇒ spread the count spec and add max.
    // (cast: spreading the SettingSpec union distributes `max` onto non-number
    // variants; the runtime object is always the number variant.)
    ...count("memory.byteCap", 0, "Total UTF-8 byte budget for inlined memory bodies; 0 = index only"),
    max: 65_536,
  } as SettingSpec,
  "memory.indexMax": count("memory.indexMax", 1, "Memory index entries before the … +N more fold"),
  "memory.maxFileBytes": count("memory.maxFileBytes", 1024, "Per-memory-file size cap in bytes"),
  "memory.maxWriteBytes": count("memory.maxWriteBytes", 256, "Single memory write/append content cap in bytes"),
  // todo #22 optimize-plan §9 (P0-b): tiered layout / v2 tool surface knobs.
  "memory.layout": choice(
    "memory.layout",
    ["tiered", "legacy"],
    "Injection renderer: tiered (budgeted, default) or legacy (byte-identical to pre-#22)",
  ),
  "memory.toolSurface": choice(
    "memory.toolSurface",
    ["v2", "legacy"],
    "memory tool factory: v2 (official field names, default) or legacy",
  ),
  "memory.childProfile": choice(
    "memory.childProfile",
    ["core", "full", "none"],
    "Child-session injection tier under layout:tiered (core/full/none)",
  ),
  "memory.coreBytes": {
    ...count("memory.coreBytes", 256, "Primary-core byte budget within a tiered block (clamped to ≤ blockBytes-600)"),
    max: 8192,
  } as SettingSpec,
  "memory.blockBytes": {
    ...count("memory.blockBytes", 800, "Hard byte cap for the whole tiered ## Memory block"),
    max: 16384,
  } as SettingSpec,
  "memory.topicWarnBytes": {
    ...count("memory.topicWarnBytes", 1024, "Non-core file size that triggers a doctor warn (D04)"),
    max: 4 * 1024 * 1024,
  } as SettingSpec,
  "memory.topicMaxBytes": {
    ...count(
      "memory.topicMaxBytes",
      1024,
      "Non-core file size a write/append is rejected past (D05); ≥ topicWarnBytes",
    ),
    max: 4 * 1024 * 1024,
  } as SettingSpec,
  "memory.doctor.notifyOnStart": bool(
    "memory.doctor.notifyOnStart",
    "Main-session startup reminder when /mem doctor would report an error (zero model cost)",
  ),
  "memory.doctor.staleDays": {
    ...count("memory.doctor.staleDays", 7, "updated age (days) past which a file is flagged stale (D08 warn)"),
    max: 3650,
  } as SettingSpec,
  "memory.tidy.agentType": {
    kind: "string",
    path: "memory.tidy.agentType",
    description:
      "Agent type for the tidy proposal subagent's prompt/model hint only — tools are always forced readonly (§7.0)",
  },
  "memory.tidy.model": {
    kind: "string",
    path: "memory.tidy.model",
    description: 'Strict provider/id for /mem tidy, or "" to use the current main-session model',
  },
  "memory.tidy.timeoutS": seconds("memory.tidy.timeoutMs", {
    min: 30,
    max: 1800,
    hint: "hard total budget of a tidy run (no grace, no extension)",
    description: "/mem tidy run timeout",
  }),
  "memory.tidy.maxInputBytes": {
    ...count(
      "memory.tidy.maxInputBytes",
      8192,
      "Total input bytes a tidy/restore snapshot may cover before asking to narrow the file set",
    ),
    max: 262_144,
  } as SettingSpec,
  "memory.tidy.maxOutputBytes": {
    ...count(
      "memory.tidy.maxOutputBytes",
      4096,
      "Hard cap on the tidy proposal's total output bytes; over this the whole proposal is discarded",
    ),
    max: 262_144,
  } as SettingSpec,
  "memory.tidy.maxCostUsd": {
    kind: "number",
    path: "memory.tidy.maxCostUsd",
    min: 0.05,
    max: 50,
    description: "Cumulative cost cap (USD) for a tidy run; only enforced for a priced model",
  },
  "memory.tidy.maxTurns": {
    ...count("memory.tidy.maxTurns", 1, "Turn-boundary cap for a tidy run"),
    max: 20,
  } as SettingSpec,
  "memory.tidy.batch.enabled": bool("memory.tidy.batch.enabled", "Enable batched tidy planning and application"),
  "memory.tidy.batch.targetBytes": {
    ...count("memory.tidy.batch.targetBytes", 8192, "Target bytes per batch; capped by memory.tidy.maxInputBytes"),
    max: 262_144,
  } as SettingSpec,
  "memory.tidy.batch.maxModelRuns": {
    ...count("memory.tidy.batch.maxModelRuns", 1, "Maximum model runs for one batched tidy"),
    max: 20,
  } as SettingSpec,
  "memory.tidy.batch.maxTotalCostUsd": {
    kind: "number",
    path: "memory.tidy.batch.maxTotalCostUsd",
    min: 0.1,
    max: 100,
    description: "Cumulative cost cap for one batched tidy run, USD",
  },
  "memory.tidy.batch.totalTimeoutS": seconds("memory.tidy.batch.totalTimeoutMs", {
    min: 300,
    max: 7200,
    hint: "hard total budget for a batched tidy run",
    description: "Batched tidy run timeout",
  }),
  "memory.tidy.batch.outputTokPerSec": {
    kind: "number",
    path: "memory.tidy.batch.outputTokPerSec",
    min: 5,
    max: 500,
    description: "Expected model output rate for batched tidy budgeting, tokens per second",
  },
};
