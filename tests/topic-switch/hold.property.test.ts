import { describe, expect, it } from "vitest";
import { COOLDOWN_OUTCOMES, initialHoldState, isCooldownOutcome, stepHold } from "../../src/topic-switch/state.js";
import type { HoldEffect, HoldEvent, HoldPhase, HoldState } from "../../src/topic-switch/state.js";
import type { JudgeVerdictLike } from "../../src/topic-switch/types.js";

/** mulberry32 — 确定性 PRNG（固定种子 ⇒ 可复现）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JUDGE_VERDICTS: JudgeVerdictLike[] = [
  { kind: "ok", related: false, confidence: 0.95 },
  { kind: "ok", related: false, confidence: 0.3 },
  { kind: "ok", related: true, confidence: 0.95 },
  { kind: "timeout" },
  { kind: "error" },
  { kind: "parse-error" },
  { kind: "no-model" },
  { kind: "aborted" },
];

const CONFIRM_OUTCOMES = ["switch", "stay", "timeout", "cancel", "unavailable", "error", "aborted"] as const;

/** 随机事件池（含大量「迟到/错序」组合——性质必须对它们免疫）。 */
function randomEvent(rand: () => number): HoldEvent {
  const pick = <T>(items: readonly T[]): T => {
    const idx = Math.floor(rand() * items.length);
    const chosen = items[Math.min(idx, items.length - 1)];
    return chosen as T;
  };
  switch (Math.floor(rand() * 11)) {
    case 0:
      return { t: "judged", v: pick(JUDGE_VERDICTS) };
    case 1:
      return { t: "confirmed", o: { kind: pick(CONFIRM_OUTCOMES) } };
    case 2:
      return { t: "newcomer" };
    case 3:
      return { t: "hop-timeout" };
    case 4:
      return { t: "ponr" };
    case 5:
      return { t: "preflight-failed" };
    case 6:
      return { t: "switch-entered" };
    case 7:
      return { t: "switch-cancelled" };
    case 8:
      return { t: "abort", why: "watchdog" };
    case 9:
      return { t: "abort", why: "shutdown", reason: pick(["quit", "reload", "new", "resume", "fork"] as const) };
    default:
      return { t: "released" };
  }
}

/** held 的「投递决定」：当前会话（release）/ 新会话（switch-entered 完成）/ 可恢复手动（pre-releasing persist-pending）。 */
interface Decision {
  kind: "current" | "new-session" | "recoverable-manual";
  step: number;
}

function decisionOfStep(phaseBefore: HoldPhase, ev: HoldEvent, fxNow: readonly HoldEffect[]): Decision | undefined {
  if (fxNow.some((f) => f.e === "release")) return { kind: "current", step: -1 };
  if (phaseBefore === "switching" && ev.t === "switch-entered") return { kind: "new-session", step: -1 };
  if (fxNow.some((f) => f.e === "persist-pending") && phaseBefore !== "releasing") {
    return { kind: "recoverable-manual", step: -1 };
  }
  return undefined;
}

describe("hold reducer · seeded property test (≥200 seeds)", () => {
  const SEEDS = 240;
  const MIN_CONFIDENCE = 0.7;

  it("every terminated hold made EXACTLY ONE delivery decision; late/stale events are no-ops", () => {
    const terminated = { count: 0 };
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const rand = rng(seed);
      const length = 6 + Math.floor(rand() * 10); // 6–15 个事件
      let s: HoldState = initialHoldState();
      let decision: Decision | undefined;
      let doneAt: number | undefined;

      for (let step = 0; step < length; step += 1) {
        const ev = randomEvent(rand);
        const before = s.phase;
        const result = stepHold(s, ev, MIN_CONFIDENCE);
        s = result.s;

        // 性质 1：决定至多一次，且互斥。
        const d = decisionOfStep(before, ev, result.fx);
        if (d !== undefined) {
          expect(
            decision,
            `seed ${seed} step ${step}: second delivery decision (${d.kind}) after ${decision?.kind}`,
          ).toBeUndefined();
          decision = { ...d, step };
        }

        // 性质 2：cooldown 效应总是伴随同一 step 的 isCooldownOutcome record。
        if (result.fx.some((f) => f.e === "cooldown")) {
          const recorded = result.fx.find((f) => f.e === "record");
          expect(
            recorded !== undefined && recorded.e === "record" && isCooldownOutcome(recorded.outcome),
            `seed ${seed} step ${step}`,
          ).toBe(true);
        }

        // 性质 3：done 之后一切事件 no-op（身份不变 + fx 恒空）。
        if (doneAt !== undefined) {
          expect(s.phase, `seed ${seed} step ${step}: phase moved after done`).toBe("done");
          expect(result.fx, `seed ${seed} step ${step}: fx after done`).toEqual([]);
        }
        if (before !== "done" && s.phase === "done") {
          doneAt = step;
          // 性质 4：进入 done 的那一刻，恰好已有一个投递决定。
          expect(decision, `seed ${seed} step ${step}: reached done without a delivery decision`).toBeDefined();
        }

        // 性质 5：releasing 一定已做过「当前会话」决定（每条进入 releasing 的转移都带 release）。
        // switching 不在其列：PONR 之后决定仍未定稿（switch-entered 或 switch-cancelled 才定）。
        if (s.phase === "releasing") {
          expect(decision, `seed ${seed} step ${step}: releasing without a decision`).toBeDefined();
          expect(decision?.kind).toBe("current");
        }
      }

      if (s.phase === "done") {
        terminated.count += 1;
        expect(decision).toBeDefined();
      }
    }
    // 采样足够广：至少一半种子走到终态（否则性质覆盖不足）。
    expect(terminated.count).toBeGreaterThanOrEqual(SEEDS / 2);
  });

  it("every seed that reaches done has exactly one decision of a single kind (XOR)", () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const rand = rng(seed + 10_000);
      let s: HoldState = initialHoldState();
      const decisions: Decision[] = [];
      for (let step = 0; step < 12; step += 1) {
        const ev = randomEvent(rand);
        const before = s.phase;
        const result = stepHold(s, ev, MIN_CONFIDENCE);
        const d = decisionOfStep(before, ev, result.fx);
        if (d !== undefined) decisions.push(d);
        s = result.s;
      }
      expect(decisions.length).toBeLessThanOrEqual(1);
      if (s.phase === "done") {
        expect(decisions).toHaveLength(1);
        const kinds: readonly Decision["kind"][] = ["current", "new-session", "recoverable-manual"];
        expect(kinds.filter((k) => decisions[0]?.kind === k)).toHaveLength(1);
      }
    }
  });

  it("cooldown outcomes list is stable and consistent with the reducer's cooldown effect", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const rand = rng(seed + 20_000);
      let s: HoldState = initialHoldState();
      for (let step = 0; step < 10; step += 1) {
        const ev = randomEvent(rand);
        const result = stepHold(s, ev, MIN_CONFIDENCE);
        for (const f of result.fx) {
          if (f.e === "cooldown") {
            const rec = result.fx.find((x): x is Extract<HoldEffect, { e: "record" }> => x.e === "record");
            expect(rec !== undefined && COOLDOWN_OUTCOMES.includes(rec.outcome)).toBe(true);
          }
        }
        s = result.s;
      }
    }
  });

  it("deterministic: identical seeds replay identical phase sequences", () => {
    const runOnce = (seed: number): string[] => {
      const rand = rng(seed);
      const phases: string[] = [];
      let s = initialHoldState();
      for (let step = 0; step < 12; step += 1) {
        const ev = randomEvent(rand);
        s = stepHold(s, ev, MIN_CONFIDENCE).s;
        phases.push(s.phase);
      }
      return phases;
    };
    for (let seed = 1; seed <= 20; seed += 1) {
      expect(runOnce(seed)).toEqual(runOnce(seed));
    }
  });
});
