// todo-archive-split #92 §8.2: the archive-store pure functions — sanitizeArchiveEntry,
// foldArchive, mergeArchive, replayTodo's three-phase semantics, evictArchived — plus the two
// frozen-copy proofs:
//   - 段 2 equivalence fuzz: for random OLD-shape-only branches, replayState must be deep-equal
//     to the verbatim pre-#92 implementation (tests/todo/fixtures/legacy-replay.ts) — OD4's
//     "no archive package ⇒ byte-identical" acceptance line;
//   - OD1-c degradation: the frozen OLD reader reads a NEW-format branch fine (live-only,
//     self-contained, nextId preserved) — archived tasks merely invisible until re-upgrade.

import { describe, expect, test } from "vitest";
import {
  archiveCompleted,
  createTask,
  deleteTask,
  emptyState,
  evictArchived,
  foldArchive,
  isBlocked,
  mergeArchive,
  replayState,
  replayTodo,
  sanitizeArchiveEntry,
  updateTask,
  validateState,
  ARCHIVE_ENTRY,
  STATE_ENTRY,
  TODO_ARCHIVE_CAP,
  type Task,
  type TodoArchiveEntryV1,
  type TodoState,
} from "../../src/todo/state.js";
import { legacyReplayState } from "./fixtures/legacy-replay.js";

function customEntry(customType: string, data: unknown): unknown {
  return { type: "custom", customType, data };
}

function toolResultEntry(state: unknown, isError = false): unknown {
  return {
    type: "message",
    message: { role: "toolResult", toolName: "TaskCreate", isError, details: { state } },
  };
}

function archivedTask(id: number, over: Partial<Task> = {}): Task {
  return {
    id,
    subject: `A${id}`,
    description: `d${id}`,
    status: "completed",
    blocks: [],
    blockedBy: [],
    createdAt: id * 10,
    updatedAt: id * 10,
    completedAt: id * 10,
    archivedAt: id * 100,
    ...over,
  };
}

function liveTask(id: number, over: Partial<Task> = {}): Task {
  return {
    id,
    subject: `L${id}`,
    description: `d${id}`,
    status: "pending",
    blocks: [],
    blockedBy: [],
    createdAt: id * 10,
    updatedAt: id * 10,
    ...over,
  };
}

describe("sanitizeArchiveEntry (fail-closed, §2.1)", () => {
  test("whole-package ignore: non-object, array, v missing / 2 / string", () => {
    expect(sanitizeArchiveEntry(undefined)).toBeUndefined();
    expect(sanitizeArchiveEntry(null)).toBeUndefined();
    expect(sanitizeArchiveEntry("v1")).toBeUndefined();
    expect(sanitizeArchiveEntry([1])).toBeUndefined();
    expect(sanitizeArchiveEntry({})).toBeUndefined(); // v missing
    expect(sanitizeArchiveEntry({ v: 2, put: [] })).toBeUndefined(); // forward-compat: v2 ignored
    expect(sanitizeArchiveEntry({ v: "1", put: [] })).toBeUndefined();
  });

  test("reset must be === true, else only the field is dropped", () => {
    expect(sanitizeArchiveEntry({ v: 1, reset: true })).toEqual({ v: 1, reset: true });
    expect(sanitizeArchiveEntry({ v: 1, reset: "yes" })).toEqual({ v: 1 });
    expect(sanitizeArchiveEntry({ v: 1, reset: false })).toEqual({ v: 1 });
  });

  test("put: non-array drops the field; bad ELEMENTS drop individually, the rest survive", () => {
    const good = archivedTask(7);
    expect(sanitizeArchiveEntry({ v: 1, put: "nope" })).toEqual({ v: 1 });
    const cleaned = sanitizeArchiveEntry({
      v: 1,
      put: [
        good,
        { ...archivedTask(8), status: "pending" }, // not completed ⇒ dropped
        { ...liveTask(9) }, // missing archivedAt ⇒ dropped
        {
          id: 0,
          subject: "x",
          description: "y",
          status: "completed",
          blocks: [],
          blockedBy: [],
          createdAt: 1,
          updatedAt: 1,
          archivedAt: 2,
        }, // whitelist-fail id ⇒ dropped
        "garbage",
        null,
      ],
    })!;
    expect(cleaned.put).toHaveLength(1);
    expect(cleaned.put![0]).toEqual(good);
  });

  test("drop: non-array drops the field; only positive integer ids survive, deduplicated", () => {
    expect(sanitizeArchiveEntry({ v: 1, drop: 3 })).toEqual({ v: 1 });
    expect(sanitizeArchiveEntry({ v: 1, drop: [3, 3, 0, -1, "3", 2.5, 4] })).toEqual({ v: 1, drop: [3, 4] });
  });
});

describe("foldArchive (§2.1)", () => {
  test("within a package: reset → put → drop", () => {
    const archived = new Map<number, Task>();
    foldArchive(archived, { v: 1, put: [archivedTask(1), archivedTask(2)] });
    expect([...archived.keys()]).toEqual([1, 2]);
    foldArchive(archived, { v: 1, reset: true, put: [archivedTask(3)] });
    expect([...archived.keys()]).toEqual([3]); // reset cleared 1,2 BEFORE the put
    foldArchive(archived, { v: 1, put: [archivedTask(3)], drop: [3] }); // put wins, drop after
    expect([...archived.keys()]).toEqual([]);
  });

  test("across packages: upsert overwrites; drop-then-put resurrects", () => {
    const archived = new Map<number, Task>();
    foldArchive(archived, { v: 1, put: [archivedTask(1, { subject: "first" })] });
    foldArchive(archived, { v: 1, put: [archivedTask(1, { subject: "second" })] });
    expect(archived.get(1)?.subject).toBe("second");
    foldArchive(archived, { v: 1, drop: [1] });
    expect(archived.has(1)).toBe(false);
    foldArchive(archived, { v: 1, put: [archivedTask(1)] });
    expect(archived.has(1)).toBe(true);
  });
});

describe("mergeArchive (§3.3)", () => {
  test("id conflict ⇒ live wins, the archived copy is ignored entirely", () => {
    const candidate = { tasks: [liveTask(1, { subject: "live copy" })], nextId: 2 };
    const archived = new Map([[1, archivedTask(1, { subject: "stale archive copy" })]]);
    const merged = mergeArchive(candidate, archived);
    expect(merged.tasks).toHaveLength(1);
    expect(merged.tasks[0]?.subject).toBe("live copy");
  });

  test("merged tasks sort by id ascending; nextId = max(candidate, maxId+1)", () => {
    const candidate = { tasks: [liveTask(5)], nextId: 3 };
    const archived = new Map([
      [2, archivedTask(2)],
      [9, archivedTask(9)],
    ]);
    const merged = mergeArchive(candidate, archived);
    expect(merged.tasks.map((task) => task.id)).toEqual([2, 5, 9]);
    expect(merged.nextId).toBe(10); // max(3, 9+1)
  });

  test("reattach: A's X.blocks ∋ P ⇒ merged P.blockedBy ∋ X (opposite edge completed)", () => {
    // X (archived) blocks P (live): the live snapshot stripped the cross edge on BOTH ends.
    const candidate = { tasks: [liveTask(2)], nextId: 3 };
    const archived = new Map([[1, archivedTask(1, { blocks: [2] })]]);
    const merged = mergeArchive(candidate, archived);
    const x = merged.tasks.find((task) => task.id === 1)!;
    const p = merged.tasks.find((task) => task.id === 2)!;
    expect(x.blocks).toEqual([2]);
    expect(p.blockedBy).toEqual([1]); // reattached
  });

  test("tolerant: an A edge pointing outside the merged set is dropped, state stays valid", () => {
    const candidate = { tasks: [liveTask(1)], nextId: 2 };
    const archived = new Map([[3, archivedTask(3, { blocks: [99], blockedBy: [98] })]]);
    const merged = mergeArchive(candidate, archived);
    const x = merged.tasks.find((task) => task.id === 3)!;
    expect(x.blocks).toEqual([]);
    expect(x.blockedBy).toEqual([]);
  });

  test("merge never mutates the folded archived objects (clone rule, review Minor #4)", () => {
    const original = archivedTask(1, { blocks: [99] }); // dangling edge
    const archived = new Map([[1, original]]);
    const merged = mergeArchive({ tasks: [liveTask(2)], nextId: 3 }, archived);
    expect(merged.tasks.find((task) => task.id === 1)?.blocks).toEqual([]); // dropped on the clone
    expect(original.blocks).toEqual([99]); // fold original untouched
  });

  test("live-side dangling edges are NOT repaired — validateState rejects (same as today)", () => {
    const candidate = { tasks: [liveTask(1, { blockedBy: [99] })], nextId: 2 };
    const merged = mergeArchive(candidate, new Map());
    expect(merged.tasks[0]?.blockedBy).toEqual([99]);
    expect(() => validateState(merged)).toThrow(/missing blockedBy dependency/);
  });
});

describe("replayTodo three-phase semantics (§3.2)", () => {
  test("archive entries fold across the branch; a valid merge wins from the LAST candidate", () => {
    const olderLive = { tasks: [liveTask(2)], nextId: 3 };
    const newerLive = { tasks: [liveTask(2), liveTask(4)], nextId: 5 };
    const branch = [
      customEntry(ARCHIVE_ENTRY, { v: 1, put: [archivedTask(1, { blocks: [2] })] }),
      customEntry(STATE_ENTRY, olderLive),
      customEntry(ARCHIVE_ENTRY, { v: 1, put: [archivedTask(3)] }),
      customEntry(STATE_ENTRY, newerLive),
    ];
    const result = replayTodo(branch)!;
    expect(result.degraded).toBe(false);
    expect(result.state!.tasks.map((task) => task.id)).toEqual([1, 2, 3, 4]);
    // reattach from the archived side: #2 blockedBy #1
    expect(result.state!.tasks.find((task) => task.id === 2)?.blockedBy).toEqual([1]);
    expect(result.state!.nextId).toBe(5);
  });

  test("a dirty live candidate falls back to the previous one (merge validated, not trusted)", () => {
    const good = { tasks: [liveTask(2)], nextId: 3 };
    const dirty = { tasks: [liveTask(2, { blockedBy: [99] })], nextId: 3 };
    const branch = [
      customEntry(ARCHIVE_ENTRY, { v: 1, put: [archivedTask(1)] }),
      customEntry(STATE_ENTRY, good),
      customEntry(STATE_ENTRY, dirty),
    ];
    const result = replayTodo(branch)!;
    expect(result.degraded).toBe(false);
    expect(result.state!.tasks.map((task) => task.id)).toEqual([1, 2]);
  });

  test("internally inconsistent archived set ⇒ every merge fails ⇒ degraded live-only fallback", () => {
    // #1 blocks #2 but #2 does not list #1 in blockedBy — a bidirectional violation inside A.
    const archived = new Map<number, Task>();
    foldArchive(archived, {
      v: 1,
      put: [archivedTask(1, { blocks: [2] }), archivedTask(2)],
    });
    const branch = [
      {
        type: "custom",
        customType: ARCHIVE_ENTRY,
        data: { v: 1, put: [archivedTask(1, { blocks: [2] }), archivedTask(2)] },
      },
      customEntry(STATE_ENTRY, { tasks: [liveTask(5)], nextId: 6 }),
    ];
    const result = replayTodo(branch)!;
    expect(result.degraded).toBe(true);
    expect(result.state!.tasks.map((task) => task.id)).toEqual([5]); // live-only, never worse
    // The fold itself is still returned — the caller keeps it (never drop what you can't read).
    expect([...result.archived.keys()]).toEqual([1, 2]);
  });

  test("an archived-set cycle likewise degrades to live-only", () => {
    const branch = [
      {
        type: "custom",
        customType: ARCHIVE_ENTRY,
        data: {
          v: 1,
          put: [archivedTask(1, { blocks: [2], blockedBy: [2] }), archivedTask(2, { blocks: [1], blockedBy: [1] })],
        },
      },
      customEntry(STATE_ENTRY, { tasks: [], nextId: 1 }),
    ];
    const result = replayTodo(branch)!;
    expect(result.degraded).toBe(true);
    expect(result.state).toEqual({ tasks: [], nextId: 1 });
  });

  test("dirty archive PACKAGES are ignored entirely (v mismatch ⇒ never saw the split format)", () => {
    const branch = [
      customEntry(ARCHIVE_ENTRY, { v: 2, put: [archivedTask(1)] }),
      customEntry(ARCHIVE_ENTRY, "not an object"),
      customEntry(STATE_ENTRY, { tasks: [liveTask(1)], nextId: 2 }),
    ];
    const result = replayTodo(branch)!;
    expect(result.degraded).toBe(false); // phase 2: never saw a valid archive package
    expect(result.state!.tasks.map((task) => task.id)).toEqual([1]);
    expect(result.archived.size).toBe(0);
  });
});

describe("段 2 equivalence fuzz: no archive package ⇒ byte-identical to the frozen pre-#92 replay", () => {
  /** mulberry32 — deterministic PRNG (fixed seed ⇒ reproducible), same shape as hold.property.test.ts. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomState(rand: () => number): TodoState {
    let state = emptyState();
    const count = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < count; i++) {
      const id = state.nextId;
      try {
        state = createTask(state, { subject: `t${id}`, description: `d${id}` }, id * 10).state;
        const roll = rand();
        if (roll < 0.3) state = updateTask(state, String(id), { status: "completed" }, id * 11).state;
        else if (roll < 0.4 && state.tasks.length >= 2) {
          const other = state.tasks[Math.floor(rand() * (state.tasks.length - 1))]!.id;
          if (other !== id) state = updateTask(state, String(id), { blockedBy: [String(other)] }, id * 12).state;
        } else if (roll < 0.5 && state.tasks.length >= 2) {
          const other = state.tasks[Math.floor(rand() * (state.tasks.length - 1))]!.id;
          if (other !== id) state = updateTask(state, String(id), { blocks: [String(other)] }, id * 13).state;
        }
      } catch {
        /* a rejected op (cycle etc.) just leaves the state as-is */
      }
    }
    if (rand() < 0.5) state = archiveCompleted(state, "all", 999);
    if (rand() < 0.2 && state.tasks.length > 1) state = deleteTask(state, String(1)).state;
    return state;
  }

  /** Random corruption of a JSON-deep-cloned state — produces DIRTY candidates. */
  function corrupt(state: TodoState, rand: () => number): unknown {
    const clone = JSON.parse(JSON.stringify(state)) as TodoState & { nextId: number };
    switch (Math.floor(rand() * 8)) {
      case 0:
        clone.nextId = 1.5;
        break;
      case 1:
        clone.tasks.push({ ...clone.tasks[0]!, id: clone.tasks[0]!.id }); // duplicate id
        break;
      case 2:
        if (clone.tasks[0]) clone.tasks[0].blockedBy = [99]; // dangling
        break;
      case 3:
        if (clone.tasks[0]) delete (clone.tasks[0] as Partial<Task>).subject; // whitelist fail
        break;
      case 4:
        if (clone.tasks[0]) clone.tasks[0].completedAt = "yesterday"; // field-level drop
        break;
      case 5:
        clone.tasks = clone.tasks.slice(0, Math.max(0, clone.tasks.length - 1)); // legal smaller state
        break;
      case 6:
        if (clone.tasks[0]) clone.tasks[0].id = 0;
        break;
      case 7: {
        // A bidirectionally-CONSISTENT cycle between the first two tasks — structurally clean,
        // rejected only by the graph validation (cycle detection).
        if (clone.tasks.length >= 2) {
          const a = clone.tasks[0]!;
          const b = clone.tasks[1]!;
          a.blocks = [b.id, ...a.blocks.filter((id) => id !== b.id)];
          a.blockedBy = [b.id, ...a.blockedBy.filter((id) => id !== b.id)];
          b.blocks = [a.id, ...b.blocks.filter((id) => id !== a.id)];
          b.blockedBy = [a.id, ...b.blockedBy.filter((id) => id !== a.id)];
        }
        break;
      }
      default:
        break; // no corruption
    }
    return clone;
  }

  test("300 seeded branches: replayState deep-equals legacyReplayState", () => {
    let definedCount = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed);
      const base = randomState(rand);
      const branch: unknown[] = [];
      const length = 1 + Math.floor(rand() * 8);
      for (let i = 0; i < length; i++) {
        const snapshot = rand() < 0.3 ? corrupt(base, rand) : JSON.parse(JSON.stringify(base));
        const roll = rand();
        if (roll < 0.45) branch.push(customEntry(STATE_ENTRY, snapshot));
        else if (roll < 0.85) branch.push(toolResultEntry(snapshot, rand() < 0.15));
        else if (roll < 0.9) branch.push({ type: "custom", customType: "unrelated", data: snapshot });
        else if (roll < 0.95) branch.push({ type: "message", message: { role: "user" } });
        else
          branch.push({
            type: "message",
            message: { role: "toolResult", isError: true, details: { state: snapshot } },
          });
      }
      const mine = replayState(branch);
      const legacy = legacyReplayState(branch);
      if (mine !== undefined) definedCount++;
      expect(mine).toEqual(legacy);
    }
    // Sanity: the generator must actually produce replayable branches — a fuzz where every
    // branch replays to undefined would trivially pass the equality above.
    expect(definedCount).toBeGreaterThan(150);
  });
});

describe("OD1-c degradation proof: the frozen OLD reader survives a NEW-format branch", () => {
  test("old reader returns the live-only state; open set and nextId match, archived absent", () => {
    // A split-format branch as the new writer produces it: live snapshot is self-contained
    // (cross edges stripped), the archived tasks (with their authoritative cross-edge copies)
    // live only in ARCHIVE_ENTRY packages the old reader cannot see.
    const branch = [
      customEntry(STATE_ENTRY, { v: 1, nextId: 3, tasks: [liveTask(2, { status: "in_progress" })] }),
      customEntry(ARCHIVE_ENTRY, { v: 1, put: [archivedTask(1, { blocks: [2] })] }),
    ];
    const legacy = legacyReplayState(branch)!;
    const fresh = replayState(branch)!;
    expect(legacy).toBeDefined();
    // The old reader sees the exact same open set and nextId…
    expect(legacy.tasks.map((task) => task.id)).toEqual(
      fresh.tasks.filter((t) => t.status !== "completed").map((t) => t.id),
    );
    expect(legacy.nextId).toBe(fresh.nextId);
    // …with archived tasks merely invisible (no dangling edges — the snapshot is self-contained).
    expect(legacy.tasks.some((task) => task.archivedAt !== undefined)).toBe(false);
    expect(fresh.tasks.map((task) => task.id)).toEqual([1, 2]);
  });
});

describe("evictArchived (§6, D14/OD2)", () => {
  function stateWithArchived(count: number, liveCount = 0): TodoState {
    let state = emptyState();
    for (let i = 0; i < count; i++) {
      const id = state.nextId;
      state = createTask(state, { subject: `a${id}`, description: "d" }, i + 1).state;
      state = updateTask(state, String(id), { status: "completed" }, i + 2).state;
      state = archiveCompleted(state, [id], i + 100);
    }
    for (let i = 0; i < liveCount; i++) {
      state = createTask(state, { subject: `l${state.nextId}`, description: "d" }, 500 + i).state;
    }
    return state;
  }

  test("≤ cap returns the SAME reference", () => {
    const state = stateWithArchived(3);
    expect(evictArchived(state, TODO_ARCHIVE_CAP)).toBe(state);
    expect(evictArchived(state, 3)).toBe(state);
    expect(evictArchived(state, 4)).toBe(state);
  });

  test("over cap evicts the oldest by (archivedAt asc, id asc) and prunes neighbor edges", () => {
    let state = emptyState();
    // #1..#3 completed+archived (archivedAt 100..300), #4 live blockedBy #3.
    for (let i = 1; i <= 3; i++) {
      state = createTask(state, { subject: `t${i}`, description: "d" }, i).state;
      state = updateTask(state, String(i), { status: "completed" }, i + 10).state;
      state = archiveCompleted(state, [i], i * 100);
    }
    state = createTask(state, { subject: "live", description: "d", blockedBy: ["3"] }, 999).state;
    const next = evictArchived(state, 2);
    expect(next).not.toBe(state);
    expect(next.tasks.map((task) => task.id)).toEqual([2, 3, 4]); // #1 (oldest) evicted
    // #3 is KEPT, so #4's edge to it survives intact.
    expect(next.tasks.find((task) => task.id === 4)?.blockedBy).toEqual([3]);
    expect(next.tasks.find((task) => task.id === 3)?.blocks).toEqual([4]);
    // Evict everything (cap 0): #2 and #3 go, #4's edge is pruned with deleteTask semantics.
    const next2 = evictArchived(next, 0);
    expect(next2.tasks.map((task) => task.id)).toEqual([4]);
    expect(next2.tasks.find((task) => task.id === 4)?.blockedBy).toEqual([]);
  });

  test("tie on archivedAt breaks by lower id = older", () => {
    const state = stateWithArchived(3);
    // All three archivedAt differ (101,102,103 by construction above); make them equal:
    const equalized: TodoState = {
      nextId: state.nextId,
      tasks: state.tasks.map((task) => ({ ...task, archivedAt: 500 })),
    };
    const next = evictArchived(equalized, 1);
    expect(next.tasks.map((task) => task.id)).toEqual([3]); // ids 1,2 evicted first
  });

  test("live tasks' isBlocked is unchanged by eviction (evicted are completed)", () => {
    let state = emptyState();
    state = createTask(state, { subject: "a", description: "d" }, 1).state;
    state = updateTask(state, "1", { status: "completed" }, 2).state;
    state = archiveCompleted(state, [1], 3);
    state = createTask(state, { subject: "b", description: "d", blockedBy: ["1"] }, 4).state;
    const blockedBefore = isBlocked(state.tasks[1]!, state.tasks); // completed ⇒ not blocked
    const next = evictArchived(state, 0);
    expect(isBlocked(next.tasks[0]!, next.tasks)).toBe(blockedBefore);
    expect(next.tasks.map((task) => task.id)).toEqual([2]);
  });
});
