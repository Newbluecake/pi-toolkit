/**
 * 重放四象限验证：流式×成功/失败、同步×成功/失败。
 * 期望：
 * - 所有场景：响应体都进入 stream_chunks，详情 API 对 replay 行返回 replay_body
 * - 失败（≥400）或非流式：/api/replay 应答直接带 body（页面立即可见）
 * - 流式成功：/api/replay 立即返回（不带 body），chunk 后台入库
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureDb } from "../../src/traffic/db.js";
import type { TrafficEngine } from "../../src/traffic/engine.js";
import { createTrafficServer } from "../../src/traffic/server.js";
import { makeEngine, teardownEngine } from "./helpers/engine.js";

let state: TrafficEngine;

let tmp: string;
let upstreamPort: number;
let recordPort: number;
let upstreamServer: ReturnType<typeof createServer>;
let srcId: number;

function writeSse(res: ServerResponse, chunks: string[], status = 200): void {
  res.writeHead(status, { "content-type": "text/event-stream" });
  let i = 0;
  const tick = () => {
    if (i < chunks.length) {
      res.write(chunks[i++]);
      setTimeout(tick, 5);
    } else {
      res.end();
    }
  };
  tick();
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "record-replay4-"));
  state = makeEngine(tmp);
  ensureDb(state);

  upstreamServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    switch (req.url) {
      case "/stream-ok":
        return writeSse(res, ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', "data: [DONE]\n\n"]);
      case "/stream-err":
        // 少数网关会用 event-stream 返回错误（状态码也可能是 200）
        return writeSse(res, ['data: {"error":"bad stream"}\n\n'], 400);
      case "/sync-ok":
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, text: "hello" }));
      case "/sync-err":
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "thinking not supported" } }));
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise<void>((r) => upstreamServer.listen(0, "127.0.0.1", r));
  upstreamPort = (upstreamServer.address() as { port: number }).port;

  recordPort = await createTrafficServer(state).startServer();
  const ins = ensureDb(state)
    .prepare(
      `INSERT INTO requests (session_id, turn, ts, provider, model, payload, request_headers, url, method)
			 VALUES ('s1', 0, ?, 'p', 'm', '{}', '{"x-api-key":"k"}', 'http://127.0.0.1/', 'POST')`,
    )
    .run(new Date().toISOString());
  srcId = Number(ins.lastInsertRowid);
});

afterAll(async () => {
  await new Promise((r) => upstreamServer.close(r));
  await teardownEngine(state);
  rmSync(tmp, { recursive: true, force: true });
});

async function replay(urlPath: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${recordPort}/api/replay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: srcId,
      url: `http://127.0.0.1:${upstreamPort}${urlPath}`,
      method: "POST",
      headers: { "x-api-key": "k", "content-type": "application/json" },
      payload: {},
    }),
  });
  return { status: res.status, json: await res.json() };
}

function dbChunks(requestId: number): string {
  const rows = ensureDb(state)
    .prepare("SELECT data FROM stream_chunks WHERE request_id = ? ORDER BY seq")
    .all(requestId) as Array<{ data: string }>;
  return rows.map((r) => r.data).join("");
}

async function waitChunks(requestId: number, until?: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = dbChunks(requestId);
    if (text && (!until || text.includes(until))) return text;
    if (Date.now() > deadline)
      throw new Error(`#${requestId} 超时：未捕获到 ${until ?? "chunk"}（当前 ${text.length}B）`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function detailReplayBody(requestId: number): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${recordPort}/api/requests/${requestId}`);
  const d = (await res.json()) as { replay_body?: unknown };
  return d.replay_body;
}

describe("重放四象限", () => {
  it("流式 + 成功：立即返回（不带 body），chunk 后台入库，/api/stream 最终报告 done", async () => {
    const { json } = await replay("/stream-ok");
    expect(json.status).toBe(200);
    expect(json.body).toBeUndefined(); // 流式不阻塞页面，由前端轮询 /api/stream 实时展示
    const text = await waitChunks(json.id, "[DONE]");
    expect(text).toContain('"a":1');
    await expect(detailReplayBody(json.id)).resolves.toContain("[DONE]");
    // 捕获收尾后 done=true（轮询等待，finally 标记与最后一条 chunk 入库存在微小先后差）
    const deadline = Date.now() + 3000;
    for (;;) {
      const r = await fetch(`http://127.0.0.1:${recordPort}/api/stream/${json.id}`);
      const sj = (await r.json()) as { rows: unknown[]; done: boolean };
      if (sj.done) {
        expect(sj.rows.length).toBeGreaterThan(0);
        break;
      }
      if (Date.now() > deadline) throw new Error("done 标记超时未置位");
      await new Promise((r2) => setTimeout(r2, 20));
    }
  });

  it("流式 + 失败（HTTP 400 + event-stream）：应答带 body，chunk 入库", async () => {
    const { json } = await replay("/stream-err");
    expect(json.status).toBe(400);
    expect(json.body).toContain("bad stream");
    expect(dbChunks(json.id)).toContain("bad stream");
    await expect(detailReplayBody(json.id)).resolves.toContain("bad stream");
  });

  it("同步 + 成功：应答带 body，整体一条入库", async () => {
    const { json } = await replay("/sync-ok");
    expect(json.status).toBe(200);
    expect(json.body).toContain("hello");
    expect(dbChunks(json.id)).toContain("hello");
    await expect(detailReplayBody(json.id)).resolves.toContain("hello");
  });

  it("同步 + 失败：应答带错误 body，整体一条入库", async () => {
    const { json } = await replay("/sync-err");
    expect(json.status).toBe(400);
    expect(json.body).toContain("thinking not supported");
    expect(dbChunks(json.id)).toContain("thinking not supported");
    await expect(detailReplayBody(json.id)).resolves.toContain("thinking not supported");
  });
});
