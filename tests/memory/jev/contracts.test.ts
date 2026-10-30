// J1 (jev-plan §4 J1 / §2 freeze table): constants, customType literals
// (I7) and wire-shape sanity for the frozen contracts.

import { describe, expect, it } from "vitest";
import {
  INLINE_META_MAX_BYTES,
  MEMORY_INJECT_CUSTOM_TYPE,
  MEMORY_RECALL_CUSTOM_TYPE,
  MAX_ENABLED_TAGS,
  HEALTH_TABLE_MAX,
  PROC_CACHE_MS,
  PROC_MAX_PIDS,
  QUESTION_BATCH_TOKENS,
  RECALL_MAX_CANDIDATES,
  SEGMENT_MAX_INJECTED,
  SIDECAR_MAX_BYTES,
  SIDECAR_MAX_ENTRIES,
  TOKEN_BUCKET_CAPACITY,
  TOKEN_BUCKET_WINDOW_MS,
  VERDICT_CACHE_MAX,
  VERDICT_CACHE_TTL_MS,
} from "../../../src/memory/jev/contracts.js";

describe("frozen constants (jev-plan §2)", () => {
  it("carry the architecture's numeric values", () => {
    expect(RECALL_MAX_CANDIDATES).toBe(360);
    expect(QUESTION_BATCH_TOKENS).toBe(12_000);
    expect(VERDICT_CACHE_MAX).toBe(64);
    expect(VERDICT_CACHE_TTL_MS).toBe(10 * 60_000);
    expect(SEGMENT_MAX_INJECTED).toBe(30);
    expect(HEALTH_TABLE_MAX).toBe(32);
    expect(TOKEN_BUCKET_CAPACITY).toBe(30);
    expect(TOKEN_BUCKET_WINDOW_MS).toBe(60_000);
    expect(SIDECAR_MAX_ENTRIES).toBe(2000);
    expect(SIDECAR_MAX_BYTES).toBe(1_000_000);
    expect(MAX_ENABLED_TAGS).toBe(64);
    expect(PROC_MAX_PIDS).toBe(4096);
    expect(PROC_CACHE_MS).toBe(2_000);
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
      duty: "gate",
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
