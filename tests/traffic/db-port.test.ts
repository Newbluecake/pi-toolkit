/**
 * 写后账本（db-port.ts，plan §3.2）单元：busy_timeout=0 下的退避让出、每 tick 预算、行补丁合并、有界缓冲 + 溢出计数、
 * 丢弃插入后依赖写不错位、chunk 合并批、独占 checkpoint tick、延迟物化（持锁期间也物化以让字节上限生效）、
 * keyset 分页读。真 SQLite（第二连接持锁）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInThreadDbPort, lazyText, newRowRef, textBytes, type DbPort } from "../../src/traffic/db-port.js";
import { loadSqlite, openDb } from "../../src/traffic/db.js";
import { walFileBytes } from "../../src/traffic/engine.js";

let dir: string;
let path: string;
let db: DatabaseSync;
let port: DbPort;
let gateOpen: boolean;
const errors: unknown[] = [];

function make(opts: Partial<Parameters<typeof createInThreadDbPort>[0]> = {}): DbPort {
  return createInThreadDbPort({
    getDb: () => db,
    gate: () => gateOpen,
    onError: (e) => errors.push(e),
    walSize: () => walFileBytes(path),
    ...opts,
  });
}

function insert(p: DbPort, payload: string | ReturnType<typeof lazyText>, epoch = 1) {
  const ref = newRowRef();
  p.enqueue({
    kind: "insert",
    epoch,
    table: "requests",
    values: { session_id: "s", turn: 0, ts: "t", payload },
    ref,
    bytes: 64 + (typeof payload === "string" ? payload.length : 0),
  });
  return ref;
}

function count(table = "requests"): number {
  return (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
}

function lock(): DatabaseSync {
  const { DatabaseSync } = loadSqlite();
  const other = new DatabaseSync(path);
  other.exec("PRAGMA busy_timeout = 0");
  other.exec("BEGIN IMMEDIATE");
  return other;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-traffic-dbport-"));
  path = join(dir, "traffic.db");
  db = openDb(path, { legacyDbPath: null });
  gateOpen = true;
  errors.length = 0;
  port = make();
});

afterEach(async () => {
  await port.close(200);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("基本落库与合并", () => {
  it("openDb 设 busy_timeout=0；插入在 setImmediate tick 落库，onDone 拿到 rowId", async () => {
    expect((db.prepare("PRAGMA busy_timeout").get() as Record<string, number>).timeout).toBe(0);
    let got: number | null = null;
    const ref = newRowRef();
    port.enqueue({
      kind: "insert",
      epoch: 1,
      table: "requests",
      values: { session_id: "s", turn: 0, ts: "t", payload: "{}" },
      ref,
      bytes: 80,
      onDone: (id) => (got = id),
    });
    expect(count()).toBe(0); // 不在调用栈内同步写
    expect(await port.whenIdle()).toBe(true);
    expect(count()).toBe(1);
    expect(got).toBe(ref.rowId);
  });

  it("插入未执行前到达的补丁并入同一条 INSERT；之后的补丁合并为一个 UPDATE（coalesce 列保留已有值）", async () => {
    const ref = insert(port, "{}");
    port.patch(1, ref, "requests", { url: "u1", request_headers: "h1" });
    await port.whenIdle();
    port.patch(1, ref, "requests", { status: 400, request_headers: null }, { coalesce: ["request_headers"] });
    port.patch(1, ref, "requests", { status: 200 });
    const before = port.stats().ticks;
    await port.whenIdle();
    expect(port.stats().ticks - before).toBe(1);
    expect(db.prepare("SELECT url, status, request_headers FROM requests").get()).toEqual({
      url: "u1",
      status: 200,
      request_headers: "h1",
    });
  });

  it("闸口拒绝（纪元不符 / secure）⇒ 执行前丢弃，不写", async () => {
    gateOpen = false;
    insert(port, "{}");
    await port.whenIdle();
    expect(count()).toBe(0);
  });

  it("语句错误只影响该条（onFail + writeErrors），同 tick 其它条目照常提交", async () => {
    db.exec("CREATE TRIGGER bad BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'nope'); END;");
    let failed = false;
    insert(port, "{}");
    port.enqueue({
      kind: "sql",
      epoch: 1,
      sql: "INSERT INTO messages (session_id, turn, ts, role, message) VALUES ('s',0,'t','r','m')",
      params: [],
      rows: 1,
      bytes: 10,
      onFail: () => (failed = true),
    });
    insert(port, "{}");
    await port.whenIdle();
    expect(count()).toBe(2);
    expect(failed).toBe(true);
    expect(port.stats().writeErrors).toBe(1);
  });
});

describe("锁竞争", () => {
  it("第二连接持锁 ⇒ BEGIN IMMEDIATE 立即 BUSY、退避让出（无同步等待），释放后补齐", async () => {
    const other = lock();
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) insert(port, `{"i":${i}}`);
    await new Promise((r) => setTimeout(r, 120));
    const s = port.stats();
    expect(s.busyBackoffs).toBeGreaterThanOrEqual(2);
    expect(s.backoffMs).toBeGreaterThanOrEqual(10);
    expect(s.queued).toBe(5);
    expect(count()).toBe(0);
    other.exec("COMMIT");
    other.close();
    expect(await port.whenIdle(2000)).toBe(true);
    expect(count()).toBe(5);
    expect(port.stats().backoffMs).toBe(0);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("有界：超过条数上限 FIFO 丢最旧并计数；被丢插入的依赖补丁 / chunk 跳过（orphanOps），不写到别的行", async () => {
    port = make({ maxEntries: 4 });
    const other = lock();
    const refs = [insert(port, '{"a":1}'), insert(port, '{"a":2}')];
    port.chunk(1, refs[0]!, "s", { seq: 0, ts: "t", elapsedMs: 0, data: "x" });
    insert(port, '{"a":3}');
    insert(port, '{"a":4}'); // 第 5 条 ⇒ 丢最旧（refs[0] 的插入）
    expect(refs[0]!.dropped).toBe(true);
    port.patch(1, refs[0]!, "requests", { status: 200 });
    other.exec("COMMIT");
    other.close();
    await port.whenIdle(2000);
    const rows = db.prepare("SELECT payload, status FROM requests ORDER BY id").all() as Array<{
      payload: string;
      status: number | null;
    }>;
    expect(rows.map((r) => r.payload)).toEqual(['{"a":2}', '{"a":3}', '{"a":4}']);
    expect(rows.every((r) => r.status === null)).toBe(true);
    expect(count("stream_chunks")).toBe(0);
    const s = port.stats();
    expect(s.droppedRows).toBe(1);
    expect(s.droppedByKind.insert).toBe(1);
    expect(s.orphanOps).toBeGreaterThanOrEqual(2);
  });

  it("字节上限：持锁期间延迟值也会被物化（独立 tick，不需要锁），真实大小触发 FIFO 丢弃", async () => {
    port = make({ maxBytes: 3 * 1024 * 1024 });
    const other = lock();
    const big = "x".repeat(1024 * 1024);
    for (let i = 0; i < 6; i++)
      insert(
        port,
        lazyText(() => JSON.stringify({ i, big })),
      );
    await new Promise((r) => setTimeout(r, 100));
    const s = port.stats();
    expect(s.queuedBytes).toBeLessThanOrEqual(3 * 1024 * 1024 + 1024);
    expect(s.droppedByKind.insert).toBeGreaterThanOrEqual(3);
    other.exec("COMMIT");
    other.close();
    await port.whenIdle(3000);
    const ids = (
      db.prepare("SELECT json_extract(payload, '$.i') i FROM requests ORDER BY id").all() as Array<{ i: number }>
    ).map((r) => r.i);
    expect(ids).toEqual(ids.slice().sort((a, b) => a - b));
    expect(ids.at(-1)).toBe(5); // 丢的是最旧
    expect(ids.length + (port.stats().droppedByKind.insert ?? 0)).toBe(6);
  });
});

describe("预算", () => {
  it("每 tick ≤2ms：大量小条目被切成多个 tick；>256 KiB 条目独占一个 tick", async () => {
    for (let i = 0; i < 500; i++) insert(port, `{"i":${i}}`);
    await port.whenIdle(5000);
    expect(count()).toBe(500);
    expect(port.stats().ticks).toBeGreaterThan(1);
    const before = port.stats().ticks;
    const big = "y".repeat(300 * 1024);
    insert(port, "{}");
    insert(port, JSON.stringify({ big }));
    insert(port, "{}");
    await port.whenIdle();
    expect(port.stats().ticks - before).toBe(3);
  });

  it("每写入 ≥1 MiB 做一次独占 tick 的 PASSIVE checkpoint；本连接关闭自动 checkpoint", async () => {
    const big = "z".repeat(600 * 1024);
    for (let i = 0; i < 4; i++) insert(port, JSON.stringify({ i, big }));
    await port.whenIdle();
    insert(port, "{}");
    await port.whenIdle();
    expect(port.stats().checkpoints).toBeGreaterThanOrEqual(1);
    expect((db.prepare("PRAGMA wal_autocheckpoint").get() as Record<string, number>).wal_autocheckpoint).toBe(0);
  });

  it("chunk 合并：同一行 64 块封一批（一个条目），流结束 sealChunks 后落库并回调", async () => {
    const ref = insert(port, "{}");
    for (let i = 0; i < 70; i++) port.chunk(1, ref, "s", { seq: i, ts: "t", elapsedMs: i, data: `d${i}` });
    expect(port.stats().queued).toBe(3); // insert + 满 64 的批 + 6 块的开放批
    let doneId: number | null = null;
    port.sealChunks(1, ref, (id) => (doneId = id));
    await port.whenIdle();
    expect(count("stream_chunks")).toBe(70);
    expect(doneId).toBe(ref.rowId);
  });
});

describe("分页读", () => {
  it("keyset 分页 ≤200 行/页，asc/desc/where/limit；页间让出", async () => {
    for (let i = 0; i < 450; i++) insert(port, `{"i":${i}}`);
    await port.whenIdle(5000);
    const sizes: number[] = [];
    for await (const page of port.pages({ table: "requests", columns: "id, payload" })) sizes.push(page.length);
    expect(sizes.every((n) => n <= 200)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(450);
    const desc = await port.query({ table: "requests", columns: "id", order: "desc", limit: 5 }, 1000);
    expect(desc.map((r) => r.id)).toEqual([450, 449, 448, 447, 446]);
    const where = await port.query({ table: "requests", columns: "id", where: "id <= ?", params: [3] }, 1000);
    expect(where).toHaveLength(3);
  });

  it("单页内按 2ms 预算提前切页（大行）", async () => {
    const big = "w".repeat(512 * 1024);
    for (let i = 0; i < 12; i++) insert(port, JSON.stringify({ i, big }));
    await port.whenIdle(5000);
    const sizes: number[] = [];
    for await (const page of port.pages({ table: "requests", columns: "id, payload" })) sizes.push(page.length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(12);
    expect(sizes.length).toBeGreaterThan(1);
  });
});

describe("关闭", () => {
  it("close(deadline) 有界排空已接纳条目；持锁时到期丢弃剩余并计数", async () => {
    insert(port, "{}");
    await port.close(500);
    expect(count()).toBe(1);
    port = make();
    const other = lock();
    insert(port, "{}");
    const t0 = performance.now();
    await port.close(150);
    expect(performance.now() - t0).toBeLessThan(800);
    expect(port.stats().droppedRows).toBe(1);
    other.exec("COMMIT");
    other.close();
    expect(count()).toBe(1);
  });
});

describe("分页读防呆", () => {
  it("columns 不含 id ⇒ 明确报错（不静默丢行）", async () => {
    insert(port, "{}");
    await port.whenIdle();
    await expect(port.query({ table: "requests", columns: "payload" }, 1000)).rejects.toThrow("必须包含整数 id");
  });
});

describe("安全评审修复", () => {
  it("#2 闸口回调同步触发 close() ⇒ 不重入同一队列排空（无未捕获异常），条目按闸口语义丢弃", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown): void => {
      uncaught.push(e);
    };
    process.on("uncaughtException", onUncaught);
    try {
      let calls = 0;
      // 模拟修复前 drainAllowed 的行为：secure 命中时同步 close 并拒绝。
      port = make({
        gate: () => {
          calls++;
          if (calls === 1) void port.close(100);
          return false;
        },
      });
      insert(port, '{"a":1}');
      insert(port, '{"a":2}');
      await new Promise((r) => setTimeout(r, 30));
      expect(uncaught).toEqual([]);
      expect(count()).toBe(0);
      expect(port.stats().queued).toBe(0);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("#5 字节口径为 UTF-8：中文按 3 字节/字计（不是 UTF-16 码元数）", () => {
    expect(textBytes("中")).toBe(3);
    expect(textBytes("a中")).toBe(4);
    expect("中".repeat(10).length).toBe(10);
    expect(textBytes("中".repeat(10))).toBe(30);
  });

  it("#5 持锁下行补丁合并膨胀 ⇒ 立即按同一限额 FIFO 丢最旧，缓冲 ≤ maxBytes", () => {
    const maxBytes = 1024 * 1024;
    port = make({ maxBytes });
    const other = lock();
    try {
      const a = insert(port, "{}");
      const b = insert(port, "{}");
      port.patch(1, b, "requests", { orig_payload: "b".repeat(700 * 1024) });
      expect(port.stats().queuedBytes).toBeLessThanOrEqual(maxBytes);
      port.patch(1, a, "requests", { orig_payload: "a".repeat(500 * 1024) }); // 合计 > 1 MiB
      const s = port.stats();
      expect(s.queuedBytes).toBeLessThanOrEqual(maxBytes);
      expect(a.dropped).toBe(true); // 最旧（a 的插入）被丢
      expect(b.dropped).toBe(false);
      expect(s.droppedByKind.insert).toBe(1);
    } finally {
      other.exec("COMMIT");
      other.close();
    }
  });

  it("#5 持锁下 chunk 批追加膨胀超过单条上限 ⇒ 该批按 oversize 丢弃并 onFail（读流取消），缓冲 ≤ maxBytes", () => {
    const maxBytes = 1024 * 1024;
    port = make({ maxBytes });
    const other = lock();
    try {
      const ref = insert(port, "{}");
      let failed = 0;
      const chunk = "c".repeat(64 * 1024);
      for (let i = 0; i < 20; i++)
        port.chunk(1, ref, "s", { seq: i, ts: "t", elapsedMs: i, data: chunk }, () => failed++);
      const s = port.stats();
      expect(s.queuedBytes).toBeLessThanOrEqual(maxBytes);
      expect(s.droppedByKind.oversize).toBeGreaterThanOrEqual(1);
      expect(failed).toBeGreaterThanOrEqual(1);
    } finally {
      other.exec("COMMIT");
      other.close();
    }
  });

  it("#5 单条 9 MiB（> 8 MiB 缺省上限）⇒ 丢弃并计 oversize，不再作为「唯一条目」例外保留", async () => {
    const ref = insert(port, "x".repeat(9 * 1024 * 1024));
    const s = port.stats();
    expect(ref.dropped).toBe(true);
    expect(s.queued).toBe(0);
    expect(s.queuedBytes).toBe(0);
    expect(s.droppedByKind.oversize).toBe(1);
    await port.whenIdle();
    expect(count()).toBe(0);
  });

  it("#5 延迟物化的中文 payload 按 UTF-8 字节计入上限（length 只有 1/3）", async () => {
    const maxBytes = 1024 * 1024;
    port = make({ maxBytes });
    const other = lock();
    try {
      const text = "中".repeat(400 * 1024); // length 400 Ki，UTF-8 1.2 MiB
      expect(text.length).toBeLessThan(maxBytes);
      const ref = insert(
        port,
        lazyText(() => text),
      );
      await new Promise((r) => setTimeout(r, 30)); // 物化 tick（不需要锁）
      expect(ref.dropped).toBe(true);
      expect(port.stats().droppedByKind.oversize).toBe(1);
      expect(port.stats().queuedBytes).toBe(0);
    } finally {
      other.exec("COMMIT");
      other.close();
    }
  });

  it("#6 / 裁定 B1：长读事务钉住快照 ⇒ WAL 积压；现场 stat 的 -wal > 2 MiB ⇒ 不在主线程 checkpoint（释放读者后也不一次复制全部积压）", async () => {
    port = make({ checkpointBytes: 1024 * 1024, checkpointMaxBytes: 2 * 1024 * 1024 });
    const { DatabaseSync } = loadSqlite();
    const reader = new DatabaseSync(path);
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) c FROM requests").get(); // 取得读快照
    const big = "p".repeat(1024 * 1024);
    for (let i = 0; i < 16; i++) {
      insert(port, JSON.stringify({ i, big }));
      await port.whenIdle(5000);
    }
    expect(walFileBytes(path)!).toBeGreaterThan(8 * 1024 * 1024); // 读者挡住了 checkpoint 推进
    reader.exec("COMMIT");
    reader.close();
    for (let i = 0; i < 4; i++) {
      insert(port, JSON.stringify({ i: 100 + i, big }));
      await port.whenIdle(5000);
    }
    const s = port.stats();
    expect(s.checkpointsDeferred).toBeGreaterThan(0);
    expect(s.walBytes!).toBeGreaterThan(2 * 1024 * 1024);
    // 修复前：释放后第一次 PASSIVE 复制 ≥16 MiB 积压（实测 45ms）。
    expect(s.maxCheckpointMs).toBeLessThan(10);
    expect(count()).toBe(20);
  }, 30_000);

  it("裁定 B1：外部连接写入大量 WAL（本连接从未 checkpoint 过 = 首次积压）⇒ 主线程不执行 checkpoint，跳过并计数", async () => {
    const { DatabaseSync } = loadSqlite();
    const ext = new DatabaseSync(path);
    ext.exec("PRAGMA wal_autocheckpoint = 0");
    const blob = "e".repeat(256 * 1024);
    const stmt = ext.prepare(
      "INSERT INTO messages (session_id, turn, ts, role, message) VALUES ('ext', 0, 't', 'user', ?)",
    );
    for (let i = 0; i < 24; i++) stmt.run(blob); // ≈6 MiB WAL，由另一连接写入
    ext.close(); // 不是最后一个连接（db 仍开着）⇒ 不会在关闭时 checkpoint
    const before = walFileBytes(path)!;
    expect(before).toBeGreaterThan(4 * 1024 * 1024);
    port = make({ checkpointBytes: 1024 * 1024, checkpointMaxBytes: 2 * 1024 * 1024 });
    const big = "q".repeat(600 * 1024);
    for (let i = 0; i < 4; i++) {
      insert(port, JSON.stringify({ i, big }));
      await port.whenIdle(5000);
    }
    const s = port.stats();
    // 修复前（按上次 checkpoint 结果估算，初值 0）：首次触发就同步 checkpoint 全部 ≈6 MiB 外部积压。
    expect(s.checkpoints).toBe(0);
    expect(s.checkpointsDeferred).toBeGreaterThan(0);
    expect(s.walBytes!).toBeGreaterThanOrEqual(before);
    expect(count()).toBe(4);
  }, 30_000);

  it("裁定 B1：stat 失败 / 未提供 walSize ⇒ 无法证明有界 ⇒ 不 checkpoint（fail closed）", async () => {
    port = make({ walSize: () => null });
    const big = "r".repeat(700 * 1024);
    for (let i = 0; i < 3; i++) {
      insert(port, JSON.stringify({ i, big }));
      await port.whenIdle(5000);
    }
    expect(port.stats().checkpoints).toBe(0);
    expect(port.stats().checkpointsDeferred).toBeGreaterThan(0);
  });

  it("裁定 B1：正常写入下 WAL 保持在上限内、照常 checkpoint；大条目写入前先 checkpoint，WAL 复位时按 journal_size_limit 截断", async () => {
    const big = "s".repeat(900 * 1024);
    for (let i = 0; i < 10; i++) {
      insert(port, JSON.stringify({ i, big }));
      await port.whenIdle(5000);
    }
    const s = port.stats();
    expect(s.checkpoints).toBeGreaterThanOrEqual(4); // 每 2 条（≥1 MiB）一次；最后一批要等下一次写才触发
    expect(s.checkpointsDeferred).toBe(0);
    expect(s.walBytes!).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect((db.prepare("PRAGMA journal_size_limit").get() as Record<string, number>).journal_size_limit).toBe(
      1024 * 1024,
    );
  }, 30_000);
});

describe("关库前 WAL 告警（第三轮裁定 B2：隐式 checkpoint 是已接受残留，大 WAL 先告知）", () => {
  it("关闭时 -wal 超过阈值 ⇒ console.warn 一行（含大小与 -wal 路径）；未超过不告警", async () => {
    const { makeEngine, teardownEngine } = await import("./helpers/engine.js");
    const { ensureDb } = await import("../../src/traffic/db.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const sub = mkdtempSync(join(tmpdir(), "pi-traffic-walwarn-"));
      const quiet = makeEngine(sub, { closeWalWarnBytes: 1024 * 1024 * 1024 });
      ensureDb(quiet).exec("PRAGMA wal_autocheckpoint = 0");
      ensureDb(quiet)
        .prepare("INSERT INTO messages (session_id, turn, ts, role, message) VALUES ('s', 0, 't', 'user', ?)")
        .run("m".repeat(512 * 1024));
      await teardownEngine(quiet);
      expect(warn).not.toHaveBeenCalled();
      const loud = makeEngine(sub, { closeWalWarnBytes: 64 * 1024 });
      ensureDb(loud).exec("PRAGMA wal_autocheckpoint = 0");
      ensureDb(loud)
        .prepare("INSERT INTO messages (session_id, turn, ts, role, message) VALUES ('s', 0, 't', 'user', ?)")
        .run("m".repeat(512 * 1024));
      await teardownEngine(loud);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]![0]);
      expect(line).toMatch(/WAL 为 \d+\.\d MiB/);
      expect(line).toContain(`${join(sub, "traffic.db")}-wal`);
      rmSync(sub, { recursive: true, force: true });
    } finally {
      warn.mockRestore();
    }
  });
});
