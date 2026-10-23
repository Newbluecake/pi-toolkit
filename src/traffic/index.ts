/**
 * traffic 录制——面向 pi 的唯一装配（T2a：进程容器 / engine 生命周期 / trampoline / 模式门禁）。
 *
 * 入口 `wireTraffic(pi, opts)`：**opts 缺省 = 关** ⇒ 立即返回，零注册、零 IO、零全局符号、不加载 node:sqlite。
 * T3 负责从 settings 读 `traffic.*` 后调用（主会话在 activate 末尾、子会话在 guard 前），并接入认领协议
 * （`isActive` 端口 = claim.isLive）。本包不改任何现有模块。
 *
 * - host（主会话）：注册 `/record on|off|status`、钩子与 `session_shutdown`。engine 只在 `/record on`
 *   时创建（`acquireEngine(owner)`）；`/record status` 无 engine 时开短连接读计数后即关（不建容器）。
 *   网页服务 / 重放只在 `ctx.mode ∈ {tui, rpc}` 时随 `/record on` 启动（§4.1），print/json 只录制并在回复注明。
 *   `session_shutdown`（任何 reason）⇒ 身份校验释放 + `engine.close()`（同步撤销接纳，有界关库）。
 * - child（子会话）：只注册录制钩子；每个钩子入口读一次全局 engine 并固定持有；engine 不存在 / 非 open /
 *   未录制 / `isActive()` 为假 ⇒ 立即 return（不 stringify、不做任何事）。子会话无命令、无服务、无重放。
 * - 所有钩子恒返回 `undefined`（不改 payload / headers）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { lazyText, type RowRef } from "./db-port.js";
import {
  defaultRecordPaths,
  ensureDb,
  openDb,
  sessionUpsertParams,
  UPSERT_SESSION_SQL,
  type SqliteLoader,
} from "./db.js";
import {
  acquireEngine,
  FALLBACK_ENGINE_SETTINGS,
  peekEngine,
  releaseEngine,
  type NotifyFn,
  type TrafficEngine,
} from "./engine.js";
import { createJqRunner } from "./jq.js";
import { PRINT_MODE_NOTE, type TrafficRole } from "./mode.js";
import { recordInsert, recordPatch, recordSql } from "./persist.js";
import { getEngineSettings, loadEnabledRules, type EngineSettings, type RewriteRule } from "./rewrite.js";
import { SECURE_SESSION_MESSAGE, isSecure } from "./secure.js";
import { createTrafficServer } from "./server.js";
import { broadcast } from "./sse.js";
import { BIND_HOST } from "./state.js";
import { checkTapAfterResponse, installTap, tapActiveFor, tapSnapshot, TICKET_HEADER } from "./tap.js";
import {
  decidePairing,
  rewriteSuspended,
  suspendRewrite,
  TICKET_APIS,
  TICKET_TTL,
  type Ticket,
  type TicketRunner,
} from "./ticket.js";

export interface WireTrafficOptions {
  /** 总开关（T3 由 `traffic.enabled` 提供）。缺省 false ⇒ 零注册零 IO。 */
  enabled?: boolean;
  /** 缺省 host。 */
  role?: TrafficRole;
  /** 主会话激活身份（T3 与 claim.token 同一对象）。缺省每次 wire 新建。 */
  owner?: object;
  /** 测试注入；缺省固定 `homedir()/.pi/agent/records/traffic.db`。 */
  dbPath?: string;
  legacyDbPath?: string | null;
  loadSqlite?: SqliteLoader;
  /** 认领协议端口（T3：claim 属于 toolkit 且 isLive）。缺省恒 true。 */
  isActive?: () => boolean;
  /** 子会话请求是否落库（T3：`traffic.childSessions`，缺省 true）。 */
  childPersist?: boolean;
}

export interface TrafficWiring {
  readonly role: TrafficRole;
  readonly owner: object;
  /** 本激活持有的 engine（host 且已 /record on）。 */
  engine(): TrafficEngine | undefined;
  /**
   * 改写是否「上膛」（open ∧ 录制中 ∧ 有启用规则）。**T5 的 warming 否决消费点**（裁定 A2）：规则启用时 T5 应对
   * `cache_warming_decision` 返回 `{action:"stop"}`。traffic 拿不到最终裁定，故观测到 decision 一律暂停改写（fail closed）。
   */
  rewriteArmed(): boolean;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function noteDbError(engine: TrafficEngine, err: unknown): void {
  const message = errorText(err);
  engine.dbError = message;
  if (!engine.dbErrorNotified) {
    engine.dbErrorNotified = true;
    broadcast(engine, { type: "record_warn", message: `数据库错误，改写持久化已禁用: ${message}` });
  }
}

function installBlockedNotifier(engine: TrafficEngine): void {
  engine.capture.setRewriteBlockedHandler((message: string) => {
    engine.notify?.(message, "error");
  });
}

function formatAttributionStatus(engine: TrafficEngine | undefined): string[] {
  if (!engine) return ["归属: 未运行"];
  const c = engine.tickets.counters;
  const d = engine.dbPort.stats();
  return [
    `归属: 票据 ${c.ticketsMinted} 铸 / ${c.ticketsBound} 绑定 / ${c.generationBumps} 升代 · 未证明 payload ${c.unattributedPayloads} / fetch ${c.unattributedFetches} / 响应 ${c.unattributedResponses} · 过期票据 ${c.staleTickets} · 白名单外 ${c.unsupportedApiPayloads}`,
    `墓碑: 立 ${c.tombstones} / 清 ${c.tombstonesCleared} · 墓碑期 payload ${c.tombstonedPayloads}`,
    `改写暂停（观测到 cache warming，fail closed）: 进入 ${c.rewriteSuspensions} / 解除 ${c.rewriteResumes} · 未应用规则的请求 ${c.rewriteSuspendedRequests}（/record off → on 恢复）`,
    `写入: 排队 ${d.queued} (${(d.queuedBytes / 1024).toFixed(0)} KB) · 丢弃 ${d.droppedRows}${d.droppedByKind.oversize ? `（超限单条 ${d.droppedByKind.oversize}）` : ""} · 退避 ${d.busyBackoffs} · 最长语句 ${d.maxStmtMs.toFixed(1)}ms · 孤儿 ${d.orphanOps} · 写错误 ${d.writeErrors}`,
    `checkpoint: ${d.checkpoints} 次 · 最长 ${d.maxCheckpointMs.toFixed(1)}ms · 无法证明有界而跳过 ${d.checkpointsDeferred}${d.walBytes !== null ? ` · WAL ${(d.walBytes / 1024).toFixed(0)} KB` : ""} · 规则快照刷新 ${engine.rulesRefresh.refreshes}（最长 ${engine.rulesRefresh.maxMs.toFixed(1)}ms）`,
    "串行化: 已停用（r2 票据归属；rewrite_settings 的 serialize_* 参数不再生效）",
  ];
}

interface StatusCounts {
  failure: string | null;
  enabledRules: number | null;
  totalRules: number | null;
  requests: number | null;
  messages: number | null;
  sessions: number | null;
  settings: EngineSettings;
}

function readCounts(db: { prepare(sql: string): { get(): unknown } }, out: StatusCounts): void {
  const count = (sql: string): number | null => {
    try {
      return (db.prepare(sql).get() as { c: number }).c;
    } catch (err) {
      out.failure = errorText(err);
      return null;
    }
  };
  out.totalRules = count("SELECT COUNT(*) c FROM rewrite_rules");
  out.requests = count("SELECT COUNT(*) c FROM requests");
  out.messages = count("SELECT COUNT(*) c FROM messages");
  out.sessions = count("SELECT COUNT(*) c FROM sessions");
}

/** 主会话 /record 命令。 */
function registerRecordCommand(
  pi: ExtensionAPI,
  opts: Required<Pick<WireTrafficOptions, "isActive">> & WireTrafficOptions,
  owner: object,
): void {
  const ownEngine = (): TrafficEngine | undefined => {
    const engine = peekEngine();
    return engine && engine.owner === owner && engine.state === "open" ? engine : undefined;
  };

  pi.registerCommand("record", {
    description: "流量录制: /record on|off|status — 记录模型输入输出到 SQLite，Web 页面实时查看（支持局域网）",
    getArgumentCompletions: (prefix) =>
      [
        { value: "on", label: "on", description: "开始录制 + 启动 Web 查看页（本机 + 局域网）" },
        { value: "off", label: "off", description: "停止录制（历史保留，页面仍可浏览）" },
        { value: "status", label: "status", description: "查看录制状态、统计与访问 URL" },
      ].filter((item) => item.value.startsWith(prefix)),
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase().split(/\s+/).filter(Boolean)[0] || "status";

      if (isSecure()) {
        ctx.ui.notify(SECURE_SESSION_MESSAGE, sub === "off" ? "info" : "warning");
        return;
      }
      if (!opts.isActive()) {
        ctx.ui.notify("traffic 录制当前由其它录制器承担（toolkit 已让位）", "warning");
        return;
      }

      if (sub === "on") {
        await recordOn(ctx);
        return;
      }
      if (sub === "off") {
        recordOff(ctx);
        return;
      }
      if (sub === "status") {
        await recordStatus(ctx);
        return;
      }
      ctx.ui.notify("用法: /record on | /record off | /record status", "warning");
    },
  });

  async function recordOn(ctx: ExtensionContext): Promise<void> {
    // 首次显式 DB 访问：创建容器 + engine（同 owner 复用；陈旧 owner 先关闭）。
    const engine = acquireEngine(owner, {
      ...(opts.dbPath !== undefined ? { dbPath: opts.dbPath } : {}),
      ...(opts.legacyDbPath !== undefined ? { legacyDbPath: opts.legacyDbPath } : {}),
      ...(opts.loadSqlite !== undefined ? { loadSqlite: opts.loadSqlite } : {}),
      role: "host",
      mode: ctx.mode,
    });
    const epoch = engine.epoch;
    // 「录制关闭后重新开启」是改写暂停的可验证解除边界（新 engine 本身就是新台账，+1 无害）。
    const resumed = !engine.recording;
    engine.notify = ctx.ui.notify.bind(ctx.ui) as NotifyFn;
    try {
      ensureDb(engine);
      installBlockedNotifier(engine); // 幂等：只是设置回调
      engine.currentSessionId = ctx.sessionManager.getSessionId();
      // 规则快照在命令路径同步加载一次（发送路径只读内存快照），之后后台定时刷新。
      engine.refreshRules();
      engine.startRulesRefresh();
      if (resumed) engine.rewriteMarks.resumeSeq++;
      engine.recording = true;
      installTap(engine, engine.capture.handleFetch);
      recordSql(engine, epoch, UPSERT_SESSION_SQL, sessionUpsertParams(ctx), 0);
      const lines = ["🔴 流量录制已开启", ""];
      if (engine.serviceAllowed) {
        engine.web ??= createTrafficServer(engine);
        const port = await engine.web.startServer();
        lines.push("Web 查看页:", ...engine.web.accessUrls(port), "");
      } else {
        lines.push(`（${PRINT_MODE_NOTE}）`, "");
      }
      lines.push(`数据库: ${engine.dbPath}`);
      broadcast(engine, { type: "state", recording: true, sessionId: engine.currentSessionId });
      ctx.ui.notify(lines.join("\n"), "info");
    } catch (err) {
      // 失败不留下半开的 engine（不留监听、不留 wrapper、不持库）。
      if (releaseEngine(owner, engine)) await engine.close("record-on-failed");
      ctx.ui.notify(`启动失败: ${errorText(err)}`, "error");
    }
  }

  function recordOff(ctx: ExtensionContext): void {
    const engine = ownEngine();
    if (!engine) {
      ctx.ui.notify("⏹ 录制未开启", "info");
      return;
    }
    // trampoline 保持安装，但 recording=false ⇒ wrapper 纯透传、不再铸票据；在途改写在 runRewrite 复查 recording。
    // engine 与页面保留（历史可浏览）；写后账本继续把已接纳的条目落库。
    engine.recording = false;
    broadcast(engine, { type: "state", recording: false, sessionId: engine.currentSessionId });
    ctx.ui.notify(
      engine.serverPort !== null && engine.web
        ? ["⏹ 录制已停止（历史保留，页面仍可浏览）", "", ...engine.web.accessUrls(engine.serverPort)].join("\n")
        : "⏹ 录制已停止",
      "info",
    );
  }

  async function recordStatus(ctx: ExtensionContext): Promise<void> {
    const engine = ownEngine();
    const counts: StatusCounts = {
      failure: null,
      enabledRules: null,
      totalRules: null,
      requests: null,
      messages: null,
      sessions: null,
      settings: FALLBACK_ENGINE_SETTINGS,
    };
    const dbPath = engine?.dbPath ?? opts.dbPath ?? defaultRecordPaths().dbPath;
    if (engine) {
      try {
        const db = ensureDb(engine);
        counts.enabledRules = loadEnabledRules(db).length;
        counts.settings = getEngineSettings(db);
        readCounts(db, counts);
      } catch (err) {
        counts.failure = errorText(err);
        noteDbError(engine, err);
      }
    } else {
      // 无 engine：显式查询 ⇒ 开短连接读完即关（不建容器、不装 wrapper）。
      try {
        const db = openDb(dbPath, {
          ...(opts.loadSqlite !== undefined ? { loadSqlite: opts.loadSqlite } : {}),
          ...(opts.legacyDbPath !== undefined ? { legacyDbPath: opts.legacyDbPath } : {}),
        });
        try {
          counts.enabledRules = loadEnabledRules(db).length;
          counts.settings = getEngineSettings(db);
          readCounts(db, counts);
        } finally {
          db.close();
        }
      } catch (err) {
        counts.failure = errorText(err);
      }
    }

    const jqRunner = engine?.jq ?? createJqRunner();
    const jq = await jqRunner.probe(counts.settings.jqPath || undefined);
    if (!engine) jqRunner.dispose();
    const jqLine = jq.ok
      ? `jq: ${counts.settings.jqPath || "PATH"} (${jq.version ?? "未知版本"})`
      : `jq: ${counts.settings.jqPath || "PATH"} | 未找到`;
    let dbSize = "0 KB";
    try {
      dbSize = `${(statSync(dbPath).size / 1024).toFixed(1)} KB`;
    } catch {}
    const recording = engine?.recording ?? false;
    const dbLine = counts.failure === null ? "DB: 正常" : `DB: ${counts.failure}`;
    const hasRules = counts.enabledRules !== null && counts.enabledRules > 0;
    const correlation = !recording
      ? "未生效（录制已关闭，/record on 启用改写）"
      : hasRules
        ? "票据精确归属（无法证明的请求不改写）"
        : "票据归属（无启用规则）";
    const rulesSuffix = hasRules && !recording ? "（当前未生效）" : "";
    const tap = tapSnapshot();
    const tapLine = engine?.tapLost
      ? `拦截层: tap lost（${engine.tapLostReason ?? "unknown"}）— 请 /record on 重新安装`
      : `拦截层: ${engine && tapActiveFor(engine) ? (tap.globalIsActive ? "活动（最外层）" : "活动（被其它层包裹）") : "未安装"} · 安装 ${tap.installs} 次 · 重入 ${tap.reentry}`;
    const lines = [
      `录制状态: ${recording ? "🔴 开启" : "⏹ 关闭"}`,
      `记录: ${counts.requests ?? "?"} 请求 / ${counts.messages ?? "?"} 消息 / ${counts.sessions ?? "?"} 会话`,
      `数据库: ${dbPath} (${dbSize})`,
      `改写规则: ${counts.enabledRules ?? "?"} 启用 / ${counts.totalRules ?? "?"} 总计${rulesSuffix}`,
      `关联模式: ${correlation}`,
      ...formatAttributionStatus(engine),
      `baseUrl 未知跳过: ${engine?.nullBaseUrlSkips ?? 0}`,
      tapLine,
      jqLine,
      `落库闸口丢弃: ${engine?.counters.droppedPersists ?? 0}`,
      dbLine,
      ...(engine?.unsupportedApiNotified ? ["部分 provider API 不在票据白名单，改写规则对其不生效"] : []),
      ...(counts.failure !== null ? [`DB 不可用：${counts.failure}；改写已禁用，流量放行`] : []),
      `绑定: ${engine?.serverPort != null ? `${BIND_HOST}:${engine.serverPort} (token 鉴权已启用，本机豁免)` : "未启动"}`,
      ...(engine?.serverPort != null && engine.web
        ? engine.web.accessUrls(engine.serverPort)
        : [
            engine && !engine.serviceAllowed ? `Web 页面: ${PRINT_MODE_NOTE}` : "Web 页面: 未启动（/record on 后可用）",
          ]),
    ];
    ctx.ui.notify(lines.join("\n"), counts.failure === null ? "info" : "error");
  }
}

interface HookOptions {
  role: TrafficRole;
  owner: object;
  isActive: () => boolean;
  persistRows: boolean;
}

/** hook 级行等待响应的上限与 TTL（§5.3 hook 级响应回填）。 */
const HOOK_ROW_TTL_MS = 120_000;
const MAX_HOOK_ROWS = 32;
const UNTRACKED_HEADERS_TTL_MS = 5_000;
const MAX_UNTRACKED_HEADERS = 8;

/**
 * 绑定时的规则快照：只读 engine 的**内存**快照（安全评审 #4：provider 发送路径零 DB 调用）。快照由命令路径
 * （`/record on`）同步加载一次，此后由 engine 的 unref 定时器在非发送路径刷新（engine.ts `refreshRules`）。
 */
function rulesSnapshot(engine: TrafficEngine): { rules: RewriteRule[]; settings: EngineSettings } {
  return engine.rulesSnapshot;
}

/**
 * 录制钩子（主/子会话共用）。每个钩子入口读一次 engine 并固定持有（续体绝不在 await 后重读全局），
 * 所有写进写后账本（persist.ts 的 record*），钩子从不等待 DB。turn 计数与票据 runner 按激活（闭包）隔离。
 *
 * 票据（§5.3）：headers 钩子铸造并注入 `x-pi-traffic-ticket`；payload 钩子只在本 runner 存活集合 L 恰为 {T}
 * 时绑定（或对失败过的 T 升 generation），否则写 hook 级行并记 unattributed；fetch 层凭票据认领（capture.ts）。
 */
function registerRecordingHooks(pi: ExtensionAPI, hook: HookOptions): void {
  let currentTurn = 0;
  // runner 按 engine 绑定：/record on 新建的 engine 有新台账 ⇒ 新 runner（旧票据随旧台账作废）。
  let bound: { engine: TrafficEngine; runner: TicketRunner } | null = null;
  const runnerOf = (engine: TrafficEngine): TicketRunner => {
    if (bound?.engine !== engine) bound = { engine, runner: engine.tickets.newRunner(hook.role) };
    return bound.runner;
  };

  /** 入口判定：返回固定的 engine 或 undefined（立即透传）。 */
  const enter = (ctx: ExtensionContext | undefined, needRecording: boolean): TrafficEngine | undefined => {
    if (isSecure()) return undefined;
    const engine = peekEngine();
    if (!engine || engine.state !== "open") return undefined;
    if (needRecording && !engine.recording) return undefined;
    if (!hook.isActive()) return undefined;
    if (hook.role === "host" && engine.owner === hook.owner && ctx)
      engine.notify = ctx.ui.notify.bind(ctx.ui) as NotifyFn;
    return engine;
  };

  const upsertSessionLater = (engine: TrafficEngine, ctx: ExtensionContext): void => {
    recordSql(engine, engine.epoch, UPSERT_SESSION_SQL, sessionUpsertParams(ctx), 0);
  };

  const pruneHookRows = (runner: TicketRunner, now: number): void => {
    while (runner.hookRows.length > 0 && now - runner.hookRows[0]!.createdAt >= HOOK_ROW_TTL_MS)
      runner.hookRows.shift();
    while (runner.hookRows.length > MAX_HOOK_ROWS) runner.hookRows.shift();
  };

  /** 白名单外请求的头快照：只在恰有一条（5s 内）时归给 hook 级行，否则不猜。 */
  const takeUntrackedHeaders = (runner: TicketRunner, now: number): string | null => {
    const fresh = runner.untrackedHeaders.filter((h) => now - h.at < UNTRACKED_HEADERS_TTL_MS);
    runner.untrackedHeaders.length = 0;
    return fresh.length === 1 ? fresh[0]!.json : null;
  };

  pi.on("turn_start", (event) => {
    currentTurn = event.turnIndex;
  });

  if (hook.role === "host") {
    pi.on("session_start", (_event, ctx) => {
      currentTurn = 0;
      const engine = enter(ctx, true);
      if (!engine || engine.owner !== hook.owner) return;
      engine.currentSessionId = ctx.sessionManager.getSessionId();
      upsertSessionLater(engine, ctx);
      broadcast(engine, { type: "state", recording: engine.recording, sessionId: engine.currentSessionId });
    });

    pi.on("model_select", (_event, ctx) => {
      const engine = enter(ctx, true);
      if (!engine) return;
      upsertSessionLater(engine, ctx);
    });
  } else {
    // 子会话无 session_shutdown（§5.4）：agent_settled ⇒ 丢弃本会话未配对 / 未 fetch 的票据与 hook 级行。
    pi.on("agent_settled", () => {
      const engine = peekEngine();
      if (!engine || bound?.engine !== engine) return;
      engine.tickets.discardUnfetched(bound.runner);
    });
  }

  pi.on("cache_warming_decision", () => {
    // 只观察（T5 的 warming 否决另行注册，消费 TrafficWiring.rewriteArmed）。安全评审 #3：pi 1.3 的 runner 把各 handler
    // 的返回值折叠进局部变量，不回写 event.action，扩展拿不到**最终**裁定。故任何 decision 事件都视为「可能发送 warming」：
    // - 录制归属：60s 内规则 ② 不成立（只会少退役 / 多 unattributed）；
    // - 改写（第三轮裁定 A）：warming 没有可验证的完成边界 ⇒ 本 runner 进入改写暂停，不按时间解除（ticket.ts）。
    const engine = enter(undefined, false);
    if (!engine) return undefined;
    const runner = runnerOf(engine);
    runner.warmingAllowedAt = engine.tickets.now();
    suspendRewrite(runner, engine.rewriteMarks, engine.tickets.counters);
    return undefined;
  });

  pi.on("before_provider_headers", (event, ctx) => {
    const engine = enter(ctx, true);
    if (!engine) return;
    const runner = runnerOf(engine);
    const api = ctx.model?.api ?? null;
    let snapshot: string | null = null;
    try {
      snapshot = JSON.stringify(event.headers ?? {});
    } catch {}
    // 白名单外 API / 活动 wrapper 不属于本 engine（tap lost 后未重装）⇒ 不铸票据（不让随机头到达 provider）。
    if (api === null || !TICKET_APIS.has(api) || !tapActiveFor(engine)) {
      if (snapshot !== null) {
        runner.untrackedHeaders.push({ json: snapshot, at: engine.tickets.now() });
        while (runner.untrackedHeaders.length > MAX_UNTRACKED_HEADERS) runner.untrackedHeaders.shift();
      }
      return;
    }
    const ticket = engine.tickets.mint(runner, {
      epoch: engine.epoch,
      sessionId: ctx.sessionManager.getSessionId(),
      api,
      headersSnapshot: snapshot,
    });
    (event.headers as Record<string, string | null>)[TICKET_HEADER] = ticket.id;
  });

  pi.on("before_provider_request", (event, ctx) => {
    // 入口固定 engine 与纪元；未录制 / 关闭 / 加密会话 ⇒ 不序列化 payload、不落库。钩子从不等待 DB。
    const engine = enter(ctx, true);
    if (!engine) return;
    const epoch = engine.epoch;
    const runner = runnerOf(engine);
    const counters = engine.tickets.counters;
    const sid = ctx.sessionManager.getSessionId();
    if (hook.role === "host") engine.currentSessionId = sid;
    // payload 的 JSON.stringify（1 MiB 级 2–5ms + GC）不在发送路径上做：交给账本的物化 tick（不需要锁、每 tick 预算）。
    // 本扩展在 activate 末尾注册，之后没有别的 before_provider_request 处理器改写它；SDK 只读不改。
    const payloadRef = event.payload ?? null;
    let payloadLen = 0;
    const payloadText = lazyText(() => {
      const text = JSON.stringify(payloadRef) ?? "null";
      payloadLen = text.length;
      return text;
    });
    const baseUrl = ctx.model?.baseUrl ?? null;
    const model = ctx.model?.id ?? null;
    const api = ctx.model?.api ?? null;
    const provider = ctx.model?.provider ?? null;
    const now = engine.tickets.now();
    const persistRows = hook.persistRows;
    const snapshot = rulesSnapshot(engine);
    const turn = currentTurn;
    const ts = new Date().toISOString();

    const insertRow = (requestHeaders: string | null, rewriteStatus: string | null): RowRef | null => {
      if (!persistRows) return null;
      upsertSessionLater(engine, ctx);
      return recordInsert(
        engine,
        epoch,
        "requests",
        {
          session_id: sid,
          turn,
          ts,
          provider,
          model,
          payload: payloadText,
          request_headers: requestHeaders,
          rewrite_status: rewriteStatus,
        },
        (rowId) => {
          if (rowId === null) return;
          broadcast(engine, {
            type: "request",
            id: rowId,
            session_id: sid,
            turn,
            ts,
            provider,
            model,
            status: null,
            size: payloadLen,
          });
        },
      );
    };

    if (snapshot.rules.length > 0 && baseUrl === null) {
      engine.nullBaseUrlSkips++;
      if (!engine.nullBaseUrlNotified) {
        engine.nullBaseUrlNotified = true;
        const message = "provider baseUrl 未知，已跳过改写";
        broadcast(engine, { type: "rewrite_warn", reason: "null-base-url", message });
        ctx.ui.notify(message, "warning");
      }
    }

    const whitelisted = api !== null && TICKET_APIS.has(api);
    // liveOf 先做惰性 TTL 退役（可能立墓碑），再读墓碑。
    const pairing = whitelisted ? decidePairing(engine.tickets.liveOf(runner), runner.tombstoned) : null;
    if (pairing && pairing.kind !== "unattributed") {
      const ticket = pairing.ticket;
      // 改写暂停（裁定 A）：照常绑定与录制，但本 generation 不带规则（fetch 层另有一次检查）。
      const suspended =
        snapshot.rules.length > 0 &&
        rewriteSuspended(runner, engine.rewriteMarks, snapshot.rules.length, engine.tickets.counters);
      if (suspended) counters.rewriteSuspendedRequests++;
      const rules = baseUrl === null || suspended ? [] : snapshot.rules;
      ticket.generation = {
        gen: pairing.gen,
        row: insertRow(ticket.headersSnapshot, suspended ? "suspended" : null),
        sessionId: sid,
        model,
        baseUrl,
        rules,
        settings: snapshot.settings,
        digest: null,
        rewrite: null,
        wireRecorded: false,
        streamCaptured: false,
      };
      ticket.generations = pairing.gen;
      if (pairing.kind === "bound") counters.ticketsBound++;
      else counters.generationBumps++;
      return;
    }

    // ---- hook 级行：无法证明归属（白名单内）或白名单外 API。绝不改写。----
    let rewriteStatus: string | null = null;
    let requestHeaders: string | null = null;
    if (whitelisted) {
      counters.unattributedPayloads++;
      if (pairing?.kind === "unattributed" && pairing.tombstoned) counters.tombstonedPayloads++;
      rewriteStatus = "unattributed";
    } else {
      requestHeaders = takeUntrackedHeaders(runner, now);
      if (snapshot.rules.length > 0) {
        counters.unsupportedApiPayloads++;
        if (!engine.unsupportedApiNotified) {
          engine.unsupportedApiNotified = true;
          if (api === "openai-codex-responses") engine.codexWsWarned = true;
          const message = `provider API ${api ?? "未知"} 不在票据白名单，改写规则对其不生效（只录钩子级字段）`;
          broadcast(engine, { type: "rewrite_warn", reason: "unsupported-api", message });
          ctx.ui.notify(message, "warning");
        }
      }
    }
    pruneHookRows(runner, now);
    runner.hookRows.push({ row: insertRow(requestHeaders, rewriteStatus), sessionId: sid, createdAt: now });
    pruneHookRows(runner, now);
  });

  pi.on("after_provider_response", (event, ctx) => {
    // 不要求 recording：/record off 之后仍回填已创建行（源实现语义）。
    const engine = enter(ctx, false);
    if (!engine) return;
    const runner = runnerOf(engine);
    const ledger = engine.tickets;
    const now = ledger.now();
    pruneHookRows(runner, now);
    // fetch 层已收到 2xx（规则 ① 已退役）、尚未被本钩子消费的票据。
    const awaiting: Ticket[] = [];
    for (const ticket of ledger.tickets.values()) {
      if (ticket.runner !== runner || ticket.awaitingHookSince === null) continue;
      if (now - ticket.awaitingHookSince >= TICKET_TTL.awaitingHookMs) ticket.awaitingHookSince = null;
      else awaiting.push(ticket);
    }
    const live = ledger.liveOf(runner);
    const hookRows = runner.hookRows;
    if (awaiting.length > 0 && hookRows.length === 0) {
      // 票据请求的状态已由 fetch 层精确写入；只消费最早的一个标记。
      awaiting.sort((a, b) => (a.awaitingHookSince ?? 0) - (b.awaitingHookSince ?? 0));
      awaiting[0]!.awaitingHookSince = null;
      return;
    }
    if (awaiting.length === 0 && hookRows.length === 0) {
      // tap lost：响应已到，而本 runner 已绑定的票据从未经过活动 wrapper。
      for (const ticket of live) {
        if (ticket.generation !== null && ticket.fetches === 0 && checkTapAfterResponse(engine, ticket.id)) break;
      }
      return;
    }
    if (awaiting.length === 0 && hookRows.length === 1 && live.length === 0) {
      const target = hookRows.shift()!;
      ledger.counters.hookBackfills++;
      if (!target.row) return;
      const status = event.status;
      recordPatch(
        engine,
        engine.epoch,
        target.row,
        "requests",
        { status, response_headers: JSON.stringify(event.headers ?? {}) },
        {
          onDone: (rowId) => broadcast(engine, { type: "response", id: rowId, session_id: target.sessionId, status }),
        },
      );
      return;
    }
    // 无法证明这条响应属于哪一行：不回填（不拿单一「当前行」冒充并发关联）。
    ledger.counters.unattributedResponses++;
  });

  pi.on("message_end", (event, ctx) => {
    const engine = enter(ctx, false);
    if (!engine) return;
    const msg = event.message as { role?: string };
    if (msg.role === "assistant") {
      // 规则 ②：assistant message_end ⇒ 本 runner 全部存活票据退役（前提：60s 内未放行 cache warming）。
      const runner = runnerOf(engine);
      if (engine.tickets.retireOnMessageEnd(runner) >= 0) runner.hookRows.length = 0;
    }
    if (!engine.recording || !hook.persistRows) return;
    const sid = ctx.sessionManager.getSessionId();
    if (hook.role === "host") engine.currentSessionId = sid;
    const msgStr = JSON.stringify(msg);
    const ts = new Date().toISOString();
    const turn = currentTurn;
    const role = msg.role ?? "unknown";
    recordInsert(engine, engine.epoch, "messages", { session_id: sid, turn, ts, role, message: msgStr }, (id) => {
      if (id === null) return;
      broadcast(engine, { type: "message", id, session_id: sid, turn, ts, role, size: msgStr.length });
    });
  });
}

/**
 * 唯一入口。opts 缺省 = 关 ⇒ 返回 undefined，不注册、不读盘、不建全局符号、不加载 node:sqlite。
 */
export function wireTraffic(pi: ExtensionAPI, opts: WireTrafficOptions = {}): TrafficWiring | undefined {
  if (opts.enabled !== true) return undefined;
  if (isSecure()) return undefined;
  const role: TrafficRole = opts.role ?? "host";
  const owner = opts.owner ?? {};
  const isActive = opts.isActive ?? (() => true);
  registerRecordingHooks(pi, {
    role,
    owner,
    isActive,
    persistRows: role === "host" ? true : opts.childPersist !== false,
  });
  if (role === "host") {
    registerRecordCommand(pi, { ...opts, isActive }, owner);
    pi.on("session_shutdown", async () => {
      // 任何 reason（quit/reload/new/resume/fork）：身份校验释放 + 关闭（同步撤销接纳，有界关库）。
      const engine = peekEngine();
      if (!engine || engine.owner !== owner) return;
      releaseEngine(owner, engine);
      await engine.close("session_shutdown");
    });
  }
  return {
    role,
    owner,
    engine: () => {
      const engine = peekEngine();
      return engine && engine.owner === owner ? engine : undefined;
    },
    rewriteArmed: () => {
      const engine = peekEngine();
      return !!engine && !isSecure() && engine.rewriteArmed();
    },
  };
}

export function wireTrafficHost(
  pi: ExtensionAPI,
  opts: Omit<WireTrafficOptions, "role"> = {},
): TrafficWiring | undefined {
  return wireTraffic(pi, { ...opts, role: "host" });
}

export function wireTrafficChild(
  pi: ExtensionAPI,
  opts: Omit<WireTrafficOptions, "role"> = {},
): TrafficWiring | undefined {
  return wireTraffic(pi, { ...opts, role: "child" });
}
