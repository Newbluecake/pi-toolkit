/**
 * Scheduled tasks — claim / sweep / recovery transactions (plan r3 §4.5a, §4.5b, §4.4, §4.6, S1).
 *
 * Every function here is ONE single-file transaction (writer.ts): synchronous work under the lock,
 * one atomic write; all cron work in the lock-free planning step.
 *
 * Auto claim (§4.5a) — outcome kinds:
 *   fired      — RunRecord{auto, dispatching|queued} + `decidedThrough = T` + `firedTotal++`;
 *   overlap    — background task already has a non-terminal run: `skippedTotal++`, watermark → T;
 *   missed     — lock obtained after `T + tol` (late branch): MissedEntry(cause "late") over
 *                (decidedThrough, T], watermark → T;
 *   lost       — T already decided;
 *   ineligible — not executable / not an occurrence of the current definition / armed after T /
 *                gate refused — NOTHING written (sweep decides T later).
 * Before a non-late fire, older undecided occurrences that are already past tolerance are recorded
 * as missed ("late"), and undecided ones still inside tolerance but earlier than T are coalesced
 * into this fire (`skippedTotal`) — so the watermark can never jump over an occurrence silently.
 * message form, D13: an existing `queued` run becomes `dropped(coalesced)` (`skippedTotal++`) and
 * the new one queues; in-flight dispatched/bound/aborting runs continue.
 *
 * Manual claim (§4.5b): never reads or writes the auto watermark, `firedTotal` or missedLog; needs
 * an executable task (and the caller's `defHash`, when given), the gate, no non-terminal run;
 * idempotent by `reqId` through `manualReqs` (refusals are recorded too).
 */
import { isOccurrence, nextOccurrence, occurrencesBetween } from "./cron.js";
import {
  appendMissed,
  applySweep,
  compileTask,
  planMissedChunks,
  planSweep,
  sweepCut,
  sweepPlanIsEmpty,
  voidUntil,
  type ChunkPlan,
  type SweepOpts,
  type SweepPlan,
} from "./occurrence.js";
import {
  closeEpochRuns,
  recoverDeadRuns,
  type JudgeOpts,
  type ProcessIdentity,
  type RecoveredRun,
} from "./recovery.js";
import {
  autoRunKey,
  defHash,
  isExecutable,
  isApproved,
  manualRunKey,
  SCHED_COUNT_CAP,
  SCHED_FIRE_TOLERANCE_MS,
  SCHED_MANUAL_REQ_TTL_MS,
  SCHED_MANUAL_REQS_MAX,
  type Holder,
  type MissedEntry,
  type RunRecord,
  type ScheduleErrorCode,
  type ScheduleStateFile,
  type ScheduleTask,
} from "./spec.js";
import { SCHED_REQ_ID_RE } from "../../web-hub/protocol/schedule.js";
import { finishRun, findRun, liveManualReqCount, nonTerminalRuns, type SessionStore, type TxResult } from "./writer.js";

/** In-lock execution gate (`assertExecutable`, §7.6): mode matrix, owner sid, secure domain, epoch alive. */
export type ClaimGate = () => { code: ScheduleErrorCode; detail?: string } | undefined;

export type IneligibleReason =
  | "no-task"
  | "no-occ"
  | "not-executable"
  | "def-changed"
  | "invalid-when"
  | "not-occurrence"
  | "armed-after"
  | "early"
  | "gate";

export interface AutoClaimInput {
  taskId: string;
  /** The occurrence the timer fired for (UTC ms). */
  t: number;
  /** When this process started watching this task's current definition. */
  armedSince: number;
  holder: Holder;
  gate?: ClaimGate;
}

export type AutoClaimResult =
  | { kind: "fired"; run: RunRecord; coalescedRunKey?: string; skipped: number; missed: MissedEntry[] }
  | { kind: "overlap"; skipped: number; missed: MissedEntry[] }
  | { kind: "missed"; missed: MissedEntry[] }
  | { kind: "lost" }
  | { kind: "ineligible"; reason: IneligibleReason; detail?: string }
  | ClaimError;

interface AutoPlan {
  validUntil: number;
  hash: string;
  late: boolean;
  pre: ChunkPlan;
  /** Undecided occurrences in (pre.reached, T) still inside tolerance — coalesced into this fire. */
  between: number;
}

/**
 * `uncertain` ⇔ the ledger write was renamed into place but not proven durable (review M5): the
 * caller must not act (dispatch) on it and must not blindly retry — re-read the ledger later.
 */
export interface ClaimError {
  kind: "error";
  code: ScheduleErrorCode;
  detail: string;
  uncertain?: true;
}

function toError<T>(r: TxResult<T>): ClaimError | T {
  return r.ok
    ? r.value
    : { kind: "error", code: r.code, detail: r.detail, ...(r.uncertain === true ? { uncertain: true as const } : {}) };
}

export async function autoClaim(store: SessionStore, input: AutoClaimInput): Promise<AutoClaimResult> {
  const T = input.t;
  const r = await store.transactPlanned<AutoPlan, AutoClaimResult>(
    (snap, now) => {
      const task = snap.tasks.find((t) => t.id === input.taskId);
      if (task === undefined) return { done: { kind: "ineligible", reason: "no-task" } };
      const occ = snap.occ[task.id];
      if (occ === undefined) return { done: { kind: "ineligible", reason: "no-occ" } };
      if (!isExecutable(task)) return { done: { kind: "ineligible", reason: "not-executable" } };
      const hash = defHash(task);
      if (occ.defHash !== hash) return { done: { kind: "ineligible", reason: "def-changed" } };
      const c = compileTask(task);
      if (c === undefined) return { done: { kind: "ineligible", reason: "invalid-when" } };
      if (!isOccurrence(c, T)) return { done: { kind: "ineligible", reason: "not-occurrence" } };
      if (input.armedSince > T) return { done: { kind: "ineligible", reason: "armed-after" } };
      // Wall clock behind T (rollback while the timer waited): never fire early — re-arm (review M1).
      if (now < T) return { done: { kind: "ineligible", reason: "early" } };
      const dt = occ.decidedThrough;
      if (T <= dt) return { done: { kind: "lost" } };
      if (now > T + SCHED_FIRE_TOLERANCE_MS) {
        const pre = planMissedChunks(c, dt, T);
        return { plan: { validUntil: Number.POSITIVE_INFINITY, hash, late: true, pre, between: 0 } };
      }
      const cut = sweepCut(now);
      const pre: ChunkPlan =
        cut > dt ? planMissedChunks(c, dt, Math.min(cut, T - 1)) : { chunks: [], reached: dt, more: false };
      if (pre.more) {
        return {
          done: { kind: "error", code: "E_BUSY", detail: "missed backlog too large for one claim; sweep first" },
        };
      }
      const betweenTs = occurrencesBetween(c, pre.reached, T - 1, SCHED_COUNT_CAP);
      const first = nextOccurrence(c, Math.max(pre.reached, cut)) ?? T;
      return {
        plan: {
          validUntil: Math.min(first, T) + SCHED_FIRE_TOLERANCE_MS,
          hash,
          late: false,
          pre,
          between: betweenTs.length,
        },
      };
    },
    (draft, p, ctx) => {
      if (ctx.now < T) return { value: { kind: "ineligible", reason: "early" }, write: false };
      const g = input.gate?.();
      if (g !== undefined) return { value: { kind: "ineligible", reason: "gate", detail: g.code }, write: false };
      const task = draft.tasks.find((t) => t.id === input.taskId)!;
      const occ = draft.occ[input.taskId]!;
      const runKey = autoRunKey(task.id, T);
      if (findRun(draft, runKey) !== undefined) return { value: { kind: "lost" }, write: false };
      const missed = appendMissed(occ, p.pre.chunks, p.hash, "late", ctx.now);
      occ.decidedThrough = Math.max(occ.decidedThrough, p.pre.reached);
      const once = task.when.kind === "once";
      if (p.late) {
        if (once && !p.pre.more) task.enabled = false;
        return { value: { kind: "missed", missed }, write: true };
      }
      const busy = nonTerminalRuns(draft, task.id);
      if (task.form === "background" && busy.length > 0) {
        occ.skippedTotal += 1 + p.between;
        occ.decidedThrough = T;
        if (once) task.enabled = false;
        return { value: { kind: "overlap", skipped: 1 + p.between, missed }, write: true };
      }
      let coalescedRunKey: string | undefined;
      let skipped = p.between;
      if (task.form === "message") {
        const queued = busy.find((b) => b.state === "queued");
        if (queued !== undefined) {
          finishRun(draft, queued.runKey, { state: "dropped", reason: "coalesced" }, ctx.now);
          coalescedRunKey = queued.runKey;
          skipped += 1;
        }
      }
      occ.skippedTotal += skipped;
      occ.decidedThrough = T;
      occ.firedTotal += 1;
      if (once) task.enabled = false;
      const run: RunRecord = {
        runKey,
        taskId: task.id,
        kind: "auto",
        form: task.form,
        scheduledAt: T,
        defHash: p.hash,
        state: task.form === "background" ? "dispatching" : "queued",
        holder: input.holder,
        startedAt: ctx.now,
        note: "none",
      };
      draft.runs.push(run);
      return {
        value: {
          kind: "fired",
          run: structuredClone(run),
          skipped,
          missed,
          ...(coalescedRunKey ? { coalescedRunKey } : {}),
        },
        write: true,
      };
    },
  );
  return toError(r);
}

// ----------------------------------------------------------------- manual claim (§4.5b)

export interface ManualClaimInput {
  taskId: string;
  /** Web cmdId / Feishu deterministic cmdId / local random id (SCHED_REQ_ID_RE). */
  reqId: string;
  /** Required from web / Feishu callers: must equal the current definition AND approval hash. */
  defHash?: string;
  holder: Holder;
  gate?: ClaimGate;
}

export type ManualClaimResult =
  | { kind: "started"; runKey: string; run?: RunRecord; replay: boolean }
  | { kind: "refused"; code: string; replay: boolean }
  | ClaimError;

export async function manualClaim(store: SessionStore, input: ManualClaimInput): Promise<ManualClaimResult> {
  if (!SCHED_REQ_ID_RE.test(input.reqId)) return { kind: "error", code: "E_INVALID", detail: "bad reqId" };
  const r = await store.transact<ManualClaimResult>((draft, ctx) => {
    const prior = draft.manualReqs[input.reqId];
    if (prior !== undefined && ctx.now - prior.at < SCHED_MANUAL_REQ_TTL_MS) {
      if (prior.runKey !== undefined) {
        const run = findRun(draft, prior.runKey);
        return {
          value: { kind: "started", runKey: prior.runKey, replay: true, ...(run ? { run: structuredClone(run) } : {}) },
          write: false,
        };
      }
      return { value: { kind: "refused", code: prior.refused ?? "E_INVALID", replay: true }, write: false };
    }
    // Idempotency window is never sacrificed for capacity (review M2): with 32 live requests a NEW
    // reqId is refused (not recorded — there is no room), existing ones keep replaying.
    if (liveManualReqCount(draft, ctx.now) >= SCHED_MANUAL_REQS_MAX) {
      return { value: { kind: "refused", code: "E_LIMIT", replay: false }, write: false };
    }
    const refuse = (code: string): { value: ManualClaimResult; write: boolean } => {
      draft.manualReqs[input.reqId] = { refused: code, at: ctx.now };
      return { value: { kind: "refused", code, replay: false }, write: true };
    };
    const task = draft.tasks.find((t) => t.id === input.taskId);
    if (task === undefined) return refuse("E_INVALID");
    if (!isApproved(task)) return refuse("E_UNAPPROVED");
    if (!task.enabled) return refuse("E_INVALID");
    const hash = defHash(task);
    if (input.defHash !== undefined && input.defHash !== hash) return refuse("E_REV");
    const g = input.gate?.();
    if (g !== undefined) return refuse(g.code);
    if (nonTerminalRuns(draft, task.id).length > 0) return refuse("E_OVERLAP");
    const runKey = manualRunKey(task.id, input.reqId);
    if (findRun(draft, runKey) !== undefined) return refuse("E_INVALID"); // hash8 collision
    const run: RunRecord = {
      runKey,
      taskId: task.id,
      kind: "manual",
      form: task.form,
      scheduledAt: ctx.now,
      defHash: hash,
      state: task.form === "background" ? "dispatching" : "queued",
      holder: input.holder,
      startedAt: ctx.now,
      note: "none",
    };
    draft.runs.push(run);
    draft.manualTotal[task.id] = (draft.manualTotal[task.id] ?? 0) + 1;
    draft.manualReqs[input.reqId] = { runKey, at: ctx.now };
    return { value: { kind: "started", runKey, run: structuredClone(run), replay: false }, write: true };
  });
  return toError(r);
}

// ----------------------------------------------------------------- sweep (§4.4)

export type SweepResult = { kind: "swept"; missed: MissedEntry[]; plan: SweepPlan; wrote: boolean } | ClaimError;

/**
 * Decide every executable task's occurrences in `(decidedThrough, now − tol)` as missed. Undecided
 * occurrences inside the tolerance window are reported (`plan.inTolerance` / `supplementalAt`), never
 * decided. `plan.tasks[].more` ⇒ call again (chunk budget).
 */
export async function sweep(store: SessionStore, opts: SweepOpts = {}): Promise<SweepResult> {
  const r = await store.transactPlanned<SweepPlan, SweepResult>(
    (snap, now) => {
      const plan = planSweep(snap, now, opts);
      if (sweepPlanIsEmpty(plan)) return { done: { kind: "swept", missed: [], plan, wrote: false } };
      return { plan };
    },
    (draft, plan, ctx) => {
      const missed = applySweep(draft, plan, ctx.now);
      return { value: { kind: "swept", missed, plan, wrote: true }, write: true };
    },
  );
  return toError(r);
}

// ----------------------------------------------------------------- recovery (§4.6)

export type RecoveryResult = { kind: "recovered"; runs: RecoveredRun[] } | ClaimError;

/** session_start / 30 s poll: dead holders' non-terminal runs ⇒ unknown / dropped. */
export async function recoverRuns(
  store: SessionStore,
  self: ProcessIdentity,
  opts: JudgeOpts = {},
): Promise<RecoveryResult> {
  const r = await store.transact<RecoveryResult>((draft, ctx) => {
    const runs = recoverDeadRuns(draft, self, ctx.now, opts);
    return { value: { kind: "recovered", runs }, write: runs.length > 0 };
  });
  return toError(r);
}

/** session_shutdown / dispose (FIRST step, lock wait ≤ 500 ms — pass a store built with that timeout). */
export async function closeEpoch(store: SessionStore, holder: Holder): Promise<RecoveryResult> {
  const r = await store.transact<RecoveryResult>((draft, ctx) => {
    const runs = closeEpochRuns(draft, holder, ctx.now);
    return { value: { kind: "recovered", runs }, write: runs.length > 0 };
  });
  return toError(r);
}

// ----------------------------------------------------------------- definition changes (§4.3/§4.4)

export type TaskChange =
  | { kind: "changed"; task: ScheduleTask; hashChanged: boolean; missed: MissedEntry[] }
  | { kind: "refused"; code: ScheduleErrorCode; detail?: string }
  | ClaimError;

/**
 * Mutate one task under §4.4's rule: FIRST sweep the OLD definition (cut = now − tol), THEN apply
 * `mutate`; if the definition hash changed — or the task just became executable (resume /
 * approval) — the watermark jumps to `now` (`voidUntil`): the old definition's future occurrences
 * and anything owed while paused/unapproved are void, never missed. `mutate` may refuse.
 * Approval is NEVER touched here: an execution-field edit invalidates it by construction (S2).
 */
export async function changeTask(
  store: SessionStore,
  taskId: string,
  mutate: (task: ScheduleTask, now: number) => { refuse: ScheduleErrorCode; detail?: string } | void,
): Promise<TaskChange> {
  const missedAll: MissedEntry[] = [];
  for (let round = 0; round < CHANGE_BACKLOG_ROUNDS; round++) {
    const r = await store.transactPlanned<SweepPlan, TaskChange | { kind: "backlog"; missed: MissedEntry[] }>(
      (snap, now) => {
        if (!snap.tasks.some((t) => t.id === taskId))
          return { done: { kind: "refused", code: "E_INVALID", detail: "no-task" } };
        return { plan: planSweep(snap, now, { taskIds: [taskId] }) };
      },
      (draft, plan, ctx) => {
        const missed = applySweep(draft, plan, ctx.now);
        // The old definition still owes occurrences beyond this sweep's chunk budget: persist the
        // progress and sweep again — never switch definitions over unsettled misses (review m3).
        if (plan.tasks.some((t) => t.more)) return { value: { kind: "backlog", missed }, write: true };
        const task = draft.tasks.find((t) => t.id === taskId)!;
        const before = defHash(task);
        const wasExecutable = isExecutable(task);
        const res = mutate(task, ctx.now);
        if (res !== undefined) {
          // a refusal still commits the old-definition sweep when it decided something
          return {
            value: { kind: "refused", code: res.refuse, ...(res.detail ? { detail: res.detail } : {}) },
            write: missed.length > 0,
          };
        }
        const after = defHash(task);
        const occ = draft.occ[taskId];
        if (occ !== undefined && (after !== before || (!wasExecutable && isExecutable(task)))) {
          occ.defHash = after;
          voidUntil(occ, ctx.now);
        }
        return {
          value: { kind: "changed", task: structuredClone(task), hashChanged: after !== before, missed },
          write: true,
        };
      },
    );
    if (!r.ok) return toError(r) as ClaimError;
    if (r.value.kind === "backlog") {
      missedAll.push(...r.value.missed);
      continue;
    }
    if (r.value.kind === "changed") return { ...r.value, missed: [...missedAll, ...r.value.missed] };
    return r.value;
  }
  return { kind: "error", code: "E_BUSY", detail: "old definition still has unsettled misses; run sweep and retry" };
}

/** Sweep rounds `changeTask` may spend settling the old definition (each ≤ 64 × 10 000). */
export const CHANGE_BACKLOG_ROUNDS = 4;

/**
 * `/schedule approve <id>` / web review (§4.3): CAS on the hash the reviewer SAW (sampled before
 * the confirm dialog). Mismatch ⇒ `E_REV` (re-review). Only user surfaces call this.
 */
export function approveTask(
  store: SessionStore,
  taskId: string,
  reviewedHash: string,
  via: "tui" | "web",
): Promise<TaskChange> {
  return changeTask(store, taskId, (task, now) => {
    if (defHash(task) !== reviewedHash) return { refuse: "E_REV", detail: "definition changed since review" };
    task.approval = { hash: reviewedHash, by: "user", via, at: now };
    return undefined;
  });
}
