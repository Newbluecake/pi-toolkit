import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { createInitialState, reduce, RUN_PHASES } from "../../src/core/state-machine.js";
import { isTerminalStatus } from "../../src/core/status.js";
import { interruptedFromJournal, journalSnapshotFromState } from "../../src/core/run-journal.js";
import { RUN_CUSTOM_TYPE, seedRunStoreFromEntries } from "../../src/adapters/pi-run-log.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { RunInput, RunPhase, RunState } from "../../src/core/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const budget = { ...DEFAULT_BUDGET, totalMs: 100_000, totalGraceMs: 0 };
const step = (state: RunState, input: RunInput, generation = state.generation) =>
  reduce(state, { generation, input }, budget);
const dispatch = (state: RunState, at = 10) =>
  step(state, { kind: "phase_entered", phase: "prompt_dispatch", at }).state;
const keys = ["promptDispatchedAt", "inputAcceptedAt", "promptOutcome"] as const;
const initial = (track = true) => createInitialState("r_input", 1, 0, undefined, track ? true : undefined);

// Explicit all-phase matrix for the enabled path, complementing core.test.ts's full INPUT_KINDS matrix.
function atPhase(phase: RunPhase, track = true): RunState {
  let s = step(initial(track), { kind: "enqueued", at: 0, budget }).state;
  if (phase === "queue_wait") return s;
  s = step(s, { kind: "slot_acquired", at: 1 }).state;
  if (phase === "resolve_config") return s;
  if (phase === "settled" || phase === "reap") {
    s = step(dispatch(s), { kind: "prompt_settled", at: 20 }).state;
    return phase === "reap" ? { ...s, phase, diag: { ...s.diag, phase } } : s;
  }
  return step(s, { kind: "phase_entered", phase, at: 2 }).state;
}

describe("W2 input acceptance evidence", () => {
  it("opts in without adding even a state key on the off path; marks dispatch synchronously, write-once", () => {
    expect(initial(false)).not.toHaveProperty("trackInput");
    const s = dispatch(initial());
    expect(s.diag.promptDispatchedAt).toBe(10);
    expect(dispatch(s, 30).diag.promptDispatchedAt).toBe(10);
    expect(s.diag).not.toHaveProperty("inputAcceptedAt");
    expect(s.diag).not.toHaveProperty("promptOutcome");
    expect(initial().diag).not.toHaveProperty("promptDispatchedAt");
  });

  it.each(RUN_PHASES)("%s: accepted/rejected are diag-only, write-once; terminal ignores", (phase) => {
    const before = atPhase(phase);
    for (const kind of ["input_accepted", "prompt_rejected"] as const) {
      const result = step(before, { kind, at: 40 });
      expect(result.effects).toEqual([]);
      if (isTerminalStatus(before.status)) expect(result.state).toBe(before);
      else {
        const patch = kind === "input_accepted" ? { inputAcceptedAt: 40 } : { promptOutcome: "rejected_pre_accept" };
        expect(result.state).toEqual({ ...before, diag: { ...before.diag, ...patch } });
        expect(step(result.state, { kind, at: 90 }).state).toBe(result.state);
      }
    }
  });

  it.each(RUN_PHASES)("%s: tracking off never writes any evidence", (phase) => {
    const s = atPhase(phase, false);
    const a = step(s, { kind: "input_accepted", at: 30 });
    const r = step(a.state, { kind: "prompt_rejected", at: 40 });
    expect(a.state).toBe(s);
    expect(r.state).toBe(s);
    expect(a.effects).toEqual([]);
    expect(r.effects).toEqual([]);
    for (const key of keys) expect(s.diag).not.toHaveProperty(key);
  });

  it("turn_start (including at zero) OR acceptance prevents proof of pre-accept rejection", () => {
    for (const proof of ["turn_start", "accepted"] as const) {
      const s = dispatch(initial());
      const input: RunInput =
        proof === "turn_start"
          ? { kind: "session_event", at: 0, event: { t: "turn_start" } }
          : { kind: "input_accepted", at: 0 };
      const seen = step(s, input).state;
      expect(step(seen, { kind: "prompt_rejected", at: 100 }).state).toBe(seen);
      expect(seen.diag).not.toHaveProperty("promptOutcome");
    }
  });

  it("stale-generation evidence cannot alter any marker", () => {
    const s = dispatch(initial());
    for (const kind of ["input_accepted", "prompt_rejected"] as const) {
      const r = step(s, { kind, at: 50 }, 9);
      expect(r.state.diag).toEqual({ ...s.diag, staleInputs: 1 });
      expect(r.effects).toEqual([]);
    }
  });

  it("200 seeded sequences: gate, first-write, rejection conditions and terminal freeze", () => {
    for (let seed = 1; seed <= 200; seed++) {
      let rand = seed;
      const next = () => (rand = (Math.imul(rand, 1664525) + 1013904223) >>> 0);
      const tracked = seed % 2 === 0;
      let s = atPhase("prompt_dispatch", tracked);
      for (let n = 1; n <= 40; n++) {
        const choice = next() % 5;
        const input: RunInput =
          choice === 0
            ? { kind: "input_accepted", at: n }
            : choice === 1
              ? { kind: "prompt_rejected", at: n }
              : choice === 2
                ? { kind: "session_event", at: n, event: { t: "turn_start" } }
                : choice === 3
                  ? { kind: "phase_entered", phase: "prompt_dispatch", at: n }
                  : { kind: "prompt_settled", at: n };
        const before = s;
        const r = step(s, input);
        s = r.state;
        for (const key of keys) {
          if (!tracked) expect(s.diag).not.toHaveProperty(key);
          if (before.diag[key] !== undefined || isTerminalStatus(before.status))
            expect(s.diag[key]).toBe(before.diag[key]);
        }
        if (input.kind === "input_accepted" || input.kind === "prompt_rejected") {
          expect(r.effects).toEqual([]);
          expect(s.diag.lastEventAt).toBe(before.diag.lastEventAt);
          if (tracked && !isTerminalStatus(before.status) && input.kind === "input_accepted")
            expect(s.diag.inputAcceptedAt).toBe(before.diag.inputAcceptedAt ?? n);
          if (
            tracked &&
            !isTerminalStatus(before.status) &&
            input.kind === "prompt_rejected" &&
            before.diag.inputAcceptedAt === undefined &&
            before.diag.lastTurnStartAt === undefined
          )
            expect(s.diag.promptOutcome).toBe("rejected_pre_accept");
        }
      }
    }
  });

  it.each(["before-dispatch", "attempted", "accepted", "rejected"] as const)(
    "crash window %s: actual reducer evidence survives JSON journal -> restart terminal rebuild",
    (window) => {
      const dir = mkdtempSync(join(tmpdir(), "input-marker-journal-"));
      dirs.push(dir);
      const file = join(dir, "child.jsonl");
      writeFileSync(file, "");
      let s = step(atPhase("extension_bind"), {
        kind: "session_created",
        at: 3,
        sessionId: "s",
        sessionFile: file,
      }).state;
      if (window !== "before-dispatch") s = dispatch(s);
      if (window === "accepted") s = step(s, { kind: "input_accepted", at: 15 }).state;
      if (window === "rejected") s = step(s, { kind: "prompt_rejected", at: 15 }).state;
      const journal = JSON.parse(JSON.stringify(journalSnapshotFromState(s, 20, { kind: "shutdown_flush" })));
      const rebuilt = interruptedFromJournal(journal);
      const store = new MemoryRunStore();
      expect(seedRunStoreFromEntries(store, [{ type: "custom", customType: RUN_CUSTOM_TYPE, data: journal }])).toBe(1);
      for (const diag of [journal.diag, rebuilt.diag, rebuilt.outcome!.diag, store.get(s.runId)!.diag]) {
        for (const key of keys) {
          if (s.diag[key] === undefined) expect(diag).not.toHaveProperty(key);
          else expect(diag[key]).toBe(s.diag[key]);
        }
      }
      // trackInput is ephemeral, not crash evidence. Absence of acceptance in a journal is NEVER retry proof.
      expect(journal).not.toHaveProperty("trackInput");
      expect(rebuilt.diag.restartInterrupted).toBeDefined();
    },
  );
});
