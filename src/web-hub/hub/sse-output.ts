/** Per-connection SSE transport. A frame is the scheduling/flush unit, never a wire change. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { constants, createGzip, type Gzip } from "node:zlib";

export interface SseOutput {
  send(frame: string): boolean;
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
  let queue: Array<{ frame: string; bytes: number }> = [];
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

  function clearStall(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function pendingBytes(): number {
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
    queue = [];
    head = 0;
    queuedBytes = inputBytes = 0;
    req.removeListener("error", abort);
    res.removeListener("drain", onDrain);
    res.removeListener("close", onClose);
    res.removeListener("finish", onFinish);
    res.removeListener("error", abort);
    if (gzip !== undefined) {
      gzip.unpipe(res);
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
    pump();
  }

  function pump(): void {
    if (closed) return;
    try {
      while (!blocked && !res.writableNeedDrain && !flushing && head < queue.length) {
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
          blocked = !res.write(item.frame);
        } else {
          flushing = true;
          inputBytes = item.bytes;
          // Exactly one frame is in zlib at a time. flush's callback is after its write;
          // if write returned false, writableNeedDrain additionally gates the next frame.
          gzip.write(item.frame);
          gzip.flush(constants.Z_SYNC_FLUSH, () => {
            if (closed) return;
            inputBytes = 0;
            flushing = false;
            if (!gzip.writableNeedDrain) pump();
            else checkStall();
          });
        }
      }
      if (ending && head === queue.length && !flushing && !blocked && !res.writableNeedDrain && !ended) {
        ended = true;
        if (gzip === undefined) res.end();
        else gzip.end(); // pipe emits the gzip trailer before ending the response
      }
      checkStall();
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
    gzip.pipe(res);
  }

  return {
    send(frame) {
      if (closed || ending) return false;
      const bytes = Buffer.byteLength(frame, "utf8");
      if (pendingBytes() + bytes > MAX_PENDING_BYTES) {
        abort(); // reconnect resyncs/re-snapshots instead of retaining an unbounded FIFO
        return false;
      }
      queue.push({ frame, bytes });
      queuedBytes += bytes;
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
        queue = [{ frame: terminal, bytes }];
        head = 0;
        queuedBytes = queue[0]!.bytes;
      }
      pump();
    },
    abort,
  };
}
