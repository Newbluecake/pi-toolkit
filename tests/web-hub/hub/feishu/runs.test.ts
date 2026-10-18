import { describe, it, expect, vi } from "vitest";
import { createFeishuRuns } from "../../../../src/web-hub/hub/feishu/runs.js";
import { createFakeClock } from "../../../fixtures/feishu/fake-http.js";
import { NOW } from "../../../fixtures/feishu/f6.js";
import type { FeishuRequestRecord } from "../../../../src/web-hub/hub/feishu/state.js";

function rig() {
  const clock = createFakeClock(NOW),
    finish = vi.fn(),
    reaction = vi.fn(),
    transfer = vi.fn();
  const runs = createFeishuRuns({ clock, finish, reaction, transfer });
  let seq = 0;
  const request: FeishuRequestRecord = {
    id: "fs" + "a".repeat(30),
    batchId: "a".repeat(64),
    state: "dispatching",
    createdAt: NOW,
    stateAt: NOW,
    sessionId: "s1",
    agentKey: "a1",
    bindingKey: "p2p:c1",
    bindingRev: 1,
    chatId: "c1",
    chatType: "p2p",
    triggerMessageId: "m1",
    senderOpenId: "ou_owner",
    senderDisplay: "Owner",
    chatLabel: "chat",
    textDigest: "a".repeat(64),
  };
  const text = "[飞书 · Owner · chat · #ABCDEFGHIJKL]\nbody";
  const ev = (e: any, n = ++seq) => {
    seq = n;
    runs.event({ type: "ev", agentKey: "a1", seq, e });
  };
  const ctl = (state: "consumed" | "dropped" | "recalled" | "returned" = "consumed", epoch = "e1", sid = "s1") =>
    runs.event({
      type: "ctl",
      agentKey: "a1",
      epoch,
      sessionId: sid,
      items: [{ cmdId: request.id, op: "prompt", state, at: NOW, updatedAt: NOW }],
    });
  const start = () => runs.request({ type: "dispatching", request, text });
  const accept = (recovered = false) =>
    runs.request({
      type: "accepted",
      request: { ...request, state: "accepted" },
      text,
      reactionEligible: true,
      recovered,
    });
  const anchor = (value = text) =>
    ev({ type: "message_start", message: { role: "user", content: [{ type: "text", text: value }] } });
  const output = (text = "secret result", stopReason = "stop") =>
    ev({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason } });
  const settle = () => ev({ type: "agent_settled" });
  return { runs, clock, finish, reaction, transfer, request, text, ev, ctl, start, accept, anchor, output, settle };
}
describe("F8 R2-a/b attribution", () => {
  it("needs consumed + exact token anchor; ignores agent_end and output until settled", () => {
    const r = rig();
    r.start();
    r.accept();
    r.ctl();
    r.anchor();
    r.output();
    r.ev({ type: "agent_end" });
    expect(r.finish).not.toHaveBeenCalled();
    r.settle();
    expect(r.finish).toHaveBeenCalledWith(expect.objectContaining({ kind: "done", text: "secret result" }));
    expect(r.reaction.mock.calls.map((c) => c[1])).toEqual([true, false]);
  });
  it.each([false, true])(
    "a settle before the queued token anchor belongs to the previous run (accepted=%s)",
    (accepted) => {
      const r = rig();
      r.start();
      if (accepted) r.accept();
      r.output("previous run output");
      r.settle();
      expect(r.finish).not.toHaveBeenCalled();
      expect(r.runs.has(r.request.id)).toBe(true);
      if (!accepted) r.accept();
      expect(r.finish).not.toHaveBeenCalled();
      r.ctl();
      r.anchor();
      r.output("queued request result");
      expect(r.finish).not.toHaveBeenCalled();
      r.settle();
      expect(r.finish).toHaveBeenCalledTimes(1);
      expect(r.finish.mock.calls[0]![0]).toMatchObject({ kind: "done", text: "queued request result" });
    },
  );
  it("buffers synchronous router events until accepted durability", () => {
    const r = rig();
    r.start();
    r.ctl();
    r.anchor();
    r.output();
    r.settle();
    expect(r.finish).not.toHaveBeenCalled();
    r.accept();
    expect(r.finish.mock.calls[0]![0].kind).toBe("done");
  });
  it.each(["body", "[飞书 · Owner · chat · #XXXXXXXXXXXX]\nbody", "[飞书 · Owner · chat · #ABCDEFGHIJKL]\nnot body"])(
    "same body/forged anchor %s never leaks output",
    (text) => {
      const r = rig();
      r.start();
      r.accept();
      r.ctl();
      r.anchor(text);
      r.output();
      r.settle();
      expect(r.finish).not.toHaveBeenCalled();
      r.clock.advance(60_000);
      expect(r.finish).toHaveBeenCalledWith(expect.objectContaining({ kind: "unattributed", text: "" }));
    },
  );
  it("anchor without consumed is not proof", () => {
    const r = rig();
    r.start();
    r.accept();
    r.anchor();
    r.output();
    r.settle();
    expect(r.finish.mock.calls[0]![0].kind).toBe("unattributed");
  });
  it("consumed without anchor expires after 60 seconds without content", () => {
    const r = rig();
    r.start();
    r.accept();
    r.ctl();
    r.clock.advance(60_000);
    expect(r.finish.mock.calls[0]![0]).toMatchObject({ kind: "unattributed", text: "" });
  });
  it.each(["gap", "agent_down", "agent_up", "agent_stale"] as const)(
    "%s invalidates a previously proved window",
    (type) => {
      const r = rig();
      r.start();
      r.accept();
      r.ctl();
      r.anchor();
      r.output();
      r.runs.event({ type, agentKey: "a1" });
      r.settle();
      expect(r.finish.mock.calls[0]![0]).toMatchObject({ kind: "unattributed", text: "" });
    },
  );
  it("sequence discontinuity cannot be repaired by later snapshots/settle", () => {
    const r = rig();
    r.start();
    r.accept();
    r.ctl();
    r.anchor();
    r.output();
    r.ev({ type: "agent_settled" }, 99);
    expect(r.finish.mock.calls[0]![0].kind).toBe("unattributed");
  });
  it("epoch change invalidates proof", () => {
    const r = rig();
    r.start();
    r.accept();
    r.ctl();
    r.anchor();
    r.output();
    r.ctl("consumed", "e2");
    expect(r.finish.mock.calls[0]![0].kind).toBe("unattributed");
  });
  it("another user message cuts reply without attributing later output", () => {
    const r = rig();
    r.start();
    r.accept();
    r.ctl();
    r.anchor();
    r.output("ours");
    r.anchor("TUI task");
    r.output("TUI secret");
    r.settle();
    expect(r.finish.mock.calls[0]![0]).toMatchObject({ text: "ours", continued: true, kind: "done" });
  });
  it.each(["dropped", "recalled", "returned"] as const)("ctl %s is rejected without output", (state) => {
    const r = rig();
    r.start();
    r.accept();
    r.ctl(state);
    expect(r.finish.mock.calls[0]![0]).toMatchObject({ kind: "rejected", text: "" });
  });
  it("token anchor positively follows a pre-anchor session transfer", () => {
    const r = rig();
    r.start();
    r.accept();
    r.runs.event({ type: "session", agentKey: "a1", session: { sessionId: "s2" } });
    r.ctl("consumed", "e1", "s2");
    r.anchor();
    expect(r.transfer).toHaveBeenCalledWith(expect.anything(), "s2");
    r.output();
    r.settle();
    expect(r.finish.mock.calls[0]![0].kind).toBe("done");
  });
  it("session change after anchor loses continuity", () => {
    const r = rig();
    r.start();
    r.accept();
    r.ctl();
    r.anchor();
    r.runs.event({ type: "session", agentKey: "a1", session: { sessionId: "s2" } });
    expect(r.finish.mock.calls[0]![0].kind).toBe("unattributed");
  });
  it("recovered accepted can never yield output", () => {
    const r = rig();
    r.accept(true);
    expect(r.finish.mock.calls[0]![0]).toMatchObject({ kind: "unattributed", text: "" });
  });
  it("TTL expires (not success) and disposal clears all owned timers", () => {
    const r = rig();
    r.start();
    r.accept();
    r.clock.advance(24 * 3_600_000);
    expect(r.finish.mock.calls[0]![0].kind).toBe("expired");
    r.runs.dispose();
    expect(r.runs.size).toBe(0);
  });
  it.each(["error", "aborted"])("%s maps partial output to failure", (reason) => {
    const r = rig();
    r.start();
    r.accept();
    r.ctl();
    r.anchor();
    r.output("partial", reason);
    r.settle();
    expect(r.finish.mock.calls[0]![0]).toMatchObject({ kind: "failed", stopReason: reason, text: "partial" });
  });
});
