/** Real production wireWebHub -> HubConnection -> outbound NDJSON bytes. Physical
 * factory is DI, XS transform uses its production implementation with fault injection.
 * Critically assert the FIRST reconnect status, before onHubCaps can republish. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalOwnerOptions } from "../../../src/web-hub/agent/terminal/owner.js";
import type { AgentFrame } from "../../../src/web-hub/protocol/messages.js";
import type { SlotFlush } from "../../../src/web-hub/agent/connection.js";
const faults = vi.hoisted(() => ({ xsThrow: false }));
vi.mock("../../../src/web-hub/agent/xs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/web-hub/agent/xs.js")>();
  return {
    ...actual,
    createXsAgentBridge: (...args: Parameters<typeof actual.createXsAgentBridge>) => {
      const bridge = actual.createXsAgentBridge(...args);
      const original = bridge.slotFlush;
      bridge.slotFlush = (frame, caps) => {
        if (faults.xsThrow) throw new Error("XS transform secret body");
        return original(frame, caps);
      };
      return bridge;
    },
  };
});
import { wireWebHub } from "../../../src/web-hub/agent/index.js";
import { currentConnection, MODULE_INSTANCE } from "../../../src/web-hub/agent/connection.js";
import {
  ackFrame,
  fakeCtx,
  fakeNet,
  fakePi,
  pathsIn,
  resetGlobals,
  SETTINGS,
  tmpDir,
  type FakeSocket,
} from "./helpers.js";
const limits = { maxPerSession: 2, maxPerPrincipal: 2, maxTotal: 8, inputIdleMs: 3600000, maxLifetimeMs: 28800000 };
let tmp: ReturnType<typeof tmpDir>;
let shutdown: (() => void) | undefined;
beforeEach(() => {
  tmp = tmpDir("ts-");
  resetGlobals();
  vi.useFakeTimers();
  faults.xsThrow = false;
});
afterEach(() => {
  shutdown?.();
  shutdown = undefined;
  resetGlobals();
  vi.useRealTimers();
  tmp.cleanup();
});
async function setup(on = true, ready = true) {
  const a = fakePi(),
    n = fakeNet(),
    c = fakeCtx();
  let guard: boolean | "throw" = true;
  const owners: Array<{
    options: TerminalOwnerOptions;
    ready: ReturnType<typeof vi.fn>;
    linkLost: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
  }> = [];
  wireWebHub(a.pi, {
    settings: { ...SETTINGS, ...(on ? { terminal: { ...limits, enabled: true } } : {}) },
    terminalGuard: () => {
      if (guard === "throw") throw new Error("secret cwd");
      return guard;
    },
    terminalOwnerFactory: async (options) => {
      const o = {
        options,
        ready: vi.fn(() => ready),
        offer: vi.fn(),
        receive: vi.fn(),
        linkLost: vi.fn(),
        revoke: vi.fn(),
        dispose: vi.fn(async () => {}),
      };
      owners.push(o);
      return o as never;
    },
    privateNs: () => ({ gate: "not-ns" }),
    xs: {
      stack: () => ({
        sessionId: () => c.ctx.sessionManager.getSessionId(),
        member: () => ({ epoch: 1, joined: true, receive: "replies" }),
        deliver: () => ({ effect: "none", reason: "rejected", woke: false }),
        status: () => ({ joined: true, receive: "replies", blocked: 0 }),
      }),
      memberLimits: () => ({
        sendsOutPerMin: 10,
        sendsOutPerHour: 60,
        wakesOutPerHour: 6,
        pairMinIntervalMs: 30000,
        pairWakesPerHour: 2,
        inFlightPerSession: 4,
        listPerMin: 6,
      }),
      hubSendsPerMin: () => 60,
      replyEnabled: () => true,
    },
    fleet: () => [],
    paths: pathsIn(tmp.dir),
    env: { HOME: tmp.dir },
    netConnect: n.netConnect,
    argv1: "/missing/pi",
    buildInfo: async () => ({ pluginVersion: "1", buildId: "terminal-session" }),
  });
  shutdown = () => a.fire("session_shutdown", { reason: "quit" }, c.ctx);
  a.fire("session_start", { reason: "startup" }, c.ctx);
  await vi.advanceTimersByTimeAsync(0);
  const up = (s: FakeSocket, caps = ["cmd.v1", "command.v1", "xs.v1", "xs.reply.v1"]) => {
    s.emit("connect");
    s.hub(ackFrame("terminal", 4242, caps));
    return s;
  };
  const socket = up(n.sockets.at(-1)!);
  await vi.advanceTimersByTimeAsync(0);
  const reconnect = async (caps?: string[]) => {
    const count = n.sockets.length;
    socket.fail("ECONNRESET");
    for (let i = 0; i < 60 && n.sockets.length === count; i++) await vi.advanceTimersByTimeAsync(100);
    expect(n.sockets.length).toBe(count + 1);
    return up(n.sockets.at(-1)!, caps);
  };
  return {
    a,
    c,
    n,
    socket,
    owners,
    up,
    reconnect,
    setGuard: (g: typeof guard) => {
      guard = g;
    },
  };
}
const statuses = (s: FakeSocket) =>
  s.written
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((f) => f.t === "status");
function stored() {
  const slots = (currentConnection() as unknown as { slots: Map<string, { frame: AgentFrame; flush: SlotFlush }> })
    .slots;
  const entry = slots.get("status");
  expect(entry).toBeDefined();
  return entry!;
}
describe("terminal status write-time declaration (T6)", () => {
  it("raw stored status has no claim; every write gets current readiness; ordinary XS is still transformed", async () => {
    const h = await setup();
    expect(statuses(h.socket)[0]?.terminalSession).toEqual({
      v: 1,
      enabled: true,
      sessionId: "sess-1",
      epoch: MODULE_INSTANCE,
      limits,
    });
    expect(stored().frame).not.toHaveProperty("terminalSession");
    const next = await h.reconnect(["cmd.v1", "command.v1", "xs.v1"]);
    expect(statuses(next)[0]?.terminalSession).toMatchObject({ sessionId: "sess-1" });
    expect(statuses(next)[0]?.xs).toMatchObject({ receive: "off" });
    expect(stored().frame).not.toHaveProperty("terminalSession");
  });
  it.each([false, "throw"] as const)(
    "first reconnect status withdraws guard=%s without stale positive replay",
    async (guard) => {
      const h = await setup();
      expect(statuses(h.socket)[0]).toHaveProperty("terminalSession");
      h.setGuard(guard);
      const next = await h.reconnect();
      expect(statuses(next).length).toBeGreaterThan(0);
      expect(statuses(next)[0]).not.toHaveProperty("terminalSession");
      expect(h.owners[0]!.revoke).toHaveBeenCalled();
    },
  );
  it("XS transform throws: total fallback AND connection generic throw fallback have no declaration", async () => {
    const h = await setup();
    expect(statuses(h.socket)[0]).toHaveProperty("terminalSession");
    faults.xsThrow = true;
    const next = await h.reconnect();
    expect(statuses(next)[0]).not.toHaveProperty("terminalSession");
    expect(statuses(next)[0]).toMatchObject({ t: "status", busy: false });
    const entry = stored();
    expect(entry.frame).not.toHaveProperty("terminalSession");
    entry.flush = () => {
      throw new Error("feature transform unexpectedly throws");
    };
    // Exercise the REAL generic connection.flushSlot catch on first ack replay.
    next.fail("ECONNRESET");
    const count = h.n.sockets.length;
    for (let i = 0; i < 60 && h.n.sockets.length === count; i++) await vi.advanceTimersByTimeAsync(100);
    const final = h.up(h.n.sockets.at(-1)!);
    expect(statuses(final)[0]).not.toHaveProperty("terminalSession");
  });
  it("generic SlotFlush catch returns first reconnect raw frame without a cached positive", async () => {
    const h = await setup();
    expect(statuses(h.socket)[0]).toHaveProperty("terminalSession");
    stored().flush = () => {
      throw new Error("unexpected feature throw");
    };
    const next = await h.reconnect(); // <1Hz tick; no status sample between old link and first ack replay
    expect(statuses(next)[0]).not.toHaveProperty("terminalSession");
  });
  it("linkLost performs no status write while the retired instance is still visible", async () => {
    const h = await setup();
    h.owners[0]!.linkLost.mockImplementation(() => {
      const n = h.socket.written.length;
      expect(currentConnection()!.terminalConnectionInstance).toBeDefined();
      expect(h.socket.written).toHaveLength(n);
    });
    const setSlot = vi.spyOn(currentConnection()!, "setSlot");
    h.socket.fail("ECONNRESET");
    expect(h.owners[0]!.linkLost).toHaveBeenCalledTimes(1);
    expect(setSlot.mock.calls.filter(([kind]) => kind === "status")).toHaveLength(0);
  });
  it("owner not ready -> no claim despite a passing guard", async () => {
    const h = await setup(true, false);
    expect(statuses(h.socket)[0]).not.toHaveProperty("terminalSession");
  });
  it("off has no owner/claim or feature transform", async () => {
    const h = await setup(false);
    expect(h.owners).toHaveLength(0);
    expect(statuses(h.socket)[0]).not.toHaveProperty("terminalSession");
    const next = await h.reconnect();
    expect(statuses(next)[0]).not.toHaveProperty("terminalSession");
  });
  it("tick publishes withdrawal only on a changed projection", async () => {
    const h = await setup();
    const spy = vi.spyOn(currentConnection()!, "setSlot");
    h.setGuard(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(statuses(h.socket).at(-1)).not.toHaveProperty("terminalSession");
    spy.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy.mock.calls.filter(([k]) => k === "status")).toHaveLength(0);
  });
  it("event-updated closure ctx supplies current cwd, then same-process session boundary seals old getter", async () => {
    const h = await setup();
    const old = h.owners[0]!.options;
    const updated = { ...h.c.ctx, cwd: "/new-current-event-cwd" };
    h.a.fire("agent_end", {}, updated);
    expect(old.currentCwd!()).toBe("/new-current-event-cwd");
    const nextCtx = {
      ...updated,
      cwd: "/next-session-cwd",
      sessionManager: { ...updated.sessionManager, getSessionId: () => "session-next" },
    };
    h.a.fire("session_shutdown", { reason: "new" }, updated);
    h.a.fire("session_start", { reason: "new" }, nextCtx);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.owners).toHaveLength(2);
    expect(() => old.currentCwd!()).toThrow("terminal cwd unavailable");
    expect(old.allowed()).toBe(false);
    expect(h.owners[1]!.options.currentCwd!()).toBe("/next-session-cwd");
    expect(statuses(h.socket).at(-1)?.terminalSession).toMatchObject({
      sessionId: "session-next",
      epoch: MODULE_INSTANCE,
    });
  });
});
