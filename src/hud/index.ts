/**
 * pi-hud 移植：HUD footer 的装配与生命周期（wireHud 入口）。
 * 来源：~/.pi/agent/extensions/pi-hud.ts（903 行单文件 → src/hud/ 六文件拆分）。
 *
 * 门控：wireHud 不读 settings——`hud.enabled` 门在调用侧（装配包）。
 *
 * S3（单一 live 门）：
 * - HudSession.live 在 session_start 判定一次（ctx.mode === "tui"），此后所有
 *   pi.on handler 与 pi.events 回调统一 `if (!s?.live) return`。
 * - 与源插件的行为差异（有意为之）：
 *   1. 非 tui 模式不再启动任何定时器（源插件 onBgStarted 无 mode 门，print 模式
 *      下后台 agent 启动会启 1Hz llmTimer）；
 *   2. turn_start 的 appendEntry 也在 live 门之后（源插件在 mode 判定前落盘
 *      pi-hud-session-start）——非 tui 会话不再产生 HUD 计时条目；
 *   3. message_* / tool_execution_* / session_tree 在非 tui 下完全 no-op
 *      （源插件只门控了 11 个 handler 中的 5 个）。
 *
 * S4（无泄漏生命周期）：
 * - 源插件把 7 个 pi.events.on(...) 的 unsubscribe 全部丢弃，而事件总线跨
 *   /reload 存活 → 每次 reload 泄漏一套死监听。这里 busUnsubscribers 收集全部
 *   退订函数，session_shutdown 里逐一调用；session_start 重新订阅（幂等），
 *   保证 /new、/reload 后监听数不增长。
 * - 全部会话状态收进 HudSession（session_start 重建、shutdown dispose）；
 *   wireHud 闭包只持有 `session` 与 `busUnsubscribers`，无模块级可变状态。
 * - refreshTimer（5s）/ llmTimer（1s）创建后立即 unref——仓库铁律（ref'd
 *   timer 会卡死 `pi -p`），非 tui 路径也可能启定时器时是硬必需。
 */
import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installFooter, renderConversationStats, renderToolStats } from "./footer.js";
import { readRepoState, readWorktrees, type ExecFn, type GitState, type WorktreeInfo } from "./git.js";
import { SpeedTracker } from "./speed.js";
import {
  SESSION_START_ENTRY_TYPE,
  createTimingState,
  finishLlmTiming,
  finishRoundTiming,
  persistPendingRoundTiming,
  restoreTiming,
  type TimingState,
} from "./timing.js";

const STATUS_ID = "pi-hud";
const REFRESH_INTERVAL_MS = 5_000;
const LLM_TIMER_INTERVAL_MS = 1_000;
const AUTO_FETCH_TIMEOUT_MS = 30_000;

export interface HudOptions {
  /**
   * 周期 `git fetch --quiet --prune` 的间隔（分钟，settings `hud.autoFetchMinutes`）。
   * ↑/↓ 对比的是本地 remote-tracking ref，不 fetch 就永远看不到别处推进的远程
   * 提交；0 = 关闭（只保留手动 /pi-hud-refresh）。
   */
  autoFetchMinutes?: number;
}

export interface HudSession {
  /** session_start 判定一次：ctx.mode === "tui"。所有 handler 的唯一门（S3）。 */
  live: boolean;
  /**
   * 会话被替换（/new、fork、switch、/reload）后捕获的 ctx 会失效，
   * 任何 await 之后都必须重新检查该标志，否则读 ctx.* 会抛 stale ctx 异常。
   */
  active: boolean;
  /** 最近一次 session_start 的 ctx，供 pi.events 回调（无 ctx 参数）使用。 */
  ctx: ExtensionContext | undefined;
  refreshTimer: ReturnType<typeof setInterval> | undefined;
  llmTimer: ReturnType<typeof setInterval> | undefined;
  refreshing: boolean;
  gitState: GitState | undefined;
  worktrees: WorktreeInfo[] | undefined;
  /** 上次自动 fetch 的 Date.now() 时间戳；0 = 尚未 fetch（首个 refresh 即补一次）。 */
  lastAutoFetchAt: number;
  userInputs: number;
  llmRequests: number;
  totalToolCalls: number;
  activeToolCalls: number;
  failedToolCalls: number;
  toolCounts: Map<string, number>;
  /**
   * 后台 subagent：id → performance.now() 启动时刻。主 agent 的
   * turn_start/turn_end/agent_settled 都感知不到子 agent（子会话有独立
   * ExtensionRunner），只能经共享事件总线 pi.events 追踪。后台 agent 存活期间
   * 回合计时挂起，Σ 继续走时，直到最后一个后台 agent 结束才收尾。
   */
  bgAgents: Map<string, number>;
  /**
   * pi-subagent 实时费用（subagent:usage 事件，1Hz）：runId → 累计花费/是否终态。
   * 与 session 已入账部分（携带 usage 的 toolResult，其 details.runId 可识别）
   * 按 runId 去重：已入账的 run 不再计入实时分量，避免双算。
   */
  subUsage: Map<string, { costUsd: number; terminal: boolean }>;
  timing: TimingState;
  speed: SpeedTracker;
  streamStartedAt: number | undefined;
  footerRequestRender: (() => void) | undefined;
}

function createHudSession(ctx: ExtensionContext): HudSession {
  return {
    live: false,
    active: false,
    ctx,
    refreshTimer: undefined,
    llmTimer: undefined,
    refreshing: false,
    gitState: undefined,
    worktrees: undefined,
    lastAutoFetchAt: 0,
    userInputs: 0,
    llmRequests: 0,
    totalToolCalls: 0,
    activeToolCalls: 0,
    failedToolCalls: 0,
    toolCounts: new Map(),
    bgAgents: new Map(),
    subUsage: new Map(),
    timing: createTimingState(),
    speed: new SpeedTracker(() => performance.now()),
    streamStartedAt: undefined,
    footerRequestRender: undefined,
  };
}

export function wireHud(pi: ExtensionAPI, options: HudOptions = {}): void {
  const autoFetchMs = Math.max(0, (options.autoFetchMinutes ?? 0) * 60_000);
  let session: HudSession | undefined;
  // S4：pi.events 退订收集。事件总线跨 /reload 存活，不收集就每次 reload 泄漏一套。
  const busUnsubscribers: Array<() => void> = [];

  const exec: ExecFn = (command, args, options) => pi.exec(command, args, options);
  const appendEntry = (customType: string, data?: unknown) => pi.appendEntry(customType, data);

  function stopLlmTimer(s: HudSession): void {
    if (s.llmTimer) clearInterval(s.llmTimer);
    s.llmTimer = undefined;
  }

  function startLlmTimer(s: HudSession): void {
    if (s.llmTimer) return;
    s.llmTimer = setInterval(() => {
      const ctx = s.ctx;
      if (!ctx) return;
      try {
        updateHud(s, ctx);
      } catch {
        stopLlmTimer(s);
      }
    }, LLM_TIMER_INTERVAL_MS);
    s.llmTimer.unref();
  }

  function updateHud(s: HudSession, ctx: ExtensionContext): void {
    if (!s.active || !s.live) return;
    const parts = [renderConversationStats(s, ctx), renderToolStats(s, ctx)].filter((part): part is string =>
      Boolean(part),
    );
    ctx.ui.setStatus(STATUS_ID, parts.join(ctx.ui.theme.fg("dim", " │ ")));
    s.footerRequestRender?.();
  }

  /**
   * 周期 git fetch：HUD 的 ↑/↓ 来自本地 remote-tracking ref（branch.ab），只有
   * fetch/push/pull 会推进它；不周期 fetch，别处推到远程的提交永远不会体现在
   * 计数上。成败都记时间戳——失败（离线/无凭据）退避到下个周期，而不是每 5s 猛打。
   */
  async function maybeAutoFetch(s: HudSession, cwd: string): Promise<void> {
    if (autoFetchMs <= 0) return;
    const now = Date.now();
    if (now - s.lastAutoFetchAt < autoFetchMs) return;
    s.lastAutoFetchAt = now;
    try {
      await exec("git", ["-C", cwd, "fetch", "--quiet", "--prune"], { timeout: AUTO_FETCH_TIMEOUT_MS });
    } catch {
      /* exec 自身 reject（spawn 失败等）：静默，HUD 继续用本地缓存的 remote ref */
    }
  }

  async function refresh(s: HudSession, ctx: ExtensionContext): Promise<void> {
    if (s.refreshing || !s.active || !s.live) return;
    s.refreshing = true;
    // cwd 在 await 前快照：await 期间会话可能被替换，之后读 ctx.cwd 会抛。
    const cwd = ctx.cwd;
    try {
      await maybeAutoFetch(s, cwd);
      if (!s.active) return;
      const state = await readRepoState(exec, cwd);
      if (!s.active) return;
      const trees = state ? await readWorktrees(exec, cwd) : undefined;
      if (!s.active) return;
      s.gitState = state;
      s.worktrees = trees;
      updateHud(s, ctx);
    } finally {
      s.refreshing = false;
    }
  }

  function persistTiming(s: HudSession): void {
    persistPendingRoundTiming(s.timing, appendEntry);
  }

  function finishRound(s: HudSession, ctx: ExtensionContext, force = false): void {
    const result = finishRoundTiming(s.timing, performance.now(), s.bgAgents.size, force);
    if (result === "finished") {
      stopLlmTimer(s);
      updateHud(s, ctx);
    }
  }

  // 后台 subagent 生命周期。兼容两套广播源：
  //  - 旧 @tintinweb/pi-subagents：频道 subagents:*（复数），payload { id }
  //  - pi-subagent（本仓库扩展）：频道 subagent:*（单数），payload { runId }
  // 两者用 Map 键去重，重复事件无害。started 在进入 running 时触发（含从队列启动）。
  const bgAgentId = (data: unknown): string | undefined => {
    const d = data as { id?: unknown; runId?: unknown } | undefined;
    const id = typeof d?.id === "string" && d.id !== "" ? d.id : undefined;
    const runId = typeof d?.runId === "string" && d.runId !== "" ? d.runId : undefined;
    return id ?? runId;
  };
  const onBgStarted = (data: unknown) => {
    const s = session;
    if (!s?.live || !s.active) return;
    const id = bgAgentId(data);
    if (id === undefined || s.bgAgents.has(id)) return;
    s.bgAgents.set(id, performance.now());
    // 主会话空闲时后台 agent 启动：开一个占位计时段，让任务总时长继续累计，
    // llmTimer 保持 HUD 每秒刷新。
    if (s.timing.roundStartedAt === undefined && s.ctx) {
      try {
        s.timing.roundStartedAt = performance.now();
        s.timing.roundHeldForBg = true;
        startLlmTimer(s);
        updateHud(s, s.ctx);
      } catch {
        s.timing.roundStartedAt = undefined;
        s.timing.roundHeldForBg = false;
        stopLlmTimer(s);
      }
    }
  };
  const onBgSettled = (data: unknown) => {
    const s = session;
    if (!s?.live || !s.active) return;
    const id = bgAgentId(data);
    if (id === undefined || !s.bgAgents.delete(id)) return;
    // 最后一个后台 agent 结束且存在挂起回合：收尾并持久化。
    if (s.bgAgents.size === 0 && s.timing.roundHeldForBg && s.ctx) {
      try {
        finishRound(s, s.ctx, true);
        persistTiming(s);
      } catch {
        stopLlmTimer(s);
      }
    }
  };
  // pi-subagent 实时费用广播（1Hz，含终态帧）：更新 runId → 花费映射并触发
  // footer 重绘，使 Σ 旁的 +agents 分量实时跳动。
  const onSubUsage = (data: unknown) => {
    const s = session;
    if (!s?.live || !s.active) return;
    const runs = (data as { runs?: unknown } | undefined)?.runs;
    if (!Array.isArray(runs)) return;
    for (const r of runs) {
      const rid = (r as { runId?: unknown }).runId;
      if (typeof rid !== "string" || rid === "") continue;
      const cost = (r as { costUsd?: unknown }).costUsd;
      s.subUsage.set(rid, {
        costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : 0,
        terminal: Boolean((r as { terminal?: unknown }).terminal),
      });
    }
    s.footerRequestRender?.();
  };

  function subscribeBusEvents(): void {
    if (busUnsubscribers.length > 0) return;
    busUnsubscribers.push(
      pi.events.on("subagents:started", onBgStarted),
      pi.events.on("subagents:completed", onBgSettled),
      pi.events.on("subagents:failed", onBgSettled),
      // pi-subagent（单数频道）：completed/failed 覆盖全部终态（aborted/timed_out 也走 failed 频道）。
      pi.events.on("subagent:started", onBgStarted),
      pi.events.on("subagent:completed", onBgSettled),
      pi.events.on("subagent:failed", onBgSettled),
      pi.events.on("subagent:usage", onSubUsage),
    );
  }

  function unsubscribeBusEvents(): void {
    while (busUnsubscribers.length > 0) busUnsubscribers.pop()?.();
  }

  // 激活即订阅：保留源插件行为（session_start 先于 activate 到达的 /reload
  // 场景也能追后台 agent）。session_shutdown 退订、session_start 幂等重订阅。
  subscribeBusEvents();

  pi.on("session_start", async (_event, ctx) => {
    if (session) disposeSession(session);
    const s = createHudSession(ctx);
    session = s;
    s.live = ctx.mode === "tui";
    if (!s.live) return;
    s.active = true;
    subscribeBusEvents();

    restoreTiming(s.timing, ctx.sessionManager.getBranch());
    s.speed.reset();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      if (entry.message.role === "user") {
        s.userInputs++;
        continue;
      }
      if (entry.message.role === "assistant") {
        s.llmRequests++;
        continue;
      }
      if (entry.message.role !== "toolResult") continue;
      const name = entry.message.toolName;
      s.totalToolCalls++;
      s.toolCounts.set(name, (s.toolCounts.get(name) ?? 0) + 1);
      if (entry.message.isError) s.failedToolCalls++;
    }

    installFooter(s, ctx);
    await refresh(s, ctx);
    // 定时器是游离 promise：必须自己吞掉异常，否则 unhandled rejection 会杀掉进程。
    s.refreshTimer = setInterval(() => {
      refresh(s, ctx).catch(() => {});
    }, REFRESH_INTERVAL_MS);
    s.refreshTimer.unref();
  });

  pi.on("message_start", async (event, _ctx) => {
    const s = session;
    if (!s?.live) return;
    if (event.message.role !== "assistant") return;
    s.streamStartedAt = performance.now();
    s.speed.reset();
  });

  pi.on("message_update", async (event, _ctx) => {
    const s = session;
    if (!s?.live) return;
    if (event.message.role !== "assistant") return;
    const output = event.message.usage?.output;
    if (typeof output === "number" && Number.isFinite(output) && output > 0) {
      s.speed.push(output);
    }
    // 不在这里触发渲染，由 1 秒 LLM 定时器刷新 HUD
  });

  pi.on("message_end", async (event, ctx) => {
    const s = session;
    if (!s?.live) return;
    if (event.message.role === "user") {
      s.userInputs++;
      updateHud(s, ctx);
      return;
    }
    if (event.message.role === "assistant") {
      const output = event.message.usage?.output;
      const streamElapsedMs = s.streamStartedAt === undefined ? undefined : performance.now() - s.streamStartedAt;
      if (
        typeof output === "number" &&
        Number.isFinite(output) &&
        output > 0 &&
        streamElapsedMs !== undefined &&
        streamElapsedMs > 0
      ) {
        s.speed.push(output);
        // 优先滑动窗口速率；长流（usage 仅末尾到达的 provider）回退到流式平均；
        // burst 投递（整段响应 <1s flush 完）回退到含 TTFT 的端到端有效速率。
        const windowSpeed = s.speed.windowSpeed();
        if (windowSpeed !== undefined) {
          s.timing.lastSpeedTps = windowSpeed;
        } else if (streamElapsedMs >= 1_000) {
          s.timing.lastSpeedTps = output / (streamElapsedMs / 1_000);
        } else if (s.timing.llmStartedAt !== undefined) {
          const llmElapsedMs = performance.now() - s.timing.llmStartedAt;
          if (llmElapsedMs > 0) s.timing.lastSpeedTps = output / (llmElapsedMs / 1_000);
        }
      }
      s.streamStartedAt = undefined;
      s.speed.reset();
      if (finishLlmTiming(s.timing, performance.now())) updateHud(s, ctx);
      s.footerRequestRender?.();
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const s = session;
    if (!s?.live) return;
    finishRound(s, ctx);
    persistTiming(s);
  });

  pi.on("turn_start", async (_event, ctx) => {
    const s = session;
    if (!s?.live) return;
    s.llmRequests++;
    if (s.timing.sessionStartedAt === undefined) {
      s.timing.sessionStartedAt = Date.now();
      appendEntry(SESSION_START_ENTRY_TYPE, { startedAt: s.timing.sessionStartedAt });
    }
    // 新回合强制收尾上一轮：若上一轮因后台 agent 挂起，其等待时长
    // 并入上一轮；新一轮重新开始计时。
    finishRound(s, ctx, true);
    persistTiming(s);
    const startedAt = performance.now();
    s.timing.roundStartedAt = startedAt;
    s.timing.llmStartedAt = startedAt;
    s.timing.currentRoundLlmDurationMs = undefined;
    startLlmTimer(s);
    updateHud(s, ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    const s = session;
    if (!s?.live) return;
    const branch = ctx.sessionManager.getBranch();
    s.userInputs = branch.filter((entry) => entry.type === "message" && entry.message.role === "user").length;
    s.llmRequests = branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length;
    stopLlmTimer(s);
    s.streamStartedAt = undefined;
    s.speed.reset();
    restoreTiming(s.timing, branch);
    updateHud(s, ctx);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    const s = session;
    if (!s?.live) return;
    s.totalToolCalls++;
    s.activeToolCalls++;
    s.toolCounts.set(event.toolName, (s.toolCounts.get(event.toolName) ?? 0) + 1);
    updateHud(s, ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const s = session;
    if (!s?.live) return;
    s.activeToolCalls = Math.max(0, s.activeToolCalls - 1);
    if (event.isError) s.failedToolCalls++;
    updateHud(s, ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    const s = session;
    if (!s?.live) return;
    finishRound(s, ctx);
    persistTiming(s);
    await refresh(s, ctx);
  });

  function disposeSession(s: HudSession): void {
    s.active = false;
    s.bgAgents.clear();
    s.subUsage.clear();
    s.timing.roundHeldForBg = false;
    if (s.refreshTimer) clearInterval(s.refreshTimer);
    s.refreshTimer = undefined;
    stopLlmTimer(s);
    s.footerRequestRender = undefined;
    s.ctx = undefined;
  }

  pi.on("session_shutdown", async (_event, ctx) => {
    const s = session;
    session = undefined;
    // S4：退订全部 pi.events 监听（事件总线跨 /reload 存活）。
    unsubscribeBusEvents();
    if (!s) return;
    const wasLive = s.live;
    disposeSession(s);
    if (!wasLive) return;
    // 恢复 pi 内置 footer / 清掉 HUD status 行。ctx 可能已失效，防御性 try。
    try {
      ctx.ui.setFooter(undefined);
      ctx.ui.setStatus(STATUS_ID, undefined);
    } catch {
      /* stale ctx on reload —— 新 activation 会重建 footer */
    }
  });

  pi.registerCommand("pi-hud-refresh", {
    description: "Fetch remote refs and refresh Pi HUD",
    handler: async (_args, ctx) => {
      const s = session;
      if (!s?.live) return;
      ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", "git fetching…"));
      const result = await exec("git", ["fetch", "--quiet", "--prune"], {
        cwd: ctx.cwd,
        timeout: AUTO_FETCH_TIMEOUT_MS,
      });
      if (result.code !== 0) {
        ctx.ui.notify(result.stderr.trim() || "git fetch failed", "error");
      }
      // 手动 fetch 后重记自动 fetch 时间戳，避免紧跟着又来一次冗余 fetch。
      s.lastAutoFetchAt = Date.now();
      await refresh(s, ctx);
    },
  });
}
