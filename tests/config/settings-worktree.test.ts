import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, loadSettings } from "../../src/config/settings.js";

describe("config: worktree.linkPaths (workflow-worktree plan D9)", () => {
  it("defaults to [] — byte-identical to pre-D9 settings", () => {
    expect(DEFAULT_SETTINGS.worktree.linkPaths).toEqual([]);
    expect(loadSettings({}).worktree.linkPaths).toEqual([]);
  });

  it("accepts a valid array of canonical repo-relative paths", () => {
    const settings = loadSettings({ worktree: { linkPaths: ["node_modules", "vendor/lib"] } });
    expect(settings.worktree.linkPaths).toEqual(["node_modules", "vendor/lib"]);
  });

  it("drops non-array values and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const settings = loadSettings({ worktree: { linkPaths: "node_modules" } });
    expect(settings.worktree.linkPaths).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("drops invalid elements individually and warns per element, keeping the valid ones", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const settings = loadSettings({ worktree: { linkPaths: ["node_modules", "/abs", "a/../b", ""] } });
    expect(settings.worktree.linkPaths).toEqual(["node_modules"]);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("dedupes and caps at 16 entries", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const many = Array.from({ length: 20 }, (_, i) => `dep${i}`);
    const settings = loadSettings({ worktree: { linkPaths: [...many, "dep0"] } });
    expect(settings.worktree.linkPaths).toHaveLength(16);
    expect(settings.worktree.linkPaths).toEqual(many.slice(0, 16));
    warn.mockRestore();
  });

  it("preserves enabled/gitTimeoutMs alongside linkPaths", () => {
    const settings = loadSettings({ worktree: { enabled: true, gitTimeoutMs: 5000, linkPaths: ["node_modules"] } });
    expect(settings.worktree).toEqual({ enabled: true, gitTimeoutMs: 5000, linkPaths: ["node_modules"] });
  });
});
