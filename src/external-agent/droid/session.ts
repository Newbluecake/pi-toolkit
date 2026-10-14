/**
 * DroidSessionHandle（plan §4.3/§4.5/§4.9，arch §9 修订版）。
 *
 * 一 run 一个 droid exec RPC 进程；本句柄把 mapper 的事件流、权限反向请求、终态判定、
 * 进程死亡、r3 异常退出对账全部收口成 SessionHandle 契约。
 *
 * 零卡死（§4.3 表）：反向权限请求同步批准；应答失败/处理器抛错（经 onProtocolError）/
 * 10s 无回执 ⇒ 致命收口 = interrupt（有界不等结果）→ terminate("now") → prompt() reject。
 * 外层另有 runner 相位预算与 reaper L3p killableHandles 兜底。
 */
import type { Clock, TimerHandle } from "../../core/clock.js";
import { ClassifiedError, classifiedInfo } from "../../core/errors.js";
import type {
  DriverEvent,
  ErrorInfo,
  ExternalPricing,
  ExternalPricingDiag,
  KillableHandle,
  UsageDelta,
} from "../../core/types.js";
import type { DisposeReport } from "../../runtime/session-driver.js";
import type { DroidAgentSettings } from "../../config/settings.js";
import { msgPermissionUnacknowledged, msgProtocolDrift } from "../messages.js";
import { renderFirstMessage } from "../prompt.js";
import type {
  ExternalCatalogPort,
  ExternalFrameworkDeps,
  ExternalSessionHandle,
  ExternalSessionSpec,
  JsonRpcClient,
  ManagedChild,
  RequestReply,
  TranscriptWriter,
  UsageLedger,
} from "../types.js";
import { createDroidMapper, type DroidMapper } from "./events.js";
import type { DroidEnvelope } from "./envelope.js";
import {
  DROID_CONTEXT_STATS_MAX_FAILURES,
  DROID_CONTEXT_STATS_THROTTLE_MS,
  DROID_CONTEXT_STATS_TIMEOUT_MS,
  DROID_INTERRUPT_WAIT_MS,
  DROID_METHODS,
  DROID_PERMISSION_ACK_TIMEOUT_MS,
  DROID_PERMISSION_REPLY,
  DROID_TOOL_NAME_HINT,
  DROID_UNSUPPORTED_REQUEST_REPLY,
} from "./protocol.js";
import { droidNativeSessionPaths, factoryHomeDir, readNativeCumulativeUsage } from "./reconcile.js";
import { classifyTurnEnd } from "./terminal.js";

/** provider/session 两阶段共享的 RPC 回调槽（client 创建后回调不可换 ⇒ 用可变 ref 换手）。 */
export interface DroidRpcHandlers {
  onNotification(method: string, params: unknown): void;
  onRequest(method: string, id: string, params: unknown): RequestReply;
  onDrift(d: { expected: string; actual: string }): void;
  onProtocolError(e: ClassifiedError): void;
}
export type DroidRpcHandlersRef = { current: DroidRpcHandlers };

export interface DroidSessionInit {
  deps: ExternalFrameworkDeps;
  settings: DroidAgentSettings;
  spec: ExternalSessionSpec;
  child: ManagedChild;
  rpc: JsonRpcClient;
  envelope: DroidEnvelope;
  handlersRef: DroidRpcHandlersRef;
  /** 生效 cwd（create = realpath(spec.cwd)；resume = transcript 头行 cwd，§4.4 钉死）。 */
  cwd: string;
  sessionId: string;
  effectiveModelId: string;
  effectiveEffort?: string;
  autonomyEcho?: string;
  transcript?: TranscriptWriter;
  ledger: UsageLedger;
  resume: boolean;
  catalog: ExternalCatalogPort;
  /** init/update 期间到达的通知（provider 已消费 settings_updated；其余在此回放）。 */
  bufferedNotifications: readonly { method: string; params: unknown }[];
  /** warn 模式下 init 阶段已见漂移： degraded:+protocol_drift 带入 run（acceptance ⑧）。 */
  protocolDriftWarned?: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

function pricingDiagOf(p: ExternalPricing): ExternalPricingDiag {
  if (p.status === "priced")
    return { status: "priced", source: p.source, basis: p.basis, ...(p.approx ? { approx: true as const } : {}) };
  return { status: "unpriced", reason: p.reason, ...(p.detail === undefined ? {} : { detail: p.detail }) };
}

export function createDroidSession(init: DroidSessionInit): ExternalSessionHandle {
  const { deps, settings, spec, child, rpc, envelope, handlersRef, catalog } = init;
  const clock: Clock = deps.clock;
  const ext = spec.external;

  let emitter: ((e: DriverEvent) => void) | undefined;
  const queued: DriverEvent[] = [];
  const emit = (e: DriverEvent): void => {
    if (emitter === undefined) queued.push(e);
    else emitter(e);
  };

  let turnErrorInfo: ErrorInfo | undefined;
  let abortRequested = false;
  let permissionApprovals = 0;
  const permissionAcks = new Map<string, { toolUseIds: readonly string[]; timer: TimerHandle }>();
  let pendingTurn: { resolve: () => void; reject: (e: unknown) => void; promise: Promise<void> } | undefined;
  let fatalError: ClassifiedError | undefined;
  let disposed = false;
  let disposeReport: DisposeReport | undefined;
  let interruptWait: TimerHandle | undefined;
  let promptCount = 0;
  const degraded: string[] = [...ext.degraded];
  if (init.protocolDriftWarned === true && !degraded.includes("protocol_drift")) degraded.push("protocol_drift");
  let reconcileAttempted = false; // 每个 prompt turn 至多对账一次（r3「绝不重复计费」）
  const contextStats = { lastAt: Number.NEGATIVE_INFINITY, inFlight: false, failures: 0, disabled: false };

  const clearAck = (requestId: string): void => {
    const ack = permissionAcks.get(requestId);
    if (ack === undefined) return;
    clock.clearTimer(ack.timer);
    permissionAcks.delete(requestId);
  };
  const clearAckByToolUse = (toolUseId: string): void => {
    for (const [rid, ack] of [...permissionAcks]) if (ack.toolUseIds.includes(toolUseId)) clearAck(rid);
  };
  const clearAllAcks = (): void => {
    for (const rid of [...permissionAcks.keys()]) clearAck(rid);
  };

  const settlePendingTurn = (): void => {
    const pending = pendingTurn;
    pendingTurn = undefined;
    pending?.resolve();
  };

  const pollContextStats = (): void => {
    const cs = contextStats;
    if (cs.disabled || cs.inFlight || disposed || fatalError !== undefined) return;
    if (child.exitInfo() !== undefined) return;
    const now = clock.now();
    if (now - cs.lastAt < DROID_CONTEXT_STATS_THROTTLE_MS) return;
    cs.lastAt = now;
    cs.inFlight = true;
    rpc
      .request<{ used?: unknown; limit?: unknown }>(DROID_METHODS.getContextStats, {}, DROID_CONTEXT_STATS_TIMEOUT_MS)
      .then(
        (res) => {
          cs.inFlight = false;
          cs.failures = 0;
          const used = typeof res?.used === "number" && Number.isFinite(res.used) ? res.used : undefined;
          const limit = typeof res?.limit === "number" && Number.isFinite(res.limit) ? res.limit : undefined;
          if (used === undefined || limit === undefined || limit <= 0) return;
          emit({
            t: "context_usage",
            usage: { tokens: used, contextWindow: limit, percent: Math.round((used / limit) * 1000) / 10 },
          });
        },
        () => {
          cs.inFlight = false;
          cs.failures++;
          if (cs.failures >= DROID_CONTEXT_STATS_MAX_FAILURES) cs.disabled = true;
        },
      );
  };

  const mapper: DroidMapper = createDroidMapper({
    emit,
    ledger: init.ledger,
    clock,
    resume: init.resume,
    modelRef: `droid/${init.effectiveModelId}`,
    ...(init.transcript === undefined
      ? {}
      : {
          appendTranscript: (entry: { type: "message"; message: unknown }) => {
            init.transcript?.append(entry);
          },
        }),
    onToolResult: clearAckByToolUse,
    onAssistantMessage: pollContextStats,
    onTurnCompleted: (completion) => {
      // §4.5 终态表：prompt() 恒 resolve（除进程早退/协议致命），错误经 getTurnErrorInfo 带出。
      turnErrorInfo = classifyTurnEnd({
        reason: completion.reason,
        abortRequested,
        errors: mapper.errors().map((e) => deps.redact(e)),
        permissionApprovals,
      });
      clearAllAcks();
      settlePendingTurn();
    },
  });

  /** r3（§14）：turn 已开始未结算时进程死/被收 ⇒ 用 droid 自己的 settings.json 累计对账补记。 */
  const reconcileIfTurnOpen = (): void => {
    if (reconcileAttempted || !mapper.turnOpen()) return;
    reconcileAttempted = true;
    const counts = readNativeCumulativeUsage(
      droidNativeSessionPaths({ homeDir: factoryHomeDir(), cwd: init.cwd, sessionId: init.sessionId }).settingsFile,
    );
    if (counts === undefined) return; // 缺失/超限/坏文件/缺字段：一律放弃且不报错
    const delta = init.ledger.observeCumulative(counts); // 负差/无基线 ⇒ 账本钳 0 或不出增量
    if (delta === undefined) return;
    // r3「负差放弃」：钳出来的全零增量不算补记（usage 补记只认 token 正差额）。
    if (delta.input + delta.output + delta.cacheRead + delta.cacheWrite <= 0) return;
    emit({ t: "message_end", usage: delta });
    emit({ t: "external_meta", meta: { provider: "droid", reconciled: true } });
  };

  const fatal = (err: ClassifiedError): void => {
    if (fatalError !== undefined) return;
    fatalError = err;
    clearAllAcks();
    reconcileIfTurnOpen();
    // interrupt 有界、不等结果（§4.3 收口表）；pending permission 时 EOF/SIGTERM 不可靠 ⇒ 直接 SIGKILL 组。
    try {
      void rpc.request(DROID_METHODS.interruptSession, {}, settings.requestTimeoutMs).then(
        () => {},
        () => {},
      );
    } catch {
      /* 写不出去也属于致命路径本身 */
    }
    child.terminate("now");
    turnErrorInfo = turnErrorInfo ?? err.info;
    const pending = pendingTurn;
    pendingTurn = undefined;
    pending?.reject(err);
  };

  const onSessionNotification = (method: string, params: unknown): void => {
    if (method !== DROID_METHODS.sessionNotification) return;
    const notif =
      params !== null && typeof params === "object" ? (params as Record<string, unknown>).notification : undefined;
    // §4.3 回执：permission_resolved 清对应计时器（mapper 不处理该类型）。
    if (notif !== null && typeof notif === "object") {
      const n = notif as Record<string, unknown>;
      if (n.type === "permission_resolved") {
        const rid = str(n.requestId);
        if (rid !== undefined) clearAck(rid);
      }
    }
    mapper.notify(notif);
  };

  const onSessionRequest = (method: string, id: string, params: unknown): RequestReply => {
    if (method !== DROID_METHODS.requestPermission) return { error: { ...DROID_UNSUPPORTED_REQUEST_REPLY } };
    // §4.3：同步批准（U2′）；每个批准起 10s 回执计时器。
    permissionApprovals++;
    emit({ t: "external_meta", meta: { provider: "droid", permissionApprovals } });
    const toolUseIds: string[] = [];
    if (params !== null && typeof params === "object") {
      const uses = (params as Record<string, unknown>).toolUses;
      if (Array.isArray(uses))
        for (const u of uses) {
          const toolUse = u !== null && typeof u === "object" ? (u as Record<string, unknown>).toolUse : undefined;
          const tid =
            toolUse !== null && typeof toolUse === "object" ? str((toolUse as Record<string, unknown>).id) : undefined;
          if (tid !== undefined) toolUseIds.push(tid);
        }
    }
    const timer = clock.setTimer(DROID_PERMISSION_ACK_TIMEOUT_MS, () => {
      permissionAcks.delete(id);
      fatal(
        new ClassifiedError({
          kind: "config",
          retryable: false,
          message: msgPermissionUnacknowledged(DROID_PERMISSION_ACK_TIMEOUT_MS),
        }),
      );
    });
    permissionAcks.set(id, { toolUseIds, timer });
    return { result: { ...DROID_PERMISSION_REPLY } };
  };

  const onSessionDrift = (d: { expected: string; actual: string }): void => {
    const agentVersion = catalog.snapshot()?.agentVersion;
    if (settings.protocolCheck === "strict") {
      fatal(
        new ClassifiedError({
          kind: "config",
          retryable: false,
          message: msgProtocolDrift(d.actual, d.expected, agentVersion),
        }),
      );
      return;
    }
    // warn 逃生口：进程内首次 warnOnce + degraded:+protocol_drift，继续跑。
    deps.warnOnce("droid-protocol-drift", msgProtocolDrift(d.actual, d.expected, agentVersion));
    if (!degraded.includes("protocol_drift")) {
      degraded.push("protocol_drift");
      emit({ t: "external_meta", meta: { provider: "droid", degraded: [...degraded] } });
    }
  };

  handlersRef.current = {
    onNotification: onSessionNotification,
    onRequest: onSessionRequest,
    onDrift: onSessionDrift,
    onProtocolError: (e) => fatal(e),
  };

  // 进程退出（exited 永不 reject；防御性挂 noop catch——句柄内部 Promise 绝不 unhandled）。
  void child.exited.then(
    (exit) => {
      try {
        rpc.failAll(new ClassifiedError({ kind: "internal", message: "droid process exited", retryable: false }));
      } catch {
        /* failAll 不应抛，防御 */
      }
      if (pendingTurn === undefined) return;
      clearAllAcks();
      reconcileIfTurnOpen();
      const pending = pendingTurn;
      pendingTurn = undefined;
      if (abortRequested || fatalError !== undefined) {
        pending.resolve();
        return;
      }
      pending.reject(
        new ClassifiedError({
          kind: "internal",
          retryable: false,
          message: `droid exited unexpectedly (code ${exit.code} / signal ${exit.signal}); stderr: ${child.stderrTail()}`,
        }),
      );
    },
    () => {},
  );

  // init/update 期间缓冲的通知回放进 mapper（事件先排队，attach 时放出）。
  for (const n of init.bufferedNotifications) onSessionNotification(n.method, n.params);

  const pid = child.pid;
  const killable: KillableHandle = {
    kind: "process",
    id: `droid:${pid}`,
    kill: () => {
      if (child.exitInfo() !== undefined) return; // 已退出 ⇒ no-op
      if (child.terminating() && !child.graceExpired()) return; // 优雅终止宽限内 ⇒ no-op（升级计时器负责）
      child.terminate("now");
    },
  };
  const killables: ReadonlySet<KillableHandle> = new Set([killable]);

  const handle: ExternalSessionHandle = {
    provider: "droid",
    sessionId: init.sessionId,
    get sessionFile() {
      return init.transcript?.path;
    },
    attach(onEvent) {
      if (emitter !== undefined) throw new Error("droid session handle: attach() may only be called once");
      emitter = onEvent;
      const protocolVersion = envelope.lastSeenProtocolVersion();
      const agentVersion = catalog.snapshot()?.agentVersion;
      emit({
        t: "external_meta",
        meta: {
          provider: "droid",
          sessionId: init.sessionId,
          ...(init.autonomyEcho === undefined ? {} : { autonomy: init.autonomyEcho }),
          ...(protocolVersion === undefined ? {} : { protocolVersion }),
          ...(agentVersion === undefined ? {} : { agentVersion }),
          pricing: pricingDiagOf(ext.pricing),
          degraded: [...degraded],
          nativeSessionFile: droidNativeSessionPaths({
            homeDir: factoryHomeDir(),
            cwd: init.cwd,
            sessionId: init.sessionId,
          }).sessionFile,
        },
      });
      for (const e of queued.splice(0)) emit(e);
    },
    prompt(text: string): Promise<void> {
      if (fatalError !== undefined) return Promise.reject(fatalError);
      if (child.exitInfo() !== undefined)
        return Promise.reject(
          new ClassifiedError({ kind: "internal", message: "droid process already exited", retryable: false }),
        );
      const first = promptCount === 0;
      promptCount++;
      // §4.8：首条消息拼 rolePrompt/contextBlocks/schema 指令；resume 时 contextBlocks 为空、
      // renderFirstMessage 退化为 text 原样。
      const out = first
        ? renderFirstMessage({
            ...(ext.rolePrompt === undefined ? {} : { rolePrompt: ext.rolePrompt }),
            contextBlocks: ext.contextBlocks,
            ...(ext.schema === undefined ? {} : { schema: ext.schema }),
            text,
            toolNameHint: DROID_TOOL_NAME_HINT,
          })
        : text;
      turnErrorInfo = undefined;
      reconcileAttempted = false;
      abortRequested = false;
      mapper.resetTurnErrors();
      let resolveTurn!: () => void;
      let rejectTurn!: (e: unknown) => void;
      const promise = new Promise<void>((resolve, reject) => {
        resolveTurn = resolve;
        rejectTurn = reject;
      });
      pendingTurn = { resolve: resolveTurn, reject: rejectTurn, promise };
      rpc.request(DROID_METHODS.addUserMessage, { text: out }, settings.requestTimeoutMs).then(
        () => {},
        (e: unknown) => {
          // add_user_message 写不出去/超时 ⇒ 致命收口（§4.5 协议致命行同款）。
          const info = classifiedInfo(e) ?? {
            kind: "internal" as const,
            message: deps.redact(e instanceof Error ? e.message : String(e)),
            retryable: false,
          };
          fatal(new ClassifiedError(info));
        },
      );
      return promise;
    },
    steer(text: string): Promise<void> {
      // idle / 已死 ⇒ 立即 resolve 不发送（reaper L1 每次都调 steer，idle 真发会开启新 turn）。
      if (!mapper.turnOpen() || child.exitInfo() !== undefined || fatalError !== undefined || disposed)
        return Promise.resolve();
      return rpc.request(DROID_METHODS.addUserMessage, { text }, settings.requestTimeoutMs).then(
        () => {},
        () => {}, // steer 失败不致命：外层兜底照常
      );
    },
    requestAbort(): Promise<void> {
      if (!mapper.turnOpen() && pendingTurn === undefined) return Promise.resolve();
      if (child.exitInfo() !== undefined || fatalError !== undefined) return Promise.resolve();
      abortRequested = true;
      try {
        void rpc.request(DROID_METHODS.interruptSession, {}, settings.requestTimeoutMs).then(
          () => {},
          () => {},
        );
      } catch {
        /* 写不出去：走计时器升级 */
      }
      const pending = pendingTurn;
      if (pending === undefined) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = clock.setTimer(DROID_INTERRUPT_WAIT_MS, () => {
          interruptWait = undefined;
          child.terminate("graceful"); // interrupt 未如期结算 ⇒ 升级
          resolve();
        });
        interruptWait = timer;
        pending.promise.then(
          () => {
            clock.clearTimer(timer);
            if (interruptWait === timer) interruptWait = undefined;
            resolve();
          },
          () => {
            clock.clearTimer(timer);
            if (interruptWait === timer) interruptWait = undefined;
            resolve();
          },
        );
      });
    },
    dispose(): DisposeReport {
      if (disposeReport !== undefined) return disposeReport;
      disposed = true;
      clearAllAcks();
      if (interruptWait !== undefined) {
        clock.clearTimer(interruptWait);
        interruptWait = undefined;
      }
      reconcileIfTurnOpen(); // r3：turn 进行中 dispose（超时/reaper）也补记
      init.transcript?.close();
      let killed = 0;
      const unkillable: { kind: string; id: string }[] = [];
      if (child.exitInfo() === undefined && !child.terminating()) {
        const r = child.terminate(mapper.turnOpen() ? "now" : "graceful");
        if (r.signalled) killed = 1;
        if (r.error !== undefined) unkillable.push({ kind: "process", id: `droid:${pid}` });
      }
      disposeReport = { returned: true, killed, unkillable };
      return disposeReport;
    },
    killableHandles: killables,
    setActiveTools: () => {}, // U2′：不下发工具白名单
    getActiveTools: () => [],
    getLastAssistantText: () => mapper.lastAssistantText(),
    getTurnErrorInfo: () => turnErrorInfo,
    getTurnError: () => turnErrorInfo?.message,
    getUsage: (): UsageDelta => init.ledger.totals().usage,
    getModelRef: () => ({ provider: "droid", id: init.effectiveModelId }),
    getThinkingLevel: () => init.effectiveEffort,
    getLeafId: () => init.transcript?.leafId() ?? null,
    getBranchEntries: () => init.transcript?.branch() ?? [],
    // 不实现（arch §9）：setModel / setThinkingLevel / observe / measureInputBudget /
    // getToolSources / getSwitchTail / consultIdentityPrediction；childExtensionMissing 永不置位。
  };
  return handle;
}
