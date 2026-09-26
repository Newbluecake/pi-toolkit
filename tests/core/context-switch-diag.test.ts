import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { COMPACTION_FAILURES_CAP, createInitialState, reduce } from "../../src/core/state-machine.js";
import { isTerminalStatus } from "../../src/core/status.js";
import type { RunState, StampedInput } from "../../src/core/types.js";

/**
 * child-context-switch plan P0 (§2.3.1/§2.4, T-A/T-F4): the three new
 * best-effort diagnostic session_event kinds (`context_switch` /
 * `compaction_failed` / `switch_selfcheck_failed`) plus `switch_capability`
 * (§3.1 point 4) are handled in the exact same unconditional reduce() branch
 * as `context_usage` (see tests/core/usage.test.ts's "context usage
 * diagnostics" suite for the sibling coverage of that event): accepted in
 * EVERY RunState (including every terminal status and a stale generation),
 * pure diag patch, no effect, `lastEventAt`/`lastEventType`/phase/status
 * never touched, `staleInputs` never bumped for these four kinds specifically
 * (they bypass the generation check entirely, unlike a real stale input).
 */
const budget = { ...DEFAULT_BUDGET, totalMs: 10_000, queueWaitMs: 1_000, startupMs: 1_000, bindMs: 1_000 };

function apply(state: RunState, input: StampedInput["input"], at: number): RunState {
  return reduce(state, { generation: state.generation, input: { ...input, at } as StampedInput["input"] }, budget)
    .state;
}
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

const PHASES = [
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

const dropped = { fromEntryId: "e1", toEntryId: "e5", entries: 4, tokensBefore: 1000, tokensAfterEstimate: 100 };

describe("child-context-switch plan P0 (T-A/T-F4): best-effort diagnostic session_events", () => {
  const events = [
    { t: "context_switch" as const, seq: 1, keepRecent: true, dropped },
    { t: "compaction_failed" as const, reason: "threshold", message: "summarization failed" },
    { t: "switch_selfcheck_failed" as const, reason: "run-ended-after-switch" },
    { t: "switch_capability" as const, reason: "l1-event-shape" },
  ];

  for (const event of events) {
    it(`${event.t}: accepted in every phase (incl. terminal), diag-only, no effect, lastEventAt/lastEventType/status/phase untouched`, () => {
      for (const phase of PHASES) {
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
        const before = {
          status: state.status,
          phase: state.phase,
          armedTimers: state.armedTimers,
          lastEventAt: state.diag.lastEventAt,
          lastEventType: state.diag.lastEventType,
        };
        const result = reduce(
          state,
          { generation: state.generation, input: { kind: "session_event", at: 50, event } },
          budget,
        );
        expect(result.effects).toEqual([]);
        expect(result.state.status).toBe(before.status);
        expect(result.state.phase).toBe(before.phase);
        expect(result.state.armedTimers).toEqual(before.armedTimers);
        expect(result.state.diag.lastEventAt).toBe(before.lastEventAt);
        expect(result.state.diag.lastEventType).toBe(before.lastEventType);
        expect(result.state.diag.lastWarn).toBeUndefined();
      }
    });

    it(`${event.t}: a stale-generation input still applies the diag patch and does NOT bump staleInputs (same exemption as context_usage)`, () => {
      const before = runningState();
      const result = reduce(before, { generation: 999, input: { kind: "session_event", at: 51, event } }, budget);
      expect(result.effects).toEqual([]);
      expect(result.state.diag.staleInputs).toBe(0);
    });
  }

  it("terminal isolation is identical for all four: settling first, then delivering the event, leaves status/phase/effects untouched", () => {
    for (const event of events) {
      let s = runningState();
      s = apply(s, { kind: "prompt_settled", text: "done" } as never, 9);
      expect(isTerminalStatus(s.status)).toBe(true);
      const sealedStatus = s.status;
      const sealedPhase = s.phase;
      const result = reduce(s, { generation: s.generation, input: { kind: "session_event", at: 10, event } }, budget);
      expect(result.effects).toEqual([]);
      expect(result.state.status).toBe(sealedStatus);
      expect(result.state.phase).toBe(sealedPhase);
    }
  });
});

describe("child-context-switch plan P0 (T-A): diag.contextSwitches / diag.compactionFailures content", () => {
  it("context_switch increments count and records `last` verbatim (seq/keepRecent/at/dropped)", () => {
    let s = runningState();
    s = apply(
      s,
      { kind: "session_event", event: { t: "context_switch", seq: 1, keepRecent: true, dropped } } as never,
      10,
    );
    expect(s.diag.contextSwitches).toEqual({ count: 1, last: { seq: 1, keepRecent: true, at: 10, dropped } });
    const dropped2 = { ...dropped, toEntryId: "e9", entries: 6 };
    s = apply(
      s,
      { kind: "session_event", event: { t: "context_switch", seq: 2, keepRecent: false, dropped: dropped2 } } as never,
      20,
    );
    expect(s.diag.contextSwitches).toEqual({
      count: 2,
      last: { seq: 2, keepRecent: false, at: 20, dropped: dropped2 },
    });
  });

  it("switch_selfcheck_failed sets contextSwitches.selfcheck without touching count/last", () => {
    let s = runningState();
    s = apply(
      s,
      { kind: "session_event", event: { t: "context_switch", seq: 1, keepRecent: true, dropped } } as never,
      10,
    );
    s = apply(
      s,
      { kind: "session_event", event: { t: "switch_selfcheck_failed", reason: "run-ended-after-switch" } } as never,
      11,
    );
    expect(s.diag.contextSwitches?.count).toBe(1);
    expect(s.diag.contextSwitches?.last).toBeDefined();
    expect(s.diag.contextSwitches?.selfcheck).toEqual({ reason: "run-ended-after-switch", at: 11 });
  });

  it("switch_selfcheck_failed on its own (no prior successful switch) still writes count:0 + selfcheck", () => {
    let s = runningState();
    s = apply(
      s,
      { kind: "session_event", event: { t: "switch_selfcheck_failed", reason: "run-ended-after-switch" } } as never,
      10,
    );
    expect(s.diag.contextSwitches).toEqual({ count: 0, selfcheck: { reason: "run-ended-after-switch", at: 10 } });
  });

  it("switch_capability sets contextSwitches.capability, independent of count/selfcheck", () => {
    let s = runningState();
    s = apply(
      s,
      { kind: "session_event", event: { t: "switch_capability", reason: "l0-missing-export" } } as never,
      10,
    );
    expect(s.diag.contextSwitches).toEqual({ count: 0, capability: { reason: "l0-missing-export", at: 10 } });
  });

  it("compaction_failed appends to a bounded FIFO ring capped at COMPACTION_FAILURES_CAP (3)", () => {
    let s = runningState();
    for (let i = 1; i <= COMPACTION_FAILURES_CAP + 2; i++) {
      s = apply(
        s,
        { kind: "session_event", event: { t: "compaction_failed", reason: "threshold", message: `err${i}` } } as never,
        10 + i,
      );
    }
    expect(s.diag.compactionFailures).toHaveLength(COMPACTION_FAILURES_CAP);
    expect(s.diag.compactionFailures?.map((f) => f.message)).toEqual(["err3", "err4", "err5"]);
  });

  it("a switch before settle lands in outcome.diag.contextSwitches (finish copies diag, same as model_changed)", () => {
    let s = runningState();
    s = apply(
      s,
      { kind: "session_event", event: { t: "context_switch", seq: 1, keepRecent: true, dropped } } as never,
      10,
    );
    s = apply(s, { kind: "prompt_settled", text: "done" } as never, 11);
    expect(s.outcome?.diag.contextSwitches?.count).toBe(1);
  });
});

describe("child-context-switch plan P0 (T-F4): lastCompactionOkAt patch on a successful compaction_end", () => {
  it("records lastCompactionOkAt on a non-aborted, non-failed compaction_end", () => {
    let s = runningState();
    s = apply(s, { kind: "session_event", event: { t: "compaction_end", aborted: false } } as never, 30);
    expect(s.diag.lastCompactionOkAt).toBe(30);
  });

  it("does NOT record lastCompactionOkAt for a failed compaction_end", () => {
    let s = runningState();
    s = apply(s, { kind: "session_event", event: { t: "compaction_end", aborted: false, failed: true } } as never, 30);
    expect(s.diag.lastCompactionOkAt).toBeUndefined();
  });

  it("does NOT record lastCompactionOkAt for an aborted compaction_end", () => {
    let s = runningState();
    s = apply(s, { kind: "session_event", event: { t: "compaction_end", aborted: true } } as never, 30);
    expect(s.diag.lastCompactionOkAt).toBeUndefined();
  });

  it("a later success overwrites an earlier one", () => {
    let s = runningState();
    s = apply(s, { kind: "session_event", event: { t: "compaction_end", aborted: false } } as never, 30);
    s = apply(
      s,
      { kind: "session_event", event: { t: "tool_start", toolCallId: "t1", toolName: "bash" } } as never,
      31,
    );
    s = apply(s, { kind: "session_event", event: { t: "tool_end", toolCallId: "t1", isError: false } } as never, 32);
    s = apply(s, { kind: "session_event", event: { t: "compaction_end", aborted: false } } as never, 40);
    expect(s.diag.lastCompactionOkAt).toBe(40);
  });
});
