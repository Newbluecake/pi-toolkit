import { describe, expect, it } from "vitest";
import { createFeishuLinks, safeFeishuLink } from "../../../../src/web-hub/hub/feishu/link.js";
import type { HostSnapshot, RequestContext } from "../../../../src/web-hub/hub/ports.js";

const snapshot = (
  hosts = ["127.0.0.1:8787", "localhost:8787", "192.168.32.10:8787", "10.8.0.1:8787"],
): HostSnapshot => ({
  gen: 1,
  computedAt: 0,
  omitted: [],
  hostKeys: new Set(hosts),
  externalOrigins: new Set(),
  trustProxyFrom: new Set(),
});
const context = (hostKey: string, extra: Partial<RequestContext> = {}): RequestContext => ({
  kind: "lan",
  peerIp: "10.8.0.3",
  clientIp: "10.8.0.3",
  viaTrustedProxy: false,
  scheme: "http",
  hostKey,
  externalOrigin: `http://${hostKey}`,
  ...extra,
});
function rig(externalOrigins: string[] = [], on = true) {
  let current: HostSnapshot | undefined = snapshot();
  const links = createFeishuLinks({
    loopbackPort: () => 7878,
    ...(on ? { lan: { port: 8787, extraHosts: [], trustProxyFrom: [], externalOrigins } } : {}),
    snapshot: () => current,
  });
  return {
    links,
    swap: (s: HostSnapshot | undefined) => {
      current = s;
    },
  };
}
describe("Feishu phone link selection", () => {
  it("externalOrigins[0] wins, including over the most recent authenticated direct LAN host", () => {
    const { links } = rig(["https://pi.example.com:8443", "https://ignored.example.com"]);
    links.authenticated(context("10.8.0.1:8787"));
    expect(links.link("a key/#")).toBe("https://pi.example.com:8443/#/agent/a%20key%2F%23");
  });
  it("otherwise uses the most recent authenticated host, with current allow-list revalidation", () => {
    const { links, swap } = rig();
    expect(links.link("key")).toBe("http://192.168.32.10:8787/#/agent/key");
    links.authenticated(context("10.8.0.1:8787"));
    expect(links.link("key")).toBe("http://10.8.0.1:8787/#/agent/key");
    links.authenticated(context("192.168.32.10:8787"));
    expect(links.link("key")).toBe("http://192.168.32.10:8787/#/agent/key");
    swap(snapshot(["10.8.0.1:8787"]));
    expect(links.link("key")).toBe("http://10.8.0.1:8787/#/agent/key");
  });
  it("never records a loopback Host seen on the LAN listener (verifier finding 2026-10-20)", () => {
    const { links } = rig();
    links.authenticated(context("10.8.0.1:8787"));
    links.authenticated(context("127.0.0.1:8787"));
    links.authenticated(context("localhost:8787"));
    expect(links.link("key")).toBe("http://10.8.0.1:8787/#/agent/key");
  });
  it("never learns an unallowed, malformed, loopback-listener or forwarded untrusted Host", () => {
    const { links } = rig();
    for (const ctx of [
      context("evil.example:8787"),
      context("10.8.0.1:8787\n"),
      context("10.8.0.1:8787", { kind: "loopback" }),
      context("10.8.0.1:8787", { viaTrustedProxy: true }),
    ])
      links.authenticated(ctx);
    expect(links.link("key")).toBe("http://192.168.32.10:8787/#/agent/key");
  });
  it("LAN off / down / loopback-only falls back to the loopback listener", () => {
    expect(rig(["https://ignored.example.com"], false).links.link("key")).toBe("http://127.0.0.1:7878/#/agent/key");
    const { links, swap } = rig();
    swap(undefined);
    expect(links.link("key")).toBe("http://127.0.0.1:7878/#/agent/key");
    swap(snapshot(["127.0.0.1:8787", "localhost:8787", "127.10.1.2:8787"]));
    expect(links.link("key")).toBe("http://127.0.0.1:7878/#/agent/key");
  });
  it.each([
    "javascript:alert(1)",
    "https://user:pass@pi.example.com",
    "http://pi.example.com/path",
    "https://pi.example.com?token=secret",
    "https://pi.example.com\n",
  ])("invalid external origin %s does not leak into cards", (origin) => {
    expect(rig([origin]).links.link("key")).toBe("http://192.168.32.10:8787/#/agent/key");
  });
  it.each([
    undefined,
    "",
    "http://",
    "http:evil.example.com",
    "http:///evil.example.com",
    "http://evil.example.com\\path",
    "http://user:secret@host/path",
    "https://host?token=secret",
    "https://host/\n",
  ])("invalid injected link %s uses the F8 fallback", (value) => {
    expect(safeFeishuLink(value)).toBe("web 会话页面");
  });
  it("startup without a bound port has no bogus port-zero link", () => {
    expect(createFeishuLinks({ loopbackPort: () => 0, snapshot: () => undefined }).link("key")).toBe("");
  });
});
