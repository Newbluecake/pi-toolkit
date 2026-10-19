/**
 * web-hub-proxy X1c — `hub.ts` lifecycle wiring (plan v2 §3.4 / §4.2 / §12): the service is
 * constructed only with `config.proxy`, AFTER `frontend.listen()` returns the real ports, with a
 * LIVE LAN snapshot; disposed on close AND on a startup failure after construction; its
 * revocation hook is subscribed/unsubscribed; its sockets count toward idle. The real hub, the
 * real service — `createProxyService` / `createIdleMonitor` are only wrapped to observe.
 */
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  services: [] as Array<{
    dispose: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
    activeConnections(): number;
  }>,
  deps: [] as Array<Record<string, any>>,
  failNext: false,
  idleCounts: undefined as undefined | (() => { agents: number; sse: number; headless: number }),
  callOrder: [] as string[],
}));

vi.mock("../../../src/web-hub/hub/proxy/service.js", async (orig) => {
  const real = await orig<typeof import("../../../src/web-hub/hub/proxy/service.js")>();
  return {
    ...real,
    createProxyService: async (deps: Parameters<typeof real.createProxyService>[0]) => {
      state.callOrder.push("service");
      if (state.failNext) {
        state.failNext = false;
        throw new Error("boom: construction failed");
      }
      state.deps.push(deps as unknown as Record<string, any>);
      const svc = await real.createProxyService(deps);
      vi.spyOn(svc, "dispose");
      vi.spyOn(svc, "revoke");
      state.services.push(svc as never);
      return svc;
    },
  };
});
vi.mock("../../../src/web-hub/hub/idle.js", async (orig) => {
  const real = await orig<typeof import("../../../src/web-hub/hub/idle.js")>();
  return {
    ...real,
    createIdleMonitor: (opts: Parameters<typeof real.createIdleMonitor>[0]) => {
      state.idleCounts = opts.counts as never;
      return { stop() {} };
    },
  };
});

import { cleanupProxyHubs, startProxyHub } from "./proxy-kit.js";

afterEach(async () => {
  await cleanupProxyHubs();
  state.services.length = 0;
  state.deps.length = 0;
  state.failNext = false;
  state.idleCounts = undefined;
  state.callOrder.length = 0;
});

const portOf = (origin: string): number => Number(new URL(origin).port);
const dial = (port: number): Promise<"connected" | "refused"> =>
  new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      resolve("connected");
    });
    s.once("error", () => resolve("refused"));
  });
async function waitFor(check: () => boolean, ms = 4_000): Promise<void> {
  const at = Date.now();
  while (!check()) {
    if (Date.now() - at > ms) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("construction", () => {
  it("proxy off ⇒ createProxyService is never called", async () => {
    await startProxyHub({ proxy: false });
    expect(state.callOrder).toEqual([]);
    expect(state.services).toHaveLength(0);
  });

  it("proxy on ⇒ built after listen with the ACTUAL hub port (random fallback), no lanPort / lan:false, maxProxies from config", async () => {
    const h = await startProxyHub({ occupyHubPort: true, proxy: { maxProxies: 3 } });
    expect(state.deps).toHaveLength(1);
    const d = state.deps[0]!;
    expect(d.hubPort).toBe(h.hub.httpPort);
    expect(d.hubPort).not.toBe(h.configured.port);
    expect(d.lan).toBe(false);
    expect(d.clientAllow.active).toBe(false); // explicit inert guard for loopback-only proxy
    expect("lanPort" in d).toBe(false);
    expect(d.config).toEqual({ portRange: h.range, maxProxies: 3 });
    expect(d.stateDir).toBe(h.stateDir);
    expect(d.lanHostSnapshot()).toBeUndefined();
  });

  it("LAN on ⇒ lan:true + lanPort = config.lan.port; the snapshot is LIVE (defined while LAN is up, undefined after teardown)", async () => {
    const h = await startProxyHub({ lan: true });
    const lp = await h.lanPort();
    const d = state.deps[0]!;
    expect(d.lan).toBe(true);
    expect(d.clientAllow).toBeDefined();
    expect(d.clientAllow).toBe(h.deps.lan!.clientAllow); // I1: ONE guard for both listener kinds
    expect(h.deps.lan!.secondFactorEnabled).toBe(false); // not a user-reachable config switch
    expect(d.lanPort).toBe(h.configured.lan!.port);
    expect(d.lanPort).toBe(lp);
    const snap = d.lanHostSnapshot() as { hostKeys: ReadonlySet<string> } | undefined;
    expect(snap?.hostKeys.has(`127.0.0.1:${lp}`)).toBe(true);
    await h.hub.lan!.close();
    expect(d.lanHostSnapshot()).toBeUndefined();
  });
});

describe("dispose", () => {
  it("normal close awaits dispose (listeners gone, binding file stays) — exactly once, before the hub is closed", async () => {
    const h = await startProxyHub();
    const opened = await h.open();
    const pp = portOf(opened.origin);
    expect(await dial(pp)).toBe("connected");
    const svc = state.services[0]!;
    await h.hub.close("test");
    expect(svc.dispose).toHaveBeenCalledTimes(1);
    await expect(svc.dispose.mock.results[0]!.value).resolves.toBeUndefined();
    expect(await dial(pp)).toBe("refused");
  });

  it("a startup failure AFTER construction (ui.refresh throws) disposes the service and rejects startHub", async () => {
    await expect(
      startProxyHub({
        wrapFrontend: (_d, fe) => {
          fe.ui.refresh = async () => {
            throw new Error("ui refresh exploded");
          };
          return fe;
        },
      }),
    ).rejects.toThrow(/ui refresh exploded/);
    expect(state.services).toHaveLength(1);
    const svc = state.services[0]!;
    expect(svc.dispose).toHaveBeenCalledTimes(1);
    await expect(svc.dispose.mock.results[0]!.value).resolves.toBeUndefined();
    // irreversible closing fence: the disposed service refuses new work
    const r = await (svc as any).open(
      { listener: "loopback", principal: "p".repeat(43), sidTag: "p".repeat(43), parentExpiresAt: Date.now() + 1e6 },
      "127.0.0.1:1",
      "127.0.0.1",
      0,
    );
    expect(r).toMatchObject({ ok: false, reason: "closing" });
  });

  it("a startup failure BEFORE the service exists never constructs it", async () => {
    await expect(
      startProxyHub({
        wrapFrontend: (_d, fe) => {
          fe.listen = async () => {
            throw new Error("listen exploded");
          };
          return fe;
        },
      }),
    ).rejects.toThrow(/listen exploded/);
    expect(state.callOrder).toEqual([]);
  });

  it("a construction failure degrades: the hub starts, caps stay static, open answers 503 closing, hub.json has no proxy key", async () => {
    state.failNext = true;
    const h = await startProxyHub();
    expect(h.hub.info.caps).toContain("proxy.v1");
    const r = await h.api("POST", "/api/proxy/open", { body: { target: `127.0.0.1:${h.up.port}` } });
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body)).toEqual({ error: "E_PROXY_UNAVAILABLE", reason: "closing" });
    const list = await h.api("GET", "/api/proxy");
    expect(list.status).toBe(503);
    const { readFileSync } = await import("node:fs");
    expect(JSON.parse(readFileSync(h.hub.paths.hubJson, "utf8"))).not.toHaveProperty("proxy");
    expect(h.logText()).toContain("proxy unavailable");
    expect(h.logText()).not.toContain("boom"); // only the message class — no stack
  });
});

describe("revocation bus subscription", () => {
  it("is subscribed while the hub runs and unsubscribed on close", async () => {
    let fe: any;
    const h = await startProxyHub({
      wrapFrontend: (_d, f) => {
        fe = f;
        return f;
      },
    });
    const svc = state.services[0]!;
    fe.revokeAllSse(); // token-rotate path ⇒ bus.emit({sel:{listener:"loopback"}, reason:"rotate"})
    expect(svc.revoke).toHaveBeenCalledWith({ sel: { listener: "loopback" }, reason: "rotate" });
    const n = svc.revoke.mock.calls.length;
    await h.hub.close("test");
    fe.revokeAllSse();
    expect(svc.revoke.mock.calls.length).toBe(n);
  });
});

describe("idle accounting", () => {
  it("open proxied connections are added to the idle monitor's `sse` count", async () => {
    const h = await startProxyHub();
    const counts = state.idleCounts!;
    expect(counts).toBeDefined();
    const base = counts().sse;
    const opened = await h.open();
    const gate = (await h.http(opened.enterUrl)).headers["set-cookie"]![0]!.split(";")[0]!;
    // a request held open by the upstream keeps a proxy socket alive
    const req = httpRequest({
      host: "127.0.0.1",
      port: portOf(opened.origin),
      path: "/hang",
      headers: { Host: new URL(opened.origin).host, Cookie: gate },
      agent: false,
    });
    req.on("error", () => {});
    req.end();
    await waitFor(() => counts().sse > base);
    expect(counts().sse).toBe(base + 1);
    req.destroy();
    h.up.release();
    await waitFor(() => counts().sse === base);
  });
});
