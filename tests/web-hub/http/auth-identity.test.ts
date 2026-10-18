/**
 * web-hub-proxy plan v2 §4.1 / §8 (package XA) — the single identity resolution: pure resolver
 * semantics, the proxy-off first-value byte-identity, the opt-in multi-candidate path
 * (conflict/overflow + best-effort clearing Set-Cookies), and that HTML-cap `sidTag` is the
 * identity that actually authenticated (shadow `pwh_sid=junk; Path=/api/preview` case).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLEAR_COOKIE_MAX_PREFIXES,
  lanIdentity,
  clearingSetCookies,
  cookieCandidates,
  pathPrefixes,
  readCookie,
  resolveCookieIdentity,
  resolveCookieIdentitySync,
} from "../../../src/web-hub/hub/auth-identity.js";
import { createAuth, SESSION_TTL_MS } from "../../../src/web-hub/hub/auth.js";
import { checkLanSession } from "../../../src/web-hub/hub/lan-auth.js";
import { hashSid } from "../../../src/web-hub/hub/sid-hash.js";
import { PREVIEW_HTML_CAP_PATH } from "../../../src/web-hub/protocol/preview-html.js";
import { captureLog, login, postJson, rawRequest } from "./helpers.js";
import { lanPostJson, lanRequest } from "./lan-helpers.js";
import { AGENT, SESSION } from "./pv-kit.js";
import { cleanupLans, startLanPv, type Lan } from "./pv-lan-kit.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

afterEach(cleanupLans);

const Q = `agentKey=${AGENT}&sessionId=${SESSION}`;
const sidOf = (cookie: string): string => cookie.slice(cookie.indexOf("=") + 1);

describe("cookieCandidates / resolvers (pure)", () => {
  it("max 1 is exactly readCookie: first pair wins, an empty first value is 'no cookie'", () => {
    expect(cookieCandidates("pwh_sid=a; pwh_sid=b", "pwh_sid", 1)).toEqual({ values: ["a"], overflow: false });
    expect(cookieCandidates("pwh_sid=; pwh_sid=b", "pwh_sid", 1)).toEqual({ values: [], overflow: false });
    expect(cookieCandidates(undefined, "pwh_sid", 1)).toEqual({ values: [], overflow: false });
    expect(readCookie("pwh_sid=; pwh_sid=b", "pwh_sid")).toBeUndefined();
    expect(readCookie("xpwh_sid=a; pwh_sid=b", "pwh_sid")).toBe("b");
  });

  it("max>1: distinct non-empty values in header order, exact duplicates collapse, overflow is flagged", () => {
    expect(cookieCandidates("pwh_sid=; pwh_sid=a; x=1; pwh_sid=b; pwh_sid=a", "pwh_sid", 8)).toEqual({
      values: ["a", "b"],
      overflow: false,
    });
    const r = cookieCandidates("pwh_sid=1; pwh_sid=2; pwh_sid=3; pwh_sid=4", "pwh_sid", 3);
    expect(r.overflow).toBe(true);
    expect(r.values).toEqual(["1", "2", "3"]);
  });

  it("async resolver: one valid among junk ⇒ one; two valid ⇒ conflict (stops validating); overflow ⇒ conflict with zero validation", async () => {
    const valid = new Set(["good", "good2"]);
    const seen: string[] = [];
    const validate = async (v: string): Promise<string | undefined> => {
      seen.push(v);
      return valid.has(v) ? `rec:${v}` : undefined;
    };
    const one = await resolveCookieIdentity("c=junk; c=good; c=junk2", "c", 3, validate);
    expect(one).toEqual({ kind: "one", value: "good", rec: "rec:good" });
    expect(seen).toEqual(["junk", "good", "junk2"]);
    seen.length = 0;
    const conflict = await resolveCookieIdentity("c=good; c=good2; c=junk", "c", 3, validate);
    expect(conflict).toEqual({ kind: "conflict", why: "multiple" });
    expect(seen).toEqual(["good", "good2"]); // third never validated (no more IPC once decided)
    seen.length = 0;
    const over = await resolveCookieIdentity("c=1; c=2; c=3; c=4", "c", 3, validate);
    expect(over).toEqual({ kind: "conflict", why: "overflow" });
    expect(seen).toEqual([]);
    expect(await resolveCookieIdentity("c=junk", "c", 3, validate)).toEqual({ kind: "none", candidates: 1 });
    expect(await resolveCookieIdentity(undefined, "c", 3, validate)).toEqual({ kind: "none", candidates: 0 });
  });

  it("a throwing validator aborts the whole resolution (fail closed), sync and async", async () => {
    await expect(
      resolveCookieIdentity("c=a; c=b", "c", 3, () => {
        throw new Error("db");
      }),
    ).rejects.toThrow("db");
    expect(() =>
      resolveCookieIdentitySync("c=a", "c", 1, () => {
        throw new Error("db");
      }),
    ).toThrow("db");
  });
});

describe("clearingSetCookies (best-effort)", () => {
  it("path-prefix lines × {host-only, Domain=<host>}; Secure only when asked", () => {
    expect(pathPrefixes("/api/preview/html-cap?x=1")).toEqual(["/", "/api", "/api/preview", "/api/preview/html-cap"]);
    const lines = clearingSetCookies("pwh_sid", "/api/preview/html-cap", "127.0.0.1:7878", { secure: false });
    expect(lines).toEqual([
      "pwh_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      "pwh_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Domain=127.0.0.1",
      "pwh_sid=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0",
      "pwh_sid=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0; Domain=127.0.0.1",
      "pwh_sid=; HttpOnly; SameSite=Strict; Path=/api/preview; Max-Age=0",
      "pwh_sid=; HttpOnly; SameSite=Strict; Path=/api/preview; Max-Age=0; Domain=127.0.0.1",
      "pwh_sid=; HttpOnly; SameSite=Strict; Path=/api/preview/html-cap; Max-Age=0",
      "pwh_sid=; HttpOnly; SameSite=Strict; Path=/api/preview/html-cap; Max-Age=0; Domain=127.0.0.1",
    ]);
    const secure = clearingSetCookies("pwh_lan", "/api/x", "nas.local:7879", { secure: true });
    expect(secure.every((l) => l.includes("; Secure"))).toBe(true);
    expect(secure).toContain("pwh_lan=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0; Secure; Domain=nas.local");
  });

  it("bounded: ≤ 8 prefixes ⇒ ≤ 16 lines for any path; IPv6 / junk hosts get no Domain line", () => {
    const deep = `/${Array.from({ length: 30 }, (_, i) => `s${i}`).join("/")}`;
    expect(pathPrefixes(deep)).toHaveLength(CLEAR_COOKIE_MAX_PREFIXES);
    expect(clearingSetCookies("pwh_sid", deep, "h:1", { secure: false })).toHaveLength(16);
    const v6 = clearingSetCookies("pwh_sid", "/api", "[::1]:7878", { secure: false });
    expect(v6.some((l) => l.includes("Domain="))).toBe(false);
    expect(
      clearingSetCookies("pwh_sid", "/api", "bad host", { secure: false }).some((l) => l.includes("Domain=")),
    ).toBe(false);
  });
});

describe("auth.resolve (loopback sessions)", () => {
  it("slides only the chosen session; conflict slides nothing; check === resolve().ok", () => {
    const dir = mkdtempSync(join(tmpdir(), "pwh-ai-"));
    try {
      const auth = createAuth({ tokenFile: join(dir, "token"), log: captureLog() });
      const a = auth.login(auth.token(), 0);
      const b = auth.login(auth.token(), 0);
      if (!a.ok || !b.ok) throw new Error("login");
      const h = `pwh_sid=${a.sid}; pwh_sid=${b.sid}`;
      // legacy max 1 = first value
      expect(auth.resolve(h, 10)).toEqual({
        ok: true,
        sid: a.sid,
        sidTag: hashSid(a.sid),
        expiresAt: 10 + SESSION_TTL_MS,
      });
      // multi: two valid ⇒ conflict, nothing slides (b still expires at TTL, not 20+TTL)
      expect(auth.resolve(h, 20, { maxCandidates: 8 })).toEqual({ ok: false, conflict: true });
      expect(auth.check(`pwh_sid=${b.sid}`, SESSION_TTL_MS + 5)).toBe(false); // b was never slid
      expect(auth.check(`pwh_sid=${a.sid}`, SESSION_TTL_MS + 5)).toBe(true);
      expect(auth.resolve(`pwh_sid=junk; pwh_sid=${a.sid}`, SESSION_TTL_MS + 6, { maxCandidates: 8 })).toMatchObject({
        ok: true,
        sid: a.sid,
      });
      expect(auth.resolve(`pwh_sid=junk; pwh_sid=${a.sid}`, SESSION_TTL_MS + 7)).toEqual({ ok: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkLanSession through the resolver", () => {
  const rec = (n: number) => ({
    userId: n,
    epoch: 1,
    expiresAt: 1_000,
    absoluteExpiresAt: 2_000,
    boundOrigin: "http://h:1",
  });
  it("first-value by default (1 IPC); with maxCandidates the one valid among junk is accepted (≤3 IPC); conflict ⇒ undefined", async () => {
    const good = hashSid("good");
    const good2 = hashSid("good2");
    const touch = vi.fn(async (h: string) => (h === good ? rec(1) : h === good2 ? rec(2) : undefined));
    const store = { touchSession: touch } as never;
    const ctx = { externalOrigin: "http://h:1" } as never;
    expect(await checkLanSession("pwh_lan=junk; pwh_lan=good", ctx, store, 10)).toBeUndefined();
    expect(touch).toHaveBeenCalledTimes(1);
    touch.mockClear();
    const ok = await checkLanSession("pwh_lan=j1; pwh_lan=good; pwh_lan=j2", ctx, store, 10, { maxCandidates: 3 });
    expect(ok).toMatchObject({ userId: 1, sidHash: good, absoluteExpiresAt: 2_000 });
    expect(touch.mock.calls.length).toBeLessThanOrEqual(3);
    expect(await checkLanSession("pwh_lan=good; pwh_lan=good2", ctx, store, 10, { maxCandidates: 3 })).toBeUndefined();
    // expired / wrong-origin candidates are invalid candidates, not conflicts
    expect(await checkLanSession("pwh_lan=good", ctx, store, 1_000)).toBeUndefined();
    expect(
      await checkLanSession("pwh_lan=good", { externalOrigin: "http://evil" } as never, store, 10),
    ).toBeUndefined();
  });
});

describe("source scan — nothing outside auth-identity.ts parses cookies or calls auth.check", () => {
  const root = fileURLToPath(new URL("../../../src/web-hub/hub", import.meta.url));
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(root);
  const code = (p: string): string =>
    readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");

  it("readCookie( / readLanCookie / cookie-header split live only in auth-identity.ts", () => {
    for (const f of files) {
      const rel = relative(root, f);
      if (rel === "auth-identity.ts") continue;
      const src = code(f);
      expect(src, rel).not.toMatch(/\breadCookie\(/);
      expect(src, rel).not.toMatch(/\breadLanCookie\b/);
      expect(src, rel).not.toMatch(/headers\.cookie\s*\.\s*split|cookie\w*\.split\(";"\)/);
    }
  });

  it("http.ts has no executing auth.check call (every site goes through the identity resolution)", () => {
    const src = code(join(root, "http.ts"));
    expect(src).not.toMatch(/auth\.check\(/);
    expect((src.match(/authorizeLoopback\(req, res\)/g) ?? []).length).toBeGreaterThanOrEqual(16);
    expect(src).not.toMatch(/requireLanSession[^;]*\.sidHash[^;]*hashSid/);
  });
});

describe("HTTP behaviour — proxy-off (default) is first-value and byte-identical", () => {
  it("loopback: valid-first ⇒ authenticated; junk-first ⇒ plain 401 {error:E_AUTH} with NO Set-Cookie and no reason", async () => {
    const l = await startLanPv();
    const ok = await rawRequest(l.loopPort, {
      path: `/api/history?agent=${AGENT}&before=9`,
      headers: { Cookie: l.loopCookie },
    });
    expect(ok.status).toBe(200);
    const validFirst = await rawRequest(l.loopPort, {
      path: `/api/history?agent=${AGENT}&before=9`,
      headers: { Cookie: `${l.loopCookie}; pwh_sid=junk` },
    });
    expect(validFirst.status).toBe(200);
    expect(validFirst.body).toBe(ok.body);
    const junkFirst = await rawRequest(l.loopPort, {
      path: `/api/history?agent=${AGENT}&before=9`,
      headers: { Cookie: `pwh_sid=junk; ${l.loopCookie}` },
    });
    const none = await rawRequest(l.loopPort, { path: `/api/history?agent=${AGENT}&before=9` });
    expect(junkFirst.status).toBe(401);
    expect(junkFirst.body).toBe('{"error":"E_AUTH"}');
    expect(junkFirst.body).toBe(none.body);
    expect(junkFirst.headers["set-cookie"]).toBeUndefined();
    // two DIFFERENT valid sids with proxy off: first wins, no conflict handling
    const second = await login(l.loopPort, join(l.dir, "state", "token"));
    const two = await rawRequest(l.loopPort, {
      path: `/api/history?agent=${AGENT}&before=9`,
      headers: { Cookie: `${l.loopCookie}; ${second}` },
    });
    expect(two.status).toBe(200);
  });

  it("LAN: junk-first ⇒ 401 after exactly ONE touchSession; valid-first ⇒ ok; no reason / Set-Cookie", async () => {
    const l = await startLanPv();
    const cookie = await l.lanCookie(1, "alice");
    const touch = vi.spyOn(l.lanStore, "touchSession");
    const bad = await lanRequest(l.lanPort, { path: "/api/session", headers: { Cookie: `pwh_lan=junk; ${cookie}` } });
    expect(bad.status).toBe(401);
    expect(bad.body).toBe('{"error":"E_AUTH"}');
    expect(bad.headers["set-cookie"]).toBeUndefined();
    expect(touch).toHaveBeenCalledTimes(1);
    touch.mockClear();
    const good = await lanRequest(l.lanPort, { path: "/api/session", headers: { Cookie: `${cookie}; pwh_lan=junk` } });
    expect(good.status).toBe(200);
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it("proxy-off logout acts on the first cookie value only (loopback)", async () => {
    const l = await startLanPv();
    const second = await login(l.loopPort, join(l.dir, "state", "token"));
    const out = await postJson(l.loopPort, "/api/logout", {}, { Cookie: `${l.loopCookie}; ${second}` });
    expect(out.status).toBe(200);
    expect(
      (
        await rawRequest(l.loopPort, {
          path: `/api/history?agent=${AGENT}&before=9`,
          headers: { Cookie: l.loopCookie },
        })
      ).status,
    ).toBe(401);
    expect(
      (await rawRequest(l.loopPort, { path: `/api/history?agent=${AGENT}&before=9`, headers: { Cookie: second } }))
        .status,
    ).toBe(200);
  });
});

describe("HTTP behaviour — multi-candidate option ON", () => {
  async function two(l: Lan): Promise<{ a: string; b: string }> {
    return { a: l.loopCookie, b: await login(l.loopPort, join(l.dir, "state", "token")) };
  }
  const probe = (l: Lan, cookie: string, path = `/api/history?agent=${AGENT}&before=9`) =>
    rawRequest(l.loopPort, { path, headers: { Cookie: cookie } });

  it("loopback: one valid among junk is accepted in either order (invalid candidates ignored)", async () => {
    const l = await startLanPv({ multiCandidateAuth: true });
    expect((await probe(l, `pwh_sid=junk; ${l.loopCookie}`)).status).toBe(200);
    expect((await probe(l, `${l.loopCookie}; pwh_sid=junk; pwh_sid=junk2`)).status).toBe(200);
    expect((await probe(l, "pwh_sid=junk; pwh_sid=junk2")).status).toBe(401);
    expect((await probe(l, "pwh_sid=junk; pwh_sid=junk2")).headers["set-cookie"]).toBeUndefined();
  });

  it("HTML-cap sidTag is the authenticating identity when a junk shadow (`pwh_sid=junk; Path=/api/preview`) comes first", async () => {
    const l = await startLanPv({ multiCandidateAuth: true });
    const events: string[] = [];
    l.fe.subscribeAuthRevoke((ev) => events.push(JSON.stringify(ev)));
    const body = { path: join(l.site, "index.html") };
    const mint = (cookie: string) => postJson(l.loopPort, `${PREVIEW_HTML_CAP_PATH}?${Q}`, body, { Cookie: cookie });
    // browsers send the longer-Path cookie first: the junk shadow precedes the real session
    const capShadow = l.capOf(await mint(`pwh_sid=junk; ${l.loopCookie}`));
    expect((await l.loopGet(`/pv/${capShadow}/index.html`)).status).toBe(200);
    // logout carrying ONLY the valid cookie revokes by hashSid(valid) ⇒ the cap minted under the
    // shadowed header was bound to that very sid, not to the junk value
    await postJson(l.loopPort, "/api/logout", {}, { Cookie: l.loopCookie });
    expect(events).toContain(JSON.stringify({ sel: { sidTag: hashSid(sidOf(l.loopCookie)) }, reason: "logout" }));
    expect((await l.loopGet(`/pv/${capShadow}/index.html`)).status).toBe(404);
  });

  it("LAN: HTML-cap sidTag follows the authenticating pwh_lan, not the shadow (junk first)", async () => {
    const l = await startLanPv({ multiCandidateAuth: true });
    const cookie = await l.lanCookie(1, "alice");
    const cap = l.capOf(await l.mintLan(`pwh_lan=junk; ${cookie}`));
    expect((await l.lanGet(`/pv/${cap}/index.html`)).status).toBe(200);
    await lanPostJson(l.lanPort, "/api/logout", {}, { Cookie: cookie });
    expect((await l.lanGet(`/pv/${cap}/index.html`)).status).toBe(404);
  });

  it("loopback conflict: two valid sids ⇒ 401 cookie-conflict + the exact clearing Set-Cookie set; stays a conflict (best-effort only)", async () => {
    const l = await startLanPv({ multiCandidateAuth: true });
    const { a, b } = await two(l);
    const r = await probe(l, `${a}; ${b}`, `/api/history?agent=${AGENT}&before=9`);
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)).toEqual({ error: "E_AUTH", reason: "cookie-conflict" });
    expect(r.headers["set-cookie"]).toEqual(
      clearingSetCookies("pwh_sid", `/api/history?agent=${AGENT}&before=9`, `127.0.0.1:${l.loopPort}`, {
        secure: false,
      }),
    );
    expect(r.headers["set-cookie"]).toHaveLength(6); // "/", "/api", "/api/history" × {host-only, Domain}
    // a shadow with a NON-segment Path (/ap) or a parent Domain is not named by any cleared line ⇒
    // the next request still carries it ⇒ still a conflict (manual recovery copy applies)
    const lines = r.headers["set-cookie"] as string[];
    expect(lines.some((x) => x.includes("Path=/ap;"))).toBe(false);
    expect((await probe(l, `${a}; ${b}`)).status).toBe(401);
    // the segment-path shadow IS removable: after the browser applies the clearing line only the real one remains
    expect((await probe(l, a)).status).toBe(200);
  });

  it("loopback overflow: 9 distinct candidates (> 8) ⇒ conflict even when one is valid", async () => {
    const l = await startLanPv({ multiCandidateAuth: true });
    const junk = Array.from({ length: 8 }, (_, i) => `pwh_sid=j${i}`).join("; ");
    const r = await probe(l, `${l.loopCookie}; ${junk}`);
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body).reason).toBe("cookie-conflict");
    expect((await probe(l, `${l.loopCookie}; ${junk.split("; ").slice(0, 7).join("; ")}`)).status).toBe(200); // exactly 8 ok
  });

  it("an attacker-valid sid planted next to the victim's is a conflict, never a swap (loopback and LAN)", async () => {
    const l = await startLanPv({ multiCandidateAuth: true });
    const attacker = await login(l.loopPort, join(l.dir, "state", "token"));
    expect((await probe(l, `${attacker}; ${l.loopCookie}`)).status).toBe(401);
    expect((await probe(l, `${l.loopCookie}; ${attacker}`)).status).toBe(401);
    const victim = await l.lanCookie(1, "alice");
    const evil = await l.lanCookie(2, "mallory");
    const lan = await lanRequest(l.lanPort, { path: "/api/session", headers: { Cookie: `${evil}; ${victim}` } });
    expect(lan.status).toBe(401);
    expect(JSON.parse(lan.body).reason).toBe("cookie-conflict");
  });

  it("LAN: one valid + two junk ⇒ accepted with ≤ 3 touchSession calls; 4 distinct ⇒ conflict with ZERO IPC; two valid ⇒ conflict", async () => {
    const l = await startLanPv({ multiCandidateAuth: true });
    const cookie = await l.lanCookie(1, "alice");
    const other = await l.lanCookie(2, "bob");
    const touch = vi.spyOn(l.lanStore, "touchSession");
    const ok = await lanRequest(l.lanPort, {
      path: "/api/session",
      headers: { Cookie: `pwh_lan=j1; ${cookie}; pwh_lan=j2` },
    });
    expect(ok.status).toBe(200);
    expect(touch.mock.calls.length).toBeLessThanOrEqual(3);
    touch.mockClear();
    const over = await lanRequest(l.lanPort, {
      path: "/api/session",
      headers: { Cookie: `${cookie}; pwh_lan=j1; pwh_lan=j2; pwh_lan=j3` },
    });
    expect(over.status).toBe(401);
    expect(JSON.parse(over.body)).toEqual({ error: "E_AUTH", reason: "cookie-conflict" });
    expect(touch).not.toHaveBeenCalled();
    expect(over.headers["set-cookie"]).toEqual(
      clearingSetCookies("pwh_lan", "/api/session", `127.0.0.1:${l.lanPort}`, { secure: false }),
    );
    const both = await lanRequest(l.lanPort, { path: "/api/session", headers: { Cookie: `${cookie}; ${other}` } });
    expect(both.status).toBe(401);
    expect(JSON.parse(both.body).reason).toBe("cookie-conflict");
  });

  it("logout is never refused by a conflict: every distinct candidate is logged out (loopback + LAN)", async () => {
    const l = await startLanPv({ multiCandidateAuth: true });
    const { a, b } = await two(l);
    expect((await postJson(l.loopPort, "/api/logout", {}, { Cookie: `${a}; ${b}` })).status).toBe(200);
    expect((await probe(l, a)).status).toBe(401);
    expect((await probe(l, b)).status).toBe(401);
    const c1 = await l.lanCookie(1, "alice");
    const c2 = await l.lanCookie(2, "bob");
    expect((await lanPostJson(l.lanPort, "/api/logout", {}, { Cookie: `${c1}; ${c2}` })).status).toBe(200);
    expect((await lanRequest(l.lanPort, { path: "/api/session", headers: { Cookie: c1 } })).status).toBe(401);
    expect((await lanRequest(l.lanPort, { path: "/api/session", headers: { Cookie: c2 } })).status).toBe(401);
  });
});

it("R2-j LAN user-id principals cannot collide with bot principals, regardless of username", () => {
  for (const username of ["admin", "alice", "feishu:1:ou_x", "feishu%3A1%3Aou_x"]) {
    const user = { username, id: 1 };
    const id = lanIdentity(
      { userId: user.id, epoch: 1, sidHash: "hash", absoluteExpiresAt: 100 },
      { expiresAt: 90, absoluteExpiresAt: 100 },
    );
    expect(id.principal).toBe("u1");
    expect(`lan:${id.principal}`).not.toBe("lan:feishu:1:ou_x");
  }
});
