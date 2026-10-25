/**
 * #10 真子进程（traffic-merge plan §3.1 / §4.1 / §8.2 #10）。
 *
 * 1. traffic off：子进程 import 入口并以缺省 / enabled:false 调 wireTraffic（主 + 子各一次）⇒ stderr 无
 *    ExperimentalWarning / SQLite、node:sqlite 未加载、零注册、wire 期间零 fs 调用、无新全局符号、
 *    exit 监听不变、HOME 下不出现 .pi。对照组 on-print 证明同一检测在真加载时为真。
 * 2. 生命周期：子进程以 tui 等价配置 /record on（engine + 服务）；父进程挂一个 SSE 连接；经 /api/replay
 *    发起重放到「永不回响应头」与「回头后永不结束流」两个本地上游（有活动出站请求）；分别触发 quit
 *    （session_shutdown reason=quit 后让事件循环自然退出）与 reload（reason=reload 后重新创建 engine）
 *    ⇒ 均在 3s 内完成，上游观察到连接被中止，SSE 被断开，进程无残留 handle（自然退出）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CHILD = resolve(__dirname, "../traffic/fixtures/lifecycle-child.ts");
const REPO = resolve(__dirname, "../..");

let home: string;
const cleanups: Array<() => void | Promise<void>> = [];

interface Child {
  proc: ChildProcessWithoutNullStreams;
  stderr: () => string;
  next: (pred: (msg: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
  exited: Promise<{ code: number | null; at: number }>;
}

function startChild(scenario: string, args: Record<string, unknown> = {}): Child {
  const proc = spawn(process.execPath, ["--import", "tsx", CHILD, scenario, JSON.stringify(args)], {
    cwd: REPO,
    env: { ...process.env, HOME: home, NODE_OPTIONS: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let buffer = "";
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    pred: (m: Record<string, unknown>) => boolean;
    resolve: (m: Record<string, unknown>) => void;
  }> = [];
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d: string) => {
    stderr += d;
  });
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (d: string) => {
    buffer += d;
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      messages.push(msg);
      for (const w of waiters.splice(0)) {
        if (w.pred(msg)) w.resolve(msg);
        else waiters.push(w);
      }
    }
  });
  const exited = new Promise<{ code: number | null; at: number }>((res) => {
    proc.once("exit", (code) => res({ code, at: Date.now() }));
  });
  cleanups.push(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  });
  return {
    proc,
    stderr: () => stderr,
    exited,
    next(pred, timeoutMs = 15_000) {
      const hit = messages.find(pred);
      if (hit) {
        messages.splice(messages.indexOf(hit), 1);
        return Promise.resolve(hit);
      }
      return new Promise((res, rej) => {
        const timer = setTimeout(
          () => rej(new Error(`child timeout; stderr=${stderr}; seen=${JSON.stringify(messages)}`)),
          timeoutMs,
        );
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(timer);
            messages.splice(messages.indexOf(m), 1);
            res(m);
          },
        });
      });
    },
  };
}

interface Upstream {
  url: string;
  hit: Promise<void>;
  aborted: Promise<number>;
  server: Server;
}

/** 本地上游：`never-headers` 永不回响应头；`hang-stream` 回 200 event-stream 头后永不结束。 */
async function startUpstream(kind: "never-headers" | "hang-stream"): Promise<Upstream> {
  let onHit!: () => void;
  let onAbort!: (at: number) => void;
  const hit = new Promise<void>((r) => (onHit = r));
  const aborted = new Promise<number>((r) => (onAbort = r));
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    onHit();
    res.on("close", () => onAbort(Date.now()));
    if (kind === "hang-stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"a":1}\n\n');
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return { url: `http://127.0.0.1:${port}/v1/messages`, hit, aborted, server };
}

/** 父进程挂一个 SSE 连接；返回「被服务端断开」的 promise（包一层对象，避免 async 返回值被展平）。 */
async function holdSse(port: number, token?: string): Promise<{ closed: Promise<void> }> {
  // T4：/api/* 要 token（回环亦然）；SSE 用 ?token= 查询（EventSource 无法带自定义头）。
  const res = await fetch(`http://127.0.0.1:${port}/api/events${token ? `?token=${token}` : ""}`);
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  await reader.read(); // retry: 2000
  const closed = (async () => {
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) return;
      }
    } catch {
      return;
    }
  })();
  return { closed };
}

function fireReplay(port: number, srcId: number, token?: string): void {
  // T4：状态变更请求必须经 x-record-token 头携带 token。
  void fetch(`http://127.0.0.1:${port}/api/replay`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-record-token": token } : {}) },
    body: JSON.stringify({ request_id: srcId }),
  })
    .then((r) => r.text())
    .catch(() => undefined);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pi-traffic-proc-"));
});

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  rmSync(home, { recursive: true, force: true });
});

describe("traffic off：零注册、零 IO、不加载 node:sqlite", () => {
  it("import + wireTraffic(缺省 / enabled:false, 主+子) ⇒ 无 ExperimentalWarning、零面", async () => {
    const child = startChild("off");
    const report = await child.next((m) => m.scenario === "off");
    const exit = await child.exited;
    expect(exit.code).toBe(0);
    expect(report).toMatchObject({
      returned: [true, true, true],
      registrations: 0,
      fsCalls: [],
      sqliteAfterImport: false,
      sqliteAfterWire: false,
      exitListenersDelta: 0,
      exitDeltaAfterImport: 0,
      newSymbols: [],
      fetchUnchanged: true,
    });
    expect(child.stderr()).not.toMatch(/ExperimentalWarning|SQLite/i);
    expect(existsSync(join(home, ".pi"))).toBe(false);
    expect(readdirSync(home)).toEqual([]);
  }, 30_000);

  it("对照组 / print 等价配置：/record on 才加载 sqlite（一次 ExperimentalWarning）；录制若干请求、无 listener，不 shutdown 也自然退出", async () => {
    const dbPath = join(home, "t.db");
    const child = startChild("on-print", { dbPath });
    const report = await child.next((m) => m.scenario === "on-print");
    const exit = await child.exited;
    expect(exit.code).toBe(0);
    // 子进程内的 `rows` 只是「write-behind 队列刚被读到时」的瞬时值（ledger 由 setImmediate tick 落库，
    // 与读取谁先谁后取决于调度，高并发下会读到 0）——不在子进程里断言；确定性证据是：进程自然退出之后
    // 磁盘上确有 3 行（即 print 模式无 shutdown 也不丢记录）。
    expect(report).toMatchObject({ sqliteBefore: false, sqliteAfter: true, dbExists: true, server: false });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect((db.prepare("SELECT COUNT(*) c FROM requests").get() as { c: number }).c).toBe(3);
    } finally {
      db.close();
    }
    expect(child.stderr().match(/ExperimentalWarning/g)?.length).toBe(1);
  }, 30_000);
});

describe.each(["never-headers", "hang-stream"] as const)("生命周期：上游 %s", (kind) => {
  it("quit：session_shutdown 中止在途重放、断开 SSE，3s 内事件循环自然退出", async () => {
    const upstream = await startUpstream(kind);
    const child = startChild("lifecycle", { dbPath: join(home, "t.db"), upstreamUrl: upstream.url });
    const ready = await child.next((m) => m.event === "ready");
    const port = ready.port as number;
    const token = ready.token as string | undefined;
    const sse = await holdSse(port, token);
    fireReplay(port, ready.srcId as number, token);
    await upstream.hit;
    await new Promise((r) => setTimeout(r, 50));

    const t0 = Date.now();
    child.proc.stdin.write("quit\n");
    const shut = await child.next((m) => m.event === "shutdown");
    expect(shut).toMatchObject({ state: "closed", cancelSize: 0, connections: 0 });
    const abortedAt = await upstream.aborted;
    expect(abortedAt - t0).toBeLessThan(3000);
    await sse.closed;
    const exit = await child.exited;
    expect(exit.code).toBe(0);
    expect(exit.at - t0).toBeLessThan(3000);
  }, 30_000);

  it("reload：session_shutdown 中止在途重放，新 engine 新纪元接管，随后 quit 仍 3s 内自然退出", async () => {
    const upstream = await startUpstream(kind);
    const child = startChild("lifecycle", { dbPath: join(home, "t.db"), upstreamUrl: upstream.url });
    const ready = await child.next((m) => m.event === "ready");
    const port = ready.port as number;
    const token = ready.token as string | undefined;
    const sse = await holdSse(port, token);
    fireReplay(port, ready.srcId as number, token);
    await upstream.hit;
    await new Promise((r) => setTimeout(r, 50));

    const t0 = Date.now();
    child.proc.stdin.write("reload\n");
    const reloaded = await child.next((m) => m.event === "reloaded");
    expect(reloaded).toMatchObject({ oldState: "closed", freshState: "open", oldCancelSize: 0 });
    expect(reloaded.freshEpoch as number).toBeGreaterThan(reloaded.oldEpoch as number);
    expect((reloaded.ms as number) < 3000).toBe(true);
    const abortedAt = await upstream.aborted;
    expect(abortedAt - t0).toBeLessThan(3000);
    await sse.closed;
    const second = await child.next((m) => m.event === "ready" && m.tag === "reloaded");
    expect(second.port).toEqual(expect.any(Number));

    const t1 = Date.now();
    child.proc.stdin.write("quit\n");
    await child.next((m) => m.event === "shutdown");
    const exit = await child.exited;
    expect(exit.code).toBe(0);
    expect(exit.at - t1).toBeLessThan(3000);
  }, 30_000);
});

describe("生命周期：流式落库抛错（安全评审 #3）", () => {
  it("chunk INSERT 失败 ⇒ 上游在 shutdown 前即被中止；随后 quit 3s 内自然退出", async () => {
    const upstream = await startUpstream("hang-stream");
    const child = startChild("lifecycle", {
      dbPath: join(home, "t.db"),
      upstreamUrl: upstream.url,
      failChunks: true,
    });
    const ready = await child.next((m) => m.event === "ready");
    const t0 = Date.now();
    fireReplay(ready.port as number, ready.srcId as number, ready.token as string | undefined);
    await upstream.hit;
    const abortedAt = await Promise.race([
      upstream.aborted,
      new Promise<number>((_, rej) =>
        setTimeout(() => rej(new Error("upstream not aborted after insert failure")), 3000),
      ),
    ]);
    expect(abortedAt - t0).toBeLessThan(3000);
    const t1 = Date.now();
    child.proc.stdin.write("quit\n");
    const shut = await child.next((m) => m.event === "shutdown");
    expect(shut).toMatchObject({ state: "closed", cancelSize: 0 });
    const exit = await child.exited;
    expect(exit.code).toBe(0);
    expect(exit.at - t1).toBeLessThan(3000);
  }, 30_000);
});
