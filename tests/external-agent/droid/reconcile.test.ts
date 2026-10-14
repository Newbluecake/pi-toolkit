import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  droidCwdSlug,
  droidNativeSessionPaths,
  readNativeCumulativeUsage,
} from "../../../src/external-agent/droid/reconcile.js";

const settingsJson = (tokenUsage: unknown) =>
  JSON.stringify({ model: "gpt-6-luna", autonomyLevel: "high", tokenUsage });

describe("droid/reconcile（plan r3 §14）", () => {
  it("droidCwdSlug：/ ⇒ -（实测 /tmp/droid-spike ⇒ -tmp-droid-spike）", () => {
    expect(droidCwdSlug("/tmp/droid-spike")).toBe("-tmp-droid-spike");
    expect(droidCwdSlug("/home/u/.config/x")).toBe("-home-u-.config-x");
  });

  it("路径推导：~/.factory/sessions/<slug>/<sessionId>.settings.json", () => {
    const p = droidNativeSessionPaths({ homeDir: "/h", cwd: "/a/b", sessionId: "s-1" });
    expect(p.dir).toBe("/h/.factory/sessions/-a-b");
    expect(p.settingsFile).toBe("/h/.factory/sessions/-a-b/s-1.settings.json");
    expect(p.sessionFile).toBe("/h/.factory/sessions/-a-b/s-1.jsonl");
  });

  it("正差数据来源：正常文件 ⇒ camelCase 累计 tokenUsage", () => {
    const dir = mkdtempSync(join(tmpdir(), "droid-recon-"));
    const f = join(dir, "s.settings.json");
    writeFileSync(
      f,
      settingsJson({
        inputTokens: 500,
        outputTokens: 60,
        cacheCreationTokens: 1000,
        cacheReadTokens: 2000,
        thinkingTokens: 7,
        factoryCredits: 300,
      }),
    );
    expect(readNativeCumulativeUsage(f)).toEqual({
      input: 500,
      output: 60,
      cacheRead: 2000,
      cacheWrite: 1000,
      thinking: 7,
      credits: 300,
    });
  });

  it("文件缺失 / 目录 / 符号链接（O_NOFOLLOW）/ 超 256KiB / 坏 JSON / 缺字段 ⇒ undefined 不抛错", () => {
    const dir = mkdtempSync(join(tmpdir(), "droid-recon-"));
    expect(readNativeCumulativeUsage(join(dir, "nope.settings.json"))).toBeUndefined();
    expect(readNativeCumulativeUsage(dir)).toBeUndefined();
    const real = join(dir, "real.settings.json");
    writeFileSync(real, settingsJson({ inputTokens: 1 }));
    const link = join(dir, "link.settings.json");
    symlinkSync(real, link);
    expect(readNativeCumulativeUsage(link)).toBeUndefined();
    const big = join(dir, "big.settings.json");
    writeFileSync(big, " ".repeat(256 * 1024 + 1));
    expect(readNativeCumulativeUsage(big)).toBeUndefined();
    const bad = join(dir, "bad.settings.json");
    writeFileSync(bad, "{not json");
    expect(readNativeCumulativeUsage(bad)).toBeUndefined();
    const noUsage = join(dir, "empty.settings.json");
    writeFileSync(noUsage, JSON.stringify({ model: "m" }));
    expect(readNativeCumulativeUsage(noUsage)).toBeUndefined();
  });

  it("真实 slug 布局端到端（mkdir -p ~/.factory/sessions/<slug>）", () => {
    const home = mkdtempSync(join(tmpdir(), "droid-recon-home-"));
    const p = droidNativeSessionPaths({ homeDir: home, cwd: "/w/x", sessionId: "abc-123" });
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.settingsFile, settingsJson({ inputTokens: 42, outputTokens: 5 }));
    expect(readNativeCumulativeUsage(p.settingsFile)?.input).toBe(42);
  });
});
