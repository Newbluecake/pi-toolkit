import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import type { Model } from "@earendil-works/pi-ai";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { createEventTap } from "../../../src/web-hub/agent/event-tap.js";
import { createMessageSpeed } from "../../../src/web-hub/agent/message-speed.js";
import { wireMessageSpeed } from "../../../src/web-hub/agent/message-speed-wire.js";
import type { WireEvent } from "../../../src/web-hub/protocol/messages.js";

function harness() {
  let time = 0;
  let owner = { sessionId: "session", sessionGeneration: 1, activationGeneration: {}, ownerToken: {} };
  const ctx = {};
  const writes: unknown[] = [];
  const emitted: WireEvent[] = [];
  const handlers = new Map<string, (e: never) => unknown>();
  const pi = {
    on: (type: string, handler: (e: never) => unknown) => handlers.set(type, handler),
    registerEntryRenderer: () => {},
  } as unknown as ExtensionAPI;
  const speed = createMessageSpeed({
    monotonicNow: () => time,
    currentOwner: () => owner,
    getCurrentContext: () => ctx,
    sessionId: () => "session",
    secureRecheckForWrite: () => undefined,
    appendEntry: (type, data) => writes.push({ type, data }),
  });
  const tap = createEventTap((e) => emitted.push(e), { speed, now: () => 0, setTimer: () => ({ cancel() {} }) });
  const wire = wireMessageSpeed(pi, speed, () => true);
  return {
    writes,
    emitted,
    tap,
    speed,
    forward: (e: Record<string, unknown> & { type: string }) => wire.forward(tap, e),
    raw: (data: unknown) =>
      handlers.get("provider_stream_event")!({
        provider: "openai",
        api: "openai-responses",
        model: "fake-task58",
        data,
      } as never),
    advance: () => {
      time += 500;
    },
    revoke: () => {
      owner = { ...owner, ownerToken: {} };
    },
  };
}
const model: Model<"openai-responses"> = {
  id: "fake-task58",
  name: "fake-task58",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://task58.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10000,
  maxTokens: 100,
};

async function sdkCase(mode: string) {
  const h = harness();
  const id = "resp_main";
  const usage = {
    input_tokens: 2,
    output_tokens: 10,
    total_tokens: 12,
    ...(mode === "missing" ? {} : { output_tokens_details: { reasoning_tokens: mode === "nonzero" ? 2 : 0 } }),
  };
  const completed = {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      usage,
      output: mode === "summary" ? [{ type: "reasoning", summary: [] }] : [],
    },
  };
  const events = [
    { type: "response.created", response: { id, status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_fake", role: "assistant", status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hello " },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "world" },
    completed,
  ];
  let fetches = 0;
  let final: unknown;
  let turn: unknown;
  await runAgentLoop(
    [{ role: "user", content: "fake", timestamp: 0 }],
    { systemPrompt: "", messages: [], tools: [] },
    { model, convertToLlm: (messages) => messages as never },
    (event) => {
      const e = event as unknown as Record<string, unknown> & { type: string };
      if (e.type === "turn_start") e.turnIndex = 0; // public extension boundary adds SDK index
      if (e.type === "message_update" && (e.assistantMessageEvent as { type: string }).type === "text_delta") {
        h.advance();
        if (mode === "owner") h.revoke();
        if (mode === "warmer") h.raw({ ...completed, response: { ...completed.response, id: "resp_warmer" } });
      }
      if (e.type === "message_end" && (e.message as { role: string }).role === "assistant") {
        final = e.message;
        if (mode === "redacted")
          (e.message as { content: unknown[] }).content.push({ type: "redacted_thinking", data: "redacted" });
      }
      if (e.type === "turn_end") {
        turn = e.message;
        // Live has already been emitted, before turn_end metadata exists.
        expect(h.emitted.filter((e) => e.type === "message_end" && e.message?.role === "assistant")).toHaveLength(1);
        e.turnIndex = 0;
        e.messageEntryId = "public-mid";
      }
      h.forward(e);
    },
    undefined,
    (m, c, o) =>
      stream(m as Model<"openai-responses">, c, {
        ...o,
        apiKey: "fake-not-secret",
        maxRetries: 0,
        fetch: async () => {
          fetches++;
          return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          });
        },
        onProviderStreamEvent: (data) => {
          h.raw(data);
          if (mode === "duplicate" && (data as { type: string }).type === "response.completed") h.raw(data);
        },
      }),
  );
  expect(fetches).toBe(1);
  expect(final).toBe(turn);
  expect((final as { usage: { reasoning: number } }).usage.reasoning).toBe(mode === "nonzero" ? 2 : 0);
  const message = h.emitted.findLast((e) => e.type === "message_end" && e.message?.role === "assistant")!.message!;
  if (mode === "positive" || mode === "warmer") {
    expect(message.piToolkitGeneration).toEqual({ v: 1, tokens: 10, genMs: 500, deltaCount: 2 });
    expect(h.writes).toEqual([
      {
        type: "subagent:web-msg-speed",
        data: { piToolkitGeneration: { v: 1, tokens: 10, genMs: 500, deltaCount: 2, mid: "public-mid" } },
      },
    ]);
  } else {
    expect(message.piToolkitGeneration).toBeUndefined();
    expect(h.writes).toEqual([]);
  }
  h.tap.dispose();
}

describe("task58 P0 real SDK 1.5 fake fetch → public port → tap → mid", () => {
  it.each(["positive", "missing", "nonzero", "summary", "redacted", "duplicate", "warmer", "owner"])("%s", sdkCase);
  it("never invokes update snapshot getters, including failed outer binding; deltas still forward", () => {
    const h = harness();
    let calls = 0;
    const throwing = () => {
      calls++;
      throw new Error("snapshot");
    };
    h.forward({ type: "agent_start" });
    h.forward({ type: "turn_start", turnIndex: 0 });
    h.forward({ type: "message_start", message: { role: "assistant", content: [] } });
    const ame = { type: "text_delta", contentIndex: 0, delta: "unchanged" };
    for (const key of ["partial", "message", "error"]) Object.defineProperty(ame, key, { get: throwing });
    const event = { type: "message_update", assistantMessageEvent: ame };
    Object.defineProperty(event, "message", { get: throwing });
    h.forward(event);
    h.advance();
    h.forward(event);
    h.tap.flush();
    expect(calls).toBe(0);
    expect(h.emitted.find((e) => e.type === "message_update")).toEqual({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "unchangedunchanged" },
    });
    h.tap.dispose();
  });
});

it.each(["positive", "missing", "nonzero", "summary"])(
  "P0 FULL public SDK session boundary %s: real turnIndex, final reference, real mid",
  async (mode) => {
    const positive = mode === "positive";
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager } =
      await import("@earendil-works/pi-coding-agent");
    const root = mkdtempSync(join(tmpdir(), "tokens58-p0-"));
    const settings = SettingsManager.inMemory({
      cacheWarming: "off",
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const manager = SessionManager.inMemory(root);
    const emitted: WireEvent[] = [];
    let time = 0;
    let current: import("@earendil-works/pi-coding-agent").ExtensionContext | undefined;
    let final: unknown;
    let turn: unknown;
    let publicIndex: unknown;
    let publicMid: unknown;
    let appendAtTurn = false;
    const ownerToken = {};
    const activationGeneration = {};
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        (pi) => {
          const speed = createMessageSpeed({
            monotonicNow: () => time,
            currentOwner: () =>
              current === undefined
                ? undefined
                : { sessionId: manager.getSessionId(), sessionGeneration: 1, ownerToken, activationGeneration },
            getCurrentContext: () => current,
            sessionId: (c) => c.sessionManager.getSessionId(),
            secureRecheckForWrite: () => undefined,
            appendEntry: (type, data) => {
              pi.appendEntry(type, data);
              appendAtTurn = true;
            },
          });
          const tap = createEventTap((e) => emitted.push(e), {
            speed,
            now: () => 0,
            setTimer: () => ({ cancel() {} }),
          });
          const wire = wireMessageSpeed(pi, speed, () => true);
          pi.on("session_start", (_e, c) => {
            current = c;
          });
          for (const type of [
            "agent_start",
            "turn_start",
            "message_start",
            "message_update",
            "message_end",
            "turn_end",
            "agent_end",
          ] as const) {
            pi.on(type, (event, c) => {
              current = c;
              if (event.type === "turn_start") publicIndex = event.turnIndex;
              if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") time += 500;
              if (event.type === "message_end" && event.message.role === "assistant") final = event.message;
              if (event.type === "turn_end") {
                turn = event.message;
                publicMid = event.messageEntryId;
                expect(appendAtTurn).toBe(false);
                expect(
                  emitted.findLast((e) => e.type === "message_end" && e.message?.role === "assistant")?.message
                    ?.piToolkitGeneration,
                ).toEqual(positive ? { v: 1, tokens: 10, genMs: 500, deltaCount: 2 } : undefined);
              }
              wire.forward(tap, event as unknown as Record<string, unknown> & { type: string });
            });
          }
        },
      ],
    });
    const responseId = "resp_real_sdk_boundary";
    const events = [
      { type: "response.created", response: { id: responseId, status: "in_progress" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_fake", role: "assistant", status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hello " },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "world" },
      {
        type: "response.completed",
        response: {
          id: responseId,
          status: "completed",
          usage: {
            input_tokens: 2,
            output_tokens: 10,
            total_tokens: 12,
            ...(mode === "missing" ? {} : { output_tokens_details: { reasoning_tokens: mode === "nonzero" ? 2 : 0 } }),
          },
          output: mode === "summary" ? [{ type: "reasoning", summary: [] }] : [],
        },
      },
    ];
    let fetches = 0;
    const runtime = {
      streamSimple: (m: Model<"openai-responses">, c: Parameters<typeof stream>[1], o: Parameters<typeof stream>[2]) =>
        stream(m, c, {
          ...o,
          apiKey: "fake-not-secret",
          maxRetries: 0,
          fetch: async () => {
            fetches++;
            return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
              headers: { "content-type": "text/event-stream" },
            });
          },
        }),
      getAuth: async () => undefined,
      hasConfiguredAuth: () => true,
      checkAuth: async () => ({ ok: true }),
      isUsingOAuth: () => false,
      isUsingSubscription: () => false,
      getError: () => undefined,
      refresh: async () => undefined,
      getAvailableSnapshot: () => [model],
      getModel: () => model,
    };
    let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
    try {
      await loader.reload();
      ({ session } = await createAgentSession({
        cwd: root,
        agentDir: join(root, "agent"),
        modelRuntime: runtime as never,
        model,
        sessionManager: manager,
        settingsManager: settings,
        resourceLoader: loader,
        tools: [],
      }));
      await session.bindExtensions({ mode: "rpc" });
      await session.prompt("isolated fake P0");
      expect(fetches).toBe(1);
      expect(publicIndex).toBe(0);
      expect(final).toBe(turn);
      expect(typeof publicMid).toBe("string");
      expect(publicMid).not.toBe("");
      expect(appendAtTurn).toBe(positive);
      const metadata = manager
        .getBranch()
        .filter((e) => e.type === "custom" && e.customType === "subagent:web-msg-speed");
      expect(metadata).toHaveLength(positive ? 1 : 0);
      if (positive)
        expect((metadata[0] as { data: unknown }).data).toEqual({
          piToolkitGeneration: { v: 1, tokens: 10, genMs: 500, deltaCount: 2, mid: publicMid },
        });
      expect(
        manager.buildSessionContext().messages.some((m) => JSON.stringify(m).includes("piToolkitGeneration")),
      ).toBe(false);
    } finally {
      session?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
