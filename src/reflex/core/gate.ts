/**
 * jev-reflex · S0 deterministic veto (plan R1 step 4; arch §4.3). Fifteen ordered rows,
 * first hit wins; the sixteenth (any handler exception ⇒ continue) is the caller's try/catch
 * and is tested in R2b. Pure, zero I/O, no module-scope mutable state (I4); module-scope
 * regexes never carry `/g` (the one `/g` consumer rebuilds its regex inside the function,
 * clauses.ts style).
 *
 * Deviation note (root ruling 2026-11-05, R1-report): arch §4.5's binding hit example
 * 「有未提交的改动吗」contains the imperative words 提交/改, so row 15 must honour negated
 * occurrences. `negationWithinWindow` (clauses.ts) covers 不要/别/不用/…, but not the
 * 未/没/没有/无 family — that extension lives HERE, local to the reflex gate, over the same
 * 8-code-point window shape (negation word ends at or before the action word, within 8 cp).
 * clauses.ts is untouched.
 */

import { cancelIntent, negationWithinWindow } from "../../memory/jev/predict/clauses.js";
import { hasAnaphora, isShortReply } from "../../topic-switch/filters.js";
import type { GateFacts, VetoCode } from "./types.js";
import { MAX_INPUT_CHARS } from "./budget.js";
import { normalizeInput, type NormalizedInput } from "./normalize.js";

export type GateResult = { pass: true; norm: NormalizedInput } | { pass: false; veto: VetoCode };

/**
 * Frozen write/imperative verb table (arch §4.3 row 15): any un-negated occurrence vetoes.
 * Substring semantics on the normalized text — over-matching only loses speed (more vetoes),
 * never correctness ("宁可漏答，不可误答").
 */
export const IMPERATIVE_VETO: readonly string[] = Object.freeze([
  "杀",
  "kill",
  "停",
  "删",
  "清理",
  "提交",
  "commit",
  "push",
  "改",
  "修",
  "写",
  "加",
  "实现",
  "创建",
  "运行",
  "跑一下",
  "启动",
  "重启",
  "安装",
  "发布",
  "merge",
  "rebase",
  "reset",
  "checkout",
  "切换",
  "帮我",
]);

/**
 * PD12 correction word list — exported for R2b/R3b (they persist the entry; the gate itself
 * never uses it: a correcting input flows through S0 like any other line).
 */
export const CORRECTION_RE: RegExp = /不对|不是|错了|重新|wrong/; // no /g — module-scope regexes stay stateless (I4)

/** Local negation extension for row 15 (see header): 未/没有/没/无, longest first. */
const EXTENDED_NEGATION_SRC = "没有|没|未|无";

/** `@label` mention token: `@` at start or after whitespace, then a label-ish run. */
const MENTION_TOKEN_RE = /(^|\s)@[\w.-]+/;

/** True when the occurrence of an action word at `actionIndex` is negated (see header). */
function isNegatedOccurrence(text: string, actionIndex: number): boolean {
  if (negationWithinWindow(text, actionIndex)) return true;
  const re = new RegExp(EXTENDED_NEGATION_SRC, "g"); // /g stays function-local (I4 rule)
  for (const m of text.matchAll(re)) {
    const end = m.index + m[0].length;
    if (end <= actionIndex && actionIndex - end <= 8) return true;
    if (m.index >= actionIndex) break;
  }
  return false;
}

/** Row 15: any imperative word with at least one un-negated occurrence. */
function imperativeHit(norm: string): boolean {
  for (const word of IMPERATIVE_VETO) {
    let from = 0;
    while (true) {
      const idx = norm.indexOf(word, from);
      if (idx < 0) break;
      if (!isNegatedOccurrence(norm, idx)) return true;
      from = idx + word.length;
    }
  }
  return false;
}

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/**
 * S0. Rows are evaluated strictly in arch §4.3 order; see that table for the rationale of
 * each. NOTE: `VetoCode`'s `"negation"` member has no row of its own — negation only modulates
 * row 15 — and is kept (frozen union) as a reserved code; evaluateGate never returns it.
 */
export function evaluateGate(f: GateFacts): GateResult {
  const fail = (veto: VetoCode): GateResult => ({ pass: false, veto });
  if (f.source !== "interactive") return fail("source"); // 1
  if (f.mode !== "tui") return fail("mode"); // 2
  if (f.streamingBehavior !== undefined) return fail("streaming"); // 3
  if (!f.idle || f.pendingMessages) return fail("busy"); // 4
  if (f.imageCount > 0) return fail("image"); // 5
  if (f.topicSwitchActive) return fail("fence-topic"); // 6
  if (f.goalBusy) return fail("fence-goal"); // 7
  if (f.inFlight) return fail("in-flight"); // 8
  const trimmed = f.text.trim();
  const rawChars = codePoints(trimmed);
  if (rawChars > MAX_INPUT_CHARS || rawChars < 2) return fail("length"); // 9
  const { norm, chars, lines } = normalizeInput(f.text);
  if (lines > 1 || f.text.includes("```")) return fail("multiline"); // 10
  const head = trimmed[0];
  if (head === "/" || head === "!" || head === "@" || head === "#" || MENTION_TOKEN_RE.test(trimmed)) {
    return fail("prefix"); // 11
  }
  if (isShortReply(trimmed)) return fail("short-reply"); // 12
  if (hasAnaphora(trimmed)) return fail("anaphora"); // 13
  if (cancelIntent(norm)) return fail("cancel"); // 14
  if (imperativeHit(norm)) return fail("imperative"); // 15
  return { pass: true, norm: { norm, chars, lines } };
}
