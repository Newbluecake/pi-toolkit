// sysload wire projection: the overall-level "held since" anchor (2026-10-16 field report
// 「已持续 0s」 — the hub used to project `sample.mono - verdict.mono` ≡ 0).
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { loadFingerprint, projectLoadWire } from "../../src/sysload/wire.js";
import type { LoadSample, LoadVerdict } from "../../src/sysload/types.js";

const verdict: LoadVerdict = {
  level: "ok",
  gating: false,
  metrics: { cpu: { level: "ok" }, mem: { level: "ok" }, disk: [] },
  mono: 100_000,
  at: 1_000_000,
};

describe("projectLoadWire — sinceAgoMs", () => {
  it("anchors on the caller-tracked overall level-since mono when given", () => {
    const wire = projectLoadWire(verdict, DEFAULT_SETTINGS.load, 100_000, 1_000_000, undefined, 40_000);
    expect(wire.sinceAgoMs).toBe(60_000);
  });

  it("legacy call (no level-since) keeps now - verdict.mono", () => {
    expect(projectLoadWire(verdict, DEFAULT_SETTINGS.load, 100_500).sinceAgoMs).toBe(500);
  });

  it("a level-since in the future is dropped, never negative", () => {
    const wire = projectLoadWire(verdict, DEFAULT_SETTINGS.load, 100_000, 1_000_000, undefined, 200_000);
    expect(wire.sinceAgoMs).toBeUndefined();
  });
});

// darwin-plan §4.3b (S3, user Q1 2026-11-18): top-level `LoadWire.cores` is the cpu-less
// platform's core-count disclosure. Emitted ONLY when the CPU reading is absent and the count
// passes projection-side validation; a Linux frame (cpu always present) keeps its exact key set
// and `loadFingerprint` bytes (I10 append-only — no PROTO bump, old hub × new UI / new hub × old
// UI both harmless because the key is optional).
describe("projectLoadWire — top-level cores disclosure (S3)", () => {
  /** A darwin-shaped sample: no CPU reading, cores from the host seam (darwin-plan §2.2/§2.3). */
  const darwinSample: LoadSample = {
    mono: 100_000,
    at: 1_000_000,
    cpu: { kind: "invalid" },
    mem: { kind: "ok", value: { availPct: 46, usedPct: 54 } },
    disks: [],
    loadavg: [2.35, 2.36, 2.38],
    cores: 12,
  };
  /** The cpu-less verdict the tracker produces for that sample (cores folded in via §2.8's
   *  fallback: `sample.cores` enters `LoadVerdict.cores` when the CPU reading is absent). */
  const darwinVerdict: LoadVerdict = {
    level: "ok",
    gating: false,
    metrics: { cpu: { level: "unknown" }, mem: { level: "unknown" }, disk: [] },
    mono: 100_000,
    at: 1_000_000,
    loadavg: [2.35, 2.36, 2.38],
    cores: 12,
  };

  it("① cpu absent + sample.cores ⇒ top-level cores, still no cpu key", () => {
    const wire = projectLoadWire(darwinVerdict, DEFAULT_SETTINGS.load, 100_000, 1_000_000, darwinSample, 40_000);
    expect(wire.cores).toBe(12);
    expect("cpu" in wire).toBe(false);
  });

  it("② Linux shape (cpu present) ⇒ NO top-level cores key, frame bytes and fingerprint identical", () => {
    const linuxVerdict: LoadVerdict = {
      level: "warn",
      gating: false,
      metrics: {
        cpu: { level: "warn" },
        mem: { level: "ok" },
        disk: [
          { label: "~", state: { level: "ok" } },
          { label: "/", state: { level: "crit" } },
        ],
      },
      mono: 100_000,
      at: 1_000_000,
    };
    const linuxSample: LoadSample & { ioPsiPct?: number } = {
      mono: 100_000,
      at: 1_000_000,
      cpu: { kind: "ok", value: { busyPct: 73.5, psiPct: 12.25, cores: 8 } },
      mem: { kind: "ok", value: { availPct: 46, usedPct: 54 } },
      disks: [
        {
          label: "~",
          reading: {
            kind: "ok",
            value: { mountPath: "/home", freePct: 55, freeBytes: 11, totalBytes: 22, mountId: 42, dev: "8:2" },
          },
        },
        { label: "/", reading: { kind: "skipped", reason: "remote" } },
      ],
      loadavg: [2.25, 2.5, 2.75],
      ioPsiPct: 5.5,
    };
    const wire = projectLoadWire(linuxVerdict, DEFAULT_SETTINGS.load, 100_000, 1_000_000, linuxSample, 40_000);
    expect(Object.keys(wire)).not.toContain("cores");
    // Byte-for-byte the PRE-S3 output for the same inputs (captured against the S3-less
    // projection, 2026-11-18) — inline literal on purpose: no external golden involved.
    expect(JSON.stringify(wire)).toBe(
      '{"v":1,"at":1000000,"sinceAgoMs":60000,"intervalMs":5000,"scope":"host",' +
        '"io":{"psiPct":5.5},"level":"warn",' +
        '"thresholds":{"cpu":{"warnPercent":85,"critPercent":95,"psiWarnPercent":40,"psiCritPercent":70},' +
        '"mem":{"warnAvailPercent":15,"critAvailPercent":8},' +
        '"disk":{"warnFreePercent":10,"critFreePercent":5,"critFreeGiB":5}},' +
        '"disks":[{"label":"~","path":"/home","usedPct":45,"freeBytes":11,"totalBytes":22,"level":"ok"},' +
        '{"label":"/","path":"/","usedPct":0,"freeBytes":0,"totalBytes":0,"level":"crit","skipped":"remote"}],' +
        '"cpu":{"busyPct":73.5,"psiPct":12.25,"level":"warn","cores":8},' +
        '"mem":{"availPct":46,"usedPct":54,"level":"ok"},"loadavg":[2.25,2.5,2.75]}',
    );
    expect(loadFingerprint(wire)).toBe(
      '{"v":1,"intervalMs":5000,"scope":"host","io":{"psiPct":5.5},"level":"warn",' +
        '"thresholds":{"cpu":{"warnPercent":85,"critPercent":95,"psiWarnPercent":40,"psiCritPercent":70},' +
        '"mem":{"warnAvailPercent":15,"critAvailPercent":8},' +
        '"disk":{"warnFreePercent":10,"critFreePercent":5,"critFreeGiB":5}},' +
        '"disks":[{"label":"~","path":"/home","usedPct":45,"freeBytes":11,"totalBytes":22,"level":"ok"},' +
        '{"label":"/","path":"/","usedPct":0,"freeBytes":0,"totalBytes":0,"level":"crit","skipped":"remote"}],' +
        '"cpu":{"busyPct":73.5,"psiPct":12.25,"level":"warn","cores":8},' +
        '"mem":{"availPct":46,"usedPct":54,"level":"ok"},"loadavg":[2.25,2.5,2.75]}',
    );
  });

  it("③ cpu absent without cores ⇒ still no cores key (unchanged cpu-less frame)", () => {
    const { cores: _cores, ...noCores } = darwinSample;
    const wire = projectLoadWire(darwinVerdict, DEFAULT_SETTINGS.load, 100_000, 1_000_000, noCores);
    expect("cores" in wire).toBe(false);
    expect("cpu" in wire).toBe(false);
  });

  it("④ invalid sample.cores is dropped by projection-side self-validation, never forwarded", () => {
    for (const bad of [0, -4, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 4097]) {
      const wire = projectLoadWire(darwinVerdict, DEFAULT_SETTINGS.load, 100_000, 1_000_000, {
        ...darwinSample,
        cores: bad,
      });
      expect(!("cores" in wire), `cores=${bad}`).toBe(true);
    }
  });
});
