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
  /**
   * 私有端口带：其它并行测试文件（server-hardening / replay / lifecycle 子进程）都用默认
   * 4177 起（自增最多到 4196）——本文件改用 4260 起，消除跨文件端口竞争导致的 canBind 假失败。
   */
  const PORT = 4260;

  it("并发两次 startServer ⇒ 同一端口、只有一个 listener；close 后端口释放", async () => {
    const engine = makeEngine(dir);
    const web = createTrafficServer(engine, { port: PORT });
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
    const web = createTrafficServer(engine, { port: PORT });
    const starting = web.startServer().catch((err: unknown) => err);
    const closing = engine.close("test");
    expect(await starting).toBeInstanceOf(Error);
    await closing;
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.listeners.size).toBe(0);
    expect(engine.server).toBeNull();
    expect(await canBind(PORT)).toBe(true);
  });

  it("并发两次 /record on 只监听一次（两条回复同一端口）；reload（session_shutdown）后端口释放", async () => {
    const { pi, handlers, command } = fakePi();
    wireTraffic(pi, {
      enabled: true,
      dbPath: join(dir, "t.db"),
      legacyDbPath: null,
      web: { host: "127.0.0.1", port: PORT },
    });
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

describe("安全评审 #5：端口自增上界截断（port=65535 不触发 listen(65536) 参数异常）", () => {
  function occupy(ports: number[]): () => void {
    const servers: Array<ReturnType<typeof createServer>> = [];
    for (const port of ports) {
      const s = createServer();
      s.listen(port, "127.0.0.1");
      servers.push(s);
    }
    return () => {
      for (const s of servers) s.close();
    };
  }

  it("port=65535 被占 ⇒ 有界「端口占用」错误（65535-65535），不是 ERR_SOCKET_BAD_PORT", async () => {
    if (!(await canBind(65535))) return; // 端口被别的进程占用 ⇒ 本用例的占用前提已天然成立
    const release = occupy([65535]);
    try {
      const engine = makeEngine(dir);
      const web = createTrafficServer(engine, { port: 65535 });
      await expect(web.startServer()).rejects.toThrow(/端口 65535-65535 均被占用/);
      expect(engine.listeners.size).toBe(0);
      await engine.close("test");
    } finally {
      release();
    }
  });

  it("port=65530 且 65530-65535 全被占 ⇒ 尝试范围截断到 65535，错误文案反映实际范围", async () => {
    const wanted = [65530, 65531, 65532, 65533, 65534, 65535];
    const free: number[] = [];
    for (const port of wanted) if (await canBind(port)) free.push(port);
    if (free.length !== wanted.length) return; // 已有外部占用 ⇒ 前提不纯，跳过断言范围文案
    const release = occupy(wanted);
    try {
      const engine = makeEngine(dir);
      const web = createTrafficServer(engine, { port: 65530 });
      // 未截断时会试到 65549 并可能在 65536 抛 ERR_SOCKET_BAD_PORT（不同 Node 版本行为不一）
      await expect(web.startServer()).rejects.toThrow(/端口 65530-65535 均被占用/);
      await engine.close("test");
    } finally {
      release();
    }
  });

  it("port=65535 空闲 ⇒ 正常监听（上界本身合法可用）", async () => {
    if (!(await canBind(65535))) return;
    const engine = makeEngine(dir);
    const web = createTrafficServer(engine, { port: 65535 });
    const port = await web.startServer();
    expect(port).toBe(65535);
    await engine.close("test");
    expect(await canBind(65535)).toBe(true);
  });
});
