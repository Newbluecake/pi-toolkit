// dynamic-threshold-plan.md §12 D2 — usage-range（P0-4 / R2-2 / R2-6）：
// T-D2-RANGE-AGG（watermark 区间累加，不是只读最后一条）、T-D2-RANGE-UNKNOWN
// （watermark-lost / no-usage / cost-missing，绝不用 0 冒充未知）、T-D2-RANGE-SAFE（永不抛）。

import { describe, expect, it } from "vitest";
import {
  aggregateAssistantUsageAfter,
  lastBranchEntryId,
  type BranchCtxLike,
} from "../../../src/compact-hint/dynamic/usage-range.js";

interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { total: number } | Record<string, never>;
}

function assistantEntry(id: string, model: string, usage: UsageLike): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-09-25T00:00:00.000Z",
    message: { role: "assistant", model, usage },
  };
}

function userEntry(id: string): unknown {
  return { type: "message", id, parentId: null, timestamp: "t", message: { role: "user", content: "hi" } };
}

function compactionEntry(id: string, costTotal: number): unknown {
  // R2-6：CompactionEntry 自带 usage（生成摘要那次 LLM 调用的账），type 是 "compaction"。
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: "t",
    summary: "…",
    firstKeptEntryId: "e0",
    tokensBefore: 420_000,
    usage: {
      input: 1000,
      output: 200,
      cacheRead: 5000,
      cacheWrite: 800,
      totalTokens: 7000,
      cost: { total: costTotal },
    },
    fromHook: true,
  };
}

const U1: UsageLike = { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 800, cost: { total: 0.01 } };
const U2: UsageLike = { input: 1500, output: 300, cacheRead: 6000, cacheWrite: 900, cost: { total: 0.02 } };
const U3: UsageLike = { input: 2000, output: 400, cacheRead: 7000, cacheWrite: 1000, cost: { total: 0.03 } };

function ctxWith(entries: unknown[]): BranchCtxLike {
  return { sessionManager: { getBranch: () => entries } };
}

describe("aggregateAssistantUsageAfter", () => {
  it("T-D2-RANGE-AGG: accumulates every assistant usage strictly after the watermark (not just the last one)", () => {
    const branch = [
      assistantEntry("a0", "model-a", { ...U1, cost: { total: 5 } }), // watermark 之前：不计入
      compactionEntry("wm", 0.5), // 切换点（watermark）
      assistantEntry("a1", "model-a", U1),
      userEntry("u1"), // 非 assistant：不计入
      assistantEntry("a2", "model-b", U2),
      assistantEntry("a3", "model-b", U3),
      compactionEntry("c9", 0.75), // compaction 条目自带 usage 也不计入（R2-6）
    ];
    const agg = aggregateAssistantUsageAfter(ctxWith(branch), "wm");
    expect(agg.unknownReason).toBeNull();
    expect(agg.turns).toBe(3); // a1/a2/a3，不是只读最后一条
    expect(agg.costUsd).toBeCloseTo(0.06, 12); // 0.01+0.02+0.03；既不是最后一条的 0.03，也不是混入 a0 的 5.06
    expect(agg.cacheRead).toBe(18_000);
    expect(agg.cacheWrite).toBe(2_700);
    // R2-2：firstContextTokens = 第一条的 input+cacheRead+cacheWrite（上下文规模代理）。
    expect(agg.firstContextTokens).toBe(1000 + 5000 + 800);
    expect(agg.firstUsage).toEqual({ input: 1000, output: 200, cacheRead: 5000, cacheWrite: 800 });
    // 跨模型 ⇒ models 去重后 >1（调用方据此标 crossModel，不丢弃数据）。
    expect(agg.models).toEqual(["model-a", "model-b"]);
    expect(agg.lastEntryId).toBe("c9");
  });

  it("T-D2-RANGE-AGG: watermark at the end of the branch aggregates nothing; entries without usage are skipped", () => {
    const branch = [
      assistantEntry("a1", "model-a", U1),
      { type: "message", id: "a2", parentId: null, timestamp: "t", message: { role: "assistant", model: "model-a" } },
      assistantEntry("wm", "model-a", U2),
    ];
    const agg = aggregateAssistantUsageAfter(ctxWith(branch), "wm");
    expect(agg.turns).toBe(0);
    expect(agg.unknownReason).toBe("no-usage");
    expect(agg.costUsd).toBeNull();
  });

  it("T-D2-RANGE-UNKNOWN: watermark not on the branch (or null) ⇒ turns 0, values null, watermark-lost", () => {
    const branch = [assistantEntry("a1", "m", U1), assistantEntry("a2", "m", U2)];
    for (const watermark of ["gone-fork-cut-it", null] as const) {
      const agg = aggregateAssistantUsageAfter(ctxWith(branch), watermark);
      expect(agg.turns).toBe(0);
      expect(agg.unknownReason).toBe("watermark-lost");
      expect(agg.costUsd).toBeNull();
      expect(agg.cacheRead).toBeNull();
      expect(agg.cacheWrite).toBeNull();
      expect(agg.firstContextTokens).toBeNull();
      expect(agg.firstUsage).toBeNull();
      expect(agg.lastEntryId).toBe("a2"); // 分支本身可读，末条目 id 照常给出
    }
  });

  it("T-D2-RANGE-UNKNOWN: any counted entry missing cost.total ⇒ costUsd null + cost-missing, cache sums still given", () => {
    const noCost: UsageLike = { input: 1, output: 1, cacheRead: 10, cacheWrite: 2, cost: {} };
    const branch = [compactionEntry("wm", 0.1), assistantEntry("a1", "m", U1), assistantEntry("a2", "m", noCost)];
    const agg = aggregateAssistantUsageAfter(ctxWith(branch), "wm");
    expect(agg.turns).toBe(2);
    expect(agg.unknownReason).toBe("cost-missing");
    expect(agg.costUsd).toBeNull(); // 绝不用 0 冒充未知
    expect(agg.cacheRead).toBe(5010); // cacheRead/cacheWrite 若都在则照常给出
    expect(agg.cacheWrite).toBe(802);
  });

  it("T-D2-RANGE-UNKNOWN: a single non-finite cacheRead poisons only that sum (null), cost stays known", () => {
    const badRead: UsageLike = { input: 1, output: 1, cacheRead: Number.NaN, cacheWrite: 2, cost: { total: 0.01 } };
    const branch = [compactionEntry("wm", 0.1), assistantEntry("a1", "m", U1), assistantEntry("a2", "m", badRead)];
    const agg = aggregateAssistantUsageAfter(ctxWith(branch), "wm");
    expect(agg.turns).toBe(2);
    expect(agg.unknownReason).toBeNull();
    expect(agg.costUsd).toBeCloseTo(0.02, 12);
    expect(agg.cacheRead).toBeNull(); // 未知 ⇒ null，不是 0
    expect(agg.cacheWrite).toBe(802);
  });

  it("T-D2-RANGE-UNKNOWN: first entry with incomplete quad ⇒ firstUsage/firstContextTokens null, never backfilled by later entries", () => {
    const partial: UsageLike = { input: 700, output: 1, cacheRead: 1, cacheWrite: Number.NaN, cost: { total: 0.01 } };
    const branch = [compactionEntry("wm", 0.1), assistantEntry("a1", "m", partial), assistantEntry("a2", "m", U1)];
    const agg = aggregateAssistantUsageAfter(ctxWith(branch), "wm");
    expect(agg.firstUsage).toBeNull();
    expect(agg.firstContextTokens).toBeNull(); // 第一条三字段不全 ⇒ null；不用第二条补位
    expect(agg.turns).toBe(2);
  });

  it("T-D2-RANGE-SAFE: ctx missing / sessionManager missing / getBranch throws / non-array ⇒ never throws, all null", () => {
    const cases: Array<BranchCtxLike | undefined> = [
      undefined,
      {},
      { sessionManager: {} },
      {
        sessionManager: {
          getBranch: () => {
            throw new Error("boom");
          },
        },
      },
      { sessionManager: { getBranch: () => "not-an-array" } },
      { sessionManager: { getBranch: () => ({ length: 3 }) } },
    ];
    for (const ctx of cases) {
      expect(() => aggregateAssistantUsageAfter(ctx, "wm")).not.toThrow();
      const agg = aggregateAssistantUsageAfter(ctx, "wm");
      expect(agg.turns).toBe(0);
      expect(agg.unknownReason).toBe("watermark-lost");
      expect(agg.costUsd).toBeNull();
      expect(agg.cacheRead).toBeNull();
      expect(agg.cacheWrite).toBeNull();
      expect(agg.firstContextTokens).toBeNull();
      expect(agg.firstUsage).toBeNull();
      expect(agg.models).toEqual([]);
      expect(agg.lastEntryId).toBeNull();
    }
  });

  it("T-D2-RANGE-SAFE: entries with malformed shapes are skipped without throwing", () => {
    const branch: unknown[] = [
      compactionEntry("wm", 0.1),
      null,
      42,
      { type: "message", id: "x1" }, // 无 message
      { type: "message", id: "x2", message: { role: "assistant", usage: "garbage" } }, // 非对象 usage
      { type: "message", id: "x3", message: { role: "assistant", usage: U1 } }, // 正常
    ];
    const agg = aggregateAssistantUsageAfter(ctxWith(branch), "wm");
    expect(agg.turns).toBe(1);
    expect(agg.costUsd).toBeCloseTo(0.01, 12);
  });
});

describe("lastBranchEntryId (watermark source, §5.5)", () => {
  it("returns the trailing entry id, skipping malformed tails; null when unreadable", () => {
    expect(lastBranchEntryId(ctxWith([compactionEntry("c1", 0)]))).toBe("c1");
    expect(lastBranchEntryId(ctxWith([assistantEntry("a1", "m", U1), { type: "message" }]))).toBe("a1");
    expect(lastBranchEntryId(ctxWith([]))).toBeNull();
    expect(lastBranchEntryId(undefined)).toBeNull();
    expect(
      lastBranchEntryId({
        sessionManager: {
          getBranch: () => {
            throw new Error("x");
          },
        },
      }),
    ).toBeNull();
  });
});
