import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  FABRIC_WAKE_RESUME_BUDGET_MAX_S,
  FABRIC_WAKE_RESUME_BUDGET_MIN_S,
  loadSettings,
} from "../../src/config/settings.js";
import { currentOf, defaultOf, isKnownSettingKey, SETTING_SPECS } from "../../src/config/setting-specs.js";

/** fabric-cross-session plan v3 §4.8 (S0): the phase-1 `fabric.wake.*` leaves. */
const defaults = DEFAULT_SETTINGS.fabric.wake;
const wake = (block: unknown) => loadSettings({ fabric: { wake: block } }).fabric.wake;

describe("fabric.wake settings (plan v3 §4.8; rootRunMaxS added by phase2 §4.1)", () => {
  it("pins the phase-1 leaves and their defaults (Q2: enabled by default, gated on fabric.enabled)", () => {
    expect(defaults).toEqual({
      enabled: true,
      maxLevel: 2,
      perRunQuota: 3,
      resumeBudgetS: 600,
      resumesPerHour: 6,
      resumesPerTargetPerHour: 2,
      parkCapPerTarget: 8,
      // phase2 §4.1: the cross-session Controller watchdog joins the wake block (default 900s)
      rootRunMaxS: 900,
    });
    // `crossSession.*` is a FABRIC-level leaf (parsed by parseFabricCrossSessionSettings), never a wake one
    expect(Object.keys(defaults).sort()).toEqual(
      [
        "enabled",
        "maxLevel",
        "parkCapPerTarget",
        "perRunQuota",
        "resumeBudgetS",
        "resumesPerHour",
        "resumesPerTargetPerHour",
        "rootRunMaxS",
      ].sort(),
    );
    // fabric itself stays off by default ⇒ a default install has no wake behaviour at all
    expect(DEFAULT_SETTINGS.fabric.enabled).toBe(false);
  });

  it("missing / non-object blocks fall back to defaults, and never alias the DEFAULT_SETTINGS object", () => {
    for (const input of [undefined, null, 0, "no", true, [], [1]]) {
      const parsed = wake(input);
      expect(parsed).toEqual(defaults);
      expect(parsed).not.toBe(defaults);
    }
    const noFabric = loadSettings({}).fabric;
    expect(noFabric.wake).toEqual(defaults);
    expect(noFabric.wake).not.toBe(DEFAULT_SETTINGS.fabric.wake);
    const nonObjectFabric = loadSettings({ fabric: "oops" }).fabric;
    expect(nonObjectFabric.wake).toEqual(defaults);
    expect(nonObjectFabric.wake).not.toBe(DEFAULT_SETTINGS.fabric.wake);
  });

  it("parses valid values and ignores unknown keys (crossSession is a fabric-level leaf, not a wake one)", () => {
    expect(
      wake({
        enabled: false,
        maxLevel: 4,
        perRunQuota: 0,
        resumeBudgetS: 120,
        resumesPerHour: 10,
        resumesPerTargetPerHour: 1,
        parkCapPerTarget: 3,
        rootRunMaxS: 5,
        crossSession: { enabled: true },
      }),
    ).toEqual({
      enabled: false,
      maxLevel: 4,
      perRunQuota: 0,
      resumeBudgetS: 120,
      resumesPerHour: 10,
      resumesPerTargetPerHour: 1,
      parkCapPerTarget: 3,
      rootRunMaxS: 60, // 5 clamps up to the 60s floor (phase2 §4.1)
    });
  });

  it("falls back per field for wrong types, negatives and non-finite numbers; floors fractions", () => {
    const parsed = wake({
      enabled: "yes",
      maxLevel: -1,
      perRunQuota: "3",
      resumeBudgetS: "600",
      resumesPerHour: Number.NaN,
      resumesPerTargetPerHour: Infinity,
      parkCapPerTarget: 2.9,
    });
    expect(parsed).toEqual({ ...defaults, parkCapPerTarget: 2 });
  });

  it("rootRunMaxS: 0 disables the Controller, positive values clamp to 60..3600, invalid falls back (phase2 §4.1)", () => {
    expect(wake({ rootRunMaxS: 0 }).rootRunMaxS).toBe(0);
    expect(wake({ rootRunMaxS: 1 }).rootRunMaxS).toBe(60);
    expect(wake({ rootRunMaxS: 59.9 }).rootRunMaxS).toBe(60);
    expect(wake({ rootRunMaxS: 900 }).rootRunMaxS).toBe(900);
    expect(wake({ rootRunMaxS: 99_999 }).rootRunMaxS).toBe(3600);
    expect(wake({ rootRunMaxS: -5 }).rootRunMaxS).toBe(900);
    expect(wake({ rootRunMaxS: "600" }).rootRunMaxS).toBe(900);
    expect(wake({ rootRunMaxS: Number.NaN }).rootRunMaxS).toBe(900);
  });

  it("resumeBudgetS is clamped to 60..3600 at parse time (plan §3.7 step 4)", () => {
    expect(FABRIC_WAKE_RESUME_BUDGET_MIN_S).toBe(60);
    expect(FABRIC_WAKE_RESUME_BUDGET_MAX_S).toBe(3600);
    expect(wake({ resumeBudgetS: 1 }).resumeBudgetS).toBe(60);
    expect(wake({ resumeBudgetS: 0 }).resumeBudgetS).toBe(60);
    expect(wake({ resumeBudgetS: -5 }).resumeBudgetS).toBe(60);
    expect(wake({ resumeBudgetS: 59.9 }).resumeBudgetS).toBe(60);
    expect(wake({ resumeBudgetS: 60 }).resumeBudgetS).toBe(60);
    expect(wake({ resumeBudgetS: 3600 }).resumeBudgetS).toBe(3600);
    expect(wake({ resumeBudgetS: 99_999 }).resumeBudgetS).toBe(3600);
    expect(wake({ resumeBudgetS: Number.NaN }).resumeBudgetS).toBe(600);
  });

  it("the other fabric.* fields are untouched by the new leaf", () => {
    const parsed = loadSettings({ fabric: { enabled: true, rootInboxCap: 7, wake: { maxLevel: 1 } } }).fabric;
    const { wake: _w, ...rest } = parsed;
    const { wake: _dw, ...restDefaults } = DEFAULT_SETTINGS.fabric;
    expect(rest).toEqual({ ...restDefaults, enabled: true, rootInboxCap: 7 });
    expect(parsed.wake.maxLevel).toBe(1);
  });

  it("every leaf is a settable spec whose default/current round-trip through the editor surface", () => {
    for (const key of [
      "enabled",
      "maxLevel",
      "perRunQuota",
      "resumeBudgetS",
      "resumesPerHour",
      "resumesPerTargetPerHour",
      "parkCapPerTarget",
    ]) {
      const full = `fabric.wake.${key}`;
      expect(isKnownSettingKey(full), full).toBe(true);
      const spec = SETTING_SPECS[full]!;
      expect(spec.path).toBe(full);
      expect(defaultOf(spec)).toBe((defaults as unknown as Record<string, unknown>)[key]);
      expect(currentOf(DEFAULT_SETTINGS, spec)).toBe((defaults as unknown as Record<string, unknown>)[key]);
    }
    expect(SETTING_SPECS["fabric.wake.resumeBudgetS"]).toMatchObject({
      kind: "number",
      min: 60,
      max: 3600,
      integer: true,
    });
  });
});
