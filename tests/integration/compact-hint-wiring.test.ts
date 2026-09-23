import { describe, expect, it, vi } from "vitest";
import { createCompactHintHook, buildSessionStack, type CompactHintState, type Stack } from "../../src/stack.js";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSetCompactThresholdTool } from "../../src/tools/set-compact-threshold-tool.js";

function holder(state: CompactHintState) {
  return { current: { compactHint: state } as Stack };
}
function ctx(percent: number | null, mode = "interactive", hasUI = false, contextWindow = 200000, notify = vi.fn()) {
  return {
    mode,
    hasUI,
    getContextUsage: () => ({ percent, contextWindow, tokens: null }),
    ui: { notify },
  } as never;
}
function harness(initial: Partial<CompactHintState> = {}) {
  const state: CompactHintState = {
    thresholdPercent: 75,
    forceAtPercent: 88,
    thresholdTokens: 0,
    forceAtTokens: 0,
    reserveTokens: 16384,
    lastHintAt: 0,
    hintedAt: undefined,
    tickStepPercent: 0,
    lastTickStep: 0,
    ...initial,
  };
  const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
  let clock = 1;
  const hook = createCompactHintHook(
    { current: { compactHint: state } as Stack },
    {
      sendMessage: (message, options) => sent.push({ message, options }),
      now: () => clock,
    },
  );
  return {
    state,
    sent,
    hook,
    setNow: (value: number) => {
      clock = value;
    },
  };
}
function fakePi() {
  const sent: unknown[] = [];
  return {
    sent,
    pi: {
      sendMessage: (message: unknown) => sent.push(message),
      appendEntry: () => undefined,
      events: { emit: () => undefined, on: () => () => undefined },
      exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    } as unknown as ExtensionAPI,
  };
}
function stackContext(cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: { getEntries: () => [], getSessionId: () => "compact-test", getBranch: () => [] },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: { notify: vi.fn() },
    hasUI: false,
    mode: "interactive",
  } as unknown as ExtensionContext;
}
const emptyTypes = { get: () => undefined, list: () => [], reload: async () => ({ types: [], errors: [] }) } as never;

describe("compact hint turn_end wiring", () => {
  it("sends once at the boundary and clears after falling below", () => {
    const state: CompactHintState = {
      thresholdPercent: 75,
      forceAtPercent: 88,
      thresholdTokens: 0,
      forceAtTokens: 0,
      reserveTokens: 16384,
      lastHintAt: 0,
      hintedAt: undefined,
      tickStepPercent: 0,
      lastTickStep: 0,
    };
    const sent: unknown[] = [];
    let clock = 1;
    const hook = createCompactHintHook(holder(state), {
      sendMessage: (message) => sent.push(message),
      now: () => clock,
    });
    hook({}, ctx(75));
    hook({}, ctx(80));
    expect(sent).toHaveLength(1);
    hook({}, ctx(74));
    clock = 600_002;
    hook({}, ctx(80));
    expect(sent).toHaveLength(2);
  });
  it("does not send below threshold and exposes the exact message contract", () => {
    const h = harness();
    h.hook({}, ctx(40));
    expect(h.sent).toHaveLength(0);
    h.hook({}, ctx(75));
    expect(h.sent[0]).toMatchObject({
      message: { customType: "subagent:compact-hint", display: true, details: { thresholdPercent: 75 } },
      options: { triggerTurn: false },
    });
  });
  it("suppresses within cooldown and sends after the window", () => {
    const h = harness();
    h.hook({}, ctx(80));
    h.hook({}, ctx(74));
    h.setNow(599_999);
    h.hook({}, ctx(80));
    expect(h.sent).toHaveLength(1);
    h.setNow(600_001);
    h.hook({}, ctx(80));
    expect(h.sent).toHaveLength(2);
  });
  it("resets on zero, threshold changes, and the 82 -> 75 sequence", () => {
    const h = harness();
    h.hook({}, ctx(80));
    h.state.thresholdPercent = 0;
    h.state.hintedAt = undefined;
    h.state.lastHintAt = 0;
    h.setNow(600_001);
    h.state.thresholdPercent = 75;
    h.hook({}, ctx(80));
    expect(h.sent).toHaveLength(2);
    h.state.thresholdPercent = 82;
    h.state.hintedAt = undefined;
    h.state.lastHintAt = 0;
    h.hook({}, ctx(80));
    expect(h.sent).toHaveLength(2);
    h.hook({}, ctx(80));
    expect(h.sent).toHaveLength(2);
    h.state.thresholdPercent = 75;
    h.state.hintedAt = undefined;
    h.state.lastHintAt = 0;
    h.hook({}, ctx(80));
    expect(h.sent).toHaveLength(3);
  });
  it("handles window switching and effective-zero windows", () => {
    const h = harness({ forceAtPercent: 0 });
    h.hook({}, ctx(75, "interactive", false, 200000));
    h.setNow(600_001);
    h.hook({}, ctx(76, "interactive", false, 64000));
    expect(h.sent).toHaveLength(2);
    h.hook({}, ctx(76, "interactive", false, 64000));
    expect(h.sent).toHaveLength(2);
    h.hook({}, ctx(80, "interactive", false, 8000));
    expect(h.state.hintedAt).toBeUndefined();
    h.setNow(1_200_001);
    h.hook({}, ctx(80, "interactive", false, 200000));
    expect(h.sent).toHaveLength(3);
  });
  it("clears a placed latch on unknown usage and retries after send failure", () => {
    const h = harness();
    h.hook({}, ctx(80));
    expect(h.state.hintedAt).toBeDefined();
    h.hook({}, ctx(null));
    expect(h.state.hintedAt).toBeUndefined();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failed = harness();
    let fail = true;
    const retryHook = createCompactHintHook(
      { current: { compactHint: failed.state } as Stack },
      {
        sendMessage: () => {
          if (fail) throw new Error("offline");
        },
        now: () => 1,
      },
    );
    retryHook({}, ctx(80));
    expect(failed.state.hintedAt).toBeUndefined();
    expect(failed.state.lastHintAt).toBe(0);
    expect(warn).toHaveBeenCalled();
    fail = false;
    retryHook({}, ctx(80));
    expect(failed.state.hintedAt).toEqual({ effectivePercent: 75, contextWindow: 200000 });
    warn.mockRestore();
  });
  it("swallows notify errors after state is successfully placed", () => {
    const h = harness();
    const notify = vi.fn(() => {
      throw new Error("toast unavailable");
    });
    expect(() => h.hook({}, ctx(80, "interactive", true, 200000, notify))).not.toThrow();
    expect(h.state.hintedAt).toEqual({ effectivePercent: 75, contextWindow: 200000 });
    expect(h.state.lastHintAt).toBe(1);
  });
  it("respects mode, null usage, dynamic windows, and failed sends", () => {
    const state: CompactHintState = {
      thresholdPercent: 75,
      forceAtPercent: 88,
      thresholdTokens: 0,
      forceAtTokens: 0,
      reserveTokens: 16384,
      lastHintAt: 0,
      hintedAt: undefined,
      tickStepPercent: 0,
      lastTickStep: 0,
    };
    const sendMessage = vi.fn(() => {
      throw new Error("offline");
    });
    const hook = createCompactHintHook(holder(state), { sendMessage, now: () => 100 });
    hook({}, ctx(80, "json"));
    hook({}, ctx(null));
    expect(sendMessage).not.toHaveBeenCalled();
    hook({}, ctx(80));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(state.hintedAt).toBeUndefined();
  });
  it("rebuilds the real stack and retargets the threshold tool", async () => {
    const cwd = "/tmp/pi-subagent-compact-test";
    const host = fakePi();
    const settings: AgentSettings = {
      ...DEFAULT_SETTINGS,
      fleetWidget: false,
      bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
      compact: {
        enabled: true,
        hintThresholdPercent: 75,
        hintThresholdTokens: 0,
        forceAtTokens: 0,
        assumedReserveTokens: 16384,
      },
    };
    const holder: { current?: Stack } = {};
    const first = buildSessionStack(host.pi, stackContext(cwd), settings, emptyTypes, []);
    holder.current = first;
    expect(first.compactHint.thresholdPercent).toBe(75);
    expect(first.compactHint.reserveTokens).toBe(16384);
    const tool = createSetCompactThresholdTool({
      getState: () => holder.current?.compactHint,
      compactToolEnabled: () => true,
    });
    await tool.execute("1", { percent: 60 }, undefined, undefined, ctx(80));
    expect(first.compactHint.thresholdPercent).toBe(60);
    first.scheduler.stop();
    first.rpc.close();
    settings.compact = {
      enabled: true,
      hintThresholdPercent: 75,
      hintThresholdTokens: 0,
      forceAtTokens: 0,
      assumedReserveTokens: 32768,
    };
    const second = buildSessionStack(host.pi, stackContext(cwd), settings, emptyTypes, []);
    holder.current = second;
    expect(second.compactHint.thresholdPercent).toBe(75);
    expect(second.compactHint.reserveTokens).toBe(32768);
    await tool.execute("2", { percent: 50 }, undefined, undefined, ctx(80));
    expect(second.compactHint.thresholdPercent).toBe(50);
    expect(first.compactHint.thresholdPercent).toBe(60);
    second.scheduler.stop();
    second.rpc.close();
  });
  it("disabled compact settings start with a closed threshold", () => {
    const settings: AgentSettings = {
      ...DEFAULT_SETTINGS,
      fleetWidget: false,
      bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
      compact: {
        enabled: false,
        hintThresholdPercent: 75,
        hintThresholdTokens: 400,
        forceAtTokens: 0,
        assumedReserveTokens: 16384,
      },
    };
    const stack = buildSessionStack(
      fakePi().pi,
      stackContext("/tmp/pi-subagent-compact-off"),
      settings,
      emptyTypes,
      [],
    );
    expect(stack.compactHint.thresholdPercent).toBe(0);
    expect(stack.compactHint.thresholdTokens).toBe(0);
    stack.scheduler.stop();
    stack.rpc.close();
  });
  it("keeps the L1 latch independent from L2 force and rearms after fallback", () => {
    const state: CompactHintState = {
      thresholdPercent: 75,
      forceAtPercent: 88,
      thresholdTokens: 0,
      forceAtTokens: 0,
      reserveTokens: 16384,
      lastHintAt: 0,
      hintedAt: undefined,
      tickStepPercent: 0,
      lastTickStep: 0,
    };
    const sent: unknown[] = [];
    const compact = vi.fn((options: { onComplete: () => void }) => options.onComplete());
    const resume = vi.fn();
    let clock = 1;
    const hook = createCompactHintHook(holder(state), {
      sendMessage: (message) => sent.push(message),
      sendUserMessage: resume,
      now: () => clock,
    });
    hook({}, { ...ctx(75), compact } as never);
    expect(sent).toHaveLength(1);
    hook({}, { ...ctx(88), compact } as never);
    expect(compact).toHaveBeenCalledOnce();
    hook({}, ctx(74));
    clock = 600_001;
    hook({}, ctx(75));
    // L1 hint + L2 force notice + re-armed L1 hint.
    expect(sent).toHaveLength(3);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("keeps 87% below force, disables force at zero, and clamps force to the window cap", () => {
    const compact = vi.fn((options: { onComplete: () => void }) => options.onComplete());
    const make = (forceAtPercent: number) => {
      const state: CompactHintState = {
        thresholdPercent: 75,
        forceAtPercent,
        thresholdTokens: 0,
        forceAtTokens: 0,
        reserveTokens: 16384,
        lastHintAt: 0,
        hintedAt: undefined,
        tickStepPercent: 0,
        lastTickStep: 0,
      };
      const hook = createCompactHintHook(
        { current: { compactHint: state } as Stack },
        { sendMessage: () => undefined, now: () => 1 },
      );
      return { state, hook };
    };
    const below = make(88);
    below.hook({}, { ...ctx(87), compact } as never);
    expect(compact).not.toHaveBeenCalled();
    const disabled = make(0);
    disabled.hook({}, { ...ctx(95), compact } as never);
    expect(compact).not.toHaveBeenCalled();
    const clamped = make(88);
    clamped.hook({}, { ...ctx(75, "interactive", false, 64000), compact } as never);
    expect(compact).toHaveBeenCalledOnce();
  });

  it("forces at 88%, resumes, and suppresses repeats during cooldown", () => {
    const state: CompactHintState = {
      thresholdPercent: 75,
      forceAtPercent: 88,
      thresholdTokens: 0,
      forceAtTokens: 0,
      reserveTokens: 16384,
      lastHintAt: 0,
      hintedAt: undefined,
      tickStepPercent: 0,
      lastTickStep: 0,
    };
    const compact = vi.fn((options: { onComplete: () => void }) => options.onComplete());
    const resume = vi.fn();
    const forceContext = { ...ctx(88, "interactive", true), compact } as never;
    const sent: unknown[] = [];
    const hook = createCompactHintHook(
      { current: { compactHint: state } as Stack },
      {
        sendMessage: (message) => sent.push(message),
        sendUserMessage: resume,
        now: () => 1,
      },
    );
    hook({}, forceContext);
    expect(compact).toHaveBeenCalledOnce();
    expect(sent[0]).toMatchObject({
      customType: "subagent:compact-hint",
      display: true,
      details: { thresholdPercent: 88, forced: true },
    });
    expect(resume).toHaveBeenCalledWith(expect.stringContaining("Context compaction completed successfully"));
    hook({}, forceContext);
    expect(compact).toHaveBeenCalledOnce();
  });

  it("does not toast when UI is unavailable and swallows toast errors", () => {
    const state: CompactHintState = {
      thresholdPercent: 75,
      forceAtPercent: 88,
      thresholdTokens: 0,
      forceAtTokens: 0,
      reserveTokens: 16384,
      lastHintAt: 0,
      hintedAt: undefined,
      tickStepPercent: 0,
      lastTickStep: 0,
    };
    const hook = createCompactHintHook(holder(state), { sendMessage: () => undefined, now: () => 0 });
    expect(() => hook({}, ctx(80, "interactive", false))).not.toThrow();
    expect(state.hintedAt).toEqual({ effectivePercent: 75, contextWindow: 200000 });
  });

  it("reports usage ticks at each 10% step from 10% with the exact message contract", () => {
    const h = harness({ tickStepPercent: 10 });
    h.hook({}, ctx(5));
    expect(h.sent).toHaveLength(0); // below the first step
    h.hook({}, ctx(12));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      message: { customType: "subagent:usage-tick", display: true, details: { tickStep: 10 } },
      options: { triggerTurn: false },
    });
    expect((h.sent[0]?.message.content as string) ?? "").toContain("无需操作");
    h.hook({}, ctx(18)); // same step, latched
    expect(h.sent).toHaveLength(1);
    h.hook({}, ctx(21));
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.message.details).toMatchObject({ tickStep: 20 });
  });

  it("does not re-notify on boundary wobble but re-arms after a real drop", () => {
    const h = harness({ tickStepPercent: 10 });
    h.hook({}, ctx(61));
    expect(h.sent).toHaveLength(1);
    h.hook({}, ctx(59.9)); // wobble below the step, within hysteresis
    h.hook({}, ctx(60.4));
    expect(h.sent).toHaveLength(1);
    h.hook({}, ctx(25)); // compaction-scale drop re-arms the latch
    expect(h.state.lastTickStep).toBe(20); // re-armed to the current step (no floor)
    h.hook({}, ctx(31));
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.message.details).toMatchObject({ tickStep: 30 });
  });

  it("keeps ticking in the L1 hint zone so usage stays visible up to the force ceiling", () => {
    const h = harness({ tickStepPercent: 10 });
    h.hook({}, ctx(70));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message.customType).toBe("subagent:usage-tick");
    h.hook({}, ctx(75));
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.message.customType).toBe("subagent:compact-hint"); // L1, not a tick
    // The L1 hint fires only once; ticks keep reporting each new step in the
    // hint zone (up to the 88% force ceiling) with the over-threshold wording.
    h.hook({}, ctx(80));
    expect(h.sent).toHaveLength(3);
    expect(h.sent[2]?.message.customType).toBe("subagent:usage-tick");
    expect(h.sent[2]?.message.details).toMatchObject({ tickStep: 80 });
    expect((h.sent[2]?.message.content as string) ?? "").toContain("已超过提醒阈值 75%");
  });

  it("keeps ticking when the hint threshold is disabled and stops at the force ceiling", () => {
    const h = harness({ tickStepPercent: 10, thresholdPercent: 0, forceAtPercent: 50 });
    const compact = vi.fn();
    const withCompact = (percent: number) => ({ ...ctx(percent), compact }) as never;
    h.hook({}, withCompact(31));
    expect(h.sent).toHaveLength(1);
    h.hook({}, withCompact(45)); // 40 < ceiling(50): tick still fires without an L1 threshold
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.message.customType).toBe("subagent:usage-tick");
    h.hook({}, withCompact(51)); // at the force ceiling: L2 owns this zone
    expect(compact).toHaveBeenCalledOnce();
    // L2 force now also emits a visible notice message.
    expect(h.sent).toHaveLength(3);
  });

  it("does not tick when tickStepPercent is 0", () => {
    const h = harness({ tickStepPercent: 0 });
    h.hook({}, ctx(30));
    h.hook({}, ctx(50));
    h.hook({}, ctx(70));
    expect(h.sent).toHaveLength(0);
  });

  it("scales the force line with the window and densifies ticks near it", () => {
    const h = harness({ thresholdPercent: 0, forceAtPercent: 88, forceScaling: true, tickStepPercent: 10 });
    const compact = vi.fn((options: { onComplete: () => void }) => options.onComplete());
    const withCompact = (percent: number, window = 200_000) =>
      ({ ...ctx(percent, "interactive", false, window), compact }) as never;
    // 200k window: the 88 anchor scales up to 91 — right at pi's own reserve
    // line — so 88 alone no longer forces.
    h.hook({}, withCompact(88));
    expect(compact).not.toHaveBeenCalled();
    // Densified grid below the 91 ceiling: 87 fires, then 89 (step/2 band).
    expect(h.sent[0]?.message.details).toMatchObject({ tickStep: 87 });
    h.hook({}, withCompact(90));
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.message.details).toMatchObject({ tickStep: 89 });
    h.hook({}, withCompact(91)); // at the scaled line: L2 owns this zone
    expect(compact).toHaveBeenCalledOnce();
    h.setNow(1_000_001);
    // 37k window: the anchor asks for 95, but the reserve cap clamps the
    // effective line to 55 — it never crosses pi's automatic compaction line.
    h.hook({}, withCompact(54, 37_000));
    expect(compact).toHaveBeenCalledOnce(); // still once (below the clamped line)
    h.hook({}, withCompact(55, 37_000));
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it("fires the default 400k absolute line early on a 1M window (min semantics)", () => {
    const h = harness({ thresholdTokens: 400 });
    h.hook({}, ctx(39, "interactive", false, 1_000_000));
    expect(h.sent).toHaveLength(0);
    h.hook({}, ctx(40, "interactive", false, 1_000_000));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      message: { customType: "subagent:compact-hint", details: { thresholdPercent: 40 } },
    });
  });

  it("auto-disables a 400k absolute line above the window, keeping percent-only behavior", () => {
    const h = harness({ thresholdTokens: 400 });
    h.hook({}, ctx(74, "interactive", false, 256_000));
    expect(h.sent).toHaveLength(0);
    h.hook({}, ctx(75, "interactive", false, 256_000));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      message: { customType: "subagent:compact-hint", details: { thresholdPercent: 75 } },
    });
    // Same for the force line: 400k > 256k window → force stays percent-only.
    const compact = vi.fn();
    const f = harness({ thresholdPercent: 0, thresholdTokens: 0, forceAtPercent: 0, forceAtTokens: 400 });
    f.hook({}, { ...ctx(95, "interactive", false, 256_000), compact } as never);
    expect(compact).not.toHaveBeenCalled();
  });

  it("threads the settings absolute lines into the session stack", () => {
    const settings: AgentSettings = {
      ...DEFAULT_SETTINGS,
      fleetWidget: false,
      bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
    };
    const stack = buildSessionStack(
      fakePi().pi,
      stackContext("/tmp/pi-subagent-compact-tokens"),
      settings,
      emptyTypes,
      [],
    );
    expect(stack.compactHint.thresholdTokens).toBe(500);
    expect(stack.compactHint.forceAtTokens).toBe(0);
    expect(stack.compactHint.forceScaling).toBe(true); // default on
    stack.scheduler.stop();
    stack.rpc.close();
    const literal = buildSessionStack(
      fakePi().pi,
      stackContext("/tmp/pi-subagent-compact-literal"),
      { ...settings, compact: { ...DEFAULT_SETTINGS.compact, forceScaling: false } },
      emptyTypes,
      [],
    );
    expect(literal.compactHint.forceScaling).toBe(false);
    literal.scheduler.stop();
    literal.rpc.close();
  });

  // ── switch_context 模式（context-switch plan §3）：L2 先礼后兵 ──────────────
  describe("switch_context mode (L2 demand before generic force)", () => {
    function switchState(overrides: Partial<CompactHintState> = {}): CompactHintState {
      return {
        thresholdPercent: 75,
        forceAtPercent: 88,
        thresholdTokens: 0,
        forceAtTokens: 0,
        reserveTokens: 16384,
        lastHintAt: 0,
        hintedAt: undefined,
        tickStepPercent: 0,
        lastTickStep: 0,
        switchTool: true,
        forceDemandTurns: 1,
        demandCount: 0,
        ...overrides,
      };
    }

    it("demands a switch first and only forces a generic compaction if the model ignores it", () => {
      const state = switchState();
      const compact = vi.fn((options: { onComplete: () => void }) => options.onComplete());
      const sent: Array<Record<string, unknown>> = [];
      const hook = createCompactHintHook(holder(state), {
        sendMessage: (message) => sent.push(message as Record<string, unknown>),
        now: () => 1,
      });
      const forceCtx = { ...ctx(90, "interactive", true), compact } as never;
      hook({}, forceCtx);
      expect(compact).not.toHaveBeenCalled();
      expect(state.demandCount).toBe(1);
      expect(sent[0]).toMatchObject({ details: { demand: true, attempt: 1 } });
      expect(String(sent[0]?.content)).toContain("switch_context");
      // 模型没照办 ⇒ 下一轮回落到通用强制压缩。
      hook({}, forceCtx);
      expect(compact).toHaveBeenCalledOnce();
      expect(sent[1]).toMatchObject({ details: { forced: true } });
      expect(state.demandCount).toBe(0);
    });

    it("never demands while a handoff is in flight, and never force-compacts over it", () => {
      const state = switchState();
      const compact = vi.fn();
      const sent: unknown[] = [];
      const hook = createCompactHintHook(holder(state), {
        sendMessage: (message) => sent.push(message),
        now: () => 1,
        handoffPending: () => true,
      });
      hook({}, { ...ctx(95), compact } as never);
      hook({}, { ...ctx(95), compact } as never);
      expect(compact).not.toHaveBeenCalled();
      expect(sent).toHaveLength(0);
      expect(state.demandCount).toBe(0);
    });

    it("re-arms the demand after usage falls back below the force line", () => {
      const state = switchState();
      const compact = vi.fn();
      const sent: unknown[] = [];
      const hook = createCompactHintHook(holder(state), {
        sendMessage: (message) => sent.push(message),
        now: () => 1,
      });
      hook({}, { ...ctx(90), compact } as never);
      expect(state.demandCount).toBe(1);
      hook({}, ctx(40));
      expect(state.demandCount).toBe(0);
      hook({}, { ...ctx(90), compact } as never);
      expect(state.demandCount).toBe(1);
      expect(compact).not.toHaveBeenCalled();
    });

    it("forceDemandTurns=0 keeps the legacy behaviour (force immediately)", () => {
      const state = switchState({ forceDemandTurns: 0 });
      const compact = vi.fn((options: { onComplete: () => void }) => options.onComplete());
      const hook = createCompactHintHook(holder(state), { sendMessage: () => undefined, now: () => 1 });
      hook({}, { ...ctx(90), compact } as never);
      expect(compact).toHaveBeenCalledOnce();
    });

    it("routes the L1 hint and usage ticks to switch_context", () => {
      const state = switchState({ tickStepPercent: 10 });
      const sent: Array<{ content?: unknown }> = [];
      const hook = createCompactHintHook(holder(state), {
        sendMessage: (message) => sent.push(message as { content?: unknown }),
        now: () => 1,
      });
      hook({}, ctx(42));
      hook({}, ctx(80));
      expect(String(sent[0]?.content)).toContain("switch_context");
      expect(String(sent[1]?.content)).toContain("switch_context");
      expect(String(sent[1]?.content)).not.toContain("compact_context");
    });

    it("buildSessionStack maps the settings block onto the state", () => {
      const base: AgentSettings = {
        ...DEFAULT_SETTINGS,
        fleetWidget: false,
        bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
      };
      const stack = buildSessionStack(
        fakePi().pi,
        stackContext("/tmp/pi-subagent-switch-mode"),
        { ...base, compact: { ...DEFAULT_SETTINGS.compact, forceDemandTurns: 2 } },
        emptyTypes,
        [],
      );
      expect(stack.compactHint.switchTool).toBe(true);
      expect(stack.compactHint.forceDemandTurns).toBe(2);
      expect(stack.compactHint.demandCount).toBe(0);
      stack.scheduler.stop();
      stack.rpc.close();
      const off = buildSessionStack(
        fakePi().pi,
        stackContext("/tmp/pi-subagent-switch-off"),
        { ...base, compact: { ...DEFAULT_SETTINGS.compact, switchTool: false } },
        emptyTypes,
        [],
      );
      expect(off.compactHint.switchTool).toBe(false);
      off.scheduler.stop();
      off.rpc.close();
    });
  });
});
