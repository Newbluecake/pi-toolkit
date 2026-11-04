// index-store tests (jev-plan §4 J4 第 6 条: 坏 JSON、锁忙、合并、GC、权限、
// taxonomy 文件校验与上限; plus the `*.md`-enumeration isolation).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  gcIndex,
  mergeIndex,
  readIndex,
  readTaxonomyFile,
  removeIndex,
  writeIndexPatch,
  writeTaxonomyFile,
} from "../../../src/memory/jev/index-store.js";
import { lockBreak, lockCreate, listRegular } from "../../../src/memory/safe-fs.js";
import { PRESET_TAGS } from "../../../src/memory/jev/taxonomy.js";
import {
  A_INJECTED_AT_MAX,
  P_INJECTED_AT_MAX,
  SIDECAR_MAX_BYTES,
  SIDECAR_MAX_ENTRIES,
  type EntryHash,
  type EntryTags,
  type IndexPatch,
  type TaxonomyFileV1,
} from "../../../src/memory/jev/contracts.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "jev-idx-"));
  roots.push(dir);
  return dir;
}

function sampleTags(file = "core.md", at = "2026-10-01T00:00:00.000Z", over: Record<string, unknown> = {}): EntryTags {
  return {
    file,
    type: "rule",
    typeP: 0.9,
    importance: 2,
    tags: { docs: { p: 0.8, rev: 1 } },
    guard: 0.1,
    temporal: "permanent",
    userLike: 0.2,
    model: "opencode/jev-1.13-free",
    at,
    taxonomyRev: "abcd1234",
    ...over,
  };
}

function jevPath(dir: string): string {
  return join(dir, ".jev");
}

describe("readIndex (§4.4 read tolerance)", () => {
  test("missing file ⇒ empty index, NOT rebuilt", () => {
    const dir = fixture();
    const { index, rebuilt } = readIndex(dir);
    expect(rebuilt).toBe(false);
    expect(index).toEqual({ v: 1, entries: {} });
  });

  test("bad JSON ⇒ empty index + rebuilt", () => {
    const dir = fixture();
    mkdirSync(jevPath(dir), { recursive: true });
    writeFileSync(join(jevPath(dir), "index.json"), "{not json", "utf8");
    const { index, rebuilt } = readIndex(dir);
    expect(rebuilt).toBe(true);
    expect(index.entries).toEqual({});
  });

  test("wrong-shape JSON (v≠1 / entries not an object) ⇒ empty + rebuilt", () => {
    const dir = fixture();
    mkdirSync(jevPath(dir), { recursive: true });
    writeFileSync(join(jevPath(dir), "index.json"), JSON.stringify({ v: 2, entries: {} }), "utf8");
    expect(readIndex(dir).rebuilt).toBe(true);
    writeFileSync(join(jevPath(dir), "index.json"), JSON.stringify({ v: 1, entries: [] }), "utf8");
    expect(readIndex(dir).rebuilt).toBe(true);
  });

  test("structurally-invalid entry values are dropped individually; the rest survives", () => {
    const dir = fixture();
    const good = sampleTags();
    const bad: Record<string, unknown> = { ...sampleTags(), type: "nope" };
    mkdirSync(jevPath(dir), { recursive: true });
    writeFileSync(
      join(jevPath(dir), "index.json"),
      JSON.stringify({
        v: 1,
        entries: { aaaaaaaaaaa: good, bbbbbbbbbbb: bad },
        lastTaggedAt: "2026-10-02T03:04:05.000Z",
      }),
      "utf8",
    );
    const { index, rebuilt } = readIndex(dir);
    expect(rebuilt).toBe(false);
    expect(Object.keys(index.entries)).toEqual(["aaaaaaaaaaa"]);
    expect(index.lastTaggedAt).toBe("2026-10-02T03:04:05.000Z");
  });
});

describe("writeIndexPatch (lock + merge + atomic replace)", () => {
  test("upsert merges by hash without losing other entries; remove wins over stale copy", async () => {
    const dir = fixture();
    const h1 = "aaaaaaaaaaaa" as EntryHash;
    const h2 = "bbbbbbbbbbbb" as EntryHash;
    expect(await writeIndexPatch(dir, { upsert: { [h1]: sampleTags() } })).toBe("ok");
    expect(await writeIndexPatch(dir, { upsert: { [h2]: sampleTags("notes.md") } })).toBe("ok");
    let { index } = readIndex(dir);
    expect(Object.keys(index.entries).sort()).toEqual([h1, h2].sort());
    expect(await writeIndexPatch(dir, { remove: [h1] })).toBe("ok");
    ({ index } = readIndex(dir));
    expect(Object.keys(index.entries)).toEqual([h2]);
  });

  test("lastTaggedAt is written and preserved when a later patch omits it", async () => {
    const dir = fixture();
    await writeIndexPatch(dir, { lastTaggedAt: "2026-10-03T08:00:00.000Z" });
    await writeIndexPatch(dir, { upsert: { x: sampleTags() } as IndexPatch["upsert"] });
    const { index } = readIndex(dir);
    expect(index.lastTaggedAt).toBe("2026-10-03T08:00:00.000Z");
  });

  test("lock held by a live same-host process ⇒ busy, file untouched, no throw", async () => {
    const dir = fixture();
    await writeIndexPatch(dir, { upsert: { a: sampleTags() } as IndexPatch["upsert"] });
    const before = readFileSync(join(jevPath(dir), "index.json"), "utf8");
    expect(lockCreate(dir, { pid: process.pid, host: "test-host", at: Date.now() })).toBe(true);
    const out = await writeIndexPatch(dir, { upsert: { b: sampleTags() } as IndexPatch["upsert"] });
    expect(out).toBe("busy");
    expect(readFileSync(join(jevPath(dir), "index.json"), "utf8")).toBe(before);
    lockBreak(dir);
    expect(await writeIndexPatch(dir, { upsert: { b: sampleTags() } as IndexPatch["upsert"] })).toBe("ok");
    expect(Object.keys(readIndex(dir).index.entries).sort()).toEqual(["a", "b"]);
  });

  test("`.jev/` is 0700, index.json 0600, keys sorted for stable bytes", async () => {
    const dir = fixture();
    await writeIndexPatch(dir, {
      upsert: { zz: sampleTags(), aa: sampleTags("a.md") } as IndexPatch["upsert"],
    });
    expect(statSync(jevPath(dir)).mode & 0o777).toBe(0o700);
    expect(statSync(join(jevPath(dir), "index.json")).mode & 0o777).toBe(0o600);
    const text = readFileSync(join(jevPath(dir), "index.json"), "utf8");
    expect(text.indexOf('"aa"')).toBeLessThan(text.indexOf('"zz"'));
  });

  test("`.jev/` files never show up in the *.md enumeration", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "core.md"), "# Core\n\n- rule one\n", "utf8");
    await writeIndexPatch(dir, { upsert: { a: sampleTags() } as IndexPatch["upsert"] });
    expect(listRegular(dir, { names: "legacy" }).files.map((f) => f.name)).toEqual(["core.md"]);
    expect(listRegular(dir, { names: "v2" }).skipped).toEqual([]);
  });

  test("count cap: 2001 entries collapse to 2000, oldest-`at` evicted first", async () => {
    const dir = fixture();
    const upsert: Record<string, EntryTags> = {};
    for (let i = 0; i <= SIDECAR_MAX_ENTRIES; i++) {
      upsert[String(i).padStart(4, "0")] = sampleTags("core.md", new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString());
    }
    expect(await writeIndexPatch(dir, { upsert })).toBe("ok");
    const { index } = readIndex(dir);
    expect(Object.keys(index.entries)).toHaveLength(SIDECAR_MAX_ENTRIES);
    expect(index.entries["0000"]).toBeUndefined(); // oldest evicted
    expect(index.entries[String(SIDECAR_MAX_ENTRIES).padStart(4, "0")]).toBeDefined();
  });
});

describe("aInjectedAt (A-layer cross-session cooldown stamps)", () => {
  test("patch round-trips; later patches merge per key without losing older stamps", async () => {
    const dir = fixture();
    await writeIndexPatch(dir, { aInjectedAt: { h1: "2026-11-03T00:00:00.000Z" } });
    await writeIndexPatch(dir, { aInjectedAt: { h2: "2026-11-03T01:00:00.000Z" } });
    await writeIndexPatch(dir, { aInjectedAt: { h1: "2026-11-03T02:00:00.000Z" } });
    const { index } = readIndex(dir);
    expect(index.aInjectedAt).toEqual({ h1: "2026-11-03T02:00:00.000Z", h2: "2026-11-03T01:00:00.000Z" });
  });

  test("tagging upserts never clobber the stamps (and vice versa)", async () => {
    const dir = fixture();
    await writeIndexPatch(dir, { aInjectedAt: { h1: "2026-11-03T00:00:00.000Z" } });
    await writeIndexPatch(dir, { upsert: { h1: sampleTags() } });
    const { index } = readIndex(dir);
    expect(index.aInjectedAt).toEqual({ h1: "2026-11-03T00:00:00.000Z" });
    expect(index.entries["h1" as EntryHash]?.file).toBe("core.md");
  });

  test("bad shapes are dropped per key on read; non-object ⇒ absent", async () => {
    const dir = fixture();
    mkdirSync(jevPath(dir), { recursive: true });
    writeFileSync(
      join(jevPath(dir), "index.json"),
      JSON.stringify({
        v: 1,
        entries: {},
        aInjectedAt: { good: "2026-11-03T00:00:00.000Z", num: 42, garbage: "not a date" },
      }),
    );
    expect(readIndex(dir).index.aInjectedAt).toEqual({ good: "2026-11-03T00:00:00.000Z" });
    writeFileSync(join(jevPath(dir), "index.json"), JSON.stringify({ v: 1, entries: {}, aInjectedAt: [1, 2] }));
    expect(readIndex(dir).index.aInjectedAt).toBeUndefined();
  });

  test(`cap: stamps collapse to the newest ${A_INJECTED_AT_MAX} (oldest evicted)`, async () => {
    const dir = fixture();
    const stamps: Record<string, string> = {};
    for (let i = 0; i < A_INJECTED_AT_MAX + 10; i++) {
      stamps[`h${String(i).padStart(4, "0")}`] = new Date(
        Date.parse("2026-11-03T00:00:00.000Z") + i * 1000,
      ).toISOString();
    }
    await writeIndexPatch(dir, { aInjectedAt: stamps });
    const { index } = readIndex(dir);
    const keys = Object.keys(index.aInjectedAt ?? {});
    expect(keys).toHaveLength(A_INJECTED_AT_MAX);
    expect(keys).not.toContain("h0000");
    expect(keys).toContain(`h${String(A_INJECTED_AT_MAX + 9).padStart(4, "0")}`);
  });
});

describe("pInjectedAt (P-layer cross-session cooldown stamps, plan §2.1/§5.3)", () => {
  test("patch round-trips; later patches merge per key without losing older stamps", async () => {
    const dir = fixture();
    await writeIndexPatch(dir, { pInjectedAt: { h1: "2026-11-04T00:00:00.000Z" } });
    await writeIndexPatch(dir, { pInjectedAt: { h2: "2026-11-04T01:00:00.000Z" } });
    await writeIndexPatch(dir, { pInjectedAt: { h1: "2026-11-04T02:00:00.000Z" } });
    const { index } = readIndex(dir);
    expect(index.pInjectedAt).toEqual({ h1: "2026-11-04T02:00:00.000Z", h2: "2026-11-04T01:00:00.000Z" });
  });

  test("tagging upserts never clobber the stamps (and vice versa)", async () => {
    const dir = fixture();
    await writeIndexPatch(dir, { pInjectedAt: { h1: "2026-11-04T00:00:00.000Z" } });
    await writeIndexPatch(dir, { upsert: { h1: sampleTags() } });
    const { index } = readIndex(dir);
    expect(index.pInjectedAt).toEqual({ h1: "2026-11-04T00:00:00.000Z" });
    expect(index.entries["h1" as EntryHash]?.file).toBe("core.md");
  });

  test("bad shapes are dropped per key on read; non-object ⇒ absent", async () => {
    const dir = fixture();
    mkdirSync(jevPath(dir), { recursive: true });
    writeFileSync(
      join(jevPath(dir), "index.json"),
      JSON.stringify({
        v: 1,
        entries: {},
        pInjectedAt: { good: "2026-11-04T00:00:00.000Z", num: 42, garbage: "not a date" },
      }),
    );
    expect(readIndex(dir).index.pInjectedAt).toEqual({ good: "2026-11-04T00:00:00.000Z" });
    writeFileSync(join(jevPath(dir), "index.json"), JSON.stringify({ v: 1, entries: {}, pInjectedAt: [1, 2] }));
    expect(readIndex(dir).index.pInjectedAt).toBeUndefined();
  });

  test(`cap: stamps collapse to the newest ${P_INJECTED_AT_MAX} (oldest evicted)`, async () => {
    const dir = fixture();
    const stamps: Record<string, string> = {};
    for (let i = 0; i < P_INJECTED_AT_MAX + 10; i++) {
      stamps[`h${String(i).padStart(4, "0")}`] = new Date(
        Date.parse("2026-11-04T00:00:00.000Z") + i * 1000,
      ).toISOString();
    }
    await writeIndexPatch(dir, { pInjectedAt: stamps });
    const { index } = readIndex(dir);
    const keys = Object.keys(index.pInjectedAt ?? {});
    expect(keys).toHaveLength(P_INJECTED_AT_MAX);
    expect(keys).not.toContain("h0000");
    expect(keys).toContain(`h${String(P_INJECTED_AT_MAX + 9).padStart(4, "0")}`);
  });

  test("gc prunes p-stamps of corpus-absent hashes once a cap is exceeded", () => {
    const entries: Record<EntryHash, EntryTags> = {};
    for (let i = 0; i <= SIDECAR_MAX_ENTRIES; i++) entries[`h${i}` as EntryHash] = sampleTags();
    const live = new Set<EntryHash>([...Object.keys(entries), "live"] as EntryHash[]);
    const gc = gcIndex(
      {
        v: 1,
        entries,
        pInjectedAt: { live: "2026-11-04T00:00:00.000Z", dead: "2026-11-04T00:00:00.000Z" },
      },
      live,
    );
    expect(gc.pInjectedAt).toEqual({ live: "2026-11-04T00:00:00.000Z" });
  });
});

describe("gcIndex (§4.4 caps)", () => {
  test("gc prunes stamps of corpus-absent hashes once a cap is exceeded", () => {
    const entries: Record<EntryHash, EntryTags> = {};
    for (let i = 0; i <= SIDECAR_MAX_ENTRIES; i++) entries[`h${i}` as EntryHash] = sampleTags();
    const live = new Set<EntryHash>([...Object.keys(entries), "live"] as EntryHash[]);
    const gc = gcIndex(
      {
        v: 1,
        entries,
        aInjectedAt: { live: "2026-11-03T00:00:00.000Z", dead: "2026-11-03T00:00:00.000Z" },
      },
      live,
    );
    expect(gc.aInjectedAt).toEqual({ live: "2026-11-03T00:00:00.000Z" });
  });

  test("under the caps the index is returned unchanged (archived entries keep tags)", () => {
    const index = { v: 1 as const, entries: { a: sampleTags() } };
    expect(gcIndex(index, new Set())).toBe(index);
  });

  test("over the entry cap: corpus-absent hashes go first, then oldest-`at`", () => {
    const entries: Record<string, EntryTags> = {};
    for (let i = 0; i < SIDECAR_MAX_ENTRIES + 5; i++) {
      entries[String(i).padStart(4, "0")] = sampleTags("core.md", new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString());
    }
    // Only the last 10 hashes are live: the 1995 dead ones must go first;
    // the 10 survivors are under the cap, so oldest-`at` never kicks in.
    const live = new Set(Object.keys(entries).slice(-10));
    const out = gcIndex({ v: 1, entries }, live);
    expect(Object.keys(out.entries)).toHaveLength(10);
    for (const h of live) expect(out.entries[h]).toBeDefined();
  });

  test("over the cap with everything live: oldest-`at` eviction to the cap", () => {
    const entries: Record<string, EntryTags> = {};
    for (let i = 0; i < SIDECAR_MAX_ENTRIES + 3; i++) {
      entries[String(i).padStart(4, "0")] = sampleTags("core.md", new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString());
    }
    const live = new Set(Object.keys(entries));
    const out = gcIndex({ v: 1, entries }, live);
    expect(Object.keys(out.entries)).toHaveLength(SIDECAR_MAX_ENTRIES);
    expect(out.entries["0000"]).toBeUndefined();
  });

  test("1MB byte cap: dead hashes drop first, then oldest-`at` shrinks until the file fits", () => {
    // 3 entries × ~600KB ⇒ over SIDECAR_MAX_BYTES while far under the
    // 2000-entry count cap. `old` is corpus-absent; `mid`/`new` are live but
    // still over 1MB together ⇒ the oldest live one (`mid`) is evicted too.
    const pad = "x".repeat(600_000);
    const entries: Record<string, EntryTags> = {
      old: sampleTags("core.md", "2026-01-01T00:00:00.000Z", { model: pad }),
      mid: sampleTags("core.md", "2026-02-01T00:00:00.000Z", { model: pad }),
      new: sampleTags("core.md", "2026-03-01T00:00:00.000Z", { model: pad }),
    };
    const out = gcIndex({ v: 1, entries }, new Set(["mid", "new"]));
    expect(Object.keys(out.entries)).toEqual(["new"]); // ≤1MB with one 600KB record
  });

  test("writeIndexPatch enforces the byte cap on the persisted file (count under 2000)", async () => {
    const dir = fixture();
    const pad = "x".repeat(600_000);
    const upsert: Record<string, EntryTags> = {
      a: sampleTags("core.md", "2026-01-01T00:00:00.000Z", { model: pad }),
      b: sampleTags("core.md", "2026-02-01T00:00:00.000Z", { model: pad }),
    };
    expect(await writeIndexPatch(dir, { upsert })).toBe("ok");
    const { index } = readIndex(dir);
    expect(Object.keys(index.entries)).toEqual(["b"]); // newest kept, oldest evicted
    const bytes = readFileSync(join(jevPath(dir), "index.json"), "utf8").length;
    expect(bytes).toBeLessThanOrEqual(SIDECAR_MAX_BYTES);
  });
});

describe("mergeIndex (pure)", () => {
  test("remove beats a simultaneous upsert of the same hash", () => {
    const merged = mergeIndex(
      { v: 1, entries: { a: sampleTags() } },
      { upsert: { a: sampleTags("x.md") } as IndexPatch["upsert"], remove: ["a"] },
    );
    expect(merged.entries).toEqual({});
  });

  test("review replaces wholesale; lastTaggedAt updates", () => {
    const review = { lastRunAt: "2026-10-05T00:00:00.000Z", corpusFp: "fp", suggestions: [], dismissed: [] };
    const merged = mergeIndex({ v: 1, entries: {} }, { review, lastTaggedAt: "2026-10-06T00:00:00.000Z" });
    expect(merged.review).toEqual(review);
    expect(merged.lastTaggedAt).toBe("2026-10-06T00:00:00.000Z");
  });
});

describe("taxonomy file", () => {
  const userTag = (id: string, rev = 1): TaxonomyFileV1["tags"][number] => ({
    id,
    label: `Label ${id}`,
    description: `Description for ${id}.`,
    risk: "normal",
    source: "user",
    rev,
  });

  test("write + read round-trip; 0600 file under 0700 .jev/", async () => {
    const dir = fixture();
    const file: TaxonomyFileV1 = { v: 1, tags: [userTag("my-tag")], disabledPresets: ["docs"] };
    expect(await writeTaxonomyFile(dir, file)).toBe("ok");
    expect(readTaxonomyFile(dir)).toEqual(file);
    expect(statSync(join(jevPath(dir), "taxonomy.json")).mode & 0o777).toBe(0o600);
    expect(statSync(jevPath(dir)).mode & 0o777).toBe(0o700);
  });

  test("missing / bad JSON / wrong shape ⇒ undefined (preset fallback)", () => {
    const dir = fixture();
    expect(readTaxonomyFile(dir)).toBeUndefined();
    mkdirSync(jevPath(dir), { recursive: true });
    writeFileSync(join(jevPath(dir), "taxonomy.json"), "{oops", "utf8");
    expect(readTaxonomyFile(dir)).toBeUndefined();
    writeFileSync(
      join(jevPath(dir), "taxonomy.json"),
      JSON.stringify({ v: 1, tags: "nope", disabledPresets: [] }),
      "utf8",
    );
    expect(readTaxonomyFile(dir)).toBeUndefined();
  });

  test("writing a file that would exceed the 64-enabled cap is refused, current file untouched", async () => {
    const dir = fixture();
    const small: TaxonomyFileV1 = { v: 1, tags: [userTag("keep-me")], disabledPresets: [] };
    expect(await writeTaxonomyFile(dir, small)).toBe("ok");
    const tooMany: TaxonomyFileV1 = {
      v: 1,
      tags: Array.from({ length: 64 - PRESET_TAGS.length + 2 }, (_, i) => userTag(`t${String(i)}`)),
      disabledPresets: [],
    };
    await expect(writeTaxonomyFile(dir, tooMany)).rejects.toThrow(/invalid taxonomy/);
    expect(readTaxonomyFile(dir)).toEqual(small);
  });

  test("lock busy ⇒ busy", async () => {
    const dir = fixture();
    expect(lockCreate(dir, { pid: process.pid, host: "test-host", at: Date.now() })).toBe(true);
    try {
      expect(await writeTaxonomyFile(dir, { v: 1, tags: [], disabledPresets: [] })).toBe("busy");
      expect(existsSync(join(jevPath(dir), "taxonomy.json"))).toBe(false);
    } finally {
      lockBreak(dir);
    }
  });
});

describe("removeIndex", () => {
  test("clears index.json, keeps taxonomy.json; missing file is a no-op", async () => {
    const dir = fixture();
    await writeIndexPatch(dir, { upsert: { a: sampleTags() } as IndexPatch["upsert"] });
    await writeTaxonomyFile(dir, { v: 1, tags: [], disabledPresets: [] });
    expect(await removeIndex(dir)).toBe("ok");
    expect(existsSync(join(jevPath(dir), "index.json"))).toBe(false);
    expect(existsSync(join(jevPath(dir), "taxonomy.json"))).toBe(true);
    expect(readIndex(dir)).toEqual({ index: { v: 1, entries: {} }, rebuilt: false });
    expect(await removeIndex(dir)).toBe("ok");
  });
});
