import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { MAX_FRAME_BYTES, NdjsonDecoder, encodeFrame, type NdjsonError } from "../../../src/web-hub/protocol/ndjson.js";

interface Collected {
  frames: unknown[];
  errors: NdjsonError[];
}

function makeDecoder(maxFrameBytes?: number): Collected & { dec: NdjsonDecoder } {
  const out: Collected = { frames: [], errors: [] };
  const dec = new NdjsonDecoder({
    maxFrameBytes,
    onFrame: (v) => out.frames.push(v),
    onError: (e) => out.errors.push(e),
  });
  return { ...out, dec };
}

describe("NdjsonDecoder", () => {
  it("reassembles a frame split across chunks", () => {
    const c = makeDecoder();
    c.dec.push('{"a":');
    expect(c.dec.bufferedBytes).toBe(5);
    c.dec.push("1}\n");
    expect(c.frames).toEqual([{ a: 1 }]);
    expect(c.dec.bufferedBytes).toBe(0);
  });

  it("parses multiple frames in one chunk", () => {
    const c = makeDecoder();
    c.dec.push('{"a":1}\n{"b":2}\n{"c":3}\n');
    expect(c.frames).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("parses frames fed byte by byte", () => {
    const c = makeDecoder();
    const raw = '{"a":"hello"}\n{"b":2}\n';
    for (const b of Buffer.from(raw, "utf8")) c.dec.push(Buffer.from([b]));
    expect(c.frames).toEqual([{ a: "hello" }, { b: 2 }]);
  });

  it("keeps a trailing partial frame buffered", () => {
    const c = makeDecoder();
    c.dec.push('{"a":1}\n{"b":');
    expect(c.frames).toEqual([{ a: 1 }]);
    expect(c.dec.bufferedBytes).toBe(5);
  });

  it("does not split frames on U+2028 / U+2029", () => {
    const c = makeDecoder();
    const frame = { s: "line separators inside" };
    const wire = encodeFrame(frame);
    expect(wire).toContain(" ");
    const mid = Math.floor(wire.length / 2);
    c.dec.push(wire.slice(0, mid));
    c.dec.push(wire.slice(mid));
    expect(c.frames).toEqual([frame]);
  });

  it("accepts \\r\\n line endings", () => {
    const c = makeDecoder();
    c.dec.push('{"a":1}\r\n{"b":2}\r\n');
    expect(c.frames).toEqual([{ a: 1 }, { b: 2 }]);
    expect(c.dec.bufferedBytes).toBe(0);
  });

  it("reassembles multibyte UTF-8 split across chunks", () => {
    const c = makeDecoder();
    const bytes = Buffer.from('{"s":"héllo 你好"}\n', "utf8");
    // split inside the é (0xC3 0xA9)
    const splitAt = bytes.indexOf(Buffer.from([0xc3])) + 1;
    c.dec.push(bytes.subarray(0, splitAt));
    c.dec.push(bytes.subarray(splitAt));
    expect(c.frames).toEqual([{ s: "héllo 你好" }]);
  });

  it("passes a frame of exactly MAX_FRAME_BYTES and rejects one byte more", () => {
    const exactly = makeDecoder();
    const payload = `{"pad":"${"x".repeat(MAX_FRAME_BYTES - 10)}"}`;
    expect(Buffer.byteLength(payload, "utf8")).toBe(MAX_FRAME_BYTES);
    exactly.dec.push(payload + "\n");
    expect(exactly.frames.length).toBe(1);
    expect(exactly.errors).toEqual([]);

    const over = makeDecoder();
    const overPayload = `{"pad":"${"x".repeat(MAX_FRAME_BYTES - 9)}"}`;
    over.dec.push(overPayload + "\n");
    expect(over.frames).toEqual([]);
    expect(over.errors).toEqual([{ code: "E_FRAME_TOO_LARGE", bytes: MAX_FRAME_BYTES + 1 }]);
  });

  it("poisons on oversized frame without newline and ignores further pushes", () => {
    const c = makeDecoder();
    c.dec.push(`{"pad":"${"x".repeat(MAX_FRAME_BYTES + 1)}"}`);
    expect(c.errors).toEqual([{ code: "E_FRAME_TOO_LARGE", bytes: MAX_FRAME_BYTES + 11 }]);
    c.dec.push('{"a":1}\n');
    expect(c.frames).toEqual([]);
    expect(c.errors.length).toBe(1); // poisoned: silent afterwards
  });

  it("honors a custom maxFrameBytes", () => {
    const c = makeDecoder(8);
    c.dec.push('{"a":1}\n'); // 7 bytes frame
    expect(c.frames).toEqual([{ a: 1 }]);
    c.dec.push('{"ab":12}\n'); // 9 bytes frame
    expect(c.errors).toEqual([{ code: "E_FRAME_TOO_LARGE", bytes: 9 }]);
  });

  it("reports bad JSON and keeps parsing subsequent frames", () => {
    const c = makeDecoder();
    c.dec.push('not json\n{"a":1}\n{oops}\n{"b":2}\n');
    expect(c.frames).toEqual([{ a: 1 }, { b: 2 }]);
    expect(c.errors.length).toBe(2);
    expect(c.errors[0]).toEqual({ code: "E_BAD_JSON", sample: "not json" });
    expect(c.errors[1]).toEqual({ code: "E_BAD_JSON", sample: "{oops}" });
  });

  it("accepts string chunks", () => {
    const c = makeDecoder();
    c.dec.push('{"a":');
    c.dec.push("1}\n");
    expect(c.frames).toEqual([{ a: 1 }]);
  });
});

describe("encodeFrame", () => {
  it("appends a newline", () => {
    expect(encodeFrame({ t: "ping", ts: 1 })).toBe('{"t":"ping","ts":1}\n');
  });
});
