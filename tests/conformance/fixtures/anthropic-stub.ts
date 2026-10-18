import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { Socket } from "node:net";

export interface StubRequest {
  body: string;
  json: Record<string, unknown>;
  headers: IncomingHttpHeaders;
  method?: string;
  url?: string;
  responseUsage?: StubUsage;
}

export type StubReply =
  | { kind: "text"; text: string; usage?: Partial<StubUsage> }
  | { kind: "tool"; calls: StubToolCall[]; usage?: Partial<StubUsage> };

export interface StubToolCall {
  name: string;
  input?: Record<string, unknown>;
  id?: string;
}

export interface StubUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/**
 * Per-request transport script (checked BEFORE `reply`). `undefined` ⇒ the normal 200 SSE reply.
 * Every request is appended to `requests` (headers + raw body) before its directive runs, so a 400 /
 * stalled POST is still visible in the POST log.
 */
export type StubDirective =
  /** Answer with a non-2xx Anthropic-shaped JSON error (e.g. the strict-tools 400). */
  | { kind: "error"; status: number; type?: string; message: string }
  /** Accept the request and never send any response bytes. */
  | { kind: "hang" }
  /** Send 200 SSE headers (+ optional partial body, e.g. a newline-less flood) and never end. */
  | { kind: "stall-after-headers"; chunk?: string };

export interface AnthropicStubOptions {
  /** Scriptable failures/stalls per request index; see {@link StubDirective}. */
  respond?: (request: StubRequest, index: number) => StubDirective | undefined | Promise<StubDirective | undefined>;
  reply?: (request: StubRequest, index: number) => StubReply | Promise<StubReply>;
  /** Deterministic, local-only cache: prefix bytes, explicit writes and <=20-block lookback reads.
   * Not a claim about Anthropic minimum lengths, billing, TTL survival or relay behaviour. */
  promptCache?: boolean;
}

const DEFAULT_USAGE: StubUsage = {
  input_tokens: 100,
  output_tokens: 10,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function sse(event: string, value: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
}

function streamFor(reply: StubReply, model: string, index: number): string {
  const usage = { ...DEFAULT_USAGE, ...reply.usage };
  const content =
    reply.kind === "text"
      ? [{ type: "text", text: reply.text }]
      : reply.calls.map((call) => ({
          type: "tool_use",
          id: call.id ?? `stub-tool-${index}-${call.name}`,
          name: call.name,
          input: call.input ?? {},
        }));
  const stopReason = reply.kind === "tool" ? "tool_use" : "end_turn";
  let result = sse("message_start", {
    type: "message_start",
    message: {
      id: `msg_stub_${index}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
  content.forEach((block, contentIndex) => {
    const startBlock = block.type === "tool_use" ? { ...block, input: {} } : block;
    result += sse("content_block_start", {
      type: "content_block_start",
      index: contentIndex,
      content_block: startBlock,
    });
    if (block.type === "tool_use") {
      result += sse("content_block_delta", {
        type: "content_block_delta",
        index: contentIndex,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
      });
    }
    result += sse("content_block_stop", { type: "content_block_stop", index: contentIndex });
  });
  result += sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });
  result += sse("message_stop", { type: "message_stop" });
  return result;
}

/**
 * A deliberately small Anthropic Messages HTTP boundary. It records raw
 * request bytes and headers, but never prints either (in particular, auth
 * headers stay in memory only). The real pi-ai anthropic-messages adapter is
 * used by the conformance tests; this server only supplies its streaming
 * response.
 */
export class AnthropicStub {
  readonly requests: StubRequest[] = [];
  private readonly server: Server;
  private readonly reply: (request: StubRequest, index: number) => StubReply | Promise<StubReply>;
  private listening: Promise<void>;
  private readonly cache = new Map<string, number>();
  private readonly sockets = new Set<Socket>();

  private cacheUsage(body: Record<string, unknown>): StubUsage {
    const clean = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(clean);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== "cache_control")
            .map(([key, v]) => [key, clean(v)]),
        );
      return value;
    };
    // Include role/message boundaries as well as block bytes. Keep cache_control
    // out of the identity, exactly as relative breakpoint comparison does.
    const prefix: unknown[] = [body.model];
    const blocks: Array<{ key: string; tokens: number; marked: boolean }> = [];
    const add = (kind: string, value: Record<string, unknown>) => {
      prefix.push([kind, clean(value)]);
      const bytes = JSON.stringify(prefix);
      blocks.push({
        key: createHash("sha256").update(bytes).digest("hex"),
        tokens: Math.ceil(bytes.length / 4),
        marked: value.cache_control !== undefined,
      });
    };
    for (const tool of (body.tools ?? []) as Record<string, unknown>[]) add("tool", tool);
    for (const system of (body.system ?? []) as Record<string, unknown>[]) add("system", system);
    for (const message of (body.messages ?? []) as Array<{ role: string; content: Record<string, unknown>[] }>) {
      prefix.push(["role", message.role]);
      for (const block of message.content) add("message", block);
    }
    let read = 0;
    let cachedThrough = 0;
    blocks.forEach((block, index) => {
      if (!block.marked) return;
      cachedThrough = block.tokens;
      for (const candidate of blocks.slice(Math.max(0, index - 19), index + 1))
        read = Math.max(read, this.cache.get(candidate.key) ?? 0);
    });
    for (const block of blocks) if (block.marked) this.cache.set(block.key, block.tokens);
    const total = blocks.at(-1)?.tokens ?? 0;
    return {
      input_tokens: Math.max(0, total - cachedThrough),
      output_tokens: 10,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: Math.max(0, cachedThrough - read),
    };
  }

  private constructor(options: AnthropicStubOptions = {}) {
    this.reply = options.reply ?? (() => ({ kind: "text", text: "stub answer" }));
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(body);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("body is not an object");
          json = parsed as Record<string, unknown>;
        } catch (error) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: String(error) } }));
          return;
        }
        const request: StubRequest = {
          body,
          json,
          headers: req.headers,
          ...(req.method === undefined ? {} : { method: req.method }),
          ...(req.url === undefined ? {} : { url: req.url }),
        };
        this.requests.push(request);
        const index = this.requests.length - 1;
        const directive = await options.respond?.(request, index);
        if (directive?.kind === "error") {
          res.writeHead(directive.status, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              type: "error",
              error: { type: directive.type ?? "invalid_request_error", message: directive.message },
            }),
          );
          return;
        }
        if (directive?.kind === "hang") return;
        if (directive?.kind === "stall-after-headers") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            connection: "keep-alive",
            "cache-control": "no-cache",
          });
          res.flushHeaders();
          if (directive.chunk !== undefined) res.write(directive.chunk);
          return;
        }
        const scripted = await this.reply(request, index);
        const usage = { ...(options.promptCache ? this.cacheUsage(json) : DEFAULT_USAGE), ...scripted.usage };
        request.responseUsage = usage;
        const reply = { ...scripted, usage };
        const model = typeof json.model === "string" ? json.model : "stub-model";
        res.writeHead(200, {
          "content-type": "text/event-stream",
          connection: "keep-alive",
          "cache-control": "no-cache",
        });
        res.end(streamFor(reply, model, index));
      });
    });
    this.server.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    this.listening = new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
  }

  static async start(options: AnthropicStubOptions = {}): Promise<AnthropicStub> {
    const stub = new AnthropicStub(options);
    await stub.listening;
    return stub;
  }

  get baseUrl(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Anthropic stub is not listening");
    return `http://127.0.0.1:${address.port}`;
  }

  async waitForRequests(count: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.requests.length < count && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    if (this.requests.length < count)
      throw new Error(`Anthropic stub received ${this.requests.length} requests; expected ${count}`);
  }

  async close(): Promise<void> {
    // Stalled/hung scripted requests never end on their own; drop their sockets so close() settles.
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
