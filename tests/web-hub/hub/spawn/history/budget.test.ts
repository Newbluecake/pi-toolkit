/**
 * web-hub session-history plan PD4 (`budget.ts`): local IO admission `inflight + zombies <
 * HISTORY_FS_SLOTS` and `historyStep`'s bounded racing.
 */
import { describe, expect, it, vi } from "vitest";
import {
  boundedClose,
  boundedFdOpen,
  createHistoryIoGate,
  historyStep,
  isHistoryBusyError,
} from "../../../../../src/web-hub/hub/spawn/history/budget.js";
import { createFdLedger } from "../../../../../src/web-hub/hub/spawn/history/fd-ledger.js";

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function fakeHandle(): { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn(() => Promise.resolve()) };
}

describe("createHistoryIoGate / historyStep", () => {
  it("admits up to the slot count, then rejects synchronously with HistoryBusyError", async () => {
    const gate = createHistoryIoGate(2);
    let resolveA: (() => void) | undefined;
    let resolveB: (() => void) | undefined;
    const now = () => 0;
    const a = historyStep(gate, () => new Promise<void>((r) => (resolveA = r)), 1_000_000, now);
    const b = historyStep(gate, () => new Promise<void>((r) => (resolveB = r)), 1_000_000, now);
    expect(gate.inflight).toBe(2);
    await expect(historyStep(gate, () => Promise.resolve(), 1_000_000, now)).rejects.toSatisfy((err: unknown) =>
      isHistoryBusyError(err),
    );
    resolveA?.();
    resolveB?.();
    await Promise.all([a, b]);
    expect(gate.inflight).toBe(0);
  });

  it("a slot frees up once its underlying op settles, admitting the next call", async () => {
    const gate = createHistoryIoGate(1);
    const now = () => 0;
    let resolve: (() => void) | undefined;
    const first = historyStep(gate, () => new Promise<void>((r) => (resolve = r)), 1_000_000, now);
    await Promise.resolve(); // let historyStep's internal `Promise.resolve().then(lazy)` run
    expect(gate.inflight).toBe(1);
    resolve?.();
    await first;
    expect(gate.inflight).toBe(0);
    const second = await historyStep(gate, () => Promise.resolve("ok"), 1_000_000, now);
    expect(second).toBe("ok");
  });

  it("a timed-out step rejects promptly and counts a zombie until the underlying op eventually settles", async () => {
    const gate = createHistoryIoGate(2);
    let t = 0;
    const now = () => t;
    const p = historyStep(gate, () => neverSettles<void>(), 10, now);
    t = 50; // past the deadline
    await expect(p).rejects.toBeInstanceOf(Error);
    // inflight is released once the race itself settles (by timing out), even though the
    // underlying promise never resolves — it becomes a zombie on the shared tracker instead.
    expect(gate.inflight).toBe(0);
    expect(gate.tracker.zombies).toBeGreaterThanOrEqual(1);
  });

  it("isHistoryBusyError recognizes exactly the busy family", () => {
    expect(isHistoryBusyError(new Error("other"))).toBe(false);
    const gate = createHistoryIoGate(0);
    return historyStep(
      gate,
      () => Promise.resolve(),
      1000,
      () => 0,
    ).catch((err: unknown) => {
      expect(isHistoryBusyError(err)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Finding-1 fix: boundedFdOpen / boundedClose
// ---------------------------------------------------------------------------

describe("boundedFdOpen", () => {
  it("normal success: reserves the ledger, returns the handle, caller owns releasing it", async () => {
    const gate = createHistoryIoGate(4);
    const ledger = createFdLedger(8);
    const h = fakeHandle();
    const openFn = vi.fn(() => Promise.resolve(h));
    const res = await boundedFdOpen(1, "pin", openFn, 1_000_000, { gate, ledger, now: () => 0 });
    expect(res).toEqual({ ok: true, handle: h });
    expect(openFn).toHaveBeenCalledTimes(1);
    expect(ledger.counts().pin).toBe(1); // caller's job to release once it's done with the handle
    expect(h.close).not.toHaveBeenCalled();
    expect(gate.lateFdCount).toBe(0);
  });

  it("ledger-busy: reservation fails synchronously, openFn is never invoked", async () => {
    const gate = createHistoryIoGate(4);
    const ledger = createFdLedger(1);
    expect(ledger.reserve(1, "gen")).toBe(true); // fill the ledger
    const openFn = vi.fn(() => Promise.resolve(fakeHandle()));
    const res = await boundedFdOpen(1, "pin", openFn, 1_000_000, { gate, ledger, now: () => 0 });
    expect(res).toEqual({ ok: false, reason: "busy" });
    expect(openFn).not.toHaveBeenCalled();
    expect(ledger.counts().pin).toBe(0);
  });

  it("gate-busy: admission fails synchronously, openFn is never invoked, the reservation is released", async () => {
    const gate = createHistoryIoGate(0); // never admits
    const ledger = createFdLedger(8);
    const openFn = vi.fn(() => Promise.resolve(fakeHandle()));
    const res = await boundedFdOpen(1, "pin", openFn, 1_000_000, { gate, ledger, now: () => 0 });
    expect(res).toEqual({ ok: false, reason: "busy" });
    expect(openFn).not.toHaveBeenCalled();
    expect(ledger.counts().pin).toBe(0);
  });

  it("real error before the deadline: ledger released exactly once, nothing to close", async () => {
    const gate = createHistoryIoGate(4);
    const ledger = createFdLedger(8);
    const err = new Error("ENOENT");
    const openFn = vi.fn(() => Promise.reject(err));
    const res = await boundedFdOpen(1, "pin", openFn, 1_000_000, { gate, ledger, now: () => 0 });
    expect(res).toEqual({ ok: false, reason: "error", err });
    expect(ledger.counts().pin).toBe(0);
    expect(gate.lateFdCount).toBe(0);
  });

  it("late success: returns deadline immediately, then closes the orphaned handle and releases the ledger exactly once", async () => {
    const gate = createHistoryIoGate(4);
    const ledger = createFdLedger(8);
    const h = fakeHandle();
    let resolveOpen: ((h: ReturnType<typeof fakeHandle>) => void) | undefined;
    const openFn = vi.fn(() => new Promise<ReturnType<typeof fakeHandle>>((r) => (resolveOpen = r)));
    let t = 0;
    const now = () => t;
    const resP = boundedFdOpen(1, "pin", openFn, 10, { gate, ledger, now });
    t = 50; // past the deadline
    const res = await resP;
    expect(res).toEqual({ ok: false, reason: "deadline" });
    // the reservation is still held — the late continuation hasn't settled yet.
    expect(ledger.counts().pin).toBe(1);
    expect(gate.lateFdCount).toBe(1);

    // now let the real open() resolve late.
    resolveOpen?.(h);
    await vi.waitFor(() => {
      expect(h.close).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(ledger.counts().pin).toBe(0);
    });
    expect(gate.lateFdCount).toBe(0);
  });

  it("late failure: ledger released exactly once, nothing throws unhandled", async () => {
    const gate = createHistoryIoGate(4);
    const ledger = createFdLedger(8);
    let rejectOpen: ((err: unknown) => void) | undefined;
    const openFn = vi.fn(() => new Promise<never>((_r, rej) => (rejectOpen = rej)));
    let t = 0;
    const now = () => t;
    const resP = boundedFdOpen(1, "pin", openFn, 10, { gate, ledger, now });
    t = 50;
    const res = await resP;
    expect(res).toEqual({ ok: false, reason: "deadline" });
    expect(gate.lateFdCount).toBe(1);

    rejectOpen?.(new Error("late failure"));
    await vi.waitFor(() => {
      expect(ledger.counts().pin).toBe(0);
    });
    expect(gate.lateFdCount).toBe(0);
  });
});

describe("boundedClose", () => {
  it("closes normally and resolves", async () => {
    const gate = createHistoryIoGate(4);
    const close = vi.fn(() => Promise.resolve());
    await boundedClose(close, { gate, now: () => 0 });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("swallows a rejecting close", async () => {
    const gate = createHistoryIoGate(4);
    const close = vi.fn(() => Promise.reject(new Error("EBADF")));
    await expect(boundedClose(close, { gate, now: () => 0 })).resolves.toBeUndefined();
  });

  it("gives up past its own deadline without throwing, even though the close never settled", async () => {
    const gate = createHistoryIoGate(4);
    const close = vi.fn(() => neverSettles<void>());
    const p = boundedClose(close, { gate, now: () => Date.now() });
    await expect(p).resolves.toBeUndefined();
  }, 3_000);
});
