import { describe, expect, it } from "vitest";
import {
  parseClientCidr,
  normalizeClientIp,
  createClientMatcher,
  IMPLICIT_ALLOWED,
  CLIENT_ALLOW_MAX,
} from "../../../src/web-hub/protocol/client-allow.js";
describe("LAN security CIDRs", () => {
  it.each([
    ["192.168.32.38", "192.168.32.38/32"],
    ["192.168.32.38/24", "192.168.32.0/24"],
    ["0.0.0.1/0", "0.0.0.0/0"],
    ["2001:DB8:1:2:3:4:5:6/48", "2001:db8:1::/48"],
    ["::1", "::1/128"],
    ["::/0", "::/0"],
    ["2001:0:0:1:0:0:1:1/128", "2001::1:0:0:1:1/128"],
    ["::ffff:192.168.32.38/120", "192.168.32.0/24"],
    ["::ffff:c0a8:2026/128", "192.168.32.38/32"],
    ["::ffff:192.168.32.38/96", "0.0.0.0/0"],
    ["::ffff:192.168.32.38/95", "::fffe:0:0/95"],
  ])("%s → %s", (input, out) => expect(parseClientCidr(input)).toBe(out));
  it.each([
    "localhost",
    "1.2.3",
    "1.2.3.256",
    "01.2.3.4",
    "1.2.3.4/-1",
    "1.2.3.4/33",
    "::1/129",
    "1.2.3.4/1/2",
    "1.2.3.4/",
    "fe80::1%eth0",
    "[::1]",
    ":::1",
    "1::2::3",
    ":1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:",
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:8:9",
    "::ffff:1.2.3.999",
    "::/01",
  ])("rejects %s", (input) => expect(parseClientCidr(input)).toBeUndefined());
  it("normalizes mapped dotted and hex, but never paths/zones/ports", () => {
    expect(normalizeClientIp("::ffff:c0a8:2026")).toBe("192.168.32.38");
    expect(normalizeClientIp("::ffff:192.168.32.38")).toBe("192.168.32.38");
    expect(normalizeClientIp("2001:DB8::1")).toBe("2001:db8::1");
    for (const ip of ["1.2.3.4/32", "1.2.3.4:80", "::1%lo", "garbage"]) expect(normalizeClientIp(ip)).toBeUndefined();
  });
  it("matches masked prefixes and rejects invalid IPs, without implicit policy", () => {
    const match = createClientMatcher(["192.168.32.38/24", "2001:db8::/32"]);
    expect(match("192.168.32.99")).toBe(true);
    expect(match("::ffff:c0a8:2026")).toBe(true);
    expect(match("192.168.33.38")).toBe(false);
    expect(match("2001:db8::abcd")).toBe(true);
    expect(match("2001:db9::1")).toBe(false);
    expect(match("garbage")).toBe(false);
    expect(match("127.0.0.1")).toBe(false);
    expect(createClientMatcher([])("127.0.0.1")).toBe(false);
    expect(() => createClientMatcher(["no"])).toThrow("Invalid client CIDR");
    expect(IMPLICIT_ALLOWED).toEqual(["127.0.0.0/8", "::1"]);
    expect(CLIENT_ALLOW_MAX).toBe(64);
    const loopback = createClientMatcher(IMPLICIT_ALLOWED);
    expect(loopback("127.99.1.1")).toBe(true);
    expect(loopback("::1")).toBe(true);
    expect(loopback("128.0.0.1")).toBe(false);
  });
});
