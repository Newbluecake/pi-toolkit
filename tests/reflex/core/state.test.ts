/**
 * R1 · state (plan R1 step 8; arch §4.7, PD5/PD6/PD12): strike accounting, effective state,
 * repeat/correction demotion, reset, correction detection windows.
 */
import { describe, expect, it } from "vitest";
import { requestDigest } from "../../../src/reflex/core/digest.js";
import {
  detectCorrection,
  effectiveState,
  onCorrected,
  onExecOutcome,
  onRepeat,
  reset,
  type CorrectionMemo,
} from "../../../src/reflex/core/state.js";
import type { ExecOutcome, ScriptRuntime } from "../../../src/reflex/core/types.js";

const FRESH: ScriptRuntime = { strikes: 0, demoted: false };
const ok: ExecOutcome = { kind: "ok", lines: [], facts: {}, truncated: false };
const uncertain: ExecOutcome = { kind: "uncertain", reason: "stale" };
const unavailable: ExecOutcome = { kind: "unavailable", reason: "no manager" };
const error: ExecOutcome = { kind: "error", reason: "boom" };
const timeout: ExecOutcome = { kind: "timeout", reason: "budget" };

describe("effectiveState", () => {
  it("demote overlay beats autoResolve; autoResolve gates auto", () => {
    expect(effectiveState("git.status", [], FRESH)).toBe("shadow");
    expect(effectiveState("git.status", ["git.status"], FRESH)).toBe("auto");
    expect(effectiveState("git.status", ["git.status"], { ...FRESH, demoted: true })).toBe("demoted");
    expect(effectiveState("git.status", [], { ...FRESH, demoted: true })).toBe("demoted");
  });
});

describe("onExecOutcome (strikes)", () => {
  it("error/timeout strike; DEMOTE_AFTER_STRIKES=2 sets the overlay exactly once", () => {
    const first = onExecOutcome(FRESH, error, 1_000);
    expect(first.rt).toEqual({ strikes: 1, demoted: false });
    expect(first.demotedNow).toBe(false);
    const second = onExecOutcome(first.rt, timeout, 2_000);
    expect(second.rt).toEqual({ strikes: 2, demoted: true, demotedAt: 2_000, demoteReason: "strikes" });
    expect(second.demotedNow).toBe(true);
    const third = onExecOutcome(second.rt, error, 3_000);
    expect(third.rt).toEqual({ strikes: 3, demoted: true, demotedAt: 2_000, demoteReason: "strikes" });
    expect(third.demotedNow).toBe(false); // notify fires once
  });

  it("ok resets strikes but NEVER clears the demote overlay", () => {
    const demoted = onExecOutcome(onExecOutcome(FRESH, error, 1).rt, error, 2).rt;
    const after = onExecOutcome(demoted, ok, 3);
    expect(after.rt).toEqual({ strikes: 0, demoted: true, demotedAt: 2, demoteReason: "strikes" });
    expect(after.demotedNow).toBe(false);
  });

  it("uncertain/unavailable neither strike nor reset", () => {
    expect(onExecOutcome({ strikes: 1, demoted: false }, uncertain, 5).rt).toEqual({ strikes: 1, demoted: false });
    expect(onExecOutcome({ strikes: 1, demoted: false }, unavailable, 5).rt).toEqual({ strikes: 1, demoted: false });
  });

  it("non-consecutive strikes: ok between two errors does not demote", () => {
    const a = onExecOutcome(FRESH, error, 1).rt;
    const b = onExecOutcome(a, ok, 2).rt; // reset
    const c = onExecOutcome(b, error, 3);
    expect(c.rt).toEqual({ strikes: 1, demoted: false });
    expect(c.demotedNow).toBe(false);
  });

  it("pure reducer: the input runtime object is never mutated", () => {
    const rt: ScriptRuntime = { strikes: 0, demoted: false };
    onExecOutcome(rt, error, 1);
    onExecOutcome(rt, error, 2);
    onRepeat(rt, 3);
    expect(rt).toEqual({ strikes: 0, demoted: false });
  });
});

describe("onRepeat / onCorrected (PD5)", () => {
  it("two-arg form demotes unconditionally (AUTO call sites)", () => {
    const r = onRepeat(FRESH, 5_000);
    expect(r.rt).toEqual({ strikes: 0, demoted: true, demotedAt: 5_000, demoteReason: "repeat" });
    expect(r.demotedNow).toBe(true);
    const c = onCorrected(FRESH, 6_000);
    expect(c.rt.demoteReason).toBe("corrected");
    expect(c.demotedNow).toBe(true);
  });

  it("state param: never demotes outside auto (PD5 root ruling)", () => {
    expect(onRepeat(FRESH, 5_000, "shadow").rt).toEqual(FRESH);
    expect(onRepeat(FRESH, 5_000, "shadow").demotedNow).toBe(false);
    expect(onCorrected(FRESH, 5_000, "demoted").demotedNow).toBe(false);
    expect(onRepeat(FRESH, 5_000, "auto").demotedNow).toBe(true);
  });

  it("already demoted: the first reason wins, no second notify", () => {
    const struck = onExecOutcome(onExecOutcome(FRESH, error, 1).rt, error, 2).rt;
    const r = onRepeat(struck, 3);
    expect(r.rt.demoteReason).toBe("strikes");
    expect(r.demotedNow).toBe(false);
  });
});

describe("reset", () => {
  it("clears strikes AND the overlay", () => {
    expect(reset({ strikes: 2, demoted: true, demotedAt: 9, demoteReason: "strikes" })).toEqual({
      strikes: 0,
      demoted: false,
    });
  });
});

describe("detectCorrection (PD12)", () => {
  const memo = (over: Partial<CorrectionMemo> = {}): CorrectionMemo => ({
    kind: "shadow",
    scriptId: "git.status",
    scriptVer: 1,
    digest: "abc123def4567890",
    settledAt: 1_000,
    corrected: false,
    ...over,
  });

  it("no memo ⇒ undefined", () => {
    expect(detectCorrection("不对", undefined, 2_000)).toBeUndefined();
  });

  it("already corrected ⇒ undefined (each target at most once)", () => {
    expect(detectCorrection("不对", memo({ corrected: true }), 2_000)).toBeUndefined();
  });

  it("non-correction text ⇒ undefined", () => {
    expect(detectCorrection("工作区干净吗", memo(), 2_000)).toBeUndefined();
  });

  it("outside the 90s window (or clock skew) ⇒ undefined", () => {
    expect(detectCorrection("不对", memo(), 1_000 + 90_000 + 1)).toBeUndefined();
    expect(detectCorrection("不对", memo(), 1_000 + 90_000)).toBeDefined(); // boundary inclusive
    expect(detectCorrection("不对", memo(), 999)).toBeUndefined(); // now < settledAt
  });

  it("hit ⇒ ReflexCorrectionV1 with delta, target and correction digest (no raw text)", () => {
    const c = detectCorrection("不对，重新看一下", memo({ kind: "answer", digest: "deadbeefdeadbeef" }), 30_000);
    expect(c).toEqual({
      v: 1,
      at: 30_000,
      targetKind: "answer",
      targetScriptId: "git.status",
      targetScriptVer: 1,
      targetDigest: "deadbeefdeadbeef",
      deltaMs: 29_000,
      correctionDigest: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    // correctionDigest is the digest of the correction's own normalized text
    expect(c!.correctionDigest).toBe(requestDigest("不对，重新看一下"));
  });
});
