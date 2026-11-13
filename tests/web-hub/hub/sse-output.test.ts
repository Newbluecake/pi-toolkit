import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Writable } from "node:stream";
import type { Gzip } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseHub } from "../../../src/web-hub/hub/sse.js";
import { createSseOutput } from "../../../src/web-hub/hub/sse-output.js";

class Response extends Writable {
  chunks: string[] = [];
  release: (() => void) | undefined;
  stalled = false;
  constructor() {
    super({ highWaterMark: 16 });
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, cb: () => void): void {
    this.chunks.push(chunk.toString());
    if (this.stalled) this.release = cb;
    else cb();
  }
}

function setup(gzip = false, maxBufferedBytes = 64, stallMs = 100) {
  const req = new EventEmitter();
  const res = new Response();
  let compressor: Gzip | undefined;
  res.once("pipe", (src) => {
    compressor = src;
  });
  const onClose = vi.fn();
  const output = createSseOutput(req as IncomingMessage, res as unknown as ServerResponse, {
    gzip,
    maxBufferedBytes,
    stallMs,
    onClose,
  });
  return { req, res, output, onClose, compressor: () => compressor };
}

afterEach(() => vi.useRealTimers());

describe("ordered SSE output and lifecycle", () => {
  it("stops on false, queues in order, resumes only on drain; transient >budget bursts survive", () => {
    vi.useFakeTimers();
    const { req, res, output, onClose } = setup();
    res.stalled = true;
    output.send("a".repeat(32));
    output.send("b".repeat(40));
    output.send("c".repeat(40));
    expect(res.chunks).toEqual(["a".repeat(32)]);
    expect(vi.getTimerCount()).toBe(1);
    res.stalled = false;
    res.release!();
    expect(res.chunks).toEqual(["a".repeat(32), "b".repeat(40), "c".repeat(40)]);
    expect(vi.getTimerCount()).toBe(0);
    output.abort();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(req.listenerCount("error")).toBe(0);
    expect(res.listenerCount("drain")).toBe(0);
  });

  it("new enqueues cannot renew a no-drain deadline, which is clamped and unref'd", () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const { res, output, onClose } = setup(false, 64, Infinity);
    res.stalled = true;
    output.send("a".repeat(128));
    const timer = timeout.mock.results.at(-1)!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    vi.advanceTimersByTime(4_900);
    output.send("ping");
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(res.destroyed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    timeout.mockRestore();
  });

  it("recovery to the soft threshold cancels the grace; a later burst gets its own window", () => {
    vi.useFakeTimers();
    const { res, output, onClose } = setup(false, 128);
    res.stalled = true;
    output.send("a".repeat(128));
    output.send("b".repeat(128));
    vi.advanceTimersByTime(90);
    res.release!(); // first write drains; remaining 128 bytes are within the soft threshold
    expect(res.chunks).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(90);
    expect(onClose).not.toHaveBeenCalled();
    output.send("c".repeat(128));
    vi.advanceTimersByTime(99);
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "a finite 8 MiB burst drains at 128 KiB/200ms across multiple windows without loss (finish=%s)",
    async (finish) => {
      vi.useFakeTimers();
      const { res, output, onClose } = setup(false, 2 * 1024 * 1024, 5_000);
      res.stalled = true;
      const frames = Array.from({ length: 64 }, (_, i) => String(i).padStart(3, "0") + "x".repeat(128 * 1024 - 3));
      const finished = new Promise<void>((resolve) => res.once("finish", resolve));
      for (const frame of frames) expect(output.send(frame)).toBe(true);
      if (finish) output.finish();
      // Let the initial synchronous burst settle before measuring net progress.
      await Promise.resolve();
      const started = Date.now();
      for (let i = 0; i < frames.length; i++) {
        vi.advanceTimersByTime(200);
        expect(res.destroyed).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
        res.release!(); // real Writable callback/drain, not a synthetic drain event
      }
      expect(Date.now() - started).toBe(12_800);
      expect(res.chunks).toEqual(frames);
      expect(Buffer.byteLength(res.chunks.join(""))).toBe(8 * 1024 * 1024);
      expect(res.writableLength).toBe(0);
      if (!finish) output.finish();
      await finished;
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("compares against the latest window: net reduction followed by stagnation expires", async () => {
    vi.useFakeTimers();
    const { res, output, onClose } = setup();
    res.stalled = true;
    for (let i = 0; i < 4; i++) output.send("x".repeat(128));
    await Promise.resolve();
    vi.advanceTimersByTime(90);
    res.release!();
    vi.advanceTimersByTime(10); // 512 -> 384: extend once
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); // 384 -> 384: expire, despite reduction from the original burst
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(res.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drain offset by equal new production is not net progress", async () => {
    vi.useFakeTimers();
    const { res, output, onClose } = setup();
    res.stalled = true;
    for (let i = 0; i < 4; i++) output.send("x".repeat(128));
    await Promise.resolve();
    vi.advanceTimersByTime(90);
    res.release!();
    output.send("x".repeat(128)); // replaces exactly the bytes just drained
    vi.advanceTimersByTime(10);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(res.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds queued bytes at admission even with a drain before every stall deadline", () => {
    vi.useFakeTimers();
    const { res, output, onClose } = setup(false, 64 * 1024, 5_000);
    res.stalled = true;
    const frame = "x".repeat(128 * 1024);
    let accepted = 0;
    let rejected = false;
    let peakQueuedBytes = 0;
    const started = Date.now();
    // The original probe: eight frames produced for every single released write.
    // Stay well below a stall window so ONLY admission can enforce this bound.
    for (let round = 0; round < 32 && !rejected; round++) {
      for (let i = 0; i < 8; i++) {
        if (!output.send(frame)) {
          rejected = true;
          break;
        }
        accepted++;
        const queuedBytes = (accepted - res.chunks.length) * Buffer.byteLength(frame);
        peakQueuedBytes = Math.max(peakQueuedBytes, queuedBytes);
        expect(queuedBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
      }
      if (!rejected) {
        vi.advanceTimersByTime(20);
        res.release!();
      }
    }
    expect(peakQueuedBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(rejected).toBe(true);
    expect(Date.now() - started).toBeLessThanOrEqual(640);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(res.destroyed).toBe(true);
    expect(output.send("late")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("periodic drains cannot renew a growing backlog across stall windows", () => {
    vi.useFakeTimers();
    const { res, output, onClose } = setup(false, 64 * 1024, 150);
    res.stalled = true;
    const frame = "x".repeat(128 * 1024);
    const started = Date.now();
    // <8 MiB throughout: this exercises the stall rule independently of the hard cap.
    for (let round = 0; round < 4 && onClose.mock.calls.length === 0; round++) {
      for (let i = 0; i < 8; i++) output.send(frame);
      vi.advanceTimersByTime(100);
      if (!res.destroyed) res.release!();
    }
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(res.destroyed).toBe(true);
    expect(Date.now() - started).toBeLessThanOrEqual(200);
    expect(res.chunks.length).toBeLessThanOrEqual(2);
    expect(output.send("late")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["send", "finish"] as const)("rejects an oversized UTF-8 %s frame before writing it", (method) => {
    const { res, output, onClose } = setup();
    const frame = "界".repeat(9 * 1024 * 1024); // 9 Mi characters, 27 MiB on the wire
    if (method === "send") expect(output.send(frame)).toBe(false);
    else output.finish(frame);
    expect(res.chunks).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(res.destroyed).toBe(true);
    expect(output.send("late")).toBe(false);
  });

  it.each([false, true])(
    "disconnect cleans queue, timers, request/response and gzip listeners (gzip=%s)",
    async (gzip) => {
      vi.useFakeTimers();
      const { req, res, output, compressor, onClose } = setup(gzip);
      res.stalled = true;
      output.send("a".repeat(128));
      output.send("b".repeat(128));
      expect(vi.getTimerCount()).toBe(1);
      const gz = compressor();
      const closed = gz === undefined ? Promise.resolve() : new Promise<void>((r) => gz.once("close", r));
      res.emit("close");
      await closed;
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(output.send("late")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(req.eventNames()).toEqual([]);
      expect(res.listenerCount("drain")).toBe(0);
      expect(res.listenerCount("close")).toBe(0);
      expect(res.listenerCount("finish")).toBe(0);
      expect(res.listenerCount("error")).toBe(0);
      if (gz !== undefined) {
        expect(gz.destroyed).toBe(true);
        expect(gz.listenerCount("drain")).toBe(0);
        expect(gz.listenerCount("error")).toBe(0);
        expect(gz.listenerCount("data")).toBe(0);
      }
    },
  );

  it.each([false, true])("disconnect also stops the hub ping timer (gzip=%s)", async (gzip) => {
    vi.useFakeTimers();
    const req = Object.assign(new EventEmitter(), {
      headers: gzip ? { "accept-encoding": "gzip" } : {},
      socket: { setNoDelay() {} },
    });
    const res = Object.assign(new Response(), { writeHead() {} });
    res.stalled = true;
    let compressor: Gzip | undefined;
    res.once("pipe", (src) => {
      compressor = src;
    });
    const h = createSseHub({ now: () => 0, maxBufferedBytes: 64, stallMs: 100 });
    h.attach(req as unknown as IncomingMessage, res as unknown as ServerResponse, undefined).send("history", {
      text: "x".repeat(128),
    });
    expect(vi.getTimerCount()).toBe(2); // bounded backlog + hub ping
    const closed =
      compressor === undefined ? Promise.resolve() : new Promise<void>((r) => compressor!.once("close", r));
    res.emit("close");
    await closed;
    expect(h.count()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(req.eventNames()).toEqual([]);
    expect(res.listenerCount("drain")).toBe(0);
  });

  it("zlib error destroys the response and removes all owned resources", async () => {
    const { res, req, output, compressor, onClose } = setup(true);
    output.send("first");
    const gz = compressor()!;
    const closed = new Promise<void>((r) => gz.once("close", r));
    gz.destroy(new Error("synthetic zlib failure"));
    await closed;
    expect(res.destroyed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(req.listenerCount("error")).toBe(0);
    expect(gz.listenerCount("error")).toBe(0);
    expect(output.send("late")).toBe(false);
  });
});
