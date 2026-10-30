// Dedicated proxy fetch for Jev calls (Q18, jev-arch §5.4 —照搬 v4.1
// §2.4.1「代理」实现约束). pi-free: only `node:http`/`node:tls`/`node:net`,
// no undici, no global fetch. One request/response at a time, no keep-alive,
// no redirects, no HTTP/2.
//
// Timers are `unref`'d (I5); the hard timeout spans CONNECT + TLS + the full
// request/response and is clamped via `clampSpanMs` (I1).

import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import { clampSpanMs } from "../../core/deadline.js";
import type { FetchInitLike, FetchLike, FetchResponseLike } from "./contracts.js";

const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface ParsedProxyUrl {
  readonly host: string;
  readonly port: number;
  readonly auth?: string; // "user:pass", already decoded for the Basic header
}

/** Only `http://[user:pass@]host[:port]` is accepted (default port 80);
 *  anything else (`https://`, `socks5://`, unparsable) ⇒ `undefined`, which
 *  callers treat as "not configured" (jev-arch §5.4). Never throws. */
export function parseProxyUrl(raw: string): ParsedProxyUrl | undefined {
  if (raw === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") return undefined;
  if (url.hostname === "") return undefined;
  const port = url.port === "" ? 80 : Number(url.port);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return undefined;
  const auth =
    url.username === "" && url.password === ""
      ? undefined
      : `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  return { host: url.hostname, port, ...(auth === undefined ? {} : { auth }) };
}

/** Mask proxy-URL userinfo for logs / `/mem jev` / error texts:
 *  `http://user:pass@host:port` → `http://***@host:port`. Leaves URLs
 *  without userinfo untouched; non-proxy-shaped input returns unchanged. */
export function redactProxyUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username === "" && url.password === "") return raw;
    url.username = "***";
    url.password = "";
    return url.toString().replace("***:@", "***@");
  } catch {
    return raw;
  }
}

function proxyError(detail: string): Error {
  return new Error(`proxy error: ${detail}`);
}

/** Read a response (status line + headers + body) off `socket`, framing the
 *  body by `Content-Length` or chunked transfer-encoding, capped at
 *  {@link MAX_RESPONSE_BYTES}. Resolves once the full body has arrived. */
function readHttpResponse(
  socket: net.Socket | tls.TLSSocket,
  opts: { signal?: AbortSignal },
): Promise<FetchResponseLike> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let headerEnd = -1;
    let status = 0;
    let contentLength: number | undefined;
    let chunked = false;
    let bodyStart = 0;
    let settled = false;

    const abortListener = (): void => {
      finishError(proxyError("aborted"));
    };
    opts.signal?.addEventListener("abort", abortListener);

    const finishOk = (body: Buffer): void => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", abortListener);
      socket.destroy();
      resolve({ status, text: async () => body.toString("utf8") });
    };
    const finishError = (err: Error): void => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", abortListener);
      socket.destroy();
      reject(err);
    };

    const tryParseHeaders = (): boolean => {
      if (headerEnd !== -1) return true;
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return false;
      headerEnd = idx;
      bodyStart = idx + 4;
      const headerText = buf.slice(0, idx).toString("latin1");
      const lines = headerText.split("\r\n");
      const statusLine = lines[0] ?? "";
      const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine);
      status = m !== undefined && m !== null ? Number(m[1]) : 0;
      for (const line of lines.slice(1)) {
        const sep = line.indexOf(":");
        if (sep === -1) continue;
        const key = line.slice(0, sep).trim().toLowerCase();
        const value = line.slice(sep + 1).trim();
        if (key === "content-length") contentLength = Number(value);
        if (key === "transfer-encoding" && /chunked/i.test(value)) chunked = true;
      }
      return true;
    };

    const tryParseChunkedBody = (): Buffer | undefined => {
      const out: Buffer[] = [];
      let pos = bodyStart;
      for (;;) {
        const lineEnd = buf.indexOf("\r\n", pos);
        if (lineEnd === -1) return undefined;
        const sizeHex = buf.slice(pos, lineEnd).toString("latin1").split(";")[0]!.trim();
        const size = Number.parseInt(sizeHex, 16);
        if (Number.isNaN(size)) {
          finishError(proxyError("malformed chunked body"));
          return undefined;
        }
        if (size === 0) return Buffer.concat(out);
        const chunkStart = lineEnd + 2;
        const chunkEnd = chunkStart + size;
        if (buf.length < chunkEnd + 2) return undefined; // need more data
        out.push(buf.slice(chunkStart, chunkEnd));
        pos = chunkEnd + 2;
      }
    };

    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_RESPONSE_BYTES + 65_536) {
        finishError(proxyError("response exceeds 1MB cap"));
        return;
      }
      if (!tryParseHeaders()) return;
      if (chunked) {
        const body = tryParseChunkedBody();
        if (body !== undefined) {
          if (body.length > MAX_RESPONSE_BYTES) finishError(proxyError("response exceeds 1MB cap"));
          else finishOk(body);
        }
        return;
      }
      if (contentLength !== undefined) {
        const have = buf.length - bodyStart;
        if (have >= contentLength) {
          const body = buf.slice(bodyStart, bodyStart + contentLength);
          if (body.length > MAX_RESPONSE_BYTES) finishError(proxyError("response exceeds 1MB cap"));
          else finishOk(body);
        }
        return;
      }
      // No framing header: treat socket close as end-of-body (rare, defensive).
    });
    socket.on("end", () => {
      if (settled) return;
      if (headerEnd !== -1 && contentLength === undefined && !chunked) {
        const body = buf.slice(bodyStart);
        finishOk(body);
        return;
      }
      finishError(proxyError("connection closed before response completed"));
    });
    socket.on("error", (err: Error) => finishError(proxyError(String(err.message ?? err))));
  });
}

export interface ProxyFetchOptions {
  readonly timeoutMs?: number;
  readonly now?: () => number;
  /** Test-only: a CA bundle for the TLS connection to the upstream (lets
   *  tests use a self-signed cert without weakening production defaults —
   *  production never sets this). */
  readonly ca?: string | Buffer;
}

/** One-shot CONNECT-tunnelled HTTPS fetch through an `http://` proxy
 *  (jev-arch §5.4). `createProxyFetch("")` returns `undefined` — callers must
 *  not pass a `fetch` option to `classify()` in that case (I9: empty proxy
 *  key ⇒ byte-identical to not having proxy support at all). An unparsable
 *  proxy URL is likewise treated as "not configured" (`undefined`). */
export function createProxyFetch(proxy: string, opts: ProxyFetchOptions = {}): FetchLike | undefined {
  const parsed = parseProxyUrl(proxy);
  if (parsed === undefined) return undefined;
  const timeoutMs = clampSpanMs(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;

  return async function proxyFetch(input: string, init: FetchInitLike = {}): Promise<FetchResponseLike> {
    const target = new URL(input);
    if (target.protocol !== "https:") throw proxyError("target must be https:");

    return new Promise<FetchResponseLike>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => {
          tunnel.destroy();
          upstreamSocket?.destroy();
          reject(proxyError(`timeout after ${timeoutMs}ms`));
        });
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();

      let upstreamSocket: tls.TLSSocket | undefined;
      const targetPort = target.port === "" ? 443 : Number(target.port);

      const tunnel = http.request({
        host: parsed.host,
        port: parsed.port,
        method: "CONNECT",
        path: `${target.hostname}:${targetPort}`,
        headers: {
          host: `${target.hostname}:${targetPort}`,
          ...(parsed.auth === undefined
            ? {}
            : { "proxy-authorization": `Basic ${Buffer.from(parsed.auth).toString("base64")}` }),
        },
      });

      if (init.signal !== undefined) {
        if (init.signal.aborted) {
          finish(() => {
            tunnel.destroy();
            reject(proxyError("aborted"));
          });
          return;
        }
        init.signal.addEventListener(
          "abort",
          () => {
            finish(() => {
              tunnel.destroy();
              upstreamSocket?.destroy();
              reject(proxyError("aborted"));
            });
          },
          { once: true },
        );
      }

      tunnel.once("connect", (res, socket: net.Socket) => {
        if (res.statusCode !== 200) {
          finish(() => {
            socket.destroy();
            reject(proxyError(`CONNECT failed (${res.statusCode})`));
          });
          return;
        }
        const secure = tls.connect({
          socket,
          servername: target.hostname,
          ...(opts.ca === undefined ? {} : { ca: opts.ca }),
        });
        upstreamSocket = secure;
        secure.once("error", (err: Error) => {
          finish(() => reject(proxyError(String(err.message ?? err))));
        });
        secure.once("secureConnect", () => {
          if (settled) return;
          const bodyText = init.body ?? "";
          const bodyBuf = Buffer.from(bodyText, "utf8");
          const headers: Record<string, string> = {
            host: target.host,
            connection: "close",
            "content-length": String(bodyBuf.length),
            ...init.headers,
          };
          const headerLines = Object.entries(headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n");
          const requestLine = `${init.method ?? "GET"} ${target.pathname}${target.search} HTTP/1.1`;
          secure.write(`${requestLine}\r\n${headerLines}\r\n\r\n`);
          if (bodyBuf.length > 0) secure.write(bodyBuf);

          readHttpResponse(secure, init.signal === undefined ? {} : { signal: init.signal })
            .then((response) => finish(() => resolve(response)))
            .catch((err: Error) => finish(() => reject(err)));
        });
      });
      tunnel.once("error", (err: Error) => {
        finish(() => reject(proxyError(String(err.message ?? err))));
      });
      tunnel.end();
    });
  };
}
