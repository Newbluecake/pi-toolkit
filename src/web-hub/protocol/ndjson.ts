/**
 * NDJSON framing over the agent↔hub unix socket (plan §包 A — frozen interface).
 *
 * Frames are split on the byte 0x0A only (a trailing `\r` is stripped), so raw
 * U+2028/U+2029 inside JSON strings never split a frame and readline's extra
 * buffering/decoding layers are avoided. Chunks are concatenated across pushes.
 */
import { Buffer } from "node:buffer";

export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export type NdjsonError = { code: "E_FRAME_TOO_LARGE"; bytes: number } | { code: "E_BAD_JSON"; sample: string };

export interface NdjsonDecoderOptions {
  maxFrameBytes?: number | undefined;
  onFrame: (value: unknown) => void;
  onError: (err: NdjsonError) => void;
}

const LF = 0x0a;
const CR = 0x0d;
const SAMPLE_BYTES = 256;

export class NdjsonDecoder {
  private readonly maxFrameBytes: number;
  private readonly opts: NdjsonDecoderOptions;
  private buf: Buffer = Buffer.alloc(0);
  private poisoned = false;

  constructor(opts: NdjsonDecoderOptions) {
    this.opts = opts;
    this.maxFrameBytes = opts.maxFrameBytes ?? MAX_FRAME_BYTES;
  }

  /** Feed a socket chunk. After `E_FRAME_TOO_LARGE` the decoder is poisoned: further pushes are ignored. */
  push(chunk: Buffer | string): void {
    if (this.poisoned) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buf = this.buf.length === 0 ? bytes : Buffer.concat([this.buf, bytes]);
    this.drain();
  }

  /** Bytes buffered so far that do not yet form a complete frame. */
  get bufferedBytes(): number {
    return this.buf.length;
  }

  private drain(): void {
    for (;;) {
      const idx = this.buf.indexOf(LF);
      if (idx === -1) {
        if (this.buf.length > this.maxFrameBytes) {
          // No newline in sight and already over budget: the frame can only grow.
          this.poison(this.buf.length);
        }
        return;
      }
      let end = idx;
      if (end > 0 && this.buf.readUInt8(end - 1) === CR) end--;
      const frameBytes = end;
      if (frameBytes > this.maxFrameBytes) {
        this.poison(frameBytes);
        return;
      }
      const text = this.buf.toString("utf8", 0, end);
      this.buf = Buffer.from(this.buf.subarray(idx + 1));
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        this.opts.onError({ code: "E_BAD_JSON", sample: text.slice(0, SAMPLE_BYTES) });
        continue;
      }
      this.opts.onFrame(value);
    }
  }

  private poison(bytes: number): void {
    this.poisoned = true;
    this.buf = Buffer.alloc(0);
    this.opts.onError({ code: "E_FRAME_TOO_LARGE", bytes });
  }
}

/** Encode one frame: JSON text + terminating newline. */
export function encodeFrame(frame: object): string {
  return `${JSON.stringify(frame)}\n`;
}
