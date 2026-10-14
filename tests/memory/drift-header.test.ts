// Field study F1 (docs/dev/memory/field-study-claude2api.md): pre-fix
// `/mem import` wrote the `> **pi copy** …` drift banner BEFORE the
// frontmatter block, hiding it from every offset-0-anchored parser
// (parseMemoryMeta / MetaCache.read → render index + doctor D06).
// Read side: stripLeadingDriftHeader + drift-tolerant stripFrontmatter /
// isPinned / frontmatterSource / parseMemoryMeta. Write side: importProject
// splices the banner AFTER the frontmatter block.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  frontmatterSource,
  isPinned,
  parseFrontmatter,
  stripFrontmatter,
  stripLeadingDriftHeader,
} from "../../src/memory/frontmatter.js";
import { parseMemoryMeta } from "../../src/memory/meta.js";
import { DRIFT_HEADER, importProject } from "../../src/memory/store.js";
import { MetaCache, renderTiered } from "../../src/memory/tiered.js";
import { renderMemoryBlock } from "../../src/memory/render.js";
import { runDoctor, type DoctorSettings, type DoctorSnapshot } from "../../src/memory/doctor.js";
import type { TieredRenderInput } from "../../src/memory/contracts.js";
import { defaultPaths, toSlug, type MemoryPaths } from "../../src/memory/paths.js";
import { materializeEmptyFixture, writeMemAt } from "./helpers/fixture-dir.js";

const OLD_DRIFT_HEADER =
  "> **pi copy** — imported from Claude Code memory by `@getpipher/armory-memory` import. " +
  "CC original is canonical until you edit here; mirror changes to CC if you still use both.\n\n";

const FM = "---\ndescription: 配额监控与预警\nread_when: quota; 限额\ntopic: quota\npin: true\nsource: agent\n---\n\n";
const BODY = "# Quota\n\n正文内容。\n";
/** The broken on-disk layout this fix reads: banner BEFORE frontmatter. */
const BANNER_FIRST = `${DRIFT_HEADER}${FM}${BODY}`;

// ───────────────────────── stripLeadingDriftHeader ─────────────────────────

describe("stripLeadingDriftHeader — strict offset-0 matching", () => {
  it("strips both banner vintages (plus the blank line) at the very head", () => {
    expect(stripLeadingDriftHeader(BANNER_FIRST)).toBe(FM + BODY);
    expect(stripLeadingDriftHeader(OLD_DRIFT_HEADER + FM + BODY)).toBe(FM + BODY);
  });

  it("returns content without a banner unchanged (same string reference)", () => {
    const plain = `${FM}${BODY}`;
    expect(stripLeadingDriftHeader(plain)).toBe(plain);
    const noFm = "just prose\n\nmore\n";
    expect(stripLeadingDriftHeader(noFm)).toBe(noFm);
  });

  it("does not strip near-miss banners (user prose must survive)", () => {
    const cases = [
      `>> **pi copy** — nested quote, not a banner\n\n${FM}${BODY}`, // extra >
      `> **pi copied** — different word\n\n${FM}${BODY}`,
      `> pi copy — no bold markers\n\n${FM}${BODY}`,
      `intro line\n${DRIFT_HEADER}${FM}${BODY}`, // banner not at offset 0
      `> **pi copy** — banner glued to fm, no blank line\n${FM}${BODY}`, // missing separator
    ];
    for (const c of cases) expect(stripLeadingDriftHeader(c)).toBe(c);
  });
});

// ───────────────────────── read side: meta parsing ─────────────────────────

describe("parseMemoryMeta — banner-first files", () => {
  it("parses the frontmatter hidden behind the banner", () => {
    const { meta, errors } = parseMemoryMeta(BANNER_FIRST, "quota");
    expect(errors).toEqual([]);
    expect(meta.description).toBe("配额监控与预警");
    expect(meta.readWhen).toBe("quota; 限额");
    expect(meta.readWhenTerms).toEqual(["quota", "限额"]);
    expect(meta.topic).toBe("quota");
    expect(meta.pin).toBe(true);
    expect(meta.source).toBe("agent");
  });

  it("no-banner files behave byte-identically (same meta as before)", () => {
    const plain = `${FM}${BODY}`;
    expect(parseMemoryMeta(plain, "quota")).toEqual(parseMemoryMeta(stripLeadingDriftHeader(plain), "quota"));
    expect(parseMemoryMeta(plain, "quota").meta.description).toBe("配额监控与预警");
  });

  it("a near-miss banner still hides the frontmatter (conservative, no false strips)", () => {
    const nearMiss = `> **pi copied** — prose\n\n${FM}${BODY}`;
    const { meta } = parseMemoryMeta(nearMiss, "fallback");
    expect(meta.description).toBeUndefined();
    expect(meta.topic).toBe("fallback");
  });
});

describe("stripFrontmatter / isPinned / frontmatterSource — banner-first files", () => {
  it("stripFrontmatter removes banner + frontmatter, leaving only the body", () => {
    expect(stripFrontmatter(BANNER_FIRST)).toBe(BODY);
  });

  it("stripFrontmatter leaves frontmatter-less content untouched (banner included)", () => {
    const bannerOnly = `${DRIFT_HEADER}plain body\n`;
    expect(stripFrontmatter(bannerOnly)).toBe(bannerOnly);
    const plain = "plain body\n";
    expect(stripFrontmatter(plain)).toBe(plain);
  });

  it("isPinned / frontmatterSource see through the banner", () => {
    expect(isPinned(BANNER_FIRST)).toBe(true);
    expect(frontmatterSource(BANNER_FIRST)).toBe("agent");
    // no-banner behavior unchanged
    expect(isPinned(`${FM}${BODY}`)).toBe(true);
    expect(isPinned(BODY)).toBe(false);
    expect(frontmatterSource(BODY)).toBeUndefined();
  });
});

// ───────────────────────── read side: MetaCache + render ─────────────────────────

describe("MetaCache / renderers — banner-first files surface their metadata", () => {
  let envTmp: string;
  beforeEach(() => {
    envTmp = mkdtempSync(join(tmpdir(), "memfx-drift-env-"));
    vi.stubEnv("HOME", join(envTmp, "nohome"));
    vi.stubEnv("ARMORY_MEMORY_ROOT", join(envTmp, "root"));
    expect(defaultPaths().memoryRoot.startsWith(tmpdir())).toBe(true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(envTmp, { recursive: true, force: true });
  });

  it("MetaCache.read parses meta + description from a banner-first file", () => {
    const fx = materializeEmptyFixture();
    try {
      writeMemAt(fx.memDir, "quota.md", BANNER_FIRST, "2026-09-01T00:00:00.000Z");
      const st = statSync(join(fx.memDir, "quota.md"));
      const entry = new MetaCache().read(fx.memDir, "quota.md", st.size, st.mtimeMs);
      expect(entry.errors).toEqual([]);
      expect(entry.meta.description).toBe("配额监控与预警");
      expect(entry.description).toBe("配额监控与预警"); // not "(no description)"
    } finally {
      fx.cleanup();
    }
  });

  it("renderTiered injects the pinned banner-first body with no banner/fm leak", () => {
    const fx = materializeEmptyFixture();
    vi.stubEnv("ARMORY_MEMORY_ROOT", fx.paths.memoryRoot);
    try {
      writeMemAt(fx.memDir, "quota.md", BANNER_FIRST, "2026-09-01T00:00:00.000Z");
      const input: TieredRenderInput = {
        cwd: fx.cwd,
        profile: "full",
        access: "memory+read",
        coreBytes: 1600,
        blockBytes: 2400,
        indexMax: 15,
      };
      const result = renderTiered(input);
      expect(result.text).toContain("正文内容。"); // pin ⇒ primary core, body inlined
      expect(result.text).not.toContain("read_when:"); // fm must not leak into the body
      expect(result.text).not.toContain("pi copy"); // banner stripped from the body
    } finally {
      fx.cleanup();
    }
  });

  it("renderTiered indexes a banner-first topic file WITH its description", () => {
    const fx = materializeEmptyFixture();
    vi.stubEnv("ARMORY_MEMORY_ROOT", fx.paths.memoryRoot);
    try {
      const topicFm = "---\ndescription: 配额监控与预警\nread_when: quota; 限额\n---\n\n";
      writeMemAt(fx.memDir, "quota.md", `${DRIFT_HEADER}${topicFm}${BODY}`, "2026-09-01T00:00:00.000Z");
      const input: TieredRenderInput = {
        cwd: fx.cwd,
        profile: "full",
        access: "memory+read",
        coreBytes: 1600,
        blockBytes: 2400,
        indexMax: 15,
      };
      const result = renderTiered(input);
      expect(result.text).toContain("配额监控与预警");
      expect(result.text).not.toContain("(no description)");
      expect(result.text).not.toContain("read_when:");
      expect(result.text).not.toContain("pi copy");
    } finally {
      fx.cleanup();
    }
  });

  it("legacy renderMemoryBlock honors pin behind the banner and strips banner+fm from the body", () => {
    const fx = materializeEmptyFixture();
    try {
      writeMemAt(fx.memDir, "quota.md", BANNER_FIRST, "2026-09-01T00:00:00.000Z");
      const block = renderMemoryBlock(
        fx.cwd,
        { inlineMax: 3, byteCap: 4000, indexMax: 15 },
        { memoryRoot: fx.paths.memoryRoot, ccProjectsRoot: fx.paths.ccProjectsRoot },
      );
      expect(block).toBeDefined();
      expect(block).toContain(`### quota.md`);
      expect(block).toContain("正文内容。");
      expect(block).not.toContain("read_when:");
      expect(block).not.toContain("pi copy");
    } finally {
      fx.cleanup();
    }
  });
});

// ───────────────────────── read side: doctor D06 ─────────────────────────

describe("doctor D06 — banner-first file no longer reports missing metadata", () => {
  const SETTINGS: DoctorSettings = {
    coreBytes: 1600,
    blockBytes: 2400,
    topicWarnBytes: 8192,
    topicMaxBytes: 16384,
    staleDays: 60,
  };

  function snapshotOf(name: string, content: string): DoctorSnapshot {
    // Mirrors doctor-command.ts's snapshot construction exactly.
    const { meta, errors } = parseMemoryMeta(content, name.replace(/\.md$/, ""));
    return {
      cwd: "/fixture/repo",
      files: [{ name, size: content.length, meta, metaErrors: errors, content }],
      nowMs: new Date("2026-09-26T00:00:00.000Z").getTime(),
    };
  }

  it("negative: banner-first file WITH description/read_when yields no D06", () => {
    const findings = runDoctor(snapshotOf("quota.md", BANNER_FIRST), SETTINGS).filter((f) => f.id === "D06");
    expect(findings).toEqual([]);
  });

  it("positive control: the same file WITHOUT frontmatter still reports D06", () => {
    const findings = runDoctor(snapshotOf("quota.md", `${DRIFT_HEADER}${BODY}`), SETTINGS).filter(
      (f) => f.id === "D06",
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.file).toBe("quota.md");
  });
});

// ───────────────────────── write side: importProject ─────────────────────────

describe("importProject — banner placement", () => {
  let tmp: string;
  let paths: MemoryPaths;
  let srcDir: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "memfx-drift-import-"));
    paths = { memoryRoot: join(tmp, "mem"), ccProjectsRoot: join(tmp, "cc") };
    srcDir = join(paths.ccProjectsRoot, "-proj-a", "memory");
    mkdirSync(srcDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const destFile = (name: string) => join(paths.memoryRoot, "-proj-a", name);

  it("writes the banner AFTER the frontmatter block (fm stays at offset 0, parseable)", async () => {
    writeFileSync(join(srcDir, "quota.md"), `${FM}${BODY}`);
    await importProject("-proj-a", false, paths);
    const text = readFileSync(destFile("quota.md"), "utf8");
    expect(text).toBe(`${FM.replace(/\n$/, "")}\n${DRIFT_HEADER}${BODY}`);
    expect(text.startsWith("---\n")).toBe(true);
    const fm = parseFrontmatter(text);
    expect(fm?.fields.get("description")).toBe("配额监控与预警");
    // and the whole pipeline sees it
    expect(parseMemoryMeta(text, "quota").meta.description).toBe("配额监控与预警");
    // stripFrontmatter removes only the fm block; body renderers pair it with
    // stripDriftHeader to drop the banner (that pair yields BODY exactly).
    expect(stripFrontmatter(text)).toBe(DRIFT_HEADER + BODY);
  });

  it("keeps the legacy banner-first layout for frontmatter-less sources", async () => {
    writeFileSync(join(srcDir, "notes.md"), "cc body");
    await importProject("-proj-a", false, paths);
    expect(readFileSync(destFile("notes.md"), "utf8")).toBe(DRIFT_HEADER + "cc body");
  });

  it("re-import is idempotent: second run skips, bytes unchanged, no stacked banners", async () => {
    writeFileSync(join(srcDir, "quota.md"), `${FM}${BODY}`);
    await importProject("-proj-a", false, paths);
    const first = readFileSync(destFile("quota.md"), "utf8");
    const second = await importProject("-proj-a", false, paths);
    expect(second).toMatchObject({ files: 0, skipped: 1 });
    expect(readFileSync(destFile("quota.md"), "utf8")).toBe(first);
    expect(first.match(/\*\*pi copy\*\*/g)).toHaveLength(1);
  });

  it("force re-import regenerates from the CC source — byte-identical, no stacked banners", async () => {
    writeFileSync(join(srcDir, "quota.md"), `${FM}${BODY}`);
    await importProject("-proj-a", false, paths);
    const first = readFileSync(destFile("quota.md"), "utf8");
    const forced = await importProject("-proj-a", true, paths);
    expect(forced).toMatchObject({ files: 1, skipped: 0 });
    const second = readFileSync(destFile("quota.md"), "utf8");
    expect(second).toBe(first);
    expect(second.match(/\*\*pi copy\*\*/g)).toHaveLength(1);
  });
});
