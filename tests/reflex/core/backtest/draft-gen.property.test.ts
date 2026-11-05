/**
 * jev-reflex · #25 B2 seeded property test (plan B2 tests): ≥1,000 random clusters through the
 * FULL pipeline (clusterTurns → generateDrafts → needsPort assign → generateDrafts → refineDrafts)
 * ⇒ every emitted draft passes `validateDraft` ①–⑦ and every template source parses under DRX;
 * no unknown keys, no argv anywhere. Plus a `tightenDraft` monotonicity battery and a determinism
 * double-run. Fixed PRNG (mulberry32) — a failure reproduces byte-for-byte.
 *
 * SEED = 0x62533242 (recorded in B2-report.md). Pure in-process work; refine runs on a sampled
 * prefix of the drafts (the replay adapter is O(turns × drafts) and the unit suite in
 * draft-gen.test.ts already covers refine semantics exhaustively).
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_SCRIPTS } from "../../../../src/reflex/core/catalog.js";
import { validateDraft } from "../../../../src/reflex/core/draft-schema.js";
import { parseDrx } from "../../../../src/reflex/core/draft-regex.js";
import { evaluateGate } from "../../../../src/reflex/core/gate.js";
import { compileCatalog } from "../../../../src/reflex/core/match.js";
import type { Capability, PortId, RScriptV1, Turn } from "../../../../src/reflex/core/types.js";
import {
  type CorpusStats,
  type ReplayFn,
  generateDrafts,
  refineDrafts,
  tightenDraft,
} from "../../../../src/reflex/core/backtest/draft-gen.js";
import { clusterTurns } from "../../../../src/reflex/core/backtest/cluster.js";
import { makeTurn } from "../../helpers/turn.js";

const SEED = 0x62533242;
const CLUSTER_COUNT = 1_050; // ≥1,000 per the plan
const REFINE_SAMPLE = 100;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALL_CAPS = new Set<Capability>(["bashJobs", "fleet", "quota", "git", "sessionDir"]);
const BUILTIN_IDS = new Set(BUILTIN_SCRIPTS.map((s) => s.id));
const BUILTIN_MATCHER = compileCatalog(BUILTIN_SCRIPTS);

const SIGS: Readonly<Record<string, readonly string[]>> = {
  "jobs.list": ["bash_job:list", "bash_job:status"],
  "fleet.status": ["get_run_result", "list_subagents"],
  "git.status": ["git status", "git diff"],
  "quota.summary": [],
};
const CORES: Readonly<Record<string, readonly string[]>> = {
  "jobs.list": ["后台任务进度", "后台队列长度", "后台还剩多少条"],
  "fleet.status": ["代理们的情况", "代理的规模", "现在代理数量"],
  "git.status": ["仓库的最新状态", "分支的领先情况", "工作副本情况"],
  "quota.summary": ["额度的消耗节奏", "quota 的节奏", "额度节奏"],
};
const DIGIT_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  "jobs.list": ["后台第 <D> 条任务"],
  "fleet.status": ["现在有 <D> 个代理"],
  "git.status": ["仓库里有 <D> 个新条目"],
  "quota.summary": ["额度还够 <D> 天"],
};
const PORTS: readonly PortId[] = ["jobs.list", "fleet.status", "git.status", "quota.summary"];
const PREFIXES = ["", "现在", "目前", "顺便问下", "帮我看看", "请问一下"];
const SUFFIXES = ["", "呢", "啊", "来着", "呀", "嘛"];
const MODIFIERS = ["", "整体", "近期", "今天", "大致", "具体", "全部", "单独"];
const WRITE_TAILS = ["提交一下", "帮我删掉", "改一下", "跑一下"];

interface RandomWorld {
  turns: Turn[];
  negatives: string[];
  randomClusters: number;
}

function buildWorld(): RandomWorld {
  const rng = mulberry32(SEED);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
  const turns: Turn[] = [];
  let id = 0;
  const next = (text: string, port: PortId, shapes: readonly string[]): Turn =>
    makeTurn({
      session: `s${Math.floor(rng() * 40)}`,
      entryId: `p${(id += 1)}`,
      text,
      shapes,
      toolCount: shapes.length,
      hasWrite: rng() < 0.05,
      unknownFacts: [],
      digest: `d${(id += 1)}`,
    });

  for (let c = 0; c < CLUSTER_COUNT; c++) {
    const port = pick(PORTS);
    const digit = rng() < 0.4;
    if (digit) {
      const template = pick(DIGIT_TEMPLATES[port]!);
      const count = 3 + Math.floor(rng() * 3); // 3–5 turns
      for (let i = 0; i < count; i++) {
        const n = 1 + Math.floor(rng() * 9999);
        turns.push(next(template.replace("<D>", String(n)), port, shapesFor(port, rng, pick)));
      }
    } else {
      const core = pick(CORES[port]!);
      const modifier = pick(MODIFIERS);
      const variants = new Set<string>();
      const variantCount = 1 + Math.floor(rng() * 3); // 1–3 distinct skeletons
      for (let i = 0; i < variantCount; i++) variants.add(`${pick(PREFIXES)}${modifier}${core}${pick(SUFFIXES)}`);
      for (const v of variants) {
        const reps = 1 + Math.floor(rng() * 2);
        for (let i = 0; i < reps; i++) turns.push(next(v, port, shapesFor(port, rng, pick)));
      }
    }
  }
  // negatives: write-flavoured sentences (some >40cp so they cannot be exclude literals)
  const negatives: string[] = [];
  for (let i = 0; i < 40; i++) {
    const core = pick(Object.values(CORES).flat());
    let text = `${pick(PREFIXES)}${core}${pick(WRITE_TAILS)}`;
    if (rng() < 0.3) text += "还有一些多余的尾巴字用来超过四十个字符的长度限制增加变化";
    negatives.push(text);
  }
  // filler turns for the weak-rate denominator (never share tokens with the cores)
  for (let i = 0; i < 200; i++) {
    turns.push(next(`zz filler ${i + 1} q qx`, "git.status", ["git diff"]));
  }
  return { turns, negatives, randomClusters: CLUSTER_COUNT };
}

function shapesFor(port: PortId, rng: () => number, pick: <T>(xs: readonly T[]) => T): readonly string[] {
  if (port === "quota.summary") return [];
  const source = rng() < 0.85 ? port : pick(PORTS.filter((p) => p !== "quota.summary")); // 15% cross-port
  const sig = SIGS[source]!;
  return sig.slice(0, 1 + Math.floor(rng() * sig.length));
}

/** Structural invariants (the property): 100% of products pass everything, always. */
function assertDraftInvariants(draft: RScriptV1): void {
  const v = validateDraft(draft, BUILTIN_IDS);
  expect(v, `${draft.id} must pass validateDraft`).toEqual(draft);
  for (const src of draft.intent.strong) expect(parseDrx(src, "strong").ok, src).toBe(true);
  for (const src of draft.intent.weak) expect(parseDrx(src, "weak").ok, src).toBe(true);
  for (const src of draft.intent.exclude) expect(parseDrx(src, "exclude").ok, src).toBe(true);
  const json = JSON.stringify(draft);
  expect(json).not.toContain("argv");
  expect(json).not.toContain("<n>");
  for (const k of Object.keys(draft))
    expect([
      "schema",
      "id",
      "version",
      "origin",
      "risk",
      "lineage",
      "intent",
      "port",
      "requires",
      "budgetMs",
      "render",
      "agreement",
    ]).toContain(k);
  for (const k of Object.keys(draft.intent)) expect(["strong", "weak", "exclude", "examples"]).toContain(k);
  expect(draft.intent.strong.length).toBeLessThanOrEqual(12);
  expect(draft.intent.weak.length).toBeLessThanOrEqual(8);
  expect(draft.intent.exclude.length).toBeLessThanOrEqual(32);
}

/** Reference two-layer replay adapter (builtin first, draft layer only on builtin miss). */
const replayFn: ReplayFn = (drafts, turns) => {
  const matcher = compileCatalog(drafts);
  const out: { draftId: string; turn: Turn; band: "high" | "ambiguous" }[] = [];
  for (const t of turns) {
    const gate = evaluateGate({
      source: "interactive",
      mode: "tui",
      streamingBehavior: undefined,
      idle: true,
      pendingMessages: false,
      imageCount: t.imageCount,
      text: t.text,
      topicSwitchActive: false,
      goalBusy: false,
      inFlight: false,
    });
    if (!gate.pass) continue;
    if (BUILTIN_MATCHER.match(gate.norm.norm, ALL_CAPS).kind === "hit") continue;
    const m = matcher.match(gate.norm.norm, ALL_CAPS);
    if (m.kind === "hit" && m.band === "high") out.push({ draftId: m.scriptId, turn: t, band: "high" });
  }
  return out;
};

describe("seeded property: ≥1,000 random clusters → safe, valid drafts", () => {
  const world = buildWorld();
  const clustered = clusterTurns(world.turns);
  const stats: CorpusStats = { turns: world.turns, negatives: world.negatives };

  it("world size: ≥1,000 random clusters fed the pipeline", () => {
    expect(world.randomClusters).toBeGreaterThanOrEqual(1_000);
    expect(world.turns.length).toBeGreaterThan(3_000);
    expect(clustered.clusters.length).toBeGreaterThan(100);
  });

  it("100% of generated drafts (auto + assigned) pass validateDraft & DRX & key whitelist", () => {
    const first = generateDrafts(clustered.clusters, stats);
    for (const draft of first.drafts) assertDraftInvariants(draft);
    const assign = new Map<string, PortId>();
    for (const cand of first.needsPort) assign.set(cand.clusterId, cand.suggestedPort);
    const second = generateDrafts(clustered.clusters, stats, assign);
    for (const draft of second.drafts) assertDraftInvariants(draft);
    expect(first.drafts.length + second.drafts.length).toBeGreaterThan(50);
  });

  it("refine survivors are still 100% valid", () => {
    const first = generateDrafts(clustered.clusters, stats);
    const assign = new Map<string, PortId>();
    for (const cand of first.needsPort) assign.set(cand.clusterId, cand.suggestedPort);
    const all = [...generateDrafts(clustered.clusters, stats, assign).drafts];
    const sample = all.slice(0, REFINE_SAMPLE);
    if (sample.length === 0) throw new Error("no drafts to refine");
    const res = refineDrafts(sample, world.turns, replayFn);
    for (const draft of res.drafts) assertDraftInvariants(draft);
    // every non-survivor is accounted for in the skip record
    const deaths = Object.values(res.skips).reduce((a, b) => a + b, 0);
    expect(res.drafts.length + deaths).toBe(sample.length);
  });

  it("determinism: a second identical run is byte-identical", () => {
    const a = generateDrafts(clusterTurns(world.turns).clusters, {
      turns: world.turns,
      negatives: world.negatives,
    });
    const b = generateDrafts(clusterTurns([...world.turns].reverse()).clusters, {
      turns: [...world.turns].reverse(),
      negatives: [...world.negatives].reverse(),
    });
    expect(b).toEqual(a);
  });

  it("tightenDraft is monotone on 300 random cases", () => {
    const rng = mulberry32(SEED ^ 0x9e3779b9);
    const first = generateDrafts(clustered.clusters, stats);
    const assign = new Map<string, PortId>();
    for (const cand of first.needsPort) assign.set(cand.clusterId, cand.suggestedPort);
    const drafts = generateDrafts(clustered.clusters, stats, assign).drafts;
    expect(drafts.length).toBeGreaterThan(50);
    const probeTexts = [
      ...world.negatives.slice(0, 10),
      ...drafts.slice(0, 10).flatMap((d) => [...d.intent.examples.hit]),
    ];
    let cases = 0;
    for (let i = 0; i < 300 && i < drafts.length * 3; i++) {
      const draft = drafts[Math.floor(rng() * drafts.length)]!;
      const bad = [...draft.intent.examples.hit.slice(0, 2), probeTexts[Math.floor(rng() * probeTexts.length)]!];
      const out = tightenDraft(draft, bad);
      if (out.dead !== undefined) {
        cases += 1;
        continue;
      }
      const tightened = out.draft!;
      const caps = new Set<Capability>(draft.requires);
      const before = compileCatalog([draft]);
      const after = compileCatalog([tightened]);
      for (const probe of [...bad, ...probeTexts.slice(0, 8)]) {
        const norm = evaluateGate({
          source: "interactive",
          mode: "tui",
          streamingBehavior: undefined,
          idle: true,
          pendingMessages: false,
          imageCount: 0,
          text: probe,
          topicSwitchActive: false,
          goalBusy: false,
          inFlight: false,
        });
        if (!norm.pass) continue;
        const a = after.match(norm.norm.norm, caps);
        if (a.kind === "hit" && a.band === "high") {
          const b = before.match(norm.norm.norm, caps);
          expect(b.kind === "hit" && b.band === "high", `monotonicity broke on "${probe}"`).toBe(true);
        }
      }
      cases += 1;
    }
    expect(cases).toBeGreaterThanOrEqual(300 > drafts.length * 3 ? drafts.length * 3 : 300);
  });
});
