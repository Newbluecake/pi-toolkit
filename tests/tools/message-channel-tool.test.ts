import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  createMessageChannelTool,
  MessageChannelParams,
  XS_BROADCAST_UNKNOWN_HINT,
} from "../../src/tools/message-channel-tool.js";
import {
  createListSessionsTool,
  formatXsSessionRows,
  ListSessionsParams,
  ListSessionsParamsChannel,
  ListSessionsParamsLegacy,
  listSessionsParamsFor,
} from "../../src/tools/list-sessions-tool.js";
import type { XsSender } from "../../src/fabric/xs/sender.js";
import type { XsBroadcastOutcome } from "../../src/fabric/xs/types-channel.js";

const testToolContext = {} as ExtensionToolContext;

const text = (r: { content: unknown }) => (r.content as { text: string }[])[0]!.text;

describe("message_channel tool", () => {
  it("schema is {channel,text,wake?} and strict; no expectReply", () => {
    expect(Object.keys(MessageChannelParams.properties).sort()).toEqual(["channel", "text", "wake"]);
    expect(MessageChannelParams.additionalProperties).toBe(false);
    expect(Value.Check(MessageChannelParams, { channel: "#a", text: "x", expectReply: {} })).toBe(false);
    expect(Value.Check(MessageChannelParams, { channel: "#a", text: "x" })).toBe(true);
  });

  it("forwards args; omitted wake stays omitted; appends the hint only on unknown", async () => {
    const broadcast = vi.fn(async (): Promise<XsBroadcastOutcome> => ({
      status: "sent",
      effect: "applied",
      channel: "a",
    }));
    const tool = createMessageChannelTool({ sender: { broadcast } as unknown as XsSender });
    const r = await tool.execute("c", { channel: "#a", text: "hi" });
    expect(broadcast).toHaveBeenCalledWith({ channel: "#a", text: "hi" });
    expect(JSON.parse(text(r))).toEqual(r.details);
    expect(text(r)).not.toContain(XS_BROADCAST_UNKNOWN_HINT);
    broadcast.mockResolvedValueOnce({ status: "sent", effect: "unknown", reason: "partial", channel: "a" });
    const u = await tool.execute("c", { channel: "a", text: "hi", wake: true });
    expect(broadcast).toHaveBeenLastCalledWith({ channel: "a", text: "hi", wake: true });
    expect(text(u)).toContain(XS_BROADCAST_UNKNOWN_HINT);
  });

  it("description states the hard wake caps' counterpart: default cannot broadcast, reply via message_session", () => {
    const tool = createMessageChannelTool({ sender: {} as XsSender });
    expect(tool.description).toContain("#default cannot be broadcast to");
    expect(JSON.stringify(tool.parameters)).toContain("at most 4 recipients and 2 wake-broadcasts per hour");
  });
});

describe("list_sessions two frozen instances", () => {
  const stub = { list: vi.fn(async () => ({ status: "ok", rows: [] })) } as unknown as XsSender;

  it("legacy instance has exactly the old properties; channel instance adds only `channel`", () => {
    expect(ListSessionsParams).toBe(ListSessionsParamsLegacy);
    expect(Object.keys(ListSessionsParamsLegacy.properties)).toEqual(["query", "scope"]);
    expect(Object.keys(ListSessionsParamsChannel.properties)).toEqual(["query", "scope", "channel"]);
    expect(ListSessionsParamsChannel.properties.query).toBe(ListSessionsParamsLegacy.properties.query);
    expect(listSessionsParamsFor(false)).toBe(ListSessionsParamsLegacy);
    expect(listSessionsParamsFor(true)).toBe(ListSessionsParamsChannel);
  });

  it("selects the instance per deps.channels and never forwards `channel` from the legacy instance", async () => {
    const off = createListSessionsTool({ sender: stub });
    expect(off.parameters).toBe(ListSessionsParamsLegacy);
    await off.execute("c", { channel: "a" } as never);
    expect(stub.list).toHaveBeenLastCalledWith({});
    const on = createListSessionsTool({ sender: stub, channels: true });
    expect(on.parameters).toBe(ListSessionsParamsChannel);
    expect(on.description).not.toBe(off.description);
    await on.execute("c", { channel: "#a", query: "q" });
    expect(stub.list).toHaveBeenLastCalledWith({ query: "q", channel: "#a" });
  });

  it("row text adds channels=#a,#b only when the row carries channels", () => {
    const base = { ref: "r1", cwdLabel: "~", kind: "main", receive: "wake" as const, busy: false, lastActiveAgoS: 1 };
    expect(formatXsSessionRows([base])[0]).not.toContain("channels=");
    expect(formatXsSessionRows([{ ...base, channels: ["a", "b"] }])[0]).toContain("· channels=#a,#b");
  });
});

import { createXsSender, type XsHubPort, type XsPortReply } from "../../src/fabric/xs/sender.js";
import type { XsResFrame } from "../../src/web-hub/protocol/xs.js";

const channelRes = (res: Partial<XsResFrame> & { ok: boolean }): XsPortReply => ({
  kind: "res",
  res: { t: "xs_res", rid: "test", ...res },
});
function broadcastBoundary(names = ["team"]) {
  const port = {
    list: vi.fn(),
    resolve: vi.fn(),
    send: vi.fn(),
    hubChannelCap: (): boolean => true,
    broadcast: vi.fn(async () => channelRes({ ok: true, effect: "applied" })),
  } satisfies XsHubPort;
  const sender = createXsSender({
    port,
    origin: { current: () => ({ sessionId: "source-session", epoch: 1 }) },
    channels: { pref: () => names, effective: () => names, link: () => names, linkJoined: () => names.length > 0 },
  });
  return { port, tool: createMessageChannelTool({ sender }) };
}

describe("message_channel boundary advice through real sender (#84 D2)", () => {
  it.each([
    ["#default", "default_channel", "#default 不支持广播"],
    ["bad name", "bad_channel", "不要自行 join 或换频道绕过"],
    ["#other", "bad_channel", "不要自行 join 或换频道绕过"],
  ])("%s is refused locally without another route or membership mutation", async (channel, status, advice) => {
    const h = broadcastBoundary();
    const result = await h.tool.execute("c", { channel, text: "body" }, undefined, undefined, testToolContext);
    expect(result.details).toMatchObject({ status, effect: "none" });
    expect(text(result)).toContain(advice);
    expect(h.port.broadcast).not.toHaveBeenCalled();
    expect(h.port.send).not.toHaveBeenCalled();
    expect(h.port.list).not.toHaveBeenCalled();
  });

  it("not_joined and unsupported stay none, with human-only next steps", async () => {
    const h = broadcastBoundary([]);
    const result = await h.tool.execute("c", { channel: "#team", text: "body" }, undefined, undefined, testToolContext);
    expect(result.details).toMatchObject({ status: "not_joined", effect: "none" });
    expect(text(result)).toContain("不要自行执行 join、改策略");
    expect(h.port.broadcast).not.toHaveBeenCalled();
    h.port.hubChannelCap = () => false;
    const unsupported = await h.tool.execute(
      "c",
      { channel: "#team", text: "body" },
      undefined,
      undefined,
      testToolContext,
    );
    expect(unsupported.details).toMatchObject({ status: "channel_unsupported", effect: "none" });
    expect(text(unsupported)).toContain("/webhub status");
    expect(h.port.broadcast).not.toHaveBeenCalled();
  });

  it.each([
    ["E_XS_FANOUT_TOO_LARGE", "fanout_too_large", "不要拆批绕过上限"],
    ["E_XS_TOO_LARGE", "too_large", "缩短正文"],
    ["E_XS_STALE_ORIGIN", "stale_origin", "重新确认发送意图"],
    ["E_XS_OFF", "off", "/fabric status"],
    ["E_XS_BAD_FRAME", "bad_frame", "核对工具参数"],
  ])("%s preserves the admission code and none effect without a second broadcast", async (code, status, advice) => {
    const h = broadcastBoundary();
    h.port.broadcast.mockResolvedValueOnce(channelRes({ ok: false, code }));
    const result = await h.tool.execute("c", { channel: "#team", text: "body" }, undefined, undefined, testToolContext);
    expect(result.details).toEqual({ status, effect: "none", code, channel: "team" });
    expect(text(result)).toContain(advice);
    expect(h.port.broadcast).toHaveBeenCalledTimes(1);
    expect(h.port.send).not.toHaveBeenCalled();
  });

  it.each([
    "rate_in_flight",
    "rate_sends_min",
    "rate_sends_hour",
    "rate_hub",
    "rate_broadcast_hour",
    "rate_broadcast_interval",
  ])("%s has no invented retry time and no automatic re-fanout", async (reason) => {
    const h = broadcastBoundary();
    h.port.broadcast.mockResolvedValueOnce(channelRes({ ok: true, effect: "none", reason }));
    const result = await h.tool.execute("c", { channel: "#team", text: "body" }, undefined, undefined, testToolContext);
    expect(result.details).toEqual({ status: "sent", effect: "none", reason, channel: "team" });
    expect(text(result)).toContain("没有权威 retryAfter，不能推算恢复时间");
    expect(text(result)).not.toMatch(/\d+\s*(秒|分钟|小时).*重试/);
    expect(h.port.broadcast).toHaveBeenCalledTimes(1);
  });

  it("no_recipients reports a known empty fanout, not a guessed target", async () => {
    const h = broadcastBoundary();
    h.port.broadcast.mockResolvedValueOnce(channelRes({ ok: true, effect: "none", reason: "no_recipients" }));
    const result = await h.tool.execute("c", { channel: "#team", text: "body" }, undefined, undefined, testToolContext);
    expect(text(result)).toContain("当前频道没有可投递收件人");
    expect(h.port.broadcast).toHaveBeenCalledTimes(1);
    expect(h.port.list).not.toHaveBeenCalled();
  });

  it("partial unknown retains each recipient effect; only none refs may be individually retried", async () => {
    const h = broadcastBoundary();
    const results = [
      { ref: "applied12345", effect: "applied" as const, woke: false },
      { ref: "unknown12345", effect: "unknown" as const, reason: "queued", woke: false },
      { ref: "none12345678", effect: "none" as const, reason: "inbox_full", woke: false },
    ];
    const fanout = { total: 3, applied: 1, none: 1, unknown: 1, woke: 0 };
    h.port.broadcast.mockResolvedValueOnce(
      channelRes({ ok: true, effect: "unknown", reason: "partial", results, fanout }),
    );
    const result = await h.tool.execute("c", { channel: "#team", text: "body" }, undefined, undefined, testToolContext);
    expect(result.details).toEqual({
      status: "sent",
      effect: "unknown",
      reason: "partial",
      channel: "team",
      results,
      fanout,
    });
    expect(text(result)).toBe(JSON.stringify(result.details) + "\n" + XS_BROADCAST_UNKNOWN_HINT);
    expect(h.port.broadcast).toHaveBeenCalledTimes(1);
    expect(h.port.send).not.toHaveBeenCalled();
  });

  it.each(["deadline", "link_lost"] as const)(
    "post-broadcast %s remains unknown, never converted to none",
    async (kind) => {
      const h = broadcastBoundary();
      h.port.broadcast.mockResolvedValueOnce({ kind });
      const result = await h.tool.execute(
        "c",
        { channel: "#team", text: "body" },
        undefined,
        undefined,
        testToolContext,
      );
      expect(result.details).toMatchObject({ effect: "unknown" });
      expect(text(result)).toBe(JSON.stringify(result.details) + "\n" + XS_BROADCAST_UNKNOWN_HINT);
      expect(h.port.broadcast).toHaveBeenCalledTimes(1);
    },
  );

  it("port errors are sanitized by the real sender without body retry", async () => {
    const h = broadcastBoundary();
    h.port.broadcast.mockRejectedValueOnce(new Error("SECRET_transport"));
    const result = await h.tool.execute("c", { channel: "#team", text: "body" }, undefined, undefined, testToolContext);
    expect(result.details).toMatchObject({ effect: "unknown", reason: "link_lost" });
    expect(text(result)).toContain(XS_BROADCAST_UNKNOWN_HINT);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(h.port.broadcast).toHaveBeenCalledTimes(1);
  });

  it("pre-admission unexpected exceptions stay sanitized failures, not fabricated none", async () => {
    const h = broadcastBoundary();
    h.port.hubChannelCap = () => {
      throw new Error("SECRET_port_state");
    };
    const failure = await h.tool
      .execute("c", { channel: "#team", text: "body" }, undefined, undefined, testToolContext)
      .then(
        () => {
          throw new Error("expected failure");
        },
        (cause: unknown) => cause,
      );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("无法确认广播效果");
    expect((failure as Error).message).not.toContain("SECRET");
    expect((failure as Error).cause).toBeUndefined();
    expect(h.port.broadcast).not.toHaveBeenCalled();
  });

  it("applied success including wake downgrade remains byte-identical JSON", async () => {
    const h = broadcastBoundary();
    h.port.broadcast.mockResolvedValueOnce(
      channelRes({ ok: true, effect: "applied", wakeDowngraded: "broadcast_wake_rate" }),
    );
    const result = await h.tool.execute("c", { channel: "#team", text: "body" }, undefined, undefined, testToolContext);
    expect(result.details).toEqual({
      status: "sent",
      effect: "applied",
      channel: "team",
      wakeDowngraded: "broadcast_wake_rate",
    });
    expect(text(result)).toBe(JSON.stringify(result.details));
    expect(h.port.broadcast).toHaveBeenCalledTimes(1);
  });
});
