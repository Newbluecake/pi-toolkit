// Local fake HTTP CONNECT proxy + fake TLS upstream for proxy-fetch.test.ts
// (jev-plan J2 §4 J2, 12-case list mirrored from hygiene-plan.md P5b). Pure
// `node:net`/`node:tls`/`node:http` servers bound to 127.0.0.1 — no network.
// Self-signed certs are generated via the system `openssl` CLI (test-only;
// production never shells out) — `opensslAvailable()` lets the test file
// skip TLS-dependent cases gracefully when it's missing.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tls from "node:tls";

export function opensslAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface GeneratedCert {
  readonly certPem: string;
  readonly keyPem: string;
}

/** Self-signed cert for `cn`, optionally with an `IP:` SAN entry (so a
 *  client connecting by IP and trusting this CA still succeeds hostname
 *  verification — omit it to produce a deliberate hostname mismatch). */
export function generateSelfSignedCert(cn: string, sanIp?: string): GeneratedCert {
  const dir = mkdtempSync(join(tmpdir(), "jev-fake-tls-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  const args = [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-nodes",
    "-subj",
    `/CN=${cn}`,
  ];
  if (sanIp !== undefined) args.push("-addext", `subjectAltName=IP:${sanIp}`);
  execFileSync("openssl", args, { stdio: "ignore" });
  return { certPem: readFileSync(certPath, "utf8"), keyPem: readFileSync(keyPath, "utf8") };
}

export type ProxyMode = "tunnel" | "407" | "502" | "no-response" | "bad-status-line";

export interface FakeProxyHandle {
  readonly port: number;
  connectCount(): number;
  close(): Promise<void>;
}

/** Minimal CONNECT-tunnelling HTTP proxy on 127.0.0.1. `tunnel` relays bytes
 *  to the real target; the other modes simulate proxy-side failures. */
export async function startFakeProxy(mode: ProxyMode = "tunnel"): Promise<FakeProxyHandle> {
  let count = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(400);
    res.end();
  });
  server.on("connect", (req, clientSocket: net.Socket, head: Buffer) => {
    count += 1;
    if (mode === "407") {
      clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (mode === "502") {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (mode === "no-response") return; // caller's own timeout must fire
    if (mode === "bad-status-line") {
      clientSocket.end("not even http\r\n\r\n");
      return;
    }
    const [host, portStr] = (req.url ?? "").split(":");
    const upstream = net.connect(Number(portStr), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    connectCount: () => count,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A port guaranteed to have nothing listening on it (bind then release),
 *  for ECONNREFUSED-style tests. */
export async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export type UpstreamMode = "json" | "chunked" | "large" | "silent" | "delay";

export interface FakeUpstreamOptions {
  readonly cert: GeneratedCert;
  readonly mode?: UpstreamMode;
  readonly status?: number;
  readonly jsonBody?: unknown;
  readonly delayMs?: number;
}

export interface FakeUpstreamHandle {
  readonly port: number;
  requestCount(): number;
  close(): Promise<void>;
}

/** Fake TLS upstream speaking a single request/response per connection
 *  (jev-arch §5.4's one-shot framing). */
export async function startFakeTlsUpstream(opts: FakeUpstreamOptions): Promise<FakeUpstreamHandle> {
  let count = 0;
  const status = opts.status ?? 200;
  const body = JSON.stringify(opts.jsonBody ?? { answers: { e1: { type: "bool", probability: 0.5 } } });

  function respond(socket: tls.TLSSocket): void {
    count += 1;
    if (opts.mode === "silent") return;
    const send = (): void => {
      if (opts.mode === "chunked") {
        const mid = Math.ceil(body.length / 2);
        const chunks = [body.slice(0, mid), body.slice(mid)];
        socket.write(`HTTP/1.1 ${status} OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`);
        for (const c of chunks) if (c.length > 0) socket.write(`${c.length.toString(16)}\r\n${c}\r\n`);
        socket.end("0\r\n\r\n");
        return;
      }
      if (opts.mode === "large") {
        const big = "x".repeat(2_000_000);
        socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${big.length}\r\nConnection: close\r\n\r\n`);
        socket.end(big);
        return;
      }
      socket.end(
        `HTTP/1.1 ${status} OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    };
    if (opts.mode === "delay") setTimeout(send, opts.delayMs ?? 5_000).unref();
    else send();
  }

  const server = tls.createServer({ cert: opts.cert.certPem, key: opts.cert.keyPem }, (socket) => {
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      if (buf.includes("\r\n\r\n")) respond(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    requestCount: () => count,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
