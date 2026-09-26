import { describe, expect, it } from "vitest";
import {
  SINGLE_LABEL_DENYLIST,
  canonicalHostKey,
  canonicalOrigin,
  classifyHostToken,
  parseOrigin,
} from "../../../src/web-hub/protocol/lan.js";

describe("classifyHostToken: classification priority (plan §2.1)", () => {
  it("localhost ⇒ localhost (not denylisted)", () => {
    expect(classifyHostToken("localhost")).toEqual({ ok: true, kind: "localhost", host: "localhost" });
  });

  it("LOCALHOST ⇒ localhost after lower-casing", () => {
    expect(classifyHostToken("LOCALHOST")).toEqual({ ok: true, kind: "localhost", host: "localhost" });
  });

  it("localhost.local ⇒ dot-local", () => {
    expect(classifyHostToken("localhost.local")).toEqual({ ok: true, kind: "dot-local", host: "localhost.local" });
  });

  it("a.localhost ⇒ fqdn", () => {
    expect(classifyHostToken("a.localhost")).toEqual({ ok: true, kind: "fqdn", host: "a.localhost" });
  });

  it("127.0.0.1 ⇒ ipv4 (not numeric)", () => {
    expect(classifyHostToken("127.0.0.1")).toEqual({ ok: true, kind: "ipv4", host: "127.0.0.1" });
  });

  it("123 ⇒ numeric (not single-label)", () => {
    expect(classifyHostToken("123")).toEqual({ ok: false, reason: "numeric" });
  });

  // 审查修复 v2 #1: WHATWG 会把短数字/十六进制/两段式重写成真 IPv4，classifyHostToken 必须在
  // 重写发生前就把这些形式判为 numeric（谁来调用它——parseOrigin 现在不再用 new URL() 取 host——见下面）。
  it("1 ⇒ numeric", () => {
    expect(classifyHostToken("1")).toEqual({ ok: false, reason: "numeric" });
  });

  it("0x7f (hex) ⇒ numeric", () => {
    expect(classifyHostToken("0x7f")).toEqual({ ok: false, reason: "numeric" });
    expect(classifyHostToken("0X7F")).toEqual({ ok: false, reason: "numeric" }); // case-insensitive
  });

  // 审查修复三轮 #1: WHATWG 的 IPv4 number parser 对空 hex 尾（“0x”本身）仍返回成功（值 0），
  // 而非失败——`new URL("https://0x").host === "0.0.0.0"`。之前的 `/^0x[0-9a-f]+$/` 要求至少一位
  // hex 数字，让裸 "0x"/"0X" 被当作合法 single-label 放行。
  it('bare "0x"/"0X" (empty hex tail, WHATWG parses it as 0) ⇒ numeric', () => {
    expect(classifyHostToken("0x")).toEqual({ ok: false, reason: "numeric" });
    expect(classifyHostToken("0X")).toEqual({ ok: false, reason: "numeric" });
  });

  // 尾随一个点的数字段（"1."/"0x."）也会被 WHATWG 重写（`new URL("https://1.").host ===
  // "0.0.0.1"`），但 `"1.".split(".")` 已产生一个尾随的空 label，被 ④ 规则（label 语法）先一步
  // 拒为 syntax，根本不会走到 ⑥ 的 numeric 分支——无需额外处理，但仍要验证它们最终被拒。
  it('a trailing dot on a numeric-looking label ("1.", "0.", "0x.") is rejected (as syntax, via the empty split label)', () => {
    for (const h of ["1.", "0.", "0x.", "0x7f."]) {
      const r = classifyHostToken(h);
      expect(r.ok, h).toBe(false);
      if (!r.ok) expect(r.reason, h).toBe("syntax");
    }
  });

  it("1.2 (two-part, WHATWG A.B → A.0.0.B) ⇒ numeric (last label is all-digit)", () => {
    expect(classifyHostToken("1.2")).toEqual({ ok: false, reason: "numeric" });
  });

  it("123.local ⇒ dot-local", () => {
    expect(classifyHostToken("123.local")).toEqual({ ok: true, kind: "dot-local", host: "123.local" });
  });

  it("dev ⇒ denylisted", () => {
    expect(classifyHostToken("dev")).toEqual({ ok: false, reason: "denylisted" });
  });

  it("x.dev ⇒ fqdn", () => {
    expect(classifyHostToken("x.dev")).toEqual({ ok: true, kind: "fqdn", host: "x.dev" });
  });

  it("a_b ⇒ syntax (checked before denylisted)", () => {
    expect(classifyHostToken("a_b")).toEqual({ ok: false, reason: "syntax" });
  });

  it("::1 ⇒ ipv6", () => {
    expect(classifyHostToken("::1")).toEqual({ ok: false, reason: "ipv6" });
  });

  it("a nonexistent numeric hostname is not omitted from SINGLE_LABEL_DENYLIST semantics: denylist excludes localhost", () => {
    expect((SINGLE_LABEL_DENYLIST as readonly string[]).includes("localhost")).toBe(false);
  });

  it("full denylist set is rejected as denylisted", () => {
    for (const h of SINGLE_LABEL_DENYLIST) expect(classifyHostToken(h)).toEqual({ ok: false, reason: "denylisted" });
  });

  it("a label over 63 bytes ⇒ too-long", () => {
    const label = "a".repeat(64);
    expect(classifyHostToken(`${label}.com`)).toEqual({ ok: false, reason: "too-long" });
  });

  it("a total host over 253 bytes ⇒ too-long", () => {
    const host = `${Array.from({ length: 60 }, () => "abcd").join(".")}.com`;
    expect(host.length).toBeGreaterThan(253);
    expect(classifyHostToken(host)).toEqual({ ok: false, reason: "too-long" });
  });

  it("three-label .local (not exactly one preceding label) ⇒ fqdn, not dot-local", () => {
    expect(classifyHostToken("a.b.local")).toEqual({ ok: true, kind: "fqdn", host: "a.b.local" });
  });

  it("a bare unlisted single label ⇒ single-label", () => {
    expect(classifyHostToken("myhost")).toEqual({ ok: true, kind: "single-label", host: "myhost" });
  });

  it("mixed-case FQDN is lower-cased", () => {
    expect(classifyHostToken("MyHost.Example.Net")).toEqual({ ok: true, kind: "fqdn", host: "myhost.example.net" });
  });
});

describe("canonicalHostKey / canonicalOrigin / parseOrigin (plan §2.2)", () => {
  it("Host: hub.example.com + https ⇒ hub.example.com:443 / https://hub.example.com", () => {
    const key = canonicalHostKey("hub.example.com", "https");
    expect(key).toBe("hub.example.com:443");
    expect(canonicalOrigin("https", key!)).toBe("https://hub.example.com");
  });

  it("Host: 192.168.31.25:7879 ⇒ unchanged", () => {
    const key = canonicalHostKey("192.168.31.25:7879", "http");
    expect(key).toBe("192.168.31.25:7879");
    expect(canonicalOrigin("http", key!)).toBe("http://192.168.31.25:7879");
  });

  it("Host: MyHost.Local:7879 ⇒ lower-cased", () => {
    expect(canonicalHostKey("MyHost.Local:7879", "http")).toBe("myhost.local:7879");
  });

  it("Host: host:080 ⇒ rejected (leading zero port)", () => {
    expect(canonicalHostKey("host:080", "http")).toBeUndefined();
  });

  it("Host: host:0 ⇒ rejected (out of range)", () => {
    expect(canonicalHostKey("host:0", "http")).toBeUndefined();
  });

  it("bracketed IPv6 literal ⇒ rejected", () => {
    expect(canonicalHostKey("[::1]:7879", "http")).toBeUndefined();
  });

  it("Origin: https://hub.example.com:443 and https://hub.example.com normalize equal", () => {
    const a = parseOrigin("https://hub.example.com:443");
    const b = parseOrigin("https://hub.example.com");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(canonicalOrigin(a!.scheme, a!.hostKey)).toBe(canonicalOrigin(b!.scheme, b!.hostKey));
  });

  it("Origin: https://hub.example.com/ (trailing slash, pathname '/') ⇒ accepted", () => {
    expect(parseOrigin("https://hub.example.com/")).toEqual({ scheme: "https", hostKey: "hub.example.com:443" });
  });

  it("Origin with a non-root path ⇒ rejected", () => {
    expect(parseOrigin("https://hub.example.com/x")).toBeUndefined();
  });

  it("Origin with search or hash ⇒ rejected", () => {
    expect(parseOrigin("https://hub.example.com/?a=1")).toBeUndefined();
    expect(parseOrigin("https://hub.example.com/#a")).toBeUndefined();
  });

  it("Origin with embedded userinfo ⇒ rejected", () => {
    expect(parseOrigin("https://user:pw@hub.example.com")).toBeUndefined();
  });

  it("Origin: null ⇒ rejected", () => {
    expect(parseOrigin("null")).toBeUndefined();
  });

  it("Origin with a non-http(s) scheme ⇒ rejected", () => {
    expect(parseOrigin("ftp://hub.example.com")).toBeUndefined();
  });

  it("a numeric / denylisted host is still canonicalizable (canonicalization ≠ allow-list)", () => {
    expect(canonicalHostKey("202507220006", "http")).toBe("202507220006:80");
    expect(canonicalHostKey("dev", "http")).toBe("dev:80");
  });

  // 审查修复 v2 #1: parseOrigin 不再用 new URL().host 取值——否则 https://123 会被 WHATWG 改写成
  // 0.0.0.123 并被当作合法 IPv4 放行。hostKey 必须是调用方字面写的原始值。
  it("parseOrigin preserves the raw authority (does not let WHATWG rewrite a numeric host into a real IPv4)", () => {
    expect(parseOrigin("https://123")).toEqual({ scheme: "https", hostKey: "123:443" });
    expect(parseOrigin("https://1")).toEqual({ scheme: "https", hostKey: "1:443" });
    expect(parseOrigin("https://0x7f")).toEqual({ scheme: "https", hostKey: "0x7f:443" });
    expect(parseOrigin("https://1.2")).toEqual({ scheme: "https", hostKey: "1.2:443" });
    // none of these are "0.0.0.123" / "0.0.0.1" / "0.0.0.127" / "1.0.0.2" (the WHATWG-rewritten forms)
  });

  // 审查修复三轮 #1: 裸 "0x"/"0X" 也要被保留为原始值（才能被 classifyHostToken 判 numeric）。
  it('parseOrigin preserves a bare "0x"/"0X" authority too (not WHATWG-rewritten to "0.0.0.0")', () => {
    expect(parseOrigin("https://0x")).toEqual({ scheme: "https", hostKey: "0x:443" });
    expect(parseOrigin("https://0X")).toEqual({ scheme: "https", hostKey: "0x:443" }); // lower-cased
  });

  it('parseOrigin rejects a trailing-dot numeric authority ("1.", "0x.") outright (empty split label ⇒ syntax)', () => {
    expect(parseOrigin("https://1.")).toBeUndefined();
    expect(parseOrigin("https://0x.")).toBeUndefined();
  });

  it("a syntactically invalid host is not canonicalizable", () => {
    expect(canonicalHostKey("a_b", "http")).toBeUndefined();
  });
});
