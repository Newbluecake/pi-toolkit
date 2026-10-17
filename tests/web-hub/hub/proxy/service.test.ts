import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { createProxyPortsMap } from "../../../../src/web-hub/hub/proxy/ports-map.js";
import { readFile, readdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { engine, freeRange, identity, listen, waitFor } from "./engine-helpers.js";
import { deferred, manualClock, flush } from "./helpers.js";
import {
  PROXY_LISTEN_TIMEOUT_MS,
  PROXY_INSTANCE_IDLE_MS,
  PROXY_SWEEP_INTERVAL_MS,
} from "../../../../src/web-hub/protocol/proxy.js";
import { join } from "node:path";

let env: Awaited<ReturnType<typeof engine>>;
afterEach(async () => {
  await env?.close();
});
describe("T-H7 lifecycle", () => {
  it("same target single-flight listens exactly once and emits distinct one-time codes; permanent binding survives idle close", async () => {
    const clock = manualClock();
    env = await engine({ now: clock.now, timer: clock.timer });
    const [a, b, c] = await Promise.all([
      env.open(undefined, identity(1, clock.now())),
      env.open(undefined, identity(2, clock.now())),
      env.open(undefined, identity(3, clock.now())),
    ]);
    expect(a.instanceId).toBe(b.instanceId);
    expect(b.instanceId).toBe(c.instanceId);
    expect(new Set([a.enterUrl, b.enterUrl, c.enterUrl]).size).toBe(3);
    expect(env.servers.filter((s) => s.listening)).toHaveLength(1);
    expect(env.service.status!()).toMatchObject({ instances: 1, reserved: 0 });
    const bytes = await readFile(join(env.dir, "proxy/ports.json"));
    clock.advance(PROXY_INSTANCE_IDLE_MS);
    await flush();
    await waitFor(() => !env.servers[0]!.listening);
    expect(env.service.list(identity()).items).toHaveLength(0);
    expect(await readFile(join(env.dir, "proxy/ports.json"))).toEqual(bytes);
    const again = await env.open(undefined, identity(1, clock.now()));
    expect(again.origin).toBe(a.origin);
    expect(again.instanceId).not.toBe(a.instanceId);
  });
  it("9 simultaneous distinct opens admit exactly 8 (atomic reservation), per-principal cap 4", async () => {
    env = await engine();
    const results = await Promise.all(
      Array.from({ length: 9 }, (_, i) =>
        env.service.open(identity(i + 1), `127.0.0.1:${2000 + i}`, "127.0.0.1", env.service.currentSeq()),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(8);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, status: 409, error: "E_LIMIT", reason: "proxies" }]);
    expect(env.service.status!()).toMatchObject({ instances: 8, reserved: 0 });
    await env.close();
    env = await engine();
    const per = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        env.service.open(identity(), `127.0.0.1:${3000 + i}`, "127.0.0.1", env.service.currentSeq()),
      ),
    );
    expect(per.filter((r) => r.ok)).toHaveLength(4);
    expect(env.service.status!().reserved).toBe(0);
  });
  it("main-session ruling: full-capacity reopens and pending joins are free; new instances still reserve atomically", async () => {
    env = await engine();
    for (let i = 0; i < 8; i++) await env.open(`127.0.0.1:${2000 + i}`, identity(i + 1));
    const attemptsBeforeReopen = env.servers.length;
    const results = await Promise.all([
      env.service.open(identity(2), "127.0.0.1:2000", "127.0.0.1", 0),
      env.service.open(identity(3), "[::ffff:7f00:1]:2000", "127.0.0.1", 0),
      env.service.open(identity(4), "127.0.0.1:3000", "127.0.0.1", 0),
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(env.servers).toHaveLength(attemptsBeforeReopen);
    expect(env.servers.filter((s) => s.listening)).toHaveLength(8);
    expect(env.service.status!()).toMatchObject({ instances: 8, reserved: 0 });
    await env.close();
    const gate = deferred<void>();
    const waiting = deferred<void>();
    env = await engine({
      config: { maxProxies: 1, portRange: env.range },
      listen: async (s, p, h) => {
        waiting.resolve();
        await gate.promise;
        await listen(s, p, h);
      },
    });
    const a = env.open("127.0.0.1:2000", identity(1));
    await waiting.promise;
    const b = env.open("[::ffff:7f00:1]:2000", identity(2));
    expect(env.service.status!().reserved).toBe(1);
    gate.resolve();
    const results2 = await Promise.all([a, b]);
    expect(results2[0].instanceId).toBe(results2[1].instanceId);
    expect(env.service.status!()).toMatchObject({ instances: 1, reserved: 0 });
  });
  it("persist failure closes the listener; broken store refuses further opens and is never rewritten", async () => {
    env = await engine();
    const directory = env.dir;
    const range = env.range;
    const ports = createProxyPortsMap({
      stateDir: directory,
      range,
      now: Date.now,
      fs: {
        ...fs,
        rename: async () => {
          throw new Error("secret error text");
        },
      },
    });
    await env.close();
    // env.close removed directory; ENOENT correctly loads as empty before the failing rename.
    env = await engine({ portsMap: ports, config: { maxProxies: 8, portRange: range } });
    const failed = await env.service.open(identity(), "127.0.0.1:2000", "127.0.0.1", 0);
    expect(failed).toMatchObject({ ok: false, reason: "ports-store" });
    await waitFor(() => env.servers.every((s) => !s.listening));
    expect(env.service.status!()).toEqual({ instances: 0, reserved: 0, portsStore: "broken" });
    expect(await env.service.open(identity(), "127.0.0.1:2001", "127.0.0.1", 0)).toMatchObject({
      reason: "ports-store",
    });
    expect(env.servers).toHaveLength(1);
    await fs.rm(directory, { recursive: true, force: true });
  });
  it("expiry/revoke during pending listen gives frozen retryable 503 and closes ungranted new instance", async () => {
    const clock = manualClock();
    const entered = deferred<void>();
    const allow = deferred<void>();
    env = await engine({
      now: clock.now,
      timer: clock.timer,
      listen: async (s, p, h) => {
        entered.resolve();
        await allow.promise;
        await listen(s, p, h);
      },
    });
    const id = { ...identity(1, clock.now()), parentExpiresAt: clock.now() + 1000 };
    const opening = env.service.open(id, "127.0.0.1:2000", "127.0.0.1", 0);
    await entered.promise;
    clock.advance(1000);
    allow.resolve();
    expect(await opening).toEqual({
      ok: false,
      status: 503,
      error: "E_PROXY_UNAVAILABLE",
      reason: "closing",
      retryable: true,
    });
    expect(env.service.status!()).toMatchObject({ instances: 0, reserved: 0 });
    expect(env.servers[0]!.listening).toBe(false);
    expect(JSON.parse(await readFile(join(env.dir, "proxy/ports.json"), "utf8")).entries).toHaveLength(1);
  });
  it("hostname resolves once, stays pinned on reopen/requests (no request-time DNS)", async () => {
    let calls = 0;
    env = await engine({
      dns: {
        inflight: false,
        resolve: async () => {
          calls++;
          return { ok: true, answers: [{ address: calls === 1 ? "127.0.0.1" : "8.8.8.8", family: 4 }] };
        },
      },
    });
    const opened = await env.open(`app.local:${env.up.port}`);
    const { cookie } = await env.enter(opened);
    expect((await env.http(opened.origin, { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await env.open(`APP.local:${env.up.port}`)).instanceId).toBe(opened.instanceId);
    expect((await env.http(opened.origin, { headers: { Cookie: cookie } })).status).toBe(200);
    expect(calls).toBe(1);
    expect(env.up.requests).toHaveLength(2);
  });
  it("syntax/fence/DNS/listen/store/code failures all release reservations and cannot issue a usable link", async () => {
    env = await engine();
    for (const target of ["bad", "8.8.8.8:80", "127.0.0.1:1", `127.0.0.1:${env.range[0]}`]) {
      expect((await env.service.open(identity(), target, "127.0.0.1", env.service.currentSeq())).ok).toBe(false);
      expect(env.service.status!().reserved).toBe(0);
    }
    const id = identity();
    const seq = env.service.currentSeq();
    env.service.revoke({ sel: { sidTag: id.sidTag }, reason: "logout" });
    expect((await env.service.open(id, `127.0.0.1:${env.up.port}`, "127.0.0.1", seq)).ok).toBe(false);
    expect(env.service.status!().reserved).toBe(0);
    await env.close();
    env = await engine({ dns: { inflight: false, resolve: async () => ({ ok: false, reason: "dns-failed" }) } });
    expect(await env.service.open(identity(), "dev.local:80", "127.0.0.1", 0)).toMatchObject({
      ok: false,
      reason: "dns-failed",
    });
    expect(env.service.status!().reserved).toBe(0);
    await env.close();
    env = await engine({
      listen: async () => {
        throw Object.assign(new Error("PATH/CODE/COOKIE must not log"), { code: "EACCES" });
      },
    });
    expect(await env.service.open(identity(), "127.0.0.1:2000", "127.0.0.1", 0)).toMatchObject({
      ok: false,
      reason: "port-busy",
    });
    expect(env.service.status!()).toMatchObject({ instances: 0, reserved: 0 });
    expect(JSON.stringify(env.logs)).not.toContain("PATH/CODE/COOKIE");
  });
  it.each([false, true])("late listen self-closes after per-creation timeout, dispose=%s", async (dispose) => {
    const clock = manualClock();
    const allow = deferred<void>();
    const entered = deferred<Server>();
    const settled = deferred<void>();
    let server!: Server;
    env = await engine({
      now: clock.now,
      timer: clock.timer,
      listen: async (s, port, host) => {
        server = s;
        entered.resolve(s);
        await allow.promise;
        await listen(s, port, host);
        settled.resolve();
      },
    });
    const opening = env.service.open(identity(1, clock.now()), "127.0.0.1:2000", "127.0.0.1", 0);
    await entered.promise;
    if (dispose) await env.service.dispose();
    else clock.advance(PROXY_LISTEN_TIMEOUT_MS);
    expect(await opening).toMatchObject({ ok: false, reason: dispose ? "closing" : "listen-timeout" });
    expect(env.service.status!().reserved).toBe(0);
    allow.resolve();
    await settled.promise;
    await waitFor(() => server.address() === null);
    // Let the physical late listen actually settle, rather than accepting its initial null address.
    await flush();
    await flush();
    expect(server.listening).toBe(false);
    expect(env.service.status!().instances).toBe(0);
    if (!dispose)
      expect(await env.service.open(identity(2, clock.now()), "bad", "127.0.0.1", 0)).toMatchObject({
        reason: "syntax",
      });
  });
  it("stop owner/loopback policy, idempotent dispose/fence, no sweep timer after last instance", async () => {
    const clock = manualClock();
    env = await engine({ now: clock.now, timer: clock.timer });
    const owner = { ...identity(1, clock.now()), listener: "lan" as const, principal: "u1", userId: 1 };
    const opened = await env.open(undefined, owner);
    expect(await env.service.stop(opened.instanceId, { ...owner, principal: "u2", userId: 2 })).toEqual({
      ok: false,
      code: "E_NOT_FOUND",
    });
    expect(await env.service.stop(opened.instanceId, identity(2, clock.now()))).toEqual({ ok: true });
    expect(clock.pending()).toBe(0);
    await env.service.dispose();
    await env.service.dispose();
    expect(await env.service.open(owner, "127.0.0.1:2000", "127.0.0.1", 0)).toMatchObject({
      ok: false,
      reason: "closing",
    });
    expect(env.service.activeConnections()).toBe(0);
  });
  it("startup-failure owner can dispose a fully constructed service; listeners/old codes die", async () => {
    env = await engine();
    const opened = await env.open();
    const simulateStartup = async () => {
      try {
        throw new Error("later startup step failed");
      } finally {
        await env.service.dispose();
      }
    };
    await expect(simulateStartup()).rejects.toThrow("later startup step failed");
    expect(env.servers.every((s) => !s.listening)).toBe(true);
    expect(env.service.status!().instances).toBe(0);
    await expect(env.http(opened.enterUrl)).rejects.toThrow();
  });
  it("parent expiry cuts long HTTP at hardAt; response bytes never slide hard deadline", async () => {
    const clock = manualClock();
    env = await engine({ now: clock.now, timer: clock.timer });
    const opened = await env.open(undefined, { ...identity(1, clock.now()), parentExpiresAt: clock.now() + 10000 });
    const { cookie } = await env.enter(opened);
    const pending = env.http(opened.origin + "/stall-body", { headers: { Cookie: cookie } }).catch(() => "closed");
    await waitFor(() => env.up.requests.length === 1);
    clock.advance(10000);
    expect(await pending).toBe("closed");
    await waitFor(() => env.up.sockets.size === 0);
  });
  it("dispose with in-flight, queued and upgraded traffic destroys every socket and returns to fd/handle baseline", async () => {
    const fdCount = async () => (await readdir("/proc/self/fd")).length;
    const networkHandles = () =>
      (process as unknown as { _getActiveHandles(): object[] })
        ._getActiveHandles()
        .filter(
          (h) =>
            ["Socket", "Server"].includes(h.constructor.name) && ![0, 1, 2].includes((h as { fd?: number }).fd ?? -1),
        ).length;
    const base = await fdCount();
    const handlesBase = networkHandles();
    env = await engine();
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    const ws = await env.ws(opened, cookie);
    // One HTTP pipeline exercises active + queued requests without bypassing direct conn-guard.
    const piped = await env.raw(Number(new URL(opened.origin).port));
    piped.on("data", () => {});
    piped.write(
      Array.from(
        { length: 50 },
        () => `GET /hang HTTP/1.1\r\nHost: ${new URL(opened.origin).host}\r\nCookie: ${cookie}\r\n\r\n`,
      ).join(""),
    );
    await waitFor(() => env.up.held === 32);
    const at = Date.now();
    await env.service.dispose();
    await waitFor(() => ws.socket.destroyed && piped.destroyed && env.up.sockets.size === 0);
    expect(Date.now() - at).toBeLessThan(2000);
    await env.close();
    await waitFor(() => env.accepted.size === 0 && env.clients.size === 0);
    expect(await fdCount()).toBeLessThanOrEqual(base);
    await waitFor(() => networkHandles() <= handlesBase);
    expect(networkHandles()).toBeLessThanOrEqual(handlesBase);
  });
  it("sweep does not idle-close an active socket; activeConnections keeps a working tab visible", async () => {
    const clock = manualClock();
    env = await engine({ now: clock.now, timer: clock.timer });
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    const ws = await env.ws(opened, cookie);
    expect(env.service.activeConnections()).toBe(1);
    clock.advance(PROXY_INSTANCE_IDLE_MS + PROXY_SWEEP_INTERVAL_MS);
    expect(env.service.status!().instances).toBe(1);
    expect(ws.socket.destroyed).toBe(false);
    ws.socket.destroy();
    await waitFor(() => env.service.activeConnections() === 0);
    clock.advance(PROXY_SWEEP_INTERVAL_MS);
    await flush();
    expect(env.service.status!().instances).toBe(0);
  });
  it("follow-up: proxy range excludes the bound upstream and neighbor probes, including explicit ranges", async () => {
    env = await engine();
    for (let i = 0; i < 24; i++) {
      const range = await freeRange([env.up.port]);
      expect(env.up.port < range[0] - 1 || env.up.port > range[1] + 1).toBe(true);
    }
    expect(env.up.port < env.range[0] - 1 || env.up.port > env.range[1] + 1).toBe(true);
    expect((await env.open()).target.port).toBe(env.up.port);
    const range = env.range;
    await env.close();
    env = await engine({ config: { portRange: range, maxProxies: 8 } });
    expect(env.range).toEqual(range);
    expect(env.up.port < range[0] - 1 || env.up.port > range[1] + 1).toBe(true);
    expect((await env.open()).target.port).toBe(env.up.port);
  });
  it.each(["stale-first", "valid-first"])(
    "follow-up: shared new target keeps the valid opener alive (%s)",
    async (order) => {
      const entered = deferred<void>();
      const allow = deferred<void>();
      env = await engine({
        listen: async (s, p, h) => {
          entered.resolve();
          await allow.promise;
          await listen(s, p, h);
        },
      });
      const stale = identity(51),
        valid = identity(52);
      const oldSeq = env.service.currentSeq();
      env.service.revoke({ sel: { sidTag: stale.sidTag }, reason: "logout" });
      const newSeq = env.service.currentSeq();
      const target = `127.0.0.1:${env.up.port}`;
      const startStale = () => env.service.open(stale, target, "127.0.0.1", oldSeq);
      const startValid = () => env.service.open(valid, target, "127.0.0.1", newSeq);
      const calls = order === "stale-first" ? [startStale(), startValid()] : [startValid(), startStale()];
      await entered.promise;
      allow.resolve();
      const results = await Promise.all(calls);
      const bad = results[order === "stale-first" ? 0 : 1]!;
      const good = results[order === "stale-first" ? 1 : 0]!;
      expect(bad).toMatchObject({ ok: false, status: 503, reason: "closing", retryable: true });
      expect(good.ok).toBe(true);
      if (!good.ok) throw new Error("valid opener refused");
      expect(env.service.status!()).toMatchObject({ instances: 1, reserved: 0 });
      const { cookie } = await env.enter(good.result);
      expect((await env.http(good.result.origin, { headers: { Cookie: cookie } })).status).toBe(200);
      expect(env.servers.filter((s) => s.listening)).toHaveLength(1);
      expect(env.logs.filter((x) => (x as unknown[])[0] === "proxy-end")).toHaveLength(0);
    },
  );
  it("follow-up: all failed shared openers still close the ungranted instance", async () => {
    const entered = deferred<void>();
    const allow = deferred<void>();
    env = await engine({
      listen: async (s, p, h) => {
        entered.resolve();
        await allow.promise;
        await listen(s, p, h);
      },
    });
    const a = identity(51),
      b = identity(52);
    const seq = env.service.currentSeq();
    env.service.revoke({ sel: "all", reason: "rotate" });
    const target = `127.0.0.1:${env.up.port}`;
    const calls = [env.service.open(a, target, "127.0.0.1", seq), env.service.open(b, target, "127.0.0.1", seq)];
    await entered.promise;
    allow.resolve();
    expect((await Promise.all(calls)).every((r) => !r.ok)).toBe(true);
    expect(env.service.status!()).toMatchObject({ instances: 0, reserved: 0 });
    expect(env.servers.every((s) => !s.listening)).toBe(true);
  });
  it("follow-up: no-instance denials throttle by canonical target, never URL/path/query", async () => {
    const clock = manualClock();
    env = await engine({ now: clock.now, timer: clock.timer });
    for (const target of ["http://8.8.8.8:80/a?secret=a", "[::ffff:808:808]:80", "http://8.8.8.8:80/b?secret=b"]) {
      expect(await env.service.open(identity(), target, "127.0.0.1", 0)).toMatchObject({ reason: "public" });
    }
    const opens = () => env.logs.filter((x) => (x as unknown[])[0] === "proxy-open");
    expect(opens()).toHaveLength(1);
    await env.service.open(identity(), "9.9.9.9:80", "127.0.0.1", 0);
    expect(opens()).toHaveLength(2);
    clock.advance(60000);
    await env.service.open(identity(), "8.8.8.8:80", "127.0.0.1", 0);
    expect(opens()).toHaveLength(3);
    expect(JSON.stringify(env.logs)).not.toContain("secret=");
    expect(env.service.status!()).toMatchObject({ instances: 0, reserved: 0 });
  });
  it("follow-up: thrown DNS seam uses frozen dns-failed instead of claiming service closing", async () => {
    env = await engine({
      dns: {
        inflight: false,
        resolve() {
          throw new Error("never log exception-secret");
        },
      },
    });
    expect(await env.service.open(identity(), "app.local:80", "127.0.0.1", 0)).toEqual({
      ok: false,
      status: 400,
      error: "E_PROXY_DENIED",
      reason: "dns-failed",
    });
    expect(env.service.status!()).toMatchObject({ instances: 0, reserved: 0 });
    expect(JSON.stringify(env.logs)).not.toContain("exception-secret");
    expect((await env.open()).target.port).toBe(env.up.port);
  });
});
