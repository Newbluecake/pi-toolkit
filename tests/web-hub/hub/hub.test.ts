import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { FrontendDeps, FrontendFactory, HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { installProcessHandlers, startHub, type RunningHub } from "../../../src/web-hub/hub/hub.js";
import { P2_HUB_CAPS, UPLOAD_HUB_CAPS } from "../../../src/web-hub/protocol/version.js";
import { config, connectClient, hello, memLog, tmpDirs, waitFor } from "./helpers.js";

const tmp = tmpDirs();
const hubs: RunningHub[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const h of hubs.splice(0)) await h.close("test");
  tmp.cleanup();
});

interface FakeFrontend extends FrontendFactory {
  deps: FrontendDeps[];
  closed: number;
  clients: number;
}

function fakeFrontend(opts: { port?: number; failListen?: boolean } = {}): FakeFrontend {
  const f = ((deps: FrontendDeps): HttpFrontend => {
    f.deps.push(deps);
    return {
      listen: async () => {
        if (opts.failListen === true) throw new Error("EACCES");
        return { port: opts.port ?? 43210 };
      },
      close: async () => {
        f.closed++;
      },
      clientCount: () => f.clients,
      ui: {
        serve: async () => false,
        refresh: async () => ({ state: "unbuilt", candidates: [] }),
        status: () => ({ state: "unbuilt", candidates: [] }),
      },
    };
  }) as FakeFrontend;
  f.deps = [];
  f.closed = 0;
  f.clients = 0;
  return f;
}

async function start(home: string, fe: FrontendFactory, idleExitMinutes = 10): Promise<RunningHub> {
  const r = await startHub(config({ home, idleExitMinutes }), fe, { uid: process.getuid?.() ?? 0 });
  if ("exists" in r) throw new Error("unexpected exists");
  hubs.push(r);
  return r;
}

describe("startHub", () => {
  it("writes hub.json (0600) in a 0700 state dir after socket + HTTP listen", async () => {
    const home = tmp.make("wh-hub-");
    const fe = fakeFrontend({ port: 43210 });
    const hub = await start(home, fe);
    expect(hub.httpPort).toBe(43210);
    expect(statSync(hub.paths.stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(hub.paths.hubJson).mode & 0o777).toBe(0o600);
    expect(statSync(hub.paths.socketPath).mode & 0o777).toBe(0o600);
    const json = JSON.parse(readFileSync(hub.paths.hubJson, "utf8")) as Record<string, unknown>;
    expect(json).toMatchObject({
      pid: process.pid,
      version: "1.2.3",
      buildId: "1.2.3@abc",
      proto: { major: 1, minor: 1 },
      socket: hub.paths.socketPath,
      port: 43210,
      startedAt: hub.info.startedAt,
    });
    expect(typeof json["nonce"]).toBe("string");
    expect(hub.info).toMatchObject({ version: "1.2.3", pid: process.pid, proto: { major: 1, minor: 1 } });
    const deps = fe.deps[0]!;
    expect(deps.paths).toEqual(hub.paths);
    expect(deps.info()).toEqual(hub.info);
    expect(typeof deps.history.snapshot).toBe("function");
    expect(deps.registry.list()).toEqual([]);
  });

  it("agents connecting get hello_ack with the HTTP port and appear in the registry", async () => {
    const home = tmp.make("wh-hub-");
    const fe = fakeFrontend({ port: 40001 });
    const hub = await start(home, fe);
    const c = await connectClient(hub.paths.socketPath);
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    expect(ack["http"]).toEqual({ port: 40001 });
    expect(fe.deps[0]!.registry.list().map((a) => a.agentKey)).toEqual(["a4242-nonceA"]);
    c.sock.destroy();
  });

  it("web-hub-upload plan §5.1: HubInfo.caps (browser-facing) and hello_ack.caps (agent-facing) both carry UPLOAD_HUB_CAPS and agree byte-for-byte", async () => {
    const home = tmp.make("wh-hub-upload-caps-");
    const fe = fakeFrontend({ port: 40002 });
    const hub = await start(home, fe);
    const browserCaps = fe.deps[0]!.info().caps;
    expect(browserCaps).toEqual(expect.arrayContaining([...P2_HUB_CAPS, ...UPLOAD_HUB_CAPS]));

    const c = await connectClient(hub.paths.socketPath);
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    expect(ack["caps"]).toEqual(expect.arrayContaining([...P2_HUB_CAPS, ...UPLOAD_HUB_CAPS]));
    // the two surfaces must never drift apart (§3.1 compat matrix invariant, extended to uploads).
    expect([...(ack["caps"] as string[])].sort()).toEqual([...browserCaps].sort());
    c.sock.destroy();
  });

  it("a second startHub returns {exists:true}", async () => {
    const home = tmp.make("wh-hub-");
    await start(home, fakeFrontend());
    const second = await startHub(config({ home }), fakeFrontend(), { uid: process.getuid?.() ?? 0 });
    expect(second).toEqual({ exists: true });
  });

  it("close() removes hub.sock and hub.json, closes the frontend, resolves closed", async () => {
    const home = tmp.make("wh-hub-");
    const fe = fakeFrontend();
    const hub = await start(home, fe);
    hubs.length = 0;
    await Promise.all([hub.close("bye"), hub.close("again")]);
    expect(await hub.closed).toBe("bye");
    expect(existsSync(hub.paths.socketPath)).toBe(false);
    expect(existsSync(hub.paths.hubJson)).toBe(false);
    expect(fe.closed).toBe(1);
    // restartable afterwards
    await start(home, fakeFrontend());
  });

  it("close() leaves a foreign hub.json (pid ≠ self) alone", async () => {
    const home = tmp.make("wh-hub-");
    const hub = await start(home, fakeFrontend());
    hubs.length = 0;
    writeFileSync(hub.paths.hubJson, JSON.stringify({ pid: 1 }));
    await hub.close("x");
    expect(existsSync(hub.paths.hubJson)).toBe(true);
  });

  it("a frontend listen failure rejects and releases the socket", async () => {
    const home = tmp.make("wh-hub-");
    await expect(startHub(config({ home }), fakeFrontend({ failListen: true }))).rejects.toThrow("EACCES");
    const hub = await start(home, fakeFrontend());
    expect(existsSync(hub.paths.socketPath)).toBe(true);
  });

  it("idle: no agents and no SSE clients for idleExitMinutes ⇒ close('idle')", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const home = tmp.make("wh-hub-");
    const fe = fakeFrontend();
    const hub = await start(home, fe, 1);
    hubs.length = 0;
    fe.clients = 1;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(existsSync(hub.paths.hubJson)).toBe(true); // an SSE client keeps it alive
    fe.clients = 0;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await hub.closed).toBe("idle");
    expect(existsSync(hub.paths.socketPath)).toBe(false);
  });

  it("fence: socket path taken over ⇒ close('fence') without deleting the foreign socket file", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const home = tmp.make("wh-hub-");
    const hub = await start(home, fakeFrontend());
    hubs.length = 0;
    unlinkSync(hub.paths.socketPath);
    writeFileSync(hub.paths.socketPath, "other hub");
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
    expect(await hub.closed).toBe("fence");
    expect(readFileSync(hub.paths.socketPath, "utf8")).toBe("other hub");
  });
});

describe('startHub — hub_ctl{reason:"stop"} sets info.state and broadcasts (acc32-B6)', () => {
  it("sets info.state to 'stopping' and pushes a live 'hub' bus event before closing", async () => {
    const home = tmp.make("wh-hub-stop-");
    const fe = fakeFrontend();
    const hub = await start(home, fe);
    const feDeps = fe.deps[0]!;
    expect(feDeps.info().state).toBeUndefined();

    const events: string[] = [];
    let stateAtHubEvent: string | undefined;
    feDeps.bus.subscribe((e) => {
      events.push(e.type);
      // Read `info()` synchronously inside the subscriber, in the same tick as the publish —
      // `close()`'s own `supersede?.dispose()` (its first step) unconditionally deletes
      // `info.state` moments later, so polling `info()` any LATER than this would already see
      // it wiped back to `undefined` regardless of whether this fix works.
      if (e.type === "hub") stateAtHubEvent = feDeps.info().state;
    });

    const client = await connectClient(hub.paths.socketPath);
    client.send(hello());
    await client.waitFrame((f) => f["t"] === "hello_ack");
    client.send({ t: "hub_ctl", rid: "rid-stop", op: "shutdown", reason: "stop" });
    await client.waitFrame((f) => f["t"] === "hub_ctl_ack");

    // Before the fix, `info.state` was only ever mutated by the supersede (`restart`) path —
    // the stop path left it `undefined` forever and never touched the bus, so an already-
    // connected browser had no way to distinguish an intentional stop from a dropped connection.
    expect(events).toContain("hub");
    expect(stateAtHubEvent).toBe("stopping");

    hubs.length = 0; // hub.close() is already underway (own path), don't double-close in afterEach
    await hub.closed;
    client.sock.destroy();
  });

  it("a plain restart (old ctl.v1 fallback / real /webhub restart) leaves info.state untouched", async () => {
    const home = tmp.make("wh-hub-restart-");
    const fe = fakeFrontend();
    const hub = await start(home, fe);
    const feDeps = fe.deps[0]!;
    const events: string[] = [];
    feDeps.bus.subscribe((e) => events.push(e.type));

    const client = await connectClient(hub.paths.socketPath);
    client.send(hello());
    await client.waitFrame((f) => f["t"] === "hello_ack");
    client.send({ t: "hub_ctl", rid: "rid-restart", op: "shutdown", reason: "restart" });
    await client.waitFrame((f) => f["t"] === "hub_ctl_ack");

    expect(feDeps.info().state).toBeUndefined();
    expect(events).not.toContain("hub");

    hubs.length = 0;
    await hub.closed;
    client.sock.destroy();
  });
});

describe("installProcessHandlers", () => {
  it("SIGTERM ⇒ close('signal'); uninstall removes the listeners", async () => {
    const home = tmp.make("wh-hub-");
    const hub = await start(home, fakeFrontend());
    hubs.length = 0;
    const before = process.listenerCount("SIGTERM");
    const uninstall = installProcessHandlers(hub, memLog());
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    process.emit("SIGTERM", "SIGTERM");
    expect(await hub.closed).toBe("signal");
    uninstall();
    expect(process.listenerCount("SIGTERM")).toBe(before);
    await waitFor(() => !existsSync(hub.paths.socketPath));
  });
});
