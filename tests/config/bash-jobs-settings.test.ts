import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, parseBashJobsSettings } from "../../src/config/settings.js";

const defaults = DEFAULT_SETTINGS.bashJobs;

describe("bashJobs settings block (§6)", () => {
  it("pins the documented defaults (R2/R4/R5, bash-timeout-grace §5.1)", () => {
    expect(defaults).toEqual({
      autoBackgroundMs: 290_000,
      maxLogBytes: 10_485_760,
      maxBackgroundJobs: 8,
      retentionMs: 24 * 60 * 60 * 1_000,
      drainTimeoutMs: 30_000,
      shutdownPolicy: "keep",
      childSessions: true,
      childSettleHold: true,
      childSettleHoldMaxRounds: 0,
      timeoutGraceMs: 60_000,
      maxExtensions: 3,
      maxTimeoutFactor: 3,
    });
    // optional fields are absent, not `undefined` (exactOptionalPropertyTypes)
    expect("dir" in defaults).toBe(false);
    expect("shellPath" in defaults).toBe(false);
  });

  it("falls back to defaults for missing / non-object blocks", () => {
    for (const input of [undefined, null, 0, "", "nope", true, [], [1, 2]]) {
      expect(parseBashJobsSettings(input)).toEqual(defaults);
    }
    expect(parseBashJobsSettings({})).toEqual(defaults);
  });

  it("returns a fresh object, never the shared default instance", () => {
    const parsed = parseBashJobsSettings({});
    expect(parsed).not.toBe(defaults);
    parsed.autoBackgroundMs = 1;
    expect(defaults.autoBackgroundMs).toBe(290_000);
  });

  it("accepts 0 for autoBackgroundMs (whole feature off)", () => {
    expect(parseBashJobsSettings({ autoBackgroundMs: 0 }).autoBackgroundMs).toBe(0);
    expect(loadSettings({ bashJobs: { autoBackgroundMs: 0 } }).bashJobs.autoBackgroundMs).toBe(0);
  });

  it("accepts finite non-negative numbers for every numeric field", () => {
    expect(
      parseBashJobsSettings({
        autoBackgroundMs: 30_000,
        maxLogBytes: 1_024,
        maxBackgroundJobs: 2,
        retentionMs: 0,
      }),
    ).toEqual({
      autoBackgroundMs: 30_000,
      maxLogBytes: 1_024,
      maxBackgroundJobs: 2,
      retentionMs: 0,
      drainTimeoutMs: defaults.drainTimeoutMs,
      shutdownPolicy: "keep",
      childSessions: defaults.childSessions,
      childSettleHold: defaults.childSettleHold,
      childSettleHoldMaxRounds: defaults.childSettleHoldMaxRounds,
      timeoutGraceMs: defaults.timeoutGraceMs,
      maxExtensions: defaults.maxExtensions,
      maxTimeoutFactor: defaults.maxTimeoutFactor,
    });
  });

  it("rejects NaN / Infinity / negative / non-number per numeric field", () => {
    const bad = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      -0.5,
      "1000",
      null,
      undefined,
      true,
      {},
      [],
    ];
    const numericKeys = ["autoBackgroundMs", "maxLogBytes", "maxBackgroundJobs", "retentionMs"] as const;
    for (const key of numericKeys) {
      for (const value of bad) {
        expect(parseBashJobsSettings({ [key]: value })[key], `${key} = ${String(value)}`).toBe(defaults[key]);
      }
    }
  });

  it("whitelists shutdownPolicy and falls back on anything else", () => {
    expect(parseBashJobsSettings({ shutdownPolicy: "keep" }).shutdownPolicy).toBe("keep");
    expect(parseBashJobsSettings({ shutdownPolicy: "kill" }).shutdownPolicy).toBe("kill");
    for (const value of ["KILL", "Keep", "terminate", "", 0, 1, null, undefined, true, {}, []]) {
      expect(parseBashJobsSettings({ shutdownPolicy: value }).shutdownPolicy).toBe("keep");
    }
  });

  it("keeps non-empty dir / shellPath strings and drops illegal ones", () => {
    const parsed = parseBashJobsSettings({ dir: "/tmp/jobs", shellPath: "/bin/bash" });
    expect(parsed.dir).toBe("/tmp/jobs");
    expect(parsed.shellPath).toBe("/bin/bash");
    for (const value of ["", 0, 1, null, undefined, true, {}, []]) {
      const out = parseBashJobsSettings({ dir: value, shellPath: value });
      expect("dir" in out, `dir = ${String(value)}`).toBe(false);
      expect("shellPath" in out, `shellPath = ${String(value)}`).toBe(false);
    }
  });

  it("mixes valid and invalid fields independently", () => {
    expect(
      parseBashJobsSettings({
        autoBackgroundMs: 5_000,
        maxLogBytes: Number.NaN,
        maxBackgroundJobs: -3,
        retentionMs: 1,
        shutdownPolicy: "nope",
        dir: 42,
      }),
    ).toEqual({
      autoBackgroundMs: 5_000,
      maxLogBytes: defaults.maxLogBytes,
      maxBackgroundJobs: defaults.maxBackgroundJobs,
      retentionMs: 1,
      drainTimeoutMs: defaults.drainTimeoutMs,
      shutdownPolicy: "keep",
      childSessions: defaults.childSessions,
      childSettleHold: defaults.childSettleHold,
      childSettleHoldMaxRounds: defaults.childSettleHoldMaxRounds,
      timeoutGraceMs: defaults.timeoutGraceMs,
      maxExtensions: defaults.maxExtensions,
      maxTimeoutFactor: defaults.maxTimeoutFactor,
    });
  });

  it("accepts a positive drain timeout and falls back for invalid values", () => {
    expect(parseBashJobsSettings({ drainTimeoutMs: 600 }).drainTimeoutMs).toBe(600);
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, "600"]) {
      expect(parseBashJobsSettings({ drainTimeoutMs: value }).drainTimeoutMs).toBe(defaults.drainTimeoutMs);
    }
  });

  it("reads drainTimeoutS and migrates legacy drainTimeoutMs", () => {
    expect(loadSettings({ bashJobs: { drainTimeoutS: 5 } }).bashJobs.drainTimeoutMs).toBe(5_000);
    expect(loadSettings({ bashJobs: { drainTimeoutS: 0 } }).bashJobs.drainTimeoutMs).toBe(defaults.drainTimeoutMs);
    expect(loadSettings({ bashJobs: { drainTimeoutMs: 5_000 } }).bashJobs.drainTimeoutMs).toBe(5_000);
  });
  it("is wired into loadSettings", () => {
    expect(loadSettings(undefined).bashJobs).toEqual(defaults);
    expect(loadSettings({}).bashJobs).toEqual(defaults);
    expect(loadSettings({ bashJobs: "garbage" }).bashJobs).toEqual(defaults);
    expect(loadSettings({ bashJobs: { shutdownPolicy: "kill", maxBackgroundJobs: 1 } }).bashJobs).toEqual({
      ...defaults,
      shutdownPolicy: "kill",
      maxBackgroundJobs: 1,
    });
  });

  it("reads its durations from the file as integer seconds (`*S`), byte/count keys unchanged", () => {
    expect(
      loadSettings({ bashJobs: { autoBackgroundS: 30, retentionS: 3_600, drainTimeoutS: 5, maxLogBytes: 2_048 } })
        .bashJobs,
    ).toEqual({
      ...defaults,
      autoBackgroundMs: 30_000,
      retentionMs: 3_600_000,
      drainTimeoutMs: 5_000,
      maxLogBytes: 2_048,
    });
    // 0 (feature off / prune immediately) survives the conversion
    expect(loadSettings({ bashJobs: { autoBackgroundS: 0, retentionS: 0 } }).bashJobs).toEqual({
      ...defaults,
      autoBackgroundMs: 0,
      retentionMs: 0,
    });
    // illegal seconds fall back field-by-field
    expect(loadSettings({ bashJobs: { autoBackgroundS: "30", retentionS: -1 } }).bashJobs).toEqual(defaults);
  });

  describe("bash-timeout-grace §5.1 new keys (U1/U2/U4/C3)", () => {
    it("childSessions/childSettleHold default true and fall back to true for non-boolean input", () => {
      expect(parseBashJobsSettings({}).childSessions).toBe(true);
      expect(parseBashJobsSettings({}).childSettleHold).toBe(true);
      expect(parseBashJobsSettings({ childSessions: false }).childSessions).toBe(false);
      expect(parseBashJobsSettings({ childSettleHold: false }).childSettleHold).toBe(false);
      for (const value of ["false", 0, 1, null, undefined, {}, []]) {
        expect(parseBashJobsSettings({ childSessions: value }).childSessions, `childSessions=${String(value)}`).toBe(
          true,
        );
        expect(
          parseBashJobsSettings({ childSettleHold: value }).childSettleHold,
          `childSettleHold=${String(value)}`,
        ).toBe(true);
      }
    });

    it("childSettleHoldMaxRounds: 0 = auto (default), positive integers pass through, non-integer/negative fall back to 0", () => {
      expect(parseBashJobsSettings({}).childSettleHoldMaxRounds).toBe(0);
      expect(parseBashJobsSettings({ childSettleHoldMaxRounds: 0 }).childSettleHoldMaxRounds).toBe(0);
      expect(parseBashJobsSettings({ childSettleHoldMaxRounds: 40 }).childSettleHoldMaxRounds).toBe(40);
      for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "40", null, undefined, true, {}, []]) {
        expect(
          parseBashJobsSettings({ childSettleHoldMaxRounds: value }).childSettleHoldMaxRounds,
          `childSettleHoldMaxRounds=${String(value)}`,
        ).toBe(0);
      }
    });

    it("timeoutGraceMs: default 60_000, 0 disables grace, missing/negative/NaN fall back to default", () => {
      expect(parseBashJobsSettings({}).timeoutGraceMs).toBe(60_000);
      expect(parseBashJobsSettings({ timeoutGraceMs: 0 }).timeoutGraceMs).toBe(0);
      expect(parseBashJobsSettings({ timeoutGraceMs: 5_000 }).timeoutGraceMs).toBe(5_000);
      for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, "60000", null, undefined, true, {}, []]) {
        expect(parseBashJobsSettings({ timeoutGraceMs: value }).timeoutGraceMs, `timeoutGraceMs=${String(value)}`).toBe(
          60_000,
        );
      }
      // seconds ↔ ms boundary: file key is `timeoutGraceS`
      expect(loadSettings({ bashJobs: { timeoutGraceS: 30 } }).bashJobs.timeoutGraceMs).toBe(30_000);
      expect(loadSettings({ bashJobs: { timeoutGraceS: 0 } }).bashJobs.timeoutGraceMs).toBe(0);
      expect(loadSettings({ bashJobs: { timeoutGraceS: -1 } }).bashJobs.timeoutGraceMs).toBe(60_000);
    });

    it("maxExtensions: default 3, 0 disables extend, non-integer/negative fall back to default", () => {
      expect(parseBashJobsSettings({}).maxExtensions).toBe(3);
      expect(parseBashJobsSettings({ maxExtensions: 0 }).maxExtensions).toBe(0);
      expect(parseBashJobsSettings({ maxExtensions: 5 }).maxExtensions).toBe(5);
      for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null, undefined, true, {}, []]) {
        expect(parseBashJobsSettings({ maxExtensions: value }).maxExtensions, `maxExtensions=${String(value)}`).toBe(3);
      }
    });

    it("maxTimeoutFactor: default 3, non-integer >= 1 is legal, not-finite/< 1 fall back to default (1 = zero headroom)", () => {
      expect(parseBashJobsSettings({}).maxTimeoutFactor).toBe(3);
      expect(parseBashJobsSettings({ maxTimeoutFactor: 1 }).maxTimeoutFactor).toBe(1);
      expect(parseBashJobsSettings({ maxTimeoutFactor: 2.5 }).maxTimeoutFactor).toBe(2.5);
      for (const value of [0, 0.999, -1, Number.NaN, Number.POSITIVE_INFINITY, "3", null, undefined, true, {}, []]) {
        expect(
          parseBashJobsSettings({ maxTimeoutFactor: value }).maxTimeoutFactor,
          `maxTimeoutFactor=${String(value)}`,
        ).toBe(3);
      }
    });

    it("is wired into loadSettings end to end", () => {
      expect(
        loadSettings({
          bashJobs: {
            childSessions: false,
            childSettleHold: false,
            childSettleHoldMaxRounds: 10,
            timeoutGraceS: 0,
            maxExtensions: 0,
            maxTimeoutFactor: 1,
          },
        }).bashJobs,
      ).toEqual({
        ...defaults,
        childSessions: false,
        childSettleHold: false,
        childSettleHoldMaxRounds: 10,
        timeoutGraceMs: 0,
        maxExtensions: 0,
        maxTimeoutFactor: 1,
      });
    });
  });
});
