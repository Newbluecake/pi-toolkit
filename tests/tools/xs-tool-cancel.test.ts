import { describe, expect, it, vi } from "vitest";
import { createXsSender, type XsHubPort, type XsPortReply } from "../../src/fabric/xs/sender.js";
import { createMessageSessionTool } from "../../src/tools/message-session-tool.js";
import { createListSessionsTool } from "../../src/tools/list-sessions-tool.js";

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
    expect((await pending).details).toMatchObject({ effect: "none", reason: "origin_changed" });
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
    expect((await pending).details).toMatchObject({ effect: "unknown", reason: "origin_changed_after_send" });
  });
  it("Esc after send preserves the received applied evidence", async () => {
    const h = setup();
    const abort = new AbortController();
    const pending = h.tool.execute("c", { to: "target123456", text: "hello" }, abort.signal);
    h.resolving.resolve(resolved);
    await vi.waitFor(() => expect(h.port.send).toHaveBeenCalledTimes(1));
    abort.abort();
    h.sending.resolve({ kind: "res", res: { t: "xs_res", rid: "s", ok: true, effect: "applied" } });
    expect((await pending).details).toMatchObject({ effect: "applied" });
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
