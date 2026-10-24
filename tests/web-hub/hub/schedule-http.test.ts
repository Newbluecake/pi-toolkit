/**
 * scheduled-reports plan r3 §5.6 (H1) — the hub HTTP attachment: `GET /api/schedules` on BOTH
 * listeners (same width), the `schedules` SSE event in the connect burst (after `load`) and as a
 * direct-send on projection changes, and the byte-identical off path (no coordinator ⇒ 404s on
 * both listeners, no SSE frame ever). Also pins the SSE_EVENTS contract insert (before
 * "privacy", spawn stays last, agent_removed keeps its adjacency).
 */
import { mkdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import type { HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { SCHEDULES_PAYLOAD_STUB_FOR_TESTS } from "./schedule/http-stub.js";
import { SCHED_API_PATH } from "../../../src/web-hub/protocol/schedule.js";
import { SSE_EVENTS } from "../../../src/web-hub/protocol/http-contract.js";
import { fakeDeps, login, makeTmp, openSse, rawRequest, type FakeDeps } from "../http/helpers.js";

interface H {
  tmp: ReturnType<typeof makeTmp>;
  deps: FakeDeps;
  fe: HttpFrontend;
  port: number;
  cookie: string;
}
const hs: H[] = [];
afterEach(async () => {
  for (const h of hs.splice(0)) {
    await h.fe.close();
    h.tmp.cleanup();
  }
});

async function start(schedules?: unknown): Promise<H> {
  const tmp = makeTmp();
  const deps = fakeDeps(tmp.dir);
  mkdirSync(deps.paths.stateDir, { recursive: true });
  if (schedules !== undefined) {
    // The on-path needs the config gate too (key absence IS off — same rule hub.ts applies).
    deps.config.schedule = { dir: "/nonexistent-schedule-store", toleranceS: 60 };
    (deps as { schedules?: unknown }).schedules = schedules;
  }
  const fe = createHttpFrontend(deps);
  const port = (await fe.listen()).port;
  const cookie = await login(port, deps.paths.tokenFile);
  const h = { tmp, deps, fe, port, cookie };
  hs.push(h);
  return h;
}

const get = (h: H, headers: Record<string, string>, suffix = "") =>
  rawRequest(h.port, { path: `${SCHED_API_PATH}${suffix}`, headers });
const authed = (h: H) => ({ Cookie: h.cookie, "X-PWH": "1" });

describe("SSE_EVENTS contract insert", () => {
  it("adds schedules before privacy; spawn stays last; agent_removed adjacency holds", () => {
    expect(SSE_EVENTS).toContain("schedules");
    expect(SSE_EVENTS.at(-1)).toBe("spawns");
    const idx = SSE_EVENTS.indexOf("schedules");
    const privacy = SSE_EVENTS.indexOf("privacy");
    expect(idx).toBeGreaterThan(-1);
    expect(privacy).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(privacy);
    expect(SSE_EVENTS[SSE_EVENTS.indexOf("spawns") - 1]).toBe("agent_removed");
    expect(SSE_EVENTS.filter((e) => e === "schedules")).toHaveLength(1);
  });
});

describe("GET /api/schedules (loopback)", () => {
  it("no coordinator ⇒ the off matrix: 401 unauth, 404 authed (byte-identical)", async () => {
    const h = await start();
    expect((await get(h, { "X-PWH": "1" })).status).toBe(401);
    expect((await get(h, authed(h))).status).toBe(404);
    expect((await get(h, { Cookie: h.cookie })).status).toBe(404);
  });

  it("missing X-PWH ⇒ 403; unauth ⇒ 401; ok ⇒ 200 snapshot + no-store", async () => {
    const h = await start(SCHEDULES_PAYLOAD_STUB_FOR_TESTS);
    expect((await get(h, { Cookie: h.cookie })).status).toBe(403);
    expect((await get(h, { "X-PWH": "1" })).status).toBe(401);
    const r = await get(h, authed(h));
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(r.body)).toEqual(SCHEDULES_PAYLOAD_STUB_FOR_TESTS.snapshot());
  });

  it("sessionId filter: matching session only; unknown ⇒ empty; malformed ⇒ 400", async () => {
    const h = await start(SCHEDULES_PAYLOAD_STUB_FOR_TESTS);
    const one = await get(h, authed(h), "?sessionId=sid-a");
    expect(JSON.parse(one.body).sessions).toHaveLength(1);
    const none = await get(h, authed(h), "?sessionId=sid-nope");
    expect(JSON.parse(none.body)).toEqual({ sessions: [] });
    const bad = await get(h, authed(h), "?sessionId=../escape");
    expect(bad.status).toBe(400);
  });
});

describe("schedules SSE", () => {
  it("rides the connect burst after load, and republishes direct-send (no id) on change", async () => {
    const h = await start(SCHEDULES_PAYLOAD_STUB_FOR_TESTS);
    const sse = await openSse(h.port, { cookie: h.cookie });
    const ev = await sse.waitFor((e) => e.event === "schedules");
    expect(ev.id).toBeUndefined();
    expect(ev.data).toEqual(SCHEDULES_PAYLOAD_STUB_FOR_TESTS.snapshot());
    // Order: rides the connect burst (right after `load` when a load service exists — none is
    // wired in this harness, so we pin the weaker invariant: it arrives without any live push).
    expect(sse.events.filter((e) => e.event === "schedules")).toHaveLength(1);

    SCHEDULES_PAYLOAD_STUB_FOR_TESTS.bump();
    // Wait for the SECOND frame by content (rev 2) — waitFor returns the first matching event.
    const again = await sse.waitFor(
      (e) => e.event === "schedules" && (e.data as { sessions: Array<{ rev: number }> }).sessions[0]!.rev === 2,
    );
    expect(again.id).toBeUndefined();
    expect(again.data).toEqual(SCHEDULES_PAYLOAD_STUB_FOR_TESTS.snapshot());
    sse.close();
  });

  it("no coordinator ⇒ no schedules frame in the connect burst", async () => {
    const h = await start();
    const sse = await openSse(h.port, { cookie: h.cookie });
    await sse.waitFor((e) => e.event === "agents");
    expect(sse.events.some((e) => e.event === "schedules")).toBe(false);
    sse.close();
  });
});
