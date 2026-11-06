// #36 P3 (arch §3.3.4/§3.3.3) — memorySection's layout dispatch: a blocks
// directory renders through blocks/render.ts (even under a tiered/legacy
// setting — the data format wins), a files directory under tiered stays
// byte-identical to renderTiered, and the external renderer follows the
// blocks branch with the external eligibility applied.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type MemorySettings } from "../../../src/config/settings.js";
import { memorySection, renderExternalMemoryBlock } from "../../../src/memory/inject.js";
import { memoryDirFor, toSlug, type MemoryPaths } from "../../../src/memory/paths.js";
import { renderTiered } from "../../../src/memory/tiered.js";
import { RenderCache } from "../../../src/memory/render.js";
import { readCorpus } from "../../../src/memory/blocks/store.js";
import { renderBlocks } from "../../../src/memory/blocks/render.js";
import { blockRaw, writeBlocksDir } from "./helpers.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fixture(): { tmp: string; cwd: string; paths: MemoryPaths } {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-inject-blocks-"));
  tmpRoots.push(tmp);
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  return { tmp, cwd, paths: { memoryRoot: join(tmp, "mem"), ccProjectsRoot: join(tmp, "cc") } };
}

function ctx(cwd: string): ExtensionContext {
  return { cwd, hasUI: false, mode: "rpc", ui: { notify: () => undefined } } as unknown as ExtensionContext;
}

function section(settings: Partial<MemorySettings>, deps: { isChildSession?: boolean; paths?: MemoryPaths } = {}) {
  const frozenBlocks = new Map<string, string | undefined>();
  const renders: { cwd: string; block: string | undefined; resident?: ReadonlyMap<string, string> }[] = [];
  const registration = memorySection({
    settings: { ...DEFAULT_SETTINGS.memory, ...settings },
    isChildSession: deps.isChildSession === true,
    cache: new RenderCache(),
    frozenBlocks,
    ...(deps.paths === undefined ? {} : { paths: deps.paths }),
    onRender: (cwd, block, _info, resident) => renders.push({ cwd, block, resident }),
  });
  return { registration, frozenBlocks, renders };
}

const INPUT = { optionsCwd: undefined, ctx: undefined, promptText: "" } as never;

describe("memorySection layout dispatch", () => {
  test("files directory + layout:tiered ⇒ byte-identical to renderTiered", () => {
    const fx = fixture();
    const dir = memoryDirFor(fx.cwd, fx.paths);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "core.md"), "# Core\n\n## Rules\n\n- run the gate first\n");
    const { registration } = section({ layout: "tiered" });
    const out = registration.provider({ ...INPUT, ctx: ctx(fx.cwd) });
    const direct = renderTiered({
      cwd: fx.cwd,
      profile: "full",
      access: "memory",
      coreBytes: DEFAULT_SETTINGS.memory.coreBytes,
      blockBytes: DEFAULT_SETTINGS.memory.blockBytes,
      indexMax: DEFAULT_SETTINGS.memory.indexMax,
    }).text;
    expect(out).toBe(direct);
  });

  test("blocks directory + layout:tiered ⇒ blocks render (data format wins)", () => {
    const fx = fixture();
    const memDir = memoryDirFor(fx.cwd, fx.paths);
    writeBlocksDir(memDir, [
      { id: "general.001", authority: "user", scope: "global", body: "- always ask first" },
      { id: "quota.001", body: "- quota note" },
    ]);
    const { registration, renders } = section({ layout: "tiered" }, { paths: fx.paths });
    const out = registration.provider({ ...INPUT, ctx: ctx(fx.cwd) }) as string;
    const expected = renderBlocks(readCorpus(join(memDir, "blocks")), {
      slug: toSlug(fx.cwd),
      isChild: false,
      residentBytes: DEFAULT_SETTINGS.memory.residentBytes,
      today: todayNow(),
    }).text;
    expect(out).toBe(expected);
    expect(out).toContain("### User rules (always on)");
    expect(out).toContain("- [general.001] always ask first");
    // onRender carries THIS render's resident map (id → renderKey)
    expect(renders.at(-1)?.resident?.get("general.001")).toBeTypeOf("string");
  });

  test('childProfile:none renders "" even with a full blocks directory (g9)', () => {
    const fx = fixture();
    writeBlocksDir(memoryDirFor(fx.cwd, fx.paths), [
      { id: "general.001", authority: "user", scope: "global", body: "- always ask first" },
    ]);
    const { registration } = section(
      { layout: "tiered", childProfile: "none", injectInChildSessions: true },
      { isChildSession: true, paths: fx.paths },
    );
    expect(registration.provider({ ...INPUT, ctx: ctx(fx.cwd) })).toBe("");
  });

  test("child session: audience=main global filtered out of the resident section", () => {
    const fx = fixture();
    const memDir = memoryDirFor(fx.cwd, fx.paths);
    writeBlocksDir(memDir, [
      { id: "general.001", authority: "user", scope: "global", body: "- shared rule" },
      { id: "general.002", authority: "user", scope: "global", audience: "main", body: "- main-only rule" },
    ]);
    const { registration } = section(
      { layout: "tiered", injectInChildSessions: true, childProfile: "full" },
      { isChildSession: true, paths: fx.paths },
    );
    const out = registration.provider({ ...INPUT, ctx: ctx(fx.cwd) }) as string;
    expect(out).toContain("- [general.001] shared rule");
    expect(out).not.toContain("main-only rule");
  });

  test("render cache: an external write to blocks/ flips the next provider render; midnight flips the expiry note", () => {
    const fx = fixture();
    const memDir = memoryDirFor(fx.cwd, fx.paths);
    writeBlocksDir(memDir, [{ id: "general.001", authority: "user", scope: "global", body: "- v1 rule" }]);
    const { registration } = section({ layout: "tiered" }, { paths: fx.paths });
    const first = registration.provider({ ...INPUT, ctx: ctx(fx.cwd) });
    expect(first).toContain("v1 rule");
    // same fingerprint + date ⇒ cached, byte-identical
    expect(registration.provider({ ...INPUT, ctx: ctx(fx.cwd) })).toBe(first);
    // external process write (bypassing every invalidation callback)
    writeFileSync(join(memDir, "blocks", "quota.001.md"), blockRaw({ id: "quota.001", body: "- quota note" }));
    const second = registration.provider({ ...INPUT, ctx: ctx(fx.cwd) }) as string;
    // agent bodies render only through the Jev message channel — the index
    // line (and the header count) is where the write shows up here.
    expect(second).toContain("- quota · 1 blocks");
    expect(second).not.toBe(first);
    // midnight: an expires=today rule gains the expiry note without any write
    writeFileSync(
      join(memDir, "blocks", "general.001.md"),
      readCorpus(join(memDir, "blocks"))
        .blocks.find((b) => b.id === "general.001")!
        .raw.replace("status: active", 'status: active\nexpires: "2026-11-07"'),
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T09:00:00"));
    try {
      const third = registration.provider({ ...INPUT, ctx: ctx(fx.cwd) }) as string;
      expect(third).toContain("（已到期，待用户确认）");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pointerHint under blocks layout (v3, acceptance fix #5)", () => {
  test("blocks directory ⇒ action:view; legacy keeps the original literal byte-for-byte", () => {
    const fx = fixture();
    writeBlocksDir(memoryDirFor(fx.cwd, fx.paths), [
      { id: "general.001", authority: "user", scope: "global", body: "- r" },
    ]);
    const input = { optionsCwd: undefined, ctx: ctx(fx.cwd), promptText: "" };
    const blocksHint = section({ layout: "tiered" }, { paths: fx.paths }).registration.pointerHint as (
      i: unknown,
    ) => string;
    expect(typeof blocksHint).toBe("function");
    expect(blocksHint(input)).toBe("Use the memory tool (action: 'view') to read the current entries.");
    // legacy layout (files directory) keeps the ORIGINAL literal string
    const fx2 = fixture();
    mkdirSync(memoryDirFor(fx2.cwd, fx2.paths), { recursive: true });
    const legacyHint = section({ layout: "legacy" }, { paths: fx2.paths }).registration.pointerHint as (
      i: unknown,
    ) => string;
    expect(legacyHint(input)).toBe("Use the memory tool (action: 'list') to read the current entries.");
  });
});

describe("/mem init under blocks layout (V06)", () => {
  test("runMemInit returns the blocks outcome without writing any file", async () => {
    const { runMemInit } = await import("../../../src/memory/init-command.js");
    const fx = fixture();
    const memDir = memoryDirFor(fx.cwd, fx.paths);
    writeBlocksDir(memDir, [{ id: "general.001", authority: "user", scope: "global", body: "- rule" }]);
    const outcome = await runMemInit(fx.cwd, { paths: fx.paths, isChildSession: false });
    expect(outcome).toEqual({ kind: "blocks", path: `${memDir}/core.md` });
    // no core.md materialized next to the blocks directory
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(memDir).includes("core.md")).toBe(false);
  });
});

describe("renderExternalMemoryBlock (blocks branch)", () => {
  test("blocks layout renders resident + index with the external eligibility (child口径)", () => {
    const fx = fixture();
    const memDir = memoryDirFor(fx.cwd, fx.paths);
    writeBlocksDir(memDir, [
      { id: "general.001", authority: "user", scope: "global", body: "- shared external rule" },
      { id: "general.002", authority: "user", scope: "global", audience: "main", body: "- main only" },
      { id: "quota.001", body: "- quota external note" },
    ]);
    const settings = { ...DEFAULT_SETTINGS.memory, layout: "tiered" as const };
    vi.stubEnv("ARMORY_MEMORY_ROOT", fx.paths.memoryRoot);
    const out = renderExternalMemoryBlock({ settings, cache: new RenderCache() }, fx.cwd);
    expect(out).toBeDefined();
    expect(out).toContain("- [general.001] shared external rule");
    expect(out).not.toContain("main only"); // child audience口径
    expect(out).toContain("- quota · 1 blocks");
    // files directory keeps the tiered branch
    const fx2 = fixture();
    mkdirSync(memoryDirFor(fx2.cwd, fx2.paths), { recursive: true });
    writeFileSync(join(memoryDirFor(fx2.cwd, fx2.paths), "core.md"), "# Core\n\n## R\n\n- tiered external\n");
    vi.stubEnv("ARMORY_MEMORY_ROOT", fx2.paths.memoryRoot);
    const out2 = renderExternalMemoryBlock({ settings, cache: new RenderCache() }, fx2.cwd);
    expect(out2).not.toContain("User rules (always on)");
  });
});

function todayNow(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
