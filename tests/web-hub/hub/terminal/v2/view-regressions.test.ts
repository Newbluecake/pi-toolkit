import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalRuntimeV2 } from "../../../../../src/web-hub/hub/terminal-v2-ports.js";
import { createTerminalViewsV2, type TerminalViewsV2 } from "../../../../../src/web-hub/hub/terminal/v2/view.js";
import { TERMINAL_V2_LIMITS as L } from "../../../../../src/web-hub/protocol/terminal-v2-values.js";
import { envelope, fixture, hubInstance, signal } from "./fixture.js";
const fixtures: Array<ReturnType<typeof fixture>> = [];
const factories: TerminalViewsV2[] = [];
function replaceFactory(f: ReturnType<typeof fixture>): TerminalViewsV2 {
  const views = createTerminalViewsV2({
    service: f.service,
    auth: f.fence,
    notifications: f.fence,
    hubInstance,
    revalidate: f.revalidate,
    resizeGate: f.resizeGate,
  });
  factories.push(views);
  return views;
}
async function attach(views: TerminalViewsV2, f: ReturnType<typeof fixture>) {
  const result = await views.open(f.id, envelope, signal());
  if (!result.ok) throw new Error(result.code);
  const sink = { send: vi.fn(() => true), close: vi.fn() };
  result.view.start(sink);
  await vi.advanceTimersByTimeAsync(10);
  const writer = { ...envelope, viewId: result.view.viewId };
  expect(await views.ack(f.id, { ...writer, offset: 0, replayComplete: true }, signal())).toEqual({
    ok: true,
    offset: 0,
  });
  await vi.advanceTimersByTimeAsync(10);
  return { writer, sink, view: result.view };
}
function setup() {
  const f = fixture();
  fixtures.push(f);
  return f;
}
async function ready(f: ReturnType<typeof fixture>) {
  const opened = await f.open();
  expect(await f.views.ack(f.id, { ...opened.writer, offset: 0, replayComplete: true }, signal())).toEqual({
    ok: true,
    offset: 0,
  });
  await vi.advanceTimersByTimeAsync(10);
  return opened;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  for (const views of factories.splice(0)) views.dispose();
  for (const f of fixtures.splice(0)) f.dispose();
  vi.useRealTimers();
});
describe("P2 verifier regressions B1/B2", () => {
  it("B1: eight continuously queued 32KiB views with immediate rendered ACK all keep progressing", async () => {
    const sources = Array.from({ length: 8 }, setup);
    const host = sources[0]!;
    const runtimes: TerminalRuntimeV2[] = sources.map((f, index) => ({
      ...f.runtime,
      termId: String(index).repeat(24),
    }));
    host.service.runtime = vi.fn(async (_id, request) => {
      const runtime = runtimes.find((candidate) => candidate.termId === request.termId);
      return runtime ? { ok: true, runtime } : { ok: false, code: "E_NOT_FOUND", effect: "none" };
    });
    const stats = runtimes.map(() => ({ bytes: 0, lastProgress: 0, closed: 0, ready: false, unackedAt: -1 }));
    const acknowledge = runtimes.map(() => true);
    const ackErrors: unknown[] = [];
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index]!,
        runtime = runtimes[index]!,
        stat = stats[index]!;
      const opened = await host.views.open(host.id, { ...envelope, termId: runtime.termId }, signal());
      if (!opened.ok) throw new Error(opened.code);
      const writer = { ...envelope, termId: runtime.termId, viewId: opened.view.viewId };
      opened.view.start({
        close() {
          stat.closed++;
        },
        send(frame) {
          if (frame.t === "ready") stat.ready = true;
          if (frame.t === "output" && !acknowledge[index]) {
            if (stat.unackedAt < 0) stat.unackedAt = Date.now();
            return true;
          }
          if (frame.t === "replay-end" || frame.t === "output") {
            const size = frame.t === "output" ? Buffer.from(frame.bytesB64, "base64").length : 0;
            const offset = frame.t === "output" ? frame.offset + size : frame.offset;
            queueMicrotask(() => {
              void host.views
                .ack(
                  host.id,
                  { ...writer, offset, ...(frame.t === "replay-end" ? { replayComplete: true as const } : {}) },
                  signal(),
                )
                .then((result) => {
                  if (!result.ok) {
                    ackErrors.push(result);
                    return;
                  }
                  if (size) {
                    stat.bytes += size;
                    stat.lastProgress = Date.now();
                    source.append(Buffer.alloc(size, 97)); // replenish only what this renderer actually consumed.
                  }
                })
                .catch((error: unknown) => ackErrors.push(error));
            });
          }
          return true;
        },
      });
    }
    await vi.advanceTimersByTimeAsync(20);
    expect(stats.every((stat) => stat.ready)).toBe(true);
    for (const source of sources) source.append(Buffer.alloc(32_768, 97));
    const checkpoints: number[][] = [];
    for (let step = 0; step < 5; step++) {
      await vi.advanceTimersByTimeAsync(500);
      checkpoints.push(stats.map((stat) => stat.bytes));
    }
    console.info("B1 eight-view facts", JSON.stringify(stats));
    expect(stats.map((stat) => stat.closed)).toEqual(Array(8).fill(0));
    expect(ackErrors).toEqual([]);
    for (let step = 1; step < checkpoints.length; step++)
      expect(checkpoints[step]!.every((bytes, index) => bytes > checkpoints[step - 1]![index]!)).toBe(true);
    expect(stats.every((stat) => Date.now() - stat.lastProgress < 500)).toBe(true);
    const totals = stats.map((stat) => stat.bytes);
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(16_384);
    expect(totals.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(
      (L.hubRateBytes - L.replayRateBytes) * 3.5,
    );
    expect(sources.map((source, index) => source.runtime.snapshot().end - stats[index]!.bytes)).toEqual(
      Array(8).fill(32_768),
    );
    expect(host.service.create).not.toHaveBeenCalled();
    expect(host.service.close).not.toHaveBeenCalled();
    // Now stop ACK on actual transmitted bytes for just one view. Fair server scheduling
    // must not weaken the original 2s client-consumption deadline for this real nonreader.
    acknowledge[0] = false;
    await vi.advanceTimersByTimeAsync(200);
    const stalledAt = stats[0]!.unackedAt;
    expect(stalledAt).toBeGreaterThan(2500);
    await vi.advanceTimersByTimeAsync(stalledAt + 1999 - Date.now());
    expect(stats[0]!.closed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(stats[0]!.closed).toBe(1);
    expect(stats.slice(1).every((stat) => stat.closed === 0 && Date.now() - stat.lastProgress < 500)).toBe(true);
  });
  it("B2: timed-out unresolved resize cannot run/report a successful successor before late physical settle", async () => {
    const f = setup();
    const { writer } = await ready(f);
    let actualCols = 0;
    let release!: () => void;
    vi.mocked(f.runtime.resize)
      .mockImplementationOnce(
        (cols) =>
          new Promise((resolve) => {
            release = () => {
              actualCols = cols;
              resolve({ ok: true });
            };
          }),
      )
      .mockImplementation(async (cols) => {
        actualCols = cols;
        return { ok: true };
      });
    const first = f.views.resize(f.id, { ...writer, seq: 1, cols: 80, rows: 24 }, signal());
    const second = f.views.resize(f.id, { ...writer, seq: 2, cols: 90, rows: 24 }, signal());
    await vi.advanceTimersByTimeAsync(2001);
    const firstResult = await first,
      secondResult = await second;
    const beforeLate = actualCols;
    release();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    console.info(
      "B2 resize facts",
      JSON.stringify({
        firstResult,
        secondResult,
        calls: vi.mocked(f.runtime.resize).mock.calls.length,
        beforeLate,
        afterLate: actualCols,
      }),
    );
    expect(firstResult).toMatchObject({ ok: false, effect: "unknown" });
    expect(secondResult).toMatchObject({ ok: false, effect: "unknown" });
    expect(f.runtime.resize).toHaveBeenCalledOnce();
    expect(beforeLate).toBe(0);
    expect(actualCols).toBe(80);
    expect(f.service.close).not.toHaveBeenCalled();
  });
  it.each(["active", "pending"] as const)(
    "B2: cancel %s request seals logical waits, but new view remains gated until physical settles",
    async (cancel) => {
      const f = setup();
      const { writer } = await ready(f);
      const active = new AbortController(),
        pending = new AbortController();
      let release!: () => void;
      vi.mocked(f.runtime.resize).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ ok: true });
          }),
      );
      const first = f.views.resize(f.id, { ...writer, seq: 1, cols: 80, rows: 24 }, active.signal);
      const second = f.views.resize(f.id, { ...writer, seq: 2, cols: 90, rows: 24 }, pending.signal);
      const third = f.views.resize(f.id, { ...writer, seq: 3, cols: 100, rows: 24 }, signal());
      if (cancel === "active") active.abort();
      else pending.abort();
      const results = await Promise.all([first, second, third]);
      expect(results.every((result) => !result.ok && result.effect === "unknown")).toBe(true);
      expect(f.resizeGate.busy(f.runtime)).toBe(true);
      expect(f.runtime.resize).toHaveBeenCalledOnce();
      const successor = await attach(f.views, f);
      expect(await f.views.resize(f.id, { ...successor.writer, seq: 1, cols: 110, rows: 24 }, signal())).toMatchObject({
        code: "E_NOT_READY",
        effect: "none",
      });
      release();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(f.resizeGate.busy(f.runtime)).toBe(false);
      expect(await f.views.resize(f.id, { ...successor.writer, seq: 1, cols: 110, rows: 24 }, signal())).toEqual({
        ok: true,
        acceptedThrough: 1,
      });
      expect(f.runtime.resize).toHaveBeenCalledTimes(2);
      expect(vi.mocked(f.runtime.resize).mock.calls.map((args) => args[0])).toEqual([80, 110]);
    },
  );
  it("B2: factory dispose cannot clear gate or let a replacement factory race the original runtime", async () => {
    const f = setup();
    const old = await ready(f);
    let release!: () => void;
    vi.mocked(f.runtime.resize).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    const pending = f.views.resize(f.id, { ...old.writer, seq: 1, cols: 80, rows: 24 }, signal());
    f.views.dispose();
    expect(await pending).toMatchObject({ ok: false, effect: "unknown" });
    expect(f.resizeGate.busy(f.runtime)).toBe(true);
    const views = replaceFactory(f),
      successor = await attach(views, f);
    expect(await views.resize(f.id, { ...successor.writer, seq: 1, cols: 90, rows: 24 }, signal())).toMatchObject({
      code: "E_NOT_READY",
      effect: "none",
    });
    expect(f.runtime.resize).toHaveBeenCalledOnce();
    const oldSends = vi.mocked(f.sink.send).mock.calls.length;
    release();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(vi.mocked(f.sink.send).mock.calls.length).toBe(oldSends);
    expect(successor.sink.close).not.toHaveBeenCalled();
    expect(await views.resize(f.id, { ...successor.writer, seq: 1, cols: 90, rows: 24 }, signal())).toEqual({
      ok: true,
      acceptedThrough: 1,
    });
    expect(f.runtime.resize).toHaveBeenCalledTimes(2);
    expect(await f.views.open(f.id, envelope, signal())).toMatchObject({ ok: false });
    expect(f.service.runtime).toHaveBeenCalledTimes(2);
  });
  it("B2: a real different runtime with the same termId is independent, invalidated old handle stays rejected", async () => {
    const f = setup();
    const old = await ready(f);
    let release!: () => void;
    let oldCols = 0,
      newCols = 0;
    vi.mocked(f.runtime.resize).mockImplementationOnce(
      (cols) =>
        new Promise((resolve) => {
          release = () => {
            oldCols = cols;
            resolve({ ok: true });
          };
        }),
    );
    const pending = f.views.resize(f.id, { ...old.writer, seq: 1, cols: 80, rows: 24 }, signal());
    f.invalidated.abort();
    expect(await pending).toMatchObject({ ok: false, effect: "unknown" });
    const fresh: TerminalRuntimeV2 = {
      ...f.runtime,
      invalidated: signal(),
      current: () => true,
      resize: vi.fn(async (cols) => {
        newCols = cols;
        return { ok: true };
      }),
    };
    expect(fresh.termId).toBe(f.runtime.termId);
    vi.mocked(f.service.runtime).mockResolvedValue({ ok: true, runtime: fresh });
    const successor = await attach(f.views, f);
    expect(await f.views.resize(f.id, { ...successor.writer, seq: 1, cols: 100, rows: 24 }, signal())).toEqual({
      ok: true,
      acceptedThrough: 1,
    });
    expect(f.resizeGate.busy(f.runtime)).toBe(true);
    expect(newCols).toBe(100);
    const oldSends = vi.mocked(f.sink.send).mock.calls.length;
    release();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(oldCols).toBe(80);
    expect(newCols).toBe(100);
    expect(vi.mocked(f.sink.send).mock.calls.length).toBe(oldSends);
    expect(f.resizeGate.busy(f.runtime)).toBe(false);
    expect(() => f.resizeGate.start(f.runtime, 120, 24, signal())).toThrow("E_SESSION_CHANGED");
    vi.mocked(f.service.runtime).mockResolvedValue({ ok: true, runtime: f.runtime });
    expect(await f.views.open(f.id, envelope, signal())).toMatchObject({ code: "E_SESSION_CHANGED" });
    expect(await f.views.resize(f.id, { ...successor.writer, seq: 2, cols: 110, rows: 24 }, signal())).toEqual({
      ok: true,
      acceptedThrough: 2,
    });
    expect(newCols).toBe(110);
    expect(f.runtime.resize).toHaveBeenCalledOnce();
  });
  it("B2: merged requests retain their own original deadlines; timeout never flushes a later physical", async () => {
    const f = setup();
    const { writer } = await ready(f);
    const releases: Array<() => void> = [];
    vi.mocked(f.runtime.resize).mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ok: true }));
        }),
    );
    const first = f.views.resize(f.id, { ...writer, seq: 1, cols: 80, rows: 24 }, signal());
    await vi.advanceTimersByTimeAsync(100);
    const second = f.views.resize(f.id, { ...writer, seq: 2, cols: 90, rows: 24 }, signal());
    await vi.advanceTimersByTimeAsync(100);
    const third = f.views.resize(f.id, { ...writer, seq: 3, cols: 100, rows: 24 }, signal());
    await vi.advanceTimersByTimeAsync(1700);
    releases[0]!();
    expect(await first).toEqual({ ok: true, acceptedThrough: 1 });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(f.runtime.resize).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.runtime.resize).mock.calls.map((args) => args[0])).toEqual([80, 100]);
    await vi.advanceTimersByTimeAsync(201);
    expect(await second).toMatchObject({ ok: false, effect: "unknown" });
    expect(await third).toMatchObject({ ok: false, effect: "unknown" });
    expect(f.resizeGate.busy(f.runtime)).toBe(true);
    expect(f.runtime.resize).toHaveBeenCalledTimes(2);
    releases[1]!();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(f.resizeGate.busy(f.runtime)).toBe(false);
  });
  it("B2: physical gate has a hard bounded pending budget, released only by actual settlement", async () => {
    const f = setup();
    const releases: Array<() => void> = [];
    const handles = Array.from({ length: L.hardTotal + 1 }, () => ({
      ...f.runtime,
      resize: vi.fn(
        () =>
          new Promise<{ ok: true }>((resolve) => {
            releases.push(() => resolve({ ok: true }));
          }),
      ),
    }));
    for (const runtime of handles.slice(0, L.hardTotal)) f.resizeGate.start(runtime, 80, 24, signal());
    const blocked = handles[L.hardTotal]!;
    expect(() => f.resizeGate.start(blocked, 80, 24, signal())).toThrow("E_RATE");
    expect(blocked.resize).not.toHaveBeenCalled();
    releases[0]!();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(f.resizeGate.busy(handles[0]!)).toBe(false);
    expect(f.resizeGate.start(blocked, 80, 24, signal()).settled).toBe(false);
    expect(blocked.resize).toHaveBeenCalledOnce();
    expect(() => f.resizeGate.start(blocked, 90, 24, signal())).toThrow("E_NOT_READY");
    for (const release of releases) release();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(handles.every((runtime) => !f.resizeGate.busy(runtime))).toBe(true);
  });
  it("B2: rejected late physical work is observed and releases only its own exact runtime slot", async () => {
    const f = setup();
    const { writer } = await ready(f);
    let reject!: (error: Error) => void;
    vi.mocked(f.runtime.resize).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const first = f.views.resize(f.id, { ...writer, seq: 1, cols: 80, rows: 24 }, signal());
    await vi.advanceTimersByTimeAsync(2001);
    expect(await first).toMatchObject({ effect: "unknown" });
    const successor = await attach(f.views, f);
    expect(await f.views.resize(f.id, { ...successor.writer, seq: 1, cols: 90, rows: 24 }, signal())).toMatchObject({
      code: "E_NOT_READY",
    });
    reject(new Error("late backend failure"));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(f.resizeGate.busy(f.runtime)).toBe(false);
    expect(await f.views.resize(f.id, { ...successor.writer, seq: 1, cols: 90, rows: 24 }, signal())).toEqual({
      ok: true,
      acceptedThrough: 1,
    });
    expect(f.runtime.resize).toHaveBeenCalledTimes(2);
  });
});
