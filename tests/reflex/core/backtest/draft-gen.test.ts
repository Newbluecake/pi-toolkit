/**
 * jev-reflex · #25 B2 draft generation (BA §4.4 step 3): digit clusters, per-port drafts,
 * small-cluster completion, weak/exclude sourcing, skip decisions, determinism, tightening
 * (monotone) and replay refinement (BD3). The quota toolless-port chain lives in
 * draft-gen.pipeline.test.ts; the seeded random battery in draft-gen.property.test.ts.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_SCRIPTS } from "../../../../src/reflex/core/catalog.js";
import { validateDraft } from "../../../../src/reflex/core/draft-schema.js";
import { evaluateGate } from "../../../../src/reflex/core/gate.js";
import { compileCatalog } from "../../../../src/reflex/core/match.js";
import type { Capability, PortId, RScriptV1, SkipCounts, Turn } from "../../../../src/reflex/core/types.js";
import {
  type CorpusStats,
  type ReplayFn,
  emptySkips,
  generateDrafts,
  refineDrafts,
  tightenDraft,
} from "../../../../src/reflex/core/backtest/draft-gen.js";
import { clusterTurns } from "../../../../src/reflex/core/backtest/cluster.js";
import { makeTurn } from "../../helpers/turn.js";

const BUILTIN_IDS = new Set(BUILTIN_SCRIPTS.map((s) => s.id));
const ALL_CAPS = new Set<Capability>(["bashJobs", "fleet", "quota", "git", "sessionDir"]);
const BUILTIN_MATCHER = compileCatalog(BUILTIN_SCRIPTS);

let seq = 0;
const turn = (text: string, over: Partial<Turn> = {}): Turn =>
  makeTurn({ session: over.session ?? "s1", entryId: over.entryId ?? `e${(seq += 1)}`, text, ...over });

const statsOf = (turns: readonly Turn[], negatives: readonly string[] = []): CorpusStats => ({
  turns: [...turns],
  negatives,
});

const expectSkips = (skips: SkipCounts, over: Partial<SkipCounts>): void => {
  expect(skips).toEqual({ ...emptySkips(), ...over });
};

// The three signed-port digit clusters — sentences deliberately avoid builtin weak words
// (`job`/`agent`/`未提交` …) so the draft layer is reachable under two-layer replay.
const jobsTurns = (): Turn[] => [
  turn("后台第 3 个任务呢", { shapes: ["bash_job:list"], toolCount: 1 }),
  turn("后台第 10 个任务呢", { shapes: ["bash_job:list"], toolCount: 1 }),
  turn("后台第 2 个任务呢", { shapes: ["bash_job:list"], toolCount: 1 }),
];
const fleetTurns = (): Turn[] => [
  turn("现在有 3 个代理在跑吗", { shapes: ["get_run_result"], toolCount: 1 }),
  turn("现在有 10 个代理在跑吗", { shapes: ["get_run_result"], toolCount: 1 }),
  turn("现在有 2 个代理在跑吗", { shapes: ["get_run_result"], toolCount: 1 }),
];
const gitTurns = (): Turn[] => [
  turn("有 3 个新文件吗", { shapes: ["git status"], toolCount: 1 }),
  turn("有 10 个新文件吗", { shapes: ["git status"], toolCount: 1 }),
  turn("有 2 个新文件吗", { shapes: ["git status"], toolCount: 1 }),
];

const TOP_KEYS = [
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
];
const INTENT_KEYS = ["strong", "weak", "exclude", "examples"];

/** Structural invariants every emitted draft must hold (also asserted property-wide). */
function assertDraftShape(draft: RScriptV1): void {
  const v = validateDraft(draft, BUILTIN_IDS);
  expect(v, `validateDraft must accept ${draft.id}`).toEqual(draft);
  expect(Object.keys(draft).every((k) => TOP_KEYS.includes(k))).toBe(true);
  expect(Object.keys(draft.intent).every((k) => INTENT_KEYS.includes(k))).toBe(true);
  expect(JSON.stringify(draft)).not.toContain("argv");
  expect(draft.origin).toBe("extracted");
  expect(draft.version).toBe(1);
  expect(draft.budgetMs).toBeUndefined();
  expect(draft.lineage).toBeUndefined();
}

describe("generateDrafts — digit cluster (数字簇)", () => {
  it("produces a jobs draft whose hits are all high and contain no literal <n>", () => {
    const turns = jobsTurns();
    const clusters = clusterTurns(turns).clusters;
    expect(clusters).toHaveLength(1);
    const res = generateDrafts(clusters, statsOf(turns));
    expect(res.drafts).toHaveLength(1);
    const draft = res.drafts[0]!;
    assertDraftShape(draft);
    expect(draft.port.id).toBe("jobs.list");
    expect(draft.intent.strong.join("|")).toContain("\\d{1,4}");
    expect(draft.intent.examples.hit.length).toBeGreaterThanOrEqual(5);
    for (const hit of draft.intent.examples.hit) {
      expect(hit).not.toContain("<n>");
      const gate = evaluateGate({
        source: "interactive",
        mode: "tui",
        streamingBehavior: undefined,
        idle: true,
        pendingMessages: false,
        imageCount: 0,
        text: hit,
        topicSwitchActive: false,
        goalBusy: false,
        inFlight: false,
      });
      expect(gate.pass, `hit must pass S0: ${hit}`).toBe(true);
    }
    expectSkips(res.skips, {});
  });
});

describe("generateDrafts — every signed port gets a draft", () => {
  it("jobs/fleet/git clusters each produce one draft on their port", () => {
    const turns = [...jobsTurns(), ...fleetTurns(), ...gitTurns()];
    const res = generateDrafts(clusterTurns(turns).clusters, statsOf(turns));
    expect(res.drafts).toHaveLength(3);
    const ports = res.drafts.map((d) => d.port.id).sort();
    expect(ports).toEqual(["fleet.status", "git.status", "jobs.list"]);
    for (const draft of res.drafts) assertDraftShape(draft);
  });
});

describe("generateDrafts — small-cluster completion (小簇)", () => {
  it("pure-literal clusters complete to 5 hits via 吗/呢 tail variants", () => {
    const turns = [
      turn("git 状态如何", { shapes: ["git status"], toolCount: 1 }),
      turn("git 状态如何", { shapes: ["git status"], toolCount: 1 }),
      turn("git 状态如何呀", { shapes: ["git status"], toolCount: 1 }),
    ];
    const res = generateDrafts(clusterTurns(turns).clusters, statsOf(turns));
    expect(res.drafts).toHaveLength(1);
    const draft = res.drafts[0]!;
    assertDraftShape(draft);
    expect(draft.intent.examples.hit.length).toBeGreaterThanOrEqual(5);
    expect(draft.intent.strong.some((s) => s.endsWith("(?:吗|呢)?"))).toBe(true);
  });

  it("a single-skeleton literal cluster cannot reach 5 distinct hits ⇒ skip examples", () => {
    const turns = [
      turn("subagent 现在用得怎么样", { shapes: ["get_run_result"], toolCount: 1 }),
      turn("subagent 现在用得怎么样", { shapes: ["get_run_result"], toolCount: 1 }),
      turn("subagent 现在用得怎么样", { shapes: ["get_run_result"], toolCount: 1 }),
    ];
    const res = generateDrafts(clusterTurns(turns).clusters, statsOf(turns));
    expect(res.drafts).toHaveLength(0);
    expectSkips(res.skips, { examples: 1 });
  });
});

describe("generateDrafts — weak n-grams and exclude sourcing", () => {
  it("weak n-grams need ≥60% coverage AND ≤2% corpus occurrence", () => {
    const clusterTurnsList = [
      turn("后台任务清单", { shapes: ["bash_job:list"], toolCount: 1 }),
      turn("后台任务清单", { shapes: ["bash_job:list"], toolCount: 1 }),
      turn("一下后台任务清单", { shapes: ["bash_job:list"], toolCount: 1 }),
    ];
    const fillers = Array.from({ length: 150 }, (_, i) =>
      turn(`filler 句子 之 编号 ${i + 1} 无关键词`, { shapes: ["read"], toolCount: 1 }),
    );
    // no fillers: rate = 3/3 ⇒ nothing passes 2% ⇒ weak empty
    const dense = generateDrafts(clusterTurns(clusterTurnsList).clusters, statsOf(clusterTurnsList));
    expect(dense.drafts[0]!.intent.weak).toEqual([]);
    // 150 fillers: 3/153 ≈ 1.96% ⇒ the cluster's bigrams qualify (≤3, deterministic order)
    const sparse = generateDrafts(clusterTurns(clusterTurnsList).clusters, statsOf([...clusterTurnsList, ...fillers]));
    const weak = sparse.drafts[0]!.intent.weak;
    // deterministic order: coverage desc → rate asc → len desc → lexicographic (任务 U+4EFB < 务清 U+52A1 < 台任 U+53F0)
    expect(weak).toEqual(["任务", "务清", "台任"]);
  });

  it("exclude = whole-sentence pure literals of training negatives (≤40cp); longer ones dropped", () => {
    const long = "长".repeat(41);
    const turns = jobsTurns();
    const res = generateDrafts(clusterTurns(turns).clusters, statsOf(turns, ["把改动提交一下", long, "把后台清空"]));
    const draft = res.drafts[0]!;
    assertDraftShape(draft);
    expect(draft.intent.exclude).toContain("把改动提交一下");
    expect(draft.intent.exclude).toContain("把后台清空");
    expect(draft.intent.exclude).not.toContain(long);
    // miss examples seed from the negatives (plus always-vetoed synthetics)
    expect(draft.intent.examples.miss).toContain("把改动提交一下");
    expect(draft.intent.examples.miss.length).toBeGreaterThanOrEqual(5);
  });
});

describe("generateDrafts — skip decisions", () => {
  it("below minGroup ⇒ small", () => {
    const turns = jobsTurns().slice(0, 2);
    const res = generateDrafts(clusterTurns(turns).clusters, statsOf(turns));
    expect(res.drafts).toHaveLength(0);
    expectSkips(res.skips, { small: 1 });
  });
  it("minGroup option is honoured", () => {
    const turns = jobsTurns().slice(0, 2);
    const res = generateDrafts(clusterTurns(turns).clusters, statsOf(turns), undefined, { minGroup: 2 });
    expect(res.drafts).toHaveLength(1);
  });
  it("no port signal at all ⇒ unmapped", () => {
    const turns = [
      turn("测试句子甲", { shapes: ["read"], toolCount: 1 }),
      turn("测试句子甲", { shapes: ["read"], toolCount: 1 }),
      turn("测试句子甲", { shapes: ["read"], toolCount: 1 }),
    ];
    const res = generateDrafts(clusterTurns(turns).clusters, statsOf(turns));
    expect(res.drafts).toHaveLength(0);
    expectSkips(res.skips, { unmapped: 1 });
  });
  it("labels split across two ports ⇒ low-purity", () => {
    const turns = [
      turn("混合任务一", { shapes: ["bash_job:list"], toolCount: 1 }),
      turn("混合任务一", { shapes: ["bash_job:list"], toolCount: 1 }),
      turn("混合任务一", { shapes: ["bash_job:list"], toolCount: 1 }),
      turn("混合任务二", { shapes: ["get_run_result"], toolCount: 1 }),
      turn("混合任务二", { shapes: ["get_run_result"], toolCount: 1 }),
      turn("混合任务二", { shapes: ["get_run_result"], toolCount: 1 }),
    ];
    const res = generateDrafts(clusterTurns(turns).clusters, statsOf(turns));
    expect(res.drafts).toHaveLength(0);
    expectSkips(res.skips, { "low-purity": 1 });
  });
  it("nothing DRX-expressible (all skeletons carry <path>) ⇒ skip regex", () => {
    const turns = [
      turn("看一下 /a/b.ts 这个", { shapes: ["bash_job:list"], toolCount: 1 }),
      turn("看一下 /c/d.txt 这个", { shapes: ["bash_job:list"], toolCount: 1 }),
      turn("看一下 /e/f.md 这个", { shapes: ["bash_job:list"], toolCount: 1 }),
    ];
    const clusters = clusterTurns(turns).clusters;
    expect(clusters[0]!.skeletons).toEqual(["看一下 <path> 这个"]);
    const res = generateDrafts(clusters, statsOf(turns));
    expect(res.drafts).toHaveLength(0);
    expectSkips(res.skips, { regex: 1 });
  });
  it("mixed cluster: a <path> skeleton counts toward size but never enters strong", () => {
    const turns = [
      turn("后台任务还有 3 个呢", { shapes: ["bash_job:list"], toolCount: 1 }),
      turn("后台任务还有 10 个呢", { shapes: ["bash_job:list"], toolCount: 1 }),
      turn("后台任务还有 /a/b 个呢", { shapes: ["bash_job:list"], toolCount: 1 }),
    ];
    const clusters = clusterTurns(turns).clusters;
    expect(clusters[0]!.size).toBe(3); // the <path> turn is a member
    expect(clusters[0]!.skeletons).toContain("后台任务还有 <path> 个呢");
    const res = generateDrafts(clusters, statsOf(turns));
    expect(res.drafts).toHaveLength(1);
    const strong = res.drafts[0]!.intent.strong;
    expect(strong).toHaveLength(1); // only the <n> skeleton became a template
    expect(strong[0]).toContain("\\d{1,4}");
    expect(JSON.stringify(strong)).not.toContain("<path>");
    expectSkips(res.skips, {});
  });
});

describe("generateDrafts — determinism", () => {
  it("reversing the cluster array yields byte-identical output", () => {
    const turns = [...jobsTurns(), ...fleetTurns(), ...gitTurns()];
    const clusters = clusterTurns(turns).clusters;
    const a = generateDrafts(clusters, statsOf(turns));
    const b = generateDrafts([...clusters].reverse(), statsOf([...turns].reverse()));
    expect(b).toEqual(a);
  });
});

describe("tightenDraft — monotone tightening", () => {
  it("exclude-first: a ≤40cp bad norm is excluded, the branch survives", () => {
    const turns = jobsTurns();
    const draft = generateDrafts(clusterTurns(turns).clusters, statsOf(turns)).drafts[0]!;
    const bad = "后台第 7 个任务呢"; // matches the digits branch, ≤40cp
    const out = tightenDraft(draft, [bad]);
    expect(out.dead).toBeUndefined();
    expect(out.draft!.intent.strong).toEqual(draft.intent.strong);
    expect(out.draft!.intent.exclude).toContain(bad);
    expect(out.excluded).toEqual([bad]);
    expect(out.droppedStrong).toEqual([]);
  });
  it("branch-drop: a >40cp bad norm drops the matching branch", () => {
    const longText = "长".repeat(45); // >40cp cannot be a DRX exclude literal
    const base = jobsDraftBase();
    const draft = { ...base, intent: { ...base.intent, strong: [...base.intent.strong, longText] } };
    expect(draft.intent.strong).toContain(longText);
    const out = tightenDraft(draft, [longText]);
    expect(out.draft!.intent.strong).not.toContain(longText);
    expect(out.draft!.intent.strong.length).toBe(draft.intent.strong.length - 1);
    expect(out.excluded).toEqual([]);
  });
  it("empty-strong death (plain) and exclude-cap death (exclude list already full)", () => {
    const base = jobsDraftBase();
    const digitsBranch = "后台第 \\d{1,4} 个任务呢";
    // ≤40cp bad norm matching the ONLY branch: excluded when there is capacity …
    const draftOne = { ...base, intent: { ...base.intent, strong: [digitsBranch] } };
    const alive = tightenDraft(draftOne, ["后台第 7 个任务呢"]);
    expect(alive.dead).toBeUndefined();
    expect(alive.draft!.intent.exclude).toContain("后台第 7 个任务呢");
    // … branch-dropped (⇒ empty-strong) when the 32 exclude slots are already taken
    const full = Array.from({ length: 32 }, (_, i) => `排除词句编号第${i}号`);
    const draftFull = { ...base, intent: { ...base.intent, strong: [digitsBranch], exclude: full } };
    expect(tightenDraft(draftFull, ["后台第 7 个任务呢"]).dead).toBe("exclude-cap");
    // a >40cp norm matching a >40cp literal branch: exclude impossible ⇒ plain empty-strong
    const longBranch = "唯一模板" + "补".repeat(40);
    const draftLong = { ...base, intent: { ...base.intent, strong: [longBranch] } };
    expect(tightenDraft(draftLong, [longBranch]).dead).toBe("empty-strong");
    // an unrelated >40cp bad norm that matches nothing changes nothing
    expect(tightenDraft(draftLong, ["长".repeat(45) + "x"]).draft).toBeDefined();
  });
  it("monotone: whatever the tightened draft matches high, the original matched high", () => {
    const turns = jobsTurns();
    const draft = generateDrafts(clusterTurns(turns).clusters, statsOf(turns)).drafts[0]!;
    const out = tightenDraft(draft, ["后台第 7 个任务呢", "后台第 9 个任务呢"]);
    const tightened = out.draft!;
    const probes = [
      ...draft.intent.examples.hit,
      "后台第 7 个任务呢",
      "后台第 9 个任务呢",
      "后台第 123 个任务呢",
      "无关句子",
    ];
    const caps = new Set<Capability>(draft.requires);
    for (const probe of probes) {
      const norm = probe;
      const after = compileCatalog([tightened]).match(norm, caps);
      if (after.kind === "hit" && after.band === "high") {
        const before = compileCatalog([draft]).match(norm, caps);
        expect(before.kind === "hit" && before.band === "high").toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// refinement (BD3)
// ---------------------------------------------------------------------------

/** Reference two-layer replay adapter: builtin first, DRAFT LAYER ONLY ON BUILTIN MISS
 *  (BA §4.3), lenient S0, high-only reporting — mirrors what B1/B3 will inject. */
const makeReplayFn = (): ReplayFn => (drafts, turns) => {
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
    const builtin = BUILTIN_MATCHER.match(gate.norm.norm, ALL_CAPS);
    if (builtin.kind === "hit") continue; // builtin high OR ambiguous shadows the draft layer
    const m = matcher.match(gate.norm.norm, ALL_CAPS);
    if (m.kind === "hit" && m.band === "high") out.push({ draftId: m.scriptId, turn: t, band: "high" });
  }
  return out;
};

describe("refineDrafts — negative re-feeding (train-only, BD7)", () => {
  const genJobsDraft = (): { draft: RScriptV1; turns: Turn[] } => {
    const turns = jobsTurns();
    const draft = generateDrafts(clusterTurns(turns).clusters, statsOf(turns)).drafts[0]!;
    return { draft, turns };
  };

  it("a write-turn hit is excluded and the draft survives", () => {
    const { draft, turns } = genJobsDraft();
    const pollution = turn("后台第 7 个任务呢", { shapes: ["edit"], toolCount: 1, hasWrite: true });
    const res = refineDrafts([draft], [...turns, pollution], makeReplayFn());
    expect(res.drafts).toHaveLength(1);
    const refined = res.drafts[0]!;
    assertDraftShape(refined);
    expect(refined.intent.exclude).toContain("后台第 7 个任务呢");
    expect(res.rounds).toBe(1);
    expect(res.misfires).toBe(1);
  });

  it("a diverging turn (tools outside the port signature) is a misfire", () => {
    const { draft, turns } = genJobsDraft();
    const diverge = turn("后台第 5 个任务呢", { shapes: ["get_run_result"], toolCount: 1 });
    const res = refineDrafts([draft], [...turns, diverge], makeReplayFn());
    expect(res.drafts).toHaveLength(1);
    expect(res.drafts[0]!.intent.exclude).toContain("后台第 5 个任务呢");
  });

  it("an agreeing, non-writing hit is NOT a misfire (drafts unchanged, zero rounds)", () => {
    const { draft, turns } = genJobsDraft();
    const res = refineDrafts([draft], turns, makeReplayFn());
    expect(res.drafts).toEqual([draft]);
    expect(res.rounds).toBe(0);
    expect(res.misfires).toBe(0);
    expect(res.skips).toEqual(emptySkips());
  });

  it("a replay that never satisfies drops the draft after maxRounds (low-purity)", () => {
    const { draft, turns } = genJobsDraft();
    const stubborn: ReplayFn = (ds) =>
      ds.map((d) => ({ draftId: d.id, turn: turn("后台第 8 个任务呢", { hasWrite: true }), band: "high" as const }));
    const res = refineDrafts([draft], turns, stubborn, 3);
    expect(res.drafts).toHaveLength(0);
    expectSkips(res.skips, { "low-purity": 1 });
    expect(res.rounds).toBe(3);
  });

  it("ambiguous draft hits are never misfires", () => {
    const { draft, turns } = genJobsDraft();
    const noise: ReplayFn = (ds) =>
      ds.map((d) => ({
        draftId: d.id,
        turn: turn("后台第 6 个任务呢", { hasWrite: true }),
        band: "ambiguous" as const,
      }));
    const res = refineDrafts([draft], turns, noise);
    expect(res.drafts).toEqual([draft]);
  });

  it("throws on non-train turns", () => {
    const { draft, turns } = genJobsDraft();
    expect(() => refineDrafts([draft], [...turns, turn("x", { split: "holdout" })], makeReplayFn())).toThrow(
      /non-train/,
    );
  });

  it("a corrupted draft (failing the final validateDraft belt) is dropped and counted as validate", () => {
    const { draft, turns } = genJobsDraft();
    const corrupted: RScriptV1 = {
      ...draft,
      intent: {
        ...draft.intent,
        examples: { ...draft.intent.examples, hit: [...draft.intent.examples.hit, "完全无关的句子甲"] },
      },
    };
    const verdict = validateDraft(corrupted, BUILTIN_IDS);
    expect("code" in verdict).toBe(true); // rule ⑦ rejects the extra non-high hit
    const res = refineDrafts([corrupted], turns, makeReplayFn());
    expect(res.drafts).toHaveLength(0);
    expectSkips(res.skips, { validate: 1 });
  });
});

/** A valid jobs draft (helpers' makeDraft) for tighten edge cases. */
function jobsDraftBase(): RScriptV1 {
  const turns = jobsTurns();
  return generateDrafts(clusterTurns(turns).clusters, statsOf(turns)).drafts[0]!;
}

describe("needsPort candidates are suggestions, not drafts (K10)", () => {
  it("a toolless-intersecting cluster appears in needsPort and yields zero drafts until assigned", () => {
    const turns = [
      turn("quota 消耗走势如何", { shapes: [], toolCount: 0 }),
      turn("quota 消耗走势如何", { shapes: [], toolCount: 0 }),
      turn("quota 消耗的走势如何", { shapes: [], toolCount: 0 }),
    ];
    const clusters = clusterTurns(turns).clusters;
    const res = generateDrafts(clusters, statsOf(turns));
    expect(res.drafts).toHaveLength(0);
    expect(res.needsPort).toHaveLength(1);
    const cand = res.needsPort[0]!;
    expect(cand.suggestedPort).toBe("quota.summary");
    expect(cand.clusterId).toBe(clusters[0]!.id);
    expect(cand.size).toBe(3);
    expect(cand.skeletons.length).toBeGreaterThanOrEqual(1);
    expectSkips(res.skips, {});
    // with the human assign, the same cluster produces a valid draft
    const assigned = generateDrafts(
      clusters,
      statsOf(turns),
      new Map<string, PortId>([[cand.clusterId, "quota.summary"]]),
    );
    expect(assigned.drafts).toHaveLength(1);
    expect(assigned.drafts[0]!.port.id).toBe("quota.summary");
    assertDraftShape(assigned.drafts[0]!);
    expect(assigned.needsPort).toHaveLength(0);
  });
});
