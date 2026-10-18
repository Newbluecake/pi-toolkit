import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FEISHU_CHUNK_LIMITS } from "../../../../src/web-hub/protocol/feishu.js";
import { Fragments } from "../../../../src/web-hub/hub/feishu/chunks.js";
import { decodeFrame, type Frame } from "../../../../src/web-hub/hub/feishu/frame.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
function part(id: string, sum: number | string, seq: number | string, payload: string | Uint8Array = "a"): Frame {
  return {
    seqId: 0n,
    logId: 0n,
    service: 1,
    method: 1,
    headers: [
      { key: "message_id", value: id },
      { key: "sum", value: String(sum) },
      { key: "seq", value: String(seq) },
    ],
    payload: typeof payload === "string" ? utf8(payload) : payload,
  };
}
function harness() {
  let now = 0;
  return {
    cache: new Fragments(() => now),
    at: (value: number) => {
      now = value;
    },
  };
}
function complete(cache: Fragments, frame: Frame): Uint8Array {
  const result = cache.add(frame);
  expect(result.status).toBe("complete");
  if (result.status !== "complete") throw new Error(`Expected completion, got ${result.status}`);
  return result.payload;
}
const size = 512 * 1024;
const block = () => new Uint8Array(size).fill(65);
function fill(cache: Fragments, id: string, count: number, sum = 16): void {
  for (let seq = 0; seq < count; seq++)
    expect(cache.add(part(id, sum, seq, block()))).toEqual({ status: "pending", duplicate: false });
}

describe("Feishu fragments: pinned SDK behavior + R2-i", () => {
  it("single fragment completes immediately and frees accounting", () => {
    const { cache } = harness();
    expect(complete(cache, part("single", 1, 0, "hello"))).toEqual(utf8("hello"));
    expect(cache.stats()).toEqual({ messages: 0, bytes: 0 });
    // Transport cache is not an event dedup ledger (F3/F6 own that).
    expect(complete(cache, part("single", 1, 0, "again"))).toEqual(utf8("again"));
  });
  it("orders chunks by seq rather than arrival order, across separate IDs", () => {
    const { cache } = harness();
    expect(cache.add(part("a", 3, 2, "C"))).toEqual({ status: "pending", duplicate: false });
    cache.add(part("b", 2, 1, "2"));
    cache.add(part("a", 3, 0, "A"));
    expect(complete(cache, part("b", 2, 0, "1"))).toEqual(utf8("12"));
    expect(complete(cache, part("a", 3, 1, "B"))).toEqual(utf8("ABC"));
    expect(cache.stats()).toEqual({ messages: 0, bytes: 0 });
  });
  it("reassembles upstream vectors whose split falls inside a UTF8 character", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../../../fixtures/feishu/pbbp2-vectors.json", import.meta.url), "utf8"),
    ) as {
      vectors: { name: string; hex: string }[];
    };
    const get = (name: string) => decodeFrame(Buffer.from(fixture.vectors.find((v) => v.name === name)!.hex, "hex"));
    const { cache } = harness();
    expect(cache.add(get("chunk-1"))).toEqual({ status: "pending", duplicate: false });
    expect(complete(cache, get("chunk-0"))).toEqual(get("event-tenant-shape").payload);
  });
  it("identical duplicates do not count twice or pretend a missing seq is present", () => {
    const { cache } = harness();
    cache.add(part("a", 2, 0, "aa"));
    expect(cache.add(part("a", 2, 0, "aa"))).toEqual({ status: "pending", duplicate: true });
    expect(cache.stats()).toEqual({ messages: 1, bytes: 2 });
    expect(complete(cache, part("a", 2, 1, "b"))).toEqual(utf8("aab"));
  });
  it("a conflicting duplicate REPLACES bytes and accounts for growth and shrinkage", () => {
    const { cache } = harness();
    cache.add(part("a", 2, 0, "x"));
    expect(cache.add(part("a", 2, 0, "longer"))).toEqual({ status: "pending", duplicate: true });
    expect(cache.stats()).toEqual({ messages: 1, bytes: 6 });
    cache.add(part("a", 2, 0, "new"));
    expect(cache.stats()).toEqual({ messages: 1, bytes: 3 });
    expect(complete(cache, part("a", 2, 1, "!"))).toEqual(utf8("new!"));
  });
  it("copies stored fragments and returns an independently owned output", () => {
    const { cache } = harness();
    const input = utf8("first");
    cache.add(part("a", 2, 0, input));
    input.fill(0);
    const last = utf8("last");
    const output = complete(cache, part("a", 2, 1, last));
    last.fill(0);
    cache.clear();
    expect(output).toEqual(utf8("firstlast"));
  });
  it("accepts empty fragments without sparse holes and can replace empty bytes", () => {
    const { cache } = harness();
    cache.add(part("a", 2, 1, ""));
    expect(cache.add(part("a", 2, 1, "x"))).toEqual({ status: "pending", duplicate: true });
    expect(complete(cache, part("a", 2, 0, ""))).toEqual(utf8("x"));
    expect(complete(cache, part("b", 1, 0, ""))).toEqual(new Uint8Array());
  });
  it("reads message_id/sum/seq last-wins, safely ignoring other headers", () => {
    const { cache } = harness();
    const frame = part("wrong", 100, 99);
    frame.headers.push(
      { key: "__proto__", value: "safe" },
      { key: "message_id", value: "right" },
      { key: "sum", value: "1" },
      { key: "seq", value: "0" },
    );
    expect(complete(cache, frame)).toEqual(utf8("a"));
  });
  it("conflicting sum drops ONLY the new chunk, retaining the first set", () => {
    const { cache } = harness();
    cache.add(part("a", 2, 0, "first"));
    expect(cache.add(part("a", 3, 1, "bad"))).toEqual({ status: "rejected", reason: "fragment-sum" });
    expect(cache.stats()).toEqual({ messages: 1, bytes: 5 });
    expect(complete(cache, part("a", 2, 1, "second"))).toEqual(utf8("firstsecond"));
  });
});

describe("chunk metadata malformed table", () => {
  it.each([
    [0, 0],
    [-1, 0],
    [65, 0],
    [1.1, 0],
    [NaN, 0],
    [Infinity, 0],
    [2, -1],
    [2, 2],
    [2, 1.5],
    [2, NaN],
    [2, Infinity],
    ["", "0"],
    ["2", ""],
    ["x", "0"],
    ["2", "x"],
    ["1e0", "0"],
    ["0x2", "0"],
    [" 2", "0"],
    ["2", " 0"],
    ["999999999999999999999999999999999", "0"],
  ])("rejects sum=%s seq=%s without allocation", (sum, seq) => {
    const { cache } = harness();
    expect(cache.add(part("id", sum!, seq!))).toEqual({ status: "rejected", reason: "fragment-meta" });
    expect(cache.stats()).toEqual({ messages: 0, bytes: 0 });
  });
  it.each(["message_id", "sum", "seq"])("rejects missing %s", (key) => {
    const { cache } = harness();
    const frame = part("id", 2, 0);
    frame.headers = frame.headers.filter((h) => h.key !== key);
    expect(cache.add(frame)).toEqual({ status: "rejected", reason: "fragment-meta" });
    expect(cache.stats()).toEqual({ messages: 0, bytes: 0 });
  });
  it("rejects absent payload, empty/oversized message_id", () => {
    const { cache } = harness();
    const frame = part("id", 2, 0);
    delete frame.payload;
    expect(cache.add(frame)).toEqual({ status: "rejected", reason: "fragment-payload" });
    expect(cache.add(part("", 2, 0))).toEqual({ status: "rejected", reason: "fragment-meta" });
    expect(cache.add(part("é".repeat(2049), 2, 0))).toEqual({ status: "rejected", reason: "fragment-meta" });
    expect(cache.stats()).toEqual({ messages: 0, bytes: 0 });
  });
  it("accepts the sum=64 / seq=63 boundary and decimal leading zeros", () => {
    const { cache } = harness();
    cache.add(part("id", 64, 63, "z"));
    for (let seq = 0; seq < 62; seq++) cache.add(part("id", 64, seq, "a"));
    expect(complete(cache, part("id", "064", "062", "y"))).toEqual(utf8("a".repeat(62) + "yz"));
  });
});

describe("TTL and explicit lifecycle (no timers or generation state)", () => {
  it("expires at the exact TTL from FIRST fragment, never refreshed by duplicates/later fragments", () => {
    const { cache, at } = harness();
    cache.add(part("a", 3, 0, "old"));
    at(9000);
    cache.add(part("a", 3, 0, "replacement"));
    cache.add(part("a", 3, 1, "later"));
    at(FEISHU_CHUNK_LIMITS.ttlMs - 1);
    expect(cache.sweep()).toBe(0);
    expect(cache.stats()).toEqual({ messages: 1, bytes: 16 });
    at(FEISHU_CHUNK_LIMITS.ttlMs);
    expect(cache.sweep()).toBe(1);
    expect(cache.stats()).toEqual({ messages: 0, bytes: 0 });
    expect(cache.add(part("a", 2, 1, "new"))).toEqual({ status: "pending", duplicate: false });
    expect(complete(cache, part("a", 2, 0, "fresh"))).toEqual(utf8("freshnew"));
  });
  it("add performs expiry before capacity checks, but unexpired sets are not evicted", () => {
    const { cache, at } = harness();
    for (let i = 0; i < 16; i++) cache.add(part(String(i), 2, 0));
    at(9999);
    expect(cache.add(part("new", 2, 0))).toEqual({ status: "rejected", reason: "message-capacity" });
    at(10000);
    expect(cache.add(part("new", 2, 0))).toEqual({ status: "pending", duplicate: false });
    expect(cache.stats()).toEqual({ messages: 1, bytes: 1 });
  });
  it.each([NaN, Infinity, -Infinity])(
    "invalid clock %s expires all stored sets and refuses admission until recovered",
    (invalid) => {
      const { cache, at } = harness();
      cache.add(part("old", 2, 0, "old"));
      at(invalid);
      expect(cache.add(part("new", 2, 0))).toEqual({ status: "rejected", reason: "invalid-clock" });
      expect(cache.stats()).toEqual({ messages: 0, bytes: 0 });
      expect(cache.add(part("single", 1, 0))).toEqual({ status: "rejected", reason: "invalid-clock" });
      at(100);
      expect(cache.add(part("old", 2, 1, "new"))).toEqual({ status: "pending", duplicate: false });
      expect(complete(cache, part("old", 2, 0, "fresh"))).toEqual(utf8("freshnew"));
    },
  );
  it.each([NaN, Infinity, -Infinity])(
    "sweep treats invalid clock %s as expiry and releases slots and bytes",
    (invalid) => {
      const { cache, at } = harness();
      cache.add(part("a", 2, 0, "one"));
      cache.add(part("b", 2, 0, "two"));
      at(invalid);
      expect(cache.sweep()).toBe(2);
      expect(cache.sweep()).toBe(0);
      expect(cache.stats()).toEqual({ messages: 0, bytes: 0 });
    },
  );
  it("clear is idempotent, releases all accounting, and instances do not share data", () => {
    const { cache } = harness();
    const other = harness().cache;
    cache.add(part("a", 2, 0, "left"));
    other.add(part("a", 2, 1, "right"));
    cache.clear();
    cache.clear();
    expect(cache.stats()).toEqual({ messages: 0, bytes: 0 });
    expect(other.stats()).toEqual({ messages: 1, bytes: 5 });
    expect(complete(other, part("a", 2, 0, "new"))).toEqual(utf8("newright"));
  });
});

describe("aggregate limits: refuse before mutation; never evict partial sets", () => {
  it("16-message capacity refuses new partial sets but admits uncached single messages and existing progress", () => {
    const { cache } = harness();
    for (let i = 0; i < FEISHU_CHUNK_LIMITS.maxMessages; i++) cache.add(part(String(i), 2, 0, "x"));
    expect(cache.add(part("overflow", 2, 0))).toEqual({ status: "rejected", reason: "message-capacity" });
    const input = utf8("single");
    const output = complete(cache, part("single", 1, 0, input));
    input.fill(0);
    expect(output).toEqual(utf8("single"));
    expect(cache.stats()).toEqual({ messages: 16, bytes: 16 });
    expect(complete(cache, part("0", 2, 1, "!"))).toEqual(utf8("x!"));
    expect(cache.add(part("overflow", 2, 0))).toEqual({ status: "pending", duplicate: false });
  });
  it("single fragments bypass full count AND byte cache caps without altering existing sets", () => {
    const { cache } = harness();
    for (let i = 0; i < FEISHU_CHUNK_LIMITS.maxMessages; i++) fill(cache, String(i), 1, 2);
    expect(cache.stats()).toEqual({ messages: 16, bytes: FEISHU_CHUNK_LIMITS.maxTotalBytes });
    expect(complete(cache, part("single", 1, 0, "immediate"))).toEqual(utf8("immediate"));
    expect(cache.stats()).toEqual({ messages: 16, bytes: FEISHU_CHUNK_LIMITS.maxTotalBytes });
    // A single-fragment claim must not overwrite an existing multi-fragment ID.
    expect(cache.add(part("0", 1, 0, "conflict"))).toEqual({ status: "rejected", reason: "fragment-sum" });
    const stored = complete(cache, part("0", 2, 1, ""));
    expect(stored.length).toBe(size);
    expect(stored.every((b) => b === 65)).toBe(true);
    expect(cache.stats()).toEqual({ messages: 15, bytes: FEISHU_CHUNK_LIMITS.maxTotalBytes - size });
  });
  it("single fragments still obey the per-message size cap", () => {
    const { cache } = harness();
    expect(cache.add(part("single", 1, 0, new Uint8Array(FEISHU_CHUNK_LIMITS.maxMessageBytes + 1)))).toEqual({
      status: "rejected",
      reason: "message-too-large",
    });
    expect(cache.stats()).toEqual({ messages: 0, bytes: 0 });
  });
  it("exactly 4 MiB/message is allowed; one additional byte refuses without damage", () => {
    const { cache } = harness();
    fill(cache, "a", 8, 9);
    expect(cache.stats()).toEqual({ messages: 1, bytes: FEISHU_CHUNK_LIMITS.maxMessageBytes });
    expect(cache.add(part("a", 9, 8, "x"))).toEqual({ status: "rejected", reason: "message-too-large" });
    expect(cache.stats()).toEqual({ messages: 1, bytes: FEISHU_CHUNK_LIMITS.maxMessageBytes });
    const output = complete(cache, part("a", 9, 8, ""));
    expect(output.length).toBe(FEISHU_CHUNK_LIMITS.maxMessageBytes);
    expect(output.every((b) => b === 65)).toBe(true);
    expect(cache.stats()).toEqual({ messages: 0, bytes: 0 });
  });
  it("refused oversized first fragment creates no cache entry", () => {
    const { cache } = harness();
    expect(cache.add(part("a", 2, 0, new Uint8Array(FEISHU_CHUNK_LIMITS.maxMessageBytes + 1)))).toEqual({
      status: "rejected",
      reason: "message-too-large",
    });
    expect(cache.stats()).toEqual({ messages: 0, bytes: 0 });
  });
  it("exactly 8 MiB aggregate is allowed; refuses new and growing existing chunks without eviction", () => {
    const { cache } = harness();
    fill(cache, "a", 8);
    fill(cache, "b", 8);
    expect(cache.stats()).toEqual({ messages: 2, bytes: FEISHU_CHUNK_LIMITS.maxTotalBytes });
    expect(cache.add(part("c", 2, 0, "x"))).toEqual({ status: "rejected", reason: "total-too-large" });
    expect(cache.add(part("b", 16, 8, "x"))).toEqual({ status: "rejected", reason: "message-too-large" });
    // Shrinking a duplicate recovers space; a refused grow keeps the replacement.
    expect(cache.add(part("a", 16, 0, ""))).toEqual({ status: "pending", duplicate: true });
    fill(cache, "c", 1);
    expect(cache.add(part("a", 16, 0, "x"))).toEqual({ status: "rejected", reason: "total-too-large" });
    expect(cache.stats()).toEqual({ messages: 3, bytes: FEISHU_CHUNK_LIMITS.maxTotalBytes });
    // Complete a with empty missing parts: the refused replacement did not stick.
    for (let seq = 8; seq < 15; seq++) cache.add(part("a", 16, seq, ""));
    expect(complete(cache, part("a", 16, 15, "")).length).toBe(7 * size);
    expect(cache.stats()).toEqual({ messages: 2, bytes: 9 * size });
  });
  it("aggregate cap admits no-growth existing fragments, but refuses growth until space is available", () => {
    const { cache } = harness();
    fill(cache, "a", 6, 8);
    fill(cache, "b", 6);
    fill(cache, "c", 4);
    expect(cache.stats()).toEqual({ messages: 3, bytes: FEISHU_CHUNK_LIMITS.maxTotalBytes });
    expect(cache.add(part("a", 8, 0, block()))).toEqual({ status: "pending", duplicate: true });
    expect(cache.add(part("a", 8, 6, ""))).toEqual({ status: "pending", duplicate: false });
    expect(cache.add(part("a", 8, 6, "x"))).toEqual({ status: "rejected", reason: "total-too-large" });
    expect(cache.stats()).toEqual({ messages: 3, bytes: FEISHU_CHUNK_LIMITS.maxTotalBytes });
    cache.add(part("a", 8, 0, ""));
    expect(cache.add(part("a", 8, 6, "x"))).toEqual({ status: "pending", duplicate: true });
    const output = complete(cache, part("a", 8, 7, ""));
    expect(output.length).toBe(5 * size + 1);
    expect(output.at(-1)).toBe(120);
    expect(cache.stats()).toEqual({ messages: 2, bytes: 10 * size });
  });
  it("a duplicate exceeding the per-message cap preserves original bytes", () => {
    const { cache } = harness();
    fill(cache, "a", 8, 9);
    expect(cache.add(part("a", 9, 0, new Uint8Array(size + 1)))).toEqual({
      status: "rejected",
      reason: "message-too-large",
    });
    const output = complete(cache, part("a", 9, 8, ""));
    expect(output.length).toBe(8 * size);
    expect(output[0]).toBe(65);
    expect(output[size - 1]).toBe(65);
  });
  it("TTL frees aggregate bytes as well as message slots", () => {
    const { cache, at } = harness();
    fill(cache, "a", 8);
    at(1000);
    fill(cache, "b", 8);
    at(10000);
    expect(cache.sweep()).toBe(1);
    expect(cache.stats()).toEqual({ messages: 1, bytes: 4 * 1024 * 1024 });
    fill(cache, "c", 8);
    expect(cache.stats()).toEqual({ messages: 2, bytes: 8 * 1024 * 1024 });
  });
});
