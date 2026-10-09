import { describe, expect, it } from "vitest";
import { evaluateSyncGates } from "../../src/topic-switch/gate.js";
import { DEFAULT_TOPIC_SWITCH_SETTINGS, parseTopicSwitchSettings } from "../../src/topic-switch/settings.js";
import type { BranchView, GateFacts, InputSourceLike, WarmthView } from "../../src/topic-switch/types.js";

const PASS_BRANCH: BranchView = {
  hasAssistant: true,
  lastAssistantText: "总结完成，如需调整请告诉我。",
  lastTurnAskedUser: false,
  todoInProgress: false,
  recentUserTexts: ["读一下 README", "再概括一次"],
  lastCompactionSummary: undefined,
};

const COLD: WarmthView = { state: "cold", reason: "ttl-elapsed", nextWriteTtl: "5m" };
const BASE_COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }; // 200k prefix @5m ⇒ $0.75

/** 一切就绪、必过全门的 facts；每个字段可单独翻转。 */
function facts(overrides: Partial<GateFacts> = {}): GateFacts {
  return {
    hasUI: true,
    mode: "tui",
    streamingBehavior: undefined,
    idle: true,
    pendingMessages: false,
    compacting: false,
    draining: false,
    cooldownActive: false,
    activeRuns: 0,
    backgroundBash: 0,
    goalBusy: false,
    origin: "input",
    source: "interactive",
    text: "写一首关于秋天的七言绝句",
    imageCount: 0,
    branch: () => PASS_BRANCH,
    warmth: () => COLD,
    prefixTokens: () => 200_000,
    modelCost: () => BASE_COST,
    ...overrides,
  };
}

function expectSkip(f: GateFacts, reason: string): void {
  const verdict = evaluateSyncGates(f, DEFAULT_TOPIC_SWITCH_SETTINGS);
  expect(verdict).toEqual({ pass: false, reason });
}

describe("evaluateSyncGates · each gate fails alone", () => {
  it("1a disabled (settings)", () => {
    const s = parseTopicSwitchSettings({ enabled: false });
    expect(evaluateSyncGates(facts(), s)).toEqual({ pass: false, reason: "disabled" });
  });
  it("1a no-ui (hasUI false or mode outside tui/rpc)", () => {
    expectSkip(facts({ hasUI: false }), "no-ui");
    expectSkip(facts({ mode: "print" }), "no-ui");
    expectSkip(facts({ mode: "json" }), "no-ui");
  });
  it("1b busy-turn", () => {
    expectSkip(facts({ streamingBehavior: "steer" }), "busy-turn");
    expectSkip(facts({ streamingBehavior: "followUp" }), "busy-turn");
    expectSkip(facts({ idle: false }), "busy-turn");
    expectSkip(facts({ pendingMessages: true }), "busy-turn");
  });
  it("compacting / draining / cooldown", () => {
    expectSkip(facts({ compacting: true }), "compacting");
    expectSkip(facts({ draining: true }), "draining");
    expectSkip(facts({ cooldownActive: true }), "cooldown");
  });
  it("background / goal", () => {
    expectSkip(facts({ activeRuns: 1 }), "background");
    expectSkip(facts({ backgroundBash: 2 }), "background");
    expectSkip(facts({ goalBusy: true }), "goal");
  });
  it("2a source", () => {
    expectSkip(facts({ source: "extension" as InputSourceLike }), "source");
  });
  it("2b prefix / short / 2c continuation", () => {
    expectSkip(facts({ text: "/cmd run" }), "prefix");
    expectSkip(facts({ text: "!force" }), "prefix");
    expectSkip(facts({ text: "好的" }), "short");
    expectSkip(facts({ text: "这个方案再改一下然后继续看效果" }), "continuation");
  });
  it("branch gates: todo / first-turn / asked", () => {
    expectSkip(facts({ branch: () => ({ ...PASS_BRANCH, todoInProgress: true }) }), "todo");
    expectSkip(facts({ branch: () => ({ ...PASS_BRANCH, hasAssistant: false }) }), "first-turn");
    expectSkip(facts({ branch: () => ({ ...PASS_BRANCH, lastAssistantText: "要继续吗？" }) }), "asked");
    expectSkip(facts({ branch: () => ({ ...PASS_BRANCH, lastTurnAskedUser: true }) }), "asked");
  });
  it("3a warm / warmth-unknown", () => {
    expectSkip(facts({ warmth: () => ({ state: "warm", reason: "1h-cover" }) }), "warm");
    expectSkip(facts({ warmth: () => ({ state: "unknown", reason: "unsupported-api" }) }), "warmth-unknown");
  });
  it("3b no-usage / unpriced / cheap", () => {
    expectSkip(facts({ prefixTokens: () => null }), "no-usage");
    expectSkip(facts({ modelCost: () => ({}) }), "unpriced");
    expectSkip(facts({ prefixTokens: () => 1000 }), "cheap"); // ≈$0.0038 < $0.5
  });
});

describe("evaluateSyncGates · pass + ordering", () => {
  it("all gates pass ⇒ priced verdict carries estimate and warmth", () => {
    const verdict = evaluateSyncGates(facts(), DEFAULT_TOPIC_SWITCH_SETTINGS);
    expect(verdict.pass).toBe(true);
    if (!verdict.pass) return;
    expect(verdict.estimate.kind).toBe("priced");
    expect(verdict.estimate.usd).toBeGreaterThan(0.5);
    expect(verdict.warmth).toBe(COLD);
  });

  it("web origin: extension source passes gate 2a (claimed at dispatch point)", () => {
    const verdict = evaluateSyncGates(
      facts({ origin: "web", source: "extension" as InputSourceLike }),
      DEFAULT_TOPIC_SWITCH_SETTINGS,
    );
    expect(verdict.pass).toBe(true);
  });

  it("gate order: earlier gate wins when several would fail", () => {
    expectSkip(
      facts({
        compacting: true,
        activeRuns: 3,
        source: "extension" as InputSourceLike,
        warmth: () => ({ state: "warm", reason: "x" }),
      }),
      "compacting",
    );
    expectSkip(facts({ activeRuns: 3, text: "好的" }), "background");
    expectSkip(facts({ text: "好的", branch: () => ({ ...PASS_BRANCH, todoInProgress: true }) }), "short");
    expectSkip(
      facts({ warmth: () => ({ state: "unknown", reason: "x" }), prefixTokens: () => null }),
      "warmth-unknown",
    );
  });

  it("expensive thunks are lazy: branch()/warmth()/prefixTokens()/modelCost() untouched by early skips", () => {
    const counters = { branch: 0, warmth: 0, prefixTokens: 0, modelCost: 0 };
    const counting = (overrides: Partial<GateFacts> = {}): GateFacts =>
      facts({
        branch: () => {
          counters.branch += 1;
          return PASS_BRANCH;
        },
        warmth: () => {
          counters.warmth += 1;
          return COLD;
        },
        prefixTokens: () => {
          counters.prefixTokens += 1;
          return 200_000;
        },
        modelCost: () => {
          counters.modelCost += 1;
          return BASE_COST;
        },
        ...overrides,
      });
    // background 门在 branch() 之前 ⇒ 零次调用
    expect(evaluateSyncGates(counting({ activeRuns: 1 }), DEFAULT_TOPIC_SWITCH_SETTINGS)).toEqual({
      pass: false,
      reason: "background",
    });
    // short 门（2b）同样在 branch() 之前
    expect(evaluateSyncGates(counting({ text: "好的" }), DEFAULT_TOPIC_SWITCH_SETTINGS)).toEqual({
      pass: false,
      reason: "short",
    });
    expect(counters).toEqual({ branch: 0, warmth: 0, prefixTokens: 0, modelCost: 0 });
  });

  it("on a full pass every thunk runs exactly once", () => {
    const counters = { branch: 0, warmth: 0, prefixTokens: 0, modelCost: 0 };
    const verdict = evaluateSyncGates(
      facts({
        branch: () => {
          counters.branch += 1;
          return PASS_BRANCH;
        },
        warmth: () => {
          counters.warmth += 1;
          return COLD;
        },
        prefixTokens: () => {
          counters.prefixTokens += 1;
          return 200_000;
        },
        modelCost: () => {
          counters.modelCost += 1;
          return BASE_COST;
        },
      }),
      DEFAULT_TOPIC_SWITCH_SETTINGS,
    );
    expect(verdict.pass).toBe(true);
    expect(counters).toEqual({ branch: 1, warmth: 1, prefixTokens: 1, modelCost: 1 });
  });

  it("cold without nextWriteTtl defaults the estimate to 5m write pricing", () => {
    const f = facts({ warmth: () => ({ state: "cold", reason: "ttl-elapsed" }) }); // nextWriteTtl absent
    const verdict = evaluateSyncGates(f, DEFAULT_TOPIC_SWITCH_SETTINGS);
    expect(verdict.pass).toBe(true);
    if (!verdict.pass) return;
    const n = verdict.estimate.newTokens;
    expect(verdict.estimate.usd).toBeCloseTo((BASE_COST.cacheWrite * 200_000 + BASE_COST.input * n) / 1e6, 10);
  });

  it("any thunk throw ⇒ fact-error (fail-open, I6)", () => {
    expectSkip(
      facts({
        branch: () => {
          throw new Error("boom");
        },
      }),
      "fact-error",
    );
    expectSkip(
      facts({
        warmth: () => {
          throw new Error("boom");
        },
      }),
      "fact-error",
    );
    expectSkip(
      facts({
        prefixTokens: () => {
          throw new Error("boom");
        },
      }),
      "fact-error",
    );
    expectSkip(
      facts({
        modelCost: () => {
          throw new Error("boom");
        },
      }),
      "fact-error",
    );
  });

  it("threshold boundary: usd exactly equal to costThresholdUsd is cheap (strictly > required)", () => {
    // craft P so that usd lands exactly on 0.5: 3.75×P/1e6 = 0.5 ⇒ P = 133333.33… use input-only ttl "none":
    // usd = 3×(P+N)/1e6 = 0.5 ⇒ P+N = 166666.666… not integral; instead use costThresholdUsd equal to produced usd.
    const f = facts({
      prefixTokens: () => 200_000,
      warmth: () => ({ state: "cold", reason: "ttl-elapsed", nextWriteTtl: "none" }),
      modelCost: () => BASE_COST,
    });
    const n = Math.ceil(Buffer.byteLength("写一首关于秋天的七言绝句", "utf8") / 3);
    const s = parseTopicSwitchSettings({ costThresholdUsd: (BASE_COST.input * (200_000 + n)) / 1e6 });
    expect(evaluateSyncGates(f, s)).toEqual({ pass: false, reason: "cheap" });
    const s2 = parseTopicSwitchSettings({ costThresholdUsd: (BASE_COST.input * (200_000 + n)) / 1e6 - 0.000001 });
    expect(evaluateSyncGates(f, s2).pass).toBe(true);
  });
});
