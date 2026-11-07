// J1 (jev-plan §4 J1 / §2 freeze table): constants, customType literals
// (I7) and wire-shape sanity for the frozen contracts.

import { describe, expect, it } from "vitest";
import {
  INLINE_META_MAX_BYTES,
  MEMORY_INJECT_CUSTOM_TYPE,
  MEMORY_RECALL_CUSTOM_TYPE,
  MAX_ENABLED_TAGS,
  HEALTH_TABLE_MAX,
  QUESTION_BATCH_TOKENS,
  RECALL_MAX_CANDIDATES,
  SEGMENT_MAX_INJECTED,
  SIDECAR_MAX_BYTES,
  SIDECAR_MAX_ENTRIES,
  TOKEN_BUCKET_CAPACITY,
  TOKEN_BUCKET_WINDOW_MS,
  type DismissedPair,
  type EntryTags,
  type InlineMeta,
  type InjectLayer,
  type JevRenderInfo,
  type JevWritePort,
  type MemEntry,
  type MemoryInjectDetailsV1,
  type PredictCallEntry,
  type RelationVerdict,
  type ReviewSuggestion,
} from "../../../src/memory/jev/contracts.js";

describe("frozen constants (jev-plan §2)", () => {
  it("carry the architecture's numeric values", () => {
    expect(RECALL_MAX_CANDIDATES).toBe(360);
    expect(QUESTION_BATCH_TOKENS).toBe(12_000);
    expect(SEGMENT_MAX_INJECTED).toBe(30);
    expect(HEALTH_TABLE_MAX).toBe(32);
    expect(TOKEN_BUCKET_CAPACITY).toBe(30);
    expect(TOKEN_BUCKET_WINDOW_MS).toBe(60_000);
    expect(SIDECAR_MAX_ENTRIES).toBe(2000);
    expect(SIDECAR_MAX_BYTES).toBe(1_000_000);
    expect(MAX_ENABLED_TAGS).toBe(64);
    expect(INLINE_META_MAX_BYTES).toBe(200);
  });

  it("I7: runtime names keep the subagent: prefix and never move", () => {
    expect(MEMORY_INJECT_CUSTOM_TYPE).toBe("subagent:memory-inject");
    expect(MEMORY_RECALL_CUSTOM_TYPE).toBe("subagent:memory-recall");
  });
});

describe("frozen wire shapes compile and discriminate", () => {
  it("JevStatus variants and the off reasons", async () => {
    const { formatStatusLine } = await import("../../../src/memory/jev/format.js");
    const cov = { tagged: 0, total: 0 };
    expect(formatStatusLine({ kind: "probing" }, cov)).toBe("jev: probing");
    expect(formatStatusLine({ kind: "full", model: "m" }, cov)).toBe("jev: full · m");
    expect(formatStatusLine({ kind: "partial", reason: "x", inactive: true }, cov)).toContain("inactive");
    expect(formatStatusLine({ kind: "off", reason: "empty-list" }, cov)).toContain("empty classifier list");
  });

  it("JevOutcome / JevRequest discriminated unions accept their members", async () => {
    const mod = await import("../../../src/memory/jev/contracts.js");
    const ok: mod.JevOutcome = { ok: true, model: "m", answers: {}, missing: [], costUsd: 0, latencyMs: 1 };
    const bad: mod.JevOutcome = { ok: false, reason: "all-failed", detail: "d" };
    expect([ok.ok, bad.ok]).toEqual([true, false]);
    const req: mod.JevRequest = {
      duty: "recall",
      registry: {},
      state: {},
      questions: {},
      budgetMs: 2500,
      mode: "sync",
    };
    expect(req.mode).toBe("sync");
    const patch: mod.IndexPatch = { upsert: {}, remove: [], lastTaggedAt: "t" };
    expect(patch.remove).toEqual([]);
  });
});

// ───────────────────── #36 memory-governance plan §4 P0（arch r5 §4.4） ─────────────────────

describe("#36 P0 contract increments", () => {
  it("JevWritePort keeps the legacy call form: no block/askScope in, no relations out", async () => {
    const seen: string[] = [];
    const port: JevWritePort = {
      // 旧调用形式（v2 路径）不传 block/askScope 也必须可编译、可返回 ——
      // 消费方不读 relations 时返回值不含它，行为与 HEAD 一致。
      async afterWrite(input) {
        seen.push(input.file);
        return { echo: ["tagged"], usage: { costUsd: 0, calls: 1 } };
      },
      checkInline: () => undefined,
      touchedUserEntries: () => [],
    };
    const out = await port.afterWrite({
      cwd: "/w",
      file: "core.md",
      before: undefined,
      after: "- new entry\n",
      registry: undefined,
    });
    expect(seen).toEqual(["core.md"]);
    expect(out.echo).toEqual(["tagged"]);
    expect(out.relations).toBeUndefined();
    expect(out.usage).toEqual({ costUsd: 0, calls: 1 });
  });

  it("JevWritePort accepts the #36 v3 call form (block + askScope) and returns relations", async () => {
    const verdict: RelationVerdict = {
      kind: "supersedes",
      newId: "quota.012",
      newRev: "rev-2",
      oldId: "quota.007",
      oldRev: "rev-1",
      p: 0.92,
      auto: true,
    };
    const port: JevWritePort = {
      async afterWrite(input) {
        expect(input.block?.id).toBe("quota.012");
        expect(input.block?.scopeExplicit).toBe(false);
        expect(input.askScope).toBe(true);
        return { echo: [], relations: [verdict] };
      },
      checkInline: () => undefined,
      touchedUserEntries: () => [],
    };
    const out = await port.afterWrite({
      cwd: "/w",
      file: "quota.012.md",
      before: "- old\n",
      after: "- new\n",
      registry: undefined,
      block: { id: "quota.012", rev: "rev-2", authority: "user", scopeExplicit: false },
      askScope: true,
    });
    expect(out.relations).toEqual([verdict]);
  });

  it("MemEntry.block carries no heading key (r5 裁定 6 — heading lives on MemEntry.heading)", () => {
    // 编译期拒绝 block.heading。注：仓库 typecheck（tsconfig*.json）不覆盖
    // tests/**，此 @ts-expect-error 不进 CI 门禁 —— 它的准确性由一次性手工
    // tsc 核验（见 P0 交付报告）；下面的运行期形状断言作双保险。
    const rejected: NonNullable<MemEntry["block"]> = {
      id: "quota.007",
      status: "active",
      updated: "2026-11-06T00:00:00.000Z",
      // @ts-expect-error — #36 裁定 6：block 上不存在 heading（编译期拒绝）
      heading: "A › B",
    };
    void rejected;
    const block: NonNullable<MemEntry["block"]> = {
      id: "quota.007",
      scope: "global",
      audience: "all",
      status: "active",
      supersededBy: "quota.012",
      snapshot: true,
      updated: "2026-11-06T00:00:00.000Z",
    };
    expect("heading" in block).toBe(false);
    expect(Object.keys(block).sort()).toEqual([
      "audience",
      "id",
      "scope",
      "snapshot",
      "status",
      "supersededBy",
      "updated",
    ]);
  });

  it("wire shapes accept the #36 additions: R layer, resident ledger, predict.bypass, PredictCallEntry", () => {
    const layer: InjectLayer = "R";
    expect(layer).toBe("R");
    const details: MemoryInjectDetailsV1 = {
      v: 1,
      layer: "R",
      trigger: "resident-diff",
      items: [],
      predict: { tags: ["git-commit"], origin: "rules", bypass: true },
      resident: {
        snapshotKey: "sha1-abc",
        ledger: [
          ["quota.007", "rk-1"],
          ["quota.012", "rk-2"],
        ],
      },
    };
    expect(details.resident?.ledger).toEqual([
      ["quota.007", "rk-1"],
      ["quota.012", "rk-2"],
    ]);
    expect(details.predict?.bypass).toBe(true);
    // 不带新字段的旧形状仍然合法（append-only）。
    const legacyDetails: MemoryInjectDetailsV1 = {
      v: 1,
      layer: "U",
      trigger: "turn-start",
      items: [],
      predict: { tags: [], origin: "rules" },
    };
    expect(legacyDetails.resident).toBeUndefined();
    const call: PredictCallEntry = {
      v: 1,
      kind: "call",
      at: "2026-11-06T00:00:00.000Z",
      model: "deepseek/deepseek-flash",
      ms: 1500,
      ok: true,
      reserveUsd: 0,
      costUsd: 0,
      costSource: "usage",
      timely: true,
      windowMs: 1000,
      attempts: 1,
    };
    expect(call.windowMs).toBe(1000);
    expect(call.attempts).toBe(1);
    const legacyCall: PredictCallEntry = {
      v: 1,
      kind: "call",
      at: "2026-11-06T00:00:00.000Z",
      model: "deepseek/deepseek-flash",
      ms: 500,
      ok: false,
      reason: "timeout",
      reserveUsd: 0.001,
      costUsd: 0.001,
      costSource: "reserve",
      timely: false,
    };
    expect(legacyCall.windowMs).toBeUndefined();
  });

  it("sidecar shapes accept the #36 additions: globalP, new review kinds, dismissed kind/until, InlineMeta keys", async () => {
    const mod = await import("../../../src/memory/jev/contracts.js");
    const tags: EntryTags = {
      file: "quota.007.md",
      type: "rule",
      typeP: 0.9,
      importance: 2,
      tags: {},
      guard: 0,
      temporal: "permanent",
      userLike: 0.1,
      model: "opencode/jev-1.13-free",
      at: "2026-11-06T00:00:00.000Z",
      taxonomyRev: "r1",
      globalP: 0.8,
    };
    expect(tags.globalP).toBe(0.8);
    const dismissed: DismissedPair = { hashKey: "a+b", anchorKey: "x+y", kind: "scope-check", until: "2026-12-01" };
    expect(dismissed.kind).toBe("scope-check");
    const legacyDismissed: DismissedPair = { hashKey: "a+b", anchorKey: "x+y" };
    expect(legacyDismissed.kind).toBeUndefined();
    // 全部 8 个新增 kind 都属于联合类型（5 旧 + 8 新 = 13）。
    const newKinds = [
      "expired-user",
      "until-check",
      "snapshot",
      "pointer",
      "oversize",
      "resident-budget",
      "scope-check",
      "legacy-drift",
    ] as const;
    for (const kind of newKinds) {
      const suggestion: ReviewSuggestion = {
        id: `s-${kind}`,
        kind,
        a: { hash: "h1", anchor: "quota.007.md|quota|first 24" },
        p: 0.9,
        at: "2026-11-06T00:00:00.000Z",
      };
      expect(suggestion.kind).toBe(kind);
    }
    const meta: InlineMeta = {
      present: true,
      scope: "global",
      audience: "main",
      supersedes: ["quota.007"],
      title: "发版分支策略",
      when: "改动发版流程时",
      clearExpires: true,
      clearUntil: true,
    };
    expect(meta.scope).toBe("global");
    const render: JevRenderInfo = { omittedSections: [], coreInlined: false, residentBlocks: ["quota.007"] };
    expect(render.residentBlocks).toEqual(["quota.007"]);
  });
});
