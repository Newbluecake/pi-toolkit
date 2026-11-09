import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentSettings } from "../../src/config/settings.js";
import { wireChildMessageSpeed, type ChildMessageSpeedOptions } from "../../src/child/message-speed.js";

function setup(
  options: ChildMessageSpeedOptions = { secureRecheckForWrite: () => undefined },
  webHub = { enabled: true, subagentTranscript: "all" },
) {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const appendEntry = vi.fn();
  const renderer = vi.fn();
  let mono = 0;
  let sid = "child-session";
  let ctx = { sessionManager: { getSessionId: () => sid } } as ExtensionContext;
  const originalCtx = ctx;
  const pi = {
    on(type: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
    },
    appendEntry,
    registerEntryRenderer: renderer,
  } as unknown as ExtensionAPI;
  wireChildMessageSpeed(pi, { webHub } as AgentSettings, { monotonicNow: () => mono, ...options });
  const fire = (type: string, extra: Record<string, unknown> = {}) => {
    for (const fn of handlers.get(type) ?? []) fn({ type, ...extra }, ctx);
  };
  const message = {
    role: "assistant",
    responseId: "resp-child",
    provider: "openai",
    api: "openai-responses",
    model: "fake",
    stopReason: "stop",
    content: [{ type: "text", text: "ab" }],
    usage: { output: 10 },
  };
  const start = () => {
    fire("agent_start");
    fire("turn_start", { turnIndex: 0 });
    fire("message_start", { message });
  };
  const delta = (time: number, kind = "text_delta", text = "a") => {
    mono = time;
    fire("message_update", { message, assistantMessageEvent: { type: kind, delta: text } });
  };
  const raw = (tokens = 10) =>
    fire("provider_stream_event", {
      provider: message.provider,
      api: message.api,
      model: message.model,
      data: {
        type: "response.completed",
        response: { id: message.responseId, status: "completed", usage: { output_tokens: tokens }, output: [] },
      },
    });
  const finish = (extra: Record<string, unknown> = {}) =>
    fire("turn_end", { turnIndex: 0, message, messageEntryId: "assistant-exact-mid", ...extra });
  return {
    handlers,
    appendEntry,
    renderer,
    fire,
    message,
    start,
    delta,
    raw,
    finish,
    swapManager: () => {
      ctx = { sessionManager: { getSessionId: () => sid } } as ExtensionContext;
    },
    restoreManager: () => {
      ctx = originalCtx;
    },
    changeId: () => {
      sid = "different-child";
    },
  };
}

describe("child tokens/s custom metadata", () => {
  it.each(["all", "loopback"])(
    "lazy %s child: raw/final=10, 500ms, exact turn mid; never mutates SDK assistant",
    (mode) => {
      const h = setup(undefined, { enabled: true, subagentTranscript: mode });
      expect(h.handlers.has("session_start")).toBe(false);
      expect(h.appendEntry).not.toHaveBeenCalled();
      h.start();
      h.delta(0);
      h.delta(500, "thinking_delta");
      h.raw();
      h.fire("message_end", { message: h.message });
      expect(h.appendEntry).not.toHaveBeenCalled();
      expect(h.message).not.toHaveProperty("piToolkitGeneration");
      h.finish();
      h.finish();
      expect(h.appendEntry.mock.calls).toEqual([
        [
          "subagent:web-msg-speed",
          {
            piToolkitGeneration: { v: 1, mid: "assistant-exact-mid", tokens: 10, genMs: 500, deltaCount: 2 },
          },
        ],
      ]);
      expect(h.renderer).toHaveBeenCalledWith("subagent:web-msg-speed", expect.any(Function));
      expect(h.renderer.mock.calls[0]![1]()).toBeUndefined();
    },
  );

  it.each([
    { enabled: false, subagentTranscript: "all" },
    { enabled: true, subagentTranscript: "off" },
  ])("off installs no hooks/renderer and writes nothing: %j", (webHub) => {
    const h = setup(undefined, webHub);
    expect(h.handlers.size).toBe(0);
    expect(h.renderer).not.toHaveBeenCalled();
    h.start();
    h.delta(0);
    h.delta(500);
    h.raw();
    h.fire("message_end", { message: h.message });
    h.finish();
    expect(h.appendEntry).not.toHaveBeenCalled();
  });

  it.each([
    "no-raw",
    "conflict",
    "short",
    "one-delta",
    "empty-delta",
    "error",
    "wrong-mid",
    "wrong-final",
    "wrong-turn",
    "manager",
    "session-id",
    "end",
    "settled",
    "shutdown",
    "no-start",
    "binding",
  ])("hides instead of estimating: %s", (mode) => {
    const h = setup();
    if (mode !== "no-start") h.start();
    h.delta(0);
    if (mode !== "one-delta") h.delta(mode === "short" ? 499 : 500, "text_delta", mode === "empty-delta" ? "" : "b");
    if (mode !== "no-raw") h.raw(mode === "conflict" ? 11 : 10);
    if (mode === "error") h.message.stopReason = "error";
    if (mode === "binding") h.message.responseId = "other";
    h.fire("message_end", { message: h.message });
    if (mode === "manager") h.swapManager();
    if (mode === "session-id") h.changeId();
    if (mode === "end") h.fire("agent_end");
    if (mode === "settled") h.fire("agent_settled");
    if (mode === "shutdown") h.fire("session_shutdown");
    h.finish(
      mode === "wrong-mid"
        ? { messageEntryId: undefined }
        : mode === "wrong-final"
          ? { message: { ...h.message } }
          : mode === "wrong-turn"
            ? { turnIndex: 1 }
            : {},
    );
    expect(h.appendEntry).not.toHaveBeenCalled();
  });

  it("raw proof observed under another owner poisons the loop even after switching back", () => {
    const h = setup();
    h.start();
    h.delta(0);
    h.delta(500);
    h.swapManager();
    h.raw();
    h.restoreManager();
    h.fire("message_end", { message: h.message });
    h.finish();
    expect(h.appendEntry).not.toHaveBeenCalled();
  });

  it.each(["missing", "locked", "promise", "throw", "owner-during-guard"])(
    "synchronous pre-write guard fails closed: %s",
    (mode) => {
      const guard = vi.fn(() => {
        if (mode === "throw") throw new Error("locked");
        if (mode === "owner-during-guard") h.changeId();
        return mode === "promise" ? Promise.resolve() : mode === "locked" ? "LOCKED" : undefined;
      });
      const h = setup(mode === "missing" ? {} : { secureRecheckForWrite: guard });
      h.start();
      h.delta(0);
      h.delta(500);
      h.raw();
      h.fire("message_end", { message: h.message });
      h.finish();
      expect(h.appendEntry).not.toHaveBeenCalled();
      expect(guard).toHaveBeenCalledTimes(mode === "missing" ? 0 : 1);
    },
  );

  it("append failure is swallowed, never retried; new loops work without shutdown/session_start", () => {
    const h = setup();
    h.appendEntry.mockImplementationOnce(() => {
      throw new Error("stale append");
    });
    h.start();
    h.delta(0);
    h.delta(500);
    h.raw();
    h.fire("message_end", { message: h.message });
    h.finish();
    h.finish();
    expect(h.appendEntry).toHaveBeenCalledTimes(1);
    h.fire("agent_end");
    h.start();
    h.delta(1000);
    h.delta(1500);
    h.raw();
    h.fire("message_end", { message: h.message });
    h.finish();
    expect(h.appendEntry).toHaveBeenCalledTimes(2);
    expect(h.appendEntry.mock.calls[1]![1].piToolkitGeneration.genMs).toBe(500);
  });
});
