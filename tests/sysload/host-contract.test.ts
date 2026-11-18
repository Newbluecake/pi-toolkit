/**
 * S1's verbatim C0 contract copy (darwin-plan §2.2/§4.1): the region between the C0 markers
 * below must be BYTE-IDENTICAL to the one in `src/sysload/sampler.ts` (the sole declaration
 * site — S1 is the writer) and to S0's copy in
 * `tests/web-hub/protocol/sysload-darwin-contract.test.ts`. The in-test read below pins the
 * first identity at runtime; the three-way `sed`/`diff` gate (§7.1 C0-1) pins all three at
 * verification. Nobody may widen/narrow the contract without reporting to the dispatcher
 * first — all three copies move in the same commit.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DARWIN_MEM_ADVISORY, HOST_MIN_BUDGET_MS, sampleOnce } from "../../src/sysload/sampler.js";
import { IoLedger } from "../../src/sysload/io-ledger.js";

// ── C0:BEGIN ── sampler.ts（S1 声明；S0 结构满足；零运行时 import）
export interface SamplerHostMount {
  // = MountInfoRecord 的字段集（host 解析器须填满：root:"/"、optionalFields:[]、superOptions:[]、mountId:0、majorMinor:"0:0" 占位）
  mountId: number;
  parentId: number;
  majorMinor: string;
  root: string;
  mountPoint: string;
  mountOptions: readonly string[];
  optionalFields: readonly string[];
  fstype: string;
  source: string;
  superOptions: readonly string[];
}
export interface SamplerHostReading {
  // 任一字段缺失 ⇔ 该项本拍不可用（互相独立）
  loadavg?: readonly [number, number, number];
  memAvailPct?: number; // kern.memorystatus_level，整数 0..100
  cores?: number; // hw.ncpu，正整数
}
export interface HostProcess {
  pid: number;
  comm: string;
  cpuPct: number;
  rssBytes: number;
}
/** 所有带 timeoutMs 的方法：调用方保证 timeoutMs 为有限正数；host 收到非有限/≤0 的值**不得启动进程**，直接 resolve undefined。 */
export interface SamplerHost {
  readonly kind: "darwin";
  readonly localFilesystems: ReadonlySet<string>; // 替代 mounts.ts 的 Linux LOCAL_FILESYSTEMS
  readHost(opts: { timeoutMs: number }): Promise<SamplerHostReading | undefined>; // 永不 throw/reject
  readMounts(opts: { timeoutMs: number }): Promise<string | undefined>; // 原始 mount(8) 文本 ≤1 MiB；永不 throw
  parseMounts(text: string): readonly SamplerHostMount[]; // 同步纯函数
  deviceOf(path: string): Promise<number | undefined>; // fs.stat().dev；失败 ⇒ undefined；永不 throw
  listProcesses(opts: {
    timeoutMs: number;
    maxPids: number;
  }): Promise<{ procs: readonly HostProcess[]; truncated: boolean } | undefined>;
}
export interface SamplerIo {
  readonly readFileSync?: (path: string, options?: { encoding?: "utf8"; flag?: string }) => string | Buffer;
  readonly readFile?: (path: string) => Promise<string | Buffer>;
  readonly realpath?: (path: string) => Promise<string>;
  readonly statfs?: (path: string, options?: { bigint?: boolean }) => Promise<StatFsLike>;
  readonly host?: SamplerHost; // 追加
}
// ── C0:END ──

const statfsOk = { blocks: 100n, bfree: 20n, bavail: 10n, bsize: 4096n } as const;

// The marker literals are split on purpose so this file's own extraction helper never trips
// the §7.1 C0-1 sed-range gate — only the verbatim copy above may match it.
const MARK_BEGIN = "// ── C0:" + "BEGIN ──";
const MARK_END = "// ── C0:" + "END ──";

const c0Region = (path: string): string => {
  const text = readFileSync(path, "utf8");
  const start = text.indexOf(MARK_BEGIN);
  const end = text.indexOf(MARK_END);
  expect(start, `${path} must carry a C0 copy-start marker`).toBeGreaterThanOrEqual(0);
  expect(end, `${path} must carry a C0 copy-end marker`).toBeGreaterThan(start);
  return text.slice(start, end + MARK_END.length);
};

const localFilesystems = new Set(["apfs", "hfs"]);

/** A contract-shaped fake: EXACT key set and arities asserted below, then fed through the real
 * `sampleOnce` so the copy's types and the sampler's are structurally checked both ways. */
const fakeHost: SamplerHost = {
  kind: "darwin",
  localFilesystems,
  readHost: (opts) => {
    void opts;
    return Promise.resolve({ loadavg: [1, 2, 3], memAvailPct: 46, cores: 12 });
  },
  readMounts: (opts) => {
    void opts;
    return Promise.resolve("/dev/disk1s1 on / (apfs, local)\n");
  },
  parseMounts: (_text) => [
    {
      mountId: 0,
      parentId: 0,
      majorMinor: "0:0",
      root: "/",
      mountPoint: "/",
      mountOptions: ["local"],
      optionalFields: [],
      fstype: "apfs",
      source: "/dev/disk1s1",
      superOptions: [],
    },
  ],
  deviceOf: (path) => {
    void path;
    return Promise.resolve(16777233);
  },
  listProcesses: (opts) => {
    void opts;
    return Promise.resolve({ procs: [], truncated: false });
  },
};

describe("sysload C0 host contract (S1 copy)", () => {
  it("is byte-identical to the declaration in src/sysload/sampler.ts", () => {
    expect(c0Region(fileURLToPath(import.meta.url))).toBe(
      c0Region(fileURLToPath(new URL("../../src/sysload/sampler.ts", import.meta.url))),
    );
  });

  it("pins the SamplerHost surface: exact key set and method arities", () => {
    expect(Object.keys(fakeHost).sort()).toEqual([
      "deviceOf",
      "kind",
      "listProcesses",
      "localFilesystems",
      "parseMounts",
      "readHost",
      "readMounts",
    ]);
    expect(fakeHost.readHost.length).toBe(1);
    expect(fakeHost.readMounts.length).toBe(1);
    expect(fakeHost.parseMounts.length).toBe(1);
    expect(fakeHost.deviceOf.length).toBe(1);
    expect(fakeHost.listProcesses.length).toBe(1);
    const mount = fakeHost.parseMounts("x")[0]!;
    expect(Object.keys(mount).sort()).toEqual([
      "fstype",
      "majorMinor",
      "mountId",
      "mountOptions",
      "mountPoint",
      "optionalFields",
      "parentId",
      "root",
      "source",
      "superOptions",
    ]);
  });

  it("keeps the S1-side constants frozen (DARWIN_MEM_ADVISORY=true until the D1 decision; budget 50ms)", () => {
    expect(DARWIN_MEM_ADVISORY).toBe(true);
    expect(HOST_MIN_BUDGET_MS).toBe(50);
  });

  it("passes a contract-shaped host through the real sampler (structural compat, both directions)", async () => {
    const io = {
      readFileSync: () => {
        throw new Error("host path must never read /proc");
      },
      realpath: async (p: string) => p,
      statfs: async () => statfsOk,
      host: fakeHost,
    };
    const result = await sampleOnce(
      io,
      { home: "/Users/dev", mono: () => 0, at: () => 1 },
      new IoLedger({ active: new Map(), capacity: 2 }),
    );
    expect(result.sample.cpu.kind).toBe("invalid");
    expect(result.sample.mem).toMatchObject({ kind: "ok", value: { availPct: 46, usedPct: 54 } });
    expect(result.sample.memAdvisory).toBe(true);
    expect(result.sample.cores).toBe(12);
    expect(result.sample.loadavg).toEqual([1, 2, 3]);
  });

  it("never hands the host a non-finite or non-positive timeoutMs (the caller side of the C0 rule)", async () => {
    const seen: number[] = [];
    const recordingHost: SamplerHost = {
      ...fakeHost,
      readHost: async (opts) => {
        seen.push(opts.timeoutMs);
        return { memAvailPct: 46, cores: 12 };
      },
      readMounts: async (opts) => {
        seen.push(opts.timeoutMs);
        return "/dev/disk1s1 on / (apfs, local)\n";
      },
    };
    let calls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (calls++ === 0 ? 0 : -9_000));
    try {
      const result = await sampleOnce(
        { host: recordingHost, realpath: async (p) => p, statfs: async () => statfsOk },
        { home: "/Users/dev", mono: () => 0, at: () => 1 },
        new IoLedger({ active: new Map(), capacity: 2 }),
      );
      expect(result.sample.mem.kind).toBe("ok");
      expect(seen.length).toBeGreaterThan(0);
      for (const timeoutMs of seen) {
        expect(Number.isFinite(timeoutMs)).toBe(true);
        expect(timeoutMs).toBeGreaterThan(0);
        expect(timeoutMs).toBeLessThanOrEqual(800);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});
