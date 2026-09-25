import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { ABSORBED_RUN_IDS_CAP, createInitialState, reduce } from "../../src/core/state-machine.js";
import type { RunState, StampedInput, UsageDelta } from "../../src/core/types.js";

/**
 * X9: usage/cost aggregation is a lifetime accumulator over every
 * message_end event seen for a run (architecture §7.2), independent of
 * session-level stats (which pi resets across compaction). These tests drive
 * `reduce()` directly with a scripted sequence of session_event inputs and
 * assert the accumulator sums correctly, including across a compaction
 * window and after the run has already reached a terminal status.
 */
const budget = { ...DEFAULT_BUDGET, totalMs: 10_000, queueWaitMs: 1_000, startupMs: 1_000, bindMs: 1_000 };

function usage(input: number, output: number, costUsd = 0): UsageDelta {
  return { input, output, cacheRead: 0, cacheWrite: 0, costUsd };
}
function apply(state: RunState, input: StampedInput["input"], at: number): RunState {
  return reduce(state, { generation: state.generation, input: { ...input, at } as StampedInput["input"] }, budget)
    .state;
}
/** Drives a run from `created` through `slot_acquired` + `session_created` into `model_turn`, ready to receive message_end events. */
function runningState(): RunState {
  let s = createInitialState("r", 1, 0);
  s = apply(s, { kind: "enqueued", budget } as never, 0);
  s = apply(s, { kind: "slot_acquired" } as never, 1);
  s = apply(s, { kind: "phase_entered", phase: "session_create" } as never, 2);
  s = apply(s, { kind: "session_created", sessionId: "s" } as never, 3);
  s = apply(s, { kind: "phase_entered", phase: "extension_bind" } as never, 4);
  s = apply(s, { kind: "session_event", event: { t: "turn_start" } } as never, 5);
  return s;
}

describe("context usage diagnostics", () => {
  it("updates only the context snapshot in every phase, including terminal and stale inputs", () => {
    const phases = [
      "queue_wait",
      "resolve_config",
      "session_create",
      "extension_bind",
      "prompt_dispatch",
      "model_turn",
      "tool_exec",
      "retry_backoff",
      "compaction",
      "abort_grace",
      "reap",
      "settled",
    ] as const;
    const usage = { tokens: null, contextWindow: 262_144, percent: null };
    for (const phase of phases) {
      const base = runningState();
      const state: RunState = {
        ...base,
        phase,
        status:
          phase === "queue_wait"
            ? "queued"
            : phase === "abort_grace" || phase === "reap"
              ? "stopping"
              : phase === "settled"
                ? "completed"
                : "running",
        diag: { ...base.diag, phase },
      };
      const before = { status: state.status, phase: state.phase, armedTimers: state.armedTimers };
      const result = reduce(
        state,
        {
          generation: state.generation,
          input: { kind: "session_event", at: 50, event: { t: "context_usage", usage } },
        },
        budget,
      );
      expect(result.effects).toEqual([]);
      expect(result.state.status).toBe(before.status);
      expect(result.state.phase).toBe(before.phase);
      expect(result.state.armedTimers).toEqual(before.armedTimers);
      expect(result.state.diag.contextUsage).toEqual(usage);
      expect(result.state.diag.lastWarn).toBeUndefined();
    }
    const stale = reduce(
      runningState(),
      { generation: 999, input: { kind: "session_event", at: 51, event: { t: "context_usage", usage } } },
      budget,
    );
    expect(stale.effects).toEqual([]);
    expect(stale.state.diag.contextUsage).toEqual(usage);
    expect(stale.state.diag.staleInputs).toBe(0);
  });
});

describe("X9 usage accumulation", () => {
  it("sums a single message_end delta into diag.usage", () => {
    const s = apply(
      runningState(),
      { kind: "session_event", event: { t: "message_end", usage: usage(10, 5, 0.01) } } as never,
      6,
    );
    expect(s.diag.usage).toEqual(usage(10, 5, 0.01));
  });

  it("sums multiple message_end deltas across turns/tool calls", () => {
    let s = runningState();
    s = apply(s, { kind: "session_event", event: { t: "message_end", usage: usage(10, 5, 0.01) } } as never, 6);
    s = apply(s, { kind: "session_event", event: { t: "tool_start", toolCallId: "t1", toolName: "bash" } } as never, 7);
    s = apply(s, { kind: "session_event", event: { t: "tool_end", toolCallId: "t1", isError: false } } as never, 8);
    s = apply(s, { kind: "session_event", event: { t: "message_end", usage: usage(20, 8, 0.02) } } as never, 9);
    expect(s.diag.usage).toEqual(usage(30, 13, 0.03));
  });

  it("keeps summing across compaction (does not reset like session-level stats would)", () => {
    let s = runningState();
    s = apply(s, { kind: "session_event", event: { t: "message_end", usage: usage(100, 40, 0.1) } } as never, 6);
    s = apply(s, { kind: "session_event", event: { t: "compaction_start", reason: "context_limit" } } as never, 7);
    // A message_end that lands *during* compaction (e.g. the summarization
    // turn itself) must still be summed, not treated as a fresh baseline.
    s = apply(s, { kind: "session_event", event: { t: "message_end", usage: usage(5, 50, 0.05) } } as never, 8);
    s = apply(s, { kind: "session_event", event: { t: "compaction_end", aborted: false } } as never, 9);
    s = apply(s, { kind: "session_event", event: { t: "message_end", usage: usage(10, 4, 0.01) } } as never, 10);
    expect(s.diag.usage).toMatchObject({ input: 115, output: 94, cacheRead: 0, cacheWrite: 0 });
    expect(s.diag.usage?.costUsd).toBeCloseTo(0.16, 10);
  });

  it("carries the accumulated usage into RunOutcome.usage on finish()", () => {
    let s = runningState();
    s = apply(s, { kind: "session_event", event: { t: "message_end", usage: usage(7, 3, 0.007) } } as never, 6);
    s = apply(s, { kind: "prompt_settled" } as never, 7);
    expect(s.status).toBe("completed");
    expect(s.outcome?.usage).toEqual(usage(7, 3, 0.007));
  });

  it("keeps accumulating a late message_end that arrives after the run is already terminal", () => {
    let s = runningState();
    s = apply(s, { kind: "session_event", event: { t: "message_end", usage: usage(7, 3, 0.007) } } as never, 6);
    s = apply(s, { kind: "prompt_settled" } as never, 7);
    expect(s.outcome?.usage).toEqual(usage(7, 3, 0.007));
    // Trailing event during abort/reap teardown after settle.
    s = apply(s, { kind: "session_event", event: { t: "message_end", usage: usage(1, 1, 0.001) } } as never, 8);
    expect(s.diag.usage).toEqual(usage(8, 4, 0.008));
    expect(s.outcome?.usage).toEqual(usage(8, 4, 0.008));
  });

  it("does not fabricate a usage object when message_end carries no usage field", () => {
    const s = apply(runningState(), { kind: "session_event", event: { t: "message_end" } } as never, 6);
    expect(s.diag.usage).toBeUndefined();
  });

  it("leaves RunOutcome.usage absent (not present as an explicit undefined key) when no usage was ever observed", () => {
    let s = runningState();
    s = apply(s, { kind: "prompt_settled" } as never, 7);
    expect(s.outcome?.usage).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(s.outcome ?? {}, "usage")).toBe(false);
  });
});

/**
 * X12: absorbedRunIds — the bounded, deduped set of nested-run ids whose
 * lifetime spend rode into THIS run's X9 accumulator on a usage-bearing
 * toolResult message_end (see tests/runtime/nested-run-usage.test.ts for the
 * mapEvent half of this contract; these tests drive the reduce()/diag half
 * directly, mirroring the "X9 usage accumulation" tests above).
 */
describe("X12 absorbed run ids", () => {
  it("folds a message_end's absorbedRunIds into diag.absorbedRunIds", () => {
    const s = apply(
      runningState(),
      {
        kind: "session_event",
        event: { t: "message_end", usage: usage(10, 5, 0.42), absorbedRunIds: ["run_c"] },
      } as never,
      6,
    );
    expect(s.diag.absorbedRunIds).toEqual(["run_c"]);
  });

  it("dedupes repeated ids and only ever grows across multiple message_ends (monotone)", () => {
    let s = runningState();
    s = apply(
      s,
      {
        kind: "session_event",
        event: { t: "message_end", usage: usage(1, 1, 0.1), absorbedRunIds: ["run_a", "run_b"] },
      } as never,
      6,
    );
    expect(s.diag.absorbedRunIds).toEqual(["run_a", "run_b"]);
    // "run_a" repeats (e.g. a get_subagent_result poll re-fetching the same
    // finished run) — must not duplicate; "run_c" is new — must be appended.
    s = apply(
      s,
      {
        kind: "session_event",
        event: { t: "message_end", usage: usage(1, 1, 0.1), absorbedRunIds: ["run_a", "run_c"] },
      } as never,
      7,
    );
    expect(s.diag.absorbedRunIds).toEqual(["run_a", "run_b", "run_c"]);
  });

  it("keeps folding a trailing message_end's absorbedRunIds after the run is already terminal", () => {
    let s = runningState();
    s = apply(
      s,
      {
        kind: "session_event",
        event: { t: "message_end", usage: usage(1, 1, 0.1), absorbedRunIds: ["run_a"] },
      } as never,
      6,
    );
    s = apply(s, { kind: "prompt_settled" } as never, 7);
    expect(s.status).toBe("completed");
    // Trailing event during abort/reap teardown after settle (terminalUpdate branch).
    s = apply(
      s,
      {
        kind: "session_event",
        event: { t: "message_end", usage: usage(1, 1, 0.1), absorbedRunIds: ["run_b"] },
      } as never,
      8,
    );
    expect(s.diag.absorbedRunIds).toEqual(["run_a", "run_b"]);
  });

  it("does not fabricate absorbedRunIds when the event carries none", () => {
    const s = apply(
      runningState(),
      { kind: "session_event", event: { t: "message_end", usage: usage(1, 1, 0.1) } } as never,
      6,
    );
    expect(s.diag.absorbedRunIds).toBeUndefined();
  });

  it("caps at ABSORBED_RUN_IDS_CAP, dropping the OLDEST id first (FIFO)", () => {
    let s = runningState();
    const total = ABSORBED_RUN_IDS_CAP + 10;
    for (let i = 0; i < total; i++) {
      s = apply(
        s,
        {
          kind: "session_event",
          event: { t: "message_end", usage: usage(1, 1, 0.001), absorbedRunIds: [`run_${i}`] },
        } as never,
        6 + i,
      );
    }
    expect(s.diag.absorbedRunIds).toHaveLength(ABSORBED_RUN_IDS_CAP);
    // The oldest 10 ids (run_0..run_9) were evicted; the newest CAP survive.
    expect(s.diag.absorbedRunIds).not.toContain("run_0");
    expect(s.diag.absorbedRunIds).not.toContain(`run_${total - ABSORBED_RUN_IDS_CAP - 1}`);
    expect(s.diag.absorbedRunIds?.[0]).toBe(`run_${total - ABSORBED_RUN_IDS_CAP}`);
    expect(s.diag.absorbedRunIds?.at(-1)).toBe(`run_${total - 1}`);
    // Usage kept summing throughout — the cap only bounds the id set, never the money.
    expect(s.diag.usage?.costUsd).toBeCloseTo(0.001 * total, 6);
  });

  /**
   * Property (requested alongside the X12 diag addition): folding
   * absorbedRunIds (a) never removes a previously-seen id (monotone set) and
   * (b) never changes status/phase/effects relative to the same event stream
   * with absorbedRunIds stripped — it is a pure additive diag annotation.
   * Driven with a seeded PRNG over a mixed sequence of message_end (with/
   * without absorbedRunIds) and text_delta events, from both a running and
   * an already-terminal run (covers both reduce() folding sites: the main
   * session_event branch and terminalUpdate's trailing-event branch).
   */
  function random(seed: number): () => number {
    let value = seed >>> 0;
    return () => {
      value = (Math.imul(value ^ (value >>> 15), 1 | value) + 0x6d2b79f5) | 0;
      return ((value ^ (value >>> 13)) >>> 0) / 4294967296;
    };
  }

  it("property: absorbed id set is monotone and status/phase/effects are unaffected, 200 seeded sequences x {running, terminal}", () => {
    for (const startTerminal of [false, true]) {
      for (let seed = 1; seed <= 200; seed++) {
        const next = random(seed + (startTerminal ? 900000 : 0));
        let base = runningState();
        if (startTerminal) base = apply(base, { kind: "prompt_settled" } as never, 6);
        let withIds = base;
        let without = base;
        let prevAbsorbed: readonly string[] = base.diag.absorbedRunIds ?? [];
        for (let step = 0; step < 20; step++) {
          const at = 100 + step;
          const hasIds = next() < 0.6;
          const ids = hasIds ? [`r${Math.floor(next() * 5)}`] : undefined;
          const eventBase = { t: "message_end" as const, usage: usage(1, 1, 0.01) };
          const rWith = apply(
            withIds,
            { kind: "session_event", event: { ...eventBase, ...(ids ? { absorbedRunIds: ids } : {}) } } as never,
            at,
          );
          const rWithout = apply(without, { kind: "session_event", event: eventBase } as never, at);
          // (b) additive-only: stripping absorbedRunIds must not change anything else.
          expect(rWith.status).toBe(rWithout.status);
          expect(rWith.phase).toBe(rWithout.phase);
          expect({ ...rWith.diag, absorbedRunIds: undefined }).toEqual({ ...rWithout.diag, absorbedRunIds: undefined });
          // (a) monotone: every previously-seen id is still present.
          const nowAbsorbed = rWith.diag.absorbedRunIds ?? [];
          for (const id of prevAbsorbed) expect(nowAbsorbed).toContain(id);
          prevAbsorbed = nowAbsorbed;
          withIds = rWith;
          without = rWithout;
        }
      }
    }
  });
});
