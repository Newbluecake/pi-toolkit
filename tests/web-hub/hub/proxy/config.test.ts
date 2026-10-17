/** `hub/proxy/config.ts` — `HubConfig.proxy` re-validation + the second line of the port-collision veto. */
import { describe, expect, it } from "vitest";
import { normalizeHubProxyConfig } from "../../../../src/web-hub/hub/proxy/config.js";

const ports = { hubPort: 7878, lanPort: 7879 };

describe("normalizeHubProxyConfig", () => {
  it("accepts a well-formed config and returns the tuple (maxProxies default 8 when absent)", () => {
    expect(normalizeHubProxyConfig({ portRange: [7900, 7949], maxProxies: 8 }, ports)).toEqual({
      ok: true,
      proxy: { portRange: [7900, 7949], maxProxies: 8 },
    });
    expect(normalizeHubProxyConfig({ portRange: [20000, 20000] }, ports)).toEqual({
      ok: true,
      proxy: { portRange: [20000, 20000], maxProxies: 8 },
    });
  });

  it.each([
    ["non-object", 5],
    ["array", []],
    ["null", null],
    ["missing range", { maxProxies: 8 }],
    ["string range", { portRange: "7900-7949" }],
    ["short tuple", { portRange: [7900] }],
    ["float", { portRange: [7900.5, 7949] }],
    ["below 1024", { portRange: [80, 100] }],
    ["above 65535", { portRange: [65000, 70000] }],
    ["lo > hi", { portRange: [7949, 7900] }],
    ["span > 256", { portRange: [7000, 7256] }],
    ["maxProxies 0", { portRange: [7900, 7949], maxProxies: 0 }],
    ["maxProxies 17", { portRange: [7900, 7949], maxProxies: 17 }],
    ["maxProxies float", { portRange: [7900, 7949], maxProxies: 2.5 }],
    ["maxProxies string", { portRange: [7900, 7949], maxProxies: "8" }],
  ])("rejects %s", (_label, value) => {
    expect(normalizeHubProxyConfig(value, ports).ok).toBe(false);
  });

  it("vetoes a range that overlaps the hub port or the LAN port (even the DEFAULT range)", () => {
    const hub = normalizeHubProxyConfig({ portRange: [7900, 7949], maxProxies: 8 }, { hubPort: 7910 });
    expect(hub).toEqual({ ok: false, detail: expect.stringContaining("webHub.port") });
    const lan = normalizeHubProxyConfig({ portRange: [7900, 7949], maxProxies: 8 }, { hubPort: 7878, lanPort: 7949 });
    expect(lan).toEqual({ ok: false, detail: expect.stringContaining("webHub.lan.port") });
    // boundary: ports one outside are fine; port 0 (ephemeral) never overlaps
    expect(normalizeHubProxyConfig({ portRange: [7900, 7949] }, { hubPort: 7899, lanPort: 7950 }).ok).toBe(true);
    expect(normalizeHubProxyConfig({ portRange: [7900, 7949] }, { hubPort: 0 }).ok).toBe(true);
  });
});
