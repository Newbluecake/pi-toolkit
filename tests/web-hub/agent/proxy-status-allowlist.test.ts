/** LAN security §2.3 #3 (pkg A): proxy status marker when the hub allowlist also guards proxy listeners. */
import { describe, expect, it } from "vitest";
import { formatProxyStatusLines } from "../../../src/web-hub/agent/proxy-status.js";

const base = {
  settings: { enabled: true, portRange: "7900-7949", maxProxies: 8 },
  lan: true,
  control: true,
  warnings: [],
  hasHubRecord: true,
  portsFile: "/s/proxy/ports.json",
} as const;

describe("proxy status allowlist marker", () => {
  it("absent / false allowlistActive ⇒ byte-identical legacy line", () => {
    const legacy = formatProxyStatusLines({ portsStore: "ok" }, base);
    expect(legacy).toEqual(["proxy: on · lan · 7900-7949 · max 8"]);
    expect(formatProxyStatusLines({ portsStore: "ok" }, { ...base, allowlistActive: false })).toEqual(legacy);
  });
  it("LAN + active allowlist ⇒ ' · allowlist' on the first line only", () => {
    expect(formatProxyStatusLines({ portsStore: "ok" }, { ...base, allowlistActive: true })).toEqual([
      "proxy: on · lan · 7900-7949 · max 8 · allowlist",
    ]);
  });
  it("loopback-only proxy never claims an allowlist; off settings stay silent", () => {
    expect(formatProxyStatusLines({ portsStore: "ok" }, { ...base, lan: false, allowlistActive: true })[0]).toBe(
      "proxy: on · loopback · 7900-7949 · max 8",
    );
    expect(
      formatProxyStatusLines(undefined, {
        ...base,
        settings: { ...base.settings, enabled: false },
        allowlistActive: true,
      }),
    ).toEqual([]);
  });
});
