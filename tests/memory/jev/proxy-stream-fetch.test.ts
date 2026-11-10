import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProxyStreamFetch,
  PROXY_STREAM_LIMITS,
  type ProxyStreamFetch,
} from "../../../src/memory/jev/proxy-stream-fetch.js";

const fetchViaProxy = (): ProxyStreamFetch => createProxyStreamFetch("http://127.0.0.1:1")!;
const target = "https://localhost:1/chat";
const post = { method: "POST", headers: { "content-type": "application/json" } };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("R3 input admission (no CONNECT)", () => {
  it.each(["", "broken", "socks5://localhost:9", "https://localhost:9", "http://%ZZ:p@localhost"])(
    "fails closed for %s",
    (proxy) => {
      expect(createProxyStreamFetch(proxy)).toBeUndefined();
    },
  );
  it.each([
    ["http://localhost:1", post, /https/],
    [target, {}, /POST/],
    [target, { ...post, method: "GET" }, /POST/],
    ["https://u:p@localhost:1", post, /credentials/],
    [target, { ...post, headers: { "content-type": "text/plain" } }, /JSON/],
    [target, { ...post, headers: { "proxy-authorization": "secret" } }, /only to CONNECT/],
    [target, { ...post, headers: { host: "evil" } }, /Host/],
    [target, { ...post, headers: { "content-length": "99" }, body: "{}" }, /Content-Length/],
    [target, { ...post, headers: { "transfer-encoding": "chunked" } }, /framing/],
    [target, { ...post, body: new Blob(["{}"]) }, /body type/],
    [target, { ...post, body: new FormData() }, /body type/],
    [target, { ...post, body: new URLSearchParams("q=1") }, /body type/],
    [target, { ...post, body: new ReadableStream() }, /body type/],
    [target, { ...post, body: "é".repeat(32769) }, /body too large/],
    [target, { ...post, body: new Uint8Array(65537) }, /body too large/],
    [target, { ...post, body: new ArrayBuffer(65537) }, /body too large/],
    [target, { ...post, headers: { huge: "x".repeat(65536) } }, /headers too large/],
    [
      target,
      { ...post, headers: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`x-${i}`, "v"])) },
      /too many headers/,
    ],
  ] satisfies [string, RequestInit, RegExp][])("rejects %s with unsupported input %#", async (url, init, error) => {
    await expect(fetchViaProxy()(url, init)).rejects.toThrow(error);
  });
  it("rejects used and locked native Request bodies", async () => {
    const used = new Request(target, { ...post, body: "{}" });
    await used.text();
    await expect(fetchViaProxy()(used)).rejects.toThrow(/used or locked/);
    const locked = new Request(target, { ...post, body: "{}" });
    const reader = locked.body!.getReader();
    await expect(fetchViaProxy()(locked)).rejects.toThrow(/used or locked/);
    reader.releaseLock();
  });
  it("bounds the native Request reader and cancels its source on overflow", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(65537));
      },
      cancel,
    });
    const request = new Request(target, { ...post, body, duplex: "half" } as RequestInit);
    await expect(fetchViaProxy()(request)).rejects.toThrow(/body too large/);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(request.body!.locked).toBe(false);
  });
  it.each(["abort", "deadline"])("cancels a stalled Request reader on %s; timer/listener released", async (mode) => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const request = new Request(target, { ...post, body, duplex: "half" } as RequestInit);
    const result = createProxyStreamFetch("http://127.0.0.1:1", { timeoutMs: 80 })!(request, { signal: abort.signal });
    const assertion = expect(result).rejects.toThrow(mode === "abort" ? /aborted/ : /timeout after 80ms/);
    if (mode === "abort") abort.abort();
    else await vi.advanceTimersByTimeAsync(80);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(request.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([undefined, 0, -1, NaN])("uses the finite 20s default for timeout %s", async (timeoutMs) => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const request = new Request(target, { ...post, body: new ReadableStream(), duplex: "half" } as RequestInit);
    const result = createProxyStreamFetch("http://127.0.0.1:1", timeoutMs === undefined ? {} : { timeoutMs })!(
      request,
      { signal: abort.signal },
    );
    const assertion = expect(result).rejects.toThrow(/timeout after 20000ms/);
    await vi.advanceTimersByTimeAsync(19999);
    expect(request.body!.locked).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(request.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("segments clamped long timers and unrefs them, without CONNECT while body is pending", async () => {
    const abort = new AbortController();
    const set = vi.spyOn(globalThis, "setTimeout");
    const request = new Request(target, { ...post, body: new ReadableStream(), duplex: "half" } as RequestInit);
    const result = createProxyStreamFetch("http://127.0.0.1:1", { timeoutMs: Infinity })!(request, {
      signal: abort.signal,
    });
    const timer = set.mock.results.at(-1)!.value as NodeJS.Timeout;
    expect(set.mock.calls.at(-1)![1]).toBe(2_147_483_647);
    expect(timer.hasRef()).toBe(false);
    abort.abort();
    await expect(result).rejects.toThrow(/aborted/);
  });
  it("does not let endless empty Request chunks starve abort or leak its reader", async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(0));
      },
      cancel,
    });
    const request = new Request(target, { ...post, body, duplex: "half" } as RequestInit);
    const timer = setTimeout(() => abort.abort(), 10);
    timer.unref();
    try {
      await expect(fetchViaProxy()(request, { signal: abort.signal })).rejects.toThrow(/aborted/);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(request.body!.locked).toBe(false);
    } finally {
      clearTimeout(timer);
    }
  });
  it("releases a Request reader after source error", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("owned body failure"));
      },
    });
    const request = new Request(target, { ...post, body, duplex: "half" } as RequestInit);
    await expect(fetchViaProxy()(request)).rejects.toThrow("owned body failure");
    expect(request.body!.locked).toBe(false);
  });
  it("caps CONNECT request credentials before opening a socket", async () => {
    const fetch = createProxyStreamFetch(`http://${"u".repeat(13000)}:p@127.0.0.1:1`)!;
    await expect(fetch(target, post)).rejects.toThrow(/CONNECT headers too large/);
  });
  it("pre-aborted signals do not touch a Request body", async () => {
    const abort = new AbortController();
    abort.abort();
    const request = new Request(target, { ...post, body: "{}" });
    const standardFetch: typeof globalThis.fetch = fetchViaProxy();
    await expect(standardFetch(request, { signal: abort.signal })).rejects.toThrow(/aborted/);
    expect(request.bodyUsed).toBe(false);
  });
  it("exports explicit, immutable resource bounds", () => {
    expect(PROXY_STREAM_LIMITS).toEqual({
      connectHeaderBytes: 16384,
      headerBytes: 65536,
      headerCount: 128,
      requestBodyBytes: 65536,
      responseBodyBytes: 1000000,
      streamHighWaterMark: 65536,
      defaultTimeoutMs: 20000,
    });
    expect(Object.isFrozen(PROXY_STREAM_LIMITS)).toBe(true);
  });
});
