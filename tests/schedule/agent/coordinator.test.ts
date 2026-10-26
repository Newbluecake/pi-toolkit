import { describe, expect, it, vi } from "vitest";
import {
  createHubCoordinator,
  createScheduleHubRouter,
  NULL_SCHEDULE_COORDINATOR,
  type SchedHubLink,
  type SchedRunVerdict,
} from "../../../src/schedule/agent/coordinator.js";
import type { DecideResult, ScheduleConfirm } from "../../../src/schedule/agent/confirm.js";
import type { SchedAgentFrame, SchedDecideFrame, SchedRunFrame } from "../../../src/web-hub/protocol/schedule.js";
import { decodeAgentFrame } from "../../../src/web-hub/protocol/messages.js";

const SID = "019a0000-aaaa-7bbb-8ccc-dddddddddddd";
const REQ = "fsAbCdEfGhIjKlMnOpQrStUvWxYz0123";
const HASH = "a".repeat(64);

function link(ready = true, confirmCap = true) {
  const sent: SchedAgentFrame[] = [];
  const l: SchedHubLink & { sent: SchedAgentFrame[]; on: boolean; confirmOn: boolean } = {
    sent,
    on: ready,
    confirmOn: confirmCap,
    ready: () => l.on,
    confirmReady: () => l.on && l.confirmOn,
    send: (f) => sent.push(f),
  };
  return l;
}

const runFrame = (over: Partial<SchedRunFrame> = {}): SchedRunFrame => ({
  t: "sched_run",
  reqId: REQ,
  sessionId: SID,
  taskId: "s_abcdefgh",
  defHash: HASH,
  expiresAt: 2_000,
  ...over,
});

const decideFrame = (over: Partial<SchedDecideFrame> = {}): SchedDecideFrame => ({
  t: "sched_decide",
  reqId: REQ,
  sessionId: SID,
  offerId: "ofAbCdEfGhIjKlMnOpQrStUvWxYz0123",
  taskId: "s_abcdefgh",
  defHash: HASH,
  decision: "approve",
  expiresAt: 2_000,
  ...over,
});

const flush = () => new Promise((r) => setImmediate(r));

function coord(l: SchedHubLink | undefined, run?: (req: unknown) => Promise<SchedRunVerdict>) {
  const removeReports = vi.fn(async () => true);
  const runRequest = vi.fn(run ?? (async () => ({ result: "started" }) as SchedRunVerdict));
  const c = createHubCoordinator({ link: () => l, sessionId: SID, now: () => 1_000, runRequest, removeReports });
  return { c, removeReports, runRequest };
}

describe("hub coordinator", () => {
  it("changed() is coalesced per tick and only sent while the link carries sched.v1; frames decode on the hub side", async () => {
    const l = link();
    const { c } = coord(l);
    c.changed();
    c.changed();
    c.changed();
    await flush();
    expect(l.sent).toEqual([{ t: "sched_changed", sessionId: SID }]);
    // every frame the agent emits is a valid agent frame for the hub decoder
    for (const f of l.sent) expect(decodeAgentFrame(JSON.parse(JSON.stringify(f)))).toEqual(f);
    l.on = false;
    c.changed();
    await flush();
    expect(l.sent).toHaveLength(1);
  });

  it("onHubCaps announces the session; bound() sends synchronously", () => {
    const l = link();
    const { c } = coord(l);
    c.onHubCaps();
    c.bound("ak-1", "s_abcdefgh@1761350400000");
    expect(l.sent).toEqual([
      { t: "sched_changed", sessionId: SID },
      { t: "sched_bound", agentKey: "ak-1", runKey: "s_abcdefgh@1761350400000" },
    ]);
  });

  it("sched_run: exactly one ack per frame; started / refused(reason) from the run handler", async () => {
    const l = link();
    const { c, runRequest } = coord(l, async () => ({ result: "refused", reason: "E_UNAPPROVED" }));
    c.onRun(runFrame());
    await flush();
    expect(runRequest).toHaveBeenCalledWith({ reqId: REQ, taskId: "s_abcdefgh", defHash: HASH });
    expect(l.sent).toEqual([{ t: "sched_run_ack", reqId: REQ, result: "refused", reason: "E_UNAPPROVED" }]);
    for (const f of l.sent) expect(decodeAgentFrame(JSON.parse(JSON.stringify(f)))).toEqual(f);
  });

  it("sched_run for another session / expired ⇒ refused without calling the handler", async () => {
    const l = link();
    const { c, runRequest } = coord(l);
    c.onRun(runFrame({ sessionId: "other-session" }));
    c.onRun(runFrame({ expiresAt: 1_000 }));
    await flush();
    expect(runRequest).not.toHaveBeenCalled();
    expect(l.sent).toEqual([
      { t: "sched_run_ack", reqId: REQ, result: "refused", reason: "E_NOT_OWNER" },
      { t: "sched_run_ack", reqId: REQ, result: "refused", reason: "E_INVALID:expired" },
    ]);
  });

  it("a duplicate in-flight reqId runs the handler once but acks each frame", async () => {
    const l = link();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { c, runRequest } = coord(l, async () => {
      await gate;
      return { result: "started" };
    });
    c.onRun(runFrame());
    c.onRun(runFrame());
    release();
    await flush();
    await flush();
    expect(runRequest).toHaveBeenCalledTimes(1);
    expect(l.sent).toEqual([
      { t: "sched_run_ack", reqId: REQ, result: "started" },
      { t: "sched_run_ack", reqId: REQ, result: "started" },
    ]);
  });

  it("a rejecting handler still acks (refused E_BUSY)", async () => {
    const l = link();
    const { c } = coord(l, async () => {
      throw new Error("boom");
    });
    c.onRun(runFrame());
    await flush();
    await flush();
    expect(l.sent).toEqual([{ t: "sched_run_ack", reqId: REQ, result: "refused", reason: "E_BUSY" }]);
  });

  it("sched_receipts removes the ids for THIS session only; a transient failure retries once", async () => {
    const l = link();
    const retries: Array<() => void> = [];
    let ok = false;
    const removeReports = vi.fn(async () => ok);
    const c = createHubCoordinator({
      link: () => l,
      sessionId: SID,
      runRequest: async () => ({ result: "started" }),
      removeReports,
      retryLater: (fn) => retries.push(fn),
    });
    c.onReceipts({ t: "sched_receipts", sessionId: "someone-else", reportIds: [HASH] });
    expect(removeReports).not.toHaveBeenCalled();
    c.onReceipts({ t: "sched_receipts", sessionId: SID, reportIds: [HASH] });
    await flush();
    expect(removeReports).toHaveBeenCalledWith([HASH]);
    expect(retries).toHaveLength(1);
    ok = true;
    retries[0]!();
    await flush();
    expect(removeReports).toHaveBeenCalledTimes(2);
    expect(retries).toHaveLength(1); // no second retry
  });

  it("disposed coordinator sends nothing but still refuses sched_run", async () => {
    const l = link();
    const { c, runRequest } = coord(l);
    c.dispose();
    c.changed();
    c.onHubCaps();
    c.onRun(runFrame());
    await flush();
    expect(runRequest).not.toHaveBeenCalled();
    expect(l.sent).toEqual([{ t: "sched_run_ack", reqId: REQ, result: "refused", reason: "E_NOT_OWNER" }]);
  });

  it("NullCoordinator does nothing", () => {
    expect(NULL_SCHEDULE_COORDINATOR.kind).toBe("null");
    expect(NULL_SCHEDULE_COORDINATOR.confirmReady()).toBe(false);
    expect(() => {
      NULL_SCHEDULE_COORDINATOR.changed();
      NULL_SCHEDULE_COORDINATOR.onRun(runFrame());
      NULL_SCHEDULE_COORDINATOR.onDecide(decideFrame());
      NULL_SCHEDULE_COORDINATOR.offers({ sessionId: SID, open: [], closed: [] });
    }).not.toThrow();
  });
});

describe("hub coordinator × confirm channel (#61 C2)", () => {
  const OFFER = { offerId: "ofAbCdEfGhIjKlMnOpQrStUvWxYz0123", taskId: "s_abcdefgh", defHash: HASH, expiresAt: 9_000 };

  function coordWithConfirm(
    l: SchedHubLink | undefined,
    decide?: (req: Parameters<ScheduleConfirm["decide"]>[0]) => Promise<DecideResult>,
  ) {
    const onHubCaps = vi.fn();
    const decideFn = vi.fn(decide ?? (async () => ({ kind: "approved" }) as DecideResult));
    const confirm = { decide: decideFn, onHubCaps } as unknown as ScheduleConfirm;
    const c = createHubCoordinator({
      link: () => l,
      sessionId: SID,
      now: () => 1_000,
      runRequest: async () => ({ result: "started" }),
      removeReports: async () => true,
      confirm: () => confirm,
    });
    return { c, confirm, decideFn, onHubCaps };
  }

  it("offers() sends the full snapshot only while the link carries sched.confirm.v1; frames decode on the hub side", () => {
    const l = link();
    const { c } = coordWithConfirm(l);
    expect(c.confirmReady()).toBe(true);
    c.offers({ sessionId: SID, open: [OFFER], closed: [] });
    expect(l.sent).toEqual([{ t: "sched_offers", sessionId: SID, open: [OFFER], closed: [] }]);
    for (const f of l.sent) expect(decodeAgentFrame(JSON.parse(JSON.stringify(f)))).toEqual(f);
    // no confirm cap ⇒ dropped (no queue); the next publish resends the full list
    l.confirmOn = false;
    expect(c.confirmReady()).toBe(false);
    c.offers({ sessionId: SID, open: [], closed: [] });
    expect(l.sent).toHaveLength(1);
    l.confirmOn = true;
    c.offers({ sessionId: SID, open: [], closed: [] });
    expect(l.sent).toHaveLength(2);
    // not live / disposed ⇒ dropped
    l.on = false;
    c.offers({ sessionId: SID, open: [OFFER], closed: [] });
    expect(l.sent).toHaveLength(2);
    l.on = true;
    c.dispose();
    c.offers({ sessionId: SID, open: [OFFER], closed: [] });
    expect(l.sent).toHaveLength(2);
    expect(c.confirmReady()).toBe(false);
  });

  it("onHubCaps announces the session AND lets confirm republish its offers (empty list too)", () => {
    const l = link();
    const { c, onHubCaps } = coordWithConfirm(l);
    c.onHubCaps();
    expect(l.sent).toEqual([{ t: "sched_changed", sessionId: SID }]);
    expect(onHubCaps).toHaveBeenCalledTimes(1);
  });

  it("sched_decide: approved / rejected / refused map to exactly one ack; args forwarded with via feishu", async () => {
    const l = link();
    const { c, decideFn } = coordWithConfirm(l);
    c.onDecide(decideFrame());
    await flush();
    expect(decideFn).toHaveBeenCalledWith({
      taskId: "s_abcdefgh",
      defHash: HASH,
      decision: "approve",
      via: "feishu",
      offerId: "ofAbCdEfGhIjKlMnOpQrStUvWxYz0123",
    });
    expect(l.sent).toEqual([{ t: "sched_decide_ack", reqId: REQ, result: "approved" }]);

    decideFn.mockImplementation(async () => ({ kind: "rejected", removed: true }));
    c.onDecide(decideFrame({ reqId: "rqAbCdEfGhIjKlMnOpQrStUvWxYz0123", decision: "reject" }));
    await flush();
    expect(l.sent[1]).toEqual({ t: "sched_decide_ack", reqId: "rqAbCdEfGhIjKlMnOpQrStUvWxYz0123", result: "rejected" });

    decideFn.mockImplementation(async () => ({ kind: "refused", code: "already-approved", detail: "x" }));
    c.onDecide(decideFrame({ reqId: "rfAbCdEfGhIjKlMnOpQrStUvWxYz0123" }));
    await flush();
    expect(l.sent[2]).toEqual({
      t: "sched_decide_ack",
      reqId: "rfAbCdEfGhIjKlMnOpQrStUvWxYz0123",
      result: "refused",
      reason: "already-approved",
    });
    for (const f of l.sent) expect(decodeAgentFrame(JSON.parse(JSON.stringify(f)))).toEqual(f);
  });

  it("sched_decide for another session / expired ⇒ refused without calling decide", async () => {
    const l = link();
    const { c, decideFn } = coordWithConfirm(l);
    c.onDecide(decideFrame({ sessionId: "other-session" }));
    c.onDecide(decideFrame({ reqId: "xpAbCdEfGhIjKlMnOpQrStUvWxYz0123", expiresAt: 1_000 }));
    await flush();
    expect(decideFn).not.toHaveBeenCalled();
    expect(l.sent).toEqual([
      { t: "sched_decide_ack", reqId: REQ, result: "refused", reason: "E_NOT_OWNER" },
      { t: "sched_decide_ack", reqId: "xpAbCdEfGhIjKlMnOpQrStUvWxYz0123", result: "refused", reason: "expired" },
    ]);
  });

  it("no confirm module ⇒ refused offer-gone; a rejecting decide still acks (E_BUSY)", async () => {
    const l = link();
    const bare = createHubCoordinator({
      link: () => l,
      sessionId: SID,
      now: () => 1_000,
      runRequest: async () => ({ result: "started" }),
      removeReports: async () => true,
    });
    bare.onDecide(decideFrame());
    await flush();
    expect(l.sent).toEqual([{ t: "sched_decide_ack", reqId: REQ, result: "refused", reason: "offer-gone" }]);

    const { c } = coordWithConfirm(l, async () => {
      throw new Error("boom");
    });
    c.onDecide(decideFrame({ reqId: "bsAbCdEfGhIjKlMnOpQrStUvWxYz0123" }));
    await flush();
    await flush();
    expect(l.sent[1]).toEqual({
      t: "sched_decide_ack",
      reqId: "bsAbCdEfGhIjKlMnOpQrStUvWxYz0123",
      result: "refused",
      reason: "E_BUSY",
    });
  });

  it("a duplicate in-flight reqId decides once but acks each frame", async () => {
    const l = link();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { c, decideFn } = coordWithConfirm(l, async () => {
      await gate;
      return { kind: "approved" };
    });
    c.onDecide(decideFrame());
    c.onDecide(decideFrame());
    release();
    await flush();
    await flush();
    expect(decideFn).toHaveBeenCalledTimes(1);
    expect(l.sent).toEqual([
      { t: "sched_decide_ack", reqId: REQ, result: "approved" },
      { t: "sched_decide_ack", reqId: REQ, result: "approved" },
    ]);
  });

  it("disposed coordinator still refuses sched_decide (exactly one ack)", async () => {
    const l = link();
    const { c, decideFn } = coordWithConfirm(l);
    c.dispose();
    c.onDecide(decideFrame());
    await flush();
    expect(decideFn).not.toHaveBeenCalled();
    expect(l.sent).toEqual([{ t: "sched_decide_ack", reqId: REQ, result: "refused", reason: "E_NOT_OWNER" }]);
  });
});

describe("activate-level router", () => {
  it("routes frames to the attached coordinator; detach is identity-checked; unattached runs are refused", async () => {
    const l = link();
    const router = createScheduleHubRouter({ hubConfig: () => ({ dir: "/s", toleranceS: 60 }) });
    router.bindLink(l);
    router.onSchedRun(runFrame());
    expect(l.sent).toEqual([{ t: "sched_run_ack", reqId: REQ, result: "refused", reason: "E_NOT_OWNER" }]);
    const a = coord(router.link());
    const b = coord(router.link());
    const detachA = router.attach(a.c);
    const detachB = router.attach(b.c);
    detachA(); // stale detach must not unhook B
    expect(router.attached()).toBe(b.c);
    router.onSchedReceipts({ t: "sched_receipts", sessionId: SID, reportIds: [HASH] });
    await flush();
    expect(b.removeReports).toHaveBeenCalled();
    expect(a.removeReports).not.toHaveBeenCalled();
    detachB();
    expect(router.attached()).toBeUndefined();
    expect(router.hubConfig()).toEqual({ dir: "/s", toleranceS: 60 });
  });

  it("sched_decide: refused E_NOT_OWNER while unattached; routed to the attached coordinator otherwise", async () => {
    const l = link();
    const router = createScheduleHubRouter({ hubConfig: () => undefined });
    router.bindLink(l);
    router.onSchedDecide(decideFrame());
    expect(l.sent).toEqual([{ t: "sched_decide_ack", reqId: REQ, result: "refused", reason: "E_NOT_OWNER" }]);
    const a = coord(router.link());
    const detach = router.attach(a.c);
    router.onSchedDecide(decideFrame({ reqId: "atAbCdEfGhIjKlMnOpQrStUvWxYz0123" }));
    await flush();
    // the plain coord() has no confirm dep ⇒ offer-gone, proving the frame reached the coordinator
    expect(l.sent[1]).toEqual({
      t: "sched_decide_ack",
      reqId: "atAbCdEfGhIjKlMnOpQrStUvWxYz0123",
      result: "refused",
      reason: "offer-gone",
    });
    detach();
  });
});
