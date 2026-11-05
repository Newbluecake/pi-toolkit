/**
 * jev-reflex · #25 B2 pipeline (plan B2 tests, r3 sample set): the TOOLLESS-PORT chain. Samples
 * must reach the entry (contain a builtin quota weak word), pass S0, and stay builtin-ambiguous
 * (never high — the r2 sample 「这个月 token 还剩多少」 was anaphora-vetoed and weak-word-free,
 * hence replaced). toolCount=0 clusters then surface as `needsPort` suggestions — zero drafts —
 * until the human `assign` produces a quota.summary draft that passes full validation. We do NOT
 * claim quota can be generated fully automatically (K10).
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_SCRIPTS } from "../../../../src/reflex/core/catalog.js";
import { evaluateGate } from "../../../../src/reflex/core/gate.js";
import { compileCatalog } from "../../../../src/reflex/core/match.js";
import type { Capability, PortId, Turn } from "../../../../src/reflex/core/types.js";
import { validateDraft } from "../../../../src/reflex/core/draft-schema.js";
import { generateDrafts, type CorpusStats } from "../../../../src/reflex/core/backtest/draft-gen.js";
import { clusterTurns } from "../../../../src/reflex/core/backtest/cluster.js";
import { makeTurn } from "../../helpers/turn.js";

const ALL_CAPS = new Set<Capability>(["bashJobs", "fleet", "quota", "git", "sessionDir"]);
const BUILTIN_IDS = new Set(BUILTIN_SCRIPTS.map((s) => s.id));
const BUILTIN_MATCHER = compileCatalog(BUILTIN_SCRIPTS);
const QUOTA_STRONG = BUILTIN_SCRIPTS.filter((s) => s.id === "quota.summary")[0]!.intent.strong.map(
  (src) => new RegExp(`^(?:${src})$`),
);

const facts = (text: string) => ({
  source: "interactive" as const,
  mode: "tui" as const,
  streamingBehavior: undefined,
  idle: true,
  pendingMessages: false,
  imageCount: 0,
  text,
  topicSwitchActive: false,
  goalBusy: false,
  inFlight: false,
});

/** norm of a text under the same ideal-facts gate the pipeline uses. */
const normOf = (text: string): string | undefined => {
  const g = evaluateGate(facts(text));
  return g.pass ? g.norm.norm : undefined;
};

let seq = 0;
const quotaTurn = (text: string): Turn =>
  makeTurn({
    session: "s-quota",
    entryId: `q${(seq += 1)}`,
    text,
    shapes: [],
    toolCount: 0,
    hasWrite: false,
    unknownFacts: [],
  });

describe("r3 sample set — entry, S0, and builtin band", () => {
  const SAMPLES = ["quota 这周用得怎么样", "额度大概还够几天", "额度最近消耗快吗"];

  it("every sample passes S0 under ideal TUI facts", () => {
    for (const sample of SAMPLES) {
      expect(evaluateGate(facts(sample)).pass, sample).toBe(true);
    }
  });

  it("every sample contains a quota weak word but matches NO quota strong template whole-sentence", () => {
    for (const sample of SAMPLES) {
      const norm = normOf(sample)!;
      expect(norm.includes("额度") || norm.includes("quota"), `${sample} lacks the weak entry word`).toBe(true);
      expect(
        QUOTA_STRONG.some((re) => re.test(norm)),
        `${sample} matched a quota strong template`,
      ).toBe(false);
    }
  });

  it("every sample is builtin-ambiguous (never high)", () => {
    for (const sample of SAMPLES) {
      const norm = normOf(sample)!;
      const m = BUILTIN_MATCHER.match(norm, ALL_CAPS);
      expect(m.kind, `${sample} should hit`).toBe("hit");
      expect(m.kind === "hit" ? m.band : undefined, `${sample}`).toBe("ambiguous");
    }
  });
});

describe("toolless quota chain — needsPort, zero drafts, assign", () => {
  // family A: suffixed/prefixed paraphrases of 「quota 用得怎么样」 — one cluster of 4
  // (「quota 最近用得怎么样」 does not join the leader and stays a small singleton).
  const familyA = ["quota 用得怎么样", "quota 用得怎么样吗", "quota 用得怎么样呢", "quota 今天用得怎么样"];
  // family B: one digit skeleton 「额度用了 <n> 成」 — three instantiations.
  const familyB = ["额度用了 2 成", "额度用了 5 成", "额度用了 8 成"];
  const turns = [
    ...familyA.map(quotaTurn),
    quotaTurn("quota 最近用得怎么样"), // singleton ⇒ small
    ...familyB.map(quotaTurn),
  ];
  const stats: CorpusStats = { turns, negatives: ["把额度重置一下"] };

  it("clusters as designed (1 family of 4 + 1 digit family of 3 + 1 singleton)", () => {
    const res = clusterTurns(turns);
    expect(res.clusters.map((c) => c.size).sort((a, b) => b - a)).toEqual([4, 3, 1]);
  });

  it("toolCount=0 ⇒ needsPort suggests quota.summary and produces ZERO drafts", () => {
    const res = generateDrafts(clusterTurns(turns).clusters, stats);
    expect(res.drafts).toHaveLength(0);
    const quotaCandidates = res.needsPort.filter((n) => n.suggestedPort === "quota.summary");
    expect(quotaCandidates).toHaveLength(2);
    for (const cand of quotaCandidates) {
      expect(cand.size).toBeGreaterThanOrEqual(3);
      expect(cand.skeletons.length).toBeGreaterThanOrEqual(1);
      expect(cand.skeletons.every((s) => Array.from(s).length <= 25)).toBe(true);
    }
    // skip snapshot: only the singleton cluster is small; nothing else skipped
    expect(res.skips).toEqual({
      small: 1,
      "low-purity": 0,
      unmapped: 0,
      examples: 0,
      regex: 0,
      "exclude-cap": 0,
      validate: 0,
    });
  });

  it("assign produces quota.summary drafts that pass validateDraft (both families)", () => {
    const clusters = clusterTurns(turns).clusters;
    const res0 = generateDrafts(clusters, stats);
    const assign = new Map<string, PortId>();
    for (const cand of res0.needsPort) assign.set(cand.clusterId, cand.suggestedPort);
    const res = generateDrafts(clusters, stats, assign);
    expect(res.drafts).toHaveLength(2);
    expect(res.needsPort).toHaveLength(0);
    for (const draft of res.drafts) {
      expect(draft.port.id).toBe("quota.summary");
      expect(validateDraft(draft, BUILTIN_IDS)).toEqual(draft);
      expect(draft.intent.strong.length).toBeGreaterThanOrEqual(1);
    }
    // the digit family's draft carries \d{1,4} and instantiates <n> in hits
    const digitDraft = res.drafts.find((d) => d.intent.strong.some((s) => s.includes("\\d{1,4}")));
    expect(digitDraft).toBeDefined();
    expect(digitDraft!.intent.examples.hit).toContain("额度用了 2 成");
    expect(digitDraft!.intent.examples.hit.every((h) => !h.includes("<n>"))).toBe(true);
  });
});
