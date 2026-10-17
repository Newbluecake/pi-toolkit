import { createHash } from "node:crypto";
import { mkdtemp, chmod, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ackFrame, decodeFrame, encodeFrame, Fragments, MAX_FRAME } from "../../scripts/dev/feishu-probe/codec.ts";
import type { Frame } from "../../scripts/dev/feishu-probe/codec.ts";
import { allowedUrl, hashId, readCredentials, redact, writePrivate } from "../../scripts/dev/feishu-probe/safety.ts";
import { qrMatrix, renderQr } from "../../scripts/dev/feishu-probe/qr.ts";
import { inferTimeUnit, identityConsistent } from "../../scripts/dev/feishu-probe/runtime.ts";
import { parseArgs } from "../../scripts/dev/feishu-probe.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const base: Frame = { seqId: 0n, logId: 0n, service: 7, method: 0, headers: [{ key: "type", value: "ping" }] };
// Generated OFFLINE with the actual upstream Frame.encode, NOT this encoder:
// https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/ws-client/proto-buf/pbbp2.js
// Loaded the pinned file in /tmp, changed only its ESM export to CJS, supplied
// protobufjs/minimal from dev node_modules. For max uint64 use {low:-1,high:-1,unsigned:true};
// upstream disables util.Long, so supplying it as a JS number would lose precision.
// Header.encode: 1=key,2=value. Frame: 1/2 uint64;3/4 int32;5 Header;
// 6/7 string;8 bytes;9 STRING. These literals pin optional-field presence and order.
const vectors: { name: string; frame: Frame; hex: string }[] = [
  { name: "ping", frame: base, hex: "08001000180720002a0c0a0474797065120470696e67" },
  {
    name: "pong with ClientConfig",
    frame: {
      ...base,
      seqId: 1n,
      logId: 2n,
      headers: [{ key: "type", value: "pong" }],
      payload: bytes('{"PingInterval":30}'),
    },
    hex: "08011002180720002a0c0a04747970651204706f6e6742137b2250696e67496e74657276616c223a33307d",
  },
  {
    name: "fragment + max uint64 + LogIDNew string",
    frame: {
      ...base,
      seqId: (1n << 64n) - 1n,
      logId: 128n,
      method: 1,
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: "m1" },
        { key: "sum", value: "2" },
        { key: "seq", value: "0" },
      ],
      payloadEncoding: "",
      payloadType: "application/json",
      payload: bytes('{"schema":'),
      logIdNew: "new-log",
    },
    hex: "08ffffffffffffffffff01108001180720012a0d0a047479706512056576656e742a100a0a6d6573736167655f696412026d312a080a0373756d1201322a080a0373657112013032003a106170706c69636174696f6e2f6a736f6e420a7b22736368656d61223a4a076e65772d6c6f67",
  },
  {
    name: "ACK",
    frame: {
      ...base,
      seqId: 9n,
      logId: 128n,
      method: 1,
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: "m2" },
        { key: "sum", value: "1" },
        { key: "seq", value: "0" },
        { key: "biz_rt", value: "3" },
      ],
      payloadEncoding: "json",
      payloadType: "application/json",
      payload: bytes('{"code":200}'),
      logIdNew: "new-log",
    },
    hex: "0809108001180720012a0d0a047479706512056576656e742a100a0a6d6573736167655f696412026d322a080a0373756d1201312a080a037365711201302a0b0a0662697a5f727412013332046a736f6e3a106170706c69636174696f6e2f6a736f6e420c7b22636f6465223a3230307d4a076e65772d6c6f67",
  },
];
describe("pbbp2 @ b188be6", () => {
  it.each(vectors)("encodes and decodes upstream $name bytes exactly", ({ frame, hex }) => {
    expect(Buffer.from(encodeFrame(frame)).toString("hex")).toBe(hex);
    expect(decodeFrame(Buffer.from(hex, "hex"))).toEqual(frame);
  });
  it("echoes inbound metadata and does not mutate the input ACK", () => {
    const original = vectors[3]!.frame;
    const inbound = { ...original, headers: original.headers.slice(0, -1), payload: bytes("event body") };
    expect(ackFrame(inbound, 3)).toEqual(original);
    expect(inbound.payload).toEqual(bytes("event body"));
    expect(ackFrame(inbound, -5).headers.at(-1)).toEqual({ key: "biz_rt", value: "0" });
  });
  it.each([
    "08",
    "08ffffffffffffffffffff02",
    "08808080808080808080808000",
    "08001000180720002a100a0474797065",
    "08001000180720002a020a00",
    "08001000180720003201ff",
    "0a00",
    "00",
    "0b",
    "080010001807",
  ])("rejects malformed/truncated protobuf %s", (hex) => {
    expect(() => decodeFrame(Buffer.from(hex, "hex"))).toThrow();
  });
  it("checks bounds, required fields and unknown wire types", () => {
    expect(() => decodeFrame(new Uint8Array(MAX_FRAME + 1))).toThrow("too-large");
    expect(() => encodeFrame({ ...base, payload: new Uint8Array(MAX_FRAME) })).toThrow("too-large");
    expect(() => encodeFrame({ ...base, seqId: -1n })).toThrow("uint64-range");
    expect(() => encodeFrame({ ...base, service: 2147483648 })).toThrow("int32-range");
    expect(() => decodeFrame(new Uint8Array())).toThrow("required");
    expect(() =>
      encodeFrame({ ...base, headers: Array.from({ length: 65 }, () => ({ key: "a", value: "b" })) }),
    ).toThrow("headers");
    expect(() => encodeFrame({ ...base, headers: [{ key: "a", value: "字".repeat(1400) }] })).toThrow(
      "header-too-large",
    );
    const encoded = encodeFrame(base);
    // Unknown fields: 10=varint, 11=fixed64, 12=length-delimited, 13=fixed32.
    const unknown = Uint8Array.from([...encoded, 80, 1, 89, 0, 0, 0, 0, 0, 0, 0, 0, 98, 1, 65, 109, 0, 0, 0, 0]);
    expect(decodeFrame(unknown)).toEqual(base);
    expect(decodeFrame(encodeFrame({ ...base, service: -1 })).service).toBe(-1);
    // Never use spread-into-function on large valid frames.
    const large = { ...base, payload: new Uint8Array(900_000).fill(65) };
    expect(decodeFrame(encodeFrame(large)).payload).toEqual(large.payload);
  });
});
function fragment(seq: number, sum: number, data: string | Uint8Array, id = "m"): Frame {
  return {
    ...base,
    method: 1,
    headers: [
      { key: "type", value: "event" },
      { key: "message_id", value: id },
      { key: "sum", value: String(sum) },
      { key: "seq", value: String(seq) },
    ],
    payload: typeof data === "string" ? bytes(data) : data,
  };
}
describe("fragment cache", () => {
  it("assembles out of order, ignores identical duplicate without double accounting", () => {
    const f = new Fragments();
    expect(f.add(fragment(1, 3, "b"), 0)).toBeUndefined();
    expect(f.add(fragment(1, 3, "b"), 1)).toBeUndefined();
    expect(f.add(fragment(2, 3, "c"), 2)).toBeUndefined();
    expect(f.add(fragment(0, 3, "a"), 3)).toEqual(bytes("abc"));
    expect(f.add(fragment(0, 1, "new"), 4)).toEqual(bytes("new"));
  });
  it("rejects conflicting duplicate and inconsistent or invalid metadata", () => {
    const f = new Fragments();
    f.add(fragment(0, 2, "a"), 0);
    expect(() => f.add(fragment(0, 2, "b"), 1)).toThrow("conflict");
    expect(() => f.add(fragment(1, 3, "b"), 1)).toThrow("sum");
    for (const [seq, sum] of [
      [-1, 2],
      [2, 2],
      [0, 0],
      [0, 65],
      [0, 1.5],
      [NaN, 2],
    ])
      expect(() => f.add(fragment(seq!, sum!, "x"), 1)).toThrow("meta");
    expect(() => f.add({ ...base, payload: bytes("x") }, 1)).toThrow("meta");
  });
  it("enforces 1 MiB reassembled, 8 MiB aggregate and 16 sets; TTL releases capacity", () => {
    const f = new Fragments();
    f.add(fragment(0, 2, new Uint8Array(MAX_FRAME)), 0);
    expect(() => f.add(fragment(1, 2, "x"), 1)).toThrow("too-large");
    expect(f.add(fragment(1, 2, ""), 2)?.length).toBe(MAX_FRAME);
    for (let i = 0; i < 8; i++) f.add(fragment(0, 2, new Uint8Array(MAX_FRAME), "large" + i), 3);
    expect(() => f.add(fragment(0, 2, "x", "overflow"), 4)).toThrow("too-large");
    expect(f.add(fragment(0, 1, "ok"), 10_003)).toEqual(bytes("ok"));
    for (let i = 0; i < 16; i++) f.add(fragment(0, 2, "x", "id" + i), 20_000);
    expect(() => f.add(fragment(0, 2, "x", "17"), 20_001)).toThrow("capacity");
    f.clear();
    expect(f.add(fragment(0, 1, "ok"), 20_002)).toEqual(bytes("ok"));
  });
});
describe("hygiene and pure helpers", () => {
  it("redacts secrets, query strings and message text recursively; hashes identities", () => {
    const result = redact(
      {
        app_secret: "super-secret",
        nested: {
          Authorization: "Bearer t",
          tenant_access_token: "t",
          device_code: "d",
          URL: "wss://socket.feishu.cn?a=hidden",
          ownerOpenId: "ou_owner",
          header: { event_type: "im.message.receive_v1" },
          message: { text: "private words", content: '{"text":"private words"}' },
          open_id: "ou_owner",
          value: "super-secret",
          weird: "canary-unknown",
        },
      },
      "",
      ["super-secret"],
    );
    const json = JSON.stringify(result);
    for (const secret of [
      "super-secret",
      "Bearer t",
      "socket.feishu",
      "hidden",
      "ou_owner",
      "private words",
      "canary-unknown",
    ])
      expect(json).not.toContain(secret);
    expect(json).toContain("im.message.receive_v1");
    expect(json).toContain(hashId("ou_owner"));
    expect((result as any).nested.message.text).toEqual({ length: 13, bytes: 13 });
    expect(redact(JSON.parse('{"__proto__":{"text":"private"}}'))).not.toHaveProperty("private");
  });
  it("refuses redirect destinations, lookalikes and credential-bearing URLs", () => {
    expect(allowedUrl("https://open.feishu.cn/open-apis/a", "api").hostname).toBe("open.feishu.cn");
    expect(allowedUrl("wss://msg-frontier.feishu.cn/path?secret=x", "ws").hostname).toBe("msg-frontier.feishu.cn");
    for (const url of [
      "http://open.feishu.cn",
      "https://open.feishu.cn.evil.test",
      "https://evil.test/",
      "https://x@open.feishu.cn/",
      "https://open.feishu.cn:444/",
      "https://open.feishu.cn/#x",
    ])
      expect(() => allowedUrl(url, "api")).toThrow();
    expect(() => allowedUrl("wss://notfeishu.cn/ws", "ws")).toThrow();
    expect(() => allowedUrl("https://open.feishu.cn/qr", "accounts")).toThrow();
  });
  it("writes 0600 atomically and refuses unsafe/symlink credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feishu-probe-"));
    await chmod(dir, 0o700);
    const c = {
      v: 1,
      brand: "feishu",
      appId: "cli_test",
      appSecret: "fake-test-only",
      ownerOpenId: "ou_test",
      createdAt: "2026-10-17",
      gen: "test",
    };
    try {
      const path = await writePrivate("credentials.json", c, dir);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(c);
      expect(await readCredentials(dir)).toEqual(c);
      await chmod(path, 0o644);
      await expect(readCredentials(dir)).rejects.toThrow("file-mode");
      await chmod(path, 0o600);
      await writeFile(path, "x".repeat(4097));
      await expect(readCredentials(dir)).rejects.toThrow("file-size");
      await rm(path);
      await writeFile(join(dir, "target"), JSON.stringify(c), { mode: 0o600 });
      await symlink(join(dir, "target"), path);
      await expect(readCredentials(dir)).rejects.toThrow("file-symlink");
      await expect(writePrivate("../escape.json", {}, dir)).rejects.toThrow("filename");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("parses selection and rejects ambiguous CLI values", () => {
    expect(parseArgs(["--steps", "P3,P2", "--skip", "P2", "--reuse", "--timeout", "10"])).toMatchObject({
      steps: ["P3"],
      reuse: true,
      timeoutMs: 10_000,
    });
    for (const args of [["--steps", ""], ["--steps", "P9"], ["--timeout", "NaN"], ["--timeout", "0"], ["--bad"]])
      expect(() => parseArgs(args)).toThrow();
  });
  it("checks envelope app/tenant consistency and timestamp units without guessing", () => {
    const now = 1_760_000_000_000;
    expect(inferTimeUnit(String(now / 1000), now)).toBe("seconds");
    expect(inferTimeUnit(String(now), now)).toBe("milliseconds");
    expect(inferTimeUnit(String(now * 1000), now)).toBe("microseconds");
    expect(inferTimeUnit("invalid", now)).toBe("unknown");
    const c = { appId: "cli_test" } as any;
    const e = {
      envelope: { header: { app_id: "cli_test", tenant_key: "tenant" }, event: { sender: { tenant_key: "tenant" } } },
    } as any;
    expect(identityConsistent(e, c)).toBe(true);
    e.envelope.event.operator = { tenant_key: "other" };
    expect(identityConsistent(e, c)).toBe(false);
    delete e.envelope.event.operator;
    e.envelope.header.app_id = "other";
    expect(identityConsistent(e, c)).toBe(false);
  });
});
describe("terminal QR", () => {
  // Reference matrix digests from Nayuki @3c6d0b3cefb4e049dc337e82237c9644399716a8
  // encodeSegments([QrSegment.makeBytes(UTF8)], Ecc.LOW,1,40,0,false).
  it.each([
    [
      "https://accounts.feishu.cn/verify?code=ABCD",
      29,
      "2033a1b33c9e0be831a4f5bfb14ebf4196dd9ca8e60bfda83adee554cfcb1749",
    ],
    [
      "https://accounts.feishu.cn/verify?code=" + "x".repeat(200),
      57,
      "ff71dbb96108731fc35406242b3ea82495ba044a5fcdd343d190403336cc6a8c",
    ],
    ["飞书 QR 测试", 21, "c9adf2a799c54d305f9530a51ac5a77fa7d94e6de2688f4e5bdfb15ff6d10f78"],
  ] as const)("matches reference QR byte-mode matrix for %s", (text, size, digest) => {
    const matrix = qrMatrix(text);
    expect(matrix).toHaveLength(size);
    expect(
      createHash("sha256")
        .update(matrix.map((row) => row.map((b) => (b ? "1" : "0")).join("")).join("\n"))
        .digest("hex"),
    ).toBe(digest);
    const terminal = renderQr(text),
      lines = terminal.split("\n");
    expect(lines).toHaveLength(Math.ceil((size + 8) / 2));
    expect(lines[0]).toBe("█".repeat(size + 8));
    expect(terminal).toMatch(/^[█▀▄ \n]+$/);
    expect(terminal).not.toContain(text);
  });
  it("rejects data exceeding QR capacity", () => expect(() => renderQr("x".repeat(4000))).toThrow("qr-too-large"));
});
