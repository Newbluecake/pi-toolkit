// external-agent plan §6.2 P4a：`renderExternalMemoryBlock` + `wireMemory().renderForExternal`
// （§5.6 冻结面）。语义 = 子会话视角：
// - `injectInChildSessions:false` / `childProfile:"none"` ⇒ undefined；
// - tiered ⇒ `renderTiered({ profile: childProfile, access: accessFromTools(["read"], toolSurface), 同预算 })`；
// - legacy ⇒ `renderMemoryBlock`（共享 wireMemory 的 RenderCache）；
// - 异常 ⇒ undefined；不读 frozenBlocks。

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type MemorySettings } from "../../src/config/settings.js";
import { renderExternalMemoryBlock } from "../../src/memory/inject.js";
import { wireMemory } from "../../src/memory/index.js";
import { memoryDirFor } from "../../src/memory/paths.js";
import { RenderCache, type InjectBudget } from "../../src/memory/render.js";
import { accessFromTools, renderTiered } from "../../src/memory/tiered.js";
import { renderMemoryBlock } from "../../src/memory/render.js";
import type { PromptSectionHub } from "../../src/sysprompt/hub.js";

const roots: string[] = [];

function fixture(settings: Partial<MemorySettings> = {}): { cwd: string; settings: MemorySettings } {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-ext-"));
  roots.push(tmp);
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(tmp, "mem"));
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  return { cwd, settings: { ...DEFAULT_SETTINGS.memory, ...settings } };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function addMemoryFile(cwd: string, name: string, body: string): void {
  const dir = memoryDirFor(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
}

const TIERED_FILE = `---
description: Core layout notes
read_when: touching layout code
pin: true
---

# Layout

The renderer is layered (core, index, pointer).
`;

function legacyBudget(s: MemorySettings): InjectBudget {
  return { inlineMax: s.inlineMax, byteCap: s.byteCap, indexMax: s.indexMax };
}

describe("renderExternalMemoryBlock (§5.6, P4a)", () => {
  it("returns undefined when injectInChildSessions is false (both layouts)", () => {
    for (const layout of ["tiered", "legacy"] as const) {
      const { cwd } = fixture({ injectInChildSessions: false, layout });
      addMemoryFile(cwd, "a.md", "# A\n\ncontent\n");
      expect(
        renderExternalMemoryBlock(
          { settings: { ...DEFAULT_SETTINGS.memory, layout, injectInChildSessions: false }, cache: new RenderCache() },
          cwd,
        ),
      ).toBeUndefined();
    }
  });

  it("returns undefined when childProfile is none (both layouts)", () => {
    for (const layout of ["tiered", "legacy"] as const) {
      const { cwd } = fixture({ layout });
      addMemoryFile(cwd, "a.md", "# A\n\ncontent\n");
      const settings = { ...DEFAULT_SETTINGS.memory, layout, childProfile: "none" } as MemorySettings;
      expect(renderExternalMemoryBlock({ settings, cache: new RenderCache() }, cwd)).toBeUndefined();
    }
  });

  it("tiered: equals renderTiered with profile=childProfile and access=accessFromTools(['read'], toolSurface)", () => {
    const { cwd, settings } = fixture({ childProfile: "core" });
    addMemoryFile(cwd, "layout.md", TIERED_FILE);
    addMemoryFile(cwd, "z-extra.md", "# Extra\n\nnon-core topic\n");
    const out = renderExternalMemoryBlock({ settings, cache: new RenderCache() }, cwd);
    const expected = renderTiered({
      cwd,
      profile: settings.childProfile,
      access: accessFromTools(["read"], settings.toolSurface),
      coreBytes: settings.coreBytes,
      blockBytes: settings.blockBytes,
      indexMax: settings.indexMax,
    }).text;
    expect(out).toBe(expected);
    expect(out).toContain("## Memory (");
    // 子会话视角是 core 档，不是主会话的 full 档。
    expect(out).not.toBe(
      renderTiered({
        cwd,
        profile: "full",
        access: accessFromTools(["read"], settings.toolSurface),
        coreBytes: settings.coreBytes,
        blockBytes: settings.blockBytes,
        indexMax: settings.indexMax,
      }).text,
    );
  });

  it("legacy: equals renderMemoryBlock and reuses the shared RenderCache", () => {
    const { cwd } = fixture({ layout: "legacy" });
    addMemoryFile(cwd, "a.md", "# A\n\npinned-ish content\n");
    const settings = { ...DEFAULT_SETTINGS.memory, layout: "legacy" } as MemorySettings;

    let gets = 0;
    let sets = 0;
    class CountingCache extends RenderCache {
      get(...args: Parameters<RenderCache["get"]>): ReturnType<RenderCache["get"]> {
        gets++;
        return super.get(...args);
      }
      set(...args: Parameters<RenderCache["set"]>): ReturnType<RenderCache["set"]> {
        sets++;
        return super.set(...args);
      }
    }
    const cache = new CountingCache();
    const out = renderExternalMemoryBlock({ settings, cache }, cwd);
    expect(out).toBe(renderMemoryBlock(cwd, legacyBudget(settings)));
    expect(gets).toBe(1);
    expect(sets).toBe(1);

    // 第二次调用命中缓存（不再写缓存）。
    renderExternalMemoryBlock({ settings, cache }, cwd);
    expect(gets).toBe(2);
    expect(sets).toBe(1);
  });

  it("returns undefined for an empty/missing memory dir (both layouts)", () => {
    const tiered = fixture();
    expect(
      renderExternalMemoryBlock({ settings: tiered.settings, cache: new RenderCache() }, tiered.cwd),
    ).toBeUndefined();
    const legacy = fixture({ layout: "legacy" });
    expect(
      renderExternalMemoryBlock({ settings: legacy.settings, cache: new RenderCache() }, legacy.cwd),
    ).toBeUndefined();
  });

  it("never throws: any failure degrades to undefined", () => {
    const { cwd, settings } = fixture();
    addMemoryFile(cwd, "layout.md", TIERED_FILE);
    // settings 读取在 try 内：getter 抛错 ⇒ undefined（两种 layout 都覆盖）。
    for (const layout of ["tiered", "legacy"] as const) {
      const exploding = { ...settings, layout } as MemorySettings;
      Object.defineProperty(exploding, "layout", {
        get(): string {
          throw new Error("boom");
        },
      });
      expect(renderExternalMemoryBlock({ settings: exploding, cache: new RenderCache() }, cwd)).toBeUndefined();
    }
    // cwd 端：让 memoryDirFor 自身抛错（join 于 null 字节）⇒ undefined。
    expect(renderExternalMemoryBlock({ settings, cache: new RenderCache() }, "/a\0b")).toBeUndefined();
  });
});

describe("wireMemory().renderForExternal (§5.6 wiring)", () => {
  function fakePi(): ExtensionAPI {
    return {
      on: () => () => undefined,
      registerTool: () => undefined,
      registerCommand: () => undefined,
    } as unknown as ExtensionAPI;
  }

  it("routes through renderExternalMemoryBlock with the wired settings + cache", () => {
    const { cwd, settings } = fixture({ childProfile: "core" });
    addMemoryFile(cwd, "layout.md", TIERED_FILE);
    const result = wireMemory(fakePi(), {
      settings,
      isChildSession: false,
      sections: { register: () => undefined } as unknown as PromptSectionHub,
    });
    expect(result.renderForExternal(cwd)).toBe(renderExternalMemoryBlock({ settings, cache: new RenderCache() }, cwd));
    // 子会话关闭注入 ⇒ undefined。
    expect(result.renderForExternal(cwd)).not.toBeUndefined();
    const off = wireMemory(fakePi(), {
      settings: { ...settings, injectInChildSessions: false },
      isChildSession: false,
      sections: { register: () => undefined } as unknown as PromptSectionHub,
    });
    expect(off.renderForExternal(cwd)).toBeUndefined();
  });
});
