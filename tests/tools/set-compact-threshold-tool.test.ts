import { describe, expect, it } from "vitest";
import { createSetCompactThresholdTool } from "../../src/tools/set-compact-threshold-tool.js";
import type { CompactHintState } from "../../src/stack.js";

function state(): CompactHintState {
  return {
    thresholdPercent: 75,
    forceAtPercent: 88,
    thresholdTokens: 0,
    forceAtTokens: 0,
    reserveTokens: 16384,
    lastHintAt: 123,
    hintedAt: { effectivePercent: 75, contextWindow: 200000 },
    tickStepPercent: 10,
    lastTickStep: 0,
  };
}
function ctx(overrides: Record<string, unknown> = {}) {
  return {
    mode: "interactive",
    getContextUsage: () => ({ percent: 80, contextWindow: 200000, tokens: 1 }),
    ...overrides,
  } as never;
}

describe("set_compact_threshold", () => {
  it("queries and writes with reset semantics", async () => {
    const current = state();
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    expect((await tool.execute("1", {}, undefined, undefined, ctx())).details).toMatchObject({
      ok: true,
      action: "query",
    });
    await tool.execute("2", { percent: 70 }, undefined, undefined, ctx());
    expect(current).toMatchObject({ thresholdPercent: 70, lastHintAt: 0, hintedAt: undefined });
  });
  it("disables with zero and resets all state", async () => {
    const current = state();
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    const response = await tool.execute("1", { percent: 0 }, undefined, undefined, ctx());
    expect(response.details).toMatchObject({ ok: true, action: "off", thresholdPercent: 0 });
    expect(current).toMatchObject({ thresholdPercent: 0, lastHintAt: 0, hintedAt: undefined });
  });
  it("sets, queries, and rejects invalid force thresholds", async () => {
    const current = state();
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    const set = await tool.execute("1", { force: 90 }, undefined, undefined, ctx());
    expect(set.details).toMatchObject({ ok: true, forceAtPercent: 90 });
    expect(current.forceAtPercent).toBe(90);
    const query = await tool.execute("2", {}, undefined, undefined, ctx());
    expect(query.details).toMatchObject({ ok: true, forceAtPercent: 90, effectiveForcePercent: 90 });
    const bad = await tool.execute("3", { force: 75 }, undefined, undefined, ctx());
    expect(bad.details).toMatchObject({ ok: false, reason: "invalid" });
    expect(current.forceAtPercent).toBe(90);
  });

  it("allows percent-only updates below a 128k dynamic cap despite the default force", async () => {
    const current = state();
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    const response = await tool.execute(
      "1",
      { percent: 60 },
      undefined,
      undefined,
      ctx({ getContextUsage: () => ({ percent: 50, contextWindow: 128000, tokens: 1 }) }),
    );
    expect(response.details).toMatchObject({ ok: true, thresholdPercent: 60 });
    expect(current).toMatchObject({ thresholdPercent: 60, forceAtPercent: 88 });
  });

  it("rejects combinations that would make warning meet or exceed force", async () => {
    const current = state();
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    const percentOnly = await tool.execute("1", { percent: 90 }, undefined, undefined, ctx());
    expect(percentOnly.details).toMatchObject({ ok: false, reason: "invalid" });
    const combined = await tool.execute("2", { percent: 80, force: 80 }, undefined, undefined, ctx());
    expect(combined.details).toMatchObject({ ok: false, reason: "invalid" });
    expect(current).toMatchObject({ thresholdPercent: 75, forceAtPercent: 88 });
  });

  it("rejects invalid and above-cap values without writing", async () => {
    const current = state();
    current.forceAtPercent = 100;
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    for (const percent of [0.5, 101, -1, Number.NaN])
      expect((await tool.execute("1", { percent }, undefined, undefined, ctx())).details).toMatchObject({
        ok: false,
        reason: "invalid",
      });
    expect((await tool.execute("1", { percent: 92 }, undefined, undefined, ctx())).details).toMatchObject({
      ok: false,
      reason: "above_cap",
    });
    expect(current.thresholdPercent).toBe(75);
  });
  it("accepts integer-floor values and usage without a context window", async () => {
    const current = state();
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    const usageMissing = ctx({ getContextUsage: () => undefined });
    const response = await tool.execute("1", { percent: 75.9 }, undefined, undefined, usageMissing);
    expect(response.details).toMatchObject({ ok: true, thresholdPercent: 75 });
    expect(response.content[0]?.text).toContain("读侧钳制可能生效");
    expect((await tool.execute("2", { percent: 1 }, undefined, undefined, ctx())).details).toMatchObject({
      ok: true,
      thresholdPercent: 1,
    });
  });
  it("returns disabled and no-session reasons", async () => {
    const disabled = createSetCompactThresholdTool({ getState: () => state(), compactToolEnabled: () => false });
    expect((await disabled.execute("1", { percent: 50 }, undefined, undefined, ctx())).details).toMatchObject({
      ok: false,
      reason: "compact_tool_disabled",
    });
    const absent = createSetCompactThresholdTool({ getState: () => undefined, compactToolEnabled: () => true });
    expect((await absent.execute("2", { percent: 50 }, undefined, undefined, ctx())).details).toMatchObject({
      ok: false,
      reason: "no_session",
    });
  });
  it("rejects noninteractive mode", async () => {
    const tool = createSetCompactThresholdTool({ getState: () => state(), compactToolEnabled: () => true });
    expect(
      (await tool.execute("1", { percent: 50 }, undefined, undefined, ctx({ mode: "json" }))).details,
    ).toMatchObject({ reason: "non_interactive_mode" });
  });

  it("sets and queries absolute token thresholds with min semantics", async () => {
    const current = state();
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    // 100k on a 200k window is stricter than 75% → effective 50%.
    const set = await tool.execute("1", { tokens: 100 }, undefined, undefined, ctx());
    expect(set.details).toMatchObject({ ok: true, action: "set", thresholdTokens: 100, effectivePercent: 50 });
    expect(current).toMatchObject({ thresholdTokens: 100, lastHintAt: 0, hintedAt: undefined });
    expect(set.content[0]?.text).toContain("75%/100k");
    const query = await tool.execute("2", {}, undefined, undefined, ctx());
    expect(query.details).toMatchObject({ ok: true, action: "query", thresholdTokens: 100, effectivePercent: 50 });
    expect(query.content[0]?.text).toContain("75%/100k");
    // 0 disables the absolute line again, percent-only.
    const off = await tool.execute("3", { tokens: 0 }, undefined, undefined, ctx());
    expect(off.details).toMatchObject({ ok: true, thresholdTokens: 0, effectivePercent: 75 });
    expect(off.content[0]?.text).not.toContain("/0k");
  });

  it("rejects invalid and force-conflicting token thresholds", async () => {
    const current = state();
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    for (const tokens of [-1, Number.NaN])
      expect((await tool.execute("1", { tokens }, undefined, undefined, ctx())).details).toMatchObject({
        ok: false,
        reason: "invalid",
      });
    for (const forceTokens of [-1, Number.NaN])
      expect((await tool.execute("1", { forceTokens }, undefined, undefined, ctx())).details).toMatchObject({
        ok: false,
        reason: "invalid",
      });
    // Effective hint line on a 200k window is 75% → 150k; forceTokens must exceed it.
    expect((await tool.execute("2", { forceTokens: 100 }, undefined, undefined, ctx())).details).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect((await tool.execute("3", { forceTokens: 150 }, undefined, undefined, ctx())).details).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect((await tool.execute("4", { forceTokens: 160 }, undefined, undefined, ctx())).details).toMatchObject({
      ok: true,
      forceAtTokens: 160,
    });
    expect(current).toMatchObject({ thresholdPercent: 75, thresholdTokens: 0, forceAtTokens: 160 });
  });

  it("annotates an absolute line that auto-disables above the window", async () => {
    const current = state();
    current.thresholdTokens = 400;
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    // 400k > 200k window → inactive, effective falls back to pure percent.
    const query = await tool.execute("1", {}, undefined, undefined, ctx());
    expect(query.details).toMatchObject({ ok: true, effectivePercent: 75 });
    expect(query.content[0]?.text).toContain("75%/400k");
    expect(query.content[0]?.text).toContain("inactive");
    // On a 1M window the same 400k line is active and wins the min → 40%.
    const big = await tool.execute(
      "2",
      {},
      undefined,
      undefined,
      ctx({ getContextUsage: () => ({ percent: 30, contextWindow: 1_000_000, tokens: 1 }) }),
    );
    expect(big.details).toMatchObject({ ok: true, effectivePercent: 40 });
    expect(big.content[0]?.text).not.toContain("inactive");
  });

  it("reports the window-scaled force line when forceScaling is on", async () => {
    const current = { ...state(), forceScaling: true };
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    // 200k window: the 88 anchor scales to 91 (= the reserve cap there).
    const query = await tool.execute("1", {}, undefined, undefined, ctx());
    expect(query.details).toMatchObject({ ok: true, effectiveForcePercent: 91 });
    // A 1M window takes the anchor literally.
    const big = await tool.execute(
      "2",
      {},
      undefined,
      undefined,
      ctx({ getContextUsage: () => ({ percent: 30, contextWindow: 1_000_000, tokens: 1 }) }),
    );
    expect(big.details).toMatchObject({ ok: true, effectiveForcePercent: 88 });
    // With scaling off the same query stays literal on every window.
    const literal = { ...state(), forceScaling: false };
    const literalTool = createSetCompactThresholdTool({ getState: () => literal, compactToolEnabled: () => true });
    expect((await literalTool.execute("3", {}, undefined, undefined, ctx())).details).toMatchObject({
      ok: true,
      effectiveForcePercent: 88,
    });
  });
});

// ── compact-hint dynamic（dynamic-threshold-plan.md §10.5 · T-D3-TOOL）────────

describe("dynamic hint line in set_compact_threshold query (P1-11)", () => {
  const usableView = {
    mode: "on",
    usable: true,
    degradeReason: null,
    hintPercent: 41,
    basis: "cost",
    lowerBoundPercent: 35,
    capPercent: 60,
    cStarPercent: 16,
    g: 1200,
    sigma: 900,
    s0: 98_000,
    rUsd: 10,
    rEquivalentTurns: 96,
    priceReadPerM: 0.2,
    priceWritePerM: 5,
    priceOutputPerM: 20,
    writePricingApproximate: true,
    subscriptionPressure: null,
    telemetryCount: 12,
    telemetryPath: "~/.pi/agent/telemetry/compact-switch.jsonl",
  } as const;

  it("port absent ⇒ query text unchanged (byte-identical to today)", async () => {
    const current = state();
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    const without = await tool.execute("1", {}, undefined, undefined, ctx());
    const absent = createSetCompactThresholdTool({
      getState: () => current,
      compactToolEnabled: () => true,
      dynamic: { view: () => undefined },
    });
    const withUndefinedView = await absent.execute("2", {}, undefined, undefined, ctx());
    expect(withUndefinedView.content[0]?.text).toBe(without.content[0]?.text);
  });

  it("on + usable ⇒ query appends the dynamic line; set branch unchanged", async () => {
    const current = state();
    const tool = createSetCompactThresholdTool({
      getState: () => current,
      compactToolEnabled: () => true,
      dynamic: { view: () => usableView },
    });
    const query = await tool.execute("1", {}, undefined, undefined, ctx());
    const text = query.content[0]?.text ?? "";
    expect(text).toContain("Dynamic hint line: 41% (cost; C* 16%, g 1200 tokens/turn, R $10.00 uncalibrated)");
    expect(text).toContain("your configured 75% stays the upper bound.");
    // set 分支不变：不追加动态行，行为照旧
    const set = await tool.execute("2", { percent: 70 }, undefined, undefined, ctx());
    expect(set.content[0]?.text).not.toContain("Dynamic hint line");
    expect(current.thresholdPercent).toBe(70);
    expect(set.details).toMatchObject({ ok: true, action: "set", thresholdPercent: 70 });
  });

  it("shadow marks computed-but-not-applied; off adds no dynamic line", async () => {
    const shadowTool = createSetCompactThresholdTool({
      getState: () => state(),
      compactToolEnabled: () => true,
      dynamic: { view: () => ({ ...usableView, mode: "shadow" }) },
    });
    const shadow = await shadowTool.execute("1", {}, undefined, undefined, ctx());
    expect(shadow.content[0]?.text).toContain("[shadow: computed but NOT applied]");
    const offTool = createSetCompactThresholdTool({
      getState: () => state(),
      compactToolEnabled: () => true,
      dynamic: { view: () => ({ ...usableView, mode: "off" }) },
    });
    const off = await offTool.execute("2", {}, undefined, undefined, ctx());
    expect(off.content[0]?.text).not.toContain("Dynamic hint line");
  });

  it("degraded view ⇒ dynamic line reports inactive (reason → static line only)", async () => {
    const tool = createSetCompactThresholdTool({
      getState: () => state(),
      compactToolEnabled: () => true,
      dynamic: {
        view: () => ({ ...usableView, usable: false, degradeReason: "price-unknown", hintPercent: null, basis: null }),
      },
    });
    const query = await tool.execute("1", {}, undefined, undefined, ctx());
    expect(query.content[0]?.text).toContain("Dynamic hint line: inactive (price-unknown → static line only).");
  });
});
