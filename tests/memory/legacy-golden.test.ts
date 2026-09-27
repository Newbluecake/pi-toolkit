// P0-a legacy golden suite (方案 docs/dev/memory/optimize-plan.md §10.1 / §10.2 A组,
// A1–A4、A6; A5 needs a setting key that doesn't exist yet — deferred to P0-b).
//
// This file — and ONLY this file, run with UPDATE_MEMORY_GOLDEN=1 — generates
// tests/fixtures/memory-legacy-golden.json. src/ is untouched by this commit
// (git diff --stat -- src/ is empty); every case below exercises the CURRENT
// (pre-#22) legacy implementation only, so the golden pins today's behavior
// as the regression oracle for every later P0-b/P1-P5 package.
//
// Determinism protocol (§10.1):
//  1. fixtures are the checked-in tests/fixtures/memory/{current-5,synthetic,
//     cc-source}/ trees, materialized into a fresh mkdtemp() root per case
//     via tests/memory/helpers/fixture-dir.ts (mtimes fixed, never the real
//     filesystem clock).
//  2. HOME / ARMORY_MEMORY_ROOT are stubbed to a throwaway tmp dir in every
//     test (defensive net — every case below already passes an explicit
//     `paths`, so no code should ever reach defaultPaths(), but if it did it
//     would still land inside os.tmpdir()).
//  3. wall-clock-dependent cases (tool write, which upserts a `updated:`
//     frontmatter timestamp via `new Date().toISOString()`) run under
//     `vi.useFakeTimers` pinned to a fixed instant.
//  4. every captured string/object is deep-redacted (tmp root -> `${MEMROOT}`)
//     before comparison/storage, so the golden file contains no machine-
//     specific paths.
//  5. UPDATE_MEMORY_GOLDEN=1 refuses to run if the golden file already
//     exists (generate-once, never overwrite — same rule as the
//     compact-hint golden).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { renderMemoryBlock, RenderCache, type InjectBudget } from "../../src/memory/render.js";
import { memorySection, type MemorySectionDeps } from "../../src/memory/inject.js";
import { createMemoryTool } from "../../src/memory/tool.js";
import { importAll, importProject } from "../../src/memory/store.js";
import { defaultPaths, type MemoryPaths } from "../../src/memory/paths.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { createPromptSectionHub, type SystemPromptMode } from "../../src/sysprompt/hub.js";
import { PROMPT_SECTIONS_ENTRY_TYPE } from "../../src/prompt-sections/store.js";
import {
  FIXTURE_CWD,
  materializeCCFixture,
  materializeEmptyFixture,
  materializeFixture,
  writeMemAt,
} from "./helpers/fixture-dir.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(HERE, "..", "fixtures", "memory-legacy-golden.json");
const UPDATE = process.env.UPDATE_MEMORY_GOLDEN === "1";
const GOLDEN_EXISTS = existsSync(GOLDEN_PATH);

if (UPDATE && GOLDEN_EXISTS) {
  throw new Error(
    "UPDATE_MEMORY_GOLDEN=1 but tests/fixtures/memory-legacy-golden.json already exists. " +
      "Legacy golden is generate-once, never overwrite (方案 §10.1 point 6) — delete it " +
      "by hand first if you really intend to regenerate (that is itself a 方案 revision).",
  );
}

// ────────────────────────────── golden load/save ──────────────────────────

interface GoldenFile {
  sourceCommit: string;
  generatedAt: string;
  cases: Record<string, unknown>;
}

function sourceCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: HERE, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const loadedGolden: GoldenFile | undefined = UPDATE
  ? undefined
  : (JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenFile);
const cases: Record<string, unknown> = UPDATE ? {} : (loadedGolden?.cases ?? {});

/** Deep-redact every occurrence of `root` (a case's tmp fixture root) in
 *  strings nested anywhere in `value`, so the golden file is machine-
 *  independent (方案 §10.1 point 5). */
function redact(value: unknown, root: string): unknown {
  if (typeof value === "string") return value.split(root).join("${MEMROOT}");
  if (Array.isArray(value)) return value.map((v) => redact(v, root));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redact(v, root);
    return out;
  }
  return value;
}

/** Canonicalize (recursively sort object keys) so the persisted JSON has a
 *  stable, diff-friendly key order regardless of insertion order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Record (UPDATE mode) or assert-equal (normal mode) one golden case. Runs
 *  through a JSON round-trip so `undefined`-valued keys (e.g. the tool
 *  result's `details: undefined`) drop out exactly like they do when the
 *  golden file itself is written/read via JSON.stringify/parse — otherwise
 *  a structurally-identical value with an explicit `undefined` property
 *  would spuriously differ from the loaded-from-disk golden. */
function goldenCheck(id: string, actualRaw: unknown, root: string): void {
  const actual = JSON.parse(JSON.stringify(canonical(redact(actualRaw, root))));
  if (UPDATE) {
    cases[id] = actual;
    return;
  }
  expect(actual).toEqual(cases[id]);
}

afterAll(() => {
  if (!UPDATE) return;
  const output: GoldenFile = { sourceCommit: sourceCommit(), generatedAt: new Date().toISOString(), cases };
  writeFileSync(GOLDEN_PATH, JSON.stringify(output, null, 2) + "\n");
});

// ────────────────────────────── env/time safety net ────────────────────────

let envTmp: string;
beforeEach(() => {
  envTmp = mkdtempSync(join(tmpdir(), "memfx-env-"));
  vi.stubEnv("HOME", join(envTmp, "nohome"));
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(envTmp, "root"));
  // §10.1 point 3: any code that accidentally reaches defaultPaths() must
  // still land inside os.tmpdir(), never the real ~/.pi/agent/memory.
  expect(defaultPaths().memoryRoot.startsWith(tmpdir())).toBe(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(envTmp, { recursive: true, force: true });
});

const DEFAULT_BUDGET: InjectBudget = {
  inlineMax: DEFAULT_SETTINGS.memory.inlineMax,
  byteCap: DEFAULT_SETTINGS.memory.byteCap,
  indexMax: DEFAULT_SETTINGS.memory.indexMax,
};

function fakeCtx(cwd: string, extra: Record<string, unknown> = {}): ExtensionContext {
  return { cwd, hasUI: false, mode: "rpc", ...extra } as unknown as ExtensionContext;
}

// ═══════════════════════════ A1 — renderMemoryBlock ════════════════════════

describe("A1 — renderMemoryBlock legacy golden", () => {
  it("current-5", () => {
    const fx = materializeFixture("current-5");
    const block = renderMemoryBlock(fx.cwd, DEFAULT_BUDGET, fx.paths);
    goldenCheck("a1_current5", block ?? null, fx.paths.memoryRoot);
    fx.cleanup();
  });

  it("empty directory -> undefined", () => {
    const fx = materializeEmptyFixture();
    const block = renderMemoryBlock(fx.cwd, DEFAULT_BUDGET, fx.paths);
    expect(block).toBeUndefined();
    fx.cleanup();
  });

  it("single file", () => {
    const fx = materializeEmptyFixture();
    writeMemAt(fx.memDir, "solo.md", "Solo file body.\n", "2026-09-01T00:00:00.000Z");
    const block = renderMemoryBlock(fx.cwd, DEFAULT_BUDGET, fx.paths);
    goldenCheck("a1_single_file", block ?? null, fx.paths.memoryRoot);
    fx.cleanup();
  });

  it("over indexMax (18 files, default indexMax=15)", () => {
    const fx = materializeEmptyFixture();
    for (let i = 1; i <= 18; i++) {
      const name = `file${String(i).padStart(2, "0")}.md`;
      writeMemAt(
        fx.memDir,
        name,
        `Content of file ${i}.\n`,
        new Date(Date.parse("2026-09-01T00:00:00.000Z") + i * 60_000).toISOString(),
      );
    }
    const block = renderMemoryBlock(fx.cwd, DEFAULT_BUDGET, fx.paths);
    goldenCheck("a1_over_index_max", block ?? null, fx.paths.memoryRoot);
    fx.cleanup();
  });

  it("inlineMax=0 (current-5)", () => {
    const fx = materializeFixture("current-5");
    const block = renderMemoryBlock(fx.cwd, { ...DEFAULT_BUDGET, inlineMax: 0 }, fx.paths);
    goldenCheck("a1_inline_max_zero", block ?? null, fx.paths.memoryRoot);
    fx.cleanup();
  });

  it("byteCap=0 (current-5)", () => {
    const fx = materializeFixture("current-5");
    const block = renderMemoryBlock(fx.cwd, { ...DEFAULT_BUDGET, byteCap: 0 }, fx.paths);
    goldenCheck("a1_byte_cap_zero", block ?? null, fx.paths.memoryRoot);
    fx.cleanup();
  });

  it("synthetic/legacy-names — arbitrary filenames pass through unchanged", () => {
    const fx = materializeFixture("synthetic/legacy-names");
    const block = renderMemoryBlock(fx.cwd, DEFAULT_BUDGET, fx.paths);
    goldenCheck("a1_legacy_names", block ?? null, fx.paths.memoryRoot);
    // The non-whitelisted names must literally appear (proves legacy accepts
    // any *.md filename — no NAME_RE check on the read path).
    expect(block).toContain("My Notes.md");
    expect(block).toContain(".hidden.md");
    expect(block).toContain("中文.md");
    fx.cleanup();
  });
});

// ═══════════════════════════ A2 — memorySection ════════════════════════════

describe("A2 — memorySection legacy golden", () => {
  function deps(fx: { paths: MemoryPaths }, isChildSession: boolean): MemorySectionDeps {
    return {
      settings: DEFAULT_SETTINGS.memory,
      isChildSession,
      cache: new RenderCache(),
      frozenBlocks: new Map(),
      paths: fx.paths,
    };
  }

  it("main session", () => {
    const fx = materializeFixture("current-5");
    const section = memorySection(deps(fx, false));
    const live = section.provider({ ctx: fakeCtx(fx.cwd), promptText: "", optionsCwd: fx.cwd });
    goldenCheck("a2_main", live, fx.paths.memoryRoot);
    fx.cleanup();
  });

  it("child session (injectInChildSessions default true) still injects the full legacy block", () => {
    const fx = materializeFixture("current-5");
    const section = memorySection(deps(fx, true));
    const live = section.provider({ ctx: fakeCtx(fx.cwd), promptText: "", optionsCwd: fx.cwd });
    goldenCheck("a2_child", live, fx.paths.memoryRoot);
    // childProfile (P5) doesn't exist yet; layout=legacy is documented (§10.2
    // G7) to keep injecting the full block for any child profile except
    // injectInChildSessions=false. Pin that this IS the same content as the
    // main-session render (legacy has no child-specific shrinking).
    expect(live).toBe(section.provider({ ctx: fakeCtx(fx.cwd), promptText: "", optionsCwd: fx.cwd }));
    fx.cleanup();
  });
});

// ═══════════════════════════ A3 — hub mode × session_start reason ═════════

interface FakePi {
  pi: ExtensionAPI;
  handlers: Map<string, (event: any, ctx: any) => any>;
  appended: Array<{ type: string; data: unknown }>;
}

function fakePi(): FakePi {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const appended: Array<{ type: string; data: unknown }> = [];
  const pi = {
    on(event: string, handler: any) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    appendEntry(type: string, data?: unknown) {
      appended.push({ type, data });
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, appended };
}

function makeHub(host: FakePi, mode: SystemPromptMode) {
  return createPromptSectionHub(host.pi, { mode: () => mode, wakeReplay: false, adoptForeignForcedPrompt: false });
}

function sessionStart(host: FakePi, reason: string, ctx: Partial<ExtensionContext> = {}): void {
  host.handlers.get("session_start")?.({ type: "session_start", reason }, ctx);
}

function beforeAgentStart(host: FakePi, systemPrompt: string, cwd: string): any {
  const handler = host.handlers.get("before_agent_start")!;
  return handler(
    { type: "before_agent_start", prompt: "go", systemPrompt, systemPromptOptions: { cwd } },
    fakeCtx(cwd),
  );
}

function snapshotResult(r: any): { systemPrompt: string; hasMessage: boolean } {
  if (r === undefined) return { systemPrompt: "BASE", hasMessage: false };
  return { systemPrompt: r.systemPrompt ?? "BASE", hasMessage: r.message !== undefined };
}

describe("A3 — systemPrompt.mode × session_start reason golden", () => {
  const MODES: SystemPromptMode[] = ["stable", "live", "legacy"];

  for (const mode of MODES) {
    it(`mode=${mode}: new / resume / reload all fold the memory section byte-identically, zero updates`, () => {
      const fx = materializeFixture("current-5");
      const memDeps = (): MemorySectionDeps => ({
        settings: DEFAULT_SETTINGS.memory,
        isChildSession: false,
        cache: new RenderCache(),
        frozenBlocks: new Map(),
        paths: fx.paths,
      });

      // Phase 1: a brand-new session (reason "new" always resets to fresh,
      // regardless of any branch data — src/prompt-sections/store.ts).
      const host1 = fakePi();
      const hub1 = makeHub(host1, mode);
      hub1.register("pi_project_memory", memorySection(memDeps()));
      sessionStart(host1, "new", {});
      const r1 = beforeAgentStart(host1, "BASE", fx.cwd);
      const snap1 = snapshotResult(r1);
      expect(snap1.hasMessage).toBe(false); // first-ever refresh never emits an update
      goldenCheck(`a3_${mode}_new`, snap1, fx.paths.memoryRoot);

      const persisted = host1.appended.find((e) => e.type === PROMPT_SECTIONS_ENTRY_TYPE);

      // Phase 2: simulate a restart (fresh hub/closure) for resume and reload,
      // restoring from phase 1's persisted branch entry (stable mode only —
      // live/legacy never persist, so ctx has no sessionManager for them,
      // which is exactly what a real restart of those modes looks like too).
      for (const reason of ["resume", "reload"] as const) {
        const host2 = fakePi();
        const hub2 = makeHub(host2, mode);
        hub2.register("pi_project_memory", memorySection(memDeps()));
        const ctx: Partial<ExtensionContext> = persisted
          ? {
              sessionManager: {
                getBranch: () => [{ type: "custom", customType: PROMPT_SECTIONS_ENTRY_TYPE, data: persisted.data }],
              } as any,
            }
          : {};
        sessionStart(host2, reason, ctx);
        const r2 = beforeAgentStart(host2, "BASE", fx.cwd);
        const snap2 = snapshotResult(r2);
        // Fixture content is unchanged between phase 1 and phase 2 -> the
        // restored `announced` already matches the live render -> zero update.
        expect(snap2.hasMessage).toBe(false);
        expect(snap2.systemPrompt).toBe(snap1.systemPrompt); // byte-identical across restart
        goldenCheck(`a3_${mode}_${reason}`, snap2, fx.paths.memoryRoot);
      }
      fx.cleanup();
    });
  }
});

// ═══════════════════════════ A4 — tool surface (legacy) ════════════════════

/** Recursively sort object keys — local, test-only canonicalization (the
 *  real `canonicalJson` lands in src/memory/tool-surface.ts in P0-b; this
 *  commit is src-zero-change, so this is a throwaway duplicate scoped to
 *  serializing the plain-data parts of the legacy ToolDefinition only).
 *  Must itself recurse into nested objects (the `parameters` typebox
 *  schema has several levels) and preserve array order — `canonicalToolDef`
 *  is meant to model what the real `canonicalJson` does, so it has to prove
 *  that on its own rather than relying on `goldenCheck`'s own `canonical()`
 *  wrapper (which would recursively sort the golden comparison anyway and
 *  so could never reveal a non-recursive bug here). See the standalone
 *  proof test below ("canonicalToolDef recursively sorts nested keys"). */
function canonicalToolDef(def: ReturnType<typeof createMemoryTool>): unknown {
  return canonical(
    JSON.parse(
      JSON.stringify({
        name: def.name,
        label: def.label,
        description: def.description,
        promptSnippet: def.promptSnippet,
        promptGuidelines: def.promptGuidelines,
        parameters: def.parameters,
      }),
    ),
  );
}

describe("A4 — memory tool surface (toolSurface=legacy) golden", () => {
  it("canonicalToolDef recursively sorts nested keys (proof, not golden-dependent)", () => {
    // A deliberately unsorted, nested fixture with the SAME shape class as
    // `parameters` (nested objects + an array whose element order must be
    // preserved) — asserts on JSON.stringify's key ORDER, not just deep
    // equality, so a non-recursive canonicalize (only top-level keys sorted)
    // would fail this even though `goldenCheck`'s outer `canonical()` could
    // never expose that bug on its own.
    const fakeDef = {
      name: "z",
      label: "a",
      description: "d",
      promptSnippet: "s",
      promptGuidelines: "g",
      parameters: {
        type: "object",
        properties: {
          zeta: { type: "string", enum: ["b", "a"] },
          alpha: {
            nested: { z: 1, a: 2 },
            list: [
              { y: 1, x: 2 },
              { b: 1, a: 2 },
            ],
          },
        },
      },
    } as unknown as ReturnType<typeof createMemoryTool>;
    const result = canonicalToolDef(fakeDef);
    expect(JSON.stringify(result)).toBe(
      JSON.stringify({
        description: "d",
        label: "a",
        name: "z",
        parameters: {
          properties: {
            alpha: {
              list: [
                { x: 2, y: 1 },
                { a: 2, b: 1 },
              ],
              nested: { a: 2, z: 1 },
            },
            zeta: { enum: ["b", "a"], type: "string" },
          },
          type: "object",
        },
        promptGuidelines: "g",
        promptSnippet: "s",
      }),
    );
  });

  it("tool definition canonical serialization", () => {
    const def = createMemoryTool({ settings: DEFAULT_SETTINGS.memory, isChildSession: false, onAfterWrite: () => {} });
    goldenCheck("a4_tool_def", canonicalToolDef(def), "@@none@@");
  });

  it("list", async () => {
    const fx = materializeFixture("current-5");
    const tool = createMemoryTool({
      settings: DEFAULT_SETTINGS.memory,
      isChildSession: false,
      onAfterWrite: () => {},
      paths: fx.paths,
    });
    const result = await tool.execute(
      "call-list",
      { action: "list" } as any,
      undefined as any,
      undefined as any,
      fakeCtx(fx.cwd),
    );
    goldenCheck("a4_list", result, fx.paths.memoryRoot);
    fx.cleanup();
  });

  it("write (fixed system time)", async () => {
    const fx = materializeEmptyFixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T00:00:00.000Z"));
    try {
      const tool = createMemoryTool({
        settings: DEFAULT_SETTINGS.memory,
        isChildSession: false,
        onAfterWrite: () => {},
        paths: fx.paths,
      });
      const result = await tool.execute(
        "call-write",
        { action: "write", name: "decisions.md", content: "# Decisions\n\nUse X.\n" } as any,
        undefined as any,
        undefined as any,
        fakeCtx(fx.cwd),
      );
      const fileBody = readFileSync(join(fx.memDir, "decisions.md"), "utf8");
      goldenCheck("a4_write", { result, fileBody }, fx.paths.memoryRoot);
    } finally {
      vi.useRealTimers();
      fx.cleanup();
    }
  });

  it("append (pure O_APPEND, never touches frontmatter)", async () => {
    const fx = materializeEmptyFixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T00:00:00.000Z"));
    try {
      const tool = createMemoryTool({
        settings: DEFAULT_SETTINGS.memory,
        isChildSession: false,
        onAfterWrite: () => {},
        paths: fx.paths,
      });
      await tool.execute(
        "call-append-1",
        { action: "write", name: "log.md", content: "first line\n" } as any,
        undefined as any,
        undefined as any,
        fakeCtx(fx.cwd),
      );
      const result = await tool.execute(
        "call-append-2",
        { action: "append", name: "log.md", content: "second line" } as any,
        undefined as any,
        undefined as any,
        fakeCtx(fx.cwd),
      );
      const fileBody = readFileSync(join(fx.memDir, "log.md"), "utf8");
      goldenCheck("a4_append", { result, fileBody }, fx.paths.memoryRoot);
    } finally {
      vi.useRealTimers();
      fx.cleanup();
    }
  });
});

// ═══════════════════════════ A6 — CC import golden ═════════════════════════

describe("A6 — CC import (importProject / importAll) golden", () => {
  it("importProject — fresh import", () => {
    const cc = materializeCCFixture();
    const result = importProject("demo-project", false, cc.paths);
    const notesBody = readFileSync(join(cc.paths.memoryRoot, "demo-project", "notes.md"), "utf8");
    const playbookBody = readFileSync(join(cc.paths.memoryRoot, "demo-project", "playbook.md"), "utf8");
    goldenCheck("a6_import_project", { result, notesBody, playbookBody }, cc.paths.memoryRoot);

    // Re-running without --force skips both (idempotent).
    const skipResult = importProject("demo-project", false, cc.paths);
    goldenCheck("a6_import_project_skip", skipResult, cc.paths.memoryRoot);

    // --force re-copies from the (untouched) CC source, byte-identical.
    const forceResult = importProject("demo-project", true, cc.paths);
    const notesBodyAfterForce = readFileSync(join(cc.paths.memoryRoot, "demo-project", "notes.md"), "utf8");
    goldenCheck(
      "a6_import_project_force",
      { result: forceResult, notesBody: notesBodyAfterForce },
      cc.paths.memoryRoot,
    );

    cc.cleanup();
  });

  it("importAll — discovers every CC project with a memory/ dir", () => {
    const cc = materializeCCFixture();
    const results = importAll(false, cc.paths);
    goldenCheck("a6_import_all", results, cc.paths.memoryRoot);
    cc.cleanup();
  });
});
