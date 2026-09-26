/**
 * hub side of the agent socket (plan §包 B): per connection NdjsonDecoder →
 * `hello` within TIMING.helloAckMs → validate → `hello_ack` / `hello_reject`;
 * hub pings every TIMING.pingMs; TIMING.silenceMs without any inbound byte ⇒
 * disconnect. Oversized frames (> MAX_FRAME_BYTES) ⇒ disconnect.
 *
 * A connection superseded by a reclaim (`AgentConn.close("reclaimed")`) never
 * reports `onClose` — the registry record already belongs to the new socket.
 *
 * `lan_req` / `hub_ctl` (plan §8, S1-W3 LD 包): dispatched to `deps.admin`
 * (`admin.ts`) *before* `registry.onFrame` is ever called — same-uid admin
 * frames must never enter the registry, the bus, or this file's own normal
 * per-frame logging (§8.1 "不进 registry、bus 和普通日志"); `admin.ts` owns
 * the dedicated audit log line instead. `deps.admin` is `undefined` in every
 * P1/direct-unit-test caller (agent-server.test.ts) — `hello_ack.caps` is
 * only emitted when it is provided (only `hub.ts`'s real assembly does),
 * which is also why those tests' exact `toEqual` on `hello_ack` stays
 * byte-identical (§1.4.4).
 */
import type net from "node:net";
import { decodeAgentFrame, LIMITS, TIMING, type AgentFrame, type HubFrame } from "../protocol/messages.js";
import { encodeFrame, NdjsonDecoder } from "../protocol/ndjson.js";
import { PROTO, protoCompatible } from "../protocol/version.js";
import type { AdminHandler } from "./admin.js";
import type { HubConfig, HubLog } from "./ports.js";
import type { AgentConn, Registry } from "./registry.js";

export interface AgentServer {
  connectionCount(): number;
  close(): Promise<void>;
}

const REJECT_LINGER_MS = 1_000;
const RETRY_BAD_HELLO_MS = 5_000;
const RETRY_PROTO_MS = 30_000;

export function createAgentServer(
  server: import("node:net").Server,
  deps: {
    registry: Registry;
    config: HubConfig;
    log: HubLog;
    now: () => number;
    httpPort: () => number;
    /** Only `hub.ts`'s real assembly provides this (plan §8, S1-W3 LD); direct unit tests of
     * this module never do, which is exactly what keeps their `hello_ack` `toEqual` assertions
     * byte-identical (§1.4.4) — `caps` is omitted entirely, not `undefined`-valued, when absent. */
    admin?: AdminHandler;
  },
): AgentServer {
  const { registry, config, log, now } = deps;
  const conns = new Set<{ sock: net.Socket; teardown: () => void }>();
  let closed = false;

  const onConnection = (sock: net.Socket): void => {
    if (closed) {
      sock.destroy();
      return;
    }
    sock.unref();
    let agentKey: string | undefined;
    let agentPid: number | undefined;
    let hadBye = false;
    let superseded = false;
    let finished = false;
    let finishedPreHello = false; // hello rejected: ignore everything until the socket closes

    const destroy = (reason: string): void => {
      if (finished) return;
      log.info("agent connection closed by hub", { agentKey, reason });
      sock.destroy();
    };

    const write = (frame: HubFrame): void => {
      if (sock.destroyed || !sock.writable) return;
      if (sock.writableLength > LIMITS.hardQueueBytes) {
        destroy("hub→agent write queue over hard limit");
        return;
      }
      sock.write(encodeFrame(frame));
    };

    const helloTimer = setTimeout(() => destroy("no hello"), TIMING.helloAckMs);
    helloTimer.unref();
    let silenceTimer = setTimeout(() => destroy("silence"), TIMING.silenceMs);
    silenceTimer.unref();
    const pingTimer = setInterval(() => {
      if (agentKey !== undefined) write({ t: "ping", ts: now() });
    }, TIMING.pingMs);
    pingTimer.unref();

    const reject = (code: "E_PROTO" | "E_BAD_HELLO", message: string, retryAfterMs: number): void => {
      clearTimeout(helloTimer);
      log.warn("hello rejected", { code, message });
      write({ t: "hello_reject", code, message, retryAfterMs });
      sock.end();
      const linger = setTimeout(() => sock.destroy(), REJECT_LINGER_MS);
      linger.unref();
      finishedPreHello = true;
    };

    const conn: AgentConn = {
      send: write,
      close(reason) {
        superseded = true;
        destroy(reason);
      },
    };

    const onFrame = (raw: unknown): void => {
      if (finishedPreHello || sock.destroyed) return;
      if (agentKey === undefined) {
        const t = rawType(raw);
        if (t !== "hello") return; // only hello is meaningful before the handshake
        const hello = decodeAgentFrame(raw);
        if (hello === undefined || hello.t !== "hello") {
          reject("E_BAD_HELLO", "hello failed validation", RETRY_BAD_HELLO_MS);
          return;
        }
        if (!protoCompatible(hello.proto)) {
          reject(
            "E_PROTO",
            `protocol ${hello.proto.major}.${hello.proto.minor} unsupported (hub ${PROTO.major}.${PROTO.minor})`,
            RETRY_PROTO_MS,
          );
          return;
        }
        clearTimeout(helloTimer);
        agentKey = registry.register(hello, conn).agentKey;
        agentPid = hello.agentId.pid;
        write({
          t: "hello_ack",
          hubVersion: config.pluginVersion,
          buildId: config.buildId,
          proto: { major: PROTO.major, minor: PROTO.minor },
          agentKey,
          pingMs: TIMING.pingMs,
          leaseMs: TIMING.staleMs,
          http: { port: deps.httpPort() },
          ...(deps.admin === undefined ? {} : { caps: deps.admin.caps() }),
        });
        return;
      }
      const frame: AgentFrame | undefined = decodeAgentFrame(raw);
      if (frame === undefined) return; // unknown / reserved / invalid: ignored
      if (frame.t === "hello") return;
      if (frame.t === "ping") {
        write({ t: "pong", ts: frame.ts });
        registry.onFrame(agentKey, frame);
        return;
      }
      // §8.1: same-uid admin frames never reach the registry, the bus, or this file's own
      // per-frame logging — dispatched to `admin.ts` instead (which owns the audit log line).
      if (frame.t === "lan_req") {
        if (deps.admin !== undefined) {
          deps.admin
            .handleLanReq(frame, { agentKey, ...(agentPid === undefined ? {} : { agentPid }) })
            .then(write, (err: unknown) =>
              log.error("web-hub agent-server: admin lan_req handler rejected", { error: String(err) }),
            );
        }
        return;
      }
      if (frame.t === "hub_ctl") {
        write({ t: "hub_ctl_ack", rid: frame.rid });
        deps.admin?.handleShutdown({ agentKey, ...(agentPid === undefined ? {} : { agentPid }) });
        return;
      }
      registry.onFrame(agentKey, frame);
      if (frame.t === "bye") {
        hadBye = true;
        sock.end();
        const linger = setTimeout(() => sock.destroy(), REJECT_LINGER_MS);
        linger.unref();
      }
    };

    const decoder = new NdjsonDecoder({
      onFrame,
      onError: (err) => {
        if (err.code === "E_FRAME_TOO_LARGE") {
          log.warn("agent frame too large", { agentKey, bytes: err.bytes });
          destroy("frame too large");
        } else {
          log.warn("agent sent bad json", { agentKey, sample: err.sample.slice(0, 80) });
        }
      },
    });

    sock.on("data", (chunk: Buffer) => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => destroy("silence"), TIMING.silenceMs);
      silenceTimer.unref();
      decoder.push(chunk);
    });
    sock.on("error", (err) => {
      log.warn("agent socket error", { agentKey, error: err.message });
    });

    const teardown = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(helloTimer);
      clearTimeout(silenceTimer);
      clearInterval(pingTimer);
    };
    const entry = { sock, teardown };
    conns.add(entry);
    sock.on("close", () => {
      teardown();
      conns.delete(entry);
      if (agentKey !== undefined && !superseded) registry.onClose(agentKey, hadBye);
    });
  };

  server.on("connection", onConnection);

  return {
    connectionCount: () => conns.size,
    close: async () => {
      if (closed) return;
      closed = true;
      server.removeListener("connection", onConnection);
      const waits: Array<Promise<void>> = [];
      for (const { sock } of [...conns]) {
        waits.push(
          new Promise<void>((resolve) => {
            if (sock.destroyed) {
              resolve();
              return;
            }
            sock.once("close", () => resolve());
            sock.destroy();
          }),
        );
      }
      await Promise.race([
        Promise.all(waits).then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, REJECT_LINGER_MS).unref()),
      ]);
    },
  };
}

function rawType(raw: unknown): unknown {
  return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)["t"] : undefined;
}
