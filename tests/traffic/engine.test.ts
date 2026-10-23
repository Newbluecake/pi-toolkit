/**
 * #3 engine：owner/epoch、acquire/release 身份校验、close 撤销接纳、陈旧续体写入被丢弃（plan §5.2 / §6）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { peekTrafficGlobal } from "../../src/traffic/container.js";
import { ensureDb, openDb } from "../../src/traffic/db.js";
import { acquireEngine, peekEngine, releaseEngine, type TrafficEngine } from "../../src/traffic/engine.js";
import { wireTraffic } from "../../src/traffic/index.js";
import { persist } from "../../src/traffic/persist.js";
import { installTap, tapActiveFor } from "../../src/traffic/tap.js";
import { makeEngine, teardownEngine } from "./helpers/engine.js";

let dir: string;
let dbPath: string;
const engines: TrafficEngine[] = [];

function acquire(owner: object, mode = "print"): TrafficEngine {
  const engine = acquireEngine(owner, { dbPath, legacyDbPath: null, role: "host", mode });
  engines.push(engine);
  return engine;
}

function count(engine: TrafficEngine, table: string): number {
  return (ensureDb(engine).prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
}

function fakePi() {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  let command: ((args: string, ctx: any) => Promise<void>) | undefined;
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => unknown) => handlers.set(event, handler),
    registerCommand: (_name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
      command = options.handler;
    },
  };
  return { pi: pi as any, handlers, command: () => command! };
}

function ctx(sessionId = "s-main", mode = "print"): any {
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-traffic-engine-"));
  dbPath = join(dir, "traffic.db");
});

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close("test");
  await teardownEngine(peekEngine());
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("acquire / release", () => {
  it("同 owner 复用；纪元单调递增；不同 owner 视为陈旧：先关闭再新建", async () => {
    const a = {};
    const b = {};
    const e1 = acquire(a);
    expect(acquire(a)).toBe(e1);
    expect(peekEngine()).toBe(e1);
    const e2 = acquire(b);
    expect(e2).not.toBe(e1);
    expect(e2.epoch).toBeGreaterThan(e1.epoch);
    // 陈旧者同步进入 closing（撤销接纳），随后 closed。
    expect(e1.state).not.toBe("open");
    expect(e1.recording).toBe(false);
    await e1.close("again");
    expect(e1.state).toBe("closed");
    expect(peekEngine()).toBe(e2);
  });

  it("旧激活迟到的 release 不清新实例（身份校验）", () => {
    const a = {};
    const b = {};
    const e1 = acquire(a);
    const e2 = acquire(b);
    expect(releaseEngine(a, e1)).toBe(false);
    expect(releaseEngine(b, e1)).toBe(false);
    expect(peekEngine()).toBe(e2);
    expect(releaseEngine(b, e2)).toBe(true);
    expect(peekEngine()).toBeUndefined();
    // 容器保留（纪元必须单调），engine 清空。
    expect(peekTrafficGlobal()?.engine).toBeUndefined();
    expect(peekTrafficGlobal()?.epochSeq).toBeGreaterThanOrEqual(e2.epoch);
  });

  it("同 owner 但 engine 已关闭 ⇒ 新建（新纪元）", async () => {
    const a = {};
    const e1 = acquire(a);
    await e1.close("x");
    const e2 = acquire(a);
    expect(e2).not.toBe(e1);
    expect(e2.epoch).toBeGreaterThan(e1.epoch);
  });

  it("旧激活的 session_shutdown 晚于新激活的 acquire：不关闭、不清除新实例", async () => {
    const oldWire = fakePi();
    const newWire = fakePi();
    const oldOwner = {};
    const newOwner = {};
    wireTraffic(oldWire.pi, { enabled: true, owner: oldOwner, dbPath, legacyDbPath: null });
    wireTraffic(newWire.pi, { enabled: true, owner: newOwner, dbPath, legacyDbPath: null });
    await oldWire.command()("on", ctx());
    const oldEngine = peekEngine()!;
    await newWire.command()("on", ctx());
    const newEngine = peekEngine()!;
    expect(newEngine).not.toBe(oldEngine);
    await oldWire.handlers.get("session_shutdown")!({ reason: "reload" }, ctx());
    expect(peekEngine()).toBe(newEngine);
    expect(newEngine.state).toBe("open");
    expect(newEngine.recording).toBe(true);
  });
});

describe("close 语义", () => {
  it("同步进入 closing：recording=false、退役 tap、中止取消域、清 SSE、kill jq 并移除 exit 监听；有界关库进入 closed", async () => {
    const engine = makeEngine(dir);
    engines.push(engine);
    ensureDb(engine);
    engine.recording = true;
    const native = globalThis.fetch;
    installTap(engine, engine.capture.handleFetch);
    expect(globalThis.fetch).not.toBe(native);
    const aborted: string[] = [];
    engine.cancel.register((reason) => aborted.push(reason));
    const ended: number[] = [];
    engine.sseClients.add({ end: () => ended.push(1), write: () => true } as never);
    // 让 jq 登记 exit 监听（首次 spawn 时登记）。
    const exitBefore = process.listenerCount("exit");
    await engine.jq.probe("/nonexistent/jq-binary").catch(() => undefined);
    expect(engine.jq.exitHookInstalled()).toBe(true);
    expect(process.listenerCount("exit")).toBe(exitBefore + 1);

    const done = engine.close("test");
    expect(engine.state).toBe("closing");
    expect(engine.recording).toBe(false);
    expect(globalThis.fetch).toBe(native);
    expect(tapActiveFor(engine)).toBeUndefined();
    expect(aborted).toEqual(["test"]);
    expect(ended).toEqual([1]);
    expect(engine.sseClients.size).toBe(0);
    expect(engine.jq.exitHookInstalled()).toBe(false);
    expect(process.listenerCount("exit")).toBe(exitBefore);
    await expect(engine.jq.run(".", "{}")).rejects.toMatchObject({ kind: "spawn_error" });
    // close 后登记的取消项立即被中止。
    engine.cancel.register((reason) => aborted.push(`late:${reason}`));
    expect(aborted).toEqual(["test", "late:test"]);
    await done;
    expect(engine.state).toBe("closed");
    expect(engine.db).toBeNull();
    // 幂等。
    expect(engine.close("again")).toBe(done);
  });

  it("关闭后不能重开库（ensureDb 拒绝），persist 丢弃并计数", async () => {
    const engine = makeEngine(dir);
    engines.push(engine);
    ensureDb(engine);
    await engine.close("test");
    expect(() => ensureDb(engine)).toThrow(/已关闭/);
    const op = vi.fn();
    expect(persist(engine, engine.epoch, op)).toBeUndefined();
    expect(op).not.toHaveBeenCalled();
    expect(engine.counters.droppedPersists).toBe(1);
    expect(engine.db).toBeNull();
  });

  it("纪元不符的写被闸口丢弃（续体持有的纪元必须与 engine 一致）", () => {
    const engine = makeEngine(dir);
    engines.push(engine);
    expect(persist(engine, engine.epoch + 1, () => 1)).toBeUndefined();
    expect(engine.counters.droppedPersists).toBe(1);
    expect(persist(engine, engine.epoch, () => 2)).toBe(2);
  });
});

describe("陈旧续体（跨 reload）", () => {
  it("before_provider_request 在 await 闸门期间 engine 被关闭：续体固定旧 engine，写入被丢弃、不重开旧库、不写新库", async () => {
    const wire1 = fakePi();
    const owner1 = {};
    wireTraffic(wire1.pi, { enabled: true, owner: owner1, dbPath, legacyDbPath: null });
    await wire1.command()("on", ctx());
    const old = peekEngine()!;
    // 启用规则使钩子在 acquireSlot 处 await（闸门被占用 ⇒ 排队）。
    ensureDb(old)
      .prepare(
        "INSERT INTO rewrite_rules (name, enabled, priority, body_jq, created_at, updated_at) VALUES ('r', 1, 1, '.', 't', 't')",
      )
      .run();
    const blocker = await old.gate.acquireSlot({ sessionId: "x", baseUrl: "https://api.example.test/v1" }, "orphan");
    const pending = wire1.handlers.get("before_provider_request")!({ payload: { a: 1 } }, ctx());
    await Promise.resolve();

    // reload：旧激活 shutdown（关闭旧 engine），新激活 /record on。
    await wire1.handlers.get("session_shutdown")!({ reason: "reload" }, ctx());
    const wire2 = fakePi();
    const owner2 = {};
    wireTraffic(wire2.pi, { enabled: true, owner: owner2, dbPath, legacyDbPath: null });
    await wire2.command()("on", ctx());
    const fresh = peekEngine()!;
    expect(fresh).not.toBe(old);
    void blocker;
    await pending; // drainGate 放行排队者，续体继续执行
    expect(old.state).toBe("closed");
    expect(old.db).toBeNull(); // 未重开旧库
    expect(count(fresh, "requests")).toBe(0); // 未写新库
    expect(fresh.recording).toBe(true); // 旧续体不能复活/干扰新 engine 的录制
    expect(old.recording).toBe(false);
  });

  it("流捕获跨 close：之后零新增 chunk，读取被取消", async () => {
    const engine = makeEngine(dir);
    engines.push(engine);
    ensureDb(engine);
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
    const capture = engine.capture.captureStream(7, "s", new Response(body), engine.epoch);
    controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
    await new Promise((r) => setTimeout(r, 20));
    const chunks = (): number => (engine.db!.prepare("SELECT COUNT(*) c FROM stream_chunks").get() as { c: number }).c;
    expect(chunks()).toBe(1);
    const closing = engine.close("reload");
    expect(cancelled).toBe(true);
    try {
      controller.enqueue(new TextEncoder().encode("data: 2\n\n"));
    } catch {}
    await capture;
    await closing;
    const raw = openDb(dbPath, { legacyDbPath: null });
    expect((raw.prepare("SELECT COUNT(*) c FROM stream_chunks").get() as { c: number }).c).toBe(1);
    raw.close();
  });
});
