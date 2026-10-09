import { describe, expect, it } from "vitest";
import { anyLongWriteSince, type LedgerCtxLike } from "../../src/cache-ttl/usage-ledger.js";

function ctxWith(entries: unknown[]): LedgerCtxLike {
  return { sessionManager: { getEntries: () => entries } };
}

function assistantEntry(usage: Record<string, unknown>, timestamp?: number, model = "claude-x") {
  return { type: "message", message: { role: "assistant", model, usage, timestamp } };
}

describe("anyLongWriteSince", () => {
  it("returns true as soon as a cacheWrite1h>0 entry is found scanning backward", () => {
    const entries = [
      assistantEntry({ cacheRead: 1, cacheWrite: 1 }, 100),
      assistantEntry({ cacheRead: 1, cacheWrite: 50, cacheWrite1h: 50 }, 200),
      assistantEntry({ cacheRead: 1, cacheWrite: 1 }, 300),
    ];
    expect(anyLongWriteSince(ctxWith(entries), 50)).toBe(true);
  });

  it("returns false once the scan reaches an entry older than sinceMs with no 1h write found", () => {
    const entries = [
      assistantEntry({ cacheRead: 1, cacheWrite: 1 }, 10), // older than sinceMs=50 — proves false
      assistantEntry({ cacheRead: 1, cacheWrite: 1 }, 100),
      assistantEntry({ cacheRead: 1, cacheWrite: 1 }, 300),
    ];
    expect(anyLongWriteSince(ctxWith(entries), 50)).toBe(false);
  });

  it("a 1h write found before reaching an older-than-sinceMs entry still wins (true checked first per entry)", () => {
    const entries = [
      assistantEntry({ cacheRead: 1, cacheWrite: 1 }, 10), // older than sinceMs, but never reached
      assistantEntry({ cacheRead: 1, cacheWrite: 50, cacheWrite1h: 50 }, 100),
    ];
    expect(anyLongWriteSince(ctxWith(entries), 50)).toBe(true);
  });

  it("non-assistant / usage-less entries are skipped without consuming the scan outcome", () => {
    const entries = [
      { type: "message", message: { role: "user" } },
      { type: "message", message: { role: "toolResult", usage: { cacheWrite1h: 999 } } },
      assistantEntry({ cacheRead: 1, cacheWrite: 1 }, 10),
    ];
    expect(anyLongWriteSince(ctxWith(entries), 50)).toBe(false);
  });

  it("unreadable ledger (not an array) ⇒ unknown", () => {
    expect(anyLongWriteSince({ sessionManager: { getEntries: () => undefined } }, 50)).toBe("unknown");
    expect(anyLongWriteSince(undefined, 50)).toBe("unknown");
  });

  it("getEntries throwing ⇒ unknown, never throws", () => {
    const ctx: LedgerCtxLike = {
      sessionManager: {
        getEntries: () => {
          throw new Error("boom");
        },
      },
    };
    expect(() => anyLongWriteSince(ctx, 50)).not.toThrow();
    expect(anyLongWriteSince(ctx, 50)).toBe("unknown");
  });

  it("exhausting the ledger without crossing sinceMs or finding a 1h write ⇒ unknown (never guessed false)", () => {
    const entries = [assistantEntry({ cacheRead: 1, cacheWrite: 1 }, 200)]; // newer than sinceMs, session has no older history
    expect(anyLongWriteSince(ctxWith(entries), 50)).toBe("unknown");
  });

  it("entries with no timestamp at all never resolve false on their own ⇒ unknown once the ledger runs out", () => {
    const entries = [assistantEntry({ cacheRead: 1, cacheWrite: 1 })]; // timestamp undefined
    expect(anyLongWriteSince(ctxWith(entries), 50)).toBe("unknown");
  });

  it("maxEntries bounds the total entries traversed (zero-hang): a huge ledger with the answer far past the budget ⇒ unknown", () => {
    const entries: unknown[] = [];
    // 500 filler assistant entries (no usage signal either way), all newer than sinceMs.
    for (let i = 0; i < 500; i += 1) entries.push(assistantEntry({ cacheRead: 1, cacheWrite: 1 }, 1_000 + i));
    // The one entry that would answer the question (older than sinceMs) is beyond the 400-entry budget.
    entries.unshift(assistantEntry({ cacheRead: 1, cacheWrite: 1 }, 10));
    expect(anyLongWriteSince(ctxWith(entries), 50, 400)).toBe("unknown");
  });

  it("a smaller maxEntries still finds a 1h write within its own budget", () => {
    const entries = [assistantEntry({ cacheRead: 1, cacheWrite: 10, cacheWrite1h: 10 }, 900)];
    expect(anyLongWriteSince(ctxWith(entries), 50, 1)).toBe(true);
  });

  it("respects a custom maxEntries smaller than the default 400", () => {
    const entries: unknown[] = [];
    for (let i = 0; i < 10; i += 1) entries.push(assistantEntry({ cacheRead: 1, cacheWrite: 1 }, 1_000 + i));
    entries.unshift(assistantEntry({ cacheRead: 1, cacheWrite: 1 }, 10)); // would prove false, but outside maxEntries=5
    expect(anyLongWriteSince(ctxWith(entries), 50, 5)).toBe("unknown");
  });
});
