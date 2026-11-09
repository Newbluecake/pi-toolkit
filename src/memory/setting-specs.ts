/**
 * memory · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { seconds, count, bool, choice, csvString } from "../config/spec-helpers.js";
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
  "memory.inlineMax": count(
    "memory.inlineMax",
    0,
    "Memory files inlined in full (pinned first); 0 = index only (legacy layout only)",
  ),
  "memory.byteCap": {
    // Nit 1: count() has no max parameter ⇒ spread the count spec and add max.
    // (cast: spreading the SettingSpec union distributes `max` onto non-number
    // variants; the runtime object is always the number variant.)
    ...count(
      "memory.byteCap",
      0,
      "Total UTF-8 byte budget for inlined memory bodies; 0 = index only (legacy layout only)",
    ),
    max: 65_536,
  } as SettingSpec,
  "memory.indexMax": count("memory.indexMax", 1, "Memory index entries before the … +N more fold (legacy layout only)"),
  "memory.maxFileBytes": count("memory.maxFileBytes", 1024, "Per-memory-file size cap in bytes"),
  "memory.maxWriteBytes": count("memory.maxWriteBytes", 256, "Single memory write/append content cap in bytes"),
  // todo #22 optimize-plan §9 (P0-b): tiered layout / v2 tool surface knobs.
  "memory.layout": choice(
    "memory.layout",
    ["tiered", "legacy", "blocks"],
    "Injection renderer: blocks (default, one file per block), tiered (budgeted files), or legacy (byte-identical to pre-#22)",
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
    ...count(
      "memory.coreBytes",
      256,
      "Primary-core byte budget within a tiered block; clamped to ≤ blockBytes-600 (tiered layout only)",
    ),
    max: 8192,
  } as SettingSpec,
  "memory.blockBytes": {
    ...count("memory.blockBytes", 800, "Hard byte cap for the whole tiered ## Memory block (tiered layout only)"),
    max: 16384,
  } as SettingSpec,
  "memory.topicWarnBytes": {
    ...count("memory.topicWarnBytes", 1024, "Non-core file size that triggers a doctor warn (D04; tiered layout only)"),
    max: 4 * 1024 * 1024,
  } as SettingSpec,
  "memory.topicMaxBytes": {
    ...count(
      "memory.topicMaxBytes",
      1024,
      "Non-core file size a write/append is rejected past (D05); ≥ topicWarnBytes (tiered layout only)",
    ),
    max: 4 * 1024 * 1024,
  } as SettingSpec,
  // #36 memory-governance plan §4 P0 / arch §4.6：新键只解析不消费
  //（迁移器 P2、渲染 P3、治理 P5a/P5b）；均非 live（改后需 /reload）。
  "memory.migrate.auto": bool(
    "memory.migrate.auto",
    "Lazy blocks-layout migration at session start (#36); off = explicit /mem migrate only",
  ),
  "memory.residentBytes": {
    ...count(
      "memory.residentBytes",
      512,
      "Soft byte budget for the resident user-rule region (blocks layout, #36); over-budget merges/demotes are suggested, never truncated",
    ),
    max: 16384,
  } as SettingSpec,
  "memory.governance.enabled": bool(
    "memory.governance.enabled",
    "Governance sweep, auto-supersede and suggestions (#36); rendering-time expiry filtering stays on when off",
  ),
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
  // jev-plan v2 §4 J3 (jev-arch §9.1): 15 keys (14 − gate×2 removed 2026-11 + fastPath×3 of
  // the 2026-11-03 noise fix), non-live (change → /reload). `classifiersRejected`
  // is NOT a setting key (parse-time derived, doctor/startup-reminder display only).
  "memory.jev.enabled": bool(
    "memory.jev.enabled",
    "Jev-assisted memory: classifier-backed recall, tagging, review (Q27 default on)",
  ),
  "memory.jev.classifiers": csvString(
    "memory.jev.classifiers",
    "Ordered provider/id classifier list; empty or all-invalid ⇒ jev off (Q34)",
  ),
  "memory.jev.proxy": {
    kind: "string",
    path: "memory.jev.proxy",
    description: "Dedicated proxy URL for Jev classify calls; empty = no proxy fetch",
  },
  "memory.jev.childSessions": bool("memory.jev.childSessions", "Wire Jev recall in child subagent sessions too"),
  "memory.jev.recall.threshold": {
    kind: "number",
    path: "memory.jev.recall.threshold",
    min: 0.5,
    max: 0.99,
    description: "Recall verdict probability threshold",
  },
  "memory.jev.recall.maxEntries": {
    ...count("memory.jev.recall.maxEntries", 1, "Max entries injected per recall"),
    max: 10,
  } as SettingSpec,
  "memory.jev.recall.maxBytes": {
    ...count("memory.jev.recall.maxBytes", 512, "Byte budget for one recall injection"),
    max: 16384,
  } as SettingSpec,
  "memory.jev.recall.waitS": seconds("memory.jev.recall.waitMs", {
    min: 0,
    max: 3,
    hint: "synchronous wait budget before async recall fallback",
    description: "Synchronous wait budget before falling back to async recall; 0 = pure async (Q37)",
  }),
  "memory.jev.review.intervalDays": {
    ...count("memory.jev.review.intervalDays", 0, "Tag review interval in days; 0 = manual only"),
    max: 90,
  } as SettingSpec,
  "memory.jev.maxCostUsd": {
    kind: "number",
    path: "memory.jev.maxCostUsd",
    min: 0.01,
    max: 5,
    description: "Per-activation Jev call budget, USD",
  },
  "memory.jev.maxCalls": {
    ...count("memory.jev.maxCalls", 0, "Per-activation Jev call count cap"),
    max: 5000,
  } as SettingSpec,
  "memory.jev.backgroundQueueLimit": {
    ...count(
      "memory.jev.backgroundQueueLimit",
      1,
      "Maximum running and queued Jev background jobs; reject new jobs when full",
    ),
    max: 1024,
  } as SettingSpec,
  "memory.jev.fastPathAllowTags": csvString(
    "memory.jev.fastPathAllowTags",
    "Extra tag ids allowed to trigger the A-layer fast path (default: risk:high tags only)",
  ),
  "memory.jev.fastPathDenyTags": csvString(
    "memory.jev.fastPathDenyTags",
    "Tag ids never allowed to trigger the A-layer fast path (wins over risk/allow)",
  ),
  "memory.jev.fastPathCooldownH": {
    ...count(
      "memory.jev.fastPathCooldownH",
      0,
      "Per-entry cross-session A-layer cooldown, hours; 0 = off (U layer unaffected)",
    ),
    max: 720,
  } as SettingSpec,
  // memory-predict plan.md §10/§11.1: 14 `memory.jev.predict.*` keys (P1b wires
  // rules/state/carry/select off these; `model.*` is parsed here but only
  // consumed starting P2, §11.2). `model.waitS`/`model.requestBudgetS` follow
  // the shared duration convention (tui-settings requirement 2): the file and
  // both settings surfaces see integer seconds under the `*S` key, `spec.path`
  // points at the internal millisecond field, and the `*S⇄*Ms` conversion is
  // registered in TIME_SETTING_MS_PATHS (src/config/settings.ts).
  "memory.jev.predict.enabled": bool(
    "memory.jev.predict.enabled",
    "Predictive pre-injection (rule engine + deepseek backfill, P layer)",
  ),
  "memory.jev.predict.childSessions": bool(
    "memory.jev.predict.childSessions",
    "Run the P-layer rule engine (and S state constraint) in child subagent sessions too",
  ),
  "memory.jev.predict.maxEntries": {
    ...count("memory.jev.predict.maxEntries", 1, "Max P-layer entries injected per turn (S counted separately)"),
    max: 5,
  } as SettingSpec,
  "memory.jev.predict.maxBytes": {
    ...count("memory.jev.predict.maxBytes", 512, "Byte budget for P-layer entries plus the S state entry"),
    max: 8192,
  } as SettingSpec,
  "memory.jev.predict.cooldownH": {
    ...count("memory.jev.predict.cooldownH", 0, "Per-entry cross-session P-layer cooldown, hours; 0 = off"),
    max: 168,
  } as SettingSpec,
  "memory.jev.predict.hintU": bool(
    "memory.jev.predict.hintU",
    "P1b: feed predicted tags as a U-layer recall hint (default off, needs recall eval support first)",
  ),
  "memory.jev.predict.model.enabled": bool(
    "memory.jev.predict.model.enabled",
    "deepseek-flash backfill for uncertain predictions (parsed in P1b, used starting P2)",
  ),
  "memory.jev.predict.model.models": csvString(
    "memory.jev.predict.model.models",
    "Ordered provider/id model chain for the predict backfill call (P2)",
  ),
  "memory.jev.predict.model.threshold": {
    kind: "number",
    path: "memory.jev.predict.model.threshold",
    min: 0.5,
    max: 0.95,
    description: "Predict model tag acceptance probability threshold (P2)",
  },
  "memory.jev.predict.model.waitS": seconds("memory.jev.predict.model.waitMs", {
    max: 1.5,
    hint: "base wait for the predict model call before falling back (P2)",
    description: "Base wait (seconds) for the predict model call before falling back (P2)",
  }),
  "memory.jev.predict.model.requestBudgetS": seconds("memory.jev.predict.model.requestBudgetMs", {
    min: 1,
    max: 6,
    hint: "hard deadline for the predict model request chain, covering all failover (P2)",
    description: "Hard deadline (seconds) for the predict model request chain, covering all failover (P2)",
  }),
  "memory.jev.predict.model.maxCallsPerDay": {
    ...count("memory.jev.predict.model.maxCallsPerDay", 0, "Predict model calls per day cap; 0 = never call (P2)"),
    max: 500,
  } as SettingSpec,
  "memory.jev.predict.model.maxUsdPerDay": {
    kind: "number",
    path: "memory.jev.predict.model.maxUsdPerDay",
    min: 0,
    max: 1,
    description: "Predict model estimated daily spend cap, USD (conditional estimate, P2)",
  },
  "memory.jev.predict.cacheTtlMin": {
    ...count("memory.jev.predict.cacheTtlMin", 1, "Session-local predict cache TTL, minutes (P2)"),
    max: 240,
  } as SettingSpec,
  // #39 intentional additive settings. Both remain non-live and default on.
  "memory.scopes.session": bool(
    "memory.scopes.session",
    "Session-scoped memory and child snapshots (default on; requires /reload)",
  ),
  "memory.scopes.hub": bool(
    "memory.scopes.hub",
    "Shared Hub memory with exact-content human approval (default on; requires /reload; forced off in secure domains)",
  ),
};
