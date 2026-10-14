/**
 * P7w (docs/dev/external-agent/quota-plan.md §9A.1/§9A.5): the quota wire gained droid pool ids,
 * `month`, per-row `billing` and top-level `problems` — append-only. LEGACY_QUOTA_WIRE_SCHEMA is a
 * verbatim copy of the pre-change `QuotaWireSchema` (what a not-yet-upgraded hub decodes with),
 * pinning that (1) ungated droid frames are rejected by it (so the cap gate is necessary),
 * (2) legacy-shaped wires decode identically under both schemas, (3) the new schema accepts the
 * new shapes and enforces their bounds.
 */
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { QuotaWireSchema, decodeAgentFrame } from "../../../src/web-hub/protocol/messages.js";
import { QUOTA_POOLS_HUB_CAP, QUOTA_POOLS_HUB_CAPS } from "../../../src/web-hub/protocol/version.js";

// ---- verbatim pre-P7w copy (do not edit) ---------------------------------------------------
const LegacyQuotaWindowSchema = Type.Object(
  {
    scope: Type.Union([Type.Literal("5h"), Type.Literal("week")]),
    usedPct: Type.Number({ minimum: 0, maximum: 100 }),
    level: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    resetAt: Type.Optional(Type.Number()),
    etaMs: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);
const LegacyQuotaProviderSchema = Type.Object(
  {
    id: Type.Union([Type.Literal("zai-coding-cn"), Type.Literal("zai"), Type.Literal("kimi-coding")]),
    plan: Type.Optional(Type.String({ maxLength: 64 })),
    level: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    stale: Type.Boolean(),
    fetchedAt: Type.Optional(Type.Number()),
    demotedUntil: Type.Optional(Type.Number()),
    windows: Type.Array(LegacyQuotaWindowSchema, { maxItems: 8 }),
  },
  { additionalProperties: true },
);
const LEGACY_QUOTA_WIRE_SCHEMA = Type.Object(
  {
    v: Type.Literal(1),
    at: Type.Number({ minimum: 0 }),
    providers: Type.Array(LegacyQuotaProviderSchema, { maxItems: 16 }),
  },
  { additionalProperties: true },
);
// ---------------------------------------------------------------------------------------------

const legacyWire = () => ({
  v: 1,
  at: 1000,
  providers: [
    {
      id: "kimi-coding",
      level: 1,
      stale: false,
      fetchedAt: 900,
      windows: [
        { scope: "5h", usedPct: 12, level: 0, resetAt: 5000 },
        { scope: "week", usedPct: 55, level: 1, etaMs: 100 },
      ],
    },
    { id: "zai", plan: "max", level: 0, stale: true, windows: [{ scope: "5h", usedPct: 1, level: 0 }] },
  ],
});

const droidWire = () => ({
  v: 1,
  at: 1000,
  providers: [
    {
      id: "droid-standard",
      level: 3,
      stale: false,
      windows: [
        { scope: "5h", usedPct: 12, level: 0 },
        { scope: "week", usedPct: 40, level: 0 },
        { scope: "month", usedPct: 100, level: 3, resetAt: 9000 },
      ],
      billing: { overage: "extraUsage", extraUsageBalanceCents: 1234, gateOpen: true },
    },
    {
      id: "droid-core",
      level: 0,
      stale: false,
      windows: [{ scope: "month", usedPct: 0, level: 0 }],
      billing: { overage: "droidCore", extraUsageBalanceCents: 0 },
    },
  ],
  problems: [{ family: "droid", status: 402 }],
});

describe("quota.pools.v1 cap constant", () => {
  it("is the frozen name", () => {
    expect(QUOTA_POOLS_HUB_CAP).toBe("quota.pools.v1");
    expect([...QUOTA_POOLS_HUB_CAPS]).toEqual(["quota.pools.v1"]);
  });
});

describe("legacy (pre-P7w) schema vs new schema", () => {
  it("1. an ungated droid frame is REJECTED by the legacy schema (the cap gate is necessary)", () => {
    expect(Value.Check(LEGACY_QUOTA_WIRE_SCHEMA, droidWire())).toBe(false);
    // each new feature alone is enough to break the legacy closed unions (problems alone is not)
    const monthOnly = legacyWire();
    monthOnly.providers[0]!.windows.push({ scope: "month", usedPct: 1, level: 0 } as never);
    expect(Value.Check(LEGACY_QUOTA_WIRE_SCHEMA, monthOnly)).toBe(false);
    const idOnly = legacyWire();
    idOnly.providers[0]!.id = "droid-core";
    expect(Value.Check(LEGACY_QUOTA_WIRE_SCHEMA, idOnly)).toBe(false);
  });

  it("2. a legacy-shaped wire (what pools:false emits) passes the legacy schema AND the new one", () => {
    expect(Value.Check(LEGACY_QUOTA_WIRE_SCHEMA, legacyWire())).toBe(true);
    expect(Value.Check(QuotaWireSchema, legacyWire())).toBe(true);
  });

  it("3. the new schema accepts month / droid ids / billing / problems", () => {
    expect(Value.Check(QuotaWireSchema, droidWire())).toBe(true);
    const problemsOnly = { v: 1, at: 1, providers: [], problems: [{ family: "droid", status: 401 }] };
    expect(Value.Check(QuotaWireSchema, problemsOnly)).toBe(true);
  });

  it("4. a legacy-shaped wire decodes to the same value under the legacy and new schema", () => {
    const wire = legacyWire();
    const legacyDecoded = Value.Clean(LEGACY_QUOTA_WIRE_SCHEMA, structuredClone(wire));
    const newDecoded = Value.Clean(QuotaWireSchema, structuredClone(wire));
    expect(newDecoded).toEqual(legacyDecoded);
    expect(newDecoded).toEqual(wire);
  });

  it("a droid status frame survives decodeAgentFrame (new hub passes it through)", () => {
    const frame = decodeAgentFrame({
      t: "status",
      ...baseStatus(),
      quota: droidWire(),
    });
    expect((frame as { quota?: unknown } | undefined)?.quota).toEqual(droidWire());
  });
});

describe("new schema bounds", () => {
  it("rejects negative / fractional cents", () => {
    const w = droidWire();
    w.providers[0]!.billing.extraUsageBalanceCents = -1;
    expect(Value.Check(QuotaWireSchema, w)).toBe(false);
    w.providers[0]!.billing.extraUsageBalanceCents = 1.5;
    expect(Value.Check(QuotaWireSchema, w)).toBe(false);
  });
  it("rejects unknown overage and gateOpen:false", () => {
    const w = droidWire();
    (w.providers[0]!.billing as { overage: string }).overage = "weird";
    expect(Value.Check(QuotaWireSchema, w)).toBe(false);
    const w2 = droidWire();
    (w2.providers[0]!.billing as { gateOpen?: boolean }).gateOpen = false;
    expect(Value.Check(QuotaWireSchema, w2)).toBe(false);
  });
  it("rejects problems status out of 100..599, non-droid family, and more than 4 entries", () => {
    for (const status of [99, 600, 402.5]) {
      const w = droidWire();
      w.problems = [{ family: "droid", status }];
      expect(Value.Check(QuotaWireSchema, w)).toBe(false);
    }
    const w = droidWire();
    (w.problems as Array<{ family: string; status: number }>)[0]!.family = "other";
    expect(Value.Check(QuotaWireSchema, w)).toBe(false);
    const w5 = droidWire();
    w5.problems = Array.from({ length: 5 }, () => ({ family: "droid" as const, status: 402 }));
    expect(Value.Check(QuotaWireSchema, w5)).toBe(false);
    const w4 = droidWire();
    w4.problems = Array.from({ length: 4 }, () => ({ family: "droid" as const, status: 402 }));
    expect(Value.Check(QuotaWireSchema, w4)).toBe(true);
  });
  it("still rejects unknown scope and unknown provider id", () => {
    const w = droidWire();
    (w.providers[0]!.windows[0] as { scope: string }).scope = "year";
    expect(Value.Check(QuotaWireSchema, w)).toBe(false);
    const w2 = droidWire();
    (w2.providers[0] as { id: string }).id = "droid";
    expect(Value.Check(QuotaWireSchema, w2)).toBe(false);
  });
});

function baseStatus(): Record<string, unknown> {
  return {
    leafId: "abc123",
    busy: true,
    pending: false,
    contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0.5 },
    costUsd: 0.12,
    subagentCostUsd: 0.01,
  };
}
