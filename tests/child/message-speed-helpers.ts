import { vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentSettings } from "../../src/config/settings.js";
import { wireChildMessageSpeed, type ChildMessageSpeedOptions } from "../../src/child/message-speed.js";

export function setup(
  options: ChildMessageSpeedOptions = { secureRecheckForWrite: () => undefined },
  webHub = { enabled: true, subagentTranscript: "all" },
) {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const persisted: Array<[string, unknown]> = [];
  const appendEntry = vi.fn((type: string, data: unknown) => {
    persisted.push([type, data]);
  });
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
    persisted,
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
