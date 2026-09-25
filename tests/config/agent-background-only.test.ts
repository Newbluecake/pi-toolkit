import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  TIME_SETTING_MS_PATHS,
  isTimeSettingKey,
  loadSettings,
  loadSettingsFromFile,
  readSettingsNoMigrate,
} from "../../src/config/settings.js";
import { SETTING_SPECS, isKnownSettingKey } from "../../src/config/setting-specs.js";
import { formatAgentTypesForPrompt } from "../../src/config/agent-types.js";
import type { AgentTypeConfig } from "../../src/core/types.js";

/**
 * docs/dev/agent-background-only/plan.md: the main-session Agent tool lost
 * its foreground mode, and with it the `foregroundAutoBackgroundMs` setting
 * (file key `foregroundAutoBackgroundS`, or the pre-seconds legacy
 * `foregroundAutoBackgroundMs`). Leftovers in a user's settings file must be
 * ignored silently: no error, no WARN, no rewrite of the file.
 */
describe("removed setting: foregroundAutoBackground{Ms,S}", () => {
  let dir: string;
  let path: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-subagent-bg-only-"));
    path = join(dir, "pi-subagent.json");
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const writeRaw = (value: unknown): string => {
    const text = JSON.stringify(value, null, 2) + "\n";
    writeFileSync(path, text, "utf8");
    return text;
  };

  it("is gone from the settings model, the time-unit tables and the settable-key specs", () => {
    expect(Object.hasOwn(DEFAULT_SETTINGS, "foregroundAutoBackgroundMs")).toBe(false);
    expect(TIME_SETTING_MS_PATHS).not.toContain("foregroundAutoBackgroundMs");
    expect(isTimeSettingKey("foregroundAutoBackgroundS")).toBe(false);
    expect(Object.hasOwn(SETTING_SPECS, "foregroundAutoBackgroundS")).toBe(false);
    expect(isKnownSettingKey("foregroundAutoBackgroundS")).toBe(false);
  });

  it("loadSettings ignores both the seconds and the legacy millisecond spelling", () => {
    const baseline = loadSettings({ concurrencyLimit: 3 });
    for (const leftover of [
      { foregroundAutoBackgroundS: 120 },
      { foregroundAutoBackgroundMs: 600_000 },
      { foregroundAutoBackgroundS: "nonsense" },
      { foregroundAutoBackgroundMs: -1 },
    ]) {
      const loaded = loadSettings({ concurrencyLimit: 3, ...leftover });
      expect(loaded).toEqual(baseline);
      expect(Object.hasOwn(loaded, "foregroundAutoBackgroundMs")).toBe(false);
      expect(Object.hasOwn(loaded, "foregroundAutoBackgroundS")).toBe(false);
    }
  });

  it.each([
    ["seconds key", { foregroundAutoBackgroundS: 120, concurrencyLimit: 4 }],
    ["legacy millisecond key", { foregroundAutoBackgroundMs: 600_000, concurrencyLimit: 4 }],
  ])("loadSettingsFromFile ignores a leftover %s without WARN and without rewriting the file", (_label, raw) => {
    const before = writeRaw(raw);
    const settings = loadSettingsFromFile(path);
    expect(settings.concurrencyLimit).toBe(4);
    expect(Object.hasOwn(settings, "foregroundAutoBackgroundMs")).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(before); // byte-identical: nothing was written back
    // The read-only (child-session) loader behaves the same.
    expect(readSettingsNoMigrate(path)).toEqual(settings);
  });

  it("a migration triggered by another legacy key neither converts nor mentions the removed one", () => {
    writeRaw({ foregroundAutoBackgroundMs: 600_000, deliveryBackoffMs: 2_000 });
    const settings = loadSettingsFromFile(path);
    expect(settings.deliveryBackoffMs).toBe(2_000);
    const rewritten = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(rewritten.deliveryBackoffS).toBe(2); // the live key was migrated…
    expect(rewritten.foregroundAutoBackgroundS).toBeUndefined(); // …the removed one was not converted
    expect(rewritten.foregroundAutoBackgroundMs).toBe(600_000); // user content left untouched
    const warnings = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warnings).toContain("deliveryBackoffMs");
    expect(warnings).not.toContain("foregroundAutoBackground");
  });
});

describe("system prompt: background-only Agent tool protocol", () => {
  const type: AgentTypeConfig = { name: "worker", description: "Does work.", systemPrompt: "", promptMode: "append" };
  const prompt = formatAgentTypesForPrompt([type]);
  const protocol = prompt.split("\n").find((line) => line.startsWith("Tool protocol:"));

  it("states the background-only protocol: immediate run_id, pushed notification, then get_subagent_result", () => {
    expect(protocol).toBeDefined();
    expect(protocol).toContain("always runs in the background");
    expect(protocol).toContain("returns immediately with a run_id");
    expect(protocol).toContain("completion notification is pushed");
    expect(protocol).toMatch(/after that notification arrives, collect the result with get_subagent_result/);
    expect(protocol).toContain("steer_subagent");
    expect(protocol).toContain("abort_subagent");
    expect(protocol).toContain("Do not poll or block");
    expect(protocol).toContain("several Agent calls in the same message");
  });

  it("states that SubagentWorkflow is background too and managed by its workflow id", () => {
    const line = prompt.split("\n").find((l) => l.startsWith("SubagentWorkflow"));
    expect(line).toBeDefined();
    expect(line).toContain("always runs in the background");
    expect(line).toContain("wf_");
    expect(line).toContain("get_subagent_result");
    expect(line).toContain("abort_subagent");
  });

  it("no longer mentions a foreground mode, auto-background, or run_in_background", () => {
    expect(prompt).not.toMatch(/foreground|auto-background|run_in_background|blocks until/i);
  });
});
