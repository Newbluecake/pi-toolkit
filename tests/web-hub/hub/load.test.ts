import { describe, expect, it } from "vitest";
import { createHubLoad, LOAD_TOP_WAITERS_MAX, normalizeHubLoadConfig } from "../../../src/web-hub/hub/load.js";
import type { HubLoadConfig } from "../../../src/web-hub/hub/ports.js";
import type { TopSnapshot } from "../../../src/sysload/types.js";

const config: HubLoadConfig = {
  sampleIntervalMs: 5_000,
  sustainMs: 60_000,
  recoverMs: 30_000,
  thresholds: {
    cpu: { warnPercent: 85, critPercent: 95, psiWarnPercent: 40, psiCritPercent: 70 },
    mem: { warnAvailPercent: 15, critAvailPercent: 8 },
    disk: { warnFreePercent: 10, critFreePercent: 5, critFreeGiB: 5 },
  },
};

const snapshot: TopSnapshot = {
  at: 10,
  byCpu: [{ comm: "node", count: 1, cpuPct: 12, rssBytes: 4096, pids: [{ pid: 42, cpuPct: 12, rssBytes: 4096 }] }],
  byRss: [{ comm: "node", count: 1, cpuPct: 12, rssBytes: 4096, pids: [{ pid: 42, cpuPct: 12, rssBytes: 4096 }] }],
};

function withThresholds(patch: {
  cpu?: Partial<HubLoadConfig["thresholds"]["cpu"]>;
  mem?: Partial<HubLoadConfig["thresholds"]["mem"]>;
  disk?: Partial<HubLoadConfig["thresholds"]["disk"]>;
}): HubLoadConfig {
  return {
    ...config,
    thresholds: {
      cpu: { ...config.thresholds.cpu, ...patch.cpu },
      mem: { ...config.thresholds.mem, ...patch.mem },
      disk: { ...config.thresholds.disk, ...patch.disk },
    },
  };
}

function withTimes(patch: Partial<Pick<HubLoadConfig, "sampleIntervalMs" | "sustainMs" | "recoverMs">>): HubLoadConfig {
  return { ...config, ...patch };
}

describe("normalizeHubLoadConfig", () => {
  it("accepts the valid config byte-for-byte (round-trip)", () => {
    expect(normalizeHubLoadConfig(config)).toEqual(config);
  });

  it("rejects non-object / array / null roots", () => {
    expect(normalizeHubLoadConfig(undefined)).toBeUndefined();
    expect(normalizeHubLoadConfig(null)).toBeUndefined();
    expect(normalizeHubLoadConfig("nope")).toBeUndefined();
    expect(normalizeHubLoadConfig(42)).toBeUndefined();
    expect(normalizeHubLoadConfig([])).toBeUndefined();
  });

  it("rejects a missing or non-record thresholds block", () => {
    expect(normalizeHubLoadConfig({ ...config, thresholds: undefined })).toBeUndefined();
    expect(normalizeHubLoadConfig({ ...config, thresholds: null })).toBeUndefined();
    expect(normalizeHubLoadConfig({ ...config, thresholds: 7 })).toBeUndefined();
    expect(normalizeHubLoadConfig({ ...config, thresholds: { ...config.thresholds, cpu: {} } })).toBeUndefined();
    expect(normalizeHubLoadConfig({ ...config, thresholds: { ...config.thresholds, mem: undefined } })).toBeUndefined();
    expect(normalizeHubLoadConfig({ ...config, thresholds: { ...config.thresholds, disk: null } })).toBeUndefined();
  });

  // warn/crit ordering — CPU and PSI are `warn <= crit`; MEM and DISK are the OPPOSITE
  // direction (`warn >= crit`) and are the two most likely to be written backwards.
  it("rejects cpu warnPercent > critPercent", () => {
    expect(normalizeHubLoadConfig(withThresholds({ cpu: { warnPercent: 90, critPercent: 85 } }))).toBeUndefined();
  });

  it("rejects cpu psiWarnPercent > psiCritPercent", () => {
    expect(normalizeHubLoadConfig(withThresholds({ cpu: { psiWarnPercent: 75, psiCritPercent: 70 } }))).toBeUndefined();
  });

  it("rejects mem warnAvailPercent < critAvailPercent (reversed direction)", () => {
    expect(
      normalizeHubLoadConfig(withThresholds({ mem: { warnAvailPercent: 5, critAvailPercent: 10 } })),
    ).toBeUndefined();
  });

  it("rejects disk warnFreePercent < critFreePercent (reversed direction)", () => {
    expect(
      normalizeHubLoadConfig(withThresholds({ disk: { warnFreePercent: 2, critFreePercent: 8 } })),
    ).toBeUndefined();
  });

  it.each([
    ["cpu.warnPercent", { cpu: { warnPercent: 101 } }],
    ["cpu.critPercent", { cpu: { critPercent: 101 } }],
    ["cpu.psiWarnPercent", { cpu: { psiWarnPercent: 101 } }],
    ["cpu.psiCritPercent", { cpu: { psiCritPercent: 101 } }],
    ["mem.warnAvailPercent", { mem: { warnAvailPercent: 101 } }],
    ["mem.critAvailPercent", { mem: { critAvailPercent: 101 } }],
    ["disk.warnFreePercent", { disk: { warnFreePercent: 101 } }],
    ["disk.critFreePercent", { disk: { critFreePercent: 101 } }],
  ] as const)("rejects percent > 100 on %s", (_name, patch) => {
    expect(normalizeHubLoadConfig(withThresholds(patch))).toBeUndefined();
  });

  it.each([
    ["cpu.warnPercent", { cpu: { warnPercent: -1 } }],
    ["cpu.critPercent", { cpu: { critPercent: -1 } }],
    ["mem.warnAvailPercent", { mem: { warnAvailPercent: -1 } }],
    ["disk.warnFreePercent", { disk: { warnFreePercent: -1 } }],
    ["disk.critFreeGiB", { disk: { critFreeGiB: -1 } }],
  ] as const)("rejects negative percent/bytes on %s", (_name, patch) => {
    expect(normalizeHubLoadConfig(withThresholds(patch))).toBeUndefined();
  });

  it("rejects critFreeGiB <= 0 (zero is not a valid floor)", () => {
    expect(normalizeHubLoadConfig(withThresholds({ disk: { critFreeGiB: 0 } }))).toBeUndefined();
  });

  it.each([
    ["non-number", { sampleIntervalMs: "5000" }],
    ["non-integer", { sampleIntervalMs: 2_500.5 }],
    ["below min", { sampleIntervalMs: 1_999 }],
    ["above max", { sampleIntervalMs: 60_001 }],
    ["NaN", { sampleIntervalMs: Number.NaN }],
  ] as const)("rejects sampleIntervalMs %s", (_name, patch) => {
    expect(normalizeHubLoadConfig(withTimes(patch))).toBeUndefined();
  });

  it.each([
    ["negative", { sustainMs: -1 }],
    ["non-integer", { sustainMs: 1_000.5 }],
    ["above 120×interval", { sustainMs: 120 * config.sampleIntervalMs + 1 }],
  ] as const)("rejects sustainMs %s", (_name, patch) => {
    expect(normalizeHubLoadConfig(withTimes(patch))).toBeUndefined();
  });

  it.each([
    ["below interval", { recoverMs: config.sampleIntervalMs - 1 }],
    ["non-integer", { recoverMs: 30_000.5 }],
    ["above 120×interval", { recoverMs: 120 * config.sampleIntervalMs + 1 }],
  ] as const)("rejects recoverMs %s", (_name, patch) => {
    expect(normalizeHubLoadConfig(withTimes(patch))).toBeUndefined();
  });

  it("accepts the boundary values (sustainMs 0, recoverMs == interval, 120×interval ceilings)", () => {
    expect(normalizeHubLoadConfig(withTimes({ sustainMs: 0, recoverMs: config.sampleIntervalMs }))).toEqual(
      withTimes({ sustainMs: 0, recoverMs: config.sampleIntervalMs }),
    );
    expect(
      normalizeHubLoadConfig(
        withTimes({ sustainMs: 120 * config.sampleIntervalMs, recoverMs: 120 * config.sampleIntervalMs }),
      ),
    ).toEqual(withTimes({ sustainMs: 120 * config.sampleIntervalMs, recoverMs: 120 * config.sampleIntervalMs }));
    expect(normalizeHubLoadConfig(withTimes({ sampleIntervalMs: 2_000 }))).toEqual(
      withTimes({ sampleIntervalMs: 2_000 }),
    );
  });
});

describe("hub sysload", () => {
  it("drops malformed config as one feature key", () => {
    expect(normalizeHubLoadConfig({ ...config, recoverMs: 1 })).toBeUndefined();
    expect(normalizeHubLoadConfig({ ...config, thresholds: { ...config.thresholds, cpu: {} } })).toBeUndefined();
    expect(normalizeHubLoadConfig(config)).toEqual(config);
  });

  it("shares one top scan, bounds waiters, and caches for two seconds", async () => {
    if (process.platform !== "linux") return;
    let now = 0;
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<TopSnapshot>((resolve) => {
      release = () => resolve(snapshot);
    });
    const service = createHubLoad(config, {
      home: "/",
      mono: () => now,
      now: () => now,
      scanTop: async () => {
        calls++;
        return pending;
      },
    });
    expect(service).toBeDefined();
    const first = service!.top();
    const waiters = Array.from({ length: LOAD_TOP_WAITERS_MAX }, () => service!.top());
    await expect(service!.top()).rejects.toMatchObject({ code: "E_BUSY" });
    release();
    await Promise.all([first, ...waiters]);
    expect(calls).toBe(1);
    await service!.top();
    expect(calls).toBe(1);
    now = 2_001;
    const second = service!.top();
    await second;
    expect(calls).toBe(2);
    await service!.dispose();
  });
});
