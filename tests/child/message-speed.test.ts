import { describe, expect, it, vi } from "vitest";
import { setup } from "./message-speed-helpers.js";

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
