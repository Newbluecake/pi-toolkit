import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { Socket } from "node:net";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

/**
 * Local OpenAI-compatible stub for the traffic conformance tests (T6).
 *
 * Serves the three endpoints the real pi-ai adapters call, all on 127.0.0.1:
 * - `POST …/chat/completions` (openai-completions SDK client)
 * - `POST …/responses` (openai-responses SDK client)
 * - `POST …/codex/responses` (openai-codex-responses SSE transport / SSE fallback)
 * - `ws(s)://…/codex/responses` upgrade (codex WebSocket transport) — the
 *   handshake headers are recorded and the socket destroyed so the adapter's
 *   real code falls back to SSE exactly as it does against a broken WS endpoint.
 *
 * Records raw request headers + body for every POST (including gzip/zstd
 * request bodies the codex adapter sends) but never prints either. Replies are
 * static SSE frames shaped for the real adapters' parsers.
 */
export interface OpenAIStubRequest {
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
  json: Record<string, unknown> | null;
}

export interface WsHandshake {
  url: string;
  headers: IncomingHttpHeaders;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  connection: "keep-alive",
  "cache-control": "no-cache",
} as const;

function sse(event: string, value: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
}

function data(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

/** openai-completions: one content delta with finish_reason + usage chunk + [DONE]. */
function completionsStream(text: string, index: number): string {
  const id = `chatcmpl-stub-${index}`;
  const base = { id, object: "chat.completion.chunk", model: "stub-model", created: 0 };
  return (
    data({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    }) +
    data({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    data({
      ...base,
      choices: [],
      usage: { prompt_tokens: 4096, completion_tokens: 4, total_tokens: 4100 },
    }) +
    "data: [DONE]\n\n"
  );
}

/** openai-responses / codex SSE: minimal message item with a text delta, then completed. */
function responsesStream(text: string, index: number): string {
  const id = `resp-stub-${index}`;
  const item = { type: "message", id: `msg-stub-${index}`, role: "assistant", status: "completed" };
  return (
    sse("response.created", { type: "response.created", response: { id, status: "in_progress" } }) +
    sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item }) +
    sse("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, delta: text }) +
    sse("response.output_text.done", { type: "response.output_text.done", output_index: 0, text }) +
    sse("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...item, content: [] },
    }) +
    sse("response.completed", {
      type: "response.completed",
      response: {
        id,
        status: "completed",
        output: [],
        usage: { input_tokens: 4096, input_tokens_details: { cached_tokens: 0 }, output_tokens: 4, total_tokens: 4100 },
      },
    })
  );
}

export class OpenAIStub {
  readonly requests: OpenAIStubRequest[] = [];
  readonly wsHandshakes: WsHandshake[] = [];
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly replyText: (index: number) => string;

  private constructor(replyText: (index: number) => string) {
    this.replyText = replyText;
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        const url = req.url ?? "/";
        let body = "";
        try {
          const encoding = String(req.headers["content-encoding"] ?? "").toLowerCase();
          if (encoding === "zstd") body = zstdDecompressSync(raw).toString("utf8");
          else if (encoding === "gzip") body = gunzipSync(raw).toString("utf8");
          else body = raw.toString("utf8");
        } catch {
          body = raw.toString("utf8");
        }
        let json: Record<string, unknown> | null = null;
        try {
          const parsed: unknown = JSON.parse(body);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
            json = parsed as Record<string, unknown>;
        } catch {
          json = null;
        }
        const index = this.requests.length;
        this.requests.push({ url, headers: req.headers, body, json });
        const stream = url.includes("/chat/completions")
          ? completionsStream(this.replyText(index), index)
          : responsesStream(this.replyText(index), index);
        res.writeHead(200, SSE_HEADERS);
        res.end(stream);
      });
    });
    // The codex WebSocket transport handshake: record the upgrade headers
    // (that is the whole point — whether the ticket header rides the WS
    // handshake), then destroy so the adapter's real fallback path runs.
    this.server.on("upgrade", (req, socket) => {
      this.wsHandshakes.push({ url: req.url ?? "/", headers: req.headers });
      socket.destroy();
    });
    this.server.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  static async start(options: { reply?: (index: number) => string } = {}): Promise<OpenAIStub> {
    const stub = new OpenAIStub(options.reply ?? (() => "openai stub answer"));
    await new Promise<void>((resolve, reject) => {
      stub.server.once("error", reject);
      stub.server.listen(0, "127.0.0.1", () => resolve());
    });
    return stub;
  }

  get baseUrl(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("OpenAI stub is not listening");
    return `http://127.0.0.1:${address.port}`;
  }

  async waitForRequests(count: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.requests.length < count && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    if (this.requests.length < count)
      throw new Error(`OpenAI stub received ${this.requests.length} requests; expected ${count}`);
  }

  async waitForHandshakes(count: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.wsHandshakes.length < count && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    if (this.wsHandshakes.length < count)
      throw new Error(`OpenAI stub saw ${this.wsHandshakes.length} WS handshakes; expected ${count}`);
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
