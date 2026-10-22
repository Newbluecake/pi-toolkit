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
