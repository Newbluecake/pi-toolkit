/** Per-connection SSE transport. A frame is the scheduling/flush unit, never a wire change. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { constants, createGzip, type Gzip } from "node:zlib";

export interface SseOutput {
  send(frame: string, source?: object): boolean;
  /** Conservative queued input + encoder + socket bytes, including the in-flight frame.
   * Optional opaque source selects ONLY that producer's stages; zero proves no private
   * frame remains locally queued/in zlib/unacknowledged by response write callbacks.
   * During gzip flush, input and compressed output can conservatively overlap.
   */
  pendingBytes(source?: object): number;
  /** One-shot local encoder/socket drain observation; cancellation never closes the stream. */
  onIdle(fn: () => void): () => void;
  /** Stop admission, finish accepted frames (or replace queued frames with a terminal auth frame). */
  finish(terminal?: string): void;
  abort(): void;
}

// Local mirror of core/deadline.ts: hub must not expand its import boundary.
function clampSpanMs(ms: number): number | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(ms, 365 * 86_400_000);
}

// Fixed per-connection admission cap, independent of the soft stall threshold:
// 16 MiB (the full replay ring) + 8 MiB for bootstrap/history and in-flight headroom.
const MAX_PENDING_BYTES = 24 * 1024 * 1024;

export function createSseOutput(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { gzip: boolean; maxBufferedBytes: number; stallMs: number; onClose(): void },
): SseOutput {
  const stallMs = Math.min(5_000, clampSpanMs(opts.stallMs) ?? 5_000);
  const gzip: Gzip | undefined = opts.gzip ? createGzip() : undefined;
  let queue: Array<{ frame: string; bytes: number; source?: object }> = [];
  // Per-source stage accounting, never a subtraction from the public backlog. Entries
  // disappear at zero; callbacks after abort cannot resurrect them.
  const sources = new Map<object, number>();
  let encodingSource: object | undefined;
  const writes = new Set<() => void>();
  function settleWrites(): void {
    // Writable can drop writableLength synchronously and defer its write callbacks
    // to nextTick. Retire that already-consumed batch before a later public write
    // can make it appear that an old private frame is still in flight.
    if (res.writableLength === 0) for (const done of writes) done();
  }
  function charge(source: object | undefined, bytes: number): void {
    if (source === undefined || closed) return;
    const remaining = (sources.get(source) ?? 0) + bytes;
    if (remaining === 0) sources.delete(source);
    else sources.set(source, remaining);
  }
  let head = 0;
  let queuedBytes = 0;
  // Count the WHOLE frame until its flush completes, not just gzip.writableLength (which can
  // become zero while zlib still owns input). Include compressed readable output as well.
  let inputBytes = 0;
  let flushing = false;
  let blocked = false;
  let ending = false;
  let ended = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Set<() => void>();
  function notifyIdle(): void {
    if (
      closed ||
      ending ||
      flushing ||
      blocked ||
      res.writableNeedDrain ||
      head < queue.length ||
      inputBytes !== 0 ||
      (gzip?.readableLength ?? 0) !== 0
    )
      return;
    const callbacks = [...idle];
    idle.clear();
    for (const fn of callbacks) if (!closed && !ending) fn();
  }

  function clearStall(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function pendingBytes(source?: object): number {
    settleWrites();
    if (source !== undefined)
      return (sources.get(source) ?? 0) + (source === encodingSource ? (gzip?.readableLength ?? 0) : 0);
    return queuedBytes + inputBytes + (gzip?.readableLength ?? 0) + res.writableLength;
  }

  function checkStall(): void {
    if (closed) return;
    const bytes = pendingBytes();
    if (!ending && bytes <= opts.maxBufferedBytes) {
      clearStall();
      return;
    }
    if (timer !== undefined) return;
    let startBytes = bytes;
    function onWindow(): void {
      timer = undefined;
      if (closed) return;
      const remaining = pendingBytes();
      if (!ending && remaining <= opts.maxBufferedBytes) return;
      // Compare window endpoints, not individual drains: finite slow snapshots may
      // continue, but production that offsets/exceeds consumption cannot renew forever.
      if (remaining >= startBytes) {
        abort();
        return;
      }
      startBytes = remaining;
      timer = setTimeout(onWindow, stallMs);
      timer.unref();
    }
    const firstTimer = setTimeout(onWindow, stallMs);
    timer = firstTimer;
    firstTimer.unref();
    // Threshold crossing can precede the rest of a synchronous bootstrap/history burst.
    // Sample that initial baseline after this turn, without postponing its deadline.
    // Later windows use the exact previous endpoint; cancelled/replaced windows stay inert.
    queueMicrotask(() => {
      if (timer === firstTimer) startBytes = pendingBytes();
    });
  }

  function cleanup(): void {
    if (closed) return;
    closed = true;
    clearStall();
    idle.clear();
    queue = [];
    head = 0;
    queuedBytes = inputBytes = 0;
    sources.clear();
    writes.clear();
    encodingSource = undefined;
    req.removeListener("error", abort);
    res.removeListener("drain", onDrain);
    res.removeListener("close", onClose);
    res.removeListener("finish", onFinish);
    res.removeListener("error", abort);
    if (gzip !== undefined) {
      gzip.removeListener("data", onEncoded);
      gzip.removeListener("end", onEncodedEnd);
      res.emit("unpipe", gzip);
      // Keep the error guard until close: an in-flight native callback may still report an
      // error after destroy. The close handler removes itself and the guard afterwards.
      gzip.destroy();
    }
    opts.onClose();
  }

  function abort(): void {
    if (closed) return;
    cleanup();
    res.destroy();
  }

  function onClose(): void {
    cleanup();
  }

  function onFinish(): void {
    cleanup();
  }

  function onDrain(): void {
    blocked = false;
    gzip?.resume();
    pump();
  }

  function writeBytes(bytes: string | Buffer, source: object | undefined): boolean {
    settleWrites();
    const n = Buffer.byteLength(bytes);
    charge(source, n);
    const done = () => {
      if (!writes.delete(done)) return;
      charge(source, -n);
    };
    if (source !== undefined) writes.add(done);
    return res.write(bytes, () => {
      done();
      notifyIdle();
    });
  }

  function onEncoded(bytes: Buffer): void {
    // Only one frame enters zlib until Z_SYNC_FLUSH AND readable/drain completion.
    // Therefore every compressed chunk (including its sync marker) has exactly that
    // frame's source, even when zlib's dictionary spans public/private frames.
    try {
      blocked = !writeBytes(bytes, encodingSource);
      if (blocked) gzip!.pause();
      else queueMicrotask(pump);
    } catch {
      abort();
    }
  }

  function onEncodedEnd(): void {
    res.end();
  }

  function pump(): void {
    if (closed) return;
    try {
      while (
        !blocked &&
        !res.writableNeedDrain &&
        !flushing &&
        (gzip?.readableLength ?? 0) === 0 &&
        head < queue.length
      ) {
        const item = queue[head]!;
        queue[head++] = undefined as unknown as (typeof queue)[number];
        queuedBytes -= item.bytes;
        if (head === queue.length) {
          queue = [];
          head = 0;
        } else if (head > 1024 && head * 2 > queue.length) {
          queue.splice(0, head);
          head = 0;
        }
        if (gzip === undefined) {
          // Transfer the queued charge to the exact response write callback.
          charge(item.source, -item.bytes);
          blocked = !writeBytes(item.frame, item.source);
        } else {
          flushing = true;
          inputBytes = item.bytes;
          encodingSource = item.source;
          // Exactly one frame is in zlib at a time. flush's callback is after its write;
          // if write returned false, writableNeedDrain additionally gates the next frame.
          gzip.write(item.frame);
          gzip.flush(constants.Z_SYNC_FLUSH, () => {
            if (closed) return;
            inputBytes = 0;
            charge(item.source, -item.bytes);
            flushing = false;
            if (!gzip.writableNeedDrain) pump();
            else checkStall();
          });
        }
      }
      if (
        ending &&
        head === queue.length &&
        !flushing &&
        (gzip?.readableLength ?? 0) === 0 &&
        !blocked &&
        !res.writableNeedDrain &&
        !ended
      ) {
        ended = true;
        if (gzip === undefined) res.end();
        else {
          encodingSource = undefined; // trailer has no frame payload/source
          gzip.end(); // onEncodedEnd ends the response after the trailer
        }
      }
      checkStall();
      notifyIdle();
    } catch {
      abort();
    }
  }

  req.on("error", abort);
  res.on("error", abort);
  res.once("close", onClose);
  res.once("finish", onFinish);
  res.on("drain", onDrain);
  if (gzip !== undefined) {
    gzip.on("error", abort);
    gzip.on("drain", pump);
    gzip.once("close", () => {
      gzip.removeListener("error", abort);
      gzip.removeListener("drain", pump);
    });
    // Explicit pipe preserves response write callbacks for source attribution. The
    // default Readable.pipe discards those callbacks; socket drain alone is not a
    // per-source delivery boundary. Retain the standard pipe/unpipe notifications.
    gzip.on("data", onEncoded);
    gzip.once("end", onEncodedEnd);
    res.emit("pipe", gzip);
  }

  return {
    pendingBytes,
    onIdle(fn) {
      if (closed || ending) return () => {};
      let live = true;
      const run = () => {
        if (live) {
          live = false;
          fn();
        }
      };
      idle.add(run);
      queueMicrotask(notifyIdle); // caller installs cancellation/deadline before notification
      return () => {
        live = false;
        idle.delete(run);
      };
    },
    send(frame, source) {
      if (closed || ending) return false;
      const bytes = Buffer.byteLength(frame, "utf8");
      if (pendingBytes() + bytes > MAX_PENDING_BYTES) {
        abort(); // reconnect resyncs/re-snapshots instead of retaining an unbounded FIFO
        return false;
      }
      queue.push({ frame, bytes, ...(source === undefined ? {} : { source }) });
      queuedBytes += bytes;
      charge(source, bytes);
      pump();
      return !closed;
    },
    finish(terminal) {
      if (closed || ending) return;
      ending = true;
      if (terminal !== undefined) {
        const bytes = Buffer.byteLength(terminal, "utf8");
        if (pendingBytes() - queuedBytes + bytes > MAX_PENDING_BYTES) {
          abort();
          return;
        }
        for (let i = head; i < queue.length; i++) charge(queue[i]!.source, -queue[i]!.bytes);
        queue = [{ frame: terminal, bytes }];
        head = 0;
        queuedBytes = queue[0]!.bytes;
      }
      pump();
    },
    abort,
  };
}
