/**
 * Fail-closed on a permanent db outage (plan §4.1/§4.2 "LAN off/db-unavailable（关闭 LAN
 * listener，fail-closed）"; LD review-fix P1, attributed to LC's `hub/http.ts`).
 *
 * `db-client.ts`'s `onUnavailable` fires once the resident query subprocess gives up for good
 * (4 restarts inside a rolling 10-minute window); before this fix `createHttpFrontend` never
 * reacted to it at all — only `lan-assembly.ts` did, and only by relabeling `LanStatus`, never
 * actually closing the socket the LAN listener was bound to. This suite drives that same event
 * through `fakes.ts`'s `FakeLanStore.simulateUnavailable()` (mirroring the real `LanStore`'s
 * `onUnavailable` shape, not part of the frozen `LanStorePort`) so it can assert the listener is
 * really gone without needing a real SQLite backend.
 */
import { describe, expect, it } from "vitest";
import { lanPostJson, lanRequest, seedLanUser, startLan } from "./lan-helpers.js";

describe("LAN db-unavailable fail-closed (plan §4.1, LC review-fix P1)", () => {
  it("actually closes the LAN listener and flips LanFacade.status() to off/db-unavailable", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const before = await lanPostJson(h.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
      expect(before.status).toBe(200);
      expect(h.fe.lan?.status().state).toBe("on");

      h.store.simulateUnavailable();
      // The close is asynchronous (`LanFacade.close()` awaits `handle.close()`); poll briefly.
      for (let i = 0; i < 50 && h.fe.lan?.status().state !== "off"; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const status = h.fe.lan?.status();
      expect(status?.state).toBe("off");
      expect(status).toMatchObject({ state: "off", reason: "db-unavailable" });

      // The listener itself must be gone (fail-closed, not just a relabeled status) — a fresh
      // connection to the same port must fail outright, not merely 503.
      await expect(lanRequest(h.port, { path: "/api/session" })).rejects.toThrow();
    } finally {
      await h.cleanup();
    }
  });

  it("a host-set change after db-unavailable never resurrects the status to on (recompute is inert once closed)", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      h.store.simulateUnavailable();
      for (let i = 0; i < 50 && h.fe.lan?.status().state !== "off"; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(h.fe.lan?.status().state).toBe("off");

      // A throttled recompute would normally rebuild `LanStatus` from the (still-computable)
      // host snapshot and call `lan.onStatus(...)` with `state: "on"` — the `lanClosed` guard
      // added alongside the fail-closed fix must keep that from firing after `close()`.
      await new Promise((r) => setTimeout(r, 50));
      expect(h.fe.lan?.status().state).toBe("off");
    } finally {
      await h.cleanup();
    }
  });
});
