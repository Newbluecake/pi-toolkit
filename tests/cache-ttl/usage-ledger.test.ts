import { describe, expect, it } from "vitest";
import {
  prefixFromLedger,
  readLatestAssistantCacheTokens,
  readLatestAssistantUsage,
  type LedgerCtxLike,
} from "../../src/cache-ttl/usage-ledger.js";

function ctxWith(entries: unknown[]): LedgerCtxLike {
  return { sessionManager: { getEntries: () => entries } };
}

function assistantEntry(usage: Record<string, unknown>, model = "claude-x") {
  return { type: "message", message: { role: "assistant", model, usage } };
}

describe("readLatestAssistantUsage", () => {
  it("reads cacheRead/cacheWrite/cacheWrite1h from the last assistant message, with anchoring fields", () => {
    const entries = [
      { type: "message", message: { role: "user" } },
      assistantEntry({ cacheRead: 100, cacheWrite: 20, cacheWrite1h: 20, cost: { total: 0.42 } }),
      { type: "message", message: { role: "toolResult", usage: { cacheRead: 999 } } },
      assistantEntry({ cacheRead: 400, cacheWrite: 5 }, "claude-y"),
    ];
    expect(readLatestAssistantUsage(ctxWith(entries))).toEqual({
      source: "usage",
      cacheRead: 400,
      cacheWrite: 5,
      cacheWrite1h: undefined,
      costTotalUsd: undefined,
      cacheWriteUsd: undefined,
      entrySeq: 3,
      entriesLength: 4,
      modelId: "claude-y",
    });
  });

  it("reads cost.cacheWrite into cacheWriteUsd with the same finite() guard as costTotalUsd", () => {
    const withCost = readLatestAssistantUsage(
      ctxWith([assistantEntry({ cacheRead: 100, cacheWrite: 20, cost: { total: 0.42, cacheWrite: 0.16 } })]),
    );
    expect(withCost.costTotalUsd).toBe(0.42);
    expect(withCost.cacheWriteUsd).toBe(0.16);
    // malformed / absent cost object ⇒ undefined (the USD gate then falls back to tokens)
    expect(
      readLatestAssistantUsage(ctxWith([assistantEntry({ cacheRead: 1, cacheWrite: 2, cost: "nope" })])).cacheWriteUsd,
    ).toBeUndefined();
    expect(
      readLatestAssistantUsage(ctxWith([assistantEntry({ cacheRead: 1, cacheWrite: 2, cost: { total: 0.1 } })]))
        .cacheWriteUsd,
    ).toBeUndefined();
    expect(
      readLatestAssistantUsage(ctxWith([assistantEntry({ cacheRead: 1, cacheWrite: 2 })])).cacheWriteUsd,
    ).toBeUndefined();
  });

  it("cacheWrite1h missing ⇒ undefined (distinguishable from a reported 0)", () => {
    const missing = readLatestAssistantUsage(ctxWith([assistantEntry({ cacheRead: 1, cacheWrite: 2 })]));
    expect(missing.cacheWrite1h).toBeUndefined();
    const reportedZero = readLatestAssistantUsage(
      ctxWith([assistantEntry({ cacheRead: 1, cacheWrite: 2, cacheWrite1h: 0 })]),
    );
    expect(reportedZero.cacheWrite1h).toBe(0);
  });

  it("degrades to source=unknown on no entries / throwing getEntries / non-array, never throws", () => {
    expect(readLatestAssistantUsage(undefined).source).toBe("unknown");
    expect(readLatestAssistantUsage({}).source).toBe("unknown");
    expect(readLatestAssistantUsage(ctxWith([]))).toEqual(
      expect.objectContaining({ source: "unknown", entrySeq: -1, entriesLength: 0, modelId: "" }),
    );
    expect(readLatestAssistantUsage({ sessionManager: { getEntries: () => "nope" } }).source).toBe("unknown");
    expect(
      readLatestAssistantUsage({
        sessionManager: {
          getEntries: () => {
            throw new Error("stale ctx");
          },
        },
      }).source,
    ).toBe("unknown");
  });

  it("keeps the real entriesLength even when no assistant usage exists yet (pending snapshot anchor)", () => {
    const entries = [{ type: "message", message: { role: "user" } }, { type: "custom" }];
    expect(readLatestAssistantUsage(ctxWith(entries))).toEqual(
      expect.objectContaining({ source: "unknown", entriesLength: 2 }),
    );
  });

  it("modelId is empty when the entry carries no model string (M1: empty never matches a real model id)", () => {
    const entries = [{ type: "message", message: { role: "assistant", usage: { cacheRead: 1, cacheWrite: 1 } } }];
    expect(readLatestAssistantUsage(ctxWith(entries)).modelId).toBe("");
  });

  it("compaction entries are skipped but do not hide older assistant entries (M1 root-cause fixture)", () => {
    // pi's compaction APPENDS a compaction entry; the pre-compact assistant entry stays readable.
    const entries = [assistantEntry({ cacheRead: 300, cacheWrite: 10 }), { type: "compaction" }];
    const ledger = readLatestAssistantUsage(ctxWith(entries));
    expect(ledger).toEqual(expect.objectContaining({ source: "usage", entrySeq: 0, cacheRead: 300 }));
  });
});

describe("readLatestAssistantCacheTokens / prefixFromLedger (regression: byte-for-byte pre-extraction behaviour)", () => {
  it("sums cacheRead+cacheWrite of the last assistant usage entry", () => {
    expect(readLatestAssistantCacheTokens(ctxWith([assistantEntry({ cacheRead: 100, cacheWrite: 23 })]))).toEqual({
      tokens: 123,
      source: "usage",
    });
  });

  it("unknown on anything unreadable", () => {
    expect(readLatestAssistantCacheTokens(undefined)).toEqual({ tokens: 0, source: "unknown" });
    expect(readLatestAssistantCacheTokens(ctxWith([]))).toEqual({ tokens: 0, source: "unknown" });
    expect(prefixFromLedger(readLatestAssistantUsage(undefined))).toEqual({ tokens: 0, source: "unknown" });
  });
});
