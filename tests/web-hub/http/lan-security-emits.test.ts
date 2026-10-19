/** I5: assembled HTTP routes emit through the SAME bus, only LAN-origin high-risk events. */
import { afterEach, expect, it } from "vitest";
import { cleanupProxyHubs, startProxyHub } from "./proxy-kit.js";
import type { SecurityEvent } from "../../../src/web-hub/hub/security-events.js";
afterEach(cleanupProxyHubs);
it("real LAN proxy open carries resolved IP/target; loopback open emits nothing", async () => {
  const h = await startProxyHub({ lan: true });
  const events: SecurityEvent[] = [];
  h.deps.lan!.security!.subscribe((e) => events.push(e));
  const lp = await h.lanPort();
  const auth = await h.lanLogin();
  await h.open();
  expect(events.filter((e) => e.type === "proxy-open")).toEqual([]);
  const r = await h.api("POST", "/api/proxy/open", {
    port: lp,
    cookie: auth.cookie,
    body: { target: `127.0.0.1:${h.up.port}` },
  });
  expect(r.status).toBe(200);
  expect(events.filter((e) => e.type === "proxy-open")).toEqual([
    { type: "proxy-open", ip: "127.0.0.1", host: "127.0.0.1", port: h.up.port },
  ]);
});
