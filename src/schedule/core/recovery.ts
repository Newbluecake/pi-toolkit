/**
 * Scheduled tasks — holder identity, liveness and run recovery (plan r3 §4.6, S1).
 *
 * A `Holder` (pid + /proc starttime + host + boot id + per-stack epoch) owns every non-terminal
 * run, note and digest claim (the session lock is a kernel flock — no liveness judgment needed).
 * Liveness is judged deterministically (M-T4 —
 * age is NEVER proof of death):
 *   - different host                                   ⇒ unprovable (never converted; E_BUSY)
 *   - same host, different boot id                      ⇒ dead (crash)
 *   - same host+boot, pid gone (ESRCH) or starttime ≠   ⇒ dead (crash)
 *   - same process (pid+start), epoch ≠ current and the
 *     caller KNOWS that epoch was disposed              ⇒ dead (reload)
 *   - anything else (incl. EPERM, unreadable /proc)     ⇒ alive / unprovable
 * Recovery converts non-terminal runs of dead holders to `unknown(<crash|reload>)` (queued messages
 * become `dropped(owner-closed)`); the shutdown path converts its OWN epoch's runs to
 * `unknown(owner-closed)`. First terminal write wins — later outcomes are only `lateOutcome`.
 *
 * Hub-importable (read-only /proc probes; boundary-pinned closure).
 */
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { isTerminalRunState, type Holder, type RunRecord, type ScheduleStateFile } from "./spec.js";

export interface ProcessIdentity {
  pid: number;
  /** /proc/<pid>/stat field 22 (starttime, clock ticks since boot). */
  start: number;
  host: string;
  boot: string;
}

/** Read-only process probes (injectable for tests). */
export interface LivenessProbe {
  /** starttime of `pid`, `undefined` when /proc has no such process, `"error"` when unreadable. */
  startOf(pid: number): number | undefined | "error";
  /** `false` only on proven ESRCH. */
  pidMayExist(pid: number): boolean;
}

function readStartTicks(pid: number): number | undefined | "error" {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? undefined : "error";
  }
  const close = raw.lastIndexOf(")");
  if (close < 0) return "error";
  const fields = raw
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const n = Number(fields[19]);
  return Number.isSafeInteger(n) && n >= 0 ? n : "error";
}

export const procLivenessProbe: LivenessProbe = Object.freeze({
  startOf: readStartTicks,
  pidMayExist(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
  },
});

export function readBootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** This process's identity, or `undefined` when /proc is unavailable (then nothing can be claimed). */
export function readSelfIdentity(): ProcessIdentity | undefined {
  const start = readStartTicks(process.pid);
  const boot = readBootId();
  if (typeof start !== "number" || boot === undefined) return undefined;
  return { pid: process.pid, start, host: hostname(), boot };
}

export type Liveness = "alive" | "dead" | "unprovable";
export type DeathCause = "crash" | "reload";

export interface LivenessVerdict {
  liveness: Liveness;
  cause?: DeathCause;
}

export interface JudgeOpts {
  probe?: LivenessProbe;
  /** Current stack epoch of THIS process (same-process holders with another epoch may be stale). */
  currentEpoch?: string;
  /** True ⇔ this process knows `epoch` was disposed (A0 keeps that set). Default: never. */
  epochDisposed?: (epoch: string) => boolean;
}

/** Deterministic liveness of `holder` as seen from `self` (rules in the module header). */
export function judgeHolder(
  holder: Pick<Holder, "pid" | "start" | "host" | "boot"> & { epoch?: string },
  self: ProcessIdentity,
  opts: JudgeOpts = {},
): LivenessVerdict {
  if (holder.host !== self.host) return { liveness: "unprovable" };
  if (holder.boot !== self.boot) return { liveness: "dead", cause: "crash" };
  if (holder.pid === self.pid && holder.start === self.start) {
    if (holder.epoch !== undefined && opts.currentEpoch !== undefined && holder.epoch !== opts.currentEpoch) {
      return opts.epochDisposed?.(holder.epoch) === true
        ? { liveness: "dead", cause: "reload" }
        : { liveness: "alive" };
    }
    return { liveness: "alive" };
  }
  const probe = opts.probe ?? procLivenessProbe;
  const start = probe.startOf(holder.pid);
  if (start === "error") return { liveness: "unprovable" };
  if (start === undefined)
    return probe.pidMayExist(holder.pid) ? { liveness: "unprovable" } : { liveness: "dead", cause: "crash" };
  return start === holder.start ? { liveness: "alive" } : { liveness: "dead", cause: "crash" };
}

export function holderOf(self: ProcessIdentity, epoch: string): Holder {
  return { pid: self.pid, start: self.start, host: self.host, boot: self.boot, epoch };
}

export function sameHolder(a: Holder, b: Holder): boolean {
  return a.pid === b.pid && a.start === b.start && a.host === b.host && a.boot === b.boot && a.epoch === b.epoch;
}

// ----------------------------------------------------------------- run recovery (pure, on a draft)

export interface RecoveredRun {
  runKey: string;
  from: RunRecord["state"];
  to: RunRecord["state"];
  reason: string;
}

function terminate(run: RunRecord, cause: "owner-closed" | DeathCause, now: number): RecoveredRun {
  const from = run.state;
  if (run.state === "queued") {
    run.state = "dropped";
    run.reason = "owner-closed";
  } else {
    run.state = "unknown";
    run.reason = cause;
  }
  run.endedAt = now;
  return { runKey: run.runKey, from, to: run.state, reason: run.reason };
}

/**
 * Convert every non-terminal run whose holder is DEAD to `unknown(crash|reload)` (queued ⇒
 * `dropped(owner-closed)`). Alive/unprovable holders are left alone (cross-host ⇒ E_BUSY territory).
 * Mutates `draft`; returns what changed (empty ⇒ no write needed).
 */
export function recoverDeadRuns(
  draft: ScheduleStateFile,
  self: ProcessIdentity,
  now: number,
  opts: JudgeOpts = {},
): RecoveredRun[] {
  const out: RecoveredRun[] = [];
  for (const run of draft.runs) {
    if (isTerminalRunState(run.state)) continue;
    const v = judgeHolder(run.holder, self, opts);
    if (v.liveness === "dead") out.push(terminate(run, v.cause ?? "crash", now));
  }
  return out;
}

/** Shutdown/dispose (§4.6 正常关闭): this epoch's non-terminal runs ⇒ `unknown(owner-closed)`. */
export function closeEpochRuns(draft: ScheduleStateFile, holder: Holder, now: number): RecoveredRun[] {
  const out: RecoveredRun[] = [];
  for (const run of draft.runs) {
    if (!isTerminalRunState(run.state) && sameHolder(run.holder, holder)) out.push(terminate(run, "owner-closed", now));
  }
  return out;
}

/** Read-only variant for the hub (§7.2 结果未知): runKeys that are `unknown`, or non-terminal with a dead holder. */
export function unknownRunKeys(state: ScheduleStateFile, self: ProcessIdentity, opts: JudgeOpts = {}): string[] {
  const out: string[] = [];
  for (const run of state.runs) {
    if (run.state === "unknown") out.push(run.runKey);
    else if (!isTerminalRunState(run.state) && judgeHolder(run.holder, self, opts).liveness === "dead")
      out.push(run.runKey);
  }
  return out;
}
