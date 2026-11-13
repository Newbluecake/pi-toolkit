import { describe, expect, it, vi } from "vitest";
import { createTerminalWiring } from "../../../src/web-hub/agent/terminal/wiring.js";
import type { TerminalOwnerOptions, TerminalOwner } from "../../../src/web-hub/agent/terminal/owner.js";
import type { CmdFrame } from "../../../src/web-hub/protocol/messages.js";
import type { TerminalNegotiation, TermReq } from "../../../src/web-hub/protocol/terminal.js";
const options: TerminalOwnerOptions = {
  sessionId: "session",
  epoch: "epoch",
  cwd: "/fixture",
  limits: { maxPerSession: 2, maxPerPrincipal: 2, maxTotal: 8, inputIdleMs: 3600000, maxLifetimeMs: 28800000 },
  allowed: () => true,
  current: () => undefined,
  send: () => false,
};
function owner() {
  return {
    offer: vi.fn<TerminalOwner["offer"]>(),
    receive: vi.fn<TerminalOwner["receive"]>(),
    linkLost: vi.fn(),
    revoke: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
}
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
const frame = {} as CmdFrame,
  negotiation = {} as TerminalNegotiation,
  request = {} as TermReq;
describe("wireWebHub terminal lifecycle adapter", () => {
  it.each([
    () => false,
    () => {
      throw new Error("unknown");
    },
  ])("missing/throwing domain authority never creates owner", async (allowed) => {
    const factory = vi.fn(async () => owner());
    const wiring = createTerminalWiring(factory);
    await wiring.start({ ...options, allowed });
    expect(factory).not.toHaveBeenCalled();
    expect(wiring.offer(frame, negotiation)).toBeUndefined();
  });
  it("passes exact creation options, routes only to its current owner, fences link loss", async () => {
    const o = owner(),
      factory = vi.fn(async () => o);
    const wiring = createTerminalWiring(factory);
    await wiring.start(options);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(options);
    wiring.offer(frame, negotiation);
    wiring.receive(request);
    wiring.linkLost();
    expect(o.offer).toHaveBeenCalledTimes(1);
    expect(o.offer).toHaveBeenCalledWith(frame, negotiation);
    expect(o.receive).toHaveBeenCalledTimes(1);
    expect(o.receive).toHaveBeenCalledWith(request);
    expect(o.linkLost).toHaveBeenCalledTimes(1);
    wiring.dispose();
    expect(o.dispose).toHaveBeenCalledTimes(1);
    wiring.receive(request);
    wiring.offer(frame, negotiation);
    expect(o.receive).toHaveBeenCalledTimes(1);
    expect(o.offer).toHaveBeenCalledTimes(1);
  });
  it("synchronously revokes on a policy transition before the first request", async () => {
    let allowed = true;
    const o = owner(),
      wiring = createTerminalWiring(async () => o);
    await wiring.start({ ...options, allowed: () => allowed });
    allowed = false;
    wiring.receive(request);
    expect(o.revoke).toHaveBeenCalledTimes(1);
    expect(o.receive).not.toHaveBeenCalled();
    expect(wiring.offer(frame, negotiation)).toBeUndefined();
    expect(o.offer).not.toHaveBeenCalled();
    wiring.dispose();
  });
  it("late creation after shutdown is disposed and cannot replace a successor owner", async () => {
    const held = pending<ReturnType<typeof owner>>(),
      old = owner(),
      next = owner();
    const factory = vi.fn().mockReturnValueOnce(held.promise).mockResolvedValueOnce(next);
    const wiring = createTerminalWiring(factory);
    const first = wiring.start(options);
    wiring.dispose();
    await wiring.start({ ...options, sessionId: "next" });
    held.resolve(old);
    await first;
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(next.dispose).not.toHaveBeenCalled();
    wiring.receive(request);
    expect(old.receive).not.toHaveBeenCalled();
    expect(next.receive).toHaveBeenCalledTimes(1);
    expect(next.receive).toHaveBeenCalledWith(request);
    wiring.dispose();
  });
  it("guard revoked while identity IO is pending discards the newly born owner", async () => {
    let allowed = true;
    const held = pending<ReturnType<typeof owner>>(),
      o = owner();
    const wiring = createTerminalWiring(() => held.promise);
    const start = wiring.start({ ...options, allowed: () => allowed });
    allowed = false;
    held.resolve(o);
    await start;
    expect(o.revoke).toHaveBeenCalledTimes(1);
    expect(o.dispose).toHaveBeenCalledTimes(1);
    wiring.receive(request);
    expect(o.receive).not.toHaveBeenCalled();
  });
  it("factory failure cannot resurrect old owner or break connection startup", async () => {
    const old = owner(),
      factory = vi.fn().mockResolvedValueOnce(old).mockRejectedValueOnce(new Error("probe"));
    const wiring = createTerminalWiring(factory);
    await wiring.start(options);
    await wiring.start(options);
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(wiring.offer(frame, negotiation)).toBeUndefined();
    expect(old.offer).not.toHaveBeenCalled();
  });
});
