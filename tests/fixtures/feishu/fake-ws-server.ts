/** F3 fixtures: deterministic WebSocket seam, plus a real minimal RFC6455 server
 * for testing the Node22 global WebSocket (no ws dependency). Test-only: no auth,
 * TLS or production protocol validation. Server scripts control delayed upgrade,
 * binary/text sends, drops and close stalls; every owned timer is unref'd. */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import type { FeishuSocket } from "../../../src/web-hub/hub/feishu/connector.js";
import type { FeishuClock } from "../../../src/web-hub/hub/feishu/http.js";
import { systemFeishuClock } from "../../../src/web-hub/hub/feishu/http.js";

export class ScriptedSocket implements FeishuSocket {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "blob";
  sent: Uint8Array[] = [];
  /** Send-time observations let tests distinguish immediate/open pings from periodic ones. */
  sentAt: number[] = [];
  closeCalls = 0;
  terminateCalls = 0;
  stallClose = false;
  throwSend = false;
  terminate?: () => void;
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  constructor(
    readonly url: string,
    private clock: FeishuClock,
    terminable: boolean,
  ) {
    if (terminable)
      this.terminate = () => {
        this.terminateCalls++;
        this.finishClose();
      };
  }
  addEventListener(type: string, fn: (event: any) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (event: any) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string, event: unknown = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  message(data: unknown): void {
    this.emit("message", { data });
  }
  send(data: Uint8Array): void {
    if (this.readyState !== 1 || this.throwSend) throw new Error("fake-send-failed");
    this.sent.push(Uint8Array.from(data));
    this.sentAt.push(this.clock.now());
  }
  close(): void {
    this.closeCalls++;
    if (this.readyState === 3) return;
    this.readyState = 2;
    if (!this.stallClose) this.clock.setTimeout(() => this.finishClose(), 0);
  }
  finishClose(code = 1000): void {
    this.readyState = 3;
    this.emit("close", { code });
  }
}
export function createFakeWebSockets(
  clock: FeishuClock,
  options: { autoOpen?: boolean; terminable?: boolean; stallClose?: boolean } = {},
) {
  const sockets: ScriptedSocket[] = [];
  let peak = 0;
  return {
    sockets,
    peak: () => peak,
    create(url: string): ScriptedSocket {
      const socket = new ScriptedSocket(url, clock, options.terminable ?? false);
      socket.stallClose = options.stallClose ?? false;
      sockets.push(socket);
      peak = Math.max(peak, sockets.filter((s) => s.readyState !== 3).length);
      if (options.autoOpen !== false) clock.setTimeout(() => socket.open(), 0);
      return socket;
    },
  };
}

export interface FakeWsPeer {
  readonly received: Uint8Array[];
  readonly closed: boolean;
  stallClose: boolean;
  send(data: Uint8Array | string): void;
  drop(): void;
}
function wire(opcode: number, bytes: Uint8Array): Buffer {
  const header =
    bytes.length < 126
      ? Buffer.from([0x80 | opcode, bytes.length])
      : bytes.length <= 65535
        ? Buffer.from([0x80 | opcode, 126, bytes.length >>> 8, bytes.length & 255])
        : Buffer.from([
            0x80 | opcode,
            127,
            0,
            0,
            0,
            0,
            bytes.length >>> 24,
            (bytes.length >>> 16) & 255,
            (bytes.length >>> 8) & 255,
            bytes.length & 255,
          ]);
  return Buffer.concat([header, bytes]);
}
export async function createFakeWsServer(
  options: { upgradeDelayMs?: number; stallClose?: boolean; clock?: FeishuClock } = {},
) {
  const clock = options.clock ?? systemFeishuClock;
  const peers: FakeWsPeer[] = [];
  const sockets = new Set<Socket>();
  const timers = new Set<unknown>();
  let peak = 0;
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, duplex, head) => {
    const socket = duplex as Socket;
    const upgrade = (): void => {
      if (socket.destroyed) return;
      const accept = createHash("sha1")
        .update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      let buffer: Buffer = Buffer.from(head);
      let closed = false;
      const peer: FakeWsPeer = {
        received: [],
        get closed() {
          return closed;
        },
        stallClose: options.stallClose ?? false,
        send(data) {
          socket.write(wire(typeof data === "string" ? 1 : 2, typeof data === "string" ? Buffer.from(data) : data));
        },
        drop() {
          socket.destroy();
        },
      };
      peers.push(peer);
      peak = Math.max(peak, peers.filter((p) => !p.closed).length);
      socket.once("close", () => {
        closed = true;
      });
      const parse = (): void => {
        while (buffer.length >= 2) {
          const opcode = buffer[0]! & 15,
            masked = (buffer[1]! & 128) !== 0;
          let size = buffer[1]! & 127,
            offset = 2;
          if (size === 126) {
            if (buffer.length < 4) return;
            size = buffer.readUInt16BE(2);
            offset = 4;
          } else if (size === 127) {
            if (buffer.length < 10) return;
            const n = buffer.readBigUInt64BE(2);
            if (n > 2_000_000n) {
              socket.destroy();
              return;
            }
            size = Number(n);
            offset = 10;
          }
          if (buffer.length < offset + (masked ? 4 : 0) + size) return;
          const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
          if (masked) offset += 4;
          const data = Buffer.from(buffer.subarray(offset, offset + size));
          if (mask) for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ mask[i % 4]!;
          buffer = buffer.subarray(offset + size);
          if (opcode === 8) {
            if (!peer.stallClose) socket.end(wire(8, data));
          } else if (opcode === 9) socket.write(wire(10, data));
          else if (opcode === 2) peer.received.push(data);
        }
      };
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        parse();
      });
      parse();
    };
    if (options.upgradeDelayMs) {
      const timer = clock.setTimeout(() => {
        timers.delete(timer);
        upgrade();
      }, options.upgradeDelayMs);
      timers.add(timer);
    } else upgrade();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake-ws-listen");
  return {
    url: `ws://127.0.0.1:${address.port}/ws`,
    peers,
    peak: () => peak,
    async dispose(): Promise<void> {
      for (const timer of timers) clock.clearTimeout(timer);
      timers.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
