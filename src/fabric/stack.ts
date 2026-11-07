import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { systemClock } from "../core/clock.js";
import { MemoryOutboxStore } from "../core/store.js";
import type { RunId, RunStatus } from "../core/types.js";
import { TERMINAL_STATUSES } from "../core/status.js";
import { createPiOutboxStore } from "../adapters/pi-outbox-store.js";
import { detectPiCapabilities } from "../adapters/pi-compat.js";
import { createDeliveryEngine } from "../delivery/engine.js";
import { createFabricMailbox, type FabricPorts } from "./mailbox.js";
import { createCausalLevel, readRootLevel, WAKE_LEVEL_CUSTOM_TYPE, type CausalLevel } from "./wake-level.js";
import { createWakeService, inboxDurability } from "./wake.js";
import { isLiveSessionFile } from "../core/live-session-files.js";
import { isRunId } from "../core/ids.js";
import { createRootWakeBudget, type RootBudgetState, type RootWakeReservation } from "./root-wake-budget.js";
import { createFabricRouter } from "./router.js";
import { createFabricThrottle } from "./throttle.js";
import { createFabricTree } from "./tree.js";
import { formatMessage, type FabricRecord, type NodeRef } from "../core/message.js";
import type { AgentSettings } from "../config/settings.js";
import type { Runner } from "../service/ports.js";
import { type QueryService } from "../service/query-service.js";
import { type SpawnService } from "../service/spawn-service.js";
import { type Tombstone } from "../service/tombstone.js";

/** Internal policy, not a settings key. Each stack starts closed until a trusted user arrival. */
const ROOT_WAKE_LIMIT = 2;

export function readRootBudgetState(
  ctx: Partial<Pick<ExtensionContext, "isIdle" | "hasPendingMessages">>,
): RootBudgetState {
  try {
    const idle = ctx.isIdle?.();
    const pending = ctx.hasPendingMessages?.();
    if (typeof idle !== "boolean" || typeof pending !== "boolean") return "unknown";
    return !idle ? "running" : pending ? "starting" : "idle";
  } catch {
    return "unknown";
  }
}

export interface RootBudgetPort {
  observeAcceptedUserArrival(event: object): boolean;
  snapshot(): import("./root-wake-budget.js").RootWakeBudgetSnapshot;
}

export function buildFabric(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  settings: AgentSettings,
  prefetched: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
  readBack: boolean,
  runnerRef: { current?: Runner },
  query: () => QueryService | undefined,
  spawn: () => Pick<SpawnService, "successorOf" | "spawn"> | undefined,
  wakeFacts: {
    tombstone: (runId: RunId) => Tombstone | undefined;
    agentTypeExists: (name: string) => boolean;
  },
) {
  const store = readBack
    ? createPiOutboxStore<FabricRecord>(
        { appendEntry: pi.appendEntry, sessionManager: ctx.sessionManager },
        "subagent:fabric",
        prefetched,
      )
    : new MemoryOutboxStore<FabricRecord>();
  const allowed: Record<FabricRecord["state"], readonly FabricRecord["state"][]> = {
    pending: ["claimed", "consumed", "dropped", "abandoned"],
    claimed: ["pending", "delivered", "consumed", "dropped"],
    delivered: [],
    consumed: [],
    dropped: [],
    abandoned: [],
  };
  const engine = createDeliveryEngine<FabricRecord, FabricRecord["state"]>({
    store,
    allowed,
    memoryOnly: new Set(["claimed"]),
    // `quarantined` (fabric-cross-session plan §4.1): contract-only in S0 — set in memory by W3's rollback-failure path, never persisted.
    memoryOnlyFields: ["claimToken", "quarantined"],
    now: () => systemClock.now(),
    onDegraded: (key, reason) => console.warn(`[pi-subagent] fabric persistence degraded for ${key}: ${reason}`),
  });
  // fabric-cross-session plan §3.9 (W1): wakeOn is decided ONCE per stack build from `fabric.enabled ∧ fabric.wake.enabled`
  // (buildFabric itself only runs with fabric on). Off ⇒ no CausalLevel, no router wake policy, no mailbox level hook,
  // no `subagent:wake-level` entry, no wake schema — every path below stays byte-identical to before.
  const wakeOn = settings.fabric.wake.enabled;
  const durability = wakeOn ? inboxDurability(readBack, ctx.sessionManager) : "stack-memory";
  // L6: the root level is restored from THIS session branch (never `getEntries()` — a fork must not resurrect a sibling's
  // value) and persisted only when the session can hold entries at all (`readBack`).
  let rootLevel0 = 0;
  if (wakeOn && readBack) {
    try {
      rootLevel0 = readRootLevel(ctx.sessionManager.getBranch());
    } catch {
      rootLevel0 = 0;
    }
  }
  const level: CausalLevel | undefined = wakeOn
    ? createCausalLevel({
        maxLevel: settings.fabric.wake.maxLevel,
        initialRoot: rootLevel0,
        runLevel: (runId) => runnerRef.current?.getRunState?.(runId)?.diag.wakeLevel,
        raiseRun: (runId, to) => runnerRef.current?.noteWakeLevel?.(runId, to),
        persistRoot: (value) => {
          if (!readBack) return;
          pi.appendEntry(WAKE_LEVEL_CUSTOM_TYPE, { v: 1, level: value, at: systemClock.now() });
        },
      })
    : undefined;
  const rootOwner = {};
  const rootBudget = wakeOn
    ? createRootWakeBudget({ owner: rootOwner, sessionId: ctx.sessionManager.getSessionId(), limit: ROOT_WAKE_LIMIT })
    : undefined;
  const rootPlans = new Map<
    string,
    {
      from: NodeRef;
      action: "queue" | "requestWake";
      reservation?: RootWakeReservation;
      attempted?: boolean;
      sent?: boolean;
    }
  >();
  const rootBudgetPort: RootBudgetPort | undefined = rootBudget
    ? {
        observeAcceptedUserArrival: (event) => rootBudget.observeAcceptedUserArrival(rootOwner, event),
        snapshot: () => rootBudget.snapshot(),
      }
    : undefined;
  const tree = createFabricTree();
  // run-persistence plan D6 (fabric row): fold the run log per runId first —
  // terminal entries win, otherwise the latest non-terminal (journal) entry —
  // then append each edge ONCE and tombstone every node. No run from a
  // previous stack can still be alive at build time (session_shutdown stopped
  // them all and this runner is a fresh instance); without the tombstone a
  // journal-only (crashed) run would sit in `pending_start` forever and the
  // mailbox would hold messages addressed to it indefinitely.
  const replayed = new Map<string, { parentRunId?: string; terminal: boolean }>();
  for (const entry of prefetched) {
    if (entry.type !== "custom" || entry.customType !== "subagent:run") continue;
    const snapshot = entry.data as { runId?: unknown; parentRunId?: unknown; status?: unknown } | undefined;
    if (typeof snapshot?.runId !== "string" || snapshot.runId === "") continue;
    const terminal = typeof snapshot.status === "string" && TERMINAL_STATUSES.has(snapshot.status as RunStatus);
    const prev = replayed.get(snapshot.runId);
    if (prev?.terminal && !terminal) continue;
    replayed.set(snapshot.runId, {
      terminal,
      ...(typeof snapshot.parentRunId === "string" ? { parentRunId: snapshot.parentRunId } : {}),
    });
  }
  const replayAt = systemClock.now();
  for (const [runId, info] of replayed) {
    tree.appendEdge(info.parentRunId ?? "root", runId);
    tree.tombstone(runId, replayAt, settings.reconcileTtlMs);
  }
  const capabilities = detectPiCapabilities(pi);
  const throttle = createFabricThrottle({
    minIntervalMs: settings.fabric.minIntervalMs,
    rootMinIntervalMs: settings.fabric.rootMinIntervalMs,
    backoffMs: settings.deliveryBackoffMs,
    progressChannel: settings.fabric.progressChannel,
    canRenderEntries: capabilities.canRenderEntries,
    records: [...engine.select(() => true)],
  });
  const router = createFabricRouter(
    engine,
    tree,
    throttle,
    {
      ...settings.fabric,
      reconcileTtlMs: settings.reconcileTtlMs,
      canRenderEntries: capabilities.canRenderEntries,
      // 2026-10-24 user report: entry headers must say WHO sent the message (`@label`), not `[fabric <kind>
      // <runId>]`. Stamp the sender's label into the record at admit() time — the run registry's diag.label
      // is authoritative (survives /reload via seeded snapshots); the live query is late-bound because the
      // fabric router is built before the QueryService exists. Display-only; never gates admission.
      senderLabel: (from) => {
        if (from === "root" || from === "system" || !isRunId(from)) return undefined;
        const label = query()?.get(from)?.diag.label;
        return typeof label === "string" && label !== "" ? label : undefined;
      },
      ...(level
        ? {
            wakePolicy: {
              levelOf: (node) => level.levelOf(node),
              hopAllowed: (l) => level.hopAllowed(l),
              perRunQuota: settings.fabric.wake.perRunQuota,
              rootAdmission: (input: {
                from: NodeRef;
                kind: FabricRecord["kind"];
                level: number;
                messageKey: string;
              }) => {
                const decision = rootBudget!.admit({
                  owner: rootOwner,
                  messageKey: input.messageKey,
                  rootState: readRootBudgetState(ctx),
                });
                if (decision.action !== "deliverOnly")
                  rootPlans.set(input.messageKey, {
                    from: input.from,
                    action: decision.action,
                    ...(decision.reservation ? { reservation: decision.reservation } : {}),
                  });
                return decision.action === "requestWake"
                  ? { action: "requestWake" as const }
                  : { action: "deliverOnly" as const, reason: `root_${decision.reason}` as const };
              },
              // W5: finished-target wake:true is decided here, synchronously, before anything is queued.
              reviveGate: (input: { from: NodeRef; to: NodeRef; level: number; rootWakes: number }) =>
                wake ? wake.admitCheck(input) : ({ ok: true } as const),
            },
            inbox: { durability, parkCapPerTarget: settings.fabric.wake.parkCapPerTarget },
          }
        : {}),
    },
    () => systemClock.now(),
    () => mailbox.pump(),
  );
  router.hydrate([...engine.select(() => true)]);
  // #34 (E3): persisted records written by an older version can carry a kind that no longer exists. Retire every
  // non-terminal one here — before the WakeService and mailbox are built — with one warning line (no body, no key,
  // no kind value) and no dead letter. Idempotent: terminal records never match again.
  const retiredUnknown = router.retireUnknownKinds();
  if (retiredUnknown.dropped > 0)
    console.warn(
      `[pi-subagent] fabric: dropped ${retiredUnknown.dropped} persisted message(s) with an unknown kind ` +
        `(written by an older version); not delivered`,
    );
  const ports: FabricPorts = {
    inject: async (record, opts) => {
      const steer = runnerRef.current?.steer;
      if (!steer) throw new Error("fabric runner unavailable");
      const formatted = formatMessage(record, tree.relation(record.from, record.to, systemClock.now()));
      // W4: a redirect steers the resumed successor of the finished run the message was addressed to.
      await steer(opts?.target ?? (record.to as string), formatted.text);
      return { ok: true };
    },
    sendRootContext: async (record) => {
      const message = {
        customType: "subagent:fabric",
        content: formatMessage(record, "child").text,
        display: false,
        details: record,
      };
      // Explicit wake requests with a current stack plan use the budget path. Other false envelopes
      // remain quiet, and omitted wake retains the legacy call verbatim.
      const plan = rootPlans.get(record.key);
      if (plan && plan.from === record.from) {
        // A retry of bookkeeping must never resend a possibly effective body/start.
        if (plan.attempted)
          return plan.sent ? { ok: true } : { ok: false, retryable: false, reason: "policy", effect: "unknown" };
        plan.attempted = true;
        const state = readRootBudgetState(ctx);
        // Busy steer needs triggerTurn:true in pi 1.5: false only appends after the turn,
        // never injects a next turn. The SDK queues this into the already active run.
        const triggerTurn = state === "running" || (plan.action === "requestWake" && state === "idle");
        try {
          if (triggerTurn) pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
          else pi.sendMessage(message, { triggerTurn: false });
          plan.sent = true;
        } catch {
          // Void host API: no delivery confirmation, no refund/clear/retry.
          return { ok: false, retryable: false, reason: "policy", effect: "unknown" };
        }
      } else if (rootBudget && record.wake === true) {
        // Replayed loud envelopes have no authorization in this new stack.
        pi.sendMessage(message, { triggerTurn: false });
      } else if (record.wake === false) pi.sendMessage(message, { triggerTurn: false });
      else pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
      return { ok: true };
    },
    // W5: only with wake on (`level` is built iff wakeOn) — off ⇒ no revive port, legacy target_gone handling.
    ...(level ? { revive: (record: FabricRecord, claimToken: string) => wake!.revive(record, claimToken) } : {}),
    sendRootDisplay: async (record) => {
      // The entry renderer displays only state === "delivered" records (one
      // chat line per message despite the append-per-transition outbox). In
      // readBack mode the delivered store update appends that record; with
      // the degraded in-memory store it never reaches appendEntry, so stamp
      // this display-only append as delivered to keep it visible exactly once.
      pi.appendEntry(
        "subagent:fabric",
        readBack ? record : { ...record, state: "delivered" as const, deliveredAt: systemClock.now() },
      );
      return { ok: true };
    },
  };
  const wake = level
    ? createWakeService({
        engine,
        query,
        spawn,
        tombstone: wakeFacts.tombstone,
        agentTypeExists: wakeFacts.agentTypeExists,
        settings: () => settings.fabric.wake,
        level,
        router,
        durability,
        isLiveSessionFile,
        entries: prefetched,
        runEntries: () => ctx.sessionManager.getBranch(),
        clock: systemClock,
        reapMs: settings.budget.reapMs,
        onChanged: () => mailbox.pump(),
      })
    : undefined;
  const mailbox = createFabricMailbox({
    engine,
    router,
    throttle,
    ports,
    clock: systemClock,
    fabricSteerTimeoutMs: settings.budget.steerMs,
    progressChannel: settings.fabric.progressChannel,
    canRenderEntries: capabilities.canRenderEntries,
    maxAttempts: settings.deliveryAttempts,
    ...(level
      ? {
          level: {
            onDelivered: (record, channel) => {
              level.onDelivered(record, channel);
              const plan = rootPlans.get(record.key);
              if (record.to === "root" && plan?.from === record.from && plan.sent) {
                if (plan.reservation) rootBudget!.clearReservation(rootOwner, plan.reservation, "delivered");
                rootPlans.delete(record.key);
              }
            },
          },
        }
      : {}),
    ...(wake
      ? {
          inbox: {
            sweep: (...args) => wake.sweep(...args),
            nextSweepAt: (...args) => wake.nextSweepAt(...args),
            successor: (...args) => wake.successor(...args),
            steerHeld: (...args) => wake.steerHeld(...args),
            auditUnverified: (...args) => wake.auditUnverified(...args),
            subscribe: (...args) => wake.subscribe(...args),
            dispose: () => {
              rootBudget?.dispose(rootOwner);
              rootPlans.clear();
              wake.dispose();
            },
          },
        }
      : {}),
  });
  return {
    engine,
    tree,
    router,
    mailbox,
    ...(rootBudgetPort ? { rootBudget: rootBudgetPort } : {}),
    ...(level ? { level } : {}),
    ...(wake ? { wake } : {}),
  };
}
