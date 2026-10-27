/**
 * workflow · settings (#56 batch 2 ⑧): the `workflow` block's types (incl. the WT1–WT19 budget shape), frozen
 * defaults and never-throws parser. `src/config/settings.ts` imports ONLY this module for the block.
 */
import type { Millis } from "../core/types.js";

/**
 * CC3 (workflow design §3.2/§8.2): forward-declared budget shape for the
 * future workflow engine (M3.1+). Only the *type* and its settings-surface
 * defaults are introduced in this milestone — no orchestrator, no runner, no
 * scripts. Field defaults mirror the WT1–WT19 timeout matrix (§4.1).
 */
export interface WorkflowBudget {
  /** WT1 */ scriptLoadMs: Millis;
  /** WT2 */ scriptSliceMs: Millis;
  /** WT3 */ workerBootMs: Millis;
  /** WT4 */ hostCallMs: Millis;
  /** WT6 */ gateMs: Millis;
  /** WT7 (0 = unlimited, still bounded by workflowTotalMs) */ phaseTotalMs: Millis;
  /** WT8 */ workflowTotalMs: Millis;
  /** WT9 (diagnostic only, see RunawayPolicy) */ heartbeatStallMs: Millis;
  /** WT10 */ abortGraceMs: Millis;
  /** WT11 */ terminateConfirmMs: Millis;
}

export const DEFAULT_WORKFLOW_BUDGET: WorkflowBudget = {
  scriptLoadMs: 5_000,
  scriptSliceMs: 2_000,
  workerBootMs: 10_000,
  hostCallMs: 60_000,
  gateMs: 600_000,
  phaseTotalMs: 0,
  workflowTotalMs: 3_600_000,
  heartbeatStallMs: 10_000,
  abortGraceMs: 10_000,
  terminateConfirmMs: 2_000,
};

/**
 * CC3/§2.3 HB2–HB5: heartbeat stall is a diagnostic/fast-detection signal,
 * never the hard termination guarantee (that's the absolute workflowTotalMs
 * deadline, CC4). "diagnose_only" (default) never terminates on stall alone.
 */
export type RunawayPolicy = "diagnose_only" | "terminate_on_stall";

export interface WorkflowSettings {
  /** Master switch; the workflow engine (M3.1+) is entirely inert while false. */
  enabled: boolean;
  budget: Partial<WorkflowBudget>;
  journalDir?: string;
  /** Default 7 days (§6.4 RP6); 0 = unlimited. */
  replayTtlMs: number;
  replayScope: "chain" | "content";
  runawayPolicy: RunawayPolicy;
  /**
   * replay-verify plan D9 (用户确认 1): whether a replayed `isolation:
   * "worktree"` call's journaled branch is checked against a load-time
   * snapshot before being reused. `"verify"` (default): only a `committed`
   * entry whose `pi-agent-<runId>` branch still exists and points EXACTLY at
   * the recorded commit at run start may be replayed; `clean` entries are
   * never checked (D3.1: same non-checking semantics as an ordinary call).
   * `"off"` restores the pre-plan behavior byte-for-byte (an isolated call
   * is unconditionally live, never journaled) — see the plan's D9 for the
   * exact scope of that guarantee.
   */
  isolationReplay: "verify" | "off";
}

/** CC3: parse the optional `workflow` settings block; malformed/missing input falls back field-by-field to DEFAULT_WORKFLOW_SETTINGS (never throws, matches the rest of loadSettings' tolerance). */
export function parseWorkflowSettings(input: unknown): WorkflowSettings {
  const defaults = DEFAULT_WORKFLOW_SETTINGS;
  if (!input || typeof input !== "object") return { ...defaults };
  const value = input as Record<string, unknown>;
  const budget = value.budget && typeof value.budget === "object" ? (value.budget as Partial<WorkflowBudget>) : {};
  const validBudgetKeys = Object.keys(DEFAULT_WORKFLOW_BUDGET) as (keyof WorkflowBudget)[];
  const cleanedBudget: Partial<WorkflowBudget> = {};
  for (const key of validBudgetKeys) {
    const v = budget[key];
    if (typeof v !== "number" || !(v >= 0)) continue;
    // workflow-agent-queue §0/Major-2 (same shape as the subagent D-11 rule):
    // workflowTotalMs must be > 0. BW10 ("0 = no workflow cap") never worked in
    // background mode — background.ts bounds its driver race by
    // workflowTotalMs + slack, so 0 ended every run after ~14s — and a queued
    // agent() call needs a finite ack.deadlineAt. Drop it here so the default
    // applies; loadSettingsFromFile WARNs once.
    if (key === "workflowTotalMs" && v <= 0) continue;
    cleanedBudget[key] = v;
  }
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    budget: cleanedBudget,
    ...(typeof value.journalDir === "string" ? { journalDir: value.journalDir } : {}),
    replayTtlMs:
      typeof value.replayTtlMs === "number" && value.replayTtlMs >= 0 ? value.replayTtlMs : defaults.replayTtlMs,
    replayScope:
      value.replayScope === "chain" || value.replayScope === "content" ? value.replayScope : defaults.replayScope,
    runawayPolicy:
      value.runawayPolicy === "diagnose_only" || value.runawayPolicy === "terminate_on_stall"
        ? value.runawayPolicy
        : defaults.runawayPolicy,
    isolationReplay:
      value.isolationReplay === "verify" || value.isolationReplay === "off"
        ? value.isolationReplay
        : defaults.isolationReplay,
  };
}

export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {
  enabled: false,
  budget: {},
  replayTtlMs: 7 * 24 * 60 * 60 * 1_000,
  replayScope: "chain",
  runawayPolicy: "diagnose_only",
  isolationReplay: "verify",
};
