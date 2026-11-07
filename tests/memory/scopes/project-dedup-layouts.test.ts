import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderMemoryBlock, injectionSentinel } from "../../../src/memory/render.js";
import { renderTiered } from "../../../src/memory/tiered.js";
import { renderBlocks, residentLines } from "../../../src/memory/blocks/render.js";
import { readCorpus } from "../../../src/memory/blocks/store.js";
import { ProjectCapture, PROJECT_ENTRY_RESERVE, projectSourceText } from "../../../src/memory/scoped-project-view.js";
import { planThreeLayerDuplicates } from "../../../src/memory/scopes/render.js";
import { memoryDirFor, toSlug } from "../../../src/memory/paths.js";
import type { TieredRenderInput } from "../../../src/memory/contracts.js";
import { writeBlocksDir } from "../blocks/helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "p4a2-layout-"));
  roots.push(root);
  const cwd = join(root, "project");
  const paths = { memoryRoot: join(root, "memory"), ccProjectsRoot: join(root, "cc") };
  const dir = memoryDirFor(cwd, paths);
  mkdirSync(dir, { recursive: true });
  for (const [name, raw] of Object.entries(files)) writeFileSync(join(dir, name), raw);
  return { root, cwd, paths, dir };
}
const tierInput = (cwd: string, extra: Partial<TieredRenderInput> = {}): TieredRenderInput => ({
  cwd,
  profile: "full",
  access: "memory",
  coreBytes: 4000,
  blockBytes: 8000,
  indexMax: 20,
  ...extra,
});

describe("actual renderer admission -> manifest -> project loser (no production assembly)", () => {
  it("legacy optional absence keeps exact original bytes", () => {
    const f = fixture({ "core.md": "x" });
    const expected = `## Memory (${toSlug(f.cwd)}) — 1 file(s)\nIndex:\n- core.md (1B)\n\nPinned & recent:\n### core.md\nx\n\n${injectionSentinel(toSlug(f.cwd))}\n`;
    expect(renderMemoryBlock(f.cwd, { inlineMax: 5, byteCap: 5000, indexMax: 20 }, f.paths)).toBe(expected);
    expect(renderMemoryBlock(f.cwd, { inlineMax: 5, byteCap: 5000, indexMax: 20 }, f.paths, undefined)).toBe(expected);
  });
  it("tiered optional absence keeps exact original bytes and whole-file shape", () => {
    const f = fixture({ "core.md": "x" });
    const text = renderTiered(tierInput(f.cwd), { paths: f.paths }).text;
    expect(text).toBe(
      `## Memory (${toSlug(f.cwd)}) — 1 file(s)\n\n### core.md\nx\n\n${injectionSentinel(toSlug(f.cwd))}\n`,
    );
  });
  it("blocks optional absence keeps exact original bytes", () => {
    const f = fixture();
    writeBlocksDir(f.dir, [{ id: "general.001", authority: "user", scope: "global", body: "x" }]);
    const corpus = readCorpus(join(f.dir, "blocks"));
    const input = { slug: "project", isChild: false, residentBytes: 2000, today: "2026-11-07" };
    const text = renderBlocks(corpus, input).text;
    expect(text).toBe(
      `## Memory (project) — 1 topic(s) · 1 block(s)\n\n### User rules (always on)\n- [general.001] x\n\nTopics (relevant blocks are injected automatically; read one with memory view <topic>):\n- general · 1 blocks\n\n${injectionSentinel("project")}`,
    );
  });
  it("legacy actual full vs truncated/index paths, and scoped path never chops body", () => {
    const f = fixture({ "core.md": "- hello😀\n  continuation" });
    const capture = new ProjectCapture();
    const text = renderMemoryBlock(f.cwd, { inlineMax: 1, byteCap: 5000, indexMax: 20 }, f.paths, capture)!;
    const source = capture.finish(text);
    expect(source.entries).toHaveLength(1);
    expect(text.slice(source.entries[0]!.start, source.entries[0]!.end)).toBe("- hello😀\n  continuation");
    const index = new ProjectCapture();
    const indexText = renderMemoryBlock(f.cwd, { inlineMax: 0, byteCap: 5000, indexMax: 20 }, f.paths, index)!;
    expect(index.finish(indexText).entries).toEqual([]);
    const old = renderMemoryBlock(f.cwd, { inlineMax: 1, byteCap: 30, indexMax: 20 }, f.paths)!;
    expect(old).toContain("truncated");
    const small = new ProjectCapture();
    const scoped = renderMemoryBlock(f.cwd, { inlineMax: 1, byteCap: 30, indexMax: 20 }, f.paths, small) ?? "";
    expect(scoped).not.toContain("truncated");
    expect(small.finish(scoped).entries).toEqual([]);
  });
  it.each(["x", "中😀"])("legacy future reserve admission at exact UTF8 budget ±1 for %s", (body) => {
    const f = fixture({ "core.md": body });
    let threshold = 0;
    for (let cap = 1; cap < 1500; cap++) {
      const c = new ProjectCapture();
      const text = renderMemoryBlock(f.cwd, { inlineMax: 1, byteCap: cap, indexMax: 20 }, f.paths, c) ?? "";
      if (c.finish(text).entries.length === 1) {
        threshold = cap;
        break;
      }
    }
    expect(threshold).toBeGreaterThan(PROJECT_ENTRY_RESERVE);
    for (const delta of [-1, 0, 1]) {
      const c = new ProjectCapture();
      const cap = threshold + delta;
      const text = renderMemoryBlock(f.cwd, { inlineMax: 1, byteCap: cap, indexMax: 20 }, f.paths, c) ?? "";
      const source = c.finish(text);
      expect(source.entries).toHaveLength(delta === -1 ? 0 : 1);
      const future = planThreeLayerDuplicates([
        ...source.entries,
        { layer: "hub", id: `${"a".repeat(48)}.999999`, authority: "user", text: body, visibility: "full" },
      ]);
      const final = projectSourceText(source, future);
      expect(Buffer.byteLength(final)).toBeLessThanOrEqual(cap);
      if (delta >= 0) expect(final).toContain("dup of hub");
    }
  });
  it("tiered whole-section admission: exact spans include admitted sections only", () => {
    const visible = "- small <!-- mem user -->";
    const omitted = "- " + "z".repeat(3000);
    const f = fixture({ "core.md": `## A\n${visible}\n\n## B\n${omitted}\n\n## C\n- last` });
    const c = new ProjectCapture();
    const result = renderTiered(tierInput(f.cwd, { coreBytes: 1000, blockBytes: 2500 }), {
      paths: f.paths,
      project: c,
    });
    const source = c.finish(result.text);
    expect(result.omittedSections).toEqual(["B"]);
    expect(result.text).toContain(visible);
    expect(result.text).toContain("- last");
    expect(result.text).not.toContain(omitted);
    expect(source.entries.map((e) => e.text)).toEqual(["- small", "- last"]);
    for (const e of source.entries) expect(result.text.slice(e.start, e.end)).toBe(e.emitted);
    const plan = planThreeLayerDuplicates([
      ...source.entries,
      { layer: "session", id: "n1", authority: "user", text: "- small", visibility: "full" },
    ]);
    const final = projectSourceText(source, plan);
    expect(final).toContain("- small <!-- mem user --> (dup of session n1)");
    expect(Buffer.byteLength(final)).toBeLessThanOrEqual(2500);
  });
  it("tiered per-entry reserve sums every item, not one bound per layer or current-plan markers", () => {
    const f = fixture({ "core.md": Array.from({ length: 6 }, (_, i) => `- item ${i}`).join("\n") });
    const noCapture = renderTiered(tierInput(f.cwd, { coreBytes: 600, blockBytes: 1600 }), { paths: f.paths });
    expect(noCapture.text).toContain("- item 5");
    const c = new ProjectCapture();
    const result = renderTiered(tierInput(f.cwd, { coreBytes: 600, blockBytes: 1600 }), { paths: f.paths, project: c });
    expect(c.finish(result.text).entries).toHaveLength(0); // whole unsectioned file cannot partially fit
    expect(result.level).toBeGreaterThanOrEqual(4);
  });
  it("tiered one-byte entry fits exactly with future reserve and next byte demotes whole file", () => {
    const f = fixture({ "core.md": "x" });
    // core budget charges '### core.md\\nx' + '\\n\\n' + per-entry future reserve
    const exact = Buffer.byteLength("### core.md\nx") + 2 + PROJECT_ENTRY_RESERVE;
    for (const delta of [-1, 0, 1]) {
      const c = new ProjectCapture();
      const result = renderTiered(tierInput(f.cwd, { coreBytes: exact + delta }), { paths: f.paths, project: c });
      expect(c.finish(result.text).entries).toHaveLength(delta < 0 ? 0 : 1);
    }
  });
  it("blocks only actual residents can win: private/secret/index/audience omitted", () => {
    const f = fixture();
    writeBlocksDir(f.dir, [
      { id: "general.001", authority: "user", scope: "global", body: "same\nsecond" },
      { id: "general.002", authority: "user", scope: "global", body: "private", private: true },
      { id: "general.003", authority: "user", scope: "topic", body: "index only" },
      { id: "general.004", authority: "user", scope: "global", body: "child", audience: "child" },
      { id: "general.005", body: "agent index" },
    ]);
    const corpus = readCorpus(join(f.dir, "blocks"));
    const c = new ProjectCapture();
    const result = renderBlocks(corpus, {
      slug: "project",
      isChild: false,
      residentBytes: 1,
      today: "2026-11-07",
      project: c,
    });
    const source = c.finish(result.text);
    expect(source.entries).toHaveLength(1);
    expect(source.entries[0]!.text).toBe("same\nsecond");
    expect(source.entries[0]!.path).toBe("blocks/general.001.md");
    expect(source.entries[0]!.lineStart).toBeGreaterThan(1);
    const entry = source.entries[0]!;
    expect(
      result.resident[0]!.raw.split("\n")
        .slice(entry.lineStart - 1, entry.lineEnd)
        .join("\n"),
    ).toBe(entry.text);
    expect(source.entries[0]!.emitted).toBe(residentLines(result.resident[0]!, "2026-11-07").join("\n"));
    expect(result.overResidentBudget).toBe(true); // soft resident rule preserved, never truncate
    const plan = planThreeLayerDuplicates([
      ...source.entries,
      { layer: "session", id: "n1", authority: "user", text: "same\nsecond", visibility: "full" },
    ]);
    expect(projectSourceText(source, plan)).toContain("- [general.001] same (dup of session n1)\n  second");
    expect(result.text).not.toContain("private");
    expect(result.text).not.toContain("child");
  });
});
