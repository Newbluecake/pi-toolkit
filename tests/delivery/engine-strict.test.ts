import { describe, expect, it } from "vitest";
import { createDeliveryEngine } from "../../src/delivery/engine.js";
import { MemoryOutboxStore } from "../../src/core/store.js";
import { createPiOutboxStore } from "../../src/adapters/pi-outbox-store.js";
import type { FabricRecord } from "../../src/core/message.js";

/**
 * fabric-cross-session plan v3 §3.5/§4.1/§8-S0 (D-W11): the persist-before-memory, CAS-guarded strict ops
 * (`transitionStrict` / `annotateStrict` / `reserveStrict`). The legacy ops (`transition` / `annotate`) keep their
 * memory-first semantics — tests/delivery/engine.test.ts still pins that.
 */
const KEY = "r_ABCDEFGH:root:1:1" as FabricRecord["key"];
const base = (over: Partial<FabricRecord> = {}): FabricRecord => ({
  key: KEY,
  from: "r_ABCDEFGH",
  to: "root",
  kind: "finding",
  seq: 1,
  generation: 1,
  payload: { text: "hello" },
  ttlMs: 100,
  createdAt: 0,
  state: "pending",
  attempts: 0,
  updatedAt: 0,
  ...over,
});

/** A store that records every persisted write and can be told to throw. */
class SpyStore extends MemoryOutboxStore<FabricRecord> {
  writes: Array<{ key: string; patch: Partial<FabricRecord> }> = [];
  failNext = false;
  override update(key: string, patch: Partial<FabricRecord>): void {
    if (this.failNext) throw new Error("disk full");
    this.writes.push({ key, patch: { ...patch } });
    super.update(key, patch);
  }
}

function setup(over: { now?: () => number } = {}) {
  let t = 10;
  const store = new SpyStore();
  const degraded: string[] = [];
  const engine = createDeliveryEngine<FabricRecord, FabricRecord["state"]>({
    store,
    allowed: {
      pending: ["claimed", "consumed", "dropped", "abandoned"],
      claimed: ["pending", "delivered", "consumed", "dropped"],
      delivered: [],
      consumed: [],
      dropped: [],
      abandoned: [],
    },
    memoryOnly: new Set(["claimed"]),
    memoryOnlyFields: ["claimToken", "quarantined"],
    now: over.now ?? (() => t++),
    onDegraded: (key) => degraded.push(key),
  });
  engine.put(base());
  store.writes.length = 0;
  return { engine, store, degraded };
}
const reservation = { rsv: "r_RSV00001", runId: "r_RESUME01", at: 20 };

describe("reserveStrict", () => {
  it("pending: persists pending+reserved FIRST, then memory (state stays pending)", () => {
    const { engine, store } = setup();
    expect(engine.reserveStrict(KEY, { state: "pending" }, reservation, 50, 100)).toEqual({ ok: true });
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]!.patch).toMatchObject({ reserved: reservation });
    expect(store.writes[0]!.patch).not.toHaveProperty("state");
    expect(engine.get(KEY)).toMatchObject({ state: "pending", reserved: reservation });
    expect(store.list()[0]).toMatchObject({ state: "pending", reserved: reservation });
  });

  it("claimed trigger: ownership passes to the reservation — memory normalized to pending, claimToken gone, persisted form never has it", () => {
    const { engine, store } = setup();
    engine.claim(KEY, "mailbox:7");
    expect(engine.get(KEY)?.state).toBe("claimed");
    expect(engine.reserveStrict(KEY, { state: "claimed", claimToken: "mailbox:7" }, reservation, 50, 100)).toEqual({
      ok: true,
    });
    const mem = engine.get(KEY)!;
    expect(mem.state).toBe("pending");
    expect(mem).not.toHaveProperty("claimToken");
    expect(mem.reserved).toEqual(reservation);
    const persisted = store.list()[0]!;
    expect(persisted.state).toBe("pending");
    expect(JSON.stringify(persisted)).not.toContain("claimToken");
    expect(JSON.stringify(store.writes)).not.toContain("mailbox:7");
    // the old claim is dead: a verdict-style CAS with the old token conflicts
    expect(engine.transitionStrict(KEY, { state: "claimed", claimToken: "mailbox:7" }, "delivered")).toEqual({
      ok: false,
      reason: "conflict",
    });
  });

  it("store throws ⇒ persist_failed and memory is byte-for-byte unchanged (claimed stays claimed with its token)", () => {
    const { engine, store, degraded } = setup();
    engine.claim(KEY, "mailbox:7");
    const before = engine.get(KEY);
    store.failNext = true;
    expect(engine.reserveStrict(KEY, { state: "claimed", claimToken: "mailbox:7" }, reservation, 50, 100)).toEqual({
      ok: false,
      reason: "persist_failed",
    });
    expect(engine.get(KEY)).toEqual(before);
    expect(degraded).toEqual([]); // the caller owns the failure; strict ops never route through onDegraded
    store.failNext = false;
    // still reservable afterwards (nothing half-applied)
    expect(engine.reserveStrict(KEY, { state: "claimed", claimToken: "mailbox:7" }, reservation, 50, 100)).toEqual({
      ok: true,
    });
  });

  it.each([
    ["pending expected but record claimed", { state: "pending" as const }, true],
    ["claimed expected, wrong token", { state: "claimed" as const, claimToken: "nope" }, true],
    ["claimed expected but record pending", { state: "claimed" as const, claimToken: "mailbox:7" }, false],
  ])("CAS conflict: %s", (_name, expect_, claimFirst) => {
    const { engine, store } = setup();
    if (claimFirst) engine.claim(KEY, "mailbox:7");
    const before = engine.get(KEY);
    expect(engine.reserveStrict(KEY, expect_, reservation, 50, 100)).toEqual({ ok: false, reason: "conflict" });
    expect(engine.get(KEY)).toEqual(before);
    expect(store.writes).toEqual([]);
  });

  it("unknown key / already reserved / quarantined ⇒ conflict, never overwrites another run's reservation", () => {
    const { engine } = setup();
    expect(engine.reserveStrict("missing", { state: "pending" }, reservation, 50, 100)).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(engine.reserveStrict(KEY, { state: "pending" }, reservation, 50, 100)).toEqual({ ok: true });
    expect(engine.reserveStrict(KEY, { state: "pending" }, { ...reservation, rsv: "other" }, 50, 100)).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(engine.get(KEY)?.reserved?.rsv).toBe(reservation.rsv);
    const q = setup();
    q.engine.annotateStrict(KEY, { state: "pending" }, { quarantined: true });
    expect(q.engine.reserveStrict(KEY, { state: "pending" }, reservation, 50, 100)).toEqual({
      ok: false,
      reason: "conflict",
    });
  });

  it("expiry uses `now >= createdAt + ttlMs` (the F0 comparison): the boundary instant is expired, one ms before is not", () => {
    const a = setup();
    expect(a.engine.reserveStrict(KEY, { state: "pending" }, reservation, 99, 100)).toEqual({ ok: true });
    const b = setup();
    expect(b.engine.reserveStrict(KEY, { state: "pending" }, reservation, 100, 100)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(b.store.writes).toEqual([]);
    expect(b.engine.get(KEY)).not.toHaveProperty("reserved");
    const c = setup();
    expect(c.engine.reserveStrict(KEY, { state: "pending" }, reservation, 5_000, 100)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("frozen ⇒ frozen (no write)", () => {
    const { engine, store } = setup();
    engine.freeze();
    expect(engine.reserveStrict(KEY, { state: "pending" }, reservation, 50, 100)).toEqual({
      ok: false,
      reason: "frozen",
    });
    expect(store.writes).toEqual([]);
  });
});

describe("annotateStrict", () => {
  it("persists first, keeps `claimed` in memory, persists the normalized pending form without memory-only fields", () => {
    const { engine, store } = setup();
    engine.claim(KEY, "mailbox:7");
    const res = engine.annotateStrict(
      KEY,
      { state: "claimed", claimToken: "mailbox:7" },
      { steerAttempt: { runId: "r_SUCC0001", at: 30 }, quarantined: true },
    );
    expect(res).toEqual({ ok: true });
    expect(engine.get(KEY)).toMatchObject({
      state: "claimed",
      claimToken: "mailbox:7",
      quarantined: true,
      steerAttempt: { runId: "r_SUCC0001", at: 30 },
    });
    const persisted = store.list()[0]!;
    expect(persisted.state).toBe("pending");
    expect(persisted.steerAttempt).toEqual({ runId: "r_SUCC0001", at: 30 });
    expect(persisted).not.toHaveProperty("quarantined");
    expect(persisted).not.toHaveProperty("claimToken");
    expect(store.writes[0]!.patch).not.toHaveProperty("state");
  });

  it("store throws ⇒ persist_failed, memory unchanged", () => {
    const { engine, store } = setup();
    const before = engine.get(KEY);
    store.failNext = true;
    expect(engine.annotateStrict(KEY, { state: "pending" }, { parked: { at: 1, reason: "wake_false" } })).toEqual({
      ok: false,
      reason: "persist_failed",
    });
    expect(engine.get(KEY)).toEqual(before);
  });

  it("CAS conflict on state or token; a memory-only state must be addressed WITH its token", () => {
    const { engine, store } = setup();
    expect(engine.annotateStrict(KEY, { state: "claimed", claimToken: "x" }, { revivedAs: "r_A" })).toEqual({
      ok: false,
      reason: "conflict",
    });
    engine.claim(KEY, "mailbox:7");
    expect(engine.annotateStrict(KEY, { state: "claimed" }, { revivedAs: "r_A" })).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(engine.annotateStrict(KEY, { state: "claimed", claimToken: "wrong" }, { revivedAs: "r_A" })).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(engine.annotateStrict(KEY, { state: "pending" }, { revivedAs: "r_A" })).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(store.writes).toEqual([]);
    expect(engine.get(KEY)).not.toHaveProperty("revivedAs");
  });

  it("an explicit `undefined` clears the field in memory and in the persisted form", () => {
    const { engine, store } = setup();
    engine.annotateStrict(KEY, { state: "pending" }, { steerAttempt: { runId: "r_S", at: 1 } });
    expect(engine.get(KEY)?.steerAttempt).toBeDefined();
    expect(engine.annotateStrict(KEY, { state: "pending" }, { steerAttempt: undefined })).toEqual({ ok: true });
    expect(engine.get(KEY)).not.toHaveProperty("steerAttempt");
    expect(JSON.parse(JSON.stringify(store.list()[0]))).not.toHaveProperty("steerAttempt");
  });

  it("never changes state even if the patch carries one", () => {
    const { engine } = setup();
    engine.annotateStrict(KEY, { state: "pending" }, { state: "consumed" } as Partial<FabricRecord>);
    expect(engine.get(KEY)?.state).toBe("pending");
  });
});

describe("transitionStrict", () => {
  it("persists first (state + patch + updatedAt), then memory; returns the new record", () => {
    const { engine, store } = setup();
    const res = engine.transitionStrict(KEY, { state: "pending" }, "consumed", {
      terminalReason: "resume_injected",
      revivedAs: "r_R",
    });
    expect(res.ok).toBe(true);
    expect(store.writes[0]!.patch).toMatchObject({
      state: "consumed",
      terminalReason: "resume_injected",
      revivedAs: "r_R",
    });
    expect(engine.get(KEY)).toMatchObject({ state: "consumed", terminalReason: "resume_injected" });
    expect(store.list()[0]).toMatchObject({ state: "consumed", revivedAs: "r_R" });
  });

  it("claimed → delivered with the token; the stale claimToken does not linger in memory", () => {
    const { engine, store } = setup();
    engine.claim(KEY, "mailbox:7");
    const res = engine.transitionStrict(KEY, { state: "claimed", claimToken: "mailbox:7" }, "delivered", {
      deliveredAt: 40,
    });
    expect(res.ok).toBe(true);
    expect(engine.get(KEY)).not.toHaveProperty("claimToken");
    expect(store.list()[0]).toMatchObject({ state: "delivered", deliveredAt: 40 });
    expect(JSON.stringify(store.writes)).not.toContain("mailbox:7");
  });

  it("claimed → pending (retry) persists `pending`, never the memory-only state", () => {
    const { engine, store } = setup();
    engine.claim(KEY, "mailbox:7");
    expect(
      engine.transitionStrict(KEY, { state: "claimed", claimToken: "mailbox:7" }, "pending", { attempts: 1 }).ok,
    ).toBe(true);
    expect(store.list()[0]).toMatchObject({ state: "pending", attempts: 1 });
    expect(engine.get(KEY)).toMatchObject({ state: "pending", attempts: 1 });
  });

  it("store throws ⇒ persist_failed, memory unchanged (state, attempts, token, updatedAt)", () => {
    const { engine, store, degraded } = setup();
    engine.claim(KEY, "mailbox:7");
    const before = engine.get(KEY);
    store.failNext = true;
    expect(
      engine.transitionStrict(KEY, { state: "claimed", claimToken: "mailbox:7" }, "delivered", { deliveredAt: 40 }),
    ).toEqual({
      ok: false,
      reason: "persist_failed",
    });
    expect(engine.get(KEY)).toEqual(before);
    expect(degraded).toEqual([]);
    // contrast with the legacy op, which advances memory and only reports degradation
    const legacy = setup();
    legacy.engine.claim(KEY, "mailbox:7");
    legacy.store.failNext = true;
    expect(legacy.engine.transition(KEY, "claimed", "delivered")?.state).toBe("delivered");
    expect(legacy.degraded).toEqual([KEY]);
  });

  it("CAS: wrong/missing token, wrong state, disallowed edge, memory-only target ⇒ conflict, no write", () => {
    const { engine, store } = setup();
    expect(engine.transitionStrict(KEY, { state: "claimed", claimToken: "x" }, "delivered")).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(engine.transitionStrict(KEY, { state: "pending" }, "delivered")).toEqual({ ok: false, reason: "conflict" }); // no pending→delivered edge
    expect(engine.transitionStrict(KEY, { state: "pending" }, "claimed")).toEqual({ ok: false, reason: "conflict" }); // claimed is memory-only
    engine.claim(KEY, "mailbox:7");
    expect(engine.transitionStrict(KEY, { state: "claimed" }, "delivered")).toEqual({ ok: false, reason: "conflict" });
    expect(engine.transitionStrict(KEY, { state: "claimed", claimToken: "wrong" }, "delivered")).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(engine.transitionStrict("missing", { state: "pending" }, "consumed")).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(store.writes).toEqual([]);
    expect(engine.get(KEY)?.state).toBe("claimed");
  });

  it("accepts a list of expected states; frozen refuses", () => {
    const { engine } = setup();
    expect(engine.transitionStrict(KEY, { state: ["pending", "claimed"] }, "dropped").ok).toBe(true);
    const f = setup();
    f.engine.freeze();
    expect(f.engine.transitionStrict(KEY, { state: "pending" }, "consumed")).toEqual({ ok: false, reason: "frozen" });
    expect(f.engine.annotateStrict(KEY, { state: "pending" }, { revivedAs: "r" })).toEqual({
      ok: false,
      reason: "frozen",
    });
  });
});

describe("persisted form survives a reload normalization", () => {
  it("a record reserved from `claimed` reloads as plain pending+reserved (no claimToken, no quarantine)", () => {
    const { engine, store } = setup();
    engine.claim(KEY, "mailbox:7");
    engine.reserveStrict(KEY, { state: "claimed", claimToken: "mailbox:7" }, reservation, 50, 100);
    const reloaded = createDeliveryEngine<FabricRecord, FabricRecord["state"]>({
      store,
      allowed: { pending: [], claimed: [], delivered: [], consumed: [], dropped: [], abandoned: [] },
      memoryOnly: new Set(["claimed"]),
      memoryOnlyFields: ["claimToken", "quarantined"],
      now: () => 0,
    });
    expect(reloaded.get(KEY)).toMatchObject({ state: "pending", reserved: reservation });
    expect(reloaded.get(KEY)).not.toHaveProperty("claimToken");
  });
});

describe("strict ops over the real pi outbox store (appendEntry-backed)", () => {
  it("appendEntry throws ⇒ persist_failed, engine memory AND the store cache are unchanged; the next attempt succeeds", () => {
    const appended: Array<{ customType: string; data: any }> = [];
    let fail = false;
    const pi = {
      appendEntry: (customType: string, data: unknown) => {
        if (fail) throw new Error("append failed");
        appended.push({ customType, data: JSON.parse(JSON.stringify(data)) });
      },
      sessionManager: { getEntries: () => [] },
    };
    const store = createPiOutboxStore<FabricRecord>(pi, "subagent:fabric", []);
    const engine = createDeliveryEngine<FabricRecord, FabricRecord["state"]>({
      store,
      allowed: {
        pending: ["claimed", "consumed", "dropped", "abandoned"],
        claimed: ["pending", "delivered", "consumed", "dropped"],
        delivered: [],
        consumed: [],
        dropped: [],
        abandoned: [],
      },
      memoryOnly: new Set(["claimed"]),
      memoryOnlyFields: ["claimToken", "quarantined"],
      now: () => 5,
    });
    engine.put(base());
    engine.claim(KEY, "mailbox:7");
    fail = true;
    expect(engine.reserveStrict(KEY, { state: "claimed", claimToken: "mailbox:7" }, reservation, 50, 100)).toEqual({
      ok: false,
      reason: "persist_failed",
    });
    expect(engine.get(KEY)).toMatchObject({ state: "claimed", claimToken: "mailbox:7" });
    expect(store.list()[0]).not.toHaveProperty("reserved"); // the store rolled its own cache back
    fail = false;
    expect(engine.reserveStrict(KEY, { state: "claimed", claimToken: "mailbox:7" }, reservation, 50, 100)).toEqual({
      ok: true,
    });
    const last = appended.at(-1)!.data;
    expect(last).toMatchObject({ state: "pending", reserved: reservation });
    expect(JSON.stringify(appended)).not.toContain("claimToken");
  });
});
