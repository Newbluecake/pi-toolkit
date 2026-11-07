import { describe, expect, it } from "vitest";
import {
  aggregateFirstReply,
  autoReturnDecision,
  canTransitionOutcome,
  isSafeFallback,
  OBSERVED_OUTCOMES,
  outcomeDetermined,
  outcomeForDisposition,
  SAFE_FALLBACK_OUTCOMES,
} from "../../../src/fabric/thread/outcome.js";

describe("Outcome vocabulary (§6.4, r3-3)", () => {
  it("the safe fallback set is EXACTLY {none} — nothing else may join it", () => {
    expect(SAFE_FALLBACK_OUTCOMES).toEqual(["none"]);
    expect(isSafeFallback("none")).toBe(true);
    for (const o of ["buffered", "flushing", "queued", "unknown"] as const) {
      expect(isSafeFallback(o)).toBe(false);
    }
  });

  it("disposition mapping: queued ⇒ queued; handled and everything else ⇒ unknown", () => {
    expect(outcomeForDisposition("queued")).toBe("queued");
    expect(outcomeForDisposition("handled")).toBe("unknown"); // r3-3: handled is NOT a no-side-effect proof
    expect(outcomeForDisposition("dropped")).toBe("unknown");
    expect(outcomeForDisposition("")).toBe("unknown");
  });

  it("determined = the three terminal values; buffered/flushing stay pending", () => {
    expect(outcomeDetermined("queued")).toBe(true);
    expect(outcomeDetermined("unknown")).toBe(true);
    expect(outcomeDetermined("none")).toBe(true);
    expect(outcomeDetermined("buffered")).toBe(false);
    expect(outcomeDetermined("flushing")).toBe(false);
  });

  it("transition law: buffered → flushing|none; flushing → queued|unknown|none; terminals absorbing", () => {
    expect(canTransitionOutcome("buffered", "flushing")).toBe(true);
    expect(canTransitionOutcome("buffered", "none")).toBe(true);
    expect(canTransitionOutcome("buffered", "queued")).toBe(false); // must flush first
    expect(canTransitionOutcome("flushing", "queued")).toBe(true);
    expect(canTransitionOutcome("flushing", "unknown")).toBe(true);
    expect(canTransitionOutcome("flushing", "none")).toBe(true);
    expect(canTransitionOutcome("queued", "queued")).toBe(true);
    expect(canTransitionOutcome("queued", "none")).toBe(false);
    expect(canTransitionOutcome("queued", "unknown")).toBe(false);
    expect(canTransitionOutcome("unknown", "queued")).toBe(false); // display-upgrade path, not a transition
    expect(canTransitionOutcome("unknown", "none")).toBe(false); // post-call outcomes NEVER become safe-fallback
    expect(canTransitionOutcome("none", "queued")).toBe(false);
    expect(canTransitionOutcome("none", "none")).toBe(true);
  });
});

describe("first-reply aggregation (§6.7 首次回复)", () => {
  it("any observed outcome ⇒ routed", () => {
    expect(OBSERVED_OUTCOMES.has("queued")).toBe(true);
    expect(aggregateFirstReply(["none"])).toBe("fallback");
    expect(aggregateFirstReply(["none", "none"])).toBe("fallback");
    expect(aggregateFirstReply(["queued"])).toBe("routed");
    expect(aggregateFirstReply(["none", "unknown"])).toBe("routed");
    expect(aggregateFirstReply(["buffered"])).toBe("routed");
    expect(aggregateFirstReply(["flushing"])).toBe("routed");
    expect(aggregateFirstReply(["none", "buffered", "none"])).toBe("routed");
    expect(aggregateFirstReply([])).toBe("fallback");
  });
});

describe("system auto-return gate (§6.7 系统自动回流)", () => {
  it("all determined and all none ⇒ request", () => {
    expect(autoReturnDecision(["none"])).toEqual({ kind: "request" });
    expect(autoReturnDecision(["none", "none", "none"])).toEqual({ kind: "request" });
  });

  it("ANY queued/unknown ⇒ blocked — never auto-return (无 unknown 回流)", () => {
    expect(autoReturnDecision(["none", "queued"])).toEqual({ kind: "blocked_observed" });
    expect(autoReturnDecision(["unknown"])).toEqual({ kind: "blocked_observed" });
    expect(autoReturnDecision(["queued", "unknown"])).toEqual({ kind: "blocked_observed" });
    expect(autoReturnDecision(["none", "none", "unknown"])).toEqual({ kind: "blocked_observed" });
  });

  it("buffered/flushing ⇒ await (judgment incomplete)", () => {
    expect(autoReturnDecision(["buffered"])).toEqual({ kind: "await_pending" });
    expect(autoReturnDecision(["none", "flushing"])).toEqual({ kind: "await_pending" });
    expect(autoReturnDecision([])).toEqual({ kind: "await_pending" }); // conservative on empty
  });
});
