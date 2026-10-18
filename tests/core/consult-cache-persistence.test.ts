import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUN_CUSTOM_TYPE, seedRunStoreFromEntries, wrapWithRunLog } from "../../src/adapters/pi-run-log.js";
import { foldConsultCall } from "../../src/core/consult-summary.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { interruptedFromJournal, journalSnapshotFromState } from "../../src/core/run-journal.js";
import { createInitialState, reduce } from "../../src/core/state-machine.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { RunInput, RunSnapshot, RunState } from "../../src/core/types.js";
import type { Runner } from "../../src/service/ports.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import { cacheProbe, cacheResult, consultMeta } from "./consult-cache-fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const budget = { ...DEFAULT_BUDGET, totalMs: 60_000 };
function apply(state: RunState, input: RunInput) {
  return reduce(state, { generation: state.generation, input }, budget);
}
function live(withFields = true, withFirst = true): RunState {
  const dir = mkdtempSync(join(tmpdir(), "consult-cache-A-"));
  dirs.push(dir);
  const file = join(dir, "session.jsonl");
  writeFileSync(file, "");
  let s = createInitialState("r_consult", 1, 0, "r_asker");
  for (const input of [
    { kind: "enqueued", at: 0, budget, ...(withFields ? { meta: consultMeta() } : {}) },
    { kind: "slot_acquired", at: 1 },
    { kind: "phase_entered", at: 2, phase: "session_create" },
    { kind: "session_created", at: 3, sessionId: "s", sessionFile: file },
    { kind: "phase_entered", at: 4, phase: "model_turn" },
  ] satisfies RunInput[])
    s = apply(s, input).state;
  if (withFirst)
    s = apply(s, { kind: "session_event", at: 200, event: { t: "consult_cache_first", result: cacheResult() } }).state;
  if (withFields)
    s = {
      ...s,
      diag: { ...s.diag, consults: foldConsultCall(undefined, { result: "completed", cacheProbe: cacheProbe() }, 20) },
    };
  return s;
}
function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function assertFacts(actual: RunSnapshot["diag"], expected: RunSnapshot["diag"]) {
  expect(actual.consultCache).toEqual(expected.consultCache);
  expect(actual.consultThread).toEqual(expected.consultThread);
  expect(actual.consults).toEqual(expected.consults);
  if (expected.consultCache === undefined) expect(actual).not.toHaveProperty("consultCache");
  if (expected.consultThread === undefined) expect(actual).not.toHaveProperty("consultThread");
}

// Exercise real persistence/rebuild functions without changing their file domains.
describe("consult cache/thread persistence, no tombstone retention (2026-10-18 ruling)", () => {
  it.each(["session_created", "shutdown_flush"] as const)(
    "%s journal JSON -> interrupted terminal -> seed round trip",
    (kind) => {
      const state = live();
      const before = json(state);
      const journal = json(
        journalSnapshotFromState(state, 300, {
          kind,
          ...(kind === "shutdown_flush" ? { shutdownReason: "reload" as const } : {}),
        }),
      );
      assertFacts(journal.diag, state.diag);
      const interrupted = json(interruptedFromJournal(journal));
      expect(interrupted.status).toBe("aborted");
      assertFacts(interrupted.diag, state.diag);
      assertFacts(interrupted.outcome!.diag, state.diag);
      const entries = [{ type: "custom", customType: RUN_CUSTOM_TYPE, data: journal }];
      const store = new MemoryRunStore();
      expect(seedRunStoreFromEntries(store, json(entries))).toBe(1);
      const seeded = store.get(state.runId)!;
      expect(seeded.status).toBe("aborted");
      assertFacts(seeded.diag, state.diag);
      assertFacts(seeded.outcome!.diag, state.diag);
      expect(state).toEqual(before);
    },
  );

  it.each([false, true])(
    "prediction-only or full first metric survives terminal entries and fresh-store rebuild (first=%s)",
    (withFirst) => {
      const state = live(true, withFirst);
      const result = apply(state, { kind: "prompt_settled", at: 400, finalText: "answer" });
      expect(result.state.status).toBe("completed");
      const persist = result.effects.find((e) => e.effect.kind === "persist_snapshot")!.effect;
      if (persist.kind !== "persist_snapshot") throw new Error("missing persist_snapshot");
      assertFacts(persist.snapshot.diag, state.diag);
      assertFacts(persist.snapshot.outcome!.diag, state.diag);
      const entries: Array<{ type: string; customType: string; data: unknown }> = [];
      const store = wrapWithRunLog(new MemoryRunStore(), {
        appendEntry: (customType, data) => {
          entries.push({ type: "custom", customType, data: json(data) });
        },
        sessionManager: { getEntries: () => entries },
      });
      store.put(persist.snapshot);
      expect(store.verifyLanded(state.runId, state.generation)).toBe(true);
      const rebuilt = new MemoryRunStore();
      expect(seedRunStoreFromEntries(rebuilt, json(entries))).toBe(1);
      const restored = rebuilt.get(state.runId)!;
      assertFacts(restored.diag, state.diag);
      assertFacts(restored.outcome!.diag, state.diag);
      expect(restored.diag.consultCache?.first === undefined).toBe(!withFirst);
    },
  );

  it("SpawnService terminal rebuild copies consult run facts from outcome.diag unchanged", async () => {
    const terminal = apply(live(), { kind: "prompt_settled", at: 400, finalText: "answer" }).state.outcome!;
    const runner: Runner = { run: async (spec) => ({ ...json(terminal), runId: spec.runId }) };
    const service = createSpawnService({
      runner,
      types: {
        get: () => ({ name: "worker", description: "", systemPrompt: "", promptMode: "append" }),
        list: () => [],
        reload: async () => ({ types: [], errors: [] }),
      },
      pool: { acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }) },
      now: () => 500,
    });
    const started = await service.spawn({ type: "worker", prompt: "x" });
    if ("error" in started) throw new Error(started.error.message);
    const settled = await service.waitOutcome(started.runId, 1000);
    expect(settled.kind).toBe("settled");
    const snapshot = service.snapshots().find((s) => s.runId === started.runId)!;
    expect(snapshot.status).toBe("completed");
    assertFacts(snapshot.diag, terminal.diag);
    assertFacts(snapshot.outcome!.diag, terminal.diag);
  });

  it("old/ordinary runs remain field-absent on every persistence surface", () => {
    const state = live(false);
    const journal = json(journalSnapshotFromState(state, 300, { kind: "shutdown_flush" }));
    assertFacts(journal.diag, state.diag);
    const interrupted = interruptedFromJournal(journal);
    assertFacts(interrupted.diag, state.diag);
    const terminal = apply(state, { kind: "prompt_settled", at: 400 }).state;
    assertFacts(terminal.diag, state.diag);
    assertFacts(terminal.outcome!.diag, state.diag);
    const store = new MemoryRunStore();
    seedRunStoreFromEntries(store, [{ type: "custom", customType: RUN_CUSTOM_TYPE, data: journal }]);
    assertFacts(store.get(state.runId)!.diag, state.diag);
  });
});
