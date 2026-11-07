import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltinBridge } from "../../../src/web-hub/agent/builtin-bridge.js";
import { createCommandHandler } from "../../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../../src/web-hub/agent/queue-mirror.js";
import { xsWebCommandArgs } from "../../../src/web-hub/protocol/xs-web-command.js";
import type { CmdFrame, CmdResultFrame } from "../../../src/web-hub/protocol/messages.js";
import type { XsActivationPort } from "../../../src/fabric/xs/session-activation.js";
import { fakeCtx, fakePi, fakeTimerQueue } from "./helpers.js";

afterEach(() => delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:web-hub:cmd-ledger")]);
const args = xsWebCommandArgs({ action: "activate", messageId: "original-message", activationKey: "original-key" });
const frame = (id = "cmd-a", text = args): CmdFrame => ({
  t: "cmd",
  rid: `r-${id}`,
  id,
  deadlineMs: 12_000,
  origin: { listener: "loopback", ip: "127.0.0.1", reqId: "req" },
  cmd: { op: "command", name: "fabric", args: text, expect: { sessionId: "sess-1" } },
});
function setup(options: { policy?: "allow" | "deny" | "confirm"; absent?: boolean; hang?: boolean } = {}) {
  const { pi, sentUserMessages } = fakePi();
  pi.getCommands = () => [{ name: "fabric", source: "extension" }] as never;
  const { ctx, state } = fakeCtx();
  const activate = vi.fn(async () => ({
    status: "accepted",
    effect: "applied",
    messageId: "original-message",
    activationKey: "original-key",
    retryable: false,
  }));
  const query = vi.fn(async () => ({ status: "unavailable", messageId: "original-message" }));
  const port = { activate: options.hang ? vi.fn(() => new Promise(() => {})) : activate, query } as XsActivationPort;
  const bridge = createBuiltinBridge({
    pi,
    getCtx: () => ctx,
    getSessionId: () => state.sessionId,
    overrides: () => ({ fabric: options.policy ?? "allow" }),
    xsActivation: () => (options.absent ? undefined : port),
  });
  const ledger = createCommandLedger();
  const sent: CmdResultFrame[] = [];
  const notify = vi.fn();
  const timers = fakeTimerQueue();
  const handler = createCommandHandler({
    pi,
    getCtx: () => ctx,
    getSessionId: () => state.sessionId,
    ledger,
    queueMirror: createQueueMirror(),
    compactionState: { manualCompacting: false, dispose() {} },
    originEntry: { appendOrigin() {}, notify, dispose() {} } as never,
    builtinBridge: bridge,
    controlEnabled: () => true,
    now: () => 1000,
    send: (f) => sent.push(f as CmdResultFrame),
    onChanged() {},
    setTimer: timers.setTimer,
  });
  return { bridge, handler, ledger, sent, notify, timers, activate, query, port, state, sentUserMessages };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
describe("P3b internal web activation over existing command channel", () => {
  it("executes one exact original-key activation, no user/model prompt, and duplicate cmdId cannot re-execute", async () => {
    const h = setup();
    h.handler.handle(frame());
    expect(h.sent).toEqual([]);
    await flush();
    expect(h.activate).toHaveBeenCalledTimes(1);
    expect(h.activate).toHaveBeenCalledWith({
      action: "activate",
      messageId: "original-message",
      activationKey: "original-key",
    });
    expect(h.sent[0]).toMatchObject({ ok: true, data: { op: "command", xsActivation: { status: "accepted" } } });
    h.handler.handle(frame());
    expect(h.activate).toHaveBeenCalledTimes(1);
    expect(h.sent[1]).toMatchObject({ ok: true, dup: true });
    expect(h.sentUserMessages).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.timers.pendingCount()).toBe(0);
  });
  it("query miss is strictly read-only and never falls through to activation", async () => {
    const h = setup();
    h.handler.handle(frame("query", xsWebCommandArgs({ action: "query", messageId: "original-message" })));
    await flush();
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.query).toHaveBeenCalledWith({ action: "query", messageId: "original-message" });
    expect(h.activate).not.toHaveBeenCalled();
    expect(h.sent[0]).toMatchObject({ ok: true, data: { xsActivation: { status: "unavailable" } } });
    expect(h.sentUserMessages).toEqual([]);
  });
  it.each(["deny", "confirm"] as const)("fabric policy=%s refuses BEFORE touching the port", async (policy) => {
    const h = setup({ policy });
    expect(await h.bridge.execute(frame())).toMatchObject({
      ok: false,
      code: policy === "deny" ? "E_COMMAND_DENIED" : "E_CONFIRM_REQUIRED",
      effect: "none",
    });
    expect(h.activate).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });
  it("confirmed policy, absent/off port, Feishu and changed session all fail closed appropriately", async () => {
    const h = setup({ policy: "confirm" });
    const f = frame();
    if (f.cmd.op !== "command") throw new Error("fixture");
    f.cmd.confirm = true;
    expect(await h.bridge.execute(f)).toMatchObject({ ok: true });
    expect(await setup({ absent: true }).bridge.execute(frame())).toMatchObject({ ok: false, code: "E_UNSUPPORTED" });
    const denied = setup();
    expect(
      await denied.bridge.execute({ ...frame(), origin: { listener: "lan", ip: "feishu", reqId: "r" } }),
    ).toMatchObject({ ok: false, code: "E_COMMAND_DENIED" });
    denied.state.sessionId = "new-session";
    expect(await denied.bridge.execute(frame())).toMatchObject({ ok: false, code: "E_SESSION_CHANGED" });
    expect(denied.activate).not.toHaveBeenCalled();
  });
  it.each([
    '__xs {"action":"activate","messageId":"m"}',
    '__xs {"action":"activate","messageId":"m","activationKey":"k","text":"forged body"}',
    '__xs {"action":"query","messageId":"m","source":"human"}',
    '__xs {"action":"bad","messageId":"m"}',
    "__xs null",
    "__xs []",
    "__xs {bad json",
  ])("rejects invalid or browser self-authorizing payload %s", async (text) => {
    const h = setup();
    expect(await h.bridge.execute(frame("invalid", text))).toMatchObject({
      ok: false,
      code: "E_BAD_REQUEST",
      effect: "none",
    });
    expect(h.activate).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
    expect(h.sentUserMessages).toEqual([]);
  });
  it("activate timeout is cached unknown/query-only, NEVER retryable none or a replay", async () => {
    const h = setup({ hang: true });
    h.handler.handle(frame("hung"));
    h.timers.fireByMs(9_000);
    expect(h.sent[0]).toMatchObject({
      ok: false,
      code: "E_DEADLINE",
      effect: "unknown",
      retryable: false,
      message: "xs:query-only",
    });
    expect(h.ledger.get("hung")?.state).toBe("failed");
    h.handler.handle(frame("hung"));
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toMatchObject({ ok: false, effect: "unknown" });
    expect(h.port.activate).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
  });
  it("a rejected activation promise is conservatively unknown, not a safe retry", async () => {
    const h = setup();
    h.port.activate = vi.fn(async () => {
      throw new Error("after-side-effect");
    });
    h.handler.handle(frame("throw"));
    await flush();
    expect(h.sent[0]).toMatchObject({ ok: false, effect: "unknown", retryable: false });
  });
});

it("P3b synchronous post-call throw is unknown; exhausted deadline refuses before any port call", async () => {
  const h = setup();
  h.port.activate = vi.fn(() => {
    throw new Error("after-control-call");
  });
  h.handler.handle(frame("sync-throw"));
  await flush();
  expect(h.sent[0]).toMatchObject({ ok: false, effect: "unknown", retryable: false });
  const short = setup();
  expect(await short.bridge.execute({ ...frame("short"), deadlineMs: 300 })).toMatchObject({
    ok: false,
    code: "E_DEADLINE",
    effect: "none",
  });
  expect(short.activate).not.toHaveBeenCalled();
  expect(short.query).not.toHaveBeenCalled();
});
