/**
 * R1 · performance probe (plan R1 tests): 10,000 random inputs through evaluateGate + match,
 * p99 per-input latency. Target ≤ 1ms; the assertion allows ×5 (5ms) as CI tolerance for
 * loaded runners — the ×5 factor is the agreed slack, written here per the plan.
 */
import { describe, expect, it } from "vitest";
import { ANAPHORA_CJK, SHORT_REPLY_TABLE } from "../../../src/topic-switch/filters.js";
import { BUILTIN_SCRIPTS } from "../../../src/reflex/core/catalog.js";
import { IMPERATIVE_VETO, evaluateGate } from "../../../src/reflex/core/gate.js";
import { compileCatalog } from "../../../src/reflex/core/match.js";
import type { Capability, GateFacts } from "../../../src/reflex/core/types.js";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  "后",
  "台",
  "还",
  "有",
  "几",
  "个",
  "job",
  "agent",
  "额度",
  "剩",
  "多",
  "少",
  "git",
  "status",
  "工",
  "作",
  "区",
  "干",
  "净",
  "吗",
  "提交",
  "改",
  " ",
  "？",
  ",",
  "5h",
  "quota",
  "subagent",
  "分",
  "支",
];

const CAPS = new Set<Capability>(["bashJobs", "fleet", "quota", "git"]);
const MATCHER = compileCatalog(BUILTIN_SCRIPTS);
const NOISE = [...SHORT_REPLY_TABLE, ...ANAPHORA_CJK, ...IMPERATIVE_VETO];

function facts(text: string): GateFacts {
  return {
    source: "interactive",
    mode: "tui",
    streamingBehavior: undefined,
    idle: true,
    pendingMessages: false,
    imageCount: 0,
    text,
    topicSwitchActive: false,
    goalBusy: false,
    inFlight: false,
  };
}

function randomInput(rng: () => number, hitCorpus: readonly string[]): string {
  const words = Array.from({ length: 1 + Math.floor(rng() * 12) }, () => {
    const pick = rng();
    if (pick < 0.15) return NOISE[Math.floor(rng() * NOISE.length)]!;
    if (pick < 0.3) return hitCorpus[Math.floor(rng() * hitCorpus.length)]!;
    return ALPHABET[Math.floor(rng() * ALPHABET.length)]!;
  });
  return words.join(rng() < 0.2 ? "" : " ").slice(0, 200);
}

describe("S0+S1 latency (10k random inputs)", () => {
  it("p99 per-input evaluateGate+match ≤ 5ms (target 1ms, ×5 CI tolerance)", () => {
    const rng = mulberry32(0x5eed);
    const hitCorpus = BUILTIN_SCRIPTS.flatMap((s) => [...s.intent.examples.hit, ...s.intent.examples.miss]);
    const samples: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      const text = randomInput(rng, hitCorpus);
      const t0 = performance.now();
      const gate = evaluateGate(facts(text));
      if (gate.pass) MATCHER.match(gate.norm.norm, CAPS);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(0.99 * samples.length)]!;
    const p50 = samples[Math.floor(0.5 * samples.length)]!;
    // eslint-disable-next-line no-console
    console.log(
      `[reflex perf] n=10000 p50=${p50.toFixed(4)}ms p99=${p99.toFixed(4)}ms max=${samples[samples.length - 1]!.toFixed(4)}ms`,
    );
    expect(p99).toBeLessThanOrEqual(5);
  });
});
