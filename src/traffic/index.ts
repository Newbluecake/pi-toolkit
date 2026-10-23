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
import { defaultRecordPaths, ensureDb, openDb, upsertSession, type SqliteLoader } from "./db.js";
import { makeProbe } from "./correlate.js";
import { acquireEngine, peekEngine, releaseEngine, type NotifyFn, type TrafficEngine } from "./engine.js";
import { createJqRunner } from "./jq.js";
import { PRINT_MODE_NOTE, type TrafficRole } from "./mode.js";
import { persist } from "./persist.js";
import { getEngineSettings, loadEnabledRules, type EngineSettings, type RewriteRule } from "./rewrite.js";
import { SECURE_SESSION_MESSAGE, isSecure } from "./secure.js";
import type { GateSlot } from "./serialize.js";
import { createTrafficServer } from "./server.js";
import { broadcast } from "./sse.js";
import { BIND_HOST } from "./state.js";
import { installTap, tapActiveFor, tapSnapshot } from "./tap.js";

const FALLBACK_ENGINE_SETTINGS: EngineSettings = {
  jqPath: "",
  timeoutMs: 2_000,
  handoffMs: 10_000,
  retryGraceMs: 30_000,
  maxHoldMs: 120_000,
  queueWaitMs: 60_000,
};

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

function notifyCodexWebSocket(engine: TrafficEngine): void {
  if (engine.codexWsWarned) return;
  engine.codexWsWarned = true;
  const message = "Codex WebSocket 传输绕过改写，请将 transport 设为 sse";
  broadcast(engine, { type: "rewrite_warn", message, reason: "codex-ws" });
  engine.notify?.(message, "warning");
}

function installGateDiagnostics(engine: TrafficEngine): void {
  engine.gate.setGateReleaseHandler((slot: GateSlot, reason) => {
    if (reason === "no-fetch" && slot.modelApi === "openai-codex-responses") notifyCodexWebSocket(engine);
  });
  engine.capture.setRewriteBlockedHandler((message: string) => {
    engine.notify?.(message, "error");
  });
}

function enabledRules(engine: TrafficEngine): { ok: boolean; rules: RewriteRule[]; settings: EngineSettings } {
  try {
    const db = ensureDb(engine);
    return { ok: true, rules: loadEnabledRules(db), settings: getEngineSettings(db) };
  } catch (err) {
    noteDbError(engine, err);
    return { ok: false, rules: [], settings: FALLBACK_ENGINE_SETTINGS };
  }
}

function formatGateStatus(engine: TrafficEngine | undefined): string {
  if (!engine) return "串行化: 未运行";
  const gate = engine.gate.gateStats();
  const holder = gate.holderId === null ? "无" : String(gate.holderId);
  const age = gate.holderAgeMs === null ? 0 : gate.holderAgeMs;
  return `串行化: 队列 ${gate.queueDepth} / 持有 ${holder} 已 ${age}ms / 交接超时 ${gate.gateNoFetch} · 旁路 ${gate.gateBypassed} · 上限 ${gate.gateTimeouts}`;
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
    engine.notify = ctx.ui.notify.bind(ctx.ui) as NotifyFn;
    try {
      ensureDb(engine);
      installGateDiagnostics(engine); // 幂等：只是设置回调
      engine.currentSessionId = ctx.sessionManager.getSessionId();
      engine.recording = true;
      installTap(engine, engine.capture.handleFetch);
      persist(engine, epoch, (d) => upsertSession(d, ctx));
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
    // 顺序要紧：先置位再 drain。被 drain 放行的排队者随后在 tryRewrite 复查 recording 时旁路。
    // trampoline 保持安装，但 recording=false ⇒ wrapper 纯透传；engine 与页面保留（历史可浏览）。
    engine.recording = false;
    engine.gate.drainGate("drain");
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
        ? "精确（串行化生效）"
        : "尽力而为（无启用规则）";
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
      formatGateStatus(engine),
      tapLine,
      jqLine,
      `未关联: ${engine?.unlinkedRewrites ?? 0}`,
      `baseUrl 未知跳过: ${engine?.nullBaseUrlSkips ?? 0}`,
      `落库闸口丢弃: ${engine?.counters.droppedPersists ?? 0}`,
      dbLine,
      ...(engine?.codexWsWarned ? ["Codex WebSocket 传输绕过改写，请将 transport 设为 sse"] : []),
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

/**
 * 录制钩子（主/子会话共用）。每个钩子入口读一次 engine 并固定持有（续体绝不在 await 后重读全局），
 * 所有写经 persist(engine, epoch, …)。turn 计数按激活（runner 闭包）隔离，不再是进程共享单槽。
 */
function registerRecordingHooks(pi: ExtensionAPI, hook: HookOptions): void {
  let currentTurn = 0;

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

  pi.on("turn_start", (event) => {
    currentTurn = event.turnIndex;
  });

  if (hook.role === "host") {
    pi.on("session_start", (_event, ctx) => {
      currentTurn = 0;
      const engine = enter(ctx, true);
      if (!engine || engine.owner !== hook.owner) return;
      engine.currentSessionId = ctx.sessionManager.getSessionId();
      try {
        persist(engine, engine.epoch, (d) => upsertSession(d, ctx));
      } catch (err) {
        noteDbError(engine, err);
      }
      broadcast(engine, { type: "state", recording: engine.recording, sessionId: engine.currentSessionId });
    });

    pi.on("model_select", (_event, ctx) => {
      const engine = enter(ctx, true);
      if (!engine) return;
      try {
        persist(engine, engine.epoch, (d) => upsertSession(d, ctx));
      } catch (err) {
        noteDbError(engine, err);
      }
    });
  }

  pi.on("before_provider_headers", (event, ctx) => {
    const engine = enter(ctx, true);
    if (!engine) return;
    try {
      engine.corr.stashHookHeaders(JSON.stringify(event.headers ?? {}));
    } catch (err) {
      noteDbError(engine, err);
    }
  });

  pi.on("before_provider_request", async (event, ctx) => {
    // 入口固定 engine 与纪元；未录制 / 关闭 / 加密会话 ⇒ 不序列化 payload、不入闸门、不落库。
    const engine = enter(ctx, true);
    if (!engine) return;
    const epoch = engine.epoch;
    const sid = ctx.sessionManager.getSessionId();
    if (hook.role === "host") engine.currentSessionId = sid;
    const payloadStr = JSON.stringify(event.payload ?? null) ?? "null";
    const baseUrl = ctx.model?.baseUrl ?? null;
    const model = ctx.model?.id ?? null;
    const { ok, rules, settings } = enabledRules(engine);
    let slot: GateSlot | null = null;

    if (rules.length > 0 && baseUrl === null) {
      engine.nullBaseUrlSkips++;
      if (!engine.nullBaseUrlNotified) {
        engine.nullBaseUrlNotified = true;
        const message = "provider baseUrl 未知，已跳过改写";
        broadcast(engine, { type: "rewrite_warn", reason: "null-base-url", message });
        ctx.ui.notify(message, "warning");
      }
    }

    if (ok && rules.length > 0 && baseUrl !== null) {
      try {
        slot = await engine.gate.acquireSlot(
          { sessionId: sid, baseUrl, model, modelApi: ctx.model?.api ?? null, rules, settings },
          "hook",
        );
      } catch (err) {
        noteDbError(engine, err);
        if (slot !== null) engine.gate.releaseSlot(slot, "failed");
        slot = null;
      }
    }

    const entry = {
      rowId: null as number | null,
      sessionId: sid,
      baseUrl,
      model,
      payloadLen: payloadStr.length,
      probe: makeProbe(payloadStr),
      debugProbe: null,
      createdAt: Date.now(),
      status: "waiting" as const,
      claimedBy: [] as number[],
      streamCaptured: false,
      slot,
      hookHeaders: engine.corr.takeHookHeaders(),
    };

    try {
      if (hook.persistRows && engine.recording) {
        const ts = new Date().toISOString();
        const turn = currentTurn;
        const rowId = persist(engine, epoch, (d) => {
          const sessionId = upsertSession(d, ctx);
          const result = d
            .prepare(
              "INSERT INTO requests (session_id, turn, ts, provider, model, payload, request_headers) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run(sessionId, turn, ts, ctx.model?.provider ?? null, model, payloadStr, entry.hookHeaders);
          return Number(result.lastInsertRowid);
        });
        if (rowId !== undefined) {
          entry.rowId = rowId;
          broadcast(engine, {
            type: "request",
            id: rowId,
            session_id: sid,
            turn,
            ts,
            provider: ctx.model?.provider ?? null,
            model,
            status: null,
            size: payloadStr.length,
          });
        }
      }
    } catch (err) {
      noteDbError(engine, err);
      if (slot !== null) {
        engine.gate.releaseSlot(slot, "failed");
        entry.slot = null;
      }
    }

    engine.corr.pushPending(entry);
    if (entry.slot !== null) entry.slot.pending = entry;
  });

  pi.on("after_provider_response", (event, ctx) => {
    // 不要求 recording：/record off 之后仍回填已创建行（源实现语义）。
    const engine = enter(ctx, false);
    if (!engine) return;
    try {
      const attempt = engine.corr.matchAfter(event.status, event.headers ?? {});
      if (!attempt || attempt.rowId === null) return;
      const rowId = attempt.rowId;
      const written = persist(engine, engine.epoch, (d) =>
        d
          .prepare("UPDATE requests SET status = ?, response_headers = ? WHERE id = ?")
          .run(event.status, JSON.stringify(event.headers ?? {}), rowId),
      );
      if (written === undefined) return;
      broadcast(engine, {
        type: "response",
        id: rowId,
        session_id: attempt.pending?.sessionId ?? null,
        status: event.status,
      });
    } catch (err) {
      noteDbError(engine, err);
    }
  });

  pi.on("message_end", (event, ctx) => {
    const engine = enter(ctx, true);
    if (!engine || !hook.persistRows) return;
    try {
      const sid = ctx.sessionManager.getSessionId();
      if (hook.role === "host") engine.currentSessionId = sid;
      const msg = event.message as { role?: string };
      const msgStr = JSON.stringify(msg);
      const ts = new Date().toISOString();
      const turn = currentTurn;
      const id = persist(engine, engine.epoch, (d) =>
        Number(
          d
            .prepare("INSERT INTO messages (session_id, turn, ts, role, message) VALUES (?, ?, ?, ?, ?)")
            .run(sid, turn, ts, msg.role ?? "unknown", msgStr).lastInsertRowid,
        ),
      );
      if (id === undefined) return;
      broadcast(engine, {
        type: "message",
        id,
        session_id: sid,
        turn,
        ts,
        role: msg.role ?? "unknown",
        size: msgStr.length,
      });
    } catch (err) {
      noteDbError(engine, err);
    }
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
