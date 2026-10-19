/** Real route + real HTML-cap registry + real proxy forwarding/session store (HTTP AND WS). */
import { request } from "node:http";
import { afterEach, expect, it } from "vitest";
import { engine, waitFor } from "../hub/proxy/engine-helpers.js";
import { cleanupLans, startLanPv } from "./pv-lan-kit.js";
import { lanPostJson, openSse } from "./lan-helpers.js";
import { hashSid, publicSessionId } from "../../../src/web-hub/hub/sid-hash.js";
let proxy: Awaited<ReturnType<typeof engine>> | undefined;
afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  await cleanupLans();
});
it("session revoke kills actual proxy HTTP and WS, HTML capability, SSE and cookie identity, not another device", async () => {
  const l = await startLanPv();
  const current = await l.lanCookie(1, "alice");
  const otherReply = await lanPostJson(l.lanPort, "/api/login", {
    username: "alice",
    password: "correct-horse-battery",
  });
  const other = otherReply.headers["set-cookie"]![0]!.split(";")[0]!;
  const otherHash = hashSid(other.split("=")[1]!);
  const cap = l.capOf(await l.mintLan(other));
  const keepCap = l.capOf(await l.mintLan(current));
  const sse = await openSse(l.lanPort, other);
  await sse.waitFor("hello");
  proxy = await engine();
  const off = l.fe.subscribeAuthRevoke((ev) => proxy!.service.revoke(ev));
  try {
    const opened = await proxy.open(undefined, {
      listener: "lan",
      principal: "u1",
      sidTag: otherHash,
      userId: 1,
      parentExpiresAt: Date.now() + 600000,
    });
    const { cookie } = await proxy.enter(opened);
    expect((await proxy.http(`${opened.origin}/hello`, { headers: { Cookie: cookie } })).status).toBe(200);
    const ws = await proxy.ws(opened, cookie);
    expect(ws.text()).toContain("101 Switching Protocols");
    const streaming = request(`${opened.origin}/stall-body`, { headers: { Cookie: cookie }, agent: false });
    streaming.on("error", () => {});
    const bodyStarted = new Promise<void>((resolve, reject) => {
      streaming.once("response", (res) => {
        res.on("error", () => {});
        res.once("data", () => resolve());
        res.resume();
      });
      streaming.once("error", reject);
    });
    streaming.setTimeout(4000, () => streaming.destroy());
    streaming.end();
    await bodyStarted;
    const r = await lanPostJson(
      l.lanPort,
      "/api/lan/sessions/revoke",
      { id: publicSessionId(otherHash) },
      { Cookie: current },
    );
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, revoked: 1, complete: true });
    await waitFor(() => ws.socket.destroyed && streaming.destroyed && proxy!.up.upgraded.size === 0);
    expect((await sse.waitFor("auth")).data).toEqual({ reason: "revoked" });
    expect((await proxy.http(`${opened.origin}/hello`, { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await l.lanGet(`/pv/${cap}/index.html`)).status).toBe(404);
    expect((await l.lanGet(`/pv/${keepCap}/index.html`)).status).toBe(200);
    expect((await l.lanGet("/api/session", { Cookie: other })).status).toBe(401);
    expect((await l.lanGet("/api/session", { Cookie: current })).status).toBe(200);
  } finally {
    off();
    sse.close();
  }
});
