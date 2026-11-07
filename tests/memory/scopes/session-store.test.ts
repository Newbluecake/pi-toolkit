/** #39 P1 store: single-append protocol, owner/cap/gate rechecks, poison, queue, locked. */
import { describe, expect, it } from "vitest";
import {
  createSessionMemoryStore,
  sessionPoisonIdentity,
  type SessionMemoryStoreDeps,
} from "../../../src/memory/scopes/session-store.js";
import { createMemoryOpCapRegistry, createHumanTurnTracker } from "../../../src/memory/scopes/op-cap.js";
import { scopedOpDigest, bodyTextDigest } from "../../../src/memory/scopes/limits.js";
import {
  SESSION_MEMORY_ENTRY_TYPE,
  type FrozenScopedOp,
  type MemoryOwner,
  type SessionMemoryWrite,
} from "../../../src/memory/scopes/types.js";

import { createSessionPoisonRegistry, type SessionRecoveryReceipt } from "../../../src/memory/scopes/session-poison.js";
const STAMP = "2026-11-07T00:00:00.000Z";

interface Harness {
  store: ReturnType<typeof createSessionMemoryStore>;
  branch: unknown[];
  appendCalls: { type: string; data: unknown }[];
  appendAttempts: () => number;
  /** null ⇒ the host reports NO session file (memory-only). */
  failAppend: () => void;
  swallowAppend: () => void;
  getBranchCalls: () => number;
  owner: MemoryOwner;
  setOwner: (owner: MemoryOwner) => void;
  setLocked: (locked: boolean) => void;
  setReopened: (value: boolean) => void;
  receipt: () => SessionRecoveryReceipt;
  deps: SessionMemoryStoreDeps;
}

function harness(overrides: Partial<{ child: boolean; sessionFile: string | null; queueLimit: number }> = {}): Harness {
  const branch: unknown[] = [];
  const appends: { type: string; data: unknown }[] = [];
  let attempts = 0;
  let failNext = false;
  let swallowNext = false;
  let getBranchCalls = 0;
  let locked = false;
  const poisonRegistry = createSessionPoisonRegistry();
  const recovery = poisonRegistry.recoveryAuthority();
  let receipt = Object.freeze({}) as SessionRecoveryReceipt;
  let entrySeq = 0;
  const incarnation = {};
  const owner: MemoryOwner = {
    incarnation,
    sid: "sess-1",
    ...(overrides.sessionFile === null
      ? {}
      : { sessionFile: overrides.sessionFile ?? "/vault/state/sessions/default/s.json" }),
    sessionEpoch: 1,
    branchGen: 1,
  };
  let current: MemoryOwner = owner;
  const deps: SessionMemoryStoreDeps = {
    currentOwner: () => current,
    isLocked: () => locked,
    getBranch: () => {
      getBranchCalls++;
      return branch;
    },
    getLeafId: () => `leaf-${branch.length}`,
    getSessionId: () => current.sid,
    getSessionFile: () =>
      overrides.sessionFile === undefined ? current.sessionFile : (overrides.sessionFile ?? undefined),
    appendCustomEntry: (type: string, data: unknown) => {
      attempts++;
      if (failNext) {
        failNext = false;
        throw new Error("EISDIR: illegal operation on a directory");
      }
      const entry = { type: "custom", customType: type, id: `e${++entrySeq}`, data };
      if (!swallowNext) branch.push(entry);
      swallowNext = false;
      appends.push({ type, data });
      // Real ExtensionAPI.appendEntry returns void.
    },
    now: () => STAMP,
    ...(overrides.child !== undefined ? { isChildSession: overrides.child } : {}),
    ...(overrides.queueLimit !== undefined ? { queueLimit: overrides.queueLimit } : {}),
    poisonRegistry,
    recovery,
    stableSessionIdentity: () => "fixture-session",
  };
  const store = createSessionMemoryStore(deps);
  return {
    store,
    branch,
    appendCalls: appends,
    appendAttempts: () => attempts,
    failAppend: () => {
      failNext = true;
    },
    swallowAppend: () => {
      swallowNext = true;
    },
    getBranchCalls: () => getBranchCalls,
    owner,
    setOwner: (next) => {
      current = next;
    },
    setLocked: (value) => {
      locked = value;
    },
    setReopened: (value) => {
      if (value) receipt = recovery.recordReopen(sessionPoisonIdentity("fixture-session"), "reopen");
    },
    receipt: () => receipt,
    deps,
  };
}

const agentPut = (text: string, owner: MemoryOwner): SessionMemoryWrite => ({
  operation: { storageScope: "session", op: "create", text, authority: "agent" } as FrozenScopedOp & {
    storageScope: "session";
  },
  owner,
});

const userPut = (text: string, owner: MemoryOwner, cap?: SessionMemoryWrite["cap"]): SessionMemoryWrite => ({
  operation: { storageScope: "session", op: "create", text, authority: "user" } as FrozenScopedOp & {
    storageScope: "session";
  },
  owner,
  ...(cap !== undefined ? { cap } : {}),
});

describe("write protocol", () => {
  it("each operation performs EXACTLY one append and the effect is visible afterwards", async () => {
    const h = harness();
    const first = await h.store.enqueue(agentPut("one", h.owner));
    expect(first).toMatchObject({ ok: true, id: "n1", persistence: "appended" });
    const second = await h.store.enqueue(agentPut("two", h.owner));
    expect(second).toMatchObject({ ok: true, id: "n2" });
    expect(h.appendCalls.length).toBe(2);
    expect(h.appendCalls[0]?.type).toBe(SESSION_MEMORY_ENTRY_TYPE);
    expect(h.store.view().items.map((f) => f.item.text)).toEqual(["one", "two"]);
  });

  it("reports memory-only when there is no session file", async () => {
    const h = harness({ sessionFile: null });
    const result = await h.store.enqueue(agentPut("x", h.owner));
    expect(result).toMatchObject({ ok: true, persistence: "memory-only" });
  });

  it("FIFO: a queued second op sees the first op's effect (single folded truth)", async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      h.store.enqueue(agentPut("a", h.owner)),
      h.store.enqueue({
        operation: {
          storageScope: "session",
          op: "update",
          targetId: "n1",
          text: "a2",
          authority: "agent",
        } as unknown as FrozenScopedOp & { storageScope: "session" },
        owner: h.owner,
      }),
    ]);
    expect(a).toMatchObject({ ok: true, id: "n1" });
    // b targeted n1 without a rev: E_REV_REQUIRED (strict CAS — no silent overwrite)
    expect(b).toMatchObject({ ok: false, code: "E_REV_REQUIRED" });
    expect(h.appendCalls.length).toBe(1);
  });

  it("owner change between admission and the commit gate ⇒ E_STALE_SESSION with ZERO appends", async () => {
    const h = harness();
    // flip the owner during the dequeue-time fresh fold: the synchronous last-await recheck
    // (immediately before the append) must then see a dead owner and refuse.
    const original = h.deps.getBranch;
    (h.deps as { getBranch: () => readonly unknown[] }).getBranch = () => {
      h.setOwner({ ...h.owner, sid: "other-session" });
      return original();
    };
    const result = await h.store.enqueue(agentPut("x", h.owner));
    expect(result).toMatchObject({ ok: false, code: "E_STALE_SESSION" });
    expect(h.appendCalls.length).toBe(0);
  });

  it("an aborted signal rejects with zero appends", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const result = await h.store.enqueue({ ...agentPut("x", h.owner), signal: controller.signal });
    expect(result).toMatchObject({ ok: false, code: "E_STALE_SESSION" });
    expect(h.appendCalls.length).toBe(0);
  });

  it("session write gate refusal at the commit gate ⇒ E_WRITE_GATE, zero appends", async () => {
    const h = harness();
    let refuseAtCommit = false;
    const gate = {
      check: () => (refuseAtCommit ? { ok: false as const, reason: "unmounted" } : { ok: true as const }),
    };
    const original = h.deps.getBranch;
    const store = createSessionMemoryStore({
      ...h.deps,
      sessionWriteGate: gate,
      // flip the gate while the dequeue-time fresh fold reads the branch: the LAST check
      // (immediately before the append) must still refuse.
      getBranch: () => {
        refuseAtCommit = true;
        return original();
      },
    });
    const result = await store.enqueue(agentPut("x", h.owner));
    expect(result).toMatchObject({ ok: false, code: "E_WRITE_GATE" });
    expect(h.appendCalls.length).toBe(0);
  });
});

describe("authority and child rules", () => {
  const mintCap = (harnessDeps: { currentOwner: () => MemoryOwner }) => {
    const tracker = createHumanTurnTracker();
    const registry = createMemoryOpCapRegistry(() => tracker.current());
    const owner = harnessDeps.currentOwner();
    const turn = tracker.noteInteractive(owner);
    const operation = { storageScope: "session", op: "create", text: "user fact", authority: "user" } as FrozenScopedOp;
    return {
      tracker,
      registry,
      cap: registry.mint({
        operation,
        binding: {
          owner,
          humanTurn: turn,
          toolCallId: "tc1",
          nonce: "a".repeat(32),
          opDigest: scopedOpDigest(operation as unknown as Record<string, unknown>),
          textDigest: bodyTextDigest("user fact"),
        },
        channel: "tui" as const,
        project: "proj",
      }),
    };
  };

  it("user authority without a cap ⇒ E_AUTHORITY (a string literal authorizes nothing)", async () => {
    const h = harness();
    const result = await h.store.enqueue(userPut("user fact", h.owner));
    expect(result).toMatchObject({ ok: false, code: "E_AUTHORITY" });
    expect(h.appendCalls.length).toBe(0);
  });

  it("user authority with a live cap writes, consumes the cap once and stamps the grant", async () => {
    const h = harness();
    const { registry, cap } = mintCap(h.deps);
    const store = createSessionMemoryStore({ ...h.deps, caps: registry });
    const result = await store.enqueue(userPut("user fact", h.owner, cap));
    expect(result).toMatchObject({ ok: true, id: "n1" });
    const written = store.view().items[0]!;
    expect(written.item.authority).toBe("user");
    expect(written.item.grant).toMatchObject({ via: "dialog", channel: "tui" });
    expect(registry.stateOf(cap)).toBe("unknown"); // consumed records are gone
    // The consumed cap cannot authorize a second write.
    const again = await store.enqueue(userPut("more", h.owner, cap));
    expect(again).toMatchObject({ ok: false, code: "E_HUB_CAP_STALE" });
    expect(h.appendCalls.length).toBe(1);
  });

  it("a cap revoked between reserve and the commit gate ⇒ E_HUB_CAP_STALE, zero appends", async () => {
    const h = harness();
    const { registry, tracker, cap } = mintCap(h.deps);
    const original = h.deps.getBranch;
    const store = createSessionMemoryStore({
      ...h.deps,
      caps: registry,
      // the fresh fold's first branch read invalidates the human turn: reserve succeeded at
      // admission, but the commit-gate recheck must refuse.
      getBranch: () => {
        tracker.invalidate("input");
        return original();
      },
    });
    const result = await store.enqueue(userPut("user fact", h.owner, cap));
    expect(result).toMatchObject({ ok: false, code: "E_HUB_CAP_STALE" });
    expect(h.appendCalls.length).toBe(0);
  });

  it("child sessions: authority=user parameter ⇒ E_CHILD_AUTHORITY; agent writes to own session ok", async () => {
    const h = harness({ child: true });
    const ok = await h.store.enqueue(agentPut("own note", h.owner));
    expect(ok).toMatchObject({ ok: true, id: "n1" });
    const refused = await h.store.enqueue(userPut("sneaky", h.owner));
    expect(refused).toMatchObject({ ok: false, code: "E_CHILD_AUTHORITY" });
    expect(h.appendCalls.length).toBe(1);
  });

  it("child cannot modify inherited user entries (E_AUTHORITY)", async () => {
    // seed the branch with a user item written by the parent session
    const seeded = harness({ child: true });
    seeded.branch.push({
      type: "custom",
      customType: SESSION_MEMORY_ENTRY_TYPE,
      id: "e0",
      data: {
        v: 1,
        sid: "parent",
        op: "put",
        item: {
          id: "n1",
          text: "parent user rule",
          authority: "user",
          grant: { via: "dialog", turn: "aabbccdd", cap: "11223344" },
          created: STAMP,
          updated: STAMP,
        },
      },
    });
    expect(seeded.store.view().items[0]?.inherited).toEqual({ kind: "fork", fromSid: "parent" });
    const delChild = await seeded.store.enqueue({
      operation: {
        storageScope: "session",
        op: "delete",
        targetId: "n1",
        authority: "agent",
      } as unknown as FrozenScopedOp & { storageScope: "session" },
      owner: seeded.owner,
    });
    expect(delChild).toMatchObject({ ok: false, code: "E_AUTHORITY" });
    expect(seeded.appendCalls.length).toBe(0);
  });
});

describe("poison (Root C0 ruling)", () => {
  it("an observed append failure ⇒ E_PERSIST + poisoned; no retry; later writes fail closed", async () => {
    const h = harness();
    h.failAppend();
    const first = await h.store.enqueue(agentPut("x", h.owner));
    expect(first).toMatchObject({ ok: false, code: "E_PERSIST_UNKNOWN" });
    expect(first.ok === false && first.persistenceFailure).toMatchObject({
      poisoned: true,
      recovery: "explicit-reopen-and-verify",
      observedBy: "scoped-writer",
    });
    expect(h.appendAttempts()).toBe(1); // exactly one failed attempt — and NOTHING after it
    const second = await h.store.enqueue(agentPut("y", h.owner));
    expect(second).toMatchObject({ ok: false, code: "E_PERSIST_UNKNOWN" });
    expect(second.ok === false && second.persistenceFailure?.poisoned).toBe(true);
    expect(h.appendAttempts()).toBe(1); // no auto retry/repair
    expect(h.store.view().poisoned).toBe(true);
  });

  it("reload alone is NOT recovery: verifyRecovery needs the host's explicit reopen assertion", async () => {
    const h = harness();
    h.failAppend();
    await h.store.enqueue(agentPut("x", h.owner));
    expect(h.store.verifyRecovery(h.receipt())).toBe(false); // isReopened() is still false
    h.setReopened(true);
    expect(h.store.verifyRecovery(h.receipt())).toBe(true);
    const after = await h.store.enqueue(agentPut("x", h.owner));
    expect(after).toMatchObject({ ok: true, id: "n1" });
    expect(h.appendAttempts()).toBe(2);
  });

  it("verifyRecovery with a throwing branch stays poisoned", async () => {
    const h = harness();
    h.failAppend();
    await h.store.enqueue(agentPut("x", h.owner));
    h.setReopened(true);
    const original = h.deps.getBranch;
    (h.deps as { getBranch: () => readonly unknown[] }).getBranch = () => {
      throw new Error("session file unreadable");
    };
    expect(h.store.verifyRecovery(h.receipt())).toBe(false);
    expect(h.store.poisonedNow()).toBe(true);
    (h.deps as { getBranch: () => readonly unknown[] }).getBranch = original;
  });

  it("append succeeded but the effect is invisible ⇒ E_PERSIST_UNKNOWN + poison", async () => {
    const h = harness();
    h.swallowAppend(); // the fake manager accepts the entry but it never reaches the branch
    const result = await h.store.enqueue(agentPut("x", h.owner));
    expect(result).toMatchObject({ ok: false, code: "E_PERSIST_UNKNOWN" });
    expect(result.ok === false && result.persistenceFailure?.poisoned).toBe(true);
    const next = await h.store.enqueue(agentPut("y", h.owner));
    expect(next).toMatchObject({ ok: false, code: "E_PERSIST_UNKNOWN" });
    expect(h.appendAttempts()).toBe(1);
    expect(h.appendCalls.length).toBe(1); // the swallowed append recorded, the retry never ran
  });
});

describe("locked discipline and queue bounds", () => {
  it("locked: fold/view/snapshot return empty with ZERO getBranch calls; writes refuse", async () => {
    const h = harness();
    await h.store.enqueue(agentPut("x", h.owner)); // one real entry
    h.setLocked(true);
    const readsBefore = h.getBranchCalls();
    expect(h.store.view().items).toEqual([]);
    expect(h.store.snapshot()).toEqual({ v: 1, state: "empty" });
    expect(h.getBranchCalls()).toBe(readsBefore);
    const write = await h.store.enqueue(agentPut("y", h.owner));
    expect(write).toMatchObject({ ok: false, code: "E_WRITE_GATE" });
    expect(h.appendCalls.length).toBe(1);
    h.setLocked(false);
    expect(h.store.view().items.length).toBe(1); // real branch again
  });

  it("queue bound: over-limit enqueues fail E_BUSY without touching the manager", async () => {
    const h = harness({ queueLimit: 1 });
    const first = h.store.enqueue(agentPut("a", h.owner));
    const second = h.store.enqueue(agentPut("b", h.owner));
    expect(await second).toMatchObject({ ok: false, code: "E_BUSY" });
    expect(await first).toMatchObject({ ok: true, id: "n1" });
    expect(h.appendCalls.length).toBe(1);
  });

  it("dispose rejects further writes", async () => {
    const h = harness();
    h.store.dispose();
    expect(await h.store.enqueue(agentPut("x", h.owner))).toMatchObject({ ok: false, code: "E_STALE_SESSION" });
    expect(h.appendCalls.length).toBe(0);
  });
});

/** Seed one wholly-legal high-watermark entry (item n999999) directly into the branch. */
const seedHighWatermark = (h: Harness): void => {
  h.branch.push({
    type: "custom",
    customType: SESSION_MEMORY_ENTRY_TYPE,
    id: "e0",
    data: {
      v: 1,
      sid: "sess-1",
      op: "put",
      item: {
        id: "n999999",
        text: "high-watermark",
        authority: "agent",
        created: STAMP,
        updated: STAMP,
      },
    },
  });
};

describe("id exhaustion (store level)", () => {
  it("legal high-watermark n999999 ⇒ create refuses E_FULL, zero appends, original entry untouched", async () => {
    const h = harness();
    seedHighWatermark(h);
    expect(h.store.view().items.map((f) => f.item.id)).toEqual(["n999999"]); // fold reconstructed the sentinel
    const refused = await h.store.enqueue(agentPut("x", h.owner));
    expect(refused).toMatchObject({ ok: false, code: "E_FULL" });
    expect(h.appendCalls.length).toBe(0);
    expect(h.appendAttempts()).toBe(0);
    expect(h.store.view().items.map((f) => f.item.id)).toEqual(["n999999"]); // never reused/overwritten (K9)
  });

  it("update by explicit id + legal rev still succeeds under exhaustion (planner passthrough)", async () => {
    const h = harness();
    seedHighWatermark(h);
    const rev = h.store.view().items[0]!.rev;
    const updated = await h.store.enqueue({
      operation: {
        storageScope: "session",
        op: "update",
        targetId: "n999999",
        text: "still writable",
        authority: "agent",
        expectRev: rev,
      } as unknown as FrozenScopedOp & { storageScope: "session" },
      owner: h.owner,
    });
    expect(updated).toMatchObject({ ok: true, id: "n999999" });
    expect(h.appendCalls.length).toBe(1);
    expect(h.store.view().items[0]?.item.text).toBe("still writable");
  });
});

describe("snapshot (seed capture seam for P2)", () => {
  it("empty state ⇒ explicit empty; non-empty ⇒ captured, deep-copied and deeply frozen", async () => {
    const h = harness();
    expect(h.store.snapshot()).toEqual({ v: 1, state: "empty" });
    await h.store.enqueue(agentPut("stable", h.owner));
    const captured = h.store.snapshot();
    expect(captured.state).toBe("captured");
    if (captured.state === "captured") {
      expect(captured.seed.fromSid).toBe("sess-1");
      expect(captured.seed.items[0]?.text).toBe("stable");
      expect(Object.isFrozen(captured.seed)).toBe(true);
      expect(Object.isFrozen(captured.seed.items)).toBe(true);
      expect(Object.isFrozen(captured.seed.items[0])).toBe(true);
      // the branch keeps evolving — the earlier capture is unaffected
      await h.store.enqueue(agentPut("later", h.owner));
      expect(captured.seed.items.length).toBe(1);
    }
  });

  it("the fold cache is transparent: repeated view() calls agree with the branch", async () => {
    const h = harness();
    await h.store.enqueue(agentPut("a", h.owner));
    const before = h.store.view().items.length;
    expect(h.store.view().items.length).toBe(before);
    await h.store.enqueue(agentPut("b", h.owner));
    expect(h.store.view().items.length).toBe(before + 1);
  });
});

describe("P1c exact cap binding and exception closure", () => {
  function authorization(
    h: Harness,
    operation: FrozenScopedOp,
    digests: Partial<{ opDigest: string; textDigest: string }> = {},
  ) {
    const tracker = createHumanTurnTracker();
    const registry = createMemoryOpCapRegistry(() => tracker.current());
    const turn = tracker.noteInteractive(h.owner);
    const cap = registry.mint({
      operation,
      channel: "tui",
      project: "proj",
      binding: {
        owner: h.owner,
        humanTurn: turn,
        toolCallId: "tc",
        nonce: "a".repeat(32),
        opDigest: digests.opDigest ?? scopedOpDigest(operation as unknown as Record<string, unknown>),
        textDigest: digests.textDigest ?? bodyTextDigest(operation.text ?? ""),
      },
    });
    return { registry, cap };
  }
  const approved = (): SessionMemoryWrite["operation"] => ({
    storageScope: "session",
    op: "create",
    text: "approved A",
    authority: "user",
  });
  it.each([
    { text: "request B" },
    { authority: "agent" },
    { from: "project:other.md" },
    { op: "update", targetId: "n1", expectRev: "12345678" },
    { topic: "ignored-topic" },
  ])("cap A cannot authorize substituted operation %j; failed cap is revoked", async (patch) => {
    const h = harness();
    const { registry, cap } = authorization(h, approved());
    const store = createSessionMemoryStore({ ...h.deps, caps: registry });
    const result = await store.enqueue({
      operation: { ...approved(), ...patch } as SessionMemoryWrite["operation"],
      owner: h.owner,
      cap,
    });
    expect(result.ok).toBe(false);
    expect(h.appendAttempts()).toBe(0);
    expect(registry.stateOf(cap)).toBe("revoked");
    expect(await store.enqueue({ operation: approved(), owner: h.owner, cap })).toMatchObject({
      ok: false,
      code: "E_HUB_CAP_STALE",
    });
  });
  it.each(["opDigest", "textDigest"] as const)("checks full %s before planning", async (field) => {
    const h = harness();
    const { registry, cap } = authorization(h, approved(), { [field]: "0".repeat(64) });
    let plans = 0;
    const store = createSessionMemoryStore({
      ...h.deps,
      caps: registry,
      now: () => {
        plans++;
        return STAMP;
      },
    });
    expect(await store.enqueue({ operation: approved(), owner: h.owner, cap })).toMatchObject({
      ok: false,
      code: "E_HUB_CAP_STALE",
    });
    expect(plans).toBe(0);
    expect(h.appendAttempts()).toBe(0);
    expect(registry.stateOf(cap)).toBe("revoked");
  });
  it("checks operation + digests AGAIN at commit, rejecting changed registry inspection", async () => {
    const h = harness();
    const { registry, cap } = authorization(h, approved());
    const store = createSessionMemoryStore({
      ...h.deps,
      caps: {
        ...registry,
        check: (c, o) => {
          const original = registry.check(c, o);
          return original === undefined
            ? undefined
            : { ...original, binding: { ...original.binding, textDigest: "0".repeat(64) } };
        },
      },
    });
    expect(await store.enqueue({ operation: approved(), owner: h.owner, cap })).toMatchObject({
      ok: false,
      code: "E_HUB_CAP_STALE",
    });
    expect(h.appendAttempts()).toBe(0);
    expect(registry.stateOf(cap)).toBe("revoked");
  });
  it("request mutation during planning cannot change authorized text; cap revoked", async () => {
    const h = harness();
    const { registry, cap } = authorization(h, approved());
    const op = { ...approved() };
    const store = createSessionMemoryStore({
      ...h.deps,
      caps: registry,
      now: () => {
        op.text = "changed";
        return STAMP;
      },
    });
    expect(await store.enqueue({ operation: op, owner: h.owner, cap })).toMatchObject({
      ok: false,
      code: "E_HUB_CAP_STALE",
    });
    expect(h.appendAttempts()).toBe(0);
    expect(registry.stateOf(cap)).toBe("revoked");
  });
  it("gate throw is proven zero-write normal rejection, cap revoked, queue released", async () => {
    const h = harness();
    const { registry, cap } = authorization(h, approved());
    let throws = true;
    const store = createSessionMemoryStore({
      ...h.deps,
      caps: registry,
      queueLimit: 1,
      sessionWriteGate: {
        check() {
          if (throws) throw new Error("gate");
          return { ok: true };
        },
      },
    });
    expect(await store.enqueue({ operation: approved(), owner: h.owner, cap })).toEqual({
      ok: false,
      code: "E_WRITE_GATE",
    });
    expect(store.poisonedNow()).toBe(false);
    expect(h.appendAttempts()).toBe(0);
    expect(registry.stateOf(cap)).toBe("revoked");
    throws = false;
    expect(await store.enqueue(agentPut("next", h.owner))).toMatchObject({ ok: true });
  });
  it.each(["branch", "leaf", "sessionId"])(
    "post-append %s throws => resolved UNKNOWN + shared poison, no retry",
    async (failure) => {
      const h = harness();
      let appended = false;
      const store = createSessionMemoryStore({
        ...h.deps,
        appendCustomEntry: (t, d) => {
          h.deps.appendCustomEntry(t, d);
          appended = true;
        },
        getBranch: () => {
          if (appended && failure === "branch") throw new Error("branch");
          return h.deps.getBranch();
        },
        getLeafId: () => {
          if (appended && failure === "leaf") throw new Error("leaf");
          return "leaf";
        },
        getSessionId: () => {
          if (appended && failure === "sessionId") throw new Error("sid");
          return h.owner.sid;
        },
      });
      expect(await store.enqueue(agentPut("x", h.owner))).toMatchObject({
        ok: false,
        code: "E_PERSIST_UNKNOWN",
        persistenceFailure: { poisoned: true },
      });
      const rebuilt = createSessionMemoryStore({ ...h.deps, currentOwner: () => ({ ...h.owner, incarnation: {} }) });
      expect(rebuilt.poisonedNow()).toBe(true);
      expect(await rebuilt.enqueue(agentPut("y", { ...h.owner, incarnation: {} }))).toMatchObject({ ok: false });
      expect(h.appendAttempts()).toBe(1);
    },
  );
  it("ordinary rebuild/tree/off-on preserves poison, explicit receipt plus real branch required", async () => {
    const h = harness();
    h.failAppend();
    await h.store.enqueue(agentPut("x", h.owner));
    const rebuilt = createSessionMemoryStore(h.deps);
    expect(rebuilt.poisonedNow()).toBe(true);
    expect(rebuilt.verifyRecovery(h.receipt())).toBe(false);
    h.setReopened(true);
    expect(rebuilt.verifyRecovery(h.receipt())).toBe(true);
    expect(h.store.poisonedNow()).toBe(false);
    expect(await rebuilt.enqueue(agentPut("x", h.owner))).toMatchObject({ ok: true });
  });
  it("disabled and locked recovery never read branch or resolve poison global", async () => {
    const h = harness();
    let registryReads = 0;
    const deps = {
      ...h.deps,
      enabled: false,
      get poisonRegistry(): ReturnType<typeof createSessionPoisonRegistry> {
        registryReads++;
        throw new Error("must not resolve");
      },
    };
    const off = createSessionMemoryStore(deps);
    expect(off.view().items).toEqual([]);
    expect(off.snapshot()).toEqual({ v: 1, state: "empty" });
    expect(await off.enqueue(agentPut("x", h.owner))).toEqual({ ok: false, code: "E_SCOPE_DISABLED" });
    expect(off.poisonedNow()).toBe(false);
    expect(off.verifyRecovery(h.receipt())).toBe(false);
    expect(registryReads).toBe(0);
    expect(h.getBranchCalls()).toBe(0);
    h.setLocked(true);
    expect(h.store.verifyRecovery(h.receipt())).toBe(false);
    expect(h.getBranchCalls()).toBe(0);
  });
  it("32nd delete cause-snap verifies deletion without poisoning", async () => {
    const h = harness();
    await h.store.enqueue(agentPut("target", h.owner));
    for (let n = 0; n < 30; n++) {
      const item = h.store.view().items[0]!;
      expect(
        await h.store.enqueue({
          operation: {
            storageScope: "session",
            op: "update",
            authority: "agent",
            targetId: item.item.id,
            expectRev: item.rev,
            text: `v${n}`,
          },
          owner: h.owner,
        }),
      ).toMatchObject({ ok: true });
    }
    const item = h.store.view().items[0]!;
    expect(
      await h.store.enqueue({
        operation: {
          storageScope: "session",
          op: "delete",
          authority: "agent",
          targetId: item.item.id,
          expectRev: item.rev,
        },
        owner: h.owner,
      }),
    ).toMatchObject({ ok: true });
    expect(h.appendAttempts()).toBe(32);
    expect(h.store.view().items).toHaveLength(0);
    expect(h.store.poisonedNow()).toBe(false);
  });
});

describe("P1c stable global store identity", () => {
  it("new activation and tree do not forgive, different sid/new/fork writes remain independent", async () => {
    const h = harness();
    const { poisonRegistry: _registry, stableSessionIdentity: _identity, ...base } = h.deps;
    const originalOwner = { ...h.owner, sid: "p1c-global-parent" };
    const originalDeps = { ...base, currentOwner: () => originalOwner, getSessionId: () => originalOwner.sid };
    const parent = createSessionMemoryStore(originalDeps);
    expect(await parent.enqueue(agentPut("inherited parent fact", originalOwner))).toMatchObject({ ok: true });
    h.failAppend();
    expect(await parent.enqueue(agentPut("uncertain", originalOwner))).toMatchObject({
      ok: false,
      code: "E_PERSIST_UNKNOWN",
    });
    const reloadOwner = { ...originalOwner, incarnation: {}, sessionEpoch: 9, branchGen: 12 };
    const reloaded = createSessionMemoryStore({ ...originalDeps, currentOwner: () => reloadOwner });
    expect(reloaded.poisonedNow()).toBe(true);
    expect(await reloaded.enqueue(agentPut("cannot retry", reloadOwner))).toMatchObject({
      ok: false,
      code: "E_PERSIST_UNKNOWN",
    });
    expect(h.appendAttempts()).toBe(2);
    const forkOwner = { ...reloadOwner, sid: "p1c-global-fork", sessionFile: "/own-tmp/fork.json" };
    const fork = createSessionMemoryStore({
      ...base,
      currentOwner: () => forkOwner,
      getSessionId: () => forkOwner.sid,
      getSessionFile: () => forkOwner.sessionFile,
    });
    expect(fork.poisonedNow()).toBe(false);
    expect(fork.view().items[0]?.inherited).toEqual({ kind: "fork", fromSid: originalOwner.sid });
    expect(await fork.enqueue(agentPut("independent fork", forkOwner))).toMatchObject({ ok: true });
    const newOwner = { ...reloadOwner, sid: "p1c-global-new" };
    const blank: unknown[] = [];
    const fresh = createSessionMemoryStore({
      ...base,
      currentOwner: () => newOwner,
      getSessionId: () => newOwner.sid,
      getBranch: () => blank,
      appendCustomEntry: (type, data) => {
        blank.push({ type: "custom", customType: type, id: "new-entry", data });
      },
    });
    expect(fresh.view().items).toHaveLength(0);
    expect(await fresh.enqueue(agentPut("fresh", newOwner))).toMatchObject({ ok: true });
    expect(reloaded.poisonedNow()).toBe(true);
  });
  it("all enqueue admission errors resolve; getters are not leaked as rejected promises", async () => {
    const h = harness();
    const request = {
      ...agentPut("x", h.owner),
      get cap(): SessionMemoryWrite["cap"] {
        throw new Error("getter");
      },
    } as SessionMemoryWrite;
    expect(await h.store.enqueue(request)).toEqual({ ok: false, code: "E_META_INVALID" });
    expect(h.appendAttempts()).toBe(0);
  });
});
