import { describe, expect, it } from "vitest";
import { decideRoute, type RouteDecisionInput } from "../../../src/fabric/thread/decision.js";

const base: RouteDecisionInput = {
  featureEnabled: true,
  trustedOrigin: true,
  hasThreadMeta: true,
  threadMetaValid: true,
  headerOk: true,
  bypass: false,
  hasLiveSubscriber: true,
  addressedOther: false,
  hourlyCapReached: false,
  laneWaitFull: false,
  recordsFull: false,
  steerTimeoutMs: 4000,
  frameDeadlineMs: 8000,
};

describe("decision table R0–R7 (§6.3)", () => {
  it("R7 for the all-green input", () => {
    expect(decideRoute(base)).toEqual({ rule: "R7", route: "lane" });
  });

  it("R0 fires for each of its five conditions, in order", () => {
    expect(decideRoute({ ...base, featureEnabled: false })).toMatchObject({ rule: "R0", reason: "feature_off" });
    expect(decideRoute({ ...base, featureEnabled: false, bypass: true })).toMatchObject({
      rule: "R0",
      reason: "feature_off",
    }); // R0 precedes R1
    expect(decideRoute({ ...base, trustedOrigin: false })).toMatchObject({ rule: "R0", reason: "untrusted_origin" });
    expect(decideRoute({ ...base, hasThreadMeta: false })).toMatchObject({ rule: "R0", reason: "no_thread_meta" });
    expect(decideRoute({ ...base, threadMetaValid: false })).toMatchObject({
      rule: "R0",
      reason: "invalid_thread_meta",
    });
    expect(decideRoute({ ...base, headerOk: false })).toMatchObject({ rule: "R0", reason: "header_mismatch" });
  });

  it("R1 (bypass) precedes R2/R3/R4/R5/R6", () => {
    const input: RouteDecisionInput = {
      ...base,
      bypass: true,
      hasLiveSubscriber: false,
      addressedOther: true,
      hourlyCapReached: true,
      laneWaitFull: true,
      recordsFull: true,
      frameDeadlineMs: 100, // would be R6
    };
    expect(decideRoute(input)).toEqual({ rule: "R1", route: "native", reason: "bypass" });
  });

  it("R2 (no live subscriber after lazy validation) precedes R3–R6", () => {
    const input: RouteDecisionInput = {
      ...base,
      hasLiveSubscriber: false,
      addressedOther: true,
      hourlyCapReached: true,
      laneWaitFull: true,
      frameDeadlineMs: 100,
    };
    expect(decideRoute(input)).toEqual({ rule: "R2", route: "native", reason: "no_live_subscriber" });
  });

  it("R3 (addressed_other) precedes R4/R5/R6", () => {
    const input: RouteDecisionInput = {
      ...base,
      addressedOther: true,
      hourlyCapReached: true,
      laneWaitFull: true,
      frameDeadlineMs: 100,
    };
    expect(decideRoute(input)).toEqual({ rule: "R3", route: "native", reason: "addressed_other" });
  });

  it("R4 (hourly direct-routing cap) precedes R5/R6", () => {
    const input: RouteDecisionInput = { ...base, hourlyCapReached: true, laneWaitFull: true, frameDeadlineMs: 100 };
    expect(decideRoute(input)).toEqual({ rule: "R4", route: "native", reason: "routed_hourly_cap" });
  });

  it("R5: lane wait full first, then records table full (§6.7 folds both into R5); R5 precedes R6", () => {
    expect(decideRoute({ ...base, laneWaitFull: true })).toEqual({
      rule: "R5",
      route: "native",
      reason: "lane_wait_full",
    });
    expect(decideRoute({ ...base, recordsFull: true })).toEqual({
      rule: "R5",
      route: "native",
      reason: "records_full",
    });
    expect(decideRoute({ ...base, laneWaitFull: true, recordsFull: true })).toEqual({
      rule: "R5",
      route: "native",
      reason: "lane_wait_full",
    });
    expect(decideRoute({ ...base, recordsFull: true, frameDeadlineMs: 100 })).toEqual({
      rule: "R5",
      route: "native",
      reason: "records_full",
    });
  });

  it("R6: unusable steer budget (clampSpanMs undefined or span < 500ms)", () => {
    expect(decideRoute({ ...base, frameDeadlineMs: 1500 })).toEqual({
      rule: "R6",
      route: "native",
      reason: "budget_invalid",
    });
    expect(decideRoute({ ...base, frameDeadlineMs: 1900 })).toEqual({
      rule: "R6",
      route: "native",
      reason: "budget_invalid",
    });
    expect(decideRoute({ ...base, steerTimeoutMs: 100, frameDeadlineMs: 8000 })).toEqual({
      rule: "R6",
      route: "native",
      reason: "budget_invalid",
    });
    expect(decideRoute({ ...base, frameDeadlineMs: 2000 })).toEqual({ rule: "R7", route: "lane" });
  });
});
