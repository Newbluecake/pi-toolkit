// memory-plan §7.7: the before_agent_start injection hook. Inline fakes
// only; per-test tmpdir + paths injection; never throws is part of the
// contract under test.

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type MemorySettings } from "../../src/config/settings.js";
import { forgetWorktreeOrigin, recordWorktreeOrigin } from "../../src/core/worktree-origin.js";
import { createMemoryInjectHook, type MemoryInjectDeps } from "../../src/memory/inject.js";
import { memoryDirFor, toSlug, type MemoryPaths } from "../../src/memory/paths.js";
import { injectionSentinel, memoryFingerprint, RenderCache, type InjectBudget } from "../../src/memory/render.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Fixture {
  tmp: string;
  cwd: string;
  paths: MemoryPaths;
  budget: InjectBudget;
}

function fixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-inject-"));
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  const s = DEFAULT_SETTINGS.memory;
  return {
    tmp,
    cwd,
    paths: { memoryRoot: join(tmp, "mem"), ccProjectsRoot: join(tmp, "cc") },
    budget: { inlineMax: s.inlineMax, byteCap: s.byteCap, indexMax: s.indexMax },
  };
}

function withMemoryFile(fx: Fixture, name: string, body: string, cwd = fx.cwd): string {
  const dir = memoryDirFor(cwd, fx.paths);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

function fakeEvent(systemPrompt: string, cwd?: string): BeforeAgentStartEvent {
  return {
    type: "before_agent_start",
    prompt: "hi",
    systemPrompt,
    ...(cwd === undefined ? {} : { systemPromptOptions: { cwd } }),
  } as unknown as BeforeAgentStartEvent;
}

function fakeCtx(cwd: string): ExtensionContext {
  return { cwd, hasUI: false, mode: "rpc", ui: { notify: () => undefined } } as unknown as ExtensionContext;
}

function makeHook(
  fx: Fixture,
  over: {
    settings?: Partial<MemorySettings>;
    isChildSession?: boolean;
    frozenBlocks?: Map<string, string | undefined>;
  } = {},
) {
  const cache = new RenderCache();
  const frozenBlocks = over.frozenBlocks ?? new Map<string, string | undefined>();
  const deps: MemoryInjectDeps = {
    settings: { ...DEFAULT_SETTINGS.memory, ...over.settings },
    isChildSession: over.isChildSession ?? false,
    cache,
    frozenBlocks,
    paths: fx.paths,
  };
  return { hook: createMemoryInjectHook(deps), cache, frozenBlocks };
}

describe("memory inject hook (§7.7)", () => {
  test("injects exactly one block with sentinel at the system-prompt tail", async () => {
    const fx = fixture();
    withMemoryFile(fx, "notes.md", "remember this");
    const { hook } = makeHook(fx);
    const result = await hook(fakeEvent("BASE", fx.cwd), fakeCtx(fx.cwd));
    expect(result).toBeDefined();
    const prompt = result!.systemPrompt!;
    expect(prompt.startsWith("BASE\n\n## Memory (")).toBe(true);
    expect(prompt).toContain("remember this");
    expect(prompt).toContain(injectionSentinel(toSlug(fx.cwd)));
  });

  test("empty directory injects nothing", async () => {
    const fx = fixture();
    mkdirSync(memoryDirFor(fx.cwd, fx.paths), { recursive: true });
    const { hook } = makeHook(fx);
    expect(await hook(fakeEvent("BASE", fx.cwd), fakeCtx(fx.cwd))).toBeUndefined();
  });

  test("child sessions honor injectInChildSessions", async () => {
    const fx = fixture();
    withMemoryFile(fx, "notes.md", "child-visible");
    const denied = makeHook(fx, { isChildSession: true, settings: { injectInChildSessions: false } });
    expect(await denied.hook(fakeEvent("BASE", fx.cwd), fakeCtx(fx.cwd))).toBeUndefined();
    const allowed = makeHook(fx, { isChildSession: true });
    expect((await allowed.hook(fakeEvent("BASE", fx.cwd), fakeCtx(fx.cwd)))!.systemPrompt).toContain("child-visible");
  });

  test("double-injection guard: own sentinel and legacy plugin banner both skip (Nit 12)", async () => {
    const fx = fixture();
    withMemoryFile(fx, "notes.md", "x");
    const slug = toSlug(fx.cwd);
    const { hook } = makeHook(fx);
    expect(await hook(fakeEvent(`BASE ${injectionSentinel(slug)}`, fx.cwd), fakeCtx(fx.cwd))).toBeUndefined();
    expect(await hook(fakeEvent(`BASE\n## Memory (${slug}) — 1 file(s)`, fx.cwd), fakeCtx(fx.cwd))).toBeUndefined();
  });

  test("cache hit serves the seeded block without re-rendering", async () => {
    const fx = fixture();
    withMemoryFile(fx, "notes.md", "on-disk");
    const { hook, cache } = makeHook(fx);
    const fp = memoryFingerprint(fx.cwd, fx.paths);
    cache.set(fx.cwd, fx.budget, fp, "SEEDED BLOCK");
    const result = await hook(fakeEvent("BASE", fx.cwd), fakeCtx(fx.cwd));
    expect(result!.systemPrompt).toBe("BASE\n\nSEEDED BLOCK");
  });

  test("freeze: frozen block wins over changed files; frozen undefined injects nothing (R2/R3)", async () => {
    const fx = fixture();
    withMemoryFile(fx, "notes.md", "v1");
    const frozenBlocks = new Map<string, string | undefined>();
    const { hook } = makeHook(fx, { frozenBlocks });
    frozenBlocks.set(fx.cwd, "FROZEN OLD");
    // disk churn must not matter while frozen
    withMemoryFile(fx, "other.md", "v2");
    const result = await hook(fakeEvent("BASE", fx.cwd), fakeCtx(fx.cwd));
    expect(result!.systemPrompt).toBe("BASE\n\nFROZEN OLD");
    frozenBlocks.set(fx.cwd, undefined);
    expect(await hook(fakeEvent("BASE", fx.cwd), fakeCtx(fx.cwd))).toBeUndefined();
  });

  test("cwd chain: worktree origin beats systemPromptOptions.cwd (B3)", async () => {
    const fx = fixture();
    const mainCwd = join(fx.tmp, "main");
    const wtCwd = join(fx.tmp, "wt");
    mkdirSync(mainCwd, { recursive: true });
    mkdirSync(wtCwd, { recursive: true });
    withMemoryFile(fx, "main.md", "main-repo-memory", realpathSync(mainCwd));
    recordWorktreeOrigin(wtCwd, mainCwd);
    try {
      const { hook } = makeHook(fx);
      const result = await hook(fakeEvent("BASE", wtCwd), fakeCtx(wtCwd));
      expect(result!.systemPrompt).toContain(`## Memory (${toSlug(realpathSync(mainCwd))})`);
      expect(result!.systemPrompt).toContain("main-repo-memory");
    } finally {
      forgetWorktreeOrigin(wtCwd);
    }
  });

  test("cwd chain: falls back to ctx.cwd when systemPromptOptions is absent", async () => {
    const fx = fixture();
    withMemoryFile(fx, "notes.md", "ctx-cwd-memory");
    const { hook } = makeHook(fx);
    const result = await hook(fakeEvent("BASE"), fakeCtx(fx.cwd));
    expect(result!.systemPrompt).toContain("ctx-cwd-memory");
  });

  test("fs explosion degrades to undefined, never throws", async () => {
    const fx = fixture();
    // memoryRoot is a regular file ⇒ every readdir/stat under it blows up.
    writeFileSync(fx.paths.memoryRoot, "not a directory");
    const { hook } = makeHook(fx);
    expect(await hook(fakeEvent("BASE", fx.cwd), fakeCtx(fx.cwd))).toBeUndefined();
  });
});
