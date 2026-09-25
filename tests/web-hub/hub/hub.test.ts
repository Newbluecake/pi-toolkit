import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { FrontendDeps, FrontendFactory, HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { installProcessHandlers, startHub, type RunningHub } from "../../../src/web-hub/hub/hub.js";
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
      proto: { major: 1, minor: 0 },
      socket: hub.paths.socketPath,
      port: 43210,
      startedAt: hub.info.startedAt,
    });
    expect(typeof json["nonce"]).toBe("string");
    expect(hub.info).toMatchObject({ version: "1.2.3", pid: process.pid, proto: { major: 1, minor: 0 } });
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
