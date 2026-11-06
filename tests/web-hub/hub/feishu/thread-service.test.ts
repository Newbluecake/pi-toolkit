import { afterEach, describe, expect, it, vi } from "vitest";
import { f8Rig, eventually, sentContent } from "../../../fixtures/feishu/f8.js";
import { messageEnvelope, OWNER } from "../../../fixtures/feishu/f6.js";
import { decodeFeishuEvent } from "../../../../src/web-hub/hub/feishu/inbound.js";
import { parseFeishuCommand } from "../../../../src/web-hub/hub/feishu/router.js";
import type { CmdFrame } from "../../../../src/web-hub/protocol/messages.js";
import type { ThrReqFrame, ThrResFrame } from "../../../../src/web-hub/protocol/thread.js";
import type { FeishuThreadTransport } from "../../../../src/web-hub/hub/feishu/thread-hub.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});
const THREADS = {
  handbackWindowMin: 10,
  startTimeoutMin: 8,
  retainMin: 15,
  replyPerThreadPerMin: 6,
  replyPerThreadPerHour: 60,
};
const RUN = { runId: "r_23456789", label: "worker" };
const ROUTED_DATA = {
  op: "prompt",
  delivery: "observed",
  behavior: "followUp",
  thread: { outcome: "routed", runs: [RUN] },
};
const TOPIC = { chatType: "group" as const, threadId: "t1", mentions: true };
async function rig(threads = true, stateDir?: string) {
  const r = await f8Rig(stateDir === undefined ? {} : { stateDir }, threads ? { threads: THREADS } : {});
  cleanups.push(() => r.close(stateDir !== undefined ? false : true));
  await r.ready();
  if (threads) r.service.setThreadTransport(transport);
  return r;
}
const sent: Array<{ agentKey: string; frame: unknown }> = [];
const transport: FeishuThreadTransport = {
  getCaps: (agentKey) => (agentKey === "agent-1" ? ["thr.v1"] : undefined),
  send: (agentKey, frame) => {
    sent.push({ agentKey, frame });
    return true;
  },
};
const promptFrames = (r: Awaited<ReturnType<typeof rig>>) =>
  r.request.mock.calls.map(([f]) => f as CmdFrame).filter((f) => f.cmd.op === "prompt" && !f.queryOnly);

describe("thread service wiring (§8.1/§8.2/§6.2/§7.3)", () => {
  it("a routed result retains the payload, receipts text-first then emoji (S1 receipt rule)", async () => {
    const r = await rig();
    await r.bind(TOPIC);
    r.request.mockImplementationOnce(async (frame: CmdFrame) => ({
      t: "cmd_result" as const,
      rid: "",
      id: frame.id,
      ok: true,
      data: ROUTED_DATA as never,
    }));
    r.send(messageEnvelope("t1m1", "first event", TOPIC));
    await eventually(() => expect(promptFrames(r).length).toBe(1));
    const frame = promptFrames(r)[0]!;
    expect(frame.cmd.op === "prompt" && frame.cmd.thread).toMatchObject({ label: expect.any(String) });
    const h = frame.cmd.op === "prompt" ? frame.cmd.thread!.h : "";
    expect(h).toMatch(/^fs:[A-Za-z0-9_-]{12}$/);
    r.consumed(frame.id);
    await eventually(() => expect(sentContent(r)).toContain(`已转交 @worker（run_id: ${RUN.runId}）`));
    expect((await r.disk())["requests"][frame.id]).toMatchObject({ state: "accepted", code: "thr:routed" });
    // Second routed event for the same subscription ⇒ emoji receipt, no second text.
    const before = r.fake.sent.length;
    r.request.mockImplementationOnce(async (f: CmdFrame) => ({
      t: "cmd_result" as const,
      rid: "",
      id: f.id,
      ok: true,
      data: ROUTED_DATA as never,
    }));
    r.send(messageEnvelope("t1m2", "second event", TOPIC));
    await eventually(() => expect(r.fake.callsTo("POST", /reactions$/).length).toBeGreaterThanOrEqual(1));
    const emojiCalls = r.fake
      .callsTo("POST", /reactions$/)
      .filter(
        (c) =>
          (c.json as { reaction_type?: { emoji_type?: string } } | null | undefined)?.["reaction_type"]?.[
            "emoji_type"
          ] === "DONE",
      );
    expect(emojiCalls.length).toBeGreaterThanOrEqual(1);
    const newNotices = r.fake.sent.slice(before).filter((s) => String(s.body["content"]).includes("已转交"));
    expect(newNotices.length).toBe(0); // later events never repeat the text receipt
  });

  it("/main rides a main: synthetic member with bypass; threads-off admits plain text once without thread effects", async () => {
    const on = await rig();
    await on.bind(TOPIC);
    on.send(messageEnvelope("mm1", "/main force the slow path", TOPIC));
    await eventually(() => expect(promptFrames(on).length).toBe(1));
    const frame = promptFrames(on)[0]!;
    expect(frame.cmd.op === "prompt" && frame.cmd.thread?.bypass).toBe(true);
    const record = (await on.disk())["requests"][frame.id];
    expect(record.payload.messageIds).toEqual(["main:mm1"]);
    expect(record.triggerMessageId).toBe("mm1");

    const off = await rig(false);
    expect(off.deps.config.threads).toBeUndefined();
    const threadSend = vi.fn(() => true);
    const threadCaps = vi.fn(() => ["thr.v1"]);
    off.service.setThreadTransport({ getCaps: threadCaps, send: threadSend });
    await off.bind(TOPIC);
    const keysBefore = Object.keys(await off.disk()).sort();
    const text = "  @_user_1  /main force\n  /reload raw  ";
    const expected = "/main force\n  /reload raw";
    const event = messageEnvelope("mm2", text, TOPIC);
    // Existing inbound normalization, independent literal pin: remove @ then trim boundaries,
    // preserving the internal newline, two spaces and /reload text. This is NOT #40's parser.
    const decoded = decodeFeishuEvent(event, "cli_test");
    expect(decoded.kind).toBe("message");
    if (decoded.kind !== "message") throw new Error("group fixture did not decode");
    expect(decoded.message.text).toBe("/main force\n  /reload raw");
    expect(parseFeishuCommand(decoded.message.text, { threads: false })).toEqual({ op: "prompt", text: expected });
    const acks = off.ackCount();
    off.send(event);
    await eventually(() => expect(promptFrames(off)).toHaveLength(1));
    const plain = promptFrames(off)[0]!;
    expect(plain.cmd.op).toBe("prompt");
    if (plain.cmd.op !== "prompt") throw new Error("threads-off must not execute pi commands");
    expect(plain.cmd.text.slice(plain.cmd.text.indexOf("\n") + 1)).toBe(expected);
    expect(plain.cmd.text.slice(plain.cmd.text.indexOf("\n") + 1)).toBe(decoded.message.text);
    expect(plain.cmd).not.toHaveProperty("thread"); // no h/bypass/new thread route
    const offRecord = (await off.disk())["requests"][plain.id];
    expect(offRecord.payload.body).toBe(expected);
    expect(offRecord.payload.messageIds).toEqual(["mm2"]); // not the enabled main: synthetic member
    off.send(event);
    await eventually(() => expect(off.ackCount()).toBe(acks + 2));
    expect(off.request).toHaveBeenCalledTimes(1);
    // Non-slash control uses the same pre-parser normalization, so the trim is not new
    // unknown-slash behavior. Both the decoder and dispatch have independent literal pins.
    const control = messageEnvelope("plain-control", "  @_user_1  ordinary  request\n  /reload raw  ", TOPIC);
    const decodedControl = decodeFeishuEvent(control, "cli_test");
    expect(decodedControl.kind).toBe("message");
    if (decodedControl.kind !== "message") throw new Error("plain control did not decode");
    expect(decodedControl.message.text).toBe("ordinary  request\n  /reload raw");
    const controlAcks = off.ackCount();
    off.send(control);
    off.send(control);
    await eventually(() => expect(off.ackCount()).toBe(controlAcks + 2));
    await eventually(() => expect(off.request).toHaveBeenCalledTimes(2));
    const controlCmd = promptFrames(off)[1]!.cmd;
    expect(controlCmd.op).toBe("prompt");
    if (controlCmd.op !== "prompt") throw new Error("plain control reached command execution");
    expect(controlCmd.text.slice(controlCmd.text.indexOf("\n") + 1)).toBe("ordinary  request\n  /reload raw");
    expect(controlCmd.text.slice(controlCmd.text.indexOf("\n") + 1)).toBe(decodedControl.message.text);
    expect(controlCmd).not.toHaveProperty("thread");
    expect(off.request.mock.calls.every(([f]) => f.cmd.op === "prompt" && !f.queryOnly)).toBe(true);
    expect(sentContent(off)).not.toContain("未知命令");
    expect(sentContent(off)).not.toContain("已转交");
    expect(threadSend).not.toHaveBeenCalled();
    expect(threadCaps).not.toHaveBeenCalled();
    const timer = vi.spyOn(off.clock, "setTimeout");
    const replies: ThrResFrame[] = [];
    off.service.thrReq(
      "agent-1",
      {
        t: "thr_req",
        rid: "off-post",
        op: "post",
        h: "fs:abcdefghijkl",
        sessionId: "session-1",
        by: RUN,
        postId: "r_23456789:1",
        text: "must-not-push",
      },
      (reply) => replies.push(reply),
    );
    await eventually(() =>
      expect(replies).toEqual([{ t: "thr_res", rid: "off-post", ok: false, code: "E_THR_STATE", effect: "none" }]),
    );
    expect(timer).not.toHaveBeenCalled();
    timer.mockRestore();
    expect(threadSend).not.toHaveBeenCalled();
    expect(sentContent(off)).not.toContain("must-not-push");
    expect(Object.keys(await off.disk()).sort()).toEqual(keysBefore);
  });

  it("/cur appends the live subscription lines only when a threads slot was seen", async () => {
    const r = await rig();
    await r.bind(TOPIC);
    r.send(messageEnvelope("q1", "/cur", TOPIC));
    await eventually(() => expect(sentContent(r)).toContain("当前：One"));
    const before = sentContent(r);
    expect(before).not.toContain("话题订阅");
    r.emit({
      type: "status",
      agentKey: "agent-1",
      status: { threads: [{ h: "fs:abcdefghijkl", subs: [RUN] }] } as never,
    });
    r.send(messageEnvelope("q2", "/cur", TOPIC));
    await eventually(() => {
      const tail = sentContent(r).slice(before.length);
      expect(tail).toContain("话题订阅");
      expect(tail).toContain(`fs:abcdefghijkl · @worker（run_id: ${RUN.runId}）`);
    });
    // Threads-off hub: the slot is never read, /cur stays byte-identical.
    const off = await rig(false);
    await off.bind(TOPIC);
    off.emit({
      type: "status",
      agentKey: "agent-1",
      status: { threads: [{ h: "fs:abcdefghijkl", subs: [RUN] }] } as never,
    });
    off.send(messageEnvelope("q3", "/cur", TOPIC));
    await eventually(() => expect(sentContent(off)).toContain("当前：One"));
    expect(sentContent(off)).not.toContain("话题订阅");
  });

  it("unbind finalizes retained requests (thread-closed) and pushes thr_closed{unbound} (§5.4)", async () => {
    sent.length = 0;
    const r = await rig();
    await r.bind(TOPIC);
    r.request.mockImplementationOnce(async (frame: CmdFrame) => ({
      t: "cmd_result" as const,
      rid: "",
      id: frame.id,
      ok: true,
      data: ROUTED_DATA as never,
    }));
    r.send(messageEnvelope("u1", "retained event", TOPIC));
    await eventually(() => expect(promptFrames(r).length).toBe(1));
    const frame = promptFrames(r)[0]!;
    const id = frame.id;
    const h = (frame.cmd as { thread?: { h: string } }).thread!.h;
    await eventually(async () => expect((await r.disk())["requests"][id]?.code).toBe("thr:routed"));
    r.send(messageEnvelope("u2", "/unbind", TOPIC));
    await eventually(async () => expect((await r.disk())["requests"][id]?.code).toBe("thread-closed"));
    expect(sent).toContainEqual({ agentKey: "agent-1", frame: { t: "thr_closed", h, reason: "unbound" } });
  });

  it("deny finalizes retained requests as thread-revoked (§8.2 撤权)", async () => {
    const r = await rig();
    await r.bind(TOPIC);
    r.request.mockImplementationOnce(async (frame: CmdFrame) => ({
      t: "cmd_result" as const,
      rid: "",
      id: frame.id,
      ok: true,
      data: ROUTED_DATA as never,
    }));
    r.send(messageEnvelope("d1", "retained event", TOPIC));
    await eventually(() => expect(promptFrames(r).length).toBe(1));
    const id = promptFrames(r)[0]!.id;
    await eventually(async () => expect((await r.disk())["requests"][id]?.code).toBe("thr:routed"));
    await r.service.admin({ t: "fsb_req", rid: "x", op: "deny", openId: OWNER });
    await eventually(async () => expect((await r.disk())["requests"][id]?.code).toBe("thread-revoked"));
  });

  it("restart re-arms retained records; a threads-off hub (old-hub rollback) unattributes them (§8.4③)", async () => {
    const boot = await f8Rig({}, { threads: THREADS });
    await boot.ready();
    boot.service.setThreadTransport(transport);
    await boot.bind(TOPIC);
    boot.request.mockImplementationOnce(async (frame: CmdFrame) => ({
      t: "cmd_result" as const,
      rid: "",
      id: frame.id,
      ok: true,
      data: ROUTED_DATA as never,
    }));
    boot.send(messageEnvelope("r1", "retained event", TOPIC));
    await eventually(() => expect(promptFrames(boot).length).toBe(1));
    const id = promptFrames(boot)[0]!.id;
    await eventually(async () => expect((await boot.disk())["requests"][id]?.code).toBe("thr:routed"));
    await boot.service.dispose(); // keep stateDir (close(false) pattern of the card-restart tests)

    const stateDir = boot.stateDir;
    cleanups.push(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(stateDir, { recursive: true, force: true });
    });
    const on = await f8Rig({ stateDir }, { threads: THREADS });
    await on.ready();
    on.service.setThreadTransport(transport);
    // Retained: NOT unattributed, no "无法确认归属" notice, no re-dispatch.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await on.disk())["requests"][id]).toMatchObject({ state: "accepted", code: "thr:routed" });
    expect(sentContent(on)).not.toContain("无法确认归属");
    expect(promptFrames(on).length).toBe(0);
    await on.close(false);

    const off = await f8Rig({ stateDir }, {});
    cleanups.push(() => off.close(true));
    await off.ready();
    await eventually(async () => expect((await off.disk())["requests"][id]?.state).toBe("unattributed"));
    await eventually(() => expect(sentContent(off)).toContain("无法确认归属"));
  });

  it("thr_req post: dedup, rate limit, subscription admission and the @label header (§6.8)", async () => {
    const r = await rig();
    await r.bind(TOPIC);
    r.send(messageEnvelope("p0", "anchor event", TOPIC));
    await eventually(() => expect(promptFrames(r).length).toBe(1));
    const h = (promptFrames(r)[0]!.cmd as { thread?: { h: string } }).thread!.h;
    const replies: ThrResFrame[] = [];
    const write = (f: ThrResFrame) => replies.push(f);
    const post = (postId: string, text = "worker reply"): ThrReqFrame => ({
      t: "thr_req",
      rid: `rid-${postId}`,
      op: "post",
      h,
      sessionId: "session-1",
      by: RUN,
      postId,
      text,
    });
    // Fail-open before any status slot was seen (§6.8 admission note).
    r.service.thrReq("agent-1", post("r_23456789:1"), write);
    await eventually(() =>
      expect(replies[0]).toEqual({ t: "thr_res", rid: "rid-r_23456789:1", ok: true, data: { queued: true } }),
    );
    await eventually(() => expect(sentContent(r)).toContain(`· @worker（run_id: ${RUN.runId}）】worker reply`));
    // Same postId ⇒ idempotent ok, no second notice.
    const before = r.fake.sent.length;
    r.service.thrReq("agent-1", post("r_23456789:1"), write);
    await eventually(() => expect(replies[1]).toMatchObject({ ok: true }));
    expect(r.fake.sent.length).toBe(before);
    // 5 more distinct postIds hit the 6/min limit on the 7th call overall.
    for (let i = 2; i <= 6; i++) r.service.thrReq("agent-1", post(`r_23456789:${i}`), write);
    await eventually(() => expect(replies.filter((x) => x.ok).length).toBeGreaterThanOrEqual(6));
    r.service.thrReq("agent-1", post("r_23456789:9"), write);
    await eventually(() =>
      expect(replies.at(-1)).toEqual({
        t: "thr_res",
        rid: "rid-r_23456789:9",
        ok: false,
        code: "E_THR_RATE",
        effect: "none",
      }),
    );
    // After a status slot WITHOUT this run in subs ⇒ E_THR_UNKNOWN (fail-closed once seen).
    r.emit({
      type: "status",
      agentKey: "agent-1",
      status: { threads: [{ h: "fs:otherhandle1", subs: [] }] } as never,
    });
    r.service.thrReq("agent-1", post("r_23456789:8"), write);
    await eventually(() =>
      expect(replies.at(-1)).toEqual({
        t: "thr_res",
        rid: "rid-r_23456789:8",
        ok: false,
        code: "E_THR_UNKNOWN",
        effect: "none",
      }),
    );
    // A wrong session is refused outright (§7.3).
    r.service.thrReq("agent-1", { ...post("r_23456789:7"), sessionId: "session-9" }, write);
    await eventually(() =>
      expect(replies.at(-1)).toEqual({
        t: "thr_res",
        rid: "rid-r_23456789:7",
        ok: false,
        code: "E_THR_STATE",
        effect: "none",
      }),
    );
  });

  it("thr_req handback through the service re-delivers with bypass (S4 happy path)", async () => {
    const r = await rig();
    await r.bind(TOPIC);
    r.request.mockImplementationOnce(async (frame: CmdFrame) => ({
      t: "cmd_result" as const,
      rid: "",
      id: frame.id,
      ok: true,
      data: ROUTED_DATA as never,
    }));
    r.send(messageEnvelope("h1", "hand me back", TOPIC));
    await eventually(() => expect(promptFrames(r).length).toBe(1));
    const id = promptFrames(r)[0]!.id;
    await eventually(async () => expect((await r.disk())["requests"][id]?.code).toBe("thr:routed"));
    const replies: ThrResFrame[] = [];
    r.service.thrReq(
      "agent-1",
      {
        t: "thr_req",
        rid: "hb-1",
        op: "handback",
        eventId: id,
        sessionId: "session-1",
        by: RUN,
        note: "超范围",
      },
      (f) => replies.push(f),
    );
    await eventually(() =>
      expect(replies[0]).toMatchObject({ ok: true, data: { requestId: expect.stringMatching(/^fs/) } }),
    );
    // The successor prompt carries bypass (native path) and the note line above the source body.
    await eventually(() => expect(promptFrames(r).length).toBe(2));
    const successor = promptFrames(r)[1]!;
    expect(successor.cmd.op === "prompt" && successor.cmd.thread?.bypass).toBe(true);
    expect(successor.cmd.op === "prompt" && successor.cmd.text).toMatch(
      /^\[飞书 · [^\n]*\]\n\[thread handback · @worker（run_id: r_23456789） · 原事件 [0-9]{2}:[0-9]{2} · 原因: 超范围\]\nhand me back$/,
    );
    expect((await r.disk())["requests"][id]).toMatchObject({ state: "replied", code: "thread-handback" });
  });

  it("onCmdLate upgrades an uncertain request via the routed branch (§8.1 晚到 cmd_late)", async () => {
    const r = await rig();
    await r.bind(TOPIC);
    // The dispatch times out at the agent (E_DEADLINE/unknown) ⇒ the request lands `uncertain`.
    r.request.mockImplementationOnce(async (frame: CmdFrame) => ({
      t: "cmd_result" as const,
      rid: "",
      id: frame.id,
      ok: false as const,
      code: "E_DEADLINE",
      retryable: true,
      effect: "unknown" as const,
    }));
    r.send(messageEnvelope("l1", "late routed", TOPIC));
    await eventually(() => expect(promptFrames(r).length).toBe(1));
    const id = promptFrames(r)[0]!.id;
    await eventually(async () => expect((await r.disk())["requests"][id]?.state).toBe("uncertain"));
    await new Promise((resolve) => setTimeout(resolve, 150)); // let dispatch() leave the inflight set
    r.service.onCmdLate("agent-1", id, true, ROUTED_DATA);
    await eventually(async () =>
      expect((await r.disk())["requests"][id]).toMatchObject({ state: "accepted", code: "thr:routed" }),
    );
  });
});
