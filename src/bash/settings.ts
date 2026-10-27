/**
 * bash · settings (#56 batch 2 ⑧): the `bashJobs` block's type, frozen defaults and never-throws parser.
 * `src/config/settings.ts` imports ONLY this module for the block (the secure-domain override of `bashJobs.dir`
 * stays in the aggregator).
 */

/**
 * bash auto-background (§6): the `bashJobs` settings block backing the bash
 * tool override and its BashJobManager. Every field is validated field-by-field
 * by `parseBashJobsSettings` (never throws, illegal values fall back to the
 * default) exactly like `parseWorkflowSettings`.
 */
export interface BashJobsSettings {
  /** Foreground bash calls auto-background after this duration; 0 = whole feature off (no tool override registered). Default 290_000 — 4m50s, just under the 5-minute prompt-cache TTL, so the early return rarely triggers a cache-miss price jump (R2). */
  autoBackgroundMs: number;
  /** Per-job log file cap in bytes; older output is truncated past this. Default 10 MiB. */
  maxLogBytes: number;
  /** Hard cap on concurrently running background jobs (§3.8). Default 8. */
  maxBackgroundJobs: number;
  /** Terminal job records/log files are pruned after this age. Default 24h; <= 0 disables pruning. */
  retentionMs: number;
  /** Post-exit log drain cap. Invalid values fall back to the 30s default. */
  drainTimeoutMs: number;
  /** What to do with still-running jobs on session shutdown (§3.7). Default "keep". */
  shutdownPolicy: "keep" | "kill";
  /** Job state/log root; each session uses a sanitized child directory. */
  dir?: string;
  /** Shell used to run job commands. 2026-10-17 revision: when unset, the resolution mirrors pi's built-in bash tool — pi's own `shellPath` setting (`~`-expanded, project over global) → pi's default chain (/bin/bash → bash on PATH → sh); `$SHELL` is never read. Allow-listed basenames (bash/zsh/sh) apply to both explicit paths. */
  shellPath?: string;
  /** bash-timeout-grace §5.1 (U1): subagent/child sessions get the bash override + `bash_job` tool registered. Default true; `false` = child sessions stay on today's behavior (no auto-background, no bash_job, no settle hold). */
  childSessions: boolean;
  /** bash-timeout-grace §5.1 (U2): a settling child run with non-terminal background jobs is kept alive and reminded instead of finishing immediately. Default true; `false` = no settle hold (child.ts's `agent_before_settle` handler is never registered). */
  childSettleHold: boolean;
  /** bash-timeout-grace §3.5/§5.1 (C3): hard cap on settle-hold continuation rounds for one run. `0` (default) = auto, derived per run as `2 × R_wait` from the run's own hard deadline/extension budget (§3.5) — there is no "unlimited" value, set a large number instead. Non-integer/negative → 0 (auto). */
  childSettleHoldMaxRounds: number;
  /** bash-timeout-grace §5.1 (U4): grace window after a job-level `timeout` fires before an already-backgrounded job is killed, so `bash_job(action:"extend")` has a chance to run. Default 60_000 (60s); missing/negative/NaN → default; `0` = grace off (still-foreground jobs are always killed immediately regardless of this setting, §2.3). */
  timeoutGraceMs: number;
  /** bash-timeout-grace §5.1 (U4): max number of `bash_job(action:"extend")` calls accepted per job. Default 3; non-integer/negative → 3; `0` = extend disabled, which (D-6) also disables grace for that job. */
  maxExtensions: number;
  /** bash-timeout-grace §5.1 (U4): hard lifetime ceiling as a multiple of the job's original `timeout` (`hardAt = spawnedAt + ceil(timeoutMs × maxTimeoutFactor)`). Default 3; not finite or `< 1` → 3; `1` = zero headroom ⇒ no extend, no grace. */
  maxTimeoutFactor: number;
}

/**
 * §6: parse the optional `bashJobs` settings block. Malformed/missing input
 * falls back field-by-field to DEFAULT_BASH_JOBS_SETTINGS; never throws.
 * Numbers must be finite and >= 0, `shutdownPolicy` is whitelisted, and the
 * optional string fields are dropped unless they are non-empty strings
 * (exactOptionalPropertyTypes: absent, not `undefined`).
 */
export function parseBashJobsSettings(input: unknown): BashJobsSettings {
  const defaults = DEFAULT_BASH_JOBS_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const num = (raw: unknown, fallback: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
  const str = (raw: unknown): string | undefined => (typeof raw === "string" && raw.length > 0 ? raw : undefined);
  const dir = str(value.dir);
  const shellPath = str(value.shellPath);
  // bash-timeout-grace §5.1: non-negative integer count, falling back field-by-field like every
  // other bashJobs numeric knob (childSettleHoldMaxRounds / maxExtensions share this shape; `0` is
  // a legal value for both — auto / extend-disabled — so it is never special-cased away from `defaults`).
  const intCount = (raw: unknown, fallback: number): number =>
    typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : fallback;
  return {
    autoBackgroundMs: num(value.autoBackgroundMs, defaults.autoBackgroundMs),
    maxLogBytes: num(value.maxLogBytes, defaults.maxLogBytes),
    maxBackgroundJobs: num(value.maxBackgroundJobs, defaults.maxBackgroundJobs),
    retentionMs: num(value.retentionMs, defaults.retentionMs),
    drainTimeoutMs:
      typeof value.drainTimeoutMs === "number" &&
      Number.isFinite(value.drainTimeoutMs) &&
      value.drainTimeoutMs > 0 &&
      Number.isInteger(value.drainTimeoutMs)
        ? value.drainTimeoutMs
        : defaults.drainTimeoutMs,
    shutdownPolicy:
      value.shutdownPolicy === "keep" || value.shutdownPolicy === "kill"
        ? value.shutdownPolicy
        : defaults.shutdownPolicy,
    ...(dir === undefined ? {} : { dir }),
    ...(shellPath === undefined ? {} : { shellPath }),
    // bash-timeout-grace §5.1 (U1/U2): non-boolean falls back to the default (true for both).
    childSessions: typeof value.childSessions === "boolean" ? value.childSessions : defaults.childSessions,
    childSettleHold: typeof value.childSettleHold === "boolean" ? value.childSettleHold : defaults.childSettleHold,
    // §5.1 (C3): no "unlimited" value — non-integer/negative falls back to 0 (auto), not silently clamped.
    childSettleHoldMaxRounds: intCount(value.childSettleHoldMaxRounds, defaults.childSettleHoldMaxRounds),
    // §5.1 (U4): timeoutGraceMs allows 0 (grace off), matching the `num` helper's own 0-is-legal rule.
    timeoutGraceMs: num(value.timeoutGraceMs, defaults.timeoutGraceMs),
    maxExtensions: intCount(value.maxExtensions, defaults.maxExtensions),
    // §5.1 (U4): factor is a multiplier, not a duration — allowed to be fractional, floor is 1 (not 0).
    maxTimeoutFactor:
      typeof value.maxTimeoutFactor === "number" &&
      Number.isFinite(value.maxTimeoutFactor) &&
      value.maxTimeoutFactor >= 1
        ? value.maxTimeoutFactor
        : defaults.maxTimeoutFactor,
  };
}

export const DEFAULT_BASH_JOBS_SETTINGS: BashJobsSettings = {
  autoBackgroundMs: 290_000,
  maxLogBytes: 10_485_760,
  maxBackgroundJobs: 8,
  retentionMs: 24 * 60 * 60 * 1_000,
  drainTimeoutMs: 30_000,
  shutdownPolicy: "keep",
  childSessions: true,
  childSettleHold: true,
  childSettleHoldMaxRounds: 0,
  timeoutGraceMs: 60_000,
  maxExtensions: 3,
  maxTimeoutFactor: 3,
};
