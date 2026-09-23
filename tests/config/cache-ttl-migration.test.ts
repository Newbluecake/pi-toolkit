import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettingsFromFile } from "../../src/config/settings.js";

describe("legacy cache TTL migration", () => {
  let dir: string | undefined;
  afterEach(() => vi.restoreAllMocks());
  function files(settings: unknown, legacy: unknown) {
    dir = mkdtempSync(join(tmpdir(), "pi-subagent-cache-ttl-"));
    const path = join(dir, "pi-subagent.json");
    writeFileSync(path, JSON.stringify(settings) + "\n");
    writeFileSync(join(dir, "cache-ttl-state.json"), JSON.stringify(legacy) + "\n");
    return { path, legacy: join(dir, "cache-ttl-state.json") };
  }

  it("moves a valid legacy mode into settings and removes the file", () => {
    const { path, legacy } = files({}, { mode: "on" });
    expect(loadSettingsFromFile(path).cacheTtl).toEqual(expect.objectContaining({ mode: "on" }));
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ cacheTtl: { mode: "on" } });
    expect(existsSync(legacy)).toBe(false);
  });

  it("does not overwrite an existing setting, including an invalid one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { path, legacy } = files({ cacheTtl: { mode: "off" } }, { mode: "on" });
    expect(loadSettingsFromFile(path).cacheTtl).toEqual(expect.objectContaining({ mode: "off" }));
    expect(existsSync(legacy)).toBe(false);
    const second = files({ cacheTtl: { mode: "bad" } }, { mode: "on" });
    // invalid explicit mode ⇒ adaptiveEnabled default (on) promotes to "adaptive" (adaptive plan §7.1)
    expect(loadSettingsFromFile(second.path).cacheTtl).toEqual(expect.objectContaining({ mode: "adaptive" }));
    expect(warn).toHaveBeenCalled();
    expect(existsSync(second.legacy)).toBe(false);
  });

  it("keeps malformed legacy state for a later retry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { path, legacy } = files({}, { mode: "bad" });
    // absent mode ⇒ flag-gated default (adaptiveEnabled defaults to true ⇒ "adaptive")
    expect(loadSettingsFromFile(path).cacheTtl).toEqual(expect.objectContaining({ mode: "adaptive" }));
    expect(existsSync(legacy)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("keeps syntactically broken legacy JSON for a later retry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), "pi-subagent-cache-ttl-"));
    const path = join(dir, "pi-subagent.json");
    writeFileSync(path, "{}\n");
    const legacy = join(dir, "cache-ttl-state.json");
    writeFileSync(legacy, "{not json");
    expect(loadSettingsFromFile(path).cacheTtl).toEqual(expect.objectContaining({ mode: "adaptive" }));
    expect(existsSync(legacy)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  // adaptive plan.md §7.3.6: legacy state written by a NEWER version may already carry "adaptive"
  it("accepts a legacy adaptive mode without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { path, legacy } = files({}, { mode: "adaptive" });
    expect(loadSettingsFromFile(path).cacheTtl).toEqual(expect.objectContaining({ mode: "adaptive" }));
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ cacheTtl: { mode: "adaptive" } });
    expect(existsSync(legacy)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  // blocker-1 回归：settings 写回失败时 legacy 必须保留，内存仍用 legacy 值，下次启动可重试
  it("keeps the legacy file when the settings write-back fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { path, legacy } = files({}, { mode: "on" });
    // 原子写（tmp + rename，review B1）下只读文件会被 rename 直接替换，
    // 模拟不可写必须上只读目录。
    chmodSync(dir!, 0o555);
    try {
      expect(loadSettingsFromFile(path).cacheTtl).toEqual(expect.objectContaining({ mode: "on" }));
      expect(existsSync(legacy)).toBe(true);
      expect(readFileSync(path, "utf8")).not.toContain("cacheTtl");
      expect(warn).toHaveBeenCalled();
    } finally {
      chmodSync(dir!, 0o755);
    }
    // 恢复可写后重试成功并清理 legacy
    expect(loadSettingsFromFile(path).cacheTtl).toEqual(expect.objectContaining({ mode: "on" }));
    expect(existsSync(legacy)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ cacheTtl: { mode: "on" } });
  });
});
