import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { getChildKeepaliveDisposeRegistry } from "../../src/cache-ttl/child-registry.js";

/**
 * P1 review fix (child-context-switch plan.md §2.4 终态 ③, todo #30 follow-up §3.3/§3.9):
 * `ChildKeepaliveDisposeRegistry` used to key its single dispose callback purely by sessionId,
 * exactly like `ChildBashRegistry`'s pre-fix `entries` map — a resume reusing the sessionId
 * would `register()` a brand-new dispose callback under the same key, and the OLD run's own
 * defensive `onReaped` fan-out (`src/stack.ts`'s `disposeSession(sessionId)`), if it happened to
 * arrive AFTER that new registration, would dispose the NEW run's live keepalive service purely
 * because it shares the resumed sessionId. The fix threads an optional `runId` through both
 * `register()` and `disposeSession()` and only actually disposes when they match (or either side
 * omits it, back-compat).
 */
describe("cache-ttl child-registry: runId-aware dispose (P1 §3.3/§3.9)", () => {
  it("disposeSession(sessionId) with no runId still disposes unconditionally (back-compat, pre-fix shape)", () => {
    const registry = getChildKeepaliveDisposeRegistry();
    const sid = randomUUID();
    const dispose = vi.fn();
    registry.register(sid, dispose);
    registry.disposeSession(sid);
    expect(dispose).toHaveBeenCalledTimes(1);
    registry.disposeSession(sid); // idempotent — already removed
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("register() + disposeSession() carrying the SAME runId dispose normally (the ordinary, single-run path)", () => {
    const registry = getChildKeepaliveDisposeRegistry();
    const sid = randomUUID();
    const runId = randomUUID();
    const dispose = vi.fn();
    registry.register(sid, dispose, runId);
    registry.disposeSession(sid, runId);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  /**
   * The exact reported race: run-1 registers and (later, in the REAL wiring) is disposed
   * normally at `agent_settled` — but here we model the pathological ordering where run-1's own
   * defensive `onReaped` fan-out is delayed until AFTER a resume (run-2) has already registered
   * its own dispose callback for the SAME sessionId. Before the fix, `disposeSession(sid)` (no
   * runId, the pre-fix call shape) or even `disposeSession(sid, runId1)` without the match check
   * would tear down run-2's live service.
   */
  it("a stale caller's late disposeSession (old run's runId) after a resume registered a NEW dispose callback must NOT dispose it", () => {
    const registry = getChildKeepaliveDisposeRegistry();
    const sid = randomUUID();
    const runId1 = randomUUID();
    const runId2 = randomUUID();
    const dispose1 = vi.fn();
    const dispose2 = vi.fn();

    registry.register(sid, dispose1, runId1);
    // resume: run-2 registers its OWN dispose callback for the SAME sessionId before run-1's
    // late fan-out ever arrives.
    registry.register(sid, dispose2, runId2);

    // LATE: run-1's own (already logically-superseded) onReaped fan-out finally fires.
    registry.disposeSession(sid, runId1);
    expect(dispose1).not.toHaveBeenCalled();
    expect(dispose2).not.toHaveBeenCalled(); // run-2's service must be untouched

    // run-2's own eventual settle can still dispose it normally.
    registry.disposeSession(sid, runId2);
    expect(dispose2).toHaveBeenCalledTimes(1);
  });

  it("a stale caller with no runId at all (pre-fix back-compat call) still cannot be told apart — documented conservative gap: only a caller that itself knows a runId is protected", () => {
    // This test documents the boundary of the fix rather than asserting new protection: a caller
    // that omits `runId` entirely (old call shape) has no way to express "I am specifically
    // run-1" and therefore always disposes unconditionally, exactly like before the fix. Every
    // production call site (src/stack.ts's onReaped, src/cache-ttl/child.ts's register) now
    // always passes a runId, so this shape should not occur in practice — but the registry itself
    // cannot invent a runId a caller never supplied.
    const registry = getChildKeepaliveDisposeRegistry();
    const sid = randomUUID();
    const runId2 = randomUUID();
    const dispose2 = vi.fn();
    registry.register(sid, dispose2, runId2);
    registry.disposeSession(sid); // no runId — back-compat unconditional dispose
    expect(dispose2).toHaveBeenCalledTimes(1);
  });
});
