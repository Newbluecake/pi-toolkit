// dynamic-threshold-plan.md §12 D2 — telemetry-store（§5.3 落盘纪律，R2-7）：
// T-D2-ATOMIC-LINE（单次 append/单行/限长降级）、T-D2-CONCURRENT（双进程 fork 压力）、
// T-D2-PERMS（0600/0700）、T-D2-ROTATE-RENAME（2 MiB rename 轮转、只保留一代）、
// T-D2-NEVER-THROW（EACCES/EISDIR/ENOSPC 不抛、每 errno 只 warn 一次）。

// fs 走 vi.mock 整体替换 + 透传原实现：node:fs 的 ESM 命名空间属性不可 configure
// （同 tests/quota/demotion.test.ts 的手法），call-through 的 module mock 是断言
// append/chmod 次数的唯一可靠途径。
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    appendFileSync: vi.fn(actual.appendFileSync),
    renameSync: vi.fn(actual.renameSync),
    chmodSync: vi.fn(actual.chmodSync),
  };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import {
  TELEMETRY_MAX_LINE,
  TELEMETRY_ROTATE_BYTES,
  createTelemetryStore,
  readTelemetryLines,
} from "../../../src/compact-hint/dynamic/telemetry-store.js";
import {
  buildSwitchTelemetryRecord,
  buildWindowTelemetryRecord,
  type SwitchRProxy,
  type SwitchTelemetryRecord,
  type TelemetrySnapshot,
} from "../../../src/compact-hint/dynamic/telemetry.js";

const SNAPSHOT: TelemetrySnapshot = {
  model: { provider: "anthropic", id: "claude-opus-4-5", contextWindow: 1_000_000 },
  lines: { mode: "on", hintPercent: 41, forcePercent: 88, basis: "cost", dynamicUsable: true, degradeReason: null },
  estimate: { g: 779.4, sigma: 512.2, s0: 98_400, cStar: 161_000, rUsd: 10, handoffTokens: 4_500 },
  price: { cacheRead: 0.2, cacheWrite: 5, output: 20, tierHit: 272_000, writePricingApproximate: true },
  cachedContextTokens: 410_000,
};

const RPROXY: SwitchRProxy = {
  turns: 6,
  wallMs: 62_000,
  firstContextTokens: 6_800,
  firstUsage: { input: 1_000, output: 200, cacheRead: 5_000, cacheWrite: 800 },
  costUsd: 0.06,
  cacheRead: 18_000,
  cacheWrite: 2_700,
  crossModel: false,
  costUnknownReason: null,
};

let seq = 0;
function switchRecord(sessionId = "cc-a"): SwitchTelemetryRecord {
  seq += 1;
  return buildSwitchTelemetryRecord({
    now: 1_759_000_000_000 + seq,
    sessionId,
    seq,
    event: {
      reason: "manual",
      compactionEntry: { fromHook: false, tokensBefore: 420_000, usage: { cost: { total: 0.02 } } },
    },
    handoff: undefined,
    force: undefined,
    turnsSinceLastSwitch: 4,
    snapshot: SNAPSHOT,
  });
}

function windowRecord(sessionId = "cc-a"): SwitchTelemetryRecord {
  return buildWindowTelemetryRecord(switchRecord(sessionId), RPROXY, 1_759_000_100_000);
}

let dir: string;

beforeEach(() => {
  vi.mocked(fs.appendFileSync).mockClear();
  vi.mocked(fs.renameSync).mockClear();
  vi.mocked(fs.chmodSync).mockClear();
  dir = fs.mkdtempSync(join(tmpdir(), "pi-compact-telemetry-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("T-D2-ATOMIC-LINE: single append per record, single line, budget", () => {
  it("each record is exactly one appendFileSync call of one ≤3500B line with trailing newline", () => {
    const file = join(dir, "compact-switch.jsonl");
    const store = createTelemetryStore({ filePath: file });
    const records = [switchRecord(), switchRecord(), switchRecord()];
    for (const record of records) store.append(record);
    expect(fs.appendFileSync).toHaveBeenCalledTimes(3); // 每条恰好一次
    expect(store.count()).toBe(3);
    const text = fs.readFileSync(file, "utf8");
    expect(text.endsWith("\n")).toBe(true); // 结尾换行
    const lines = text.split("\n").slice(0, -1);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(TELEMETRY_MAX_LINE); // 行长是降低撕裂概率的手段
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("overlong record degrades once (drops rProxy.firstUsage) and is still appended", () => {
    const file = join(dir, "compact-switch.jsonl");
    const store = createTelemetryStore({ filePath: file });
    // 把 basis 填充到「带 firstUsage 超限、丢掉后合规」的窗口：
    const probe = windowRecord();
    const withoutFirstUsage = JSON.stringify({ ...probe, rProxy: { ...RPROXY, firstUsage: null } }).length;
    const basisLen = Math.max(0, TELEMETRY_MAX_LINE - 30 - (withoutFirstUsage - probe.lines.basis.length));
    const padded: SwitchTelemetryRecord = {
      ...probe,
      lines: { ...probe.lines, basis: "x".repeat(basisLen) },
    };
    const withProxy = JSON.stringify(padded);
    expect(Buffer.byteLength(withProxy)).toBeGreaterThan(TELEMETRY_MAX_LINE); // 前提：确实超限
    store.append(padded);
    expect(fs.appendFileSync).toHaveBeenCalledTimes(1); // 降级成功 ⇒ 照常一次追加
    const [line] = fs.readFileSync(file, "utf8").split("\n");
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(TELEMETRY_MAX_LINE);
    expect((JSON.parse(line) as { rProxy: { firstUsage: unknown } }).rProxy.firstUsage).toBeNull(); // 第一档降级
  });

  it("record still overlong after both degrade stages is skipped with a warn and never appended", () => {
    const file = join(dir, "compact-switch.jsonl");
    const warn = vi.fn();
    const store = createTelemetryStore({ filePath: file, warn });
    const padded: SwitchTelemetryRecord = {
      ...switchRecord(),
      lines: { ...SNAPSHOT.lines, basis: "y".repeat(TELEMETRY_MAX_LINE) }, // 保留字段超限：两档降级都救不回
    };
    expect(() => store.append(padded)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("skipped");
    expect(fs.appendFileSync).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
    expect(store.count()).toBe(0);
  });
});

describe("T-D2-PERMS: 0600 file / 0700 dir, chmod once per session", () => {
  it("creates the telemetry dir 0700 and the file 0600, confirming perms once", () => {
    const file = join(dir, "telemetry", "compact-switch.jsonl");
    const store = createTelemetryStore({ filePath: file });
    store.append(switchRecord());
    store.append(switchRecord());
    store.append(switchRecord());
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(join(dir, "telemetry")).mode & 0o777).toBe(0o700);
    expect(fs.chmodSync).toHaveBeenCalledTimes(1); // 本会话只确认一次，不是每行一次
  });
});

describe("T-D2-ROTATE-RENAME: >2MiB rotates to .1, one generation, overwrite on re-rotate", () => {
  it("renames to .1 past the budget and later rotations overwrite the old generation (no .2)", () => {
    const file = join(dir, "compact-switch.jsonl");
    const store = createTelemetryStore({ filePath: file });
    const first = switchRecord(); // 本测试的首条（seq 计数器为文件级共享，不从 1 开始）
    const firstSeq = first.seq;
    const lineLen = JSON.stringify(first).length + 1; // ASCII 记录：字节数 == 字符数 +1 换行
    const batch = Math.ceil((TELEMETRY_ROTATE_BYTES + lineLen * 8) / lineLen);
    const seqOf = (record: unknown): number => (record as { seq: number }).seq;

    store.append(first);
    for (let i = 1; i < batch; i += 1) store.append(switchRecord());
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.existsSync(`${file}.2`)).toBe(false); // 只保留一代
    const firstGen = readTelemetryLines(`${file}.1`);
    expect(firstGen.skipped).toBe(0);
    expect(firstGen.records.length).toBeGreaterThan(0);
    expect(seqOf(firstGen.records[0])).toBe(firstSeq); // 第一代从本测试首条开始
    // 单进程顺序写：一行不丢（main + .1 = batch）。
    expect(readTelemetryLines(file).records.length + firstGen.records.length).toBe(batch);

    // 第二批再次跨过 2 MiB ⇒ 再次轮转：旧 .1 被覆盖（rename 原子替换），仍无 .2。
    for (let i = 0; i < batch; i += 1) store.append(switchRecord());
    expect(fs.existsSync(`${file}.2`)).toBe(false);
    const secondGen = readTelemetryLines(`${file}.1`);
    const main = readTelemetryLines(file);
    expect(secondGen.skipped).toBe(0);
    expect(main.skipped).toBe(0);
    expect(secondGen.records.length).toBeGreaterThan(0);
    expect(seqOf(secondGen.records[0])).toBeGreaterThan(firstSeq); // 旧一代（从 firstSeq 起）确实被覆盖了
    expect(seqOf(secondGen.records[0])).toBeLessThan(seqOf(main.records[0])); // .1 早于 main
    // 第二批在两代文件里基本完整（只可能丢被覆盖的第一代）。
    expect(secondGen.records.length + main.records.length).toBeGreaterThan(batch);
  });
});

describe("T-D2-NEVER-THROW: silent best-effort, one warn per errno", () => {
  it(
    "unwritable parent dir: never throws, one warn per errno (EACCES mkdir + ENOENT append), count stays 0",
    { skipIf: typeof process.getuid === "function" && process.getuid() === 0 }, // root 无视目录权限位
    () => {
      const blocked = join(dir, "blocked");
      fs.mkdirSync(blocked);
      fs.chmodSync(blocked, 0o500);
      try {
        const warn = vi.fn();
        const store = createTelemetryStore({ filePath: join(blocked, "telemetry", "x.jsonl"), warn });
        expect(() => {
          store.append(switchRecord());
          store.append(switchRecord());
          store.append(switchRecord());
        }).not.toThrow();
        // 两个 errno 各报一次：mkdir 撞 EACCES；目录造不出来 ⇒ append 撞 ENOENT。第三个 errno 不存在，也不再新增 warn。
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls[0]?.[0]).toContain("EACCES");
        expect(warn.mock.calls[1]?.[0]).toContain("ENOENT");
        expect(store.count()).toBe(0);
      } finally {
        fs.chmodSync(blocked, 0o700); // 恢复写权限，否则 afterEach 的 rmSync 也清不掉
      }
    },
  );

  it("file path is a directory (EISDIR): never throws, warns once", () => {
    const target = join(dir, "i-am-a-dir");
    fs.mkdirSync(target);
    const warn = vi.fn();
    const store = createTelemetryStore({ filePath: target, warn });
    expect(() => {
      store.append(switchRecord());
      store.append(switchRecord());
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("EISDIR");
    expect(store.count()).toBe(0);
  });

  it("simulated ENOSPC: never throws, warns once, recovers on the next append", () => {
    const file = join(dir, "compact-switch.jsonl");
    const warn = vi.fn();
    const store = createTelemetryStore({ filePath: file, warn });
    const mocked = vi.mocked(fs.appendFileSync);
    const original = mocked.getMockImplementation();
    mocked.mockImplementation(() => {
      throw Object.assign(new Error("disk full (simulated)"), { code: "ENOSPC" });
    });
    try {
      expect(() => {
        store.append(switchRecord());
        store.append(switchRecord());
      }).not.toThrow();
    } finally {
      mocked.mockImplementation(original!);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("ENOSPC");
    expect(store.count()).toBe(0);
    store.append(switchRecord()); // 磁盘恢复后照常写，无需重建 store
    expect(store.count()).toBe(1);
  });
});

describe("T-D2-CONCURRENT: two forked writers, no locks, consumer skips torn lines", () => {
  it(
    "parallel forks keep ≥ (1−ε) of lines parseable; every parseable line is self-consistent; both exit 0",
    { timeout: 60_000 },
    async () => {
      const file = join(dir, "compact-switch.jsonl");
      const lineLen = JSON.stringify(switchRecord("cc-a")).length + 1;
      // A 的写入量跨过 2 MiB（每迭代 2 行）⇒ 至少触发一次 rotate；B 少量并发写入。
      const iterationsA = Math.ceil((TELEMETRY_ROTATE_BYTES * 1.1) / (lineLen * 2));
      const iterationsB = 120;
      const childPath = join(import.meta.dirname, "telemetry-fork-child.ts");
      const runChild = (sessionId: string, iterations: number): Promise<number> =>
        new Promise<number>((resolve, reject) => {
          const child = fork(childPath, [file, sessionId, String(iterations)], { execArgv: ["--import", "tsx"] });
          child.on("exit", (code) => resolve(code ?? -1));
          child.on("error", reject);
        });
      const [codeA, codeB] = await Promise.all([runChild("cc-a", iterationsA), runChild("cc-b", iterationsB)]);
      expect(codeA).toBe(0); // ③ 进程均以 0 退出、无未捕获异常
      expect(codeB).toBe(0);
      expect(fs.existsSync(`${file}.1`)).toBe(true); // A 的写入量确实触发了一次 rotate

      const main = readTelemetryLines(file);
      const rotated = readTelemetryLines(`${file}.1`); // 不存在 ⇒ 空结果，不抛
      const parseable = main.records.length + rotated.records.length;
      const expected = 2 * (iterationsA + iterationsB) - 2; // 每进程 2N−1 行
      expect(parseable).toBeGreaterThanOrEqual(Math.floor(expected * 0.98)); // ① ε=2% 吸收撕裂行/轮转竞争
      for (const record of [...main.records, ...rotated.records]) {
        const r = record as SwitchTelemetryRecord; // 每条内容自洽
        expect(r.v).toBe(2);
        expect(r.phase === "switch" || r.phase === "window").toBe(true);
        expect(typeof r.seq).toBe("number");
        expect(r.seq).toBeGreaterThan(0);
        expect(["cc-a", "cc-b"]).toContain(r.sessionId);
      }
      // ② 消费端跳过坏行：人为补一条撕裂半行，重读不抛且 skipped 计数 +1。
      fs.appendFileSync(file, '{"v":2,"ts":1759000000000,"sess');
      const reread = readTelemetryLines(file);
      expect(reread.skipped).toBe(main.skipped + 1);
    },
  );
});
