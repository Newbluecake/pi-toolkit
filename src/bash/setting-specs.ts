/**
 * bash · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { seconds, count, bool, choice } from "../config/spec-helpers.js";
import type { SettingSpec } from "../config/spec-helpers.js";

export const BASH_JOBS_SETTING_SPECS: Record<string, SettingSpec> = {
  // bash auto-background (§6): v1 exposes the numeric knobs plus the shutdown
  // policy enum; bashJobs.dir / bashJobs.shellPath stay JSON-file-only.
  // bashJobs.dir is the root for per-session job directories.
  "bashJobs.autoBackgroundS": seconds("bashJobs.autoBackgroundMs", {
    hint: "0 turns the whole feature off",
    description: "Auto-background foreground bash after this",
  }),
  "bashJobs.maxLogBytes": {
    kind: "number",
    path: "bashJobs.maxLogBytes",
    min: 0,
    description: "Per-job log file cap in bytes",
  },
  "bashJobs.maxBackgroundJobs": count("bashJobs.maxBackgroundJobs", 0, "Max concurrent background jobs"),
  "bashJobs.drainTimeoutS": seconds("bashJobs.drainTimeoutMs", {
    max: 600,
    hint: "values under 1s fall back to the 30s default",
    description: "Bounded wait for post-exit log tail capture",
  }),
  "bashJobs.retentionS": seconds("bashJobs.retentionMs", {
    description: "Terminal job records pruned after this age",
  }),
  "bashJobs.shutdownPolicy": choice(
    "bashJobs.shutdownPolicy",
    ["keep", "kill"],
    "What to do with running jobs on shutdown",
  ),
  // bash-timeout-grace §5.1 (P2): child/subagent bash auto-background, job-level timeout grace,
  // extend cap, hard lifetime factor, and settle-hold controls. Same JSON-file-only exception
  // (dir/shellPath) does not apply here — all six of these are plain settable knobs.
  "bashJobs.childSessions": bool(
    "bashJobs.childSessions",
    "Register bash auto-background + bash_job in child/subagent sessions",
  ),
  "bashJobs.childSettleHold": bool(
    "bashJobs.childSettleHold",
    "Keep a settling child run alive while it still has running background jobs",
  ),
  "bashJobs.childSettleHoldMaxRounds": count(
    "bashJobs.childSettleHoldMaxRounds",
    0,
    'Settle-hold continuation round cap; 0 = auto (derived per run, no "unlimited" value)',
  ),
  "bashJobs.timeoutGraceS": seconds("bashJobs.timeoutGraceMs", {
    hint: "0 disables the grace window",
    description: "Grace window after a backgrounded job's timeout before it is killed",
  }),
  "bashJobs.maxExtensions": count(
    "bashJobs.maxExtensions",
    0,
    "Max bash_job(extend) calls per job; 0 disables extend (and grace)",
  ),
  "bashJobs.maxTimeoutFactor": {
    kind: "number",
    path: "bashJobs.maxTimeoutFactor",
    min: 1,
    description: "Hard lifetime ceiling as a multiple of the job's original timeout; 1 = zero headroom",
  },
};
