import type { Millis } from "../core/types.js";
import { isTerminalJobStatus } from "./types.js";
import type { JobDeadline, JobDeadlinePolicy, JobRecord } from "./types.js";

/**
 * bash-timeout-grace plan §2.2: job-level deadline arithmetic, deliberately
 * shaped to mirror `src/core/deadline.ts` (run-level `extendability` /
 * `graceWindow`) — same decision order, same "D-6: no extension headroom =>
 * no grace either" rule, applied to a `JobRecord`'s `deadline` instead of a
 * `RunState`'s `deadlines`.
 *
 * Layering (mirrors `src/core/deadline.ts`): **pure functions only** — no pi
 * imports, no I/O, no `Date.now()` (every `now`/`at` is passed in). The
 * manager (§2.3/§2.4, out of P1 scope) is the only caller that touches the
 * clock, timers or the job store.
 */

/** §5 defaults (U4): 60s grace, 3 extensions, 3x the original timeout as the hard cap. */
export const DEFAULT_JOB_DEADLINE_POLICY: JobDeadlinePolicy = {
  graceMs: 60_000,
  maxExtensions: 3,
  maxTimeoutFactor: 3,
};

/**
 * Build the frozen deadline for a freshly created job (§2.1): `dueAt =
 * spawnedAt + timeoutMs`, `hardAt = spawnedAt + ceil(timeoutMs *
 * maxTimeoutFactor)`. `policy` is copied verbatim (frozen — a later config
 * change never affects an already-created job). Defensive against a caller
 * passing a non-positive `timeoutMs` or an out-of-range `maxTimeoutFactor`
 * (clamped to the same floor `parseJobDeadline` accepts), so this never
 * produces a `dueAt > hardAt` record.
 */
export function createJobDeadline(timeoutMs: Millis, policy: JobDeadlinePolicy, now: Millis): JobDeadline {
  const boundedTimeout = Math.max(0, timeoutMs);
  const factor = Math.max(1, policy.maxTimeoutFactor);
  const dueAt = now + boundedTimeout;
  const hardAt = now + Math.ceil(boundedTimeout * factor);
  return {
    timeoutMs: boundedTimeout,
    policy,
    dueAt,
    hardAt,
    graces: 0,
    graceNotified: 0,
    extensions: 0,
    grantedMs: 0,
    seq: 0,
  };
}

/** Every reason `jobExtendability` can refuse eligibility for extend/grace. */
export type JobExtendabilityReason = "already_terminal" | "no_timeout" | "foreground" | "limit_reached" | "no_headroom";

/**
 * §2.2 the single eligibility judgment consumed by both `applyJobExtension`
 * (extend) and `jobGraceWindow` (D-6: grace requires the same eligibility as
 * extend) — one piece of logic, not two.
 *
 * Decision order (first match wins), per plan §2.2's table:
 * 1. terminal status                      -> `already_terminal`
 * 2. no `deadline` at all                 -> `no_timeout`
 * 3. not yet backgrounded                 -> `foreground` (§2.3: a foreground
 *    job's own timeout kills immediately — nobody is positioned to decide,
 *    U5 — so it can never be extended or graced)
 * 4. `maxExtensions <= 0` or used up       -> `limit_reached`
 * 5. `hardAt - max(now, dueAt) <= 0`       -> `no_headroom`
 * otherwise                                -> `{ ok: true, headroomMs }`
 */
export function jobExtendability(
  record: JobRecord,
  now: Millis,
): { ok: true; headroomMs: Millis } | { ok: false; reason: JobExtendabilityReason } {
  if (isTerminalJobStatus(record.status)) return { ok: false, reason: "already_terminal" };
  const d = record.deadline;
  if (d === undefined) return { ok: false, reason: "no_timeout" };
  if (record.backgroundedAt === undefined) return { ok: false, reason: "foreground" };
  if (d.policy.maxExtensions <= 0 || d.extensions >= d.policy.maxExtensions) {
    return { ok: false, reason: "limit_reached" };
  }
  const headroomMs = d.hardAt - Math.max(now, d.dueAt);
  if (headroomMs <= 0) return { ok: false, reason: "no_headroom" };
  return { ok: true, headroomMs };
}

/**
 * §2.2 grace window, capped at the hard ceiling (mirrors
 * `src/core/deadline.ts`'s `graceWindow`). Returns `undefined` (no grace) when:
 * - there is no deadline, or `policy.graceMs <= 0` (grace disabled), or
 * - `jobExtendability` is not `ok` for any reason (D-6: no extension headroom
 *   left => no grace either — a job with `extensions` exhausted, or already
 *   past `hardAt`, or still foreground, gets killed outright, not graced), or
 * - the computed window collapses to `at` or earlier (hard ceiling already reached).
 */
export function jobGraceWindow(record: JobRecord, at: Millis): Millis | undefined {
  const d = record.deadline;
  if (d === undefined || d.policy.graceMs <= 0) return undefined;
  if (!jobExtendability(record, at).ok) return undefined; // D-6
  const until = Math.min(at + d.policy.graceMs, d.hardAt);
  return until > at ? until : undefined;
}

/** Every reason `applyJobExtension` can reject a requested extension. */
export type JobExtensionReason = JobExtendabilityReason | "zero_gain";

/**
 * §2.2 apply an `extend` (the `bash_job(action:"extend")` tool, §2.6):
 * `base = max(now, dueAt)`; `next = min(base + extendMs, hardAt)`. Rejects
 * up front via `jobExtendability` (so `extend` and eligibility can never
 * disagree), then rejects a request that would produce zero net increase
 * (`next <= base` — e.g. `extendMs <= 0`, or `hardAt` already reached but
 * `jobExtendability` somehow let it through). On success: `dueAt` moves to
 * `next`, `graceUntil` is cleared (the job is no longer in grace), `extensions`
 * and `seq` bump by one, `grantedMs` accrues the actual granted delta
 * (`next - base`, which can be less than the requested `extendMs` when capped
 * by `hardAt`), and `lastReason` is set when provided.
 */
export function applyJobExtension(
  record: JobRecord,
  extendMs: Millis,
  now: Millis,
  reason?: string,
): { ok: true; record: JobRecord } | { ok: false; reason: JobExtensionReason } {
  const elig = jobExtendability(record, now);
  if (!elig.ok) return { ok: false, reason: elig.reason };
  const d = record.deadline;
  if (d === undefined) return { ok: false, reason: "no_timeout" }; // unreachable: elig.ok implies d defined
  const base = Math.max(now, d.dueAt);
  const next = Math.min(base + Math.max(0, extendMs), d.hardAt);
  if (next <= base) return { ok: false, reason: "zero_gain" };
  const { graceUntil: _droppedGraceUntil, lastReason: _droppedLastReason, ...rest } = d;
  const nextDeadline: JobDeadline = {
    ...rest,
    dueAt: next,
    extensions: d.extensions + 1,
    grantedMs: d.grantedMs + (next - base),
    seq: d.seq + 1,
    ...(reason !== undefined ? { lastReason: reason } : {}),
  };
  return { ok: true, record: { ...record, deadline: nextDeadline } };
}

/**
 * §2.5 step 2 (`adoptLocalJobs`): re-arm a job's deadline timer purely from
 * its in-memory record, with **no I/O** — the whole point being that timer
 * recovery across a handoff/reload never depends on a disk read completing
 * (§2.5 "交接期间 deadline timer 的恢复不依赖任何 I/O"). Also the core of
 * `resumeDeadline`'s three-way decision used by the manager (§2.3) whenever
 * it needs to re-derive "what should happen to this job's deadline right
 * now" without waiting for the next timer tick.
 *
 * Three outcomes (plan §2.2):
 * - `graceUntil` already set and now `<= graceUntil`'s deadline -> `expire`
 *   (the grace window itself has run out; kill).
 * - `dueAt <= now` and not already in grace -> ask `jobGraceWindow`: enters
 *   grace if it grants one, otherwise `expire` (D-6: no grace available).
 * - otherwise -> `arm` at the next relevant instant (`graceUntil` if already
 *   in grace, else `dueAt`).
 *
 * A job without a `deadline` at all yields `kind: "none"` — defensive; the
 * plan's step 2 only calls this for jobs that already carry a `deadline`,
 * but the function stays total rather than throwing on a caller mistake.
 */
export type ResumeDeadlineDecision =
  { kind: "none" } | { kind: "expire" } | { kind: "grace"; graceUntil: Millis } | { kind: "arm"; at: Millis };

export function resumeDeadline(record: JobRecord, now: Millis): ResumeDeadlineDecision {
  const d = record.deadline;
  if (d === undefined) return { kind: "none" };
  if (d.graceUntil !== undefined && d.graceUntil <= now) return { kind: "expire" };
  if (d.dueAt <= now && d.graceUntil === undefined) {
    const graceUntil = jobGraceWindow(record, now);
    return graceUntil !== undefined ? { kind: "grace", graceUntil } : { kind: "expire" };
  }
  return { kind: "arm", at: d.graceUntil ?? d.dueAt };
}
