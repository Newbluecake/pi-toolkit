/** A1 background executor. Installation is explicit; stack/index wiring belongs to integration. */
import type { Clock } from "../../core/clock.js";
import { systemClock } from "../../core/clock.js";
import { DEFAULT_BUDGET, withDeadline } from "../../core/deadline.js";
import type { RunOutcome, SpawnRequest } from "../../core/types.js";
import type { SpawnService } from "../../service/spawn-service.js";
import { sameHolder } from "../core/recovery.js";
import { isTerminalRunState, type RunRecord, type ScheduleTask } from "../core/spec.js";
import { findRun, finishRun, updateRun, type SessionStore } from "../core/writer.js";
import type { ScheduleAgent, ScheduleExecutor } from "./wire.js";
import { createScheduleNotes, type ScheduleNoteDeps, type ScheduleNotes } from "./note.js";
import { backgroundHeader, commitBackgroundReport, truncateUtf8, type BackgroundResult } from "./report-file.js";

export interface BackgroundExecutorDeps {
  spawn: Pick<SpawnService, "spawn" | "waitOutcome">;
  notes: ScheduleNoteDeps;
  clock?: Clock;
  monotonic?: () => number;
  /** Defensive wait allowance after the fixed child deadline, bounded to 5 min. */
  waitGraceMs?: number;
}
export interface BackgroundExecutor extends ScheduleExecutor {
  readonly notes: ScheduleNotes;
  /** Test/integration drain of currently dispatched work. Does not wait for future dispatches. */
  drain(): Promise<void>;
  /** Stop new work and quiet-proof timers. A0 shutdown must run BEFORE the stack drains children. */
  dispose(): void;
}

/** Never branch is intentional: adding a RunOutcome.status must fail compilation here. */
export function mapBackgroundOutcome(outcome: RunOutcome): {
  state: RunOutcome["status"];
  reason?: string;
  text: string;
} {
  const partial = outcome.text ?? "";
  switch (outcome.status) {
    case "completed":
      return { state: "completed", text: partial };
    case "failed":
      return {
        state: "failed",
        reason: outcome.error?.kind ?? "internal",
        text: `执行失败：${outcome.error?.message ?? "未知错误"}\n\n${partial}`,
      };
    case "timed_out":
      return {
        state: "timed_out",
        reason: outcome.timeoutReason ?? "total",
        text: `执行超时：${outcome.timeoutReason ?? "total"}\n\n${partial}`,
      };
    case "aborted": {
      const reason = outcome.diag.stopCause ?? "unspecified";
      return { state: "aborted", reason, text: `已中止：${reason}\n\n${partial}` };
    }
    default: {
      const exhaustive: never = outcome.status;
      throw new Error(`unsupported run outcome: ${String(exhaustive)}`);
    }
  }
}

export function installBackgroundExecutor(schedule: ScheduleAgent, deps: BackgroundExecutorDeps): BackgroundExecutor {
  const clock = deps.clock ?? systemClock;
  const monotonic = deps.monotonic ?? (() => performance.now());
  const grace = Number.isFinite(deps.waitGraceMs)
    ? Math.min(300_000, Math.max(0, deps.waitGraceMs!))
    : DEFAULT_BUDGET.totalGraceMs + DEFAULT_BUDGET.abortGraceMs + DEFAULT_BUDGET.reapMs;
  const holder = schedule.holder;
  const epoch = schedule.epoch;
  const store = schedule.store();
  // Store is normally lazy at installation. Capture its reference when dispatch is claimed instead.
  const active = new Map<string, Promise<void>>();
  const claimedStores = new Map<string, SessionStore>();
  const closing = new Set<Promise<void>>();
  let disposed = false;
  let ownerGone = false;
  const notes = createScheduleNotes(schedule, { ...deps.notes, clock });
  const closed = () => disposed || ownerGone || schedule.isDisposed() || schedule.epoch !== epoch;
  const live = (): boolean => {
    if (closed()) return false;
    try {
      const matches = schedule.sessionId !== undefined && deps.notes.currentSessionId() === schedule.sessionId;
      if (!matches) ownerGone = true;
      return matches;
    } catch {
      ownerGone = true;
      return false;
    }
  };
  const changed = () => {
    if (live()) schedule.changed();
  };

  async function execute(run: RunRecord, task: ScheduleTask): Promise<void> {
    const target = store ?? schedule.store();
    if (
      target === undefined ||
      holder === undefined ||
      schedule.sessionId !== target.sessionId ||
      !sameHolder(run.holder, holder)
    )
      return;
    claimedStores.set(run.runKey, target);
    let consultWarning = "";
    async function finish(result: BackgroundResult): Promise<void> {
      live(); // Latch a replaced/stale owner before entering the ctx-free report transaction.
      if (consultWarning) result = { ...result, text: `${consultWarning}\n\n${result.text}` };
      const r = await commitBackgroundReport({
        store: target!,
        run,
        task,
        holder: holder!,
        isDisposed: closed,
        result,
        now: clock.now(),
      });
      if (!live()) return;
      if (r.kind === "committed") {
        changed();
        await notes.deliver(run.runKey, result.text, task.bg?.handoff === true);
      } else if (r.kind === "late" || r.kind === "closed") changed();
    }
    if (!live()) {
      await finish({ state: "unknown", reason: "owner-closed", text: "归属会话已关闭，结果未知。" });
      return;
    }
    // Lock-time check deduplicates callbacks and protects against a recovered/foreign run.
    const start = await target.transact((d) => {
      const current = findRun(d, run.runKey);
      if (closed() || current === undefined || current.state !== "dispatching" || !sameHolder(current.holder, holder))
        return { value: false, write: false };
      // Still dispatching until admission supplies runId. The per-instance map excludes duplicates;
      // other stacks have a different holder and cannot own this run.
      return { value: true, write: false };
    });
    if (!start.ok || !start.value) return;
    if (!live()) {
      await finish({ state: "unknown", reason: "owner-closed", text: "归属会话已关闭，结果未知。" });
      return;
    }
    const bg = task.bg;
    if (bg === undefined) {
      await finish({ state: "refused", reason: "admission:config", text: "缺少 background 配置。" });
      return;
    }
    // #40: `bg.consultMain` stays a persisted field (defHash), but consult is gone — a legacy `true` is ignored.
    if (bg.consultMain) consultWarning = "⚠ consult-main 已移除，本次独立执行（该选项被忽略）。";
    if (!live()) {
      await finish({ state: "unknown", reason: "owner-closed", text: "归属会话已关闭，结果未知。" });
      return;
    }
    const refusal = schedule.gate(task);
    if (refusal !== undefined) {
      await finish({ state: "refused", reason: `admission:${refusal.code}`, text: `执行门拒绝：${refusal.detail}` });
      return;
    }
    const request: SpawnRequest = {
      type: bg.type,
      prompt: `${backgroundHeader(task, run)}\n本次为定时运行，最终回复即为报告。\n\n${task.prompt}`,
      label: `sched:${task.name}`,
      cwd: task.ownerCwd,
      ...(bg.model === undefined ? {} : { modelOverride: bg.model }),
      ...(bg.thinking === undefined ? {} : { thinkingOverride: bg.thinking }),
      budgetOverride: { totalMs: bg.timeoutS * 1000 },
      timeoutPolicy: "fixed",
      suppressDelivery: true,
      callerOwned: true,
      ...(bg.isolation === undefined ? {} : { isolation: bg.isolation }),
    };
    const began = monotonic();
    const hardMs = bg.timeoutS * 1000 + grace;
    try {
      const admission = await withDeadline(
        deps.spawn.spawn(request),
        Math.min(60_000, hardMs),
        clock,
        "sched admission",
      );
      if (!admission.ok) {
        await finish(
          admission.reason === "error"
            ? {
                state: "refused",
                reason: `admission:${admission.error.kind}`,
                text: `准入异常：${admission.error.message}`,
              }
            : {
                state: "unknown",
                reason: "no-outcome",
                text: "结果未知：派发未能在预算内返回，可能已经生效，未自动重试。",
              },
        );
        return;
      }
      const spawned = admission.value;
      if ("error" in spawned) {
        await finish({
          state: "refused",
          reason: `admission:${spawned.error.reason ?? spawned.error.kind}`,
          text: `准入拒绝：${spawned.error.message}`,
        });
        return;
      }
      run = { ...run, runId: spawned.runId };
      await target.transact((d) => {
        const current = findRun(d, run.runKey);
        if (current === undefined || !sameHolder(current.holder, holder) || isTerminalRunState(current.state))
          return { value: false, write: false };
        if (closed()) {
          finishRun(d, run.runKey, { state: "unknown", reason: "owner-closed" }, clock.now());
        } else updateRun(d, run.runKey, { state: "running", runId: spawned.runId });
        return { value: true, write: true };
      });
      changed();
      // Each wait has its own deadline even if a faulty port never honors waitMs. Accumulating
      // pending intervals also bounds a broken port returning "pending" immediately (no busy loop).
      let pendingMs = 0;
      while (Math.max(monotonic() - began, pendingMs) < hardMs) {
        const waitMs = Math.min(60_000, hardMs - Math.max(monotonic() - began, pendingMs));
        const waited = await withDeadline(
          deps.spawn.waitOutcome(spawned.runId, waitMs),
          waitMs + 1000,
          clock,
          "sched outcome",
        );
        if (!waited.ok) {
          await finish({ state: "unknown", reason: "no-outcome", text: "结果未知：等待运行终态失败。" });
          return;
        }
        if (waited.value.kind === "settled") {
          await finish(mapBackgroundOutcome(waited.value.outcome));
          return;
        }
        if (closed()) {
          await finish({ state: "unknown", reason: "owner-closed", text: "归属会话已关闭，结果未知。" });
          return;
        }
        pendingMs += waitMs;
      }
      await finish({ state: "unknown", reason: "no-outcome", text: "结果未知：超过等待硬上限，未自动重跑。" });
    } catch (err) {
      // Before a runId exists this is an admission exception; after admission it is no-outcome.
      await finish(
        run.runId === undefined
          ? { state: "refused", reason: "admission:internal", text: `准入异常：${truncateUtf8(String(err), 2048)}` }
          : { state: "unknown", reason: "no-outcome", text: "结果未知：运行结果读取失败。" },
      );
    }
  }
  const api: BackgroundExecutor = {
    notes,
    dispatch(run, task) {
      if (closed() || holder === undefined || !sameHolder(run.holder, holder) || active.has(run.runKey)) return;
      const work = execute(structuredClone(run), structuredClone(task))
        .catch(() => {
          // Store failure leaves the durable intent for A0 recovery; never leak an unhandled rejection.
        })
        .finally(() => {
          active.delete(run.runKey);
          claimedStores.delete(run.runKey);
        });
      active.set(run.runKey, work);
    },
    async drain() {
      await Promise.all([...active.values(), ...closing]);
      await notes.idle();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      notes.dispose();
      schedule.setExecutor("background", undefined);
      // A0 normally closes the epoch first. Defensive executor-only disposal still writes unknown
      // using captured stores, with no old ctx/frame/report IO and the same first-terminal rule.
      for (const [runKey, target] of claimedStores) {
        const work = target
          .transact((d, ctx) => {
            const run = findRun(d, runKey);
            if (
              holder === undefined ||
              run === undefined ||
              !sameHolder(run.holder, holder) ||
              isTerminalRunState(run.state)
            )
              return { value: undefined, write: false };
            finishRun(d, runKey, { state: "unknown", reason: "owner-closed" }, ctx.now);
            return { value: undefined, write: true };
          })
          .then(() => undefined)
          .catch(() => undefined)
          .finally(() => {
            closing.delete(work);
          });
        closing.add(work);
      }
    },
  };
  schedule.setExecutor("background", api);
  return api;
}
