import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings } from "../../src/config/settings.js";
import { SETTING_SPECS } from "../../src/config/setting-specs.js";

describe("config: todo.nudge (main-session todo staleness nudge, L1 feature)", () => {
  it("defaults: enabled=true, graceTurns=2, fallbackTurns=20, cooldownTurns=8", () => {
    expect(DEFAULT_SETTINGS.todo).toEqual({
      enabled: true,
      nudge: { enabled: true, graceTurns: 2, fallbackTurns: 20, cooldownTurns: 8 },
    });
    expect(loadSettings({}).todo).toEqual(DEFAULT_SETTINGS.todo);
  });

  it("todo.enabled still works standalone (nudge falls back to defaults)", () => {
    const settings = loadSettings({ todo: { enabled: false } });
    expect(settings.todo.enabled).toBe(false);
    expect(settings.todo.nudge).toEqual(DEFAULT_SETTINGS.todo.nudge);
  });

  it("accepts a fully overridden nudge block", () => {
    const settings = loadSettings({
      todo: { nudge: { enabled: false, graceTurns: 3, fallbackTurns: 30, cooldownTurns: 5 } },
    });
    expect(settings.todo.enabled).toBe(true); // untouched field keeps its own default
    expect(settings.todo.nudge).toEqual({ enabled: false, graceTurns: 3, fallbackTurns: 30, cooldownTurns: 5 });
  });

  it("falls back field-by-field on illegal values (non-integer, zero, negative, non-numeric)", () => {
    for (const bad of [0, -1, 1.5, "10", null, NaN, Infinity, {}]) {
      const settings = loadSettings({ todo: { nudge: { graceTurns: bad, fallbackTurns: bad, cooldownTurns: bad } } });
      expect(settings.todo.nudge.graceTurns).toBe(2);
      expect(settings.todo.nudge.fallbackTurns).toBe(20);
      expect(settings.todo.nudge.cooldownTurns).toBe(8);
    }
  });

  it("a non-boolean nudge.enabled falls back to the default", () => {
    expect(loadSettings({ todo: { nudge: { enabled: "yes" } } }).todo.nudge.enabled).toBe(true);
  });

  it("a malformed nudge block (non-object) falls back entirely to defaults", () => {
    for (const bad of [null, "x", 5, []]) {
      expect(loadSettings({ todo: { nudge: bad } }).todo.nudge).toEqual(DEFAULT_SETTINGS.todo.nudge);
    }
  });

  it("a malformed todo block (non-object) falls back entirely to defaults", () => {
    for (const bad of [null, "x", 5, []]) {
      expect(loadSettings({ todo: bad }).todo).toEqual(DEFAULT_SETTINGS.todo);
    }
  });

  it("accepts positive integer overrides verbatim", () => {
    const settings = loadSettings({ todo: { nudge: { graceTurns: 1, fallbackTurns: 100, cooldownTurns: 1 } } });
    expect(settings.todo.nudge).toEqual({ enabled: true, graceTurns: 1, fallbackTurns: 100, cooldownTurns: 1 });
  });

  it("is registered in SETTING_SPECS as boolean + three integer count knobs", () => {
    expect(SETTING_SPECS["todo.nudge.enabled"]?.kind).toBe("boolean");
    for (const key of ["todo.nudge.graceTurns", "todo.nudge.fallbackTurns", "todo.nudge.cooldownTurns"] as const) {
      const spec = SETTING_SPECS[key];
      expect(spec, key).toBeDefined();
      expect(spec!.kind).toBe("number");
      if (spec!.kind === "number") {
        expect(spec!.integer).toBe(true);
        expect(spec!.time).toBeUndefined(); // turn counts, never durations
      }
    }
  });
});
