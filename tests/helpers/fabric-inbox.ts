import { FakeClock } from "../../src/core/clock.js";
import { makeMessageKey, type FabricRecord } from "../../src/core/message.js";
import { MemoryOutboxStore } from "../../src/core/store.js";
import type { RunSnapshot } from "../../src/core/types.js";
import { createDeliveryEngine } from "../../src/delivery/engine.js";
import { createFabricMailbox, type Verdict } from "../../src/fabric/mailbox.js";
import { createFabricRouter } from "../../src/fabric/router.js";
import { createFabricThrottle } from "../../src/fabric/throttle.js";
import { createFabricTree } from "../../src/fabric/tree.js";
import { createWakeService, type InboxDurability } from "../../src/fabric/wake.js";
import { createCausalLevel } from "../../src/fabric/wake-level.js";

export const sender = "r_SENDER01";
export const target = "r_TARGET01";
export const successor = "r_RESUME01";
export const sessionFile = "/tmp/fabric-inbox-session.jsonl";
export const allowed: Record<FabricRecord["state"], readonly FabricRecord["state"][]> = {
  pending: ["claimed", "consumed", "dropped", "abandoned"],
  claimed: ["pending", "delivered", "consumed", "dropped"],
  delivered: [],
  consumed: [],
  dropped: [],
  abandoned: [],
};
export function inboxRecord(patch: Partial<FabricRecord> = {}): FabricRecord {
  return {
    key: makeMessageKey(sender, target, 1, 1),
    from: sender,
    to: target,
    kind: "finding",
    seq: 1,
    generation: 1,
    payload: { text: "parked payload" },
    ttlMs: 1000,
    createdAt: 0,
    updatedAt: 0,
    state: "pending",
    attempts: 0,
    wake: false,
    parked: { at: 0, reason: "wake_false" },
    ...patch,
  };
}
export function snapshot(runId = successor, patch: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId,
    generation: 1,
    status: "running",
    phase: "model_turn",
    deadlines: { enqueuedAt: 0, hardDeadlineAt: 100_000, deadlineAt: 100_000, queueDeadlineAt: undefined },
    diag: {
      createdAt: 0,
      phase: "model_turn",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 0,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      sessionFile,
    },
    updatedAt: 0,
    ...patch,
  };
}
export type Entry = { type: string; customType?: string; data?: unknown };
export const runEntry = (s: RunSnapshot): Entry => ({ type: "custom", customType: "subagent:run", data: s });
export function inboxRig(
  opts: {
    records?: FabricRecord[];
    entries?: Entry[];
    durability?: InboxDurability;
    live?: (file: string) => boolean;
    inject?: (r: FabricRecord, o?: { target: string }) => Promise<Verdict>;
    /** W4: `resumeOwners` (sessionFile/run id → successor run id); absent ⇒ no successor routing. */
    owners?: Map<string, string>;
    failUpdate?: (key: string, n: number) => boolean;
  } = {},
) {
  const clock = new FakeClock();
  const store = new MemoryOutboxStore<FabricRecord>();
  for (const r of opts.records ?? []) store.put(r);
  let updates = 0;
  const engine = createDeliveryEngine<FabricRecord, FabricRecord["state"]>({
    store: {
      put: (r) => store.put(r),
      list: () => store.list(),
      update: (key, patch) => {
        if (opts.failUpdate?.(key, ++updates)) throw new Error("persist failed");
        store.update(key, patch);
      },
    },
    allowed,
    memoryOnly: new Set(["claimed"]),
    memoryOnlyFields: ["claimToken", "quarantined"],
    now: () => clock.now(),
  });
  const entries = opts.entries ?? [];
  const snapshots = new Map([[target, snapshot(target, { status: "completed", phase: "settled" })]]);
  const raised: { runId: string; level: number }[] = [];
  const level = createCausalLevel({
    maxLevel: 2,
    runLevel: (id) => snapshots.get(id)?.diag.wakeLevel,
    raiseRun: (runId, level) => raised.push({ runId, level }),
    initialRoot: 0,
    persistRoot() {},
  });
  const tree = createFabricTree();
  tree.append("root", target);
  tree.tombstone(target, 0, 1000);
  tree.append("root", sender);
  tree.markRunning(sender);
  const throttle = createFabricThrottle({ minIntervalMs: 0, rootMinIntervalMs: 0, backoffMs: 10 });
  const durability = opts.durability ?? "disk";
  const router = createFabricRouter(
    engine,
    tree,
    throttle,
    {
      maxPerRun: 20,
      findingQuota: 20,
      directiveQuota: 20,
      deadLetterQuota: 20,
      maxChars: 1000,
      progressTtlMs: 1000,
      reconcileTtlMs: 1000,
      rootInboxCap: 20,
      wakePolicy: { levelOf: () => 1, hopAllowed: () => true, perRunQuota: 3 },
      inbox: { durability, parkCapPerTarget: 8 },
    },
    () => clock.now(),
  );
  let reads = 0;
  const wake = createWakeService({
    engine,
    query: () => ({ get: (id) => snapshots.get(id) }),
    ...(opts.owners ? { spawn: () => ({ successorOf: (f: string) => opts.owners!.get(f) }) } : {}),
    level,
    durability,
    isLiveSessionFile: opts.live ?? (() => false),
    entries,
    runEntries: () => {
      reads++;
      return entries;
    },
    clock,
    reapMs: 20,
    onChanged: () => mailbox.pump(),
  });
  const inject = opts.inject ?? (async () => ({ ok: true as const }));
  const mailbox = createFabricMailbox({
    engine,
    router,
    throttle,
    clock,
    ports: { inject, sendRootContext: inject, sendRootDisplay: inject },
    fabricSteerTimeoutMs: 10,
    maxAttempts: 3,
    inbox: wake,
  });
  return {
    clock,
    store,
    engine,
    entries,
    snapshots,
    level,
    raised,
    tree,
    router,
    wake,
    mailbox,
    get reads() {
      return reads;
    },
  };
}
export async function flush() {
  for (let n = 0; n < 8; n++) await Promise.resolve();
}
