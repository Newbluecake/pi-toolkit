/**
 * §4.2 "SSE 到期复核" (LC review fix, lan-plan.md §15.9 #3): a successful recheck (session still
 * valid) updates the connection's own `auth.verifiedAt` — a focused unit test on
 * `recheckLanSseExpiry` directly (exported from `hub/http.ts` for exactly this purpose; not part
 * of any frozen `ports.ts` surface). The end-to-end revoke/keep-open/batch paths are already
 * covered through the real HTTP harness in `lan-sse-expiry.test.ts`.
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { recheckLanSseExpiry, type LanRuntime } from "../../../src/web-hub/hub/http.js";
import { createSseHub, type SseClient, type SseHub } from "../../../src/web-hub/hub/sse.js";
import { fakeLanStore } from "../contract/fakes.js";
import { captureLog, openSse } from "./helpers.js";

describe("recheckLanSseExpiry updates auth.verifiedAt on a successful recheck", () => {
  let server: Server | undefined;
  let hub: SseHub | undefined;

  afterEach(async () => {
    hub?.closeAll();
    hub = undefined;
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
  });

  it("bumps verifiedAt (and never revokes) when the session is still valid", async () => {
    let now = 1_700_000_000_000;
    const store = fakeLanStore();
    store.seedUser({
      id: 1,
      username: "alice",
      kdf: "scrypt",
      n: 16384,
      r: 8,
      p: 1,
      salt: Buffer.alloc(16, 1),
      hash: Buffer.alloc(32, 1),
      epoch: 1,
      createdAt: now,
      updatedAt: now,
    });
    const sidHash = "sid-hash-1";
    // Seed the session record directly (bypassing `createSession`'s random sid) so the test
    // controls the exact sidHash used by both the attached client's `auth` and the store lookup.
    (store.sessionsBySidHash as Map<string, unknown>).set(sidHash, {
      userId: 1,
      epoch: 1,
      boundOrigin: "http://192.168.1.5:7879",
      expiresAt: now + 12 * 3_600_000,
      absoluteExpiresAt: now + 7 * 24 * 3_600_000,
    });

    const lanSse = createSseHub({ now: () => now });
    hub = lanSse;
    let attached: SseClient | undefined;
    server = createServer((req, res) => {
      attached = lanSse.attach(req, res, undefined, {
        sidHash,
        userId: 1,
        epoch: 1,
        boundOrigin: "http://192.168.1.5:7879",
        verifiedAt: now,
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const conn = await openSse(port, {});
    await conn.waitFor((e) => e.event === "hello");
    expect(attached).not.toBeUndefined();

    const rt: LanRuntime = {
      lan: { store } as unknown as LanRuntime["lan"],
      routes: undefined as unknown as LanRuntime["routes"],
      lanSse,
      root: "",
      now: () => now,
      version: () => "test",
      log: captureLog(),
      clientInflight: new Map(),
      sidInflight: new Map(),
      absoluteExpiryTimers: new Map(),
      markKdfInvalid: () => {},
    };

    const before = attached!.auth!.verifiedAt;
    now += 55_000;
    await recheckLanSseExpiry(rt);
    expect(attached!.auth!.verifiedAt).toBe(now);
    expect(attached!.auth!.verifiedAt).toBeGreaterThan(before);
    expect(attached!.revoked).not.toBe(true);
    conn.close();
  });
});
