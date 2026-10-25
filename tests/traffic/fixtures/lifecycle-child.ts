/**
 * 真子进程驱动（tests/integration/traffic-lifecycle-process.test.ts 使用；plan §3.1 / §4.1 / §8.2 #10）。
 *
 * 用法：node --import tsx lifecycle-child.ts <scenario> [json-args]
 * - off       : import 入口 + wireTraffic（缺省 / enabled:false）⇒ 打印零面证据（fs 调用、sqlite 加载、全局符号、监听器）
 * - on-print  : 对照组——enabled + print 模式 /record on ⇒ 真加载 node:sqlite（证明检测有效）
 * - lifecycle : tui 等价配置 /record on 启动 engine+服务；stdin 指令驱动 quit / reload
 *
 * 输出：每行一个 JSON（stdout）。stderr 由父进程检查 ExperimentalWarning。
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const scenario = process.argv[2] ?? "off";
const args = JSON.parse(process.argv[3] ?? "{}") as { dbPath?: string; upstreamUrl?: string; failChunks?: boolean };

function out(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function fakePi() {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  let calls = 0;
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      calls++;
      handlers.set(event, handler);
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
      calls++;
      commands.set(name, options.handler);
    },
    registerTool: () => {
      calls++;
    },
  };
  return { pi: pi as any, handlers, commands, calls: () => calls };
}

function ctx(mode: string): any {
  return {
    mode,
    model: { api: "anthropic-messages", baseUrl: "https://api.example.test/v1", id: "m", provider: "p" },
    ui: { notify: (m: string) => out({ notify: m.split("\n")[0] }) },
    sessionManager: { getSessionId: () => "s-main" },
    cwd: process.cwd(),
  };
}

function sqliteLoaded(): boolean {
  const list = (process as unknown as { moduleLoadList?: string[] }).moduleLoadList ?? [];
  return list.some((entry) => entry.toLowerCase().includes("sqlite"));
}

async function scenarioOff(): Promise<void> {
  const exitBefore = process.listenerCount("exit");
  const fetchBefore = globalThis.fetch;
  // 先触发 Node 自身的惰性 undici 初始化（首次读 Headers/Request/Response 会挂 undici.globalDispatcher 符号），
  // 再拍符号快照——那不是 traffic 的全局状态。
  void Headers;
  const symbolsBefore = Object.getOwnPropertySymbols(globalThis).map(String);
  const mod = await import("../../../src/traffic/index.js");
  const afterImport = { sqlite: sqliteLoaded(), exit: process.listenerCount("exit") };

  // import 完成后才开始计 fs 调用（模块加载器自身读源码不算）。
  const touched: string[] = [];
  const names = [
    "openSync",
    "readFileSync",
    "writeFileSync",
    "existsSync",
    "statSync",
    "lstatSync",
    "mkdirSync",
    "readdirSync",
    "realpathSync",
    "open",
    "readFile",
    "writeFile",
    "mkdir",
    "stat",
  ] as const;
  const fsAny = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
  const saved = new Map<string, (...a: unknown[]) => unknown>();
  for (const name of names) {
    const orig = fsAny[name];
    if (typeof orig !== "function") continue;
    saved.set(name, orig);
    fsAny[name] = function patched(this: unknown, ...a: unknown[]) {
      touched.push(`${name}:${String(a[0])}`);
      return orig.apply(this, a);
    };
  }
  syncBuiltinESMExports();
  const a = fakePi();
  const b = fakePi();
  const c = fakePi();
  const r1 = mod.wireTraffic(a.pi);
  const r2 = mod.wireTraffic(b.pi, { enabled: false });
  const r3 = mod.wireTraffic(c.pi, { enabled: false, role: "child" });
  for (const [name, orig] of saved) fsAny[name] = orig;
  syncBuiltinESMExports();

  const symbolsAfter = Object.getOwnPropertySymbols(globalThis).map(String);
  out({
    scenario: "off",
    returned: [r1 === undefined, r2 === undefined, r3 === undefined],
    registrations: a.calls() + b.calls() + c.calls(),
    fsCalls: touched,
    sqliteAfterImport: afterImport.sqlite,
    sqliteAfterWire: sqliteLoaded(),
    exitListenersDelta: process.listenerCount("exit") - exitBefore,
    exitDeltaAfterImport: afterImport.exit - exitBefore,
    newSymbols: symbolsAfter.filter((s) => !symbolsBefore.includes(s)),
    fetchUnchanged: globalThis.fetch === fetchBefore,
  });
}

async function scenarioOnPrint(): Promise<void> {
  const mod = await import("../../../src/traffic/index.js");
  const p = fakePi();
  mod.wireTraffic(p.pi, { enabled: true, dbPath: args.dbPath!, legacyDbPath: null });
  const before = sqliteLoaded();
  await p.commands.get("record")!("on", ctx("print"));
  const after = sqliteLoaded();
  for (let i = 0; i < 3; i++) {
    await p.handlers.get("before_provider_request")!({ payload: { i } }, ctx("print"));
    p.handlers.get("message_end")!({ message: { role: "assistant", content: `r${i}` } }, ctx("print"));
  }
  const engineMod = await import("../../../src/traffic/engine.js");
  const dbMod = await import("../../../src/traffic/db.js");
  const engine = engineMod.peekEngine()!;
  const rows = (dbMod.ensureDb(engine).prepare("SELECT COUNT(*) c FROM requests").get() as { c: number }).c;
  // 不调 session_shutdown：print 模式无 listener / ref'd 定时器，事件循环必须自然退出。
  out({
    scenario: "on-print",
    sqliteBefore: before,
    sqliteAfter: after,
    dbExists: fs.existsSync(args.dbPath!),
    rows,
    server: engine.server !== null,
    resources: process.getActiveResourcesInfo(),
  });
}

async function scenarioLifecycle(): Promise<void> {
  const mod = await import("../../../src/traffic/index.js");
  const engineMod = await import("../../../src/traffic/engine.js");
  const dbMod = await import("../../../src/traffic/db.js");
  const dbPath = args.dbPath!;

  const start = async (tag: string): Promise<{ handlers: Map<string, (e: any, c: any) => unknown> }> => {
    const p = fakePi();
    mod.wireTraffic(p.pi, { enabled: true, owner: {}, dbPath, legacyDbPath: null });
    await p.commands.get("record")!("on", ctx("tui"));
    const engine = engineMod.peekEngine()!;
    const srcId = Number(
      dbMod
        .ensureDb(engine)
        .prepare(
          "INSERT INTO requests (session_id, turn, ts, payload, request_headers, url, method) VALUES ('s', 0, 't', '{}', '{}', ?, 'POST')",
        )
        .run(args.upstreamUrl!).lastInsertRowid,
    );
    if (args.failChunks) {
      // 注入：流式 chunk 落库一律失败（模拟磁盘满 / 约束错误）。
      dbMod
        .ensureDb(engine)
        .exec(
          "CREATE TRIGGER IF NOT EXISTS fail_chunks BEFORE INSERT ON stream_chunks BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
        );
    }
    // T4：/api/* 一律要 token（回环亦然）——把 token 一并交给父进程。
    out({ event: "ready", tag, port: engine.serverPort, srcId, epoch: engine.epoch, token: engine.accessToken });
    return { handlers: p.handlers };
  };

  let current = await start("first");
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      void handle(line);
    }
  });

  async function handle(line: string): Promise<void> {
    if (line === "quit") {
      const engine = engineMod.peekEngine()!;
      const t0 = Date.now();
      await current.handlers.get("session_shutdown")!({ reason: "quit" }, ctx("tui"));
      out({
        event: "shutdown",
        reason: "quit",
        state: engine.state,
        ms: Date.now() - t0,
        cancelSize: engine.cancel.size(),
        connections: engine.connections.size,
      });
      // quit：不再持有 stdin，让事件循环自然退出（任何残留 ref'd handle 都会让父进程判超时）。
      process.stdin.pause();
      process.stdin.removeAllListeners("data");
      (process.stdin as unknown as { unref?: () => void }).unref?.();
      return;
    }
    if (line === "reload") {
      const old = engineMod.peekEngine()!;
      const t0 = Date.now();
      await current.handlers.get("session_shutdown")!({ reason: "reload" }, ctx("tui"));
      const oldState = old.state;
      current = await start("reloaded");
      const fresh = engineMod.peekEngine()!;
      out({
        event: "reloaded",
        oldState,
        ms: Date.now() - t0,
        freshState: fresh.state,
        freshEpoch: fresh.epoch,
        oldEpoch: old.epoch,
        oldCancelSize: old.cancel.size(),
      });
      return;
    }
    if (line === "resources") {
      out({ event: "resources", list: process.getActiveResourcesInfo() });
    }
  }
}

process.on("exit", (code) => {
  try {
    fs.writeSync(1, `${JSON.stringify({ event: "exit", code })}\n`);
  } catch {}
});

const run = scenario === "off" ? scenarioOff : scenario === "on-print" ? scenarioOnPrint : scenarioLifecycle;
void run().catch((err) => {
  out({ event: "error", message: String(err instanceof Error ? (err.stack ?? err.message) : err) });
  process.exitCode = 1;
});
