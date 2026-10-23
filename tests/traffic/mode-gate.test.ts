/**
 * #13 模式门禁（plan §4.1 硬规则）：网页服务与重放只存在于「主会话 ∧ mode ∈ {tui, rpc}」。
 * print/json：/record on 只录制、无 listener、无重放入口（E_REPLAY_MODE）；子会话：无命令 / 服务 / 重放。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDb } from "../../src/traffic/db.js";
import { createTrafficEngine, peekEngine } from "../../src/traffic/engine.js";
import { wireTraffic } from "../../src/traffic/index.js";
import { PRINT_MODE_NOTE, serviceAllowed } from "../../src/traffic/mode.js";
import { createTrafficServer } from "../../src/traffic/server.js";
import { teardownEngine } from "./helpers/engine.js";

let dir: string;
let dbPath: string;

function fakePi() {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      if (handlers.has(event)) throw new Error(`duplicate handler ${event}`);
      handlers.set(event, handler);
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
      commands.set(name, options.handler);
    },
  };
  return { pi: pi as any, handlers, commands };
}

function ctx(mode: string, sessionId = "s-main"): any {
  const notes: string[] = [];
  return {
    mode,
    model: { api: "anthropic-messages", baseUrl: "https://api.example.test/v1", id: "m", provider: "p" },
    ui: { notify: (m: string) => notes.push(m) },
    sessionManager: { getSessionId: () => sessionId },
    cwd: process.cwd(),
    notes,
  };
}

function fakeRes(): any {
  return { writeHead: () => undefined, end: () => undefined };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-traffic-mode-"));
  dbPath = join(dir, "traffic.db");
});

afterEach(async () => {
  await teardownEngine(peekEngine());
  rmSync(dir, { recursive: true, force: true });
});

describe("serviceAllowed", () => {
  it("只有 host ∧ tui/rpc 允许；print/json/未知/子会话一律不允许", () => {
    expect(serviceAllowed("host", "tui")).toBe(true);
    expect(serviceAllowed("host", "rpc")).toBe(true);
    expect(serviceAllowed("host", "print")).toBe(false);
    expect(serviceAllowed("host", "json")).toBe(false);
    expect(serviceAllowed("host", undefined)).toBe(false);
    expect(serviceAllowed("host", "future-mode")).toBe(false);
    expect(serviceAllowed("child", "tui")).toBe(false);
    expect(serviceAllowed("child", "rpc")).toBe(false);
  });
});

describe.each(["print", "json"])("%s 模式", (mode) => {
  it("/record on 只录制：无 listener、回复注明、钩子照常落库；startServer / replay 抛 E_REPLAY_MODE", async () => {
    const { pi, handlers, commands } = fakePi();
    wireTraffic(pi, { enabled: true, dbPath, legacyDbPath: null });
    const c = ctx(mode);
    await commands.get("record")!("on", c);
    const engine = peekEngine()!;
    expect(engine.recording).toBe(true);
    expect(engine.serviceAllowed).toBe(false);
    expect(engine.server).toBeNull();
    expect(engine.serverPort).toBeNull();
    expect(engine.web).toBeNull();
    expect(engine.connections.size).toBe(0);
    expect(c.notes.join("\n")).toContain(PRINT_MODE_NOTE);

    await handlers.get("before_provider_request")!({ payload: { a: 1 } }, c);
    handlers.get("message_end")!({ message: { role: "assistant", content: "hi" } }, c);
    await engine.dbPort.whenIdle(); // T2b：写后账本
    const db = ensureDb(engine);
    expect((db.prepare("SELECT COUNT(*) c FROM requests").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number }).c).toBe(1);

    // 纵深防御：即使有人构造服务实例，也起不来、不能重放。
    const web = createTrafficServer(engine);
    await expect(web.startServer()).rejects.toMatchObject({ code: "E_REPLAY_MODE" });
    await expect(web.replay({ request_id: 1 }, fakeRes())).rejects.toMatchObject({ code: "E_REPLAY_MODE" });
    expect(engine.server).toBeNull();

    // status 也注明无网页服务。
    await commands.get("record")!("status", c);
    expect(c.notes.at(-1)).toContain(PRINT_MODE_NOTE);
  });
});

describe("交互模式（tui / rpc）", () => {
  it.each(["tui", "rpc"])("%s：/record on 启动 listener（socket 记账、unref），session_shutdown 关闭", async (mode) => {
    const { pi, handlers, commands } = fakePi();
    wireTraffic(pi, { enabled: true, dbPath, legacyDbPath: null });
    await commands.get("record")!("on", ctx(mode));
    const engine = peekEngine()!;
    expect(engine.serviceAllowed).toBe(true);
    expect(engine.serverPort).not.toBeNull();
    const res = await fetch(`http://127.0.0.1:${engine.serverPort}/api/state`, {
      headers: { connection: "keep-alive", "x-record-token": engine.accessToken ?? "" },
    });
    expect(res.status).toBe(200);
    await res.json();
    expect(engine.connections.size).toBeGreaterThanOrEqual(1);
    const server = engine.server!;
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx(mode));
    expect(engine.state).toBe("closed");
    expect(server.listening).toBe(false);
    expect(engine.connections.size).toBe(0);
    expect(peekEngine()).toBeUndefined();
  });
});

describe("子会话", () => {
  it("只注册录制钩子：无命令、无 session_shutdown；子会话 engine 不允许服务/重放", async () => {
    const child = fakePi();
    wireTraffic(child.pi, { enabled: true, role: "child", dbPath, legacyDbPath: null });
    expect(child.commands.size).toBe(0);
    expect(child.handlers.has("session_shutdown")).toBe(false);
    expect(child.handlers.has("session_start")).toBe(false);
    expect([...child.handlers.keys()].sort()).toEqual(
      [
        "after_provider_response",
        "agent_settled",
        "before_provider_headers",
        "before_provider_request",
        "cache_warming_decision",
        "message_end",
        "turn_start",
      ].sort(),
    );
    const childEngine = createTrafficEngine({ dbPath, legacyDbPath: null, role: "child", mode: "tui" });
    expect(childEngine.serviceAllowed).toBe(false);
    await expect(createTrafficServer(childEngine).replay({}, fakeRes())).rejects.toMatchObject({
      code: "E_REPLAY_MODE",
    });
    await childEngine.close("t");
  });

  it("主会话未录制 ⇒ 子会话钩子立即返回（不建容器、不落库）；主会话录制中 ⇒ 子会话请求以子会话 id 落库", async () => {
    const child = fakePi();
    wireTraffic(child.pi, { enabled: true, role: "child", dbPath, legacyDbPath: null });
    await child.handlers.get("before_provider_request")!({ payload: { a: 1 } }, ctx("print", "s-child"));
    expect(peekEngine()).toBeUndefined();

    const host = fakePi();
    wireTraffic(host.pi, { enabled: true, dbPath, legacyDbPath: null });
    await host.commands.get("record")!("on", ctx("print"));
    await child.handlers.get("before_provider_request")!({ payload: { a: 2 } }, ctx("print", "s-child"));
    await peekEngine()!.dbPort.whenIdle();
    const rows = ensureDb(peekEngine()!).prepare("SELECT session_id FROM requests").all() as Array<{
      session_id: string;
    }>;
    expect(rows).toEqual([{ session_id: "s-child" }]);
  });

  it("childPersist=false：子会话钩子不落库", async () => {
    const host = fakePi();
    wireTraffic(host.pi, { enabled: true, dbPath, legacyDbPath: null });
    await host.commands.get("record")!("on", ctx("print"));
    const child = fakePi();
    wireTraffic(child.pi, { enabled: true, role: "child", childPersist: false, dbPath, legacyDbPath: null });
    await child.handlers.get("before_provider_request")!({ payload: { a: 2 } }, ctx("print", "s-child"));
    child.handlers.get("message_end")!({ message: { role: "assistant" } }, ctx("print", "s-child"));
    await peekEngine()!.dbPort.whenIdle();
    const db = ensureDb(peekEngine()!);
    expect((db.prepare("SELECT COUNT(*) c FROM requests").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number }).c).toBe(0);
  });

  it("isActive=false（认领协议让位）⇒ 钩子与命令均不工作", async () => {
    const host = fakePi();
    wireTraffic(host.pi, { enabled: true, dbPath, legacyDbPath: null, isActive: () => false });
    const c = ctx("tui");
    await host.commands.get("record")!("on", c);
    expect(peekEngine()).toBeUndefined();
    expect(c.notes.join("\n")).toContain("让位");
  });
});
