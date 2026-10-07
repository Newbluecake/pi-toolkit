import { describe, expect, it } from "vitest";
import {
  interruptedFromJournal,
  JOURNAL_TASK_PROMPT_CAP,
  journalSnapshotFromState,
  restartInterruptedMessage,
} from "../../src/core/run-journal.js";
import { createInitialState } from "../../src/core/state-machine.js";
import type { RunDiagnostics, RunSnapshot, RunState } from "../../src/core/types.js";

/** A live (non-terminal) state whose diag carries EVERY field — retained and dropped alike. */
function richState(over: Partial<RunDiagnostics> = {}): RunState {
  const base = createInitialState("r_rich", 1, 1_000, "r_parent");
  const diag: RunDiagnostics = {
    ...base.diag,
    createdAt: 1_000,
    enqueuedAt: 1_000,
    startedAt: 1_010,
    promptDispatchedAt: 1_020,
    phase: "model_turn",
    phaseEnteredAt: 1_030,
    lastEventAt: 1_040,
    lastEventType: "text_delta",
    lastTurnStartAt: 1_035,
    currentTool: { name: "bash", toolCallId: "t1", startedAt: 1_036 },
    pendingTools: 1,
    turns: 3,
    retry: { attempt: 1, maxAttempts: 3, delayMs: 10, startedAt: 1_037 },
    compacting: { reason: "threshold", startedAt: 1_038 },
    usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, costUsd: 0.5 },
    absorbedRunIds: ["r_x"],
    contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
    model: { provider: "anthropic", id: "claude" },
    label: "worker",
    agentType: "general",
    taskPrompt: "p".repeat(4096),
    toolHistory: [{ name: "bash", toolCallId: "t0", startedAt: 1_031, endedAt: 1_032 }],
    worktree: { state: "active" },
    toolCounts: { bash: 2 },
    stopRequestedAt: 1_041,
    stopCause: "user_stop",
    timeoutReason: "idle",
    error: { kind: "model", message: "boom", retryable: false },
    escalation: [{ level: "L0", at: 1_042, ok: true }],
    orphaned: false,
    generation: 1,
    deadlineAt: 9_000,
    hardDeadlineAt: 10_000,
    overtime: { graces: 1, extensions: 1, grantedMs: 1_000, lastReason: "more", lastSource: "tool" },
    degraded: [{ effect: "dispose", at: 1_043, error: "x", compensated: true }],
    persistStatus: "verifying",
    staleInputs: 2,
    unkillable: [{ kind: "process", id: "1" }],
    deliveryKey: "k",
    lastWarn: "w",
    text: "partial answer",
    textFinal: true,
    thinkingText: "thinking…",
    sessionFile: "/tmp/sess.jsonl",
    exitFacts: { bashJobs: [] },
    finalLeafId: "leaf",
    contextSwitches: { count: 1, rejected: [{ reason: "x", at: 1_044 }] },
    compactionFailures: [],
    lastCompactionOkAt: 1_039,
    childExtensionMissing: true,
    ...over,
  };
  return { ...base, status: "running", phase: "model_turn", diag };
}

const RETAINED = [
  "createdAt",
  "enqueuedAt",
  "startedAt",
  "promptDispatchedAt",
  "phase",
  "phaseEnteredAt",
  "lastEventAt",
  "lastEventType",
  "pendingTools",
  "turns",
  "usage",
  "contextUsage",
  "model",
  "label",
  "agentType",
  "taskPrompt",
  "worktree",
  "toolCounts",
  "stopRequestedAt",
  "stopCause",
  "timeoutReason",
  "error",
  "orphaned",
  "generation",
  "deadlineAt",
  "hardDeadlineAt",
  "overtime",
  "staleInputs",
  "sessionFile",
  "childExtensionMissing",
  "escalation",
  "degraded",
  "unkillable",
].sort();

describe("journalSnapshotFromState (run-persistence plan D3)", () => {
  it("keeps exactly the whitelisted diag fields, resets the required arrays, and never carries an outcome", () => {
    const state = richState();
    const snap = journalSnapshotFromState(state, 2_000, { kind: "session_created" });
    expect(Object.keys(snap.diag).sort()).toEqual(RETAINED);
    for (const dropped of [
      "text",
      "textFinal",
      "thinkingText",
      "toolHistory",
      "currentTool",
      "retry",
      "compacting",
      "absorbedRunIds",
      "contextSwitches",
      "compactionFailures",
      "exitFacts",
      "finalLeafId",
      "persistStatus",
      "deliveryKey",
      "lastWarn",
      "lastTurnStartAt",
      "lastCompactionOkAt",
    ])
      expect(snap.diag).not.toHaveProperty(dropped);
    expect(snap.diag.escalation).toEqual([]);
    expect(snap.diag.degraded).toEqual([]);
    expect(snap.diag.unkillable).toEqual([]);
    expect(snap).not.toHaveProperty("outcome");
    expect(snap.diag.usage).toEqual(state.diag.usage);
    expect(snap.diag.sessionFile).toBe("/tmp/sess.jsonl");
    // The live state itself is never mutated.
    expect(state.diag.text).toBe("partial answer");
    expect(state.diag.escalation).toHaveLength(1);
  });

  it("projects the top level: status/phase/deadlines/parentRunId, updatedAt = at, journal mark", () => {
    const state = richState();
    const snap = journalSnapshotFromState(state, 2_000, { kind: "shutdown_flush", shutdownReason: "reload" });
    expect(Object.keys(snap).sort()).toEqual(
      ["deadlines", "diag", "generation", "journal", "parentRunId", "phase", "runId", "status", "updatedAt"].sort(),
    );
    expect(snap).toMatchObject({
      runId: "r_rich",
      generation: 1,
      status: "running",
      phase: "model_turn",
      updatedAt: 2_000,
      parentRunId: "r_parent",
      journal: { kind: "shutdown_flush", shutdownReason: "reload" },
    });
    expect(snap.deadlines).toBe(state.deadlines);
    const plain = journalSnapshotFromState({ ...state, parentRunId: undefined } as unknown as RunState, 3, {
      kind: "session_created",
    });
    expect(plain).not.toHaveProperty("parentRunId");
    expect(plain.journal).toEqual({ kind: "session_created" });
    expect(plain.journal).not.toHaveProperty("shutdownReason");
  });

  it(`truncates taskPrompt to JOURNAL_TASK_PROMPT_CAP (${JOURNAL_TASK_PROMPT_CAP}); short prompts pass verbatim`, () => {
    expect(JOURNAL_TASK_PROMPT_CAP).toBe(1024);
    const long = journalSnapshotFromState(richState(), 1, { kind: "session_created" });
    expect(long.diag.taskPrompt).toHaveLength(1024);
    const short = journalSnapshotFromState(richState({ taskPrompt: "do it" }), 1, { kind: "session_created" });
    expect(short.diag.taskPrompt).toBe("do it");
  });

  it("stays under the 6 KiB size budget with every retained field at its upper bound", () => {
    // 1024 CJK chars (3 UTF-8 bytes each) is the worst-case prompt; the other
    // variable-length retained fields get generous upper-bound values.
    const tools = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`tool_name_number_${i}`, 99_999]));
    const state = richState({
      taskPrompt: "测".repeat(4096),
      label: "l".repeat(64),
      agentType: "a".repeat(64),
      model: { provider: "p".repeat(64), id: "m".repeat(128) },
      sessionFile: `/home/${"u".repeat(32)}/.pi/agent/sessions/--${"d".repeat(160)}--/2026-10-05T00-00-00-000Z_${"x".repeat(36)}.jsonl`,
      toolCounts: tools,
      usage: {
        input: 999_999_999,
        output: 999_999_999,
        cacheRead: 999_999_999,
        cacheWrite: 999_999_999,
        costUsd: 9_999.123456789,
      },
      contextUsage: { tokens: 999_999_999, contextWindow: 999_999_999, percent: 99.999999 },
      overtime: {
        graces: 99,
        grace: { startedAt: 1_759_000_000_000, until: 1_759_000_000_000 },
        extensions: 99,
        grantedMs: 999_999_999,
        lastReason: "r".repeat(200),
        lastSource: "tool",
      },
      worktree: { state: "kept", branch: `pi-agent-${"b".repeat(40)}`, path: `/tmp/${"w".repeat(120)}` },
      error: undefined,
    } as Partial<RunDiagnostics>);
    const snap = journalSnapshotFromState(state, 1_759_000_000_000, {
      kind: "shutdown_flush",
      shutdownReason: "resume",
    });
    const bytes = Buffer.byteLength(JSON.stringify(snap), "utf8");
    expect(bytes).toBeGreaterThan(3 * 1024); // the CJK prompt alone is 3 KiB — the fixture really is large
    expect(bytes).toBeLessThan(6 * 1024);
  });
});

describe("interruptedFromJournal (run-persistence plan D4/D7)", () => {
  function journal(over: Partial<RunDiagnostics> = {}, mark?: RunSnapshot["journal"]): RunSnapshot {
    const snap = journalSnapshotFromState(richState({ stopCause: undefined, ...over }), 5_000, {
      kind: "session_created",
    });
    if (mark === undefined) {
      const { journal: _drop, ...rest } = snap;
      return rest as RunSnapshot;
    }
    return { ...snap, journal: mark };
  }

  it("produces a terminal aborted snapshot with phase/outcome/error filled in", () => {
    const out = interruptedFromJournal(journal({}, { kind: "session_created" }));
    expect(out.status).toBe("aborted");
    expect(out.phase).toBe("settled");
    expect(out.updatedAt).toBe(5_000); // last-seen moment, never "now"
    expect(out).not.toHaveProperty("journal");
    expect(out.parentRunId).toBe("r_parent");
    expect(out.diag.phase).toBe("settled");
    expect(out.diag.phaseEnteredAt).toBe(5_000);
    expect(out.diag.settledAt).toBe(5_000);
    expect(out.diag.stopCause).toBe("shutdown");
    expect(out.diag.error?.kind).toBe("aborted");
    expect(out.diag.error?.retryable).toBe(false);
    expect(out.outcome).toBeDefined();
    expect(out.outcome!.status).toBe("aborted");
    expect(out.outcome!.runId).toBe("r_rich");
    expect(out.outcome!.turns).toBe(3);
    expect(out.outcome!.durationMs).toBe(4_000); // 5_000 - enqueuedAt 1_000
    expect(out.outcome!.error).toEqual(out.diag.error);
    expect(out.outcome!.diag).toBe(out.diag);
    expect(out.outcome!.usage).toEqual({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, costUsd: 0.5 });
    expect(out.diag.restartInterrupted).toEqual({
      lastStatus: "running",
      lastPhase: "model_turn",
      lastSeenAt: 5_000,
      source: "session_created",
    });
  });

  it("keeps an already-recorded stopCause and carries the shutdown_flush reason", () => {
    const out = interruptedFromJournal(
      journal({ stopCause: "user_stop" }, { kind: "shutdown_flush", shutdownReason: "reload" }),
    );
    expect(out.diag.stopCause).toBe("user_stop");
    expect(out.diag.restartInterrupted).toMatchObject({ source: "shutdown_flush", shutdownReason: "reload" });
    expect(out.outcome!.error!.message).toContain("interrupted by a pi restart (reload)");
  });

  it("treats an entry without a journal field as session_created (crash/kill)", () => {
    const out = interruptedFromJournal(journal({}, undefined));
    expect(out.diag.restartInterrupted?.source).toBe("session_created");
    expect(out.diag.restartInterrupted).not.toHaveProperty("shutdownReason");
    expect(out.outcome!.error!.message).toContain("(crash/kill)");
  });

  it("omits usage when unknown and never reports a negative duration", () => {
    const snap = journal({ usage: undefined }, { kind: "session_created" });
    const out = interruptedFromJournal({ ...snap, updatedAt: 500 });
    expect(out.outcome).not.toHaveProperty("usage");
    expect(out.outcome!.durationMs).toBe(0);
  });

  it("maps an in-flight worktree marker active → kept and appends the worktree warning", () => {
    const out = interruptedFromJournal(journal({ worktree: { state: "active" } }, { kind: "session_created" }));
    expect(out.diag.worktree).toEqual({ state: "kept" });
    expect(out.outcome!.error!.message).toContain("worktree changes may be uncommitted");
    const committed = interruptedFromJournal(
      journal({ worktree: { state: "committed", branch: "pi-agent-x" } }, { kind: "session_created" }),
    );
    expect(committed.diag.worktree).toEqual({ state: "committed", branch: "pi-agent-x" });
    const none = interruptedFromJournal(journal({ worktree: undefined }, { kind: "session_created" }));
    expect(none.diag).not.toHaveProperty("worktree");
    expect(none.outcome!.error!.message).not.toContain("worktree");
  });

  it("message names the run id and points at resume", () => {
    const msg = restartInterruptedMessage("r_abc", {
      lastStatus: "starting",
      lastPhase: "extension_bind",
      lastSeenAt: Date.UTC(2026, 9, 5),
      source: "session_created",
    });
    expect(msg).toContain('Agent({ resume: "r_abc"');
    expect(msg).toContain("still starting (phase extension_bind)");
    expect(msg).toContain("2026-10-05T00:00:00.000Z");
    expect(msg).toContain("crash/kill");
  });
});
