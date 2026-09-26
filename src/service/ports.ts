import type { DeadlineBudget, ExtendOutcome, ExtendSource, SetModelOutcome } from "../core/types.js";
import type {
  AgentTypeConfig,
  DriverEvent,
  LifecycleEvent,
  RunId,
  RunOutcome,
  RunSnapshot,
  RunState,
  RunInput,
  SpawnRequest,
  StopCause,
} from "../core/types.js";

export interface SlotTicket {
  readonly runId: RunId;
  release(): void;
}
export interface SlotPool {
  acquire(
    runId: RunId,
    opts: { slotless?: boolean; queueWaitMs: number; signal?: AbortSignal },
  ): Promise<{ ok: true; ticket: SlotTicket } | { ok: false; reason: "queue_timeout" | "aborted" }>;
  release?(runId: RunId): void;
  drain?(): void;
  setLimit?(n: number): void;
  readonly stats?: { limit: number; inUse: number; queued: number; slotless: number };
}

/**
 * Service-layer spec passed to Runner.run(): the fully resolved spawn
 * context (agent type config + original request + budget). Distinct from
 * core.SessionSpec (the narrower pi-session-shaped config the SessionDriver
 * actually consumes) — the two used to share the name "SessionSpec" even
 * though they are different concepts at different layers; renamed here to
 * remove that ambiguity (see the M1 wiring seam-consolidation notes).
 */
export interface RunnerSpec {
  readonly runId: RunId;
  readonly type: AgentTypeConfig;
  readonly request: SpawnRequest;
  readonly cwd?: string;
  readonly model?: { provider: string; id: string };
  readonly budget: DeadlineBudget;
  /** X3: nesting depth of this run (0 = top-level), computed by SpawnService at spawn time. */
  readonly depth?: number;
}
export interface RunnerCallbacks {
  onLifecycle?(event: LifecycleEvent): void;
  onEvent?(event: DriverEvent): void;
  onSnapshot?(snapshot: RunSnapshot): void;
}
export interface Runner {
  run(spec: RunnerSpec, callbacks?: RunnerCallbacks): Promise<RunOutcome>;
  abort?(runId: RunId, cause?: StopCause): Promise<{ ok: boolean; escalatedTo: "L2" | "L3" | "L4" }>;
  steer?(runId: RunId, text: string): Promise<void>;
  /** set_model: bounded mid-run model switch. Returns a reason union instead of
   *  throwing (unlike steer) so "unknown_model" stays distinguishable from
   *  "the session refused" — the tool turns the two into different, self-correcting messages. */
  setModel?(
    runId: RunId,
    model: { provider: string; id: string },
    opts?: { thinking?: string },
  ): Promise<SetModelOutcome>;
  /** M4: EventWatchdog tick 读取运行态（子阶段超时接线后不再是空壳）。 */
  getRunState?(runId: RunId, generation?: number): RunState | undefined;
  /** M4: EventWatchdog 的超时入口——折进状态机并解除 prompt guard 的阻塞。 */
  fireDeadline?(runId: RunId, generation: number, input: Extract<RunInput, { kind: "deadline_fired" }>): void;
  /**
   * timeout-notify：延长 run 的软截止（deadlineAt）。**同步**返回（D-9：检查—派发—回读之间
   * 无 await，单线程事件循环内串行，消除与 watchdog tick 的 TOCTOU）。老实现缺席此方法
   * 时调用方按 `{ ok: false, reason: "unsupported" }` 处理。
   */
  extendDeadline?(runId: RunId, extendMs: number, opts: { source: ExtendSource; reason?: string }): ExtendOutcome;
  /**
   * workflow-worktree plan D13 (v2.1 condition 2): idempotent. Called once by
   * stack.ts's rebuild hand-off (before the previous stack's pieces are
   * discarded) and again on session_shutdown. After this, any H3
   * (beforeReap) write-back that still arrives for a run this adapter
   * created must redirect to the current session's durable sink instead of
   * this (about to be replaced) adapter's own store/live-record sink — see
   * `runtime-adapter.ts`'s `setWorktreeDisposition`. Optional so existing
   * Runner fakes/tests stay valid.
   */
  dispose?(): void;
}
export interface RunRegistry {
  get(runId: RunId): RunSnapshot | undefined;
  list(filter?: { status?: RunSnapshot["status"][]; parentRunId?: RunId }): RunSnapshot[];
  put?(snapshot: RunSnapshot): void;
}
export interface LifecycleSink {
  (event: LifecycleEvent): void;
}
