import { describe, expect, it } from "vitest";
import {
  getChildSwitchCapability,
  resetChildSwitchCapabilityForTests,
  type ChildSwitchCapability,
} from "../../src/context-switch/capability.js";

function fresh(): ChildSwitchCapability {
  resetChildSwitchCapabilityForTests();
  return getChildSwitchCapability();
}

describe("child-switch capability state machine (plan §3.1)", () => {
  it("full transition matrix: unknown -> static-ok -> observed -> ready -> verifying -> verified", () => {
    const cap = fresh();
    expect(cap.get()).toEqual({ state: "unknown" });
    expect(cap.noteL0({ ok: true })).toEqual({ state: "static-ok" });
    expect(cap.noteL1({ ok: true })).toEqual({ state: "observed" });
    expect(cap.noteL2({ ok: true })).toEqual({ state: "ready" });
    expect(cap.tryBeginVerification()).toBe(true);
    expect(cap.get()).toEqual({ state: "verifying" });
    expect(cap.noteL3({ ok: true })).toEqual({ state: "verified" });
  });

  it("L0 failure disables sticky, before ever registering anything", () => {
    const cap = fresh();
    expect(cap.noteL0({ ok: false, reason: "missing-emitBoundary" })).toEqual({
      state: "disabled",
      reason: "l0-missing-emitBoundary",
    });
    // sticky: further probes at any layer are no-ops.
    expect(cap.noteL1({ ok: true })).toEqual({ state: "disabled", reason: "l0-missing-emitBoundary" });
    expect(cap.noteL2({ ok: true })).toEqual({ state: "disabled", reason: "l0-missing-emitBoundary" });
    expect(cap.tryBeginVerification()).toBe(false);
  });

  it("L1 failure disables sticky (0.86-shaped turn_end event)", () => {
    const cap = fresh();
    cap.noteL0({ ok: true });
    expect(cap.noteL1({ ok: false, reason: "l1-event-shape" })).toEqual({
      state: "disabled",
      reason: "l1-event-shape",
    });
  });

  it("L2 failure disables sticky, with the specific v3.1 sub-reason", () => {
    const cap = fresh();
    cap.noteL0({ ok: true });
    cap.noteL1({ ok: true });
    expect(cap.noteL2({ ok: false, reason: "l2-drafts-ignored" })).toEqual({
      state: "disabled",
      reason: "l2-drafts-ignored",
    });
  });

  it("L2 no-conclusion (session ended early / no session file) stays observed", () => {
    const cap = fresh();
    cap.noteL0({ ok: true });
    cap.noteL1({ ok: true });
    expect(cap.noteL2({ ok: undefined })).toEqual({ state: "observed" });
    // repeated no-conclusion probes keep it observed, never advance nor disable.
    expect(cap.noteL2({ ok: undefined })).toEqual({ state: "observed" });
    // and it can still reach ready afterwards once a conclusive probe lands.
    expect(cap.noteL2({ ok: true })).toEqual({ state: "ready" });
  });

  it("verifying rejects a second concurrent verification request", () => {
    const cap = fresh();
    cap.noteL0({ ok: true });
    cap.noteL1({ ok: true });
    cap.noteL2({ ok: true });
    expect(cap.tryBeginVerification()).toBe(true);
    // A second session's switch request must not also begin verification.
    expect(cap.tryBeginVerification()).toBe(false);
    expect(cap.get()).toEqual({ state: "verifying" });
  });

  it("first-use self-check (L3) failure disables immediately — unverified processes stop on first failure", () => {
    const cap = fresh();
    cap.noteL0({ ok: true });
    cap.noteL1({ ok: true });
    cap.noteL2({ ok: true });
    cap.tryBeginVerification();
    expect(cap.noteL3({ ok: false, reason: "context-not-refreshed" })).toEqual({
      state: "disabled",
      reason: "context-not-refreshed",
    });
  });

  it("verified process tolerates a single uncommitted recheck, disables only on 2 consecutive", () => {
    const cap = fresh();
    cap.noteL0({ ok: true });
    cap.noteL1({ ok: true });
    cap.noteL2({ ok: true });
    cap.tryBeginVerification();
    cap.noteL3({ ok: true });
    expect(cap.get()).toEqual({ state: "verified" });

    expect(cap.noteRecheck({ ok: false, reason: "uncommitted" })).toEqual({ state: "verified" });
    // A success in between resets the consecutive counter.
    expect(cap.noteRecheck({ ok: true })).toEqual({ state: "verified" });
    expect(cap.noteRecheck({ ok: false, reason: "uncommitted" })).toEqual({ state: "verified" });
    expect(cap.noteRecheck({ ok: false, reason: "uncommitted" })).toEqual({
      state: "disabled",
      reason: "repeat-uncommitted",
    });
  });

  it("onDisabled listener fires exactly once, only at the first transition into disabled", () => {
    const cap = fresh();
    let calls = 0;
    let lastReason: string | undefined;
    const unsubscribe = cap.onDisabled((reason) => {
      calls += 1;
      lastReason = reason;
    });
    cap.noteL0({ ok: false, reason: "x" });
    expect(calls).toBe(1);
    expect(lastReason).toBe("l0-x");
    // Further failed probes are no-ops on an already-disabled record: no re-notify.
    cap.noteL1({ ok: false, reason: "y" });
    expect(calls).toBe(1);
    unsubscribe();
  });

  it("multiple listeners registered before the transition are each called once", () => {
    const cap = fresh();
    let a = 0;
    let b = 0;
    cap.onDisabled(() => (a += 1));
    cap.onDisabled(() => (b += 1));
    cap.noteL0({ ok: false, reason: "z" });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it("shares the same process-level singleton across separate handles (simulates /reload)", () => {
    resetChildSwitchCapabilityForTests();
    const first = getChildSwitchCapability();
    first.noteL0({ ok: true });
    first.noteL1({ ok: true });
    // A brand-new handle (as a fresh module instance after /reload would produce) reads the
    // same globalThis-backed record.
    const second = getChildSwitchCapability();
    expect(second.get()).toEqual({ state: "observed" });
    second.noteL2({ ok: true });
    expect(first.get()).toEqual({ state: "ready" });
  });
});
