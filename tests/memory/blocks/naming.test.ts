import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "../../../src/memory/safe-fs.js";
import {
  ARCHIVE_NAME_RE,
  BLOCK_NAME_RE,
  canonicalTopic,
  dirFormat,
  effectiveLayout,
  nextSeq,
  parseArchiveName,
  parseBlockName,
  toolSurfaceFor,
} from "../../../src/memory/blocks/naming.js";
import { parseMemorySettings } from "../../../src/memory/settings.js";
const roots: string[] = [];
function root(): string {
  const p = mkdtempSync(join(tmpdir(), "blocks-names-"));
  roots.push(p);
  return p;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
describe("block naming and layout", () => {
  it("validates namespaces and never recycles sequence numbers", () => {
    expect(BLOCK_NAME_RE.test("quota.007.md")).toBe(true);
    expect(BLOCK_NAME_RE.test("quota.007.r1.md")).toBe(false);
    expect(ARCHIVE_NAME_RE.test("quota.007.r999.md")).toBe(true);
    expect(ARCHIVE_NAME_RE.test("quota.007.r1000.md")).toBe(false);
    expect(parseArchiveName("quota.007.r1.md")).toEqual({ topic: "quota", seq: 7, r: 1 });
    expect(parseBlockName("QUOTA.001.md")).toBeUndefined();
    expect(
      nextSeq("quota", [
        "quota.003.md",
        "quota.007.r1.md",
        "20261106T000000000Z-1234-ab12cd-quota.009.md",
        "other.999.md",
      ]),
    ).toBe(10);
    expect(() => nextSeq("quota", ["quota.999999.md"])).toThrow("E_SEQ_EXHAUSTED");
  });
  it("canonicalizes topics", () => {
    expect(canonicalTopic("_QUOTA__foo!!")).toBe("quota-foo");
    expect(canonicalTopic("中文!_")).toBeUndefined();
    expect(canonicalTopic("a".repeat(60))).toHaveLength(48);
  });
  it("covers all twelve effective layout cells and static surfaces", () => {
    const rows = {
      blocks: ["blocks", "tiered", "tiered", "blocks"],
      tiered: ["blocks", "tiered", "tiered", "tiered"],
      legacy: ["blocks", "legacy", "legacy", "legacy"],
    };
    for (const setting of ["blocks", "tiered", "legacy"] as const)
      for (const [i, format] of (["blocks", "files", "held", "absent"] as const).entries())
        expect(effectiveLayout(setting, format)).toBe(rows[setting][i]);
    const settings = parseMemorySettings({ layout: "blocks" });
    for (const format of ["blocks", "files", "absent"] as const) expect(toolSurfaceFor(settings, format)).toBe("v3");
    expect(toolSurfaceFor(settings, "held")).toBe("v2");
    expect(toolSurfaceFor({ ...settings, migrate: { auto: false } }, "files")).toBe("v2");
    expect(toolSurfaceFor(settings, "files", true)).toBe("v2");
    expect(toolSurfaceFor({ ...settings, layout: "tiered", toolSurface: "legacy" }, "blocks")).toBe("legacy");
  });
  it("hold wins, symlink and device errors fall back with diagnosis", () => {
    const p = root();
    expect(dirFormat(p)).toBe("absent");
    writeFileSync(join(p, "core.md"), "old");
    expect(dirFormat(p)).toBe("files");
    mkdirSync(join(p, "blocks"));
    writeFileSync(join(p, "blocks", ".layout.json"), "broken");
    expect(dirFormat(p)).toBe("blocks");
    writeFileSync(join(p, ".blocks-hold"), "broken");
    expect(dirFormat(p)).toBe("held");
    rmSync(join(p, ".blocks-hold"));
    const actual = fs.inspectDirNoFollow;
    vi.spyOn(fs, "inspectDirNoFollow").mockImplementation((path) => ({
      ...actual(path),
      dev: path.endsWith("blocks") ? -1 : actual(path).dev,
    }));
    const diag = vi.fn();
    expect(dirFormat(p, diag)).toBe("files");
    expect(diag).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
    rmSync(join(p, "blocks"), { recursive: true });
    symlinkSync(root(), join(p, "blocks"));
    expect(dirFormat(p, diag)).toBe("files");
    expect(dirFormat(join(p, "missing"))).toBe("absent");
  });
});

it("trusted root symlinks work, while read failures and non-directory roots fail closed", () => {
  const p = root(),
    target = root();
  mkdirSync(join(target, "blocks"));
  writeFileSync(join(target, "blocks", ".layout.json"), "{}");
  symlinkSync(target, join(p, "trusted"));
  expect(dirFormat(join(p, "trusted"))).toBe("blocks");
  writeFileSync(join(p, "file"), "x");
  const diag = vi.fn();
  expect(dirFormat(join(p, "file"), diag)).toBe("files");
  expect(diag).toHaveBeenCalledOnce();
  vi.spyOn(fs, "inspectDirNoFollow").mockImplementation(() => {
    throw Object.assign(new Error("not enumerable"), { code: "EACCES" });
  });
  expect(dirFormat(target, diag)).toBe("files");
  expect(diag).toHaveBeenCalledTimes(2);
});
