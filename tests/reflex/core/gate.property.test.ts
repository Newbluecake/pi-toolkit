/**
 * R1 · seeded property test (plan R1 tests): ≥2,000 cases of "random hit sentence + random
 * veto word inserted at a random position" NEVER reach `high` through S0+S1 — the composite
 * zero-false-answer guarantee. Deterministic PRNG (mulberry32, fixed seed): a failure
 * reproduces byte-for-byte.
 */
import { describe, expect, it } from "vitest";
import { ANAPHORA_CJK, ANAPHORA_EN, SHORT_REPLY_TABLE } from "../../../src/topic-switch/filters.js";
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

const CAPS = new Set<Capability>(["bashJobs", "fleet", "quota", "git"]);
const MATCHER = compileCatalog(BUILTIN_SCRIPTS);
const HIT_SENTENCES = BUILTIN_SCRIPTS.flatMap((s) => [...s.intent.examples.hit]);
const SUBSTRING_VETO_WORDS = [...IMPERATIVE_VETO, ...ANAPHORA_CJK, "算了", "取消", "停下", "停止", "先不做", "不做了"];
const ALL_VETO_WORDS = [...SUBSTRING_VETO_WORDS, ...SHORT_REPLY_TABLE, ...ANAPHORA_EN];

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

function insertAt(text: string, at: number, word: string, sep: string): string {
  const head = Array.from(text).slice(0, at).join("");
  const tail = Array.from(text).slice(at).join("");
  return `${head}${sep}${word}${sep}${tail}`;
}

describe("seeded property: veto word ⊕ hit sentence never reaches high", () => {
  it("2,400 random insertions (composite S0+S1 never high)", () => {
    const rng = mulberry32(0xc0ffee);
    let highHits = 0;
    for (let i = 0; i < 2_400; i++) {
      const base = HIT_SENTENCES[Math.floor(rng() * HIT_SENTENCES.length)]!;
      const word = ALL_VETO_WORDS[Math.floor(rng() * ALL_VETO_WORDS.length)]!;
      const cpCount = Array.from(base).length;
      const at = Math.floor(rng() * (cpCount + 1));
      const sep = rng() < 0.3 ? " " : "";
      const text = insertAt(base, at, word, sep);
      const gate = evaluateGate(facts(text));
      if (gate.pass) {
        const match = MATCHER.match(gate.norm.norm, CAPS);
        if (match.kind === "hit" && match.band === "high") {
          highHits += 1;
          throw new Error(`property broken: "${text}" (base=${base} word=${word} at=${at}) reached high`);
        }
      }
    }
    expect(highHits).toBe(0);
  });

  it("500 prepended substring-veto words always veto at the gate (position 0 can never be negated)", () => {
    const rng = mulberry32(0xfeed);
    for (let i = 0; i < 500; i++) {
      const base = HIT_SENTENCES[Math.floor(rng() * HIT_SENTENCES.length)]!;
      const word = SUBSTRING_VETO_WORDS[Math.floor(rng() * SUBSTRING_VETO_WORDS.length)]!;
      // CJK words splice directly; EN words keep a word boundary after the splice.
      const text = /^[\x00-\x7f]+$/.test(word) ? `${word} ${base}` : `${word}${base}`;
      const gate = evaluateGate(facts(text));
      expect(gate.pass, `"${text}" should veto`).toBe(false);
    }
  });
});
