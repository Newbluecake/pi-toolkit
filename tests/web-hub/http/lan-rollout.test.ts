/** Regression at REAL startHub assembly, not only the frontend's default seam. */
import { afterEach, expect, it } from "vitest";
import { cleanupProxyHubs, startProxyHub } from "./proxy-kit.js";
import { connectClient, hello } from "../hub/helpers.js";
import { seedLanUser } from "./lan-helpers.js";
afterEach(cleanupProxyHubs);
it("production startHub gates new-IP enrolled logins and advertises BOTH capabilities on both surfaces", async () => {
  const h = await startProxyHub({ lan: true, proxy: false });
  const port = await h.lanPort();
  const store = h.lanStore!;
  seedLanUser(store, { username: "alice", password: "correct-horse-battery" });
  await store.setFeishu2fa({ userId: 1, on: true, now: Date.now() });
  expect(h.deps.lan!.secondFactorEnabled).toBe(true);
  const r = await h.api("POST", "/api/login", {
    port,
    cookie: null,
    body: { username: "alice", password: "correct-horse-battery" },
  });
  expect(r.status).toBe(401);
  expect(JSON.parse(r.body)).toMatchObject({ error: "E_2FA", methods: ["recovery"] });
  expect(store.sessionsBySidHash.size).toBe(0);
  expect((await h.api("POST", "/api/login/2fa", { port, body: {} })).status).toBe(400);
  expect(h.hub.info.caps).toEqual(expect.arrayContaining(["lan.2fa.v1", "lan.sessions.v1"]));
  const c = await connectClient(h.hub.paths.socketPath);
  try {
    c.send(hello());
    const ack = await c.waitFrame((f) => f.t === "hello_ack");
    expect(ack.caps).toEqual(h.hub.info.caps);
  } finally {
    c.sock.destroy();
  }
});

it("production loopback-only hub remains free of both LAN security capabilities", async () => {
  const h = await startProxyHub({ proxy: false });
  expect(h.deps.lan).toBeUndefined();
  expect(h.hub.info.caps).not.toContain("lan.2fa.v1");
  expect(h.hub.info.caps).not.toContain("lan.sessions.v1");
});
