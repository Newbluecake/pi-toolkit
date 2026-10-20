import { vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import type { FabricRecord, WakeOrigin } from "../../src/core/message.js";
import { MemoryOutboxStore } from "../../src/core/store.js";
import type { ErrorInfo, RunSnapshot, SpawnRequest } from "../../src/core/types.js";
import { DEFAULT_SETTINGS, type FabricWakeSettings } from "../../src/config/settings.js";
import { createDeliveryEngine } from "../../src/delivery/engine.js";
import { createFabricMailbox, type Verdict } from "../../src/fabric/mailbox.js";
import { createFabricRouter } from "../../src/fabric/router.js";
import { createFabricThrottle } from "../../src/fabric/throttle.js";
import { createFabricTree } from "../../src/fabric/tree.js";
import { createWakeService, type InboxDurability } from "../../src/fabric/wake.js";
import { createCausalLevel } from "../../src/fabric/wake-level.js";
import type { Tombstone } from "../../src/service/tombstone.js";
import { allowed, sender, sessionFile, snapshot, target } from "./fabric-inbox.js";

export { sender, target, sessionFile };

/** A finished, revivable run (wake-on admission verdict "none"). */
export type DiagPatch = { [K in keyof RunSnapshot["diag"]]?: RunSnapshot["diag"][K] | undefined };
/** Apply a diag patch where an explicit `undefined` REMOVES the key (a legacy entry lacks it entirely). */
export function applyDiag(diag: RunSnapshot["diag"], patch: DiagPatch): void {
  const bag = diag as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete bag[k];
    else bag[k] = v;
  }
}
export function revivable(patch: DiagPatch = {}): RunSnapshot {
  const s = snapshot(target, { status: "completed", phase: "settled" });
  applyDiag(s.diag, {
    wakeExclusion: "none",
    agentType: "worker",
    label: "worker-label",
    model: { provider: "p", id: "m" },
    thinkingLevel: "high",
    ...patch,
  });
  return s;
}

export type SpawnResult = { runId: string } | { error: ErrorInfo };

/**
 * Real router + mailbox + WakeService around a fake `spawn()` that, like spawn-service, performs the synchronous inbox
 * reservation (`onResumeAdmitted`) on success so the ownership hand-over is exercised for real.
 */
export function reviveRig(
  opts: {
    snapshots?: RunSnapshot[];
    tombstones?: Tombstone[];
    durability?: InboxDurability;
    wake?: Partial<FabricWakeSettings>;
    types?: (name: string) => boolean;
    pathExists?: (p: string) => boolean;
    spawn?: (req: SpawnRequest) => SpawnResult | Promise<SpawnResult>;
    owners?: Map<string, string>;
    parkCap?: number;
    maxAttempts?: number;
    maxLevel?: number;
    /** W6: replace the recording inject port (e.g. to finish the successor mid-steer). */
    inject?: (record: FabricRecord, opts?: { target: string }) => Promise<Verdict>;
  } = {},
) {
  const clock = new FakeClock();
  const store = new MemoryOutboxStore<FabricRecord>();
  const engine = createDeliveryEngine<FabricRecord, FabricRecord["state"]>({
    store,
    allowed,
    memoryOnly: new Set(["claimed"]),
    memoryOnlyFields: ["claimToken", "quarantined"],
    now: () => clock.now(),
  });
  const snaps = new Map<string, RunSnapshot>();
  for (const s of opts.snapshots ?? [revivable()]) snaps.set(s.runId, s);
  const settings: FabricWakeSettings = { ...DEFAULT_SETTINGS.fabric.wake, ...opts.wake };
  const raised: { runId: string; level: number }[] = [];
  const level = createCausalLevel({
    maxLevel: opts.maxLevel ?? settings.maxLevel,
    runLevel: (id) => snaps.get(id)?.diag.wakeLevel,
    raiseRun: (runId, lvl) => raised.push({ runId, level: lvl }),
    initialRoot: 0,
    persistRoot() {},
  });
  const tree = createFabricTree();
  tree.append("root", target);
  tree.tombstone(target, 0, 100_000);
  tree.append("root", sender);
  tree.markRunning(sender);
  const throttle = createFabricThrottle({ minIntervalMs: 0, rootMinIntervalMs: 0, backoffMs: 10 });
  const durability = opts.durability ?? "disk";
  const spawnCalls: SpawnRequest[] = [];
  let seq = 0;
  const defaultSpawn = (req: SpawnRequest): SpawnResult => {
    const runId = `r_REVIVE${String(++seq).padStart(2, "0")}`;
    const trigger = req.wakeOrigin?.trigger;
    // spawn-service's synchronous admission step
    wake.onResumeAdmitted({
      runId,
      sessionFile: req.resumeFrom as string,
      ...(trigger ? { trigger: { ...trigger, sender: (req.wakeOrigin as WakeOrigin).by } } : {}),
    });
    return { runId };
  };
  const spawn = vi.fn(async (req: SpawnRequest) => {
    spawnCalls.push(req);
    return (opts.spawn ?? defaultSpawn)(req);
  });
  const wake = createWakeService({
    engine,
    query: () => ({ get: (id) => snaps.get(id), list: () => [...snaps.values()] }),
    spawn: () => ({
      successorOf: (f: string) => opts.owners?.get(f),
      spawn: spawn as never,
    }),
    tombstone: (id) => opts.tombstones?.find((t) => t.runId === id),
    agentTypeExists: opts.types ?? (() => true),
    settings: () => settings,
    // W6: late-bound (the router is built after the service, like in stack.ts)
    router: { admitSystemResult: (...a) => router.admitSystemResult(...a) },
    pathExists: opts.pathExists ?? (() => true),
    level,
    durability,
    isLiveSessionFile: () => false,
    entries: [],
    runEntries: () => [],
    clock,
    reapMs: 20,
    onChanged: () => mailbox.pump(),
  });
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
      reconcileTtlMs: 100_000,
      rootInboxCap: 20,
      wakePolicy: {
        levelOf: (n) => level.levelOf(n),
        hopAllowed: (l) => level.hopAllowed(l),
        perRunQuota: settings.perRunQuota,
        reviveGate: (input) => wake.admitCheck(input),
      },
      inbox: { durability, parkCapPerTarget: opts.parkCap ?? 8 },
    },
    () => clock.now(),
    () => mailbox.pump(),
  );
  const injected: FabricRecord[] = [];
  const inject = async (r: FabricRecord, o?: { target: string }): Promise<Verdict> => {
    injected.push(r);
    return opts.inject ? opts.inject(r, o) : { ok: true };
  };
  const mailbox = createFabricMailbox({
    engine,
    router,
    throttle,
    clock,
    ports: {
      inject,
      sendRootContext: inject,
      sendRootDisplay: inject,
      revive: (record, token) => wake.revive(record, token),
    },
    fabricSteerTimeoutMs: 10,
    maxAttempts: opts.maxAttempts ?? 3,
    level,
    inbox: wake,
  });
  const send = (over: { wake?: boolean; text?: string; kind?: "finding" | "directive"; from?: string } = {}) =>
    router.admit(over.from ?? sender, {
      to: target,
      kind: over.kind ?? "finding",
      text: over.text ?? "wake up please",
      generation: 1,
      canMessage: ["sibling", "parent"],
      ...(over.wake === undefined ? {} : { wake: over.wake }),
    });
  /** A pending wake:true record put WITHOUT admission (no gate, no pump) — the "state changed after admission" race. */
  const putRaw = (n = 1, patch: Partial<FabricRecord> = {}): FabricRecord => {
    const record: FabricRecord = {
      key: `${sender}:${target}:1:${n}` as never,
      from: sender,
      to: target,
      kind: "finding",
      seq: n,
      generation: 1,
      payload: { text: "raw wake" },
      ttlMs: 100_000,
      createdAt: clock.now(),
      updatedAt: clock.now(),
      state: "pending",
      attempts: 0,
      wake: true,
      level: 0,
      ...patch,
    };
    engine.put(record);
    return record;
  };
  const rec = (key: string) => engine.get(key as never)!;
  /** W6: a running run in the tree (a waker / a successor). */
  const addRunning = (runId: string): void => {
    tree.append("root", runId);
    tree.markRunning(runId);
  };
  return {
    raised,
    addRunning,
    clock,
    engine,
    snaps,
    router,
    mailbox,
    wake,
    spawn,
    spawnCalls,
    injected,
    send,
    putRaw,
    rec,
    tree,
    level,
    settings,
  };
}
