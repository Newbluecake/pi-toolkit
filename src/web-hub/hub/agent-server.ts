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
 * the dedicated audit log line instead.
 *
 * `hello_ack.caps` (C3, plan §3.1 — verified P0 fix): ALWAYS present, always
 * `[...admin.caps(), ...P2_HUB_CAPS]` (or just `P2_HUB_CAPS` when `deps.admin`
 * is absent, e.g. `agent-server.test.ts`'s direct-unit-test callers). This is
 * a frozen-protocol invariant, not a C0/P1 admin-wiring artifact: agent-side
 * `connection.ts`'s D14 slot gating reads `hello_ack.caps ?? []` to decide
 * whether to ever send the `dialogs`/`ctl`/`commands` slots at all — omitting
 * `caps` here makes every hub look like a pre-P2 hub to every agent.
 */
import type net from "node:net";
import { decodeAgentFrame, LIMITS, TIMING, type AgentFrame, type HubFrame } from "../protocol/messages.js";
import { encodeFrame, NdjsonDecoder } from "../protocol/ndjson.js";
import {
  P2_HUB_CAPS,
  PROTO,
  UPLOAD_HUB_CAPS,
  DIALOG_BG_HUB_CAPS,
  RUNTX_HUB_CAPS,
  protoCompatible,
} from "../protocol/version.js";
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
     * this module (`agent-server.test.ts`) never do. Either way `hello_ack.caps` is always sent
     * (C3, plan §3.1): `[...admin.caps(), ...P2_HUB_CAPS]` when present, plain `P2_HUB_CAPS` when
     * absent — never omitted, since agent-side D14 slot gating treats a missing `caps` as a
     * pre-P2 hub. */
    admin?: AdminHandler;
    /** C8/C10: scan rotate.intent on every successful hello. */
    onHello?: () => void;
    /** spawn-restore §9.3: when set, a `shutdown{reason:"restart"}` ack carries the hub's
     * restore-candidate count (`restoreCount`) so the TUI can say how many sessions come back. */
    restoreCount?: () => number;
    /** web-hub-spawn plan §SP10（arch §7.1）：hub 装配层逆来的追加 cap（`[SPAWN_HUB_CAP]`，仅
     * `config.spawn` 存在时）——与 hub.ts 的 `HubInfo.caps` 共用同一个数组，保持两面字节一致
     * （§3.1 compat matrix 不变量，同 UPLOAD/DIALOG_BG 的追加模式）。可选：缺省时 caps 与
     * 追加前逐字节一致。 */
    extraHubCaps?: readonly string[];
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
        try {
          deps.onHello?.();
        } catch (err) {
          log.error("web-hub agent-server: hello recovery hook failed", { error: String(err) });
        }
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
          caps: [
            ...(deps.admin?.caps() ?? []),
            ...P2_HUB_CAPS,
            ...UPLOAD_HUB_CAPS,
            // ask-user-async plan §7.2 (P3): same surface rule as UPLOAD_HUB_CAPS — must stay
            // byte-identical with hub.ts's browser-facing HubInfo.caps.
            ...DIALOG_BG_HUB_CAPS,
            // fleet-drawer plan §5.3 (F3b): same two-surface rule — inserted in the SAME
            // position as hub.ts's HubInfo.caps fold so the two lists stay byte-identical
            // (§8.4's caps-coexist test pins the set equality).
            ...RUNTX_HUB_CAPS,
            // web-hub-spawn plan §SP10: conditional cap tail (spawn.v1 + spawn.model.v1) —
            // 同源数组展开（集合/顺序一致，非同一实例）：hub.ts spreads the SAME source array into
            // HubInfo.caps, so the two surfaces can never drift.
            ...(deps.extraHubCaps ?? []),
          ],
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
        const meta = { agentKey, ...(agentPid === undefined ? {} : { agentPid }) };
        if (frame.op === "rotate_token") {
          // §6.7.1 (C8 verifier P0): the online rotate MUST NOT fall through to the shutdown
          // path — every hub_ctl op used to be acked and then shut the hub down.
          if (deps.admin !== undefined) {
            void deps.admin.handleRotateToken(meta).then(
              ({ revoked }) => write({ t: "hub_ctl_ack", rid: frame.rid, revoked }),
              (err: unknown) =>
                log.error("web-hub agent-server: admin rotate_token handler rejected", { error: String(err) }),
            );
          } else {
            write({ t: "hub_ctl_ack", rid: frame.rid });
          }
          return;
        }
        const rc = frame.reason === "restart" ? deps.restoreCount?.() : undefined;
        // 0 is omitted entirely — exact-shape ack consumers (and older TUI code reading the
        // frame) only ever see the field when there is something to restore.
        const restoreCount = rc !== undefined && rc > 0 ? rc : undefined;
        write({ t: "hub_ctl_ack", rid: frame.rid, ...(restoreCount === undefined ? {} : { restoreCount }) });
        deps.admin?.handleShutdown(meta, frame.reason);
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
