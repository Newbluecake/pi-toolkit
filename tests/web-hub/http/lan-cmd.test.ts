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

  it("no session cookie writes a phase:reject audit line with code E_AUTH (plan §6.4, C3 P1 fix)", async () => {
    const router = fakeRouter(okReply);
    const h = await startLan({ commands: router });
    harnesses.push(h);
    const res = await lanPostJson(h.port, "/api/cmd", abortBody());
    expect(res.status).toBe(401);
    const audits = h.logLines
      .filter((l) => (l.data as Record<string, unknown> | undefined)?.["audit"] === "control")
      .map((l) => l.data as Record<string, unknown>);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ phase: "reject", code: "E_AUTH", endpoint: "cmd", listener: "lan", ok: false });
    expect(audits[0]).not.toHaveProperty("user");
  });

  it("a hung touchSession degrades to 503 E_DB well within the write-endpoint's own 13s budget (plan §3.3 step ②, C3 P1 fix)", async () => {
    const router = fakeRouter(okReply);
    const h = await startLan({ commands: router });
    harnesses.push(h);
    const cookie = await loggedIn(h);
    h.store.touchSession = () => new Promise(() => {}); // never resolves
    const started = Date.now();
    const res = await lanPostJson(h.port, "/api/cmd", abortBody(), { Cookie: cookie });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_DB" });
    expect(elapsed).toBeLessThan(6_000);
    expect(router.calls).toHaveLength(0);
  }, 10_000);

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

describe("POST /api/cmd (LAN) — Blocker #1 fix (plan §3.3/§6.3 step ⑦): agent budget derives from the post-reauth remaining, not the stale pre-reauth snapshot", () => {
  /** Wraps `h.store.touchSession` so the *second* call (the pre-forward "stillAuthorized" recheck
   * — the LAN listener's `authorize()` closure is invoked once early and once again right before
   * the frame is built) simulates spending `ms` of real request budget by advancing the harness's
   * fake clock synchronously before resolving — no real timers/waiting needed since `ReqDeadline`
   * only ever reads `h.clock.now()`. */
  function delaySecondAuth(h: LanHarness, ms: number): void {
    const original = h.store.touchSession.bind(h.store);
    let call = 0;
    h.store.touchSession = async (sidHash, now, opts) => {
      call++;
      if (call === 2) h.clock.advance(ms);
      return original(sidHash, now, opts);
    };
  }

  it("a slow-but-successful second reauth shrinks agentDeadlineMs well below the 8s cap a stale pre-reauth remaining would have produced", async () => {
    const router = fakeRouter(okReply);
    const h = await startLan({ commands: router });
    harnesses.push(h);
    const cookie = await loggedIn(h);
    delaySecondAuth(h, 6_500); // leaves ~6.5s of the 13s WRITE_TOTAL_MS budget
    const res = await lanPostJson(h.port, "/api/cmd", abortBody(), { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(router.calls).toHaveLength(1);
    // deriveBudget(~6500, 8000, 1500) ≈ 5000 — the pre-fix bug would have used the ~13000 remaining
    // captured before the second reauth and always hit the 8000 cap instead.
    expect(router.calls[0]!.deadlineMs).toBeLessThan(6_000);
    expect(router.calls[0]!.deadlineMs).toBeGreaterThan(3_000);
  });

  it("a second reauth that burns past FORWARD_MIN_REMAINING_MS is rejected 504 without ever building/sending a frame", async () => {
    const router = fakeRouter(okReply);
    const h = await startLan({ commands: router });
    harnesses.push(h);
    const cookie = await loggedIn(h);
    delaySecondAuth(h, 10_500); // leaves ~2.5s, below FORWARD_MIN_REMAINING_MS(3000)
    const res = await lanPostJson(h.port, "/api/cmd", abortBody(), { Cookie: cookie });
    expect(res.status).toBe(504);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_DEADLINE" });
    expect(router.calls).toHaveLength(0);
  });

  it("the whole request still completes well inside the 13s WRITE_TOTAL_MS wall-clock budget when the second reauth is merely slow, not hung", async () => {
    const router = fakeRouter(okReply);
    const h = await startLan({ commands: router });
    harnesses.push(h);
    const cookie = await loggedIn(h);
    delaySecondAuth(h, 6_500);
    const started = Date.now();
    const res = await lanPostJson(h.port, "/api/cmd", abortBody(), { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2_000); // fake-clock advance, no real waiting involved
  });
});
