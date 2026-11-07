/** #39 P1 limits: shape-first validation, field predicates and the three byte budgets. */
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  jsonUtf8Bytes,
  readUntrustedArray,
  readUntrustedShape,
  scopedOpDigest,
  sessionItemRevision,
  utf8Bytes,
  validateSeedCapture,
  validateSessionEntry,
  validateSessionItem,
} from "../../../src/memory/scopes/limits.js";
import {
  FOLD_HARD_BODY_BYTES,
  FOLD_HARD_DTO_BYTES,
  FOLD_HARD_ITEMS,
  HUB_MEMORY_DTO_MAX_BYTES,
  MEMORY_ENVELOPE_MAX_BYTES,
  MEMORY_ITEM_MAX_BYTES,
  MEMORY_META_MAX_BYTES,
  MEMORY_OPERATION_DTO_MAX_BYTES,
  SESSION_MEMORY_DTO_MAX_BYTES,
  SESSION_MEMORY_MAX_BODY_BYTES,
  SESSION_MEMORY_MAX_ITEMS,
} from "../../../src/memory/scopes/types.js";

const STAMP = "2026-11-07T00:00:00.000Z";
const sid = "sess-1";
const grant = { via: "dialog" as const, turn: "aabbccdd", cap: "11223344", channel: "tui" as const };

function item(n: number, text: string, extra: Record<string, unknown> = {}) {
  return { id: `n${n}`, text, authority: "agent", created: STAMP, updated: STAMP, ...extra };
}

describe("budget formulas mirror the frozen P0 constants", () => {
  it("session/hub product budgets satisfy the approved formulas", () => {
    expect(6 * 1024 + MEMORY_META_MAX_BYTES + MEMORY_ENVELOPE_MAX_BYTES).toBe(MEMORY_OPERATION_DTO_MAX_BYTES);
    expect(
      6 * SESSION_MEMORY_MAX_BODY_BYTES + SESSION_MEMORY_MAX_ITEMS * MEMORY_META_MAX_BYTES + MEMORY_ENVELOPE_MAX_BYTES,
    ).toBe(SESSION_MEMORY_DTO_MAX_BYTES);
    expect(6 * 4096 + 32 * MEMORY_META_MAX_BYTES + MEMORY_ENVELOPE_MAX_BYTES).toBe(HUB_MEMORY_DTO_MAX_BYTES);
    expect(6 * FOLD_HARD_BODY_BYTES + FOLD_HARD_ITEMS * MEMORY_META_MAX_BYTES + MEMORY_ENVELOPE_MAX_BYTES).toBe(
      FOLD_HARD_DTO_BYTES,
    );
  });
});

describe("raw / serialized / rendered budgets are distinct and measured independently (±1)", () => {
  const texts = ["\0", "\u0001\n\t", "\\", '"', "中文", "🙂", "混合\0\\🙂"];
  it.each(texts.map((text) => [text] as const))("text %j: raw and JSON measured separately", (text) => {
    const raw = utf8Bytes(text);
    const serialized = jsonUtf8Bytes({ text });
    expect(serialized).toBeGreaterThan(raw); // escaping can only grow
    expect(serialized).toBeLessThanOrEqual(6 * raw + utf8Bytes('{"text":""}'));
  });

  it("the per-item raw budget discriminates equality vs +1 on the 1024-byte boundary", () => {
    const raw1024 = utf8Bytes("\0".repeat(1024));
    expect(raw1024 <= 1024).toBe(true);
    expect(raw1024 <= 1023).toBe(false);
    expect(utf8Bytes("\0".repeat(1025)) <= 1024).toBe(false);
  });

  it("512 NULs are 512 raw bytes but 3072 JSON string bytes", () => {
    expect(utf8Bytes("\0".repeat(512))).toBe(512);
    expect(jsonUtf8Bytes({ text: "\0".repeat(512) })).toBe(utf8Bytes('{"text":""}') + 3072);
  });
});

describe("validateSessionItem", () => {
  it("accepts a full-fields item whose metadata serialization fits META_MAX", () => {
    const full = item(1, "body", {
      authority: "user",
      grant,
      from: `project:${"a".repeat(100)}`,
      originSid: "S".repeat(64),
    });
    const result = validateSessionItem(full, { textMaxBytes: 1024 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.item.id).toBe("n1");
      const { text: _text, ...meta } = result.item;
      expect(jsonUtf8Bytes(meta)).toBeLessThanOrEqual(MEMORY_META_MAX_BYTES);
    }
  });

  it("individually maximal valid fields keep the aggregate metadata within META_MAX (field caps imply the budget)", () => {
    const maximal = item(2, "body", {
      authority: "user",
      grant: { via: "dialog", turn: "aabbccdd", cap: "11223344", channel: "web" },
      from: `project:${"a".repeat(100)}`,
      originSid: "S".repeat(64),
    });
    const result = validateSessionItem(maximal, { textMaxBytes: 1024 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { text: _t, ...meta } = result.item;
      expect(jsonUtf8Bytes(meta)).toBeLessThanOrEqual(MEMORY_META_MAX_BYTES);
    }
  });

  it("raw body budget: 1024 accepted, 1025 rejected (equality / +1)", () => {
    expect(validateSessionItem(item(1, "ä".repeat(512), {}), { textMaxBytes: 1024 }).ok).toBe(true);
    const over = validateSessionItem(item(1, "ä".repeat(512) + "a", {}), { textMaxBytes: 1024 });
    expect(over).toEqual({ ok: false, reason: "text-bytes" });
  });

  it("field predicates reject overflow and invalid characters", () => {
    expect(validateSessionItem(item(1, "x", { id: "n1234567" }), { textMaxBytes: 1024 }).ok).toBe(false);
    expect(validateSessionItem(item(1, "x", { id: "x1" }), { textMaxBytes: 1024 }).ok).toBe(false);
    expect(validateSessionItem(item(1, "x", { created: "2026-11-07T00:00:00.000Zx" }), { textMaxBytes: 1024 }).ok).toBe(
      false,
    );
    expect(validateSessionItem(item(1, "x", { created: "2026-11-07T00:00:00Z" }), { textMaxBytes: 1024 }).ok).toBe(
      false,
    );
    expect(validateSessionItem(item(1, "x", { originSid: "S".repeat(65) }), { textMaxBytes: 1024 }).ok).toBe(false);
    expect(validateSessionItem(item(1, "x", { from: "session:n1x" }), { textMaxBytes: 1024 }).ok).toBe(false);
    expect(validateSessionItem(item(1, "x", { from: `project:${"a".repeat(101)}` }), { textMaxBytes: 1024 }).ok).toBe(
      false,
    );
    expect(
      validateSessionItem(item(1, "x", { grant: { via: "dialog", turn: "AABBCCDD" } }), { textMaxBytes: 1024 }).ok,
    ).toBe(false);
    expect(validateSessionItem(item(1, "x", { grant: { via: "other" } }), { textMaxBytes: 1024 }).ok).toBe(false);
    expect(validateSessionItem(item(1, "x", { authority: "root" }), { textMaxBytes: 1024 }).ok).toBe(false);
  });
});

describe("untrusted shapes never execute user code", () => {
  it("getter/toJSON are not executed; accessor/sparse/symbol/prototype/cycle/depth/nonfinite refuse", () => {
    let calls = 0;
    const getter = Object.defineProperty({}, "id", {
      enumerable: true,
      get() {
        calls++;
        return "n1";
      },
    });
    const withToJson = {
      id: "n1",
      toJSON() {
        calls++;
        return {};
      },
    };
    const cycle: Record<string, unknown> = {};
    cycle.item = cycle;
    let deep: unknown = "x";
    for (let i = 0; i < 12; i++) deep = { item: deep };
    const namedBad: Record<string, unknown> = {
      getter,
      toJSON: withToJson,
      cycle,
      date: new Date(),
      class: new (class {})(),
      arrayWithUndefined: [undefined],
      newArray3: new Array(3),
      symbol: { [Symbol("s")]: 1 },
      extraField: { id: "n1", surprise: true },
      float: { id: "n1", nextN: 1.5 },
      infinity: { id: "n1", nextN: Number.POSITIVE_INFINITY },
      deep,
    };
    for (const [name, value] of Object.entries(namedBad)) {
      // the item validator rejects every one of them (unknown fields included)
      expect(validateSessionItem(value, { textMaxBytes: 1024 }).ok, name).toBe(false);
      // at SHAPE level everything fails except plain records with unknown fields ("extraField"):
      // the generic reader's job is shape, the validator's job is the field allowlist.
      if (name !== "extraField") expect(readUntrustedShape(value).ok, name).toBe(false);
    }
    expect(calls).toBe(0);
    expect(readUntrustedShape(Object.assign(Object.create(null), { id: "n1" })).ok).toBe(true);
    expect(readUntrustedArray([1, 2], 8).ok).toBe(true);
    expect(
      readUntrustedArray(
        Array.from({ length: 9 }, (_, i) => i),
        8,
      ).ok,
    ).toBe(false);
    expect(readUntrustedArray(new Array(2), 8).ok).toBe(false);
  });
});

describe("validateSessionEntry (write and fold modes)", () => {
  it("put/del entries validate against the operation DTO cap", () => {
    expect(validateSessionEntry({ v: 1, sid, op: "put", item: item(1, "x") }, { mode: "write" }).ok).toBe(true);
    expect(validateSessionEntry({ v: 1, sid, op: "del", id: "n1" }, { mode: "write" }).ok).toBe(true);
    expect(validateSessionEntry({ v: 2, sid, op: "del", id: "n1" }, { mode: "write" }).ok).toBe(false);
    expect(validateSessionEntry({ v: 1, sid: "../x", op: "del", id: "n1" }, { mode: "write" }).ok).toBe(false);
    expect(validateSessionEntry({ v: 1, sid, op: "replace", id: "n1" }, { mode: "write" }).ok).toBe(false);
  });

  it("snap with 48 valid items passes; duplicate ids reject the WHOLE snap", () => {
    const items = Array.from({ length: SESSION_MEMORY_MAX_ITEMS }, (_, i) => item(i + 1, "x"));
    const snap = { v: 1, sid, op: "snap", items, nextN: 49 };
    expect(validateSessionEntry(snap, { mode: "write" }).ok).toBe(true);
    const dup = { ...snap, items: [...items.slice(0, 47), items[0]] }; // 48 items, n1 twice
    expect(dup.items.length).toBe(48);
    expect(validateSessionEntry(dup, { mode: "write" }).ok).toBe(false);
  });

  it("one bad item rejects the whole snap (no partial adoption)", () => {
    const items = [item(1, "ok"), item(2, "ok"), item(3, "bad", { id: "n3!" })];
    const result = validateSessionEntry({ v: 1, sid, op: "snap", items, nextN: 4 }, { mode: "write" });
    expect(result.ok).toBe(false);
  });

  it("fold history budgets: 64 items ok / 65 rejected; 65536 raw ok / 65537 rejected", () => {
    const mk = (count: number, perText: (i: number) => string) =>
      Array.from({ length: count }, (_, i) => item(i + 1, perText(i)));
    // 64 items, exactly FOLD_HARD_BODY_BYTES total raw: 64 × 1024.
    const full = mk(FOLD_HARD_ITEMS, () => "\0".repeat(1024));
    expect(full.reduce((sum, entry) => sum + utf8Bytes(entry.text), 0)).toBe(FOLD_HARD_BODY_BYTES);
    const ok = validateSessionEntry({ v: 1, sid, op: "snap", items: full, nextN: 65 }, { mode: "fold" });
    expect(ok.ok).toBe(true);
    const overCount = validateSessionEntry(
      { v: 1, sid, op: "snap", items: mk(FOLD_HARD_ITEMS + 1, () => "x"), nextN: 66 },
      { mode: "fold" },
    );
    expect(overCount.ok).toBe(false);
    const overBody = validateSessionEntry(
      { v: 1, sid, op: "snap", items: [...full, item(65, "x")], nextN: 66 },
      { mode: "fold" },
    );
    expect(overBody.ok).toBe(false);
    // The same 64×1024 snap is REFUSED in write mode (product body budget 8192).
    expect(validateSessionEntry({ v: 1, sid, op: "snap", items: full, nextN: 65 }, { mode: "write" }).ok).toBe(false);
  });

  it("cause and inherit shapes are strictly validated", () => {
    const base = { v: 1, sid, op: "snap", items: [item(1, "x")], nextN: 2 };
    expect(validateSessionEntry({ ...base, cause: { op: "put", id: "n1" } }, { mode: "write" }).ok).toBe(true);
    expect(validateSessionEntry({ ...base, cause: { op: "snap", id: "n1" } }, { mode: "write" }).ok).toBe(false);
    expect(
      validateSessionEntry(
        { ...base, inherit: { kind: "spawn", fromSid: "p1", fromLeaf: "leaf-1", frozenAt: STAMP } },
        { mode: "write" },
      ).ok,
    ).toBe(true);
    expect(
      validateSessionEntry({ ...base, inherit: { kind: "fork", fromSid: "p1", frozenAt: STAMP } }, { mode: "write" })
        .ok,
    ).toBe(false);
    expect(
      validateSessionEntry({ ...base, inherit: { kind: "spawn", fromSid: "p1", frozenAt: "nope" } }, { mode: "write" })
        .ok,
    ).toBe(false);
  });
});

describe("validateSeedCapture", () => {
  it("accepts explicit empty and a product-budget captured seed; rejects dup/overflow/wrapper drift", () => {
    expect(validateSeedCapture({ v: 1, state: "empty" })).toEqual({ ok: true, capture: { v: 1, state: "empty" } });
    const seed = {
      v: 1,
      fromSid: "parent-1",
      fromLeaf: "leaf-9",
      frozenAt: STAMP,
      items: [item(1, "a"), item(2, "b")],
      nextN: 3,
    };
    const ok = validateSeedCapture({ v: 1, state: "captured", seed });
    expect(ok.ok).toBe(true);
    const dup = validateSeedCapture({
      v: 1,
      state: "captured",
      seed: { ...seed, items: [item(1, "a"), item(1, "b")] },
    });
    expect(dup.ok).toBe(false);
    const over = validateSeedCapture({
      v: 1,
      state: "captured",
      seed: { ...seed, items: Array.from({ length: SESSION_MEMORY_MAX_ITEMS + 1 }, (_, i) => item(i + 1, "x")) },
    });
    expect(over.ok).toBe(false);
    const overBody = validateSeedCapture({
      v: 1,
      state: "captured",
      seed: { ...seed, items: [item(1, "x".repeat(SESSION_MEMORY_MAX_BODY_BYTES + 1))] },
    });
    expect(overBody.ok).toBe(false);
    expect(validateSeedCapture({ v: 1, state: "maybe", seed }).ok).toBe(false);
    expect(validateSeedCapture({ v: 1, state: "captured", seed: { ...seed, extra: 1 } }).ok).toBe(false);
  });
});

describe("digests and revisions", () => {
  it("canonicalJson is key-order independent; revision and op digest are stable", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
    const one = item(1, "x");
    const two = item(1, "x");
    expect(sessionItemRevision(one as never)).toBe(sessionItemRevision(two as never));
    expect(sessionItemRevision(item(1, "x") as never)).not.toBe(sessionItemRevision(item(1, "y") as never));
    const op = { storageScope: "session", op: "create", text: "t", authority: "user" };
    expect(scopedOpDigest(op)).toBe(scopedOpDigest({ ...op })); // sha256 hex
    expect(scopedOpDigest(op)).toMatch(/^[a-f0-9]{64}$/);
    expect(scopedOpDigest({ ...op, authority: "agent" })).not.toBe(scopedOpDigest(op)); // authority IS covered
    expect(scopedOpDigest({ ...op, expectRev: "ab" })).not.toBe(scopedOpDigest(op)); // rev IS covered
  });

  it("MEMORY_ITEM_MAX_BYTES boundary: 1024 emoji-adjacent multi-byte text measured in UTF-8", () => {
    // 341 emoji = 1364 raw bytes ⇒ rejected even though it is 341 characters.
    expect(validateSessionItem(item(1, "🙂".repeat(341), {}), { textMaxBytes: MEMORY_ITEM_MAX_BYTES }).ok).toBe(false);
    expect(validateSessionItem(item(1, "🙂".repeat(256), {}), { textMaxBytes: MEMORY_ITEM_MAX_BYTES }).ok).toBe(true);
  });
});
