/**
 * darwin-plan §4.2-T: the tracker behind darwin-shaped samples — CPU always `invalid`, mem
 * carrying `memAdvisory` (display-only, §2.9/Q3), disk driving the level. Also pins the
 * reversibility of the advisory flag (removing it re-enters the normal Linux path).
 */
import { describe, expect, it } from "vitest";
import { parseLoadSettings } from "../../src/sysload/settings.js";
import { createLoadTracker } from "../../src/sysload/tracker.js";
import type { LoadSample, LoadDiskPathSample } from "../../src/sysload/types.js";

const settings = parseLoadSettings({ sampleIntervalMs: 5_000, sustainMs: 0, recoverMs: 5_000 });

const disk = (freePct: number, freeBytes = 100 * 2 ** 30): LoadDiskPathSample => ({
  label: "/",
  reading: {
    kind: "ok",
    value: { mountPath: "/", freePct, freeBytes, totalBytes: 200 * 2 ** 30, mountId: 1, dev: "8:1" },
  },
});

function darwinSample(
  mono: number,
  opts: {
    availPct?: number;
    memAdvisory?: boolean;
    disks?: readonly LoadDiskPathSample[];
    cores?: number;
  } = {},
): LoadSample {
  const availPct = opts.availPct ?? 50;
  return {
    mono,
    at: mono,
    cpu: { kind: "invalid" },
    mem: { kind: "ok", value: { availPct, usedPct: 100 - availPct } },
    disks: opts.disks ?? [disk(50)],
    ...(opts.memAdvisory === false ? {} : { memAdvisory: true }),
    ...(opts.cores === undefined ? {} : { cores: opts.cores }),
  };
}

describe("sysload darwin tracker (§4.2-T)", () => {
  it("disk alone drives the level: crit disk gates even with CPU absent and mem advisory", () => {
    const tracker = createLoadTracker(settings);
    tracker.observe(darwinSample(0, { availPct: 3, disks: [disk(3, 1 * 2 ** 30)] }));
    tracker.observe(darwinSample(5_000, { availPct: 3, disks: [disk(3, 1 * 2 ** 30)] }));
    const verdict = tracker.verdict(5_000);
    expect(verdict.level).toBe("crit");
    expect(verdict.gating).toBe(true);
    expect(verdict.metrics.cpu.level).toBe("unknown");
    expect(verdict.metrics.mem.level).toBe("unknown");
    expect(verdict.metrics.disk[0]?.state.level).toBe("crit");
  });

  it("advisory mem is display-only: level stays unknown, no gate, but availPct is preserved", () => {
    const tracker = createLoadTracker(settings);
    for (let mono = 0; mono <= 20_000; mono += 5_000) {
      const transition = tracker.observe(darwinSample(mono, { availPct: 3 }));
      expect(transition.gateCleared).toBe(false);
      expect(transition.provenRecovered).toBe(false);
      expect(transition.escalatedTo).toBeUndefined();
    }
    const verdict = tracker.verdict(20_000);
    expect(verdict.metrics.mem.level).toBe("unknown");
    expect(verdict.metrics.mem.availPct).toBe(3);
    expect(verdict.metrics.mem.lastValidMono).toBe(20_000);
    expect(verdict.level).toBe("ok"); // disk ok; advisory mem never enters the overall level
    expect(verdict.gating).toBe(false);
  });

  it("removing the advisory flag re-enters the normal path: the same mem series escalates (reversibility)", () => {
    const tracker = createLoadTracker(settings);
    for (let mono = 0; mono <= 10_000; mono += 5_000)
      tracker.observe(darwinSample(mono, { availPct: 3, memAdvisory: false }));
    const verdict = tracker.verdict(10_000);
    expect(verdict.metrics.mem.level).toBe("crit");
    expect(verdict.level).toBe("crit");
    expect(verdict.gating).toBe(true);
  });

  it("an advisory switch after a REAL crit mem drops mem out of the level composition entirely (Major 2)", () => {
    const tracker = createLoadTracker(settings);
    // 非 advisory 时代：mem 真实升到 crit 并 gate
    tracker.observe(darwinSample(0, { availPct: 3, memAdvisory: false }));
    tracker.observe(darwinSample(5_000, { availPct: 3, memAdvisory: false }));
    expect(tracker.verdict(5_000).metrics.mem.level).toBe("crit");
    expect(tracker.verdict(5_000).gating).toBe(true);
    // 同一 tracker 切到 advisory：存量 crit 等级与挂起窗口必须被清除，不再计入 overall/gate
    const transition = tracker.observe(darwinSample(10_000, { availPct: 3 }));
    expect(transition.gateCleared).toBe(true);
    expect(transition.provenRecovered).toBe(false);
    expect(transition.escalatedTo).toBeUndefined();
    const verdict = tracker.verdict(10_000);
    expect(verdict.metrics.mem.level).toBe("unknown");
    expect(verdict.metrics.mem.availPct).toBe(3); // 显示值照常
    expect(verdict.level).toBe("ok"); // overall 不再含 mem
    expect(verdict.gating).toBe(false);
    // 持续 advisory：保持 unknown
    tracker.observe(darwinSample(15_000, { availPct: 3 }));
    expect(tracker.verdict(15_000).metrics.mem.level).toBe("unknown");
    expect(tracker.verdict(15_000).level).toBe("ok");
    // 切回非 advisory（模拟 D1 启用）：从 unknown 重新正常升级
    tracker.observe(darwinSample(20_000, { availPct: 3, memAdvisory: false }));
    expect(tracker.verdict(20_000).metrics.mem.level).toBe("crit");
    expect(tracker.verdict(20_000).gating).toBe(true);
  });

  it("an advisory INVALID mem sample after a REAL crit also drops the stale level (R2: unconditional)", () => {
    const tracker = createLoadTracker(settings);
    tracker.observe(darwinSample(0, { availPct: 3, memAdvisory: false }));
    tracker.observe(darwinSample(5_000, { availPct: 3, memAdvisory: false }));
    expect(tracker.verdict(5_000).metrics.mem.level).toBe("crit");
    expect(tracker.verdict(5_000).gating).toBe(true);
    const invalidAdvisory: LoadSample = {
      mono: 10_000,
      at: 10_000,
      cpu: { kind: "invalid" },
      mem: { kind: "invalid" },
      disks: [disk(50)],
      memAdvisory: true,
    };
    const transition = tracker.observe(invalidAdvisory);
    expect(transition.gateCleared).toBe(true);
    const verdict = tracker.verdict(10_000);
    expect(verdict.metrics.mem.level).toBe("unknown");
    expect(verdict.level).toBe("ok");
    expect(verdict.gating).toBe(false);
  });

  it("an advisory UNTRUSTED mem sample after a REAL crit clears the level and does not refresh the display (R2)", () => {
    const tracker = createLoadTracker(settings);
    tracker.observe(darwinSample(0, { availPct: 3, memAdvisory: false }));
    tracker.observe(darwinSample(5_000, { availPct: 3, memAdvisory: false }));
    expect(tracker.verdict(5_000).metrics.mem.level).toBe("crit");
    const untrustedAdvisory: LoadSample = {
      mono: 10_000,
      at: 10_000,
      cpu: { kind: "invalid" },
      mem: { kind: "ok", value: { availPct: 90, usedPct: 42 } }, // usedPct ≠ 100 − availPct ⇒ 不可信
      disks: [disk(50)],
      memAdvisory: true,
    };
    const transition = tracker.observe(untrustedAdvisory);
    expect(transition.gateCleared).toBe(true);
    const verdict = tracker.verdict(10_000);
    expect(verdict.metrics.mem.level).toBe("unknown");
    expect(verdict.level).toBe("ok");
    expect(verdict.gating).toBe(false);
    expect(verdict.metrics.mem.availPct).toBe(3); // 不可信读数不刷新显示值
    expect(verdict.metrics.mem.lastValidMono).toBe(5_000);
  });

  it("fail-open: all-invalid disks with advisory mem keep the overall level unknown and the gate closed", () => {
    const tracker = createLoadTracker(settings);
    tracker.observe(darwinSample(0, { availPct: 3, disks: [{ label: "/", reading: { kind: "invalid" } }] }));
    tracker.observe(darwinSample(5_000, { availPct: 3, disks: [{ label: "/", reading: { kind: "invalid" } }] }));
    const verdict = tracker.verdict(5_000);
    expect(verdict.level).toBe("unknown");
    expect(verdict.gating).toBe(false);
    expect(verdict.metrics.mem.availPct).toBe(3);
  });

  it("cores falls back to sample.cores when the CPU reading is absent; cpu.cores wins otherwise", () => {
    const tracker = createLoadTracker(settings);
    tracker.observe(darwinSample(0, { cores: 12 }));
    expect(tracker.verdict(0).cores).toBe(12);
    // display value is sticky like loadavg: a later core-less sample keeps the last known count
    tracker.observe(darwinSample(5_000));
    expect(tracker.verdict(5_000).cores).toBe(12);
    const fresh = createLoadTracker(settings);
    fresh.observe(darwinSample(0));
    expect(fresh.verdict(0).cores).toBeUndefined();

    const linuxLike: LoadSample = {
      mono: 10_000,
      at: 10_000,
      cpu: { kind: "ok", value: { busyPct: 10, cores: 8 } },
      mem: { kind: "ok", value: { availPct: 50, usedPct: 50 } },
      disks: [disk(50)],
      cores: 12, // even if a stray sample carries both, the CPU reading is authoritative
    };
    tracker.observe(linuxLike);
    expect(tracker.verdict(10_000).cores).toBe(8);
  });

  it("implausible advisory readings fold to invalid instead of displaying", () => {
    const tracker = createLoadTracker(settings);
    const bogus: LoadSample = {
      mono: 0,
      at: 0,
      cpu: { kind: "invalid" },
      mem: { kind: "ok", value: { availPct: 3, usedPct: 42 } }, // usedPct ≠ 100 − availPct
      disks: [disk(50)],
      memAdvisory: true,
    };
    tracker.observe(bogus);
    tracker.observe(darwinSample(5_000, { availPct: 46 }));
    const verdict = tracker.verdict(5_000);
    expect(verdict.metrics.mem.level).toBe("unknown");
    expect(verdict.metrics.mem.availPct).toBe(46); // the plausible sample is displayed
    expect(verdict.level).toBe("ok");
  });
});
