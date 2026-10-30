// jev/decide.test.ts — effectiveMeta, recall/error/tagging/review/gate
// decisions, verdict cache (jev-plan J2).

import { describe, expect, it } from "vitest";
import {
  createVerdictCache,
  decideErrorRecall,
  decideGate,
  decideRecall,
  decideReview,
  decideTagging,
  decideUserLikeSuggestion,
  effectiveMeta,
  evidenceTier,
  strictest,
  verdictKey,
} from "../../../src/memory/jev/decide.js";
import { mergeTaxonomy } from "../../../src/memory/jev/taxonomy.js";
import type { EntryTags, GateCandidate, JevAnswer, JevConfig, MemEntry } from "../../../src/memory/jev/contracts.js";

function taxonomy() {
  const r = mergeTaxonomy();
  if (!r.ok) throw new Error("bad");
  return r.taxonomy;
}

function entry(overrides: Partial<MemEntry> = {}): MemEntry {
  return {
    file: "a.md",
    section: "",
    ordinal: 1,
    lineStart: 1,
    lineEnd: 1,
    raw: "x",
    body: "x",
    hash: "h1",
    guardHash: "g1",
    inline: { present: false },
    inlineErrors: [],
    authority: "agent",
    fileStatus: "active",
    secret: false,
    namedPrograms: [],
    ...overrides,
  };
}

function entryTags(overrides: Partial<EntryTags> = {}): EntryTags {
  return {
    file: "a.md",
    type: "rule",
    typeP: 0.9,
    importance: 2,
    tags: { "git-push": { p: 0.8, rev: 1 } },
    guard: 0.9,
    temporal: "permanent",
    userLike: 0.1,
    model: "m",
    at: "2026-10-30",
    taxonomyRev: "r1",
    ...overrides,
  };
}

const CFG: JevConfig = {
  classifiers: ["opencode/jev-1.13-free"],
  proxy: "",
  childSessions: true,
  recall: { threshold: 0.6, maxEntries: 3, maxBytes: 4096, waitMs: 1500 },
  gate: { enabled: true, threshold: 0.6 },
  reviewIntervalDays: 7,
  maxCostUsd: 0.5,
  maxCalls: 800,
  confirmTimeoutMs: 60_000,
};

describe("effectiveMeta (§4.4)", () => {
  it("pending entry (no sidecar) has undefined importance/type, only inline tags", () => {
    const e = entry({ inline: { present: true, tagsAdd: ["release"] } });
    const meta = effectiveMeta(e, undefined, taxonomy());
    expect(meta.pending).toBe(true);
    expect(meta.importance).toBeUndefined();
    expect(meta.type).toBeUndefined();
    expect(meta.tags).toEqual(["release"]);
  });

  it("tagged entry: tags = sidecar p>=0.6 plus inline + minus inline -", () => {
    const e = entry({ inline: { present: true, tagsAdd: ["extra"], tagsRemove: ["git-push"] } });
    const tags = entryTags({ tags: { "git-push": { p: 0.8, rev: 1 }, low: { p: 0.4, rev: 1 } } });
    const meta = effectiveMeta(e, tags, taxonomy());
    expect(meta.tags).toEqual(["extra"]); // git-push removed inline, low below 0.6, extra added
    expect(meta.pending).toBe(false);
    expect(meta.importance).toBe(2);
  });

  it("guarded: inline gate always wins", () => {
    expect(effectiveMeta(entry({ inline: { present: true, gate: "gate" } }), undefined, taxonomy()).guarded).toBe(true);
    expect(effectiveMeta(entry({ inline: { present: true, gate: "nogate" } }), entryTags(), taxonomy()).guarded).toBe(
      false,
    );
  });

  it("guarded by derivation: guard>=0.7 and type in {rule,procedure}, no nogate", () => {
    expect(effectiveMeta(entry(), entryTags({ guard: 0.9, type: "rule" }), taxonomy()).guarded).toBe(true);
    expect(effectiveMeta(entry(), entryTags({ guard: 0.9, type: "fact" }), taxonomy()).guarded).toBe(false);
    expect(effectiveMeta(entry(), entryTags({ guard: 0.5, type: "rule" }), taxonomy()).guarded).toBe(false);
  });

  it("hold only ever comes from inline gate=hold", () => {
    expect(effectiveMeta(entry({ inline: { present: true, gate: "hold" } }), undefined, taxonomy()).hold).toBe(true);
    expect(effectiveMeta(entry(), entryTags({ guard: 0.99 }), taxonomy()).hold).toBe(false);
  });
});

describe("decideRecall (§6.1.1)", () => {
  const cands = [
    { id: "e1", file: "b.md", excerpt: "x".repeat(10), authority: "agent" as const, importance: 1 as const },
    { id: "e2", file: "a.md", excerpt: "y".repeat(10), authority: "user" as const, importance: 1 as const },
    { id: "e3", file: "c.md", excerpt: "z".repeat(10), authority: "agent" as const, importance: 3 as const },
    { id: "e4", file: "d.md", excerpt: "w".repeat(10), authority: "agent" as const },
  ];
  const answers: Record<string, JevAnswer> = {
    e1: { type: "bool", probability: 0.7 },
    e2: { type: "bool", probability: 0.7 },
    e3: { type: "bool", probability: 0.9 },
    e4: { type: "bool", probability: 0.1 }, // below threshold
  };

  it("filters by threshold, sorts by p desc then user-first then importance then file", () => {
    const decided = decideRecall(answers, cands, CFG);
    expect(decided.map((d) => d.id)).toEqual(["e3", "e2", "e1"]);
  });

  it("caps at maxEntries and cumulative maxBytes", () => {
    const tight = { ...CFG, recall: { ...CFG.recall, maxEntries: 10, maxBytes: 15 } };
    const decided = decideRecall(answers, cands, tight);
    expect(decided.length).toBe(1); // first entry (10 bytes) fits; a second would exceed 15
  });

  it("unanswered candidates are excluded, not treated as 0", () => {
    const decided = decideRecall({}, cands, CFG);
    expect(decided).toEqual([]);
  });

  it("threshold boundary (主会话裁定①, threshold=0.6): p=0.59 excluded, p=0.60 included", () => {
    const boundaryCands = [
      { id: "b1", file: "a.md", excerpt: "x", authority: "agent" as const },
      { id: "b2", file: "b.md", excerpt: "x", authority: "agent" as const },
    ];
    const boundaryAnswers: Record<string, JevAnswer> = {
      b1: { type: "bool", probability: 0.59 },
      b2: { type: "bool", probability: 0.6 },
    };
    const decided = decideRecall(boundaryAnswers, boundaryCands, CFG);
    expect(decided.map((d) => d.id)).toEqual(["b2"]);
  });
});

describe("decideErrorRecall (§6.1.4)", () => {
  it("fixed threshold 0.7, top 2 by p desc", () => {
    const cands = [
      { id: "x1", file: "a.md", excerpt: "a" },
      { id: "x2", file: "b.md", excerpt: "b" },
      { id: "x3", file: "c.md", excerpt: "c" },
    ];
    const answers: Record<string, JevAnswer> = {
      x1: { type: "bool", probability: 0.71 },
      x2: { type: "bool", probability: 0.95 },
      x3: { type: "bool", probability: 0.5 },
    };
    expect(decideErrorRecall(answers, cands).map((d) => d.id)).toEqual(["x2", "x1"]);
  });

  it("threshold boundary (plan test checklist: 0.69/0.70): p=0.69 excluded, p=0.70 included", () => {
    const cands = [
      { id: "x1", file: "a.md", excerpt: "a" },
      { id: "x2", file: "b.md", excerpt: "b" },
    ];
    const answers: Record<string, JevAnswer> = {
      x1: { type: "bool", probability: 0.69 },
      x2: { type: "bool", probability: 0.7 },
    };
    expect(decideErrorRecall(answers, cands).map((d) => d.id)).toEqual(["x2"]);
  });
});

describe("decideTagging (§6.2.2)", () => {
  it("builds EntryTags from m_*/t_* answers, keeping only p>=0.3 tags", () => {
    const tax = taxonomy();
    const tagId = tax.tags[0]!.id;
    const answers: Record<string, JevAnswer> = {
      m_type: { type: "choice", choice: "rule", probabilities: { rule: 0.9 }, confidence: 0.9 },
      m_importance: { type: "score", score: 2.6, confidence: 0.8 },
      m_guard: { type: "bool", probability: 0.8 },
      m_temporal: { type: "choice", choice: "dated", probabilities: { dated: 0.6 }, confidence: 0.6 },
      m_userlike: { type: "bool", probability: 0.2 },
      [`t_${tagId}`]: { type: "bool", probability: 0.4 },
    };
    const tags = decideTagging(answers, tax, "opencode/jev-1.13", "2026-10-30", "a.md");
    expect(tags.type).toBe("rule");
    expect(tags.importance).toBe(3); // round(2.6)
    expect(tags.guard).toBe(0.8);
    expect(tags.temporal).toBe("dated");
    expect(tags.tags[tagId]).toEqual({ p: 0.4, rev: tax.tags[0]!.rev });
    expect(tags.file).toBe("a.md");
  });

  it("drops tags below p=0.3 and falls back to safe defaults on malformed answers", () => {
    const tax = taxonomy();
    const tags = decideTagging({}, tax, "m", "2026-10-30", "a.md");
    expect(tags.type).toBe("fact");
    expect(tags.importance).toBe(0);
    expect(Object.keys(tags.tags)).toEqual([]);
  });
});

describe("decideUserLikeSuggestion (§6.3.4 疑似用户令)", () => {
  it("only fires for agent-attributed entries with userLike>=0.8", () => {
    expect(decideUserLikeSuggestion("h1", "a.md #1", "agent", 0.85, "2026-10-30")).toEqual({
      id: "ul-h1",
      kind: "user-like",
      a: { hash: "h1", anchor: "a.md #1" },
      p: 0.85,
      at: "2026-10-30",
    });
    expect(decideUserLikeSuggestion("h1", "a.md #1", "user", 0.9, "2026-10-30")).toBeUndefined();
    expect(decideUserLikeSuggestion("h1", "a.md #1", "agent", 0.5, "2026-10-30")).toBeUndefined();
  });
});

describe("decideReview (§6.3.4)", () => {
  it("duplicate/supersedes/conflict at p>=0.75 become suggestions; swaps a/b on b_supersedes_a", () => {
    const pairs = [
      { id: "p1", a: { hash: "ha", anchor: "A" }, b: { hash: "hb", anchor: "B" } },
      { id: "p2", a: { hash: "hc", anchor: "C" }, b: { hash: "hd", anchor: "D" } },
      { id: "p3", a: { hash: "he", anchor: "E" }, b: { hash: "hf", anchor: "F" } },
    ];
    const answers: Record<string, JevAnswer> = {
      p1: { type: "choice", choice: "duplicate", probabilities: { duplicate: 0.8 }, confidence: 0.8 },
      p2: { type: "choice", choice: "b_supersedes_a", probabilities: { b_supersedes_a: 0.9 }, confidence: 0.9 },
      p3: { type: "choice", choice: "unrelated", probabilities: { unrelated: 0.95 }, confidence: 0.95 },
    };
    const out = decideReview(answers, pairs, [], "2026-10-30");
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ id: "p1", kind: "duplicate" });
    expect(out[1]).toMatchObject({
      id: "p2",
      kind: "supersedes",
      a: { hash: "hd", anchor: "D" },
      b: { hash: "hc", anchor: "C" },
    });
  });

  it("below-threshold relation -> no suggestion; obsolete at p>=0.8", () => {
    const answers: Record<string, JevAnswer> = {
      p1: { type: "choice", choice: "duplicate", probabilities: { duplicate: 0.5 }, confidence: 0.5 },
      o1: { type: "bool", probability: 0.85 },
      o2: { type: "bool", probability: 0.5 },
    };
    const out = decideReview(
      answers,
      [{ id: "p1", a: { hash: "ha", anchor: "A" }, b: { hash: "hb", anchor: "B" } }],
      [
        { id: "o1", hash: "ho1", anchor: "O1" },
        { id: "o2", hash: "ho2", anchor: "O2" },
      ],
      "2026-10-30",
    );
    expect(out).toEqual([{ id: "o1", kind: "obsolete", a: { hash: "ho1", anchor: "O1" }, p: 0.85, at: "2026-10-30" }]);
  });
});

describe("decideGate (§6.4.4 table)", () => {
  const base = { entryHash: "h1", anchor: "a.md #1", authority: "user" as const, threshold: 0.6 };

  it("a+v below threshold -> pass", () => {
    expect(decideGate({ ...base, a: 0.2, v: 0.1, hold: false, latched: false }).action).toBe("pass");
  });

  it("hold entry with v>=threshold -> hold", () => {
    expect(decideGate({ ...base, a: 0.9, v: 0.8, hold: true, latched: false }).action).toBe("hold");
  });

  it("hold entry but v<threshold and not latched -> once (applies, not violating now)", () => {
    expect(decideGate({ ...base, a: 0.9, v: 0.1, hold: true, latched: false }).action).toBe("once");
  });

  it("segment not yet latched -> once", () => {
    expect(decideGate({ ...base, a: 0.9, v: 0.1, hold: false, latched: false }).action).toBe("once");
  });

  it("already latched, not hold -> pass (don't re-block every retry)", () => {
    expect(decideGate({ ...base, a: 0.9, v: 0.1, hold: false, latched: true }).action).toBe("pass");
  });
});

describe("evidenceTier (§6.4.5)", () => {
  function gateCandidate(hold: boolean, namedPrograms: readonly string[]): GateCandidate {
    return {
      entry: entry({ namedPrograms }),
      meta: { tags: [], guarded: true, hold, authority: "user", importance: 3, type: "rule", pending: false },
    };
  }

  it("hold entry with a running named program -> hold; otherwise pass", () => {
    const cands = [
      gateCandidate(true, ["release.sh"]),
      gateCandidate(true, ["other.sh"]),
      gateCandidate(false, ["release.sh"]),
    ];
    const out = evidenceTier(cands, new Set(["release.sh"]));
    expect(out.map((d) => d.action)).toEqual(["hold", "pass", "pass"]);
  });
});

describe("strictest", () => {
  it("hold > once > pass; empty -> undefined", () => {
    const pass = decideGate({
      entryHash: "h",
      anchor: "a",
      authority: "user",
      a: 0,
      v: 0,
      hold: false,
      latched: false,
      threshold: 0.6,
    });
    const once = decideGate({
      entryHash: "h2",
      anchor: "a2",
      authority: "user",
      a: 0.9,
      v: 0.1,
      hold: false,
      latched: false,
      threshold: 0.6,
    });
    const hold = decideGate({
      entryHash: "h3",
      anchor: "a3",
      authority: "user",
      a: 0.9,
      v: 0.9,
      hold: true,
      latched: false,
      threshold: 0.6,
    });
    expect(strictest([pass, once, hold])?.action).toBe("hold");
    expect(strictest([pass, once])?.action).toBe("once");
    expect(strictest([])).toBeUndefined();
  });
});

describe("verdict cache (§6.4.4)", () => {
  it("hits on the same key, expires after 10 minutes, evicts oldest past 64, clear() wipes", () => {
    let now = 0;
    const cache = createVerdictCache(() => now);
    const decision = decideGate({
      entryHash: "h",
      anchor: "a",
      authority: "user",
      a: 0.9,
      v: 0.9,
      hold: true,
      latched: false,
      threshold: 0.6,
    });
    const key = verdictKey("h", "fp1", "git commit");
    cache.set(key, decision);
    expect(cache.get(key)).toEqual(decision);
    now += 10 * 60_000 + 1;
    expect(cache.get(key)).toBeUndefined();

    now = 0;
    for (let i = 0; i < 65; i++) cache.set(verdictKey(`h${i}`, "fp", "shape"), decision);
    expect(cache.size).toBe(64);
    expect(cache.get(verdictKey("h0", "fp", "shape"))).toBeUndefined();
    expect(cache.get(verdictKey("h64", "fp", "shape"))).toEqual(decision);

    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("different evidence fingerprints produce different keys (no false hit)", () => {
    const k1 = verdictKey("h", "fpA", "git commit");
    const k2 = verdictKey("h", "fpB", "git commit");
    expect(k1).not.toBe(k2);
  });
});
