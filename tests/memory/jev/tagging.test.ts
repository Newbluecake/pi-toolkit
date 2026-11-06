// tagging tests (jev-plan §4 J4 第 6 条: 单条打标问题数、结果落盘过滤、172 次
// 调用计数、并发上限、partial 中断、abort、单标签补打、private/secret 剔除).

import { describe, expect, test } from "vitest";
import { tagBulk, tagOne, TAG_MAJOR_BATCH_TOKENS, taggableEntries } from "../../../src/memory/jev/tagging.js";
import { splitEntries } from "../../../src/memory/jev/entries.js";
import { mergeTaxonomy } from "../../../src/memory/jev/taxonomy.js";
import type {
  ClassifierRegistryLike,
  EntryTags,
  JevAnswer,
  JevClient,
  JevOutcome,
  JevRequest,
  JevStatus,
  MemEntry,
} from "../../../src/memory/jev/contracts.js";

// ───────────────────────────── scripted fake client ─────────────────────────────

interface AskRecord {
  readonly duty: JevRequest["duty"];
  readonly state: JevRequest["state"];
  readonly questions: Record<string, JevRequest["questions"][string]>;
}

interface FakeClientOptions {
  /** Answer factory per duty; default: bool 0.9 / first-choice 0.9 / score 1. */
  readonly answerFor?: (record: AskRecord) => Record<string, JevAnswer>;
  /** Return false-ish to fail the NEXT ask (after counting it). */
  readonly failWhen?: (record: AskRecord, callsSoFar: number) => JevOutcome | undefined;
}

function defaultAnswers(record: AskRecord): Record<string, JevAnswer> {
  const out: Record<string, JevAnswer> = {};
  for (const [id, q] of Object.entries(record.questions)) {
    if (q.type === "bool") out[id] = { type: "bool", probability: 0.9 };
    else if (q.type === "score") out[id] = { type: "score", score: 1, confidence: 0.9 };
    else {
      const first = Object.keys(q.criteria)[0]!;
      out[id] = { type: "choice", choice: first, probabilities: { [first]: 0.9 }, confidence: 0.9 };
    }
  }
  return out;
}

function fakeClient(
  opts: FakeClientOptions = {},
): JevClient & { asks: readonly AskRecord[]; maxConcurrent: () => number } {
  const asks: AskRecord[] = [];
  let inFlight = 0;
  let max = 0;
  const client: JevClient = {
    status: (): JevStatus => ({ kind: "full", model: "opencode/jev-1.13-free" }),
    ask: async (req: JevRequest): Promise<JevOutcome> => {
      asks.push({ duty: req.duty, state: req.state, questions: req.questions });
      inFlight += 1;
      max = Math.max(max, inFlight);
      try {
        const failure = opts.failWhen?.(asks[asks.length - 1]!, asks.length);
        if (failure !== undefined) return failure;
        const answers = (opts.answerFor ?? defaultAnswers)(asks[asks.length - 1]!);
        return {
          ok: true,
          model: "opencode/jev-1.13-free",
          answers,
          missing: [],
          costUsd: 0.0001,
          latencyMs: 1,
        };
      } finally {
        inFlight -= 1;
      }
    },
    probe: async (): Promise<JevStatus> => ({ kind: "full", model: "opencode/jev-1.13-free" }),
  };
  return Object.assign(client, { asks, maxConcurrent: () => max });
}

const registry = {} as ClassifierRegistryLike;

// ───────────────────────────── corpus helpers ─────────────────────────────

function corpusOf(count: number, prefix = "entry"): readonly MemEntry[] {
  const lines = ["# Core", "", "## Rules", ""];
  for (let i = 0; i < count; i++)
    lines.push(`- ${prefix} ${i}: always wrap long commands with timeout before running them`);
  return splitEntries("core.md", `${lines.join("\n")}\n`, { status: "active", handWritten: false });
}

const taxonomy = mergeTaxonomy().taxonomy;

function makeEntryTags(hash: string, over: Record<string, unknown> = {}): EntryTags {
  return {
    file: "core.md",
    type: "rule",
    typeP: 0.9,
    importance: 1,
    tags: {},
    guard: 0.1,
    temporal: "permanent",
    userLike: 0.1,
    model: "old/model",
    at: "2026-09-01T00:00:00.000Z",
    taxonomyRev: "old",
    ...over,
    ...(hash === "" ? {} : {}),
  };
}

describe("taggableEntries (§7.2 never-send)", () => {
  test("private and secret entries are excluded", () => {
    const raw = [
      "# Core",
      "",
      "## Rules",
      "",
      "- <!-- mem private --> hidden rule never sent",
      "- <!-- mem user --> user rule is fine",
      "- token=sk-1234567890abcdef1234567890abcdef looks like a secret",
      "- plain rule body",
    ].join("\n");
    const entries = splitEntries("core.md", raw, { status: "active", handWritten: false });
    const eligible = taggableEntries(entries);
    expect(eligible.some((e) => e.inline.isPrivate === true)).toBe(false);
    expect(eligible.some((e) => e.secret)).toBe(false);
    expect(eligible).toHaveLength(2);
  });
});

describe("tagOne (§6.2.2)", () => {
  test("asks 5 m_* + one t_<id> per enabled tag + up to 20 c*; state carries the redacted entry", async () => {
    const client = fakeClient();
    const entry = corpusOf(1)[0]!;
    const compare = Array.from({ length: 30 }, (_, i) => ({
      id: `c${String(i + 1)}`,
      file: "notes.md",
      excerpt: `existing ${String(i)}`,
    }));
    const out = await tagOne({ client, registry, entry, taxonomy, compare, mode: "sync" });
    expect(out.tags).toBeDefined();
    const rec = client.asks[0]!;
    const ids = Object.keys(rec.questions);
    expect(ids.filter((id) => id.startsWith("m_"))).toHaveLength(5);
    expect(ids.filter((id) => id.startsWith("t_"))).toHaveLength(taxonomy.tags.length);
    expect(ids.filter((id) => /^c\d+$/.test(id))).toHaveLength(20); // capped at 20
    expect(rec.state["entry"]).toBe(entry.body); // short body passes redaction unchanged
    expect(rec.state["file"]).toBe("core.md");
  });

  test("private/secret entry never asks — immediate off outcome", async () => {
    const client = fakeClient();
    const raw = "- <!-- mem private --> hidden rule";
    const entry = splitEntries("core.md", `# Core\n\n## Rules\n\n${raw}\n`, {
      status: "active",
      handWritten: false,
    })[0]!;
    const out = await tagOne({ client, registry, entry, taxonomy, compare: [], mode: "sync" });
    expect(client.asks).toHaveLength(0);
    expect(out.tags).toBeUndefined();
    expect(out.outcome.ok).toBe(false);
  });

  test("failed outcome carries through without tags", async () => {
    const client = fakeClient({
      failWhen: () => ({ ok: false, reason: "all-failed", detail: "System One API error (451): blocked" }),
    });
    const entry = corpusOf(1)[0]!;
    const out = await tagOne({ client, registry, entry, taxonomy, compare: [], mode: "sync" });
    expect(out.tags).toBeUndefined();
    expect(out.outcome).toMatchObject({ ok: false, reason: "all-failed" });
  });
});

describe("tagBulk (§6.2.3 / Q28)", () => {
  test("150 entries + 22 preset tags ⇒ exactly 172 asks; p ≥ 0.3 tags land; concurrency ≤ 4", async () => {
    const client = fakeClient();
    const entries = corpusOf(150);
    expect(entries).toHaveLength(150);
    expect(taxonomy.tags).toHaveLength(22);
    const collected = new Map<string, EntryTags>();
    const result = await tagBulk({
      client,
      registry,
      entries,
      taxonomy,
      onEntryTags: (hash, tags) => collected.set(hash, tags),
    });
    expect(client.asks).toHaveLength(172);
    expect(result).toMatchObject({ calls: 172, tagged: 150, pending: 0 });
    expect(client.maxConcurrent()).toBeLessThanOrEqual(4);
    expect(collected.size).toBe(150);
    // Tag-major staged probabilities ride along on the entry-major record.
    const first = collected.get(entries[0]!.hash)!;
    expect(Object.keys(first.tags).length).toBe(22);
    expect(first.tags["git-commit"]).toEqual({ p: 0.9, rev: 1 });
    // Tag part first: the first 22 asks are tag-major, one per tag.
    const tagMajor = client.asks.slice(0, 22);
    expect(tagMajor.every((a) => a.duty === "tag-major")).toBe(true);
    expect(new Set(tagMajor.map((a) => String(a.state["tag"]))).size).toBe(22);
    expect(tagMajor[0]!.questions).toHaveProperty("q150");
    // Entry part: 150 asks, 5 m_* questions each.
    const entryMajor = client.asks.slice(22);
    expect(entryMajor.every((a) => a.duty === "tag")).toBe(true);
    expect(Object.keys(entryMajor[0]!.questions).filter((id) => id.startsWith("m_"))).toHaveLength(5);
  });

  test("partial mid-run: stop issuing, remaining entries stay pending (no records)", async () => {
    let entryCalls = 0;
    const client = fakeClient({
      failWhen: (record) => {
        if (record.duty === "tag-major") return undefined;
        entryCalls += 1;
        return entryCalls > 9 ? { ok: false, reason: "all-failed", detail: "System One API error (451)" } : undefined;
      },
    });
    const entries = corpusOf(30);
    const result = await tagBulk({ client, registry, entries, taxonomy });
    // 22 tag-major (all succeed) + the entry part halts right after the 10th
    // entry-major fails — up to 4 workers may already be mid-flight, so the
    // exact count is 22 + 10..13; what is pinned: 9 tagged, 21 pending, and
    // the run stops long before all 30 entry calls.
    expect(result.calls).toBeGreaterThanOrEqual(22 + 10);
    expect(result.calls).toBeLessThanOrEqual(22 + 13);
    expect(result.tagged).toBe(9);
    expect(result.pending).toBe(21);
    expect(client.asks.length).toBe(result.calls);
  });

  test("aborted before start ⇒ zero asks, everything pending", async () => {
    const client = fakeClient();
    const controller = new AbortController();
    controller.abort();
    const entries = corpusOf(10);
    const result = await tagBulk({ client, registry, entries, taxonomy, signal: controller.signal });
    expect(client.asks).toHaveLength(0);
    expect(result).toMatchObject({ calls: 0, tagged: 0, pending: 10 });
  });

  test("session_shutdown-style abort mid-run stops new asks", async () => {
    const controller = new AbortController();
    const entries = corpusOf(30);
    let entryCalls = 0;
    const client = fakeClient({
      failWhen: (record) => {
        if (record.duty === "tag-major") return undefined;
        entryCalls += 1;
        if (entryCalls === 3) controller.abort();
        return undefined; // the client would return aborted for in-flight; we simulate via next loop
      },
    });
    const result = await tagBulk({ client, registry, entries, taxonomy, signal: controller.signal });
    // Entry part halts shortly after the abort fires; tag part completed.
    expect(result.tagged).toBeLessThan(30);
    expect(result.pending).toBe(30 - result.tagged);
  });

  test("client reports partial ⇒ run stops even though asks would keep succeeding (explicit §6.2.3 stop)", async () => {
    const client = fakeClient();
    let statusCalls = 0;
    const dynamic = client as JevClient & { status: () => JevStatus };
    dynamic.status = (): JevStatus => {
      statusCalls += 1;
      // Degrade right after the first tag-major ask completes.
      return client.asks.length >= 1
        ? { kind: "partial", reason: "451", inactive: false }
        : { kind: "full", model: "opencode/jev-1.13-free" };
    };
    const entries = corpusOf(30);
    const result = await tagBulk({ client, registry, entries, taxonomy });
    // Halt is checked before each ask: tag part stops after the first tag,
    // the entry part never starts — every entry stays pending.
    expect(client.asks).toHaveLength(1);
    expect(result).toMatchObject({ calls: 1, tagged: 0, pending: 30 });
    expect(statusCalls).toBeGreaterThan(0);
  });

  test("onlyTag ⇒ exactly ONE tag-major ask over all entries, no entry part", async () => {
    const client = fakeClient();
    const entries = corpusOf(150);
    const base: Record<string, EntryTags> = {};
    for (const e of entries) base[e.hash] = makeEntryTags(e.hash);
    const updates = new Map<string, EntryTags>();
    const result = await tagBulk({
      client,
      registry,
      entries,
      taxonomy,
      onlyTag: "testing",
      base,
      onEntryTags: (hash, tags) => updates.set(hash, tags),
    });
    expect(client.asks).toHaveLength(1);
    expect(client.asks[0]!.duty).toBe("tag-major");
    expect(String(client.asks[0]!.state["tag"])).toContain("testing:");
    expect(result).toMatchObject({ calls: 1, tagged: 150, pending: 0 });
    // p 0.9 ≥ 0.3 ⇒ the tag is added onto every existing record.
    expect(updates.size).toBe(150);
    expect([...updates.values()][0]!.tags["testing"]).toEqual({ p: 0.9, rev: 1 });
  });

  test("onlyTag with p < 0.3 ⇒ the tag is REMOVED from existing records", async () => {
    const client = fakeClient({
      answerFor: (record) =>
        Object.fromEntries(
          Object.keys(record.questions).map((id) => [id, { type: "bool", probability: 0.1 } as JevAnswer]),
        ),
    });
    const entries = corpusOf(3);
    const base: Record<string, EntryTags> = {};
    for (const e of entries) base[e.hash] = makeEntryTags(e.hash, { tags: { testing: { p: 0.8, rev: 1 } } });
    const updates = new Map<string, EntryTags>();
    await tagBulk({
      client,
      registry,
      entries,
      taxonomy,
      onlyTag: "testing",
      base,
      onEntryTags: (h, t) => updates.set(h, t),
    });
    for (const tags of updates.values()) expect(tags.tags["testing"]).toBeUndefined();
  });

  test("onlyTag with an unknown/disabled id ⇒ zero asks", async () => {
    const client = fakeClient();
    const result = await tagBulk({ client, registry, entries: corpusOf(4), taxonomy, onlyTag: "no-such-tag" });
    expect(client.asks).toHaveLength(0);
    expect(result).toMatchObject({ calls: 0, pending: 4 });
  });

  test("`all` semantics: without base, every entry re-runs the entry part even if a record exists", async () => {
    const client = fakeClient();
    const entries = corpusOf(5);
    const result = await tagBulk({ client, registry, entries, taxonomy }); // no base ⇒ all entry-major
    expect(client.asks.filter((a) => a.duty === "tag")).toHaveLength(5);
    expect(result.tagged).toBe(5);
  });

  test("with base: only pending entries run the entry part", async () => {
    const client = fakeClient();
    const entries = corpusOf(5);
    const base: Record<string, EntryTags> = {};
    for (const e of entries.slice(0, 3)) base[e.hash] = makeEntryTags(e.hash);
    const result = await tagBulk({ client, registry, entries, taxonomy, base });
    expect(client.asks.filter((a) => a.duty === "tag")).toHaveLength(2);
    expect(result).toMatchObject({ tagged: 5, pending: 0 });
  });

  test("TAG_MAJOR_BATCH_TOKENS keeps one batch per tag for the reference corpus", async () => {
    // Sanity for the root-approved exception: 150 short entries fit in ONE
    // splitBatches bucket at 20k tokens (they would split in two at 12k).
    const client = fakeClient();
    const entries = corpusOf(150);
    const result = await tagBulk({ client, registry, entries, taxonomy, onlyTag: "docs" });
    expect(client.asks).toHaveLength(1);
    expect(result.calls).toBe(1);
  });
});

// ── #36 P4 (arch r5 §4.4/§5.3): tagOne's askScope — g1 rides the same askAll ──

describe("tagOne askScope (#36)", () => {
  test("askScope=false/omitted: the question set is byte-identical to the pre-#36 call", async () => {
    const client = fakeClient();
    const entry = corpusOf(1)[0]!;
    const taxonomy = mergeTaxonomy().taxonomy;
    await tagOne({ client, registry, entry, taxonomy, compare: [], mode: "sync" });
    const before = JSON.stringify(client.asks[0]!.questions);
    const client2 = fakeClient();
    await tagOne({ client: client2, registry, entry, taxonomy, compare: [], mode: "sync", askScope: false });
    expect(JSON.stringify(client2.asks[0]!.questions)).toBe(before);
  });

  test("askScope=true: exactly one extra g1 question, and the bool answer lands in EntryTags.globalP", async () => {
    const client = fakeClient({
      answerFor: (ask) => ({ ...defaultAnswers(ask), g1: { type: "bool", probability: 0.77 } }),
    });
    const taxonomy = mergeTaxonomy().taxonomy;
    const result = await tagOne({
      client,
      registry,
      entry: corpusOf(1)[0]!,
      taxonomy,
      compare: [],
      mode: "sync",
      askScope: true,
    });
    const ids = Object.keys(client.asks[0]!.questions);
    const base = ids.filter((k) => k !== "g1");
    expect(ids.filter((k) => k === "g1")).toHaveLength(1);
    expect(base.length).toBeGreaterThan(5); // m_* + t_* still there
    expect(result.tags?.globalP).toBeCloseTo(0.77);
    // without an answer: no globalP field at all (never a default)
    const client3 = fakeClient({
      answerFor: (ask) => Object.fromEntries(Object.entries(defaultAnswers(ask)).filter(([k]) => k !== "g1")),
    });
    const bare = await tagOne({
      client: client3,
      registry,
      entry: corpusOf(1)[0]!,
      taxonomy,
      compare: [],
      mode: "sync",
      askScope: true,
    });
    expect(bare.tags).not.toHaveProperty("globalP");
  });
});
