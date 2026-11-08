import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createBlockLocked,
  readCorpus,
  replaceBlockLocked,
  topicSummary,
  trashBlockLocked,
} from "../../../src/memory/blocks/store.js";
import { listTrashEntries } from "../../../src/memory/tidy/manifest.js";
import { restoreFromTrash } from "../../../src/memory/tidy/restore.js";
import { defaultPaths } from "../../../src/memory/paths.js";
import type { JevIndexV1 } from "../../../src/memory/jev/contracts.js";
import { entryHash } from "../../../src/memory/jev/entries.js";
const roots: string[] = [];
function setup(): { p: string; dir: string } {
  const p = mkdtempSync(join(tmpdir(), "blocks-store-"));
  roots.push(p);
  const dir = join(p, "blocks");
  mkdirSync(dir);
  writeFileSync(join(dir, ".layout.json"), '{"v":1}');
  return { p, dir };
}
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
it("create, CAS replacement, inherited heading, cleared migration residue and raw-byte revisions", () => {
  const { dir } = setup(),
    now = new Date("2026-11-06T00:00:00Z");
  const b = createBlockLocked(
    dir,
    "topic",
    { authority: "user", heading: "A › B", residue: true, origin: { file: "core.md", lines: [1, 2] } },
    "body",
    now,
  );
  expect(b.id).toBe("topic.001");
  expect(b.meta.version).toBe(1);
  expect(() => replaceBlockLocked(dir, b.id, "", { meta: b.meta, body: "next" }, now)).toThrow("E_REV_REQUIRED");
  const next = replaceBlockLocked(dir, b.id, b.rev, { meta: { ...b.meta, heading: "not allowed" }, body: "next" }, now);
  expect(next.meta.version).toBe(2);
  expect(next.meta.heading).toBe("A › B");
  expect(next.meta).not.toHaveProperty("residue");
  expect(next.meta).not.toHaveProperty("origin");
  writeFileSync(join(dir, `${b.id}.md`), next.raw.replace("next", "hand-edited"));
  expect(() => replaceBlockLocked(dir, b.id, next.rev, { meta: next.meta, body: "overwrite" }, now)).toThrow(
    /E_CONFLICT.*current rev[\s\S]*hand-edited/,
  );
  expect(readCorpus(dir).blocks[0]?.rev).not.toBe(next.rev);
  expect(() => trashBlockLocked(dir, `${b.id}.md`, next.rev)).toThrow("E_CONFLICT");
});
it("sequence includes archive revisions and trash; trash can be listed and restored unchanged", async () => {
  const { p, dir } = setup(),
    now = new Date();
  mkdirSync(join(dir, "archive"));
  writeFileSync(join(dir, "archive", "quota.007.r1.md"), "used");
  const b = createBlockLocked(dir, "quota", { authority: "agent" }, "recover me", now);
  expect(b.seq).toBe(8);
  const deleted = trashBlockLocked(dir, `${b.id}.md`, b.rev);
  const entries = listTrashEntries(dir);
  expect(entries).toEqual([
    { id: deleted.trashName.slice(0, -(`${b.id}.md`.length + 1)), name: `${b.id}.md`, fileName: deleted.trashName },
  ]);
  expect(createBlockLocked(dir, "quota", { authority: "agent" }, "next", now).seq).toBe(9);
  expect(await restoreFromTrash("blocks", entries[0]!.id, "skip", { ...defaultPaths(), memoryRoot: p })).toEqual({
    restored: true,
  });
  expect(readFileSync(join(dir, `${b.id}.md`), "utf8")).toBe(b.raw);
});
it("corpus classifies strays, counts archived blocks and fingerprints metadata", () => {
  const { p, dir } = setup();
  const b = createBlockLocked(dir, "topic", { authority: "agent" }, "body", new Date());
  mkdirSync(join(dir, "archive"));
  writeFileSync(join(dir, "archive", "topic.007.r1.md"), b.raw);
  writeFileSync(join(dir, "bad.md"), "stray");
  writeFileSync(join(dir, "topic.009.md"), "missing kind");
  writeFileSync(join(p, "core.md"), "legacy");
  const first = readCorpus(dir);
  expect(first.strays.sort()).toEqual(["bad.md", "topic.009.md"]);
  expect(first.archivedByTopic.get("topic")).toBe(1);
  expect(first.legacy.files).toHaveLength(1);
  writeFileSync(join(dir, "topic.010.md"), b.raw);
  expect(readCorpus(dir).fingerprint).not.toBe(first.fingerprint);
});
it("topic summaries use tags, then sections, then empty, only active blocks", () => {
  const { dir } = setup();
  const b = createBlockLocked(dir, "topic", { authority: "agent", section: "section" }, "body", new Date());
  const corpus = readCorpus(dir);
  expect(topicSummary(corpus, undefined, "topic")).toBe("sections: section");
  const index = {
    entries: { [entryHash(b.body)]: { tags: { release: { p: 0.8, rev: 1 }, docs: { p: 0.4, rev: 1 } } } },
  } as unknown as JevIndexV1;
  expect(topicSummary(corpus, index, "topic")).toBe("tags: release");
  expect(topicSummary(corpus, index, "missing")).toBe("");
  expect(
    topicSummary(
      { ...corpus, blocks: [{ ...b, meta: { ...b.meta, tags: { add: ["manual"], remove: ["release"] } } }] },
      index,
      "topic",
    ),
  ).toBe("tags: manual");
});
it("a closed write gate prevents all storage mutation", () => {
  const { dir } = setup();
  const gate = { check: vi.fn(() => ({ ok: false as const, reason: "locked" as const })), capture: vi.fn() };
  expect(() => createBlockLocked(dir, "topic", { authority: "agent" }, "no write", new Date(), { gate })).toThrow(
    "E_WRITE_GATE",
  );
  expect(readCorpus(dir).blocks).toEqual([]);
  expect(gate.check).toHaveBeenCalledOnce();
});

it("rejects edits rather than silently deleting historical over-limit metadata", () => {
  const { dir } = setup();
  const now = new Date();
  const b = createBlockLocked(dir, "topic", { authority: "agent" }, "original", now);
  const raw = b.raw.replace("status: active", `status: active\nwhen: ${"w".repeat(95)}`);
  writeFileSync(join(dir, `${b.id}.md`), raw);
  const read = readCorpus(dir).blocks[0]!;
  expect(read.meta.when).toMatch(/…$/);
  expect(() => replaceBlockLocked(dir, b.id, read.rev, { meta: read.meta, body: "edit" }, now)).toThrow(
    "E_META: invalid when",
  );
  expect(readFileSync(join(dir, `${b.id}.md`), "utf8")).toBe(raw);
});
