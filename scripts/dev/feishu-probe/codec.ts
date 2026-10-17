// Wire reference: larksuite/node-sdk b188be60134d409b61259546bcf69c731d2b0b7c
// ws-client/proto-buf/pbbp2.js Frame.encode/decode, Header.encode/decode.
// Independently implemented; LogIDNew is a STRING (field 9), not a uint64.
export const MAX_FRAME = 1024 * 1024;
export interface Frame {
  seqId: bigint;
  logId: bigint;
  service: number;
  method: number;
  headers: { key: string; value: string }[];
  payloadEncoding?: string;
  payloadType?: string;
  payload?: Uint8Array;
  logIdNew?: string;
}
const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const U64 = (1n << 64n) - 1n;
function varint(value: bigint): number[] {
  if (value < 0n || value > U64) throw new Error("uint64-range");
  const out: number[] = [];
  do {
    out.push(Number(value & 127n) | (value > 127n ? 128 : 0));
    value >>= 7n;
  } while (value);
  return out;
}
function bytesField(id: number, bytes: Uint8Array): number[] {
  return [...varint(BigInt(id * 8 + 2)), ...varint(BigInt(bytes.length)), ...bytes];
}
function stringField(id: number, value: string): number[] {
  return bytesField(id, utf8.encode(value));
}
function int32(value: number): bigint {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new Error("int32-range");
  return BigInt.asUintN(64, BigInt(value));
}
export function encodeFrame(frame: Frame): Uint8Array {
  checkHeaders(frame.headers);
  // Array.push(...payload) can exceed the JS argument limit even below 1 MiB.
  const parts: number[][] = [
    [8, ...varint(frame.seqId)],
    [16, ...varint(frame.logId)],
    [24, ...varint(int32(frame.service))],
    [32, ...varint(int32(frame.method))],
  ];
  for (const h of frame.headers)
    parts.push(bytesField(5, Uint8Array.from([...stringField(1, h.key), ...stringField(2, h.value)])));
  if (frame.payloadEncoding !== undefined) parts.push(stringField(6, frame.payloadEncoding));
  if (frame.payloadType !== undefined) parts.push(stringField(7, frame.payloadType));
  if (frame.payload !== undefined) parts.push(bytesField(8, frame.payload));
  if (frame.logIdNew !== undefined) parts.push(stringField(9, frame.logIdNew));
  const length = parts.reduce((n, p) => n + p.length, 0);
  if (length > MAX_FRAME) throw new Error("frame-too-large");
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
class Reader {
  bytes: Uint8Array;
  pos = 0;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  uint(): bigint {
    let n = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.bytes.length) throw new Error("truncated-varint");
      const b = this.bytes[this.pos++]!;
      if (i === 9 && b > 1) throw new Error("overflow-varint");
      n |= BigInt(b & 127) << BigInt(7 * i);
      if (!(b & 128)) return n;
    }
    throw new Error("malformed-varint");
  }
  take(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.bytes.length - this.pos) throw new Error("truncated-field");
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  data(): Uint8Array {
    return this.take(Number(this.uint()));
  }
  skip(wire: number): void {
    if (wire === 0) this.uint();
    else if (wire === 1) this.take(8);
    else if (wire === 2) this.data();
    else if (wire === 5) this.take(4);
    else throw new Error("unsupported-wire");
  }
  tag(): [number, number] {
    const n = this.uint();
    if (n > 0xffffffffn || n >> 3n === 0n) throw new Error("invalid-tag");
    return [Number(n >> 3n), Number(n & 7n)];
  }
}
function checkHeaders(headers: Frame["headers"]): void {
  if (headers.length > 64) throw new Error("too-many-headers");
  for (const h of headers)
    if (utf8.encode(h.key).length > 4096 || utf8.encode(h.value).length > 4096) throw new Error("header-too-large");
}
function decodeHeader(bytes: Uint8Array): Frame["headers"][number] {
  const r = new Reader(bytes);
  let key: string | undefined, value: string | undefined;
  while (r.pos < bytes.length) {
    const [id, wire] = r.tag();
    if (id === 1 || id === 2) {
      if (wire !== 2) throw new Error("header-wire");
      const text = decoder.decode(r.data());
      if (id === 1) key = text;
      else value = text;
    } else r.skip(wire);
  }
  if (key === undefined || value === undefined) throw new Error("header-required");
  return { key, value };
}
export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length > MAX_FRAME) throw new Error("frame-too-large");
  const r = new Reader(bytes);
  const frame: Frame = { seqId: 0n, logId: 0n, service: 0, method: 0, headers: [] };
  const required = new Set<number>();
  while (r.pos < bytes.length) {
    const [id, wire] = r.tag();
    if (id >= 1 && id <= 4) {
      if (wire !== 0) throw new Error("frame-wire");
      const n = r.uint();
      required.add(id);
      if (id === 1) frame.seqId = n;
      if (id === 2) frame.logId = n;
      if (id === 3) frame.service = Number(BigInt.asIntN(32, n));
      if (id === 4) frame.method = Number(BigInt.asIntN(32, n));
    } else if (id >= 5 && id <= 9) {
      if (wire !== 2) throw new Error("frame-wire");
      const b = r.data();
      if (id === 5) frame.headers.push(decodeHeader(b));
      if (id === 6) frame.payloadEncoding = decoder.decode(b);
      if (id === 7) frame.payloadType = decoder.decode(b);
      if (id === 8) frame.payload = Uint8Array.from(b);
      if (id === 9) frame.logIdNew = decoder.decode(b);
      checkHeaders(frame.headers);
    } else r.skip(wire);
  }
  if (required.size !== 4) throw new Error("frame-required");
  return frame;
}
export function header(frame: Frame, key: string): string | undefined {
  return frame.headers.findLast((h) => h.key === key)?.value;
}
export function ackFrame(frame: Frame, elapsedMs = 0): Frame {
  return {
    ...frame,
    headers: [...frame.headers, { key: "biz_rt", value: String(Math.max(0, Math.floor(elapsedMs))) }],
    payload: utf8.encode('{"code":200}'),
  };
}
interface PartialMessage {
  sum: number;
  parts: Map<number, Uint8Array>;
  bytes: number;
  at: number;
}
export class Fragments {
  private pending = new Map<string, PartialMessage>();
  private total = 0;
  clear(): void {
    this.pending.clear();
    this.total = 0;
  }
  private remove(id: string, p: PartialMessage): void {
    this.total -= p.bytes;
    this.pending.delete(id);
  }
  add(frame: Frame, now = Date.now()): Uint8Array | undefined {
    for (const [id, p] of this.pending) if (now - p.at >= 10_000) this.remove(id, p);
    const id = header(frame, "message_id");
    const sumText = header(frame, "sum"),
      seqText = header(frame, "seq");
    if (!id || !/^\d+$/.test(sumText ?? "") || !/^\d+$/.test(seqText ?? "")) throw new Error("fragment-meta");
    const sum = Number(sumText),
      seq = Number(seqText);
    if (!Number.isInteger(sum) || sum < 1 || sum > 64 || !Number.isInteger(seq) || seq < 0 || seq >= sum)
      throw new Error("fragment-meta");
    const bytes = frame.payload ?? new Uint8Array();
    let p = this.pending.get(id);
    if (p && p.sum !== sum) throw new Error("fragment-sum");
    if (!p) {
      if (this.pending.size >= 16) throw new Error("fragment-capacity");
      p = { sum, parts: new Map(), bytes: 0, at: now };
    }
    const previous = p.parts.get(seq);
    if (previous) {
      if (previous.length !== bytes.length || !previous.every((b, i) => b === bytes[i]))
        throw new Error("fragment-conflict");
      return undefined;
    }
    if (p.bytes + bytes.length > MAX_FRAME || this.total + bytes.length > 8 * MAX_FRAME)
      throw new Error("reassembled-too-large");
    p.parts.set(seq, bytes.slice());
    p.bytes += bytes.length;
    this.total += bytes.length;
    this.pending.set(id, p);
    if (p.parts.size !== sum) return undefined;
    const out = new Uint8Array(p.bytes);
    let offset = 0;
    for (let i = 0; i < sum; i++) {
      const b = p.parts.get(i)!;
      out.set(b, offset);
      offset += b.length;
    }
    this.remove(id, p);
    return out;
  }
}
