import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, isTimeSettingKey, loadSettings } from "../../src/config/settings.js";
import { SETTING_SPECS } from "../../src/config/setting-specs.js";

/**
 * ask-user-async plan §10 P2-4: `askUser.backgroundInterrupt.*` settings —
 * defaults (main-session TUI on, RPC off), seconds-on-disk ⇄ ms-internal time
 * units, per-field fallback on illegal values (never throws), the
 * maxDefer ≥ quiet clamp, and /agent-settings spec registration.
 */

const DEFAULT_BI = DEFAULT_SETTINGS.askUser.backgroundInterrupt;

describe("config: askUser.backgroundInterrupt (ask-user-async P2)", () => {
  it("defaults: enabled=true (main TUI), rpc=false, §5.2.1 timing defaults", () => {
    expect(DEFAULT_SETTINGS.askUser).toEqual({
      enabled: true,
      backgroundInterrupt: {
        enabled: true,
        delayMs: 1_000,
        quietMs: 4_000,
        maxDeferMs: 20_000,
        reaskDwellMs: 10_000,
        maxPerQuestion: 3,
        rpc: false,
      },
    });
    expect(loadSettings({}).askUser).toEqual(DEFAULT_SETTINGS.askUser);
  });

  it("askUser.enabled keeps working standalone; the sub-block falls back to defaults", () => {
    const settings = loadSettings({ askUser: { enabled: false } });
    expect(settings.askUser.enabled).toBe(false);
    expect(settings.askUser.backgroundInterrupt).toEqual(DEFAULT_BI);
  });

  it("reads the on-disk integer-second *S keys into internal *Ms", () => {
    const settings = loadSettings({
      askUser: {
        backgroundInterrupt: { delayS: 2, quietS: 8, maxDeferS: 30, reaskDwellS: 5, maxPerQuestion: 5, rpc: true },
      },
    });
    expect(settings.askUser.backgroundInterrupt).toEqual({
      enabled: true,
      delayMs: 2_000,
      quietMs: 8_000,
      maxDeferMs: 30_000,
      reaskDwellMs: 5_000,
      maxPerQuestion: 5,
      rpc: true,
    });
  });

  it("0 is a legal value with its own §5.2.1 semantics (next macrotask / no protection / …)", () => {
    const settings = loadSettings({
      askUser: { backgroundInterrupt: { delayS: 0, quietS: 0, maxDeferS: 0, reaskDwellS: 0 } },
    });
    expect(settings.askUser.backgroundInterrupt.delayMs).toBe(0);
    expect(settings.askUser.backgroundInterrupt.quietMs).toBe(0);
    expect(settings.askUser.backgroundInterrupt.maxDeferMs).toBe(0);
    expect(settings.askUser.backgroundInterrupt.reaskDwellMs).toBe(0);
  });

  it("maxDeferS:0 alone keeps 0 (not clamped to the quietS default) — §5.2.1 explicit-zero semantics", () => {
    // 回归（2026-10-05 P1+P2 验收）：此前无条件 Math.max(maxDeferMs, quietMs)，
    // 只设 maxDeferS:0 时会被 quietS 默认 4s 错钳为 4000。
    const settings = loadSettings({ askUser: { backgroundInterrupt: { maxDeferS: 0 } } });
    expect(settings.askUser.backgroundInterrupt.quietMs).toBe(4_000); // quietS 默认未动
    expect(settings.askUser.backgroundInterrupt.maxDeferMs).toBe(0); // 显式 0 保留
    // 非 0 的钳制仍然成立：maxDefer < quiet ⇒ 钳为 quiet。
    const clamped = loadSettings({ askUser: { backgroundInterrupt: { maxDeferS: 2 } } });
    expect(clamped.askUser.backgroundInterrupt.maxDeferMs).toBe(4_000);
  });

  it("falls back field-by-field on illegal values (out of range / non-numeric)", () => {
    for (const bad of [-1, 11, "2", null, NaN, Infinity, {}]) {
      // delayS range is 0–10; 11s (→ 11_000ms) is out of range.
      const settings = loadSettings({ askUser: { backgroundInterrupt: { delayS: bad } } });
      expect(settings.askUser.backgroundInterrupt.delayMs, JSON.stringify(bad)).toBe(DEFAULT_BI.delayMs);
    }
    for (const bad of [31, -1, "x"] as const) {
      expect(
        loadSettings({ askUser: { backgroundInterrupt: { quietS: bad } } }).askUser.backgroundInterrupt.quietMs,
      ).toBe(DEFAULT_BI.quietMs);
    }
    for (const bad of [121, -1] as const) {
      expect(
        loadSettings({ askUser: { backgroundInterrupt: { maxDeferS: bad } } }).askUser.backgroundInterrupt.maxDeferMs,
      ).toBe(DEFAULT_BI.maxDeferMs);
    }
    for (const bad of [61, -1] as const) {
      expect(
        loadSettings({ askUser: { backgroundInterrupt: { reaskDwellS: bad } } }).askUser.backgroundInterrupt
          .reaskDwellMs,
      ).toBe(DEFAULT_BI.reaskDwellMs);
    }
    // A fractional seconds value that converts to whole milliseconds (1.5s →
    // 1500ms) survives normalizeTimeUnits as a valid in-range integer — same
    // tolerance as every other duration setting.
    expect(
      loadSettings({ askUser: { backgroundInterrupt: { delayS: 1.5 } } }).askUser.backgroundInterrupt.delayMs,
    ).toBe(1_500);
  });

  it("maxDeferS below quietS clamps UP to the quiet period (§5.2.1)", () => {
    const settings = loadSettings({ askUser: { backgroundInterrupt: { quietS: 10, maxDeferS: 5 } } });
    expect(settings.askUser.backgroundInterrupt.quietMs).toBe(10_000);
    expect(settings.askUser.backgroundInterrupt.maxDeferMs).toBe(10_000);
  });

  it("maxPerQuestion accepts 1–10 integers; 0 / >10 / non-integer fall back to 3", () => {
    expect(
      loadSettings({ askUser: { backgroundInterrupt: { maxPerQuestion: 1 } } }).askUser.backgroundInterrupt
        .maxPerQuestion,
    ).toBe(1);
    expect(
      loadSettings({ askUser: { backgroundInterrupt: { maxPerQuestion: 10 } } }).askUser.backgroundInterrupt
        .maxPerQuestion,
    ).toBe(10);
    for (const bad of [0, 11, 2.5, "3", null, NaN]) {
      expect(
        loadSettings({ askUser: { backgroundInterrupt: { maxPerQuestion: bad } } }).askUser.backgroundInterrupt
          .maxPerQuestion,
        JSON.stringify(bad),
      ).toBe(3);
    }
  });

  it("enabled/rpc fall back on non-booleans", () => {
    const settings = loadSettings({ askUser: { backgroundInterrupt: { enabled: "yes", rpc: 1 } } });
    expect(settings.askUser.backgroundInterrupt.enabled).toBe(true);
    expect(settings.askUser.backgroundInterrupt.rpc).toBe(false);
  });

  it("malformed blocks fall back entirely to defaults, never throw", () => {
    for (const bad of [null, "x", 5, []]) {
      expect(loadSettings({ askUser: { backgroundInterrupt: bad } }).askUser).toEqual(DEFAULT_SETTINGS.askUser);
      expect(loadSettings({ askUser: bad }).askUser).toEqual(DEFAULT_SETTINGS.askUser);
    }
  });

  it("the four durations are registered as time settings (seconds on disk)", () => {
    for (const key of [
      "askUser.backgroundInterrupt.delayS",
      "askUser.backgroundInterrupt.quietS",
      "askUser.backgroundInterrupt.maxDeferS",
      "askUser.backgroundInterrupt.reaskDwellS",
    ] as const) {
      expect(isTimeSettingKey(key), key).toBe(true);
      const spec = SETTING_SPECS[key];
      expect(spec, key).toBeDefined();
      expect(spec!.kind).toBe("number");
      expect(spec!.time).toBe(true);
      expect(spec!.path.endsWith("Ms")).toBe(true);
    }
    const ranges: Record<string, [number, number]> = {
      "askUser.backgroundInterrupt.delayS": [0, 10],
      "askUser.backgroundInterrupt.quietS": [0, 30],
      "askUser.backgroundInterrupt.maxDeferS": [0, 120],
      "askUser.backgroundInterrupt.reaskDwellS": [0, 60],
    };
    for (const [key, [min, max]] of Object.entries(ranges)) {
      const spec = SETTING_SPECS[key]!;
      if (spec.kind !== "number") throw new Error("unreachable");
      expect(spec.min, key).toBe(min);
      expect(spec.max, key).toBe(max);
      expect(spec.integer, key).toBe(true);
    }
  });

  it("registers enabled/maxPerQuestion/rpc specs (maxPerQuestion: integer count 1–10)", () => {
    expect(SETTING_SPECS["askUser.backgroundInterrupt.enabled"]?.kind).toBe("boolean");
    expect(SETTING_SPECS["askUser.backgroundInterrupt.rpc"]?.kind).toBe("boolean");
    const spec = SETTING_SPECS["askUser.backgroundInterrupt.maxPerQuestion"];
    expect(spec).toBeDefined();
    expect(spec!.kind).toBe("number");
    if (spec!.kind === "number") {
      expect(spec!.integer).toBe(true);
      expect(spec!.time).toBeUndefined(); // a count, never a duration
      expect(spec!.min).toBe(1);
      expect(spec!.max).toBe(10);
    }
  });
});
