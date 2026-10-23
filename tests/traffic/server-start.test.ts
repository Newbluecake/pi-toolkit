/**
 * 安全评审 #4：startServer 启动中 single-flight——并发 /record on 只监听一次；close / reload 关闭所有
 * 曾监听（含启动中）的 listener，端口随之释放。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { peekEngine } from "../../src/traffic/engine.js";
import { wireTraffic } from "../../src/traffic/index.js";
import { createTrafficServer } from "../../src/traffic/server.js";
import { BIND_HOST } from "../../src/traffic/state.js";
import { makeEngine, teardownEngine } from "./helpers/engine.js";

let dir: string;

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, BIND_HOST, () => probe.close(() => resolve(true)));
  });
}

function fakePi() {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  let command!: (args: string, ctx: any) => Promise<void>;
  const pi = {
    on: (e: string, h: (event: any, ctx: any) => unknown) => handlers.set(e, h),
    registerCommand: (_n: string, o: { handler: (args: string, ctx: any) => Promise<void> }) => {
      command = o.handler;
    },
  };
  return { pi: pi as any, handlers, command: () => command };
}

function ctx(notes: string[]): any {
  return {
    mode: "tui",
    model: { api: "anthropic-messages", baseUrl: "https://api.example.test/v1", id: "m", provider: "p" },
    ui: { notify: (m: string) => notes.push(m) },
    sessionManager: { getSessionId: () => "s" },
    cwd: process.cwd(),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-traffic-server-start-"));
});

afterEach(async () => {
  await teardownEngine(peekEngine());
  rmSync(dir, { recursive: true, force: true });
});

describe("startServer single-flight", () => {
  it("并发两次 startServer ⇒ 同一端口、只有一个 listener；close 后端口释放", async () => {
    const engine = makeEngine(dir);
    const web = createTrafficServer(engine);
    const [a, b] = await Promise.all([web.startServer(), web.startServer()]);
    expect(a).toBe(b);
    expect(engine.listeners.size).toBe(1);
    expect(await canBind(a + 1)).toBe(true); // 没有在相邻端口再起一个
    // 两个实例（同一 engine）同样共享启动。
    const other = createTrafficServer(engine);
    expect(await other.startServer()).toBe(a);
    expect(engine.listeners.size).toBe(1);
    await engine.close("test");
    expect(engine.listeners.size).toBe(0);
    expect(await canBind(a)).toBe(true);
  });

  it("启动中 close ⇒ 不留下任何 listener", async () => {
    const engine = makeEngine(dir);
    const web = createTrafficServer(engine);
    const starting = web.startServer().catch((err: unknown) => err);
    const closing = engine.close("test");
    expect(await starting).toBeInstanceOf(Error);
    await closing;
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.listeners.size).toBe(0);
    expect(engine.server).toBeNull();
    expect(await canBind(4177)).toBe(true);
  });

  it("并发两次 /record on 只监听一次（两条回复同一端口）；reload（session_shutdown）后端口释放", async () => {
    const { pi, handlers, command } = fakePi();
    wireTraffic(pi, { enabled: true, dbPath: join(dir, "t.db"), legacyDbPath: null });
    const notes: string[] = [];
    await Promise.all([command()("on", ctx(notes)), command()("on", ctx(notes))]);
    const engine = peekEngine()!;
    expect(engine.listeners.size).toBe(1);
    const port = engine.serverPort!;
    const ports = notes.map((n) => [...n.matchAll(/:(\d{4,5})/g)].map((m) => Number(m[1]))).flat();
    expect(new Set(ports)).toEqual(new Set([port]));
    await handlers.get("session_shutdown")!({ reason: "reload" }, ctx(notes));
    expect(engine.listeners.size).toBe(0);
    expect(await canBind(port)).toBe(true);
  });
});
