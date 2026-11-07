// J1 (jev-plan §4 J1 / arch §4.3): preset taxonomy shape, merging, disable,
// the 64-tag cap, validation errors, rev stability and criteria shape.

import { describe, expect, it } from "vitest";
import {
  ENTRY_TYPES,
  IMPORTANCE_LABELS,
  PRESET_TAGS,
  mergeTaxonomy,
  tagCriteria,
  taxonomyRev,
  validateTagDef,
} from "../../../src/memory/jev/taxonomy.js";
import type { TagDef } from "../../../src/memory/jev/contracts.js";

const BASE = { id: "my-tag", label: "My tag", description: "About my scenario." };

describe("preset shape (arch §4.3.2)", () => {
  it("has exactly the 22 preset ids with unique ids and ≤240B descriptions", () => {
    expect(PRESET_TAGS).toHaveLength(22);
    const ids = PRESET_TAGS.map((t) => t.id);
    expect(new Set(ids).size).toBe(22);
    expect(ids).toEqual([
      "git-commit",
      "git-push",
      "git-history",
      "release",
      "deletion",
      "dispatch",
      "dependencies",
      "credentials",
      "frozen-files",
      "model-routing",
      "testing",
      "build",
      "ci",
      "network",
      "config",
      "shell-env",
      "background-jobs",
      "session-context",
      "docs",
      "communication",
      "workflow",
      "memory-system",
    ]);
    for (const t of PRESET_TAGS) {
      expect(Buffer.byteLength(t.description, "utf8"), `${t.id} description`).toBeLessThanOrEqual(240);
      expect(Buffer.byteLength(t.label, "utf8"), `${t.id} label`).toBeLessThanOrEqual(40);
      expect(t.source).toBe("preset");
      expect(t.rev).toBe(1);
      expect(t.risk).toMatch(/^(normal|high)$/);
    }
  });

  it("exactly nine high-risk presets; deletion matches commands only (no memory tool — ruling #3)", () => {
    expect(PRESET_TAGS.filter((t) => t.risk === "high").map((t) => t.id)).toEqual([
      "git-commit",
      "git-push",
      "git-history",
      "release",
      "deletion",
      "dispatch",
      "dependencies",
      "credentials",
      "frozen-files",
    ]);
    expect(
      PRESET_TAGS.filter((t) => t.match === undefined)
        .map((t) => t.id)
        .sort(),
    ).toEqual(["communication", "workflow"]);
    const deletion = PRESET_TAGS.find((t) => t.id === "deletion")!;
    expect(deletion.match?.tools).toBeUndefined();
    expect(deletion.match?.commands).toEqual(["rm", "git rm", "git clean", "find -delete", "trash"]);
  });

  it("types and importance are the fixed six/four", () => {
    expect(ENTRY_TYPES.map((t) => t.id)).toEqual(["rule", "pitfall", "procedure", "preference", "fact", "pointer"]);
    expect(IMPORTANCE_LABELS).toEqual(["background", "useful", "important", "critical"]);
  });
});

describe("mergeTaxonomy", () => {
  it("no file ⇒ presets only, sorted by id", () => {
    const r = mergeTaxonomy(undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.taxonomy.tags.map((t) => t.id)).toEqual([...PRESET_TAGS.map((t) => t.id)].sort());
    expect(r.taxonomy.types).toBe(ENTRY_TYPES);
    expect(r.taxonomy.importance).toBe(IMPORTANCE_LABELS);
    expect(r.taxonomy.rev).toMatch(/^[0-9a-f]{8}$/);
  });

  it("disabledPresets remove those presets (unknown ids ignored)", () => {
    const r = mergeTaxonomy({ v: 1, tags: [], disabledPresets: ["release", "nope"] });
    expect(r.ok && !r.taxonomy.tags.some((t) => t.id === "release")).toBe(true);
  });

  it("user tags are added after validation, sorted together", () => {
    const r = mergeTaxonomy({ v: 1, tags: [{ ...BASE, source: "user", rev: 1 }], disabledPresets: [] });
    expect(r.ok && r.taxonomy.tags.some((t) => t.id === "my-tag" && t.source === "user")).toBe(true);
  });

  it("rejects duplicate ids, preset collisions, invalid ids and over-cap sets", () => {
    const user = (id: string): TagDef => ({ ...BASE, id, source: "user", rev: 1 });
    expect(mergeTaxonomy({ v: 1, tags: [user("a-b"), user("a-b")], disabledPresets: [] })).toMatchObject({
      ok: false,
    });
    expect(mergeTaxonomy({ v: 1, tags: [user("release")], disabledPresets: [] })).toMatchObject({ ok: false });
    expect(mergeTaxonomy({ v: 1, tags: [user("Bad_Id")], disabledPresets: [] })).toMatchObject({ ok: false });
    const tooMany = Array.from({ length: 64 - 22 + 1 }, (_, i) => user(`t-${String(i).padStart(2, "0")}`));
    expect(mergeTaxonomy({ v: 1, tags: tooMany, disabledPresets: [] })).toMatchObject({ ok: false });
    const fits = tooMany.slice(0, 64 - 22);
    expect(mergeTaxonomy({ v: 1, tags: fits, disabledPresets: [] }).ok).toBe(true);
  });
});

describe("validateTagDef", () => {
  it("accepts a good def and normalizes risk/match", () => {
    const r = validateTagDef({ ...BASE, commands: ["git push"], risk: "high" });
    expect(r).toMatchObject({
      ok: true,
      def: { id: "my-tag", risk: "high", source: "user", rev: 1, match: { commands: ["git push"] } },
    });
  });
  it("rejects bad ids, preset collisions, empty/oversized label and description", () => {
    expect(validateTagDef({ ...BASE, id: "X" }).ok).toBe(false);
    expect(validateTagDef({ ...BASE, id: "release" }).ok).toBe(false);
    expect(validateTagDef({ ...BASE, label: "" }).ok).toBe(false);
    expect(validateTagDef({ ...BASE, label: "x".repeat(41) }).ok).toBe(false);
    expect(validateTagDef({ ...BASE, description: "" }).ok).toBe(false);
    expect(validateTagDef({ ...BASE, description: "d".repeat(241) }).ok).toBe(false);
  });
});

describe("rev stability", () => {
  const clone = (over: Partial<TagDef>): TagDef => ({ ...PRESET_TAGS[0]!, ...over });

  it("taxonomyRev changes with a description edit, not with a matcher edit", () => {
    const tags = PRESET_TAGS.map((t) => ({ ...t }));
    const base = taxonomyRev(tags);
    expect(taxonomyRev(PRESET_TAGS.map((t) => ({ ...t })))).toBe(base); // stable across order
    const matcherOnly = tags.map((t) => (t.id === "release" ? { ...t, match: { commands: ["other"] } } : { ...t }));
    expect(taxonomyRev(matcherOnly)).toBe(base);
    const descEdited = tags.map((t) =>
      t.id === "release" ? { ...t, description: `${t.description} More.` } : { ...t },
    );
    expect(taxonomyRev(descEdited)).not.toBe(base);
    const revBumped = tags.map((t) => (t.id === "release" ? { ...t, rev: 2 } : { ...t }));
    expect(taxonomyRev(revBumped)).not.toBe(base);
  });

  it("taxonomyRev changes when the enabled set changes (disable/add)", () => {
    const base = taxonomyRev(PRESET_TAGS);
    expect(taxonomyRev(PRESET_TAGS.slice(1))).not.toBe(base);
  });
});

describe("tagCriteria (§4.3.1 criteria shape)", () => {
  it("bool question with the description as criteria.true and label-scoped false (arch §4.3.1)", () => {
    const tag = PRESET_TAGS.find((t) => t.id === "git-push")!;
    const q = tagCriteria(tag);
    expect(q.type).toBe("bool");
    if (q.type !== "bool") return;
    expect(q.criteria.true).toBe(PRESET_TAGS.find((t) => t.id === "git-push")!.description);
    expect(q.criteria.false).toBe(`Not about ${tag.label}`);
    expect(q.instructions).toContain(`${tag.label}:`);
    expect(q.instructions).toContain("Is this project-memory entry about the scenario below?");
  });
});
