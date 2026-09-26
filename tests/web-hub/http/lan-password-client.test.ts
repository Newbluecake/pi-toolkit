/**
 * LC + LF integration (real HTTP route + the actual browser-side password-mode client, plan
 * §11's "LF+LC 联调测试（真实 http 路由 + 前端解析）" requirement — LC review fixes #6/#7,
 * lan-plan.md §15.9): `createPasswordClient` (`src/web-hub/web/password-client.js`) driven
 * against a *real* `createHttpFrontend` LAN listener, through a `fetch` adapter backed by real
 * `node:http` requests (`lanRequest` from `./lan-helpers.js`) rather than a hand-mocked response.
 * This is exactly the seam the two review findings slipped through: unit tests on either side
 * mocked the *other* side's shape correctly by construction, so a real field-name/tag mismatch
 * between them was invisible until both were wired together for real.
 */
import { describe, expect, it } from "vitest";
import { createPasswordClient } from "../../../src/web-hub/web/password-client.js";
import { lanPostJson, lanRequest, seedLanUser, startLan } from "./lan-helpers.js";

interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

/** Adapts `password-client.js`'s `fetch(url, init)` deps to a real LAN HTTP request, the way a
 * real browser's `fetch` would talk to a real hub \u2014 including the `Origin` header a browser
 * sets automatically (the client itself never sets it; CSRF requires it, §2.4). */
function fetchViaLan(
  port: number,
): (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponse> {
  return async (url, init = {}) => {
    const r = await lanRequest(port, {
      method: init.method ?? "GET",
      path: url,
      headers: { ...(init.headers ?? {}), Origin: `http://127.0.0.1:${port}` },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (name: string) => (r.headers[name.toLowerCase()] as string | undefined) ?? null },
      json: async () => (r.body.length > 0 ? JSON.parse(r.body) : {}),
    };
  };
}

/** Never actually opens an SSE connection \u2014 out of scope for these two field-name/tag checks,
 * which only exercise `POST /api/login`'s real response body. */
class NoopEventSource {
  readyState = 0;
  addEventListener(): void {}
  close(): void {}
}

function client(port: number) {
  return createPasswordClient({
    fetch: fetchViaLan(port),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    EventSource: NoopEventSource as any,
    location: { hash: "", pathname: "/", search: "" },
    history: { replaceState: () => {} },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: unknown) => clearTimeout(t as NodeJS.Timeout),
    now: () => Date.now(),
    onMessage: () => {},
    onConn: () => {},
    onAuthEvent: () => {},
    onUnauthenticated: () => {},
  });
}

describe("LC + LF integration: real /api/login response vs. the real frontend parser (lan-plan.md §15.9 #6/#7)", () => {
  it("review fix #6: a successful login with the initial password is surfaced as initialPassword:true (not lost to a field-name mismatch)", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "initial-secret-1", initial: true });
      const c = client(h.port);
      const r = await c.login("alice", "initial-secret-1");
      expect(r).toEqual({ ok: true, initialPassword: true });
    } finally {
      await h.cleanup();
    }
  });

  it("review fix #6: a successful login without the initial password is initialPassword:false", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const c = client(h.port);
      const r = await c.login("alice", "correct-horse-battery");
      expect(r).toEqual({ ok: true, initialPassword: false });
    } finally {
      await h.cleanup();
    }
  });

  it('review fix #7: an ordinary per-IP backoff lockout (not saturated, not the KDF admission queue) is classified "throttled" (countdown, no auto-retry) \u2014 previously indistinguishable E_RATE made this branch unreachable', async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      for (let i = 0; i < 6; i++) {
        await lanPostJson(h.port, "/api/login", { username: "alice", password: "wrong" });
      }
      // the 7th request within the window is now locked out (plan §6.2's 5-free-failures table)
      const raw = await lanPostJson(h.port, "/api/login", { username: "alice", password: "wrong" });
      expect(raw.status).toBe(429);
      expect(JSON.parse(raw.body)).toMatchObject({ error: "E_LOCKED" });

      const c = client(h.port);
      const r = await c.login("alice", "wrong");
      expect(r).toMatchObject({ ok: false, kind: "throttled" });
    } finally {
      await h.cleanup();
    }
  });

  it('review fix #7: the saturated sub-case keeps the plan\u2019s literal {error:"E_RATE", saturated:true} body and classifies "saturated" (no retry)', async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      for (let i = 0; i < 4096; i++) {
        h.limiter.fail(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
      }
      const raw = await lanPostJson(h.port, "/api/login", { username: "alice", password: "wrong" });
      expect(raw.status).toBe(429);
      expect(JSON.parse(raw.body)).toMatchObject({ error: "E_RATE", saturated: true });

      const c = client(h.port);
      const r = await c.login("alice", "wrong");
      expect(r).toMatchObject({ ok: false, kind: "saturated" });
    } finally {
      await h.cleanup();
    }
  });
});
