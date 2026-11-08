// #36 P3 (arch §3.3.4/§3.3.3) — memorySection's layout dispatch: a blocks
// directory renders through blocks/render.ts (even under a tiered/legacy
// setting — the data format wins), a files directory under tiered stays
// byte-identical to renderTiered, and the external renderer follows the
// blocks branch with the external eligibility applied.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { writeIndexPatch } from "../../../src/memory/jev/index-store.js";
import { softLegacyMetadata, softMetaDiagnostics } from "../../../src/memory/soft-meta.js";
import { parseFrontmatter } from "../../../src/memory/frontmatter.js";
import { entryHash } from "../../../src/memory/jev/entries.js";

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

// ── #36 P4 (root ruling 2026-11-06): the blocks SIDECAR feeds the renderer's
// tag summaries, and a sidecar-only change refreshes the cached render even
// when no block file changed. ──

function makeTags(tags: Record<string, number>): import("../../../src/memory/jev/contracts.js").EntryTags {
  return {
    file: "quota.001.md",
    type: "fact",
    typeP: 0.9,
    importance: 2,
    tags: Object.fromEntries(Object.entries(tags).map(([id, p]) => [id, { p, rev: 1 }])),
    guard: 0.05,
    temporal: "permanent",
    userLike: 0.1,
    model: "opencode/jev-1.13",
    at: "2026-11-06T00:00:00.000Z",
    taxonomyRev: "r1",
  };
}

describe("blocks sidecar → renderer (P4 wiring)", () => {
  function tagBody(body: string): string {
    return body; // entryHash is over the normalized body
  }

  test("sidecar tags shape the topic summary line (tags: …), not just sections", async () => {
    const fx = fixture();
    const memDir = memoryDirFor(fx.cwd, fx.paths);
    writeBlocksDir(memDir, [
      { id: "quota.001", body: "- quota reading note one" },
      { id: "quota.002", body: "- quota reading note two" },
    ]);
    // no sidecar ⇒ section-less topics fall back to plain counts (no tags:)
    const { registration } = section({ layout: "tiered" }, { paths: fx.paths });
    const before = registration.provider({ ...INPUT, ctx: ctx(fx.cwd) }) as string;
    expect(before).toContain("- quota · 2 blocks");
    expect(before).not.toContain("tags: quota");
    // write the P2 blocks sidecar with a high-p tag for both bodies
    await writeIndexPatch(memDir, {
      upsert: {
        [entryHash(tagBody("- quota reading note one"))]: makeTags({ quota: 0.9 }),
        [entryHash(tagBody("- quota reading note two"))]: makeTags({ quota: 0.8 }),
      },
      lastTaggedAt: "2026-11-06T00:00:00.000Z",
    });
    const after = registration.provider({ ...INPUT, ctx: ctx(fx.cwd) }) as string;
    expect(after).toContain("tags: quota");
    expect(after).not.toContain("sections:");
  });

  test("a sidecar-only change refreshes the cached summary (mtime joins the cache key)", async () => {
    const fx = fixture();
    const memDir = memoryDirFor(fx.cwd, fx.paths);
    writeBlocksDir(memDir, [{ id: "quota.001", body: "- quota reading note one" }]);
    const { registration } = section({ layout: "tiered" }, { paths: fx.paths });
    const first = registration.provider({ ...INPUT, ctx: ctx(fx.cwd) }) as string;
    expect(first).toContain("- quota · 1 blocks");
    // same corpus, NEW sidecar ⇒ the line gains the tag summary
    await writeIndexPatch(memDir, {
      upsert: { [entryHash(tagBody("- quota reading note one"))]: makeTags({ quota: 0.9 }) },
      lastTaggedAt: "2026-11-06T00:00:00.000Z",
    });
    const second = registration.provider({ ...INPUT, ctx: ctx(fx.cwd) }) as string;
    expect(second).toContain("tags: quota");
  });

  test("files layouts never read a blocks sidecar (old layout unchanged)", () => {
    const fx = fixture();
    const dir = memoryDirFor(fx.cwd, fx.paths);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "core.md"), "# Core\n\n## Rules\n\n- run the gate first\n");
    // a stray blocks/.jev dir must not affect the tiered render
    const out = section({ layout: "tiered" }, { paths: fx.paths }).registration.provider({
      ...INPUT,
      ctx: ctx(fx.cwd),
    }) as string;
    expect(out).toBe(
      renderTiered({
        cwd: fx.cwd,
        profile: "full",
        access: "memory",
        coreBytes: DEFAULT_SETTINGS.memory.coreBytes,
        blockBytes: DEFAULT_SETTINGS.memory.blockBytes,
        indexMax: DEFAULT_SETTINGS.memory.indexMax,
      }).text,
    );
  });
});

test("historical overlong block metadata renders with one soft diagnostic per block", () => {
  const fx = fixture();
  const dir = memoryDirFor(fx.cwd, fx.paths);
  const real = writeBlocksDir(dir, [
    { id: "general.001", authority: "user", scope: "global", body: "- keep this rule" },
  ]);
  const file = join(real, "general.001.md");
  writeFileSync(
    file,
    blockRaw({ id: "general.001", authority: "user", scope: "global", body: "- keep this rule" }).replace(
      "status: active",
      `status: active\nsection: ${"中".repeat(34)}\nwhen: ${"w".repeat(95)}`,
    ),
  );
  writeFileSync(join(dir, "jev-reflex.md"), `---\nread_when: ${"w".repeat(95)}\n---\n- legacy\n`);
  const parsed = readCorpus(real).blocks[0]!;
  expect(parsed.errors.filter((e) => e === "E_META_SOFT")).toEqual(["E_META_SOFT"]);
  expect(Buffer.byteLength(parsed.meta.section!)).toBeLessThanOrEqual(80);
  const { registration } = section({ layout: "blocks" }, { paths: fx.paths });
  expect(registration.provider({ ...INPUT, ctx: ctx(fx.cwd) })).toContain("keep this rule");
  expect(registration.provider({ ...INPUT, ctx: ctx(fx.cwd) })).toContain("keep this rule");
});

test("legacy and blocks injection soften metadata once per directory field and value without warnings", () => {
  const fx = fixture();
  const dir = memoryDirFor(fx.cwd, fx.paths);
  mkdirSync(dir, { recursive: true });
  const when = "w".repeat(95);
  const legacy = `---\ndescription: reflex\nwhen: ${when}\nsource: agent\n---\n- legacy rule\n`;
  writeFileSync(join(dir, "jev-reflex.md"), legacy);
  const warn = vi.spyOn(console, "warn");
  const { registration } = section({ layout: "legacy" }, { paths: fx.paths });
  expect(registration.provider({ ...INPUT, ctx: ctx(fx.cwd) })).toContain("legacy rule");
  expect(registration.provider({ ...INPUT, ctx: ctx(fx.cwd) })).toContain("legacy rule");
  expect(softMetaDiagnostics(dir)).toEqual([{ code: "E_META_SOFT", field: "when", bytes: 95, limit: 70 }]);
  const normalized = softLegacyMetadata(legacy, dir);
  expect(Buffer.byteLength(parseFrontmatter(normalized)!.fields.get("when")!.replaceAll('"', ""))).toBeLessThanOrEqual(
    70,
  );
  expect(readFileSync(join(dir, "jev-reflex.md"), "utf8")).toBe(legacy);

  const longSection = "中".repeat(34);
  const real = writeBlocksDir(dir, [
    { id: "general.001", authority: "user", scope: "global", body: "- block one" },
    { id: "general.002", authority: "user", scope: "global", body: "- block two" },
  ]);
  for (const id of ["general.001", "general.002"]) {
    const file = join(real, `${id}.md`);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("status: active", `status: active\nsection: ${longSection}`),
    );
  }
  const first = readCorpus(real);
  expect(first.blocks).toHaveLength(2);
  expect(first.blocks.every((b) => Buffer.byteLength(b.meta.section!) <= 80)).toBe(true);
  expect(softMetaDiagnostics(dir)).toEqual([
    { code: "E_META_SOFT", field: "when", bytes: 95, limit: 70 },
    { code: "E_META_SOFT", field: "section", bytes: 102, limit: 80 },
  ]);
  const blocks = section({ layout: "blocks" }, { paths: fx.paths });
  expect(blocks.registration.provider({ ...INPUT, ctx: ctx(fx.cwd) })).toContain("block one");
  expect(
    section({ layout: "blocks" }, { paths: fx.paths }).registration.provider({ ...INPUT, ctx: ctx(fx.cwd) }),
  ).toContain("block two");
  expect(softMetaDiagnostics(dir)).toHaveLength(2);
  expect(warn).not.toHaveBeenCalled();
});

test("tiered files renderer reads legacy when at the block byte limit", () => {
  const fx = fixture();
  const dir = memoryDirFor(fx.cwd, fx.paths);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "jev-reflex.md"), `---\ndescription: reflex\nwhen: ${"中".repeat(31) + "ab"}\n---\n- fact\n`);
  const input = {
    cwd: fx.cwd,
    profile: "full" as const,
    access: "memory" as const,
    coreBytes: 2048,
    blockBytes: 8192,
    indexMax: 20,
  };
  const out = renderTiered(input, { paths: fx.paths }).text;
  expect(out).toContain("jev-reflex");
  expect(out).toContain("when:");
  expect(out).toContain("…");
  expect(softMetaDiagnostics(dir)).toEqual([{ code: "E_META_SOFT", field: "when", bytes: 95, limit: 70 }]);
  expect(renderTiered(input, { paths: fx.paths }).text).toBe(out);
  expect(softMetaDiagnostics(dir)).toHaveLength(1);
});
