/** Pure formatter of `/webhub status`'s proxy lines (X1c). */
import { describe, expect, it } from "vitest";
import { formatProxyStatusLines, type FormatProxyStatusOptions } from "../../../src/web-hub/agent/proxy-status.js";

const base: FormatProxyStatusOptions = {
  settings: { enabled: true, portRange: "7900-7949", maxProxies: 8 },
  lan: false,
  control: true,
  warnings: [],
  hasHubRecord: true,
  portsFile: "/state/proxy/ports.json",
};

describe("formatProxyStatusLines", () => {
  it("off / undefined settings ⇒ silent regardless of everything else", () => {
    expect(formatProxyStatusLines({ portsStore: "broken" }, { ...base, settings: undefined })).toEqual([]);
    expect(
      formatProxyStatusLines({ portsStore: "broken" }, { ...base, settings: { ...base.settings!, enabled: false } }),
    ).toEqual([]);
  });

  it("healthy: the one compact English-token line (loopback | lan)", () => {
    expect(formatProxyStatusLines({ portsStore: "ok" }, base)).toEqual(["proxy: on · loopback · 7900-7949 · max 8"]);
    expect(formatProxyStatusLines({ portsStore: "ok" }, { ...base, lan: true })).toEqual([
      "proxy: on · lan · 7900-7949 · max 8",
    ]);
  });

  it("every settings warning gets its own prose line naming the fallback", () => {
    const lines = formatProxyStatusLines(
      { portsStore: "ok" },
      { ...base, warnings: ["port-range-invalid", "port-range-overlap", "max-proxies-invalid"] },
    );
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("格式无效");
    expect(lines[2]).toContain("重叠");
    expect(lines[3]).toContain("maxProxies");
    expect(lines.slice(1).every((l) => l.startsWith("warning："))).toBe(true);
  });

  it("hub record without a proxy slot ⇒ 未挂载 warning; no hub record ⇒ not reported (stopped hub)", () => {
    expect(formatProxyStatusLines(undefined, base)[1]).toContain("未挂载端口代理");
    expect(formatProxyStatusLines(undefined, { ...base, hasHubRecord: false })).toEqual([
      "proxy: on · loopback · 7900-7949 · max 8",
    ]);
  });

  it("broken ports store ⇒ recovery note with the file path, /webhub stop and the forget-bindings disclosure", () => {
    const lines = formatProxyStatusLines({ portsStore: "broken" }, base);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("/state/proxy/ports.json");
    expect(lines[1]).toContain("/webhub stop");
    expect(lines[1]).toContain("遗忘");
  });

  it("control:false ⇒ exactly one not-enabled warning", () => {
    const lines = formatProxyStatusLines({ portsStore: "ok" }, { ...base, control: false });
    expect(lines).toEqual([expect.stringContaining("control=false")]);
  });
});
