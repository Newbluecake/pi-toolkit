import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createXsSender, type XsHubPort, type XsPortReply } from "../../src/fabric/xs/sender.js";
import { createMessageSessionTool } from "../../src/tools/message-session-tool.js";
import { createListSessionsTool } from "../../src/tools/list-sessions-tool.js";

const testToolContext = {} as ExtensionToolContext;

function gate<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup() {
  const resolving = gate<XsPortReply>();
  const sending = gate<XsPortReply>();
  const port: XsHubPort = {
    list: vi.fn(async () => ({ kind: "res", res: { t: "xs_res", rid: "l", ok: true, rows: [] } })),
    resolve: vi.fn(() => resolving.promise),
    send: vi.fn(() => sending.promise),
  };
  const sender = createXsSender({ port, origin: { current: () => ({ sessionId: "session-a", epoch: 1 }) } });
  return {
    port,
    resolving,
    sending,
    tool: createMessageSessionTool({ sender }),
    list: createListSessionsTool({ sender }),
  };
}
const resolved: XsPortReply = {
  kind: "res",
  res: { t: "xs_res", rid: "r", ok: true, target: { ref: "target123456" } },
};

describe("xs tools forward pi's third-argument Esc signal (r3 M2)", () => {
  it("Esc during resolve returns none and never sends", async () => {
    const h = setup();
    const abort = new AbortController();
    const pending = h.tool.execute("c", { to: "target123456", text: "hello" }, abort.signal);
    expect(h.port.resolve).toHaveBeenCalledTimes(1);
    abort.abort();
    h.resolving.resolve(resolved);
    const result = await pending;
    expect(result.details).toMatchObject({ effect: "none", reason: "origin_changed" });
    expect((result.content[0] as { text: string }).text).toContain("停止本次操作");
    expect(h.port.resolve).toHaveBeenCalledTimes(1);
    expect(h.port.send).not.toHaveBeenCalled();
  });
  it("Esc after send with no remote verdict is unknown, never none", async () => {
    const h = setup();
    const abort = new AbortController();
    const pending = h.tool.execute("c", { to: "target123456", text: "hello" }, abort.signal);
    h.resolving.resolve(resolved);
    await vi.waitFor(() => expect(h.port.send).toHaveBeenCalledTimes(1));
    abort.abort();
    h.sending.resolve({ kind: "link_lost" });
    const result = await pending;
    expect(result.details).toMatchObject({ effect: "unknown", reason: "origin_changed_after_send" });
    expect((result.content[0] as { text: string }).text).toContain("不要重发");
    expect((result.content[0] as { text: string }).text).not.toContain("正文未送达");
    expect(h.port.send).toHaveBeenCalledTimes(1);
  });
  it("Esc after send preserves the received applied evidence", async () => {
    const h = setup();
    const abort = new AbortController();
    const pending = h.tool.execute("c", { to: "target123456", text: "hello" }, abort.signal);
    h.resolving.resolve(resolved);
    await vi.waitFor(() => expect(h.port.send).toHaveBeenCalledTimes(1));
    abort.abort();
    h.sending.resolve({ kind: "res", res: { t: "xs_res", rid: "s", ok: true, effect: "applied" } });
    const result = await pending;
    expect(result.details).toMatchObject({ effect: "applied" });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.details) }]);
    expect(h.port.send).toHaveBeenCalledTimes(1);
  });
  it("list respects a cancelled signal before issuing any request and forwards a live signal", async () => {
    const h = setup();
    const abort = new AbortController();
    abort.abort();
    expect((await h.list.execute("c", {}, abort.signal)).details).toMatchObject({ status: "origin_changed" });
    expect(h.port.list).not.toHaveBeenCalled();
    const list = vi.fn(async () => ({ status: "ok" as const, rows: [] }));
    const live = new AbortController();
    await createListSessionsTool({ sender: { list, message: vi.fn() } }).execute("c", {}, live.signal);
    expect(list).toHaveBeenCalledWith({ signal: live.signal });
  });
});

import { createMessageChannelTool, XS_BROADCAST_UNKNOWN_HINT } from "../../src/tools/message-channel-tool.js";

describe("broadcast cancellation keeps the sender's effect boundary (#84 D2)", () => {
  function broadcastSetup() {
    const sending = gate<XsPortReply>();
    const broadcast = vi.fn(() => sending.promise);
    const sender = createXsSender({
      port: { list: vi.fn(), resolve: vi.fn(), send: vi.fn(), broadcast, hubChannelCap: () => true },
      origin: { current: () => ({ sessionId: "source-session", epoch: 1 }) },
      channels: { pref: () => ["team"], effective: () => ["team"], link: () => ["team"], linkJoined: () => true },
    });
    return { sending, broadcast, tool: createMessageChannelTool({ sender }) };
  }

  it("pre-send cancellation is none with zero broadcast calls", async () => {
    const h = broadcastSetup();
    const abort = new AbortController();
    abort.abort();
    const result = await h.tool.execute(
      "c",
      { channel: "#team", text: "body" },
      abort.signal,
      undefined,
      testToolContext,
    );
    expect(result.details).toMatchObject({ effect: "none", reason: "origin_changed" });
    expect((result.content[0] as { text: string }).text).toContain("停止本次操作");
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it.each(["unknown", "applied"] as const)("post-send cancellation preserves %s without re-fanout", async (effect) => {
    const h = broadcastSetup();
    const abort = new AbortController();
    const pending = h.tool.execute("c", { channel: "#team", text: "body" }, abort.signal, undefined, testToolContext);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
    abort.abort();
    h.sending.resolve(
      effect === "unknown"
        ? { kind: "deadline" }
        : { kind: "res", res: { t: "xs_res", rid: "b", ok: true, effect: "applied" } },
    );
    const result = await pending;
    expect(result.details).toMatchObject({
      effect,
      ...(effect === "unknown" ? { reason: "origin_changed_after_send" } : {}),
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(result.details) + (effect === "unknown" ? "\n" + XS_BROADCAST_UNKNOWN_HINT : ""),
      },
    ]);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
  });
});
