/** Regression at REAL startHub assembly, not only the frontend's default seam. */
import { afterEach, expect, it } from "vitest";
import { cleanupProxyHubs, startProxyHub } from "./proxy-kit.js";
import { seedLanUser } from "./lan-helpers.js";
afterEach(cleanupProxyHubs);
it("production startHub stages enrolled accounts without advertising unavailable second-factor UI", async () => {
  const h = await startProxyHub({ lan: true, proxy: false });
  const port = await h.lanPort();
  const store = h.lanStore!;
  seedLanUser(store, { username: "alice", password: "correct-horse-battery" });
  await store.setFeishu2fa({ userId: 1, on: true, now: Date.now() });
  expect(h.deps.lan!.secondFactorEnabled).toBe(false);
  const r = await h.api("POST", "/api/login", {
    port,
    cookie: null,
    body: { username: "alice", password: "correct-horse-battery" },
  });
  expect(r.status).toBe(200);
  expect(JSON.parse(r.body)).toEqual({ ok: true, initialPassword: false });
  expect((await h.api("POST", "/api/login/2fa", { port, body: {} })).status).toBe(404);
  const info = await h.api("GET", "/api/hub");
  expect(JSON.parse(info.body).caps ?? []).not.toContain("lan.2fa.v1");
});
