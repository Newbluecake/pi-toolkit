// memory-plan §7.7 / sysprompt-stable plan v3.1 §4.6 (M3): the
// `pi_project_memory` SectionRegistration. Inline fakes only; per-test tmpdir
// + paths injection; never throws is part of the contract under test.
//
// M3 turned the old async `before_agent_start` handler into a synchronous
// `SectionRegistration` (provider / title / skipIf) consumed by the
// PromptSectionHub. These tests exercise the registration directly; the
// combined fold (memory -> types -> models) and the hub's stable-mode
// behavior are covered by tests/sysprompt/memory-section.test.ts.

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type MemorySettings } from "../../src/config/settings.js";
import { forgetWorktreeOrigin, recordWorktreeOrigin } from "../../src/core/worktree-origin.js";
import { memorySection, memoryTitle, type MemorySectionDeps } from "../../src/memory/inject.js";
import { memoryDirFor, toSlug, type MemoryPaths } from "../../src/memory/paths.js";
import { injectionSentinel, memoryFingerprint, RenderCache, type InjectBudget } from "../../src/memory/render.js";
import { SKIP } from "../../src/prompt-sections/stable-section.js";
import type { SectionProviderInput } from "../../src/sysprompt/hub.js";

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

function fakeCtx(cwd: string): ExtensionContext {
  return { cwd, hasUI: false, mode: "rpc", ui: { notify: () => undefined } } as unknown as ExtensionContext;
}

function input(promptText: string, ctx: ExtensionContext, optionsCwd?: string): SectionProviderInput {
  return { ctx, promptText, ...(optionsCwd === undefined ? {} : { optionsCwd }) };
}

function makeSection(
  fx: Fixture,
  over: {
    settings?: Partial<MemorySettings>;
    isChildSession?: boolean;
    frozenBlocks?: Map<string, string | undefined>;
  } = {},
) {
  const cache = new RenderCache();
  const frozenBlocks = over.frozenBlocks ?? new Map<string, string | undefined>();
  const deps: MemorySectionDeps = {
    settings: { ...DEFAULT_SETTINGS.memory, ...over.settings },
    isChildSession: over.isChildSession ?? false,
    cache,
    frozenBlocks,
    paths: fx.paths,
  };
  return { section: memorySection(deps), cache, frozenBlocks };
}

/** Folds a single section's live value the same way `foldSections` would, so
 *  these unit tests can still assert on "the resulting system prompt" like
 *  the pre-M3 tests did, without pulling in the hub. */
function foldOne(promptText: string, live: string | typeof SKIP): string | undefined {
  if (live === SKIP || live === "") return undefined;
  return promptText + "\n\n" + live;
}

describe("memorySection registration (§7.7, M3)", () => {
  test("provider yields exactly one block, title matches the block's first line, sentinel present", () => {
    const fx = fixture();
    withMemoryFile(fx, "notes.md", "remember this");
    const { section } = makeSection(fx);
    const ctx = fakeCtx(fx.cwd);
    const live = section.provider(input("BASE", ctx, fx.cwd));
    expect(typeof live).toBe("string");
    const prompt = foldOne("BASE", live as string)!;
    expect(prompt.startsWith("BASE\n\n## Memory (")).toBe(true);
    expect(prompt).toContain("remember this");
    expect(prompt).toContain(injectionSentinel(toSlug(fx.cwd)));
    const title = typeof section.title === "function" ? section.title(input("BASE", ctx, fx.cwd)) : section.title;
    expect(prompt.split("\n\n")[1]!.startsWith(title)).toBe(true);
    expect(title).toBe(memoryTitle(toSlug(fx.cwd)));
  });

  test("empty directory yields an empty Live (nothing to fold)", () => {
    const fx = fixture();
    mkdirSync(memoryDirFor(fx.cwd, fx.paths), { recursive: true });
    const { section } = makeSection(fx);
    const live = section.provider(input("BASE", fakeCtx(fx.cwd), fx.cwd));
    expect(live).toBe("");
    expect(foldOne("BASE", live as string)).toBeUndefined();
  });

  test("child sessions honor injectInChildSessions", () => {
    const fx = fixture();
    withMemoryFile(fx, "notes.md", "child-visible");
    const { section: denied } = makeSection(fx, { isChildSession: true, settings: { injectInChildSessions: false } });
    expect(denied.provider(input("BASE", fakeCtx(fx.cwd), fx.cwd))).toBe("");

    const { section: allowed } = makeSection(fx, { isChildSession: true });
    const live = allowed.provider(input("BASE", fakeCtx(fx.cwd), fx.cwd));
    expect(foldOne("BASE", live as string)).toContain("child-visible");
  });

  test("double-injection guard (skipIf): own sentinel and legacy plugin banner both skip (Nit 12)", () => {
    const fx = fixture();
    withMemoryFile(fx, "notes.md", "x");
    const slug = toSlug(fx.cwd);
    const { section } = makeSection(fx);
    expect(section.skipIf!(input(`BASE ${injectionSentinel(slug)}`, fakeCtx(fx.cwd), fx.cwd))).toBe(true);
    expect(section.skipIf!(input(`BASE\n${memoryTitle(slug)} — 1 file(s)`, fakeCtx(fx.cwd), fx.cwd))).toBe(true);
    expect(section.skipIf!(input("BASE", fakeCtx(fx.cwd), fx.cwd))).toBe(false);
  });

  test("cache hit serves the seeded block without re-rendering", () => {
    const fx = fixture();
    withMemoryFile(fx, "notes.md", "on-disk");
    const { section, cache } = makeSection(fx);
    const fp = memoryFingerprint(fx.cwd, fx.paths);
    cache.set(fx.cwd, fx.budget, fp, "SEEDED BLOCK");
    const live = section.provider(input("BASE", fakeCtx(fx.cwd), fx.cwd));
    expect(live).toBe("SEEDED BLOCK");
  });

  test("freeze: frozen block wins over changed files; frozen undefined yields empty Live (R2/R3)", () => {
    const fx = fixture();
    withMemoryFile(fx, "notes.md", "v1");
    const frozenBlocks = new Map<string, string | undefined>();
    const { section } = makeSection(fx, { frozenBlocks });
    frozenBlocks.set(fx.cwd, "FROZEN OLD");
    // disk churn must not matter while frozen
    withMemoryFile(fx, "other.md", "v2");
    expect(section.provider(input("BASE", fakeCtx(fx.cwd), fx.cwd))).toBe("FROZEN OLD");
    frozenBlocks.set(fx.cwd, undefined);
    expect(section.provider(input("BASE", fakeCtx(fx.cwd), fx.cwd))).toBe("");
  });

  test("cwd chain: worktree origin beats systemPromptOptions.cwd (B3)", () => {
    const fx = fixture();
    const mainCwd = join(fx.tmp, "main");
    const wtCwd = join(fx.tmp, "wt");
    mkdirSync(mainCwd, { recursive: true });
    mkdirSync(wtCwd, { recursive: true });
    withMemoryFile(fx, "main.md", "main-repo-memory", realpathSync(mainCwd));
    recordWorktreeOrigin(wtCwd, mainCwd);
    try {
      const { section } = makeSection(fx);
      const live = section.provider(input("BASE", fakeCtx(wtCwd), wtCwd));
      const title = (section.title as (i: SectionProviderInput) => string)(input("BASE", fakeCtx(wtCwd), wtCwd));
      expect(title).toBe(memoryTitle(toSlug(realpathSync(mainCwd))));
      expect(live).toContain("main-repo-memory");
    } finally {
      forgetWorktreeOrigin(wtCwd);
    }
  });

  test("cwd chain: falls back to ctx.cwd when systemPromptOptions is absent", () => {
    const fx = fixture();
    withMemoryFile(fx, "notes.md", "ctx-cwd-memory");
    const { section } = makeSection(fx);
    const live = section.provider(input("BASE", fakeCtx(fx.cwd)));
    expect(live).toContain("ctx-cwd-memory");
  });

  test("fs explosion degrades to an empty Live, never throws", () => {
    const fx = fixture();
    // memoryRoot is a regular file ⇒ every readdir/stat under it fails, but
    // listMemory/renderMemoryBlock already treat that as "empty directory"
    // (never throws) — so the provider yields "", the same as no memory files.
    writeFileSync(fx.paths.memoryRoot, "not a directory");
    const { section } = makeSection(fx);
    expect(section.provider(input("BASE", fakeCtx(fx.cwd), fx.cwd))).toBe("");
  });
});
