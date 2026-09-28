/**
 * Manual-compaction window tracker (plan §4.2/D13, §9.1 v2 addendum).
 */
import { describe, expect, it } from "vitest";
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
