/**
 * jev-reflex · #25 B2 clustering (BA §4.4 step 2): skeletonization, Jaccard tokens, port
 * labeling, and the train-only guard. Fixture turns come from the B0 shared constructors.
 */
import { describe, expect, it } from "vitest";
import { compileCatalog } from "../../../../src/reflex/core/match.js";
import { BUILTIN_SCRIPTS } from "../../../../src/reflex/core/catalog.js";
import type { PortId, Turn } from "../../../../src/reflex/core/types.js";
import {
  CLUSTER_JACCARD,
  SKELETON_N,
  SKELETON_PATH,
  SKELETON_Q,
  clusterTurns,
  portLabel,
  skeletonTokens,
  skeletonize,
} from "../../../../src/reflex/core/backtest/cluster.js";
import { makeTurn } from "../../helpers/turn.js";

let seq = 0;
const turn = (text: string, over: Partial<Turn> = {}): Turn =>
  makeTurn({
    session: over.session ?? "s1",
    entryId: over.entryId ?? `e${(seq += 1)}`,
    text,
    ...over,
  });

describe("skeletonize", () => {
  it("collapses paths wholesale (digits inside included)", () => {
    expect(skeletonize("看一下 src/v2/a.ts 这个")).toBe("看一下 <path> 这个");
    expect(skeletonize("打开 /home/u/proj/x.md")).toBe("打开 <path>");
    expect(skeletonize("编译 ~/pi/p.ts 和 ./b.ts")).toBe("编译 <path> 和 <path>");
    expect(skeletonize("访问 https://a.b/c?d=1")).toBe("访问 <path>");
  });
  it("collapses quoted spans (ASCII + CJK quotes)", () => {
    expect(skeletonize('把 "任意内容" 讲一下')).toBe("把 <q> 讲一下");
    expect(skeletonize("改「引号里的话」")).toBe("改<q>");
    expect(skeletonize("看“这段”")).toBe("看<q>");
  });
  it("collapses digit runs to <n>", () => {
    expect(skeletonize("后台第 3 个 job")).toBe("后台第 <n> 个 job");
    expect(skeletonize("2024-11-05 有多少")).toBe("<n>-<n>-<n> 有多少");
    expect(skeletonize("第10086个任务")).toBe("第<n>个任务");
  });
  it("order: paths before digits, quotes absorb their contents; plain text is unchanged", () => {
    expect(skeletonize("后台任务状态如何")).toBe("后台任务状态如何");
    expect(skeletonize("第 3 个")).toBe("第 <n> 个");
  });
  it("a literal <n>/<path>/<q> typed by the user never becomes a placeholder", () => {
    expect(skeletonize("<n> 是什么意思")).toBe("〈n〉 是什么意思");
    expect(skeletonize("<path> 呢")).toBe("〈path〉 呢");
  });
});

describe("skeletonTokens", () => {
  it("placeholders are single tokens; CJK runs give unigrams+bigrams; ascii runs whole words", () => {
    expect(skeletonTokens("<n> 个 job")).toEqual(["<n>", "个", "job"]);
    expect(skeletonTokens("第 个")).toEqual(["第", "个"]); // single-CJK runs: unigrams only
  });
  it("CJK runs longer than 1 contribute unigrams and bigrams", () => {
    expect(skeletonTokens("用得怎么样")).toEqual(["用", "得", "怎", "么", "样", "用得", "得怎", "怎么", "么样"]);
  });
});

describe("portLabel — signed ports only, exactly-one signature", () => {
  const label = (shapes: readonly string[], toolCount = shapes.length, hasWrite = false): PortId | undefined =>
    portLabel({ shapes, toolCount, hasWrite });

  it("a single-signature hit labels the port", () => {
    expect(label(["bash_job:list"])).toBe("jobs.list");
    expect(label(["bash_job:status", "bash_job:list"], 2)).toBe("jobs.list");
    expect(label(["get_run_result"])).toBe("fleet.status");
    expect(label(["git status"])).toBe("git.status");
    expect(label(["git diff", "git status"], 2)).toBe("git.status");
  });
  it("two signatures is not a label; write turns and >3 tools never label", () => {
    expect(label(["bash_job:list", "get_run_result"], 2)).toBeUndefined();
    expect(label(["bash_job:list"], 1, true)).toBeUndefined();
    expect(label(["bash_job:list", "bash_job:status", "bash_job:list", "bash_job:status"], 4)).toBeUndefined();
  });
  it("empty shapes (the toolless-port shape) never label — TOOLLESS is never auto-assigned", () => {
    expect(label([])).toBeUndefined();
  });
});

describe("clusterTurns — train guard and candidate filter", () => {
  it("throws on any non-train turn (BD7/U3)", () => {
    expect(() => clusterTurns([turn("后台还有几个 job", { split: "holdout" })])).toThrow(/non-train/);
    expect(() => clusterTurns([turn("x", { split: "unscored" })])).toThrow(/non-train/);
  });
  it("counts non-candidates: origin, veto, builtin-high", () => {
    const turns = [
      turn("后台还有几个 job", { origin: "web" }), // origin
      turn("帮我看一下这个问题"), // veto (imperative)
      turn("后台还有几个 job"), // builtin high (jobs.list strong)
      turn("现在有 3 个 agent 在跑吗"), // candidate (digit skeleton, fleet-flavoured)
    ];
    const res = clusterTurns(turns);
    expect(res.nonCandidates).toEqual({ origin: 1, veto: 1, builtinHigh: 1 });
    expect(res.clusters).toHaveLength(1);
    expect(res.clusters[0]!.size).toBe(1);
    expect(res.clusters[0]!.skeletons).toEqual(["现在有 <n> 个 agent 在跑吗"]);
  });
  it("builtin-ambiguous (weak-only) turns ARE candidates", () => {
    const res = clusterTurns([turn("job 是什么意思"), turn("job 是什么意思")]);
    expect(res.clusters).toHaveLength(1); // weak "job" hit ⇒ ambiguous ⇒ candidate
  });
});

describe("clusterTurns — grouping and determinism", () => {
  const quotaTurns = (): Turn[] => [
    turn("quota 用得怎么样", { session: "s1", entryId: "e1" }),
    turn("quota 今天用得怎么样", { session: "s1", entryId: "e2" }),
    turn("quota 这周用得怎么样", { session: "s2", entryId: "e3" }),
    turn("额度最近消耗快吗", { session: "s2", entryId: "e4" }),
    turn("fleet 的状态呢", { session: "s3", entryId: "e5" }), // unrelated — its own cluster
  ];

  it("paraphrases with shared cores join; unrelated split; identical texts share one skeleton", () => {
    const res = clusterTurns(quotaTurns());
    const quotaCluster = res.clusters.find((c) => c.leader.startsWith("quota"));
    expect(quotaCluster).toBeDefined();
    // 额度最近消耗快吗 shares too few tokens with the quota-用得怎么样 family
    expect(quotaCluster!.skeletons).not.toContain("额度最近消耗快吗");
    expect(res.clusters.length).toBeGreaterThanOrEqual(3);
    expect(res.clusters.every((c) => c.id.startsWith("c"))).toBe(true);
  });

  it("identical norms land in one skeleton bucket and count toward size", () => {
    const res = clusterTurns([
      turn("后台第 3 个 job 呢", { entryId: "a" }),
      turn("后台第 10 个 job 呢", { entryId: "b" }),
      turn("后台第 2 个 job 呢", { entryId: "c" }),
    ]);
    expect(res.clusters).toHaveLength(1);
    expect(res.clusters[0]!.skeletons).toEqual(["后台第 <n> 个 job 呢"]);
    expect(res.clusters[0]!.size).toBe(3);
  });

  it("deterministic: shuffled input produces byte-identical clusters", () => {
    const a = clusterTurns(quotaTurns());
    const b = clusterTurns([...quotaTurns()].reverse());
    expect(b).toEqual(a);
    const c = clusterTurns(quotaTurns());
    expect(c).toEqual(a);
  });

  it("cluster ids are content-derived and distinct", () => {
    const res = clusterTurns(quotaTurns());
    const ids = res.clusters.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("clusterTurns — builtin matcher injection", () => {
  it("a custom matcher that misses everything keeps builtin-strong turns as candidates", () => {
    const noBuiltin = compileCatalog([]);
    const res = clusterTurns([turn("后台还有几个 job"), turn("后台还有几个 job")], { matcher: noBuiltin });
    expect(res.nonCandidates.builtinHigh).toBe(0);
    expect(res.clusters).toHaveLength(1);
  });
  it("default jaccard is the BA threshold", () => {
    expect(CLUSTER_JACCARD).toBe(0.6);
  });
  it("skeletons containing <path>/<q> still cluster (they just cannot become strong templates)", () => {
    const res = clusterTurns([turn("看一下 /a/b.ts 这个"), turn("看一下 /c/d.ts 这个"), turn("看一下 /e/f.txt 这个")]);
    expect(res.clusters).toHaveLength(1);
    expect(res.clusters[0]!.skeletons).toEqual(["看一下 <path> 这个"]);
    expect(res.clusters[0]!.leader).toContain(SKELETON_PATH);
    expect(SKELETON_Q).toBe("<q>");
    expect(SKELETON_N).toBe("<n>");
    void BUILTIN_SCRIPTS; // imported for the catalogue reality of the default matcher
  });
});
