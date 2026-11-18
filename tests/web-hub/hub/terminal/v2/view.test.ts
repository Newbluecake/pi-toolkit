import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalViewFrameV2Ok } from "../../../../../src/web-hub/protocol/terminal-v2.js";
import { envelope, fixture, signal } from "./fixture.js";
const all: Array<ReturnType<typeof fixture>> = [];
function setup(initial?: Buffer) {
  const f = fixture(initial);
  all.push(f);
  return f;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  for (const f of all.splice(0)) f.dispose();
  vi.useRealTimers();
});
async function ready(f: ReturnType<typeof fixture>, writer: Awaited<ReturnType<typeof f.open>>["writer"]) {
  const end = f.frames.find((frame) => frame.t === "replay-end");
  if (!end || end.t !== "replay-end") throw new Error("missing replay-end");
  expect(await f.views.ack(f.id, { ...writer, offset: end.offset, replayComplete: true }, signal())).toEqual({
    ok: true,
    offset: end.offset,
  });
  await vi.advanceTimersByTimeAsync(10);
}
describe("terminal v2 exact writer/rendered ACK/seq", () => {
  it("atomic <=16KiB suffix with explicit gap; ready only after renderer ACK and ready frame", async () => {
    const f = setup(Buffer.alloc(80_000, 97));
    const { writer } = await f.open({ offset: 0 });
    expect(f.frames.slice(0, 5).map((frame) => frame.t)).toEqual(["attached", "gap", "output", "output", "replay-end"]);
    expect(f.frames[1]).toEqual({ t: "gap", from: 0, to: 80_000 - 16_384 });
    const output = f.frames.filter((frame) => frame.t === "output");
    expect(output.reduce((sum, frame) => sum + Buffer.from(frame.bytesB64, "base64").length, 0)).toBe(16_384);
    expect(f.frames.every(terminalViewFrameV2Ok)).toBe(true);
    const input = { ...writer, seq: 0, bytesB64: "YQ==", kind: "user" as const };
    expect(await f.views.input(f.id, input, signal())).toMatchObject({ code: "E_NOT_READY", effect: "none" });
    expect(await f.views.resize(f.id, { ...writer, seq: 0, cols: 80, rows: 24 }, signal())).toMatchObject({
      code: "E_NOT_READY",
    });
    expect(f.runtime.write).not.toHaveBeenCalled();
    expect(f.runtime.resize).not.toHaveBeenCalled();
    expect(await f.views.ack(f.id, { ...writer, offset: 80_001 }, signal())).toMatchObject({ code: "E_BAD_REQUEST" });
    await ready(f, writer);
    expect(await f.views.input(f.id, input, signal())).toEqual({ ok: true, acceptedThrough: 0 });
    expect(f.runtime.write).toHaveBeenCalledOnce();
    expect(await f.views.ack(f.id, { ...writer, offset: 79_999 }, signal())).toMatchObject({ code: "E_BAD_REQUEST" });
  });
  it("query miss/hit/eviction have zero writes/create/runtime acquisition/idle renewal; max seq never rewrites", async () => {
    const f = setup();
    const { writer } = await f.open();
    await ready(f, writer);
    const query = (seq: number) => f.views.input(f.id, { ...writer, seq, queryOnly: true }, signal());
    expect(await query(0)).toEqual({ ok: false, code: "E_INPUT_UNKNOWN", effect: "unknown" });
    expect(f.runtime.write).not.toHaveBeenCalled();
    for (let seq = 0; seq < 65; seq++) {
      expect(await f.views.input(f.id, { ...writer, seq, bytesB64: "YQ==", kind: "user" }, signal())).toEqual({
        ok: true,
        acceptedThrough: seq,
      });
    }
    expect(await query(64)).toEqual({ ok: true, acceptedThrough: 64 });
    expect(await query(0)).toMatchObject({ code: "E_INPUT_UNKNOWN", effect: "unknown" });
    expect(await query(100)).toMatchObject({ code: "E_INPUT_UNKNOWN", effect: "unknown" });
    expect(await f.views.input(f.id, { ...writer, seq: 0, bytesB64: "YQ==", kind: "user" }, signal())).toMatchObject({
      code: "E_INPUT_UNKNOWN",
      effect: "unknown",
    });
    expect(await f.views.input(f.id, { ...writer, seq: 64, bytesB64: "Yg==", kind: "user" }, signal())).toMatchObject({
      code: "E_IDEMPOTENCY_CONFLICT",
    });
    expect(await f.views.input(f.id, { ...writer, seq: 64, bytesB64: "YQ==", kind: "user" }, signal())).toEqual({
      ok: true,
      acceptedThrough: 64,
    });
    expect(f.runtime.write).toHaveBeenCalledTimes(65);
    expect(f.service.runtime).toHaveBeenCalledOnce();
    expect(f.service.create).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(14_900);
    expect(await query(64)).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(101);
    expect(f.sink.close).toHaveBeenCalledOnce();
    expect(await query(64)).toMatchObject({ code: "E_VIEW_CHANGED" });
    expect(f.runtime.write).toHaveBeenCalledTimes(65);
  });
  it("rejects stale/foreign/auth/hub/scope before cache lookup and has no payload canonicalization bypass", async () => {
    const f = setup();
    const { writer, view } = await f.open();
    await ready(f, writer);
    const query = { ...writer, seq: 0, queryOnly: true as const };
    expect(await f.views.input(f.id, { ...writer, seq: 0, bytesB64: "YR==", kind: "user" }, signal())).toMatchObject({
      code: "E_BAD_REQUEST",
    });
    expect(await f.views.input(f.id, { ...query, bytesB64: "YQ==" }, signal())).toMatchObject({
      code: "E_BAD_REQUEST",
    });
    expect(await f.views.input({ ...f.id, sidTag: "other" }, query, signal())).toMatchObject({
      code: "E_VIEW_CHANGED",
    });
    expect(await f.views.input(f.id, { ...query, hubInstance: "x".repeat(24) }, signal())).toMatchObject({
      code: "E_HUB_CHANGED",
    });
    expect(await f.views.input(f.id, { ...query, scope: { ...writer.scope, epoch: "other" } }, signal())).toMatchObject(
      { code: "E_VIEW_CHANGED" },
    );
    f.fence.invalidate({ sidTag: f.id.sidTag });
    expect(await f.views.input(f.id, query, signal())).toMatchObject({ code: "E_REVOKING" });
    view.detach();
    const rev = f.fence.invalidate({ sidTag: f.id.sidTag });
    f.fence.settle({ sidTag: f.id.sidTag }, rev, { kind: "sid-absent", sidTag: f.id.sidTag });
    expect(await f.views.input(f.id, query, signal())).toMatchObject({ code: "E_VIEW_CHANGED" });
    expect(f.runtime.write).not.toHaveBeenCalled();
  });
  it("single writer CAS never steals; old detach cannot release successor", async () => {
    const f = setup();
    const first = await f.open();
    expect(await f.views.open(f.id, envelope, signal())).toMatchObject({ code: "E_WRITER_BUSY" });
    first.view.detach();
    const second = await f.open();
    first.view.detach();
    expect(await f.views.open(f.id, envelope, signal())).toMatchObject({ code: "E_WRITER_BUSY" });
    expect(await f.views.ack(f.id, { ...second.writer, offset: 0, replayComplete: true }, signal())).toMatchObject({
      ok: true,
    });
    f.invalidated.abort();
    expect(await f.views.ack(f.id, { ...second.writer, offset: 0 }, signal())).toMatchObject({
      code: "E_VIEW_CHANGED",
    });
  });
  it("pins concurrent input before await; lost/delayed reply remains unknown and never retries", async () => {
    const f = setup();
    const { writer } = await f.open();
    await ready(f, writer);
    let finish!: (value: { ok: true }) => void;
    vi.mocked(f.runtime.write).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const input = { ...writer, seq: 1, bytesB64: "YQ==", kind: "user" as const };
    const first = f.views.input(f.id, input, signal());
    const duplicate = f.views.input(f.id, input, signal());
    const query = f.views.input(f.id, { ...writer, seq: 1, queryOnly: true }, signal());
    await vi.advanceTimersByTimeAsync(2001);
    expect(await first).toMatchObject({ code: "E_INPUT_UNKNOWN", effect: "unknown" });
    expect(await duplicate).toEqual(await first);
    expect(await query).toEqual(await first);
    finish({ ok: true });
    await Promise.resolve();
    expect(await f.views.input(f.id, input, signal())).toEqual(await first);
    expect(f.runtime.write).toHaveBeenCalledOnce();
  });
  it("revoke during runtime admission/write refuses late results and closes only matching view", async () => {
    const f = setup();
    let finish!: (result: Awaited<ReturnType<typeof f.service.runtime>>) => void;
    vi.mocked(f.service.runtime).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const opening = f.views.open(f.id, envelope, signal());
    f.fence.invalidate({ sidTag: f.id.sidTag });
    finish({ ok: true, runtime: f.runtime });
    expect(await opening).toMatchObject({ ok: false });
    const revision = f.fence.invalidate({ sidTag: f.id.sidTag });
    f.fence.settle({ sidTag: f.id.sidTag }, revision, { kind: "no-change-confirmed" });
    vi.mocked(f.service.runtime).mockResolvedValue({ ok: true, runtime: f.runtime });
    const { writer } = await f.open();
    await ready(f, writer);
    vi.mocked(f.runtime.write).mockImplementation(() => new Promise(() => {}));
    const writing = f.views.input(f.id, { ...writer, seq: 0, bytesB64: "YQ==", kind: "user" }, signal());
    await Promise.resolve();
    await Promise.resolve();
    f.fence.invalidate({ sidTag: f.id.sidTag });
    expect(await writing).toMatchObject({ code: "E_REVOKING" });
    expect(f.sink.close).toHaveBeenCalledOnce();
    expect(f.service.close).not.toHaveBeenCalled();
  });
  it("zero-progress ACK does not extend 2s byte deadline; late output starts a fresh progress window", async () => {
    const f = setup();
    const { writer } = await f.open();
    await ready(f, writer);
    await vi.advanceTimersByTimeAsync(6000);
    f.append(Buffer.from("late"));
    await vi.advanceTimersByTimeAsync(10);
    expect(f.sink.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1900);
    expect(await f.views.ack(f.id, { ...writer, offset: 0 }, signal())).toEqual({ ok: true, offset: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.sink.close).toHaveBeenCalledOnce();
    expect(f.service.close).not.toHaveBeenCalled();
  });
  it("resize coalesces latest dimensions, deduplicates and ACK/response do not write user input", async () => {
    const f = setup();
    const { writer } = await f.open();
    await ready(f, writer);
    let finish!: (value: { ok: true }) => void;
    vi.mocked(f.runtime.resize).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = f.views.resize(f.id, { ...writer, seq: 0, cols: 80, rows: 24 }, signal());
    const second = f.views.resize(f.id, { ...writer, seq: 1, cols: 81, rows: 25 }, signal());
    const third = f.views.resize(f.id, { ...writer, seq: 2, cols: 90, rows: 30 }, signal());
    finish({ ok: true });
    expect(await first).toEqual({ ok: true, acceptedThrough: 0 });
    expect(await second).toEqual({ ok: true, acceptedThrough: 2 });
    expect(await third).toEqual(await second);
    expect(f.runtime.resize).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.runtime.resize).mock.calls[1]?.slice(0, 2)).toEqual([90, 30]);
    expect(await f.views.resize(f.id, { ...writer, seq: 2, cols: 90, rows: 30 }, signal())).toEqual(await third);
    expect(await f.views.resize(f.id, { ...writer, seq: 2, cols: 91, rows: 30 }, signal())).toMatchObject({
      code: "E_IDEMPOTENCY_CONFLICT",
    });
    expect(f.runtime.write).not.toHaveBeenCalled();
  });
  it("5s ping/55s bounded auth recheck/hard expiry, E_DB closes stream without ledger mutation", async () => {
    const f = setup();
    const { writer } = await f.open();
    await ready(f, writer);
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(5000);
      await f.views.ack(f.id, { ...writer, offset: 0 }, signal());
    }
    expect(f.frames.filter((frame) => frame.t === "ping")).toHaveLength(10);
    vi.mocked(f.revalidate).mockRejectedValue(new Error("E_DB"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.revalidate).toHaveBeenCalledOnce();
    expect(f.sink.close).toHaveBeenCalledOnce();
    expect(f.service.create).not.toHaveBeenCalled();
    expect(f.service.close).not.toHaveBeenCalled();
  });
  it("revalidate unknown/none/timeouts fail closed, abort and do not change ledger/resource ports", async () => {
    for (const outcome of ["none", "unknown", "timeout"] as const) {
      const f = setup();
      const { writer } = await f.open();
      await ready(f, writer);
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(5000);
        await f.views.ack(f.id, { ...writer, offset: 0 }, signal());
      }
      let recheckSignal: AbortSignal | undefined;
      f.revalidate.mockImplementation(async (_id, incoming) => {
        recheckSignal = incoming;
        if (outcome === "timeout") return new Promise(() => {});
        return { ok: false, code: "E_DB", effect: outcome };
      });
      await vi.advanceTimersByTimeAsync(5000);
      if (outcome === "timeout") {
        expect(f.sink.close).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000);
      }
      expect(recheckSignal?.aborted).toBe(true);
      expect(f.sink.close).toHaveBeenCalledOnce();
      expect(f.service.close).not.toHaveBeenCalled();
      expect(f.service.dispose).not.toHaveBeenCalled();
      f.dispose();
    }
  });
  it("fresh auth may shorten but never extend the original parent-expiry hard timer", async () => {
    for (const change of ["shorter", "longer"] as const) {
      vi.setSystemTime(0);
      const f = setup();
      if (change === "longer") f.id.parentExpiresAt = 55_100;
      const { writer } = await f.open();
      await ready(f, writer);
      f.revalidate.mockImplementation(async (id) => ({
        ok: true,
        identity: { ...id, parentExpiresAt: change === "shorter" ? Date.now() + 100 : 1_000_000 },
      }));
      for (let i = 0; i < 11; i++) {
        await vi.advanceTimersByTimeAsync(5000);
        await f.views.ack(f.id, { ...writer, offset: 0 }, signal());
      }
      expect(f.revalidate).toHaveBeenCalledOnce();
      expect(f.sink.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(120);
      expect(f.sink.close).toHaveBeenCalledOnce();
      expect(f.service.close).not.toHaveBeenCalled();
      f.dispose();
    }
  });
  it("hard expiry is not extended by active ACK/query; unstarted handles expire and release only themselves", async () => {
    const f = setup();
    f.id.parentExpiresAt = 100;
    const { writer } = await f.open();
    await ready(f, writer);
    await vi.advanceTimersByTimeAsync(70);
    expect(await f.views.ack(f.id, { ...writer, offset: 0 }, signal())).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(11);
    expect(f.sink.close).toHaveBeenCalledOnce();
    expect(await f.views.input(f.id, { ...writer, seq: 0, queryOnly: true }, signal())).toMatchObject({
      code: "E_AUTH",
    });
    const g = setup();
    const pending = await g.views.open(g.id, envelope, signal());
    expect(pending.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await g.views.open(g.id, envelope, signal())).toMatchObject({ ok: true });
    if (pending.ok) pending.view.start(g.sink);
    expect(g.sink.close).toHaveBeenCalledOnce();
  });
  it("unrelated revoke during 55s auth await discards old result without tearing another user's view", async () => {
    const f = setup();
    const { writer } = await f.open();
    await ready(f, writer);
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(5000);
      await f.views.ack(f.id, { ...writer, offset: 0 }, signal());
    }
    let release!: (value: Awaited<ReturnType<typeof f.revalidate>>) => void;
    f.revalidate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    f.fence.invalidate({ sidTag: "someone-else" });
    release({ ok: true, identity: f.id });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(f.revalidate).toHaveBeenCalledTimes(2);
    expect(f.sink.close).not.toHaveBeenCalled();
    expect(await f.views.ack(f.id, { ...writer, offset: 0 }, signal())).toMatchObject({ ok: true });
  });
  it("128KiB/view/s throttles raw output without extending the byte ACK deadline", async () => {
    const f = setup();
    const { writer } = await f.open();
    await ready(f, writer);
    const start = Date.now();
    let delivered = 0;
    for (let i = 0; i < 16; i++) {
      f.append(Buffer.alloc(8192));
      await vi.advanceTimersByTimeAsync(1);
      delivered += 8192;
      expect(await f.views.ack(f.id, { ...writer, offset: delivered }, signal())).toMatchObject({ ok: true });
    }
    f.append(Buffer.alloc(8192));
    await vi.advanceTimersByTimeAsync(1);
    expect(f.frames.filter((frame) => frame.t === "output")).toHaveLength(16);
    await vi.advanceTimersByTimeAsync(70);
    expect(f.frames.filter((frame) => frame.t === "output")).toHaveLength(17);
    expect(Date.now() - start).toBeLessThan(1000);
  });
  it("bounded fair passes interleave two runtimes without putting replay behind an entire live queue", async () => {
    const f = setup();
    const g = setup(Buffer.alloc(16_384));
    const runtime = { ...g.runtime, termId: "g".repeat(24) };
    f.service.runtime = vi.fn(async (_id, request) => ({
      ok: true,
      runtime: request.termId === runtime.termId ? runtime : f.runtime,
    }));
    const { writer } = await f.open();
    await ready(f, writer);
    const order: string[] = [];
    vi.mocked(f.sink.send).mockImplementation((frame) => {
      f.frames.push(frame);
      if (frame.t === "output") order.push("live");
      return true;
    });
    vi.mocked(g.sink.send).mockImplementation((frame) => {
      g.frames.push(frame);
      if (frame.t === "output") order.push("replay");
      return true;
    });
    f.append(Buffer.alloc(65_536));
    const replay = await f.views.open(f.id, { ...envelope, termId: runtime.termId }, signal());
    if (!replay.ok) throw new Error(replay.code);
    replay.view.start(g.sink);
    await vi.advanceTimersByTimeAsync(20);
    expect(order.slice(0, 5)).toEqual(["live", "live", "replay", "live", "replay"]);
    expect(g.frames.some((frame) => frame.t === "replay-end")).toBe(true);
    expect(f.sink.close).not.toHaveBeenCalled();
    expect(g.sink.close).not.toHaveBeenCalled();
  });
  it("pending bytes/queue rejection only detach this view and dispose cancels every timer", async () => {
    const f = setup();
    const { writer } = await f.open();
    await ready(f, writer);
    f.append(Buffer.alloc(65_536)); // bounded suffix itself is permitted (gap, not full ring).
    f.append(Buffer.alloc(8192)); // another pending chunk would exceed this view's budget.
    expect(f.sink.close).toHaveBeenCalledOnce();
    expect(f.service.close).not.toHaveBeenCalled();
    f.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
