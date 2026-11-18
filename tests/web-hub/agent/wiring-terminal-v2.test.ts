import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireWebHub } from "../../../src/web-hub/agent/index.js";
import { currentConnection, MODULE_INSTANCE } from "../../../src/web-hub/agent/connection.js";
import { ackFrame, fakeCtx, fakeNet, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";
const limits = {
  enabled: true,
  maxPerSession: 2,
  maxPerPrincipal: 2,
  maxTotal: 8,
  inputIdleMs: 3600000,
  maxLifetimeMs: 28800000,
};
let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir("t51-wire-");
  resetGlobals();
  vi.useFakeTimers();
});
afterEach(() => {
  resetGlobals();
  vi.useRealTimers();
  tmp.cleanup();
});
async function setup(trusted: boolean, guard: () => boolean = () => true) {
  const a = fakePi(),
    n = fakeNet(),
    c = fakeCtx();
  Object.assign(c.ctx, { cwd: tmp.dir });
  wireWebHub(a.pi, {
    settings: { ...SETTINGS, terminal: limits },
    terminalGuard: guard,
    ...(trusted ? { terminalTrust: { domain: "plain" as const, isChild: false } } : {}),
    fleet: () => [],
    paths: pathsIn(tmp.dir),
    env: { HOME: tmp.dir },
    netConnect: n.netConnect,
    random: () => 0.5,
    argv1: "/nonexistent/pi",
    buildInfo: async () => ({ pluginVersion: "1", buildId: "t51" }),
  });
  a.fire("session_start", { type: "session_start" }, c.ctx);
  await vi.advanceTimersByTimeAsync(0);
  const socket = n.sockets.at(-1)!;
  socket.emit("connect");
  socket.hub(ackFrame("a-terminal", 4242, ["cmd.v1", "command.v1"]));
  return { a, c, n, socket };
}
describe("metadata-only production wireWebHub", () => {
  it("starts synchronously before first replayed status and replies only on exact live link", async () => {
    const h = await setup(true);
    const first = h.socket.frames().find((f) => f.t === "status")!;
    expect(first.terminalSession).toBeUndefined();
    expect(first.terminalSessionV2).toMatchObject({ v: 2, sessionId: "sess-1", epoch: MODULE_INSTANCE });
    const generation = (first.terminalSessionV2 as { contextGeneration: number }).contextGeneration;
    const request = {
      t: "terminal_context_req",
      v: 2,
      rid: "r".repeat(24),
      sessionId: "sess-1",
      epoch: MODULE_INSTANCE,
      contextGeneration: generation,
    };
    h.socket.hub(request);
    expect(h.socket.frames().at(-1)).toMatchObject({ t: "terminal_context_res", ok: true, cwd: tmp.dir });
    const original = currentConnection()!.terminalLinkInstance;
    h.socket.fail("ECONNRESET");
    expect(currentConnection()!.terminalLinkInstance).toBeUndefined();
    const before = h.socket.frames().length;
    h.socket.hub(request);
    expect(h.socket.frames()).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(500);
    const next = h.n.sockets.at(-1)!;
    next.emit("connect");
    next.hub(ackFrame());
    expect(currentConnection()!.terminalLinkInstance).not.toBe(original);
    const status = next.frames().find((f) => f.t === "status")!;
    expect((status.terminalSessionV2 as { contextGeneration: number }).contextGeneration).toBeGreaterThan(generation);
    next.hub(request);
    expect(next.frames().at(-1)).toMatchObject({ ok: false, code: "E_SESSION_CHANGED" });
    h.a.fire("session_shutdown", { reason: "quit" }, h.c.ctx);
  });
  it("missing host trust never infers plain from a positive guard", async () => {
    const h = await setup(false);
    expect(h.socket.frames().find((f) => f.t === "status")!.terminalSessionV2).toBeUndefined();
    h.a.fire("session_shutdown", { reason: "quit" }, h.c.ctx);
  });
  it("live guard withdrawal strips declaration; restoring guard does not revive generation", async () => {
    let allowed = true;
    const h = await setup(true, () => allowed);
    allowed = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      h.socket
        .frames()
        .filter((f) => f.t === "status")
        .at(-1)!.terminalSessionV2,
    ).toBeUndefined();
    allowed = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      h.socket
        .frames()
        .filter((f) => f.t === "status")
        .at(-1)!.terminalSessionV2,
    ).toBeUndefined();
    h.a.fire("session_shutdown", { reason: "quit" }, h.c.ctx);
  });
});
