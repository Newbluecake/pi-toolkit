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
  type DismissedPair,
  type EntryHash,
  type EntryTags,
  type IndexPatch,
  type ReviewSuggestion,
  type ReviewSuggestionKind,
  type ReviewState,
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

// ───────────────────── #36 memory-governance plan §4 P0（sanitizer 兼容） ─────────────────────

describe("#36 P0 sanitizer increments (governance arch r5 §4.4)", () => {
  test("EntryTags.globalP round-trips; a non-number globalP drops the field, the entry survives", async () => {
    const dir = fixture();
    const hash = "g1100p0hash1" as EntryHash;
    expect(
      await writeIndexPatch(dir, {
        upsert: { [hash]: sampleTags("core.md", "2026-11-06T00:00:00.000Z", { globalP: 0.8 }) },
      }),
    ).toBe("ok");
    expect(readIndex(dir).index.entries[hash]?.globalP).toBe(0.8);
    // 坏值（字符串/NaN）按字段丢弃，条目本体存活（读容错风格与其余字段一致）。
    mkdirSync(jevPath(dir), { recursive: true });
    writeFileSync(
      join(jevPath(dir), "index.json"),
      JSON.stringify({
        v: 1,
        entries: { [hash]: sampleTags("core.md", "2026-11-06T00:00:00.000Z", { globalP: "high" }) },
      }),
      "utf8",
    );
    expect(readIndex(dir).index.entries[hash]?.globalP).toBeUndefined();
    expect(readIndex(dir).index.entries[hash]?.file).toBe("core.md");
  });

  test("review suggestions accept the 8 new kinds; unknown kinds are still dropped", async () => {
    const dir = fixture();
    // mk 的 kind 参数故意留 string（非法值经内部断言写入，与生产写路径的
    // 「信任调用方」语义一致），读取侧由白名单容错。
    const mk = (kind: string, id: string): ReviewSuggestion => ({
      id,
      kind: kind as ReviewSuggestionKind,
      a: { hash: "h1", anchor: "quota.007.md|quota|body" },
      p: 0.9,
      at: "2026-11-06T00:00:00.000Z",
    });
    const review: ReviewState = {
      lastRunAt: "2026-11-06T00:00:00.000Z",
      corpusFp: "fp1",
      suggestions: [
        mk("expired-user", "s1"),
        mk("until-check", "s2"),
        mk("snapshot", "s3"),
        mk("pointer", "s4"),
        mk("oversize", "s5"),
        mk("resident-budget", "s6"),
        mk("scope-check", "s7"),
        mk("legacy-drift", "s8"),
        mk("totally-unknown", "s9"), // 未知 kind 照旧丢弃
      ],
      dismissed: [],
    };
    expect(await writeIndexPatch(dir, { review })).toBe("ok");
    const kinds = readIndex(dir).index.review?.suggestions.map((s) => s.kind) ?? [];
    expect(kinds).toEqual([
      "expired-user",
      "until-check",
      "snapshot",
      "pointer",
      "oversize",
      "resident-budget",
      "scope-check",
      "legacy-drift",
    ]);
    expect(kinds).not.toContain("totally-unknown");
  });

  test("dismissed pairs round-trip kind/until; invalid values drop the fields, the pair survives", async () => {
    const dir = fixture();
    const review: ReviewState = {
      lastRunAt: "2026-11-06T00:00:00.000Z",
      corpusFp: "fp1",
      suggestions: [],
      dismissed: [
        { hashKey: "a+b", anchorKey: "x+y", kind: "scope-check", until: "2026-12-01" },
        // 故意非法（kind 不在联合里 / until 非日期）：内部断言绕过类型写入，读取侧丢字段。
        { hashKey: "c+d", anchorKey: "z+w", kind: "not-a-kind", until: "not-a-date" } as unknown as DismissedPair,
        { hashKey: "e+f", anchorKey: "u+v" }, // 旧形状：无 kind/until
      ],
    };
    expect(await writeIndexPatch(dir, { review })).toBe("ok");
    const dismissed = readIndex(dir).index.review?.dismissed ?? [];
    expect(dismissed[0]).toEqual({ hashKey: "a+b", anchorKey: "x+y", kind: "scope-check", until: "2026-12-01" });
    // 非法 kind/until 只丢字段，dismiss 本体保留（退回旧的两两语义）。
    expect(dismissed[1]).toEqual({ hashKey: "c+d", anchorKey: "z+w" });
    expect(dismissed[2]).toEqual({ hashKey: "e+f", anchorKey: "u+v" });
  });

  test("a pre-#36 sidecar (no new fields) reads back and rewrites byte-identically", async () => {
    const dir = fixture();
    // 1) 用 #36 后的代码写入一份「旧形状」数据（无 globalP、旧 kind、无 kind/until）。
    const hashA = "aaaaaaaaaaaa" as EntryHash;
    const hashB = "bbbbbbbbbbbb" as EntryHash;
    const review: ReviewState = {
      lastRunAt: "2026-10-01T00:00:00.000Z",
      corpusFp: "fp0",
      suggestions: [
        {
          id: "dup-1",
          kind: "duplicate",
          a: { hash: hashA, anchor: "a.md|sec|body" },
          b: { hash: hashB, anchor: "b.md|sec|body" },
          p: 0.88,
          at: "2026-10-01T00:00:00.000Z",
        },
      ],
      dismissed: [{ hashKey: "x+y", anchorKey: "p+q" }],
    };
    expect(
      await writeIndexPatch(dir, {
        upsert: { [hashA]: sampleTags(), [hashB]: sampleTags("notes.md") },
        lastTaggedAt: "2026-10-02T03:04:05.000Z",
        review,
      }),
    ).toBe("ok");
    const path = join(jevPath(dir), "index.json");
    const before = readFileSync(path, "utf8");
    expect(before).not.toContain("globalP");
    expect(before).not.toContain("until");
    // 2) 读入后再写出（空 patch 只触发 read→merge→serialize）：字节不变。
    expect(await writeIndexPatch(dir, {})).toBe("ok");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("REVIEW_SUGGESTION_KINDS stays in lockstep with the contracts union (drift pin)", async () => {
    const { REVIEW_SUGGESTION_KINDS } = await import("../../../src/memory/jev/index-store.js");
    // 编译期①：白名单 ⊆ 联合（多出的成员赋不进这个类型）。注：仓库 typecheck
    // 不覆盖 tests/**，这两条类型断言不进 CI 门禁，由手工 tsc 核验（见 P0 交付报告）。
    const allow: readonly ReviewSuggestionKind[] = REVIEW_SUGGESTION_KINDS;
    // 编译期②：联合 ⊆ 本清单 —— Record 穷尽检查：contracts 联合增/删任何成员，
    // 这个对象字面量都会缺键/多键而编译失败。
    const exhaustive: Record<ReviewSuggestionKind, true> = {
      duplicate: true,
      supersedes: true,
      conflict: true,
      obsolete: true,
      "user-like": true,
      "expired-user": true,
      "until-check": true,
      snapshot: true,
      pointer: true,
      oversize: true,
      "resident-budget": true,
      "scope-check": true,
      "legacy-drift": true,
    };
    // 运行期：白名单 ≡ 穷尽清单（双向），5 旧 + 8 新 = 13，无重复。
    const expected = Object.keys(exhaustive);
    expect(REVIEW_SUGGESTION_KINDS).toHaveLength(13);
    expect(expected).toHaveLength(13);
    expect(new Set(REVIEW_SUGGESTION_KINDS).size).toBe(13);
    expect([...REVIEW_SUGGESTION_KINDS].sort()).toEqual([...expected].sort());
    void allow;
  });
});

describe("#66 in-flight review", () => {
  test("preserves concurrent suggestions and dismissal across a stale review result", async () => {
    const dir = fixture();
    const old: ReviewSuggestion = {
      id: "old",
      kind: "duplicate",
      a: { hash: "a", anchor: "a" },
      b: { hash: "b", anchor: "b" },
      p: 0.9,
      at: "2026-11-08T00:00:00.000Z",
    };
    const added: ReviewSuggestion = {
      id: "added",
      kind: "scope-check",
      a: { hash: "c", anchor: "c" },
      p: 1,
      at: old.at,
    };
    const initial: ReviewState = { lastRunAt: "", corpusFp: "", suggestions: [old], dismissed: [] };
    expect(await writeIndexPatch(dir, { review: initial })).toBe("ok");
    const staleResult: ReviewState = { ...readIndex(dir).index.review!, lastRunAt: old.at, corpusFp: "fp" };
    // Model call is in flight: governance appends, then the user dismisses old.
    const current: ReviewState = {
      ...initial,
      suggestions: [added],
      dismissed: [{ hashKey: "a+b", anchorKey: "a+b" }],
    };
    expect(await writeIndexPatch(dir, { review: current })).toBe("ok");
    expect(await writeIndexPatch(dir, { review: staleResult })).toBe("ok");
    const reloaded = readIndex(dir).index.review!;
    expect(reloaded.suggestions.map((s) => s.id)).toEqual(["added"]);
    expect(reloaded.dismissed).toEqual(current.dismissed);
  });
});

test("manual and background review snapshots merge idempotently and respect resolve tombstones", async () => {
  const dir = fixture();
  const base: ReviewState = { lastRunAt: "", corpusFp: "", suggestions: [], dismissed: [] };
  await writeIndexPatch(dir, { review: base });
  const snapshot = readIndex(dir).index.review!;
  const make = (id: string, anchor: string): ReviewSuggestion => ({
    id,
    kind: "obsolete",
    a: { hash: anchor, anchor },
    p: 0.9,
    at: "2026-11-08",
  });
  const manual = { ...snapshot, lastRunAt: "2026-11-08T01:00:00Z", corpusFp: "m", suggestions: [make("o1", "one")] };
  const background = {
    ...snapshot,
    lastRunAt: "2026-11-08T02:00:00Z",
    corpusFp: "b",
    suggestions: [make("o1", "two")],
  };
  await writeIndexPatch(dir, { review: manual });
  await writeIndexPatch(dir, { review: background });
  await writeIndexPatch(dir, { review: background });
  expect(
    readIndex(dir)
      .index.review!.suggestions.map((s) => s.a.anchor)
      .sort(),
  ).toEqual(["one", "two"]);
  const { updateIndexLocked, suggestionKey } = await import("../../../src/memory/jev/index-store.js");
  await updateIndexLocked(dir, (index) => ({
    ...index,
    review: {
      ...index.review!,
      suggestions: index.review!.suggestions.filter((s) => s.a.anchor !== "one"),
      resolved: [suggestionKey(manual.suggestions[0]!)],
    },
  }));
  await writeIndexPatch(dir, { review: manual });
  expect(readIndex(dir).index.review!.suggestions.map((s) => s.a.anchor)).toEqual(["two"]);
  expect(readIndex(dir).index.review!.resolved).toHaveLength(1);
});

test("review snapshot cannot overwrite a newer update to the same stable suggestion", async () => {
  const dir = fixture();
  const suggestion: ReviewSuggestion = {
    id: "p1",
    kind: "duplicate",
    a: { hash: "a", anchor: "entry-a" },
    b: { hash: "b", anchor: "entry-b" },
    p: 0.6,
    at: "2026-11-01",
  };
  const base: ReviewState = { lastRunAt: "", corpusFp: "", suggestions: [suggestion], dismissed: [] };
  await writeIndexPatch(dir, { review: base });
  await writeIndexPatch(dir, { review: { ...base, suggestions: [{ ...suggestion, p: 0.8, at: "2026-11-02" }] } });
  await writeIndexPatch(dir, {
    reviewBase: base,
    review: { ...base, suggestions: [{ ...suggestion, p: 0.99, at: "2026-11-03" }] },
  });
  expect(readIndex(dir).index.review!.suggestions[0]).toMatchObject({ p: 0.8, at: "2026-11-02" });
});

test("relation dismissal recognizes stable semantic duplicate and legacy block anchors after edits, ignoring until", async () => {
  const { isDismissedRelation, suggestionKey } = await import("../../../src/memory/jev/index-store.js");
  const a = { hash: "old-a", anchor: "a.001.md||old alpha" },
    b = { hash: "old-b", anchor: "b.002.md||old beta" };
  const freshA = { hash: "new-a", anchor: "a.001.md||rewritten alpha" },
    freshB = { hash: "new-b", anchor: "b.002.md||rewritten beta" };
  const semantic: ReviewSuggestion = { id: "r-old", kind: "duplicate", a, b, p: 1, at: "" };
  const legacy = {
    hashKey: [a.hash, b.hash].sort().join("+"),
    anchorKey: [a.anchor, b.anchor].sort().join("+"),
    until: "2000-01-01",
  };
  expect(
    isDismissedRelation([{ ...legacy, suggestionKey: suggestionKey(semantic) }], freshA, freshB, "duplicate"),
  ).toBe(true);
  expect(isDismissedRelation([legacy], freshA, freshB)).toBe(true);
  expect(isDismissedRelation([legacy], freshA, { hash: "other", anchor: "c.003.md||different" })).toBe(false);
  expect(
    isDismissedRelation(
      [{ hashKey: "x+y", anchorKey: "legacy|a+legacy|b" }],
      { hash: "x", anchor: "unrelated" },
      { hash: "y", anchor: "also-unrelated" },
    ),
  ).toBe(true);
});

test("source-independent identities accept legacy source-prefixed dismissal and resolved keys", async () => {
  const dir = fixture();
  const a = { hash: "ha", anchor: "a.001.md|section|body" },
    b = { hash: "hb", anchor: "b.002.md|section|body" };
  const g: ReviewSuggestion = { id: "relation-a-b", kind: "conflict", a, b, p: 0.9, at: "2026-11-01" };
  const s: ReviewSuggestion = { ...g, id: "r-123", at: "2026-11-02" };
  const { suggestionKey } = await import("../../../src/memory/jev/index-store.js");
  expect(suggestionKey(g)).toBe(suggestionKey(s));
  const oldKey = JSON.stringify(["governance", "conflict", "a.001.md", "b.002.md"]);
  const legacy: ReviewState = {
    lastRunAt: "",
    corpusFp: "",
    suggestions: [],
    dismissed: [{ hashKey: "stale", anchorKey: "stale", suggestionKey: oldKey }],
  };
  await writeIndexPatch(dir, { review: legacy });
  await writeIndexPatch(dir, { review: { ...legacy, suggestions: [s] } });
  expect(readIndex(dir).index.review!.suggestions).toEqual([]);
  const other = { ...s, b: { hash: "hc", anchor: "c.003.md|section|body" } };
  await writeIndexPatch(dir, { review: { ...legacy, suggestions: [other] } });
  expect(readIndex(dir).index.review!.suggestions).toEqual([other]);
  const dir2 = fixture();
  await writeIndexPatch(dir2, { review: { ...legacy, dismissed: [], resolved: [oldKey] } });
  await writeIndexPatch(dir2, { review: { ...legacy, dismissed: [], suggestions: [s] } });
  expect(readIndex(dir2).index.review!.suggestions).toEqual([]);
});

test("undismissed governance and semantic results for one relation both merge normally", async () => {
  const dir = fixture();
  const a = { hash: "a", anchor: "a.001.md|first|old" },
    b = { hash: "b", anchor: "b.002.md|first|old" };
  const governance: ReviewSuggestion = { id: "relation-a-b", kind: "conflict", a, b, p: 0.6, at: "2026-11-01" };
  const semantic: ReviewSuggestion = { ...governance, id: "r-new", p: 0.9, at: "2026-11-02" };
  const state: ReviewState = { lastRunAt: "", corpusFp: "", suggestions: [governance], dismissed: [] };
  await writeIndexPatch(dir, { review: state });
  expect(readIndex(dir).index.review!.suggestions).toEqual([governance]);
  await writeIndexPatch(dir, { review: { ...state, suggestions: [semantic] } });
  expect(readIndex(dir).index.review!.suggestions).toEqual([semantic]);
});

test("typed keyed dismissal keeps other kinds even with identical hashes; same kind stays suppressed", async () => {
  const { isDismissedRelation, suggestionKey } = await import("../../../src/memory/jev/index-store.js");
  const a = { hash: "ha", anchor: "a.001.md||alpha" },
    b = { hash: "hb", anchor: "b.002.md||beta" };
  const conflict: ReviewSuggestion = { id: "relation-a-b", kind: "conflict", a, b, p: 0.9, at: "2026-11-08" };
  const supersedes: ReviewSuggestion = { ...conflict, id: "r-sup", kind: "supersedes" };
  const dismissal = {
    hashKey: "ha+hb",
    anchorKey: [a.anchor, b.anchor].sort().join("+"),
    suggestionKey: suggestionKey(conflict),
  };
  expect(isDismissedRelation([dismissal], a, b)).toBe(false);
  expect(isDismissedRelation([dismissal], a, b, "conflict")).toBe(true);
  expect(isDismissedRelation([dismissal], a, b, "supersedes")).toBe(false);
  const dir = fixture();
  const state: ReviewState = { lastRunAt: "", corpusFp: "", suggestions: [], dismissed: [dismissal] };
  await writeIndexPatch(dir, { review: state });
  await writeIndexPatch(dir, { review: { ...state, suggestions: [conflict, supersedes] } });
  expect(readIndex(dir).index.review!.suggestions).toEqual([supersedes]);
});
