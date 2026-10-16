/** web-hub-version plan §3.9/§3.11 — LAN `GET /api/version` (same width as loopback, D3). */
import { afterEach, describe, expect, it } from "vitest";
import type { VersionInfoOutcome, VersionInfoPort } from "../../../src/web-hub/hub/ports.js";
import { VERSION_INFO_PATH, type VersionInfoWire } from "../../../src/web-hub/protocol/version-info.js";
import { lanPostJson, lanRequest, seedLanUser, startLan, type LanHarness } from "./lan-helpers.js";

const WIRE: VersionInfoWire = { v: 1, checkedAt: 5, hub: { pid: 1, startedAt: 1 } };
const fixed = (o: VersionInfoOutcome): VersionInfoPort & { calls: number } => {
  const p = { calls: 0, snapshot: async () => (p.calls++, o) };
  return p;
};
const hs: LanHarness[] = [];
afterEach(async () => {
  for (const h of hs.splice(0)) await h.cleanup();
});
async function loggedIn(h: LanHarness): Promise<string> {
  seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
  const r = await lanPostJson(h.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
  expect(r.status).toBe(200);
  return (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
}

describe("LAN GET /api/version", () => {
  it("service absent ⇒ 404 whether or not authenticated (unchanged matrix)", async () => {
    const h = await startLan();
    hs.push(h);
    expect((await lanRequest(h.port, { path: VERSION_INFO_PATH, headers: { "X-PWH": "1" } })).status).toBe(404);
    const cookie = await loggedIn(h);
    expect(
      (await lanRequest(h.port, { path: VERSION_INFO_PATH, headers: { Cookie: cookie, "X-PWH": "1" } })).status,
    ).toBe(404);
  });

  it("403 without X-PWH, 401 unauthenticated, 200 verbatim when authenticated", async () => {
    const svc = fixed({ ok: true, data: WIRE });
    const h = await startLan({ version: svc });
    hs.push(h);
    const cookie = await loggedIn(h);
    expect((await lanRequest(h.port, { path: VERSION_INFO_PATH, headers: { Cookie: cookie } })).status).toBe(403);
    expect((await lanRequest(h.port, { path: VERSION_INFO_PATH, headers: { "X-PWH": "1" } })).status).toBe(401);
    expect(svc.calls).toBe(0);
    const r = await lanRequest(h.port, { path: VERSION_INFO_PATH, headers: { Cookie: cookie, "X-PWH": "1" } });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual(WIRE);
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("503 / 504 mapping and 429 under burst", async () => {
    const busy = await startLan({ version: fixed({ ok: false, code: "E_BUSY" }) });
    hs.push(busy);
    const c1 = await loggedIn(busy);
    expect(
      (await lanRequest(busy.port, { path: VERSION_INFO_PATH, headers: { Cookie: c1, "X-PWH": "1" } })).status,
    ).toBe(503);
    const dl = await startLan({ version: fixed({ ok: false, code: "E_DEADLINE" }) });
    hs.push(dl);
    const c2 = await loggedIn(dl);
    expect((await lanRequest(dl.port, { path: VERSION_INFO_PATH, headers: { Cookie: c2, "X-PWH": "1" } })).status).toBe(
      504,
    );
    const burst = await startLan({ version: fixed({ ok: true, data: WIRE }) });
    hs.push(burst);
    const c3 = await loggedIn(burst);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push(
        (await lanRequest(burst.port, { path: VERSION_INFO_PATH, headers: { Cookie: c3, "X-PWH": "1" } })).status,
      );
    }
    expect(codes).toContain(429);
  });
});
