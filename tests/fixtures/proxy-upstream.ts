/** Controllable real HTTP + raw WebSocket upstream. Every listener/socket/timer is owned here. */
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";
import { once } from "node:events";

export async function proxyUpstream() {
  const sockets = new Set<Socket>();
  const held = new Set<ServerResponse>();
  const upgraded = new Set<Socket>();
  const requests: Array<{ path: string; headers: IncomingHttpHeaders; method: string | undefined; bytes: number }> = [];
  let connections = 0;
  let peakHeld = 0;
  const server = createServer((req, res) => {
    const rec = { path: req.url ?? "", headers: req.headers, method: req.method, bytes: 0 };
    requests.push(rec);
    req.on("data", (b: Buffer) => {
      rec.bytes += b.length;
    });
    if (req.url === "/hang" || req.url === "/slow-head") {
      held.add(res);
      peakHeld = Math.max(peakHeld, held.size);
      res.on("close", () => held.delete(res));
      return;
    }
    if (req.url === "/stall-body") {
      res.writeHead(200);
      res.write("start");
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "http://10.0.0.9/private?secret=1" });
      res.end();
      return;
    }
    if (req.url === "/headers") {
      res.setHeader("Clear-Site-Data", '"cookies","storage"');
      res.setHeader("Set-Cookie", [
        "pwh_sid=ATTACK; Path=/",
        "PwH_lan=ATTACK; Path=/",
        "app=ok; Domain=localhost; Path=/",
      ]);
    }
    if (req.url === "/huge" || req.url === "/flood") {
      let remaining = req.url === "/huge" ? 4 * 1024 * 1024 : 1024 * 1024 * 1024;
      const chunk = Buffer.alloc(65536, 0x61);
      const write = () => {
        while (!res.destroyed && remaining > 0) {
          remaining -= chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", write);
            return;
          }
        }
        if (!res.destroyed) res.end();
      };
      write();
      return;
    }
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(rec));
    });
  });
  server.on("connection", (socket) => {
    connections++;
    sockets.add(socket);
    socket.unref();
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, raw, head) => {
    const socket = raw as Socket;
    requests.push({ path: req.url ?? "", headers: req.headers, method: req.method, bytes: head.length });
    if (req.url === "/ws-stall") return;
    if (req.url === "/ws-reject") {
      socket.end(
        'HTTP/1.1 403 Forbidden\r\nClear-Site-Data: "cookies"\r\nSet-Cookie: pwh_sid=BAD\r\nSet-Cookie: app=ok; Domain=localhost\r\nContent-Length: 100000\r\n\r\n' +
          "x".repeat(100000),
      );
      return;
    }
    const accept = createHash("sha1")
      .update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nClear-Site-Data: "cookies"\r\nSet-Cookie: pwh_sid=BAD\r\nSet-Cookie: app=ok; Domain=localhost\r\n\r\n`,
    );
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
    if (head.length) socket.write(head);
    socket.pipe(socket); // raw frame echo: no frame parsing needed by either end of the proxy
  });
  server.listen(0, "127.0.0.1");
  server.unref();
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    server,
    port,
    requests,
    sockets,
    upgraded,
    get connections() {
      return connections;
    },
    get held() {
      return held.size;
    },
    get peakHeld() {
      return peakHeld;
    },
    release() {
      for (const res of [...held]) res.end("released");
    },
    async close() {
      const closing = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await closing;
    },
  };
}
