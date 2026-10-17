/**
 * web-hub-proxy plan v2 §4.2 / §8 (package XA) — the auth revocation bus: pure semantics
 * (synchronous, subscription order, per-subscriber exception isolation) and its wiring through the
 * REAL frontend: every former `revokeHtmlCaps` hook is a 1:1 in-place `emit` (LAN logout emits
 * BEFORE and AFTER the awaited session delete, then SSE), HTML preview is subscribed with no
 * proxy anywhere, and §R2 #6's eventual-revocation semantics across the delete await.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthRevokeBus, type AuthRevokeEvent } from "../../../src/web-hub/hub/auth-revoke.js";
import { hashSid } from "../../../src/web-hub/hub/sid-hash.js";
import { captureLog, login, postJson, rawRequest } from "./helpers.js";
import { lanPostJson, openSse } from "./lan-helpers.js";
import { cleanupLans, startLanPv, type Lan } from "./pv-lan-kit.js";

afterEach(cleanupLans);

const sidOf = (cookie: string): string => cookie.slice(cookie.indexOf("=") + 1);
const ev = (sel: AuthRevokeEvent["sel"], reason: AuthRevokeEvent["reason"]): AuthRevokeEvent => ({ sel, reason });

describe("createAuthRevokeBus (pure)", () => {
  it("emit is synchronous and runs subscribers in subscription order", () => {
    const bus = createAuthRevokeBus(captureLog());
    const order: string[] = [];
    bus.subscribe((e) => order.push(`a:${e.reason}`));
    bus.subscribe((e) => order.push(`b:${e.reason}`));
    bus.emit(ev("all", "close"));
    expect(order).toEqual(["a:close", "b:close"]); // before emit() returned
  });

  it("a throwing subscriber is logged and isolated: the rest still run, emit never throws", () => {
    const log = captureLog();
    const bus = createAuthRevokeBus(log);
    const got: string[] = [];
    bus.subscribe(() => got.push("first"));
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(() => got.push("third"));
    expect(() => bus.emit(ev({ sidTag: "t" }, "logout"))).not.toThrow();
    expect(got).toEqual(["first", "third"]);
    const errs = log.lines.filter((l) => l.level === "error");
    expect(errs).toHaveLength(1);
    expect(JSON.stringify(errs[0])).toContain("boom");
    expect(JSON.stringify(errs[0])).not.toContain('"t"'); // selector payload (a sid tag) is never logged
  });

  it("unsubscribe is idempotent; subscribe/unsubscribe during an emit does not disturb that emit", () => {
    const bus = createAuthRevokeBus(captureLog());
    const got: string[] = [];
    let offB: () => void = () => {};
    bus.subscribe(() => {
      got.push("a");
      offB();
      bus.subscribe(() => got.push("late"));
    });
    offB = bus.subscribe(() => got.push("b"));
    bus.emit(ev("all", "rotate"));
    expect(got).toEqual(["a", "b"]); // snapshot: b still ran, "late" did not join this emit
    offB();
    offB();
    got.length = 0;
    bus.emit(ev("all", "rotate"));
    expect(got).toEqual(["a", "late"]);
  });
});

/** a promise the test resolves by hand */
function gate(): { promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

describe("bus wiring through the real frontend (proxy OFF — nothing but the HTML preview subscribes)", () => {
  it("emits the exact {selector, reason} on all five revoke paths, and HTML caps die on each", async () => {
    const l = await startLanPv();
    const events: AuthRevokeEvent[] = [];
    l.fe.subscribeAuthRevoke((e) => events.push(e));
    const alice = await l.lanCookie(1, "alice");
    const bob = await l.lanCookie(2, "bob");

    // 1. loopback logout
    const loopCap = l.capOf(await l.mintLoop());
    await postJson(l.loopPort, "/api/logout", {}, { Cookie: l.loopCookie });
    expect(events).toEqual([ev({ sidTag: hashSid(sidOf(l.loopCookie)) }, "logout")]);
    expect((await l.loopGet(`/pv/${loopCap}/index.html`)).status).toBe(404);

    // 2. LAN logout (double emit)
    events.length = 0;
    const capA = l.capOf(await l.mintLan(alice));
    await lanPostJson(l.lanPort, "/api/logout", {}, { Cookie: alice });
    const aTag = { sidTag: hashSid(sidOf(alice)) };
    expect(events).toEqual([ev(aTag, "logout"), ev(aTag, "logout")]);
    expect((await l.lanGet(`/pv/${capA}/index.html`)).status).toBe(404);

    // 3. passwd ⇒ facade.revoke({userId})
    events.length = 0;
    const capB = l.capOf(await l.mintLan(bob));
    expect(((await l.passwd("bob")) as { ok: boolean }).ok).toBe(true);
    expect(events).toEqual([ev({ userId: 2 }, "passwd")]);
    expect((await l.lanGet(`/pv/${capB}/index.html`)).status).toBe(404);

    // 4. LAN rotate ⇒ facade.revokeAll
    events.length = 0;
    const carol = await l.lanCookie(3, "carol");
    const capC = l.capOf(await l.mintLan(carol));
    (l.fe.lan as unknown as { revokeAll(): number }).revokeAll();
    expect(events).toEqual([ev({ listener: "lan" }, "rotate")]);
    expect((await l.lanGet(`/pv/${capC}/index.html`)).status).toBe(404);

    // 5. loopback rotate ⇒ revokeAllSse
    events.length = 0;
    const cookie2 = await login(l.loopPort, `${l.dir}/state/token`);
    const cap2 = l.capOf(
      await postJson(
        l.loopPort,
        `/api/preview/html-cap?agentKey=a4242-nonce12&sessionId=sess123`,
        { path: `${l.site}/index.html` },
        { Cookie: cookie2 },
      ),
    );
    expect((await l.loopGet(`/pv/${cap2}/index.html`)).status).toBe(200);
    l.fe.revokeAllSse();
    expect(events).toEqual([ev({ listener: "loopback" }, "rotate")]);
    expect((await l.loopGet(`/pv/${cap2}/index.html`)).status).toBe(404);
  });

  it("LAN logout emit sequence is [before-delete, after-delete], then the SSE revoke", async () => {
    const l = await startLanPv();
    const cookie = await l.lanCookie(1, "alice");
    const sse = await openSse(l.lanPort, cookie);
    await sse.waitFor("hello");
    const timeline: string[] = [];
    l.fe.subscribeAuthRevoke((e) => timeline.push(`emit:${e.reason}`));
    const hold = gate();
    const realDelete = l.lanStore.deleteSession.bind(l.lanStore);
    vi.spyOn(l.lanStore, "deleteSession").mockImplementation(async (h: string) => {
      timeline.push("delete:start");
      await hold.promise;
      await realDelete(h);
      timeline.push("delete:done");
    });
    const out = lanPostJson(l.lanPort, "/api/logout", {}, { Cookie: cookie });
    await vi.waitFor(() => expect(timeline).toContain("delete:start"));
    // the first emit already happened (before the awaited delete); the SSE is NOT revoked yet
    expect(timeline).toEqual(["emit:logout", "delete:start"]);
    await expect(
      Promise.race([sse.waitFor("auth"), new Promise((r) => setTimeout(() => r("quiet"), 150))]),
    ).resolves.toBe("quiet");
    hold.open();
    expect((await out).status).toBe(200);
    expect(timeline).toEqual(["emit:logout", "delete:start", "delete:done", "emit:logout"]);
    expect((await sse.waitFor("auth")).data).toEqual({ reason: "revoked" }); // SSE revoke follows the second emit
    sse.close();
  });

  it("§R2 #6 eventual revocation: a cap minted inside the delete-await window may succeed, but dies at the second emit", async () => {
    const l = await startLanPv();
    const cookie = await l.lanCookie(1, "alice");
    const before = l.capOf(await l.mintLan(cookie));
    const hold = gate();
    const realDelete = l.lanStore.deleteSession.bind(l.lanStore);
    vi.spyOn(l.lanStore, "deleteSession").mockImplementation(async (h: string) => {
      await hold.promise;
      await realDelete(h);
    });
    const out = lanPostJson(l.lanPort, "/api/logout", {}, { Cookie: cookie });
    await vi.waitFor(() => expect(l.lanStore.deleteSession).toHaveBeenCalled());
    // the first emit already killed `before`; the session row still exists ⇒ a mint in the window
    // is NOT guaranteed to fail up front (it may be admitted)…
    expect((await l.lanGet(`/pv/${before}/index.html`)).status).toBe(404);
    const mid = await l.mintLan(cookie);
    expect([200, 401]).toContain(mid.status);
    hold.open();
    expect((await out).status).toBe(200);
    // …but after the second emit nothing minted in the window survives, and a new mint is refused
    if (mid.status === 200) expect((await l.lanGet(`/pv/${l.capOf(mid)}/index.html`)).status).toBe(404);
    expect((await l.mintLan(cookie)).status).toBe(401);
  });

  it("a throwing subscriber never blocks HTML revocation or the logout response (real frontend)", async () => {
    const log = captureLog();
    const l = await startLanPv({ wrapLog: () => log });
    const got: string[] = [];
    l.fe.subscribeAuthRevoke(() => {
      throw new Error("bad-subscriber");
    });
    l.fe.subscribeAuthRevoke((e) => got.push(e.reason));
    const cookie = await l.lanCookie(1, "alice");
    const cap = l.capOf(await l.mintLan(cookie));
    expect((await lanPostJson(l.lanPort, "/api/logout", {}, { Cookie: cookie })).status).toBe(200);
    expect(got).toEqual(["logout", "logout"]); // both emits reached the later subscriber
    expect((await l.lanGet(`/pv/${cap}/index.html`)).status).toBe(404); // preview (subscribed first) revoked
    expect(log.lines.filter((x) => x.level === "error" && JSON.stringify(x).includes("bad-subscriber"))).toHaveLength(
      2,
    );
    // loopback unaffected by the bad subscriber too
    const loopCap = l.capOf(await l.mintLoop());
    await postJson(l.loopPort, "/api/logout", {}, { Cookie: l.loopCookie });
    expect((await l.loopGet(`/pv/${loopCap}/index.html`)).status).toBe(404);
  });

  it("the preview subscription is unconditional — no proxy/multi-candidate option required — and absent preview ⇒ emits are inert", async () => {
    const l = await startLanPv({ previewOff: true });
    const events: AuthRevokeEvent[] = [];
    l.fe.subscribeAuthRevoke((e) => events.push(e));
    const cookie = await l.lanCookie(1, "alice");
    expect((await lanPostJson(l.lanPort, "/api/logout", {}, { Cookie: cookie })).status).toBe(200);
    expect(events).toHaveLength(2); // still emitted, nobody (preview off) to act — and nothing throws
    expect((await rawRequest(l.loopPort, { path: "/healthz" })).status).toBe(200);
  });
});
