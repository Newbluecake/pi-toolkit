/**
 * Regenerate the frozen pbbp2 vectors using ONLY the pinned upstream encoder:
 *
 *   git clone https://github.com/larksuite/node-sdk.git /tmp/feishu-sdk
 *   git -C /tmp/feishu-sdk checkout b188be60134d409b61259546bcf69c731d2b0b7c
 *   npm install --prefix /tmp/feishu-sdk --ignore-scripts
 *   npx tsx scripts/dev/feishu-vectors.ts --sdk-root /tmp/feishu-sdk
 *   npx prettier --write tests/fixtures/feishu/pbbp2-vectors.json
 *
 * protobufjs 7.6.6 was used for this fixture (upstream declares ^7.2.6). No
 * runtime dependency is added. The source SHA-256 is checked BEFORE evaluation;
 * the sole source adaptation is removing the two ESM exports in a CJS vm wrapper.
 * IDs enter upstream as low/high words: protobufjs's Long-disabled decoder loses
 * precision above 2^53, but its Writer accepts the full 64-bit words correctly.
 * This script never imports our production codec or fetches anything at runtime.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const commit = "b188be60134d409b61259546bcf69c731d2b0b7c";
const sourceSha256 = "f7989fe3472ef2ea51a5ad9851a956bf978eb5dcc4eeb6258020cf2f16c04ee8";
const script = "scripts/dev/feishu-vectors.ts";
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--sdk-root")
  throw new Error(`Usage: npx tsx ${script} --sdk-root <pinned-sdk-checkout>`);
const root = resolve(args[1]!);
const source = readFileSync(resolve(root, "ws-client/proto-buf/pbbp2.js"), "utf8");
assert.equal(createHash("sha256").update(source).digest("hex"), sourceSha256, "pinned pbbp2.js source mismatch");
const require = createRequire(resolve(root, "package.json"));
const executable = source.replace("export const pbbp2", "const pbbp2").replace("export { $root as default };", "");
const upstream = runInNewContext(`${executable}\npbbp2;`, { require, Buffer });
const protobufjsVersion: string = require("protobufjs/package.json").version;

interface VectorFrame {
  seqId: string;
  logId: string;
  service: number;
  method: number;
  headers: { key: string; value: string }[];
  payloadEncoding?: string;
  payloadType?: string;
  payloadHex?: string;
  logIdNew?: string;
}
const vectors: { name: string; frame: VectorFrame; hex: string }[] = [];
function add(name: string, frame: VectorFrame): void {
  const words = (n: string) => ({ low: Number(BigInt(n) & 0xffffffffn), high: Number(BigInt(n) >> 32n) });
  const message: Record<string, unknown> = {
    SeqID: words(frame.seqId),
    LogID: words(frame.logId),
    service: frame.service,
    method: frame.method,
    headers: frame.headers,
  };
  if (frame.payloadEncoding !== undefined) message.payloadEncoding = frame.payloadEncoding;
  if (frame.payloadType !== undefined) message.payloadType = frame.payloadType;
  if (frame.payloadHex !== undefined) message.payload = Buffer.from(frame.payloadHex, "hex");
  if (frame.logIdNew !== undefined) message.LogIDNew = frame.logIdNew;
  const bytes = upstream.Frame.encode(message).finish();
  const decoded = upstream.Frame.decode(bytes);
  // Upstream sanity check independent of our codec, including optional presence.
  assert.equal(decoded.SeqID, Number(frame.seqId));
  assert.equal(decoded.LogID, Number(frame.logId));
  assert.equal(decoded.service, frame.service);
  assert.equal(decoded.method, frame.method);
  assert.equal(JSON.stringify(decoded.headers), JSON.stringify(frame.headers));
  for (const [field, expected] of [
    ["payloadEncoding", frame.payloadEncoding],
    ["payloadType", frame.payloadType],
    ["LogIDNew", frame.logIdNew],
  ] as const) {
    assert.equal(Object.hasOwn(decoded, field), expected !== undefined);
    if (expected !== undefined) assert.equal(decoded[field], expected);
  }
  assert.equal(Object.hasOwn(decoded, "payload"), frame.payloadHex !== undefined);
  if (frame.payloadHex !== undefined) assert.equal(Buffer.from(decoded.payload).toString("hex"), frame.payloadHex);
  vectors.push({ name, frame, hex: Buffer.from(bytes).toString("hex") });
}

const base: VectorFrame = { seqId: "0", logId: "0", service: 7, method: 0, headers: [] };
add("ping", { ...base, headers: [{ key: "type", value: "ping" }] });
add("pong-config", {
  ...base,
  headers: [{ key: "type", value: "pong" }],
  payloadHex: Buffer.from(
    '{"PingInterval":90,"ReconnectCount":-1,"ReconnectInterval":90,"ReconnectNonce":25}',
  ).toString("hex"),
});
const event: VectorFrame = {
  seqId: "18446744073709551615",
  logId: "9223372036854775809",
  service: 7,
  method: 1,
  headers: [
    { key: "type", value: "event" },
    { key: "message_id", value: "fixture-message" },
    { key: "sum", value: "1" },
    { key: "seq", value: "0" },
    { key: "x_frontier_recieved_time", value: "1792296000000" },
    { key: "x_frontier_arriverate", value: "1" },
    { key: "instance_id", value: "fixture-instance" },
    { key: "trace_id", value: "fixture-trace" },
  ],
  payloadEncoding: "",
  payloadType: "application/json",
  payloadHex: Buffer.from(
    '{"schema":"2.0","header":{"event_type":"im.message.receive_v1"},"event":{"text":"你好🌍"}}',
  ).toString("hex"),
  logIdNew: "opaque-log-id/你好",
};
add("event-tenant-shape", event);
const payload = Buffer.from(event.payloadHex!, "hex");
const cut = payload.indexOf(Buffer.from("你")) + 1; // A multibyte code point straddles chunks.
for (let seq = 0; seq < 2; seq++) {
  add(`chunk-${seq}`, {
    ...event,
    seqId: String(seq + 128),
    headers: event.headers.map((h) =>
      h.key === "sum" ? { ...h, value: "2" } : h.key === "seq" ? { ...h, value: String(seq) } : h,
    ),
    payloadHex: (seq === 0 ? payload.subarray(0, cut) : payload.subarray(cut)).toString("hex"),
  });
}
add("ack", {
  ...event,
  headers: [...event.headers, { key: "biz_rt", value: "17" }],
  payloadHex: Buffer.from('{"code":200}').toString("hex"),
});
add("required-zeros", { ...base, service: 0 });
add("optional-empty-present", { ...base, payloadEncoding: "", payloadType: "", payloadHex: "", logIdNew: "" });
add("int32-negative-u64-boundaries", {
  ...base,
  service: -2147483648,
  method: -1,
  seqId: "9007199254740993",
  logId: "18446744073709551615",
});
add("unicode-bom-and-duplicates", {
  ...base,
  headers: [
    { key: "type", value: "ping" },
    { key: "type", value: "event" },
    { key: "__proto__", value: "未知" },
  ],
  payloadType: "\ufeffjson",
  logIdNew: "\u0000é🌍",
});

// Stable PRNG + 128 independent upstream encodes broaden varint/header coverage.
let seed = 0x188be601;
function random(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed;
}
const alphabet = ["", "a", "你好", "🌍", "\ufeff", "\u0000", "é", "long-".repeat(30)];
const word = () => alphabet[random() % alphabet.length]!;
for (let i = 0; i < 128; i++) {
  const frame: VectorFrame = {
    seqId: ((BigInt(random()) << 32n) | BigInt(random())).toString(),
    logId: ((BigInt(random()) << 32n) | BigInt(random())).toString(),
    service: random() | 0,
    method: random() | 0,
    headers: Array.from({ length: random() % 8 }, () => ({ key: word(), value: word() })),
  };
  const mask = random();
  if (mask & 1) frame.payloadEncoding = word();
  if (mask & 2) frame.payloadType = word();
  if (mask & 4)
    frame.payloadHex = Buffer.from(Array.from({ length: random() % 64 }, () => random() & 255)).toString("hex");
  if (mask & 8) frame.logIdNew = word();
  add(`seeded-${i.toString().padStart(3, "0")}`, frame);
}
const fixture = {
  provenance: {
    repository: "https://github.com/larksuite/node-sdk",
    commit,
    source: "ws-client/proto-buf/pbbp2.js",
    sourceSha256,
    protobufjsVersion,
    script,
    regenerate: `npx tsx ${script} --sdk-root <checkout-at-${commit}>`,
    seed: "0x188be601",
  },
  vectors,
};
const output = resolve("tests/fixtures/feishu/pbbp2-vectors.json");
writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`${vectors.length} upstream vectors → ${output}`);
