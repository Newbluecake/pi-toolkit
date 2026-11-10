// R3 transport tests only, not ModelRegistry/SDK/authentication acceptance.
import * as http from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createProxyStreamFetch, type ProxyStreamFetchOptions } from "../../src/memory/jev/proxy-stream-fetch.js";
import { deferred, streamLab, streamTestCertificates, type StreamLab } from "./helpers/memory-proxy-stream.js";

let certificates: ReturnType<typeof streamTestCertificates>;
let lab: StreamLab | undefined;
beforeAll(() => {
  certificates = streamTestCertificates();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await lab?.close();
  lab = undefined;
});
const post: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
const fetcher = (options: ProxyStreamFetchOptions = {}) =>
  createProxyStreamFetch(lab!.proxyUrl, { ca: certificates.ca, timeoutMs: 2000, ...options })!;
const turn = (): Promise<void> => new Promise((r) => setImmediate(r));

async function assertIdle(): Promise<void> {
  await lab!.idle;
  expect(lab!.sockets.size).toBe(0);
}

async function rawLab(response: string, connectReply?: string): Promise<void> {
  lab = await streamLab(
    certificates,
    (_req, res) => {
      res.socket!.end(response);
    },
    connectReply,
  );
}

describe("R3 real CONNECT → verified TLS → Node parser → streaming Response", () => {
  it.each(["string/record", "URL/Headers", "Request/tuples", "Uint8Array", "ArrayBuffer", "empty"])(
    "supports standard input: %s",
    async (variant) => {
      lab = await streamLab(certificates, (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
      });
      const headers = {
        "content-type": "application/json; charset=utf-8",
        authorization: "Bearer provider-secret",
        "x-extra": "✓".replace("✓", "yes"),
      };
      const text = '{"q":"中文"}';
      let input: string | URL | Request = lab.url;
      let init: RequestInit = { method: "post", headers, body: text };
      if (variant === "URL/Headers") {
        input = new URL(lab.url);
        init.headers = new Headers(headers);
      }
      if (variant === "Request/tuples") {
        input = new Request(lab.url, { ...init, headers: Object.entries(headers) });
        init = {};
      }
      if (variant === "Uint8Array") init.body = new TextEncoder().encode(text);
      if (variant === "ArrayBuffer") init.body = new TextEncoder().encode(text).buffer;
      if (variant === "empty") init.body = null;
      const result = await fetcher()(input, init);
      expect(result).toBeInstanceOf(Response);
      expect(result.ok).toBe(true);
      expect(await result.json()).toEqual({ ok: true });
      expect(lab.connects).toHaveLength(1);
      expect(lab.requests).toHaveLength(1);
      expect(lab.requests[0]).toMatchObject({
        body: Buffer.from(variant === "empty" ? "" : text),
        path: "/chat?q=1",
        sni: "localhost",
      });
      expect(lab.connects[0]!.headers["proxy-authorization"]).toBe(
        `Basic ${Buffer.from("proxy-user:proxy-password").toString("base64")}`,
      );
      expect(lab.connects[0]!.headers.authorization).toBeUndefined();
      expect(lab.requests[0]!.headers.authorization).toBe("Bearer provider-secret");
      expect(lab.requests[0]!.headers["proxy-authorization"]).toBeUndefined();
      expect(lab.requests[0]!.headers.connection).toBe("close");
      expect(lab.requests[0]!.headers["accept-encoding"]).toBe("identity");
      await assertIdle();
    },
  );

  it("inherits a native Request body, and applies init method/header/body overrides", async () => {
    lab = await streamLab(certificates, (_req, res) => res.end("ok"));
    const original = new Request(lab.url, { ...post, body: '{"old":true}' });
    const result = await fetcher()(original, {
      method: "POST",
      headers: [
        ["authorization", "Bearer changed-at-call"],
        ["content-type", "application/json"],
      ],
      body: '{"new":true}',
    });
    expect(await result.text()).toBe("ok");
    expect(lab.requests[0]!.body.toString()).toBe('{"new":true}');
    expect(lab.requests[0]!.headers.authorization).toBe("Bearer changed-at-call");
    expect(original.bodyUsed).toBe(false);
    await assertIdle();
  });

  it("returns headers and the first complete SSE event BEFORE upstream EOF", async () => {
    const release = deferred();
    let eof = false;
    lab = await streamLab(certificates, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"first":true}\n\n');
      void release.promise.then(() => {
        eof = true;
        res.end("data: [DONE]\n\n");
      });
    });
    const result = await fetcher()(lab.url, post);
    expect(eof).toBe(false);
    expect(result.headers.get("content-type")).toBe("text/event-stream");
    const reader = result.body!.getReader();
    let event = "";
    while (!event.includes("\n\n")) event += new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(event.slice(6).trim())).toEqual({ first: true });
    expect(eof).toBe(false);
    release.resolve();
    let rest = "";
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      rest += new TextDecoder().decode(part.value);
    }
    expect(rest).toBe("data: [DONE]\n\n");
    await assertIdle();
  });

  it.each([302, 307, 402, 500, 204, 205, 304])(
    "returns HTTP %s without retry or redirect/direct escape",
    async (status) => {
      lab = await streamLab(certificates, (_req, res) => {
        res.writeHead(status, { location: "https://must-not-be-followed.invalid/", "content-length": "0" });
        res.end();
      });
      const result = await fetcher()(lab.url, { ...post, redirect: "follow" });
      expect(result.status).toBe(status);
      expect(await result.text()).toBe("");
      if ([204, 205, 304].includes(status)) expect(result.body).toBeNull();
      expect(lab.connects).toHaveLength(1);
      expect(lab.requests).toHaveLength(1);
      await assertIdle();
    },
  );

  it("accepts exactly 65536 request bytes and exactly 128 final request headers", async () => {
    lab = await streamLab(certificates, (_req, res) => res.end("ok"));
    // Five owned headers: host/connection/content-type/accept-encoding/content-length.
    const headers = Object.fromEntries(Array.from({ length: 123 }, (_, i) => [`x-${i}`, "v"]));
    const body = `"${"x".repeat(65534)}"`;
    const result = await fetcher()(lab.url, { method: "POST", headers, body });
    expect(await result.text()).toBe("ok");
    expect(Object.keys(lab.requests[0]!.headers)).toHaveLength(128);
    expect(lab.requests[0]!.body.byteLength).toBe(65536);
    await assertIdle();
  });

  it("reads a native Request stream through the bounded reader at exactly 65536 bytes", async () => {
    lab = await streamLab(certificates, (_req, res) => res.end("ok"));
    const cancel = vi.fn();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (chunks++ < 256) c.enqueue(new Uint8Array(256).fill(120));
        else c.close();
      },
      cancel,
    });
    const request = new Request(lab.url, { ...post, body, duplex: "half" } as RequestInit);
    expect(await (await fetcher()(request)).text()).toBe("ok");
    expect(request.bodyUsed).toBe(true);
    expect(request.body!.locked).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(lab.requests[0]!.body).toEqual(Buffer.alloc(65536, 120));
    await assertIdle();
  });

  it.each([65535, 65536, 65537])("counts exact request wire bytes: %s", async (size) => {
    lab = await streamLab(certificates, (_req, res) => res.end("ok"));
    const headers = new Headers({
      "x-large": "",
      host: new URL(lab.url).host,
      connection: "close",
      "content-type": "application/json",
      "accept-encoding": "identity",
      "content-length": "2",
    });
    const empty = `POST /chat?q=1 HTTP/1.1\r\n${[...headers].map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`;
    headers.set("x-large", "x".repeat(size - Buffer.byteLength(empty)));
    if (size > 65536) {
      await expect(fetcher()(lab.url, { ...post, headers })).rejects.toThrow(/request headers too large/);
      expect(lab.connects).toHaveLength(0);
    } else {
      // The owned upstream opts into 64KiB instead of Node's smaller default.
      const result = await fetcher()(lab.url, { ...post, headers });
      expect(await result.text()).toBe("ok");
      expect(lab.requests).toHaveLength(1);
      await assertIdle();
    }
  });

  it.each(["length", "chunked", "close"])(
    "de-frames %s response incrementally at the exact 1000000-byte bound",
    async (framing) => {
      lab = await streamLab(certificates, (_req, res) => {
        if (framing === "close") {
          res.socket!.end(`HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n${"x".repeat(1000000)}`);
          return;
        }
        if (framing === "length") res.setHeader("content-length", "1000000");
        for (let i = 0; i < 100; i++) res.write("x".repeat(10000));
        res.end();
      });
      const result = await fetcher()(lab.url, post);
      expect(result.headers.has("content-length")).toBe(false);
      expect(result.headers.has("transfer-encoding")).toBe(false);
      const body = await result.arrayBuffer();
      expect(body.byteLength).toBe(1000000);
      expect(new Uint8Array(body).every((v) => v === 120)).toBe(true);
      await assertIdle();
    },
  );

  it("rejects the decoded chunked +1 byte and closes every tunnel resource", async () => {
    lab = await streamLab(certificates, (_req, res) => {
      res.write("x".repeat(1000000));
      res.end("x");
    });
    const result = await fetcher()(lab.url, post);
    await expect(result.text()).rejects.toThrow(/1000000 byte cap/);
    await assertIdle();
  });

  it.each([
    ["oversize Content-Length", "HTTP/1.1 200 OK\r\nContent-Length: 1000001\r\n\r\n", /1000000/],
    ["bad status", "not http\r\n\r\n", /Parse Error/],
    ["CL/TE conflict", "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n", /Parse Error/],
    [
      "129 headers",
      `HTTP/1.1 200 OK\r\n${Array.from({ length: 129 }, (_, i) => `X-${i}: v\r\n`).join("")}\r\n`,
      /too many headers/,
    ],
    ["oversize headers", `HTTP/1.1 200 OK\r\nX-Large: ${"x".repeat(65537)}\r\n\r\n`, /headers too large/],
    ["compressed peer", "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 0\r\n\r\n", /identity required/],
  ])("rejects upstream %s through the Node parser/header admission", async (_name, raw, error) => {
    await rawLab(raw);
    await expect(fetcher()(lab!.url, post)).rejects.toThrow(error);
    expect(lab!.connects).toHaveLength(1);
    await assertIdle();
  });

  it.each([65535, 65536, 65537])("counts exact upstream wire-header bytes: %s", async (size) => {
    const prefix = "HTTP/1.1 200 OK\r\nX-Large: ";
    const suffix = "\r\nContent-Length: 0\r\n\r\n";
    const raw = prefix + "x".repeat(size - prefix.length - suffix.length) + suffix;
    expect(Buffer.byteLength(raw)).toBe(size);
    await rawLab(raw);
    if (size > 65536) await expect(fetcher()(lab!.url, post)).rejects.toThrow(/headers too large/);
    else expect(await (await fetcher()(lab!.url, post)).text()).toBe("");
    await assertIdle();
  });

  it("handles split headers and informational groups without delaying SSE until EOF", async () => {
    const first = deferred();
    let response: http.ServerResponse | undefined;
    lab = await streamLab(certificates, (_req, res) => {
      response = res;
      res.socket!.write(
        "HTTP/1.1 100 Continue\r\nX-Info: v\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r",
      );
      first.resolve();
    });
    const pending = fetcher()(lab.url, post);
    await first.promise;
    await turn();
    response!.socket!.write("\n9\r\ndata: 1\n\n\r\n");
    const result = await pending;
    const reader = result.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 1\n\n");
    response!.socket!.end("0\r\n\r\n");
    expect((await reader.read()).done).toBe(true);
    await assertIdle();
  });

  it("preserves all 128 allowed response fields without Node's silent header truncation", async () => {
    await rawLab(
      `HTTP/1.1 200 OK\r\n${Array.from({ length: 127 }, (_, i) => `X-${i}: v\r\n`).join("")}Content-Length: 0\r\n\r\n`,
    );
    const result = await fetcher()(lab!.url, post);
    expect(result.headers.get("x-126")).toBe("v");
    expect([...result.headers]).toHaveLength(127);
    expect(await result.text()).toBe("");
    await assertIdle();
  });

  it.each([
    ["short Content-Length", "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort"],
    ["malformed chunk", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZ\r\nwrong\r\n"],
    ["short chunk", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\nshort"],
  ])("fails the fetch OR returned body for %s; never a successful short read", async (_name, raw) => {
    await rawLab(raw);
    await expect(fetcher()(lab!.url, post).then((result) => result.text())).rejects.toThrow();
    await assertIdle();
  });

  it("bounds chunk trailers (not just initial headers)", async () => {
    await rawLab(
      `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n${Array.from({ length: 129 }, (_, i) => `X-${i}: v\r\n`).join("")}\r\n`,
    );
    await expect(fetcher()(lab!.url, post).then((r) => r.text())).rejects.toThrow(/too many headers/);
    await assertIdle();
  });

  it.each([
    ["407", "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n", /407/],
    ["redirect", "HTTP/1.1 302 Found\r\nLocation: https://must-not-follow.invalid\r\n\r\n", /302/],
    [
      "129 headers",
      `HTTP/1.1 200 OK\r\n${Array.from({ length: 129 }, (_, i) => `X-${i}: v\r\n`).join("")}\r\n`,
      /too many headers/,
    ],
    ["16KiB +1", `HTTP/1.1 200 OK\r\nX-Large: ${"x".repeat(16385)}\r\n\r\n`, /headers too large/],
    ["malformed", "wrong\r\n\r\n", /Parse Error/],
    ["tunnel head", "HTTP/1.1 200 OK\r\n\r\nunsolicited", /unexpected CONNECT/],
  ])("rejects CONNECT %s once, never contacting the provider", async (_name, raw, error) => {
    await rawLab("", raw);
    await expect(fetcher()(lab!.url, post)).rejects.toThrow(error);
    expect(lab!.connects).toHaveLength(1);
    expect(lab!.requests).toHaveLength(0);
    await assertIdle();
  });

  it.each([16383, 16384, 16385])("counts exact CONNECT wire-header bytes: %s", async (size) => {
    const prefix = "HTTP/1.1 200 OK\r\nX-Large: ";
    const suffix = "\r\n\r\n";
    const raw = prefix + "x".repeat(size - prefix.length - suffix.length) + suffix;
    expect(Buffer.byteLength(raw)).toBe(size);
    lab = await streamLab(certificates, (_req, res) => res.end("ok"), { successHeaders: raw });
    if (size > 16384) {
      await expect(fetcher()(lab.url, post)).rejects.toThrow(/headers too large/);
      expect(lab.requests).toHaveLength(0);
    } else expect(await (await fetcher()(lab.url, post)).text()).toBe("ok");
    expect(lab.connects).toHaveLength(1);
    await assertIdle();
  });

  it("accepts exactly 128 CONNECT fields and performs one verified upstream request", async () => {
    const raw = `HTTP/1.1 200 OK\r\n${Array.from({ length: 128 }, (_, i) => `X-${i}: v\r\n`).join("")}\r\n`;
    lab = await streamLab(certificates, (_req, res) => res.end("ok"), { successHeaders: raw });
    expect(await (await fetcher()(lab.url, post)).text()).toBe("ok");
    expect(lab.connects).toHaveLength(1);
    expect(lab.requests).toHaveLength(1);
    await assertIdle();
  });

  it.each(["untrusted CA", "name mismatch"])("does not downgrade verified TLS for %s", async (mode) => {
    lab = await streamLab(certificates, (_req, res) => res.end("must not happen"));
    const fetch = mode === "untrusted CA" ? createProxyStreamFetch(lab.proxyUrl, { timeoutMs: 1000 })! : fetcher();
    await expect(
      fetch(mode === "name mismatch" ? lab.url.replace("localhost", "127.0.0.1") : lab.url, post),
    ).rejects.toThrow(/certificate|altname|self.signed|issuer/i);
    expect(lab.connects).toHaveLength(1);
    expect(lab.requests).toHaveLength(0);
    await assertIdle();
  });

  it.each(["CONNECT", "TLS", "headers", "body", "unread body"])(
    "total deadline spans %s and converges resources",
    async (stage) => {
      lab = await streamLab(
        certificates,
        (_req, res) => {
          if (stage === "headers") return;
          res.writeHead(200);
          res.write("first");
        },
        stage === "CONNECT" ? "silent" : stage === "TLS" ? "tls-silent" : undefined,
      );
      const result = fetcher({ timeoutMs: 120 })(lab.url, post);
      if (["body", "unread body"].includes(stage)) {
        const response = await result;
        if (stage === "body") await expect(response.text()).rejects.toThrow(/timeout after 120ms/);
        else {
          await lab.idle;
          await expect(response.text()).rejects.toThrow(/timeout after 120ms/);
        }
      } else await expect(result).rejects.toThrow(/timeout after 120ms/);
      expect(lab.connects).toHaveLength(1);
      await assertIdle();
    },
  );

  it.each(["CONNECT", "TLS", "headers", "body", "cancel"])(
    "abort/cancel during %s destroys both ends without waiting for EOF",
    async (stage) => {
      const started = deferred();
      lab = await streamLab(
        certificates,
        (_req, res) => {
          started.resolve();
          if (stage !== "headers") {
            res.writeHead(200);
            res.write("first");
          }
        },
        stage === "CONNECT" ? "silent" : stage === "TLS" ? "tls-silent" : undefined,
      );
      const abort = new AbortController();
      const remove = vi.spyOn(abort.signal, "removeEventListener");
      const pending = fetcher()(lab.url, { ...post, signal: abort.signal });
      if (stage === "body" || stage === "cancel") {
        const response = await pending;
        const reader = response.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
        if (stage === "cancel") await reader.cancel();
        else {
          const next = reader.read();
          abort.abort();
          await expect(next).rejects.toThrow(/aborted/);
        }
      } else {
        const assertion = expect(pending).rejects.toThrow(/aborted/);
        if (stage === "headers") await started.promise;
        else while (lab.connects.length === 0) await turn();
        abort.abort();
        await assertion;
      }
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      await assertIdle();
    },
  );

  it("uses byte-measured 64KiB WHATWG/Node queues and no extra body queue under backpressure", async () => {
    const original = http.IncomingMessage.prototype.read;
    let incoming: http.IncomingMessage | undefined;
    let totalRead = 0;
    vi.spyOn(http.IncomingMessage.prototype, "read").mockImplementation(function (
      this: http.IncomingMessage,
      size?: number,
    ) {
      const result: Buffer | null = original.call(this, size);
      if (this.statusCode === 200 && result !== null) {
        incoming = this;
        totalRead += result.byteLength;
      }
      return result;
    });
    lab = await streamLab(certificates, (_req, res) => {
      res.writeHead(200);
      res.write("x".repeat(500000));
    });
    const response = await fetcher()(lab.url, post);
    // Allow socket readiness callbacks to fill bounded queues, but do not read
    // the WHATWG body. A buffered-Response implementation reads all 500k here.
    for (let i = 0; i < 20; i++) await turn();
    expect(totalRead).toBeGreaterThan(0);
    expect(totalRead).toBeLessThanOrEqual(65536);
    expect(incoming!.readableHighWaterMark).toBe(65536);
    expect(incoming!.readableLength).toBeLessThanOrEqual(65536 + 16384); // one in-flight TLS record may cross the target
    const beforeRead = totalRead;
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.value!.byteLength).toBeLessThanOrEqual(65536);
    for (let i = 0; i < 10; i++) await turn();
    expect(totalRead).toBeGreaterThan(beforeRead);
    expect(totalRead - beforeRead).toBeLessThanOrEqual(first.value!.byteLength);
    await reader.cancel();
    await assertIdle();
  });
});
