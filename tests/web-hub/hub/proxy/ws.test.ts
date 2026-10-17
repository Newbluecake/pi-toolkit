import { afterEach, describe, expect, it } from "vitest";
import { engine, identity, waitFor } from "./engine-helpers.js";
import { manualClock, flush } from "./helpers.js";
import {
  PROXY_WS_HANDSHAKE_MS,
  PROXY_WS_IDLE_MS,
  PROXY_STREAM_HWM_BYTES,
} from "../../../../src/web-hub/protocol/proxy.js";

let env: Awaited<ReturnType<typeof engine>>;
afterEach(async () => {
  await env?.close();
});
describe("T-H3 WebSocket", () => {
  it("echoes both initial heads and later frames, filters 101 and cleans both sockets on revoke", async () => {
    env = await engine();
    const id = identity();
    const opened = await env.open(undefined, id);
    const { cookie } = await env.enter(opened);
    const frame = Buffer.from([0x81, 3, 0x61, 0x62, 0x63]);
    const ws = await env.ws(opened, cookie, { head: frame });
    expect(ws.text()).toContain("101 Switching Protocols");
    expect(ws.text().toLowerCase()).not.toContain("clear-site-data");
    expect(ws.text()).not.toContain("pwh_sid");
    expect(ws.text()).toContain("app=ok");
    expect(ws.text()).not.toContain("Domain=");
    await waitFor(() => Buffer.concat(ws.chunks).includes(frame));
    const later = Buffer.from([0x82, 4, 1, 2, 3, 4]);
    ws.socket.write(later);
    await waitFor(() => Buffer.concat(ws.chunks).includes(later));
    expect(env.up.requests[0]!.headers.cookie).toBeUndefined();
    expect(env.service.activeConnections()).toBe(1);
    const closed = new Promise((resolve) => ws.socket.once("close", resolve));
    env.service.revoke({ sel: { sidTag: id.sidTag }, reason: "logout" });
    await closed;
    await waitFor(() => env.up.upgraded.size === 0 && env.service.activeConnections() === 0);
  });
  it.each([null, "null", "http://127.0.0.1:9999"])("Origin %s refused BEFORE upstream", async (origin) => {
    env = await engine();
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    expect((await env.ws(opened, cookie, { origin })).text()).toContain("403");
    expect(env.up.connections).toBe(0);
  });
  it("h2c and non-101 filtered response; body truncated to 64KiB", async () => {
    env = await engine();
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    expect((await env.ws(opened, cookie, { upgrade: "h2c" })).text()).toContain("400");
    expect(env.up.connections).toBe(0);
    const ws = await env.ws(opened, cookie, { path: "/ws-reject" });
    await waitFor(() => ws.socket.destroyed);
    const text = ws.text();
    expect(text).toContain("403");
    expect(text.toLowerCase()).not.toContain("clear-site-data");
    expect(text).not.toContain("pwh_sid");
    expect(text).not.toContain("Domain=");
    expect(text).toContain("app=ok");
    expect(Buffer.byteLength(text.split("\r\n\r\n")[1]!)).toBe(65536);
  });
  it("handshake 10s deadline; established quiet WS survives 10s then dies on idle, not on old handshake timer", async () => {
    const clock = manualClock();
    env = await engine({ now: clock.now, timer: clock.timer });
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    const live = await env.ws(opened, cookie);
    const stalledPromise = env.ws(opened, cookie, { path: "/ws-stall" });
    await waitFor(() => env.up.requests.some((r) => r.path === "/ws-stall"));
    clock.advance(PROXY_WS_HANDSHAKE_MS);
    const stalled = await stalledPromise;
    await waitFor(() => stalled.socket.destroyed);
    expect(live.socket.destroyed).toBe(false);
    // Node socket idle timers are physical, test them through the real timeout event; the exact
    // timeout configured on both sides remains 30min, independent of the injected deadline clock.
    expect((env.servers[0] as unknown as { _connections: number })._connections).toBe(1);
    const proxySocket = [...env.accepted][0]!;
    expect(proxySocket.timeout).toBe(PROXY_WS_IDLE_MS);
    proxySocket.emit("timeout");
    await waitFor(() => live.socket.destroyed && env.up.upgraded.size === 0);
  });
  it("parent hard deadline closes established WS, without response/data extending it", async () => {
    const clock = manualClock();
    env = await engine({ now: clock.now, timer: clock.timer });
    const id = { ...identity(1, clock.now()), parentExpiresAt: clock.now() + 20000 };
    const opened = await env.open(undefined, id);
    const { cookie } = await env.enter(opened);
    const ws = await env.ws(opened, cookie);
    clock.advance(19999);
    await flush();
    expect(ws.socket.destroyed).toBe(false);
    clock.advance(1);
    await waitFor(() => ws.socket.destroyed);
    await waitFor(() => env.up.upgraded.size === 0);
  });
  it("33rd WS refused and capacity returned after disconnect", async () => {
    env = await engine();
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    const sockets = [];
    for (let i = 0; i < 32; i++) {
      const w = await env.ws(opened, cookie);
      expect(w.text()).toContain("101");
      sockets.push(w);
    }
    const refused = await env.ws(opened, cookie);
    expect(refused.text()).toContain("503");
    expect(env.up.upgraded.size).toBe(32);
    sockets[0]!.socket.destroy();
    await waitFor(() => env.up.upgraded.size === 31);
    expect((await env.ws(opened, cookie)).text()).toContain("101");
  });
  it("global WS budget 64 across instances, then releases on failure/stop", async () => {
    env = await engine();
    const a = await env.open();
    const aa = await env.enter(a);
    const b = await env.open(`localhost:${env.up.port}`);
    const bb = await env.enter(b);
    const c = await env.open(`127.0.0.1:${env.up.port + 1}`);
    const cc = await env.enter(c);
    for (let i = 0; i < 32; i++) {
      expect((await env.ws(a, aa.cookie)).text()).toContain("101");
      expect((await env.ws(b, bb.cookie)).text()).toContain("101");
    }
    expect((await env.ws(c, cc.cookie)).text()).toContain("503");
    expect(env.up.upgraded.size).toBe(64);
    const count = env.up.requests.length;
    expect((await env.ws(b, bb.cookie, { origin: a.origin })).text()).toContain("403");
    expect(env.up.requests).toHaveLength(count);
    await env.service.stop(a.instanceId, identity());
    await waitFor(() => env.up.upgraded.size === 32);
    // The now-unbudgeted third instance can reach a refused TCP port and relay 502, not hang.
    const failed = await env.ws(c, cc.cookie);
    expect(failed.text()).toContain("502");
  });
  it("paused readers backpressure both directions (bounded by hwm plus one chunk)", async () => {
    env = await engine();
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    const ws = await env.ws(opened, cookie);
    ws.off();
    ws.socket.pause();
    const remote = [...env.up.upgraded][0]!;
    const chunk = Buffer.alloc(PROXY_STREAM_HWM_BYTES, 0x71);
    let writes = 0;
    const pump = () => {
      while (!remote.destroyed && writes++ < 2048)
        if (!remote.write(chunk)) {
          remote.once("drain", pump);
          return;
        }
    };
    pump();
    await waitFor(() => remote.writableNeedDrain && remote.writableLength > 0);
    // Inspect the proxy-side physical sockets through connection capture, not process RSS.
    // A saturated remote writer proves the reader is no longer drained unboundedly.
    expect(remote.writableLength).toBeLessThanOrEqual(PROXY_STREAM_HWM_BYTES * 2);
    expect(remote.readableLength).toBeLessThanOrEqual(PROXY_STREAM_HWM_BYTES * 2);
    const proxySocket = [...env.accepted][0]!;
    expect(proxySocket.writableLength).toBeLessThanOrEqual(PROXY_STREAM_HWM_BYTES * 2);
    expect(proxySocket.readableLength).toBeLessThanOrEqual(PROXY_STREAM_HWM_BYTES * 2);
    expect(writes).toBeLessThan(2048);
    // Reverse direction: stop the upstream reader, then saturate the client writer.
    remote.pause();
    ws.socket.resume();
    let sent = 0;
    const upload = () => {
      while (!ws.socket.destroyed && sent++ < 2048)
        if (!ws.socket.write(chunk)) {
          ws.socket.once("drain", upload);
          return;
        }
    };
    upload();
    await waitFor(() => ws.socket.writableNeedDrain && ws.socket.writableLength > 0);
    expect(ws.socket.writableLength).toBeLessThanOrEqual(PROXY_STREAM_HWM_BYTES * 2);
    expect(proxySocket.readableLength).toBeLessThanOrEqual(PROXY_STREAM_HWM_BYTES * 2);
    expect(sent).toBeLessThan(2048);
  });
});
