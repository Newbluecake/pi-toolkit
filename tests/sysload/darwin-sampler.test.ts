/**
 * darwin-plan §4.2-D: sampler behavior behind a fake SamplerHost (tier1 — no real subprocess,
 * no real FS; the host/statfs/realpath fakes are injected through `SamplerIo`). The Linux path
 * (`host === undefined`) is covered by sampler.test.ts + linux-parity.test.ts, never here.
 */
import { describe, expect, it, vi } from "vitest";
import { IoLedger } from "../../src/sysload/io-ledger.js";
import {
  sampleOnce,
  type SamplerHost,
  type SamplerHostMount,
  type SamplerHostReading,
} from "../../src/sysload/sampler.js";

const DARWIN_LOCAL = new Set(["apfs", "hfs", "exfat", "msdos", "zfs"]);

/** Minimal `mount(8)` parser for fixtures only (the real one is S0's protocol parser). */
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

const MOUNTS_APFS_ROOT = "/dev/disk0s1s1 on / (apfs, sealed, local, read-only, journaled)\n";

interface HostLog {
  readonly readHost: number[];
  readonly readMounts: number[];
  readonly deviceOf: string[];
  readonly listProcesses: number[];
  readonly statfs: string[];
  readonly procReads: string[];
}

const emptyLog = (): HostLog => ({
  readHost: [],
  readMounts: [],
  deviceOf: [],
  listProcesses: [],
  statfs: [],
  procReads: [],
});

interface HostOptions {
  reading?: () => Promise<SamplerHostReading | undefined>;
  mountsText?: string | Promise<string | undefined>;
  deviceOf?: (path: string) => Promise<number | undefined>;
}

const makeHost = (options: HostOptions, log: HostLog): SamplerHost => ({
  kind: "darwin",
  localFilesystems: DARWIN_LOCAL,
  readHost: (opts) => {
    log.readHost.push(opts.timeoutMs);
    return (options.reading ?? (() => Promise.resolve({ loadavg: [1.5, 1.6, 1.7], memAvailPct: 46, cores: 12 })))();
  },
  readMounts: (opts) => {
    log.readMounts.push(opts.timeoutMs);
    const text = options.mountsText ?? MOUNTS_APFS_ROOT;
    return typeof text === "string" ? Promise.resolve(text) : text;
  },
  parseMounts: parseMountText,
  deviceOf: (path) => {
    log.deviceOf.push(path);
    return (options.deviceOf ?? (() => Promise.resolve(16777233)))(path);
  },
  listProcesses: (opts) => {
    log.listProcesses.push(opts.timeoutMs);
    void opts.maxPids;
    return Promise.resolve({ procs: [], truncated: false });
  },
});

const hostIo = (host: SamplerHost, log: HostLog) => ({
  readFileSync: (path: string) => {
    log.procReads.push(path);
    throw new Error(`host path must never read ${path}`);
  },
  realpath: async (path: string) => path,
  statfs: async (path: string) => {
    log.statfs.push(path);
    return { blocks: 100n, bfree: 20n, bavail: 10n, bsize: 4096n };
  },
  host,
});

const freshLedger = (): IoLedger => new IoLedger({ active: new Map(), capacity: 2 });

/** Records every key ever acquired (tryAcquire success), on top of an isolated ledger. */
class RecordingLedger extends IoLedger {
  readonly acquired: string[] = [];
  tryAcquire(key: string) {
    const lease = super.tryAcquire(key);
    if (lease !== undefined) this.acquired.push(key);
    return lease;
  }
}

/** A ledger whose dev-slot is permanently full — isolates the "账本满 ⇒ unresolved" branch. */
class DevFullLedger extends IoLedger {
  tryAcquire(key: string) {
    return key.startsWith("host:dev:") ? undefined : super.tryAcquire(key);
  }
}

/** performance.now fake: the deadline computation (first call) sees 0; every later call sees
 * `later` — so left() is exactly 1000 − later for the whole tick (darwin-plan §4.2-D(2)). */
const freezeLeft = (later: number): (() => void) => {
  let calls = 0;
  const spy = vi.spyOn(performance, "now").mockImplementation(() => (calls++ === 0 ? 0 : later));
  return () => {
    spy.mockRestore();
  };
};

/** performance.now fake with an explicit per-call queue (exhausted ⇒ repeats the last value):
 * lets a test place the budget-check snapshot and the SUBSEQUENT clock reads on opposite sides
 * of the 50ms boundary (S1 review Major 1). */
const queueClock = (values: readonly number[]): (() => void) => {
  let index = 0;
  const spy = vi.spyOn(performance, "now").mockImplementation(() => values[Math.min(index++, values.length - 1)]!);
  return () => {
    spy.mockRestore();
  };
};

describe("sysload darwin sampler (host seam, §4.2-D)", () => {
  it("D1: full-ok sample — cpu invalid, advisory mem, loadavg/cores, dev-identity dedup", async () => {
    const log = emptyLog();
    const host = makeHost({}, log);
    const result = await sampleOnce(
      hostIo(host, log),
      { home: "/Users/blue", mono: () => 0, at: () => 1 },
      freshLedger(),
    );
    expect(log.procReads).toEqual([]);
    expect(result.sample.cpu).toEqual({ kind: "invalid" });
    expect(result.nextCpu).toBeUndefined();
    expect(result.sample.mem).toEqual({ kind: "ok", value: { availPct: 46, usedPct: 54 } });
    expect(result.sample.memAdvisory).toBe(true);
    expect(result.sample.loadavg).toEqual([1.5, 1.6, 1.7]);
    expect(result.sample.cores).toBe(12);
    // `/` and `~` share the APFS container dev ⇒ deduped to ONE `~` row (§2.3 挂载身份去重).
    expect(result.sample.disks).toHaveLength(1);
    expect(result.sample.disks[0]).toMatchObject({ label: "~" });
    const reading = result.sample.disks[0]!.reading;
    expect(reading).toMatchObject({ kind: "ok", value: { mountPath: "/", mountId: 16777233, dev: "16777233" } });
    expect(result.mountinfoText).toBe(MOUNTS_APFS_ROOT);
    expect(log.statfs).toEqual(["/Users/blue"]);
  });

  it("D1: distinct devs keep both rows; a remote home mount is skipped without deviceOf/statfs", async () => {
    const splitLog = emptyLog();
    const split = await sampleOnce(
      hostIo(makeHost({ deviceOf: () => Promise.resolve(Math.floor(Math.random() * 1e6)) }, splitLog), splitLog),
      { home: "/Users/blue", mono: () => 0, at: () => 1 },
      freshLedger(),
    );
    expect(split.sample.disks.map((disk) => disk.label)).toEqual(["~", "/"]);
    expect(split.sample.disks.every((disk) => disk.reading.kind === "ok")).toBe(true);

    const remoteLog = emptyLog();
    const remote = await sampleOnce(
      hostIo(
        makeHost(
          {
            mountsText: "//srv/share on /Users/blue (smbfs, nobrowse)\n/dev/disk0s1s1 on / (apfs, local)\n",
          },
          remoteLog,
        ),
        remoteLog,
      ),
      { home: "/Users/blue", mono: () => 0, at: () => 1 },
      freshLedger(),
    );
    expect(remote.sample.disks.find((disk) => disk.label === "~")?.reading).toEqual({
      kind: "skipped",
      reason: "remote",
    });
    expect(remote.sample.disks.find((disk) => disk.label === "/")?.reading.kind).toBe("ok");
    expect(remoteLog.deviceOf).toEqual(["/"]); // never the remote mount, never statfs on it
    expect(remoteLog.statfs).toEqual(["/"]);
  });

  it("D2: left() of 0 or 49 starts nothing — no host call, no lease, all readings unavailable", async () => {
    for (const later of [1_000, 951]) {
      const log = emptyLog();
      const ledger = new RecordingLedger({ active: new Map(), capacity: 2 });
      const restore = freezeLeft(later);
      try {
        const result = await sampleOnce(
          hostIo(makeHost({}, log), log),
          { home: "/", mono: () => 0, at: () => 1 },
          ledger,
        );
        expect(log.readHost).toEqual([]);
        expect(log.readMounts).toEqual([]);
        expect(log.deviceOf).toEqual([]);
        expect(log.statfs).toEqual([]);
        expect(ledger.acquired).toEqual([]);
        expect(ledger.size).toBe(0);
        expect(result.sample.cpu).toEqual({ kind: "invalid" });
        expect(result.sample.mem).toEqual({ kind: "invalid" });
        expect("loadavg" in result.sample).toBe(false);
        expect("cores" in result.sample).toBe(false);
        expect(result.sample.disks.every((disk) => disk.reading.kind === "unresolved")).toBe(true);
      } finally {
        restore();
      }
    }
  });

  it("D2: left() of exactly 50 still calls the host with timeoutMs 50; left() 3000 clamps to 800", async () => {
    for (const [later, expected] of [
      [950, 50],
      [-2_000, 800],
    ] as const) {
      const log = emptyLog();
      const restore = freezeLeft(later);
      try {
        const result = await sampleOnce(
          hostIo(makeHost({}, log), log),
          { home: "/", mono: () => 0, at: () => 1 },
          freshLedger(),
        );
        expect(log.readHost).toEqual([expected]);
        expect(log.readMounts).toEqual([expected]);
        expect(result.sample.mem.kind).toBe("ok");
      } finally {
        restore();
      }
    }
  });

  it("D2: the budget is ONE snapshot — a clock crossing the 50ms boundary mid-check never leaks a sub-50 call (Major 1)", async () => {
    // Snapshot exactly 49 ⇒ no lease, no host call at all (queue: deadline calc, then 49 forever).
    const at49 = emptyLog();
    const ledger49 = new RecordingLedger({ active: new Map(), capacity: 2 });
    const restore49 = queueClock([0, 951]);
    try {
      await sampleOnce(hostIo(makeHost({}, at49), at49), { home: "/", mono: () => 0, at: () => 1 }, ledger49);
      expect(at49.readHost).toEqual([]);
      expect(ledger49.acquired).toEqual([]);
      expect(ledger49.size).toBe(0);
    } finally {
      restore49();
    }

    // Snapshot exactly 50, but the NEXT clock read is already 49: the call proceeds with
    // timeoutMs 50 taken from the snapshot — never 49 (the pre-fix double-read computed 49).
    const crossing = emptyLog();
    const ledgerCross = new RecordingLedger({ active: new Map(), capacity: 2 });
    const restoreCross = queueClock([0, 950, 951]);
    try {
      await sampleOnce(
        hostIo(makeHost({}, crossing), crossing),
        { home: "/", mono: () => 0, at: () => 1 },
        ledgerCross,
      );
      expect(crossing.readHost).toEqual([50]);
      expect(ledgerCross.acquired).toContain("host:sysctl");
    } finally {
      restoreCross();
    }

    // Snapshot 51 ⇒ proceeds with 51.
    const at51 = emptyLog();
    const restore51 = queueClock([0, 949, 949]);
    try {
      await sampleOnce(hostIo(makeHost({}, at51), at51), { home: "/", mono: () => 0, at: () => 1 }, freshLedger());
      expect(at51.readHost).toEqual([51]);
    } finally {
      restore51();
    }

    // A non-finite snapshot ⇒ no lease, no call (the Number.isFinite guard).
    const nanLog = emptyLog();
    const nanLedger = new RecordingLedger({ active: new Map(), capacity: 2 });
    const restoreNan = queueClock([0, Number.NaN]);
    try {
      await sampleOnce(hostIo(makeHost({}, nanLog), nanLog), { home: "/", mono: () => 0, at: () => 1 }, nanLedger);
      expect(nanLog.readHost).toEqual([]);
      expect(nanLedger.acquired).toEqual([]);
    } finally {
      restoreNan();
    }
  });

  it("D3: a hung readHost settles the sample at the deadline and holds its lease until it really settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let releaseRead!: (value: SamplerHostReading | undefined) => void;
    const log = emptyLog();
    try {
      const hungReading = new Promise<SamplerHostReading | undefined>((resolve) => {
        releaseRead = resolve;
      });
      const host = makeHost({ reading: () => hungReading }, log);
      const ledger = freshLedger();
      const io = hostIo(host, log);
      const plan = { home: "/", mono: () => 0, at: () => 1, mountinfoText: MOUNTS_APFS_ROOT };
      const first = sampleOnce(io, plan, ledger);
      await vi.advanceTimersByTimeAsync(0);
      expect(ledger.has("host:sysctl")).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await first;
      expect(result.sample.mem).toEqual({ kind: "invalid" });
      // the wait ended, not the process: the lease is still held while the host hangs
      expect(ledger.has("host:sysctl")).toBe(true);
      expect(ledger.tryAcquire("host:sysctl")).toBeUndefined();

      // same-key single-flight: the second tick does NOT re-call the hung host
      const second = await sampleOnce(io, plan, ledger);
      expect(log.readHost).toHaveLength(1);
      expect(second.sample.mem).toEqual({ kind: "invalid" });
      expect(second.sample.disks.every((disk) => disk.reading.kind === "ok")).toBe(true);

      releaseRead(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(ledger.has("host:sysctl")).toBe(false);
    } finally {
      releaseRead?.(undefined);
      vi.useRealTimers();
    }
  });

  it("D4: deviceOf failure/reject/full-ledger ⇒ unresolved, statfs never called, seenMounts unpolluted", async () => {
    const failingLog = emptyLog();
    const failing = await sampleOnce(
      hostIo(
        makeHost(
          {
            deviceOf: (path) => Promise.resolve(path === "/Users/blue" ? undefined : 16777233),
          },
          failingLog,
        ),
        failingLog,
      ),
      { home: "/Users/blue", mono: () => 0, at: () => 1 },
      freshLedger(),
    );
    expect(failing.sample.disks.find((disk) => disk.label === "~")?.reading).toEqual({ kind: "unresolved" });
    expect(failing.sample.disks.find((disk) => disk.label === "/")?.reading.kind).toBe("ok");
    expect(failingLog.statfs).toEqual(["/"]); // only the proven mount

    const rejectingLog = emptyLog();
    const rejecting = await sampleOnce(
      hostIo(
        makeHost(
          {
            deviceOf: (path) =>
              path === "/Users/blue" ? Promise.reject(new Error("stat boom")) : Promise.resolve(16777233),
          },
          rejectingLog,
        ),
        rejectingLog,
      ),
      { home: "/Users/blue", mono: () => 0, at: (): number => 1 },
      freshLedger(),
    );
    expect(rejecting.sample.disks.find((disk) => disk.label === "~")?.reading).toEqual({ kind: "unresolved" });
    expect(rejecting.sample.disks.find((disk) => disk.label === "/")?.reading.kind).toBe("ok");

    const fullLog = emptyLog();
    const full = await sampleOnce(
      hostIo(makeHost({}, fullLog), fullLog),
      { home: "/Users/blue", mono: () => 0, at: () => 1 },
      new DevFullLedger({ active: new Map(), capacity: 2 }),
    );
    expect(full.sample.disks.every((disk) => disk.reading.kind === "unresolved")).toBe(true);
    expect(fullLog.statfs).toEqual([]);
  });

  it("D4: a deviceOf that outlives the budget ⇒ unresolved for that path only, lease settles late", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let releaseDevice!: (value: number | undefined) => void;
    const log = emptyLog();
    const ledger = freshLedger();
    try {
      const hungDevice = new Promise<number | undefined>((resolve) => {
        releaseDevice = resolve;
      });
      const host = makeHost(
        {
          deviceOf: (path) => (path === "/Users/blue" ? hungDevice : Promise.resolve(16777233)),
        },
        log,
      );
      const plan = { home: "/Users/blue", mono: () => 0, at: () => 1, mountinfoText: MOUNTS_APFS_ROOT };
      const scan = sampleOnce(hostIo(host, log), plan, ledger);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await scan;
      expect(result.sample.disks.find((disk) => disk.label === "~")?.reading).toEqual({ kind: "unresolved" });
      expect(result.sample.disks.find((disk) => disk.label === "/")?.reading.kind).toBe("ok");
      expect(log.statfs).toEqual(["/"]);
      expect(ledger.has("host:dev:/Users/blue")).toBe(true);
      releaseDevice(111);
      await vi.advanceTimersByTimeAsync(0);
      expect(ledger.has("host:dev:/Users/blue")).toBe(false);
    } finally {
      releaseDevice?.(undefined);
      vi.useRealTimers();
    }
  });

  it("D4: entering the deviceOf step with left() < 50 or a stale generation ⇒ invalid, deviceOf never called", async () => {
    // readHost consumes the budget: after it returns, left() is 49.
    let clock = 0;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const drainedLog = emptyLog();
    try {
      const host = makeHost(
        {
          reading: () => {
            clock = 951;
            return Promise.resolve({ loadavg: [1, 2, 3], memAvailPct: 46, cores: 12 });
          },
        },
        drainedLog,
      );
      const result = await sampleOnce(
        hostIo(host, drainedLog),
        {
          home: "/Users/blue",
          mono: () => 0,
          at: () => 1,
          mountinfoText: MOUNTS_APFS_ROOT,
        },
        freshLedger(),
      );
      expect(drainedLog.readHost).toEqual([800]);
      expect(drainedLog.deviceOf).toEqual([]);
      expect(drainedLog.statfs).toEqual([]);
      expect(result.sample.disks.every((disk) => disk.reading.kind === "invalid")).toBe(true);
    } finally {
      spy.mockRestore();
    }

    // generation flips during readHost: the deviceOf step then sees a stale tick ⇒ invalid, zero calls
    // (home "/" keeps resolvePath out of the picture — its own stale bail is the "unresolved" path).
    let generation = 0;
    const staleLog = emptyLog();
    const staleHost = makeHost(
      {
        reading: () => {
          generation = 1;
          return Promise.resolve({ loadavg: [1, 2, 3], memAvailPct: 46, cores: 12 });
        },
      },
      staleLog,
    );
    const stale = await sampleOnce(
      hostIo(staleHost, staleLog),
      {
        home: "/",
        mono: () => 0,
        at: () => 1,
        mountinfoText: MOUNTS_APFS_ROOT,
        expectedGeneration: () => generation,
      },
      freshLedger(),
    );
    expect(staleLog.deviceOf).toEqual([]);
    expect(staleLog.statfs).toEqual([]);
    expect(stale.sample.disks.every((disk) => disk.reading.kind === "invalid")).toBe(true);
  });

  it("D4: a generation flip settled INSIDE deviceOf ⇒ invalid (not unresolved), statfs never called (Minor)", async () => {
    let generation = 0;
    const log = emptyLog();
    const host = makeHost(
      {
        deviceOf: () => {
          generation = 1; // settle the dev, then invalidate the tick: hostBounded discards it
          return Promise.resolve(16777233);
        },
      },
      log,
    );
    const result = await sampleOnce(
      hostIo(host, log),
      {
        home: "/Users/blue",
        mono: () => 0,
        at: () => 1,
        mountinfoText: MOUNTS_APFS_ROOT,
        expectedGeneration: () => generation,
      },
      freshLedger(),
    );
    expect(log.deviceOf).toEqual(["/Users/blue"]);
    expect(log.statfs).toEqual([]);
    // Minor 修复：dev 缺席 + 代际失效 ⇒ invalid（区别于 deviceOf 真失败 ⇒ unresolved）；
    // "~" 在 deviceOf 内部翻代际，"/" 在进入 deviceOf 步骤时即非当前代。
    expect(result.sample.disks.map((disk) => disk.reading.kind)).toEqual(["invalid", "invalid"]);
  });

  it("D5: readHost undefined ⇒ mem invalid but disks still sampled; mountinfoText cache skips readMounts", async () => {
    const noHostLog = emptyLog();
    const noHost = await sampleOnce(
      hostIo(makeHost({ reading: () => Promise.resolve(undefined) }, noHostLog), noHostLog),
      { home: "/Users/blue", mono: () => 0, at: (): number => 1 },
      freshLedger(),
    );
    expect(noHost.sample.mem).toEqual({ kind: "invalid" });
    expect("loadavg" in noHost.sample).toBe(false);
    expect("cores" in noHost.sample).toBe(false);
    expect(noHost.sample.disks.every((disk) => disk.reading.kind === "ok")).toBe(true);
    expect(noHostLog.readMounts).toHaveLength(1);
    expect(noHost.mountinfoText).toBe(MOUNTS_APFS_ROOT);

    const cachedLog = emptyLog();
    const cached = await sampleOnce(
      hostIo(makeHost({}, cachedLog), cachedLog),
      {
        home: "/Users/blue",
        mono: () => 0,
        at: () => 1,
        mountinfoText: MOUNTS_APFS_ROOT,
      },
      freshLedger(),
    );
    expect(cachedLog.readMounts).toEqual([]);
    expect(cached.mountinfoText).toBe(MOUNTS_APFS_ROOT);
    expect(cached.sample.disks.every((disk) => disk.reading.kind === "ok")).toBe(true);
  });
});
