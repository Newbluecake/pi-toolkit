/** Every's one-window verdict. No enumeration, IO, clocks or pi in the planner. */
import { everyCount, EVERY_GRACE_MS, nextEvery } from "./every.js";
import {
  autoRunKey,
  defHash,
  type CatchUp,
  type EveryWhen,
  type Holder,
  type MissedCause,
  type MissedEntry,
  type OccState,
  type ScheduleTask,
} from "./spec.js";
import type { AutoClaimResult, ClaimGate } from "./claim.js";
import { nonTerminalRuns, type SessionStore } from "./writer.js";

export interface EveryDuePlan {
  defHash: string;
  decidedThrough: number;
  validUntil: number;
  latest?: number;
  dueCount: number;
  catchUp?: CatchUp;
}
export function planEveryDue(task: ScheduleTask, occ: OccState, now: number, openedAt: number): EveryDuePlan {
  const p: EveryDuePlan = {
    defHash: defHash(task),
    decidedThrough: occ.decidedThrough,
    validUntil: Number.POSITIVE_INFINITY,
    dueCount: 0,
  };
  if (task.when.kind !== "every") return p;
  const w = task.when;
  const n = everyCount(w, occ.decidedThrough, now);
  const next = nextEvery(w, now);
  p.validUntil = next === undefined ? Number.POSITIVE_INFINITY : next - 1;
  if (n === 0) return p;
  const first = nextEvery(w, occ.decidedThrough)!;
  const t = first + (n - 1) * w.everyMs;
  p.latest = t;
  p.dueCount = n;
  if (now <= t + EVERY_GRACE_MS) p.validUntil = Math.min(p.validUntil, t + EVERY_GRACE_MS);
  const cause = occ.resumePending
    ? "resume"
    : first < openedAt
      ? "reopen"
      : n > 1 || now - t > 60_000
        ? "late"
        : undefined;
  if (cause !== undefined)
    p.catchUp = { cause, fromExclusive: occ.decidedThrough, through: t, dueCount: n, recoveredAt: now };
  return p;
}
/** Account all M missed points but materialize only the final ≤64 chunks. Steps are observable for tests. */
export function appendEveryMissed(
  occ: OccState,
  w: EveryWhen,
  count: number,
  hash: string,
  cause: MissedCause,
  now: number,
  step?: () => void,
): MissedEntry[] {
  if (count === 0) return [];
  const from = occ.decidedThrough;
  const first = nextEvery(w, from)!;
  const chunks = Math.ceil(count / 10_000);
  const oldTotal = occ.missedTotal;
  const oldSeq = occ.missedLog.at(-1)?.seq ?? 0;
  const entries: MissedEntry[] = [];
  for (let j = Math.max(0, chunks - 64); j < chunks; j++) {
    step?.();
    const before = j * 10_000;
    const n = Math.min(10_000, count - before);
    entries.push({
      seq: oldSeq + j + 1,
      defHash: hash,
      from: j === 0 ? from : first + (before - 1) * w.everyMs,
      to: first + (before + n - 1) * w.everyMs,
      count: n,
      totalAfter: oldTotal + before + n,
      at: now,
      cause,
    });
  }
  occ.missedTotal += count;
  occ.missedLog = [...occ.missedLog, ...entries].slice(-64);
  return entries;
}
export async function reconcileEvery(
  store: SessionStore,
  input: { taskId: string; holder: Holder; openedAt: number; deadlineMono: number; gate: ClaimGate },
): Promise<AutoClaimResult> {
  // Runtime locked must refuse before reading or taking any lock.
  const denied = input.gate();
  if (denied !== undefined) return { kind: "ineligible", reason: "gate", detail: denied.code };
  const r = await store.transactPlanned<EveryDuePlan, AutoClaimResult>(
    (snap, now) => {
      const task = snap.tasks.find((t) => t.id === input.taskId);
      const occ = snap.occ[input.taskId];
      if (task === undefined || occ === undefined || task.when.kind !== "every" || !task.enabled)
        return { done: { kind: "ineligible", reason: "not-executable" } };
      if (occ.defHash !== defHash(task)) return { done: { kind: "ineligible", reason: "def-changed" } };
      return { plan: planEveryDue(task, occ, now, input.openedAt) };
    },
    (draft, p, ctx) => {
      const gate = input.gate();
      if (gate !== undefined) return { value: { kind: "ineligible", reason: "gate", detail: gate.code }, write: false };
      const task = draft.tasks.find((t) => t.id === input.taskId);
      const occ = draft.occ[input.taskId];
      if (
        task === undefined ||
        occ === undefined ||
        !task.enabled ||
        task.when.kind !== "every" ||
        defHash(task) !== p.defHash ||
        occ.defHash !== p.defHash ||
        occ.decidedThrough !== p.decidedThrough
      )
        return { value: { kind: "ineligible", reason: "def-changed" }, write: false };
      // Recompute the label at LOCK time (source-independent); rev/watermark/validUntil checked by writer.
      const locked = planEveryDue(task, occ, ctx.now, input.openedAt);
      const pending = occ.resumePending === true;
      delete occ.resumePending;
      const t = locked.latest,
        n = locked.dueCount;
      if (t === undefined) return { value: { kind: "lost" }, write: pending };
      if (nonTerminalRuns(draft, task.id).length > 0) {
        occ.skippedTotal += n;
        occ.decidedThrough = t;
        return { value: { kind: "overlap", skipped: n, missed: [] }, write: true };
      }
      const expired = ctx.now - t > EVERY_GRACE_MS;
      const missed = appendEveryMissed(occ, task.when, expired ? n : n - 1, p.defHash, "late", ctx.now);
      occ.decidedThrough = t;
      if (expired) return { value: { kind: "missed", missed }, write: true };
      const key = autoRunKey(task.id, t);
      if (draft.runs.some((r) => r.runKey === key)) return { value: { kind: "lost" }, write: false };
      occ.firedTotal++;
      const run = {
        runKey: key,
        taskId: task.id,
        kind: "auto" as const,
        form: task.form,
        scheduledAt: t,
        defHash: p.defHash,
        state: task.form === "background" ? ("dispatching" as const) : ("queued" as const),
        holder: input.holder,
        startedAt: ctx.now,
        note: "none" as const,
        ...(locked.catchUp === undefined ? {} : { catchUp: locked.catchUp }),
      };
      draft.runs.push(run);
      return { value: { kind: "fired", run: structuredClone(run), skipped: 0, missed }, write: true };
    },
    { deadlineMono: input.deadlineMono },
  );
  return r.ok
    ? r.value
    : { kind: "error", code: r.code, detail: r.detail, ...(r.uncertain ? { uncertain: true } : {}) };
}
