/**
 * darwin-plan §4.2「Linux 对照」(修订 #9): the S1 seam must leave the Linux path
 * byte-identical. Two layers of evidence:
 *  - sampler: the SAME Linux fixtures (host absent) run through the frozen origin/dev snapshot
 *    (`compat/sampler-v0.ts`) and the current `sampleOnce` — complete `SampleResult` equality,
 *    including the sample's key set (no `cores`/`memAdvisory` keys on Linux).
 *  - top: `aggregateTop` (whose tail was extracted into `rankTopRows`) diffed against the frozen
 *    `compat/top-v0.ts` under a fixed `Date` clock — layer A compares the WHOLE snapshot, layer B
 *    compares the ranking rows via `rankTopRows` directly (incl. darwin tie-breaks with no v0
 *    counterpart).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IoLedger } from "../../src/sysload/io-ledger.js";
import { sampleOnce as sampleOnceV0 } from "./compat/sampler-v0.js";
import { sampleOnce } from "../../src/sysload/sampler.js";
import { aggregateTop as aggregateTopV0 } from "./compat/top-v0.js";
import type { TopSampleProcess as TopSampleProcessV0 } from "./compat/top-v0.js";
import { aggregateTop, rankTopRows } from "../../src/sysload/top.js";
import type { RankInput } from "../../src/sysload/top.js";

const STAT_OK = { blocks: 100n, bfree: 20n, bavail: 10n, bsize: 4096n };

interface ParityCase {
  readonly name: string;
  readonly files: Record<string, string>;
  readonly mountinfoText: string;
  readonly plan?: {
    home?: string;
    previousCpu?: Parameters<typeof sampleOnce>[1] extends { previousCpu?: infer C } ? C : never;
    previousMono?: number;
    mono?: () => number;
    at?: () => number;
    realpath?: (path: string) => Promise<string>;
  };
  readonly statfs?: () => Promise<object>;
  readonly fullLedger?: boolean;
}

const BASE_FILES = {
  "/proc/stat": "cpu 10 0 10 80 0 0 0 0 0 0\ncpu0 10 0 10 80 0 0 0 0 0 0\ncpu1 10 0 10 80 0 0 0 0 0 0\n",
  "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 500 kB\n",
  "/proc/loadavg": "1 2 3 1/10 42\n",
  "/proc/pressure/cpu": "some avg10=2.5 avg60=1 avg300=0 total=1\n",
  "/proc/pressure/io": "some avg10=4.5 avg60=2 avg300=1 total=9\n",
};
const MOUNTINFO_ROOT = "1 0 8:1 / / rw - ext4 /dev/root rw\n";
const MOUNTINFO_SPLIT = "1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 8:2 / /home/user rw - ext4 /dev/sda2 rw\n";
const MOUNTINFO_REMOTE = "1 0 0:42 / / rw - nfs server:/export rw\n";

const PARITY_CASES: readonly ParityCase[] = [
  {
    name: "multi-core cpu with psi, two-tick delta",
    files: BASE_FILES,
    mountinfoText: MOUNTINFO_ROOT,
    plan: {
      home: "/",
      previousCpu: {
        name: "cpu",
        user: 5,
        nice: 0,
        system: 5,
        idle: 40,
        iowait: 0,
        irq: 0,
        softirq: 0,
        steal: 0,
        total: 50,
        idleAll: 40,
      },
      previousMono: 0,
      mono: () => 5_000,
      at: () => 20,
    },
  },
  {
    name: "counter regression (wraparound) keeps nextCpu but invalid busy",
    files: { ...BASE_FILES, "/proc/stat": "cpu 1 0 1 8 0 0 0 0 0 0\ncpu0 1 0 1 8 0 0 0 0 0 0\n" },
    mountinfoText: MOUNTINFO_ROOT,
    plan: {
      home: "/",
      previousCpu: {
        name: "cpu",
        user: 500,
        nice: 0,
        system: 500,
        idle: 4000,
        iowait: 0,
        irq: 0,
        softirq: 0,
        steal: 0,
        total: 5000,
        idleAll: 4000,
      },
      previousMono: 0,
      mono: () => 5_000,
      at: () => 20,
    },
  },
  {
    name: "missing MemAvailable keeps mem invalid, no psi files at all",
    files: {
      "/proc/stat": BASE_FILES["/proc/stat"]!,
      "/proc/meminfo": "MemTotal: 1000 kB\n",
      "/proc/loadavg": "1 2 3 1/10 42\n",
    },
    mountinfoText: MOUNTINFO_ROOT,
    plan: { home: "/", mono: () => 0, at: () => 1 },
  },
  {
    name: "remote mount skipped",
    files: BASE_FILES,
    mountinfoText: MOUNTINFO_REMOTE,
    plan: { home: "/", mono: () => 0, at: () => 1 },
  },
  {
    name: "ledger full marks statfs invalid",
    files: BASE_FILES,
    mountinfoText: MOUNTINFO_ROOT,
    plan: { home: "/", mono: () => 0, at: () => 1 },
    fullLedger: true,
  },
  {
    name: "unresolved symlink",
    files: BASE_FILES,
    mountinfoText: MOUNTINFO_ROOT,
    plan: {
      home: "/home/user",
      mono: () => 0,
      at: () => 1,
      realpath: async () => {
        throw new Error("unresolved");
      },
    },
  },
  {
    name: "duplicate mount dedup (HOME on root fs)",
    files: BASE_FILES,
    mountinfoText: MOUNTINFO_ROOT,
    plan: { home: "/home/user", mono: () => 0, at: () => 1, realpath: async (p: string) => p },
  },
  {
    name: "both display mounts kept",
    files: BASE_FILES,
    mountinfoText: MOUNTINFO_SPLIT,
    plan: { home: "/home/user", mono: () => 0, at: () => 1, realpath: async (p: string) => p },
  },
];

describe("sysload linux-parity: sampler v0 vs current (§4.2, E-CI)", () => {
  for (const testCase of PARITY_CASES) {
    it(`byte-identical SampleResult — ${testCase.name}`, async () => {
      const run = async (impl: typeof sampleOnce) => {
        const ledger = testCase.fullLedger
          ? new IoLedger({
              active: new Map([
                ["held-a", 1],
                ["held-b", 1],
              ]),
              capacity: 2,
            })
          : new IoLedger({ active: new Map(), capacity: 2 });
        return impl(
          {
            readFileSync: (path: string) => testCase.files[path] ?? "",
            ...(testCase.plan?.realpath === undefined ? {} : { realpath: testCase.plan.realpath }),
            statfs: async () => testCase.statfs?.() ?? STAT_OK,
          },
          { mountinfoText: testCase.mountinfoText, home: testCase.plan?.home, ...(testCase.plan ?? {}) },
          ledger,
        );
      };
      const v0 = await run(sampleOnceV0);
      const current = await run(sampleOnce);
      expect(current).toEqual(v0);
      expect(Object.keys(current.sample).sort()).toEqual(Object.keys(v0.sample).sort());
      expect(Object.keys(current.sample)).not.toContain("cores");
      expect(Object.keys(current.sample)).not.toContain("memAdvisory");
      expect(JSON.stringify(current.sample)).toBe(JSON.stringify(v0.sample));
    });
  }

  it("the default io path (no host) produces no host interaction keys", async () => {
    const result = await sampleOnce(
      { readFileSync: (path: string) => BASE_FILES[path] ?? "", statfs: async () => STAT_OK },
      { home: "/", mono: () => 0, at: () => 1, mountinfoText: MOUNTINFO_ROOT },
      new IoLedger({ active: new Map(), capacity: 2 }),
    );
    expect(result.sample.cpu.kind).toBe("invalid");
    expect(result.sample.mem.kind).toBe("ok");
    expect(result.sample.disks.every((d) => d.reading.kind === "ok")).toBe(true);
    expect(result.sample.ioPsiPct).toBe(4.5);
  });
});

const FIXED_AT = 1_700_000_000_000;

const TOP_FIXTURES: readonly {
  readonly name: string;
  readonly processes: readonly TopSampleProcessV0[];
  readonly previous?: Parameters<typeof aggregateTopV0>[1];
  readonly now: number;
  readonly units?: { userHz: number; pageSize: number };
}[] = [
  {
    name: "two-tick delta with comm aggregation",
    processes: [
      { pid: 10, comm: "node", utime: 150, stime: 0, starttime: 1, rssPages: 10 },
      { pid: 11, comm: "node", utime: 200, stime: 0, starttime: 2, rssPages: 20, lifetimeSeconds: 2 },
      { pid: 12, comm: "java", utime: 1, stime: 0, starttime: 1, rssPages: 100 },
    ],
    previous: { mono: 0, processes: new Map([[10, { starttime: 1, cpuTicks: 100 }]]) },
    now: 1_000,
    units: { userHz: 100, pageSize: 4096 },
  },
  {
    name: "pid reuse lifetime average",
    processes: [{ pid: 10, comm: "node", utime: 100, stime: 0, starttime: 99, rssPages: 4, lifetimeSeconds: 2 }],
    previous: { mono: 0, processes: new Map([[10, { starttime: 1, cpuTicks: 1 }]]) },
    now: 1_000,
    units: { userHz: 100, pageSize: 4096 },
  },
  {
    name: "units unavailable (n/a rows)",
    processes: [{ pid: 10, comm: "node", utime: 100, stime: 0, starttime: 1, rssPages: 4 }],
    now: 0,
  },
  {
    name: "lifetime average without previous",
    processes: [
      { pid: 10, comm: "node", utime: 100, stime: 0, starttime: 1, rssPages: 4, lifetimeSeconds: 4 },
      { pid: 11, comm: "node", utime: 100, stime: 0, starttime: 1, rssPages: 8, lifetimeSeconds: 4 },
    ],
    now: 0,
    units: { userHz: 100, pageSize: 4096 },
  },
  {
    name: "duplicate pid rows and value ties (rss/cpu tie-breaks, comm tie-break)",
    processes: [
      { pid: 20, comm: "aaa", utime: 100, stime: 0, starttime: 1, rssPages: 4, lifetimeSeconds: 4 },
      { pid: 21, comm: "bbb", utime: 100, stime: 0, starttime: 1, rssPages: 4, lifetimeSeconds: 4 },
      { pid: 22, comm: "ccc", utime: 100, stime: 0, starttime: 1, rssPages: 4, lifetimeSeconds: 4 },
      { pid: 10, comm: "node", utime: 100, stime: 0, starttime: 1, rssPages: 4, lifetimeSeconds: 4 },
      { pid: 10, comm: "other", utime: 100, stime: 0, starttime: 1, rssPages: 4, lifetimeSeconds: 4 },
    ],
    now: 0,
    units: { userHz: 100, pageSize: 4096 },
  },
  {
    name: "more than 5 comms and 8 same-comm pids (caps)",
    processes: Array.from({ length: 12 }, (_unused, index) => ({
      pid: index,
      comm: ["a", "b", "c", "d", "e", "f", "g"][index % 7]!,
      utime: 100 + index,
      stime: 0,
      starttime: 1,
      rssPages: index,
      lifetimeSeconds: 4,
    })),
    now: 0,
    units: { userHz: 100, pageSize: 4096 },
  },
];

describe("sysload linux-parity: top v0 vs current (fixed Date clock, §4.2 修订 #9)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_AT);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const fixture of TOP_FIXTURES) {
    it(`layer A: whole snapshot equal — ${fixture.name}`, () => {
      const v0 = aggregateTopV0(fixture.processes, fixture.previous, fixture.now, fixture.units);
      const current = aggregateTop(fixture.processes, fixture.previous, fixture.now, fixture.units);
      expect(current).toEqual(v0);
      expect(current.at).toBe(FIXED_AT);
    });

    it(`layer B: rankTopRows reproduces the v0 ranking — ${fixture.name}`, () => {
      const v0 = aggregateTopV0(fixture.processes, fixture.previous, fixture.now, fixture.units);
      // Rebuild the RankInput view from the v0 rows themselves (pid-level values are the same
      // numbers aggregateTop computed; fixtures keep ≤8 pids per comm so the row's pid cap
      // loses nothing). rankTopRows must reproduce the identical ranking. Row-level `avg` is
      // per-pid in reality and already stripped from row.pids — strip it on both sides.
      const byComm = new Set<string>();
      const inputs: RankInput[] = [...v0.byCpu, ...v0.byRss]
        .filter((row) => (byComm.has(row.comm) ? false : byComm.add(row.comm)))
        .flatMap((row) =>
          row.pids.map((pid) => ({ pid: pid.pid, comm: row.comm, cpuPct: pid.cpuPct, rssBytes: pid.rssBytes })),
        );
      const ranked = rankTopRows(inputs);
      const stripAvg = (rows: readonly { avg?: true }[]) => rows.map(({ avg: _avg, ...row }) => row);
      expect(stripAvg(ranked.byCpu)).toEqual(stripAvg(v0.byCpu));
      expect(stripAvg(ranked.byRss)).toEqual(stripAvg(v0.byRss));
    });
  }

  it("layer B: darwin-specific ranking rules (no v0 counterpart)", () => {
    const inputs: RankInput[] = [
      { pid: 1, comm: "node", cpuPct: 5, rssBytes: 100 },
      { pid: 2, comm: "node", cpuPct: 3, rssBytes: 300 },
      { pid: 3, comm: "Google Chrome Helper (Renderer)", cpuPct: 4, rssBytes: 200 },
      { pid: 4, comm: "we\x01rd\x7f", cpuPct: 2, rssBytes: 400 },
    ];
    const ranked = rankTopRows(inputs);
    expect(ranked.byCpu[0]).toMatchObject({ comm: "node", count: 2, cpuPct: 8, rssBytes: 400 });
    expect(ranked.byCpu[0]!.pids).toEqual([
      { pid: 1, cpuPct: 5, rssBytes: 100 },
      { pid: 2, cpuPct: 3, rssBytes: 300 },
    ]);
    expect(ranked.byCpu[0]).not.toHaveProperty("avg");
    expect(ranked.byRss[0]).toMatchObject({ comm: "node", rssBytes: 400 });
    // control characters are cleaned exactly like the Linux path
    expect(ranked.byCpu.map((row) => row.comm)).toContain("we?rd?");
    expect(ranked.byCpu.length).toBeLessThanOrEqual(5);
    expect(ranked.byRss.length).toBeLessThanOrEqual(5);
    // equal cpuPct falls back to rssBytes, then comm (same rules as v0)
    const ties = rankTopRows([
      { pid: 1, comm: "bbb", cpuPct: 5, rssBytes: 100 },
      { pid: 2, comm: "aaa", cpuPct: 5, rssBytes: 100 },
      { pid: 3, comm: "ccc", cpuPct: 5, rssBytes: 200 },
    ]);
    expect(ties.byCpu.map((row) => row.comm)).toEqual(["ccc", "aaa", "bbb"]);
    const rssTies = rankTopRows([
      { pid: 1, comm: "bbb", cpuPct: 5, rssBytes: 100 },
      { pid: 2, comm: "aaa", cpuPct: 5, rssBytes: 100 },
      { pid: 3, comm: "ccc", cpuPct: 6, rssBytes: 100 },
    ]);
    expect(rssTies.byRss.map((row) => row.comm)).toEqual(["ccc", "aaa", "bbb"]);
  });
});
