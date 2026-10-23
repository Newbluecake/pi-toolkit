// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  estimateSnapshotBytes,
  PreviewHistoryBudget,
  PREVIEW_HISTORY_BUDGET_DESKTOP,
  PREVIEW_HISTORY_BUDGET_TOUCH,
  historyBudgetFor,
} from "../../../src/web-hub/ui/src/logic/previewHistoryBudget.js";

/** web-hub-preview-windows plan r2 §4.5 (评审 #11, W1): the global cross-window FIFO budget. */

describe("logic/previewHistoryBudget: constants", () => {
  it("96 MiB desktop / 32 MiB touch (§4.5)", () => {
    expect(PREVIEW_HISTORY_BUDGET_DESKTOP).toBe(96 * 1024 * 1024);
    expect(PREVIEW_HISTORY_BUDGET_TOUCH).toBe(32 * 1024 * 1024);
    expect(historyBudgetFor(false)).toBe(PREVIEW_HISTORY_BUDGET_DESKTOP);
    expect(historyBudgetFor(true)).toBe(PREVIEW_HISTORY_BUDGET_TOUCH);
  });
});

describe("logic/previewHistoryBudget: FIFO eviction", () => {
  it("over budget ⇒ the OLDEST entries are demoted (stub called), newest survive", () => {
    const b = new PreviewHistoryBudget(130);
    const stubs: Array<[number, number]> = [];
    const stub = (winId: number) => (token: number) => stubs.push([winId, token]);
    b.add({ winId: 1, token: 1, bytes: 60, stub: stub(1) });
    b.add({ winId: 1, token: 2, bytes: 60, stub: stub(1) });
    expect(b.bytes).toBe(120); // exactly at budget — no eviction yet
    expect(stubs).toEqual([]);
    b.add({ winId: 2, token: 1, bytes: 60, stub: stub(2) });
    expect(stubs).toEqual([[1, 1]]); // the oldest (win 1 token 1) went first
    expect(b.count).toBe(2);
    expect(b.bytes).toBe(120); // (1,2) + (2,1) survive — ids do not collide
  });

  it("a single entry larger than the whole budget demotes itself", () => {
    const b = new PreviewHistoryBudget(10);
    const stubs: number[] = [];
    b.add({ winId: 3, token: 7, bytes: 10_000, stub: (t) => stubs.push(t) });
    expect(stubs).toEqual([7]);
    expect(b.count).toBe(0);
    expect(b.bytes).toBe(0);
  });

  it("under budget nothing is ever demoted", () => {
    const b = new PreviewHistoryBudget(1000);
    const stub = vi.fn();
    for (let i = 0; i < 50; i++) b.add({ winId: 1, token: i, bytes: 10, stub });
    expect(stub).not.toHaveBeenCalled();
    expect(b.bytes).toBe(500);
  });

  it("a throwing stub callback never breaks the ledger", () => {
    const b = new PreviewHistoryBudget(5);
    b.add({
      winId: 1,
      token: 1,
      bytes: 100,
      stub: () => {
        throw new Error("boom");
      },
    });
    expect(b.count).toBe(0);
    expect(b.bytes).toBe(0);
    b.add({ winId: 2, token: 1, bytes: 1, stub: () => {} }); // still usable
    expect(b.count).toBe(1);
  });
});

describe("logic/previewHistoryBudget: remove / dropWindow", () => {
  it("remove(winId, token) releases exactly that entry (tokens are per-window counters)", () => {
    const b = new PreviewHistoryBudget(1000);
    const stub = vi.fn();
    b.add({ winId: 1, token: 1, bytes: 100, stub });
    b.add({ winId: 2, token: 1, bytes: 100, stub });
    b.remove(2, 1);
    expect(b.count).toBe(1);
    expect(b.bytes).toBe(100);
    b.remove(2, 1); // idempotent / unknown no-op
    b.remove(9, 9);
    expect(b.count).toBe(1);
  });

  it("a removed entry is never stubbed afterwards", () => {
    const b = new PreviewHistoryBudget(150);
    const stub1 = vi.fn();
    b.add({ winId: 1, token: 1, bytes: 100, stub: stub1 });
    b.remove(1, 1);
    b.add({ winId: 1, token: 2, bytes: 100, stub: vi.fn() }); // total 100 ≤ 150 — no evict
    b.add({ winId: 1, token: 3, bytes: 100, stub: vi.fn() }); // total 200 > 150 ⇒ evict (1,2)
    expect(stub1).not.toHaveBeenCalled(); // (1,1) is gone from the ledger for good
    expect(b.bytes).toBe(100);
  });

  it("dropWindow(winId) drops exactly that window's entries — no stub calls", () => {
    const b = new PreviewHistoryBudget(10_000);
    const s1 = vi.fn();
    const s2 = vi.fn();
    b.add({ winId: 1, token: 1, bytes: 100, stub: s1 });
    b.add({ winId: 2, token: 1, bytes: 100, stub: s2 });
    b.add({ winId: 1, token: 2, bytes: 100, stub: s1 });
    b.dropWindow(1);
    expect(b.count).toBe(1);
    expect(b.bytes).toBe(100);
    expect(s1).not.toHaveBeenCalled();
    b.dropWindow(1); // idempotent
    expect(b.count).toBe(1);
  });
});

describe("logic/previewHistoryBudget: estimateSnapshotBytes (§4.5 byte rules)", () => {
  it("image ⇒ dataUrl.length; text ⇒ demoted stream chunks, else text.length; dir ⇒ entries×128", () => {
    expect(estimateSnapshotBytes({ phase: "image", dataUrl: "12345678" })).toBe(8);
    expect(estimateSnapshotBytes({ phase: "text", text: "hello" })).toBe(5);
    expect(estimateSnapshotBytes({ phase: "text", text: "hello", stream: { chunks: ["abc", "de"] } })).toBe(5);
    expect(estimateSnapshotBytes({ phase: "dir", listing: { entries: new Array(10) } })).toBe(1280);
  });
});
