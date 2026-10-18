import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { isTerminalStatus } from "../../src/core/status.js";
import { createInitialState, reduce } from "../../src/core/state-machine.js";
import type { RunDisplayMeta, RunInput, RunState } from "../../src/core/types.js";
import { cacheResult, consultMeta } from "./consult-cache-fixtures.js";

const budget = { ...DEFAULT_BUDGET, totalMs: 60_000, queueWaitMs: 1_000 };
function apply(state: RunState, input: RunInput, generation = state.generation) {
  return reduce(state, { generation, input }, budget);
}
function running(meta?: RunDisplayMeta): RunState {
  let s = createInitialState("r_consult", 1, 0);
  for (const input of [
    { kind: "enqueued", at: 0, budget, ...(meta === undefined ? {} : { meta }) },
    { kind: "slot_acquired", at: 1 },
    { kind: "phase_entered", at: 2, phase: "session_create" },
    { kind: "session_created", at: 3, sessionId: "s_consult" },
    { kind: "phase_entered", at: 4, phase: "extension_bind" },
    { kind: "phase_entered", at: 5, phase: "prompt_dispatch" },
    { kind: "session_event", at: 6, event: { t: "turn_start" } },
  ] satisfies RunInput[])
    s = apply(s, input).state;
  return s;
}

function first(at = 20): RunInput {
  return { kind: "session_event", at, event: { t: "consult_cache_first", result: cacheResult() } };
}

describe("consult cache/thread write-once diagnostics (§5.3, R2-4)", () => {
  it("writes prediction and thread at enqueue, but never a first-response slot from metadata", () => {
    const meta = consultMeta();
    // Defensive runtime check: structural/untyped producers may carry extra keys.
    Object.assign(meta.consultCache!, { first: { ...cacheResult(), at: -1 } });
    const s = running(meta);
    expect(s.diag.consultCache).toEqual({ v: 1, predicted: meta.consultCache!.predicted });
    expect(s.diag.consultThread).toEqual({ threadId: "ct_thread", seq: 2 });
    const repeated = apply(s, {
      kind: "enqueued",
      at: 10,
      budget,
      meta: {
        consultCache: { v: 1, predicted: { state: "cold" } },
        consultThread: { threadId: "ct_other", seq: 1 },
      },
    }).state;
    expect(repeated.diag.consultCache).toEqual(s.diag.consultCache);
    expect(repeated.diag.consultThread).toEqual(s.diag.consultThread);
  });

  it("records the event timestamp, not a result's untyped at; duplicate result is reference-equal no-op", () => {
    const s = running(consultMeta());
    const result = { ...cacheResult(), at: -100 };
    const r = apply(s, { kind: "session_event", at: 20, event: { t: "consult_cache_first", result } });
    expect(r.effects).toEqual([]);
    expect(r.state.diag.consultCache!.first).toEqual({ ...cacheResult(), at: 20 });
    expect(s.diag.consultCache).not.toHaveProperty("first");
    const again = apply(r.state, {
      kind: "session_event",
      at: 30,
      event: {
        t: "consult_cache_first",
        result: {
          v: 1,
          label: "miss",
          readShare: 0,
          anchor: "skipped:limit",
          degraded: true,
        },
      },
    });
    expect(again).toEqual({ state: r.state, effects: [] });
    expect(again.state).toBe(r.state);
  });

  it("stale generation cannot claim the first result or change prediction/thread", () => {
    const s = running(consultMeta());
    const stale = apply(s, first(), s.generation + 1);
    expect(stale.state).toEqual({ ...s, diag: { ...s.diag, staleInputs: s.diag.staleInputs + 1 } });
    expect(stale.effects).toEqual([]);
    expect(apply(stale.state, first(21)).state.diag.consultCache!.first!.at).toBe(21);
  });

  it("ordinary and legacy runs never acquire optional consult fields from an event alone", () => {
    for (const s of [
      createInitialState("r_plain", 1, 0),
      running(),
      apply(running(), { kind: "prompt_settled", at: 10 }).state,
    ]) {
      const r = apply(s, first());
      expect(r.state).toBe(s);
      for (const key of ["consultCache", "consultThread"]) expect(r.state.diag).not.toHaveProperty(key);
      expect(r.effects).toEqual([]);
    }
  });

  it("consultThread may exist without cache diagnostics (main/unknown evidence does not invent a cache result)", () => {
    const s = running({ consultThread: { threadId: "ct_independent", seq: 3 } });
    const r = apply(s, first());
    expect(r.state).toBe(s);
    expect(r.state.diag).not.toHaveProperty("consultCache");
    expect(r.state.diag.consultThread).toEqual({ threadId: "ct_independent", seq: 3 });
  });
});

describe("consult_cache_first seeded property invariants", () => {
  it("touches only first once; never alters liveness, usage, phases, deadlines or execution outcomes", () => {
    let writes = 0;
    let duplicates = 0;
    let terminalNoops = 0;
    let stale = 0;
    let absent = 0;
    const op = fc.constantFrom(
      "first",
      "first",
      "stale",
      "text",
      "turn",
      "tool",
      "compact",
      "requeue",
      "stop",
      "settle",
      "reap",
    );
    fc.assert(
      fc.property(fc.boolean(), fc.array(op, { minLength: 20, maxLength: 60 }), (withMeta, ops) => {
        let state = running(withMeta ? consultMeta() : undefined);
        const frozenPrediction = state.diag.consultCache?.predicted;
        const frozenThread = state.diag.consultThread;
        for (const [i, action] of ops.entries()) {
          const at = 20 + i;
          let input: RunInput;
          switch (action) {
            case "first":
            case "stale":
              input = first(at);
              break;
            case "text":
              input = { kind: "session_event", at, event: { t: "text_delta", delta: "answer" } };
              break;
            case "turn":
              input = { kind: "session_event", at, event: { t: "turn_start" } };
              break;
            case "tool":
              input = { kind: "session_event", at, event: { t: "tool_start", toolCallId: `t${i}`, toolName: "read" } };
              break;
            case "compact":
              input = { kind: "session_event", at, event: { t: "compaction_start", reason: "threshold" } };
              break;
            case "requeue":
              input = {
                kind: "enqueued",
                at,
                budget,
                meta: {
                  consultCache: { v: 1, predicted: { state: "cold" } },
                  consultThread: { threadId: "replacement", seq: 99 },
                },
              };
              break;
            case "stop":
              input = { kind: "stop_requested", at, cause: "user_stop" };
              break;
            case "settle":
              input = { kind: "prompt_settled", at, finalText: "done" };
              break;
            case "reap":
              input = { kind: "reap_finished", at, disposed: true, orphaned: false };
              break;
            default:
              throw new Error(`unknown op ${action}`);
          }
          const before = structuredClone(state);
          const result = apply(state, input, action === "stale" ? state.generation + 1 : state.generation);
          expect(state).toEqual(before); // reducer is immutable
          if (action === "stale") {
            stale++;
            expect(result.state).toEqual({
              ...state,
              diag: { ...state.diag, staleInputs: state.diag.staleInputs + 1 },
            });
            expect(result.effects).toEqual([]);
          } else if (action === "first") {
            expect(result.effects).toEqual([]);
            const cache = state.diag.consultCache;
            if (isTerminalStatus(state.status) || cache === undefined || cache.first !== undefined) {
              expect(result.state).toBe(state);
              if (isTerminalStatus(state.status)) terminalNoops++;
              if (cache === undefined) absent++;
              if (cache?.first !== undefined) duplicates++;
            } else {
              writes++;
              expect(result.state).toEqual({
                ...state,
                diag: {
                  ...state.diag,
                  consultCache: {
                    ...cache,
                    first: { ...cacheResult(), at },
                  },
                },
              });
            }
          } else if (state.diag.consultCache?.first !== undefined) {
            expect(result.state.diag.consultCache?.first).toEqual(state.diag.consultCache.first);
          }
          expect(result.state.diag.consultCache?.predicted).toEqual(frozenPrediction);
          expect(result.state.diag.consultThread).toEqual(frozenThread);
          if (!withMeta) {
            expect(result.state.diag).not.toHaveProperty("consultCache");
            expect(result.state.diag).not.toHaveProperty("consultThread");
          }
          state = result.state;
        }
      }),
      { seed: 0xca4e, numRuns: 200 },
    );
    // Every guarded path must really have been exercised.
    expect(writes).toBeGreaterThan(20);
    expect(duplicates).toBeGreaterThan(20);
    expect(terminalNoops).toBeGreaterThan(20);
    expect(stale).toBeGreaterThan(20);
    expect(absent).toBeGreaterThan(20);
  });
});
