/**
 * LAN `GET /api/load/top` budget regression (sysload plan §7.1/§7.3, LAN parity with
 * preview/wtdiff's ~3s auth budget off an 8s total admission window).
 *
 * Root cause: unlike every other LAN GET endpoint that derives its `authDeadlineMs` from a
 * real multi-second total request budget (preview: 8s total, 4s reserve ⇒ 3s auth cap; wtdiff:
 * 8s total, 5s reserve ⇒ 3s auth cap), `/api/load/top`'s LAN branch derived its auth budget
 * from `LOAD_TOP_DEADLINE_MS` itself (1.5s) — `deriveBudget(1500, 3000, 500)` = 1000ms. LAN
 * auth is an IPC round-trip to the separate sqlite-backed auth store (unlike loopback's
 * synchronous in-process cookie check), so on any real system under load that IPC call
 * regularly exceeds 1000ms while comfortably completing under a few seconds — the on-demand
 * "Top 进程" card panel then fails every single time (503 `E_DB`) while the SSE-pushed load
 * snapshot (loopback-style sync cookie check / no deadline on the SSE auth path) keeps working.
 */
import { afterEach, describe, expect, it } from "vitest";
import { fakeLanStore, type FakeLanStore } from "../contract/fakes.js";
import type { HubLoadConfig } from "../../../src/web-hub/hub/ports.js";
import { lanPostJson, lanRequest, seedLanUser, startLan, type LanHarness } from "./lan-helpers.js";

const LOAD: HubLoadConfig = {
  sampleIntervalMs: 5_000,
  sustainMs: 60_000,
  recoverMs: 30_000,
  thresholds: {
    cpu: { warnPercent: 85, critPercent: 95, psiWarnPercent: 40, psiCritPercent: 70 },
    mem: { warnAvailPercent: 15, critAvailPercent: 8 },
    disk: { warnFreePercent: 10, critFreePercent: 5, critFreeGiB: 5 },
  },
};

const IS_LINUX = process.platform === "linux";

/** Wraps a `FakeLanStore`'s `touchSession` with an artificial IPC-like delay — standing in for
 * a real system under load where the sqlite auth child process' round-trip genuinely takes this
 * long (seen on real hardware with the hub's own process competing for CPU). */
function withTouchSessionDelay(store: FakeLanStore, delayMs: number): FakeLanStore {
  return {
    ...store,
    touchSession: (sidHash, now) =>
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(store.touchSession(sidHash, now)), delayMs);
        t.unref?.();
      }),
  };
}

async function loggedIn(h: LanHarness): Promise<string> {
  seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
  const r = await lanPostJson(h.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
  expect(r.status).toBe(200);
  return (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
}

const harnesses: LanHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

describe.skipIf(!IS_LINUX)("LAN GET /api/load/top budget (sysload plan §7.1/§7.3)", () => {
  it("fast auth (no delay) ⇒ 200 with a valid payload", async () => {
    const h = await startLan({ load: LOAD });
    harnesses.push(h);
    const cookie = await loggedIn(h);
    const res = await lanRequest(h.port, {
      path: "/api/load/top",
      headers: { Cookie: cookie, "X-PWH": "1" },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { byCpu?: unknown[]; byRss?: unknown[] };
    expect(Array.isArray(body.byCpu)).toBe(true);
    expect(Array.isArray(body.byRss)).toBe(true);
  });

  it("missing X-PWH ⇒ 403 E_CSRF (unchanged by the budget fix)", async () => {
    const h = await startLan({ load: LOAD });
    harnesses.push(h);
    const cookie = await loggedIn(h);
    const res = await lanRequest(h.port, { path: "/api/load/top", headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_CSRF" });
  });

  it(
    "a 1.1s LAN auth IPC round-trip (realistic under real system load) must still succeed — this " +
      "is the exact regression: the LAN auth budget must not be derived from the 1.5s scan-only " +
      "LOAD_TOP_DEADLINE_MS, which would collapse the auth cap to ~1s and fail every such request",
    async () => {
      const delayed = withTouchSessionDelay(fakeLanStore(), 1_100);
      const h = await startLan({ load: LOAD, store: delayed });
      harnesses.push(h);
      const cookie = await loggedIn(h);
      const start = Date.now();
      const res = await lanRequest(h.port, {
        path: "/api/load/top",
        headers: { Cookie: cookie, "X-PWH": "1" },
      });
      const elapsed = Date.now() - start;
      expect(res.status, `body=${res.body} elapsed=${elapsed}ms`).toBe(200);
      const body = JSON.parse(res.body) as { byCpu?: unknown[]; byRss?: unknown[] };
      expect(Array.isArray(body.byCpu)).toBe(true);
    },
  );

  it("an auth round-trip beyond the LAN auth cap (3s) still fails closed with 503 E_DB (budget is generous, not unbounded)", async () => {
    const delayed = withTouchSessionDelay(fakeLanStore(), 3_500);
    const h = await startLan({ load: LOAD, store: delayed });
    harnesses.push(h);
    const cookie = await loggedIn(h);
    const res = await lanRequest(h.port, {
      path: "/api/load/top",
      headers: { Cookie: cookie, "X-PWH": "1" },
    });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_DB" });
  }, 10_000);
});
