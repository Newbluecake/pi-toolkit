// Owned, loopback-only R3 integration environment. No environment/global CA or
// NODE_TLS_REJECT_UNAUTHORIZED changes; generated CA is passed to this fetch only.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";

export function streamTestCertificates(): { ca: string; cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "r3-stream-ca-"));
  const run = (...args: string[]): void => {
    execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  };
  try {
    run(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=R3 owned test CA",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
    );
    run(
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-keyout",
      "server.key",
      "-out",
      "server.csr",
    );
    writeFileSync(
      join(dir, "ext"),
      "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n",
    );
    run(
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      "ext",
      "-out",
      "server.pem",
    );
    return {
      ca: readFileSync(join(dir, "ca.pem"), "utf8"),
      cert: readFileSync(join(dir, "server.pem"), "utf8"),
      key: readFileSync(join(dir, "server.key"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export interface StreamLab {
  readonly url: string;
  readonly proxyUrl: string;
  readonly connects: http.IncomingMessage[];
  readonly requests: { headers: http.IncomingHttpHeaders; body: Buffer; path: string; sni: string | false | null }[];
  readonly idle: Promise<void>;
  readonly sockets: Set<net.Socket>;
  close(): Promise<void>;
}

export async function streamLab(
  certificates: ReturnType<typeof streamTestCertificates>,
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  connectReply?: string | { readonly successHeaders: string },
): Promise<StreamLab> {
  const connects: http.IncomingMessage[] = [];
  const requests: StreamLab["requests"] = [];
  const sockets = new Set<net.Socket>();
  const idle = deferred();
  const track = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => {
      sockets.delete(socket);
      if (sockets.size === 0) idle.resolve();
    });
  };
  const upstream = https.createServer(
    { key: certificates.key, cert: certificates.cert, maxHeaderSize: 65536 },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({
          headers: req.headers,
          body: Buffer.concat(chunks),
          path: req.url ?? "",
          sni: (req.socket as TLSSocket).servername,
        });
        handler(req, res);
      });
    },
  );
  upstream.on("connection", track);
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as net.AddressInfo).port;
  const proxy = http.createServer();
  proxy.on("connection", track);
  proxy.on("connect", (req, client: net.Socket) => {
    connects.push(req);
    // Upgraded HTTP sockets are half-open by default. This owned proxy closes
    // its endpoint when the client sends FIN, including deliberately silent
    // CONNECT/TLS test modes; do not mistake that server half for a client leak.
    client.once("end", () => client.destroy());
    if (connectReply === "silent") return;
    if (connectReply === "tls-silent") {
      client.write("HTTP/1.1 200 OK\r\n\r\n");
      client.resume(); // discard ClientHello so a subsequent FIN is observable
      return;
    }
    if (typeof connectReply === "string") {
      client.end(connectReply);
      return;
    }
    if (req.url !== `localhost:${port}` && req.url !== `127.0.0.1:${port}`) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    // Never relay anywhere except this lab's owned upstream.
    const remote = net.connect(port, "127.0.0.1", () => {
      client.write(connectReply?.successHeaders ?? "HTTP/1.1 200 Connection Established\r\n\r\n");
      remote.pipe(client);
      client.pipe(remote);
    });
    track(remote);
    client.once("close", () => remote.destroy());
    remote.once("close", () => client.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return {
    url: `https://localhost:${port}/chat?q=1`,
    proxyUrl: `http://proxy-user:proxy-password@127.0.0.1:${(proxy.address() as net.AddressInfo).port}`,
    connects,
    requests,
    idle: idle.promise,
    sockets,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((r) => proxy.close(() => r())),
        new Promise<void>((r) => upstream.close(() => r())),
      ]);
    },
  };
}
