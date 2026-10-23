/**
 * 安全评审 #3：流式落库抛错后，重放的上游必须被中止，取消域 / AbortController 不得在上游存活时被注销；
 * status UPDATE（响应头之后）抛错同理；engine.close 之后不留出站连接。
 */
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDb } from "../../src/traffic/db.js";
import type { TrafficEngine } from "../../src/traffic/engine.js";
import { createTrafficServer } from "../../src/traffic/server.js";
import { makeEngine, teardownEngine } from "./helpers/engine.js";

let dir: string;
let engine: TrafficEngine;
let upstream: Server;
let upstreamClosed: Promise<number>;
let upstreamHit: Promise<void>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-traffic-replay-cleanup-"));
  engine = makeEngine(dir);
  let onClose!: (t: number) => void;
  let onHit!: () => void;
  upstreamClosed = new Promise((r) => (onClose = r));
  upstreamHit = new Promise((r) => (onHit = r));
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    res.on("close", () => onClose(Date.now()));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"a":1}\n\n'); // 回头后永不结束
    onHit();
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
});

afterEach(async () => {
  await teardownEngine(engine);
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
  rmSync(dir, { recursive: true, force: true });
});

function seedSource(): number {
  const port = (upstream.address() as { port: number }).port;
  return Number(
    ensureDb(engine)
      .prepare(
        "INSERT INTO requests (session_id, turn, ts, payload, request_headers, url, method) VALUES ('s', 0, 't', '{}', '{}', ?, 'POST')",
      )
      .run(`http://127.0.0.1:${port}/v1/messages`).lastInsertRowid,
  );
}

/** 不复用连接（每个用例的服务都从 4177 起绑，undici 连接池可能复用上个用例已被销毁的 socket）。 */
function replay(port: number, id: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/replay",
        method: "POST",
        agent: false,
        headers: { "content-type": "application/json", "x-record-token": engine.accessToken ?? "" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ request_id: id }));
  });
}

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);

describe("重放异常路径的资源作用域", () => {
  it("stream_chunks INSERT 抛错 ⇒ 上游立即被中止，取消域清空", async () => {
    const web = createTrafficServer(engine);
    const port = await web.startServer();
    const src = seedSource();
    ensureDb(engine).exec(
      "CREATE TRIGGER fail_chunks BEFORE INSERT ON stream_chunks BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    );
    const t0 = Date.now();
    expect(await replay(port, src)).toBe(200);
    await upstreamHit;
    const closedAt = await within(upstreamClosed, 2000, "upstream abort after insert failure");
    expect(closedAt - t0).toBeLessThan(2000);
    // 没有遗留的取消项（controller 已在 abort 之后才注销）。
    expect(engine.cancel.size()).toBe(0);
  });

  it("响应头之后 status UPDATE 抛错 ⇒ 上游被中止（不留孤儿出站连接）", async () => {
    const web = createTrafficServer(engine);
    const port = await web.startServer();
    const src = seedSource();
    ensureDb(engine).exec(
      "CREATE TRIGGER fail_status BEFORE UPDATE OF status ON requests BEGIN SELECT RAISE(ABORT, 'locked'); END;",
    );
    expect(await replay(port, src)).toBe(500);
    await within(upstreamClosed, 2000, "upstream abort after status update failure");
    expect(engine.cancel.size()).toBe(0);
  });

  it("正常流式重放进行中 engine.close ⇒ 上游被中止（取消域仍持有 controller）", async () => {
    const web = createTrafficServer(engine);
    const port = await web.startServer();
    const src = seedSource();
    expect(await replay(port, src)).toBe(200);
    await upstreamHit;
    await new Promise((r) => setTimeout(r, 30));
    expect(engine.cancel.size()).toBeGreaterThanOrEqual(1);
    await engine.close("quit");
    await within(upstreamClosed, 2000, "upstream abort after close");
  });

  it("captureStream 落库抛错 ⇒ 取消 reader（非 EOF 退出先取消、再注销），onEnd 报 aborted", async () => {
    ensureDb(engine).exec(
      "CREATE TRIGGER fail_chunks BEFORE INSERT ON stream_chunks BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    );
    let cancelled = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        cancelled = true;
      },
    });
    const ends: string[] = [];
    const done = engine.capture.captureStream(9, "s", new Response(body), engine.epoch, {
      onEnd: (kind) => ends.push(kind),
    });
    controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
    await done;
    expect(cancelled).toBe(true);
    expect(ends).toEqual(["aborted"]);
    expect(engine.cancel.size()).toBe(0);
  });

  it("captureStream 自然 EOF ⇒ 不取消，onEnd 报 eof", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: 1\n\n"));
        c.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const ends: string[] = [];
    ensureDb(engine);
    await engine.capture.captureStream(10, "s", new Response(body), engine.epoch, { onEnd: (k) => ends.push(k) });
    expect(cancelled).toBe(false);
    expect(ends).toEqual(["eof"]);
  });
});
