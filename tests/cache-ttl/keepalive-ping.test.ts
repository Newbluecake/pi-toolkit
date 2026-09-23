import { describe, expect, it, vi } from "vitest";
import {
  buildPingRequest,
  preparePingPayload,
  redactSecrets,
  sendKeepalivePing,
  type PingRequest,
} from "../../src/cache-ttl/ping-client.js";

const encoder = new TextEncoder();

/** A duck-typed reader compatible with what ping-client expects from `res.body.getReader()`. */
interface FakeReader {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: (reason?: unknown) => Promise<void>;
}

function chunkedReader(chunks: string[]): FakeReader & { cancelSpy: ReturnType<typeof vi.fn> } {
  let index = 0;
  const cancelSpy = vi.fn(async () => {});
  return {
    cancelSpy,
    cancel: cancelSpy,
    read: async () => {
      if (index < chunks.length) {
        const value = encoder.encode(chunks[index]);
        index += 1;
        return { done: false, value };
      }
      return { done: true, value: undefined };
    },
  };
}

/** Fake `Response` carrying a duck-typed streaming body. */
function fakeResponse(opts: { ok?: boolean; status?: number; reader?: FakeReader; text?: string }): Response {
  const { ok = true, status = 200, reader, text = "" } = opts;
  return {
    ok,
    status,
    body: reader ? { getReader: () => reader } : undefined,
    text: async () => text,
  } as unknown as Response;
}

function fetchResolvingWith(response: Response): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

/** fetchImpl that hangs until the request's AbortSignal fires, then rejects (no headers ever received). */
function fetchHangingOnConnect(): { fetchImpl: typeof fetch; calls: unknown[] } {
  const calls: unknown[] = [];
  const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
    calls.push(init);
    const signal = init?.signal;
    return new Promise((_resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** fetchImpl that resolves headers immediately, then hangs on body reads until aborted. */
function fetchHangingOnBody(): { fetchImpl: typeof fetch; cancelSpy: ReturnType<typeof vi.fn> } {
  const cancelSpy = vi.fn(async () => {});
  const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    const reader: FakeReader = {
      cancel: cancelSpy,
      read: () =>
        new Promise((_resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
    };
    return Promise.resolve(fakeResponse({ reader }));
  }) as unknown as typeof fetch;
  return { fetchImpl, cancelSpy };
}

const SAMPLE_REQUEST: PingRequest = {
  url: "https://api.example.com/v1/messages",
  headers: { "content-type": "application/json" },
  body: { model: "claude-x", messages: [], stream: true, max_tokens: 1 },
};

function sseLine(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n`;
}

describe("preparePingPayload", () => {
  it("forces max_tokens: 1 when thinking is not active, replays everything else byte-for-byte (I-K1)", () => {
    const captured = {
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
      temperature: 0.5,
      stream: true,
      system: "sys",
      tools: [{ name: "t" }],
      metadata: { user_id: "u1" },
      tool_choice: { type: "auto" },
    };
    const result = preparePingPayload(captured);
    const expected = { ...captured, max_tokens: 1 };
    expect(result).toEqual(expected);
    // deep-compare every field except max_tokens is *identical*, not just equal shape.
    const { max_tokens: _resultMaxTokens, ...resultRest } = result;
    const { max_tokens: _capturedMaxTokens, ...capturedRest } = captured;
    expect(resultRest).toEqual(capturedRest);
  });

  it("leaves max_tokens untouched and thinking intact when thinking is active", () => {
    const thinking = { type: "enabled", budget_tokens: 2048 };
    const captured = { model: "x", messages: [], max_tokens: 4096, thinking, stream: true };
    const result = preparePingPayload(captured);
    expect(result.max_tokens).toBe(4096);
    expect(result.thinking).toBe(thinking);
    expect(result).toEqual(captured);
  });

  it("still forces max_tokens: 1 when thinking is explicitly disabled", () => {
    const captured = { model: "x", messages: [], max_tokens: 4096, thinking: { type: "disabled" }, stream: true };
    const result = preparePingPayload(captured);
    expect(result.max_tokens).toBe(1);
  });

  it("does not mutate the input object", () => {
    const captured = { model: "x", messages: [], max_tokens: 4096, stream: true };
    const original = structuredClone(captured);
    preparePingPayload(captured);
    expect(captured).toEqual(original);
  });

  it("B1: never writes/rewrites `stream` — a false value is replayed verbatim, not forced to true", () => {
    const captured = { model: "x", messages: [], max_tokens: 4096, stream: false };
    const result = preparePingPayload(captured);
    expect(result.stream).toBe(false);
  });

  it("B1: never adds `stream` when the captured payload never had it", () => {
    const captured = { model: "x", messages: [], max_tokens: 4096 };
    const result = preparePingPayload(captured);
    expect("stream" in result).toBe(false);
  });
});

describe("buildPingRequest", () => {
  const body = { model: "x", messages: [] };

  it("strips trailing slash and appends /v1/messages", () => {
    const { request } = buildPingRequest(body, "https://api.anthropic.com/", {});
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("replays captured headers verbatim, without any hand-assembled baseline", () => {
    const captured = { "content-type": "application/json", "anthropic-beta": "some-real-beta-from-the-request" };
    const { request, headerSource, filledAuthKeys } = buildPingRequest(body, "https://api.anthropic.com", captured);
    expect(request.headers).toEqual(captured);
    expect(request.headers).not.toBe(captured); // defensive copy, not aliasing
    expect(headerSource).toBe("captured");
    expect(filledAuthKeys).toEqual([]);
  });

  it("never hardcodes anthropic-beta — an absent captured beta stays absent", () => {
    const { request } = buildPingRequest(body, "https://api.anthropic.com", { "content-type": "application/json" });
    expect(request.headers["anthropic-beta"]).toBeUndefined();
  });

  it("fills in a missing x-api-key from auth fallback without touching other captured keys", () => {
    const captured = { "content-type": "application/json" };
    const { request, headerSource, filledAuthKeys } = buildPingRequest(body, "https://api.anthropic.com", captured, {
      apiKey: "sk-ant-api03-abc",
    });
    expect(request.headers["x-api-key"]).toBe("sk-ant-api03-abc");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(headerSource).toBe("captured+auth-filled");
    expect(filledAuthKeys).toEqual(["x-api-key"]);
  });

  it("fills in Bearer + auth.headers for a missing OAuth token, never adding claude-code identity headers", () => {
    const { request } = buildPingRequest(body, "https://api.anthropic.com", {}, { apiKey: "sk-ant-oat01-xyz" });
    expect(request.headers.authorization).toBe("Bearer sk-ant-oat01-xyz");
    expect(request.headers["anthropic-beta"]).toBeUndefined();
    expect(request.headers["user-agent"]).toBeUndefined();
    expect(request.headers["x-app"]).toBeUndefined();
    expect(request.headers["x-api-key"]).toBeUndefined();
  });

  it("NEVER overrides an already-captured key with the auth fallback, even when the fallback carries the same key", () => {
    const captured = { authorization: "Bearer captured-value", "x-model": "m" };
    const { request, headerSource, filledAuthKeys } = buildPingRequest(body, "https://api.anthropic.com", captured, {
      apiKey: "sk-ant-api03-abc",
      headers: { authorization: "Bearer should-not-win", "x-auth": "a" },
    });
    expect(request.headers.authorization).toBe("Bearer captured-value"); // captured wins, never overwritten
    expect(request.headers["x-model"]).toBe("m");
    expect(request.headers["x-auth"]).toBe("a"); // still filled in — it was genuinely missing
    expect(request.headers["x-api-key"]).toBeUndefined(); // apiKey branch only applies to a missing authorization/x-api-key pair
    expect(headerSource).toBe("captured+auth-filled");
    expect(filledAuthKeys).toEqual(["x-auth"]);
  });

  it("reports headerSource as 'captured' (no fallback keys used) when the capture already has everything", () => {
    const { headerSource, filledAuthKeys } = buildPingRequest(
      body,
      "https://api.anthropic.com",
      { authorization: "Bearer x" },
      { apiKey: "sk-ant-api03-abc" },
    );
    expect(headerSource).toBe("captured");
    expect(filledAuthKeys).toEqual([]);
  });
});

describe("sendKeepalivePing — success and SSE parsing", () => {
  it("returns proven-hit and releases resources when message_start has cache_read>0, cache_creation=0", async () => {
    const reader = chunkedReader([
      sseLine({
        type: "message_start",
        message: { usage: { input_tokens: 5, cache_read_input_tokens: 620000, cache_creation_input_tokens: 0 } },
      }),
    ]);
    const fetchImpl = fetchResolvingWith(fakeResponse({ reader }));
    const parent = new AbortController();
    const removeSpy = vi.spyOn(parent.signal, "removeEventListener");

    const outcome = await sendKeepalivePing(SAMPLE_REQUEST, { fetchImpl, signal: parent.signal });

    expect(outcome).toEqual({ kind: "proven-hit", cacheReadTokens: 620000, inputTokens: 5 });
    expect(reader.cancelSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it("reassembles a message_start SSE line split across chunk boundaries", async () => {
    const full = sseLine({
      type: "message_start",
      message: { usage: { input_tokens: 1, cache_read_input_tokens: 42, cache_creation_input_tokens: 0 } },
    });
    const cut = Math.floor(full.length / 2);
    const reader = chunkedReader([full.slice(0, cut), full.slice(cut)]);
    const fetchImpl = fetchResolvingWith(fakeResponse({ reader }));

    const outcome = await sendKeepalivePing(SAMPLE_REQUEST, { fetchImpl });

    expect(outcome).toEqual({ kind: "proven-hit", cacheReadTokens: 42, inputTokens: 1 });
  });

  it("classifies cache_creation > 0 as proven-write (confirmed write, expensive failure)", async () => {
    const reader = chunkedReader([
      sseLine({
        type: "message_start",
        message: { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 900 } },
      }),
    ]);
    const fetchImpl = fetchResolvingWith(fakeResponse({ reader }));

    const outcome = await sendKeepalivePing(SAMPLE_REQUEST, { fetchImpl });

    expect(outcome).toEqual({ kind: "proven-write", cacheWriteTokens: 900 });
  });

  it("classifies double-zero usage as no-usage (never as success)", async () => {
    const reader = chunkedReader([
      sseLine({
        type: "message_start",
        message: { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      }),
    ]);
    const fetchImpl = fetchResolvingWith(fakeResponse({ reader }));

    const outcome = await sendKeepalivePing(SAMPLE_REQUEST, { fetchImpl });

    expect(outcome).toEqual({ kind: "no-usage" });
  });

  it("classifies message_start with missing usage field as no-usage", async () => {
    const reader = chunkedReader([sseLine({ type: "message_start", message: {} })]);
    const fetchImpl = fetchResolvingWith(fakeResponse({ reader }));

    const outcome = await sendKeepalivePing(SAMPLE_REQUEST, { fetchImpl });

    expect(outcome).toEqual({ kind: "no-usage" });
  });
});

describe("sendKeepalivePing — malformed / accepted-then-disconnect", () => {
  it("returns malformed when there is no body at all", async () => {
    const fetchImpl = fetchResolvingWith(fakeResponse({ reader: undefined }));
    const outcome = await sendKeepalivePing(SAMPLE_REQUEST, { fetchImpl });
    expect(outcome).toEqual({ kind: "malformed" });
  });

  it("returns accepted-then-lost (not network) when the stream closes before message_start", async () => {
    const reader = chunkedReader([sseLine({ type: "ping" })]); // some other event, then stream ends
    const fetchImpl = fetchResolvingWith(fakeResponse({ reader }));

    const outcome = await sendKeepalivePing(SAMPLE_REQUEST, { fetchImpl });

    expect(outcome).toEqual({ kind: "accepted-then-lost" });
    expect(reader.cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("returns malformed after scanning 64KB without seeing message_start, and aborts", async () => {
    const junkLine = `data: ${JSON.stringify({ type: "ping", pad: "x".repeat(2000) })}\n`;
    const chunks = Array.from({ length: 40 }, () => junkLine); // ~40 * ~2KB > 64KB
    const reader = chunkedReader(chunks);
    const fetchImpl = fetchResolvingWith(fakeResponse({ reader }));

    const outcome = await sendKeepalivePing(SAMPLE_REQUEST, { fetchImpl });

    expect(outcome).toEqual({ kind: "malformed" });
    expect(reader.cancelSpy).toHaveBeenCalledTimes(1);
  });
});

describe("sendKeepalivePing — HTTP errors", () => {
  it("returns {kind: http, status} for non-2xx and releases resources", async () => {
    const cancelSpy = vi.fn(async () => {});
    const reader: FakeReader = {
      cancel: cancelSpy,
      read: vi.fn(async () => ({ done: true, value: undefined })),
    };
    const response = fakeResponse({ ok: false, status: 529, reader, text: "overloaded" });
    const fetchImpl = fetchResolvingWith(response);

    const outcome = await sendKeepalivePing(SAMPLE_REQUEST, { fetchImpl });

    expect(outcome).toEqual({ kind: "http", status: 529 });
  });

  it("caps the error body read at 2KB without throwing", async () => {
    const cancelSpy = vi.fn(async () => {});
    const bigLine = "x".repeat(5000);
    const reader: FakeReader = {
      cancel: cancelSpy,
      read: (() => {
        let done = false;
        return async () => {
          if (done) return { done: true, value: undefined };
          done = true;
          return { done: false, value: encoder.encode(bigLine) };
        };
      })(),
    };
    const response = fakeResponse({ ok: false, status: 400, reader });
    const fetchImpl = fetchResolvingWith(response);

    const outcome = await sendKeepalivePing(SAMPLE_REQUEST, { fetchImpl });

    expect(outcome).toEqual({ kind: "http", status: 400 });
  });
});

describe("sendKeepalivePing — network / abort / timeout", () => {
  it("classifies a fetch rejection before headers as network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;

    const outcome = await sendKeepalivePing(SAMPLE_REQUEST, { fetchImpl });

    expect(outcome).toEqual({ kind: "network" });
  });

  it("times out before headers are received -> network, and clears the timer", async () => {
    vi.useFakeTimers();
    try {
      const { fetchImpl } = fetchHangingOnConnect();

      const promise = sendKeepalivePing(SAMPLE_REQUEST, { fetchImpl, timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      const outcome = await promise;

      expect(outcome).toEqual({ kind: "network" });
      expect(vi.getTimerCount()).toBe(0); // the timeout timer was cleared, nothing left pending
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out after headers are received -> accepted-then-lost, and cancels the reader", async () => {
    vi.useFakeTimers();
    try {
      const { fetchImpl, cancelSpy } = fetchHangingOnBody();

      const promise = sendKeepalivePing(SAMPLE_REQUEST, { fetchImpl, timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      const outcome = await promise;

      expect(outcome).toEqual({ kind: "accepted-then-lost" });
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("external (parent) abort before headers -> network, and the internal controller is aborted", async () => {
    const { fetchImpl, calls } = fetchHangingOnConnect();
    const parent = new AbortController();

    const promise = sendKeepalivePing(SAMPLE_REQUEST, { fetchImpl, signal: parent.signal });
    parent.abort();
    const outcome = await promise;

    expect(outcome).toEqual({ kind: "network" });
    const init = calls[0] as RequestInit;
    expect((init.signal as AbortSignal).aborted).toBe(true);
  });

  it("external (parent) abort after headers -> accepted-then-lost, and the reader is cancelled", async () => {
    const { fetchImpl, cancelSpy } = fetchHangingOnBody();
    const parent = new AbortController();

    const promise = sendKeepalivePing(SAMPLE_REQUEST, { fetchImpl, signal: parent.signal });
    // let the fetch resolve before aborting
    await Promise.resolve();
    await Promise.resolve();
    parent.abort();
    const outcome = await promise;

    expect(outcome).toEqual({ kind: "accepted-then-lost" });
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("removes the parent abort listener on every exit path (success, http, network)", async () => {
    const parent = new AbortController();
    const addSpy = vi.spyOn(parent.signal, "addEventListener");
    const removeSpy = vi.spyOn(parent.signal, "removeEventListener");

    const reader = chunkedReader([
      sseLine({
        type: "message_start",
        message: { usage: { cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } },
      }),
    ]);
    await sendKeepalivePing(SAMPLE_REQUEST, {
      fetchImpl: fetchResolvingWith(fakeResponse({ reader })),
      signal: parent.signal,
    });
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);

    addSpy.mockClear();
    removeSpy.mockClear();
    await sendKeepalivePing(SAMPLE_REQUEST, {
      fetchImpl: fetchResolvingWith(fakeResponse({ ok: false, status: 500, reader: undefined, text: "" })),
      signal: parent.signal,
    });
    expect(removeSpy).toHaveBeenCalledTimes(1);

    addSpy.mockClear();
    removeSpy.mockClear();
    await sendKeepalivePing(SAMPLE_REQUEST, {
      fetchImpl: vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      signal: parent.signal,
    });
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("redactSecrets", () => {
  it("redacts bearer tokens and explicit secret values", () => {
    const message = `request failed: authorization: Bearer sk-ant-oat01-super-secret header, key=abc123`;
    const redacted = redactSecrets(message, ["sk-ant-oat01-super-secret"]);
    expect(redacted).not.toContain("sk-ant-oat01-super-secret");
    expect(redacted).toContain("[REDACTED]");
  });

  it("passes through messages with no secrets untouched", () => {
    expect(redactSecrets("plain message", [])).toBe("plain message");
  });
});
