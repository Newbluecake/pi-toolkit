import { describe, expect, it } from "vitest";
import { parseLoadSettings } from "../../src/config/settings.js";
import { createLoadTracker } from "../../src/sysload/tracker.js";
import type { LoadSample } from "../../src/sysload/types.js";

const settings = parseLoadSettings({ sampleIntervalMs: 5_000, sustainMs: 10_000, recoverMs: 5_000 });
function sample(mono: number, busyPct: number, availPct = 50, freePct = 50, freeBytes = 100 * 2 ** 30): LoadSample {
  return {
    mono,
    at: mono,
    cpu: { kind: "ok", value: { busyPct, cores: 8 } },
    mem: { kind: "ok", value: { availPct, usedPct: 100 - availPct } },
    disks: [
      {
        label: "/",
        reading: {
          kind: "ok",
          value: { mountPath: "/", freePct, freeBytes, totalBytes: 200 * 2 ** 30, mountId: 1, dev: "8:1" },
        },
      },
    ],
  };
}

describe("sysload tracker", () => {
  it("requires elapsed sustain time and handles equality thresholds", () => {
    const tracker = createLoadTracker(settings);
    tracker.observe(sample(0, 95));
    expect(tracker.verdict(0).level).toBe("unknown");
    tracker.observe(sample(5_000, 95));
    expect(tracker.verdict(5_000).level).toBe("unknown");
    tracker.observe(sample(10_000, 95));
    expect(tracker.verdict(10_000).level).toBe("crit");
    expect(tracker.verdict(10_000).gating).toBe(true);
    expect(tracker.verdict(15_000).gatingSinceMono).toBe(10_000);
    expect(tracker.verdict(15_000).metrics.cpu.levelSinceMono).toBe(10_000);
  });

  it("recovers with hysteresis and reports gate clearing, but not unknown as recovery", () => {
    const tracker = createLoadTracker(parseLoadSettings({ sampleIntervalMs: 5_000, sustainMs: 0, recoverMs: 5_000 }));
    tracker.observe(sample(0, 96));
    tracker.observe(sample(1, 96));
    expect(tracker.verdict(1).level).toBe("crit");
    tracker.observe(sample(2, 70));
    expect(tracker.verdict(2).level).toBe("crit");
    const transition = tracker.observe(sample(7_000, 70));
    expect(transition.gateCleared).toBe(true);
    expect(transition.provenRecovered).toBe(true);
    expect(tracker.verdict(7_000).level).toBe("warn");
    expect(tracker.verdict(7_000).gatingSinceMono).toBeUndefined();
  });

  it("requires both non-default disk recovery margins", () => {
    const tracker = createLoadTracker(
      parseLoadSettings({
        sustainMs: 0,
        recoverMs: 5_000,
        disk: { warnFreePercent: 20, critFreePercent: 10, critFreeGiB: 10 },
      }),
    );
    tracker.observe(sample(0, 10, 50, 4, 1 * 2 ** 30));
    expect(tracker.verdict(0).level).toBe("crit");
    tracker.observe(sample(1, 10, 50, 12, 12 * 2 ** 30));
    tracker.observe(sample(5_001, 10, 50, 12, 12 * 2 ** 30));
    expect(tracker.verdict(5_001).level).toBe("warn");
  });

  it("does not escalate before a real 60-second sustain window", () => {
    const tracker = createLoadTracker(parseLoadSettings({ sustainMs: 60_000 }));
    for (let mono = 0; mono <= 55_000; mono += 5_000) tracker.observe(sample(mono, 95));
    expect(tracker.verdict(55_000).level).not.toBe("crit");
  });

  it("breaks disk continuity when mount identity changes", () => {
    const tracker = createLoadTracker(parseLoadSettings({ sustainMs: 0, recoverMs: 5_000 }));
    tracker.observe(sample(0, 10, 50, 4, 1 * 2 ** 30));
    const clear = sample(1, 10, 50, 50, 100 * 2 ** 30);
    tracker.observe(clear);
    const changed = {
      ...clear,
      mono: 2_000,
      disks: clear.disks.map((disk) =>
        disk.label === "/" && disk.reading.kind === "ok"
          ? { ...disk, reading: { ...disk.reading, value: { ...disk.reading.value, mountId: 2 } } }
          : disk,
      ),
    };
    tracker.observe(changed);
    expect(tracker.verdict(2_000).level).toBe("crit");
  });

  it("keeps the gate disabled even when a high level is observed", () => {
    const tracker = createLoadTracker(parseLoadSettings({ sustainMs: 0, gate: false }));
    tracker.observe(sample(0, 99));
    expect(tracker.verdict(0).gating).toBe(false);
  });

  it("fails open after stale input", () => {
    const tracker = createLoadTracker(parseLoadSettings({ sampleIntervalMs: 5_000, sustainMs: 0, recoverMs: 5_000 }));
    tracker.observe(sample(0, 99));
    expect(tracker.verdict(20_001).level).toBe("unknown");
    expect(tracker.verdict(20_001).gating).toBe(false);
  });
});
