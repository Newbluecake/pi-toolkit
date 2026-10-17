import { describe, expect, it, vi } from "vitest";
import {
  createProxyAudit,
  proxyErrCode,
  type ProxyOpenAudit,
  type ProxyEndAudit,
} from "../../../../src/web-hub/hub/proxy/audit.js";
import {
  PROXY_DENY_LOG_THROTTLE_MS,
  PROXY_END_LOG_FIELDS,
  PROXY_MAX_PROXIES_MAX,
  PROXY_OPEN_LOG_FIELDS,
} from "../../../../src/web-hub/protocol/proxy.js";
import { manualClock } from "./helpers.js";

const identity = { listener: "lan" as const, principal: "u1" };
describe("§7 / T-A2 pure audit projection", () => {
  it("whitelists open/end fields, never spreads paths, URLs, queries, headers, cookie, code, sid or errors", () => {
    const clock = manualClock();
    const info = vi.fn();
    const audit = createProxyAudit({ info }, clock.now);
    const forbidden = {
      path: "/SECRET_PATH",
      url: "http://secret.local/SECRET_URL",
      query: "SECRET_QUERY",
      headers: { Authorization: "SECRET_HEADER" },
      cookie: "SECRET_COOKIE",
      code: "SECRET_CODE",
      sid: "SECRET_SID",
      error: new Error("SECRET_ERROR"),
    };
    audit.open({
      ...forbidden,
      ok: true,
      identity,
      cls: "private",
      targetIp: "192.168.1.1",
      targetPort: 3000,
      host: "nas.local",
      port: 3000,
    } as ProxyOpenAudit);
    audit.end({
      ...forbidden,
      instanceId: "instance-private",
      end: "close",
      reqs: 2,
      bytesUp: 3,
      bytesDown: 4,
      ws: 1,
    } as ProxyEndAudit);
    expect(info.mock.calls[0]).toEqual([
      "proxy-open",
      {
        ok: true,
        principal: "u1",
        listener: "lan",
        cls: "private",
        target: "192.168.1.1:3000",
        host: "nas.local",
        port: 3000,
      },
    ]);
    const end = info.mock.calls[1]![1]!;
    expect(Object.keys(end)).toEqual([...PROXY_END_LOG_FIELDS]);
    expect(end).toMatchObject({ end: "close", reqs: 2, bytesUp: 3, bytesDown: 4, ws: 1 });
    expect(end.instTag).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const text = JSON.stringify(info.mock.calls);
    expect(text).not.toMatch(/SECRET_|instance-private/);
    expect(Object.keys(info.mock.calls[0]![1]!)).toEqual([...PROXY_OPEN_LOG_FIELDS].filter((k) => k !== "reason"));
  });
  it("validates logged values too: an allowed field cannot smuggle a URL/path/header", () => {
    const info = vi.fn();
    const audit = createProxyAudit({ info }, () => 1);
    audit.open({
      ok: false,
      reason: "SECRET_REASON",
      identity: { listener: "lan", principal: "/SECRET_PRINCIPAL" },
      targetIp: "127.0.0.1/SECRET_TARGET",
      targetPort: 3000,
      host: "localhost:3000/SECRET_HOST",
      port: 3000,
      cls: "SECRET_CLASS",
    } as unknown as ProxyOpenAudit);
    audit.end({
      instanceId: "/SECRET_INSTANCE",
      end: "/SECRET_END",
      reqs: NaN,
      bytesUp: Infinity,
      bytesDown: -1,
      ws: 1.5,
    } as unknown as ProxyEndAudit);
    expect(info.mock.calls[0]).toEqual(["proxy-open", { ok: false, listener: "lan", port: 3000 }]);
    expect(info.mock.calls[1]![1]).toMatchObject({ end: "close", reqs: 0, bytesUp: 0, bytesDown: 0, ws: 0 });
    expect(JSON.stringify(info.mock.calls)).not.toContain("SECRET");
  });
  it("canonicalizes target IP, never raw spelling; preserves only expected identity formats", () => {
    const info = vi.fn();
    const audit = createProxyAudit({ info }, () => 1);
    audit.open({
      ok: true,
      identity: { listener: "loopback", principal: "x".repeat(43) },
      targetIp: "[::ffff:7f00:1]",
      targetPort: 3000,
    });
    expect(info.mock.calls[0]![1]).toMatchObject({ principal: "x".repeat(43), target: "127.0.0.1:3000" });
    audit.open({ ok: true, identity, targetIp: "fd12:0:0::1", targetPort: 3000 });
    expect(info.mock.calls[1]![1].target).toBe("[fd12::1]:3000");
  });
  it("denials throttle per instance/60s, bounded table, success unaffected; forget releases state", () => {
    const clock = manualClock();
    const info = vi.fn();
    const audit = createProxyAudit({ info }, clock.now);
    const deny = { ok: false, reason: "public" as const, identity };
    expect(audit.open(deny, "a")).toBe(true);
    expect(audit.open(deny, "a")).toBe(false);
    expect(audit.open(deny, "b")).toBe(true);
    clock.advance(PROXY_DENY_LOG_THROTTLE_MS - 1);
    expect(audit.open(deny, "a")).toBe(false);
    clock.advance(1);
    expect(audit.open(deny, "a")).toBe(true);
    expect(audit.open({ ok: true, identity }, "a")).toBe(true);
    audit.forget("a");
    expect(audit.open(deny, "a")).toBe(true);
    for (let i = 2; i < PROXY_MAX_PROXIES_MAX; i++) expect(audit.open(deny, `inst-${i}`)).toBe(true);
    expect(audit.open(deny, "overflow")).toBe(true);
    expect(audit.open(deny, "overflow")).toBe(false);
    audit.forget("b");
    expect(audit.open(deny, "new-after-forget")).toBe(true);
    expect(info).toHaveBeenCalledTimes(PROXY_MAX_PROXIES_MAX + 5);
  });
  it("prunes old throttles automatically: 1000 distinct ids over time need no forget calls", () => {
    const clock = manualClock();
    const info = vi.fn();
    const audit = createProxyAudit({ info }, clock.now);
    const deny = { ok: false, reason: "public" as const, identity };
    for (let i = 0; i < 1000; i++) {
      clock.advance(PROXY_DENY_LOG_THROTTLE_MS);
      expect(audit.open(deny, `instance-${i}`)).toBe(true);
      expect(audit.open(deny, `instance-${i}`)).toBe(false);
    }
    expect(info).toHaveBeenCalledTimes(1000);
    clock.advance(PROXY_DENY_LOG_THROTTLE_MS);
    expect(audit.open(deny, "instance-999")).toBe(true);
    expect(info).toHaveBeenCalledTimes(1001);
  });
  it("does not drop new ids even if 1000 distinct ids churn inside one window", () => {
    const info = vi.fn();
    const audit = createProxyAudit({ info }, () => 1);
    for (let i = 0; i < 1000; i++) expect(audit.open({ ok: false, identity }, `burst-${i}`)).toBe(true);
    expect(info).toHaveBeenCalledTimes(1000);
    expect(audit.open({ ok: false, identity }, "burst-999")).toBe(false);
  });
  it.each(["proxies", "codes", "sessions", "closing", "revocation-gap", "listen-timeout"] as const)(
    "uses the frozen resource/availability log reason %s",
    (reason) => {
      const info = vi.fn();
      const audit = createProxyAudit({ info }, () => 1);
      audit.open({ ok: false, identity, reason });
      expect(info.mock.calls[0]).toEqual(["proxy-open", { ok: false, principal: "u1", listener: "lan", reason }]);
    },
  );
  it("errCode helper returns only errno-shaped tokens, never exception message/URL", () => {
    expect(proxyErrCode(Object.assign(new Error("secret"), { code: "ECONNRESET" }))).toBe("ECONNRESET");
    for (const e of [new Error("/secret"), "http://secret/", { code: "http://secret/" }, { code: "E\r\nSECRET" }, null])
      expect(proxyErrCode(e)).toBe("E_PROXY_UNAVAILABLE");
  });
  it("logger failures never interrupt forwarding/session teardown", () => {
    const info = vi.fn(() => {
      throw new Error("disk gone");
    });
    const audit = createProxyAudit({ info }, () => 1);
    expect(audit.open({ ok: true, identity })).toBe(true);
    audit.end({ instanceId: "instance", end: "revoked", reqs: 0, bytesUp: 0, bytesDown: 0, ws: 0 });
    expect(info).toHaveBeenCalledTimes(2);
  });
});
