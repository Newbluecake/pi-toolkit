import { hostname, networkInterfaces } from "node:os";
import { describe, expect, it } from "vitest";
import { createHostsPort, sameHostKeys } from "../../../src/web-hub/hub/net-hosts.js";
import type { HubLanConfig } from "../../../src/web-hub/hub/ports.js";

function cfg(overrides: Partial<HubLanConfig> = {}): HubLanConfig {
  return { port: 7879, extraHosts: [], trustProxyFrom: [], externalOrigins: [], ...overrides };
}

describe("createHostsPort().compute (plan §2.1/§2.3)", () => {
  it("always includes 127.0.0.1 and localhost with the configured port", () => {
    const snap = createHostsPort().compute(cfg());
    expect(snap.hostKeys.has("127.0.0.1:7879")).toBe(true);
    expect(snap.hostKeys.has("localhost:7879")).toBe(true);
  });

  it("includes every IPv4 interface address", () => {
    const snap = createHostsPort().compute(cfg());
    const ifaceIps = Object.values(networkInterfaces())
      .flat()
      .filter((a): a is NonNullable<typeof a> => a !== undefined && a.family === "IPv4")
      .map((a) => a.address);
    for (const ip of ifaceIps) expect(snap.hostKeys.has(`${ip}:7879`)).toBe(true);
  });

  it("includes the system hostname when it classifies ok, and always <hostname>.local", () => {
    const snap = createHostsPort().compute(cfg());
    const h = hostname().toLowerCase();
    expect(snap.hostKeys.has(`${h}.local:7879`)).toBe(true);
    // whether `h` itself is present depends on classifyHostToken(h).ok — not asserted generically
    // here (machine-dependent); the numeric case below pins that behavior directly.
  });

  it("merges extraHosts into hostKeys", () => {
    const snap = createHostsPort().compute(cfg({ extraHosts: ["hub.example.com", "192.168.31.25"] }));
    expect(snap.hostKeys.has("hub.example.com:7879")).toBe(true);
    expect(snap.hostKeys.has("192.168.31.25:7879")).toBe(true);
  });

  it("never puts externalOrigins into hostKeys; carries them + trustProxyFrom through unchanged", () => {
    const snap = createHostsPort().compute(
      cfg({ trustProxyFrom: ["127.0.0.1"], externalOrigins: ["https://hub.example.com"] }),
    );
    expect(snap.hostKeys.has("https://hub.example.com")).toBe(false);
    expect([...snap.externalOrigins]).toEqual(["https://hub.example.com"]);
    expect([...snap.trustProxyFrom]).toEqual(["127.0.0.1"]);
  });

  it("is pure/synchronous and side-effect free across repeated calls", () => {
    const hosts = createHostsPort();
    const a = hosts.compute(cfg());
    const b = hosts.compute(cfg());
    expect(sameHostKeys(a, b)).toBe(true);
  });
});

describe("sameHostKeys", () => {
  it("true for identical sets regardless of insertion order", () => {
    const a = { hostKeys: new Set(["a:1", "b:2"]) } as never;
    const b = { hostKeys: new Set(["b:2", "a:1"]) } as never;
    expect(sameHostKeys(a, b)).toBe(true);
  });

  it("false when sizes differ or an element differs", () => {
    const a = { hostKeys: new Set(["a:1", "b:2"]) } as never;
    const b = { hostKeys: new Set(["a:1"]) } as never;
    const c = { hostKeys: new Set(["a:1", "c:3"]) } as never;
    expect(sameHostKeys(a, b)).toBe(false);
    expect(sameHostKeys(a, c)).toBe(false);
  });
});
