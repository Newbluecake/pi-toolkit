/** Real wireWebHub/commands/connection; only physical owner factory replaced.
 * True PTY plus real hub belongs to integration/web-hub-terminal-wiring. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalOwnerOptions } from "../../../src/web-hub/agent/terminal/owner.js";
const factory = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../../../src/web-hub/agent/terminal/owner.js", () => ({ createTerminalOwner: factory.create }));
import { wireWebHub } from "../../../src/web-hub/agent/index.js";
import { currentConnection, MODULE_INSTANCE } from "../../../src/web-hub/agent/connection.js";
import { ackFrame, fakeCtx, fakeNet, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";
import type { TermReq } from "../../../src/web-hub/protocol/terminal.js";
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
  tmp = tmpDir("tw-");
  resetGlobals();
  vi.useFakeTimers();
  factory.create.mockReset();
});
afterEach(() => {
  resetGlobals();
  vi.useRealTimers();
  tmp.cleanup();
});
function setup(on: boolean, guard?: () => boolean) {
  const a = fakePi(),
    n = fakeNet(),
    c = fakeCtx();
  Object.assign(c.ctx, { cwd: tmp.dir });
  const o = {
    offer: vi.fn(() => ({ v: 1, outcome: "handshake-required", offerId: "offer" })),
    receive: vi.fn(),
    revoke: vi.fn(),
    linkLost: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
  factory.create.mockResolvedValue(o);
  wireWebHub(a.pi, {
    settings: { ...SETTINGS, ...(on ? { terminal: limits } : {}) },
    ...(guard === undefined ? {} : { terminalGuard: guard }),
    fleet: () => [],
    paths: pathsIn(tmp.dir),
    env: { HOME: tmp.dir },
    netConnect: n.netConnect,
    argv1: "/nonexistent/pi",
    buildInfo: async () => ({ pluginVersion: "1", buildId: "terminal-test" }),
  });
  const start = async () => {
    a.fire("session_start", { type: "session_start" }, c.ctx);
    await vi.advanceTimersByTimeAsync(0);
    const s = n.sockets.at(-1)!;
    s.emit("connect");
    await vi.advanceTimersByTimeAsync(0);
    s.hub(ackFrame("a1-terminal", 4242, ["cmd.v1", "command.v1"]));
    await vi.advanceTimersByTimeAsync(0);
    return s;
  };
  return { ...a, ...c, n, o, start };
}
describe("production terminal owner wiring", () => {
  it("off retains exact hook registration shape and never invokes physical factory", async () => {
    const off = setup(false),
      counts = [...off.handlers].map(([k, v]) => [k, v.length]);
    await off.start();
    expect(factory.create).not.toHaveBeenCalled();
    off.fire("session_shutdown", { reason: "quit" }, off.ctx);
    const on = setup(true, () => true);
    expect([...on.handlers].map(([k, v]) => [k, v.length])).toEqual(counts);
    await on.start();
    expect(factory.create).toHaveBeenCalledTimes(1);
    on.fire("session_shutdown", { reason: "quit" }, on.ctx);
  });
  it.each([
    undefined,
    () => false,
    () => {
      throw new Error("unknown");
    },
  ])("enabled without trusted guard cannot create owner", async (guard) => {
    const a = setup(true, guard);
    await a.start();
    expect(factory.create).not.toHaveBeenCalled();
    a.fire("session_shutdown", { reason: "quit" }, a.ctx);
  });
  it("connects exact session/epoch/current incarnation and dedicated receive/send, seals before detach", async () => {
    let allowed = true;
    const a = setup(true, () => allowed),
      s = await a.start();
    const opts = factory.create.mock.calls[0]![0] as TerminalOwnerOptions;
    const { enabled: _enabled, ...wireLimits } = limits;
    expect(opts).toMatchObject({ sessionId: "sess-1", epoch: MODULE_INSTANCE, cwd: tmp.dir, limits: wireLimits });
    expect(Object.hasOwn(opts.limits, "enabled")).toBe(false);
    expect(opts.allowed()).toBe(true);
    expect(opts.current()).toEqual({
      sessionId: "sess-1",
      epoch: MODULE_INSTANCE,
      localConnectionInstance: currentConnection()!.terminalConnectionInstance,
    });
    const valid: TermReq = {
      t: "term_req",
      v: 1,
      rid: "rid",
      sessionId: "sess-1",
      epoch: MODULE_INSTANCE,
      op: "prepare_protocol",
      offerId: "offer",
      hubNonce: "nonce",
    };
    s.hub(valid);
    expect(a.o.receive).toHaveBeenCalledWith(valid);
    const detach = vi.spyOn(currentConnection()!, "detach");
    a.o.dispose.mockImplementation(async () => {
      expect(detach).not.toHaveBeenCalled();
    });
    allowed = false;
    s.hub(valid);
    expect(a.o.receive).toHaveBeenCalledTimes(1);
    expect(a.o.revoke).toHaveBeenCalled();
    a.fire("session_shutdown", { reason: "reload" }, a.ctx);
    expect(a.o.dispose).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledWith("reload");
    expect(opts.current()).toBeUndefined();
    expect(
      opts.send({
        t: "term_res",
        v: 1,
        rid: valid.rid,
        op: "close",
        ok: false,
        code: "E_UNSUPPORTED",
        effect: "none",
      } as never),
    ).toBe(false);
  });
  it("link retirement invokes owner linkLost before reusing a connection", async () => {
    const a = setup(true, () => true),
      s = await a.start();
    s.fail("ECONNRESET");
    expect(a.o.linkLost).toHaveBeenCalledTimes(1);
    a.fire("session_shutdown", { reason: "quit" }, a.ctx);
  });
});
