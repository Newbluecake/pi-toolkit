/**
 * #8 §3.2 硬验收门（r3 裁定 R1-9）：同线程 DbPort 在第二连接持写锁 / 无锁 + 历史读与导出下，provider 发送延迟增量、
 * 事件循环心跳、取消延迟。不达标 ⇒ 报告并停在 T2c（worker）分支，不在这里放宽门槛。
 *
 * 口径（方案作者确认）：
 * - 发送时刻 = 上游 stub（trampoline 的固定下游）被调用的时刻 − 模拟 pi 钩子序列开始的时刻；
 *   增量_i = 录制组 latency_i − 无录制基线组中位数；门槛 p99 ≤ 10ms。串行（固定间隔）为主门，另跑并发 4。
 * - 并发 4 = **1 个主会话 + 3 个子会话激活**（各自 runner / sessionId，各自串行请求流，4 路并行；安全评审 #9）：
 *   断言每个请求都被票据精确绑定（ticketsBound 增量 = N、unattributed 增量 = 0）且落库行归属各自会话。
 * - 发送路径零 DB（安全评审 #4）：从钩子序列开始到 stub 被调用的窗口内（只有微任务，账本 tick 不会混入），
 *   引擎连接的 prepare / exec 调用数必须为 0。
 * - 心跳：5ms setInterval 的最大实际间隔 ≤ 80ms。
 * - 取消延迟：持锁 + 账本有待写时，对经过 tap 的在途 provider 请求 abort() ⇒ fetch reject 与上游看到连接关闭 ≤ 80ms。
 * - 锁释放后账本 ≤5s 落库完成，无行错位，`droppedRows` 与注入一致。
 *
 * 数字经 console.log 输出（`[traffic-gate]` 前缀），供 T2b 报告引用；设 TRAFFIC_GATE_JSON=<path> 另存 JSON。
 *
 * **计时门槛只在 `PI_TRAFFIC_PERF_GATE=1` 时断言**（`npm run test:traffic-gate`，独立运行）：常规套件 / CI 与其它测试文件
 * 并行、机器负载不可控，fsync 抖动会让 ≤10ms / ≤80ms 偶发超限。常规运行只做功能断言（归属正确、无错位、丢弃计数自洽、
 * 取消确实生效、最终排空）并照常打印数字。硬门以独立运行与真机 V11（含 IO 负载）为准，V11 复现超限 ⇒ 启动 T2c。
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureDb, loadSqlite } from "../../src/traffic/db.js";
import { peekEngine, type TrafficEngine } from "../../src/traffic/engine.js";
import { activate, URL_MESSAGES, type Activation } from "./helpers/harness.js";
import { teardownEngine } from "./helpers/engine.js";

const N = 50;
const INTERVAL_MS = 40;
const PAYLOAD_BYTES = 1024 * 1024;
const GATE = { p99IncrementMs: 10, heartbeatMs: 80, cancelMs: 80, drainMs: 5000 };
/** 计时门槛开关（见文件头）。 */
const PERF_GATE = process.env.PI_TRAFFIC_PERF_GATE === "1";
/** 功能模式下「最终能排空」的宽松上限（不是性能门槛）。 */
const IDLE_MS = PERF_GATE ? GATE.drainMs : 20_000;

const results: Record<string, unknown> = {};

/** 1 MiB 的会话 payload：多条消息（更接近真实会话的 stringify 成本，而非单个大字符串）。 */
function bigPayload(i: number): Record<string, unknown> {
  const msgs: Array<{ role: string; content: string }> = [];
  const piece = 4096;
  const count = Math.ceil(PAYLOAD_BYTES / piece);
  for (let k = 0; k < count; k++)
    msgs.push({ role: k % 2 ? "assistant" : "user", content: `${i}:${k}:`.padEnd(piece, "x") });
  return { model: "m", max_tokens: 1024, messages: msgs, req: i };
}

function sseResponse(): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let k = 0; k < 8; k++) c.enqueue(enc.encode(`data: {"k":${k}}\n\n`));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function pct(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? NaN;
}
function median(values: number[]): number {
  return pct(values, 50);
}

function heartbeat(): { stop(): number } {
  let last = performance.now();
  let max = 0;
  const timer = setInterval(() => {
    const t = performance.now();
    max = Math.max(max, t - last);
    last = t;
  }, 5);
  return {
    stop() {
      clearInterval(timer);
      return Math.max(max, performance.now() - last);
    },
  };
}

let dir: string;
let dbPath: string;
let realFetch: typeof globalThis.fetch;
let host: Activation;
/** 并发组：host + 3 个子会话激活（各自 runner）。 */
let actors: Activation[];
let engine: TrafficEngine;
const sentAt = new Map<number, number>();
/** 发送窗口计数（>0 ⇒ 正处在某个请求的「钩子开始 → stub 被调用」窗口内）。 */
let openWindows = 0;
const windowOpenedFor = new Set<number>();
let sendPathDbCalls = 0;

function closeWindow(i: number): void {
  if (windowOpenedFor.delete(i)) openWindows--;
}
const stubFetch = ((input: any, init?: any) => stubFetchImpl(input, init)) as typeof globalThis.fetch;

/** 模拟 pi 的一次会话请求：headers → payload → fetch（stub）→ after → 读完流 → message_end。 */
async function oneRequest(
  i: number,
  bodyText: string,
  payload: Record<string, unknown>,
  hooks: boolean,
  act: Activation | undefined = host,
): Promise<number> {
  const ctx = hooks ? act!.ctx() : undefined;
  const t0 = performance.now();
  windowOpenedFor.add(i);
  openWindows++;
  const headers: Record<string, string | null> = {
    "content-type": "application/json",
    "x-api-key": `k-${act?.sessionId ?? "baseline"}`,
  };
  try {
    if (hooks) {
      await act!.emit("before_provider_headers", { headers }, ctx);
      await act!.emit("before_provider_request", { payload }, ctx);
    }
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (v !== null) h[k] = v;
    const res = await globalThis.fetch(URL_MESSAGES, { method: "POST", headers: h, body: bodyText });
    const latency = (sentAt.get(i) ?? NaN) - t0;
    if (hooks) {
      const rh: Record<string, string> = {};
      res.headers.forEach((v, k) => (rh[k] = v));
      await act!.emit("after_provider_response", { status: res.status, headers: rh }, ctx);
    }
    await res.text();
    if (hooks)
      await act!.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }, ctx);
    return latency;
  } finally {
    closeWindow(i);
  }
}

interface Prepared {
  payload: Record<string, unknown>;
  body: string;
}

function prepare(base: number): Prepared[] {
  const out: Prepared[] = [];
  for (let i = 0; i < N; i++) {
    const payload = bigPayload(base + i);
    out.push({ payload, body: JSON.stringify(payload) }); // pi 的 SDK 同样 stringify（两组共用）
  }
  return out;
}

/** 请求 j（相对 base）由哪个激活发出：串行 = host；并发 4 = actors[j % 4]（每个激活一条串行请求流）。 */
function actorOf(j: number, concurrency: number): Activation {
  return concurrency === 1 ? host : actors[j % concurrency]!;
}

async function runLoad(
  base: number,
  hooks: boolean,
  opts: { concurrency?: number } = {},
): Promise<{ latencies: number[]; heartbeatMaxMs: number; dbCalls: number }> {
  const reqs = prepare(base);
  const concurrency = opts.concurrency ?? 1;
  const latencies: number[] = [];
  const hb = heartbeat();
  const db0 = sendPathDbCalls;
  // 每条流（worker）串行：上一请求完成后，按 INTERVAL_MS 节拍发下一个；并发 = 多条流并行。
  const worker = async (w: number): Promise<void> => {
    for (let j = w; j < N; j += concurrency) {
      const start = performance.now();
      const r = reqs[j]!;
      latencies.push(await oneRequest(base + j, r.body, r.payload, hooks, hooks ? actorOf(j, concurrency) : host));
      const wait = INTERVAL_MS - (performance.now() - start);
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, (_, w) => worker(w)));
  return { latencies, heartbeatMaxMs: hb.stop(), dbCalls: sendPathDbCalls - db0 };
}

function holdLock(ms: number): { done: Promise<void>; conn: DatabaseSync } {
  const { DatabaseSync } = loadSqlite();
  const conn = new DatabaseSync(dbPath);
  conn.exec("PRAGMA busy_timeout = 0");
  conn.exec("BEGIN IMMEDIATE");
  const done = new Promise<void>((resolve) =>
    setTimeout(() => {
      conn.exec("COMMIT");
      conn.close();
      resolve();
    }, ms),
  );
  return { done, conn };
}

function report(name: string, data: Record<string, unknown>): void {
  results[name] = data;
  console.log(`[traffic-gate] ${name} ${JSON.stringify(data)}`);
}

let baselineSerial: number;
let baselineConcurrent: number;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-traffic-gate-"));
  dbPath = join(dir, "traffic.db");
  realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch;
  // 基线：无录制（钩子不注册、不装 tap），同一 harness。
  const warm = await runLoad(9000, false);
  void warm;
  const serial = await runLoad(10_000, false);
  const conc = await runLoad(11_000, false, { concurrency: 4 });
  baselineSerial = median(serial.latencies);
  baselineConcurrent = median(conc.latencies);
  report("mode", { perfGate: PERF_GATE });
  report("baseline", {
    serialMedianMs: +baselineSerial.toFixed(3),
    serialP99Ms: +pct(serial.latencies, 99).toFixed(3),
    concurrentMedianMs: +baselineConcurrent.toFixed(3),
    concurrentP99Ms: +pct(conc.latencies, 99).toFixed(3),
  });
  host = activate({ dbPath, sessionId: "S-gate" });
  await host.commands.get("record")!("on", host.ctx());
  engine = peekEngine()!;
  expect(engine.recording).toBe(true);
  actors = [host, ...[1, 2, 3].map((k) => activate({ role: "child", dbPath, sessionId: `S-gate-c${k}` }))];
  // 发送路径 DB 调用计数：包住引擎连接的 prepare / exec（账本与读端口用同一连接）。
  const db = ensureDb(engine) as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of ["prepare", "exec"]) {
    const orig = db[name]!.bind(db);
    db[name] = (...a: unknown[]) => {
      if (openWindows > 0) sendPathDbCalls++;
      return orig(...a);
    };
  }
}, 60_000);

afterAll(async () => {
  await teardownEngine(engine);
  globalThis.fetch = realFetch;
  if (process.env.TRAFFIC_GATE_JSON) writeFileSync(process.env.TRAFFIC_GATE_JSON, JSON.stringify(results, null, 2));
  rmSync(dir, { recursive: true, force: true });
});

interface ReqRow {
  id: number;
  req: number;
  status: number | null;
  url: string | null;
  session_id: string;
  request_headers: string | null;
}

function requestRows(base: number): ReqRow[] {
  const rows = ensureDb(engine)
    .prepare(
      "SELECT id, CAST(json_extract(payload, '$.req') AS INTEGER) req, status, url, session_id, request_headers FROM requests WHERE CAST(json_extract(payload, '$.req') AS INTEGER) BETWEEN ? AND ? ORDER BY id",
    )
    .all(base, base + N - 1) as unknown as ReqRow[];
  return rows;
}

type Counters = typeof engine.tickets.counters;
function snapCounters(): Counters {
  return { ...engine.tickets.counters };
}

/** 路径断言（安全评审 #9）：每个请求都被精确绑定；落库行归属发出它的会话（线级头也是它自己的凭证）。 */
function assertAttribution(
  name: string,
  base: number,
  concurrency: number,
  before: Counters,
  dbCalls: number,
): { landed: number } {
  const c = engine.tickets.counters;
  const bound = c.ticketsBound - before.ticketsBound;
  const unattributed = c.unattributedPayloads - before.unattributedPayloads;
  const rows = requestRows(base);
  let wrongSession = 0;
  let wrongHeaders = 0;
  for (const r of rows) {
    const act = actorOf(r.req - base, concurrency);
    if (r.session_id !== act.sessionId) wrongSession++;
    if (r.request_headers !== null && JSON.parse(r.request_headers)["x-api-key"] !== `k-${act.sessionId}`)
      wrongHeaders++;
  }
  report(`${name}-attribution`, {
    runners: concurrency === 1 ? 1 : concurrency,
    ticketsBound: bound,
    unattributedPayloads: unattributed,
    generationBumps: c.generationBumps - before.generationBumps,
    tombstonedPayloads: c.tombstonedPayloads - before.tombstonedPayloads,
    landedRows: rows.length,
    wrongSession,
    wrongHeaders,
    sendPathDbCalls: dbCalls,
  });
  expect(bound).toBe(N);
  expect(unattributed).toBe(0);
  expect(c.tombstonedPayloads - before.tombstonedPayloads).toBe(0);
  expect(wrongSession).toBe(0);
  expect(wrongHeaders).toBe(0);
  expect(dbCalls).toBe(0);
  return { landed: rows.length };
}

function gateOf(name: string, latencies: number[], baseline: number, heartbeatMaxMs: number): void {
  const inc = latencies.map((l) => l - baseline);
  const stats = engine.dbPort.stats();
  report(name, {
    n: latencies.length,
    incP50Ms: +pct(inc, 50).toFixed(3),
    incP99Ms: +pct(inc, 99).toFixed(3),
    incMaxMs: +Math.max(...inc).toFixed(3),
    heartbeatMaxMs: +heartbeatMaxMs.toFixed(1),
    maxStmtMs: +stats.maxStmtMs.toFixed(2),
    maxTickMs: +stats.maxTickMs.toFixed(2),
    checkpoints: stats.checkpoints,
    maxCheckpointMs: +stats.maxCheckpointMs.toFixed(2),
    checkpointsDeferred: stats.checkpointsDeferred,
    busyBackoffs: stats.busyBackoffs,
    droppedRows: stats.droppedRows,
  });
  expect(latencies.every(Number.isFinite)).toBe(true);
  if (PERF_GATE) {
    expect(pct(inc, 99)).toBeLessThanOrEqual(GATE.p99IncrementMs);
    expect(heartbeatMaxMs).toBeLessThanOrEqual(GATE.heartbeatMs);
  }
}

describe("§3.2 硬验收门（同线程 DbPort）", () => {
  it("场景 1：第二连接 BEGIN IMMEDIATE 持写锁 3s，期间 50 个 1 MiB 请求（串行 40ms 间隔）；锁释放后 ≤5s 落库、无错位、丢弃数与注入一致", async () => {
    const base = 20_000;
    const before = engine.dbPort.stats();
    const c0 = snapCounters();
    const lock = holdLock(3000);
    const { latencies, heartbeatMaxMs, dbCalls } = await runLoad(base, true);
    gateOf("locked-serial", latencies, baselineSerial, heartbeatMaxMs);
    const mid = engine.dbPort.stats();
    expect(mid.busyBackoffs).toBeGreaterThan(before.busyBackoffs);
    await lock.done;
    const t0 = performance.now();
    expect(await engine.dbPort.whenIdle(IDLE_MS)).toBe(true);
    const drainMs = performance.now() - t0;
    const after = engine.dbPort.stats();
    const rows = requestRows(base);
    const droppedInserts = (after.droppedByKind.insert ?? 0) - (before.droppedByKind.insert ?? 0);
    // 每条落库的行都属于它自己的请求（payload.req 唯一、按注入顺序），状态与 URL 由它自己的 fetch 写入
    const reqs = rows.map((r) => r.req);
    expect(new Set(reqs).size).toBe(reqs.length);
    expect([...reqs].sort((a, b) => a - b)).toEqual(reqs);
    for (const r of rows) {
      expect(r.status === null || r.status === 200).toBe(true);
      expect(r.url === null || r.url === URL_MESSAGES).toBe(true);
    }
    // 注入 50 个请求行 = 落库 + 被丢弃（requests 插入；messages 另计）
    const droppedRequests = N - rows.length;
    report("locked-drain", {
      drainMs: +drainMs.toFixed(1),
      landed: rows.length,
      droppedRequestRows: droppedRequests,
      droppedInsertsAllTables: droppedInserts,
      droppedRowsTotal: after.droppedRows - before.droppedRows,
      orphanOps: after.orphanOps - before.orphanOps,
    });
    if (PERF_GATE) expect(drainMs).toBeLessThanOrEqual(GATE.drainMs);
    const landedMessages = (
      ensureDb(engine).prepare("SELECT COUNT(*) c FROM messages WHERE session_id = 'S-gate'").get() as { c: number }
    ).c;
    expect(droppedInserts).toBe(droppedRequests + (N - landedMessages));
    expect(rows.length).toBeGreaterThan(0);
    assertAttribution("locked-serial", base, 1, c0, dbCalls);
    ensureDb(engine).exec("DELETE FROM messages");
  }, 30_000);

  it("场景 1b：持锁下并发 4（1 主会话 + 3 子会话激活，各自 runner、各自串行流）同样负载；每个请求精确绑定、行归属正确", async () => {
    const c0 = snapCounters();
    const lock = holdLock(3000);
    const { latencies, heartbeatMaxMs, dbCalls } = await runLoad(30_000, true, { concurrency: 4 });
    gateOf("locked-concurrent4", latencies, baselineConcurrent, heartbeatMaxMs);
    await lock.done;
    expect(await engine.dbPort.whenIdle(IDLE_MS)).toBe(true);
    const { landed } = assertAttribution("locked-concurrent4", 30_000, 4, c0, dbCalls);
    expect(landed).toBeGreaterThan(0);
  }, 30_000);

  it("场景 2：无持锁，同样负载 + 同时分页读历史与导出（DbPort.pages，≤200 行/页 + 2ms 预算）", async () => {
    let stop = false;
    let pagesRead = 0;
    let rowsRead = 0;
    const reader = (async () => {
      while (!stop) {
        // 历史列表（不含大字段）
        for await (const page of engine.dbPort.pages({
          table: "requests",
          columns: "id, session_id, status, ts",
          order: "desc",
          limit: 500,
        })) {
          pagesRead++;
          rowsRead += page.length;
          if (stop) break;
        }
        // 导出（含 1 MiB payload）
        for await (const page of engine.dbPort.pages({
          table: "requests",
          columns: "id, payload, request_headers",
          where: "session_id = ?",
          params: ["S-gate"],
        })) {
          pagesRead++;
          // 流式导出：逐行序列化，每行后让出（与 pages 的读预算同口径；真实导出写响应流亦如此）
          for (const row of page) {
            rowsRead += JSON.stringify(row).length > 0 ? 1 : 0;
            await new Promise((r) => setImmediate(r));
          }
          if (stop) break;
        }
        await new Promise((r) => setImmediate(r)); // 空表时 pages 立即返回：读者自身也要让出
      }
    })();
    const c0 = snapCounters();
    const { latencies, heartbeatMaxMs, dbCalls } = await runLoad(40_000, true);
    stop = true;
    await reader;
    gateOf("unlocked-serial+reads", latencies, baselineSerial, heartbeatMaxMs);
    report("unlocked-reads", { pagesRead, rowsRead });
    expect(pagesRead).toBeGreaterThan(0);
    expect(await engine.dbPort.whenIdle(IDLE_MS)).toBe(true);
    expect(assertAttribution("unlocked-serial", 40_000, 1, c0, dbCalls).landed).toBe(N);
  }, 30_000);

  it("场景 2b：无持锁并发 4（1 主 + 3 子会话激活）+ 读", async () => {
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        for await (const page of engine.dbPort.pages({ table: "requests", columns: "id, payload" })) {
          void page;
          if (stop) break;
        }
        await new Promise((r) => setImmediate(r));
      }
    })();
    const c0 = snapCounters();
    const { latencies, heartbeatMaxMs, dbCalls } = await runLoad(50_000, true, { concurrency: 4 });
    stop = true;
    await reader;
    gateOf("unlocked-concurrent4+reads", latencies, baselineConcurrent, heartbeatMaxMs);
    expect(await engine.dbPort.whenIdle(IDLE_MS)).toBe(true);
    // 100 MiB/s 合成负载 + 全表含 payload 的读者：有界缓冲可能 FIFO 丢行（预期行为，计入 droppedRows 并报告）；
    // 断言的是已落库行的归属与发送路径口径，不要求零丢弃。
    expect(assertAttribution("unlocked-concurrent4", 50_000, 4, c0, dbCalls).landed).toBeGreaterThan(0);
  }, 30_000);

  it("取消延迟：持锁 + 账本有待写时，经 tap 的在途 provider 请求 abort() ⇒ fetch reject 与上游连接关闭 ≤80ms", async () => {
    let closedAt = 0;
    let onClosed!: () => void;
    const upstreamClosed = new Promise<void>((r) => (onClosed = r));
    let onHit!: () => void;
    const hit = new Promise<void>((r) => (onHit = r));
    const server: Server = createServer((req, res) => {
      req.resume();
      res.on("close", () => {
        closedAt = performance.now();
        onClosed();
      });
      onHit(); // 永不回响应头
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    // tap 的固定下游是 stub；这里让 stub 对本地 URL 改走真实 fetch（真实 socket）。
    const local = `http://127.0.0.1:${port}/v1/messages`;
    const prevStub = stubFetchImpl;
    stubFetchImpl = (input, init) => (String(input).startsWith(local) ? realFetch(input, init) : prevStub(input, init));
    const lock = holdLock(1500);
    try {
      // 账本里压一批待写（持锁 ⇒ 全在缓冲）
      const warm = prepare(60_000).slice(0, 5);
      for (const [k, r] of warm.entries()) await oneRequest(60_000 + k, r.body, r.payload, true);
      expect(engine.dbPort.stats().queued).toBeGreaterThan(0);
      const hb = heartbeat();
      const ctx = host.ctx({ baseUrl: `http://127.0.0.1:${port}/v1` });
      const headers: Record<string, string | null> = { "content-type": "application/json" };
      await host.emit("before_provider_headers", { headers }, ctx);
      await host.emit("before_provider_request", { payload: { cancel: true } }, ctx);
      const controller = new AbortController();
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) if (v !== null) h[k] = v;
      const p = globalThis.fetch(local, {
        method: "POST",
        headers: h,
        body: '{"cancel":true}',
        signal: controller.signal,
      });
      await hit;
      const t0 = performance.now();
      controller.abort();
      let rejectedAt = 0;
      await p.then(
        () => undefined,
        () => {
          rejectedAt = performance.now();
        },
      );
      await Promise.race([upstreamClosed, new Promise((r) => setTimeout(r, 1000))]);
      const heartbeatMaxMs = hb.stop();
      const rejectMs = rejectedAt - t0;
      const closeMs = closedAt - t0;
      report("cancel", {
        rejectMs: +rejectMs.toFixed(2),
        upstreamCloseMs: +closeMs.toFixed(2),
        heartbeatMaxMs: +heartbeatMaxMs.toFixed(1),
      });
      expect(rejectedAt).toBeGreaterThan(0);
      if (PERF_GATE) expect(rejectMs).toBeLessThanOrEqual(GATE.cancelMs);
      expect(closedAt).toBeGreaterThan(0);
      if (PERF_GATE) expect(closeMs).toBeLessThanOrEqual(GATE.cancelMs);
    } finally {
      stubFetchImpl = prevStub;
      await lock.done;
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    expect(await engine.dbPort.whenIdle(IDLE_MS)).toBe(true);
  }, 30_000);
});

// stub 的实现可在用例里替换（tap 已捕获 stubFetch 作为固定下游，故经一层间接）。
let stubFetchImpl: (input: any, init?: any) => Promise<Response> = async (_input, init) => {
  const body = typeof init?.body === "string" ? init.body : "";
  const m = /"req":(\d+)\}$/.exec(body);
  if (m) sentAt.set(Number(m[1]), performance.now());
  return sseResponse();
};
