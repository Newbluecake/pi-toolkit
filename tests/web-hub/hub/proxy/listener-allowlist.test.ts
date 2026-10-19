/** LAN security §2.3 #3 / §10 (pkg A): the proxy listener enforces the client allowlist at connection level. */
import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { createClientAllowGuard } from "../../../../src/web-hub/hub/client-allow.js";
import type { ClientAllowGuard } from "../../../../src/web-hub/hub/ports.js";
import { engine } from "./engine-helpers.js";

let env: Awaited<ReturnType<typeof engine>>;
afterEach(async () => {
  await env?.close();
});

function guardWithLog(entries: string[] | undefined, implicitLoopback?: false) {
  const lines: Array<{ msg: string; data: Record<string, unknown> }> = [];
  const guard = createClientAllowGuard({
    ...(entries === undefined ? {} : { entries }),
    ...(implicitLoopback === undefined ? {} : { implicitLoopback }),
    log: { info: (msg, data) => lines.push({ msg, data: (data ?? {}) as Record<string, unknown> }) },
  });
  return { guard, lines };
}

/** Send raw bytes, resolve with everything the server sent before it closed (never hangs: 3 s cap). */
async function exchange(env: Awaited<ReturnType<typeof engine>>, port: number, payload: string) {
  const socket = await env.raw(port);
  const chunks: Buffer[] = [];
  socket.on("data", (b) => chunks.push(b));
  socket.write(payload);
  await Promise.race([once(socket, "close"), new Promise((r) => setTimeout(r, 3000).unref())]);
  return { bytes: Buffer.concat(chunks).length, closed: socket.destroyed || socket.readyState === "closed" };
}

describe("proxy listener allowlist", () => {
  it("inactive guard (no clientAllow dep) admits everything: enter, forward", async () => {
    env = await engine();
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    const res = await env.http(`${opened.origin}/hello`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it("explicit allow entry admits enter, forwarded HTTP and WebSocket upgrade", async () => {
    const { guard } = guardWithLog(["127.0.0.1/32"], false);
    env = await engine({ clientAllow: guard });
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    const res = await env.http(`${opened.origin}/hello`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const ws = await env.ws(opened, cookie);
    expect(ws.text()).toContain("101 Switching Protocols");
    expect(guard.snapshot().denied).toBeUndefined();
  });

  it("implicit loopback keeps a deny-all ([]) listener reachable from 127.0.0.1", async () => {
    const { guard } = guardWithLog([]);
    expect(guard.active).toBe(true);
    env = await engine({ clientAllow: guard });
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    expect((await env.http(`${opened.origin}/x`, { headers: { cookie } })).status).toBe(200);
  });

  it.each([
    ["not in the list", ["10.0.0.0/8"]],
    ["deny-all", [] as string[]],
  ])(
    "denied peer (%s): no bytes for enter / HTTP / upgrade, upstream never touched, audited as proxy",
    async (_n, entries) => {
      const { guard, lines } = guardWithLog(entries, false);
      env = await engine({ clientAllow: guard });
      const opened = await env.open();
      const port = Number(new URL(opened.origin).port);
      const host = new URL(opened.origin).host;
      const enter = await exchange(
        env,
        port,
        `GET ${new URL(opened.enterUrl).pathname}${new URL(opened.enterUrl).search} HTTP/1.1\r\nHost: ${host}\r\n\r\n`,
      );
      const plain = await exchange(env, port, `GET /hello HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
      const upgrade = await exchange(
        env,
        port,
        `GET /ws HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: ${opened.origin}\r\n\r\n`,
      );
      for (const r of [enter, plain, upgrade]) expect(r).toEqual({ bytes: 0, closed: true });
      expect(env.up.requests).toHaveLength(0);
      expect(env.service.activeConnections()).toBe(0);
      expect(guard.snapshot().denied?.total).toBe(3);
      // One audit line per IP per window, tagged by the proxy listener, via=peer; the rest is `suppressed`.
      expect(lines).toHaveLength(1);
      expect(lines[0]!.data).toMatchObject({
        audit: "client-deny",
        listener: "proxy",
        via: "peer",
        reason: "not-allowed",
        ip: "127.0.0.1",
        suppressed: 0,
      });
    },
  );

  it("calls admitPeer(remoteAddress, false) exactly once per connection, before any bytes are read", async () => {
    const calls: Array<[string, boolean]> = [];
    const spy: ClientAllowGuard = {
      active: true,
      admitPeer(ip, trusted) {
        calls.push([ip, trusted]);
        return false;
      },
      admitForwarded: () => true,
      snapshot: () => ({ entries: [] }),
      onBurst: () => () => {},
    };
    env = await engine({ clientAllow: spy });
    const opened = await env.open();
    const r = await exchange(env, Number(new URL(opened.origin).port), "");
    expect(r).toEqual({ bytes: 0, closed: true });
    expect(calls).toEqual([[expect.stringMatching(/127\.0\.0\.1$/), false]]);
  });

  it("a denied enter attempt never spends the one-time code (refused before the session store)", async () => {
    let allow = false;
    const gate: ClientAllowGuard = {
      active: true,
      admitPeer: () => allow,
      admitForwarded: () => true,
      snapshot: () => ({ entries: [] }),
      onBurst: () => () => {},
    };
    env = await engine({ clientAllow: gate });
    const opened = await env.open();
    const url = new URL(opened.enterUrl);
    const denied = await exchange(
      env,
      Number(url.port),
      `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`,
    );
    expect(denied.bytes).toBe(0);
    allow = true;
    const { res } = await env.enter(opened);
    expect(res.status).toBe(303);
  });
});
