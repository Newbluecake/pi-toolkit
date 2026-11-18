import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { parseLoadSettings } from "../../src/sysload/settings.js";
import { createLoadActivation, escalated } from "../../src/sysload/activation.js";
import type { SamplerHost, SamplerHostMount, SamplerIo } from "../../src/sysload/sampler.js";
import { IoLedger } from "../../src/sysload/io-ledger.js";
import { aggregateTop } from "../../src/sysload/top.js";

/** darwin-plan §4.2 (S2 装配侧)：平台判定在装配点（activation.ts），测试注入 host / io 均不起任何子进程。 */
const flush = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 1));
};

const DARWIN_LOCAL = new Set(["apfs", "hfs", "exfat", "msdos", "zfs"]);
const MOUNTS_APFS_ROOT = "/dev/disk0s1s1 on / (apfs, sealed, local, read-only, journaled)\n";
const parseMountText = (text: string): SamplerHostMount[] =>
  text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const match = /^(.+?) on (\/.*) \(([^()]*)\)$/.exec(line);
      if (match === null) return [];
      const [fstype, ...options] = match[3]!.split(",").map((token) => token.trim());
      return [
        {
          mountId: 0,
          parentId: 0,
          majorMinor: "0:0",
          root: "/",
          mountPoint: match[2]!,
          mountOptions: options,
          optionalFields: [],
          fstype: fstype!,
          source: match[1]!,
          superOptions: [],
        },
      ];
    });

describe("sysload activation and IO ledger", () => {
  it("treats every rise into warn/crit as an escalation that refreshes top", () => {
    expect(escalated("ok", "warn")).toBe(true);
    expect(escalated("ok", "crit")).toBe(true);
    expect(escalated("warn", "crit")).toBe(true);
    expect(escalated("unknown", "warn")).toBe(true);
    expect(escalated("unknown", "ok")).toBe(false);
    expect(escalated("crit", "warn")).toBe(false);
    expect(escalated("warn", "warn")).toBe(false);
    expect(escalated("crit", "unknown")).toBe(false);
  });

  it("does not start in print/json and dispose is idempotent", () => {
    const clock = new FakeClock();
    const activation = createLoadActivation({ settings: parseLoadSettings({}), clock, mono: () => 0, wall: () => 0 });
    activation.start({ mode: "print" });
    expect(clock.pendingTimers).toBe(0);
    activation.dispose();
    activation.dispose();
    expect(activation.port().verdict().gating).toBe(false);
  });

  it("carries the previous top table across refreshes", async () => {
    let monoNow = 0;
    const previousOptions: unknown[] = [];
    const snapshots = [
      aggregateTop([{ pid: 7, comm: "node", utime: 10, stime: 0, starttime: 3, rssPages: 1 }], undefined, 0, {
        userHz: 100,
        pageSize: 4096,
      }),
      aggregateTop([{ pid: 7, comm: "node", utime: 20, stime: 0, starttime: 3, rssPages: 1 }], undefined, 0, {
        userHz: 100,
        pageSize: 4096,
      }),
    ];
    let call = 0;
    const activation = createLoadActivation({
      settings: parseLoadSettings({}),
      mono: () => monoNow,
      wall: () => monoNow,
      scanTop: async (_ledger, options) => {
        previousOptions.push(options.previous);
        options.onPrevious?.({ mono: monoNow, processes: new Map([[7, { starttime: 3, cpuTicks: 10 }]]) });
        return snapshots[call++] ?? snapshots[1]!;
      },
    });
    activation.port().refreshTop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    monoNow = 30_000;
    activation.port().refreshTop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(previousOptions[0]).toBeUndefined();
    expect(previousOptions[1]).toMatchObject({ processes: new Map([[7, { starttime: 3, cpuTicks: 10 }]]) });
  });

  it("keeps one lease per key and releases only explicitly", async () => {
    const ledger = new IoLedger({ active: new Map(), capacity: 2 });
    const first = ledger.tryAcquire("a");
    expect(first).toBeDefined();
    expect(ledger.tryAcquire("a")).toBeUndefined();
    const pending = new Promise<void>((resolve) => setTimeout(resolve, 5));
    const lease = ledger.tryAcquire("b");
    expect(lease).toBeDefined();
    expect(ledger.tryAcquire("c")).toBeUndefined();
    await pending;
    first?.release();
    expect(ledger.tryAcquire("c")).toBeDefined();
    lease?.release();
  });

  it("routes sampling and top through the injected host seam (darwin assembly path)", async () => {
    const calls = { readHost: 0, readMounts: 0, deviceOf: 0, listProcesses: 0, statfs: 0, procReads: [] as string[] };
    const host: SamplerHost = {
      kind: "darwin",
      localFilesystems: DARWIN_LOCAL,
      readHost: (opts) => {
        calls.readHost++;
        void opts;
        return Promise.resolve({ loadavg: [1.5, 1.6, 1.7], memAvailPct: 46, cores: 12 });
      },
      readMounts: (opts) => {
        calls.readMounts++;
        void opts;
        return Promise.resolve(MOUNTS_APFS_ROOT);
      },
      parseMounts: parseMountText,
      deviceOf: (path) => {
        calls.deviceOf++;
        return Promise.resolve(path === "/home/u" ? 16777233 : undefined);
      },
      listProcesses: (opts) => {
        calls.listProcesses++;
        expect(opts.timeoutMs).toBeGreaterThan(0);
        expect(opts.timeoutMs).toBeLessThanOrEqual(1000);
        return Promise.resolve({
          procs: [{ pid: 42, comm: "node", cpuPct: 12.5, rssBytes: 4096 }],
          truncated: false,
        });
      },
    };
    const io: SamplerIo = {
      readFileSync: (path) => {
        calls.procReads.push(path);
        throw new Error(`host path must never read ${path}`);
      },
      realpath: async (path) => path,
      statfs: async (path) => {
        calls.statfs++;
        void path;
        return { blocks: 100n, bfree: 20n, bavail: 10n, bsize: 4096n };
      },
    };
    const clock = new FakeClock();
    let monoNow = 0;
    const activation = createLoadActivation({
      settings: parseLoadSettings({}),
      clock,
      mono: () => monoNow,
      wall: () => monoNow,
      host,
      io,
    });
    activation.start({ mode: "tui", home: "/home/u", cwd: "/home/u" });
    await flush();
    // One host-driven tick: sysctl once, mount(8) once (then cached), zero /proc reads.
    expect(calls.readHost).toBe(1);
    expect(calls.readMounts).toBe(1);
    expect(calls.procReads).toEqual([]);
    const verdict = activation.port().verdict();
    // darwin-plan §2.2/§2.9: cores/loadavg disclosed, mem advisory (display value, unknown level).
    expect(verdict.cores).toBe(12);
    expect(verdict.loadavg).toEqual([1.5, 1.6, 1.7]);
    expect(verdict.metrics.mem.availPct).toBe(46);
    expect(verdict.metrics.mem.level).toBe("unknown");
    expect(verdict.metrics.cpu.level).toBe("unknown");
    expect(clock.pendingTimers).toBe(1); // the tick rescheduled itself
    // Top refresh goes through createHostTopScanner(host), never the /proc scanner.
    activation.port().refreshTop();
    await flush();
    expect(calls.listProcesses).toBe(1);
    const top = activation.port().top();
    expect(top?.byRss[0]?.comm).toBe("node");
    expect(calls.procReads).toEqual([]);
    activation.dispose();
    expect(clock.pendingTimers).toBe(0);
  });

  it("treats an injected io as authoritative — no platform host is resolved behind it", async () => {
    // darwin-plan §2.1: platform judgment lives ONLY at the assembly points. An injected io
    // (the Linux-fixture seam) decides its own path — even on a darwin dev machine the sampler
    // takes the Linux default branch (observable here: /proc/stat is READ, which the darwin
    // host path never does), so fixture suites can never be mis-routed by process.platform.
    const procReads: string[] = [];
    const clock = new FakeClock();
    const activation = createLoadActivation({
      settings: parseLoadSettings({}),
      clock,
      mono: () => 0,
      wall: () => 0,
      io: {
        readFileSync: (path) => {
          procReads.push(path);
          throw new Error("no fs");
        },
      },
    });
    activation.start({ mode: "tui" });
    await flush();
    expect(procReads).toContain("/proc/stat");
    expect(procReads).toContain("/proc/meminfo");
    activation.dispose();
  });
});
