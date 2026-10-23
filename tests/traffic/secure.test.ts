import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDb, openDb } from "../../src/traffic/db.js";
import { wireTraffic } from "../../src/traffic/index.js";
import { acquireEngine, peekEngine, type TrafficEngine } from "../../src/traffic/engine.js";
import { installTap, retireTap } from "../../src/traffic/tap.js";
import { teardownEngine } from "./helpers/engine.js";
import { isSecureSession } from "../../src/traffic/secure.js";

let dir: string;
let handlers: Map<string, (event: any, ctx: any) => any>;
let command: (args: string, ctx: any) => Promise<void>;
let notes: string[];
let state: TrafficEngine;
let owner: object;
const patchFetch = (): void => {
  installTap(state, state.capture.handleFetch);
};
const unpatchFetch = (): void => {
  retireTap(state);
};

function ctx(): any {
  return {
    model: { api: "anthropic-messages", baseUrl: "https://api.example.test/v1", id: "m", provider: "p" },
    ui: { notify: (m: string) => notes.push(m) },
    sessionManager: { getSessionId: () => "sec-session" },
    cwd: process.cwd(),
  };
}

const prev = process.env.PI_SECURE_SESSION;
const nativeFetch = globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-traffic-secure-"));
  notes = [];
  handlers = new Map();
  owner = {};
  const dbPath = join(dir, "traffic.db");
  wireTraffic(
    {
      on: (e: string, h: any) => handlers.set(e, h),
      registerCommand: (_n: string, o: any) => {
        command = o.handler;
      },
    } as any,
    { enabled: true, owner, dbPath, legacyDbPath: null },
  );
  state = acquireEngine(owner, { dbPath, legacyDbPath: null, role: "host", mode: "tui" });
});

afterEach(async () => {
  unpatchFetch();
  globalThis.fetch = nativeFetch;
  if (prev === undefined) delete process.env.PI_SECURE_SESSION;
  else process.env.PI_SECURE_SESSION = prev;
  await teardownEngine(peekEngine());
  await teardownEngine(state);
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("PI_SECURE_SESSION 契约", () => {
  it('仅严格等于 "1" 才判定为加密会话，且每次现场读取', () => {
    delete process.env.PI_SECURE_SESSION;
    expect(isSecureSession()).toBe(false);
    process.env.PI_SECURE_SESSION = "0";
    expect(isSecureSession()).toBe(false);
    process.env.PI_SECURE_SESSION = "1";
    expect(isSecureSession()).toBe(true);
    delete process.env.PI_SECURE_SESSION;
    expect(isSecureSession()).toBe(false);
  });

  it("加密会话：全部钩子不创建 traffic.db、不入队、无广播副作用", async () => {
    state.recording = true;
    process.env.PI_SECURE_SESSION = "1";
    handlers.get("session_start")!({}, ctx());
    handlers.get("model_select")!({}, ctx());
    handlers.get("before_provider_headers")!({ headers: { authorization: "x" } }, ctx());
    await handlers.get("before_provider_request")!({ payload: { secret: "TOPSECRET" } }, ctx());
    handlers.get("after_provider_response")!({ status: 200, headers: {} }, ctx());
    handlers.get("message_end")!({ message: { role: "user", content: "TOPSECRET" } }, ctx());
    expect(existsSync(state.dbPath)).toBe(false);
    expect(state.db).toBeNull();
    expect(state.dbError).toBeNull();
  });

  it("加密会话：ensureDb 拒绝打开，即使 state.db 已存在", () => {
    delete process.env.PI_SECURE_SESSION;
    ensureDb(state);
    expect(state.db).not.toBeNull();
    process.env.PI_SECURE_SESSION = "1";
    expect(() => ensureDb(state)).toThrow(/PI_SECURE_SESSION/);
  });

  it("加密会话：/record on 拒绝，不开启录制、不建库", async () => {
    process.env.PI_SECURE_SESSION = "1";
    await command("on", ctx());
    expect(state.recording).toBe(false);
    expect(existsSync(state.dbPath)).toBe(false);
    expect(notes.join("\n")).toContain("PI_SECURE_SESSION=1");
    await command("status", ctx());
    expect(existsSync(state.dbPath)).toBe(false);
  });

  it("加密会话：fetch 透传，不写库、不消费响应体；非加密会话仍记录", async () => {
    const real = vi.fn(
      async () => new Response("data: TOPSECRET\n\n", { headers: { "content-type": "text/event-stream" } }),
    );
    globalThis.fetch = real as any;
    patchFetch();
    process.env.PI_SECURE_SESSION = "1";
    const res = await globalThis.fetch("https://api.example.test/v1/messages", { method: "POST", body: "{}" });
    expect(await res.text()).toBe("data: TOPSECRET\n\n");
    expect(real).toHaveBeenCalledTimes(1);
    expect(existsSync(state.dbPath)).toBe(false);

    // 中途切回非加密：同一进程每次现场判定（对照组：钩子正常落库）
    delete process.env.PI_SECURE_SESSION;
    state.recording = true;
    await handlers.get("before_provider_request")!({ payload: { a: 1 } }, ctx());
    await state.dbPort.whenIdle(); // T2b：写后账本
    expect(existsSync(state.dbPath)).toBe(true);
    const n = (ensureDb(state).prepare("SELECT COUNT(*) c FROM requests").get() as { c: number }).c;
    expect(n).toBe(1);
  });

  it("package.json 声明 piSecure.honors", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "fixtures/source-package.json"), "utf8"));
    expect(pkg.piSecure).toEqual({ honors: "PI_SECURE_SESSION/1" });
  });
});

describe("secure-domain 符号源 + 异步切点（plan §6）", () => {
  const DOMAIN_KEY = Symbol.for("pi-subagent:secure-domain");
  const g = globalThis as Record<symbol, unknown>;

  afterEach(() => {
    delete g[DOMAIN_KEY];
  });

  it("getSecureDomain().kind ∈ {secure, locked} ⇒ isSecure；plain / 未初始化 ⇒ 只看 env", () => {
    delete process.env.PI_SECURE_SESSION;
    expect(isSecureSession()).toBe(false);
    g[DOMAIN_KEY] = { kind: "locked", reason: "x", vaults: [], config: {} };
    expect(isSecureSession()).toBe(true);
    g[DOMAIN_KEY] = { kind: "secure", vaults: [], config: {} };
    expect(isSecureSession()).toBe(true);
    g[DOMAIN_KEY] = { kind: "plain", vaults: [], config: {} };
    expect(isSecureSession()).toBe(false);
    process.env.PI_SECURE_SESSION = "1";
    expect(isSecureSession()).toBe(true);
  });

  it("locked 域：wireTraffic 零注册", () => {
    g[DOMAIN_KEY] = { kind: "locked", reason: "x", vaults: [], config: {} };
    const on = vi.fn();
    const registerCommand = vi.fn();
    expect(wireTraffic({ on, registerCommand } as any, { enabled: true })).toBeUndefined();
    expect(on).not.toHaveBeenCalled();
    expect(registerCommand).not.toHaveBeenCalled();
  });

  it.each(["env", "locked"])(
    "安全评审 #2（E2）：plain 下排队后切 secure（%s），由 flush 的 drainAllowed 首次发现 ⇒ 无未捕获异常、零新增写、engine 有界关闭",
    async (how) => {
      const uncaught: unknown[] = [];
      const onUncaught = (e: unknown): void => {
        uncaught.push(e);
      };
      process.on("uncaughtException", onUncaught);
      try {
        delete process.env.PI_SECURE_SESSION;
        ensureDb(state);
        await state.dbPort.whenIdle();
        state.recording = true;
        // 两条 ready 条目：修复前内层 close 排空全部后，外层 shift() 得到 undefined 并读 .bytes。
        handlers.get("message_end")!({ message: { role: "user", content: "a" } }, ctx());
        handlers.get("message_end")!({ message: { role: "user", content: "b" } }, ctx());
        handlers.get("before_provider_request")!({ payload: { p: 1 } }, ctx());
        expect(state.dbPort.stats().queued).toBeGreaterThanOrEqual(3);
        // 入队之后、flush 之前切域；之后不再调用任何 record*。
        if (how === "env") process.env.PI_SECURE_SESSION = "1";
        else g[DOMAIN_KEY] = { kind: "locked", reason: "x", vaults: [], config: {} };
        const t0 = performance.now();
        await new Promise((r) => setTimeout(r, 30));
        expect(uncaught).toEqual([]);
        expect(state.state).not.toBe("open");
        await state.close("test");
        expect(state.state).toBe("closed");
        expect(performance.now() - t0).toBeLessThan(1500);
        expect(state.dbPort.stats().queued).toBe(0);
        delete process.env.PI_SECURE_SESSION;
        delete g[DOMAIN_KEY];
        const raw = openDb(state.dbPath, { legacyDbPath: null });
        try {
          expect((raw.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number }).c).toBe(0);
          expect((raw.prepare("SELECT COUNT(*) c FROM requests").get() as { c: number }).c).toBe(0);
        } finally {
          raw.close();
        }
      } finally {
        process.off("uncaughtException", onUncaught);
      }
    },
  );

  it("慢流中途切到 locked ⇒ 之后零新增 chunk、读取被取消、engine 进入关闭", async () => {
    ensureDb(state);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        cancelled = true;
      },
    });
    const capture = state.capture.captureStream(1, "s", new Response(body), state.epoch);
    const enc = new TextEncoder();
    controller.enqueue(enc.encode("data: 1\n\n"));
    await new Promise((r) => setTimeout(r, 20));
    await state.dbPort.whenIdle(); // T2b：chunk 在账本内合并成批（whenIdle 封批并落库）
    const rawCount = (): number => {
      const db = openDb(state.dbPath, { legacyDbPath: null });
      try {
        return (db.prepare("SELECT COUNT(*) c FROM stream_chunks").get() as { c: number }).c;
      } finally {
        db.close();
      }
    };
    expect(rawCount()).toBe(1);
    g[DOMAIN_KEY] = { kind: "locked", reason: "x", vaults: [], config: {} };
    controller.enqueue(enc.encode("data: 2\n\n"));
    await capture;
    expect(cancelled).toBe(true);
    expect(state.recording).toBe(false); // 同步撤销接纳
    await new Promise((r) => setImmediate(r)); // 关闭延迟到当前栈退出之后（安全评审 #2）
    expect(state.state).not.toBe("open");
    delete g[DOMAIN_KEY];
    expect(rawCount()).toBe(1);
  });

  it("慢重放跨切换（上游回头前切到 secure）⇒ 切换后零写入，回 503", async () => {
    const { createServer } = await import("node:http");
    const { createTrafficServer } = await import("../../src/traffic/server.js");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const upstream = createServer((_req, res) => {
      void gate.then(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upPort = (upstream.address() as { port: number }).port;
    try {
      const web = createTrafficServer(state);
      const port = await web.startServer();
      const src = Number(
        ensureDb(state)
          .prepare(
            "INSERT INTO requests (session_id, turn, ts, payload, request_headers, url, method) VALUES ('s', 0, 't', '{}', '{}', ?, 'POST')",
          )
          .run(`http://127.0.0.1:${upPort}/x`).lastInsertRowid,
      );
      const pending = fetch(`http://127.0.0.1:${port}/api/replay`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-record-token": state.accessToken ?? "" },
        body: JSON.stringify({ request_id: src }),
      });
      // 等重放行已插入、上游请求已发出。
      for (let i = 0; i < 100; i++) {
        const n = (ensureDb(state).prepare("SELECT COUNT(*) c FROM requests").get() as { c: number }).c;
        if (n === 2) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const db = state.db!;
      if (!db.prepare("SELECT id FROM requests WHERE origin = 'replay'").get()) {
        const r = await pending;
        throw new Error(`replay failed: ${r.status} ${await r.text()}`);
      }
      const replayRow = (db.prepare("SELECT id FROM requests WHERE origin = 'replay'").get() as { id: number }).id;
      process.env.PI_SECURE_SESSION = "1";
      release();
      const res = await pending;
      expect(res.status).toBe(503);
      delete process.env.PI_SECURE_SESSION;
      const raw = openDb(state.dbPath, { legacyDbPath: null });
      try {
        const row = raw.prepare("SELECT status, response_headers FROM requests WHERE id = ?").get(replayRow) as {
          status: number | null;
          response_headers: string | null;
        };
        expect(row).toEqual({ status: null, response_headers: null });
        expect((raw.prepare("SELECT COUNT(*) c FROM stream_chunks").get() as { c: number }).c).toBe(0);
      } finally {
        raw.close();
      }
    } finally {
      release();
      await new Promise((r) => upstream.close(r));
    }
  });
});
