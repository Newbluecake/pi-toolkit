/**
 * traffic 录制——面向 pi 的唯一装配（T2a：进程容器 / engine 生命周期 / trampoline / 模式门禁）。
 *
 * 入口 `wireTraffic(pi, opts)`：**opts 缺省 = 关** ⇒ 立即返回，零注册、零 IO、零全局符号、不加载 node:sqlite。
 * T3 的 `assembleTrafficHost` / `assembleTrafficChild` 从 settings 读 `traffic.*` 后调用（主会话在 activate
 * 末尾、子会话在 guard 前），并接入认领协议（`isActive` 端口 = claim 存活）。
 *
 * - host（主会话）：注册 `/record on|off|status`、钩子与 `session_shutdown`。engine 只在 `/record on`
 *   时创建（`acquireEngine(owner)`）；`/record status` 无 engine 时开短连接读计数后即关（不建容器）。
 *   网页服务 / 重放只在 `ctx.mode ∈ {tui, rpc}` 时随 `/record on` 启动（§4.1），print/json 只录制并在回复注明。
 *   `session_shutdown`（任何 reason）⇒ 身份校验释放 + `engine.close()`（同步撤销接纳，有界关库）。
 * - child（子会话）：只注册录制钩子；每个钩子入口读一次全局 engine 并固定持有；engine 不存在 / 非 open /
 *   未录制 / `isActive()` 为假 / **会话槽准入被拒**（安全评审 #1：同一 AgentSession 的重复 toolkit 副本）
 *   ⇒ 立即 return（不 stringify、不做任何事）。子会话无命令、无服务、无重放。
 * - 所有钩子恒返回 `undefined`（不改 payload / headers）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TrafficSettings, TrafficWebSettings } from "../config/settings.js";
import { statSync } from "node:fs";
import {
  externalActiveInProcess,
  publishToolkitClaim,
  releaseToolkitClaim,
  claimIsOurs,
  toolkitClaimIsLive,
  type ToolkitTrafficClaim,
} from "./claim.js";
import {
  defaultAgentDir,
  findExternalRecorderCommand,
  formatDupWarning,
  scanExternalTrafficReferences,
  TOOLKIT_PACKAGE_ROOT,
  type DupDetectFs,
} from "./dup-detect.js";
// T5（§7.3）：keepalive 否决端口 + pi 原生 warming 否决（两模块均零重依赖、零顶层副作用）。
import { createTrafficKeepalivePort, registerTrafficKeepalivePort } from "./keepalive-port.js";
import { registerWarmingVeto, type WarmingVetoHandle } from "./warming.js";
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
  /** 认领协议端口（T3：claim 属于 toolkit 且存活）。缺省恒 true。 */
  isActive?: () => boolean;
  /** 子会话请求是否落库（T3：`traffic.childSessions`，缺省 true）。 */
  childPersist?: boolean;
  /** `traffic.web.*`（T3）：host 传入 server；`"0.0.0.0"` 时 on/status 附明文 HTTP 风险提示。 */
  web?: TrafficWebSettings;
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

/** HUD/TUI 状态键（§7.5）：录制中 `rec`，有丢弃时 `rec·drop N`；停止/关闭清除。 */
const TRAFFIC_STATUS_KEY = "pi-subagent:traffic";
const STATUS_TICK_MS = 2_000;

/** §2.2（拍板②）：`traffic.web.host="0.0.0.0"` 时 /record on 与 status 的额外风险提示。 */
export const LAN_PLAINTEXT_WARNING =
  "明文 HTTP：token、请求正文与 API key 可被同网段嗅探（web.host=0.0.0.0，建议保持 127.0.0.1）";

interface StatusUi {
  setStatus?: (key: string, text: string | undefined) => void;
}

// ── 安全评审 #1（Major）：每个 AgentSession 只允许一套 traffic 录制钩子 ──
//
// 同一 AgentSession 可能加载两份 toolkit 副本（settings 同时列 git 安装与本地路径）：第一份认领
// HOST_KEY 装配 host，第二份仅凭 HOST_KEY 存在被误判为 child，在 guard 前注册第二套录制钩子——
// HOST_KEY 只能区分「首个激活与否」，不能区分「重复宿主副本」与「真子会话」（真子会话是
// PiSessionDriver.create 在同进程新建的另一个 AgentSession，有自己的 sessionManager）。故按
// **实际会话身份**（ctx.sessionManager 对象）做进程级唯一接纳：首个拿到 engine 的激活认领会话槽，
// 同会话的其它副本永久惰性（不铸票据不落库）；跨会话互不影响（WeakMap 键为各会话的
// sessionManager 对象，子会话结束随 GC 回收）。host 在 session_shutdown 身份校验释放（/reload
// 后新激活可重新认领）；激活顺序保证 host 先注册 ⇒ 先认领（激活序 = 注册序 = 派发序）。

const SESSION_SLOT_KEY = Symbol.for("pi-subagent:traffic-session-slot");
type SessionSlots = WeakMap<object, object>;

function sessionSlots(): SessionSlots {
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[SESSION_SLOT_KEY] as SessionSlots | undefined;
  if (existing instanceof WeakMap) return existing;
  const created: SessionSlots = new WeakMap();
  g[SESSION_SLOT_KEY] = created;
  return created;
}

/** 会话槽值 = 认领激活的 owner 对象（身份校验释放：仅本人可删）。 */
function claimSessionSlot(sessionManager: object, token: object): boolean {
  const slots = sessionSlots();
  if (slots.has(sessionManager)) return false;
  slots.set(sessionManager, token);
  return true;
}

function releaseSessionSlot(sessionManager: object, token: object): void {
  const slots = sessionSlots();
  if (slots.get(sessionManager) === token) slots.delete(sessionManager);
}

/** 仅测试：清除会话槽表（不影响 engine/tap/claim）。 */
export function resetTrafficSessionSlotsForTest(): void {
  delete (globalThis as Record<symbol, unknown>)[SESSION_SLOT_KEY];
}

/**
 * HUD 状态行控制器（§7.5）：状态全在闭包；`refresh()` 读当前 engine（发送者提供 getter）重画；
 * 录制中后动 unref 的 2s tick（丢计数可见），停止/关闭即停。`setStatus` 缺席（print/rpc 无 TUI）⇒ 静默。
 */
function createTrafficStatus(engineOf: () => TrafficEngine | undefined): {
  noteCtx: (ui: StatusUi | undefined) => void;
  refresh: () => void;
  clear: () => void;
} {
  let ui: StatusUi | undefined;
  let timer: ReturnType<typeof setInterval> | null = null;
  const render = (): string | undefined => {
    const engine = engineOf();
    if (!engine || engine.state !== "open" || !engine.recording) return undefined;
    const dropped = engine.dbPort.stats().droppedRows;
    return dropped > 0 ? `rec·drop ${dropped}` : "rec";
  };
  const push = (): void => {
    try {
      ui?.setStatus?.(TRAFFIC_STATUS_KEY, render());
    } catch {
      /* 展示-only */
    }
  };
  const stopTick = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  return {
    noteCtx: (next) => {
      if (next?.setStatus) ui = next;
    },
    refresh: () => {
      const engine = engineOf();
      const recording = engine !== undefined && engine.state === "open" && engine.recording;
      if (!recording) stopTick();
      else if (timer === null) {
        timer = setInterval(push, STATUS_TICK_MS);
        timer.unref?.();
      }
      push();
    },
    clear: () => {
      stopTick();
      try {
        ui?.setStatus?.(TRAFFIC_STATUS_KEY, undefined);
      } catch {
        /* 展示-only */
      }
    },
  };
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
  status: { noteCtx: (ui: StatusUi | undefined) => void; refresh: () => void },
): void {
  const ownEngine = (): TrafficEngine | undefined => {
    const engine = peekEngine();
    return engine && engine.owner === owner && engine.state === "open" ? engine : undefined;
  };

  pi.registerCommand("record", {
    description:
      '流量录制: /record on|off|status — 记录模型输入输出到 SQLite，Web 默认仅限 127.0.0.1（局域网需 traffic.web.host="0.0.0.0"）',
    getArgumentCompletions: (prefix) =>
      [
        {
          value: "on",
          label: "on",
          description: '开始录制 + 启动 Web 查看页（默认 127.0.0.1；局域网需 traffic.web.host="0.0.0.0"）',
        },
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
        // 让位（外部 pi-traffic-record 实际加载/活动）或本激活已随会话切换结束（claim 已释放，拍板⑤）。
        ctx.ui.notify(
          "traffic 录制未生效：已让位给外部 pi-traffic-record，或本激活已随会话切换/关闭结束（/reload 后重开）",
          "warning",
        );
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
        engine.web ??= createTrafficServer(engine, {
          host: opts.web?.host ?? "127.0.0.1",
          ...(opts.web?.port !== undefined ? { port: opts.web.port } : {}),
        });
        const port = await engine.web.startServer();
        lines.push("Web 查看页:", ...engine.web.accessUrls(port), "");
        if (opts.web?.host === "0.0.0.0") lines.push(LAN_PLAINTEXT_WARNING, "");
      } else {
        lines.push(`（${PRINT_MODE_NOTE}）`, "");
      }
      lines.push(`数据库: ${engine.dbPath}`);
      broadcast(engine, { type: "state", recording: true, sessionId: engine.currentSessionId });
      status.noteCtx(ctx.ui as StatusUi | undefined);
      status.refresh();
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
    status.noteCtx(ctx.ui as StatusUi | undefined);
    status.refresh();
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
        ? [
            ...engine.web.accessUrls(engine.serverPort),
            ...(opts.web?.host === "0.0.0.0" ? [LAN_PLAINTEXT_WARNING] : []),
          ]
        : [
            engine && !engine.serviceAllowed ? `Web 页面: ${PRINT_MODE_NOTE}` : "Web 页面: 未启动（/record on 后可用）",
          ]),
      ...(opts.web?.host === "0.0.0.0" && engine?.serverPort == null ? [LAN_PLAINTEXT_WARNING] : []),
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
function registerRecordingHooks(pi: ExtensionAPI, hook: HookOptions): () => void {
  let currentTurn = 0;
  // runner 按 engine 绑定：/record on 新建的 engine 有新台账 ⇒ 新 runner（旧票据随旧台账作废）。
  let bound: { engine: TrafficEngine; runner: TicketRunner } | null = null;
  const runnerOf = (engine: TrafficEngine): TicketRunner => {
    if (bound?.engine !== engine) bound = { engine, runner: engine.tickets.newRunner(hook.role) };
    return bound.runner;
  };

  /**
   * 安全评审 #1：按实际会话身份的唯一接纳。ctx 无 sessionManager（cache_warming_decision
   * 观察器等无 ctx 路径）⇒ 不占槽也不拒绝（其操作只作用于本激活自己的 runner，无害重复）。
   * 每次直接查/占 WeakMap（微秒级），不缓存结果——多会话/重生成都正确；本激活占过的槽记入
   * claimedSlots 供 disposer 身份校验释放（一个激活实际只会服务一个会话，集合为防御性多记）。
   */
  const claimedSlots = new Set<object>();
  const admit = (ctx: ExtensionContext | undefined): boolean => {
    const sm = ctx?.sessionManager;
    if (sm === undefined || sm === null) return true;
    const slots = sessionSlots();
    const holder = slots.get(sm);
    if (holder === undefined) {
      slots.set(sm, hook.owner);
      claimedSlots.add(sm);
      return true;
    }
    return holder === hook.owner;
  };

  /** 入口判定：返回固定的 engine 或 undefined（立即透传）。 */
  const enter = (ctx: ExtensionContext | undefined, needRecording: boolean): TrafficEngine | undefined => {
    if (isSecure()) return undefined;
    const engine = peekEngine();
    if (!engine || engine.state !== "open") return undefined;
    if (needRecording && !engine.recording) return undefined;
    if (!hook.isActive()) return undefined;
    if (!admit(ctx)) return undefined;
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

  // 安全评审 #1：释放本激活认领的会话槽（仅槽值 === 本激活 owner 时删；身份校验，/reload 安全）。
  // host 由 wireTraffic 的 session_shutdown 调用；child 无 shutdown，靠 sessionManager GC 回收。
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const sm of claimedSlots) releaseSessionSlot(sm, hook.owner);
    claimedSlots.clear();
  };
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
  const releaseRecordingSlots = registerRecordingHooks(pi, {
    role,
    owner,
    isActive,
    persistRows: role === "host" ? true : opts.childPersist !== false,
  });
  if (role === "host") {
    const status = createTrafficStatus(() => {
      const engine = peekEngine();
      return engine && engine.owner === owner ? engine : undefined;
    });
    registerRecordCommand(pi, { ...opts, isActive }, owner, status);
    pi.on("session_shutdown", async () => {
      // 任何 reason（quit/reload/new/resume/fork）：身份校验释放 + 关闭（同步撤销接纳，有界关库）
      // + 会话槽释放（评审 #1：/reload 后新激活可重新认领本会话）。
      status.clear();
      releaseRecordingSlots();
      const engine = peekEngine();
      if (!engine || engine.owner !== owner) return;
      releaseEngine(owner, engine);
      await engine.close("session_shutdown");
    });
  } else {
    // 子会话无 shutdown：disposer 不接线，会话槽随子会话 sessionManager GC 回收（WeakMap 键）。
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

// ── T3 装配（traffic-merge plan §2.3/§2.4/§6/§7）：settings → wire + 认领协议 + 复核 + 告警 ──

export interface AssembleTrafficOptions {
  /** settings.traffic 组。`enabled !== true` ⇒ 零注册零 IO（冻结面）。 */
  settings: TrafficSettings;
  /** dup-detect 的项目级扫描目录；缺省 process.cwd()。 */
  cwd?: string;
  /** getCommands 判定的 toolkit 包根；缺省未模块位置推导。 */
  packageRoot?: string;
  /** dup-detect 的 agentDir；缺省 `$PI_CODING_AGENT_DIR` else `~/.pi/agent`。 */
  agentDir?: string;
  /** 测试注入的只读 fs。 */
  fs?: DupDetectFs;
}

const EXTERNAL_ACTIVE_MESSAGE =
  "pi-traffic-record 已在运行，toolkit traffic 让位；请从 settings.json 移除该 package 后重启 pi";

function notifyOnce(pi: ExtensionAPI, message: string, level: "info" | "warning"): void {
  let done = false;
  pi.on("session_start", (_event, ctx) => {
    if (done) return;
    done = true;
    try {
      ctx?.ui?.notify?.(message, level);
    } catch {
      /* 展示-only */
    }
  });
}

/**
 * 主会话装配（activate 末尾、cache-ttl 之后调用；§2.3）。
 *
 * 1. `enabled !== true` 或加密域 ⇒ 零注册零全局符号（settings 层已强制，这里双保险）。
 * 2. 外部墓碑版已在本进程活动（`external-active`）⇒ **不发布 claim、不注册任何命令/钩子**，
 *    session_start notify 一次让位说明（§2.4 步骤 1）。
 * 3. 否则发布 claim（token === wire 的 owner 同一对象）、注册 `/record` 与钩子；
 *    settings 扫描（dup-detect）只产出告警文案（步骤 2，永不让位）。
 * 4. session_start 复核（权威证据，步骤 3）：getCommands 里存在包根外的 `/record(:\d+)?` ⇒
 *    身份校验释放 claim（钩子/命令立即失效）、notify 一次。
 * 5. session_shutdown（任何 reason）：释放 claim（拍板⑤的认领面；engine 关闭在 wire 内部）。
 */
export function assembleTrafficHost(pi: ExtensionAPI, opts: AssembleTrafficOptions): TrafficWiring | undefined {
  if (opts.settings.enabled !== true) return undefined;
  if (isSecure()) return undefined;
  if (externalActiveInProcess()) {
    notifyOnce(pi, EXTERNAL_ACTIVE_MESSAGE, "warning");
    return undefined;
  }
  const owner: object = {};
  const claim: ToolkitTrafficClaim = publishToolkitClaim(owner);
  const dupFindings = scanExternalTrafficReferences({
    ...(opts.agentDir !== undefined ? { agentDir: opts.agentDir } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.fs !== undefined ? { fs: opts.fs } : {}),
  });
  const wiring = wireTrafficHost(pi, {
    enabled: true,
    owner,
    // 评审 #4：主会话 isActive 绑定自身 claim 对象身份（claimIsOurs），不只问进程内是否有 claim。
    isActive: () => claimIsOurs(claim),
    web: opts.settings.web,
  });
  if (!wiring) {
    // 不可达防御（isSecure 已查，wireTraffic 自身也复查）：不留半装配的 claim。
    releaseToolkitClaim(claim);
    return undefined;
  }
  // T5（§7.3，主会话装配；子会话同进程共享，无需重复注册）：keepalive 否决端口（进程级符号，
  // capture.ts 出站边界写入镜像标记，engine 关闭/重载后旧 capture 仍被否决）；身份校验注销。
  const unregisterKeepalivePort = registerTrafficKeepalivePort(
    createTrafficKeepalivePort(() => peekEngine(), { isSecure: () => isSecure() }),
  );
  // T5（裁定 A2）：规则启用时否决 pi 原生 cache warming（traffic 自己的观察器仍 fail-closed 暂停改写）。
  const warmingVeto: WarmingVetoHandle = registerWarmingVeto(pi, {
    rewriteArmed: () => wiring.rewriteArmed(),
  });
  let warnedDup = false;
  let yielded = false;
  pi.on("session_start", (_event, ctx) => {
    if (yielded) return;
    // 步骤 3：权威证据复核（所有扩展 activate 完成后才会 fire，两种加载顺序都覆盖）。
    const external =
      typeof pi.getCommands === "function"
        ? findExternalRecorderCommand(pi.getCommands(), opts.packageRoot ?? TOOLKIT_PACKAGE_ROOT)
        : undefined;
    if (external) {
      yielded = true;
      releaseToolkitClaim(claim);
      try {
        ctx?.ui?.notify?.(
          `检测到外部录制器已加载（${external.path ?? external.name}），toolkit traffic 已让位；` +
            "请从 settings.json 移除后重启 pi",
          "warning",
        );
      } catch {
        /* 展示-only */
      }
      return;
    }
    if (!warnedDup && dupFindings.length > 0) {
      warnedDup = true;
      try {
        ctx?.ui?.notify?.(formatDupWarning(dupFindings), "warning");
      } catch {
        /* 展示-only */
      }
    }
  });
  pi.on("session_shutdown", () => {
    releaseToolkitClaim(claim);
    unregisterKeepalivePort();
    warmingVeto.dispose();
  });
  return wiring;
}

/**
 * 子会话装配（guard 前调用；§2.3）：只注册录制钩子（含 `agent_settled`/`cache_warming_decision`），
 * 无命令、无服务、无重放。`isActive` = 进程内 toolkit claim 存活（主会话发布；让位/关闭后立即惰性）。
 * `childSessions=false` 只禁落库，不禁改写归属（拍板①）。
 */
export function assembleTrafficChild(pi: ExtensionAPI, opts: AssembleTrafficOptions): TrafficWiring | undefined {
  if (opts.settings.enabled !== true) return undefined;
  if (isSecure()) return undefined;
  const wiring = wireTrafficChild(pi, {
    enabled: true,
    isActive: toolkitClaimIsLive,
    childPersist: opts.settings.childSessions,
  });
  if (!wiring) return undefined;
  // T5（裁定 A2）：每个 AgentSession 有自己的 cache warmer ⇒ 子会话装配也各注册一次；
  // 子会话无 session_shutdown，不 dispose 也只留下一个恒返回 undefined 的惰性处理器（随子会话销毁）。
  registerWarmingVeto(pi, { rewriteArmed: () => wiring.rewriteArmed() });
  return wiring;
}
