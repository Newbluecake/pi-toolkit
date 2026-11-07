// cache.ts unit tests (plan.md v3.2 §7.1/§7.2, §11.2 cache 列表).

import { describe, expect, it } from "vitest";
import { CACHE_CAPACITY, PENDING_CAP_P, PredictCache, turnKey } from "../../../../src/memory/jev/predict/cache.js";
import { buildPredictOutbound } from "../../../../src/memory/jev/predict/outbound.js";
import type { Modifier, PredictInput, TagScore } from "../../../../src/memory/jev/predict/contracts.js";

function baseInput(prompt: string): PredictInput {
  return {
    prompt,
    todo: [],
    recentTools: [],
    git: { branch: "dev", dirty: true },
    bashJobs: [],
    activeSubagents: 1,
    session: "main",
  };
}

function dtoFor(prompt: string) {
  return buildPredictOutbound(baseInput(prompt), { ruleGuess: [{ tag: "git-commit", score: 0.8 }] });
}

// ───────────────────────────── turnKey（§7.1 精确键） ─────────────────────────────

describe("turnKey", () => {
  const base = { models: ["deepseek/deepseek-flash"], taxonomyRev: "r1", threshold: 0.6 };

  it("is deterministic for identical input", () => {
    expect(turnKey({ dto: dtoFor("fix it"), ...base })).toBe(turnKey({ dto: dtoFor("fix it"), ...base }));
  });

  it("distinguishes punctuation differences (标点敏感)", () => {
    expect(turnKey({ dto: dtoFor("fix it, now"), ...base })).not.toBe(turnKey({ dto: dtoFor("fix it now"), ...base }));
  });

  it("distinguishes case (大小写敏感)", () => {
    expect(turnKey({ dto: dtoFor("Commit it"), ...base })).not.toBe(turnKey({ dto: dtoFor("commit it"), ...base }));
  });

  it("covers the model chain", () => {
    expect(turnKey({ dto: dtoFor("fix it"), ...base })).not.toBe(
      turnKey({ dto: dtoFor("fix it"), ...base, models: ["a/b", "c/d"] }),
    );
  });

  it("covers the threshold", () => {
    expect(turnKey({ dto: dtoFor("fix it"), ...base })).not.toBe(
      turnKey({ dto: dtoFor("fix it"), ...base, threshold: 0.65 }),
    );
  });

  it("covers taxonomyRev", () => {
    expect(turnKey({ dto: dtoFor("fix it"), ...base })).not.toBe(
      turnKey({ dto: dtoFor("fix it"), ...base, taxonomyRev: "r2" }),
    );
  });
});

// ───────────────────────────── LRU + TTL（§7.1） ─────────────────────────────

describe("PredictCache exact-key LRU + TTL", () => {
  it("hits within TTL and expires after it", () => {
    let now = 1000;
    const cache = new PredictCache({ ttlMs: 30 * 60_000, clock: () => now });
    cache.set("k", [{ tag: "release", p: 0.7 }]);
    expect(cache.get("k")).toEqual([{ tag: "release", p: 0.7 }]);
    now += 30 * 60_000; // 恰好 TTL：未"超过"
    expect(cache.get("k")).toEqual([{ tag: "release", p: 0.7 }]);
    now += 1; // 超过
    expect(cache.get("k")).toBeUndefined();
    expect(cache.get("k")).toBeUndefined(); // 过期条目已被淘汰
  });

  it("evicts least-recently-used first (get refreshes recency)", () => {
    let now = 0;
    const cache = new PredictCache({ ttlMs: 60_000, clock: () => now, capacity: 3 });
    cache.set("a", []);
    cache.set("b", []);
    cache.set("c", []);
    expect(cache.get("a")).toEqual([]); // a 变为最新
    cache.set("d", []); // 挤掉最旧的 b
    expect(cache.get("a")).toEqual([]);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toEqual([]);
    expect(cache.get("d")).toEqual([]);
  });

  it("default capacity is 64", () => {
    let now = 0;
    const cache = new PredictCache({ ttlMs: 60_000, clock: () => now });
    expect(CACHE_CAPACITY).toBe(64);
    for (let i = 0; i < 65; i++) cache.set(`k${i}`, [{ tag: "t", p: 0.5 }]);
    expect(cache.get("k0")).toBeUndefined();
    expect(cache.get("k1")).toBeDefined();
    expect(cache.get("k64")).toBeDefined();
  });
});

// ───────────────────────────── pendingModel 单槽（§7.2） ─────────────────────────────

const PENDING_TAGS = [
  { tag: "git-commit", p: 0.9 },
  { tag: "release", p: 0.7 },
];

function ruleTag(tag: string, score = 0.6): TagScore {
  return { tag, score, sources: ["U"], rules: ["R02"] };
}

function modifier(kind: Modifier["kind"], tags: readonly string[] | "all" = "all"): Modifier {
  return { rule: "test", kind, tags };
}

describe("PredictCache pendingModel slot", () => {
  function fresh() {
    let now = 1000;
    const cache = new PredictCache({ ttlMs: 30 * 60_000, clock: () => now });
    return { cache, tick: (ms: number) => (now += ms) };
  }

  it("carry phrase redeems with full weight and clears the slot (used once)", () => {
    const { cache } = fresh();
    cache.setPending(PENDING_TAGS, undefined, 5);
    const out = cache.redeemPending({ turnSeq: 6, prompt: "继续", currentTags: [], modifiers: [] });
    expect(out).toEqual({ kind: "full", tags: PENDING_TAGS }); // 原权重，不封顶
    expect(cache.peekPending()).toBeUndefined(); // 用过一次即清空
    expect(cache.redeemPending({ turnSeq: 7, prompt: "继续", currentTags: [], modifiers: [] })).toEqual({
      kind: "none",
    });
  });

  it("new instruction keeps only rule-supported tags, capped at 0.6", () => {
    const { cache } = fresh();
    cache.setPending(PENDING_TAGS, undefined, 5);
    const out = cache.redeemPending({
      turnSeq: 6,
      prompt: "改一下 README 的排版",
      currentTags: [ruleTag("git-commit")],
      modifiers: [],
    });
    expect(out).toEqual({ kind: "capped", tags: [{ tag: "git-commit", p: PENDING_CAP_P }] });
    expect(PENDING_CAP_P).toBe(0.6);
  });

  it("stateSupportedTags (T/W) also survive the new-instruction filter", () => {
    const { cache } = fresh();
    cache.setPending(PENDING_TAGS, undefined, 5);
    const out = cache.redeemPending({
      turnSeq: 6,
      prompt: "改一下 README 的排版",
      currentTags: [],
      modifiers: [],
      stateSupportedTags: new Set(["release"]),
    });
    expect(out).toEqual({ kind: "capped", tags: [{ tag: "release", p: PENDING_CAP_P }] });
  });

  it("drops everything on a cancel modifier", () => {
    const { cache } = fresh();
    cache.setPending(PENDING_TAGS, undefined, 5);
    const out = cache.redeemPending({
      turnSeq: 6,
      prompt: "好的",
      currentTags: [ruleTag("git-commit")],
      modifiers: [modifier("cancel")],
    });
    expect(out).toEqual({ kind: "dropped" });
    expect(cache.peekPending()).toBeUndefined();
  });

  it("refuses non-adjacent turns and clears the slot", () => {
    const { cache } = fresh();
    cache.setPending(PENDING_TAGS, undefined, 5);
    expect(cache.redeemPending({ turnSeq: 7, prompt: "继续", currentTags: [], modifiers: [] })).toEqual({
      kind: "none",
    });
    expect(cache.peekPending()).toBeUndefined();
    // 相邻轮再来也兑现不了：槽已清。
    expect(cache.redeemPending({ turnSeq: 6, prompt: "继续", currentTags: [], modifiers: [] })).toEqual({
      kind: "none",
    });
  });

  it("expires pending past the TTL", () => {
    const { cache, tick } = fresh();
    cache.setPending(PENDING_TAGS, undefined, 5);
    tick(30 * 60_000 + 1);
    expect(cache.redeemPending({ turnSeq: 6, prompt: "继续", currentTags: [], modifiers: [] })).toEqual({
      kind: "none",
    });
  });

  it("does not apply negate/readonly itself (vote path owns §4.2)", () => {
    const { cache } = fresh();
    cache.setPending(PENDING_TAGS, undefined, 5);
    const out = cache.redeemPending({
      turnSeq: 6,
      prompt: "好的", // 承接 ⇒ full
      currentTags: [],
      modifiers: [modifier("negate", ["git-commit"]), modifier("readonly", ["release"])],
    });
    expect(out).toEqual({ kind: "full", tags: PENDING_TAGS }); // 原样交给 vote
  });

  it("carries evidence through the redeem", () => {
    const { cache } = fresh();
    const evidence = { todoIds: [3], jobShapes: ["release.sh"] };
    cache.setPending(PENDING_TAGS, evidence, 5);
    const out = cache.redeemPending({ turnSeq: 6, prompt: "继续", currentTags: [], modifiers: [] });
    expect(out).toEqual({ kind: "full", tags: PENDING_TAGS, evidence });
  });

  it("pending slot is independent of the exact-key entries", () => {
    const { cache } = fresh();
    cache.set("k", [{ tag: "release", p: 0.7 }]);
    cache.setPending(PENDING_TAGS, undefined, 5);
    expect(cache.get("k")).toEqual([{ tag: "release", p: 0.7 }]);
    cache.redeemPending({ turnSeq: 6, prompt: "继续", currentTags: [], modifiers: [] });
    expect(cache.get("k")).toEqual([{ tag: "release", p: 0.7 }]); // 兑现不影响 LRU
  });
});

// ───────────────────── P2 验收小项：模型链分隔 ─────────────────────

describe("turnKey model-chain separation", () => {
  it('does not collide ["a,b"] with ["a","b"] (no comma join)', () => {
    const dto = dtoFor("fix it");
    const k1 = turnKey({ dto, models: ["a,b"], taxonomyRev: "r1", threshold: 0.6 });
    const k2 = turnKey({ dto, models: ["a", "b"], taxonomyRev: "r1", threshold: 0.6 });
    expect(k1).not.toBe(k2);
  });
});
