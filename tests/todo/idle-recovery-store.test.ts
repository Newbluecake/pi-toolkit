// Task59 Stage B1 — idle-recovery store: write-ahead reservation, fail-closed replay, reload/fork
// semantics. The host here is a tiny in-memory session-log double (append-ordered entries +
// synchronous append), which is exactly the seam the store is specified against; no send/abort
// port exists anywhere in the store, so "no send before the attempt entry" is structural.

import { describe, expect, it } from "vitest";
import {
  foldIdleRecoveryEntries,
  IDLE_RECOVERY_ENTRY,
  RECOVERY_SEEN_CAP,
  type RecoveryHumanProof,
} from "../../src/todo/idle-recovery.js";
import {
  createIdleRecoveryStore,
  type IdleRecoveryStore,
  type RecoveryPlan,
} from "../../src/todo/idle-recovery-store.js";
import type { Task, TodoState } from "../../src/todo/state.js";

const PROOF = (overrides: Partial<RecoveryHumanProof> = {}): RecoveryHumanProof => ({
  sid: "s1",
  owner: "root",
  epoch: 1,
  inputId: "in-1",
  provenance: "strong-consumption",
  ...overrides,
});

function task(overrides: Partial<Task> & { id: number }): Task {
  return {
    id: overrides.id,
    subject: `task ${overrides.id}`,
    description: `description ${overrides.id}`,
    status: "in_progress",
    blocks: [],
    blockedBy: [],
    createdAt: 1_000 + overrides.id,
    updatedAt: 1_000 + overrides.id,
    ...overrides,
  };
}

function todo(tasks: Task[]): TodoState {
  return { tasks, nextId: Math.max(0, ...tasks.map((entry) => entry.id)) + 1 };
}

interface Host {
  entries: unknown[];
  failAppend: boolean;
  throwRead: boolean;
  getEntries(): readonly unknown[];
  appendCustomEntry(customType: string, data: unknown): unknown;
}

function makeHost(entries: unknown[] = []): Host {
  const host: Host = {
    entries: [...entries],
    failAppend: false,
    throwRead: false,
    getEntries: () => {
      if (host.throwRead) throw new Error("session read failed");
      return host.entries;
    },
    appendCustomEntry: (customType: string, data: unknown) => {
      if (host.failAppend) throw new Error("session append failed");
      host.entries.push({ type: "custom", customType, data });
      return "entry";
    },
  };
  return host;
}

let attemptSeq = 0;
function storeFor(host: Host, overrides: { sessionId?: string; owner?: string } = {}): IdleRecoveryStore {
  return createIdleRecoveryStore({
    sessionId: overrides.sessionId ?? "s1",
    owner: overrides.owner ?? "root",
    getEntries: host.getEntries,
    appendCustomEntry: host.appendCustomEntry,
    now: () => 7,
    createAttemptId: () => `ir_${++attemptSeq}`,
  });
}

function withProgressKey(target: Task, tasks: Task[], progressKey: string): TodoState {
  return todo(
    tasks.map((entry) => (entry.id === target.id ? { ...entry, metadata: { idleRecovery: { progressKey } } } : entry)),
  );
}

function lastEntry(host: Host): { customType?: unknown; data?: Record<string, unknown> } {
  const entry = host.entries.at(-1) as { customType?: unknown; data?: Record<string, unknown> };
  return entry;
}

describe("idle-recovery store: gates", () => {
  it("refuses to build without a session id, an owner, or the session seams", () => {
    const host = makeHost();
    expect(() =>
      createIdleRecoveryStore({
        sessionId: "",
        owner: "root",
        getEntries: host.getEntries,
        appendCustomEntry: host.appendCustomEntry,
      }),
    ).toThrow(/sessionId/);
    expect(() =>
      createIdleRecoveryStore({
        sessionId: "s1",
        owner: "",
        getEntries: host.getEntries,
        appendCustomEntry: host.appendCustomEntry,
      }),
    ).toThrow(/owner/);
    expect(() =>
      createIdleRecoveryStore({
        sessionId: "s1",
        owner: "root",
        getEntries: undefined as unknown as () => readonly unknown[],
        appendCustomEntry: host.appendCustomEntry,
      }),
    ).toThrow(/getEntries/);
    expect(() =>
      createIdleRecoveryStore({
        sessionId: "s1",
        owner: "root",
        getEntries: host.getEntries,
        appendCustomEntry: undefined as unknown as (customType: string, data: unknown) => unknown,
      }),
    ).toThrow(/appendCustomEntry/);
  });

  it("cannot send, abort or start a timer: the store surface has no such method", () => {
    const store = storeFor(makeHost());
    expect(Object.keys(store).sort()).toEqual([
      "commit",
      "dispose",
      "noteHumanProof",
      "noteStop",
      "prepare",
      "reserve",
      "view",
    ]);
  });

  it("has zero budget before a strong-consumption proof, and prepare writes nothing", () => {
    const host = makeHost();
    const store = storeFor(host);
    const result = store.prepare({ todo: todo([task({ id: 1 })]) });
    expect(result).toMatchObject({ kind: "denied", reason: "no-window" });
    expect(host.entries).toHaveLength(0);
  });

  it("reports no candidates before any window (nothing to check)", () => {
    const store = storeFor(makeHost());
    expect(store.prepare({ todo: todo([task({ id: 1, status: "completed" })]) })).toMatchObject({
      kind: "denied",
      reason: "no-candidates",
    });
  });

  it("ignores admission/interactive proofs as window openers", () => {
    const host = makeHost();
    const store = storeFor(host);
    for (const provenance of ["admission", "interactive"] as const) {
      expect(store.noteHumanProof(PROOF({ provenance }))).toMatchObject({ kind: "ignored", reason: "weak-provenance" });
    }
    expect(host.entries).toHaveLength(0);
    expect(store.prepare({ todo: todo([task({ id: 1 })]) })).toMatchObject({ kind: "denied", reason: "no-window" });
  });
});

describe("idle-recovery store: attempt-before-send protocol", () => {
  it("persists the attempt entry before returning a reservation, and charges one window attempt", () => {
    const host = makeHost();
    const store = storeFor(host);
    store.noteHumanProof(PROOF());
    const tasks = [task({ id: 1 }), task({ id: 2, status: "completed" }), task({ id: 3 })];
    const prepared = store.prepare({ todo: todo(tasks) });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") return;
    expect(prepared.plan.tasks.map((entry) => entry.taskId)).toEqual([1, 3]);
    expect(prepared.plan.pairs).toHaveLength(2);
    expect(host.entries).toHaveLength(1); // only the window entry so far

    const reserved = store.reserve(prepared.plan);
    expect(reserved.kind).toBe("reserved");
    const appended = lastEntry(host);
    expect(appended.data).toMatchObject({ kind: "attempt", attemptId: prepared.plan.attemptId, epoch: 1 });
    expect(store.view()).toMatchObject({ attemptsInWindow: 1, totalAttempts: 1 });
    expect(store.view().seen).toHaveLength(2); // every listed pair charged to one send
  });

  it("re-checks every gate on reserve: a stale plan cannot produce a second send", () => {
    const host = makeHost();
    const store = storeFor(host);
    store.noteHumanProof(PROOF());
    const tasks = [task({ id: 1 })];
    const first = store.prepare({ todo: todo(tasks) });
    const second = store.prepare({ todo: todo(tasks) });
    expect(first.kind).toBe("ready");
    expect(second.kind).toBe("ready");
    if (first.kind !== "ready" || second.kind !== "ready") return;
    expect(store.reserve(first.plan).kind).toBe("reserved");
    expect(store.reserve(second.plan)).toMatchObject({ kind: "denied", reason: "stale-plan" });
    expect(
      host.entries.filter((entry) => (entry as { data?: { kind?: string } }).data?.kind === "attempt"),
    ).toHaveLength(1);
    expect(store.view().attemptsInWindow).toBe(1);
  });

  it("never refunds a failed/unknown send: the budget was already consumed", () => {
    const host = makeHost();
    const store = storeFor(host);
    store.noteHumanProof(PROOF());
    const tasks = [task({ id: 1 })];
    const p0 = store.prepare({ todo: todo(tasks) });
    if (p0.kind !== "ready") throw new Error("expected ready");
    const r0 = store.reserve(p0.plan);
    if (r0.kind !== "reserved") throw new Error("expected reserved");
    store.commit(r0.reservation, "unknown");
    expect(store.view()).toMatchObject({ attemptsInWindow: 1, unresolved: [] });

    const p1 = store.prepare({ todo: withProgressKey(tasks[0]!, tasks, "P1") });
    if (p1.kind !== "ready") throw new Error("expected ready for the second attempt");
    const r1 = store.reserve(p1.plan);
    if (r1.kind !== "reserved") throw new Error("expected reserved");
    store.commit(r1.reservation, "failed");
    expect(store.view().attemptsInWindow).toBe(2);
    expect(store.prepare({ todo: withProgressKey(tasks[0]!, tasks, "P2") })).toMatchObject({
      kind: "denied",
      reason: "window-exhausted",
    });
  });

  it("refuses a repeated (fingerprint, progressKey) pair without spending budget", () => {
    const host = makeHost();
    const store = storeFor(host);
    store.noteHumanProof(PROOF());
    const tasks = [task({ id: 1 })];
    const first = store.prepare({ todo: todo(tasks) });
    if (first.kind !== "ready") throw new Error("expected ready");
    store.reserve(first.plan);
    expect(store.prepare({ todo: todo(tasks) })).toMatchObject({ kind: "denied", reason: "seen" });
    expect(store.view().attemptsInWindow).toBe(1);
  });

  it("does nothing when the only work left is completed, pending or dependency-blocked", () => {
    const host = makeHost();
    const store = storeFor(host);
    store.noteHumanProof(PROOF());
    const tasks = [
      task({ id: 1, status: "completed" }),
      task({ id: 2, status: "pending" }),
      task({ id: 3, blockedBy: [2] }),
    ];
    expect(store.prepare({ todo: todo(tasks) })).toMatchObject({ kind: "denied", reason: "no-candidates" });
    expect(host.entries).toHaveLength(1);
  });
});

describe("idle-recovery store: Stop", () => {
  it("suppresses the current window until a NEW strong consumption, not on a duplicate proof", () => {
    const host = makeHost();
    const store = storeFor(host);
    store.noteHumanProof(PROOF({ epoch: 2, inputId: "in-2" }));
    store.noteStop("aborted");
    const stopEntry = lastEntry(host);
    expect(stopEntry.data).toMatchObject({ kind: "stop", inputId: "in-2", epoch: 2, reason: "aborted" });
    expect(store.prepare({ todo: todo([task({ id: 1 })]) })).toMatchObject({ kind: "denied", reason: "stopped" });

    expect(store.noteHumanProof(PROOF({ epoch: 2, inputId: "in-2" }))).toMatchObject({ kind: "opened", fresh: false });
    expect(store.view().stopped).toBe(true);
    expect(store.prepare({ todo: todo([task({ id: 1 })]) })).toMatchObject({ kind: "denied", reason: "stopped" });

    expect(store.noteHumanProof(PROOF({ epoch: 3, inputId: "in-3" }))).toMatchObject({ kind: "opened", fresh: true });
    expect(store.view().stopped).toBe(false);
    expect(store.prepare({ todo: todo([task({ id: 1 })]) }).kind).toBe("ready");
  });

  it("keeps the Stop across a reload and refuses the replayed window", () => {
    const host = makeHost();
    const first = storeFor(host);
    first.noteHumanProof(PROOF({ epoch: 4, inputId: "in-4" }));
    first.noteStop("abort-admission");

    const reloaded = storeFor(host);
    expect(reloaded.view()).toMatchObject({ stopped: true, open: false, attemptsInWindow: 0 });
    expect(reloaded.prepare({ todo: todo([task({ id: 1 })]) })).toMatchObject({ kind: "denied", reason: "no-window" });
    expect(reloaded.noteHumanProof(PROOF({ epoch: 4, inputId: "in-4" }))).toMatchObject({
      kind: "opened",
      fresh: false,
    });
    expect(reloaded.prepare({ todo: todo([task({ id: 1 })]) })).toMatchObject({ kind: "denied", reason: "stopped" });
  });
});

describe("idle-recovery store: reload / fork", () => {
  it("keeps used/seen on a same-sid reload but never restores a live window", () => {
    const host = makeHost();
    const tasks = [task({ id: 1 })];
    const first = storeFor(host);
    first.noteHumanProof(PROOF({ epoch: 2, inputId: "in-2" }));
    const p0 = first.prepare({ todo: todo(tasks) });
    if (p0.kind !== "ready") throw new Error("expected ready");
    const r0 = first.reserve(p0.plan);
    if (r0.kind !== "reserved") throw new Error("expected reserved");
    first.commit(r0.reservation, "sent");
    const p1 = first.prepare({ todo: withProgressKey(tasks[0]!, tasks, "P1") });
    if (p1.kind !== "ready") throw new Error("expected ready");
    first.reserve(p1.plan);

    const reloaded = storeFor(host);
    expect(reloaded.view()).toMatchObject({ attemptsInWindow: 2, open: false, stopped: false });
    expect(reloaded.view().seen).toHaveLength(2);
    expect(reloaded.view().unresolved).toHaveLength(1); // reserved, never committed ⇒ never resent
    expect(reloaded.prepare({ todo: withProgressKey(tasks[0]!, tasks, "P2") })).toMatchObject({
      kind: "denied",
      reason: "no-window",
    });
    expect(reloaded.noteHumanProof(PROOF({ epoch: 2, inputId: "in-2" }))).toMatchObject({
      kind: "opened",
      fresh: false,
    });
    expect(reloaded.prepare({ todo: withProgressKey(tasks[0]!, tasks, "P2") })).toMatchObject({
      kind: "denied",
      reason: "window-exhausted",
    });
    expect(reloaded.noteHumanProof(PROOF({ epoch: 3, inputId: "in-3" }))).toMatchObject({
      kind: "opened",
      fresh: true,
    });
    const fresh = reloaded.prepare({ todo: withProgressKey(tasks[0]!, tasks, "P2") });
    expect(fresh.kind).toBe("ready");
    if (fresh.kind === "ready") expect(fresh.plan.attemptNumber).toBe(1);
  });

  it("does not inherit anything from a forked session's copied entries (other sid)", () => {
    const oldEntries = [
      {
        type: "custom",
        customType: IDLE_RECOVERY_ENTRY,
        data: { v: 1, kind: "window", sid: "old", inputId: "in-1", epoch: 9, owner: "root", at: 1 },
      },
      {
        type: "custom",
        customType: IDLE_RECOVERY_ENTRY,
        data: {
          v: 1,
          kind: "attempt",
          sid: "old",
          inputId: "in-1",
          epoch: 9,
          attemptId: "ir_old",
          pairs: [{ fingerprint: "a".repeat(64), key: "" }],
          at: 2,
        },
      },
      {
        type: "custom",
        customType: IDLE_RECOVERY_ENTRY,
        data: { v: 1, kind: "stop", sid: "old", inputId: "in-1", epoch: 9, reason: "aborted", at: 3 },
      },
    ];
    const host = makeHost(oldEntries);
    const forked = storeFor(host, { sessionId: "new" });
    expect(forked.view()).toMatchObject({ sid: "new", open: false, attemptsInWindow: 0, stopped: false, seen: [] });
    expect(forked.prepare({ todo: todo([task({ id: 1 })]) })).toMatchObject({ kind: "denied", reason: "no-window" });
    // The new session must wait for its OWN trusted input; that input then grants a full window.
    expect(forked.noteHumanProof(PROOF({ sid: "new", epoch: 1, inputId: "new-in" }))).toMatchObject({ kind: "opened" });
    expect(forked.prepare({ todo: todo([task({ id: 1 })]) })).toMatchObject({
      kind: "ready",
      plan: { attemptNumber: 1 },
    });
  });

  it("matches the reference full replay of the entry log", () => {
    const host = makeHost();
    const tasks = [task({ id: 1 })];
    const store = storeFor(host);
    store.noteHumanProof(PROOF({ epoch: 2, inputId: "in-2" }));
    const plan = store.prepare({ todo: todo(tasks) });
    if (plan.kind !== "ready") throw new Error("expected ready");
    const reserved = store.reserve(plan.plan);
    if (reserved.kind !== "reserved") throw new Error("expected reserved");
    store.commit(reserved.reservation, "sent");
    store.noteStop("aborted");

    const live = store.view();
    const reference = foldIdleRecoveryEntries(host.entries, "s1").state;
    expect({
      sid: live.sid,
      window: live.window,
      attemptsInWindow: live.attemptsInWindow,
      totalAttempts: live.totalAttempts,
      seen: live.seen,
      stopped: live.stopped,
      unresolved: live.unresolved,
      latch: live.latch,
    }).toEqual({
      sid: reference.sid,
      window: reference.window,
      attemptsInWindow: reference.attemptsInWindow,
      totalAttempts: reference.totalAttempts,
      seen: reference.seen,
      stopped: reference.stopped,
      unresolved: reference.unresolved,
      latch: reference.latch,
    });
    expect(live.open).toBe(true); // live window only; the replay never restores it
    expect(reference.open).toBe(false);
  });
});

describe("idle-recovery store: failure / corruption fail-closed", () => {
  it("does not send when the attempt append fails, and does not refund the consumed attempt", () => {
    const host = makeHost();
    const store = storeFor(host);
    store.noteHumanProof(PROOF());
    const prepared = store.prepare({ todo: todo([task({ id: 1 })]) });
    if (prepared.kind !== "ready") throw new Error("expected ready");
    const before = host.entries.length;
    host.failAppend = true;
    expect(store.reserve(prepared.plan)).toMatchObject({ kind: "denied", reason: "persist-uncertain" });
    expect(host.entries).toHaveLength(before);
    expect(store.view()).toMatchObject({ attemptsInWindow: 1, latch: "persist-uncertain" });
    expect(store.prepare({ todo: todo([task({ id: 1 })]) })).toMatchObject({
      kind: "denied",
      reason: "persist-uncertain",
    });
  });

  it("latches when the window entry cannot be persisted (no unproven window)", () => {
    const host = makeHost();
    const store = storeFor(host);
    host.failAppend = true;
    expect(store.noteHumanProof(PROOF())).toMatchObject({ kind: "opened" });
    expect(store.view().latch).toBe("persist-uncertain");
    expect(store.prepare({ todo: todo([task({ id: 1 })]) })).toMatchObject({
      kind: "denied",
      reason: "persist-uncertain",
    });
  });

  it("fails closed on a read failure", () => {
    const host = makeHost();
    const store = storeFor(host);
    host.throwRead = true;
    expect(store.view().latch).toBe("persist-uncertain");
    expect(store.prepare({ todo: todo([task({ id: 1 })]) })).toMatchObject({
      kind: "denied",
      reason: "persist-uncertain",
    });
  });

  it("fails closed when the log shrinks instead of refunding the budget", () => {
    const host = makeHost();
    const store = storeFor(host);
    store.noteHumanProof(PROOF());
    const prepared = store.prepare({ todo: todo([task({ id: 1 })]) });
    if (prepared.kind !== "ready") throw new Error("expected ready");
    store.reserve(prepared.plan);
    expect(store.view().attemptsInWindow).toBe(1);
    host.entries.pop(); // the log lost a record: continuity is unprovable
    expect(store.view().latch).toBe("persist-uncertain");
    expect(store.view().attemptsInWindow).toBe(1);
    expect(store.prepare({ todo: todo([task({ id: 1 })]) })).toMatchObject({
      kind: "denied",
      reason: "persist-uncertain",
    });
  });

  it("fails closed on a corrupt recovery entry of this session", () => {
    const host = makeHost([
      { type: "custom", customType: IDLE_RECOVERY_ENTRY, data: { v: 1, kind: "window", sid: "s1", epoch: 1 } },
    ]);
    const store = storeFor(host);
    expect(store.view().latch).toBe("persist-uncertain");
    expect(store.noteHumanProof(PROOF())).toMatchObject({ kind: "ignored" });
    expect(store.prepare({ todo: todo([task({ id: 1 })]) })).toMatchObject({
      kind: "denied",
      reason: "persist-uncertain",
    });
  });

  it("refuses a malformed outcome without refunding and without throwing", () => {
    const host = makeHost();
    const store = storeFor(host);
    store.noteHumanProof(PROOF());
    const prepared = store.prepare({ todo: todo([task({ id: 1 })]) });
    if (prepared.kind !== "ready") throw new Error("expected ready");
    const reserved = store.reserve(prepared.plan);
    if (reserved.kind !== "reserved") throw new Error("expected reserved");
    expect(() => store.commit(reserved.reservation, "bogus" as never)).not.toThrow();
    expect(store.view()).toMatchObject({ attemptsInWindow: 1, latch: "persist-uncertain" });
  });

  it("stops working after dispose", () => {
    const host = makeHost();
    const store = storeFor(host);
    store.noteHumanProof(PROOF());
    store.dispose();
    expect(store.prepare({ todo: todo([task({ id: 1 })]) })).toMatchObject({ kind: "denied", reason: "disposed" });
    expect(store.noteHumanProof(PROOF({ epoch: 2, inputId: "in-2" }))).toMatchObject({
      kind: "ignored",
      reason: "disposed",
    });
  });
});

describe("idle-recovery store: invariants over a random operation sequence", () => {
  // Deterministic PRNG (mulberry32) so failures reproduce.
  const random = (): (() => number) => {
    let seed = 0x2f6e2b1;
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
  };

  it("never exceeds two attempts per window, never loses seen pairs, never throws", () => {
    const host = makeHost();
    let store = storeFor(host);
    let epoch = 1;
    let attempts = 0;
    let seen = 0;
    let window = 0;
    const tasks = [task({ id: 1 })];
    const out = random();
    for (let step = 0; step < 200; step++) {
      const pick = out();
      if (pick < 0.25) {
        epoch += 1;
        store.noteHumanProof(PROOF({ epoch, inputId: `in-${epoch}` }));
        attempts = 0;
        window += 1;
      } else if (pick < 0.35) {
        store.noteStop("aborted");
      } else if (pick < 0.45) {
        store = storeFor(host); // reload
        attempts = store.view().attemptsInWindow;
      } else {
        const key = `P${Math.floor(out() * 4)}`;
        const prepared = store.prepare({ todo: withProgressKey(tasks[0]!, tasks, key) });
        if (prepared.kind !== "ready") {
          expect(store.view().attemptsInWindow).toBeLessThanOrEqual(2);
          continue;
        }
        expect(prepared.plan.attemptNumber).toBe(store.view().attemptsInWindow + 1);
        const reserved = store.reserve(prepared.plan);
        if (reserved.kind !== "reserved") continue;
        attempts = store.view().attemptsInWindow;
        seen = store.view().seen.length;
        expect(attempts).toBeLessThanOrEqual(2);
        store.commit(reserved.reservation, out() < 0.5 ? "sent" : "unknown");
        expect(store.view().attemptsInWindow).toBe(attempts);
        expect(store.view().seen.length).toBeGreaterThanOrEqual(seen);
      }
      expect(store.view().seen.length).toBeLessThanOrEqual(RECOVERY_SEEN_CAP);
      expect(store.view().attemptsInWindow).toBeGreaterThanOrEqual(0);
      expect(window).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("idle-recovery store: plan ownership", () => {
  it("rejects a plan produced for another session or owner", () => {
    const host = makeHost();
    const store = storeFor(host);
    store.noteHumanProof(PROOF());
    const prepared = store.prepare({ todo: todo([task({ id: 1 })]) });
    if (prepared.kind !== "ready") throw new Error("expected ready");
    const foreignPlan: RecoveryPlan = { ...prepared.plan, owner: "someone-else" };
    expect(store.reserve(foreignPlan)).toMatchObject({ kind: "denied", reason: "stale-plan" });
    expect(store.reserve({ ...prepared.plan, sid: "other" })).toMatchObject({ kind: "denied", reason: "stale-plan" });
    expect(store.view().attemptsInWindow).toBe(0);
  });
});
