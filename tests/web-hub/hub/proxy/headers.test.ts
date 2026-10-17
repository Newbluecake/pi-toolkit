import { describe, expect, it } from "vitest";
import { parseProxyTarget } from "../../../../src/web-hub/hub/proxy/target.js";
import {
  filterProxySetCookie,
  filterRequestHeaders,
  filterResponseHeaders,
  rewriteProxyLocation,
  stripProxyCookies,
} from "../../../../src/web-hub/hub/proxy/headers.js";

const ctx = {
  origin: "http://hub.local:7901",
  target: { hostHeader: "nas.local:3000", port: 3000 },
  pinnedIp: "192.168.1.2",
  cls: "private" as const,
  peer: "192.168.1.3",
  browserHost: "hub.local:7901",
};

describe("T-F3 request headers", () => {
  it("drops hop-by-hop/Connection tokens, all incoming forwarded/proxy credentials; forced fields cannot be suppressed", () => {
    const out = filterRequestHeaders(
      {
        Connection: "keep-alive, X-Remove, Host, X-Forwarded-For",
        "X-Remove": "secret",
        "Keep-Alive": "timeout=60",
        TE: "trailers",
        Trailer: "x",
        "Transfer-Encoding": "chunked",
        Upgrade: "h2c",
        "Proxy-Authorization": "secret",
        "Proxy-Foo": "secret",
        "Proxy-Authenticate": "secret",
        "X-PWH": "1",
        Forwarded: "for=evil",
        "X-Forwarded-For": "evil",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "evil",
        "X-Forwarded-Special": "evil",
        "X-Real-IP": "evil",
        Host: "evil",
        Accept: "text/html",
        "Content-Type": "application/json",
        "Content-Length": 12,
        "X-Custom": ["a", "b"],
        "X-Undefined": undefined,
      },
      ctx,
    );
    expect({ ...out }).toEqual({
      accept: "text/html",
      "content-type": "application/json",
      "content-length": 12,
      "x-custom": ["a", "b"],
      host: "nas.local:3000",
      "x-forwarded-for": "192.168.1.3",
      "x-forwarded-proto": "http",
      "x-forwarded-host": "hub.local:7901",
    });
  });
  it("strips EVERY pwh_* cookie, handles whitespace/duplicates/arrays, keeps app credentials", () => {
    const value = "a=1; pwh_sid=x; pwh_lan=y; pwh_px_7901=z; b=2";
    expect(stripProxyCookies(value)).toBe("a=1; b=2");
    expect(
      filterRequestHeaders({ Cookie: [value, "pwh_legacy=q; pwh_sid=w; app=a=b; PWH_other=case-sensitive"] }, ctx)
        .cookie,
    ).toBe("a=1; b=2; app=a=b");
    expect(filterRequestHeaders({ Cookie: "pwh_sid=x; pwh_lan=y; pwh_=z; bad" }, ctx).cookie).toBeUndefined();
  });
  it("rewrites only the exact own Origin and Referer prefix; foreign/null/near-prefix stay unchanged", () => {
    const out = filterRequestHeaders({ Origin: ctx.origin, Referer: `${ctx.origin}/a?x=1` }, ctx);
    expect(out.origin).toBe("http://nas.local:3000");
    expect(out.referer).toBe("http://nas.local:3000/a?x=1");
    expect(filterRequestHeaders({ Referer: ctx.origin }, ctx).referer).toBe("http://nas.local:3000");
    for (const value of ["null", "http://other:7901", `${ctx.origin}.evil/a`, "https://hub.local:7901/a"]) {
      const foreign = filterRequestHeaders({ Origin: value, Referer: value }, ctx);
      expect(foreign.origin).toBe(value);
      expect(foreign.referer).toBe(value);
    }
  });
  it.each(["pwh_sid", "PWH_LAN", "PwH_px_7900", "pWh_other", "PWH_"])(
    "strips reserved cookie %s case-insensitively in both directions",
    (name) => {
      expect(stripProxyCookies(`app=1; ${name}=secret; xpwh_keep=2`)).toBe("app=1; xpwh_keep=2");
      for (const ws of [false, true]) {
        expect(filterRequestHeaders({ Cookie: `${name}=secret; app=1` }, { ...ctx, ws }).cookie).toBe("app=1");
        expect(
          filterResponseHeaders({ "Set-Cookie": [`${name}=secret; Domain=x`, "App=x; Domain=x"] }, { ...ctx, ws })[
            "set-cookie"
          ],
        ).toEqual(["App=x"]);
      }
      expect(filterProxySetCookie(`${name}=secret`)).toBeUndefined();
    },
  );
  it("uses the canonical literal Host spelling upstream", () => {
    const parsed = parseProxyTarget("[::ffff:7f00:1]:80");
    if (!parsed.ok) throw new Error("parse failed");
    expect(filterRequestHeaders({ Host: "browser.local:7901" }, { ...ctx, target: parsed.target }).host).toBe(
      "127.0.0.1",
    );
  });
  it("WS preserves handshake headers but replaces Upgrade/Connection, not arbitrary hop tokens", () => {
    expect(
      filterRequestHeaders(
        {
          Connection: "upgrade, x-hop",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": "abc",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Protocol": "proto",
          "X-Hop": "drop",
        },
        { ...ctx, ws: true },
      ),
    ).toMatchObject({
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "abc",
      "sec-websocket-version": "13",
      "sec-websocket-protocol": "proto",
    });
    expect(
      filterRequestHeaders({ Connection: "x-hop", "X-Hop": "drop" }, { ...ctx, ws: true })["x-hop"],
    ).toBeUndefined();
  });
});

describe("T-F3 response headers (same filter for normal, 101 and non-101 WS)", () => {
  it.each(["http", "ws-101", "ws-non101"])(
    "%s strips Clear-Site-Data and hub cookies, Domain only, never merges Set-Cookie",
    (mode) => {
      const out = filterResponseHeaders(
        {
          Connection: ["keep-alive", "X-Hop"],
          "X-Hop": "secret",
          "Keep-Alive": "timeout=2",
          "Transfer-Encoding": "chunked",
          "Clear-Site-Data": '"cookies","storage"',
          "Proxy-Connection": "keep-alive",
          "Set-Cookie": [
            "pwh_sid=secret; Domain=hub.local; Path=/",
            "pwh_lan=secret",
            "pwh_px_7901=secret",
            "pwh_old=secret",
            "app=a=b; dOmAiN = .nas.local; HttpOnly; Path=/a; SameSite=Lax",
            "other=z; Expires=Wed, 21 Oct 2030 07:28:00 GMT; DOMAIN=nas.local; Secure",
          ],
          "Content-Type": "text/html",
          "Sec-WebSocket-Accept": "accept",
        },
        { ...ctx, ws: mode === "ws-101" },
      );
      expect(out["clear-site-data"]).toBeUndefined();
      expect(out["proxy-connection"]).toBeUndefined();
      expect(out["x-hop"]).toBeUndefined();
      expect(out["set-cookie"]).toEqual([
        "app=a=b; HttpOnly; Path=/a; SameSite=Lax",
        "other=z; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Secure",
      ]);
      expect(out["content-type"]).toBe("text/html");
      expect(out.connection).toBe(mode === "ws-101" ? "Upgrade" : undefined);
      expect(out.upgrade).toBe(mode === "ws-101" ? "websocket" : undefined);
      expect(out["sec-websocket-accept"]).toBe("accept");
    },
  );
  it("drops malformed and case-insensitive reserved cookies while preserving app cookies", () => {
    expect(filterProxySetCookie("pwh_lan=x")).toBeUndefined();
    expect(filterProxySetCookie("bad")).toBeUndefined();
    expect(filterProxySetCookie("PWH_lan=app; Domain=x; Path=/")).toBeUndefined();
    expect(filterProxySetCookie("App=x; Domain=x; Path=/")).toBe("App=x; Path=/");
  });
  it.each([
    ["http://nas.local:3000/a?q=x#f", "http://hub.local:7901/a?q=x#f"],
    ["//nas.local:3000/a", "//hub.local:7901/a"],
    ["http://192.168.1.2:3000/a", "http://hub.local:7901/a"],
    ["//192.168.1.2:3000/a", "//hub.local:7901/a"],
    ["http://nas.local:3001/a", "http://nas.local:3001/a"],
    ["https://nas.local:3000/a", "https://nas.local:3000/a"],
    ["http://foreign.local:3000/a", "http://foreign.local:3000/a"],
    ["//foreign.local:3000/a", "//foreign.local:3000/a"],
    ["/relative?a=b", "/relative?a=b"],
    ["relative", "relative"],
    ["?a=b", "?a=b"],
    ["#f", "#f"],
    ["http://user@nas.local:3000/a", "http://user@nas.local:3000/a"],
  ])("rewrites Location %s => %s", (input, expected) => {
    expect(rewriteProxyLocation(input!, ctx)).toBe(expected);
    expect(filterResponseHeaders({ Location: input, "Content-Location": input }, ctx)).toMatchObject({
      location: expected,
      "content-location": expected,
    });
  });
  it("normalizes :80, supports loopback aliases and IPv6 pinned authorities", () => {
    const local = {
      ...ctx,
      target: { hostHeader: "localhost", port: 80 },
      pinnedIp: "127.0.0.1",
      cls: "loopback" as const,
    };
    for (const a of ["localhost", "localhost:80", "127.0.0.1", "127.0.0.1:80", "[::1]", "[::1]:80"]) {
      expect(rewriteProxyLocation(`http://${a}/a`, local)).toBe(`${ctx.origin}/a`);
      expect(rewriteProxyLocation(`//${a}/a`, local)).toBe("//hub.local:7901/a");
    }
    expect(rewriteProxyLocation("http://[fd12::1]:3000/a", { ...ctx, pinnedIp: "fd12::1", cls: "ula" })).toBe(
      `${ctx.origin}/a`,
    );
    expect(rewriteProxyLocation("http://127.0.0.1:3000/a", ctx)).toBe("http://127.0.0.1:3000/a");
  });
  it("does not mutate the caller's header arrays", () => {
    const cookies = ["app=x; Domain=nas.local"];
    filterResponseHeaders({ "Set-Cookie": cookies }, ctx);
    expect(cookies).toEqual(["app=x; Domain=nas.local"]);
  });
});
