import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaCache } from "../../src/memory/tiered.js";
import { parseFrontmatter } from "../../src/memory/frontmatter.js";
import {
  META_LIMITS,
  parseBlockFile,
  serializeBlock,
  truncateMeta,
  type BlockMeta,
} from "../../src/memory/blocks/format.js";
import { softLegacyMetadata, softMetaDiagnostics } from "../../src/memory/soft-meta.js";

const base: BlockMeta = {
  kind: "block",
  authority: "agent",
  status: "active",
  created: "2026-01-01T00:00:00Z",
  updated: "2026-01-01T00:00:00Z",
  version: 1,
};
describe("legacy metadata read compatibility", () => {
  it("softens each limited field on code point boundaries, deduplicating by field and value", () => {
    const dir = "/test/soft-meta-all-fields";
    const raw = `---\n${Object.keys(META_LIMITS)
      .map((k) => `${k}: ${"中".repeat(60)}`)
      .join("\n")}\n---\nbody\n`;
    const normalized = softLegacyMetadata(raw, dir);
    const fm = parseFrontmatter(normalized)!;
    for (const [key, limit] of Object.entries(META_LIMITS)) {
      const value = JSON.parse(fm.fields.get(key)!);
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(limit);
      expect(value).toMatch(/…$/);
      expect(value).not.toContain("�");
    }
    expect(softMetaDiagnostics(dir)).toHaveLength(5);
    expect(softLegacyMetadata(raw, dir)).toBe(normalized);
    expect(softMetaDiagnostics(dir)).toHaveLength(5);
  });
  it("does not soften malformed block structure or incomplete legacy frontmatter", () => {
    const dir = "/test/soft-meta-invalid";
    const bad = `---\nwhen: ${"w".repeat(95)}\n`;
    expect(softLegacyMetadata(bad, dir)).toBe(bad);
    expect(softMetaDiagnostics(dir)).toEqual([]);
    const raw = serializeBlock(base, "body");
    const callback = () => {
      throw new Error("must not normalize stray");
    };
    expect(
      parseBlockFile("bad.md", raw.replace("status: active", `status: active\nwhen: ${"w".repeat(95)}`), {
        softLimits: true,
        onSoftLimit: callback,
      }),
    ).toHaveProperty("stray", true);
    expect(
      parseBlockFile("ok.001.md", raw.replace("kind: block\n", ""), { softLimits: true, onSoftLimit: callback }),
    ).toHaveProperty("stray", true);
    expect(
      parseBlockFile("ok.001.md", "---\nkind: block\n", { softLimits: true, onSoftLimit: callback }),
    ).toHaveProperty("stray", true);
  });
});

describe("legacy when final consumer decoding", () => {
  const cases = [
    ["backslashes path", "C:\\repo\\".repeat(12)],
    ["backslashes", "\\".repeat(95)],
    ["quotes", '"'.repeat(95)],
    ["tabs", "\t".repeat(95)],
    ["quotes exact", '"'.repeat(70)],
    ["quotes plus one", '"'.repeat(71)],
    ["tabs exact", "\t".repeat(70)],
    ["tabs plus one", "\t".repeat(71)],
    ["Chinese", "中".repeat(31) + "ab"],
    ["emoji", "😀".repeat(24)],
    ["ASCII exact", "a".repeat(70)],
    ["ASCII plus one", "a".repeat(71)],
    ["backslashes exact", "\\".repeat(70)],
    ["backslashes plus one", "\\".repeat(71)],
    ["Chinese exact", "中".repeat(23) + "a"],
    ["Chinese plus one", "中".repeat(23) + "ab"],
    ["emoji exact", "😀".repeat(17) + "ab"],
    ["emoji plus one", "😀".repeat(17) + "abc"],
  ] as const;
  it.each(cases)("normalizes %s through the production MetaCache", (_name, value) => {
    const dir = mkdtempSync(join(tmpdir(), "soft-meta-read-"));
    try {
      const raw = `---\ndescription: metadata\nwhen: ${JSON.stringify(value)}\n---\n- body\n`;
      const file = join(dir, "reflex.md");
      writeFileSync(file, raw);
      const cached = new MetaCache().read(dir, "reflex.md", Buffer.byteLength(raw), 1);
      const result = cached.meta.readWhen!;
      expect(result).toBe(truncateMeta(value, META_LIMITS.when));
      expect(Buffer.byteLength(result)).toBeLessThanOrEqual(META_LIMITS.when);
      expect(result).not.toContain("�");
      expect(readFileSync(file, "utf8")).toBe(raw);
      expect(softMetaDiagnostics(dir)).toHaveLength(Buffer.byteLength(value) > 70 ? 1 : 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("normalizes the unquoted 96B Windows-style legacy path at its final consumer", () => {
  const dir = mkdtempSync(join(tmpdir(), "soft-meta-path-"));
  try {
    const value = "C:\\repo\\".repeat(12);
    const raw = `---\nwhen: ${value}\n---\n- body\n`;
    writeFileSync(join(dir, "reflex.md"), raw);
    const actual = new MetaCache().read(dir, "reflex.md", Buffer.byteLength(raw), 1).meta.readWhen!;
    expect(Buffer.byteLength(value)).toBe(96);
    expect(actual).toBe(truncateMeta(value, 70));
    expect(Buffer.byteLength(actual)).toBeLessThanOrEqual(70);
    expect(readFileSync(join(dir, "reflex.md"), "utf8")).toBe(raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
