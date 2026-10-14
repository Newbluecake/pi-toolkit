import { describe, expect, it } from "vitest";
import { EXTERNAL_DEGRADED_CAP, mergeExternalMeta, mergeUnpriced } from "../../src/core/external-meta.js";
import type { ExternalMetaPatch, ExternalPricingDiag, ExternalRunMeta, UsageDelta } from "../../src/core/types.js";

const priced = (source: string): ExternalPricingDiag => ({ status: "priced", source });
const usage = (over: Partial<UsageDelta> = {}): UsageDelta => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0,
  ...over,
});

describe("mergeExternalMeta (external-agent plan §2.2)", () => {
  it("first patch creates the meta object with the patch provider", () => {
    expect(mergeExternalMeta(undefined, { provider: "droid" })).toEqual({ provider: "droid" });
    expect(mergeExternalMeta(undefined, { provider: "droid", sessionId: "abc12345" })).toEqual({
      provider: "droid",
      sessionId: "abc12345",
    });
  });

  it("plain string fields are last-wins; absent keys keep the previous value", () => {
    const prev: ExternalRunMeta = {
      provider: "droid",
      sessionId: "aaaaaaaa",
      autonomy: "high",
      protocolVersion: "1.264.0",
      agentVersion: "0.241.1",
      nativeSessionFile: "/x/y.jsonl",
    };
    const next = mergeExternalMeta(prev, {
      provider: "droid",
      sessionId: "bbbbbbbb",
      autonomy: "low",
    });
    expect(next.sessionId).toBe("bbbbbbbb");
    expect(next.autonomy).toBe("low");
    expect(next.protocolVersion).toBe("1.264.0");
    expect(next.agentVersion).toBe("0.241.1");
    expect(next.nativeSessionFile).toBe("/x/y.jsonl");
  });

  it.each(["credits", "thinkingTokens", "childTokens", "permissionApprovals", "unknownNotifications"] as const)(
    "%s takes the max (monotone counters)",
    (key) => {
      const prev: ExternalRunMeta = { provider: "droid", [key]: 10 };
      expect(mergeExternalMeta(prev, { provider: "droid", [key]: 3 })[key]).toBe(10);
      expect(mergeExternalMeta(prev, { provider: "droid", [key]: 25 })[key]).toBe(25);
      // patch without the key keeps the previous value
      expect(mergeExternalMeta(prev, { provider: "droid" })[key]).toBe(10);
      // non-finite patch values are ignored defensively
      expect(mergeExternalMeta(prev, { provider: "droid", [key]: Number.NaN })[key]).toBe(10);
    },
  );

  it("degraded is an order-preserving union with dedupe", () => {
    const prev: ExternalRunMeta = { provider: "droid", degraded: ["a", "b"] };
    expect(mergeExternalMeta(prev, { provider: "droid", degraded: ["b", "c"] }).degraded).toEqual(["a", "b", "c"]);
    expect(mergeExternalMeta({ provider: "droid" }, { provider: "droid", degraded: ["x"] }).degraded).toEqual(["x"]);
  });

  it(`degraded is capped at ${EXTERNAL_DEGRADED_CAP} entries, dropping the oldest`, () => {
    const prev: ExternalRunMeta = { provider: "droid", degraded: Array.from({ length: 14 }, (_, i) => `d${i}`) };
    const next = mergeExternalMeta(prev, { provider: "droid", degraded: ["n1", "n2", "n3", "n4"] });
    expect(next.degraded).toHaveLength(EXTERNAL_DEGRADED_CAP);
    // 14 + 4 = 18 ⇒ the two earliest (d0, d1) drop; order preserved otherwise
    expect(next.degraded).toEqual([...Array.from({ length: 12 }, (_, i) => `d${i + 2}`), "n1", "n2", "n3", "n4"]);
  });

  it("pricing only ever degrades: priced < partial < unpriced (status takes the worse, fields follow)", () => {
    // no prev pricing ⇒ patch installs
    expect(mergeExternalMeta({ provider: "droid" }, { provider: "droid", pricing: priced("a") }).pricing).toEqual(
      priced("a"),
    );
    // priced → partial upgrade wins (patch)
    let meta: ExternalRunMeta = { provider: "droid", pricing: priced("a") };
    let next = mergeExternalMeta(meta, { provider: "droid", pricing: { status: "partial", reason: "child_usage" } });
    expect(next.pricing).toEqual({ status: "partial", reason: "child_usage" });
    // partial → priced does NOT regress
    meta = next;
    next = mergeExternalMeta(meta, { provider: "droid", pricing: priced("b") });
    expect(next.pricing).toEqual({ status: "partial", reason: "child_usage" });
    // partial → unpriced wins
    next = mergeExternalMeta(meta, {
      provider: "droid",
      pricing: { status: "unpriced", reason: "no_match" },
    });
    expect(next.pricing).toEqual({ status: "unpriced", reason: "no_match" });
    // unpriced → priced does not regress
    meta = next;
    next = mergeExternalMeta(meta, { provider: "droid", pricing: priced("c") });
    expect(next.pricing).toEqual({ status: "unpriced", reason: "no_match" });
    // unpriced → partial does not regress (unpriced is strictly worse)
    next = mergeExternalMeta(meta, { provider: "droid", pricing: { status: "partial", reason: "child_usage" } });
    expect(next.pricing).toEqual({ status: "unpriced", reason: "no_match" });
    // same rank ⇒ patch wins wholesale (last-wins within the rank)
    meta = { provider: "droid", pricing: priced("old") };
    expect(mergeExternalMeta(meta, { provider: "droid", pricing: priced("new") }).pricing).toEqual(priced("new"));
    // patch without pricing keeps prev
    expect(mergeExternalMeta(meta, { provider: "droid" }).pricing).toEqual(priced("old"));
  });

  it("reconciled (plan r3) latches true and never resets", () => {
    const prev: ExternalRunMeta = { provider: "droid" };
    const latched = mergeExternalMeta(prev, { provider: "droid", reconciled: true });
    expect(latched.reconciled).toBe(true);
    expect(mergeExternalMeta(latched, { provider: "droid" }).reconciled).toBe(true);
    expect(mergeExternalMeta(prev, { provider: "droid" }).reconciled).toBeUndefined();
  });

  it("ignores non-finite counter and malformed pricing shapes defensively", () => {
    const prev: ExternalRunMeta = { provider: "droid", credits: 5, pricing: priced("x") };
    const patch = {
      provider: "droid",
      credits: Number.POSITIVE_INFINITY,
      pricing: { status: "bogus" },
    } as unknown as ExternalMetaPatch;
    const next = mergeExternalMeta(prev, patch);
    expect(next.credits).toBe(5);
    expect(next.pricing).toEqual(priced("x"));
  });
});

describe("mergeUnpriced (external-agent plan §2.2, review #10)", () => {
  it("full table", () => {
    const cases: Array<
      [
        UsageDelta["unpriced"] | undefined,
        UsageDelta["unpriced"] | undefined,
        UsageDelta["unpriced"] | undefined,
        string,
      ]
    > = [
      [undefined, undefined, undefined, "no prev, none on delta"],
      [undefined, "all", "all", "first delta carries all"],
      [undefined, "partial", "partial", "first delta carries partial"],
      // a delta WITHOUT the marker is a priced delta: mixing priced and
      // unpriced accumulation degrades the total to "partial" (plan: 两者相同
      // ⇒ 不变，否则 partial).
      ["all", undefined, "partial", "prev all, delta priced"],
      ["partial", undefined, "partial", "prev partial, delta priced"],
      ["all", "all", "all", "same"],
      ["partial", "partial", "partial", "same"],
      ["all", "partial", "partial", "mixed ⇒ partial"],
      ["partial", "all", "partial", "mixed ⇒ partial"],
    ];
    for (const [prevU, deltaU, expected, label] of cases) {
      const prev = prevU === undefined ? undefined : usage({ unpriced: prevU });
      expect(mergeUnpriced(prev, usage({ unpriced: deltaU })), label).toBe(expected);
    }
  });
});
