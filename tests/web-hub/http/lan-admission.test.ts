/**
 * §4.2/§6.3 HTTP-layer admission quotas (plan §11 LC row: "每客户端 IP 进行中
 * 配额 16 / 每 sid 8 / SSE 上限先于 IPC；静态与 healthz 零 IPC").
 */
import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { lanPostJson, lanRequest, seedLanUser, startLan } from "./lan-helpers.js";

async function loginCookie(port: number, username = "alice"): Promise<string> {
  const r = await lanPostJson(port, "/api/login", { username, password: "correct-horse-battery" });
  return (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
}

async function loginCookie2(port: number, username = "alice"): Promise<string> {
  const r = await lanPostJson(
    port,
    "/api/login",
    { username, password: "correct-horse-battery" },
    { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "hub.example.com", Origin: "https://hub.example.com" },
    "127.0.0.2",
  );
  return (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
}

describe("LAN admission quotas (plan §4.2)", () => {
  it("per-clientIP inflight cap (16): the 17th concurrent session-gated request gets 429", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const cookie = await loginCookie(h.port);
      // Make history calls hang so 16 stay "in flight" simultaneously.
      const original = h.store.getUserSummary;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      h.store.getUserSummary = async (...args) => {
        await gate;
        return original.apply(h.store, args);
      };
      const inflight = Array.from({ length: 16 }, () =>
        lanRequest(h.port, { path: "/api/session", headers: { Cookie: cookie } }),
      );
      await new Promise((r) => setTimeout(r, 50)); // let them all reach the gate
      const seventeenth = await lanRequest(h.port, { path: "/api/session", headers: { Cookie: cookie } });
      expect(seventeenth.status).toBe(429);
      release();
      const results = await Promise.all(inflight);
      for (const r of results) expect(r.status).toBe(200);
      h.store.getUserSummary = original;
    } finally {
      await h.cleanup();
    }
  }, 10_000);

  it("per-sid touchSession dedupe: 20 concurrent requests on one sid (via a trusted proxy, distinct XFF client IPs so the per-clientIP cap doesn't also trip) ⇒ 1 IPC call, 8 succeed, 12 get 429", async () => {
    const h = await startLan({ cfg: { trustProxyFrom: ["127.0.0.2"], externalOrigins: ["https://hub.example.com"] } });
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const cookie = await loginCookie2(h.port);
      let touchCalls = 0;
      const originalTouch = h.store.touchSession;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      h.store.touchSession = async (...args) => {
        touchCalls++;
        await gate;
        return originalTouch.apply(h.store, args);
      };
      const all = Array.from({ length: 20 }, (_, i) =>
        lanRequest(h.port, {
          path: "/api/session",
          localAddress: "127.0.0.2",
          headers: {
            Cookie: cookie,
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "hub.example.com",
            "X-Forwarded-For": `10.5.0.${i}`,
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
      release();
      const results = await Promise.all(all);
      expect(touchCalls).toBe(1);
      const ok = results.filter((r) => r.status === 200).length;
      const busy = results.filter((r) => r.status === 429).length;
      expect(ok).toBe(8);
      expect(busy).toBe(12);
      h.store.touchSession = originalTouch;
    } finally {
      await h.cleanup();
    }
  }, 10_000);

  it("/api/events checks the SSE limit before touching the store (zero extra IPC on rejection)", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const cookie = await loginCookie(h.port);
      const opened: ReturnType<typeof httpRequest>[] = [];
      const openSse = (): Promise<number> =>
        new Promise((resolve, reject) => {
          const req = httpRequest(
            {
              host: "127.0.0.1",
              port: h.port,
              path: "/api/events",
              headers: { Host: `127.0.0.1:${h.port}`, Cookie: cookie, Accept: "text/event-stream" },
            },
            (res) => resolve(res.statusCode ?? 0),
          );
          req.on("error", reject);
          req.end();
          opened.push(req);
        });
      const eight = await Promise.all(Array.from({ length: 8 }, () => openSse()));
      for (const s of eight) expect(s).toBe(200);

      let touchCalls = 0;
      const originalTouch = h.store.touchSession;
      h.store.touchSession = async (...args) => {
        touchCalls++;
        return originalTouch.apply(h.store, args);
      };
      const ninthStatus = await openSse();
      expect(ninthStatus).toBe(429);
      expect(touchCalls).toBe(0); // rejected by the SSE-limit check, before any touchSession IPC
      h.store.touchSession = originalTouch;

      for (const req of opened) req.destroy();
    } finally {
      await h.cleanup();
    }
  }, 10_000);

  it("static resources and /healthz never touch the store even while authenticated", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const cookie = await loginCookie(h.port);
      let calls = 0;
      const wrap =
        <A extends unknown[], R>(fn: (...a: A) => R) =>
        (...a: A): R => {
          calls++;
          return fn(...a);
        };
      h.store.touchSession = wrap(h.store.touchSession.bind(h.store));
      for (let i = 0; i < 10; i++) {
        await lanRequest(h.port, { path: "/", headers: { Cookie: cookie } });
        await lanRequest(h.port, { path: "/healthz", headers: { Cookie: cookie } });
      }
      expect(calls).toBe(0);
    } finally {
      await h.cleanup();
    }
  });
});
