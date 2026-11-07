import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runMigration } from "../../../src/memory/blocks/migrate.js";
import { trashBlockLocked, readCorpus } from "../../../src/memory/blocks/store.js";
import { entryHash } from "../../../src/memory/jev/entries.js";
import { gcBlockIndex, readIndex, writeIndexPatch } from "../../../src/memory/jev/index-store.js";
import type { JevIndexV1, EntryTags } from "../../../src/memory/jev/contracts.js";
const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
it("same hash survives deletion of one block; last deletion prunes tags, cooldowns and suggestions", async () => {
  const p = mkdtempSync(join(tmpdir(), "blocks-sidecar-"));
  roots.push(p);
  writeFileSync(join(p, "core.md"), "- same\n- same\n");
  await runMigration(p);
  const dir = join(p, "blocks"),
    hash = entryHash("- same"),
    tags: EntryTags = {
      file: "general.001.md",
      type: "rule",
      typeP: 1,
      importance: 1,
      tags: {},
      guard: 0,
      temporal: "permanent",
      userLike: 0,
      model: "test",
      at: "2026-01-01",
      taxonomyRev: "test",
    };
  await writeIndexPatch(p, {
    upsert: { [hash]: tags },
    aInjectedAt: { [hash]: "2026-01-01" },
    pInjectedAt: { [hash]: "2026-01-01" },
  });
  expect(existsSync(join(p, "blocks/.jev/index.json"))).toBe(true);
  expect(existsSync(join(p, ".jev/index.json"))).toBe(false);
  const blocks = readCorpus(dir).blocks;
  trashBlockLocked(dir, blocks[0]!.id + ".md");
  await writeIndexPatch(p, {});
  expect(readIndex(p).index.entries[hash]).toEqual(tags);
  trashBlockLocked(dir, blocks[1]!.id + ".md");
  await writeIndexPatch(p, {});
  const index = readIndex(p).index;
  expect(index.entries).toEqual({});
  expect(index.aInjectedAt).toBeUndefined();
  expect(index.pInjectedAt).toBeUndefined();
});
it("dismiss until passed is pruned; today's deadline remains; legacy index is untouched", () => {
  const index: JevIndexV1 = {
    v: 1,
    entries: {
      abc: {
        file: "abc",
        type: "rule",
        typeP: 1,
        importance: 1,
        tags: {},
        guard: 0,
        temporal: "permanent",
        userLike: 0,
        model: "test",
        at: "",
        taxonomyRev: "test",
      },
    },
    review: {
      lastRunAt: "",
      corpusFp: "",
      suggestions: [{ id: "s", kind: "oversize", a: { hash: "gone", anchor: "gone" }, p: 1, at: "" }],
      dismissed: [
        { hashKey: "abc", anchorKey: "a", until: "2026-11-05" },
        { hashKey: "abc", anchorKey: "b", until: "2026-11-06" },
        { hashKey: "abc", anchorKey: "c" },
      ],
    },
  };
  const before = JSON.stringify(index),
    out = gcBlockIndex(index, new Set(["abc"]), "2026-11-06");
  expect(out.review?.dismissed.map((d) => d.anchorKey)).toEqual(["b", "c"]);
  expect(out.review?.suggestions).toEqual([]);
  expect(JSON.stringify(index)).toBe(before);
});
it("migration copies eligible old tags but never rewrites the old sidecar", async () => {
  const p = mkdtempSync(join(tmpdir(), "old-sidecar-"));
  roots.push(p);
  writeFileSync(join(p, "core.md"), "- copied\n");
  const hash = entryHash("- copied");
  const tags: EntryTags = {
    file: "core.md",
    type: "rule",
    typeP: 1,
    importance: 2,
    tags: {},
    guard: 0,
    temporal: "permanent",
    userLike: 0,
    model: "test",
    at: "2026-01-01",
    taxonomyRev: "test",
  };
  await writeIndexPatch(p, { upsert: { [hash]: tags } });
  const old = readFileSync(join(p, ".jev/index.json"), "utf8");
  await runMigration(p);
  expect(readIndex(p).index.entries[hash]).toEqual(tags);
  expect(readFileSync(join(p, ".jev/index.json"), "utf8")).toBe(old);
});
it("denied sidecar writes do not acquire a write lock or create directories", async () => {
  const p = mkdtempSync(join(tmpdir(), "denied-sidecar-"));
  roots.push(p);
  await expect(
    writeIndexPatch(p, {}, { capture: () => {}, check: () => ({ ok: false, reason: "locked" }) }),
  ).rejects.toThrow("locked");
  expect(existsSync(join(p, ".jev"))).toBe(false);
  expect(existsSync(join(p, ".lock"))).toBe(false);
});
