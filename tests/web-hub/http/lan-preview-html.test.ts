/**
 * web-hub HTML preview (plan v2 §8 T-H10/T-H12, LAN parity) — a REAL LAN listener (lan-helpers'
 * assembly shape) next to the loopback one, both over one `createHttpFrontend` with
 * `createPreviewRoutes({ html })`: mode matrix, listener/origin binding, the four revocation hooks
 * (logout on both listeners, the REAL `admin.handlePasswd` → facade `revoke({userId})`, LAN
 * rotate `revokeAll`, loopback rotate `revokeAllSse`) and the I1/I3/I4 invariants on the LAN face.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_PATH } from "../../../src/web-hub/protocol/preview.js";
import { PREVIEW_HTML_CAP_PATH, PV_SANDBOX } from "../../../src/web-hub/protocol/preview-html.js";
import { postJson } from "./helpers.js";
import { lanPostJson, lanRequest } from "./lan-helpers.js";
import { AGENT, SESSION, openGet } from "./pv-kit.js";
import { cleanupLans, startLanPv } from "./pv-lan-kit.js";

afterEach(cleanupLans);

const CSP_BASE = `sandbox ${PV_SANDBOX}; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; object-src 'none'`;

describe("T-H10 LAN parity — mode matrix", () => {
  it("mode on: mint, /pv, /pvw answer on LAN; entry CSP pins frame-ancestors to the LAN origin", async () => {
    const l = await startLanPv();
    const cookie = await l.lanCookie(1, "alice");
    const m = await l.mintLan(cookie);
    const cap = l.capOf(m);
    const pv = await l.lanGet(`/pv/${cap}/index.html`);
    expect(pv.status).toBe(200);
    expect(pv.headers["content-security-policy"]).toBe(`${CSP_BASE}; frame-ancestors http://127.0.0.1:${l.lanPort}`);
    expect(pv.headers["x-frame-options"]).toBeUndefined();
    expect(pv.headers["set-cookie"]).toBeUndefined();
    expect((await l.lanGet(`/pv/${cap}/style.css`)).status).toBe(200);
    const w = await l.lanGet(`/pvw/${cap}`);
    expect(w.status).toBe(200);
    expect(w.body).toContain(`sandbox="${PV_SANDBOX}"`);
  });

  it("mode loopback: LAN mint / /pv / /pvw are 404, byte-identical to preview off; loopback still previews", async () => {
    const lb = await startLanPv({ mode: "loopback" });
    const off = await startLanPv({ previewOff: true });
    const cookie = await lb.lanCookie(1, "alice");
    const cookieOff = await off.lanCookie(1, "alice");
    const bad = "A".repeat(43);
    for (const p of [`/pv/${bad}/index.html`, `/pvw/${bad}`]) {
      const a = await lb.lanGet(p);
      const b = await off.lanGet(p);
      expect(a.status).toBe(404);
      expect(a.status).toBe(b.status);
      expect(a.body).toBe(b.body);
    }
    const a = await lb.mintLan(cookie);
    const b = await off.mintLan(cookieOff);
    expect(a.status).toBe(404);
    expect(a.status).toBe(b.status);
    expect(a.body).toBe(b.body);
    // loopback keeps working in `loopback` mode
    const m = await lb.mintLoop();
    expect(m.status).toBe(200);
  });

  it("html surface not attached (html:false): every /pv, /pvw and mint falls through to the original 404 on both listeners", async () => {
    const l = await startLanPv({ html: false });
    const cookie = await l.lanCookie(1, "alice");
    expect((await l.mintLan(cookie)).status).toBe(404);
    expect((await l.mintLoop()).status).toBe(404);
    expect((await l.lanGet(`/pv/${"A".repeat(43)}/x`)).status).toBe(404);
    expect((await l.loopGet(`/pv/${"A".repeat(43)}/x`)).status).toBe(404);
  });

  it("a loopback cap never serves on LAN (and a LAN cap never on loopback)", async () => {
    const l = await startLanPv();
    const cookie = await l.lanCookie(1, "alice");
    const loopCap = l.capOf(await l.mintLoop());
    const lanCap = l.capOf(await l.mintLan(cookie));
    expect((await l.loopGet(`/pv/${loopCap}/index.html`)).status).toBe(200);
    expect((await l.lanGet(`/pv/${loopCap}/index.html`)).status).toBe(404);
    expect((await l.lanGet(`/pv/${lanCap}/index.html`)).status).toBe(200);
    expect((await l.loopGet(`/pv/${lanCap}/index.html`)).status).toBe(404);
  });

  it("origin binding: a cap minted under host A is not served for host B", async () => {
    const l = await startLanPv();
    const cookie = await l.lanCookie(1, "alice");
    const cap = l.capOf(await l.mintLan(cookie));
    const other = await l.lanGet(`/pv/${cap}/index.html`, { Host: `localhost:${l.lanPort}` });
    expect(other.status).not.toBe(200);
    expect((await l.lanGet(`/pv/${cap}/index.html`)).status).toBe(200);
  });

  it("I1 on LAN: serving never calls the session store (spy on touchSession)", async () => {
    const l = await startLanPv();
    const cookie = await l.lanCookie(1, "alice");
    const cap = l.capOf(await l.mintLan(cookie));
    const spy = vi.spyOn(l.lanStore, "touchSession");
    await l.lanGet(`/pv/${cap}/index.html`, { Cookie: cookie });
    await l.lanGet(`/pv/${cap}/style.css`);
    await l.lanGet(`/pvw/${cap}`);
    await l.lanGet(`/pv/${"Z".repeat(43)}/x`);
    expect(spy).not.toHaveBeenCalled();
  });

  it("mint needs a LAN session (401), the exact origin (403 with Origin: null), and X-PWH", async () => {
    const l = await startLanPv();
    const cookie = await l.lanCookie(1, "alice");
    expect((await l.mintLan("pwh_lan=bogus")).status).toBe(401);
    expect((await l.mintLan(cookie, { Origin: "null" })).status).toBe(403);
    expect((await l.mintLan(cookie, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await l.mintLan(cookie)).status).toBe(200);
  });
});

describe("T-H10 LAN revocation hooks", () => {
  it("LAN logout revokes this session's caps only", async () => {
    const l = await startLanPv();
    const a = await l.lanCookie(1, "alice");
    const b = await l.lanCookie(2, "bob");
    const capA = l.capOf(await l.mintLan(a));
    const capB = l.capOf(await l.mintLan(b));
    expect((await lanPostJson(l.lanPort, "/api/logout", {}, { Cookie: a })).status).toBe(200);
    expect((await l.lanGet(`/pv/${capA}/index.html`)).status).toBe(404);
    expect((await l.lanGet(`/pvw/${capA}`)).status).toBe(404);
    expect((await l.lanGet(`/pv/${capB}/index.html`)).status).toBe(200);
  });

  it("REAL admin.handlePasswd → facade.revoke({userId}): that user's caps die, another user's keep serving", async () => {
    const l = await startLanPv();
    const a = await l.lanCookie(1, "alice");
    const b = await l.lanCookie(2, "bob");
    const capA = l.capOf(await l.mintLan(a));
    const capA2 = l.capOf(await l.mintLan(a));
    const capB = l.capOf(await l.mintLan(b));
    expect((await l.lanGet(`/pv/${capA}/index.html`)).status).toBe(200);
    const res = (await l.passwd("alice")) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect((await l.lanGet(`/pv/${capA}/index.html`)).status).toBe(404);
    expect((await l.lanGet(`/pv/${capA2}/style.css`)).status).toBe(404);
    expect((await l.lanGet(`/pv/${capB}/index.html`)).status).toBe(200);
  });

  it("LAN rotate (revokeAll) kills LAN caps only; loopback rotate (revokeAllSse) kills loopback caps only", async () => {
    const l = await startLanPv();
    const a = await l.lanCookie(1, "alice");
    const lanCap = l.capOf(await l.mintLan(a));
    const loopCap = l.capOf(await l.mintLoop());
    (l.fe.lan as unknown as { revokeAll(): number }).revokeAll();
    expect((await l.lanGet(`/pv/${lanCap}/index.html`)).status).toBe(404);
    expect((await l.loopGet(`/pv/${loopCap}/index.html`)).status).toBe(200);
    const lanCap2 = l.capOf(await l.mintLan(a));
    l.fe.revokeAllSse();
    expect((await l.loopGet(`/pv/${loopCap}/index.html`)).status).toBe(404);
    expect((await l.lanGet(`/pv/${lanCap2}/index.html`)).status).toBe(200);
  });

  it("loopback logout revokes loopback caps and leaves LAN caps alone", async () => {
    const l = await startLanPv();
    const a = await l.lanCookie(1, "alice");
    const lanCap = l.capOf(await l.mintLan(a));
    const loopCap = l.capOf(await l.mintLoop());
    expect((await postJson(l.loopPort, "/api/logout", {}, { Cookie: l.loopCookie })).status).toBe(200);
    expect((await l.loopGet(`/pv/${loopCap}/index.html`)).status).toBe(404);
    expect((await l.lanGet(`/pv/${lanCap}/index.html`)).status).toBe(200);
  });
});

describe("T-H12 invariants on the LAN face (I1, I3, I4)", () => {
  it("Origin: null + a valid LAN cookie ⇒ no Access-Control-*; OPTIONS ⇒ 404; text/plain POST ⇒ 403; /pv sets no cookie", async () => {
    const l = await startLanPv();
    const cookie = await l.lanCookie(1, "alice");
    const hdr = { Cookie: cookie, Origin: "null" };
    const prev = `${PREVIEW_PATH}?agentKey=${AGENT}&sessionId=${SESSION}&path=${encodeURIComponent(join(l.site, "index.html"))}`;
    for (const p of [
      `/api/history?agentKey=${AGENT}`,
      "/api/run/history",
      prev,
      "/api/headless",
      "/api/load/top",
      "/api/avatar",
    ]) {
      const r = await l.lanGet(p, hdr);
      expect(
        Object.keys(r.headers).filter((k) => k.startsWith("access-control-")),
        p,
      ).toEqual([]);
    }
    const sse = await openGet(l.lanPort, "/api/events", hdr);
    expect(Object.keys(sse.res.headers).filter((k) => k.startsWith("access-control-"))).toEqual([]);
    sse.destroy();
    for (const p of ["/api/history", "/api/cmd", PREVIEW_HTML_CAP_PATH]) {
      const r = await lanRequest(l.lanPort, { method: "OPTIONS", path: p, headers: hdr });
      expect(r.status, p).toBe(404);
      expect(Object.keys(r.headers).filter((k) => k.startsWith("access-control-"))).toEqual([]);
    }
    const cmd = await lanRequest(l.lanPort, {
      method: "POST",
      path: "/api/cmd",
      headers: { Cookie: cookie, Origin: "null", "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(cmd.status).toBe(403);
    const cap = l.capOf(await l.mintLan(cookie));
    const pv = await l.lanGet(`/pv/${cap}/app.js`, { Origin: "null", Cookie: cookie });
    expect(pv.headers["access-control-allow-origin"]).toBe("null");
    expect(pv.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(pv.headers["set-cookie"]).toBeUndefined();
  });
});
