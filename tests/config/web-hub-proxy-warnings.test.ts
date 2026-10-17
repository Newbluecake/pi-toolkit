// web-hub-proxy X1c: `loadWebHubProxyWarnings` — the raw-block diagnostics `/webhub status` shows.
import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWebHubProxyWarnings } from "../../src/config/settings.js";

let path: string;
beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "pi-subagent-proxy-warn-")), "pi-subagent.json");
});
const put = (webHub: unknown) => writeFileSync(path, JSON.stringify({ webHub }), "utf8");

describe("loadWebHubProxyWarnings", () => {
  it("returns exactly the parseWebHubProxyBlock warnings off the raw file", () => {
    put({ proxy: { enabled: true, portRange: "nope", maxProxies: 99 } });
    expect(loadWebHubProxyWarnings(path)).toEqual(["port-range-invalid", "max-proxies-invalid"]);
  });

  it("overlap is judged against the RESOLVED hub port and the LAN port", () => {
    put({ port: 7910, proxy: { enabled: true, portRange: "7900-7949" } });
    expect(loadWebHubProxyWarnings(path)).toEqual(["port-range-overlap"]);
    put({ port: 7878, lan: { enabled: true, port: 7930 }, proxy: { enabled: true, portRange: "7900-7949" } });
    expect(loadWebHubProxyWarnings(path)).toEqual(["port-range-overlap"]);
    put({ port: 7878, proxy: { enabled: true, portRange: "7900-7949" } });
    expect(loadWebHubProxyWarnings(path)).toEqual([]);
  });

  it("missing file / malformed JSON / missing or malformed blocks ⇒ [] (never throws)", () => {
    expect(loadWebHubProxyWarnings(path)).toEqual([]);
    writeFileSync(path, "not json", "utf8");
    expect(loadWebHubProxyWarnings(path)).toEqual([]);
    put("nope");
    expect(loadWebHubProxyWarnings(path)).toEqual([]);
    put({ port: 1 });
    expect(loadWebHubProxyWarnings(path)).toEqual([]);
    put({ proxy: 5 });
    expect(loadWebHubProxyWarnings(path)).toEqual([]);
  });
});
