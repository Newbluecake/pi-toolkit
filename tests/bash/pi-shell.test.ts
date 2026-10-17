import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { readPiShellSettings, shellSettingsFrom } from "../../src/bash/pi-shell.js";

/**
 * 2026-10-17 shell-resolution revision: the pi-facing reader for pi's own
 * `shellPath` / `shellCommandPrefix`. The `~` expansion and project-over-global
 * precedence are pi's own `SettingsManager` behaviour — pinned here through
 * pi's real `inMemory` manager so a pi change that drops normalization fails
 * this suite instead of silently breaking the override's chain.
 */
describe("shellSettingsFrom", () => {
  it("passes through non-empty values and drops empty/absent ones", () => {
    expect(shellSettingsFrom({ getShellPath: () => "/bin/bash", getShellCommandPrefix: () => "export CI=1" })).toEqual({
      shellPath: "/bin/bash",
      shellCommandPrefix: "export CI=1",
    });
    expect(shellSettingsFrom({ getShellPath: () => "", getShellCommandPrefix: () => undefined })).toEqual({});
    expect(shellSettingsFrom(undefined)).toEqual({});
  });

  it("degrades a throwing source to {}", () => {
    const boom = (): never => {
      throw new Error("boom");
    };
    expect(shellSettingsFrom({ getShellPath: boom, getShellCommandPrefix: boom })).toEqual({});
  });

  it("honours pi's own leading-~ expansion (getShellPath normalizes)", () => {
    const manager = SettingsManager.inMemory({
      shellPath: "~/.local/bin/bash",
      shellCommandPrefix: "export CI=1",
    });
    expect(shellSettingsFrom(manager)).toEqual({
      shellPath: join(homedir(), ".local/bin/bash"),
      shellCommandPrefix: "export CI=1",
    });
  });

  it("leaves absolute pi shellPath untouched", () => {
    const manager = SettingsManager.inMemory({ shellPath: "/usr/local/bin/bash" });
    expect(shellSettingsFrom(manager)).toEqual({ shellPath: "/usr/local/bin/bash" });
  });
});

describe("readPiShellSettings", () => {
  it("reads the real settings files without throwing (shape-only assertions)", () => {
    const settings = readPiShellSettings(process.cwd());
    expect(Object.keys(settings).every((key) => key === "shellPath" || key === "shellCommandPrefix")).toBe(true);
    if (settings.shellPath !== undefined) expect(settings.shellPath.length).toBeGreaterThan(0);
    if (settings.shellCommandPrefix !== undefined) {
      expect(settings.shellCommandPrefix.length).toBeGreaterThan(0);
    }
  });

  it("never throws, even for a cwd that does not exist", () => {
    const settings = readPiShellSettings("/definitely/not/a/dir");
    // The global settings file may legitimately set either field on the real
    // machine — only the never-throw + shape contract is asserted here.
    expect(Object.keys(settings).every((key) => key === "shellPath" || key === "shellCommandPrefix")).toBe(true);
  });
});
