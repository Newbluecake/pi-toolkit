import { describe, expect, it, vi } from "vitest";
import { createListSessionsTool, formatXsSessionRows } from "../../src/tools/list-sessions-tool.js";
import { createMessageSessionTool, XS_UNKNOWN_HINT } from "../../src/tools/message-session-tool.js";
import {
  xsTargetFormallyRejected,
  type XsListOutcome,
  type XsSendOutcome,
  type XsSender,
} from "../../src/fabric/xs/sender.js";
import type { XsSessionRowWire } from "../../src/web-hub/protocol/xs.js";

/**
 * fabric phase-2 X3 anchor (phase2-plan §11.2): the two main-session tools — reserved addresses,
 * omitted wake, the `scope` parameter, result shapes and the S3 unknown hint. The sender core is
 * faked (its own behaviour is pinned by tests/fabric/xs-sender.test.ts).
 */

function fakeSender() {
  const message = vi.fn(async (args: { to: string }): Promise<XsSendOutcome> =>
    // the fake mirrors the sender contract's local pre-check (real behaviour is pinned in xs-sender.test.ts)
    xsTargetFormallyRejected(args.to)
      ? { status: "bad_target", effect: "none", reason: "bad_target" }
      : { status: "sent", effect: "applied" },
  );
  const list = vi.fn(async (): Promise<XsListOutcome> => ({ status: "ok", rows: [] }));
  return { sender: { message, list } as unknown as XsSender, message, list };
}

describe("tools/message_session", () => {
  it("rejects reserved address forms locally — no sender round trip", async () => {
    for (const to of ["root", "system", "main", "r_PARENT01", "@label", "wf_123456"]) {
      const h = fakeSender();
      const tool = createMessageSessionTool({ sender: h.sender });
      const result = await tool.execute("c", { to, text: "hi" });
      expect(result.details).toMatchObject({ status: "bad_target", effect: "none", reason: "bad_target" });
      // "no hub frame leaves" is the sender-core contract (pinned in xs-sender.test.ts); at the tool
      // seam only the surfaced outcome matters.
    }
  });

  it("omitted wake never reaches the sender as true (Q1: omitted = false)", async () => {
    const h = fakeSender();
    const tool = createMessageSessionTool({ sender: h.sender });
    await tool.execute("c", { to: "abcdefgh1234", text: "hi" });
    expect(h.message).toHaveBeenCalledWith({ to: "abcdefgh1234", text: "hi" });
    expect(h.message.mock.calls[0]![0]!.wake).toBeUndefined();
  });

  it("passes an explicit wake through and returns the sender outcome as details + JSON text", async () => {
    const h = fakeSender();
    h.message.mockResolvedValueOnce({
      status: "sent",
      effect: "applied",
      to: { ref: "abcdefgh1234", name: "frontend rework" },
      woke: true,
    });
    const tool = createMessageSessionTool({ sender: h.sender });
    const result = await tool.execute("c", { to: "abcdefgh1234", text: "hi", wake: true });
    expect(h.message).toHaveBeenCalledWith({ to: "abcdefgh1234", text: "hi", wake: true });
    expect(result.details).toEqual({
      status: "sent",
      effect: "applied",
      to: { ref: "abcdefgh1234", name: "frontend rework" },
      woke: true,
    });
    expect(JSON.parse((result.content as { type: "text"; text: string }[])[0]!.text)).toEqual(result.details);
  });

  it("appends the S3 do-not-resend hint exactly on unknown verdicts", async () => {
    const h = fakeSender();
    h.message.mockResolvedValueOnce({ status: "sent", effect: "unknown", reason: "queued" });
    const tool = createMessageSessionTool({ sender: h.sender });
    const unknown = await tool.execute("c", { to: "abcdefgh1234", text: "hi" });
    const unknownText = (unknown.content as { type: "text"; text: string }[])[0]!.text;
    expect(unknownText).toContain(XS_UNKNOWN_HINT);
    expect(unknownText).toContain("不要重发");

    h.message.mockResolvedValueOnce({ status: "sent", effect: "none", reason: "rejected" });
    const none = await tool.execute("c", { to: "abcdefgh1234", text: "hi" });
    expect((none.content as { type: "text"; text: string }[])[0]!.text).not.toContain(XS_UNKNOWN_HINT);
  });

  it("carries wakeDowngraded and candidates verbatim in the result shape (§4.3)", async () => {
    const h = fakeSender();
    h.message.mockResolvedValueOnce({
      status: "sent",
      effect: "applied",
      wakeDowngraded: "busy",
      to: { ref: "abcdefgh1234" },
    });
    const tool = createMessageSessionTool({ sender: h.sender });
    const out = await tool.execute("c", { to: "abcdefgh1234", text: "hi", wake: true });
    expect(out.details).toMatchObject({ effect: "applied", wakeDowngraded: "busy", to: { ref: "abcdefgh1234" } });

    h.message.mockResolvedValueOnce({
      status: "ambiguous",
      effect: "none",
      candidates: [{ ref: "aaaaaaaaaaaa" }, { ref: "bbbbbbbbbbbb", name: "n" }],
    });
    const amb = await tool.execute("c", { to: "dup", text: "hi" });
    expect(amb.details).toMatchObject({ status: "ambiguous", effect: "none" });
    expect((amb.details as { candidates?: unknown[] }).candidates).toHaveLength(2);
  });
});

describe("tools/list_sessions", () => {
  const row = (over: Partial<XsSessionRowWire> = {}): XsSessionRowWire => ({
    ref: "abcdefgh1234",
    name: "frontend rework",
    cwdLabel: "~/ai/pi-toolkit",
    kind: "main",
    receive: "wake",
    busy: false,
    lastActiveAgoS: 42,
    ...over,
  });

  it("passes query and scope through to the sender", async () => {
    const h = fakeSender();
    h.list.mockResolvedValueOnce({ status: "ok", rows: [row()] });
    const tool = createListSessionsTool({ sender: h.sender });
    await tool.execute("c", { query: "front", scope: "cwd" });
    expect(h.list).toHaveBeenCalledWith({ query: "front", scope: "cwd" });
    await tool.execute("c", {});
    expect(h.list).toHaveBeenLastCalledWith({});
  });

  it("renders rows with compact English tokens and reports empty listings", async () => {
    const h = fakeSender();
    h.list.mockResolvedValueOnce({
      status: "ok",
      rows: [row(), row({ name: undefined, busy: true, receive: "deliver" })],
    });
    const tool = createListSessionsTool({ sender: h.sender });
    const result = await tool.execute("c", {});
    const text = (result.content as { type: "text"; text: string }[])[0]!.text;
    expect(text).toContain("abcdefgh1234");
    expect(text).toContain('name="frontend rework"');
    expect(text).toContain("receive=wake");
    expect(text).toContain("idle");
    expect(text).toContain("lastActive=42s ago");
    expect(text).toContain("busy");
    expect(result.details).toMatchObject({ status: "ok" });

    h.list.mockResolvedValueOnce({ status: "ok", rows: [] });
    const empty = await tool.execute("c", {});
    expect((empty.content as { type: "text"; text: string }[])[0]!.text).toContain("No other joined sessions");
  });

  it("maps non-ok statuses to a single unavailable line with the code", async () => {
    const h = fakeSender();
    h.list.mockResolvedValueOnce({ status: "off", code: "E_XS_OFF" });
    const tool = createListSessionsTool({ sender: h.sender });
    const result = await tool.execute("c", {});
    const text = (result.content as { type: "text"; text: string }[])[0]!.text;
    expect(text).toContain("list_sessions unavailable: off (E_XS_OFF)");
    expect(result.details).toMatchObject({ status: "off", code: "E_XS_OFF" });
  });

  it("formatXsSessionRows stays token-only (UI-language split)", () => {
    const [line] = formatXsSessionRows([row()]);
    expect(line).toBe(
      '- abcdefgh1234 · name="frontend rework" · cwd=~/ai/pi-toolkit · kind=main · receive=wake · idle · lastActive=42s ago',
    );
  });
});

// ====================================================================== reply-plan §4.1/§4.2 (RX4)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  messageSessionParamsFor,
  MessageSessionParamsLegacy,
  MessageSessionParamsReply,
  XS_REPLY_TO_REJECTED_HINT,
  XS_REPLY_TO_UNKNOWN_HINT,
} from "../../src/tools/message-session-tool.js";

describe("tools/message_session — reply instances (RX4)", () => {
  const golden = JSON.parse(
    readFileSync(join(__dirname, "..", "fixtures", "fabric-xs-reply-off-golden.json"), "utf8"),
  ) as { tools: { message_session: { description: string; parameters: unknown } } };

  it("instance selection: reply off ⇒ the legacy instance, reply on ⇒ the reply instance", () => {
    expect(messageSessionParamsFor(false)).toBe(MessageSessionParamsLegacy);
    expect(messageSessionParamsFor(true)).toBe(MessageSessionParamsReply);
    const off = createMessageSessionTool({ sender: fakeSender().sender });
    const off2 = createMessageSessionTool({ sender: fakeSender().sender, reply: false });
    const on = createMessageSessionTool({ sender: fakeSender().sender, reply: true });
    expect(off.parameters).toBe(MessageSessionParamsLegacy);
    expect(off2.parameters).toBe(MessageSessionParamsLegacy);
    expect(on.parameters).toBe(MessageSessionParamsReply);
  });

  it("reply OFF: description + schema equal the checked-in reply-off golden byte for byte", () => {
    const tool = createMessageSessionTool({ sender: fakeSender().sender });
    expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual(golden.tools.message_session.parameters);
    expect(tool.description).toBe(golden.tools.message_session.description);
    expect(Object.keys((tool.parameters as { properties: object }).properties)).toEqual(["to", "text", "wake"]);
  });

  it("reply ON: the schema is the legacy properties plus exactly expectReply/replyTo", () => {
    const on = createMessageSessionTool({ sender: fakeSender().sender, reply: true });
    const props = (on.parameters as unknown as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(["to", "text", "wake", "expectReply", "replyTo"]);
    const legacyProps = (golden.tools.message_session.parameters as { properties: Record<string, unknown> }).properties;
    for (const k of Object.keys(legacyProps)) expect(JSON.parse(JSON.stringify(props[k]))).toEqual(legacyProps[k]);
    const replyTo = JSON.parse(JSON.stringify(props.replyTo)) as { pattern: string };
    expect(replyTo.pattern).toBe("^q[0-9a-f]{18}$");
    const expectReply = JSON.parse(JSON.stringify(props.expectReply)) as {
      additionalProperties: boolean;
      properties: { timeoutS: { minimum: number; maximum: number } };
    };
    expect(expectReply.additionalProperties).toBe(false);
    expect(expectReply.properties.timeoutS).toMatchObject({ minimum: 60, maximum: 86_400 });
    expect(on.description).not.toBe(golden.tools.message_session.description);
  });

  it("reply ON forwards expectReply / replyTo to the sender; reply OFF never does", async () => {
    const q = "q" + "0".repeat(18);
    const on = fakeSender();
    await createMessageSessionTool({ sender: on.sender, reply: true }).execute("c", {
      to: "abcdefgh1234",
      text: "t",
      expectReply: { timeoutS: 90 },
    });
    expect(on.message).toHaveBeenCalledWith({ to: "abcdefgh1234", text: "t", expectReply: { timeoutS: 90 } });
    const on2 = fakeSender();
    await createMessageSessionTool({ sender: on2.sender, reply: true }).execute("c", {
      to: "abcdefgh1234",
      text: "t",
      replyTo: q,
    });
    expect(on2.message).toHaveBeenCalledWith({ to: "abcdefgh1234", text: "t", replyTo: q });
    const off = fakeSender();
    await createMessageSessionTool({ sender: off.sender }).execute("c", {
      to: "abcdefgh1234",
      text: "t",
      expectReply: {},
      replyTo: q,
    } as never);
    expect(off.message).toHaveBeenCalledWith({ to: "abcdefgh1234", text: "t" });
  });

  it("expectReply success text names the request id and due time; the outcome carries reply{requestId,dueAt,state}", async () => {
    const h = fakeSender();
    h.message.mockResolvedValueOnce({
      status: "sent",
      effect: "applied",
      reply: { requestId: "q" + "1".repeat(18), dueAt: "2026-10-22T09:00:00.000Z", state: "pending" },
    });
    const r = await createMessageSessionTool({ sender: h.sender, reply: true }).execute("c", {
      to: "abcdefgh1234",
      text: "t",
      expectReply: {},
    });
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("已登记期待回复 q" + "1".repeat(18));
    expect(text).toContain("2026-10-22T09:00:00.000Z");
    expect(text).toContain("无需轮询");
    expect(r.details).toMatchObject({ reply: { state: "pending" } });
  });

  it("replyTo unknown ⇒ the idempotent-resend hint (not the legacy 'do not resend' one)", async () => {
    const h = fakeSender();
    h.message.mockResolvedValueOnce({
      status: "unanswered",
      effect: "unknown",
      reason: "client_deadline",
      replyTo: { requestId: "q" + "2".repeat(18), accepted: false },
    });
    const r = await createMessageSessionTool({ sender: h.sender, reply: true }).execute("c", {
      to: "abcdefgh1234",
      text: "t",
      replyTo: "q" + "2".repeat(18),
    });
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain(XS_REPLY_TO_UNKNOWN_HINT);
    expect(text).not.toContain(XS_UNKNOWN_HINT);
  });

  it("replyTo none{rejected} ⇒ the 'do not resend' rejected hint", async () => {
    const h = fakeSender();
    h.message.mockResolvedValueOnce({
      status: "sent",
      effect: "none",
      reason: "rejected",
      replyTo: { requestId: "q" + "3".repeat(18), accepted: false },
    });
    const r = await createMessageSessionTool({ sender: h.sender, reply: true }).execute("c", {
      to: "abcdefgh1234",
      text: "t",
      replyTo: "q" + "3".repeat(18),
    });
    expect((r.content[0] as { text: string }).text).toContain(XS_REPLY_TO_REJECTED_HINT);
  });

  it("a plain unknown send keeps the legacy hint on the reply instance too", async () => {
    const h = fakeSender();
    h.message.mockResolvedValueOnce({ status: "unanswered", effect: "unknown", reason: "link_lost" });
    const r = await createMessageSessionTool({ sender: h.sender, reply: true }).execute("c", {
      to: "abcdefgh1234",
      text: "t",
    });
    expect((r.content[0] as { text: string }).text).toContain(XS_UNKNOWN_HINT);
  });
});
