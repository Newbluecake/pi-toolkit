import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { frontmatterSource } from "../../../src/memory/frontmatter.js";
import { splitEntries } from "../../../src/memory/jev/entries.js";
import { blockToEntry } from "../../../src/memory/blocks/adapter.js";
import { parseBlockFile, serializeBlock, type BlockMeta } from "../../../src/memory/blocks/format.js";
it("every current-5 entry preserves its hash and heading through block serialization", () => {
  const dir = new URL("../../fixtures/memory/current-5/", import.meta.url).pathname;
  let checked = 0;
  let oversizedSections = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const raw = readFileSync(join(dir, file), "utf8");
    for (const entry of splitEntries(file, raw, {
      handWritten: frontmatterSource(raw) !== "agent",
      status: "active",
    })) {
      const meta: BlockMeta = {
        kind: "block",
        authority: entry.authority,
        section: entry.section,
        ...(entry.heading === undefined ? {} : { heading: entry.heading }),
        status: "active",
        version: 1,
        created: "2026-11-06T00:00:00.000Z",
        updated: "2026-11-06T00:00:00.000Z",
      };
      const parsed = parseBlockFile("general.001.md", serializeBlock(meta, entry.body, { allowOversize: true }));
      expect(parsed).not.toHaveProperty("stray");
      if ("stray" in parsed) throw new Error("unexpected stray");
      const adapted = blockToEntry(parsed, "2026-11-06");
      expect(adapted.section).toBe(entry.section);
      if (Buffer.byteLength(entry.section) > 80) {
        expect(Buffer.byteLength(entry.section)).toBe(103);
        expect(parsed.errors).toContain("E_SECTION_TOO_LARGE");
        oversizedSections++;
      }
      expect(adapted.hash).toBe(entry.hash);
      expect(adapted.heading).toBe(entry.heading);
      expect(adapted.block).not.toHaveProperty("heading");
      if (entry.heading === undefined) expect(adapted).not.toHaveProperty("heading");
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
  expect(oversizedSections).toBe(2);
});
