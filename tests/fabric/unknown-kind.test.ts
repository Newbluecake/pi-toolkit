import { describe, expect, it, vi } from "vitest";
import type { FabricRecord } from "../../src/core/message.js";
import { makeMessageKey } from "../../src/core/message.js";
import { MemoryOutboxStore } from "../../src/core/store.js";
import { createDeliveryEngine } from "../../src/delivery/engine.js";
import { FabricRouter } from "../../src/fabric/router.js";
import { FabricThrottle } from "../../src/fabric/throttle.js";
import { FabricTree } from "../../src/fabric/tree.js";
import { UNKNOWN_KIND_REASON } from "../../src/fabric/unknown-kind.js";
import { inboxRig, inboxRecord, sender, sessionFile, successor, target } from "../helpers/fabric-inbox.js";
import { revivable, reviveRig, sender as rSender } from "../helpers/fabric-revive.js";

vi.mock("../../src/fabric/format-fence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/fabric/format-fence.js")>();
  return { ...actual, formatInbox: vi.fn(actual.formatInbox) };
});
import { formatInbox } from "../../src/fabric/format-fence.js";

const LEGACY_KIND: string = "finding"; // #34 legacy input
const LEGACY_BODY = "pre-#34 persisted body";

/** Router-only rig (T-U2/T-U4), quota low enough to observe consumption. */
function routerRig(records: readonly FabricRecord[] = []) {
  const store = new MemoryOutboxStore<FabricRecord>();
  for (const r of records) store.put(r);
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
    memoryOnlyFields: ["claimToken"],
    now: () => 1,
  });
  const tree = new FabricTree();
  tree.append("root", "r_ABCDEFGH");
  tree.append("root", "r_12345678");
  tree.markRunning("r_ABCDEFGH");
  tree.markRunning("r_12345678");
  const router = new FabricRouter(
    engine,
    tree,
    new FabricThrottle({ minIntervalMs: 0, rootMinIntervalMs: 0, backoffMs: 0 }),
    {
      maxPerRun: 2,
      findingQuota: 2,
      directiveQuota: 2,
      deadLetterQuota: 1,
      maxChars: 100,
      progressTtlMs: 100,
      reconcileTtlMs: 100,
      rootInboxCap: 4,
    },
    () => 1,
  );
  router.hydrate([...engine.select(() => true)]);
  return { engine, router };
}

const legacyRecord = (patch: Partial<FabricRecord> = {}): FabricRecord => ({
  key: makeMessageKey(sender, target, 1, 1),
  from: sender,
  to: target,
  kind: LEGACY_KIND as FabricRecord["kind"],
  seq: 1,
  generation: 1,
  payload: { text: LEGACY_BODY },
  ttlMs: 1000,
  createdAt: 0,
  updatedAt: 0,
  state: "pending",
  attempts: 0,
  ...patch,
});

describe("fabric unknown kind: admission (E0–E2)", () => {
  it("T-U2: router.admit throws exactly `message not authorized` for a pre-#34 kind, consuming no seq and no quota", () => {
    const { engine, router } = routerRig();
    const admitLegacy = (): unknown =>
      router.admit("r_ABCDEFGH", {
        to: "root",
        kind: LEGACY_KIND as never,
        text: "x",
        generation: 1,
        canMessage: ["parent"],
      });
    expect(admitLegacy).toThrowError(/^message not authorized$/);
    expect(engine.select(() => true)).toHaveLength(0);
    // The failed attempt spent nothing: the first legal report on the same link gets seq 1…
    const first = router.admit("r_ABCDEFGH", {
      to: "root",
      kind: "report",
      text: "x",
      generation: 1,
      canMessage: ["parent"],
    });
    expect(first).toMatchObject({ ok: true, seq: 1 });
    // …and the per-sender report quota is untouched (one more fits, the third is exhausted).
    expect(
      router.admit("r_ABCDEFGH", { to: "root", kind: "report", text: "y", generation: 1, canMessage: ["parent"] }),
    ).toMatchObject({ ok: true });
    expect(
      router.admit("r_ABCDEFGH", { to: "root", kind: "report", text: "z", generation: 1, canMessage: ["parent"] }),
    ).toMatchObject({ ok: false, status: "quota_exhausted", used: 2, quota: 2 });
  });
});

describe("fabric unknown kind: stack build (E3/E4)", () => {
  it("T-U4: retireUnknownKinds drops exactly the non-terminal pre-#34 records, keeps history, is idempotent", () => {
    const rootLegacy: FabricRecord = {
      key: makeMessageKey("r_ABCDEFGH", "root", 1, 1),
      from: "r_ABCDEFGH",
      to: "root",
      kind: LEGACY_KIND as FabricRecord["kind"],
      seq: 1,
      generation: 1,
      payload: { text: "to root" },
      ttlMs: 100,
      createdAt: 0,
      updatedAt: 1,
      state: "pending",
      attempts: 0,
    };
    const parkedReservedLegacy: FabricRecord = {
      key: makeMessageKey("r_ABCDEFGH", "r_12345678", 1, 2),
      from: "r_ABCDEFGH",
      to: "r_12345678",
      kind: LEGACY_KIND as FabricRecord["kind"],
      seq: 2,
      generation: 1,
      payload: { text: "parked" },
      ttlMs: 100,
      createdAt: 0,
      updatedAt: 1,
      state: "pending",
      attempts: 0,
      parked: { at: 0, reason: "wake_false" },
      reserved: { rsv: "rsv1", runId: "r_RESUME01", at: 0 },
    };
    const deliveredLegacy: FabricRecord = {
      key: makeMessageKey("r_ABCDEFGH", "r_12345678", 1, 3),
      from: "r_ABCDEFGH",
      to: "r_12345678",
      kind: LEGACY_KIND as FabricRecord["kind"],
      seq: 3,
      generation: 1,
      payload: { text: "history" },
      ttlMs: 100,
      createdAt: 0,
      updatedAt: 1,
      state: "delivered",
      attempts: 1,
      deliveredAt: 1,
    };
    const pendingReport: FabricRecord = {
      key: makeMessageKey("r_ABCDEFGH", "r_12345678", 1, 5),
      from: "r_ABCDEFGH",
      to: "r_12345678",
      kind: "report",
      seq: 5,
      generation: 1,
      payload: { text: "still valid" },
      ttlMs: 100,
      createdAt: 0,
      updatedAt: 1,
      state: "pending",
      attempts: 0,
    };
    const { engine, router } = routerRig([rootLegacy, parkedReservedLegacy, deliveredLegacy, pendingReport]);
    expect(router.retireUnknownKinds()).toEqual({ dropped: 2 });
    expect(engine.get(rootLegacy.key)).toMatchObject({ state: "dropped", terminalReason: UNKNOWN_KIND_REASON });
    expect(engine.get(parkedReservedLegacy.key)).toMatchObject({
      state: "dropped",
      terminalReason: UNKNOWN_KIND_REASON,
    });
    expect(engine.get(deliveredLegacy.key)).toMatchObject({ state: "delivered" });
    expect(engine.get(deliveredLegacy.key)?.terminalReason).toBeUndefined();
    expect(engine.get(pendingReport.key)).toMatchObject({ state: "pending" });
    expect(engine.select((r) => r.kind === "dead_letter")).toHaveLength(0);
    // E4: terminal history keeps advancing the seq — a fresh admit continues after the old max.
    expect(
      router.admit("r_ABCDEFGH", {
        to: "r_12345678",
        kind: "report",
        text: "n",
        generation: 1,
        canMessage: ["sibling"],
      }),
    ).toMatchObject({ ok: true, seq: 6 });
    // Idempotent: nothing left to retire.
    expect(router.retireUnknownKinds()).toEqual({ dropped: 0 });
  });
});

describe("fabric unknown kind: mailbox pump (E5)", () => {
  it("T-U5: a pending pre-#34 record put behind the router is retired on pump, never dispatched", async () => {
    const h = reviveRig({});
    h.engine.put({
      key: `${rSender}:${rSender}:1:1` as never,
      from: rSender,
      to: rSender,
      kind: LEGACY_KIND as FabricRecord["kind"],
      seq: 1,
      generation: 1,
      payload: { text: LEGACY_BODY },
      ttlMs: 100_000,
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
      state: "pending",
      attempts: 0,
    });
    h.mailbox.pump();
    const retired = h.engine.get(`${rSender}:${rSender}:1:1` as never);
    expect(retired).toMatchObject({ state: "dropped", terminalReason: UNKNOWN_KIND_REASON });
    expect(h.injected).toHaveLength(0);
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

describe("fabric unknown kind: resume admission (E8)", () => {
  it("T-U9: parked pre-#34 records never enter the resume block; the pump retires them afterwards", () => {
    const legacy = legacyRecord({ payload: { text: LEGACY_BODY } });
    const report = inboxRecord({ key: makeMessageKey(sender, target, 1, 2), seq: 2 });
    const h = inboxRig({ records: [legacy, report] });
    const result = h.wake.onResumeAdmitted({ runId: "r_NEWRUN01", sessionFile });
    expect(result.trackInput).toBe(true);
    expect(result.block).toBeDefined();
    expect(result.block).toContain("parked payload");
    expect(result.block).not.toContain(LEGACY_BODY);
    expect(result.block).not.toContain(`kind=${LEGACY_KIND}`);
    expect(h.engine.get(legacy.key)?.reserved).toBeUndefined();
    h.mailbox.pump();
    expect(h.engine.get(legacy.key)).toMatchObject({ state: "dropped", terminalReason: UNKNOWN_KIND_REASON });
  });

  it("T-U10: a pre-#34 trigger is retired and answered like a missing trigger, reserving nothing", () => {
    const trigger = legacyRecord({ state: "claimed", claimToken: "tok" });
    const parked = inboxRecord({ key: makeMessageKey(sender, target, 1, 2), seq: 2 });
    const h = inboxRig({ records: [trigger, parked] });
    const result = h.wake.onResumeAdmitted({
      runId: "r_NEWRUN01",
      sessionFile,
      trigger: { key: trigger.key, claimToken: "tok", sender },
    });
    expect(result).toEqual({ trackInput: false, persistFailed: true });
    expect(result.block).toBeUndefined();
    expect(h.engine.get(trigger.key)).toMatchObject({ state: "dropped", terminalReason: UNKNOWN_KIND_REASON });
    expect(h.engine.get(parked.key)?.reserved).toBeUndefined();
  });
});

describe("fabric unknown kind: wake scheduling (E7)", () => {
  it("T-U11: reserved/quarantined pre-#34 records are never scheduled or swept, only retired by the pump", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const reserved = legacyRecord({ reserved: { rsv: "rsv", runId: successor, at: 0 } });
      const h = inboxRig({ records: [reserved] });
      const quarantined = legacyRecord({
        key: makeMessageKey(sender, target, 1, 2),
        seq: 2,
        payload: { text: "q" },
      });
      h.engine.put(quarantined);
      h.engine.annotate(quarantined.key, { quarantined: true });
      expect(h.wake.nextSweepAt(h.clock.now())).toBeUndefined();
      h.wake.sweep(h.clock.now(), 32);
      h.wake.reconcile();
      expect(h.engine.get(reserved.key)).toMatchObject({ state: "pending" });
      expect(h.engine.get(quarantined.key)).toMatchObject({ state: "pending" });
      expect(h.clock.pendingTimers).toBe(0);
      expect(warn).not.toHaveBeenCalled();
      h.mailbox.pump();
      expect(h.engine.get(reserved.key)).toMatchObject({ state: "dropped", terminalReason: UNKNOWN_KIND_REASON });
      expect(h.engine.get(quarantined.key)).toMatchObject({ state: "dropped", terminalReason: UNKNOWN_KIND_REASON });
    } finally {
      warn.mockRestore();
    }
  });

  it("T-U12: a recovered steerAttempt on a pre-#34 record is not held, not scheduled, retired by the pump", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const steer = legacyRecord({
        steerAttempt: { runId: successor, at: 0 },
        wake: undefined,
        parked: undefined,
      });
      const h = inboxRig({
        records: [steer],
        inject: async () => {
          throw new Error("must not dispatch");
        },
      });
      expect(h.wake.steerHeld(steer.key)).toBe(false);
      expect(h.wake.nextSweepAt(h.clock.now())).toBeUndefined();
      h.mailbox.pump();
      expect(h.engine.get(steer.key)).toMatchObject({ state: "dropped", terminalReason: UNKNOWN_KIND_REASON });
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("steer_unverified"));
      warn.mockClear();
    } finally {
      warn.mockRestore();
    }
  });

  it("T-U13: pre-existing parkRetryAt/waitingFor markers for a pre-#34 key are dropped by the pump", () => {
    const legacy = legacyRecord({ wake: undefined, parked: undefined });
    const h = inboxRig({ records: [legacy] });
    const priv = h.mailbox as unknown as {
      parkRetryAt: Map<string, number>;
      waitingFor: Map<string, { runId: string; sessionFile: string | undefined }>;
    };
    priv.parkRetryAt.set(legacy.key, h.clock.now() + 1);
    priv.waitingFor.set(legacy.key, { runId: successor, sessionFile: undefined });
    h.mailbox.pump();
    expect(priv.parkRetryAt.has(legacy.key)).toBe(false);
    expect(priv.waitingFor.has(legacy.key)).toBe(false);
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.engine.get(legacy.key)).toMatchObject({ state: "dropped", terminalReason: UNKNOWN_KIND_REASON });
  });

  it("T-U14: when retiring keeps failing, no timer, no self-scheduling, no port and no inbox format ever happen", () => {
    vi.mocked(formatInbox).mockClear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const h = reviveRig({});
      const plain: FabricRecord = {
        key: `${rSender}:${rSender}:1:1` as never,
        from: rSender,
        to: rSender,
        kind: LEGACY_KIND as FabricRecord["kind"],
        seq: 1,
        generation: 1,
        payload: { text: LEGACY_BODY },
        ttlMs: 100_000,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
        state: "pending",
        attempts: 0,
      };
      const reserved: FabricRecord = {
        ...plain,
        key: `${rSender}:${rSender}:1:2` as never,
        seq: 2,
        reserved: { rsv: "r", runId: "r_RESUME01", at: 0 },
      };
      const steer: FabricRecord = {
        ...plain,
        key: `${rSender}:${rSender}:1:3` as never,
        seq: 3,
        steerAttempt: { runId: "r_RESUME01", at: 0 },
      };
      for (const r of [plain, reserved, steer]) h.engine.put(r);
      const priv = h.mailbox as unknown as {
        parkRetryAt: Map<string, number>;
        waitingFor: Map<string, { runId: string; sessionFile: string | undefined }>;
      };
      priv.parkRetryAt.set(plain.key, h.clock.now() + 1);
      priv.waitingFor.set(plain.key, { runId: "r_RESUME01", sessionFile: undefined });
      const transition = vi.spyOn(h.engine, "transition").mockReturnValue(undefined);
      const step = Math.max(1000, 100_000);
      for (let i = 0; i < 10; i++) {
        h.mailbox.pump(); // the ONLY pump source: the test itself
        h.clock.advance(step);
        expect(h.clock.pendingTimers).toBe(0);
      }
      expect(transition).toHaveBeenCalled(); // retiring was attempted every pump, and always failed
      for (const r of [plain, reserved, steer]) expect(h.engine.get(r.key)).toMatchObject({ state: "pending" });
      expect(priv.parkRetryAt.size).toBe(0);
      expect(priv.waitingFor.size).toBe(0);
      expect(h.injected).toHaveLength(0);
      expect(h.spawn).not.toHaveBeenCalled();
      expect(formatInbox).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.mocked(formatInbox).mockRestore();
    }
  });
});
