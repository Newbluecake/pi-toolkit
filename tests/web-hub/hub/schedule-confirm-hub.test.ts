/**
 * #61 H2 — hub coordination of confirm offers: exhaustive `onAgentFrame` dispatch, `sched_offers`
 * store + sid/cap validation, the projection's optional `offer`, port.offers/closedOffers/decide,
 * `offersChanged`, and the ledger-evidence extras handed to the Feishu card (F2).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createScheduleService,
  SCHED_DECIDE_WAITERS_MAX,
  SCHED_OFFERS_SESSIONS_MAX,
  type ScheduleCoordinator,
  type SchedTimer,
} from "../../../src/web-hub/hub/schedule/service.js";
import type { HubSchedulePort, ScheduleDelivery } from "../../../src/web-hub/hub/schedule/feishu-port.js";
import { defHash, emptyStateFile, type ScheduleStateFile, type ScheduleTask } from "../../../src/schedule/core/spec.js";
import {
  SCHED_CONFIRM_CAP,
  SCHED_DECIDE_ACK_WAIT_MS,
  SCHED_DECIDE_TTL_MS,
  SCHED_HUB_CAP,
  type SchedOffersFrame,
  type SchedulesPayloadWire,
} from "../../../src/web-hub/protocol/schedule.js";
import type { HubEvent } from "../../../src/web-hub/hub/ports.js";
import type { HubFrame } from "../../../src/web-hub/protocol/messages.js";

const BASE = Date.UTC(2026, 9, 26, 0, 0, 0);
const SID = "sess-a";
const TID = "s_abcd2345";
const OFFER = "offer-0123456789abcdef";
const REQ = (n: number): string => `req-${String(n).padStart(16, "0")}`;

const dirs: string[] = [];
const services: ScheduleCoordinator[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "pwh-sched-confirm-"));
  dirs.push(d);
  return d;
};

function pendingTask(over: Partial<ScheduleTask> = {}): ScheduleTask {
  const { approval: _drop, ...rest } = {
    id: TID,
    name: "daily",
    form: "background",
    when: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    prompt: "do the thing",
    feishu: true,
    enabled: true,
    bg: { type: "general-purpose", timeoutS: 1800, consultMain: false, handoff: false },
    approval: undefined,
    createdBy: "agent",
    createdVia: "tool",
    createdAt: 1,
    ownerCwd: "/tmp/x",
    ...over,
  } as ScheduleTask;
  return rest as ScheduleTask;
}
const approved = (t: ScheduleTask): ScheduleTask => ({
  ...t,
  approval: { hash: defHash(t), by: "user", via: "tui", at: 1 },
});

function writeStore(root: string, sid: string, tasks: ScheduleTask[]): void {
  const dir = join(root, sid);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const s: ScheduleStateFile = emptyStateFile(sid);
  s.rev = 1;
  s.tasks.push(...tasks);
  writeFileSync(join(dir, "state.json"), JSON.stringify(s), { mode: 0o600 });
}

interface AgentRec {
  session?: { sessionId: string };
  caps?: string[];
  connected: boolean;
}
function fakeRegistry() {
  const sent: { agentKey: string; frame: HubFrame }[] = [];
  const agents = new Map<string, AgentRec>();
  let busFn: ((e: HubEvent) => void) | undefined;
  return {
    sent,
    agents,
    emit: (e: HubEvent) => busFn?.(e),
    list: () =>
      [...agents.entries()].map(([agentKey, a]) => ({
        agentKey,
        ...(a.session === undefined ? {} : { session: a.session }),
      })),
    isConnected: (k: string) => agents.get(k)?.connected ?? false,
    getCaps: (k: string) => agents.get(k)?.caps,
    send: (k: string, frame: HubFrame) => {
      sent.push({ agentKey: k, frame });
      return agents.get(k)?.connected ?? false;
    },
    bus: {
      subscribe: (fn: (e: HubEvent) => void) => {
        busFn = fn;
        return () => {
          busFn = undefined;
        };
      },
    },
  };
}
type Reg = ReturnType<typeof fakeRegistry>;
const online = (reg: Reg, key = "a1", sid = SID, caps: string[] = [SCHED_HUB_CAP, SCHED_CONFIRM_CAP]): void => {
  reg.agents.set(key, { session: { sessionId: sid }, caps, connected: true });
};

function manualTimer(now: () => number) {
  const singles = new Map<object, { at: number; fn: () => void }>();
  const timer: SchedTimer = {
    set: (ms, fn) => {
      const h = {} as { unref?(): void };
      singles.set(h, { at: now() + ms, fn });
      return h;
    },
    clear: (h) => void singles.delete(h as object),
    interval: () => ({}) as { unref?(): void },
  };
  return {
    timer,
    pending: () => singles.size,
    runDue(): void {
      for (const [h, e] of [...singles]) {
        if (now() >= e.at) {
          singles.delete(h);
          e.fn();
        }
      }
    },
  };
}

function setup(reg: Reg, root: string) {
  const clock = { v: BASE };
  const mt = manualTimer(() => clock.v);
  const svc = createScheduleService({
    config: { dir: root, toleranceS: 60 },
    stateDir: tmp(),
    registry: reg,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => clock.v,
    timer: mt.timer,
  });
  services.push(svc);
  const payloads: SchedulesPayloadWire[] = [];
  svc.setSseSink({ publish: (p) => payloads.push(p) });
  return { svc, clock, mt, payloads, port: svc.port() as HubSchedulePort };
}

const offersFrame = (over: Partial<SchedOffersFrame> & { hash?: string } = {}): SchedOffersFrame => ({
  t: "sched_offers",
  sessionId: SID,
  open: [{ offerId: OFFER, taskId: TID, defHash: over.hash ?? defHash(pendingTask()), expiresAt: BASE + 3_600_000 }],
  closed: [],
  ...(over.sessionId === undefined ? {} : { sessionId: over.sessionId }),
  ...(over.open === undefined ? {} : { open: over.open }),
  ...(over.closed === undefined ? {} : { closed: over.closed }),
});

const offerOfTask = (p: SchedulesPayloadWire | undefined) =>
  p?.sessions.find((s) => s.sessionId === SID)?.tasks[0]?.offer;

function deliveryRecorder() {
  const calls: string[] = [];
  const delivery: ScheduleDelivery = {
    pushNotice: async () => ({ outcome: "queued" }),
    pushReport: async (o) => ({ reportId: o.reportId, outcome: "queued" }),
    receiptsFor: () => [],
    hasReceipt: () => false,
    offersChanged: (sid) => void calls.push(sid),
  };
  return { delivery, calls };
}

describe("onAgentFrame is exhaustive by `t` (#61 regression: no more default-run_ack)", () => {
  it("sched_offers / sched_decide_ack never settle a pending run() waiter", async () => {
    const root = tmp();
    writeStore(root, SID, [approved(pendingTask())]);
    const reg = fakeRegistry();
    online(reg);
    const { svc, port } = setup(reg, root);
    await svc.rescanAll();
    const run = port.run({ reqId: REQ(1), sessionId: SID, taskId: TID, defHash: defHash(pendingTask()) });
    let settled = false;
    void run.then(() => (settled = true));
    svc.onAgentFrame("a1", offersFrame());
    svc.onAgentFrame("a1", { t: "sched_decide_ack", reqId: REQ(1), result: "approved" });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    svc.onAgentFrame("a1", { t: "sched_run_ack", reqId: REQ(1), result: "started" });
    expect(await run).toEqual({ kind: "started" });
  });
});

describe("sched_offers acceptance", () => {
  it("drops a frame whose sessionId is not the sender's own session (counted), keeps the rest", () => {
    const reg = fakeRegistry();
    online(reg, "a1", SID);
    online(reg, "a2", "sess-b");
    const { svc, port } = setup(reg, tmp());
    svc.onAgentFrame("a2", offersFrame()); // a2 owns sess-b but claims sess-a
    expect(svc.status().counters.offersDropped).toBe(1);
    expect(port.offersSeen?.(SID)).toBeUndefined();
    svc.onAgentFrame("ghost", offersFrame()); // unknown agent
    expect(svc.status().counters.offersDropped).toBe(2);
    svc.onAgentFrame("a1", offersFrame());
    expect(svc.status().counters.offersFrames).toBe(1);
    expect(port.offersSeen?.(SID)).toEqual({ at: BASE, online: true });
  });

  it("drops a frame from an agent that never declared the confirm cap", () => {
    const reg = fakeRegistry();
    online(reg, "a1", SID, [SCHED_HUB_CAP]);
    const { svc, port } = setup(reg, tmp());
    svc.onAgentFrame("a1", offersFrame());
    expect(svc.status().counters.offersDropped).toBe(1);
    expect(port.offersSeen?.(SID)).toBeUndefined();
  });

  it("remembers at most SCHED_OFFERS_SESSIONS_MAX sessions (stalest evicted)", () => {
    const reg = fakeRegistry();
    const { svc, port } = setup(reg, tmp());
    const n = SCHED_OFFERS_SESSIONS_MAX + 3;
    for (let i = 0; i < n; i++) {
      const sid = `sess-${i}`;
      online(reg, `k${i}`, sid);
      svc.onAgentFrame(`k${i}`, offersFrame({ sessionId: sid, open: [] }));
    }
    expect(port.offersSeen?.("sess-0")).toBeUndefined();
    expect(port.offersSeen?.("sess-2")).toBeUndefined();
    expect(port.offersSeen?.("sess-3")).toBeDefined();
    expect(port.offersSeen?.(`sess-${n - 1}`)).toBeDefined();
  });
});

describe("projection `offer` (online ∧ hash-match ∧ pending ∧ unexpired)", () => {
  it("appears with the frame, vanishes when the view goes away / expires / hash changes", async () => {
    const root = tmp();
    writeStore(root, SID, [pendingTask()]);
    const reg = fakeRegistry();
    online(reg);
    const { svc, clock, payloads } = setup(reg, root);
    await svc.rescanAll();
    expect(offerOfTask(payloads.at(-1))).toBeUndefined(); // no offers yet

    svc.onAgentFrame("a1", offersFrame());
    expect(offerOfTask(payloads.at(-1))).toEqual({ offerId: OFFER, expiresAt: BASE + 3_600_000 });
    expect(offerOfTask(svc.snapshot(SID))).toBeDefined();

    // second view of the same session ⇒ ambiguous ⇒ no offer
    online(reg, "a2", SID);
    reg.emit({ type: "agent_up", agent: { session: { sessionId: SID } } } as never);
    await svc.rescanSession(SID);
    expect(offerOfTask(svc.snapshot(SID))).toBeUndefined();
    reg.agents.delete("a2");
    await svc.rescanSession(SID);
    expect(offerOfTask(svc.snapshot(SID))).toBeDefined();

    // agent view disconnects ⇒ projection drops it (offers are retained for a later reattach)
    reg.agents.get("a1")!.connected = false;
    reg.emit({ type: "agent_down", agentKey: "a1", reason: "x" });
    expect(offerOfTask(payloads.at(-1))).toBeUndefined();
    reg.agents.get("a1")!.connected = true;
    await svc.rescanSession(SID);
    expect(offerOfTask(svc.snapshot(SID))).toBeDefined();

    // expiry
    clock.v = BASE + 3_600_001;
    await svc.rescanSession(SID);
    expect(offerOfTask(svc.snapshot(SID))).toBeUndefined();
  });

  it("is absent when the offer's hash differs from the ledger's, or the task is already approved", async () => {
    const root = tmp();
    writeStore(root, SID, [pendingTask()]);
    const reg = fakeRegistry();
    online(reg);
    const { svc } = setup(reg, root);
    await svc.rescanAll();
    svc.onAgentFrame("a1", offersFrame({ hash: "f".repeat(64) }));
    expect(offerOfTask(svc.snapshot(SID))).toBeUndefined();

    svc.onAgentFrame("a1", offersFrame());
    expect(offerOfTask(svc.snapshot(SID))).toBeDefined();
    writeStore(root, SID, [approved(pendingTask())]);
    await svc.rescanSession(SID);
    expect(offerOfTask(svc.snapshot(SID))).toBeUndefined();
  });
});

describe("port.offers / closedOffers", () => {
  it("lists only hash-matching pending offers with the full definition; scan lag neither lists nor closes", async () => {
    const root = tmp();
    const t1 = pendingTask();
    writeStore(root, SID, [t1]);
    const reg = fakeRegistry();
    online(reg);
    const { svc, port } = setup(reg, root);
    await svc.rescanAll();
    // The agent already rewrote the task (offer = h2) but the hub's scan still sees h1.
    const t2 = pendingTask({ prompt: "changed" });
    svc.onAgentFrame(
      "a1",
      offersFrame({
        hash: defHash(t2),
        closed: [{ offerId: "offer-closed-0123456", taskId: TID, defHash: defHash(t1), outcome: "superseded" }],
      }),
    );
    expect(port.offers!()).toEqual([]);
    expect(port.closedOffers!(SID)).toEqual([
      { sessionId: SID, offerId: "offer-closed-0123456", outcome: "superseded" },
    ]);
    // the ledger catches up ⇒ now visible, definition included
    writeStore(root, SID, [t2]);
    await svc.rescanSession(SID);
    const rows = port.offers!();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: SID,
      sessionLabel: SID,
      online: true,
      offerId: OFFER,
      defHash: defHash(t2),
    });
    expect(rows[0]!.task.prompt).toBe("changed");
  });

  it("keeps offline sessions' offers listed with online:false; expired ones are not listed; by is carried", async () => {
    const root = tmp();
    writeStore(root, SID, [pendingTask()]);
    const reg = fakeRegistry();
    online(reg);
    const { svc, clock, port } = setup(reg, root);
    await svc.rescanAll();
    svc.onAgentFrame(
      "a1",
      offersFrame({
        closed: [
          { offerId: "offer-won-0123456789", taskId: TID, defHash: "a".repeat(64), outcome: "approved", by: "feishu" },
        ],
      }),
    );
    reg.agents.get("a1")!.connected = false;
    expect(port.offers!().map((r) => [r.offerId, r.online])).toEqual([[OFFER, false]]);
    expect(port.closedOffers!(SID)[0]).toMatchObject({ outcome: "approved", by: "feishu" });
    clock.v = BASE + 3_600_001;
    expect(port.offers!()).toEqual([]);
  });
});

describe("offersChanged", () => {
  it("fires on every accepted frame, on a rescan that flips the hash match, on view loss — and not on a no-op scan", async () => {
    const root = tmp();
    const t1 = pendingTask();
    writeStore(root, SID, [t1]);
    const reg = fakeRegistry();
    online(reg);
    const { svc } = setup(reg, root);
    const { delivery, calls } = deliveryRecorder();
    await svc.rescanAll();
    svc.bindDelivery(delivery);
    await svc.rescanAll();
    expect(calls).toEqual([]); // nothing offered yet

    const t2 = pendingTask({ prompt: "v2" });
    svc.onAgentFrame("a1", offersFrame({ hash: defHash(t2) }));
    expect(calls).toEqual([SID]);
    svc.onAgentFrame("a1", offersFrame({ hash: defHash(t2) })); // identical hello_ack replay still announces
    expect(calls).toEqual([SID, SID]);

    await svc.rescanSession(SID); // ledger still t1 ⇒ nothing flips
    expect(calls).toHaveLength(2);
    writeStore(root, SID, [t2]);
    await svc.rescanSession(SID); // hash now matches ⇒ visible set changed
    expect(calls).toHaveLength(3);
    await svc.rescanSession(SID);
    expect(calls).toHaveLength(3);

    reg.agents.get("a1")!.connected = false;
    reg.emit({ type: "agent_down", agentKey: "a1", reason: "x" });
    expect(calls).toHaveLength(4);
  });

  it("swallows a throwing delivery and announces pre-bind offers when delivery binds", () => {
    const reg = fakeRegistry();
    online(reg);
    const { svc } = setup(reg, tmp());
    svc.onAgentFrame("a1", offersFrame());
    const { delivery, calls } = deliveryRecorder();
    svc.bindDelivery({
      ...delivery,
      offersChanged: (sid) => (
        calls.push(sid),
        (() => {
          throw new Error("boom");
        })()
      ),
    });
    expect(calls).toEqual([SID]);
    svc.onAgentFrame("a1", offersFrame()); // must not throw into the frame router
    expect(calls).toEqual([SID, SID]);
  });
});

describe("port.decide", () => {
  const decideReq = (n = 1, over: Record<string, unknown> = {}) => ({
    reqId: REQ(n),
    sessionId: SID,
    offerId: OFFER,
    taskId: TID,
    defHash: "b".repeat(64),
    decision: "approve" as const,
    ...over,
  });
  const decideFrames = (reg: Reg) => reg.sent.filter((s) => s.frame.t === "sched_decide");

  it("offline / multi / no-cap / bad-request never send a frame", async () => {
    const reg = fakeRegistry();
    const { port } = setup(reg, tmp());
    expect(await port.decide!(decideReq())).toEqual({ kind: "offline" });
    online(reg, "a1");
    online(reg, "a2");
    expect(await port.decide!(decideReq(2))).toEqual({ kind: "multi" });
    reg.agents.delete("a2");
    reg.agents.get("a1")!.caps = [SCHED_HUB_CAP]; // old agent: sched.v1 only
    expect(await port.decide!(decideReq(3))).toEqual({ kind: "refused", reason: "no-cap" });
    reg.agents.get("a1")!.caps = undefined;
    expect(await port.decide!(decideReq(4))).toEqual({ kind: "refused", reason: "no-cap" });
    expect(await port.decide!(decideReq(5, { reqId: "short" }))).toEqual({ kind: "refused", reason: "bad-request" });
    expect(await port.decide!(decideReq(6, { defHash: "zz" }))).toEqual({ kind: "refused", reason: "bad-request" });
    expect(await port.decide!(decideReq(7, { decision: "maybe" }))).toEqual({ kind: "refused", reason: "bad-request" });
    expect(decideFrames(reg)).toHaveLength(0);
  });

  it("a disconnected send is offline; a good send carries ttl and resolves on the matching ack", async () => {
    const reg = fakeRegistry();
    online(reg);
    const { port, svc, clock } = setup(reg, tmp());
    reg.agents.get("a1")!.connected = false;
    expect(await port.decide!(decideReq())).toEqual({ kind: "offline" });
    reg.agents.get("a1")!.connected = true;

    const p = port.decide!(decideReq(2));
    expect(decideFrames(reg).at(-1)!.frame).toEqual({
      t: "sched_decide",
      reqId: REQ(2),
      sessionId: SID,
      offerId: OFFER,
      taskId: TID,
      defHash: "b".repeat(64),
      decision: "approve",
      expiresAt: clock.v + SCHED_DECIDE_TTL_MS,
    });
    svc.onAgentFrame("a1", { t: "sched_decide_ack", reqId: REQ(2), result: "approved" });
    expect(await p).toEqual({ kind: "approved" });

    const r = port.decide!(decideReq(3, { decision: "reject" }));
    svc.onAgentFrame("a1", { t: "sched_decide_ack", reqId: REQ(3), result: "rejected" });
    expect(await r).toEqual({ kind: "rejected" });

    const f = port.decide!(decideReq(4));
    svc.onAgentFrame("a1", { t: "sched_decide_ack", reqId: REQ(4), result: "refused", reason: "E_REV" });
    expect(await f).toEqual({ kind: "refused", reason: "E_REV" });
    const g = port.decide!(decideReq(5));
    svc.onAgentFrame("a1", { t: "sched_decide_ack", reqId: REQ(5), result: "refused" });
    expect(await g).toEqual({ kind: "refused", reason: "refused" });
  });

  it("times out after SCHED_DECIDE_ACK_WAIT_MS; a late ack is ignored; the timer map empties", async () => {
    const reg = fakeRegistry();
    online(reg);
    const { port, svc, clock, mt } = setup(reg, tmp());
    const p = port.decide!(decideReq());
    expect(mt.pending()).toBe(1);
    clock.v += SCHED_DECIDE_ACK_WAIT_MS - 1;
    mt.runDue();
    clock.v += 1;
    mt.runDue();
    expect(await p).toEqual({ kind: "timeout" });
    expect(mt.pending()).toBe(0);
    svc.onAgentFrame("a1", { t: "sched_decide_ack", reqId: REQ(1), result: "approved" });
    expect(svc.status().counters.decideTimeouts).toBe(1);
    expect(svc.status().counters.decideAcksIgnored).toBe(1);
  });

  it("joins a duplicate in-flight reqId (one frame) and ignores an ack from a foreign agent", async () => {
    const reg = fakeRegistry();
    online(reg);
    online(reg, "other", "sess-z");
    const { port, svc } = setup(reg, tmp());
    const a = port.decide!(decideReq());
    const b = port.decide!(decideReq());
    expect(decideFrames(reg)).toHaveLength(1);
    svc.onAgentFrame("other", { t: "sched_decide_ack", reqId: REQ(1), result: "approved" });
    expect(svc.status().counters.decideAcksIgnored).toBe(1);
    svc.onAgentFrame("a1", { t: "sched_decide_ack", reqId: REQ(1), result: "rejected" });
    expect(await a).toEqual({ kind: "rejected" });
    expect(await b).toEqual({ kind: "rejected" });
  });

  it("bounds concurrent waiters", async () => {
    const reg = fakeRegistry();
    online(reg);
    const { port } = setup(reg, tmp());
    const pending: Promise<unknown>[] = [];
    for (let i = 1; i <= SCHED_DECIDE_WAITERS_MAX; i++) pending.push(port.decide!(decideReq(i)));
    expect(await port.decide!(decideReq(SCHED_DECIDE_WAITERS_MAX + 1))).toEqual({ kind: "refused", reason: "busy" });
    expect(decideFrames(reg)).toHaveLength(SCHED_DECIDE_WAITERS_MAX);
    void pending;
  });

  it("dispose settles every waiter as unavailable and clears timers; later decides are unavailable", async () => {
    const reg = fakeRegistry();
    online(reg);
    const { port, svc, mt } = setup(reg, tmp());
    const p1 = port.decide!(decideReq(1));
    const p2 = port.decide!(decideReq(2));
    expect(mt.pending()).toBe(2);
    await svc.dispose();
    expect(await p1).toEqual({ kind: "unavailable" });
    expect(await p2).toEqual({ kind: "unavailable" });
    expect(mt.pending()).toBe(0);
    expect(await port.decide!(decideReq(3))).toEqual({ kind: "unavailable" });
  });
});

describe("ledger evidence for the card (port.ledgerTask / offersSeen)", () => {
  it("present (approved or not) / deleted / stale / no-session / degraded", async () => {
    const root = tmp();
    writeStore(root, SID, [pendingTask()]);
    const reg = fakeRegistry();
    online(reg);
    const { svc, clock, port } = setup(reg, root);
    expect(port.ledgerTask!(SID, TID)).toEqual({ kind: "unknown", reason: "no-session" });

    clock.v = BASE + 1000;
    await svc.rescanAll();
    expect(port.ledgerTask!(SID, TID)).toEqual({
      kind: "present",
      approved: false,
      defHash: defHash(pendingTask()),
      scannedAt: BASE + 1000,
    });
    writeStore(root, SID, [approved(pendingTask())]);
    clock.v = BASE + 2000;
    await svc.rescanSession(SID);
    expect(port.ledgerTask!(SID, TID)).toMatchObject({ kind: "present", approved: true, scannedAt: BASE + 2000 });

    // task removed: deletion is only PROVEN by a scan that started at/after the caller's anchor
    writeStore(root, SID, []);
    clock.v = BASE + 3000;
    await svc.rescanSession(SID);
    expect(port.ledgerTask!(SID, TID)).toEqual({ kind: "deleted", scannedAt: BASE + 3000 });
    expect(port.ledgerTask!(SID, TID, { since: BASE + 3000 })).toEqual({ kind: "deleted", scannedAt: BASE + 3000 });
    expect(port.ledgerTask!(SID, TID, { since: BASE + 3001 })).toEqual({ kind: "unknown", reason: "stale" });

    // unreadable ledger is never "deleted"
    writeFileSync(join(root, SID, "state.json"), "{not json");
    clock.v = BASE + 4000;
    await svc.rescanSession(SID);
    expect(port.ledgerTask!(SID, TID)).toEqual({ kind: "unknown", reason: "degraded" });
  });

  it("a rescan of another session does not refresh scannedAt", async () => {
    const root = tmp();
    writeStore(root, SID, [pendingTask()]);
    const reg = fakeRegistry();
    online(reg);
    const { svc, clock, port } = setup(reg, root);
    clock.v = BASE + 10;
    await svc.rescanAll();
    clock.v = BASE + 20;
    await svc.rescanSession("sess-other-does-not-exist");
    expect(port.ledgerTask!(SID, TID)).toMatchObject({ kind: "present", scannedAt: BASE + 10 });
  });

  it("offersSeen reports authority time and liveness", () => {
    const reg = fakeRegistry();
    online(reg);
    const { svc, clock, port } = setup(reg, tmp());
    expect(port.offersSeen!(SID)).toBeUndefined();
    clock.v = BASE + 5;
    svc.onAgentFrame("a1", offersFrame());
    expect(port.offersSeen!(SID)).toEqual({ at: BASE + 5, online: true });
    reg.agents.get("a1")!.connected = false;
    expect(port.offersSeen!(SID)).toEqual({ at: BASE + 5, online: false });
  });
});
