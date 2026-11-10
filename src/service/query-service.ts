import { withDeadline } from "../core/deadline.js";
import type { Clock } from "../core/clock.js";
import type {
  ExtendOutcome,
  ExtendSource,
  ObserveRunResult,
  RunId,
  RunObserverListener,
  RunOutcome,
  RunPhase,
  RunSnapshot,
  RunStatus,
  SetModelOutcome,
  StopCause,
} from "../core/types.js";
import type { Runner, RunRegistry } from "./ports.js";

export type StopResult =
  | { ok: true; escalatedTo: "L2" | "L3" | "L4" }
  | { ok: false; reason: "unknown_run" }
  | { ok: false; reason: "already_terminal"; status: RunStatus }
  | { ok: false; reason: "stop_failed"; escalatedTo: "L2" | "L3" | "L4"; effect?: "none" | "unknown" };

export interface QueryService {
  get(runId: RunId): RunSnapshot | undefined;
  list(filter?: { status?: RunStatus[]; parentRunId?: RunId }): RunSnapshot[];
  wait(
    runId: RunId,
    opts?: { waitMs?: number; signal?: AbortSignal },
  ): Promise<{ ok: true; outcome: RunOutcome } | { ok: false; reason: "wait_timeout" | "aborted" | "unknown_run" }>;
  waitAll(opts?: { runIds?: RunId[]; waitMs?: number }): Promise<{ settled: RunOutcome[]; pending: RunId[] }>;
  /**
   * `origin` (fabric-cross-session plan §3.3 seam B): who is steering, as a causal level. Omitted ⇒ the caller is the
   * autonomous root model (the `steer_subagent` tool) and the target is raised to the ROOT's current level; a human
   * origin (web steer op, TUI @mention) passes `{ level: 0 }`, which never raises anything.
   */
  steer(
    runId: RunId,
    text: string,
    origin?: { level: number },
  ): Promise<{ ok: true } | { ok: false; reason: "not_running" | "steer_timeout" | "steer_rejected"; detail?: string }>;
  /**
   * fabric-thread arch r3 §6.4 (P3): the thread-dedicated steer — disposition-preserving and
   * bounded by `capMs` (the caller derives it from the event's remaining budget). Resolves with
   * pi's QueuedInputDisposition STRING (`"queued"`/`"handled"` — engine §6.4 mapping); rejects on
   * timeout / no active session / registry miss. Existing `steer()` semantics untouched.
   * OPTIONAL so every pre-existing fake/forwarder stays a valid QueryService (holder.ts, tests);
   * the implementation always provides it, and only the thread engine calls it.
   */
  steerThread?(runId: RunId, text: string, capMs: number): Promise<string>;
  /**
   * fleet-drawer plan §4.1: read-only peek at a running run's current
   * persisted branch, for live-run transcript snapshots. `undefined` when
   * the runner cannot serve it (unknown/terminal/handle-less run, or the
   * runner predates the read port) — the caller re-reads run info and takes
   * the terminal/file path in that case. Signatures use `unknown` (I1).
   */
  branchOf?(runId: RunId): readonly unknown[] | undefined;
  /**
   * fleet-drawer plan §4.1 (#7): attach a live observer to a running run's
   * session stream. Synchronous four-state verdict (attached/terminal/
   * no_session/unknown); `no_session` when the runner does not implement the
   * read port at all. `onEnd` exactly once per attach; detach never fires
   * onEnd. Signatures use `unknown` (I1).
   */
  observe?(runId: RunId, l: RunObserverListener): ObserveRunResult;
  /** set_model: mid-run model switch for a running run (plan §4.6). */
  setModel(
    runId: RunId,
    model: { provider: string; id: string },
    opts?: { thinking?: string },
  ): Promise<SetModelOutcome>;
  stop(runId: RunId, cause?: StopCause): Promise<StopResult>;
  /**
   * timeout-notify：延长 run 的软截止（deadlineAt），extendMs 为追加毫秒数。
   * **同步**返回 ExtendOutcome（arch §4.6：检查—派发—回读在单线程事件循环内
   * 串行完成，没有 await 的必要；同步签名让工具层少一层 Promise 包装）。
   */
  extendTimeout(runId: RunId, extendMs: number, opts: { source: ExtendSource; reason?: string }): ExtendOutcome;
}
export interface QueryServiceDeps {
  registry: RunRegistry;
  runner: Runner;
  clock?: Clock;
  defaultWaitMs?: number;
  /**
   * fabric-cross-session plan §3.3 seam B (W1): called after a steer was ACCEPTED by a running run. `originLevel` is the
   * caller-supplied origin level or `undefined` (= the root's level, resolved by the wiring). Absent ⇒ wake off.
   */
  onSteered?: (runId: RunId, originLevel: number | undefined) => void;
  /**
   * fabric-thread arch r3 §6.4 (P3): the bounded, disposition-preserving thread-steer channel —
   * stack.ts wires this to `RuntimeRunner.steerThreadRun` (the Runner port itself stays untouched:
   * `src/service/ports.ts` is outside P3's file domain, and the seam here keeps fakes/tests valid).
   * Absent ⇒ `steerThread` rejects with `steer_unsupported` (never called in practice — the
   * engine only exists while the stack wired it).
   */
  steerThread?: (runId: RunId, text: string, capMs: number) => Promise<string>;
}
/** Only bounded protocol/errno tokens cross the service boundary; never driver exception text. */
function failureReason(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const fields = error as { code?: unknown; reason?: unknown };
  const allowed = new Set([
    "ETIMEDOUT",
    "ECONNRESET",
    "EPIPE",
    "ABORT_ERR",
    "ERR_CANCELED",
    "timeout",
    "steer_timeout",
    "rejected",
    "unsupported",
    "not_running",
  ]);
  for (const value of [fields.reason, fields.code]) {
    if (typeof value === "string" && allowed.has(value)) return value;
  }
  return "unknown";
}

const terminal = (status: RunStatus) =>
  status === "completed" || status === "failed" || status === "timed_out" || status === "aborted";
/**
 * Grace added on top of the awaited run's own deadline when deriving the
 * *default* wait budget: the run settles at deadlineAt, then needs abort
 * grace + reap + bookkeeping before its outcome lands in the registry. A
 * default wait should outlive that settlement, not race it.
 */
export const WAIT_SETTLEMENT_GRACE_MS = 30_000;
export function createQueryService(deps: QueryServiceDeps): QueryService {
  const clock = deps.clock ?? {
    now: () => Date.now(),
    setTimer: (ms: number, fn: () => void) => ({ id: setTimeout(fn, ms) as unknown as number }),
    clearTimer: (h: { id: number }) => clearTimeout(h.id),
  };
  return {
    get: (id) => deps.registry.get(id),
    list: (filter) => deps.registry.list(filter),
    async wait(id, opts = {}) {
      const snapshot = deps.registry.get(id);
      if (!snapshot) return { ok: false, reason: "unknown_run" };
      if (snapshot.outcome && terminal(snapshot.status)) return { ok: true, outcome: snapshot.outcome };
      // Default wait budget, in precedence order: explicit opts.waitMs →
      // dynamic "the awaited run's remaining lifetime + settlement grace"
      // (deadlineAt is absolute, set at enqueue — core/types.ts ①) → host
      // static default → hardcoded 30min. The dynamic default means a bare
      // wait normally settles WITH the run instead of timing out earlier
      // (e.g. a 2h timeout_s run awaited under a 30min static default).
      //
      // RK-5 (timeout-notify): the deadline basis escalates to the hard
      // ceiling ONLY for runs that actually entered grace or were extended
      // (diag.overtime exists) — an extended run outlives its original
      // deadlineAt, and a bare wait keyed on deadlineAt would race ahead and
      // wait_timeout while the run is still legitimately alive. Runs without
      // overtime keep the deadlineAt basis so their wait windows don't
      // silently double to maxTotalFactor × totalMs.
      const basis =
        snapshot.diag.overtime !== undefined
          ? (snapshot.deadlines.hardDeadlineAt ?? snapshot.deadlines.deadlineAt)
          : snapshot.deadlines.deadlineAt;
      const remaining = basis !== undefined ? Math.max(0, basis - clock.now()) + WAIT_SETTLEMENT_GRACE_MS : undefined;
      const waitMs = opts.waitMs ?? remaining ?? deps.defaultWaitMs ?? 1_800_000;
      const waiter = new Promise<RunOutcome>((resolve, reject) => {
        const poll = () => {
          try {
            const current = deps.registry.get(id);
            if (current?.outcome && terminal(current.status)) resolve(current.outcome);
            else clock.setTimer(10, poll);
          } catch (error) {
            reject(
              new Error(
                `Run read failed [code=result_read_failed reason=${failureReason(error)} retryable=false effect=none]. No terminal outcome was established.`,
              ),
            );
          }
        };
        poll();
      });
      if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
      const cancelled = new Promise<never>((_, reject) =>
        opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
      const result = await withDeadline(Promise.race([waiter, cancelled]), waitMs, clock, "wait");
      if (result.ok) return { ok: true, outcome: result.value };
      if (result.reason === "error" && opts.signal?.aborted) return { ok: false, reason: "aborted" };
      if (result.reason === "error") throw new Error(result.error.message);
      return { ok: false, reason: "wait_timeout" };
    },
    async waitAll(opts = {}) {
      const ids =
        opts.runIds ??
        deps.registry
          .list()
          .filter((s) => !terminal(s.status))
          .map((s) => s.runId);
      const results = await Promise.all(
        ids.map((id) => this.wait(id, opts.waitMs === undefined ? {} : { waitMs: opts.waitMs })),
      );
      const settled: RunOutcome[] = [];
      const pending: RunId[] = [];
      results.forEach((r, i) => (r.ok ? settled.push(r.outcome) : pending.push(ids[i]!)));
      return { settled, pending };
    },
    async steer(id, text, origin) {
      const snapshot = deps.registry.get(id);
      if (!snapshot || snapshot.status !== "running" || !deps.runner.steer) return { ok: false, reason: "not_running" };
      try {
        await deps.runner.steer(id, text);
        try {
          deps.onSteered?.(id, origin?.level);
        } catch {
          /* level propagation is advisory: never turn an accepted steer into a failure */
        }
        return { ok: true };
      } catch (error) {
        const detail = failureReason(error);
        return {
          ok: false,
          reason: ["ETIMEDOUT", "timeout", "steer_timeout"].includes(detail) ? "steer_timeout" : "steer_rejected",
          detail,
        };
      }
    },
    async steerThread(id, text, capMs) {
      if (deps.steerThread === undefined) throw new Error("steer_thread unsupported (threads off)");
      // §6.4 调用后： once the runner is invoked every failure (timeout included) is post-call —
      // the ENGINE maps the rejection to Outcome `unknown`; only the registry miss below is
      // pre-call-shaped, and the engine's facts check (steerable) has already gated that.
      const snapshot = deps.registry.get(id);
      if (!snapshot) throw new Error(`no run ${id}`);
      return deps.steerThread(id, text, capMs);
    },
    // fleet-drawer plan §4.1: pure passthroughs — the runner is the single
    // source of truth for both (four-state verdict / branch availability);
    // no registry pre-check that could diverge from the runner's own view.
    branchOf: (id) => deps.runner.peekBranch?.(id),
    observe: (id, l) => deps.runner.observe?.(id, l) ?? { kind: "no_session" },
    async setModel(id, model, opts) {
      const snapshot = deps.registry.get(id);
      if (!snapshot || snapshot.status !== "running" || !deps.runner.setModel)
        return { ok: false, reason: "not_running" };
      try {
        // The timeout bound lives inside the runner (SET_MODEL_TIMEOUT_MS);
        // this layer deliberately does not re-time it.
        return await deps.runner.setModel(id, model, opts);
      } catch (error) {
        return { ok: false, reason: "rejected", detail: failureReason(error) };
      }
    },
    async stop(id, cause = "user_stop") {
      const snapshot = deps.registry.get(id);
      if (!snapshot) return { ok: false, reason: "unknown_run" };
      if (terminal(snapshot.status)) return { ok: false, reason: "already_terminal", status: snapshot.status };
      if (!deps.runner.abort) return { ok: false, reason: "stop_failed", escalatedTo: "L4", effect: "none" };
      try {
        const result = await deps.runner.abort(id, cause);
        if (result.ok) return { ok: true, escalatedTo: result.escalatedTo };
        const after = deps.registry.get(id);
        if (after && terminal(after.status)) return { ok: false, reason: "already_terminal", status: after.status };
        return { ok: false, reason: "stop_failed", escalatedTo: result.escalatedTo };
      } catch {
        // Abort may have taken effect before rejecting. Read only; never send a second abort.
        try {
          const after = deps.registry.get(id);
          if (after && terminal(after.status)) return { ok: false, reason: "already_terminal", status: after.status };
        } catch {
          // An unreadable state is not evidence of a terminal run.
        }
        // L4 is the legacy fallback value, NOT evidence that a kill completed.
        return { ok: false, reason: "stop_failed", escalatedTo: "L4" };
      }
    },
    extendTimeout(id, extendMs, opts) {
      const snapshot = deps.registry.get(id);
      if (!snapshot) return { ok: false, reason: "unknown_run" };
      if (!deps.runner.extendDeadline) return { ok: false, reason: "unsupported" };
      // 不重复 extendability 逻辑：runner/reducer 是唯一判定口径（arch §3.3）。
      return deps.runner.extendDeadline(id, extendMs, opts);
    },
  };
}
export type DiagnosticView = {
  runId: RunId;
  status: RunStatus;
  phase: RunPhase;
  pendingTools: number;
  staleInputs: number;
  degraded: number;
  orphaned: boolean;
};
