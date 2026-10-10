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
