import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuth, LOGIN_WINDOW_MS, readCookie, SESSION_TTL_MS, type Auth } from "../../../src/web-hub/hub/auth.js";
import { captureLog, makeTmp } from "./helpers.js";

let tmp: ReturnType<typeof makeTmp>;
let tokenFile: string;

beforeEach(() => {
  tmp = makeTmp("pwh-auth-");
  tokenFile = join(tmp.dir, "state", "token");
});
afterEach(() => tmp.cleanup());

function cookieOf(r: ReturnType<Auth["login"]>): string {
  if (!r.ok) throw new Error(`login failed: ${r.code}`);
  return `other=1; pwh_sid=${r.sid}`;
}

describe("createAuth", () => {
  it("creates the token once (wx, 0600) with injected randomness and reuses it", () => {
    let n = 0;
    const auth = createAuth({ tokenFile, log: captureLog(), randomBytes: (len) => Buffer.alloc(len, ++n) });
    const t = auth.token();
    expect(t).toBe(Buffer.alloc(32, 1).toString("base64url"));
    expect(auth.token()).toBe(t);
    expect(readFileSync(tokenFile, "utf8").trim()).toBe(t);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    // a second auth instance (hub restart) keeps the same token
    expect(createAuth({ tokenFile, log: captureLog() }).token()).toBe(t);
  });

  it("regenerates a corrupt/empty token file (0600) and warns", () => {
    mkdirSync(join(tmp.dir, "state"), { recursive: true });
    writeFileSync(tokenFile, "short\n");
    chmodSync(tokenFile, 0o666);
    const log = captureLog();
    const t = createAuth({ tokenFile, log }).token();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(log.lines.filter((l) => l.level === "warn").length).toBeGreaterThanOrEqual(1);
  });

  it("login ⇒ sid; check slides a 12 h expiry; logout revokes", () => {
    const auth = createAuth({ tokenFile, log: captureLog() });
    const cookie = cookieOf(auth.login(auth.token(), 0));
    expect(auth.check(cookie, SESSION_TTL_MS - 1)).toBe(true); // slides to 2×TTL-1
    expect(auth.check(cookie, 2 * SESSION_TTL_MS - 2)).toBe(true);
    expect(auth.check(cookie, 4 * SESSION_TTL_MS)).toBe(false); // idle > 12 h
    const c2 = cookieOf(auth.login(auth.token(), 0));
    auth.logout(readCookie(c2, "pwh_sid")!);
    expect(auth.check(c2, 1)).toBe(false);
    expect(auth.check(undefined, 1)).toBe(false);
    expect(auth.check("pwh_sid=", 1)).toBe(false);
  });

  it("rate limit: 5 failures per rolling 60 s; recovers after the window", () => {
    const auth = createAuth({ tokenFile, log: captureLog() });
    for (let i = 0; i < 5; i++) expect(auth.login("bad", 1_000 + i)).toEqual({ ok: false, code: "E_AUTH" });
    expect(auth.login(auth.token(), 2_000)).toEqual({ ok: false, code: "E_RATE" });
    expect(auth.login(auth.token(), 1_000 + LOGIN_WINDOW_MS)).toMatchObject({ ok: true });
  });

  it("non-string / empty / oversized candidates fail", () => {
    const auth = createAuth({ tokenFile, log: captureLog() });
    auth.token();
    for (const c of [undefined, null, 42, {}, "", "x".repeat(5000)]) expect(auth.login(c, 0).ok).toBe(false);
  });

  it("readCookie parses among several cookies", () => {
    expect(readCookie("a=1; pwh_sid=abc; b=2", "pwh_sid")).toBe("abc");
    expect(readCookie("xpwh_sid=abc", "pwh_sid")).toBeUndefined();
    expect(readCookie(undefined, "pwh_sid")).toBeUndefined();
  });
});
