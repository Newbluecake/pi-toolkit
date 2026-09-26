import { describe, expect, it } from "vitest";
import {
  assertCompatible,
  checkTurnEndShape,
  detectPiCapabilities,
  probeBoundaryStatic,
  probeReadBackEntries,
} from "../../src/adapters/pi-compat.js";

describe("pi-compat gate", () => {
  it("passes when the load-time ExtensionAPI lacks sessionManager (real pi behavior)", () => {
    // Regression: gating on sessionManager.getEntries at load time disabled
    // the whole extension on real pi, where sessionManager only exists on
    // the session_start ctx.
    const caps = detectPiCapabilities({ sendMessage() {}, appendEntry() {}, events: { on() {}, emit() {} } }, "0.87.1");
    expect(caps.canReadBackEntries).toBe(false);
    const result = assertCompatible(caps);
    expect(result.ok).toBe(true);
  });

  it("rejects when a load-time-critical capability is missing", () => {
    expect(assertCompatible(detectPiCapabilities({ appendEntry() {}, events: { on() {}, emit() {} } }))).toMatchObject({
      ok: false,
    });
    expect(assertCompatible(detectPiCapabilities({ sendMessage() {}, events: { on() {}, emit() {} } }))).toMatchObject({
      ok: false,
    });
    expect(assertCompatible(detectPiCapabilities({ sendMessage() {}, appendEntry() {} }))).toMatchObject({
      ok: false,
    });
  });

  it("warns (not rejects) outside the tested version range", () => {
    const caps = detectPiCapabilities({ sendMessage() {}, appendEntry() {}, events: { on() {}, emit() {} } }, "0.99.0");
    const result = assertCompatible(caps);
    expect(result.ok).toBe(true);
    expect(result).toHaveProperty("warning");
  });

  it("probeReadBackEntries detects the session-start ctx shape", () => {
    expect(probeReadBackEntries({ sessionManager: { getEntries: () => [] } })).toBe(true);
    expect(probeReadBackEntries({ sessionManager: {} })).toBe(false);
    expect(probeReadBackEntries({})).toBe(false);
    expect(probeReadBackEntries(undefined)).toBe(false);
  });
});

describe("probeBoundaryStatic (plan §3.1 L0: structural detection, no version read)", () => {
  function fullModule() {
    return {
      ExtensionRunner: { prototype: { emitBoundary: () => undefined } },
      SessionManager: { inMemory: () => undefined },
      convertToLlm: () => [],
      findCutPoint: () => undefined,
      estimateTokens: () => 0,
      parseSessionEntries: () => [],
      sessionEntryToContextMessages: () => [],
    };
  }

  it("passes when every required export is a function", () => {
    expect(probeBoundaryStatic(fullModule())).toEqual({ ok: true });
  });

  it("fails with the missing export named in `reason` and `missing` for each export individually (0.86-shaped module)", () => {
    const cases: [string, (mod: ReturnType<typeof fullModule>) => unknown][] = [
      ["ExtensionRunner.emitBoundary", (mod) => ({ ...mod, ExtensionRunner: { prototype: {} } })],
      ["SessionManager.inMemory", (mod) => ({ ...mod, SessionManager: {} })],
      ["convertToLlm", (mod) => ({ ...mod, convertToLlm: undefined })],
      ["findCutPoint", (mod) => ({ ...mod, findCutPoint: undefined })],
      ["estimateTokens", (mod) => ({ ...mod, estimateTokens: undefined })],
      ["parseSessionEntries", (mod) => ({ ...mod, parseSessionEntries: undefined })],
      ["sessionEntryToContextMessages", (mod) => ({ ...mod, sessionEntryToContextMessages: undefined })],
    ];
    for (const [exportName, degrade] of cases) {
      const result = probeBoundaryStatic(degrade(fullModule()) as never);
      expect(result).toMatchObject({ ok: false, missing: [exportName] });
      expect((result as { reason: string }).reason).toBe(`l0-${exportName}`);
    }
  });

  it("reports every missing export together on a fully-0.86-shaped module (only the pre-0.87 exports survive)", () => {
    const legacyShaped = { parseSessionEntries: () => [] }; // 0.86 has none of the boundary exports
    const result = probeBoundaryStatic(legacyShaped);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual([
      "ExtensionRunner.emitBoundary",
      "SessionManager.inMemory",
      "convertToLlm",
      "findCutPoint",
      "estimateTokens",
      "sessionEntryToContextMessages",
    ]);
  });

  it("treats `undefined` (module namespace missing entirely) as every export missing, never throws", () => {
    expect(() => probeBoundaryStatic(undefined)).not.toThrow();
    expect(probeBoundaryStatic(undefined).ok).toBe(false);
  });
});

describe("checkTurnEndShape (plan §3.1 L1: does THIS turn_end event have 0.87-shaped boundary fields?)", () => {
  function fullEvent() {
    return {
      entries: [],
      messageEntryId: "m1",
      toolResultEntryIds: [] as string[],
      context: { canContinue: true },
      outcome: "completed",
    };
  }
  function sessionManagerWith(branch: readonly { id?: unknown }[]) {
    return { getHeader: () => ({}), getBranch: () => branch };
  }

  it("passes on a well-shaped 0.87 event with messageEntryId present in the branch", () => {
    const result = checkTurnEndShape(fullEvent(), sessionManagerWith([{ id: "m1" }]));
    expect(result).toEqual({ ok: true });
  });

  it("fails on the 0.86-shaped TurnEndEvent (only type/turnIndex/message/toolResults, none of the boundary fields)", () => {
    const legacyEvent = { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] };
    const result = checkTurnEndShape(legacyEvent as never, sessionManagerWith([]));
    expect(result).toEqual({ ok: false, reason: "l1-event-shape" });
  });

  it("fails when entries is not an array", () => {
    expect(
      checkTurnEndShape({ ...fullEvent(), entries: undefined } as never, sessionManagerWith([{ id: "m1" }])),
    ).toEqual({ ok: false, reason: "l1-event-shape" });
  });

  it("fails when context.canContinue is missing or not boolean", () => {
    expect(checkTurnEndShape({ ...fullEvent(), context: {} } as never, sessionManagerWith([{ id: "m1" }]))).toEqual({
      ok: false,
      reason: "l1-event-shape",
    });
  });

  it("fails when outcome is not one of completed/aborted/error", () => {
    expect(
      checkTurnEndShape({ ...fullEvent(), outcome: "unknown" } as never, sessionManagerWith([{ id: "m1" }])),
    ).toEqual({ ok: false, reason: "l1-event-shape" });
  });

  it("fails when sessionManager.getBranch/getHeader are missing", () => {
    expect(checkTurnEndShape(fullEvent(), undefined)).toEqual({ ok: false, reason: "l1-event-shape" });
    expect(checkTurnEndShape(fullEvent(), { getHeader: () => ({}) } as never)).toEqual({
      ok: false,
      reason: "l1-event-shape",
    });
  });

  it("fails when getBranch throws (defensive: never propagate)", () => {
    const throwing = {
      getHeader: () => ({}),
      getBranch: () => {
        throw new Error("boom");
      },
    };
    expect(() => checkTurnEndShape(fullEvent(), throwing)).not.toThrow();
    expect(checkTurnEndShape(fullEvent(), throwing)).toEqual({ ok: false, reason: "l1-event-shape" });
  });

  it("fails when messageEntryId is not actually present in the branch", () => {
    expect(checkTurnEndShape(fullEvent(), sessionManagerWith([{ id: "other" }]))).toEqual({
      ok: false,
      reason: "l1-event-shape",
    });
  });
});
