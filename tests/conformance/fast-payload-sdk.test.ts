/** Actual pi-ai 1.5 constructors and their final serialized transports. No credentials/network.
 * The fetch and WebSocket endpoints accept ONLY numeric loopback. Socket connect is forbidden,
 * so an accidental SDK escape cannot hit a real model, proxy, DNS or external WebSocket.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as commonStream, streamSimple as commonSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as azureStream } from "@earendil-works/pi-ai/api/azure-openai-responses";
import {
  stream as codexStream,
  closeOpenAICodexWebSocketSessions,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { Api, Model, TranscriptContext, Tool, AssistantMessage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { FastMode } from "../../src/core/types.js";
import { classifyResponsesPayload, rewriteFastPayload } from "../../src/fast/payload.js";

type Body = Record<string, unknown>;
const sdkRoot = (createRequire(import.meta.url).resolve.paths("@earendil-works/pi-ai") ?? [])
  .map((p) => join(p, "@earendil-works/pi-ai"))
  .find((p) => existsSync(join(p, "package.json")))!;
const actualSDK = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")) as { version: string };
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
const terminal = {
  type: "response.completed",
  response: {
    id: "resp_local",
    status: "completed",
    output: [],
    usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
  },
};
const events = [{ type: "response.created", response: { id: "resp_local" } }, terminal];
function loopback(url: string) {
  const u = new URL(url);
  if (!["127.0.0.1", "[::1]"].includes(u.hostname)) throw Error("Non-loopback transport forbidden");
}
// An unmistakably fake unsigned token; the SDK only extracts this local claim. Never sent remotely.
const fakeToken = `fake.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "FAKE_LOCAL_ONLY" } })).toString("base64url")}.fake`;
const functionTool: Tool = {
  name: "f",
  description: "local function",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
const grammarTool: Tool = {
  name: "g",
  description: "local grammar",
  parameters: {
    type: "object",
    properties: { input: { type: "string" } },
    required: ["input"],
    additionalProperties: false,
  },
  constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /a/" } },
};
type ResponsesApi = "openai-responses" | "azure-openai-responses" | "openai-codex-responses";
function model<A extends ResponsesApi>(api: A, variant?: string): Model<A>;
function model(api: ResponsesApi, variant = "basic"): Model<ResponsesApi> {
  return {
    id: "unlisted-model",
    api,
    provider: "unlisted-provider",
    name: "local",
    baseUrl: "http://127.0.0.1:19455/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000,
    maxTokens: 1024,
    samplingParams: { service_tier: "flex", top_p: 0.8 },
    compat: {
      supportsOpenAIGrammarTools: true,
      supportsStrictMode: true,
      supportsMidConvoSystemMessages: true,
      supportsAdditionalTools: variant === "changes",
      supportsToolSearch: variant === "search",
      supportsMidConvoEffort: variant === "config",
    },
  };
}
function context(api: Api, variant: string): TranscriptContext {
  if (variant === "warm") return normalizeContext({ messages: [] });
  const prior: AssistantMessage = {
    role: "assistant",
    provider: "unlisted-provider",
    api,
    model: "unlisted-model",
    timestamp: 0,
    stopReason: "toolUse",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [
      {
        type: "thinking",
        thinking: "private",
        thinkingSignature: JSON.stringify({
          type: "reasoning",
          id: "rs_local",
          summary: [{ type: "summary_text", text: "local" }],
          encrypted_content: "opaque",
        }),
      },
      { type: "text", text: "local" },
      { type: "toolCall", id: "call_f|fc_local", name: "f", arguments: {} },
      { type: "toolCall", id: "call_g|ctc_local", name: "g", arguments: { input: "a" } },
    ],
  };
  return normalizeContext({
    messages: [
      { role: "system", content: "local system", toolsAdded: [functionTool, grammarTool], timestamp: 0 },
      {
        role: "user",
        content: [
          { type: "text", text: "local" },
          { type: "image", mimeType: "image/png", data: "AA==" },
        ],
        timestamp: 0,
      },
      prior,
      {
        role: "toolResult",
        toolCallId: "call_f|fc_local",
        toolName: "f",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "call_g|ctc_local",
        toolName: "g",
        content: [
          { type: "text", text: "ok" },
          { type: "image", mimeType: "image/png", data: "AA==" },
        ],
        isError: false,
        timestamp: 0,
      },
      { role: "system", content: "updated", toolsAdded: [{ ...functionTool, name: "later" }], timestamp: 1 },
    ],
  });
}

let responseEvents: object[] = events;
let httpBodies: Body[] = [];
let wsBodies: Body[] = [];
const localFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  loopback(request.url);
  const bytes = await request.arrayBuffer();
  // Node 22 has no zstd; Node 24+ SDK may compress Codex requests.
  let text: string;
  if (request.headers.get("content-encoding") === "zstd") {
    const zlib = await import("node:zlib");
    text = (zlib as unknown as { zstdDecompressSync(b: Uint8Array): Buffer })
      .zstdDecompressSync(new Uint8Array(bytes))
      .toString();
  } else text = new TextDecoder().decode(bytes);
  httpBodies.push(JSON.parse(text) as Body);
  return new Response(
    responseEvents.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
};
class LocalWebSocket extends EventTarget {
  readyState = 0;
  constructor(url: string) {
    super();
    loopback(url);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }
  send(text: string) {
    wsBodies.push(JSON.parse(text) as Body);
    setImmediate(() => {
      for (const e of responseEvents) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(e) }));
    });
  }
  close() {
    this.readyState = 3;
  }
}
beforeEach(() => {
  responseEvents = events;
  httpBodies = [];
  wsBodies = [];
  // Hard deny sockets (including any proxy); all transport here must remain in-process.
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw Error("Real sockets forbidden in Fast corpus");
  });
  vi.stubGlobal("fetch", localFetch);
  vi.stubGlobal("WebSocket", LocalWebSocket);
});
afterEach(() => {
  closeOpenAICodexWebSocketSessions();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function run(
  api: "openai-responses" | "azure-openai-responses" | "openai-codex-responses",
  mode: FastMode,
  variant: string,
  ws = false,
  simple = false,
  replay?: AssistantMessage,
) {
  const m = model(api, variant);
  deepFreeze(m);
  const before = JSON.stringify(m);
  let original: Body | undefined;
  let replacement: unknown;
  const options = {
    apiKey: api === "openai-codex-responses" ? fakeToken : "FAKE_LOCAL_ONLY",
    env: {},
    fetch: localFetch,
    maxRetries: 0,
    transport: ws ? ("websocket" as const) : ("sse" as const),
    reasoningEffort: "high" as const,
    reasoning: "high" as const,
    maxTokens: 256,
    azureDeploymentName: "different-deployment",
    azureBaseUrl: "http://127.0.0.1:19455/v1",
    timeoutMs: 2000,
    websocketConnectTimeoutMs: 2000,
    onPayload: (p: unknown) => {
      original = p as Body;
      expect(classifyResponsesPayload(p).kind).toBe("responses");
      // Preserve all nested references and a fully frozen original through the rewrite.
      deepFreeze(p);
      const result = rewriteFastPayload(p, { mode, revision: 17, incarnation: {} });
      if (result?.kind === "applied") {
        replacement = result.replacement;
        expect(result.replacement.input).toBe(original.input);
        expect(result.replacement.reasoning).toBe(original.reasoning);
        return result.replacement;
      }
      expect(result).toBeUndefined();
      return undefined;
    },
  };
  const ctx = replay
    ? normalizeContext({ messages: [replay, { role: "user", content: "fixture", timestamp: 1 }] })
    : context(api, variant);
  const stream =
    api === "openai-responses"
      ? simple
        ? commonSimple(m as Model<"openai-responses">, ctx, options)
        : commonStream(m as Model<"openai-responses">, ctx, options)
      : api === "azure-openai-responses"
        ? azureStream(m as Model<"azure-openai-responses">, ctx, options)
        : codexStream(m as Model<"openai-codex-responses">, ctx, options);
  const output = await stream.result();
  expect(output.stopReason, output.errorMessage).toBe("stop");
  expect(original).toBeDefined();
  expect(JSON.stringify(m)).toBe(before);
  expect(httpBodies.length + wsBodies.length).toBe(1);
  expect(wsBodies.length).toBe(ws ? 1 : 0);
  const final = (ws ? wsBodies[0] : httpBodies[0])!;
  const { type, ...wsBody } = final;
  const actual = ws ? wsBody : final;
  if (ws) expect(type).toBe("response.create");
  expect(actual).toEqual(JSON.parse(JSON.stringify(mode === "inherit" ? original : replacement)));
  if (mode !== "inherit") expect(actual.service_tier).toBe(mode === "on" ? "priority" : "default");
  else {
    expect(replacement).toBeUndefined();
    expect(JSON.stringify(actual)).toBe(JSON.stringify(original));
  }
  if (api === "azure-openai-responses") expect(actual.model).toBe("different-deployment");
  expect(actual.reasoning).toEqual(original!.reasoning);
  return actual;
}

describe("Fast real SDK 1.5 final body corpus", () => {
  it("uses the actual installed 1.5 SDK, not the baseline package declaration", () => {
    expect(Number(actualSDK.version.split(".")[0])).toBeGreaterThanOrEqual(1);
    if (actualSDK.version.startsWith("1.")) expect(Number(actualSDK.version.split(".")[1])).toBeGreaterThanOrEqual(5);
    console.info("FAST_PAYLOAD_SDK", actualSDK.version);
  });
  for (const api of ["openai-responses", "azure-openai-responses", "openai-codex-responses"] as const)
    for (const mode of ["inherit", "on", "off"] as const)
      for (const variant of ["basic", "changes", "search", "config", "warm"])
        it(`${api} ${mode} ${variant} SSE`, async () => {
          const final = await run(api, mode, variant);
          const input = final.input as Body[];
          if (variant === "warm") expect(input).toEqual([]);
          if (variant === "changes") expect(input.some((i) => i.type === "additional_tools")).toBe(true);
          if (variant === "search") expect(input.some((i) => i.type === "tool_search_call")).toBe(true);
          if (variant === "config" && api === "openai-responses")
            expect(input.some((i) => i.type === "configuration_update")).toBe(true);
        });
  for (const mode of ["inherit", "on", "off"] as const)
    for (const variant of ["basic", "changes", "search", "config", "warm"])
      it(`Codex ${mode} ${variant} controlled WebSocket final frame`, async () => {
        await run("openai-codex-responses", mode, variant, true);
      });
  for (const mode of ["inherit", "on", "off"] as const)
    it(`streamSimple ${mode} preserves callback after model/thinking/request merge`, async () => {
      const final = await run("openai-responses", mode, "basic", false, true);
      expect(final.max_output_tokens).toBe(256);
    });
  it("network guard rejects external destinations without creating a socket", async () => {
    expect(() => loopback("https://example.com/v1")).toThrow("Non-loopback");
    await expect(localFetch("https://example.com/v1", { method: "POST", body: "{}" })).rejects.toThrow("Non-loopback");
    expect(() => new LocalWebSocket("wss://example.com/v1")).toThrow("Non-loopback");
    const socket = new Socket();
    expect(() => socket.connect(443, "example.com")).toThrow("Real sockets forbidden");
    socket.destroy();
    expect(httpBodies).toEqual([]);
    expect(wsBodies).toEqual([]);
  });
});
it.each([{ messages: [] }, { unrecognized_sdk_extension: true }])(
  "unsupported real constructor body continues once without Fast overwrite or retry: %s",
  async (extra) => {
    const m = model("openai-responses");
    const fakeCtx = { model: { api: "anthropic-messages", id: "fake-selection" } }; // Selection is a different API/model, not evidence for this request.
    expect(fakeCtx.model.api).not.toBe(m.api);
    let observed: unknown;
    const output = await commonStream(m, context(m.api, "basic"), {
      apiKey: "FAKE_LOCAL_ONLY",
      env: {},
      fetch: localFetch,
      maxRetries: 0,
      samplingParams: extra,
      onPayload: (p) => {
        observed = rewriteFastPayload(p, { mode: "on", revision: 1, incarnation: {} });
        expect(observed).toMatchObject({ kind: "unsupported" });
        // This is exactly the integration behavior: return undefined, don't throw to fake a block.
        return undefined;
      },
    }).result();
    expect(output.stopReason, output.errorMessage).toBe("stop");
    expect(httpBodies).toHaveLength(1);
    expect(wsBodies).toHaveLength(0);
    expect(httpBodies[0]).toMatchObject({ ...extra, service_tier: "flex" });
    expect(observed).toEqual({
      kind: "unsupported",
      reason: "messages" in extra ? "mixed-protocol" : "unknown-root-field",
    });
  },
);

// Exercise SDK receive -> thinkingSignature -> SDK replay, not a fabricated helper payload.
for (const api of ["openai-responses", "openai-codex-responses"] as const)
  for (const mode of ["inherit", "on", "off"] as const)
    for (const ws of api === "openai-codex-responses" ? [false, true] : [false])
      it(`SDK raw reasoning receive/replay ${api} ${mode} ${ws ? "WS" : "SSE"}`, async () => {
        const raw = {
          type: "reasoning",
          id: "rs_fixture",
          summary: [],
          content: [{ type: "reasoning_text", text: "fixture" }],
          status: null,
          encrypted_content: null,
        };
        responseEvents = [
          events[0]!,
          { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: raw.id, summary: [] } },
          { type: "response.output_item.done", output_index: 0, item: raw },
          { ...terminal, response: { ...terminal.response, output: [raw] } },
        ];
        const m = model(api);
        const options = {
          apiKey: api === "openai-codex-responses" ? fakeToken : "FAKE_LOCAL_ONLY",
          env: {},
          fetch: localFetch,
          maxRetries: 0,
          transport: "sse" as const,
        };
        const received = await (
          api === "openai-responses"
            ? commonStream(m as Model<"openai-responses">, normalizeContext({ messages: [] }), options)
            : codexStream(m as Model<"openai-codex-responses">, normalizeContext({ messages: [] }), options)
        ).result();
        expect(received.stopReason, received.errorMessage).toBe("stop");
        expect(received.content).toEqual([
          { type: "thinking", thinking: "fixture", thinkingSignature: JSON.stringify(raw) },
        ]);
        expect(httpBodies).toHaveLength(1);
        httpBodies = [];
        responseEvents = events;
        const final = await run(api, mode, "basic", ws, false, received);
        expect((final.input as Body[]).find((i) => i.type === "reasoning")).toEqual(raw);
        expect(final.service_tier).toBe(
          mode === "inherit"
            ? api === "openai-responses"
              ? "flex"
              : undefined
            : mode === "on"
              ? "priority"
              : "default",
        );
        expect(final.reasoning).toMatchObject({ effort: "high" });
      });
