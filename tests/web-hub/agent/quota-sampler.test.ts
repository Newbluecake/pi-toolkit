// quota-web plan §2 (D3/D4): `projectQuota`/`quotaFingerprint` — pure projection + the 1Hz
// fingerprint gate (no sampler state, no timers: see the module's own docstring for why this
// differs from worktree-sampler.ts/bash-jobs-sampler.ts).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { projectQuota, quotaFingerprint } from "../../../src/web-hub/agent/quota-sampler.js";
import { QuotaWireSchema } from "../../../src/web-hub/protocol/messages.js";
import { LEGACY_QUOTA_WIRE_SCHEMA } from "../protocol/legacy-quota-schema.js";
import type { ProviderVerdict, WindowVerdict } from "../../../src/quota/ladder.js";

function window(over: Partial<WindowVerdict> = {}): WindowVerdict {
  return { scope: "5h", usedPct: 10, level: 0, reason: "none", ...over };
}

function verdict(over: Partial<ProviderVerdict> = {}): ProviderVerdict {
  return {
    provider: "zai-coding-cn",
    level: 0,
    windows: [window()],
    demoted: false,
    fetchedAt: 1_000,
    stale: false,
    ...over,
  };
}

describe("projectQuota", () => {
  it("undefined/empty verdicts ⇒ undefined (field omitted entirely)", () => {
    expect(projectQuota(undefined, 1_000)).toBeUndefined();
    expect(projectQuota([], 1_000)).toBeUndefined();
  });

  it("writes displayLevel (not the forecast-raised level) to provider and window wire", () => {
    const v = verdict({
      level: 2,
      displayLevel: 0,
      windows: [window({ usedPct: 30, level: 2, displayLevel: 0, reason: "forecast-before-reset" })],
    });
    const wire = projectQuota([v], 1_000)!;
    expect(wire.providers[0]?.level).toBe(0);
    expect(wire.providers[0]?.windows[0]?.level).toBe(0);
  });

  it("falls back to level when displayLevel is absent", () => {
    const wire = projectQuota([verdict({ level: 2, windows: [window({ level: 2 })] })], 1_000)!;
    expect(wire.providers[0]?.level).toBe(2);
    expect(wire.providers[0]?.windows[0]?.level).toBe(2);
  });

  it("projects provider + window fields; v=1 and at=now", () => {
    const v = verdict({
      provider: "kimi-coding",
      level: 2,
      plan: "pro",
      demoted: true,
      demotedUntil: 5_000,
      stale: true,
      windows: [window({ scope: "week", usedPct: 91.4, level: 2, resetAt: 9_000, etaMs: 120_000 })],
    });
    const wire = projectQuota([v], 2_000)!;
    expect(wire.v).toBe(1);
    expect(wire.at).toBe(2_000);
    expect(wire.providers).toHaveLength(1);
    expect(wire.providers[0]).toEqual({
      id: "kimi-coding",
      plan: "pro",
      level: 2,
      stale: true,
      fetchedAt: 1_000,
      demotedUntil: 5_000,
      windows: [{ scope: "week", usedPct: 91.4, level: 2, resetAt: 9_000, etaMs: 120_000 }],
    });
  });

  it("projects fetchedAt unconditionally (always present on the verdict)", () => {
    const wire = projectQuota([verdict({ fetchedAt: 7_500 })], 1_000)!;
    expect(wire.providers[0]!.fetchedAt).toBe(7_500);
  });

  it("omits plan/demotedUntil/resetAt/etaMs when absent (never emits as explicit undefined)", () => {
    const wire = projectQuota([verdict()], 1_000)!;
    const p = wire.providers[0]!;
    expect("plan" in p).toBe(false);
    expect("demotedUntil" in p).toBe(false);
    const w = p.windows[0]!;
    expect("resetAt" in w).toBe(false);
    expect("etaMs" in w).toBe(false);
  });

  it("demoted=true but demotedUntil undefined ⇒ wire carries no demotedUntil (matches the plan's wire shape — no standalone `demoted` flag)", () => {
    const wire = projectQuota([verdict({ demoted: true })], 1_000)!;
    expect("demotedUntil" in wire.providers[0]!).toBe(false);
  });

  it("multiple providers project in order; an unrecognized provider id is dropped, not fatal", () => {
    const bogus = verdict({ provider: "nope" as unknown as ProviderVerdict["provider"] });
    const wire = projectQuota([verdict({ provider: "zai" }), bogus, verdict({ provider: "kimi-coding" })], 1_000)!;
    expect(wire.providers.map((p) => p.id)).toEqual(["zai", "kimi-coding"]);
  });

  it("every provider dropped (all unrecognized ids) ⇒ undefined, not an empty-providers wire", () => {
    const bogus = verdict({ provider: "nope" as unknown as ProviderVerdict["provider"] });
    expect(projectQuota([bogus], 1_000)).toBeUndefined();
  });
});

describe("quotaFingerprint", () => {
  it("undefined wire ⇒ empty-string sentinel, distinct from any real wire", () => {
    expect(quotaFingerprint(undefined)).toBe("");
    const wire = projectQuota([verdict()], 1_000)!;
    expect(quotaFingerprint(wire)).not.toBe("");
  });

  it("ignores `at` (two reads a tick apart with identical verdicts must not flip the fingerprint)", () => {
    const v = verdict();
    const a = projectQuota([v], 1_000)!;
    const b = projectQuota([v], 61_000)!;
    expect(quotaFingerprint(a)).toBe(quotaFingerprint(b));
  });

  it("rounds usedPct to whole percent, resetAt/etaMs to the minute (sub-unit jitter never flips it)", () => {
    const v1 = verdict({ windows: [window({ usedPct: 50.1, resetAt: 60_000, etaMs: 120_000 })] });
    const v2 = verdict({ windows: [window({ usedPct: 50.49, resetAt: 60_999, etaMs: 120_999 })] });
    expect(quotaFingerprint(projectQuota([v1], 0))).toBe(quotaFingerprint(projectQuota([v2], 0)));
  });

  it("flips on a real level/usedPct/resetAt/etaMs/stale/demotedUntil change", () => {
    const base = quotaFingerprint(projectQuota([verdict()], 0));
    expect(quotaFingerprint(projectQuota([verdict({ level: 1 })], 0))).not.toBe(base);
    expect(quotaFingerprint(projectQuota([verdict({ windows: [window({ usedPct: 60 })] })], 0))).not.toBe(base);
    expect(quotaFingerprint(projectQuota([verdict({ stale: true })], 0))).not.toBe(base);
    expect(quotaFingerprint(projectQuota([verdict({ demoted: true, demotedUntil: 5_000 })], 0))).not.toBe(base);
    expect(quotaFingerprint(projectQuota([verdict({ windows: [window({ resetAt: 600_000 })] })], 0))).not.toBe(base);
    expect(quotaFingerprint(projectQuota([verdict({ windows: [window({ etaMs: 600_000 })] })], 0))).not.toBe(base);
    expect(quotaFingerprint(projectQuota([verdict({ fetchedAt: 9_999 })], 0))).not.toBe(base);
  });
});

// quota-plan r2 §11（P7）：droid 行过滤 / month 防御——P7 单独合入时 web 永不收到 droid
// 数据（旧 hub 的 decodeWith 遇封闭枚举外的值会丢整帧）。
describe("projectQuota — droid / month legacy guard (P7)", () => {
  const droidStd = verdict({
    provider: "droid-standard",
    level: 3,
    windows: [window({ scope: "5h", usedPct: 100, level: 3, reason: "exhausted" })],
  });
  const droidCore = verdict({ provider: "droid-core", windows: [window({ scope: "month", usedPct: 3 })] });

  it("only droid rows ⇒ undefined (field omitted, byte-equal to pre-feature)", () => {
    expect(projectQuota([droidStd, droidCore], 1_000)).toBeUndefined();
    expect(quotaFingerprint(projectQuota([droidStd, droidCore], 1_000))).toBe("");
  });

  it("droid mixed with kimi ⇒ output is byte-identical to the kimi-only projection", () => {
    const kimi = verdict({
      provider: "kimi-coding",
      level: 1,
      windows: [window({ scope: "week", usedPct: 55, level: 1 })],
    });
    const alone = projectQuota([kimi], 5_000);
    const mixed = projectQuota([droidStd, kimi, droidCore], 5_000);
    expect(JSON.stringify(mixed)).toBe(JSON.stringify(alone));
    expect(mixed?.providers.map((p) => p.id)).toEqual(["kimi-coding"]);
    expect(quotaFingerprint(mixed)).toBe(quotaFingerprint(alone));
  });

  it("a kimi/zai verdict carrying a month window (defensive) drops the month window, keeps the rest", () => {
    const v = verdict({
      provider: "zai-coding-cn",
      windows: [window({ scope: "5h", usedPct: 10 }), window({ scope: "month", usedPct: 99, level: 3 })],
    });
    const wire = projectQuota([v], 0)!;
    expect(wire.providers[0]?.windows.map((w) => w.scope)).toEqual(["5h"]);
    expect(JSON.stringify(wire)).not.toContain("month");
  });

  it("billing is never projected on the legacy wire", () => {
    const v = {
      ...verdict({ provider: "kimi-coding" }),
      billing: {
        kind: "factory" as const,
        pool: "standard" as const,
        overage: "extraUsage" as const,
        extraUsageAllowed: true,
        extraUsageBalanceCents: 100,
      },
    };
    expect(JSON.stringify(projectQuota([v], 0))).not.toContain("billing");
  });
});

// quota-plan r2 §9A.4（P7wa）：cap 门控的 pools 模式——`quota.pools.v1` 在场时 droid 两池行、
// month 窗口、billing（D20 字段）、problems 上线；不在场时与 P7 字节一致。
describe("projectQuota — pools mode (P7wa, §9A.4)", () => {
  const billing = (over: Partial<Parameters<typeof droidVerdict>[0]["billing"]> = {}) =>
    ({
      kind: "factory",
      pool: "standard",
      overage: "extraUsage",
      extraUsageAllowed: true,
      extraUsageBalanceCents: 1_234,
      ...over,
    }) as NonNullable<ProviderVerdict["billing"]>;
  function droidVerdict(over: Partial<ProviderVerdict> = {}): ProviderVerdict {
    return verdict({
      provider: "droid-standard",
      level: 3,
      windows: [
        window({ scope: "5h", usedPct: 100, level: 3, reason: "exhausted" }),
        window({ scope: "week", usedPct: 40, level: 0 }),
        window({ scope: "month", usedPct: 88, level: 2, resetAt: 9_000 }),
      ],
      ...over,
    });
  }
  const kimi = verdict({
    provider: "kimi-coding",
    level: 1,
    windows: [window({ scope: "week", usedPct: 55, level: 1 })],
  });

  it("pools:true keeps droid rows and the month window; passes the CURRENT wire schema", () => {
    const std = droidVerdict({ billing: billing() });
    const core = verdict({
      provider: "droid-core",
      windows: [window({ scope: "month", usedPct: 3 })],
      billing: billing({ pool: "core", overage: "droidCore", extraUsageBalanceCents: 0 }),
    });
    const wire = projectQuota([std, core, kimi], 5_000, { pools: true })!;
    expect(wire.providers.map((p) => p.id)).toEqual(["droid-standard", "droid-core", "kimi-coding"]);
    expect(wire.providers[0]!.windows.map((w) => w.scope)).toEqual(["5h", "week", "month"]);
    expect(wire.providers[1]!.windows.map((w) => w.scope)).toEqual(["month"]);
    expect("problems" in wire).toBe(false);
    expect(Value.Check(QuotaWireSchema, wire)).toBe(true);
  });

  it("billing carries exactly D20's fields: overage + cents, gateOpen only when true", () => {
    const closed = droidVerdict({ billing: billing({ gateOpen: false }) });
    const wClosed = projectQuota([closed], 0, { pools: true })!;
    expect(wClosed.providers[0]!.billing).toEqual({ overage: "extraUsage", extraUsageBalanceCents: 1_234 });
    expect(JSON.stringify(wClosed)).not.toContain("gateOpen");
    // kind/pool/extraUsageAllowed are agent-internal semantics — never on the wire (D20)
    expect(JSON.stringify(wClosed)).not.toContain("extraUsageAllowed");
    expect(JSON.stringify(wClosed)).not.toContain('"pool"');
    expect(JSON.stringify(wClosed)).not.toContain('"kind"');

    const open = droidVerdict({ billing: billing({ gateOpen: true }) });
    const wOpen = projectQuota([open], 0, { pools: true })!;
    expect(wOpen.providers[0]!.billing).toEqual({
      overage: "extraUsage",
      extraUsageBalanceCents: 1_234,
      gateOpen: true,
    });
  });

  it("billing is NOT projected in legacy mode even for a droid row carrying it", () => {
    const v = droidVerdict({ billing: billing({ gateOpen: true }) });
    expect(projectQuota([v, kimi], 0, { pools: false })!.providers.map((p) => p.id)).toEqual(["kimi-coding"]);
    expect(JSON.stringify(projectQuota([v, kimi], 0))).not.toContain("billing");
  });

  it("problems: only family droid, capped at 4; non-droid family and bad statuses dropped", () => {
    const problems = [
      { family: "droid", status: 402 },
      { family: "other", status: 401 }, // 非固定字面量 ⇒ 丢弃
      { family: "droid", status: 99 }, // 越界 ⇒ 丢弃
      { family: "droid", status: 600 }, // 越界 ⇒ 丢弃
      { family: "droid", status: 403.5 }, // 非整数 ⇒ 丢弃
      { family: "droid", status: 401 },
      { family: "droid", status: 403 },
      { family: "droid", status: 500 },
    ];
    const wire = projectQuota([droidVerdict()], 0, { pools: true, problems })!;
    expect(wire.problems).toEqual([
      { family: "droid", status: 402 },
      { family: "droid", status: 401 },
      { family: "droid", status: 403 },
      { family: "droid", status: 500 },
    ]);
    expect(Value.Check(QuotaWireSchema, wire)).toBe(true);
  });

  it("problems are ignored unless pools is true (never on the legacy wire)", () => {
    const problems = [{ family: "droid", status: 402 }];
    expect(JSON.stringify(projectQuota([kimi], 0, { problems }))).not.toContain("problems");
    expect(JSON.stringify(projectQuota([kimi], 0, { pools: false, problems }))).not.toContain("problems");
  });

  it("problems-only (all droid rows absent / empty verdicts) ⇒ providers:[] + problems", () => {
    const wire = projectQuota([], 7_000, { pools: true, problems: [{ family: "droid", status: 402 }] })!;
    expect(wire).toEqual({ v: 1, at: 7_000, providers: [], problems: [{ family: "droid", status: 402 }] });
    expect(Value.Check(QuotaWireSchema, wire)).toBe(true);
    // 两者都空 ⇒ undefined（字段缺席）
    expect(projectQuota([], 7_000, { pools: true })).toBeUndefined();
    expect(projectQuota([], 7_000, { pools: true, problems: [{ family: "other", status: 401 }] })).toBeUndefined();
  });

  it("pools:true over kimi-only input (no billing/month/problems) is byte-identical to legacy", () => {
    const legacy = projectQuota([kimi], 3_000);
    const pools = projectQuota([kimi], 3_000, { pools: true });
    expect(JSON.stringify(pools)).toBe(JSON.stringify(legacy));
  });

  it("no-opts vs {pools:false} are byte-identical on mixed droid+kimi input, and pass the OLD schema copy", () => {
    const std = droidVerdict({ billing: billing({ gateOpen: true }) });
    const core = verdict({ provider: "droid-core", windows: [window({ scope: "month", usedPct: 3 })] });
    const input = [std, kimi, core];
    const noOpts = projectQuota(input, 9_000);
    const poolsFalse = projectQuota(input, 9_000, { pools: false, problems: [{ family: "droid", status: 402 }] });
    expect(JSON.stringify(poolsFalse)).toBe(JSON.stringify(noOpts));
    // §9A.5-2：旧 hub（改动前 schema 副本）能解码 pools:false 的输出——不丢帧
    expect(Value.Check(LEGACY_QUOTA_WIRE_SCHEMA, poolsFalse)).toBe(true);
    expect(quotaFingerprint(poolsFalse)).toBe(quotaFingerprint(noOpts));
  });

  it("golden: {pools:false} (and no-opts) reproduce the P7 fixture wire byte-for-byte", () => {
    const fixture = JSON.parse(
      readFileSync(resolve(process.cwd(), "tests/fixtures/quota-kimi-zai-golden.json"), "utf8"),
    ) as {
      meta: { now: number };
      verdicts: Record<string, ProviderVerdict>;
      sampler: { wire: unknown; fingerprint: string };
    };
    // 与 recordKimiZaiGolden 相同的输入列表（kimi-zai-golden.ts 的 sampler 段）
    const input = ["kimi-trap", "zai-cn-l1", "zai-l1", "demotion-floor"].map(
      (k) => fixture.verdicts[k] as ProviderVerdict,
    );
    const now = fixture.meta.now;
    for (const opts of [undefined, { pools: false }] as const) {
      const wire = projectQuota(input, now, opts);
      expect(JSON.parse(JSON.stringify(wire))).toEqual(fixture.sampler.wire);
      expect(quotaFingerprint(wire)).toBe(fixture.sampler.fingerprint);
    }
    expect(Value.Check(LEGACY_QUOTA_WIRE_SCHEMA, projectQuota(input, now, { pools: false }))).toBe(true);
  });
});

describe("quotaFingerprint — pools additions (P7wa, §9A.4)", () => {
  const billing = (over: Partial<NonNullable<ProviderVerdict["billing"]>> = {}) =>
    ({
      kind: "factory",
      pool: "standard",
      overage: "extraUsage",
      extraUsageAllowed: true,
      extraUsageBalanceCents: 1_000,
      ...over,
    }) as NonNullable<ProviderVerdict["billing"]>;
  const droid = (b?: ProviderVerdict["billing"]): ProviderVerdict =>
    verdict({
      provider: "droid-standard",
      windows: [window({ scope: "month", usedPct: 5 })],
      ...(b !== undefined ? { billing: b } : {}),
    });

  it("legacy-shaped output keeps the exact pre-P7wa fingerprint bytes (no billing/problems keys)", () => {
    const kimi = verdict({ provider: "kimi-coding" });
    expect(quotaFingerprint(projectQuota([kimi], 0, { pools: true }))).toBe(
      JSON.stringify([
        {
          id: "kimi-coding",
          level: 0,
          demotedUntil: undefined,
          stale: false,
          fetchedAt: 1_000,
          windows: [{ scope: "5h", usedPct: 10, resetAt: undefined, etaMs: undefined }],
        },
      ]),
    );
  });

  it("flips on billing (overage / cents / gateOpen) and on problems", () => {
    const base = quotaFingerprint(projectQuota([droid(billing())], 0, { pools: true }));
    expect(quotaFingerprint(projectQuota([droid()], 0, { pools: true }))).not.toBe(base); // billing 出现
    expect(
      quotaFingerprint(projectQuota([droid(billing({ extraUsageBalanceCents: 2_000 }))], 0, { pools: true })),
    ).not.toBe(base); // cents 变化
    expect(quotaFingerprint(projectQuota([droid(billing({ overage: "droidCore" }))], 0, { pools: true }))).not.toBe(
      base,
    ); // overage 变化
    expect(quotaFingerprint(projectQuota([droid(billing({ gateOpen: true }))], 0, { pools: true }))).not.toBe(base); // gateOpen 装饰
    const withProblems = projectQuota([droid(billing())], 0, {
      pools: true,
      problems: [{ family: "droid", status: 402 }],
    })!;
    expect(quotaFingerprint(withProblems)).not.toBe(base);
    expect(quotaFingerprint({ ...withProblems, problems: [{ family: "droid", status: 401 }] })).not.toBe(
      quotaFingerprint(withProblems),
    );
  });

  it("ignores `at` even with problems (two reads a tick apart keep the fingerprint)", () => {
    const mk = (at: number) =>
      projectQuota([droid()], at, { pools: true, problems: [{ family: "droid", status: 402 }] })!;
    expect(quotaFingerprint(mk(1_000))).toBe(quotaFingerprint(mk(61_000)));
  });
});
