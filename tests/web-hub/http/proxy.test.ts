import { describe, expect, it } from "vitest";
import { resolveProxy } from "../../../src/web-hub/hub/proxy.js";

const TRUST = new Set(["192.168.31.10"]);

describe("resolveProxy (plan §2.4)", () => {
  it("untrusted peer: every X-Forwarded-* header ignored", () => {
    const r = resolveProxy("1.2.3.4", { "x-forwarded-for": "9.9.9.9", "x-forwarded-proto": "https", host: "h" }, TRUST);
    expect(r).toEqual({ viaTrustedProxy: false, clientIp: "1.2.3.4", scheme: "http", hostHeader: "h", warnings: [] });
  });

  it("trusted peer, well-formed XFF/XFP/XFH ⇒ clientIp from XFF, scheme https, hostHeader from XFH", () => {
    const r = resolveProxy(
      "192.168.31.10",
      {
        "x-forwarded-for": "1.2.3.4, 192.168.31.10",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "hub.example.com",
      },
      TRUST,
    );
    expect(r.viaTrustedProxy).toBe(true);
    expect(r.clientIp).toBe("1.2.3.4");
    expect(r.scheme).toBe("https");
    expect(r.hostHeader).toBe("hub.example.com");
    expect(r.warnings).toEqual([]);
  });

  it("XFF missing ⇒ clientIp = peerIp + xff-missing warning", () => {
    const r = resolveProxy("192.168.31.10", { "x-forwarded-proto": "https" }, TRUST);
    expect(r.clientIp).toBe("192.168.31.10");
    expect(r.warnings).toContain("xff-missing");
  });

  it("XFF all-trusted ⇒ clientIp = peerIp + xff-all-trusted warning", () => {
    const r = resolveProxy(
      "192.168.31.10",
      { "x-forwarded-for": "192.168.31.10", "x-forwarded-proto": "https" },
      TRUST,
    );
    expect(r.clientIp).toBe("192.168.31.10");
    expect(r.warnings).toContain("xff-all-trusted");
  });

  it("XFF malformed (garbage / IPv6) ⇒ clientIp = peerIp + xff-malformed warning", () => {
    for (const bad of ["garbage", "::1"]) {
      const r = resolveProxy("192.168.31.10", { "x-forwarded-for": bad, "x-forwarded-proto": "https" }, TRUST);
      expect(r.clientIp).toBe("192.168.31.10");
      expect(r.warnings).toContain("xff-malformed");
    }
  });

  it("two X-Forwarded-For header lines (node joins with comma) ⇒ reads right-to-left across the whole joined string", () => {
    const r = resolveProxy(
      "192.168.31.10",
      { "x-forwarded-for": "1.2.3.4, 192.168.31.10", "x-forwarded-proto": "https" },
      TRUST,
    );
    expect(r.clientIp).toBe("1.2.3.4");
  });

  it("X-Forwarded-Proto: missing / non-https / multi-value ⇒ proto-invalid warning; case-insensitive https passes", () => {
    for (const bad of [undefined, "http", "https, http", "HTTP"]) {
      const headers: Record<string, string> = { "x-forwarded-for": "1.2.3.4" };
      if (bad !== undefined) headers["x-forwarded-proto"] = bad;
      const r = resolveProxy("192.168.31.10", headers, TRUST);
      expect(r.warnings).toContain("proto-invalid");
      expect(r.scheme).toBe("http");
    }
    const ok = resolveProxy("192.168.31.10", { "x-forwarded-for": "1.2.3.4", "x-forwarded-proto": "HTTPS" }, TRUST);
    expect(ok.warnings).not.toContain("proto-invalid");
    expect(ok.scheme).toBe("https");
  });

  it("X-Forwarded-Host missing ⇒ falls back to Host", () => {
    const r = resolveProxy(
      "192.168.31.10",
      { "x-forwarded-for": "1.2.3.4", "x-forwarded-proto": "https", host: "hub.example.com" },
      TRUST,
    );
    expect(r.hostHeader).toBe("hub.example.com");
  });

  it("X-Forwarded-Host multi-value (comma) is passed through raw for the caller to reject", () => {
    const r = resolveProxy(
      "192.168.31.10",
      { "x-forwarded-for": "1.2.3.4", "x-forwarded-proto": "https", "x-forwarded-host": "a, b" },
      TRUST,
    );
    expect(r.hostHeader).toBe("a, b");
  });
});
