/** Raw WebSocket tunnel: opaque frames, pinned dial, bounded handshake and stream backpressure. */
import { request, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { FilteredProxyHeaders } from "./headers.js";
import { filterRequestHeaders, filterResponseHeaders } from "./headers.js";
import { systemProxyTimer } from "./dns-gate.js";
import type { ProxyForwardDeps, ProxyRequestGate } from "./forward.js";
import {
  PROXY_WS_HANDSHAKE_MS,
  PROXY_WS_IDLE_MS,
  PROXY_WS_PER_INSTANCE,
  PROXY_WS_GLOBAL,
  PROXY_WS_NON101_BODY_MAX_BYTES,
  PROXY_MAX_HEADER_BYTES,
  PROXY_STREAM_HWM_BYTES,
  PROXY_LISTENER_STATUS as STATUS,
} from "../../protocol/proxy.js";

/** service-owned (not module-global); includes handshakes and non-101 relays. */
export interface ProxyWsBudget {
  active: number;
}
export function proxyResponseHead(status: number, headers: FilteredProxyHeaders): string {
  let text = `HTTP/1.1 ${status} ${status === 101 ? "Switching Protocols" : "Proxy Response"}\r\n`;
  for (const [name, value] of Object.entries(headers)) {
    for (const line of Array.isArray(value) ? value : [value]) text += `${name}: ${line}\r\n`;
  }
  return text + "\r\n";
}
export interface ProxyWsDeps extends Omit<ProxyForwardDeps, "admission" | "reply"> {
  budget: ProxyWsBudget;
  upgraded: Set<Socket>;
  reject(socket: Socket, status: number): void;
}
export function createProxyWebSockets(deps: ProxyWsDeps) {
  const timer = deps.timer ?? systemProxyTimer;
  const cancels = new Set<() => void>();
  let active = 0;
  let closing = false;
  return {
    /** Called only after the listener's gate. Its immediately-armed timer is transferred here. */
    handle(req: IncomingMessage, socket: Socket, head: Buffer, gate: ProxyRequestGate, cancelHandshake: () => void) {
      if (closing || active >= PROXY_WS_PER_INSTANCE || deps.budget.active >= PROXY_WS_GLOBAL) {
        deps.reject(socket, STATUS.busy);
        return;
      }
      active++;
      deps.budget.active++;
      let done = false;
      let responded = false;
      let upSocket: Socket | undefined;
      let hardCancel = () => {};
      let up: ReturnType<typeof request> | undefined;
      const cleanup = () => {
        if (done) return;
        done = true;
        active--;
        deps.budget.active--;
        cancelHandshake();
        hardCancel();
        cancels.delete(cleanup);
        deps.sessions.detach(gate.session, revoker);
        deps.upgraded.delete(socket);
        if (upSocket !== undefined) deps.upgraded.delete(upSocket);
        socket.destroy();
        upSocket?.destroy();
        up?.destroy();
      };
      const revoker = { destroy: cleanup };
      cancels.add(cleanup);
      socket.once("close", cleanup);
      socket.on("error", cleanup);
      if (!deps.sessions.attach(gate.session, revoker)) {
        cleanup();
        return;
      }
      hardCancel = timer.after(Math.max(1, gate.session.hardAt - deps.now()), cleanup);
      const ctx = {
        ...deps.pinned,
        ...gate,
        target: deps.pinned.target,
        ws: true,
        peer: socket.remoteAddress ?? "",
        browserHost: gate.browserHost,
      };
      try {
        up = request({
          host: deps.pinned.pinnedIp,
          port: deps.pinned.target.port,
          method: "GET",
          path: req.url,
          headers: filterRequestHeaders(req.headers, ctx),
          setHost: false,
          agent: false,
          maxHeaderSize: PROXY_MAX_HEADER_BYTES,
          ...{ highWaterMark: PROXY_STREAM_HWM_BYTES },
        });
      } catch {
        deps.reject(socket, STATUS.badGateway);
        return;
      }
      up.on("socket", (s) => s.unref());
      up.on("error", () => {
        if (!done) {
          if (responded) {
            cleanup();
            return;
          }
          deps.reject(socket, STATUS.badGateway);
        }
      });
      up.on("upgrade", (res, raw, upHead) => {
        const remote = raw as Socket;
        if (done || socket.destroyed || !deps.sessions.isLive(gate.session)) {
          remote.destroy();
          cleanup();
          return;
        }
        upSocket = remote;
        deps.upgraded.add(socket);
        deps.upgraded.add(remote);
        remote.unref();
        socket.setNoDelay(true);
        remote.setNoDelay(true);
        remote.on("error", cleanup);
        remote.once("close", cleanup);
        socket.setTimeout(PROXY_WS_IDLE_MS, cleanup);
        remote.setTimeout(PROXY_WS_IDLE_MS, cleanup);
        const touch = () => {
          if (!deps.sessions.touch(gate.session, "ws")) cleanup();
        };
        socket.on("data", (chunk: Buffer) => {
          deps.traffic.bytesUp += chunk.length;
          gate.traffic.bytesUp += chunk.length;
          touch();
        });
        remote.on("data", (chunk: Buffer) => {
          deps.traffic.bytesDown += chunk.length;
          gate.traffic.bytesDown += chunk.length;
          touch();
        });
        // Start piping only after each initial write drains; never ignore write() backpressure.
        socket.pause();
        remote.pause();
        const start = () => {
          if (done) return;
          if (head.length > 0 && !remote.write(head)) remote.once("drain", pipe);
          else pipe();
        };
        const pipe = () => {
          if (!done) {
            socket.pipe(remote);
            remote.pipe(socket);
          }
        };
        responded = true;
        socket.write(proxyResponseHead(101, filterResponseHeaders(res.headers, ctx)), () => {
          if (done || socket.destroyed) return;
          cancelHandshake(); // only once 101 has actually been written (§R2 #11)
          deps.traffic.ws++;
          gate.traffic.ws++;
          if (upHead.length > 0 && !socket.write(upHead)) socket.once("drain", start);
          else start();
        });
      });
      up.on("response", (res) => {
        if (done) {
          res.destroy();
          return;
        }
        const headers = filterResponseHeaders(res.headers, { ...ctx, ws: false });
        delete headers["content-length"];
        headers.connection = "close";
        responded = true;
        socket.write(proxyResponseHead(res.statusCode ?? STATUS.badGateway, headers));
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          const keep = chunk.subarray(0, Math.max(0, PROXY_WS_NON101_BODY_MAX_BYTES - bytes));
          bytes += keep.length;
          if (keep.length > 0 && !socket.write(keep)) {
            res.pause();
            socket.once("drain", () => res.resume());
          }
          if (bytes >= PROXY_WS_NON101_BODY_MAX_BYTES) {
            res.destroy();
            socket.end(cleanup);
          }
        });
        res.on("end", () => socket.end(cleanup));
        res.on("error", cleanup);
        // Premature response close must not leave the gate/WS capacity occupied.
        res.on("close", () => {
          if (!res.complete) socket.end(cleanup);
        });
      });
      up.end();
    },
    close() {
      closing = true;
      for (const cancel of [...cancels]) cancel();
    },
    active: () => active,
  };
}

/** Arm BEFORE any gate/upstream work. Caller installs this on the raw upgrade socket. */
export function armProxyHandshake(socket: Socket, timer = systemProxyTimer): () => void {
  const cancel = timer.after(PROXY_WS_HANDSHAKE_MS, () => socket.destroy());
  socket.once("close", cancel);
  return cancel;
}
