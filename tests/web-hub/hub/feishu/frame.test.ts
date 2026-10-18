import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FEISHU_ACK, FEISHU_FRAME_LIMITS } from "../../../../src/web-hub/protocol/feishu.js";
import {
  ackFrame,
  controlType,
  decodeFrame,
  encodeFrame,
  FrameError,
  header,
  pingFrame,
  pongFrame,
  type Frame,
  type FrameErrorCode,
} from "../../../../src/web-hub/hub/feishu/frame.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../../fixtures/feishu/pbbp2-vectors.json", import.meta.url), "utf8"),
) as {
  provenance: { commit: string; sourceSha256: string; script: string; protobufjsVersion: string };
  vectors: {
    name: string;
    hex: string;
    frame: Omit<Frame, "seqId" | "logId" | "payload"> & { seqId: string; logId: string; payloadHex?: string };
  }[];
};
function vectorFrame(v: (typeof fixture.vectors)[number]): Frame {
  const { payloadHex, ...frame } = v.frame;
  return {
    ...frame,
    seqId: BigInt(frame.seqId),
    logId: BigInt(frame.logId),
    ...(payloadHex === undefined ? {} : { payload: Uint8Array.from(Buffer.from(payloadHex, "hex")) }),
  };
}
function bytes(...parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(Buffer.concat(parts));
}
function uint(n: bigint): Uint8Array {
  const out: number[] = [];
  do {
    out.push(Number(n & 127n) | (n > 127n ? 128 : 0));
    n >>= 7n;
  } while (n);
  return Uint8Array.from(out);
}
function data(id: number, payload: Uint8Array): Uint8Array {
  return bytes(uint(BigInt(id * 8 + 2)), uint(BigInt(payload.length)), payload);
}
const utf8 = (s: string) => new TextEncoder().encode(s);
const baseBytes = Uint8Array.from([8, 0, 16, 0, 24, 0, 32, 0]);
const base = (): Frame => ({ seqId: 0n, logId: 0n, service: 0, method: 0, headers: [] });
function error(input: unknown, code: FrameErrorCode): void {
  expect(() => decodeFrame(input)).toThrowError(FrameError);
  expect(() => decodeFrame(input)).toThrowError(code);
}

// Wire bytes below are built independently of encodeFrame; malformed tests must
// not pass merely because encoder and decoder share a bug.
describe("pinned upstream pbbp2 vectors", () => {
  it("records the immutable source and generator", () => {
    expect(fixture.provenance).toMatchObject({
      commit: "b188be60134d409b61259546bcf69c731d2b0b7c",
      sourceSha256: "f7989fe3472ef2ea51a5ad9851a956bf978eb5dcc4eeb6258020cf2f16c04ee8",
      script: "scripts/dev/feishu-vectors.ts",
      protobufjsVersion: "7.6.6",
    });
    expect(fixture.vectors).toHaveLength(138);
  });
  it.each(fixture.vectors)("$name: exact upstream encode and independent decode", (v) => {
    const frame = vectorFrame(v);
    expect(Buffer.from(encodeFrame(frame)).toString("hex")).toBe(v.hex);
    expect(decodeFrame(Buffer.from(v.hex, "hex"))).toEqual(frame);
    expect(Buffer.from(encodeFrame(decodeFrame(Buffer.from(v.hex, "hex")))).toString("hex")).toBe(v.hex);
  });
});

describe("frame malformed admission (plan §2.3)", () => {
  it.each(["text", "", null, undefined, {}, [], new DataView(new ArrayBuffer(8))])("rejects non-binary %#", (input) => {
    error(input, "non-binary");
  });
  it("accepts ArrayBuffer and respects Uint8Array/Buffer byte offsets", () => {
    expect(decodeFrame(baseBytes.slice().buffer)).toEqual(base());
    const padded = Buffer.concat([Buffer.from([255]), baseBytes, Buffer.from([255])]);
    expect(decodeFrame(padded.subarray(1, -1))).toEqual(base());
  });
  it.each([
    ["missing required", new Uint8Array(), "frame-required"],
    ["truncated varint", Uint8Array.from([8, 128]), "truncated-varint"],
    ["truncated tag", bytes(baseBytes, Uint8Array.from([128])), "truncated-varint"],
    ["overflow varint", bytes(Uint8Array.from([8]), Uint8Array.from([...Array(9).fill(255), 2])), "overflow-varint"],
    ["eleven-byte varint", bytes(Uint8Array.from([8]), new Uint8Array(11).fill(128)), "overflow-varint"],
    ["zero field number", bytes(baseBytes, Uint8Array.from([0])), "invalid-tag"],
    ["oversize tag", bytes(baseBytes, uint(1n << 32n)), "invalid-tag"],
    ["wrong integer wire", Uint8Array.from([10, 0]), "frame-wire"],
    ["wrong bytes wire", bytes(baseBytes, Uint8Array.from([48, 0])), "frame-wire"],
    ["incomplete bytes", bytes(baseBytes, Uint8Array.from([66, 2, 1])), "truncated-field"],
    [
      "huge length without allocation",
      bytes(baseBytes, Uint8Array.from([66]), uint((1n << 64n) - 1n)),
      "truncated-field",
    ],
    ["invalid UTF8 string", bytes(baseBytes, data(6, Uint8Array.from([255]))), "invalid-utf8"],
    ["missing header key", bytes(baseBytes, data(5, data(2, utf8("v")))), "header-required"],
    ["missing header value", bytes(baseBytes, data(5, data(1, utf8("k")))), "header-required"],
    ["empty header message", bytes(baseBytes, data(5, new Uint8Array())), "header-required"],
    ["wrong header wire", bytes(baseBytes, data(5, Uint8Array.from([8, 0]))), "header-wire"],
    [
      "nested field overruns header",
      bytes(baseBytes, data(5, Uint8Array.from([10, 3, 65])), data(6, utf8("rest"))),
      "truncated-field",
    ],
    ["truncated unknown fixed64", bytes(baseBytes, Uint8Array.from([81, 1])), "truncated-field"],
    ["truncated unknown fixed32", bytes(baseBytes, Uint8Array.from([85, 1])), "truncated-field"],
    ["unsupported group start", bytes(baseBytes, Uint8Array.from([83])), "unsupported-wire"],
    ["unsupported group end", bytes(baseBytes, Uint8Array.from([84])), "unsupported-wire"],
    ["invalid wire 6", bytes(baseBytes, Uint8Array.from([86])), "unsupported-wire"],
    ["invalid wire 7", bytes(baseBytes, Uint8Array.from([87])), "unsupported-wire"],
  ] as const)("%s", (_name, input, code) => error(input, code));
  it.each([1, 2, 3, 4])("requires field %i even if other fields are present", (id) => {
    error(Uint8Array.from([...baseBytes].filter((_, i) => Math.floor(i / 2) !== id - 1)), "frame-required");
  });
  it("skips unknown fields of exactly the four supported wire types", () => {
    const unknown = bytes(
      Uint8Array.from([80, 128, 1, 89]),
      new Uint8Array(8),
      data(12, utf8("future")),
      Uint8Array.from([109, 1, 2, 3, 4]),
    );
    expect(decodeFrame(bytes(baseBytes, unknown))).toEqual(base());
    const nested = bytes(data(1, utf8("key")), unknown, data(2, utf8("value")));
    expect(decodeFrame(bytes(baseBytes, data(5, nested))).headers).toEqual([{ key: "key", value: "value" }]);
  });
  it("last scalar/optional/header subfield wins, as in protobufjs", () => {
    const nested = bytes(data(1, utf8("old")), data(2, utf8("old")), data(1, utf8("new")), data(2, utf8("new")));
    expect(
      decodeFrame(
        bytes(baseBytes, Uint8Array.from([8, 123]), data(6, utf8("old")), data(6, utf8("")), data(5, nested)),
      ),
    ).toEqual({
      ...base(),
      seqId: 123n,
      payloadEncoding: "",
      headers: [{ key: "new", value: "new" }],
    });
  });
  it("admits exactly 1 MiB; encoder and decoder refuse the next byte", () => {
    const frame = { ...base(), payload: new Uint8Array(FEISHU_FRAME_LIMITS.maxFrameBytes - 12) };
    const encoded = encodeFrame(frame);
    expect(encoded.length).toBe(FEISHU_FRAME_LIMITS.maxFrameBytes);
    expect(decodeFrame(encoded).payload?.length).toBe(frame.payload.length);
    error(bytes(encoded, new Uint8Array(1)), "frame-too-large");
    expect(() => encodeFrame({ ...frame, payload: new Uint8Array(frame.payload.length + 1) })).toThrowError(
      "frame-too-large",
    );
  });
  it("admits 64 headers; decoder rejects 65, including ACK-shaped inbound data", () => {
    const empty = data(5, Uint8Array.from([10, 0, 18, 0]));
    const accepted = bytes(baseBytes, ...Array.from({ length: FEISHU_FRAME_LIMITS.maxHeaders }, () => empty));
    expect(decodeFrame(accepted).headers).toHaveLength(64);
    error(bytes(accepted, empty), "too-many-headers");
    expect(() =>
      encodeFrame({ ...base(), headers: Array.from({ length: 65 }, () => ({ key: "", value: "" })) }),
    ).toThrowError("too-many-headers");
  });
  it.each(["key", "value"] as const)("checks %s as UTF-8 bytes, not character count", (field) => {
    const h = { key: "k", value: "v", [field]: "é".repeat(2048) };
    expect(decodeFrame(encodeFrame({ ...base(), headers: [h] })).headers).toEqual([h]);
    expect(() => encodeFrame({ ...base(), headers: [{ ...h, [field]: h[field] + "x" }] })).toThrowError(
      "header-too-large",
    );
    const raw = data(
      5,
      bytes(data(1, utf8(field === "key" ? h.key + "x" : "k")), data(2, utf8(field === "value" ? h.value + "x" : "v"))),
    );
    error(bytes(baseBytes, raw), "header-too-large");
  });
  it("cannot hide an overlimit header behind a repeated, shorter subfield", () => {
    const raw = data(5, bytes(data(1, new Uint8Array(4097).fill(65)), data(1, utf8("k")), data(2, utf8("v"))));
    error(bytes(baseBytes, raw), "header-too-large");
  });
  it.each(["\ud800", "\udfff"])("rejects unpaired UTF16 surrogate %# on encoding", (payloadType) => {
    expect(() => encodeFrame({ ...base(), payloadType })).toThrowError("invalid-utf8");
  });
  it.each([-1n, 1n << 64n])("rejects out of range uint64 %s", (seqId) => {
    expect(() => encodeFrame({ ...base(), seqId })).toThrowError("uint64-range");
    expect(() => encodeFrame({ ...base(), logId: seqId })).toThrowError("uint64-range");
  });
  it.each([-2147483649, 2147483648, 1.5, NaN, Infinity])("rejects out of range int32 %s", (n) => {
    expect(() => encodeFrame({ ...base(), service: n })).toThrowError("int32-range");
    expect(() => encodeFrame({ ...base(), method: n })).toThrowError("int32-range");
  });
  it("keeps payload bytes opaque: unknown encoding, malformed UTF8/JSON are F3's durable-undecodable path", () => {
    const frame = { ...base(), method: 1, payloadEncoding: "gzip-unknown", payload: Uint8Array.from([255, 0, 123]) };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });
  it("encodes only OWN optional properties, matching pbbp2 presence checks", () => {
    const frame = Object.assign(
      Object.create({
        payloadEncoding: "inherited",
        payloadType: "inherited",
        payload: utf8("inherited"),
        logIdNew: "inherited",
      }),
      base(),
    ) as Frame;
    expect(encodeFrame(frame)).toEqual(baseBytes);
    frame.payloadEncoding = "";
    expect(encodeFrame(frame)).toEqual(bytes(baseBytes, data(6, new Uint8Array())));
  });
  it("copies decoded payload, so input buffer mutation cannot change it", () => {
    const input = encodeFrame({ ...base(), payload: Uint8Array.from([1, 2]) });
    const decoded = decodeFrame(input);
    input.fill(0);
    expect(decoded.payload).toEqual(Uint8Array.from([1, 2]));
  });
});

describe("header semantics and pure builders (R2-i)", () => {
  it("event metadata last-wins; control type first-wins; preserves unknown header order", () => {
    const frame = {
      ...base(),
      headers: [
        { key: "type", value: "ping" },
        { key: "__proto__", value: "safe" },
        { key: "type", value: "event" },
      ],
    };
    expect(header(frame, "type")).toBe("event");
    expect(controlType(frame)).toBe("ping");
    expect(header(frame, "__proto__")).toBe("safe");
    expect(header(frame, "missing")).toBeUndefined();
    expect(controlType(base())).toBeUndefined();
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });
  it("builds SDK ping/pong shapes against upstream bytes", () => {
    expect(Buffer.from(encodeFrame(pingFrame(7))).toString("hex")).toBe(
      fixture.vectors.find((v) => v.name === "ping")!.hex,
    );
    const pong = pongFrame(7, { PingInterval: 90, ReconnectCount: -1, ReconnectInterval: 90, ReconnectNonce: 25 });
    expect(Buffer.from(encodeFrame(pong)).toString("hex")).toBe(
      fixture.vectors.find((v) => v.name === "pong-config")!.hex,
    );
    expect(pongFrame(7)).not.toHaveProperty("payload");
  });
  it("ACK echoes 1–7/9 and every header, overrides payload, appends biz_rt; matches upstream vector", () => {
    const incoming = vectorFrame(fixture.vectors.find((v) => v.name === "event-tenant-shape")!);
    const before = structuredClone(incoming);
    const ack = ackFrame(incoming, 17.9);
    expect(ack).toEqual({
      ...incoming,
      headers: [...incoming.headers, { key: "biz_rt", value: "17" }],
      payload: utf8(FEISHU_ACK.payload),
    });
    expect(Buffer.from(encodeFrame(ack)).toString("hex")).toBe(fixture.vectors.find((v) => v.name === "ack")!.hex);
    ack.headers[0]!.value = "mutated";
    expect(incoming).toEqual(before);
  });
  it.each([-1, NaN, Infinity, -Infinity])("ACK biz_rt is finite and nonnegative for %s", (ms) => {
    expect(header(ackFrame(base(), ms), "biz_rt")).toBe("0");
  });
  it.each([
    [2147483647, "2147483647"],
    [2147483648, "2147483647"],
    [1e21, "2147483647"],
    [Number.MAX_VALUE, "2147483647"],
    [123.9, "123"],
    [1e-7, "0"],
  ] as const)("ACK biz_rt bounds %s to decimal integer %s", (ms, expected) => {
    const value = header(ackFrame(base(), ms), "biz_rt");
    expect(value).toBe(expected);
    expect(value).toMatch(/^\d+$/);
  });
  it("64-header inbound → 65-header outgoing ACK is the only allowed extra encoder slot", () => {
    const incoming = {
      ...base(),
      headers: Array.from({ length: 64 }, (_, i) => ({ key: String(i), value: "unknown" })),
    };
    const ack = ackFrame(incoming);
    expect(ack.headers.slice(0, -1)).toEqual(incoming.headers);
    expect(ack.headers).toHaveLength(65);
    expect(decodeFrame(encodeFrame(incoming))).toEqual(incoming);
    const encoded = encodeFrame(ack);
    expect(encoded).toEqual(
      bytes(
        baseBytes,
        ...ack.headers.map((h) => data(5, bytes(data(1, utf8(h.key)), data(2, utf8(h.value))))),
        data(8, utf8(FEISHU_ACK.payload)),
      ),
    );
    error(encoded, "too-many-headers"); // The inbound admission cap did NOT widen.
    expect(() => encodeFrame({ ...ack, headers: [...ack.headers, { key: "biz_rt", value: "0" }] })).toThrowError(
      "too-many-headers",
    );
    expect(() => encodeFrame({ ...ack, payload: utf8('{"code":201}') })).toThrowError("too-many-headers");
    expect(() =>
      encodeFrame({ ...ack, headers: [...ack.headers.slice(0, -1), { key: "other", value: "0" }] }),
    ).toThrowError("too-many-headers");
    expect(() => encodeFrame({ ...ack, payload: undefined } as unknown as Frame)).toThrowError("too-many-headers");
    const inheritedPayload = Object.assign(Object.create({ payload: utf8(FEISHU_ACK.payload) }), ack) as Frame;
    delete inheritedPayload.payload;
    expect(() => encodeFrame(inheritedPayload)).toThrowError("too-many-headers");
  });
});
