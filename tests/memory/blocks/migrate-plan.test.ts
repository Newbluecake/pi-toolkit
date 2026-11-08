import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { planMigration, sourceSha, type MigrationSource } from "../../../src/memory/blocks/migrate-plan.js";
import { parseBlockFile } from "../../../src/memory/blocks/format.js";
const source = (name: string, raw: string): MigrationSource => ({
  name,
  raw,
  sha256: sourceSha(raw),
  size: Buffer.byteLength(raw),
  mtimeMs: 0,
});
const inputs = [
  source(
    "core.md",
    "---\nsource: agent\n---\n# Rules\n## Main\n### Safety\n- Always use exact paths <!-- mem user expires=2030-01-01 tags=+safety -->\n- Read docs <!-- mem lesson -->\n- docs/readme.md <!-- mem user -->\n- Follow the comprehensive persistent rule in docs/readme.md and verify the result carefully before every delivery <!-- mem user -->\n\n## Code\n```sh\nopaque\n```\n",
  ),
  source(
    "hand.md",
    "# Hand\n## Topic\n- My decision <!-- mem user -->\n- Learned lesson <!-- mem lesson -->\n\n## Code\n```\nuncovered\n```\n",
  ),
  source("code.md", "---\nsource: agent\n---\n```\n" + "x".repeat(1100) + "\n```\n"),
  source("zero.md", "# Empty headings\n```\nonly code\n```\n"),
  source(
    "plain.md",
    "---\nsource: agent\n---\n## Paragraph\nlong ordinary paragraph with no list and no inline metadata\n",
  ),
  source(
    "feedback_style.md",
    "---\ndescription: style decision\nread_when: choosing style\n---\n- Prefer concise outputs\n",
  ),
  source("feedback_more.md", "- Prefer tests\n"),
  source("project_state.md", "- Project state\n"),
  source("reference_docs.md", "- Reference docs\n"),
  source("user_pref.md", "- User choice\n"),
  source("MEMORY.md", "# Manual CC index\n- Link\n"),
  source("pin.md", "---\npin: true\n---\n- A pinned decision\n"),
  source(
    "bom.md",
    '\uFEFF---\r\nsource: agent\r\n---\r\n## BOM\r\n- protected <!-- mem user until="task complete" tags=+safety,-noise private gate=hold -->\r\n',
  ),
  source("empty.md", "# Only heading\n"),
  source(
    "structured.md",
    "---\nsource: agent\n---\n## Structures\n| a | b |\n|---|---|\n\n> quote\n\n<div>html</div>\n",
  ),
  source("topic_a.md", "---\nsource: agent\ntopic: notes\nupdated: 2026-11-05\n---\n- First topic fact\n"),
  source("topic_b.md", "---\nsource: agent\ntopic: notes\n---\n- Second topic fact\n"),
  source(
    "uniform.md",
    "- first <!-- mem user expires=2030-01-01 tags=+safety private -->\n- second <!-- mem user expires=2031-01-01 tags=+safety -->\n## Code\n```\nopaque\n```\n",
  ),
];
const parsed = (plan: ReturnType<typeof planMigration>) =>
  plan.blocks.map((b) => {
    const p = parseBlockFile(b.name, b.content);
    if ("stray" in p) throw new Error("invalid block");
    return p;
  });
it("mixed authority preserves each entry and emits agent residue with exact origin", () => {
  const p = planMigration(inputs),
    blocks = parsed(p);
  expect(p.report.files.find((f) => f.name === "core.md")).toMatchObject({
    whole: false,
    mixedAuthority: true,
    h1: ["# Rules"],
  });
  expect(blocks.find((b) => b.body.includes("Always use"))?.meta).toMatchObject({
    authority: "user",
    scope: "global",
    audience: "main",
    section: "Main",
    heading: "Main › Safety",
    expires: "2030-01-01",
    tags: { add: ["safety"], remove: [] },
  });
  expect(blocks.find((b) => b.body.includes("Read docs"))?.meta.authority).toBe("agent");
  expect(p.report.residue).toHaveLength(2);
  for (const r of p.report.residue) {
    const b = blocks.find((b) => b.id === r.id)!;
    expect(b.meta).toMatchObject({ authority: "agent", residue: true, status: "active" });
    expect(r.origin).toMatch(/\.md#L\d+-L\d+/);
    expect(b.meta.scope).toBeUndefined();
  }
  expect(p.blocks.every((b) => !b.content.includes("<!-- mem"))).toBe(true);
});
it("whole fallback, oversize, CC grouping and MEMORY retention", () => {
  const p = planMigration(inputs),
    blocks = parsed(p);
  expect(p.whole).toEqual(["code.md", "empty.md", "uniform.md", "zero.md"]);
  expect(p.report.oversize).toHaveLength(1);
  expect(p.sidecar.review?.suggestions.some((s) => s.kind === "oversize")).toBe(true);
  expect(blocks.filter((b) => b.topic === "feedback")).toHaveLength(2);
  expect(blocks.find((b) => b.topic === "feedback" && b.meta.title)?.meta).toMatchObject({
    authority: "user",
    scope: "topic",
    title: "style decision",
    when: "choosing style",
  });
  for (const t of ["project", "reference"]) expect(blocks.find((b) => b.topic === t)?.meta.authority).toBe("agent");
  expect(p.report.files.find((f) => f.name === "MEMORY.md")).toMatchObject({ retained: true, blocks: [] });
  expect(blocks.find((b) => b.body.includes("pinned"))?.meta.scope).toBe("topic");
});
it("pure pointer demotes global, suspected pointer retains it with suggestion", () => {
  const p = planMigration([
    source(
      "core.md",
      "- docs/readme.md <!-- mem user -->\n- Follow the comprehensive persistent rule in docs/readme.md and verify the result carefully before every delivery <!-- mem user -->\n",
    ),
  ]);
  const b = parsed(p);
  expect(b[0]?.meta.scope).toBe("topic");
  expect(b[1]?.meta.scope).toBe("global");
  expect(p.sidecar.review?.suggestions.map((s) => s.kind)).toContain("pointer");
});
it("whole fallback preserves common inline fields, keeps private monotone, reports differing deadlines", () => {
  const p = planMigration([
    source(
      "uniform.md",
      "- first <!-- mem user expires=2030-01-01 tags=+safety private -->\n- second <!-- mem user expires=2031-01-01 tags=+safety -->\n## Code\n```\nopaque\n```\n",
    ),
  ]);
  expect(p.whole).toEqual(["uniform.md"]);
  const b = parsed(p)[0]!;
  expect(b.meta.authority).toBe("user");
  expect(b.meta.expires).toBeUndefined();
  expect(b.meta.tags).toEqual({ add: ["safety"], remove: [] });
  expect(b.meta.private).toBe(true);
  expect(p.report.wholeInline).toHaveLength(2);
});
it("whole tags inherit only as a completely identical add/remove pair", () => {
  const p = planMigration([
    source(
      "tags.md",
      "- first <!-- mem user tags=+safety,-noise -->\n- second <!-- mem user tags=+safety,-other -->\n## Code\n```\nopaque\n```\n",
    ),
  ]);
  expect(p.whole).toEqual(["tags.md"]);
  expect(parsed(p)[0]!.meta.tags).toBeUndefined();
  expect(p.report.wholeInline.map((e) => e.meta.tagsRemove)).toEqual([["noise"], ["other"]]);
});
it("deterministic migration contract golden; capture refuses overwrites", () => {
  const text = JSON.stringify(planMigration(inputs), null, 2) + "\n",
    dir = join(import.meta.dirname, "../../fixtures/memory/migrate-golden"),
    path = join(dir, "plan.json");
  if (process.env.PI_TOOLKIT_UPDATE_BLOCKS_GOLDEN === "1") {
    if (existsSync(path)) throw new Error("migrate golden exists: NEVER overwrite");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, text, { flag: "wx" });
  }
  expect(readFileSync(path, "utf8")).toBe(text);
});

it("truncates legacy metadata on UTF-8 boundaries and reports each truncation", () => {
  for (const description of ["a".repeat(111), "中".repeat(100)]) {
    const p = planMigration([
      source(
        "feedback_long.md",
        `---\ndescription: ${description}\nread_when: ${"w".repeat(95)}\n---\n## ${"中".repeat(34)}\n- A fact\n`,
      ),
    ]);
    const b = parsed(p)[0]!;
    expect(Buffer.byteLength(b.meta.title!)).toBeLessThanOrEqual(110);
    expect(b.meta.title).toMatch(/…$/);
    expect(b.meta.title).not.toContain("�");
    expect(Buffer.byteLength(b.meta.when!)).toBeLessThanOrEqual(70);
    expect(Buffer.byteLength(b.meta.section!)).toBeLessThanOrEqual(80);
    expect(p.report.metaTruncated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ blockId: b.id, field: "title", from: description, to: b.meta.title }),
        expect.objectContaining({ blockId: b.id, field: "when" }),
        expect.objectContaining({ blockId: b.id, field: "section" }),
      ]),
    );
  }
});
