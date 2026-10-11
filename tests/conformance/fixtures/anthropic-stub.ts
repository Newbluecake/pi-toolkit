import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

export interface StubRequest {
  body: string;
  json: Record<string, unknown>;
  headers: IncomingHttpHeaders;
  method?: string;
  url?: string;
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

export interface AnthropicStubOptions {
  reply?: (request: StubRequest, index: number) => StubReply;
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
  private readonly reply: (request: StubRequest, index: number) => StubReply;
  private listening: Promise<void>;

  private constructor(options: AnthropicStubOptions = {}) {
    this.reply = options.reply ?? (() => ({ kind: "text", text: "stub answer" }));
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
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
        const reply = this.reply(request, this.requests.length - 1);
        const model = typeof json.model === "string" ? json.model : "stub-model";
        res.writeHead(200, {
          "content-type": "text/event-stream",
          connection: "keep-alive",
          "cache-control": "no-cache",
        });
        res.end(streamFor(reply, model, this.requests.length - 1));
      });
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
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
