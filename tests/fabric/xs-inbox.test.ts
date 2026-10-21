import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { MemoryOutboxStore } from "../../src/core/store.js";
import type { FabricRecord } from "../../src/core/message.js";
import { createDeliveryEngine } from "../../src/delivery/engine.js";
import { FabricTree } from "../../src/fabric/tree.js";
import { FabricThrottle } from "../../src/fabric/throttle.js";
import { FabricRouter } from "../../src/fabric/router.js";
import { XsInbox } from "../../src/fabric/xs/inbox.js";

/**
 * fabric phase-2 X4 (phase2-plan §8.4 + review #7 + §11.2 X4 行): the independent cross-session
 * inbox. Anchors: release rules per mode (a run that started after acceptance ends ⇒ release;
 * trigger releases on Controller idle), session_start clears, and the CROSS-INDEPENDENCE with
 * the tree-internal `FabricRouter.rootInbox()` counter — xs filling its inbox never changes the
 * tree counter and vice versa.
 */

function treeRouter(rootInboxCap: number): FabricRouter {
  const engine = createDeliveryEngine<FabricRecord, FabricRecord["state"]>({
    store: new MemoryOutboxStore<FabricRecord>(),
    allowed: {
      pending: ["claimed", "consumed", "dropped", "abandoned"],
      claimed: ["pending", "delivered", "consumed", "dropped"],
      delivered: [],
      consumed: [],
      dropped: [],
      abandoned: [],
    },
    memoryOnly: new Set(["claimed"]),
    memoryOnlyFields: ["claimToken"],
    now: () => 1,
  });
  const tree = new FabricTree();
  tree.append("root", "r_ABCDEFGH");
  tree.markRunning("r_ABCDEFGH");
  return new FabricRouter(
    engine,
    tree,
    new FabricThrottle({ minIntervalMs: 0, rootMinIntervalMs: 0, backoffMs: 0 }),
    {
      maxPerRun: 20,
      findingQuota: 10,
      directiveQuota: 5,
      deadLetterQuota: 5,
      maxChars: 2000,
      progressTtlMs: 900_000,
      reconcileTtlMs: 86_400_000,
      rootInboxCap,
      progressChannel: "context",
    },
    () => 1,
  );
}

function treeDeliver(router: FabricRouter, text: string) {
  return router.admit("r_ABCDEFGH", { to: "root", kind: "finding", text, generation: 1 });
}

describe("xs-inbox: release rules (§8.4)", () => {
  it("appended: released when a run that started AFTER acceptance settles", () => {
    const clock = new FakeClock(1_000);
    const inbox = new XsInbox(3, clock);
    expect(inbox.accept("a", "appended")).toBe(true);
    expect(inbox.occupied).toBe(1);
    clock.advance(10);
    inbox.onRunStart(clock.now()); // run starts after acceptance ⇒ in context
    expect(inbox.snapshot()[0]!.inContext).toBe(true);
    expect(inbox.onRunSettled()).toBe(1);
    expect(inbox.occupied).toBe(0);
  });

  it("an entry accepted AFTER the run start is NOT marked — only a later run releases it", () => {
    const clock = new FakeClock(1_000);
    const inbox = new XsInbox(3, clock);
    clock.advance(10);
    inbox.onRunStart(clock.now()); // run already running at t=1010
    inbox.accept("a", "queued"); // accepted at 1010, NOT before the run start
    inbox.onRunSettled();
    expect(inbox.occupied).toBe(1); // this run's context may not contain it
    clock.advance(10);
    inbox.onRunStart(clock.now());
    expect(inbox.snapshot()[0]!.inContext).toBe(true);
    expect(inbox.onRunSettled()).toBe(1);
    expect(inbox.occupied).toBe(0);
  });

  it("trigger: released by releaseTrigger() even without run observation (Controller idle)", () => {
    const clock = new FakeClock(1_000);
    const inbox = new XsInbox(3, clock);
    inbox.accept("t", "trigger");
    expect(inbox.onRunSettled()).toBe(0); // never marked in-context ⇒ run settle releases nothing
    expect(inbox.releaseTrigger()).toBe(1);
    expect(inbox.occupied).toBe(0);
  });

  it("trigger also releases through its own run start/settle (§8.4 '该 run 结束')", () => {
    const clock = new FakeClock(1_000);
    const inbox = new XsInbox(3, clock);
    inbox.accept("t", "trigger");
    clock.advance(5);
    inbox.onRunStart(clock.now());
    inbox.accept("a", "appended");
    clock.advance(5);
    inbox.onRunStart(clock.now());
    expect(inbox.onRunSettled()).toBe(2); // both in context, run ended
    expect(inbox.occupied).toBe(0);
  });

  it("releaseTrigger is idempotent and never touches appended/queued entries", () => {
    const clock = new FakeClock(1_000);
    const inbox = new XsInbox(3, clock);
    inbox.accept("t", "trigger");
    inbox.accept("a", "appended");
    expect(inbox.releaseTrigger()).toBe(1);
    expect(inbox.releaseTrigger()).toBe(0);
    expect(inbox.occupied).toBe(1);
  });

  it("cap: full ⇒ isFull, accept refuses (receiver turns that into none{inbox_full})", () => {
    const clock = new FakeClock(1_000);
    const inbox = new XsInbox(2, clock);
    inbox.accept("a", "appended");
    inbox.accept("b", "appended");
    expect(inbox.isFull()).toBe(true);
    expect(inbox.accept("c", "appended")).toBe(false);
    expect(inbox.occupied).toBe(2);
  });

  it("session_start ⇒ clear() wipes everything; released entries never accumulate", () => {
    const clock = new FakeClock(1_000);
    const inbox = new XsInbox(2, clock);
    inbox.accept("a", "appended");
    inbox.onRunStart(clock.now());
    inbox.onRunSettled();
    inbox.accept("b", "appended");
    inbox.clear();
    expect(inbox.occupied).toBe(0);
    expect(inbox.snapshot()).toEqual([]);
  });

  it("released entries are compacted even when pinned behind an unreleased entry", () => {
    const clock = new FakeClock(1_000);
    const inbox = new XsInbox(3, clock);
    inbox.accept("a", "appended");
    clock.advance(5);
    inbox.onRunStart(clock.now()); // run starts; 'a' in context
    inbox.accept("t", "trigger"); // accepted AFTER the run start ⇒ not marked
    expect(inbox.onRunSettled()).toBe(1);
    expect(inbox.snapshot()).toEqual([expect.objectContaining({ xid: "t" })]); // 'a' fully dropped
  });
});

describe("xs-inbox × tree rootInbox() cross-independence (review #7)", () => {
  it("xs inbox at cap does not change the tree rootInbox() count or its backpressure verdict", () => {
    const router = treeRouter(2);
    const inbox = new XsInbox(2, new FakeClock(0));
    inbox.accept("x1", "appended");
    inbox.accept("x2", "appended");
    expect(inbox.isFull()).toBe(true);
    expect(router.rootInbox()).toBe(0); // tree counter untouched by xs accounting
    expect(treeDeliver(router, "t1").ok).toBe(true);
    expect(router.rootInbox()).toBe(1);
    expect(treeDeliver(router, "t2").ok).toBe(true);
    // tree cap (2) now rejects its NEXT root delivery — independent of the xs inbox
    const full = treeDeliver(router, "t3");
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.status).toBe("target_backpressure");
    // ...while the xs inbox is full for entirely its own reasons
    expect(inbox.accept("x3", "appended")).toBe(false);
  });

  it("tree rootInbox at cap does not stop the xs inbox from accepting (and vice versa)", () => {
    const router = treeRouter(2);
    expect(treeDeliver(router, "t1").ok).toBe(true);
    expect(treeDeliver(router, "t2").ok).toBe(true);
    expect(router.rootInbox()).toBe(2);
    const inbox = new XsInbox(1, new FakeClock(0));
    expect(inbox.accept("x1", "appended")).toBe(true); // xs side unaffected
    expect(inbox.accept("x2", "appended")).toBe(false); // its OWN cap, not the tree's
  });
});
