import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDb } from "../../src/traffic/db.js";

import { wireTraffic } from "../../src/traffic/index.js";
import { acquireEngine, peekEngine, RULES_REFRESH_MS, type TrafficEngine } from "../../src/traffic/engine.js";
import { teardownEngine } from "./helpers/engine.js";

const baseUrl = "https://api.example.test/v1";
const requestUrl = `${baseUrl}/messages`;
const payload = JSON.stringify({ messages: [{ role: "user", content: "hook test" }] });

let dir: string;
let handlers: Map<string, (event: any, ctx: any) => unknown>;
let command: (args: string, ctx: any) => Promise<void>;
let notifications: Array<{ message: string; type?: string }>;
let state: TrafficEngine;
let owner: object;

function model(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    api: "anthropic-messages",
    baseUrl,
    id: "test-model",
    provider: "test-provider",
    ...overrides,
  };
}

function context(modelValue: Record<string, unknown> | undefined = model()): any {
  return {
    model: modelValue,
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
    sessionManager: { getSessionId: () => "hook-session" },
    cwd: process.cwd(),
  };
}

function fakePi(): any {
  handlers = new Map();
  return {
    on: (event: string, handler: (event: any, ctx: any) => unknown) => handlers.set(event, handler),
    registerCommand: (_name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
      command = options.handler;
    },
  };
}

function addRule(): void {
  ensureDb(state)
    .prepare(
      `INSERT INTO rewrite_rules (name, enabled, priority, body_jq, created_at, updated_at)
			 VALUES (?, 1, 1, ?, ?, ?)`,
    )
    .run("hook-rule", ".", new Date().toISOString(), new Date().toISOString());
  state.refreshRules(); // 发送路径只读内存快照（安全评审 #4）
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-traffic-hooks-"));
  notifications = [];
  owner = {};
  const pi = fakePi();
  const dbPath = join(dir, "traffic.db");
  // T2a：钩子经 wireTraffic 注册，入口读进程容器里的 engine（由 /record on 等价的 acquireEngine 创建）。
  wireTraffic(pi, { enabled: true, owner, dbPath, legacyDbPath: null });
  state = acquireEngine(owner, { dbPath, legacyDbPath: null, role: "host", mode: "tui" });
  // 改写引擎按录制开关门控，钩子层用例需显式开启录制才会入闸门。
  state.recording = true;
});

afterEach(async () => {
  vi.useRealTimers();
  await teardownEngine(peekEngine());
  await teardownEngine(state);
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("T8 钩子层", () => {
  it("a: 钩子从不等待 DB / 闸门：有无启用规则都同步完成，不创建定时器（写后账本只排 setImmediate）", async () => {
    const before = handlers.get("before_provider_request")!;
    ensureDb(state);
    addRule();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const r1 = before({ payload }, context());
    expect(r1).toBeUndefined(); // 同步 handler：不返回 promise
    expect(vi.getTimerCount()).toBe(0);
    ensureDb(state).exec("DELETE FROM rewrite_rules");
    state.refreshRules();
    expect(before({ payload }, context())).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    await state.dbPort.whenIdle();
    expect((ensureDb(state).prepare("SELECT COUNT(*) c FROM requests").get() as { c: number }).c).toBe(2);
  });

  it("安全评审 #4：发送路径零 DB——有启用规则时 headers / payload 钩子的同步执行内 prepare / exec 调用数为 0", async () => {
    await command("on", { ...context(), mode: "print" }); // 装 tap（铸票据的前提）
    await state.dbPort.whenIdle();
    const db = ensureDb(state);
    addRule();
    expect(state.rulesSnapshot.rules).toHaveLength(1);
    const prepareSpy = vi.spyOn(db, "prepare");
    const execSpy = vi.spyOn(db, "exec");
    const c = context();
    const headers: Record<string, string | null> = { "content-type": "application/json" };
    handlers.get("before_provider_headers")!({ headers }, c);
    handlers.get("before_provider_request")!({ payload }, c);
    // 修复前：rulesSnapshot 每次同步 ensureDb + loadEnabledRules + getEngineSettings（2 次 prepare）。
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(execSpy).not.toHaveBeenCalled();
    prepareSpy.mockRestore();
    execSpy.mockRestore();
    // 快照确实被用于绑定（规则进入本 generation）。
    const ticket = [...state.tickets.tickets.values()].at(-1)!;
    expect(ticket.generation?.rules.map((r) => r.name)).toEqual(["hook-rule"]);
  });

  it("安全评审 #4：规则快照由非发送路径刷新（后台 unref 定时器 ~1s；engine.close 清除）", async () => {
    await command("on", { ...context(), mode: "print" });
    const engine = peekEngine()!;
    ensureDb(engine)
      .prepare(
        `INSERT INTO rewrite_rules (name, enabled, priority, body_jq, created_at, updated_at) VALUES ('later', 1, 1, '.', 't', 't')`,
      )
      .run();
    expect(engine.rulesSnapshot.rules).toHaveLength(0); // 写库不立即影响发送路径
    // 轮询（负载下定时器可能晚到）：至少一个刷新间隔之后、≤5s 内被后台定时器刷新。
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, RULES_REFRESH_MS));
    while (engine.rulesSnapshot.rules.length === 0 && Date.now() - t0 < 5000)
      await new Promise((r) => setTimeout(r, 50));
    expect(engine.rulesSnapshot.rules.map((r) => r.name)).toEqual(["later"]);
    expect(engine.rulesRefresh.refreshes).toBeGreaterThanOrEqual(2);
  });

  it("b: baseUrl 为 null 且有启用规则 ⇒ 不改写，递增 nullBaseUrlSkips 并只提示一次", async () => {
    ensureDb(state);
    addRule();
    const c = context({ ...model(), baseUrl: undefined });
    await handlers.get("before_provider_request")!({ payload }, c);
    await handlers.get("before_provider_request")!({ payload }, c);
    expect(state.nullBaseUrlSkips).toBe(2);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.message).toContain("baseUrl 未知");
  });

  it("c: requests INSERT 失败只记 dbError（flush 时），钩子本身不抛、provider 请求不受影响", async () => {
    ensureDb(state).exec(
      "CREATE TRIGGER fail_req BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT, 'insert failed'); END;",
    );
    expect(() => handlers.get("before_provider_request")!({ payload }, context())).not.toThrow();
    await state.dbPort.whenIdle();
    expect(state.dbError).toContain("insert failed");
    expect(state.dbPort.stats().writeErrors).toBe(1);
  });

  it("d: recording=false 时 after 仍回填已创建的 hook 级行", async () => {
    const c = context(model({ api: "bedrock-converse-stream" }));
    await handlers.get("before_provider_headers")!({ headers: {} }, c);
    await handlers.get("before_provider_request")!({ payload }, c);
    state.recording = false;
    await handlers.get("after_provider_response")!({ status: 200, headers: { "request-id": "hook-response" } }, c);
    await state.dbPort.whenIdle();
    const row = ensureDb(state).prepare("SELECT status, response_headers FROM requests").get() as {
      status: number;
      response_headers: string;
    };
    expect(row.status).toBe(200);
    expect(JSON.parse(row.response_headers)["request-id"]).toBe("hook-response");
  });

  it("e: 白名单外 API（Codex）有启用规则 ⇒ 一次性提示 + rewrite_warn，codex_ws_warning 置位", async () => {
    await command("on", { ...context(), mode: "print" });
    notifications.length = 0;
    ensureDb(state);
    addRule();
    const events: string[] = [];
    state.sseClients.add({
      write: (text: string) => {
        events.push(text);
        return true;
      },
    } as never);
    const before = handlers.get("before_provider_request")!;
    const c = context(model({ api: "openai-codex-responses" }));
    before({ payload }, c);
    before({ payload }, c);
    expect(state.codexWsWarned).toBe(true);
    expect(notifications.filter((item) => item.message.includes("不在票据白名单"))).toHaveLength(1);
    expect(events.join("\n")).toContain("unsupported-api");
    expect(state.tickets.counters.unsupportedApiPayloads).toBe(2);
  });

  it("f: ensureDb 抛错时 status 仍输出故障信息", async () => {
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "block");
    state.dbPath = join(blocker, "traffic.db");
    const ctx = context();
    await command("status", ctx);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.message).toContain("DB 不可用");
    expect(notifications[0]?.message).toContain("改写已禁用，流量放行");
    expect(notifications[0]?.message).toContain("录制状态");
  });

  it.skipIf(!existsSync("/usr/bin/jq"))(
    "g: session_shutdown 关闭旧 engine 的 jq，/record on 新 engine 的 jq 可用",
    async () => {
      const shutdown = handlers.get("session_shutdown")!;
      const closed = state;

      await shutdown({ reason: "quit" }, context());
      expect(closed.state).toBe("closed");
      expect(peekEngine()).toBeUndefined();
      await expect(closed.jq.run(".", "{}")).rejects.toMatchObject({
        kind: "spawn_error",
        message: "jq spawn_error: engine shutting down",
      });

      // 关闭是终态：reset 不能复活旧 engine 的 jq。
      closed.jq.reset();
      await expect(closed.jq.run(".", "{}")).rejects.toMatchObject({ kind: "spawn_error" });

      await command("on", { ...context(), mode: "print" });
      const next = peekEngine()!;
      expect(next).not.toBe(closed);
      expect(next.epoch).toBeGreaterThan(closed.epoch);
      await expect(next.jq.run(".", "{}")).resolves.toBe("{}");
    },
  );
});
