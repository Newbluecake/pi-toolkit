import { describe, expect, it, vi } from "vitest";
import {
  createHubCoordinator,
  createScheduleHubRouter,
  NULL_SCHEDULE_COORDINATOR,
  type SchedHubLink,
  type SchedRunVerdict,
} from "../../../src/schedule/agent/coordinator.js";
import type { SchedAgentFrame, SchedRunFrame } from "../../../src/web-hub/protocol/schedule.js";
import { decodeAgentFrame } from "../../../src/web-hub/protocol/messages.js";

const SID = "019a0000-aaaa-7bbb-8ccc-dddddddddddd";
const REQ = "fsAbCdEfGhIjKlMnOpQrStUvWxYz0123";
const HASH = "a".repeat(64);

function link(ready = true) {
  const sent: SchedAgentFrame[] = [];
  const l: SchedHubLink & { sent: SchedAgentFrame[]; on: boolean } = {
    sent,
    on: ready,
    ready: () => l.on,
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
    expect(() => {
      NULL_SCHEDULE_COORDINATOR.changed();
      NULL_SCHEDULE_COORDINATOR.onRun(runFrame());
    }).not.toThrow();
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
});
