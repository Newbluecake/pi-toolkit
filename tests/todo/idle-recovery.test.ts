// Task59 Stage B1 — pure idle-recovery kernel: candidates, fingerprints/progress keys and the
// window/Stop accounting. No pi imports are needed here because src/todo/idle-recovery.ts is
// pure (no I/O, no timers). The final two describes are the #59 B1 minor-fix regressions: the
// explicit seen-cap latch (256/257/320 unique pairs, new-window and store decisions) and, for
// the store decisions only, a tiny in-memory session-log double drives the FROZEN store
// (src/todo/idle-recovery-store.ts is not modified by these fixes).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyHumanProof,
  computeRecoveryFingerprint,
  decideRecoveryAttempt,
  emptyRecoveryState,
  foldIdleRecoveryEntries,
  IDLE_RECOVERY_ENTRY,
  parseIdleRecoveryEntry,
  parseRecoveryHumanProof,
  readProgressKey,
  readRecoveryMetadataHint,
  recordRecoveryAttempt,
  RECOVERY_ATTEMPTS_PER_WINDOW,
  RECOVERY_PROGRESS_KEY_MAX_BYTES,
  RECOVERY_SEEN_CAP,
  sameRecoveryWindow,
  selectRecoveryCandidates,
  solveRecoveryAttempt,
  suppressRecoveryWindow,
  withRecoveryLatch,
  type PersistedRecoveryEntry,
  type RecoveryHumanProof,
  type RecoveryState,
  type SeenPair,
} from "../../src/todo/idle-recovery.js";
import { createIdleRecoveryStore, type RecoveryPlan } from "../../src/todo/idle-recovery-store.js";
import type { Task, TodoState } from "../../src/todo/state.js";

function task(overrides: Partial<Task> & { id: number }): Task {
  const id = overrides.id;
  return {
    subject: `task ${id}`,
    description: `description ${id}`,
    status: "in_progress",
    blocks: [],
    blockedBy: [],
    createdAt: 1_000 + id,
    updatedAt: 1_000 + id,
    ...overrides,
  };
}

function todo(tasks: Task[]): TodoState {
  return { tasks, nextId: Math.max(0, ...tasks.map((entry) => entry.id)) + 1 };
}

const PROOF = (overrides: Partial<RecoveryHumanProof> = {}): RecoveryHumanProof => ({
  sid: "s1",
  owner: "root",
  epoch: 1,
  inputId: "in-1",
  provenance: "strong-consumption",
  ...overrides,
});

function pairFor(target: Task, tasks: Task[], key = ""): SeenPair {
  return { fingerprint: computeRecoveryFingerprint(target, tasks), key };
}

function opened(proof: RecoveryHumanProof = PROOF(), sid = "s1", owner = "root"): RecoveryState {
  const result = applyHumanProof(emptyRecoveryState(sid), proof, { sid, owner });
  if (result.kind !== "opened") throw new Error(`expected opened, got ${result.kind}`);
  return result.state;
}

describe("idle-recovery: candidate selection", () => {
  it("returns nothing for an empty list, all-pending and all-completed lists", () => {
    expect(selectRecoveryCandidates(todo([]))).toEqual([]);
    expect(selectRecoveryCandidates(todo([task({ id: 1, status: "pending" })]))).toEqual([]);
    expect(selectRecoveryCandidates(todo([task({ id: 1, status: "completed" })]))).toEqual([]);
  });

  it("accepts an unarchived in_progress task whose dependencies are completed", () => {
    const tasks = [task({ id: 1, status: "completed" }), task({ id: 2, blockedBy: [1] })];
    const candidates = selectRecoveryCandidates(todo(tasks));
    expect(candidates.map((entry) => entry.taskId)).toEqual([2]);
    expect(candidates[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(candidates[0]?.progressKey).toBe("");
  });

  it("excludes archived, blocked, missing-dependency and cyclic in_progress tasks", () => {
    const tasks = [
      task({ id: 1, status: "completed" }),
      task({ id: 2, status: "pending" }),
      task({ id: 3, archivedAt: 5 }), // archived while in_progress: still never recoverable
      task({ id: 4, blockedBy: [2] }), // pending dependency
      task({ id: 5, blockedBy: [999] }), // missing dependency
      task({ id: 6, blockedBy: [7] }), // cycle 6 ⇄ 7
      task({ id: 7, blockedBy: [6] }),
      task({ id: 8, blockedBy: [1] }), // the one legal candidate
    ];
    expect(selectRecoveryCandidates(todo(tasks)).map((entry) => entry.taskId)).toEqual([8]);
  });

  it("sorts candidates by numeric task id", () => {
    const tasks = [task({ id: 10 }), task({ id: 2 }), task({ id: 31 })];
    expect(selectRecoveryCandidates(todo(tasks)).map((entry) => entry.taskId)).toEqual([2, 10, 31]);
  });

  it("excludes tasks owned by somebody else, and treats an unknown current owner as unconfirmable", () => {
    const tasks = [task({ id: 1, owner: "other" }), task({ id: 2, owner: "root" }), task({ id: 3 })];
    expect(selectRecoveryCandidates(todo(tasks), { owner: "root" }).map((entry) => entry.taskId)).toEqual([2, 3]);
    expect(selectRecoveryCandidates(todo(tasks)).map((entry) => entry.taskId)).toEqual([3]);
  });

  it("lets metadata NARROW eligibility only (disabled / waiting), never grant it", () => {
    const tasks = [
      task({ id: 1, metadata: { idleRecovery: { disabled: true } } }),
      task({ id: 2, metadata: { idleRecovery: { waiting: "user" } } }),
      task({ id: 3, metadata: { idleRecovery: { waiting: "approval" } } }),
      task({ id: 4, metadata: { idleRecovery: { waiting: "external" } } }),
      task({ id: 5, metadata: { idleRecovery: { waiting: "timer" } } }),
      task({ id: 6, metadata: { idleRecovery: { waiting: "someday" } } }), // unknown wait = wait
      task({ id: 7, metadata: { idleRecovery: { disabled: false } } }),
      task({ id: 8, metadata: { idleRecovery: "not-an-object" } }),
      task({ id: 9, metadata: { idleRecovery: { progressKey: "P1" } } }),
      task({ id: 10, metadata: { unrelated: "x" } }),
    ];
    expect(selectRecoveryCandidates(todo(tasks)).map((entry) => entry.taskId)).toEqual([7, 8, 9, 10]);
  });

  it("reads metadata hints through own data descriptors only (no getters/toJSON)", () => {
    const hostile: Record<string, unknown> = { unrelated: true };
    Object.defineProperty(hostile, "idleRecovery", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("getter must not run");
      },
    });
    expect(readRecoveryMetadataHint(hostile)).toEqual({ excluded: false });
    const metadata = {
      idleRecovery: {
        progressKey: "P1",
        toJSON() {
          throw new Error("toJSON must not run");
        },
      },
    };
    expect(readProgressKey(task({ id: 1, metadata }))).toEqual({ ok: true, key: "P1" });
    expect(readRecoveryMetadataHint(metadata)).toEqual({ excluded: false });
  });
});

describe("idle-recovery: malformed blockedBy fails closed (no TypeError, no getters)", () => {
  it("excludes a candidate whose blockedBy is not an array, without throwing", () => {
    const shapes: unknown[] = [undefined, null, "1", 12, {}, { length: 0 }, () => []];
    for (const blockedBy of shapes) {
      const malformed = { ...task({ id: 1 }), blockedBy } as unknown as Task;
      const sibling = task({ id: 2 });
      // the old kernel threw a TypeError iterating a non-array blockedBy; it now fails closed,
      // and a well-formed sibling in the same state is still selected (real replay unchanged).
      expect(() => selectRecoveryCandidates(todo([malformed, sibling]))).not.toThrow();
      expect(selectRecoveryCandidates(todo([malformed, sibling])).map((entry) => entry.taskId)).toEqual([2]);
    }
  });

  it("never invokes a blockedBy getter (own data descriptors only)", () => {
    let getterRuns = 0;
    const hostile: Record<string, unknown> = { ...task({ id: 1 }) };
    delete hostile.blockedBy;
    Object.defineProperty(hostile, "blockedBy", {
      enumerable: true,
      configurable: true,
      get() {
        getterRuns += 1;
        return [];
      },
    });
    // an accessor is not an own data value: the dependency list is unreadable ⇒ excluded.
    expect(selectRecoveryCandidates(todo([hostile as unknown as Task]))).toEqual([]);
    expect(getterRuns).toBe(0);
  });

  it("excludes a candidate whose reached dependency has an unreadable blockedBy (cycle unprovable)", () => {
    const dep = { ...task({ id: 1, status: "completed" }), blockedBy: "garbage" } as unknown as Task;
    const candidate = task({ id: 2, blockedBy: [1] });
    // dep is completed, but its own edges cannot be traversed ⇒ acyclicity is unprovable ⇒ out.
    expect(() => selectRecoveryCandidates(todo([dep, candidate]))).not.toThrow();
    expect(selectRecoveryCandidates(todo([dep, candidate]))).toEqual([]);
  });

  it("does not throw when a reached dependency's blockedBy is not iterable", () => {
    const dep = { ...task({ id: 1, status: "completed" }), blockedBy: undefined } as unknown as Task;
    const candidate = task({ id: 2, blockedBy: [1] });
    expect(() => selectRecoveryCandidates(todo([dep, candidate]))).not.toThrow();
    expect(selectRecoveryCandidates(todo([dep, candidate]))).toEqual([]);
  });

  it("an unreached malformed task never affects other candidates", () => {
    const unrelated = { ...task({ id: 9, status: "completed" }), blockedBy: 7 } as unknown as Task;
    const dep = task({ id: 3, status: "completed" });
    const candidate = task({ id: 2, blockedBy: [3] });
    expect(selectRecoveryCandidates(todo([unrelated, dep, candidate])).map((entry) => entry.taskId)).toEqual([2]);
  });
});

describe("idle-recovery: progress key (<= 64 UTF-8 bytes, invalid is excluded not truncated)", () => {
  it("defaults to the empty string when absent", () => {
    expect(readProgressKey(task({ id: 1 }))).toEqual({ ok: true, key: "" });
  });

  it("accepts exactly 64 bytes and rejects 65 bytes without truncating", () => {
    expect(readProgressKey(task({ id: 1, metadata: { idleRecovery: { progressKey: "a".repeat(64) } } }))).toEqual({
      ok: true,
      key: "a".repeat(64),
    });
    expect(readProgressKey(task({ id: 1, metadata: { idleRecovery: { progressKey: "a".repeat(65) } } }))).toEqual({
      ok: false,
    });
    // a rejected 65-byte key must not silently become its 64-byte prefix (collision).
    const candidates = selectRecoveryCandidates(
      todo([task({ id: 1, metadata: { idleRecovery: { progressKey: `${"a".repeat(64)}b` } } })]),
    );
    expect(candidates).toEqual([]);
  });

  it("counts UTF-8 bytes, not code points", () => {
    expect(RECOVERY_PROGRESS_KEY_MAX_BYTES).toBe(64);
    expect(readProgressKey(task({ id: 1, metadata: { idleRecovery: { progressKey: "é".repeat(32) } } }))).toEqual({
      ok: true,
      key: "é".repeat(32),
    });
    expect(readProgressKey(task({ id: 1, metadata: { idleRecovery: { progressKey: "é".repeat(33) } } }))).toEqual({
      ok: false,
    });
  });

  it("rejects non-string keys", () => {
    expect(readProgressKey(task({ id: 1, metadata: { idleRecovery: { progressKey: 42 } } }))).toEqual({ ok: false });
    expect(readProgressKey(task({ id: 1, metadata: { idleRecovery: { progressKey: null } } }))).toEqual({ ok: false });
  });
});

describe("idle-recovery: fingerprint identity", () => {
  const base = (): Task[] => [
    task({ id: 1, status: "completed" }),
    task({ id: 2, blockedBy: [1], subject: "Fix   the\tparser", description: "line one" }),
  ];

  it("ignores updatedAt, activeForm, unrelated metadata and the progress key", () => {
    const tasks = base();
    const target = tasks[1]!;
    const reference = computeRecoveryFingerprint(target, tasks);
    const edited = task({
      ...target,
      updatedAt: target.updatedAt + 5_000,
      activeForm: "fixing the parser",
      metadata: { idleRecovery: { progressKey: "P1" }, unrelated: [1, 2, 3] },
    });
    const editedTasks = [tasks[0]!, edited];
    expect(computeRecoveryFingerprint(edited, editedTasks)).toBe(reference);
  });

  it("treats whitespace-only subject/description reflow as the same work", () => {
    const tasks = base();
    const target = tasks[1]!;
    const reflowed = task({ ...target, subject: "Fix the parser", description: "  line   one  " });
    expect(computeRecoveryFingerprint(reflowed, [tasks[0]!, reflowed])).toBe(computeRecoveryFingerprint(target, tasks));
  });

  it("changes on real work changes: subject, description, owner, status, createdAt", () => {
    const tasks = base();
    const target = tasks[1]!;
    const reference = computeRecoveryFingerprint(target, tasks);
    for (const edited of [
      task({ ...target, subject: "Fix the parser properly" }),
      task({ ...target, description: "line two" }),
      task({ ...target, owner: "root" }),
      task({ ...target, createdAt: target.createdAt + 1 }),
      task({ ...target, status: "pending" }),
    ]) {
      expect(computeRecoveryFingerprint(edited, [tasks[0]!, edited])).not.toBe(reference);
    }
  });

  it("changes when a dependency completes but not when the edge array is reordered", () => {
    const tasks = [
      task({ id: 1, status: "completed" }),
      task({ id: 3, status: "completed" }),
      task({ id: 2, blockedBy: [1, 3] }),
    ];
    const target = tasks[2]!;
    const reordered = task({ ...target, blockedBy: [3, 1] });
    expect(computeRecoveryFingerprint(reordered, [tasks[0]!, tasks[1]!, reordered])).toBe(
      computeRecoveryFingerprint(target, tasks),
    );
    const reopened = [task({ id: 1, status: "in_progress" }), tasks[1]!, tasks[2]!];
    expect(computeRecoveryFingerprint(target, reopened)).not.toBe(computeRecoveryFingerprint(target, tasks));
  });

  it("survives hostile metadata (throwing toJSON) because nothing stringifies foreign objects", () => {
    const tasks = base();
    const target = tasks[1]!;
    const metadata = {
      toJSON() {
        throw new Error("toJSON must not run");
      },
    };
    expect(() => computeRecoveryFingerprint(task({ ...target, metadata }), tasks)).not.toThrow();
  });
});

describe("idle-recovery: window + Stop accounting", () => {
  it("starts with zero budget and refuses before any proof", () => {
    const state = emptyRecoveryState("s1");
    expect(decideRecoveryAttempt(state, [{ fingerprint: "a".repeat(64), key: "" }])).toMatchObject({
      allowed: false,
      reason: "no-window",
    });
  });

  it("ignores weak proofs: admission/interactive hand over but never open a window", () => {
    for (const provenance of ["admission", "interactive"] as const) {
      const state = emptyRecoveryState("s1");
      const result = applyHumanProof(state, PROOF({ provenance }), { sid: "s1", owner: "root" });
      expect(result.kind).toBe("ignored");
      if (result.kind === "ignored") expect(result.reason).toBe("weak-provenance");
      expect(result.state.open).toBe(false);
      expect(result.state.window).toBeUndefined();
    }
  });

  it("rejects proofs for another session or another owner", () => {
    const state = emptyRecoveryState("s1");
    const otherSid = applyHumanProof(state, PROOF({ sid: "s2" }), { sid: "s1", owner: "root" });
    expect(otherSid).toMatchObject({ kind: "ignored", reason: "sid-mismatch" });
    const otherOwner = applyHumanProof(state, PROOF({ owner: "someone" }), { sid: "s1", owner: "root" });
    expect(otherOwner).toMatchObject({ kind: "ignored", reason: "owner-mismatch" });
    expect(
      applyHumanProof(
        state,
        { sid: "s1", owner: "root", epoch: 0, inputId: "x", provenance: "strong-consumption" },
        { sid: "s1", owner: "root" },
      ),
    ).toMatchObject({
      kind: "ignored",
      reason: "invalid",
    });
  });

  it("opens a window and allows exactly two attempts per strong human window", () => {
    let state = opened();
    expect(state.open).toBe(true);
    expect(state.attemptsInWindow).toBe(0);
    const first = decideRecoveryAttempt(state, [{ fingerprint: "a".repeat(64), key: "" }]);
    expect(first).toMatchObject({ allowed: true, attemptNumber: 1 });
    state = recordRecoveryAttempt(first.state, first.allowed ? first.pairs : [], "ir_1");
    const second = decideRecoveryAttempt(state, [{ fingerprint: "b".repeat(64), key: "" }]);
    expect(second).toMatchObject({ allowed: true, attemptNumber: 2 });
    state = recordRecoveryAttempt(second.state, second.allowed ? second.pairs : [], "ir_2");
    expect(state.attemptsInWindow).toBe(RECOVERY_ATTEMPTS_PER_WINDOW);
    expect(decideRecoveryAttempt(state, [{ fingerprint: "c".repeat(64), key: "" }])).toMatchObject({
      allowed: false,
      reason: "window-exhausted",
    });
  });

  it("does not extend the budget when the progress key changes (P0 → P1 → P2)", () => {
    const tasks = [task({ id: 1 })];
    const target = tasks[0]!;
    let state = opened();
    state = recordRecoveryAttempt(state, [pairFor(target, tasks, "P0")], "ir_1");
    state = recordRecoveryAttempt(state, [pairFor(target, tasks, "P1")], "ir_2");
    expect(state.seen).toHaveLength(2);
    expect(decideRecoveryAttempt(state, [pairFor(target, tasks, "P2")])).toMatchObject({
      allowed: false,
      reason: "window-exhausted",
    });
  });

  it("charges every listed pair but only one window attempt per send", () => {
    const state = opened();
    const pairs = [
      { fingerprint: "a".repeat(64), key: "" },
      { fingerprint: "b".repeat(64), key: "P1" },
    ];
    const decision = decideRecoveryAttempt(state, pairs);
    expect(decision.allowed).toBe(true);
    const recorded = recordRecoveryAttempt(state, decision.allowed ? decision.pairs : [], "ir_1");
    expect(recorded.attemptsInWindow).toBe(1);
    expect(recorded.seen).toHaveLength(2);
  });

  it("refuses an already-seen (fingerprint, progressKey) pair without spending an attempt", () => {
    const pair = { fingerprint: "a".repeat(64), key: "P1" };
    let state = opened();
    state = recordRecoveryAttempt(state, [pair], "ir_1");
    expect(decideRecoveryAttempt(state, [pair])).toMatchObject({ allowed: false, reason: "seen" });
    expect(state.attemptsInWindow).toBe(1);
  });

  it("a Stop suppresses the window until a NEW strong consumption, never a duplicate proof", () => {
    let state = opened(PROOF({ epoch: 2, inputId: "in-2" }));
    state = suppressRecoveryWindow(state);
    expect(decideRecoveryAttempt(state, [{ fingerprint: "a".repeat(64), key: "" }])).toMatchObject({
      allowed: false,
      reason: "stopped",
    });
    const duplicate = applyHumanProof(state, PROOF({ epoch: 2, inputId: "in-2" }), { sid: "s1", owner: "root" });
    expect(duplicate).toMatchObject({ kind: "opened", fresh: false });
    expect(duplicate.state.stopped).toBe(true);
    expect(duplicate.state.attemptsInWindow).toBe(state.attemptsInWindow);
    const fresh = applyHumanProof(duplicate.state, PROOF({ epoch: 3, inputId: "in-3" }), { sid: "s1", owner: "root" });
    expect(fresh).toMatchObject({ kind: "opened", fresh: true });
    expect(fresh.state.stopped).toBe(false);
    expect(decideRecoveryAttempt(fresh.state, [{ fingerprint: "a".repeat(64), key: "" }])).toMatchObject({
      allowed: true,
      attemptNumber: 1,
    });
  });

  it("a new strong window resets the budget but a stale epoch is ignored", () => {
    let state = opened(PROOF({ epoch: 5, inputId: "in-5" }));
    state = recordRecoveryAttempt(state, [{ fingerprint: "a".repeat(64), key: "" }], "ir_1");
    const stale = applyHumanProof(state, PROOF({ epoch: 4, inputId: "in-4" }), { sid: "s1", owner: "root" });
    expect(stale).toMatchObject({ kind: "ignored", reason: "stale-epoch" });
    expect(stale.state.open).toBe(true);
    expect(stale.state.attemptsInWindow).toBe(1);
    const next = applyHumanProof(stale.state, PROOF({ epoch: 6, inputId: "in-6" }), { sid: "s1", owner: "root" });
    expect(next.state.attemptsInWindow).toBe(0);
    expect(next.state.seen).toHaveLength(1); // seen is per SESSION, not per window
  });

  it("latches on a same-epoch conflicting inputId (never guesses a window)", () => {
    const state = opened(PROOF({ epoch: 2, inputId: "in-2" }));
    const conflict = applyHumanProof(state, PROOF({ epoch: 2, inputId: "in-other" }), { sid: "s1", owner: "root" });
    expect(conflict.kind).toBe("conflict");
    expect(conflict.state.latch).toBe("window-conflict");
    expect(decideRecoveryAttempt(conflict.state, [{ fingerprint: "a".repeat(64), key: "" }])).toMatchObject({
      allowed: false,
      reason: "window-conflict",
    });
  });

  it("fail-closes the session when the seen set would exceed its cap (no eviction)", () => {
    const state = {
      ...opened(),
      seen: Array.from({ length: RECOVERY_SEEN_CAP - 1 }, (_, index) => ({
        fingerprint: index.toString(16).padStart(64, "0"),
        key: "",
      })),
    };
    const decision = decideRecoveryAttempt(state, [
      { fingerprint: "c".repeat(64), key: "" },
      { fingerprint: "d".repeat(64), key: "" },
    ]);
    expect(decision).toMatchObject({ allowed: false, reason: "seen-cap" });
    expect(decision.state.latch).toBe("seen-cap");
    expect(decision.state.seen).toHaveLength(RECOVERY_SEEN_CAP - 1); // never evicted to regain status
  });

  it("keeps the accounting latched across every further decision", () => {
    const latched = withRecoveryLatch(opened(), "persist-uncertain");
    expect(decideRecoveryAttempt(latched, [{ fingerprint: "a".repeat(64), key: "" }])).toMatchObject({
      allowed: false,
      reason: "persist-uncertain",
    });
  });

  it("solving an unresolved attempt clears the diagnostic list without refunding budget", () => {
    const state = recordRecoveryAttempt(opened(), [{ fingerprint: "a".repeat(64), key: "" }], "ir_1");
    expect(state.unresolved).toEqual(["ir_1"]);
    const solved = solveRecoveryAttempt(state, "ir_1");
    expect(solved.unresolved).toEqual([]);
    expect(solved.attemptsInWindow).toBe(1);
    expect(solved.seen).toHaveLength(1);
  });
});

describe("idle-recovery: entry parsing + replay fold", () => {
  const sid = "s1";
  const windowEntry = (overrides: Partial<PersistedRecoveryEntry> = {}): unknown => ({
    type: "custom",
    customType: IDLE_RECOVERY_ENTRY,
    data: { v: 1, kind: "window", sid, inputId: "in-1", epoch: 1, owner: "root", at: 1, ...overrides },
  });
  const attemptEntry = (attemptId: string, pairs: SeenPair[]): unknown => ({
    type: "custom",
    customType: IDLE_RECOVERY_ENTRY,
    data: { v: 1, kind: "attempt", sid, inputId: "in-1", epoch: 1, attemptId, pairs, at: 2 },
  });

  it("replays window + attempt + outcome + stop in order", () => {
    const entries = [
      windowEntry(),
      attemptEntry("ir_1", [{ fingerprint: "a".repeat(64), key: "P0" }]),
      attemptEntry("ir_2", [{ fingerprint: "b".repeat(64), key: "P1" }]),
      {
        type: "custom",
        customType: IDLE_RECOVERY_ENTRY,
        data: { v: 1, kind: "outcome", sid, attemptId: "ir_2", outcome: "unknown", at: 3 },
      },
      {
        type: "custom",
        customType: IDLE_RECOVERY_ENTRY,
        data: { v: 1, kind: "stop", sid, inputId: "in-1", epoch: 1, reason: "aborted", at: 4 },
      },
    ];
    const folded = foldIdleRecoveryEntries(entries, sid);
    expect(folded.corrupt).toBe(false);
    expect(folded.state).toMatchObject({ attemptsInWindow: 2, totalAttempts: 2, stopped: true, open: false });
    expect(folded.state.seen).toHaveLength(2);
    expect(folded.state.unresolved).toEqual(["ir_1"]);
    expect(folded.state.window).toEqual({ sid, inputId: "in-1", epoch: 1 });
  });

  it("never restores a live window from the log (a forged entry is not a proof)", () => {
    const folded = foldIdleRecoveryEntries([windowEntry()], sid);
    expect(folded.state.open).toBe(false);
    expect(folded.state.attemptsInWindow).toBe(0);
    expect(decideRecoveryAttempt(folded.state, [{ fingerprint: "a".repeat(64), key: "" }])).toMatchObject({
      allowed: false,
      reason: "no-window",
    });
  });

  it("ignores entries of another sid (a fork does not inherit budget/seen/stop)", () => {
    const foreign = [
      {
        type: "custom",
        customType: IDLE_RECOVERY_ENTRY,
        data: { v: 1, kind: "window", sid: "old", inputId: "in-1", epoch: 3, owner: "root", at: 1 },
      },
      {
        type: "custom",
        customType: IDLE_RECOVERY_ENTRY,
        data: {
          v: 1,
          kind: "attempt",
          sid: "old",
          inputId: "in-1",
          epoch: 3,
          attemptId: "ir_old",
          pairs: [{ fingerprint: "a".repeat(64), key: "" }],
          at: 2,
        },
      },
      {
        type: "custom",
        customType: IDLE_RECOVERY_ENTRY,
        data: { v: 1, kind: "stop", sid: "old", inputId: "in-1", epoch: 3, reason: "aborted", at: 3 },
      },
    ];
    const folded = foldIdleRecoveryEntries(foreign, "new");
    expect(folded.corrupt).toBe(false);
    expect(folded.state).toEqual(emptyRecoveryState("new"));
  });

  it("ignores foreign entry kinds and flags unparseable recovery entries as corrupt", () => {
    const entries = [
      { type: "message", message: { role: "user" } },
      { type: "custom", customType: "claude-code-todo-state", data: { v: 1, tasks: [], nextId: 1 } },
      { type: "custom", customType: IDLE_RECOVERY_ENTRY }, // no data
      {
        type: "custom",
        customType: IDLE_RECOVERY_ENTRY,
        data: { v: 2, kind: "window", sid, inputId: "in-1", epoch: 1, owner: "root" },
      },
      {
        type: "custom",
        customType: IDLE_RECOVERY_ENTRY,
        data: { v: 1, kind: "attempt", sid, inputId: "in-1", epoch: 1, attemptId: "ir_1", pairs: "nope" },
      },
    ];
    const folded = foldIdleRecoveryEntries(entries, sid);
    expect(folded.corrupt).toBe(true);
    expect(folded.state.latch).toBe("persist-uncertain");
  });

  it("parses entries through own data descriptors (getter/toJSON are never invoked)", () => {
    const data: Record<string, unknown> = { v: 1, kind: "window", inputId: "in-1", epoch: 1, owner: "root", at: 1 };
    Object.defineProperty(data, "sid", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("getter must not run");
      },
    });
    expect(parseIdleRecoveryEntry({ customType: IDLE_RECOVERY_ENTRY, data }, sid)).toEqual({ kind: "corrupt" });
    const ok = {
      v: 1,
      kind: "window",
      sid,
      inputId: "in-1",
      epoch: 1,
      owner: "root",
      at: 1,
      toJSON: () => {
        throw new Error("toJSON must not run");
      },
    };
    expect(parseIdleRecoveryEntry({ customType: IDLE_RECOVERY_ENTRY, data: ok }, sid).kind).toBe("entry");
  });

  it("does not guess a window on an epoch-conflicting window entry", () => {
    const entries = [windowEntry(), windowEntry({ inputId: "in-other" })];
    const folded = foldIdleRecoveryEntries(entries, sid);
    expect(folded.state.latch).toBe("window-conflict");
    expect(folded.state.window?.inputId).toBe("in-1");
  });

  it("rejects a proof whose fields are accessors (own-descriptor parse)", () => {
    const hostile = { owner: "root", epoch: 1, inputId: "in-1", provenance: "strong-consumption" };
    Object.defineProperty(hostile, "sid", { enumerable: true, get: () => "s1" });
    expect(parseRecoveryHumanProof(hostile)).toBeUndefined();
  });

  it("recognises a same window key and rejects a different one", () => {
    const window = { sid, inputId: "in-1", epoch: 1 };
    expect(sameRecoveryWindow(window, { ...window })).toBe(true);
    expect(sameRecoveryWindow(window, { ...window, epoch: 2 })).toBe(false);
    expect(sameRecoveryWindow(undefined, window)).toBe(false);
    expect(sameRecoveryWindow(undefined, undefined)).toBe(true);
  });
});

describe("idle-recovery: seen cap is an explicit fail-closed latch (no silent truncation)", () => {
  const sid = "s1";
  const pairAt = (n: number): SeenPair => ({ fingerprint: n.toString(16).padStart(64, "0"), key: "" });
  const windowAt = (inputId = "in-1", epoch = 1): unknown => ({
    type: "custom",
    customType: IDLE_RECOVERY_ENTRY,
    data: { v: 1, kind: "window", sid, inputId, epoch, owner: "root", at: 1 },
  });
  const bulkAttempt = (attemptId: string, from: number, count: number): unknown => ({
    type: "custom",
    customType: IDLE_RECOVERY_ENTRY,
    data: {
      v: 1,
      kind: "attempt",
      sid,
      inputId: "in-1",
      epoch: 1,
      attemptId,
      pairs: Array.from({ length: count }, (_, index) => pairAt(from + index)),
      at: 2,
    },
  });
  /** A window whose attempts charge exactly 256 unique pairs (4 × 64, the per-attempt parse cap). */
  const filled = (): unknown[] => [
    windowAt(),
    bulkAttempt("ir_a", 0, 64),
    bulkAttempt("ir_b", 64, 64),
    bulkAttempt("ir_c", 128, 64),
    bulkAttempt("ir_d", 192, 64),
  ];

  it("replay reaching exactly 256 unique pairs latches seen-cap and keeps budget/Stop", () => {
    const folded = foldIdleRecoveryEntries(filled(), sid);
    expect(folded.corrupt).toBe(false);
    expect(folded.state.seen).toHaveLength(RECOVERY_SEEN_CAP);
    expect(folded.state.latch).toBe("seen-cap"); // reaching the cap is explicit, never silent
    expect(folded.state.attemptsInWindow).toBe(4); // budget kept
    expect(folded.state.totalAttempts).toBe(4);
    expect(folded.state.stopped).toBe(false);
    expect(decideRecoveryAttempt(folded.state, [pairAt(999)])).toMatchObject({
      allowed: false,
      reason: "seen-cap",
    });
    expect(applyHumanProof(folded.state, PROOF({ epoch: 2, inputId: "in-2" }), { sid, owner: "root" })).toMatchObject({
      kind: "ignored",
      reason: "latched", // a new consumption window cannot bypass a full cap
    });
  });

  it("replay exceeding the cap (257 pairs) stays latched; the extra pair gains no eligibility", () => {
    const folded = foldIdleRecoveryEntries([...filled(), bulkAttempt("ir_e", 256, 1)], sid);
    expect(folded.state.latch).toBe("seen-cap");
    expect(folded.state.seen).toHaveLength(RECOVERY_SEEN_CAP);
    expect(folded.state.totalAttempts).toBe(5); // accounting continues past the latch
    const extra = pairAt(256);
    expect(folded.state.seen).not.toContainEqual(extra); // untracked after the latch...
    expect(decideRecoveryAttempt(folded.state, [extra])).toMatchObject({
      allowed: false,
      reason: "seen-cap", // ...and still unattemptable: no eviction amnesty, no bypass
    });
    expect(applyHumanProof(folded.state, PROOF({ epoch: 2, inputId: "in-2" }), { sid, owner: "root" })).toMatchObject({
      kind: "ignored",
      reason: "latched",
    });
  });

  it("replay of 320 unique pairs (5 × 64) stays fail-closed with bounded seen work", () => {
    const folded = foldIdleRecoveryEntries([...filled(), bulkAttempt("ir_e", 256, 64)], sid);
    expect(folded.state.latch).toBe("seen-cap");
    expect(folded.state.seen).toHaveLength(RECOVERY_SEEN_CAP); // post-latch charges add no entries
    expect(folded.state.totalAttempts).toBe(5);
    expect(folded.state.attemptsInWindow).toBe(5);
    expect(decideRecoveryAttempt(folded.state, [pairAt(400)])).toMatchObject({
      allowed: false,
      reason: "seen-cap",
    });
    expect(applyHumanProof(folded.state, PROOF({ epoch: 9, inputId: "in-9" }), { sid, owner: "root" })).toMatchObject({
      kind: "ignored",
      reason: "latched",
    });
  });

  it("a later window entry in the log cannot bypass the latched cap", () => {
    const folded = foldIdleRecoveryEntries([...filled(), windowAt("in-2", 2)], sid);
    expect(folded.state.window).toEqual({ sid, inputId: "in-2", epoch: 2 });
    expect(folded.state.attemptsInWindow).toBe(0); // per-window accounting continues...
    expect(folded.state.latch).toBe("seen-cap"); // ...but the latch survives the new window
    expect(folded.state.seen).toHaveLength(RECOVERY_SEEN_CAP);
    expect(decideRecoveryAttempt(folded.state, [pairAt(999)])).toMatchObject({
      allowed: false,
      reason: "seen-cap",
    });
  });

  it("a single charge crossing the cap keeps every pair (no eviction) and keeps budget/Stop", () => {
    const base = suppressRecoveryWindow({
      ...opened(),
      seen: Array.from({ length: RECOVERY_SEEN_CAP - 6 }, (_, index) => pairAt(index)),
    });
    const charge = Array.from({ length: 10 }, (_, index) => pairAt(RECOVERY_SEEN_CAP - 6 + index));
    const recorded = recordRecoveryAttempt(base, charge, "ir_cross");
    expect(recorded.seen).toHaveLength(RECOVERY_SEEN_CAP + 4); // nothing dropped, nothing evicted
    expect(recorded.latch).toBe("seen-cap");
    expect(recorded.attemptsInWindow).toBe(1); // budget kept
    expect(recorded.stopped).toBe(true); // Stop kept
    expect(decideRecoveryAttempt(recorded, [pairAt(999)])).toMatchObject({
      allowed: false,
      reason: "seen-cap",
    });
    expect(applyHumanProof(recorded, PROOF({ epoch: 2, inputId: "in-2" }), { sid, owner: "root" })).toMatchObject({
      kind: "ignored",
      reason: "latched",
    });
  });

  it("the live attempt that fills the cap exactly is the last allowed one and latches", () => {
    let state: RecoveryState = {
      ...opened(),
      seen: Array.from({ length: RECOVERY_SEEN_CAP - 1 }, (_, index) => pairAt(index)),
    };
    const decision = decideRecoveryAttempt(state, [pairAt(RECOVERY_SEEN_CAP - 1)]);
    expect(decision.allowed).toBe(true); // 255 + 1 = 256: the final charge that fits
    if (!decision.allowed) return;
    state = recordRecoveryAttempt(state, decision.pairs, "ir_last");
    expect(state.seen).toHaveLength(RECOVERY_SEEN_CAP);
    expect(state.latch).toBe("seen-cap"); // reaching the cap closes explicitly
    expect(state.attemptsInWindow).toBe(1);
    expect(decideRecoveryAttempt(state, [pairAt(999)])).toMatchObject({
      allowed: false,
      reason: "seen-cap",
    });
    expect(applyHumanProof(state, PROOF({ epoch: 2, inputId: "in-2" }), { sid, owner: "root" })).toMatchObject({
      kind: "ignored",
      reason: "latched",
    });
  });
});

describe("idle-recovery: seen cap closes the store (narrow store-decision regression)", () => {
  const pairAt = (n: number): SeenPair => ({ fingerprint: n.toString(16).padStart(64, "0"), key: "" });
  const hostFor = (entries: unknown[]) => ({
    getEntries: () => entries,
    appendCustomEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
      return entries.length;
    },
  });

  it("a replayed over-cap log (257 pairs) denies new windows, prepare and reserve", () => {
    const entries: unknown[] = [
      {
        type: "custom",
        customType: IDLE_RECOVERY_ENTRY,
        data: { v: 1, kind: "window", sid: "s1", inputId: "in-1", epoch: 1, owner: "root", at: 1 },
      },
      ...[0, 64, 128, 192].map((from, index) => ({
        type: "custom",
        customType: IDLE_RECOVERY_ENTRY,
        data: {
          v: 1,
          kind: "attempt",
          sid: "s1",
          inputId: "in-1",
          epoch: 1,
          attemptId: `ir_${index}`,
          pairs: Array.from({ length: 64 }, (_, offset) => pairAt(from + offset)),
          at: 2,
        },
      })),
      {
        type: "custom",
        customType: IDLE_RECOVERY_ENTRY,
        data: {
          v: 1,
          kind: "attempt",
          sid: "s1",
          inputId: "in-1",
          epoch: 1,
          attemptId: "ir_extra",
          pairs: [pairAt(256)],
          at: 3,
        },
      },
    ];
    const store = createIdleRecoveryStore({
      sessionId: "s1",
      owner: "root",
      ...hostFor(entries),
      now: () => 7,
    });
    const view = store.view();
    expect(view.latch).toBe("seen-cap");
    expect(view.seen).toHaveLength(RECOVERY_SEEN_CAP);
    const before = entries.length;
    expect(store.noteHumanProof(PROOF({ epoch: 2, inputId: "in-2" }))).toMatchObject({
      kind: "ignored",
      reason: "latched", // no new window off a full cap
    });
    expect(store.prepare({ todo: todo([task({ id: 1 })]) })).toMatchObject({
      kind: "denied",
      reason: "seen-cap",
    });
    expect(store.reserve({} as RecoveryPlan)).toMatchObject({ kind: "denied", reason: "seen-cap" });
    expect(entries).toHaveLength(before); // a latched store is inert: nothing was written
  });

  it("live reservations that fill the cap (2 windows × 2 × 64) latch; later windows/plans denied", () => {
    const entries: unknown[] = [];
    const store = createIdleRecoveryStore({
      sessionId: "s1",
      owner: "root",
      getEntries: () => entries,
      appendCustomEntry: (customType: string, data: unknown) => {
        entries.push({ type: "custom", customType, data });
        return entries.length;
      },
      now: () => 7,
      createAttemptId: (() => {
        let seq = 0;
        return () => `ir_${++seq}`;
      })(),
    });
    const pool = Array.from({ length: 256 }, (_, index) => task({ id: index + 1 }));
    expect(store.noteHumanProof(PROOF())).toMatchObject({ kind: "opened", fresh: true });
    for (let round = 0; round < 4; round++) {
      if (round === 2) {
        // window 1 is exhausted (2 attempts); a NEW strong window opens, seen set kept.
        expect(store.noteHumanProof(PROOF({ epoch: 2, inputId: "in-2" }))).toMatchObject({
          kind: "opened",
          fresh: true,
        });
      }
      const prepared = store.prepare({ todo: todo(pool.slice(round * 64, round * 64 + 64)) });
      expect(prepared.kind).toBe("ready");
      if (prepared.kind !== "ready") return;
      expect(store.reserve(prepared.plan).kind).toBe("reserved");
    }
    expect(store.view().seen).toHaveLength(RECOVERY_SEEN_CAP);
    expect(store.view().latch).toBe("seen-cap");
    expect(store.noteHumanProof(PROOF({ epoch: 3, inputId: "in-3" }))).toMatchObject({
      kind: "ignored",
      reason: "latched", // the new window cannot bypass the full cap
    });
    expect(store.prepare({ todo: todo([task({ id: 999 })]) })).toMatchObject({
      kind: "denied",
      reason: "seen-cap",
    });
  });
});

describe("idle-recovery: module boundary", () => {
  it("stays pi-free and keeps no module-scope mutable state (I4)", () => {
    for (const file of ["idle-recovery.ts", "idle-recovery-store.ts"]) {
      const source = readFileSync(new URL(`../../src/todo/${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/@earendil-works|@sinclair\/typebox/);
      expect(source).not.toMatch(/^(let|var) /m);
    }
  });
});

// 2026-11-08 ruling: trusted new-chat arrival is sufficient; no SDK consumption receipt.
describe("idle-recovery: host user-arrival windows", () => {
  const arrival = (overrides: Partial<RecoveryHumanProof> = {}): RecoveryHumanProof =>
    PROOF({ provenance: "user-arrival", ...overrides });
  const expected = { sid: "s1", owner: "root" };

  it("parses host user-arrival and opens immediately, retaining strong-consumption compatibility", () => {
    for (const provenance of ["user-arrival", "strong-consumption"] as const) {
      const proof = PROOF({ provenance });
      expect(parseRecoveryHumanProof(proof)).toEqual(proof);
      expect(applyHumanProof(emptyRecoveryState("s1"), proof, expected)).toMatchObject({
        kind: "opened",
        fresh: true,
        state: { open: true, attemptsInWindow: 0, stopped: false },
      });
    }
  });

  it("clears Stop only on a new arrival and grants exactly two attempts in each new window", () => {
    let state = suppressRecoveryWindow(opened(arrival()));
    const duplicate = applyHumanProof(state, arrival(), expected);
    expect(duplicate).toMatchObject({ kind: "opened", fresh: false, state: { stopped: true } });
    for (let epoch = 2; epoch <= 4; epoch++) {
      const result = applyHumanProof(state, arrival({ epoch, inputId: `in-${epoch}` }), expected);
      expect(result).toMatchObject({ kind: "opened", fresh: true, state: { stopped: false, attemptsInWindow: 0 } });
      state = result.state;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const pairs = [{ fingerprint: "a".repeat(64), key: `${epoch}-${attempt}` }];
        expect(decideRecoveryAttempt(state, pairs)).toMatchObject({ allowed: true, attemptNumber: attempt });
        state = recordRecoveryAttempt(state, pairs, `ir_${epoch}_${attempt}`);
      }
      expect(decideRecoveryAttempt(state, [{ fingerprint: "b".repeat(64), key: "third" }])).toMatchObject({
        allowed: false,
        reason: "window-exhausted",
      });
      expect(applyHumanProof(state, arrival({ epoch, inputId: `in-${epoch}` }), expected).state.attemptsInWindow).toBe(
        2,
      );
      state = suppressRecoveryWindow(state);
    }
    expect(state.seen).toHaveLength(6);
    expect(state.totalAttempts).toBe(6);
  });

  it.each([
    [{ owner: "old-owner", epoch: 3, inputId: "new" }, "owner-mismatch"],
    [{ sid: "other", epoch: 3, inputId: "new" }, "sid-mismatch"],
    [{ epoch: 1, inputId: "old" }, "stale-epoch"],
    [{ provenance: "admission", epoch: 3, inputId: "new" }, "weak-provenance"],
    [{ provenance: "interactive", epoch: 3, inputId: "new" }, "weak-provenance"],
  ] as const)("rejects ineligible arrival %j without clearing Stop", (overrides, reason) => {
    const state = suppressRecoveryWindow(opened(arrival({ epoch: 2, inputId: "in-2" })));
    const result = applyHumanProof(state, arrival(overrides), expected);
    expect(result).toMatchObject({ kind: "ignored", reason });
    expect(result.state).toBe(state);
    expect(result.state.stopped).toBe(true);
  });

  it("does not interpret role:user, machine notifications or tool operations as trusted proof", () => {
    const state = suppressRecoveryWindow(opened(arrival()));
    for (const raw of [
      { role: "user", content: "hello" },
      { source: "interactive" },
      { source: "admission" },
      { tool: "TaskList" },
      { tool: "TaskGet" },
      { tool: "TaskUpdate" },
      { customType: "subagent:complete" },
    ]) {
      expect(applyHumanProof(state, raw, expected)).toMatchObject({ kind: "ignored", reason: "invalid" });
      expect(applyHumanProof(state, raw, expected).state).toBe(state);
    }
  });
});
