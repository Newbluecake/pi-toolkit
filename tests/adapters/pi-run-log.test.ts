import { describe, expect, it } from "vitest";
import { MemoryRunStore } from "../../src/core/store.js";
import {
  RUN_CUSTOM_TYPE,
  seedRunStoreFromEntries,
  WORKTREE_DISPOSITION_CUSTOM_TYPE,
  wrapWithRunLog,
} from "../../src/adapters/pi-run-log.js";
import { journalSnapshotFromState } from "../../src/core/run-journal.js";
import { createInitialState } from "../../src/core/state-machine.js";
import { isTerminalStatus } from "../../src/core/status.js";
import type { RunJournalMark, RunSnapshot, RunState, WorktreeDisposition } from "../../src/core/types.js";

function snapshot(textFinal?: true): RunSnapshot {
  const diag = {
    createdAt: 0,
    phase: "settled" as const,
    phaseEnteredAt: 1,
    pendingTools: 0,
    turns: 1,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
    text: "final answer",
    ...(textFinal ? { textFinal } : {}),
  };
  return {
    runId: "r1",
    generation: 1,
    status: "completed",
    phase: "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag,
    outcome: { runId: "r1", status: "completed", text: "final answer", turns: 1, durationMs: 1, diag },
    updatedAt: 1,
  };
}

describe("pi run log diagnostics persistence", () => {
  it("retains textFinal through the append-entry JSON round trip", () => {
    const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
    const store = wrapWithRunLog(new MemoryRunStore(), {
      appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
      sessionManager: { getEntries: () => entries },
    });
    store.put(snapshot(true));
    const persisted = JSON.parse(JSON.stringify(entries[0]!.data)) as RunSnapshot;
    expect(persisted.diag.text).toBe("final answer");
    expect(persisted.diag.textFinal).toBe(true);
    expect(entries[0]!.customType).toBe(RUN_CUSTOM_TYPE);

    const old = JSON.parse(JSON.stringify(snapshot().diag)) as { textFinal?: true };
    expect(old.textFinal).toBeUndefined();
  });
});

// G5a 补全（2026-10-04 事故）：stack 重建时把会话文件里的终态快照种回内存
// store，否则重启后 resolveResumeTarget 四源全空、终态 run 无法 resume。
describe("seedRunStoreFromEntries (restart resume seeding)", () => {
  function snap(runId: string, over: { status?: RunSnapshot["status"]; updatedAt?: number; file?: string } = {}) {
    const base = snapshot();
    const file = over.file ?? `/tmp/sess-${runId}.jsonl`;
    return {
      ...base,
      runId,
      status: over.status ?? base.status,
      updatedAt: over.updatedAt ?? 1,
      diag: { ...base.diag, sessionFile: file },
      outcome: { ...base.outcome!, runId },
    } as RunSnapshot;
  }
  const entry = (s: RunSnapshot) => ({ type: "custom", customType: RUN_CUSTOM_TYPE, data: s });
  const allExist = () => true;

  it("seeds terminal snapshots with existing session files; maps a running-only run to aborted", () => {
    const store = new MemoryRunStore();
    const seeded = seedRunStoreFromEntries(
      store,
      [
        entry(snap("r_done")),
        entry(snap("r_failed", { status: "failed" })),
        entry(snap("r_running", { status: "running" as RunSnapshot["status"] })),
        { type: "custom", customType: "subagent:notification", data: {} },
        { type: "message" },
      ],
      allExist,
    );
    // run-persistence plan D4: a run with only a non-terminal entry is seeded
    // as a synthesized terminal `aborted` snapshot (no longer skipped).
    expect(seeded).toBe(3);
    expect(store.get("r_done")?.status).toBe("completed");
    expect(store.get("r_failed")?.status).toBe("failed");
    expect(store.get("r_running")?.status).toBe("aborted");
    expect(store.get("r_running")?.diag.restartInterrupted).toBeDefined();
  });

  it("keeps only the latest snapshot per runId (updatedAt, then file order)", () => {
    const store = new MemoryRunStore();
    const older = snap("r1", { updatedAt: 100 });
    const newer = { ...snap("r1", { updatedAt: 200 }), generation: 2 } as RunSnapshot;
    seedRunStoreFromEntries(store, [entry(older), entry(newer)], allExist);
    expect(store.get("r1")?.updatedAt).toBe(200);
    expect(store.list()).toHaveLength(1);
    // Equal updatedAt: the LATER entry in the file wins (no generation tie-break).
    const tie = new MemoryRunStore();
    const first = { ...snap("r2", { updatedAt: 300 }), generation: 2 } as RunSnapshot;
    const second = { ...snap("r2", { updatedAt: 300, status: "failed" }), generation: 1 } as RunSnapshot;
    seedRunStoreFromEntries(tie, [entry(first), entry(second)], allExist);
    expect(tie.list()).toHaveLength(1);
    expect(tie.list()[0]!.status).toBe("failed");
  });

  it("skips snapshots whose session file no longer exists", () => {
    const store = new MemoryRunStore();
    const seeded = seedRunStoreFromEntries(store, [entry(snap("r_gone", { file: "/tmp/nope.jsonl" }))], () => false);
    expect(seeded).toBe(0);
    expect(store.get("r_gone")).toBeUndefined();
  });

  it("seeds the BASE store — never re-appends entries through the write-through wrapper", () => {
    const appended: unknown[] = [];
    const store = wrapWithRunLog(new MemoryRunStore(), {
      appendEntry: (_t, d) => appended.push(d),
      sessionManager: { getEntries: () => [] },
    });
    // 模拟 stack.ts 的接线：seed 只接触 base（这里直接断言种子路径不产生新条目）。
    const base = new MemoryRunStore();
    seedRunStoreFromEntries(base, [entry(snap("r1"))], allExist);
    const wrapped = wrapWithRunLog(base, {
      appendEntry: (_t, d) => appended.push(d),
      sessionManager: { getEntries: () => [] },
    });
    expect(appended).toHaveLength(0);
    expect(wrapped.get("r1")?.status).toBe("completed");
    expect(store.get("r1")).toBeUndefined();
  });
});

// run-persistence plan D4/D7 (docs/dev/subagent-run-persistence/plan.md §5 P2).
describe("seedRunStoreFromEntries: non-terminal journal entries (run-persistence plan D4/D7)", () => {
  const allExist = () => true;
  const entry = (s: unknown) => ({ type: "custom", customType: RUN_CUSTOM_TYPE, data: s });
  const disposition = (d: { runId: string; state: "committed" | "kept" | "clean"; at: number; branch?: string }) => ({
    type: "custom",
    customType: WORKTREE_DISPOSITION_CUSTOM_TYPE,
    data: d,
  });
  function live(
    runId: string,
    over: {
      file?: string | null;
      usage?: RunState["diag"]["usage"];
      worktree?: WorktreeDisposition;
      label?: string;
    } = {},
  ): RunState {
    const base = createInitialState(runId, 1, 1_000);
    const file = over.file === null ? undefined : (over.file ?? `/tmp/sess-${runId}.jsonl`);
    return {
      ...base,
      status: "running",
      phase: "model_turn",
      diag: {
        ...base.diag,
        phase: "model_turn",
        turns: 2,
        ...(file === undefined ? {} : { sessionFile: file }),
        ...(over.usage === undefined ? {} : { usage: over.usage }),
        ...(over.worktree === undefined ? {} : { worktree: over.worktree }),
        ...(over.label === undefined ? {} : { label: over.label }),
      },
    };
  }
  const journalOf = (state: RunState, at: number, mark: RunJournalMark = { kind: "session_created" }) =>
    JSON.parse(JSON.stringify(journalSnapshotFromState(state, at, mark))) as RunSnapshot;
  function terminalOf(runId: string, updatedAt: number, worktree?: WorktreeDisposition): RunSnapshot {
    const state = live(runId, worktree === undefined ? {} : { worktree });
    const diag = { ...state.diag, phase: "settled" as const, settledAt: updatedAt };
    return {
      runId,
      generation: 1,
      status: "completed",
      phase: "settled",
      deadlines: state.deadlines,
      diag,
      outcome: { runId, status: "completed", text: "done", turns: 2, durationMs: 1, diag },
      updatedAt,
    };
  }

  it("a terminal entry beats a non-terminal one even with a smaller updatedAt", () => {
    const store = new MemoryRunStore();
    seedRunStoreFromEntries(store, [entry(terminalOf("r1", 100)), entry(journalOf(live("r1"), 500))], allExist);
    expect(store.get("r1")?.status).toBe("completed");
    expect(store.get("r1")?.outcome?.text).toBe("done");
    expect(store.get("r1")?.diag.restartInterrupted).toBeUndefined();
  });

  it("same-class, same-updatedAt: the later entry in the file wins", () => {
    const store = new MemoryRunStore();
    const a = journalOf(live("r1", { label: "first" }), 500);
    const b = journalOf(live("r1", { label: "second" }), 500);
    seedRunStoreFromEntries(store, [entry(a), entry(b)], allExist);
    expect(store.get("r1")?.diag.label).toBe("second");
  });

  it("session_created + shutdown_flush: the flush entry wins and supplies source/reason/usage", () => {
    const store = new MemoryRunStore();
    const usage = { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, costUsd: 0.25 };
    seedRunStoreFromEntries(
      store,
      [
        entry(journalOf(live("r1"), 500)),
        entry(journalOf(live("r1", { usage }), 900, { kind: "shutdown_flush", shutdownReason: "reload" })),
      ],
      allExist,
    );
    const seeded = store.get("r1")!;
    expect(seeded.status).toBe("aborted");
    expect(seeded.updatedAt).toBe(900);
    expect(seeded.diag.restartInterrupted).toMatchObject({ source: "shutdown_flush", shutdownReason: "reload" });
    expect(seeded.outcome?.usage).toEqual(usage);
    expect(seeded.outcome?.error?.message).toContain("interrupted by a pi restart (reload)");
  });

  it("filters non-terminal entries whose sessionFile is missing or gone", () => {
    const store = new MemoryRunStore();
    const seeded = seedRunStoreFromEntries(
      store,
      [entry(journalOf(live("r_nofile", { file: null }), 500)), entry(journalOf(live("r_gone"), 500))],
      (p) => p !== "/tmp/sess-r_gone.jsonl",
    );
    expect(seeded).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it("synthesizes from a legacy non-terminal entry without a journal field", () => {
    const store = new MemoryRunStore();
    const legacy = journalOf(live("r1"), 500) as RunSnapshot & { journal?: unknown };
    delete legacy.journal;
    expect(seedRunStoreFromEntries(store, [entry(legacy)], allExist)).toBe(1);
    expect(store.get("r1")?.status).toBe("aborted");
    expect(store.get("r1")?.diag.restartInterrupted?.source).toBe("session_created");
  });

  it("folds the latest late worktree disposition into unresolved worktree states only", () => {
    const store = new MemoryRunStore();
    seedRunStoreFromEntries(
      store,
      [
        // r_active: synthesized (active → kept, no path) ⇒ overridden by the `at`-max disposition.
        entry(journalOf(live("r_active", { worktree: { state: "active" } }), 500)),
        disposition({ runId: "r_active", state: "kept", at: 10 }),
        disposition({ runId: "r_active", state: "committed", branch: "pi-agent-r_active", at: 20 }),
        disposition({ runId: "r_active", state: "clean", at: 15 }),
        // r_committed: terminal entry already committed ⇒ untouched.
        entry(terminalOf("r_committed", 600, { state: "committed", branch: "pi-agent-own" })),
        disposition({ runId: "r_committed", state: "kept", at: 30 }),
        // r_absent: terminal entry without any worktree ⇒ filled in.
        entry(terminalOf("r_absent", 600)),
        disposition({ runId: "r_absent", state: "clean", at: 40 }),
      ],
      allExist,
    );
    expect(store.get("r_active")?.diag.worktree).toEqual({ state: "committed", branch: "pi-agent-r_active" });
    expect(store.get("r_active")?.outcome?.diag.worktree).toEqual({ state: "committed", branch: "pi-agent-r_active" });
    expect(store.get("r_committed")?.diag.worktree).toEqual({ state: "committed", branch: "pi-agent-own" });
    expect(store.get("r_absent")?.diag.worktree).toEqual({ state: "clean" });
  });

  it("J1: after seeding, the base store holds terminal snapshots only", () => {
    const store = new MemoryRunStore();
    seedRunStoreFromEntries(
      store,
      [
        entry(journalOf(live("r1"), 500)),
        entry(journalOf(live("r2"), 500)),
        entry(journalOf(live("r2"), 700, { kind: "shutdown_flush", shutdownReason: "quit" })),
        entry(terminalOf("r3", 100)),
        entry(journalOf(live("r3"), 900)),
      ],
      allExist,
    );
    expect(store.list()).toHaveLength(3);
    for (const s of store.list()) {
      expect(isTerminalStatus(s.status)).toBe(true);
      expect(s.outcome).toBeDefined();
      expect(s).not.toHaveProperty("journal");
    }
  });
});

describe("wrapWithRunLog.journal (run-persistence plan D2/J2/J7)", () => {
  const journalEntry = () =>
    journalSnapshotFromState({ ...createInitialState("r_j", 1, 0), status: "starting", phase: "session_create" }, 5, {
      kind: "session_created",
    });

  it("appends a subagent:run entry but never puts into the base store", () => {
    const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
    const base = new MemoryRunStore();
    const store = wrapWithRunLog(base, {
      appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
      sessionManager: { getEntries: () => entries },
    });
    const snap = journalEntry();
    store.journal(snap);
    expect(entries).toEqual([{ type: "custom", customType: RUN_CUSTOM_TYPE, data: snap }]);
    expect(base.get("r_j")).toBeUndefined();
    expect(store.get("r_j")).toBeUndefined();
    expect(base.list()).toEqual([]);
  });

  it("swallows an appendEntry failure (stale ctx after /reload)", () => {
    const store = wrapWithRunLog(new MemoryRunStore(), {
      appendEntry: () => {
        throw new Error("stale extension context");
      },
      sessionManager: { getEntries: () => [] },
    });
    expect(() => store.journal(journalEntry())).not.toThrow();
    expect(store.get("r_j")).toBeUndefined();
  });
});
