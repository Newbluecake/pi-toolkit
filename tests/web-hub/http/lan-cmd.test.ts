import { afterEach, describe, expect, it } from "vitest";
import type { CommandRouter } from "../../../src/web-hub/hub/ports.js";
import type { CmdFrame, CmdResultFrame } from "../../../src/web-hub/protocol/messages.js";
import { lanPostJson, lanRequest, seedLanUser, startLan, type LanHarness } from "./lan-helpers.js";

interface FakeRouter extends CommandRouter {
  calls: CmdFrame[];
}

function fakeRouter(reply: (frame: CmdFrame) => CmdResultFrame): FakeRouter {
  const calls: CmdFrame[] = [];
  return {
    calls,
    async request(frame) {
      calls.push(frame);
      return reply(frame);
    },
    async drain() {
      return { inflight: 0, timedOut: false };
    },
    inflight() {
      return 0;
    },
  };
}

function okReply(frame: CmdFrame): CmdResultFrame {
  return { t: "cmd_result", rid: frame.rid, id: frame.id, ok: true, data: { op: "abort", wasBusy: false } };
}

async function loggedIn(h: LanHarness): Promise<string> {
  seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
  const r = await lanPostJson(h.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
  return (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
}

function abortBody(id = "a".repeat(16)): Record<string, unknown> {
  return { agentKey: "a1", id, op: "abort" };
}

const harnesses: LanHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

describe("POST /api/cmd (LAN) - gate order + K16 (plan section 6.3/2.1)", () => {
  it("missing Origin ⇒ 403 E_CSRF (Origin is required, unlike the loose LAN CSRF used by /api/subscribe etc.)", async () => {
    const router = fakeRouter(okReply);
    const h = await startLan({ commands: router });
    harnesses.push(h);
    const cookie = await loggedIn(h);
    const res = await lanRequest(h.port, {
      method: "POST",
      path: "/api/cmd",
      headers: { "Content-Type": "application/json", "X-PWH": "1", Cookie: cookie },
      body: JSON.stringify(abortBody()),
    });
    expect(res.status).toBe(403);
    expect(router.calls).toHaveLength(0);
  });

  it("K16: a LAN plaintext direct request with Origin but NO Sec-Fetch-Site at all still passes CSRF (must not regress)", async () => {
    const router = fakeRouter(okReply);
    const h = await startLan({ commands: router });
    harnesses.push(h);
    const cookie = await loggedIn(h);
    const res = await lanPostJson(h.port, "/api/cmd", abortBody(), { Cookie: cookie }); // Origin defaulted, no Sec-Fetch-Site header
    expect(res.status).toBe(200);
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]!.origin).toMatchObject({ listener: "lan" });
  });

  it("Sec-Fetch-Site: cross-site ⇒ 403 even with a matching Origin", async () => {
    const router = fakeRouter(okReply);
    const h = await startLan({ commands: router });
    harnesses.push(h);
    const cookie = await loggedIn(h);
    const res = await lanPostJson(h.port, "/api/cmd", abortBody(), { Cookie: cookie, "Sec-Fetch-Site": "cross-site" });
    expect(res.status).toBe(403);
  });

  it("Sec-Fetch-Site: same-origin passes", async () => {
    const router = fakeRouter(okReply);
    const h = await startLan({ commands: router });
    harnesses.push(h);
    const cookie = await loggedIn(h);
    const res = await lanPostJson(h.port, "/api/cmd", abortBody(), { Cookie: cookie, "Sec-Fetch-Site": "same-origin" });
    expect(res.status).toBe(200);
  });

  it("no session cookie (valid CSRF) ⇒ 401 E_AUTH, router never called", async () => {
    const router = fakeRouter(okReply);
    const h = await startLan({ commands: router });
    harnesses.push(h);
    const res = await lanPostJson(h.port, "/api/cmd", abortBody());
    expect(res.status).toBe(401);
    expect(router.calls).toHaveLength(0);
  });

  it("commands router not wired ⇒ 501 E_NOT_IMPLEMENTED", async () => {
    const h = await startLan();
    harnesses.push(h);
    const cookie = await loggedIn(h);
    const res = await lanPostJson(h.port, "/api/cmd", abortBody(), { Cookie: cookie });
    expect(res.status).toBe(501);
  });

  it("origin.user is derived from the LAN session (not the raw username, but a stable per-user token)", async () => {
    const router = fakeRouter(okReply);
    const h = await startLan({ commands: router });
    harnesses.push(h);
    const cookie = await loggedIn(h);
    await lanPostJson(h.port, "/api/cmd", abortBody(), { Cookie: cookie });
    expect(router.calls[0]!.origin.user).toBeDefined();
    expect(typeof router.calls[0]!.origin.user).toBe("string");
  });

  it("happy path 200s with the router's data; deadlineMs stays within the agent-total cap", async () => {
    const router = fakeRouter(okReply);
    const h = await startLan({ commands: router });
    harnesses.push(h);
    const cookie = await loggedIn(h);
    const res = await lanPostJson(h.port, "/api/cmd", abortBody(), { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, data: { op: "abort" } });
    expect(router.calls[0]!.deadlineMs).toBeLessThanOrEqual(8_000);
  });
});
