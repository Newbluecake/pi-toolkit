/** P0 pure capability specimens. Production validation/render/paths ports belong to P1/P3. */
import { describe, expect, it } from "vitest";
import { resolveHubPaths } from "../../../src/web-hub/protocol/paths.js";

const META = 512,
  ENVELOPE = 2048;
const budgets = {
  session: { n: 48, raw: 8192, dto: 75776, render: 63488 },
  hub: { n: 32, raw: 4096, dto: 43008, render: 34816 },
};
const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const jsonBytes = (value: unknown) => bytes(JSON.stringify(value));

// Test-only descriptor gate proves the DTO technique without invoking untrusted getters/toJSON.
// It is NOT the production limits validator, which P1 must implement and independently test.
function specimenData(value: unknown, depth = 0, seen = new Set<object>()): unknown {
  if (typeof value === "string" || value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return value;
  if (typeof value !== "object" || value === null || depth > 8 || seen.has(value)) throw new Error("shape");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null && !(Array.isArray(value) && proto === Array.prototype))
    throw new Error("prototype");
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length) throw new Error("symbol");
    if (Array.isArray(value)) {
      if (value.length > 64 || Object.keys(descriptors).length !== value.length + 1) throw new Error("array");
      return Array.from({ length: value.length }, (_, index) => {
        const desc = descriptors[String(index)];
        if (!desc || !("value" in desc)) throw new Error("accessor/sparse");
        return specimenData(desc.value, depth + 1, seen);
      });
    }
    const allowed = new Set([
      "v",
      "sid",
      "op",
      "item",
      "items",
      "id",
      "text",
      "authority",
      "grant",
      "via",
      "turn",
      "cap",
      "created",
      "updated",
      "from",
      "originSid",
      "nextN",
      "cause",
      "inherit",
      "kind",
      "fromSid",
      "fromLeaf",
      "frozenAt",
      "state",
      "seed",
      "channel",
      "by",
      "who",
      "topic",
      "src",
      "project",
      "label",
      "sid8",
    ]);
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, desc] of Object.entries(descriptors)) {
      if (!allowed.has(key) || !("value" in desc)) throw new Error("field/accessor");
      result[key] = specimenData(desc.value, depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}
const stamp = "2026-11-07T00:00:00.000Z";
function item(index: number, text: string) {
  return {
    id: `n${index}`,
    text,
    authority: "user",
    grant: { via: "dialog", turn: "a".repeat(8), cap: "b".repeat(8) },
    created: stamp,
    updated: stamp,
    from: `project:${"x".repeat(100)}`,
    originSid: "S".repeat(64),
  };
}

describe("C5 raw/render/DTO safety arithmetic and untrusted shape specimens", () => {
  it.each(Object.entries(budgets))(
    "%s full optional fields and maximal item count obey actual serialized wrappers",
    (scope, limit) => {
      expect(6 * limit.raw + limit.n * META + ENVELOPE).toBe(limit.dto);
      expect(2048 + 6 * limit.raw + limit.n * 256).toBe(limit.render);
      expect(6 * 1024 + META + ENVELOPE).toBe(8704);
      const items = Array.from({ length: limit.n }, (_, index) =>
        item(index + 1, "\0".repeat(Math.floor(limit.raw / limit.n) + (index < limit.raw % limit.n ? 1 : 0))),
      );
      expect(items.reduce((sum, entry) => sum + bytes(entry.text), 0)).toBe(limit.raw);
      for (const entry of items) {
        const { text: _text, ...metadata } = entry;
        expect(jsonBytes(metadata)).toBeLessThanOrEqual(META);
      }
      const seed = { v: 1, fromSid: "S".repeat(64), fromLeaf: "L".repeat(64), frozenAt: stamp, items, nextN: 999999 };
      const snap = {
        v: 1,
        sid: "S".repeat(64),
        op: "snap",
        items,
        nextN: 999999,
        cause: { op: "put", id: "n999999" },
        inherit: { kind: "spawn", fromSid: seed.fromSid, fromLeaf: seed.fromLeaf, frozenAt: stamp },
      };
      for (const dto of [seed, snap, { v: 1, state: "captured", seed }])
        expect(jsonBytes(specimenData(dto))).toBeLessThanOrEqual(limit.dto);
      for (const dto of [
        { v: 1, sid: "S".repeat(64), op: "put", item: item(999999, "\0".repeat(1024)) },
        { v: 1, sid: "S".repeat(64), op: "del", id: "n999999" },
      ])
        expect(jsonBytes(specimenData(dto))).toBeLessThanOrEqual(8704);
      // Conservative render technique, not the final section renderer.
      const render = `${scope}\n${items.map((entry) => `${entry.id} user ${JSON.stringify(entry.text)}`).join("\n")}`;
      expect(bytes(render)).toBeLessThanOrEqual(limit.render);
      expect(jsonBytes({ text: "\0".repeat(1024) })).toBeGreaterThan(bytes("\0".repeat(1024)));
    },
  );

  it("distinct raw/serialized/render budgets include controls, slashes, CJK and emoji, equality/+1", () => {
    for (const text of ["\0", "\u0001\n\t", "\\", '"', "中文", "🙂", "混合\0\\🙂"]) {
      const raw = bytes(text),
        serialized = jsonBytes({ text }),
        rendered = bytes(JSON.stringify(text));
      expect(serialized).toBeLessThanOrEqual(6 * raw + bytes('{"text":""}'));
      const fits = (actual: number, cap: number) => actual <= cap;
      expect(fits(raw, raw)).toBe(true);
      expect(fits(raw, raw - 1)).toBe(false);
      expect(fits(serialized, serialized)).toBe(true);
      expect(fits(serialized, serialized - 1)).toBe(false);
      expect(fits(rendered, rendered)).toBe(true);
      expect(fits(rendered, rendered - 1)).toBe(false);
    }
    expect(6 * 65536 + 64 * META + ENVELOPE).toBe(428032);
    expect(2048 + 6 * 65536 + 64 * 256).toBe(411648);
  });

  it("does not execute getter/toJSON; refuses cycles, nonplain, sparse, symbols, extras, depth and nonfinite", () => {
    let calls = 0;
    const getter = Object.defineProperty({}, "text", {
      enumerable: true,
      get() {
        calls++;
        return "secret";
      },
    });
    const toJSON = {
      toJSON() {
        calls++;
        return {};
      },
    };
    const cycle: Record<string, unknown> = {};
    cycle.seed = cycle;
    let deep: unknown = "x";
    for (let i = 0; i < 10; i++) deep = { seed: deep };
    for (const bad of [
      getter,
      toJSON,
      cycle,
      new Date(),
      new Array(1),
      [undefined],
      { text: "x", surprise: true },
      { nextN: Infinity },
      { nextN: NaN },
      { [Symbol("private")]: "x" },
      Array(65).fill(null),
      deep,
    ])
      expect(() => specimenData(bad)).toThrow();
    expect(calls).toBe(0);
    expect(specimenData(Object.assign(Object.create(null), { text: "safe" }))).toEqual({ text: "safe" });
  });
});

// Mirrors the approved agent resolution precedence at a local composition seam. P3 owns the
// production effective-paths module; no memory code guesses HOME a second time.
describe("C5 shared effective path object injection capability", () => {
  it("paths override wins launchHome/HOME; memoryRoot and agentDir cannot split a slot", () => {
    const override = resolveHubPaths({ home: "/tmp/override", uid: 1234 });
    let calls = 0;
    const resolveOnce = (input: {
      paths?: typeof override;
      launchHome?: string;
      home?: string;
      memoryRoot?: string;
      agentDir?: string;
      enabled: boolean;
    }) => {
      calls++;
      return input.paths ?? resolveHubPaths({ home: input.launchHome ?? (input.home || "/tmp/fallback"), uid: 1234 });
    };
    for (const enabled of [true, false])
      for (const memoryRoot of ["/tmp/memoryA", "/tmp/memoryB"])
        for (const agentDir of ["/tmp/agentA", "/tmp/agentB"]) {
          const effective = resolveOnce({
            paths: override,
            launchHome: "/tmp/launch",
            home: "/tmp/env",
            memoryRoot,
            agentDir,
            enabled,
          });
          const injectedSlot = { effectiveStateDir: effective.stateDir, uid: 1234 };
          expect(effective).toBe(override);
          expect(injectedSlot.effectiveStateDir).toBe(override.stateDir);
        }
    expect(calls).toBe(8);
    expect(resolveOnce({ launchHome: "/tmp/launch", home: "/tmp/env", enabled: true }).stateDir).toBe(
      "/tmp/launch/.pi/agent/web-hub",
    );
    expect(resolveOnce({ home: "/tmp/env", enabled: true }).stateDir).toBe("/tmp/env/.pi/agent/web-hub");
    expect(resolveOnce({ home: "", enabled: false }).stateDir).toBe("/tmp/fallback/.pi/agent/web-hub");
    expect(resolveHubPaths({ home: "/tmp/another", uid: 1234 }).stateDir).not.toBe(override.stateDir);
    // Production off-port absence is a P4 assembly gate, not inferred from this path specimen.
  });
});

/** Field-by-field constraints of specimens, separate from production validation. */
const fieldCaps = {
  sessionId: { re: /^n\d{1,6}$/, max: 7 },
  hubId: { re: /^[a-z0-9-]{1,48}\.\d{3}$/, max: 52 },
  topic: { re: /^[a-z0-9-]{1,48}$/, max: 48 },
  sid: { re: /^[A-Za-z0-9_-]{1,64}$/, max: 64 },
  fromLeaf: { re: /^[A-Za-z0-9_-]{1,64}$/, max: 64 },
  from: { re: /^(session:n\d{1,6}|project:[A-Za-z0-9._/-]{1,100})$/, max: 120 },
  stamp: { re: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, max: 24 },
  hex8: { re: /^[a-f0-9]{8}$/, max: 8 },
  project: { re: /^[a-f0-9]{12}$/, max: 12 },
  label: { re: /^[^\x00-\x1f\x7f]*$/, max: 40 },
};
function field(name: keyof typeof fieldCaps, value: unknown): boolean {
  const cap = fieldCaps[name];
  return typeof value === "string" && bytes(value) <= cap.max && cap.re.test(value);
}
it("C5 all bounded metadata fields reject invalid chars or byte overflow, independent from sid", () => {
  const valid = {
    sessionId: "n999999",
    hubId: `${"a".repeat(48)}.999`,
    topic: "a".repeat(48),
    sid: "S".repeat(64),
    fromLeaf: "f".repeat(64),
    from: `project:${"a".repeat(100)}`,
    stamp,
    hex8: "abcdef01",
    project: "a".repeat(12),
    label: "🙂".repeat(10),
  };
  for (const [name, value] of Object.entries(valid)) {
    const key = name as keyof typeof fieldCaps;
    expect(field(key, value)).toBe(true);
    expect(field(key, `${value}\0`)).toBe(false);
    expect(field(key, `${value}${"x".repeat(121)}`)).toBe(false);
    expect(field(key, null)).toBe(false);
  }
  expect(field("label", `${valid.label}x`)).toBe(false); // 40 B exact / +1
  expect(field("sid", `${valid.sid}x`)).toBe(false);
  expect(field("fromLeaf", `${valid.fromLeaf}x`)).toBe(false);
  expect(field("topic", `${valid.topic}x`)).toBe(false);
  expect(field("from", `project:${"a".repeat(101)}`)).toBe(false);
  const hub = {
    id: valid.hubId,
    topic: valid.topic,
    text: "\0".repeat(1024),
    authority: "user",
    grant: { via: "dialog", channel: "web", by: "agent", turn: valid.hex8, cap: valid.hex8, who: valid.hex8 },
    src: { project: valid.project, label: valid.label, sid8: valid.hex8 },
    created: stamp,
    updated: stamp,
  };
  const { text: _text, ...metadata } = hub;
  expect(jsonBytes(specimenData(metadata))).toBeLessThanOrEqual(META);
  expect(jsonBytes(specimenData(hub))).toBeLessThanOrEqual(8704);
  // Individually maximal optional metadata can exceed the aggregate 512 B cap. Reject it;
  // field-wise acceptance does not authorize silently truncating/omitting fields.
  const allOptional = { ...hub, from: valid.from };
  const { text: _allText, ...fullMetadata } = allOptional;
  expect(jsonBytes(specimenData(fullMetadata))).toBeGreaterThan(META);
  const fullCorpus = {
    v: 1,
    items: Array.from({ length: 32 }, (_, index) => ({
      ...hub,
      id: `${"a".repeat(48)}.${String(index).padStart(3, "0")}`,
      text: "\0".repeat(128),
    })),
  };
  expect(jsonBytes(specimenData(fullCorpus))).toBeLessThanOrEqual(budgets.hub.dto);
});

import * as contracts from "../../../src/memory/scopes/types.js";
import type { MemorySeedCapture, SessionMemorySeedV1 } from "../../../src/core/types.js";

it("frozen production constants match independently exercised product/DTO budgets", () => {
  expect(contracts.SESSION_MEMORY_ENTRY_TYPE).toBe("subagent:memory-session");
  expect([
    contracts.SESSION_MEMORY_MAX_ITEMS,
    contracts.SESSION_MEMORY_MAX_BODY_BYTES,
    contracts.SESSION_MEMORY_DTO_MAX_BYTES,
    contracts.SESSION_MEMORY_RENDER_MAX_BYTES,
  ]).toEqual(Object.values(budgets.session));
  expect([
    contracts.HUB_MEMORY_MAX_ITEMS,
    contracts.HUB_MEMORY_MAX_BODY_BYTES,
    contracts.HUB_MEMORY_DTO_MAX_BYTES,
    contracts.HUB_MEMORY_RENDER_MAX_BYTES,
  ]).toEqual(Object.values(budgets.hub));
  expect(contracts.MEMORY_ITEM_MAX_BYTES).toBe(1024);
  expect(contracts.MEMORY_META_MAX_BYTES).toBe(META);
  expect(contracts.MEMORY_ENVELOPE_MAX_BYTES).toBe(ENVELOPE);
  expect(contracts.MEMORY_OPERATION_DTO_MAX_BYTES).toBe(8704);
});

it("independent seed DTO admits explicit empty and a deep-copy/deep-freeze capture specimen", () => {
  // This is a contract specimen, NOT P2's capture/spawn implementation or journal/replay gate.
  const original = item(1, "original");
  const detached = JSON.parse(JSON.stringify(original));
  Object.freeze(detached.grant);
  Object.freeze(detached);
  const seed: SessionMemorySeedV1 = Object.freeze({
    v: 1,
    fromSid: "parent",
    fromLeaf: "abc123de",
    frozenAt: stamp,
    items: Object.freeze([detached]),
    nextN: 2,
  });
  const captured: MemorySeedCapture = Object.freeze({ v: 1, state: "captured", seed });
  const empty: MemorySeedCapture = Object.freeze({ v: 1, state: "empty" });
  original.text = "parent changed";
  original.grant.cap = "cccccccc";
  expect(captured.seed.items[0]?.text).toBe("original");
  expect(captured.seed.items[0]?.grant).toMatchObject({ cap: "bbbbbbbb" });
  for (const value of [captured, seed, seed.items, seed.items[0], seed.items[0]?.grant])
    expect(Object.isFrozen(value)).toBe(true);
  expect(empty).toEqual({ v: 1, state: "empty" });
  expect(JSON.stringify(captured)).not.toContain("fast");
  expect(() => {
    (seed.items as unknown[]).push({});
  }).toThrow();
});
