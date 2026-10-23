/**
 * Traffic Record — pi 流量录制与数据集收集扩展
 *
 * /record on|off|status 控制录制与 Web 查看页；改写引擎按录制开关门控（录制关 = 完全不介入，含重放）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { patchFetch, setRewriteBlockedHandler, unpatchFetch } from "./capture.js";
import { ensureDb, upsertSession } from "./db.js";
import {
  makeProbe,
  matchAfter,
  pushPending,
  resetCorrelation,
  stashHookHeaders,
  takeHookHeaders,
} from "./correlate.js";
import { probeJq, resetJqEngine, shutdownJq } from "./jq.js";
import { acquireSlot, drainGate, gateStats, releaseSlot, setGateReleaseHandler, type GateSlot } from "./serialize.js";
import { getEngineSettings, loadEnabledRules, type EngineSettings, type RewriteRule } from "./rewrite.js";
import { accessUrls, startServer } from "./server.js";
import { broadcast } from "./sse.js";
import { state } from "./state.js";

const FALLBACK_ENGINE_SETTINGS: EngineSettings = {
  jqPath: "",
  timeoutMs: 2_000,
  handoffMs: 10_000,
  retryGraceMs: 30_000,
  maxHoldMs: 120_000,
  queueWaitMs: 60_000,
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function noteDbError(err: unknown): void {
  const message = errorText(err);
  state.dbError = message;
  if (!state.dbErrorNotified) {
    state.dbErrorNotified = true;
    broadcast({ type: "record_warn", message: `数据库错误，改写持久化已禁用: ${message}` });
  }
}

function notifyCodexWebSocket(): void {
  if (state.codexWsWarned) return;
  state.codexWsWarned = true;
  const message = "Codex WebSocket 传输绕过改写，请将 transport 设为 sse";
  broadcast({ type: "rewrite_warn", message, reason: "codex-ws" });
  lastUiNotify?.(message, "warning");
}

let lastUiNotify: ((message: string, type?: "info" | "warning" | "error") => void) | null = null;

function installGateDiagnostics(): void {
  setGateReleaseHandler((slot: GateSlot, reason) => {
    if (reason === "no-fetch" && slot.modelApi === "openai-codex-responses") notifyCodexWebSocket();
  });
  setRewriteBlockedHandler((message: string) => {
    lastUiNotify?.(message, "error");
  });
}

function safeRules(): { db: ReturnType<typeof ensureDb> | null; rules: RewriteRule[] } {
  try {
    const db = ensureDb();
    return { db, rules: loadEnabledRules(db) };
  } catch (err) {
    noteDbError(err);
    return { db: null, rules: [] };
  }
}

function formatGateStatus(): string {
  const gate = gateStats();
  const holder = gate.holderId === null ? "无" : String(gate.holderId);
  const age = gate.holderAgeMs === null ? 0 : gate.holderAgeMs;
  return `串行化: 队列 ${gate.queueDepth} / 持有 ${holder} 已 ${age}ms / 交接超时 ${gate.gateNoFetch} · 旁路 ${gate.gateBypassed} · 上限 ${gate.gateTimeouts}`;
}

import { SECURE_SESSION_MESSAGE, isSecureSession } from "./secure.js";

function registerRecordCommand(pi: ExtensionAPI): void {
  pi.registerCommand("record", {
    description: "流量录制: /record on|off|status — 记录模型输入输出到 SQLite，Web 页面实时查看（支持局域网）",
    getArgumentCompletions: (prefix) =>
      [
        { value: "on", label: "on", description: "开始录制 + 启动 Web 查看页（本机 + 局域网）" },
        { value: "off", label: "off", description: "停止录制（历史保留，页面仍可浏览）" },
        { value: "status", label: "status", description: "查看录制状态、统计与访问 URL" },
      ].filter((item) => item.value.startsWith(prefix)),
    handler: async (args, ctx) => {
      lastUiNotify = ctx.ui.notify;
      const sub = args.trim().toLowerCase().split(/\s+/).filter(Boolean)[0] || "status";

      if (isSecureSession()) {
        ctx.ui.notify(SECURE_SESSION_MESSAGE, sub === "off" ? "info" : "warning");
        return;
      }

      if (sub === "on") {
        try {
          ensureDb();
          state.recording = true;
          upsertSession(ctx);
          const port = await startServer();
          broadcast({ type: "state", recording: true, sessionId: state.currentSessionId });
          ctx.ui.notify(
            ["🔴 流量录制已开启", "", "Web 查看页:", ...accessUrls(port), "", `数据库: ${state.dbPath}`].join("\n"),
            "info",
          );
        } catch (err) {
          state.recording = false;
          ctx.ui.notify(`启动失败: ${err}`, "error");
        }
        return;
      }

      if (sub === "off") {
        // 顺序要紧：先置位再 drain。被 drain 放行的排队者随后在 tryRewrite 复查 recording 时旁路，
        // 反序会让它们带着非空 rules 快照继续改写（degraded slot 不清 rules）。
        state.recording = false;
        drainGate("drain");
        broadcast({ type: "state", recording: false, sessionId: state.currentSessionId });
        ctx.ui.notify(
          state.serverPort !== null
            ? ["⏹ 录制已停止（历史保留，页面仍可浏览）", "", ...accessUrls(state.serverPort)].join("\n")
            : "⏹ 录制已停止",
          "info",
        );
        return;
      }

      if (sub === "status") {
        let db: ReturnType<typeof ensureDb> | null = null;
        let dbFailure: string | null = null;
        let enabledRules: number | null = null;
        let totalRules: number | null = null;
        let requestCount: number | null = null;
        let messageCount: number | null = null;
        let sessionCount: number | null = null;
        let settings = FALLBACK_ENGINE_SETTINGS;
        try {
          db = ensureDb();
        } catch (err) {
          dbFailure = errorText(err);
          noteDbError(err);
        }

        if (db) {
          try {
            enabledRules = loadEnabledRules(db).length;
          } catch (err) {
            dbFailure = errorText(err);
            noteDbError(err);
          }
          try {
            totalRules = (db.prepare("SELECT COUNT(*) c FROM rewrite_rules").get() as { c: number }).c;
          } catch (err) {
            dbFailure = errorText(err);
            noteDbError(err);
          }
          try {
            requestCount = (db.prepare("SELECT COUNT(*) c FROM requests").get() as { c: number }).c;
          } catch (err) {
            dbFailure = errorText(err);
            noteDbError(err);
          }
          try {
            messageCount = (db.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number }).c;
          } catch (err) {
            dbFailure = errorText(err);
            noteDbError(err);
          }
          try {
            sessionCount = (db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c;
          } catch (err) {
            dbFailure = errorText(err);
            noteDbError(err);
          }
          try {
            settings = getEngineSettings(db);
          } catch (err) {
            dbFailure = errorText(err);
            noteDbError(err);
          }
        }

        const jq = await probeJq(settings.jqPath || undefined);
        const jqLine = jq.ok
          ? `jq: ${settings.jqPath || "PATH"} (${jq.version ?? "未知版本"})`
          : `jq: ${settings.jqPath || "PATH"} | 未找到`;
        let dbSize = "0 KB";
        try {
          dbSize = `${(statSync(state.dbPath).size / 1024).toFixed(1)} KB`;
        } catch {}
        const dbLine = dbFailure === null ? "DB: 正常" : `DB: ${dbFailure}`;
        const hasRules = enabledRules !== null && enabledRules > 0;
        // 录制关闭 = 改写引擎停机，不能再报「精确（串行化生效）」误导用户。
        const correlation = !state.recording
          ? "未生效（录制已关闭，/record on 启用改写）"
          : hasRules
            ? "精确（串行化生效）"
            : "尽力而为（无启用规则）";
        const rulesSuffix = hasRules && !state.recording ? "（当前未生效）" : "";
        const lines = [
          `录制状态: ${state.recording ? "🔴 开启" : "⏹ 关闭"}`,
          `记录: ${requestCount ?? "?"} 请求 / ${messageCount ?? "?"} 消息 / ${sessionCount ?? "?"} 会话`,
          `数据库: ${state.dbPath} (${dbSize})`,
          `改写规则: ${enabledRules ?? "?"} 启用 / ${totalRules ?? "?"} 总计${rulesSuffix}`,
          `关联模式: ${correlation}`,
          formatGateStatus(),
          jqLine,
          `未关联: ${state.unlinkedRewrites}`,
          `baseUrl 未知跳过: ${state.nullBaseUrlSkips}`,
          dbLine,
          ...(state.codexWsWarned ? ["Codex WebSocket 传输绕过改写，请将 transport 设为 sse"] : []),
          ...(dbFailure !== null ? [`DB 不可用：${dbFailure}；改写已禁用，流量放行`] : []),
          `绑定: ${state.serverPort !== null ? `0.0.0.0:${state.serverPort} (token 鉴权已启用，本机豁免)` : "未启动"}`,
          ...(state.serverPort !== null ? accessUrls(state.serverPort) : ["Web 页面: 未启动（/record on 后可用）"]),
        ];
        ctx.ui.notify(lines.join("\n"), dbFailure === null ? "info" : "error");
        return;
      }

      ctx.ui.notify("用法: /record on | /record off | /record status", "warning");
    },
  });
}

/** 注册钩子，导出供钩子层测试直接调用。 */
export function registerTrafficRecordHandlers(pi: ExtensionAPI): void {
  installGateDiagnostics();

  pi.on("session_start", (_event, ctx) => {
    resetJqEngine();
    lastUiNotify = ctx.ui.notify;
    state.currentTurn = 0;
    resetCorrelation();
    drainGate("drain");
    state.currentSessionId = ctx.sessionManager.getSessionId();
    if (isSecureSession() || !state.recording) return;
    try {
      upsertSession(ctx);
    } catch (err) {
      noteDbError(err);
    }
    broadcast({ type: "state", recording: state.recording, sessionId: state.currentSessionId });
  });

  pi.on("model_select", (_event, ctx) => {
    lastUiNotify = ctx.ui.notify;
    if (isSecureSession() || !state.recording) return;
    try {
      upsertSession(ctx);
    } catch (err) {
      noteDbError(err);
    }
  });

  pi.on("turn_start", (event) => {
    state.currentTurn = event.turnIndex;
  });

  pi.on("before_provider_headers", (event, ctx) => {
    lastUiNotify = ctx.ui.notify;
    if (isSecureSession()) return;
    try {
      stashHookHeaders(JSON.stringify(event.headers ?? {}));
    } catch (err) {
      noteDbError(err);
    }
  });

  pi.on("before_provider_request", async (event, ctx) => {
    lastUiNotify = ctx.ui.notify;
    // 加密会话：不序列化 payload、不入队、不取 slot、不落库。
    if (isSecureSession()) return;
    const sid = ctx.sessionManager.getSessionId();
    state.currentSessionId = sid;
    const payloadStr = JSON.stringify(event.payload ?? null) ?? "null";
    const baseUrl = ctx.model?.baseUrl ?? null;
    const model = ctx.model?.id ?? null;
    // 录制关闭 = 改写引擎停机：视为零规则，连 loadEnabledRules 的 SELECT 都不执行。
    const { db, rules } = state.recording ? safeRules() : { db: null, rules: [] as RewriteRule[] };
    let slot: GateSlot | null = null;
    let settings = FALLBACK_ENGINE_SETTINGS;

    if (rules.length > 0 && baseUrl === null) {
      state.nullBaseUrlSkips++;
      if (!state.nullBaseUrlNotified) {
        state.nullBaseUrlNotified = true;
        const message = "provider baseUrl 未知，已跳过改写";
        broadcast({ type: "rewrite_warn", reason: "null-base-url", message });
        ctx.ui.notify(message, "warning");
      }
    }

    if (rules.length > 0 && baseUrl !== null && db !== null) {
      try {
        settings = getEngineSettings(db);
        slot = await acquireSlot(
          {
            sessionId: sid,
            baseUrl,
            model,
            modelApi: ctx.model?.api ?? null,
            rules,
            settings,
          },
          "hook",
        );
      } catch (err) {
        noteDbError(err);
        if (slot !== null) releaseSlot(slot, "failed");
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
      hookHeaders: takeHookHeaders(),
    };

    try {
      if (state.recording) {
        const d = db ?? ensureDb();
        const sessionId = upsertSession(ctx);
        entry.sessionId = sessionId;
        const ts = new Date().toISOString();
        const result = d
          .prepare(
            "INSERT INTO requests (session_id, turn, ts, provider, model, payload, request_headers) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(sessionId, state.currentTurn, ts, ctx.model?.provider ?? null, model, payloadStr, entry.hookHeaders);
        entry.rowId = Number(result.lastInsertRowid);
        broadcast({
          type: "request",
          id: entry.rowId,
          session_id: sessionId,
          turn: state.currentTurn,
          ts,
          provider: ctx.model?.provider ?? null,
          model,
          status: null,
          size: payloadStr.length,
        });
      }
    } catch (err) {
      noteDbError(err);
      if (slot !== null) {
        releaseSlot(slot, "failed");
        slot = null;
      }
    }

    pushPending(entry);
    if (entry.slot !== null) entry.slot.pending = entry;
  });

  pi.on("after_provider_response", (event) => {
    if (isSecureSession()) return;
    try {
      const attempt = matchAfter(event.status, event.headers ?? {});
      if (!attempt || attempt.rowId === null) return;
      ensureDb()
        .prepare("UPDATE requests SET status = ?, response_headers = ? WHERE id = ?")
        .run(event.status, JSON.stringify(event.headers ?? {}), attempt.rowId);
      broadcast({
        type: "response",
        id: attempt.rowId,
        session_id: attempt.pending?.sessionId ?? null,
        status: event.status,
      });
    } catch (err) {
      noteDbError(err);
    }
  });

  pi.on("message_end", (event, ctx) => {
    lastUiNotify = ctx.ui.notify;
    if (isSecureSession() || !state.recording) return;
    try {
      const d = ensureDb();
      const sid = ctx.sessionManager.getSessionId();
      state.currentSessionId = sid;
      const msg = event.message as { role?: string };
      const msgStr = JSON.stringify(msg);
      const ts = new Date().toISOString();
      const result = d
        .prepare("INSERT INTO messages (session_id, turn, ts, role, message) VALUES (?, ?, ?, ?, ?)")
        .run(sid, state.currentTurn, ts, msg.role ?? "unknown", msgStr);
      broadcast({
        type: "message",
        id: Number(result.lastInsertRowid),
        session_id: sid,
        turn: state.currentTurn,
        ts,
        role: msg.role ?? "unknown",
        size: msgStr.length,
      });
    } catch (err) {
      noteDbError(err);
    }
  });

  pi.on("session_shutdown", async () => {
    drainGate("drain");
    try {
      await shutdownJq();
    } catch (err) {
      noteDbError(err);
    }
    for (const res of state.sseClients) {
      try {
        res.end();
      } catch {}
    }
    state.sseClients.clear();
    try {
      state.server?.close();
    } catch {}
    state.server = null;
    state.serverPort = null;
    state.accessToken = null;
    resetCorrelation();
    unpatchFetch();
    try {
      state.db?.close();
    } catch {}
    state.db = null;
  });

  registerRecordCommand(pi);
}

export default function trafficRecord(pi: ExtensionAPI): void {
  patchFetch();
  registerTrafficRecordHandlers(pi);
}
