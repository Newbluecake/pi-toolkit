/**
 * private-plan §4.1 (N3) + security review N3 #1: the web-hub agent wiring's private-ns gates.
 *
 *   - auto-start NEVER spawns while the gate says in-ns OR unknown (fail-safe), firing the
 *     ONE-shot notify (§4.1-2 wording; unknown carries its own diagnostic copy);
 *   - hello.caps carries `agent.nospawn.v1` for in-ns AND unknown, even under `control:false`
 *     (Q2: BEFORE the early return), and never while not-ns (freeze F6);
 *   - the restart flow's own spawn exit is refused too (spawnHub hard gate, §4.1-1).
 *
 * not-ns parity (opts/caps byte-equal) is pinned by every pre-existing wiring test — anything
 * that changed there would fail the suite; here we only assert the cap's absence explicitly.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireWebHub, type WebHubDeps, type WebHubSettings } from "../../../src/web-hub/agent/index.js";
import { AGENT_NOSPAWN_CAP } from "../../../src/web-hub/protocol/nospawn.js";
import { ackFrame, fakeCtx, fakeNet, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  vi.useFakeTimers();
  tmp = tmpDir("wh-d-pns-");
  resetGlobals();
});
afterEach(() => {
  resetGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  tmp.cleanup();
});

function fakeNodeLoader(): string {
  const p = join(tmp.dir, "fake-jiti-cli.mjs");
  writeFileSync(p, "");
  return p;
}

function deps(over: Partial<WebHubDeps> = {}): WebHubDeps {
  return {
    settings: SETTINGS,
    fleet: () => [],
    env: { HOME: tmp.dir },
    paths: pathsIn(tmp.dir),
    buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "1.2.3@pns" }),
    argv1: "/nonexistent/pi",
    ...over,
  };
}

function enoentConnect(): typeof import("node:net").connect {
  return (() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }) as unknown as typeof import("node:net").connect;
}

const fakeChild = () => ({ on: () => undefined, unref: () => undefined }) as never;

/** Drive session_start to a LIVE fake-hub link; returns the socket + spies. */
async function live(over: Partial<WebHubDeps> = {}) {
  const net = fakeNet();
  const { pi, fire } = fakePi();
  const spawnImpl = vi.fn(fakeChild);
  const ctx = fakeCtx({ mode: "tui" });
  const control = wireWebHub(
    pi,
    deps({
      settings: { ...SETTINGS, nodeLoader: fakeNodeLoader() },
      netConnect: net.netConnect,
      spawnImpl,
      ...over,
    }),
  );
  fire("session_start", { type: "session_start", reason: "startup" }, ctx.ctx);
  await vi.advanceTimersByTimeAsync(0);
  const socket = net.sockets[0]!;
  socket.emit("connect");
  socket.hub(ackFrame("a1-pns", 4242, ["ctl.v1"]));
  await vi.advanceTimersByTimeAsync(0);
  return { control, socket, spawnImpl, ctx, net, fire };
}

const helloCaps = (socket: { frames(): Array<Record<string, unknown>> }): string[] => {
  const hello = socket.frames().find((f) => f.t === "hello");
  expect(hello).toBeDefined();
  return (hello?.caps as string[]) ?? [];
};

describe("wireWebHub inside a private mount ns (private-plan §4.1)", () => {
  it("auto-start NEVER spawns and fires the ONE-shot notify with the §4.1-2 wording", async () => {
    const { pi, fire } = fakePi();
    const ctx = fakeCtx({ mode: "tui" });
    const spawnImpl = vi.fn(fakeChild);
    wireWebHub(
      pi,
      deps({
        settings: { ...SETTINGS, autoStart: true, nodeLoader: fakeNodeLoader() },
        netConnect: enoentConnect(),
        spawnImpl,
        privateNs: () => ({ gate: "in-ns", reason: "acme" }),
      }),
    );
    fire("session_start", { type: "session_start", reason: "startup" }, ctx.ctx);
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnImpl).not.toHaveBeenCalled();
    const notes = ctx.state.notifyCalls.filter(([m]) => m.includes("私有挂载命名空间"));
    expect(notes).toHaveLength(1);
    expect(notes[0]![1]).toBe("warning");
    expect(notes[0]![0]).toContain("不会自动拉起 web-hub");
    expect(notes[0]![0]).toContain("/webhub start");

    // a SECOND spawn admission (link-down on a later connect attempt) does not re-notify:
    // drop the socket of a fresh connect attempt the way a real close would.
    fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
    await vi.advanceTimersByTimeAsync(5_000); // burn the backoff into a retry → blocked again
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(ctx.state.notifyCalls.filter(([m]) => m.includes("私有挂载命名空间"))).toHaveLength(1);
  });

  it("unknown verdict: auto-start is blocked TOO (fail-safe) and the notify carries the diagnostic copy", async () => {
    const { pi, fire } = fakePi();
    const ctx = fakeCtx({ mode: "tui" });
    const spawnImpl = vi.fn(fakeChild);
    wireWebHub(
      pi,
      deps({
        settings: { ...SETTINGS, autoStart: true, nodeLoader: fakeNodeLoader() },
        netConnect: enoentConnect(),
        spawnImpl,
        privateNs: () => ({ gate: "unknown", reason: "保险库 acme 的 private.json 损坏（json）" }),
      }),
    );
    fire("session_start", { type: "session_start", reason: "startup" }, ctx.ctx);
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnImpl).not.toHaveBeenCalled();
    const notes = ctx.state.notifyCalls.filter(([m]) => m.includes("无法确认"));
    expect(notes).toHaveLength(1);
    expect(notes[0]![0]).toContain("private.json 损坏");
    expect(notes[0]![0]).toContain("pi-secure status");
    expect(notes[0]![1]).toBe("warning");
  });

  it("non-ns auto-start still spawns (existing behavior) and never notifies", async () => {
    const { pi, fire } = fakePi();
    const ctx = fakeCtx({ mode: "tui" });
    const spawnImpl = vi.fn(fakeChild);
    wireWebHub(
      pi,
      deps({
        settings: { ...SETTINGS, autoStart: true, nodeLoader: fakeNodeLoader() },
        netConnect: enoentConnect(),
        spawnImpl,
        privateNs: () => ({ gate: "not-ns" }),
      }),
    );
    fire("session_start", { type: "session_start", reason: "startup" }, ctx.ctx);
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(ctx.state.notifyCalls.filter(([m]) => m.includes("命名空间"))).toHaveLength(0);
  });

  it("ns: hello.caps carries agent.nospawn.v1 — also under control:false (Q2, before the early return)", async () => {
    const settings: WebHubSettings = { ...SETTINGS, nodeLoader: fakeNodeLoader(), control: false };
    const h = await live({ settings, privateNs: () => ({ gate: "in-ns", reason: "acme" }) });
    expect(h.control.status().state).toBe("live");
    expect(helloCaps(h.socket)).toContain(AGENT_NOSPAWN_CAP);
  });

  it("ns with control on: the cap rides alongside the normal caps", async () => {
    const h = await live({ privateNs: () => ({ gate: "in-ns", reason: "acme" }) });
    const caps = helloCaps(h.socket);
    expect(caps).toContain(AGENT_NOSPAWN_CAP);
    expect(caps).toContain("cmd.v1"); // the control plane caps are unaffected
  });

  it("non-ns: hello.caps NEVER carries agent.nospawn.v1 (freeze F6) — control on and off", async () => {
    const on = await live({ privateNs: () => ({ gate: "not-ns" }) });
    expect(helloCaps(on.socket)).not.toContain(AGENT_NOSPAWN_CAP);
    on.control.status(); // still live
    resetGlobals(); // close the first connection so the second wiring makes its own socket
    const off = await live({
      settings: { ...SETTINGS, nodeLoader: fakeNodeLoader(), control: false },
      privateNs: () => ({ gate: "not-ns" }),
    });
    expect(helloCaps(off.socket)).not.toContain(AGENT_NOSPAWN_CAP);
  });

  it("ns: the restart flow's own spawn exit is refused (spawnHub hard gate) — no hub process ever appears", async () => {
    const h = await live({ privateNs: () => ({ gate: "in-ns", reason: "acme" }) });
    const done = h.control.lan.restart();
    await vi.advanceTimersByTimeAsync(0);
    // answer the shutdown handshake exactly like the hub would
    const frame = h.socket.frames().find((f) => f.t === "hub_ctl");
    expect(frame).toMatchObject({ op: "shutdown", reason: "restart" });
    h.socket.hub({ t: "hub_ctl_ack", rid: String(frame!.rid) });
    await vi.advanceTimersByTimeAsync(300);
    await done;
    expect(h.spawnImpl).not.toHaveBeenCalled();
  });
});
