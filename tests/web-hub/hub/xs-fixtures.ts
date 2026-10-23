/** Shared builders for the fabric phase-2 X1 hub tests (registry-level, no sockets). */
import type { AgentFrame, XsMemberFrame } from "../../../src/web-hub/protocol/messages.js";
import type { XsMemberLimitsWire } from "../../../src/web-hub/protocol/xs.js";
import { createRegistry, type Registry } from "../../../src/web-hub/hub/registry.js";
import { createXsRelay, type XsRelay } from "../../../src/web-hub/hub/xs/router.js";
import { fakeConn, hello, memLog, type FakeConn, type MemLog } from "./helpers.js";

export const LIMITS: XsMemberLimitsWire = {
  sendsOutPerMin: 10,
  sendsOutPerHour: 60,
  wakesOutPerHour: 6,
  pairMinIntervalMs: 5_000,
  pairWakesPerHour: 2,
  inFlightPerSession: 4,
  listPerMin: 6,
};

export const session = (over: Partial<Extract<AgentFrame, { t: "session" }>> = {}): AgentFrame => ({
  t: "session",
  sessionId: "s1",
  cwd: "/tmp/work",
  reason: "startup",
  leafId: "L1",
  mode: "tui",
  ...over,
});

export const memberFrame = (over: Partial<XsMemberFrame> = {}): AgentFrame => ({
  t: "xs_member",
  sessionId: "s1",
  epoch: 1,
  joined: true,
  receive: "wake",
  limits: { ...LIMITS },
  ...over,
});

export interface Rig {
  clock: { t: number };
  registry: Registry;
  relay: XsRelay;
  log: MemLog;
  /** Register an agent with `xs.v1`, send session + xs_member; returns its key + fake conn. */
  agent(opts: {
    pid: number;
    sessionId: string;
    name?: string;
    cwd?: string;
    epoch?: number;
    joined?: boolean;
    receive?: "off" | "deliver" | "wake" | "replies";
    caps?: string[];
    limits?: Partial<XsMemberLimitsWire>;
    skipMember?: boolean;
    /** Channel-plan: the `xs_member.channels` key (absent ⇒ not written). */
    channels?: string[];
  }): { key: string; conn: FakeConn };
}

/** Channel-plan: caps of a channel-capable (new) agent. */
export const CHANNEL_CAPS = ["ev.v1", "xs.v1", "xs.reply.v1", "xs.channel.v1"];
/** Broadcast keys a new agent with named channels declares (§6.4 defaults). */
export const BCAST_LIMITS: Partial<XsMemberLimitsWire> = {
  broadcastsOutPerHour: 6,
  broadcastMinIntervalMs: 60_000,
  broadcastWakesOutPerHour: 2,
};

export function rig(hubSendsPerMin = 60, channels?: { maxRecipients: number; wakeMaxRecipients: number }): Rig {
  const clock = { t: 1_000_000 };
  const log = memLog();
  const registry = createRegistry({ now: () => clock.t, log, pidAlive: () => true });
  const relay = createXsRelay({
    registry,
    config: {
      home: "/home/u",
      crossSession: { limits: { hubSendsPerMin }, ...(channels === undefined ? {} : { channels }) },
    },
    log,
    now: () => clock.t,
  });
  return {
    clock,
    registry,
    relay,
    log,
    agent(o) {
      const conn = fakeConn();
      const { agentKey } = registry.register(
        hello({
          agentId: { pid: o.pid, nonce: `nonce${String(o.pid).padStart(15, "0")}` },
          caps: o.caps ?? ["ev.v1", "xs.v1"],
          cwd: o.cwd ?? "/tmp/work",
        }),
        conn,
      );
      registry.onFrame(
        agentKey,
        session({
          sessionId: o.sessionId,
          cwd: o.cwd ?? "/tmp/work",
          ...(o.name !== undefined ? { name: o.name } : {}),
        }),
      );
      if (o.skipMember !== true) {
        registry.onFrame(
          agentKey,
          memberFrame({
            sessionId: o.sessionId,
            epoch: o.epoch ?? 1,
            joined: o.joined ?? true,
            receive: o.receive ?? "wake",
            limits: { ...LIMITS, ...o.limits },
            ...(o.channels === undefined ? {} : { channels: o.channels }),
          }),
        );
      }
      return { key: agentKey, conn };
    },
  };
}
