/**
 * Manual-compaction window tracker (plan §4.2/D13, §9.1 v2 addendum).
 */
import { describe, expect, it, vi } from "vitest";
import { createCompactionState } from "../../../src/web-hub/agent/compaction-state.js";
import { fakePi } from "./helpers.js";

describe("createCompactionState — D13", () => {
  it("sets manualCompacting on session_before_compact{reason:'manual'}", () => {
    const { pi, fire } = fakePi();
    const state = createCompactionState(pi);
    expect(state.manualCompacting).toBe(false);
    fire("session_before_compact", { type: "session_before_compact", reason: "manual" }, undefined);
    expect(state.manualCompacting).toBe(true);
  });

  it("clears on session_compact{reason:'manual'}", () => {
    const { pi, fire } = fakePi();
    const state = createCompactionState(pi);
    fire("session_before_compact", { type: "session_before_compact", reason: "manual" }, undefined);
    fire("session_compact", { type: "session_compact", reason: "manual" }, undefined);
    expect(state.manualCompacting).toBe(false);
  });

  it("clears on session_compact_failed{reason:'manual'} (compaction cancelled/failed)", () => {
    const { pi, fire } = fakePi();
    const state = createCompactionState(pi);
    fire("session_before_compact", { type: "session_before_compact", reason: "manual" }, undefined);
    fire("session_compact_failed", { type: "session_compact_failed", reason: "manual" }, undefined);
    expect(state.manualCompacting).toBe(false);
  });

  it.each(["threshold", "overflow"] as const)(
    "reason:%s never sets manualCompacting (only explicit manual compaction does)",
    (reason) => {
      const { pi, fire } = fakePi();
      const state = createCompactionState(pi);
      fire("session_before_compact", { type: "session_before_compact", reason }, undefined);
      expect(state.manualCompacting).toBe(false);
      fire("session_compact", { type: "session_compact", reason }, undefined);
      fire("session_compact_failed", { type: "session_compact_failed", reason }, undefined);
      expect(state.manualCompacting).toBe(false);
    },
  );

  it("branch-summary-shaped events (no reason field at all) never set manualCompacting", () => {
    const { pi, fire } = fakePi();
    const state = createCompactionState(pi);
    fire("session_before_compact", { type: "session_before_compact" }, undefined);
    expect(state.manualCompacting).toBe(false);
  });

  it("dispose() unsubscribes every handler — later events are inert", () => {
    const { pi, fire } = fakePi();
    const state = createCompactionState(pi);
    state.dispose();
    fire("session_before_compact", { type: "session_before_compact", reason: "manual" }, undefined);
    expect(state.manualCompacting).toBe(false);
  });
});

// todo #32 finding 1 (D26, spike K13): pi emits `session_compact` before clearing its own
// `_compactionAbortController` (agent-session.js:1941 vs :1957) — a synchronous dispatch from
// inside that handler's own call stack is silently swallowed. `deferAfterManualCompaction` is the
// safety net any current/future consumer reacting to a manual compaction ending MUST go through.
describe("createCompactionState — deferAfterManualCompaction (D26)", () => {
  it("never invokes the callback synchronously — only after the current tick", () => {
    vi.useFakeTimers();
    try {
      const { pi } = fakePi();
      const state = createCompactionState(pi);
      const cb = vi.fn();
      state.deferAfterManualCompaction(cb);
      expect(cb).not.toHaveBeenCalled();
      vi.advanceTimersByTime(0);
      expect(cb).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a callback registered inside a synchronous session_compact handler still only runs next tick", () => {
    vi.useFakeTimers();
    try {
      const { pi, fire } = fakePi();
      const state = createCompactionState(pi);
      let insideHandler = false;
      let sawInsideHandlerWhenFired: boolean | undefined;
      pi.on("session_compact", () => {
        insideHandler = true;
        state.deferAfterManualCompaction(() => {
          sawInsideHandlerWhenFired = insideHandler;
        });
        insideHandler = false;
      });
      fire("session_before_compact", { type: "session_before_compact", reason: "manual" }, undefined);
      fire("session_compact", { type: "session_compact", reason: "manual" }, undefined);
      expect(sawInsideHandlerWhenFired).toBeUndefined(); // not fired yet
      vi.advanceTimersByTime(0);
      expect(sawInsideHandlerWhenFired).toBe(false); // fired strictly after the handler returned
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules an unref'd timer (never wedges `pi -p` print mode)", () => {
    const unref = vi.fn();
    const spy = vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      expect(ms).toBe(0);
      queueMicrotask(fn);
      return { unref } as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
    try {
      const { pi } = fakePi();
      const state = createCompactionState(pi);
      state.deferAfterManualCompaction(() => {});
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("multiple deferred callbacks all fire, independently, on the next tick", () => {
    vi.useFakeTimers();
    try {
      const { pi } = fakePi();
      const state = createCompactionState(pi);
      const a = vi.fn();
      const b = vi.fn();
      state.deferAfterManualCompaction(a);
      state.deferAfterManualCompaction(b);
      vi.advanceTimersByTime(0);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
