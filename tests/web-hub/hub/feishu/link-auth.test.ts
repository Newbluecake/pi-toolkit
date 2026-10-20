import { afterEach, describe, expect, it, vi } from "vitest";
import * as http from "../../../../src/web-hub/hub/http.js";
import { lanPostJson, lanRequest, seedLanUser, startLan } from "../../http/lan-helpers.js";

afterEach(() => vi.restoreAllMocks());
describe("Feishu authenticated LAN Host observation (real HTTP)", () => {
  it("never observes public, unallowed or unauthenticated requests; records admitted cookie-authenticated requests only", async () => {
    const original = http.createHttpFrontend;
    const observed = vi.fn();
    vi.spyOn(http, "createHttpFrontend").mockImplementation((deps) => {
      if (deps.lan) deps.lan.onAuthenticated = observed;
      return original(deps);
    });
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      expect((await lanRequest(h.port, { path: "/healthz" })).status).toBe(200);
      expect((await lanRequest(h.port, { path: "/api/session", host: `evil.example.com:${h.port}` })).status).toBe(421);
      expect((await lanRequest(h.port, { path: "/api/session" })).status).toBe(401);
      expect(observed).not.toHaveBeenCalled();
      const login = await lanPostJson(h.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
      expect(login.status).toBe(200);
      const cookie = login.headers["set-cookie"]![0]!.split(";")[0]!;
      expect((await lanRequest(h.port, { path: "/api/session", headers: { Cookie: cookie } })).status).toBe(200);
      expect(observed).toHaveBeenCalledTimes(1);
      expect(observed).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "lan", hostKey: `127.0.0.1:${h.port}`, viaTrustedProxy: false }),
      );
      expect(
        (
          await lanRequest(h.port, {
            path: "/api/session",
            host: `evil.example.com:${h.port}`,
            headers: { Cookie: cookie },
          })
        ).status,
      ).toBe(421);
      expect(observed).toHaveBeenCalledTimes(1);
    } finally {
      await h.cleanup();
    }
  });
});
