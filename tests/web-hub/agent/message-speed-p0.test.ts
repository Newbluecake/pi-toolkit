import { describe, expect, it, vi } from "vitest";
import { expectHidden } from "./message-speed-test-helpers.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as chatStream } from "@earendil-works/pi-ai/api/openai-completions";
import type { Model } from "@earendil-works/pi-ai";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { createEventTap } from "../../../src/web-hub/agent/event-tap.js";
import { createMessageSpeed } from "../../../src/web-hub/agent/message-speed.js";
import { wireMessageSpeed } from "../../../src/web-hub/agent/message-speed-wire.js";
import type { WireEvent } from "../../../src/web-hub/protocol/messages.js";

function harness(api = "openai-responses") {
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
  const end = vi.spyOn(speed, "end");
  const tap = createEventTap((e) => emitted.push(e), { speed, now: () => 0, setTimer: () => ({ cancel() {} }) });
  const wire = wireMessageSpeed(pi, speed, () => true);
  return {
    writes,
    emitted,
    tap,
    speed,
    end,
    forward: (e: Record<string, unknown> & { type: string }) => wire.forward(tap, e),
    raw: (data: unknown) =>
      handlers.get("provider_stream_event")!({
        provider: "openai",
        api,
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
    expect(h.end.mock.calls.at(-1)?.[0]).toMatchObject({ role: "assistant" });
    expectHidden(h.emitted, h.end.mock.results.at(-1)?.value, h.writes.length);
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

it.each([
  "positive",
  "missing",
  "nonzero",
  "summary",
  "late-done",
  "queued",
  "error-delta",
  "second-start",
  "R1-frames",
  "R1-batch",
  "R1-delayed",
])("P0 FULL public SDK session boundary %s: real turnIndex, final reference, real mid", async (mode) => {
  const positive = mode === "positive" || mode === "queued";
  const r1 = mode.startsWith("R1-");
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
  let appendAtTurn = 0;
  let endResult: unknown;
  let releaseCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });
  let releaseTail!: () => void;
  const tail = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  let deltaCount = 0;
  const trace: string[] = [];
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
            appendAtTurn++;
          },
        });
        const originalEnd = speed.end;
        speed.end = (message) => (endResult = originalEnd(message)) as ReturnType<typeof originalEnd>;
        const tap = createEventTap((e) => emitted.push(e), {
          speed,
          now: () => 0,
          setTimer: () => ({ cancel() {} }),
        });
        const wire = wireMessageSpeed(pi, speed, () => true);
        pi.on("provider_stream_event", async (event) => {
          const raw = event.data as { type?: string; delta?: string };
          if (r1) {
            trace.push(`raw-${raw.type}${raw.delta === " late" ? "-late" : ""}`);
            if (mode === "R1-delayed") await new Promise<void>((resolve) => queueMicrotask(resolve));
            trace.push(`release-${raw.type}${raw.delta === " late" ? "-late" : ""}`);
            if (raw.delta === " late") releaseTail();
          }
          if (raw.type === "response.completed") {
            trace.push("raw-completed");
            releaseCompletion();
          }
        });
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
          pi.on(type, async (event, c) => {
            current = c;
            if (event.type === "turn_start") publicIndex = event.turnIndex;
            if (r1 && event.type === "message_start" && event.message.role === "assistant") {
              trace.push("public-start-enter");
              if (mode === "R1-delayed") await tail;
              trace.push("public-start-forward");
            }
            if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
              deltaCount++;
              if (mode === "queued" && deltaCount === 2) {
                await completion;
                trace.push("second-delta-forward");
              }
              time += 500;
            }
            if (event.type === "message_end" && event.message.role === "assistant") {
              if (mode === "error-delta")
                wire.forward(tap, {
                  type: "message_update",
                  assistantMessageEvent: { type: "error" },
                  message: event.message,
                });
              if (mode === "second-start") wire.forward(tap, { type: "message_start", message: event.message });
            }
            if (event.type === "message_end" && event.message.role === "assistant") final = event.message;
            if (event.type === "turn_end") {
              turn = event.message;
              publicMid = event.messageEntryId;
              expect(appendAtTurn).toBe(0);
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
  if (r1)
    events.push({
      type: "response.output_text.delta",
      response_id: responseId,
      output_index: 0,
      content_index: 0,
      delta: " late",
    } as never);
  if (mode === "late-done")
    events.push({
      type: "response.output_text.done",
      response_id: responseId,
      output_index: 0,
      content_index: 0,
      text: "late",
    } as never);
  let fetches = 0;
  const runtime = {
    streamSimple: (m: Model<"openai-responses">, c: Parameters<typeof stream>[1], o: Parameters<typeof stream>[2]) =>
      stream(m, c, {
        ...o,
        apiKey: "fake-not-secret",
        maxRetries: 0,
        fetch: async () => {
          fetches++;
          const frames = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
          if (mode === "R1-frames") {
            let i = 0;
            return new Response(
              new ReadableStream({
                pull(controller) {
                  if (i < frames.length) {
                    trace.push(`frame-${i}`);
                    controller.enqueue(new TextEncoder().encode(frames[i++]));
                  } else {
                    trace.push("eof");
                    controller.close();
                  }
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          if (r1) trace.push("batch-response");
          return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
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
    expect(appendAtTurn).toBe(positive ? 1 : 0);
    if (!positive) expectHidden(emitted, endResult, appendAtTurn);
    expect(endResult).toEqual(positive ? { v: 1, tokens: 10, genMs: 500, deltaCount: 2 } : undefined);
    // The positive control has the same completed usage but no post-completion delta.
    if (mode === "positive" || r1) expect((final as { usage: { output: number } }).usage.output).toBe(10);
    if (mode === "queued") expect(trace.indexOf("raw-completed")).toBeLessThan(trace.indexOf("second-delta-forward"));
    if (r1) {
      const completedAt = trace.indexOf("release-response.completed");
      const lateAt = trace.indexOf("raw-response.output_text.delta-late");
      expect(completedAt).toBeGreaterThanOrEqual(0);
      expect(lateAt).toBeGreaterThan(completedAt);
      expect(trace.indexOf("release-response.output_text.delta-late")).toBeGreaterThan(lateAt);
      if (mode === "R1-frames") {
        expect(trace.filter((x) => x.startsWith("frame-"))).toHaveLength(events.length);
        expect(trace).toContain("eof");
      } else expect(trace).toContain("batch-response");
      if (mode === "R1-delayed")
        expect(trace.indexOf("public-start-forward")).toBeGreaterThan(
          trace.indexOf("release-response.output_text.delta-late"),
        );
      const result = final as { stopReason: string; content: Array<{ type: string; text?: string }> };
      expect(result.stopReason).toBe("stop");
      expect(
        result.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join(""),
      ).toBe("hello world late");
    }
    const metadata = manager
      .getBranch()
      .filter((e) => e.type === "custom" && e.customType === "subagent:web-msg-speed");
    expect(metadata).toHaveLength(positive ? 1 : 0);
    if (positive)
      expect((metadata[0] as { data: unknown }).data).toEqual({
        piToolkitGeneration: { v: 1, tokens: 10, genMs: 500, deltaCount: 2, mid: publicMid },
      });
    expect(manager.buildSessionContext().messages.some((m) => JSON.stringify(m).includes("piToolkitGeneration"))).toBe(
      false,
    );
  } finally {
    session?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

describe("P1 real completions SDK → tap → metadata", () => {
  it.each([
    "positive",
    "reasoning",
    "thinking",
    "changed id",
    "missing usage",
    "null usage",
    "mismatch",
    "empty",
    "tool round",
  ])("%s", async (mode) => {
    const h = harness("openai-completions");
    const chatModel: Model<"openai-completions"> = { ...model, api: "openai-completions" };
    const id = "chat_main";
    const chunk = (choices: unknown[], usage?: unknown, chunkId = id) => ({
      id: chunkId,
      object: "chat.completion.chunk",
      created: 1,
      model: chatModel.id,
      choices,
      ...(usage === undefined ? {} : { usage }),
    });
    const choice = (delta: object, finish_reason: string | null = null) => ({ index: 0, delta, finish_reason });
    const events = [
      chunk([choice({ role: "assistant" })], null),
      ...(mode === "empty"
        ? []
        : [
            chunk([choice(mode === "thinking" ? { reasoning_content: "think" } : { content: "hello " })]),
            chunk([choice({ content: "world" })], undefined, mode === "changed id" ? "other" : id),
          ]),
      chunk([choice({}, mode === "tool round" ? "tool_calls" : "stop")]),
      ...(mode === "missing usage"
        ? []
        : [
            chunk(
              [],
              mode === "null usage"
                ? null
                : {
                    prompt_tokens: 2,
                    completion_tokens: 10,
                    total_tokens: 12,
                    completion_tokens_details: { reasoning_tokens: mode === "reasoning" ? 5 : 0 },
                  },
            ),
          ]),
    ];
    let final: any;
    await runAgentLoop(
      [{ role: "user", content: "fake", timestamp: 0 }],
      { systemPrompt: "", messages: [], tools: [] },
      { model: chatModel, convertToLlm: (messages) => messages as never },
      (event) => {
        const e = event as unknown as Record<string, unknown> & { type: string };
        if (e.type === "turn_start") e.turnIndex = 0;
        if (
          e.type === "message_update" &&
          ["text_delta", "thinking_delta"].includes((e.assistantMessageEvent as { type: string }).type)
        )
          h.advance();
        if (e.type === "message_end" && (e.message as { role: string }).role === "assistant") {
          final = e.message;
          if (mode === "mismatch") final.usage.output = 9;
        }
        if (e.type === "turn_end") {
          e.turnIndex = 0;
          e.messageEntryId = "public-mid";
        }
        h.forward(e);
      },
      undefined,
      (m, c, o) =>
        chatStream(m as Model<"openai-completions">, c, {
          ...o,
          apiKey: "fake-not-secret",
          maxRetries: 0,
          fetch: async () =>
            new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", {
              headers: { "content-type": "text/event-stream" },
            }),
          onProviderStreamEvent: (data) => h.raw(data),
        }),
    );
    const positive = ["positive", "reasoning", "thinking"].includes(mode);
    const msg = h.emitted.findLast((e) => e.type === "message_end" && e.message?.role === "assistant")?.message;
    if (positive) {
      expect(msg?.piToolkitGeneration).toEqual({ v: 1, tokens: 10, genMs: 500, deltaCount: 2 });
      expect(h.writes).toHaveLength(1);
    } else {
      expect(h.end.mock.calls.at(-1)?.[0]).toMatchObject({ role: "assistant" });
      expectHidden(h.emitted, h.end.mock.results.at(-1)?.value, h.writes.length);
    }
    if (mode === "changed id") {
      expect(final.responseId).toBe(id);
      expect(final.stopReason).toBe("stop");
      expect(final.usage.output).toBe(10);
    }
    h.tap.dispose();
  });
});

describe("P1 rework full public Chat session scheduling", () => {
  it.each(["frames", "batch", "delayed"])(
    "%s: exact join, public mid, and independent warmer",
    async (schedule) => {
      for (const warmerAt of [
        "none",
        "before",
        "middle",
        "after",
        "getter",
        "changed-id",
        "error-delta",
        "second-start",
      ]) {
        const { mkdtempSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager } =
          await import("@earendil-works/pi-coding-agent");
        const root = mkdtempSync(join(tmpdir(), "speed-chat-full-"));
        const settings = SettingsManager.inMemory({
          cacheWarming: "off",
          compaction: { enabled: false },
          retry: { enabled: false },
        });
        const manager = SessionManager.inMemory(root);
        const emitted: WireEvent[] = [];
        const trace: string[] = [];
        let time = 0,
          writes = 0;
        let current: import("@earendil-works/pi-coding-agent").ExtensionContext | undefined;
        let getterCalls = 0;
        let endResult: unknown = Symbol("end not called"),
          final: unknown,
          turn: unknown,
          mid: unknown;
        const ownerToken = {},
          activationGeneration = {};
        let release!: () => void;
        const terminal = new Promise<void>((resolve) => {
          release = resolve;
        });
        const api = "openai-completions";
        const chatModel: Model<"openai-completions"> = { ...model, api };
        const id = "chat_full";
        const chunk = (choices: unknown[], usage?: unknown, chunkId = id) => ({
          id: chunkId,
          object: "chat.completion.chunk",
          created: 1,
          model: chatModel.id,
          choices,
          ...(usage === undefined ? {} : { usage }),
        });
        const choice = (delta: object, finish_reason: string | null = null) => ({ index: 0, delta, finish_reason });
        const frames = [
          chunk([choice({ role: "assistant" })]),
          chunk([choice({ content: "hello " })]),
          chunk([choice({ content: "world" })], undefined, warmerAt === "changed-id" ? "other" : id),
          chunk([choice({}, "stop")]),
          chunk([], { prompt_tokens: 2, completion_tokens: 10, total_tokens: 12 }),
        ];
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
                  writes++;
                  pi.appendEntry(type, data);
                },
              });
              const originalEnd = speed.end;
              speed.end = (message) => (endResult = originalEnd(message)) as ReturnType<typeof originalEnd>;
              const tap = createEventTap((e) => emitted.push(e), {
                speed,
                now: () => 0,
                setTimer: () => ({ cancel() {} }),
              });
              let rawIndex = 0;
              pi.on("provider_stream_event", async (event) => {
                // Delay the raw handler ahead of production; the SDK awaits each callback.
                trace.push(`raw${rawIndex}`);
                if (schedule === "delayed") await new Promise<void>((resolve) => queueMicrotask(resolve));
                trace.push(`raw-release${rawIndex}`);
                const at = rawIndex++;
                if (warmerAt === "getter" && at === 0) {
                  const choices = [{ index: 0 }];
                  Object.defineProperty(choices, "0", {
                    get() {
                      getterCalls++;
                      return { index: 0 };
                    },
                  });
                  speed.raw({ provider: "openai", api, model: chatModel.id, data: { id, choices } });
                }
                if (
                  (warmerAt === "before" && at === 0) ||
                  (warmerAt === "middle" && at === 2) ||
                  (warmerAt === "after" && at === 4)
                ) {
                  trace.push("independent-warmer");
                  const warmFrames = [
                    chunk([choice({ role: "assistant" })], undefined, "warmer"),
                    chunk([choice({ content: "warm" })], undefined, "warmer"),
                    chunk([choice({}, "stop")], undefined, "warmer"),
                    chunk([], { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, "warmer"),
                  ];
                  const warmer = chatStream(
                    chatModel,
                    { systemPrompt: "", messages: [], tools: [] },
                    {
                      apiKey: "fake-not-secret",
                      maxRetries: 0,
                      fetch: async () =>
                        new Response(
                          warmFrames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
                          { headers: { "content-type": "text/event-stream" } },
                        ),
                      onProviderStreamEvent: (data) => {
                        trace.push("warmer-raw");
                        speed.raw({ provider: "openai", api, model: chatModel.id, data });
                      },
                    },
                  );
                  await warmer.result();
                }
              });
              const wire = wireMessageSpeed(pi, speed, () => true);
              pi.on("provider_stream_event", () => {
                if (rawIndex === 5) release();
              });
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
              ] as const)
                pi.on(type, async (event, c) => {
                  current = c;
                  if (event.type === "message_start" && event.message.role === "assistant") {
                    trace.push("public-start-enter");
                    if (schedule === "delayed") await terminal;
                    trace.push("public-start-forward");
                  }
                  if (
                    event.type === "message_update" &&
                    ["text_delta", "thinking_delta"].includes(event.assistantMessageEvent.type)
                  )
                    time += 500;
                  if (event.type === "message_end" && event.message.role === "assistant") {
                    final = event.message;
                    if (warmerAt === "second-start")
                      wire.forward(tap, { type: "message_start", message: event.message });
                    if (warmerAt === "error-delta")
                      wire.forward(tap, {
                        type: "message_update",
                        assistantMessageEvent: { type: "error" },
                        message: event.message,
                      });
                  }
                  if (event.type === "turn_end") {
                    turn = event.message;
                    mid = event.messageEntryId;
                  }
                  wire.forward(tap, event as unknown as Record<string, unknown> & { type: string });
                });
            },
          ],
        });
        const encoded = frames.map((e) => `data: ${JSON.stringify(e)}\n\n`).concat("data: [DONE]\n\n");
        const runtime = {
          streamSimple: (
            m: Model<"openai-completions">,
            c: Parameters<typeof chatStream>[1],
            o: Parameters<typeof chatStream>[2],
          ) =>
            chatStream(m, c, {
              ...o,
              apiKey: "fake-not-secret",
              maxRetries: 0,
              fetch: async () => {
                if (schedule !== "frames")
                  return new Response(encoded.join(""), { headers: { "content-type": "text/event-stream" } });
                let i = 0;
                return new Response(
                  new ReadableStream({
                    pull(controller) {
                      if (i < encoded.length) controller.enqueue(new TextEncoder().encode(encoded[i++]));
                      else controller.close();
                    },
                  }),
                  { headers: { "content-type": "text/event-stream" } },
                );
              },
            }),
          getAuth: async () => undefined,
          hasConfiguredAuth: () => true,
          checkAuth: () => ({ ok: true }),
          isUsingOAuth: () => false,
          isUsingSubscription: () => false,
          getError: () => undefined,
          refresh: async () => undefined,
          getAvailableSnapshot: () => [chatModel],
          getModel: () => chatModel,
        };
        let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
        try {
          await loader.reload();
          ({ session } = await createAgentSession({
            cwd: root,
            agentDir: join(root, "agent"),
            modelRuntime: runtime as never,
            model: chatModel,
            sessionManager: manager,
            settingsManager: settings,
            resourceLoader: loader,
            tools: [],
          }));
          await session.bindExtensions({ mode: "rpc" });
          await session.prompt("fake chat");
          expect(final).toBe(turn);
          expect(typeof mid).toBe("string");
          expect((final as { responseId: string; usage: { output: number }; stopReason: string }).responseId).toBe(id);
          expect((final as { usage: { output: number } }).usage.output).toBe(10);
          const expected = warmerAt === "none" ? { v: 1, tokens: 10, genMs: 500, deltaCount: 2 } : undefined;
          expect(endResult).toEqual(expected);
          expect(
            emitted.findLast((e) => e.type === "message_end" && e.message?.role === "assistant")?.message
              ?.piToolkitGeneration,
          ).toEqual(expected);
          if (warmerAt !== "none") expectHidden(emitted, endResult, writes);
          expect(writes).toBe(warmerAt === "none" ? 1 : 0);
          expect(
            manager.getBranch().filter((e) => e.type === "custom" && e.customType === "subagent:web-msg-speed"),
          ).toHaveLength(writes);
          if (schedule === "delayed") {
            expect(trace.indexOf("raw-release4")).toBeLessThan(trace.indexOf("public-start-forward"));
            for (let i = 0; i < 4; i++)
              expect(trace.indexOf(`raw-release${i}`)).toBeLessThan(trace.indexOf(`raw${i + 1}`));
          }
          if (["before", "middle", "after"].includes(warmerAt)) {
            expect(trace).toContain("independent-warmer");
            expect(trace.filter((x) => x === "warmer-raw")).toHaveLength(4);
          }
          expect(getterCalls).toBe(0);
        } finally {
          session?.dispose();
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
    30000,
  );
});
