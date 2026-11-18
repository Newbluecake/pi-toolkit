/** One response, identity only. No SSE/clientId/compressor/public queue dependencies. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TerminalViewSinkV2 } from "../../terminal-v2-ports.js";
import { terminalViewFrameV2Ok } from "../../../protocol/terminal-v2.js";
import { TERMINAL_V2_LIMITS as L, terminalBase64BytesV2 } from "../../../protocol/terminal-v2-values.js";
export function terminalNdjsonSinkV2(
  req: IncomingMessage,
  res: ServerResponse,
  onClose: () => void,
): TerminalViewSinkV2 {
  const queue: Array<{ line: string; raw: number; size: number }> = [];
  let closed = false,
    writing = false,
    drained = true,
    raw = 0,
    bytes = 0,
    items = 0;
  function close() {
    if (closed) return;
    closed = true;
    queue.length = 0;
    raw = 0;
    bytes = 0;
    items = 0;
    req.off("aborted", close);
    res.off("close", close);
    res.off("error", close);
    res.off("drain", drain);
    try {
      onClose();
    } finally {
      res.destroy();
    }
  }
  function drain() {
    drained = true;
    flush();
  }
  function flush() {
    if (closed || writing || !drained) return;
    const entry = queue.shift();
    if (!entry) return;
    writing = true;
    try {
      const accepted = res.write(entry.line, (error?: Error | null) => {
        if (closed) return;
        if (error) {
          close();
          return;
        }
        writing = false;
        raw -= entry.raw;
        bytes -= entry.size;
        items--;
        flush();
      });
      if (!accepted) drained = false;
    } catch {
      close();
    }
  }
  req.once("aborted", close);
  res.once("close", close);
  res.once("error", close);
  res.on("drain", drain);
  return {
    send(frame) {
      if (closed || res.destroyed || res.writableEnded) {
        close();
        return false;
      }
      if (!terminalViewFrameV2Ok(frame)) {
        close();
        return false;
      }
      const line = JSON.stringify(frame) + "\n";
      const size = Buffer.byteLength(line);
      const n = frame.t === "output" ? terminalBase64BytesV2(frame.bytesB64)! : 0;
      if (
        size > L.frameBytes ||
        bytes + size + res.writableLength > L.viewSerializedBytes ||
        raw + n > L.viewPendingBytes ||
        items >= L.viewPendingItems
      ) {
        close();
        return false;
      }
      raw += n;
      bytes += size;
      items++;
      queue.push({ line, size, raw: n });
      flush();
      return !closed;
    },
    close,
  };
}
