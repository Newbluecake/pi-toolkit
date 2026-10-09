import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOPIC_SWITCH_SETTINGS,
  parseTopicSwitchSettings,
  type TopicSwitchSettings,
} from "../../src/topic-switch/settings.js";

/** 输入是 normalizeTimeUnits 之后的 ms 形态（*S 文件键的转换属于 config/settings.ts）。 */
describe("DEFAULT_TOPIC_SWITCH_SETTINGS", () => {
  it("matches plan.md defaults and is frozen", () => {
    expect(DEFAULT_TOPIC_SWITCH_SETTINGS).toEqual({
      enabled: true,
      costThresholdUsd: 0.5,
      model: "",
      judgeTimeoutMs: 6_000,
      minConfidence: 0.7,
      confirmTimeoutMs: 30_000,
      minChars: 8,
      regrowTokens: 100_000,
      expirySlackMs: 30_000,
      debugAssumedTtlMs: 0,
    } satisfies TopicSwitchSettings);
    expect(Object.isFrozen(DEFAULT_TOPIC_SWITCH_SETTINGS)).toBe(true);
  });
});

describe("parseTopicSwitchSettings", () => {
  it("non-object input returns a fresh copy of defaults (never throws)", () => {
    for (const input of [undefined, null, 42, "x", [], true]) {
      expect(parseTopicSwitchSettings(input)).toEqual({ ...DEFAULT_TOPIC_SWITCH_SETTINGS });
    }
  });

  it("empty object falls back to defaults field-by-field", () => {
    expect(parseTopicSwitchSettings({})).toEqual({ ...DEFAULT_TOPIC_SWITCH_SETTINGS });
  });

  it("accepts every in-domain value verbatim", () => {
    const parsed = parseTopicSwitchSettings({
      enabled: false,
      costThresholdUsd: 3.25,
      model: " moonshot/kimi-k3 ",
      judgeTimeoutMs: 12_000,
      minConfidence: 0,
      confirmTimeoutMs: 300_000,
      minChars: 0,
      regrowTokens: 0,
      expirySlackMs: 0,
      debugAssumedTtlMs: 20_000,
    });
    expect(parsed).toEqual({
      enabled: false,
      costThresholdUsd: 3.25,
      model: "moonshot/kimi-k3",
      judgeTimeoutMs: 12_000,
      minConfidence: 0,
      confirmTimeoutMs: 300_000,
      minChars: 0,
      regrowTokens: 0,
      expirySlackMs: 0,
      debugAssumedTtlMs: 20_000,
    });
  });

  it("out-of-domain and wrong-typed fields fall back per-field", () => {
    const parsed = parseTopicSwitchSettings({
      enabled: "yes", // → true
      costThresholdUsd: 0, // 0 < x ⇒ invalid → 0.5
      model: 7, // → ""
      judgeTimeoutMs: 999, // below 1s → 6000
      minConfidence: 1.2, // → 0.7
      confirmTimeoutMs: 4_999, // below 5s → 30000
      minChars: 201, // → 8
      regrowTokens: -1, // → 100000
      expirySlackMs: 600_001, // → 30000
      debugAssumedTtlMs: 5_000, // 1–9.999s band invalid → 0
    });
    expect(parsed).toEqual({ ...DEFAULT_TOPIC_SWITCH_SETTINGS });
  });

  it("domain boundaries are inclusive", () => {
    const parsed = parseTopicSwitchSettings({
      costThresholdUsd: 100,
      judgeTimeoutMs: 1_000,
      minConfidence: 1,
      confirmTimeoutMs: 5_000,
      minChars: 200,
      regrowTokens: Number.MAX_SAFE_INTEGER,
      expirySlackMs: 600_000,
      debugAssumedTtlMs: 3_600_000,
    });
    expect(parsed.costThresholdUsd).toBe(100);
    expect(parsed.judgeTimeoutMs).toBe(1_000);
    expect(parsed.minConfidence).toBe(1);
    expect(parsed.confirmTimeoutMs).toBe(5_000);
    expect(parsed.minChars).toBe(200);
    expect(parsed.regrowTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(parsed.expirySlackMs).toBe(600_000);
    expect(parsed.debugAssumedTtlMs).toBe(3_600_000);
  });

  it("just-outside boundaries fall back", () => {
    const parsed = parseTopicSwitchSettings({
      costThresholdUsd: 100.01,
      judgeTimeoutMs: 30_001,
      minConfidence: -0.001,
      confirmTimeoutMs: 300_001,
      minChars: -1,
      expirySlackMs: -1,
      debugAssumedTtlMs: 3_600_001,
    });
    expect(parsed.costThresholdUsd).toBe(0.5);
    expect(parsed.judgeTimeoutMs).toBe(6_000);
    expect(parsed.minConfidence).toBe(0.7);
    expect(parsed.confirmTimeoutMs).toBe(30_000);
    expect(parsed.minChars).toBe(8);
    expect(parsed.expirySlackMs).toBe(30_000);
    expect(parsed.debugAssumedTtlMs).toBe(0);
  });

  it("non-integer minChars / regrowTokens and NaN fall back", () => {
    const parsed = parseTopicSwitchSettings({
      minChars: 8.5,
      regrowTokens: 1e3 + 0.5,
      minConfidence: Number.NaN,
      judgeTimeoutMs: Number.POSITIVE_INFINITY,
      costThresholdUsd: Number.NaN,
    });
    expect(parsed.minChars).toBe(8);
    expect(parsed.regrowTokens).toBe(100_000);
    expect(parsed.minConfidence).toBe(0.7);
    expect(parsed.judgeTimeoutMs).toBe(6_000);
    expect(parsed.costThresholdUsd).toBe(0.5);
  });

  it("debugAssumedTtlMs: 0 is valid, 10s is the lower non-zero bound", () => {
    expect(parseTopicSwitchSettings({ debugAssumedTtlMs: 0 }).debugAssumedTtlMs).toBe(0);
    expect(parseTopicSwitchSettings({ debugAssumedTtlMs: 10_000 }).debugAssumedTtlMs).toBe(10_000);
    expect(parseTopicSwitchSettings({ debugAssumedTtlMs: 9_999 }).debugAssumedTtlMs).toBe(0);
  });

  it("model: empty string is a legal sentinel; non-strings fall back", () => {
    expect(parseTopicSwitchSettings({ model: "" }).model).toBe("");
    expect(parseTopicSwitchSettings({ model: null }).model).toBe("");
    expect(parseTopicSwitchSettings({ model: {} }).model).toBe("");
  });

  it("unknown keys are ignored (forward compatibility)", () => {
    const parsed = parseTopicSwitchSettings({ enabled: false, futureKey: "x" });
    expect(parsed.enabled).toBe(false);
    expect("futureKey" in parsed).toBe(false);
  });
});
