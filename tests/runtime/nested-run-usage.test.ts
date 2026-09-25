import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { createInitialState, reduce } from "../../src/core/state-machine.js";
import type { RunState, StampedInput } from "../../src/core/types.js";
import { mapEvent } from "../../src/runtime/session-driver.js";

/**
 * Nested-run spend absorption (usage-broadcast / HUD dedupe contract):
 *
 * A child run R that consults an expert (consult run C) or delegates via the
 * nested Agent tool (grandchild run G) gets the nested session's spend
 * delivered back on the *toolResult* message: pi emits `message_end` for the
 * toolResult (agent-core tool-placement.js), PiSessionDriver.bind maps it
 * through mapEvent, and the X9 accumulator sums its usage into R's
 * diag.usage. That part is by design ("the child session's spend rides on
 * this tool result", src/tools/usage.ts).
 *
 * What these tests pin down is the OTHER half of the contract the HUD needs:
 * the broadcast (subagent:usage) lists C/G as independent tracked runs, so a
 * consumer can only avoid double-counting if it can tell that C/G's cost is
 * already inside R's accumulator. The run ids riding on the toolResult
 * details (`runId` / `runIds` / `consultRunId`) are that marker, folded into
 * diag.absorbedRunIds by the same message_end reduction.
 */

const budget = { ...DEFAULT_BUDGET, totalMs: 10_000, queueWaitMs: 1_000, startupMs: 1_000, bindMs: 1_000 };

function apply(state: RunState, input: StampedInput["input"], at: number): RunState {
  return reduce(state, { generation: state.generation, input: { ...input, at } as StampedInput["input"] }, budget)
    .state;
}
/** A run parked in model_turn, ready to observe message_end events. */
function runningState(): RunState {
  let s = createInitialState("r_parent", 1, 0);
  s = apply(s, { kind: "enqueued", budget } as never, 0);
  s = apply(s, { kind: "slot_acquired" } as never, 1);
  s = apply(s, { kind: "phase_entered", phase: "session_create" } as never, 2);
  s = apply(s, { kind: "session_created", sessionId: "s" } as never, 3);
  s = apply(s, { kind: "phase_entered", phase: "extension_bind" } as never, 4);
  s = apply(s, { kind: "session_event", event: { t: "turn_start" } } as never, 5);
  return s;
}

/** The pi-side event shape for a toolResult message_end (usage-bearing). */
function toolResultEnd(details: Record<string, unknown>, costTotal: number) {
  return {
    type: "message_end",
    message: {
      role: "toolResult",
      usage: { input: 120, output: 60, cacheRead: 0, cacheWrite: 0, cost: { total: costTotal } },
      details,
    },
  };
}

describe("nested spend rides the parent's toolResult message_end (X9 chain)", () => {
  it("mapEvent + reduce: a consult toolResult's usage lands in the parent run's diag.usage", () => {
    // Consult run C cost $0.42; its spend rides the consult toolResult of R.
    const ev = mapEvent(toolResultEnd({ consultRunId: "run_c", outcome: "completed" }, 0.42));
    expect(ev).toMatchObject({ t: "message_end", usage: { costUsd: 0.42 } });
    const s = apply(runningState(), { kind: "session_event", event: ev! } as never, 6);
    expect(s.diag.usage?.costUsd).toBeCloseTo(0.42, 10);
  });

  it("the same holds for the nested Agent blocking result (details.runId)", () => {
    const ev = mapEvent(toolResultEnd({ runId: "run_g" }, 0.5));
    const s = apply(runningState(), { kind: "session_event", event: ev! } as never, 6);
    expect(s.diag.usage?.costUsd).toBeCloseTo(0.5, 10);
  });
});
