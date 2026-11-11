import { afterEach, describe, expect, it, vi } from "vitest";
import { wireWebHub } from "../../../src/web-hub/agent/index.js";
import { ackFrame, fakeCtx, fakeNet, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  resetGlobals();
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("speed host assembly", () => {
  it.each(["positive", "session-reset", "shutdown", "locked", "missing-guard"])(
    "public raw and scalar adapter %s",
    async (mode) => {
      const tmp = tmpDir("speed-wiring-");
      cleanups.push(tmp.cleanup);
      resetGlobals();
      vi.useFakeTimers();
      const n = fakeNet();
      const p = fakePi();
      const append = vi.spyOn(p.pi, "appendEntry");
      const { ctx } = fakeCtx();
      (ctx as unknown as { cwd: string }).cwd = tmp.dir;
      let mono = 0;
      wireWebHub(p.pi, {
        settings: SETTINGS,
        fleet: () => [],
        env: { HOME: tmp.dir },
        paths: pathsIn(tmp.dir),
        buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "speed-test" }),
        argv1: "/nonexistent/pi",
        netConnect: n.netConnect,
        monotonicNow: () => mono,
        ...(mode === "missing-guard"
          ? {}
          : { secureRecheckForWrite: () => (mode === "locked" ? "LOCKED" : undefined) }),
      });
      const fire = (type: string, extra: Record<string, unknown> = {}) => p.fire(type, { type, ...extra }, ctx);
      fire("session_start", { reason: "startup" });
      await vi.advanceTimersByTimeAsync(0);
      const socket = n.sockets[0]!;
      socket.emit("connect");
      await vi.advanceTimersByTimeAsync(0);
      socket.hub(ackFrame());
      await vi.advanceTimersByTimeAsync(0);
      expect(p.handlers.get("provider_stream_event")).toHaveLength(1);
      const binding = { responseId: "resp", provider: "openai", api: "openai-responses", model: "fake" };
      const message = {
        role: "assistant",
        ...binding,
        stopReason: "stop",
        content: [{ type: "text", text: "ab" }],
        usage: { output: 10 },
        timestamp: 123,
      };
      fire("agent_start");
      fire("turn_start", { turnIndex: 0 });
      fire("message_start", { message });
      for (const time of [0, 500]) {
        mono = time;
        fire("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a" } });
      }
      fire("provider_stream_event", {
        provider: binding.provider,
        api: binding.api,
        model: binding.model,
        data: {
          type: "response.completed",
          response: {
            id: "resp",
            status: "completed",
            usage: { output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 } },
            output: [],
          },
        },
      });
      fire("message_end", { message });
      const ends = socket.frames().filter((f) => f.t === "ev" && (f.e as { type: string }).type === "message_end");
      expect(ends).toHaveLength(1);
      expect((ends[0]!.e as { message: Record<string, unknown> }).message.piToolkitGeneration).toEqual({
        v: 1,
        tokens: 10,
        genMs: 500,
        deltaCount: 2,
      });
      expect(append).not.toHaveBeenCalled();
      if (mode === "session-reset") fire("session_start", { reason: "new" });
      if (mode === "shutdown") fire("session_shutdown", { reason: "reload" });
      fire("turn_end", { turnIndex: 0, messageEntryId: "mid", message });
      if (mode === "positive")
        expect(append).toHaveBeenCalledWith("subagent:web-msg-speed", {
          piToolkitGeneration: { v: 1, tokens: 10, genMs: 500, deltaCount: 2, mid: "mid" },
        });
      else expect(append).not.toHaveBeenCalled();
      fire("session_shutdown", { reason: "quit" });
    },
  );
});
