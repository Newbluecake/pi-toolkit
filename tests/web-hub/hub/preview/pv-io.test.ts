/** web-hub-html-preview plan v2 §2.5 / T-H14 — `hub/preview/pv-io.ts`. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPreviewIoError } from "../../../../src/web-hub/hub/preview/fs.js";
import { createPvIoGate } from "../../../../src/web-hub/hub/preview/pv-io.js";
import { PV_IO_OP_TIMEOUT_MS, PV_IO_SLOTS } from "../../../../src/web-hub/protocol/preview-html.js";

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

function deferred<T = void>(): { p: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const p = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { p, resolve, reject };
}

const bg = (p: Promise<unknown>): void => void p.catch(() => undefined);
const far = (): number => Date.now() + 60_000;
const failOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return isPreviewIoError(e) ? e.ioFail : `other:${String(e)}`;
  }
  return "none";
};

afterEach(() => vi.restoreAllMocks());

describe("pv-io gate", () => {
  it("default slots = PV_IO_SLOTS and runs ops", async () => {
    const g = createPvIoGate();
    expect(g.slots).toBe(PV_IO_SLOTS);
    await expect(g.run(async () => 7, { deadlineAt: far() })).resolves.toBe(7);
    expect(g.inflight).toBe(0);
  });

  it("never more than `slots` ops outstanding; waiters are FIFO", async () => {
    const g = createPvIoGate({ slots: 2 });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    const ps = gates.map((d, i) =>
      g.run(
        async () => {
          started.push(i);
          await d.p;
          return i;
        },
        { deadlineAt: far() },
      ),
    );
    await tick();
    expect(started).toEqual([0, 1]);
    expect(g.inflight).toBe(2);
    expect(g.waiting).toBe(2);
    gates[1]!.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    gates[0]!.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[2]!.resolve();
    gates[3]!.resolve();
    expect(await Promise.all(ps)).toEqual([0, 1, 2, 3]);
    expect(g.inflight).toBe(0);
  });

  it("a raced-out op keeps its slot until it REALLY settles (zombie)", async () => {
    const g = createPvIoGate({ slots: 1, opTimeoutMs: 20 });
    const hang = deferred();
    const first = g.run(() => hang.p, { deadlineAt: far() });
    expect(await failOf(first)).toBe("deadline");
    expect(g.inflight).toBe(1); // caller gave up, slot still held
    // a second op cannot start: busy once its own deadline passes
    let ran = false;
    const second = g.run(
      async () => {
        ran = true;
      },
      { deadlineAt: Date.now() + 30 },
    );
    expect(await failOf(second)).toBe("busy");
    expect(ran).toBe(false);
    hang.resolve();
    await tick();
    expect(g.inflight).toBe(0);
    await expect(g.run(async () => 1, { deadlineAt: far() })).resolves.toBe(1);
  });

  it("op timeout is PV_IO_OP_TIMEOUT_MS by default", () => {
    expect(PV_IO_OP_TIMEOUT_MS).toBe(2000);
  });

  it("deadline already past ⇒ the op is never initiated", async () => {
    const g = createPvIoGate();
    const op = vi.fn(async () => 1);
    expect(await failOf(g.run(op, { deadlineAt: Date.now() - 1 }))).toBe("deadline");
    expect(op).not.toHaveBeenCalled();
    expect(g.inflight).toBe(0);
  });

  it("abort while waiting removes the waiter; abort before ⇒ abort", async () => {
    const g = createPvIoGate({ slots: 1 });
    const hang = deferred();
    bg(g.run(() => hang.p, { deadlineAt: far() }));
    const ctl = new AbortController();
    const w = g.run(async () => 1, { deadlineAt: far(), signal: ctl.signal });
    await tick();
    expect(g.waiting).toBe(1);
    ctl.abort();
    expect(await failOf(w)).toBe("abort");
    expect(g.waiting).toBe(0);
    const pre = new AbortController();
    pre.abort();
    expect(await failOf(g.run(async () => 1, { deadlineAt: far(), signal: pre.signal }))).toBe("abort");
    hang.resolve();
  });

  it("a rejected op releases its slot", async () => {
    const g = createPvIoGate({ slots: 1 });
    await expect(g.run(() => Promise.reject(new Error("x")), { deadlineAt: far() })).rejects.toThrow("x");
    expect(g.inflight).toBe(0);
  });

  it("open: a handle arriving after the race gave up is closed on settle", async () => {
    const g = createPvIoGate({ slots: 2, opTimeoutMs: 20 });
    const d = deferred<{ close(): Promise<void> }>();
    const closed = vi.fn(async () => undefined);
    expect(await failOf(g.open(() => d.p, { deadlineAt: far() }))).toBe("deadline");
    expect(g.lateFds).toBe(1);
    d.resolve({ close: closed });
    await tick(5);
    expect(g.lateFds).toBe(0);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(g.inflight).toBe(0);
  });

  it("close: bounded for the caller, never rejects, still runs when a slot frees", async () => {
    const g = createPvIoGate({ slots: 1, opTimeoutMs: 30 });
    const hang = deferred();
    bg(g.run(() => hang.p, { deadlineAt: far() }));
    const closeOp = vi.fn(async () => undefined);
    const t0 = Date.now();
    await g.close(closeOp); // caller released after ≈ opTimeoutMs even though no slot
    expect(Date.now() - t0).toBeLessThan(500);
    expect(closeOp).not.toHaveBeenCalled();
    hang.resolve();
    await tick(5);
    expect(closeOp).toHaveBeenCalledTimes(1); // queued close ran once the slot freed
    await expect(g.close(() => Promise.reject(new Error("x")))).resolves.toBeUndefined();
  });

  it("a close that never completes keeps its slot forever ⇒ run is busy", async () => {
    const g = createPvIoGate({ slots: 1, opTimeoutMs: 20 });
    await g.close(() => new Promise<void>(() => undefined));
    expect(g.inflight).toBe(1);
    expect(await failOf(g.run(async () => 1, { deadlineAt: Date.now() + 30 }))).toBe("busy");
  });

  it("close jumps ahead of waiting runs", async () => {
    const g = createPvIoGate({ slots: 1, opTimeoutMs: 1000 });
    const hang = deferred();
    bg(g.run(() => hang.p, { deadlineAt: far() }));
    const order: string[] = [];
    const r = g.run(async () => void order.push("run"), { deadlineAt: far() });
    const c = g.close(async () => void order.push("close"));
    hang.resolve();
    await Promise.all([r, c]);
    expect(order).toEqual(["close", "run"]);
  });

  it("dispose rejects waiters and later runs, but closes keep working", async () => {
    const g = createPvIoGate({ slots: 1 });
    const hang = deferred();
    bg(g.run(() => hang.p, { deadlineAt: far() }));
    const w = g.run(async () => 1, { deadlineAt: far() });
    await tick();
    g.dispose();
    expect(await failOf(w)).toBe("abort");
    expect(await failOf(g.run(async () => 1, { deadlineAt: far() }))).toBe("abort");
    const closeOp = vi.fn(async () => undefined);
    hang.resolve();
    await g.close(closeOp);
    expect(closeOp).toHaveBeenCalled();
  });

  it("all timers are unref'd", async () => {
    const created: NodeJS.Timeout[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const t = real(fn, ms);
      created.push(t);
      return t;
    }) as typeof setTimeout);
    const g = createPvIoGate({ slots: 1, opTimeoutMs: 15 });
    const hang = deferred();
    bg(g.run(() => hang.p, { deadlineAt: far() }));
    await failOf(g.run(async () => 1, { deadlineAt: Date.now() + 15 }));
    await g.close(async () => undefined);
    expect(created.length).toBeGreaterThan(0);
    for (const t of created) expect(t.hasRef()).toBe(false);
    hang.resolve();
  });
});
