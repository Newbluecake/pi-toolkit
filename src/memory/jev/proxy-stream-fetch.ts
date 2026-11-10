// R3 transport core only: no SDK/client/binding wiring. One CONNECT, one verified
// TLS connection, one HTTP/1.1 POST; no retry, redirect, pooling or direct escape.
// Limits bound protocol queues, not total heap, consumer tees or token counts.
import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import { systemClock, type TimerHandle } from "../../core/clock.js";
import { clampSpanMs } from "../../core/deadline.js";
import { parseProxyUrl } from "./proxy-fetch.js";

export type ProxyStreamFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ProxyStreamFetchOptions {
  /** Total budget, including input-body reading and consumption of the response. */
  readonly timeoutMs?: number;
  /** Only for an owned test server's CA; never disables peer/name verification. */
  readonly ca?: string | Buffer;
}

export const PROXY_STREAM_LIMITS = Object.freeze({
  connectHeaderBytes: 16_384,
  headerBytes: 65_536,
  headerCount: 128,
  requestBodyBytes: 65_536,
  responseBodyBytes: 1_000_000,
  streamHighWaterMark: 65_536,
  defaultTimeoutMs: 20_000,
});

const L = PROXY_STREAM_LIMITS;
const failure = (detail: string): Error => new Error(`proxy stream error: ${detail}`);

function headerGroup(raw: readonly string[], max: number): void {
  if (raw.length / 2 > L.headerCount) throw failure("too many headers");
  let bytes = 2;
  for (let i = 0; i < raw.length; i += 2) {
    bytes += Buffer.byteLength(`${raw[i]}: ${raw[i + 1]}\r\n`, "latin1");
  }
  if (bytes > max) throw failure("headers too large");
}

/** Invalid proxy configuration fails closed (undefined); a configured caller must
 * treat this as unavailable, never as permission to omit the proxy. */
export function createProxyStreamFetch(
  proxy: string,
  options: ProxyStreamFetchOptions = {},
): ProxyStreamFetch | undefined {
  let parsed;
  try {
    parsed = parseProxyUrl(proxy);
  } catch {
    return undefined; // malformed percent-encoded credentials
  }
  if (parsed === undefined) return undefined;
  const proxyAddress = parsed;
  const timeoutMs = clampSpanMs(options.timeoutMs ?? L.defaultTimeoutMs) ?? L.defaultTimeoutMs;
  // Snapshot mutable test CA bytes at construction, not during a request.
  const ca = Buffer.isBuffer(options.ca) ? Buffer.from(options.ca) : options.ca;

  return function proxyStreamFetch(input, init = {}): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      let done = false;
      let published = false;
      let timer: TimerHandle | undefined;
      let signal: AbortSignal | undefined;
      let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let inputYield: NodeJS.Immediate | undefined;
      let resumeInput: (() => void) | undefined;
      let tunnel: http.ClientRequest | undefined;
      let socket: net.Socket | undefined;
      let secure: tls.TLSSocket | undefined;
      let request: http.ClientRequest | undefined;
      let incoming: http.IncomingMessage | undefined;
      let agent: http.Agent | undefined;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let bodyBytes = 0;
      let nullBody = false;
      const removeHeaderGuards: (() => void)[] = [];

      // Node's maxHeaderSize counts parser header content, not every wire
      // delimiter/status byte. Count the actual header groups as well, without
      // retaining them or parsing any body framing. Node remains the sole HTTP
      // parser. Informational groups restart the counter; final headers detach.
      const guardHeaderBytes = (transport: net.Socket, max: number): void => {
        let bytes = 0;
        let match = 0;
        let prefix = "";
        const delimiter = [13, 10, 13, 10];
        const remove = (): void => {
          transport.removeListener("data", inspect);
        };
        const inspect = (chunk: Buffer): void => {
          for (const byte of chunk) {
            bytes++;
            if (bytes > max) {
              fail(failure("headers too large"));
              return;
            }
            if (prefix.length < 12) prefix += String.fromCharCode(byte);
            match = byte === delimiter[match] ? match + 1 : byte === 13 ? 1 : 0;
            if (match !== 4) continue;
            const status = Number(prefix.slice(9, 12));
            if (status >= 100 && status < 200 && status !== 101) {
              bytes = 0;
              match = 0;
              prefix = "";
            } else {
              remove();
              return;
            }
          }
        };
        transport.prependListener("data", inspect);
        removeHeaderGuards.push(remove);
      };

      const cleanup = (): void => {
        for (const remove of removeHeaderGuards) remove();
        if (timer !== undefined) systemClock.clearTimer(timer);
        signal?.removeEventListener("abort", onAbort);
        if (inputYield !== undefined) clearImmediate(inputYield);
        inputYield = undefined;
        resumeInput?.();
        resumeInput = undefined;
        // Never await an uncooperative Request stream's cancel promise. The
        // pending read has its own rejection observer in run().
        if (bodyReader !== undefined) {
          const reader = bodyReader;
          bodyReader = undefined;
          void reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        incoming?.destroy();
        request?.destroy();
        secure?.destroy();
        socket?.destroy();
        tunnel?.destroy();
        agent?.destroy();
      };
      const fail = (err: unknown): void => {
        if (done) return;
        done = true;
        const error = err instanceof Error ? err : failure("transport failed");
        controller?.error(error);
        cleanup();
        if (!published) reject(error);
      };
      const onAbort = (): void => fail(failure("aborted"));
      const finish = (): void => {
        if (done) return;
        try {
          headerGroup(incoming?.rawTrailers ?? [], L.headerBytes);
          if (!incoming?.complete) throw failure("truncated response");
          done = true;
          controller?.close();
          cleanup();
        } catch (err) {
          fail(err);
        }
      };
      const pump = (): void => {
        if (done || incoming === undefined) return;
        try {
          // Readable mode, not a flowing data listener: Node stops reading at
          // its HWM when the WHATWG byte queue is full. No intermediate array.
          while (!done && incoming.readableLength > 0) {
            const space = nullBody ? L.streamHighWaterMark : (controller?.desiredSize ?? 0);
            if (space <= 0) return;
            const size = Math.min(space, incoming.readableLength, L.streamHighWaterMark);
            const chunk: Buffer | null = incoming.read(size);
            if (chunk === null) return;
            bodyBytes += chunk.byteLength;
            if (bodyBytes > L.responseBodyBytes) throw failure("response exceeds 1000000 byte cap");
            if (nullBody && chunk.byteLength !== 0) throw failure("unexpected body for null-body status");
            // Copy the view: don't retain an entire Node slab in the web queue.
            if (!nullBody) controller?.enqueue(new Uint8Array(chunk));
          }
          // Trigger Node's end event even for a zero-length response.
          if (incoming.readableLength === 0) incoming.read(0);
        } catch (err) {
          fail(err);
        }
      };

      const run = async (): Promise<void> => {
        const source = input instanceof Request ? input : undefined;
        signal = (init.signal === undefined ? source?.signal : init.signal) ?? undefined;
        if (signal?.aborted) throw failure("aborted");
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = systemClock.setTimer(timeoutMs, () => fail(failure(`timeout after ${timeoutMs}ms`)));

        const target = new URL(source?.url ?? (input as string | URL));
        if (target.protocol !== "https:") throw failure("target must be https:");
        if (target.username !== "" || target.password !== "") throw failure("URL credentials unsupported");
        const method = (init.method ?? source?.method ?? "GET").toUpperCase();
        if (method !== "POST") throw failure("only POST JSON is supported");
        if (source !== undefined && (source.bodyUsed || source.body?.locked)) {
          throw failure("Request body is used or locked");
        }
        const headers = new Headers(init.headers ?? source?.headers);
        const contentType = headers.get("content-type");
        if (contentType !== null && !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;|$)/i.test(contentType)) {
          throw failure("only JSON content-type is supported");
        }
        if (headers.has("proxy-authorization") || headers.has("proxy-connection")) {
          throw failure("proxy credentials belong only to CONNECT");
        }
        for (const key of ["transfer-encoding", "upgrade", "expect", "te", "trailer"]) {
          if (headers.has(key)) throw failure("unsupported request framing header");
        }
        if (headers.has("host") && headers.get("host") !== target.host) throw failure("conflicting Host");
        headers.set("host", target.host);
        headers.set("connection", "close");
        headers.set("content-type", contentType ?? "application/json");
        // No content-decoder queues. Ask for identity and fail closed if a peer
        // ignores it; the cap counts HTTP-parser decoded (dechunked) body bytes.
        headers.set("accept-encoding", "identity");

        let body: Buffer;
        const suppliedBody = init.body;
        if (suppliedBody != null) {
          if (typeof suppliedBody === "string") {
            if (Buffer.byteLength(suppliedBody) > L.requestBodyBytes) throw failure("request body too large");
            body = Buffer.from(suppliedBody);
          } else if (suppliedBody instanceof Uint8Array) {
            if (suppliedBody.byteLength > L.requestBodyBytes) throw failure("request body too large");
            body = Buffer.from(suppliedBody);
          } else if (suppliedBody instanceof ArrayBuffer) {
            if (suppliedBody.byteLength > L.requestBodyBytes) throw failure("request body too large");
            body = Buffer.from(new Uint8Array(suppliedBody));
          } else {
            throw failure("unsupported body type");
          }
        } else if (source?.body != null) {
          // Fixed bounded buffer, never Request.arrayBuffer() (which is unbounded).
          const buffer = Buffer.alloc(L.requestBodyBytes);
          let size = 0;
          let chunks = 0;
          const reader = source.body.getReader();
          bodyReader = reader;
          for (;;) {
            const part = await reader.read();
            if (done) return;
            if (part.done) break;
            if (!(part.value instanceof Uint8Array)) throw failure("invalid Request body chunk");
            size += part.value.byteLength;
            if (size > L.requestBodyBytes) throw failure("request body too large");
            buffer.set(part.value, size - part.value.byteLength);
            // An adversarial native Request stream can deliver infinitely many
            // immediately-resolved empty chunks. Yield periodically so the
            // earlier abort/deadline can run, without another retained queue.
            if (++chunks % 128 === 0) {
              await new Promise<void>((resume) => {
                resumeInput = resume;
                inputYield = setImmediate(() => {
                  inputYield = undefined;
                  resumeInput = undefined;
                  resume();
                });
                inputYield.unref();
              });
              if (done) return;
            }
          }
          body = buffer.subarray(0, size);
        } else {
          body = Buffer.alloc(0);
        }
        if (done) return;
        if (headers.has("content-length") && headers.get("content-length") !== String(body.byteLength)) {
          throw failure("conflicting Content-Length");
        }
        headers.set("content-length", String(body.byteLength));
        const headerPairs = [...headers];
        const path = `${target.pathname}${target.search}`;
        headerGroup(headerPairs.flat(), L.headerBytes);
        const wireBytes = Buffer.byteLength(
          `POST ${path} HTTP/1.1\r\n${headerPairs.map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`,
        );
        if (wireBytes > L.headerBytes) throw failure("request headers too large");
        if (bodyReader !== undefined) {
          bodyReader.releaseLock();
          bodyReader = undefined;
        }
        const hostname = target.hostname.replace(/^\[|\]$/g, "");
        const authority = `${target.hostname}:${target.port || "443"}`;
        const connectHeaders: Record<string, string> = { host: authority, connection: "close" };
        if (proxyAddress.auth !== undefined) {
          connectHeaders["proxy-authorization"] = `Basic ${Buffer.from(proxyAddress.auth).toString("base64")}`;
        }
        const connectBytes = Buffer.byteLength(
          `CONNECT ${authority} HTTP/1.1\r\n${Object.entries(connectHeaders)
            .map(([k, v]) => `${k}: ${v}\r\n`)
            .join("")}\r\n`,
        );
        if (connectBytes > L.connectHeaderBytes) throw failure("CONNECT headers too large");
        tunnel = http.request({
          host: proxyAddress.host.replace(/^\[|\]$/g, ""),
          port: proxyAddress.port,
          method: "CONNECT",
          path: authority,
          headers: connectHeaders,
          agent: false,
          maxHeaderSize: L.connectHeaderBytes,
        });
        // One sentinel pair beyond the bound: never accept silently truncated
        // rawHeaders (Node's maxHeadersCount otherwise truncates, not rejects).
        tunnel.maxHeadersCount = L.headerCount + 1;
        tunnel.once("socket", (transport: net.Socket) => {
          if (done) transport.destroy();
          else guardHeaderBytes(transport, L.connectHeaderBytes);
        });
        tunnel.on("error", fail);
        tunnel.on("information", (info) => {
          try {
            headerGroup(info.rawHeaders, L.connectHeaderBytes);
          } catch (err) {
            fail(err);
          }
        });
        tunnel.once("response", () => fail(failure("CONNECT refused")));
        tunnel.once("connect", (response, connected: net.Socket, head) => {
          socket = connected;
          if (done) {
            connected.destroy();
            return;
          }
          try {
            headerGroup(response.rawHeaders, L.connectHeaderBytes);
            if (response.statusCode !== 200) throw failure(`CONNECT failed (${response.statusCode})`);
            if (head.length !== 0) throw failure("unexpected CONNECT tunnel bytes");
            connected.on("error", fail);
            // Node 22 forwards this option to TLSSocket's Readable; the
            // @types/node ConnectionOptions surface does not yet declare it.
            const tlsOptions: tls.ConnectionOptions & { highWaterMark: number } = {
              highWaterMark: L.streamHighWaterMark,
              socket: connected,
              host: hostname,
              ...(net.isIP(hostname) === 0 ? { servername: hostname } : {}),
              rejectUnauthorized: true,
              ALPNProtocols: ["http/1.1"],
              ...(ca === undefined ? {} : { ca }),
            };
            secure = tls.connect(tlsOptions);
            secure.on("error", fail);
            secure.once("close", () => {
              if (!done && incoming === undefined) fail(failure("TLS closed before headers"));
            });
            secure.once("secureConnect", () => {
              if (done) return;
              try {
                if (!secure?.authorized) throw failure("TLS peer not authorized");
                // Explicit name check also covers IP targets without a DNS SNI.
                const nameError = tls.checkServerIdentity(hostname, secure.getPeerCertificate());
                if (nameError !== undefined) throw nameError;
                const verified = secure;
                guardHeaderBytes(verified, L.headerBytes);
                agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
                agent.createConnection = () => verified;
                request = http.request({
                  host: hostname,
                  port: Number(target.port || "443"),
                  method: "POST",
                  path,
                  headers: Object.fromEntries(headerPairs),
                  agent,
                  maxHeaderSize: L.headerBytes,
                });
                request.maxHeadersCount = L.headerCount + 1;
                request.on("error", fail);
                request.on("information", (info) => {
                  try {
                    headerGroup(info.rawHeaders, L.headerBytes);
                  } catch (err) {
                    fail(err);
                  }
                });
                request.on("upgrade", (_res, upgraded) => {
                  upgraded.destroy();
                  fail(failure("HTTP upgrade unsupported"));
                });
                request.once("response", (res) => {
                  incoming = res;
                  if (done) {
                    res.destroy();
                    return;
                  }
                  try {
                    headerGroup(res.rawHeaders, L.headerBytes);
                    const status = res.statusCode ?? 0;
                    if (status < 200 || status > 599) throw failure("invalid HTTP status");
                    const responseHeaders = new Headers();
                    for (let i = 0; i < res.rawHeaders.length; i += 2) {
                      responseHeaders.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
                    }
                    const encoding = responseHeaders.get("content-encoding");
                    if (encoding !== null && encoding.toLowerCase() !== "identity") {
                      throw failure("encoded response unsupported; identity required");
                    }
                    const length = responseHeaders.get("content-length");
                    if (length !== null && Number(length) > L.responseBodyBytes)
                      throw failure("response exceeds 1000000 byte cap");
                    responseHeaders.delete("transfer-encoding");
                    responseHeaders.delete("content-length");
                    nullBody = status === 204 || status === 205 || status === 304;
                    res.on("error", fail);
                    res.on("aborted", () => fail(failure("truncated response")));
                    res.on("close", () => {
                      if (!res.complete) fail(failure("truncated response"));
                    });
                    res.on("end", finish);
                    const stream = new ReadableStream<Uint8Array>(
                      {
                        start(c) {
                          controller = c;
                        },
                        pull() {
                          pump();
                        },
                        cancel() {
                          if (done) return;
                          done = true;
                          cleanup();
                        },
                      },
                      { highWaterMark: L.streamHighWaterMark, size: (chunk) => chunk.byteLength },
                    );
                    const result = new Response(nullBody ? null : stream, { status, headers: responseHeaders });
                    res.on("readable", pump);
                    published = true;
                    resolve(result);
                    pump();
                  } catch (err) {
                    fail(err);
                  }
                });
                request.end(body);
              } catch (err) {
                fail(err);
              }
            });
          } catch (err) {
            fail(err);
          }
        });
        tunnel.end();
      };
      void run().catch(fail);
    });
  };
}
