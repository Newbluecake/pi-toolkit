import { describe, it, expect, vi } from "vitest";
import { createFeishuRuns } from "../../../../src/web-hub/hub/feishu/runs.js";
import { createFakeClock } from "../../../fixtures/feishu/fake-http.js";
import { NOW } from "../../../fixtures/feishu/f6.js";
import type { FeishuRequestRecord } from "../../../../src/web-hub/hub/feishu/state.js";

/** fabric-thread §8.1 结果竞争 (S9/S10): thread candidates defer gap/epoch/consumed races to
 *  the result under a bounded fallback; `detach` removes the tracker without finishing. */
function rig() {
  const clock = createFakeClock(NOW),
    finish = vi.fn(),
    reaction = vi.fn(),
    transfer = vi.fn();
  const runs = createFeishuRuns({ clock, finish, reaction, transfer, frameDeadlineMs: 8_000 });
  let seq = 0;
  const request: FeishuRequestRecord = {
    id: "fs" + "a".repeat(30),
    batchId: "a".repeat(64),
    state: "dispatching",
    createdAt: NOW,
    stateAt: NOW,
    sessionId: "s1",
    agentKey: "a1",
    bindingKey: "grp:c1:t1",
    bindingRev: 1,
    chatId: "c1",
    chatType: "group",
    threadId: "t1",
    triggerMessageId: "m1",
    senderOpenId: "ou_owner",
    senderDisplay: "Owner",
    chatLabel: "chat",
    textDigest: "a".repeat(64),
  };
  const text = "[飞书 · Owner · chat · #ABCDEFGHIJKL]\nbody";
  const ev = (e: object) => {
    runs.event({ type: "ev", agentKey: "a1", seq: ++seq, e: e as never });
  };
  const ctl = (state: "consumed" | "dropped" = "consumed", epoch = "e1", sid = "s1", withItem = true) =>
    runs.event({
      type: "ctl",
      agentKey: "a1",
      epoch,
      sessionId: sid,
      items: withItem ? [{ cmdId: request.id, op: "prompt", state, at: NOW, updatedAt: NOW }] : [],
    });
  const anchor = (value = text) =>
    ev({ type: "message_start", message: { role: "user", content: [{ type: "text", text: value }] } });
  const start = (thread = true) =>
    runs.request({ type: "dispatching", request, text, ...(thread ? { thread: true } : {}) });
  const accept = () =>
    runs.request({
      type: "accepted",
      request: { ...request, state: "accepted" },
      text,
      reactionEligible: false,
      recovered: false,
    });
  return { runs, clock, finish, reaction, request, start, accept, ctl, ev, anchor };
}

describe("thread candidate gap competition (S9)", () => {
  it("a gap before the result does NOT finish; the fallback bound does", () => {
    const r = rig();
    r.start();
    r.runs.event({ type: "gap", agentKey: "a1" });
    expect(r.finish).not.toHaveBeenCalled();
    r.clock.advance(8_000 + 5_000);
    expect(r.finish).toHaveBeenCalledWith(expect.objectContaining({ kind: "unattributed" }));
  });
  it("agent_down/agent_stale/agent_up all defer the same way", () => {
    for (const type of ["agent_down", "agent_stale", "agent_up"] as const) {
      const r = rig();
      r.start();
      r.runs.event({ type, agentKey: "a1" });
      expect(r.finish).not.toHaveBeenCalled();
      r.clock.advance(13_000);
      expect(r.finish).toHaveBeenCalledTimes(1);
    }
  });
  it("a plain-ok result AFTER the gap finishes unattributed, exactly like today", () => {
    const r = rig();
    r.start();
    r.runs.event({ type: "gap", agentKey: "a1" });
    r.accept();
    expect(r.finish).toHaveBeenCalledWith(expect.objectContaining({ kind: "unattributed" }));
  });
  it("an epoch change defers for candidates (non-candidates finish immediately)", () => {
    const r = rig();
    r.start();
    r.ctl("consumed", "e1", "s1", false); // prime the stream epoch without touching the run
    r.ctl("consumed", "e2");
    expect(r.finish).not.toHaveBeenCalled();
    r.clock.advance(13_000);
    expect(r.finish).toHaveBeenCalledTimes(1);
    const legacy = rig();
    legacy.start(false);
    legacy.ctl("consumed", "e1", "s1", false);
    legacy.ctl("consumed", "e2");
    expect(legacy.finish).toHaveBeenCalledTimes(1);
  });
  it("consumed-without-anchor arms the fallback bound, not the 60 s anchor timer", () => {
    const r = rig();
    r.start();
    r.ctl("consumed");
    r.clock.advance(13_000);
    expect(r.finish).toHaveBeenCalledTimes(1);
    const legacy = rig();
    legacy.start(false);
    legacy.ctl("consumed");
    legacy.clock.advance(13_000);
    expect(legacy.finish).not.toHaveBeenCalled(); // still inside the 60 s window
    legacy.clock.advance(60_000);
    expect(legacy.finish).toHaveBeenCalledTimes(1);
  });
  it("a late plain-ok result restores the standard 60 s consumed bound", () => {
    const r = rig();
    r.start();
    r.ctl("consumed"); // fallback armed (13 s) — NOT a stream break
    r.clock.advance(12_000);
    r.accept(); // result arrived: fallback never fires; 60 s bound restored
    r.clock.advance(2_000);
    expect(r.finish).not.toHaveBeenCalled();
    r.clock.advance(60_000);
    expect(r.finish).toHaveBeenCalledWith(expect.objectContaining({ kind: "unattributed" }));
  });
});

describe("session change before the result (S9 variant, §8.1 r3-5)", () => {
  it("an ANCHORED candidate does not finish early; a late routed detach migrates cleanly", () => {
    const r = rig();
    r.start();
    r.anchor(); // the slow-path anchor landed before the session was replaced
    r.runs.event({ type: "session", agentKey: "a1", session: { sessionId: "s2" } });
    expect(r.finish).not.toHaveBeenCalled();
    // The routed outcome: detach removes the tracker — no finish ever fires.
    r.runs.detach(r.request.id);
    r.clock.advance(60_000);
    expect(r.finish).not.toHaveBeenCalled();
  });
  it("an anchored candidate + session change + plain-ok ⇒ unattributed (stream already broke)", () => {
    const r = rig();
    r.start();
    r.anchor();
    r.runs.event({ type: "session", agentKey: "a1", session: { sessionId: "s2" } });
    r.accept(); // plain ok after the break — anchor or not, attribution is gone
    expect(r.finish).toHaveBeenCalledWith(expect.objectContaining({ kind: "unattributed" }));
  });
  it("an anchored NON-candidate still finishes immediately on session change (unchanged legacy)", () => {
    const r = rig();
    r.start(false);
    r.anchor();
    r.runs.event({ type: "session", agentKey: "a1", session: { sessionId: "s2" } });
    expect(r.finish).toHaveBeenCalledTimes(1);
  });
});

describe("routed detach (S10, §8.1 step 2)", () => {
  it("detach clears timers and removes the tracker WITHOUT finishing or reacting", () => {
    const r = rig();
    r.start();
    r.ctl("consumed");
    r.runs.detach(r.request.id);
    expect(r.runs.has(r.request.id)).toBe(false);
    expect(r.finish).not.toHaveBeenCalled();
    expect(r.reaction).not.toHaveBeenCalled();
    r.clock.advance(24 * 3_600_000); // nothing fires afterwards
    expect(r.finish).not.toHaveBeenCalled();
  });
  it("detach is idempotent; a late finish on a detached id is a no-op", () => {
    const r = rig();
    r.runs.detach(r.request.id);
    r.runs.detach(r.request.id);
    expect(r.finish).not.toHaveBeenCalled();
  });
  it("the routed request event (arriving after detach) finds no tracker and stays silent", () => {
    const r = rig();
    r.start();
    r.runs.detach(r.request.id);
    r.runs.request({
      type: "routed",
      request: { ...r.request, state: "accepted", code: "thr:routed" },
      runs: [{ runId: "r_23456789", label: "w" }],
      retained: true,
      recovered: false,
    });
    expect(r.finish).not.toHaveBeenCalled();
  });
  it("a NON-candidate run still finishes unattributed on gap (unchanged legacy path)", () => {
    const r = rig();
    r.start(false);
    r.runs.event({ type: "gap", agentKey: "a1" });
    expect(r.finish).toHaveBeenCalledTimes(1);
  });
});
