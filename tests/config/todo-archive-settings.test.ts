// todo-archive plan §2/§3 (tests/config): `todo.archive.{onCompact,afterTurns}` defaults,
// field-by-field fallback (afterTurns accepts integers >= 0, 0 = off), and SETTING_SPECS coverage.

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings } from "../../src/config/settings.js";
import { SETTING_SPECS } from "../../src/config/setting-specs.js";

describe("config: todo.archive (completed-task auto-archive, todo-archive plan D1)", () => {
  it("defaults: onCompact=true, afterTurns=30 (user ruling 2026-10-15)", () => {
    expect(DEFAULT_SETTINGS.todo.archive).toEqual({ onCompact: true, afterTurns: 30 });
    expect(loadSettings({}).todo.archive).toEqual(DEFAULT_SETTINGS.todo.archive);
  });

  it("accepts full overrides verbatim, including afterTurns=0 (sweeper off)", () => {
    const settings = loadSettings({ todo: { archive: { onCompact: false, afterTurns: 0 } } });
    expect(settings.todo.archive).toEqual({ onCompact: false, afterTurns: 0 });
    // Untouched sibling blocks keep their own defaults.
    expect(settings.todo.enabled).toBe(true);
    expect(settings.todo.nudge).toEqual(DEFAULT_SETTINGS.todo.nudge);
  });

  it("falls back field-by-field on illegal values (negative, fractional, non-numeric, non-boolean)", () => {
    for (const bad of [-1, 1.5, "10", null, NaN, Infinity, {}, []]) {
      const settings = loadSettings({ todo: { archive: { afterTurns: bad } } });
      expect(settings.todo.archive.afterTurns, String(bad)).toBe(30);
    }
    for (const bad of ["yes", 1, null, []]) {
      const settings = loadSettings({ todo: { archive: { onCompact: bad } } });
      expect(settings.todo.archive.onCompact, String(bad)).toBe(true);
    }
  });

  it("afterTurns=0 is a legal value (disables the per-turn sweeper), not a fallback", () => {
    expect(loadSettings({ todo: { archive: { afterTurns: 0 } } }).todo.archive.afterTurns).toBe(0);
  });

  it("a malformed archive block (non-object) falls back entirely to defaults", () => {
    for (const bad of [null, "x", 5, []]) {
      expect(loadSettings({ todo: { archive: bad } }).todo.archive).toEqual(DEFAULT_SETTINGS.todo.archive);
    }
  });

  it("is registered in SETTING_SPECS as one boolean + one integer count knob (min 0)", () => {
    const onCompact = SETTING_SPECS["todo.archive.onCompact"];
    expect(onCompact?.kind).toBe("boolean");
    const afterTurns = SETTING_SPECS["todo.archive.afterTurns"];
    expect(afterTurns).toBeDefined();
    expect(afterTurns!.kind).toBe("number");
    if (afterTurns!.kind === "number") {
      expect(afterTurns!.integer).toBe(true);
      expect(afterTurns!.min).toBe(0);
      expect(afterTurns!.time).toBeUndefined(); // turn counts, never durations
    }
  });
});
