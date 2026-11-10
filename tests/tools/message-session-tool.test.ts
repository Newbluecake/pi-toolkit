import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createListSessionsTool, formatXsSessionRows } from "../../src/tools/list-sessions-tool.js";
import {
  createMessageSessionTool,
  XS_UNKNOWN_HINT,
  type MessageSessionParams,
} from "../../src/tools/message-session-tool.js";
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

const testToolContext = {} as ExtensionToolContext;

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

  it.each([
    { status: "bad_target", effect: "none", reason: "bad_target" },
    { status: "no_target", effect: "none" },
    { status: "ambiguous", effect: "none", candidates: [{ ref: "aaaaaaaaaaaa" }] },
  ] satisfies XsSendOutcome[])("guides target discovery for $status", async (outcome) => {
    const h = fakeSender();
    h.message.mockResolvedValueOnce(outcome);
    const tool = createMessageSessionTool({ sender: h.sender });
    const result = await tool.execute("c", { to: "peer", text: "hi" });
    expect(result.details).toEqual(outcome);
    expect((result.content[0] as { text: string }).text).toBe(
      JSON.stringify(outcome) +
        "\n`to` 只接受 `list_sessions` 给出的 ref、完整 session id 或精确会话名；先用 `list_sessions` 确认目标再发送。",
    );
  });

  it.each([
    { status: "sent", effect: "applied" },
    { status: "unanswered", effect: "unknown", reason: "client_deadline" },
  ] satisfies XsSendOutcome[])("preserves text for other outcomes: $status/$effect", async (outcome) => {
    const h = fakeSender();
    h.message.mockResolvedValueOnce(outcome);
    const result = await createMessageSessionTool({ sender: h.sender }).execute("c", { to: "peer", text: "hi" });
    expect((result.content[0] as { text: string }).text).toBe(
      JSON.stringify(outcome) + (outcome.effect === "unknown" ? `\n${XS_UNKNOWN_HINT}` : ""),
    );
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

describe("message_session bad argument guidance and retry guard", () => {
  const args = { to: "peer", text: "hello", expectReply: {}, replyTo: "q" + "0".repeat(18) };
  const bad: XsSendOutcome = { status: "bad_args", effect: "none", reason: "expect_and_reply_to" };
  const text = (result: { content: readonly unknown[] }) => (result.content[0] as { text: string }).text;

  it("does not expose reply correction on a reply-off instance", async () => {
    const h = fakeSender();
    h.message.mockResolvedValue(bad);
    const tool = createMessageSessionTool({ sender: h.sender });
    expect(text(await tool.execute("1", args))).toBe(JSON.stringify(bad));
    expect(h.message).toHaveBeenCalledWith({ to: "peer", text: "hello" });
  });

  it("explains mutual exclusion, warns on repeated failures and caps the count", async () => {
    const h = fakeSender();
    h.message.mockResolvedValue(bad);
    const tool = createMessageSessionTool({ sender: h.sender, reply: true });
    const first = text(await tool.execute("1", args));
    expect(first).toContain("发起请求请使用 expectReply 且不要带 replyTo");
    expect(first).toContain("值必须来自请求头，不要编造");
    expect(first).toContain("两条路径互斥");
    expect(first).not.toContain("连续失败");
    expect(text(await tool.execute("2", args))).toContain(
      "相同参数已连续失败 2 次，请修改参数或停止重试。若目标是会话名，先用 list_sessions 确认 ref。",
    );
    expect(text(await tool.execute("3", args))).toContain("连续失败 3 次");
    for (let i = 0; i < 6; i++) await tool.execute("x", args);
    expect(text(await tool.execute("x", args))).toContain("连续失败 5 次");
    const fresh = createMessageSessionTool({ sender: h.sender, reply: true });
    expect(text(await fresh.execute("x", args))).not.toContain("连续失败");
  });

  it("ignores late failures from an earlier argument group", async () => {
    const h = fakeSender();
    let finish!: (outcome: XsSendOutcome) => void;
    h.message.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.message.mockResolvedValue(bad);
    const tool = createMessageSessionTool({ sender: h.sender, reply: true });
    const pending = tool.execute("1", args);
    const changed = { ...args, text: "changed" };
    await tool.execute("2", changed);
    finish(bad);
    expect(text(await pending)).not.toContain("连续失败");
    expect(text(await tool.execute("3", changed))).toContain("连续失败 2 次");
  });

  it("resets on argument changes, successful sends and non-validation errors", async () => {
    const h = fakeSender();
    h.message.mockResolvedValue(bad);
    const tool = createMessageSessionTool({ sender: h.sender, reply: true });
    await tool.execute("1", args);
    await tool.execute("2", args);
    const changed = { ...args, text: "changed" };
    expect(text(await tool.execute("3", changed))).not.toContain("连续失败");
    expect(text(await tool.execute("4", changed))).toContain("连续失败 2 次");
    h.message.mockResolvedValueOnce({ status: "sent", effect: "applied" });
    await tool.execute("5", changed);
    expect(text(await tool.execute("6", changed))).not.toContain("连续失败");
    h.message.mockResolvedValueOnce({ status: "unanswered", effect: "unknown", reason: "client_deadline" });
    expect(text(await tool.execute("7", changed))).not.toContain("连续失败");
    expect(text(await tool.execute("8", changed))).not.toContain("连续失败");
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

  it("explains bad channel without changing valid or omitted filters", async () => {
    const h = fakeSender();
    h.list.mockResolvedValueOnce({ status: "bad_channel", reason: "bad_channel" });
    const tool = createListSessionsTool({ sender: h.sender, channels: true });
    const invalid = await tool.execute("c", { channel: "" });
    expect((invalid.content[0] as { text: string }).text).toContain(
      "channel 为空字符串不等于省略；不需要过滤请省略该参数",
    );
    expect(h.list).toHaveBeenLastCalledWith({ channel: "" });
    h.list.mockResolvedValueOnce({ status: "bad_channel", reason: "bad_channel" });
    const whitespace = await tool.execute("c", { channel: "  " });
    expect((whitespace.content[0] as { text: string }).text).toContain("channel 为空字符串不等于省略");
    h.list.mockResolvedValueOnce({ status: "bad_channel", reason: "bad_channel" });
    const other = await tool.execute("c", { channel: "other" });
    expect((other.content[0] as { text: string }).text).toContain(
      "channel 无效或不在本链路；核对频道名，不需要过滤请省略该参数",
    );
    expect(h.list).toHaveBeenLastCalledWith({ channel: "other" });
    await tool.execute("c", { channel: "#team" });
    expect(h.list).toHaveBeenLastCalledWith({ channel: "#team" });
    await tool.execute("c", {});
    expect(h.list).toHaveBeenLastCalledWith({});
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

// #20 r3: predicate truth table is intentionally separate from tool wiring/rendering.
import { XS_IDLE_NO_WAKE_HINT, xsIdleNoWakeRisk } from "../../src/tools/message-session-tool.js";

function idleRiskBase(): XsSendOutcome {
  return {
    status: "sent",
    effect: "applied",
    to: { ref: "abcdefgh1234" },
    reply: { requestId: "q111111111111111111", dueAt: "2026-11-05T04:00:00.000Z", state: "pending" },
    wake: { requested: false, decision: "deliver_only" },
    track: { messageId: "x-original", activationKey: "k-original" },
    progress: {
      messageId: "x-original",
      revision: 1,
      observation: "live",
      phase: "delivered",
      wake: { requested: false, decision: "deliver_only" },
    },
  };
}
const predicateNegatives: Array<[string, (o: XsSendOutcome) => void]> = [
  [
    "C1 unanswered (only status flipped)",
    (o) => {
      o.status = "unanswered";
    },
  ],
  [
    "C1 defensive bad_args (non-sent)",
    (o) => {
      o.status = "bad_args";
    },
  ],
  [
    "C2 unknown",
    (o) => {
      o.effect = "unknown";
    },
  ],
  [
    "C3 missing reply",
    (o) => {
      delete o.reply;
    },
  ],
  [
    "C4 replyTo present",
    (o) => {
      o.replyTo = { requestId: "q222222222222222222", accepted: true };
    },
  ],
  [
    "C5/C6 missing wake",
    (o) => {
      delete o.wake;
    },
  ],
  [
    "C6 wake exists, requested true (trusted human default)",
    (o) => {
      o.wake = { requested: true, defaulted: true, decision: "dispatch_accepted" };
    },
  ],
  [
    "C7 existing wakeDowngraded",
    (o) => {
      o.wakeDowngraded = "pair_wake_rate";
    },
  ],
  [
    "C8 woke true",
    (o) => {
      o.woke = true;
    },
  ],
  [
    "C9/C10 missing track",
    (o) => {
      delete o.track;
    },
  ],
  [
    "C10 track exists, missing activationKey",
    (o) => {
      delete o.track!.activationKey;
    },
  ],
  [
    "C11 started",
    (o) => {
      o.progress!.phase = "started";
    },
  ],
  [
    "C11 replied",
    (o) => {
      o.progress!.phase = "replied";
    },
  ],
  [
    "D-q applied+queued contradiction",
    (o) => {
      o.progress!.phase = "queued";
    },
  ],
];

describe("xsIdleNoWakeRisk — pure C1–C11 / D-q", () => {
  it("baseline is positive; absent phase/progress and woke:false remain positive", () => {
    const o = idleRiskBase();
    expect(xsIdleNoWakeRisk(o)).toBe(true);
    delete o.progress!.phase;
    expect(xsIdleNoWakeRisk(o)).toBe(true);
    delete o.progress;
    o.woke = false;
    expect(xsIdleNoWakeRisk(o)).toBe(true);
  });
  it.each(predicateNegatives)("%s", (_name, mutate) => {
    const o = idleRiskBase();
    mutate(o);
    expect(xsIdleNoWakeRisk(o)).toBe(false);
  });
  it.each([
    [1, {}, true],
    [2, {}, true],
    [3, { wake: { requested: true, defaulted: true, decision: "dispatch_accepted" } }, false],
    [
      4,
      { wake: { requested: true, defaulted: true, decision: "downgraded" }, wakeDowngraded: "pair_wake_rate" },
      false,
    ],
    [5, { wake: { requested: true, decision: "dispatch_accepted" }, woke: true }, false],
    [6, { wake: { requested: true, decision: "downgraded" }, wakeDowngraded: "level_limit" }, false],
    [7, { effect: "unknown", reason: "queued" }, false],
    [8, { effect: "unknown", reason: "accept_unverified" }, false],
    [9, { effect: "none", reply: { requestId: "q111111111111111111", dueAt: "d", state: "send_failed" } }, false],
    [10, { track: { messageId: "x-original" } }, false],
    [11, { reply: undefined }, false],
    [12, { replyTo: { requestId: "q222222222222222222", accepted: true } }, false],
    // rows 13/15 are gate/non-tool cases: their qualifying outcome still satisfies the pure predicate.
    [13, {}, true],
    [14, { progress: { ...idleRiskBase().progress!, phase: "started" } }, false],
    [15, {}, true],
  ] as const)("plan §2 row %s (gate/mention outside predicate)", (_row, over, risk) => {
    expect(xsIdleNoWakeRisk({ ...idleRiskBase(), ...over } as XsSendOutcome)).toBe(risk);
  });
});

/** Frozen pre-#20 rendering copy: no calls to production hint functions. */
function renderPre20(o: XsSendOutcome, reply = true, alias = true, activation = true): string {
  let hint = "";
  if (reply) {
    if (o.reply?.state === "pending")
      hint += `\n已登记期待回复 ${o.reply.requestId}，截止 ${o.reply.dueAt}；回复到达或超时都会通知你，无需轮询（pi 重启会使未决请求失效）。`;
    if (o.replyTo !== undefined) {
      if (o.effect === "unknown")
        hint +=
          "\n可能已送达。对方凭证一次性：重发同一回复不会造成重复投递，但可能被拒收（拒收说明对方已收到、已超过宽限期，或对方 pi 已重启使凭证失效）。";
      else if (o.effect === "none" && o.reason === "rejected")
        hint += "\n对方未接收（已收到过回复、凭证过期或失效、或对方策略拒收）；不要再重发。";
    } else if (o.effect === "unknown")
      hint += "\n注意：这条消息可能已进入对方队列，通常在对方下一个 turn 边界可见；不要重发。";
  } else if (o.effect === "unknown")
    hint = "\n注意：这条消息可能已进入对方队列，通常在对方下一个 turn 边界可见；不要重发。";
  if (alias && o.status === "alias_unavailable") hint += "\nhub 别名服务暂不可用，请用 list_sessions 给出的 ref";
  if (activation && o.wakeDowngraded) {
    const quota = o.wakeDowngraded === "pair_wake_rate" ? "（hub，每会话对默认 2 次/小时）" : "";
    hint += `\n唤醒因 ${o.wakeDowngraded} 降级${quota}；${o.effect === "none" ? "正文未送达" : o.effect === "applied" ? "正文投递已确认，非 started 证明" : "正文可能已进入队列"}，不要重发。仅已确认送达且未开始的有效原 receipt 可人工 activate；配额降级须等待配额，unknown 只查询。`;
  }
  return JSON.stringify(o) + hint;
}

describe("message_session #20 — final content / frozen gate (fake sender)", () => {
  async function execute(o: XsSendOutcome, idleWakeAdvice?: boolean) {
    const h = fakeSender();
    h.message.mockResolvedValueOnce(o);
    const tool = createMessageSessionTool({
      sender: h.sender,
      reply: true,
      alias: true,
      activation: true,
      ...(idleWakeAdvice === undefined ? {} : { idleWakeAdvice }),
    });
    return tool.execute("c", { to: "abcdefgh1234", text: "t", expectReply: {}, wake: false });
  }
  it("D4 verbatim; appends ONLY after all prior hints; outcome/details bytes unchanged", async () => {
    expect(XS_IDLE_NO_WAKE_HINT).toBe(
      '注意：本次 expectReply 未请求唤醒，且投递时（接收端采样）对方会话空闲——这次写入不会触发对方处理，大概率等到超时也收不到回复。正文已送达，不要重发；需要对方处理请调用 wake_session（action "activate"，to 用本结果 to.ref，messageId/activationKey 取本结果 track）激活这条请求。只有正文未送达（effect none）时才改用 wake:true 重发。',
    );
    const o = idleRiskBase(),
      bytes = JSON.stringify(o);
    const result = await execute(o, true);
    expect(result.content).toEqual([{ type: "text", text: renderPre20(o) + "\n" + XS_IDLE_NO_WAKE_HINT }]);
    expect(result.details).toBe(o);
    expect(JSON.stringify(result.details)).toBe(bytes);
    expect(JSON.stringify(o)).toBe(bytes);
  });
  it.each([undefined, false])("gate %s ⇒ byte-identical pre20 even for positive outcome", async (gate) => {
    const o = idleRiskBase();
    expect((await execute(o, gate)).content).toEqual([{ type: "text", text: renderPre20(o) }]);
  });
  it.each(predicateNegatives)("gate on, negative %s ⇒ byte-identical pre20", async (_name, mutate) => {
    const o = idleRiskBase();
    mutate(o);
    expect((await execute(o, true)).content).toEqual([{ type: "text", text: renderPre20(o) }]);
  });
  it("only idleWakeAdvice gates the append (no redundant activation/reply gate)", async () => {
    const o = idleRiskBase(),
      h = fakeSender();
    h.message.mockResolvedValueOnce(o);
    const result = await createMessageSessionTool({ sender: h.sender, idleWakeAdvice: true }).execute("c", {
      to: "abcdefgh1234",
      text: "t",
    });
    expect(result.content).toEqual([
      { type: "text", text: renderPre20(o, false, false, false) + "\n" + XS_IDLE_NO_WAKE_HINT },
    ]);
  });
});

// #84 D2 — use the shipped sender and ledger, never a real hub/network.
import { createXsSender, type XsSenderDeps, type XsPortReply, type XsHubPort } from "../../src/fabric/xs/sender.js";
import { XsReplyLedger } from "../../src/fabric/xs/reply-ledger.js";
import type { XsResFrame } from "../../src/web-hub/protocol/xs.js";

const xsRes = (res: Partial<XsResFrame> & { ok: boolean }): XsPortReply => ({
  kind: "res",
  res: { t: "xs_res", rid: "test", ...res },
});
function boundarySender(over: Partial<XsSenderDeps> = {}) {
  const port = {
    list: vi.fn(async () => xsRes({ ok: true, rows: [] })),
    resolve: vi.fn(async () => xsRes({ ok: true, target: { ref: "target123456", sessionId: "session-target" } })),
    send: vi.fn(async () => xsRes({ ok: true, effect: "applied" })),
    replyCapable: () => true,
  } satisfies XsHubPort;
  const sender = createXsSender({
    port,
    origin: { current: () => ({ sessionId: "session-source", epoch: 1 }) },
    ...over,
  });
  return { port, sender, tool: createMessageSessionTool({ sender, reply: true, alias: true }) };
}
const boundaryText = (r: { content: unknown }) => (r.content as { text: string }[])[0]!.text;
const boundaryArgs = { to: "target123456", text: "body-never-real-sent" };

function replyDeps(ledger = new XsReplyLedger()): NonNullable<XsSenderDeps["reply"]> {
  return {
    ledger,
    defaultTimeoutS: 60,
    maxTimeoutS: 3600,
    lateGraceS: 60,
    maxPending: 2,
    maxPendingPerTarget: 1,
    receivable: () => "ok",
    inbound: () => undefined,
  };
}

describe("message_session boundary guidance through real sender (#84 D2)", () => {
  it.each([
    ["E_XS_NO_TARGET", "no_target", "list_sessions"],
    ["E_XS_AMBIGUOUS", "ambiguous", "list_sessions"],
    ["E_XS_STALE_ORIGIN", "stale_origin", "重新确认发送意图"],
    ["E_XS_OFF", "off", "/fabric status"],
    ["E_XS_TOO_LARGE", "too_large", "缩短正文"],
    ["E_XS_BAD_FRAME", "bad_frame", "核对工具参数"],
    ["E_XS_REPLY_UNSUPPORTED", "reply_unsupported", "不要编造 replyTo"],
    ["E_XS_ALIAS_UNAVAILABLE", "alias_unavailable", "list_sessions 给出的 ref"],
  ])("resolve refusal %s preserves code/effect and sends nothing", async (code, status, hint) => {
    const h = boundarySender();
    h.port.resolve.mockResolvedValueOnce(xsRes({ ok: false, code }));
    const result = await h.tool.execute("c", boundaryArgs, undefined, undefined, testToolContext);
    expect(result.details).toEqual({ status, effect: "none", code });
    expect(boundaryText(result)).toContain(hint);
    expect(h.port.resolve).toHaveBeenCalledTimes(1);
    expect(h.port.send).not.toHaveBeenCalled();
    expect(h.port.list).not.toHaveBeenCalled();
  });

  it.each([
    ["rejected", "接收方策略拒收"],
    ["inbox_full", "接收容量受限"],
    ["dedup_full", "接收容量受限"],
    ["fenced:compaction", "操作边界保护"],
    ["fenced:switch", "操作边界保护"],
    ["fenced:tree", "操作边界保护"],
    ["fenced:web_exec", "操作边界保护"],
    ["fenced:topic_switch", "操作边界保护"],
    ["session_changed", "目标会话已变化"],
    ["expired", "投递已过期"],
    ["host_rejected", "接收端未完成投递"],
    ["receiver_error", "接收端未完成投递"],
    ["rate_in_flight", "没有权威 retryAfter"],
    ["rate_sends_min", "没有权威 retryAfter"],
    ["rate_sends_hour", "没有权威 retryAfter"],
    ["rate_hub", "没有权威 retryAfter"],
    ["rate_pair_interval", "没有权威 retryAfter"],
    ["inbound_rate", "没有权威 retryAfter"],
  ])("none/%s adds safe advice without a second body or invented retry time", async (reason, advice) => {
    const h = boundarySender();
    h.port.send.mockResolvedValueOnce(xsRes({ ok: true, effect: "none", reason }));
    const result = await h.tool.execute("c", boundaryArgs, undefined, undefined, testToolContext);
    expect(result.details).toMatchObject({ status: "sent", effect: "none", reason });
    expect(boundaryText(result)).toContain(advice);
    expect(boundaryText(result)).not.toMatch(/\d+\s*(秒|分钟|小时).*重试/);
    expect(h.port.send).toHaveBeenCalledTimes(1);
    expect(h.port.send.mock.calls[0]).toEqual([
      { origin: { sessionId: "session-source", epoch: 1 }, to: boundaryArgs.to, text: boundaryArgs.text },
    ]);
    expect(h.port.resolve).toHaveBeenCalledTimes(1);
    expect(h.port.list).not.toHaveBeenCalled();
  });

  it.each(["deadline", "link_lost", "off"] as const)(
    "pre-send %s does not become a delivery claim or retry loop",
    async (kind) => {
      const h = boundarySender();
      h.port.resolve.mockResolvedValueOnce({ kind });
      const result = await h.tool.execute("c", boundaryArgs, undefined, undefined, testToolContext);
      expect(result.details).toMatchObject({ effect: "none", status: kind === "off" ? "off" : "error" });
      expect(boundaryText(result)).toContain("本次正文未送达");
      expect(h.port.send).not.toHaveBeenCalled();
      expect(h.port.resolve).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["deadline", "link_lost"] as const)(
    "post-send %s remains unknown with unchanged do-not-resend bytes",
    async (kind) => {
      const h = boundarySender();
      h.port.send.mockResolvedValueOnce({ kind });
      const result = await h.tool.execute("c", boundaryArgs, undefined, undefined, testToolContext);
      expect(result.details).toEqual({
        status: "unanswered",
        effect: "unknown",
        reason: kind === "deadline" ? "client_deadline" : "link_lost",
      });
      expect(boundaryText(result)).toBe(JSON.stringify(result.details) + "\n" + XS_UNKNOWN_HINT);
      expect(h.port.send).toHaveBeenCalledTimes(1);
    },
  );

  it("unknown remote error retains code/reason/effect without guessing a cause or resending", async () => {
    const h = boundarySender();
    h.port.send.mockResolvedValueOnce(xsRes({ ok: false, code: "E_XS_INTERNAL", reason: "unverified" }));
    const result = await h.tool.execute("c", boundaryArgs, undefined, undefined, testToolContext);
    expect(result.details).toMatchObject({
      status: "error",
      code: "E_XS_INTERNAL",
      reason: "unverified",
      effect: "unknown",
    });
    expect(boundaryText(result)).toBe(JSON.stringify(result.details) + "\n" + XS_UNKNOWN_HINT);
    expect(h.port.send).toHaveBeenCalledTimes(1);
  });

  it("plain applied success remains JSON-only and sends exactly once", async () => {
    const h = boundarySender();
    const result = await h.tool.execute("c", boundaryArgs, undefined, undefined, testToolContext);
    expect(boundaryText(result)).toBe(JSON.stringify(result.details));
    expect(result.details).toEqual({ status: "sent", effect: "applied", to: { ref: "target123456" } });
    expect(h.port.send).toHaveBeenCalledTimes(1);
  });

  it.each(["receive_off", "blocked", "not_joined"] as const)(
    "unreceivable/%s never issues a credential or sends",
    async (unreceivable) => {
      const reply = replyDeps();
      reply.receivable = () => unreceivable;
      const h = boundarySender({ reply });
      const result = await h.tool.execute(
        "c",
        { ...boundaryArgs, expectReply: {} } as MessageSessionParams,
        undefined,
        undefined,
        testToolContext,
      );
      expect(result.details).toEqual({
        status: "reply_unreceivable",
        effect: "none",
        reason: "reply_unreceivable",
        unreceivable,
      });
      expect(boundaryText(result)).toContain("不要自行 join、改 policy 或去掉 expectReply 绕过");
      expect(reply.ledger).toHaveProperty("size", 0);
      expect(h.port.send).not.toHaveBeenCalled();
    },
  );

  it.each(["reply_quota", "reply_ledger_full"] as const)(
    "%s uses real pending ledger capacity, without new issues/refunds/retries",
    async (status) => {
      const ledger = new XsReplyLedger({ capacity: status === "reply_ledger_full" ? 1 : 64 });
      const reply = replyDeps(ledger);
      if (status === "reply_ledger_full") reply.maxPendingPerTarget = 2;
      const h = boundarySender({ reply });
      const first = await h.tool.execute(
        "c",
        { ...boundaryArgs, expectReply: {} } as MessageSessionParams,
        undefined,
        undefined,
        testToolContext,
      );
      expect(first.details).toMatchObject({ effect: "applied", reply: { state: "pending" } });
      const recordSend = vi.spyOn(ledger, "recordSend");
      const result = await h.tool.execute(
        "c2",
        { ...boundaryArgs, expectReply: {} } as MessageSessionParams,
        undefined,
        undefined,
        testToolContext,
      );
      expect(result.details).toMatchObject({ status, effect: "none" });
      expect(boundaryText(result)).toContain("不要换目标、去掉 expectReply 或重启来绕过");
      expect(ledger.size).toBe(1);
      expect(recordSend).not.toHaveBeenCalled();
      expect(h.port.send).toHaveBeenCalledTimes(1);
    },
  );

  it("replyTo mismatch stays none and does not suggest dropping the one-use credential", async () => {
    const reply = replyDeps();
    reply.inbound = () => ({ fromSessionId: "different-session" });
    const h = boundarySender({ reply });
    const result = await h.tool.execute(
      "c",
      { ...boundaryArgs, replyTo: "q111111111111111111" } as MessageSessionParams,
      undefined,
      undefined,
      testToolContext,
    );
    expect(result.details).toEqual({
      status: "reply_target_mismatch",
      effect: "none",
      reason: "reply_target_mismatch",
    });
    expect(boundaryText(result)).toContain("不要编造凭证或改成普通消息重发最终回复");
    expect(h.port.send).not.toHaveBeenCalled();
  });

  it("unknown request keeps its real one-use ticket pending and never reissues or refunds", async () => {
    const ledger = new XsReplyLedger();
    const h = boundarySender({ reply: replyDeps(ledger) });
    const recordSend = vi.spyOn(ledger, "recordSend");
    h.port.send.mockRejectedValueOnce(new Error("SECRET_send_failure"));
    const result = await h.tool.execute(
      "c",
      { ...boundaryArgs, expectReply: {} } as MessageSessionParams,
      undefined,
      undefined,
      testToolContext,
    );
    const outcome = result.details as XsSendOutcome;
    expect(outcome).toMatchObject({ status: "unanswered", effect: "unknown", reply: { state: "pending" } });
    expect(recordSend).toHaveBeenCalledTimes(1);
    expect(recordSend).toHaveBeenCalledWith(outcome.reply!.requestId, "unknown");
    expect(ledger.classify(outcome.reply!.requestId, "session-target", "session-source").kind).toBe("reply");
    expect(boundaryText(result)).toContain(XS_UNKNOWN_HINT);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(h.port.send).toHaveBeenCalledTimes(1);
    expect(ledger.size).toBe(1);
  });

  it("replyTo unknown/rejected keep the original one-use guidance and one body attempt", async () => {
    for (const unknown of [true, false]) {
      const h = boundarySender({ reply: replyDeps() });
      h.port.send.mockResolvedValueOnce(
        unknown ? { kind: "deadline" } : xsRes({ ok: true, effect: "none", reason: "rejected" }),
      );
      const result = await h.tool.execute(
        "c",
        { ...boundaryArgs, replyTo: "q111111111111111111" } as MessageSessionParams,
        undefined,
        undefined,
        testToolContext,
      );
      expect(result.details).toMatchObject({
        effect: unknown ? "unknown" : "none",
        replyTo: { requestId: "q111111111111111111", accepted: false },
      });
      expect(boundaryText(result)).toBe(
        JSON.stringify(result.details) + "\n" + (unknown ? XS_REPLY_TO_UNKNOWN_HINT : XS_REPLY_TO_REJECTED_HINT),
      );
      expect(h.port.send).toHaveBeenCalledTimes(1);
    }
  });

  it.each([new Error("SECRET_resolve_failure"), "SECRET_non_error"])(
    "unhandled sender-port exception becomes a sanitized failure, not invented none",
    async (error) => {
      const h = boundarySender();
      h.port.resolve.mockRejectedValueOnce(error);
      const failure = await h.tool.execute("c", boundaryArgs, undefined, undefined, testToolContext).then(
        () => {
          throw new Error("expected failure");
        },
        (cause: unknown) => cause,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        "message_session: unexpected failure — 无法确认发送效果；不要重发正文",
      );
      expect((failure as Error).message).not.toContain("SECRET");
      expect((failure as Error).cause).toBeUndefined();
      expect(h.port.resolve).toHaveBeenCalledTimes(1);
      expect(h.port.send).not.toHaveBeenCalled();
    },
  );
});

describe("message_session local refusals through real sender (#84 D2)", () => {
  it("bad_args does not issue, resolve or send and keeps the original mutually-exclusive guidance", async () => {
    const ledger = new XsReplyLedger();
    const h = boundarySender({ reply: replyDeps(ledger) });
    const result = await h.tool.execute(
      "c",
      { ...boundaryArgs, expectReply: {}, replyTo: "q111111111111111111" } as MessageSessionParams,
      undefined,
      undefined,
      testToolContext,
    );
    expect(result.details).toEqual({ status: "bad_args", effect: "none", reason: "expect_and_reply_to" });
    expect(boundaryText(result)).toContain("两条路径互斥");
    expect(ledger.size).toBe(0);
    expect(h.port.resolve).not.toHaveBeenCalled();
    expect(h.port.send).not.toHaveBeenCalled();
  });

  it.each(["root", "system", "main", "r_ABCD0001", "@builder", "wf_123456"])(
    "reserved %s never reaches discovery or send",
    async (to) => {
      const h = boundarySender();
      const result = await h.tool.execute("c", { ...boundaryArgs, to }, undefined, undefined, testToolContext);
      expect(result.details).toEqual({ status: "bad_target", effect: "none", reason: "bad_target" });
      expect(boundaryText(result)).toContain("list_sessions");
      expect(h.port.resolve).not.toHaveBeenCalled();
      expect(h.port.send).not.toHaveBeenCalled();
    },
  );

  it("not_joined does not try to join or resolve", async () => {
    const h = boundarySender({
      channels: { pref: () => [], effective: () => [], link: () => [], linkJoined: () => false },
    });
    const result = await h.tool.execute("c", boundaryArgs, undefined, undefined, testToolContext);
    expect(result.details).toEqual({ status: "not_joined", effect: "none", reason: "not_joined" });
    expect(boundaryText(result)).toContain("不要自行执行 join、改策略或换路由绕过");
    expect(h.port.resolve).not.toHaveBeenCalled();
    expect(h.port.send).not.toHaveBeenCalled();
  });

  it("oversize UTF-8 frame stays too_large/none and does not send", async () => {
    const h = boundarySender({ maxChars: 16_384 });
    const result = await h.tool.execute(
      "c",
      { ...boundaryArgs, text: "x".repeat(16_384) },
      undefined,
      undefined,
      testToolContext,
    );
    expect(result.details).toEqual({ status: "too_large", effect: "none", reason: "too_large" });
    expect(boundaryText(result)).toContain("缩短正文后再发送");
    expect(h.port.resolve).toHaveBeenCalledTimes(1);
    expect(h.port.send).not.toHaveBeenCalled();
  });
});
