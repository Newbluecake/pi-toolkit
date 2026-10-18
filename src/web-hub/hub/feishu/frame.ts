/**
 * pbbp2 Frame, independently implemented against larksuite/node-sdk @
 * b188be60134d409b61259546bcf69c731d2b0b7c (ws-client/proto-buf/pbbp2.js).
 * No transport, payload interpretation, timers or I/O. Required fields are always
 * encoded; optional-field presence and all 64 bits of the two IDs are preserved.
 */
import { FEISHU_ACK, FEISHU_FRAME_LIMITS } from "../../protocol/feishu.js";

export interface Header {
  key: string;
  value: string;
}

export interface Frame {
  seqId: bigint;
  logId: bigint;
  service: number;
  method: number;
  headers: Header[];
  payloadEncoding?: string;
  payloadType?: string;
  payload?: Uint8Array;
  /** Field 9 is a string, NOT a third uint64. */
  logIdNew?: string;
}

/** Fixed codes only: never put untrusted frame/header/payload contents in errors. */
export type FrameErrorCode =
  | "non-binary"
  | "frame-too-large"
  | "too-many-headers"
  | "header-too-large"
  | "uint64-range"
  | "int32-range"
  | "invalid-utf8"
  | "truncated-varint"
  | "overflow-varint"
  | "truncated-field"
  | "invalid-tag"
  | "unsupported-wire"
  | "frame-wire"
  | "header-wire"
  | "header-required"
  | "frame-required";

export class FrameError extends Error {
  constructor(readonly code: FrameErrorCode) {
    super(code);
    this.name = "FrameError";
  }
}

const U64_MAX = (1n << 64n) - 1n;

function varint(value: bigint): Uint8Array {
  if (value < 0n || value > U64_MAX) throw new FrameError("uint64-range");
  const bytes: number[] = [];
  do {
    bytes.push(Number(value & 127n) | (value > 127n ? 128 : 0));
    value >>= 7n;
  } while (value !== 0n);
  return Uint8Array.from(bytes);
}

function int32(value: number): bigint {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new FrameError("int32-range");
  return BigInt.asUintN(64, BigInt(value));
}

function text(bytes: Uint8Array): string {
  try {
    // A BOM inside a protobuf string is content, not a stream prefix.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new FrameError("invalid-utf8");
  }
}

function utf8(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  // Reject lone UTF-16 surrogates rather than silently changing their value.
  if (text(bytes) !== value) throw new FrameError("invalid-utf8");
  return bytes;
}

/** Segments avoid spreading a near-1 MiB payload into function arguments/JS arrays. */
class Writer {
  private parts: Uint8Array[] = [];
  private length = 0;

  append(bytes: Uint8Array): void {
    if (bytes.byteLength > FEISHU_FRAME_LIMITS.maxFrameBytes - this.length) throw new FrameError("frame-too-large");
    this.parts.push(bytes);
    this.length += bytes.byteLength;
  }

  integer(id: number, value: bigint): void {
    this.append(varint(BigInt(id * 8)));
    this.append(varint(value));
  }

  data(id: number, bytes: Uint8Array): void {
    this.append(varint(BigInt(id * 8 + 2)));
    this.append(varint(BigInt(bytes.byteLength)));
    this.append(bytes);
  }

  string(id: number, value: string): void {
    this.data(id, utf8(value));
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const bytes of this.parts) {
      out.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return out;
  }
}

function isAck(frame: Frame): boolean {
  const payload = new TextEncoder().encode(FEISHU_ACK.payload);
  return (
    frame.headers.at(-1)?.key === "biz_rt" &&
    Object.hasOwn(frame, "payload") &&
    frame.payload?.length === payload.length &&
    payload.every((b, i) => frame.payload?.[i] === b)
  );
}

export function encodeFrame(frame: Frame): Uint8Array {
  // Inbound admission is strictly 64. An ACK echoes those 64 plus SDK's biz_rt.
  const maxHeaders = FEISHU_FRAME_LIMITS.maxHeaders + (isAck(frame) ? 1 : 0);
  if (frame.headers.length > maxHeaders) throw new FrameError("too-many-headers");
  const writer = new Writer();
  writer.integer(1, frame.seqId);
  writer.integer(2, frame.logId);
  writer.integer(3, int32(frame.service));
  writer.integer(4, int32(frame.method));
  for (const h of frame.headers) {
    const key = utf8(h.key);
    const value = utf8(h.value);
    if (key.length > FEISHU_FRAME_LIMITS.maxHeaderKeyBytes || value.length > FEISHU_FRAME_LIMITS.maxHeaderValueBytes)
      throw new FrameError("header-too-large");
    const nested = new Writer();
    nested.data(1, key);
    nested.data(2, value);
    writer.data(5, nested.finish());
  }
  if (Object.hasOwn(frame, "payloadEncoding") && frame.payloadEncoding !== undefined)
    writer.string(6, frame.payloadEncoding);
  if (Object.hasOwn(frame, "payloadType") && frame.payloadType !== undefined) writer.string(7, frame.payloadType);
  if (Object.hasOwn(frame, "payload") && frame.payload !== undefined) writer.data(8, frame.payload);
  if (Object.hasOwn(frame, "logIdNew") && frame.logIdNew !== undefined) writer.string(9, frame.logIdNew);
  return writer.finish();
}

class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}

  uint(): bigint {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      const byte = this.bytes[this.pos++];
      if (byte === undefined) throw new FrameError("truncated-varint");
      if (i === 9 && byte > 1) throw new FrameError("overflow-varint");
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if ((byte & 128) === 0) return value;
    }
    throw new FrameError("overflow-varint");
  }

  take(length: number): Uint8Array {
    if (length > this.bytes.length - this.pos) throw new FrameError("truncated-field");
    const bytes = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return bytes;
  }

  data(maxBytes?: number): Uint8Array {
    const length = this.uint();
    if (maxBytes !== undefined && length > BigInt(maxBytes)) throw new FrameError("header-too-large");
    if (length > BigInt(this.bytes.length - this.pos)) throw new FrameError("truncated-field");
    return this.take(Number(length));
  }

  tag(): [number, number] {
    const tag = this.uint();
    if (tag > 0xffffffffn || tag >> 3n === 0n) throw new FrameError("invalid-tag");
    return [Number(tag >> 3n), Number(tag & 7n)];
  }

  skip(wire: number): void {
    if (wire === 0) this.uint();
    else if (wire === 1) this.take(8);
    else if (wire === 2) this.data();
    else if (wire === 5) this.take(4);
    else throw new FrameError("unsupported-wire");
  }
}

function decodeHeader(bytes: Uint8Array): Header {
  const reader = new Reader(bytes);
  let key: string | undefined;
  let value: string | undefined;
  while (reader.pos < bytes.length) {
    const [id, wire] = reader.tag();
    if (id === 1 || id === 2) {
      if (wire !== 2) throw new FrameError("header-wire");
      const field = reader.data(
        id === 1 ? FEISHU_FRAME_LIMITS.maxHeaderKeyBytes : FEISHU_FRAME_LIMITS.maxHeaderValueBytes,
      );
      if (id === 1) key = text(field);
      else value = text(field);
    } else reader.skip(wire);
  }
  if (key === undefined || value === undefined) throw new FrameError("header-required");
  return { key, value };
}

/** Rejects non-binary WS data synchronously. ArrayBuffer and Node Buffer are accepted. */
export function decodeFrame(input: unknown): Frame {
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : undefined;
  if (!bytes) throw new FrameError("non-binary");
  if (bytes.byteLength > FEISHU_FRAME_LIMITS.maxFrameBytes) throw new FrameError("frame-too-large");
  const reader = new Reader(bytes);
  const frame: Frame = { seqId: 0n, logId: 0n, service: 0, method: 0, headers: [] };
  let required = 0;
  while (reader.pos < bytes.length) {
    const [id, wire] = reader.tag();
    if (id >= 1 && id <= 4) {
      if (wire !== 0) throw new FrameError("frame-wire");
      const n = reader.uint();
      required |= 1 << (id - 1);
      if (id === 1) frame.seqId = n;
      else if (id === 2) frame.logId = n;
      else if (id === 3) frame.service = Number(BigInt.asIntN(32, n));
      else frame.method = Number(BigInt.asIntN(32, n));
    } else if (id >= 5 && id <= 9) {
      if (wire !== 2) throw new FrameError("frame-wire");
      if (id === 5 && frame.headers.length >= FEISHU_FRAME_LIMITS.maxHeaders) throw new FrameError("too-many-headers");
      const data = reader.data();
      if (id === 5) frame.headers.push(decodeHeader(data));
      else if (id === 6) frame.payloadEncoding = text(data);
      else if (id === 7) frame.payloadType = text(data);
      else if (id === 8) frame.payload = Uint8Array.from(data);
      else frame.logIdNew = text(data);
    } else reader.skip(wire);
  }
  if (required !== 15) throw new FrameError("frame-required");
  return frame;
}

/** Event headers reduce last-wins, matching SDK handleEventData (R2-i). */
export function header(frame: Frame, key: string): string | undefined {
  for (let i = frame.headers.length - 1; i >= 0; i--) {
    const entry = frame.headers[i]!;
    if (entry.key === key) return entry.value;
  }
  return undefined;
}

/** Control `type` uses Array.find (first-wins), unlike event headers (R2-i). */
export function controlType(frame: Frame): string | undefined {
  return frame.headers.find((h) => h.key === "type")?.value;
}

/** Pure builder, NOT permission to ACK: F3 must establish durable receipt + live gen. */
export function ackFrame(frame: Frame, elapsedMs = 0): Frame {
  // Bound the decimal wire value; even huge finite inputs must never use exponent notation.
  const ms = Number.isFinite(elapsedMs) ? Math.min(0x7fffffff, Math.max(0, Math.floor(elapsedMs))) : 0;
  return {
    ...frame,
    headers: [...frame.headers.map((h) => ({ ...h })), { key: "biz_rt", value: String(ms) }],
    payload: new TextEncoder().encode(FEISHU_ACK.payload),
  };
}

/** SDK pingLoop shape. Server pings are ignored; this is not a ping response. */
export function pingFrame(service: number): Frame {
  return { seqId: 0n, logId: 0n, service, method: 0, headers: [{ key: "type", value: "ping" }] };
}

/** Fixture/server-side builder. The client never answers server pings (R2-i). */
export function pongFrame(service: number, config?: Record<string, unknown>): Frame {
  const frame = pingFrame(service);
  frame.headers = [{ key: "type", value: "pong" }];
  if (config !== undefined) frame.payload = new TextEncoder().encode(JSON.stringify(config));
  return frame;
}
