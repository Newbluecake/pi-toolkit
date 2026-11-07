/**
 * fabric-thread P1 (arch r3 §6.4/§6.7): Outcome — the per-(event, subscription) delivery result
 * vocabulary, the pi-disposition mapping, the state-machine transition law, the event-level
 * aggregation for the first hub reply, and the system auto-return decision.
 *
 * The load-bearing rule (r3-3): the SAFE FALLBACK SET is exactly {`none`} — rejections this
 * plugin's own code determined BEFORE calling pi's steer. Once pi's steer is called, EVERY
 * result (`queued`, `handled`, reject, timeout, unknown string) is `queued`/`unknown` and NEVER
 * safe to fall back from. `handled ⇒ unknown` (an input handler may have consumed and acted).
 */
import type { Outcome } from "./types.js";

/** §6.4: 安全回落集合 = {none} — and nothing else (r3-3; `refused` was removed in r3). */
export const SAFE_FALLBACK_OUTCOMES: readonly Outcome[] = ["none"];

export function isSafeFallback(outcome: Outcome): boolean {
  return outcome === "none";
}

/** §6.7 首次回复: at least one of these ⇒ the `routed` reply branch. */
export const OBSERVED_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>(["queued", "unknown", "buffered", "flushing"]);

/** §6.4 terminal Outcome values; `buffered`/`flushing` are intermediate (仍可能被接收). */
export function outcomeDetermined(outcome: Outcome): boolean {
  return outcome === "queued" || outcome === "unknown" || outcome === "none";
}

/**
 * §6.4 pi `QueuedInputDisposition` (pi 1.4.0: `"handled" | "queued"`) → Outcome:
 * `queued ⇒ queued`; `handled` and EVERYTHING else (reject path, unknown string) ⇒ `unknown`.
 * The engine routes rejects/timeouts here with the literal "unknown".
 */
export function outcomeForDisposition(disposition: string): "queued" | "unknown" {
  return disposition === "queued" ? "queued" : "unknown";
}

/** The Outcome state-machine law (§5.2/§6.5): `buffered → flushing → queued|unknown|none`,
 *  `buffered → none`, terminals absorbing. `unknown → queued` is NOT a transition — it is the
 *  display-state upgrade (§6.5 晚到结果), handled by the engine's audit path, not here. */
export function canTransitionOutcome(from: Outcome, to: Outcome): boolean {
  if (from === to) return true;
  switch (from) {
    case "buffered":
      return to === "flushing" || to === "none";
    case "flushing":
      return to === "queued" || to === "unknown" || to === "none";
    default:
      return false; // queued / unknown / none are absorbing
  }
}

/** §6.7 首次回复 aggregation: `routed` iff ANY outcome ∈ observed set; `fallback` (all `none`)
 *  otherwise. An EMPTY subscriber set is conservatively `fallback` (the engine only reaches the
 *  reply with an empty set through the lazy-cleanup race; the native release path re-checks). */
export function aggregateFirstReply(outcomes: Iterable<Outcome>): "routed" | "fallback" {
  for (const o of outcomes) {
    if (OBSERVED_OUTCOMES.has(o)) return "routed";
  }
  return "fallback";
}

export type AutoReturnDecision =
  /** all subscribers determined AND all `none` ⇒ request the system handback (§8.3 by:"system"). */
  | { kind: "request" }
  /** some subscriber ∈ {queued, unknown} ⇒ NEVER auto-return (A may be acting; display line only). */
  | { kind: "blocked_observed" }
  /** some subscriber still buffered/flushing ⇒ no decision yet. */
  | { kind: "await_pending" };

/** §6.7 系统自动回流 gate. Pure — the engine adds the at-most-once latch on top. An EMPTY
 *  outcome set is conservatively `await_pending`: auto-return needs POSITIVE all-`none`
 *  evidence (an event with zero subscribers never reaches this check through the engine). */
export function autoReturnDecision(outcomes: Iterable<Outcome>): AutoReturnDecision {
  let seen = false;
  let allNone = true;
  for (const o of outcomes) {
    seen = true;
    if (o === "queued" || o === "unknown") return { kind: "blocked_observed" };
    if (o === "buffered" || o === "flushing") return { kind: "await_pending" };
    allNone = allNone && o === "none";
  }
  if (!seen) return { kind: "await_pending" };
  return allNone ? { kind: "request" } : { kind: "blocked_observed" };
}
