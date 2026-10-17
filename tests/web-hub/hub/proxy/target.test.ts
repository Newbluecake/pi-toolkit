import { describe, expect, it } from "vitest";
import { validateHeaderValue } from "node:http";
import {
  canonicalAddr,
  classifyProxyAddr,
  isProxySelfPort,
  parseProxyTarget,
  proxyTargetKey,
  safeOriginForm,
} from "../../../../src/web-hub/hub/proxy/target.js";

const allow = [
  ["127.0.0.1:1", "loopback"],
  ["[::1]:3000", "loopback"],
  ["localhost:5173", "loopback"],
  ["10.0.0.1:80", "private"],
  ["172.16.0.1:80", "private"],
  ["172.31.255.255:80", "private"],
  ["192.168.31.25:80", "private"],
  ["100.64.0.1:80", "cgnat"],
  ["100.127.255.255:80", "cgnat"],
  ["[fd12::1]:80", "ula"],
  ["[fc00::1]:80", "ula"],
  ["[::ffff:127.0.0.1]:80", "loopback"],
  ["[::ffff:7f00:1]:80", "loopback"],
  ["[0:0:0:0:0:ffff:7f00:1]:80", "loopback"],
] as const;
const deny = [
  ["172.32.0.1", "public"],
  ["8.8.8.8", "public"],
  ["2001:db8::1", "public"],
  ["fec0::1", "public"],
  ["169.254.169.254", "metadata"],
  ["100.100.100.200", "metadata"],
  ["fd00:ec2::254", "metadata"],
  ["fd00:ec2:ffff::1", "metadata"],
  ["169.254.1.1", "link-local"],
  ["fe80::1", "link-local"],
  ["febf:ffff::1", "link-local"],
  ["::ffff:a9fe:a9fe", "metadata"],
  ["::ffff:a9fe:1", "link-local"],
  ["64:ff9b::7f00:1", "translation"],
  ["64:ff9b::a00:1", "translation"],
  ["64:ff9b:1::1", "translation"],
  ["2002:7f00:1::", "translation"],
  ["::7f00:1", "translation"],
  ["0.0.0.0", "unspecified"],
  ["0.1.2.3", "unspecified"],
  ["::", "unspecified"],
  ["224.0.0.1", "multicast"],
  ["ff02::1", "multicast"],
  ["255.255.255.255", "reserved"],
  ["240.0.0.1", "reserved"],
  ["192.0.0.1", "reserved"],
  ["192.0.2.1", "reserved"],
  ["198.18.0.1", "reserved"],
  ["198.19.255.255", "reserved"],
  ["198.51.100.1", "reserved"],
  ["203.0.113.1", "reserved"],
] as const;

describe("T-F1 canonical fence corpus", () => {
  it.each(allow)("allows %s as %s", (input, cls) => {
    const p = parseProxyTarget(input);
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error("parse failed");
    expect(classifyProxyAddr(p.target.address!)).toEqual({ ok: true, cls });
  });
  it.each(deny)("denies %s as %s (including mapped forms)", (ip, reason) => {
    const address = canonicalAddr(ip)!;
    expect(address).toBeDefined();
    expect(classifyProxyAddr(address)).toEqual({ ok: false, reason });
    expect(parseProxyTarget(`${ip.includes(":") ? `[${ip}]` : ip}:3000`)).toEqual({ ok: false, reason });
    if (address.v === 4)
      expect(classifyProxyAddr(canonicalAddr(`::ffff:${address.key}`)!)).toEqual({ ok: false, reason });
  });
  it.each([
    ["0x7f.0.0.1:80", "syntax"],
    ["2130706433:80", "syntax"],
    ["127.1:80", "syntax"],
    ["0177.0.0.1:80", "syntax"],
    ["127.0.0.1.:80", "syntax"],
    ["0x7f.1:80", "syntax"],
    ["127.0.0.01:80", "syntax"],
    ["0x:80", "syntax"],
    ["unix:/run/x.sock", "scheme"],
    ["/run/pi-webhub.sock", "syntax"],
    ["https://localhost:80", "scheme"],
    ["ftp://localhost:80", "scheme"],
    ["http://user:password@localhost:80", "userinfo"],
    ["user@localhost:80", "userinfo"],
    ["localhost", "syntax"],
    ["localhost:3000/path", "syntax"],
    ["[::1]:3000?query", "syntax"],
    [" localhost:3000", "syntax"],
    ["localhost:", "port"],
    ["localhost:0", "port"],
    ["localhost:65536", "port"],
    ["localhost:080", "port"],
    ["localhost:+80", "port"],
    ["localhost:1e2", "port"],
    ["[fe80::1%eth0]:80", "syntax"],
    ["[::1]", "syntax"],
    ["::1:80", "syntax"],
    ["http://localhost\\evil:80", "syntax"],
    ["http://%31%32%37.0.0.1:80", "syntax"],
    ["http://localhost:80\r\nx:y", "syntax"],
  ])("rejects grammar %s => %s", (input, reason) => {
    expect(parseProxyTarget(input!)).toEqual({ ok: false, reason });
  });
  it.each([
    "metadata",
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
    "instance-data.ec2.internal",
    "metadata.azure.internal",
  ])("rejects metadata hostname %s before DNS", (host) => {
    expect(parseProxyTarget(`${host.toUpperCase()}:80`)).toEqual({ ok: false, reason: "metadata" });
  });
  it.each([
    "127.1",
    "2130706433",
    "0x7f.1",
    "0177.0.0.1",
    "127.0.0.1.",
    "[::ffff:7f00:1]",
    "::ffff:127.0.0.1",
    "0:0:0:0:0:ffff:7f00:1",
  ])("canonicalizes %s to the SAME self/fence key", (text) => {
    const a = canonicalAddr(text)!;
    expect(a.key).toBe("127.0.0.1");
    expect([...a.bytes]).toEqual([127, 0, 0, 1]);
    expect(classifyProxyAddr(a)).toEqual({ ok: true, cls: "loopback" });
  });
  it.each([
    "",
    "foo",
    "127.0.0.1/path",
    "127.0.0.1:80",
    "fe80::1%eth0",
    "http://127.0.0.1",
    "[127.0.0.1]",
    "::gg",
    "::1@evil",
    "1:2:3",
  ])("does not canonicalize junk %s", (s) => {
    // A bracket pair only belongs to IPv6, never IPv4.
    expect(canonicalAddr(s)).toBeUndefined();
  });
  it.each([
    ["0x0a000001", "10.0.0.1", "private"],
    ["0300.0250.01.1", "192.168.1.1", "private"],
    ["169.254.43518", "169.254.169.254", "metadata"],
    ["0251.0376.0251.0376", "169.254.169.254", "metadata"],
    ["0xa9fea9fe", "169.254.169.254", "metadata"],
    ["0x08080808", "8.8.8.8", "public"],
    ["134744072", "8.8.8.8", "public"],
    ["8.526344", "8.8.8.8", "public"],
    ["0", "0.0.0.0", "unspecified"],
  ] as const)(
    "classifies legacy IPv4 %s via canonical bytes but never admits it as target syntax",
    (text, key, clsOrReason) => {
      const a = canonicalAddr(text)!;
      expect(a.key).toBe(key);
      expect(classifyProxyAddr(a)).toEqual(
        clsOrReason === "private" ? { ok: true, cls: clsOrReason } : { ok: false, reason: clsOrReason },
      );
      expect(parseProxyTarget(`${text}:3000`)).toEqual({ ok: false, reason: "syntax" });
    },
  );
  it("keeps target virtual host and safe path separate from the pinned key", () => {
    const p = parseProxyTarget("http://Nas.Local:3000/app?token=secret#ignored");
    expect(p).toEqual({
      ok: true,
      target: {
        host: "Nas.Local",
        lookupHost: "nas.local",
        port: 3000,
        hostHeader: "nas.local:3000",
        nextPath: "/app?token=secret",
      },
    });
    if (!p.ok) throw new Error("parse failed");
    expect(proxyTargetKey(canonicalAddr("192.168.1.1")!, p.target)).toBe("192.168.1.1|3000|nas.local:3000");
    expect(parseProxyTarget("http://localhost:80?x=1")).toMatchObject({
      target: { hostHeader: "localhost", nextPath: "/?x=1" },
    });
  });
  it("canonicalizes literal upstream Host and target key across mapped IPv6/IPv4 spellings", () => {
    for (const port of [80, 3000]) {
      const targets = ["127.0.0.1", "[::ffff:7f00:1]", "[::ffff:127.0.0.1]", "[0:0:0:0:0:ffff:7f00:1]"].map((host) => {
        const parsed = parseProxyTarget(`${host}:${port}`);
        if (!parsed.ok) throw new Error("parse failed");
        return parsed.target;
      });
      for (const target of targets) {
        expect(target.hostHeader).toBe(`127.0.0.1${port === 80 ? "" : `:${port}`}`);
        expect(proxyTargetKey(target.address!, target)).toBe(`127.0.0.1|${port}|${targets[0]!.hostHeader}`);
      }
      expect(
        proxyTargetKey(canonicalAddr("127.0.0.1")!, {
          port,
          hostHeader: `[::ffff:7f00:1]${port === 80 ? "" : `:${port}`}`,
        }),
      ).toBe(`127.0.0.1|${port}|${targets[0]!.hostHeader}`);
    }
    const ipv6 = parseProxyTarget("[FD12:0:0:0:0:0:0:1]:3000");
    expect(ipv6).toMatchObject({ target: { hostHeader: "[fd12::1]:3000" } });
  });
  it("canonical self check uses ACTUAL fallback+LAN ports and every interface/mapped form", () => {
    const self = {
      hubPort: 47123,
      lanPort: 7879,
      proxyRange: [7900, 7949] as const,
      localAddresses: ["::ffff:c0a8:101", "fd12:0:0:0:0:0:0:1"],
    };
    for (const ip of ["127.1", "[::ffff:7f00:1]", "::1", "192.168.1.1", "[fd12::1]"]) {
      for (const port of [47123, 7879, 7900, 7949]) expect(isProxySelfPort(canonicalAddr(ip)!, port, self)).toBe(true);
      expect(isProxySelfPort(canonicalAddr(ip)!, 3000, self)).toBe(false);
    }
    expect(isProxySelfPort(canonicalAddr("10.1.1.1")!, 47123, self)).toBe(false);
    expect(isProxySelfPort(canonicalAddr("127.0.0.1")!, 7878, self)).toBe(false);
  });
});

describe("T-F3 safeOriginForm", () => {
  it.each([
    "//evil",
    "/\\evil",
    "\\\\evil",
    "/%0d%0aSet-Cookie:x",
    "/%00",
    "/%",
    "/%x1",
    "/%0",
    "?q=é",
    "/a b",
    "/%20",
    "/%7f",
    "/%5c",
    "/%2fevil",
    "/\u007f",
    "*",
    "http://evil",
    "/" + "a".repeat(2048),
    "/" + "é".repeat(1024),
  ])("falls back for %s", (s) => expect(safeOriginForm(s)).toBe("/"));
  it.each(["/a?b=c", "/", "/foo%2fbar", "/" + "a".repeat(2047), "/a?url=http://example.test"])("keeps %s", (s) =>
    expect(safeOriginForm(s)).toBe(s),
  );
  it.each([
    ["/日本", "/%E6%97%A5%E6%9C%AC"],
    ["/?q=é", "/?q=%C3%A9"],
    ["/a\u2028b", "/a%E2%80%A8b"],
    ["/\ud800", "/%EF%BF%BD"],
    ["/\udc00", "/%EF%BF%BD"],
    ["/😀?q=%C3%A9", "/%F0%9F%98%80?q=%C3%A9"],
  ])("encodes UTF-8 for ASCII-only Location: %s", (input, expected) => {
    const safe = safeOriginForm(input!);
    expect(safe).toBe(expected);
    expect(safe).toMatch(/^[\x21-\x7e]+$/);
    expect(validateHeaderValue("Location", safe)).toBeUndefined();
    const parsed = parseProxyTarget(`http://localhost:80${input}`);
    expect(parsed).toMatchObject({ ok: true, target: { nextPath: expected } });
  });
  it("applies the byte cap to the ASCII output after percent encoding", () => {
    expect(safeOriginForm("/" + "é".repeat(341))).toBe("/" + "%C3%A9".repeat(341));
    expect(safeOriginForm("/" + "é".repeat(342))).toBe("/");
    expect(parseProxyTarget("http://localhost:80?q=é")).toMatchObject({ target: { nextPath: "/?q=%C3%A9" } });
  });
  it("drops fragment and unsafe nextPath during target parsing", () => {
    expect(safeOriginForm("/a#fragment")).toBe("/a");
    expect(parseProxyTarget("http://localhost:3000//evil")).toMatchObject({ target: { nextPath: "/" } });
    expect(parseProxyTarget("http://localhost:3000/a ")).toMatchObject({ target: { nextPath: "/" } });
  });
});
