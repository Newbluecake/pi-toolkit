/**
 * Contract test ⑪ (plan §11 表格) + `parseHubLanConfig` unit tests (§1.4.3,
 * §9.1). `parseHubLanConfig` lives in `hub/lan-config.ts` and is re-exported
 * from `hub/main.ts`; tests import the former directly — `hub/main.ts` runs
 * `void main()` at module scope (spawned-process entry point) and must never
 * be `import`ed from a test process (it would call `process.exit`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { checkLanPortConflict, parseHubLanConfig } from "../../../src/web-hub/hub/lan-config.js";
import { startHub, type RunningHub } from "../../../src/web-hub/hub/hub.js";
import type { FrontendDeps, FrontendFactory, HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { resolveHubPaths } from "../../../src/web-hub/protocol/paths.js";
import { config, tmpDirs } from "./helpers.js";

const tmp = tmpDirs();
const hubs: RunningHub[] = [];

afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close("test");
  tmp.cleanup();
});

function fakeFrontend(): FrontendFactory & { deps: FrontendDeps[] } {
  const f = ((deps: FrontendDeps): HttpFrontend => {
    f.deps.push(deps);
    return { listen: async () => ({ port: 40077 }), close: async () => {}, clientCount: () => 0 };
  }) as FrontendFactory & { deps: FrontendDeps[] };
  f.deps = [];
  return f;
}

describe("parseHubLanConfig (plan §1.4.3, §9.1)", () => {
  const valid = { port: 7879, extraHosts: [], trustProxyFrom: [], externalOrigins: [] };

  it("accepts a minimal valid config", () => {
    expect(parseHubLanConfig(valid)).toEqual({ ok: true, lan: valid });
  });

  it("lower-cases / canonicalizes extraHosts entries", () => {
    const r = parseHubLanConfig({ ...valid, extraHosts: ["MyHost.Local"] });
    expect(r).toEqual({ ok: true, lan: { ...valid, extraHosts: ["myhost.local"] } });
  });

  it("rejects a non-object", () => {
    expect(parseHubLanConfig(null).ok).toBe(false);
    expect(parseHubLanConfig("x").ok).toBe(false);
    expect(parseHubLanConfig([]).ok).toBe(false);
  });

  it("rejects an out-of-range port", () => {
    expect(parseHubLanConfig({ ...valid, port: 0 }).ok).toBe(false);
    expect(parseHubLanConfig({ ...valid, port: 70000 }).ok).toBe(false);
    expect(parseHubLanConfig({ ...valid, port: 1.5 }).ok).toBe(false);
  });

  it("rejects a numeric/denylisted extraHosts entry", () => {
    const numeric = parseHubLanConfig({ ...valid, extraHosts: ["202507220006"] });
    expect(numeric.ok).toBe(false);
    if (!numeric.ok) expect(numeric.detail).toContain("numeric");
    const denylisted = parseHubLanConfig({ ...valid, extraHosts: ["dev"] });
    expect(denylisted.ok).toBe(false);
    if (!denylisted.ok) expect(denylisted.detail).toContain("denylisted");
  });

  it("rejects a non-IPv4 trustProxyFrom entry", () => {
    const r = parseHubLanConfig({
      ...valid,
      trustProxyFrom: ["not-an-ip"],
      externalOrigins: ["https://hub.example.com"],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-https externalOrigins entry", () => {
    const r = parseHubLanConfig({
      ...valid,
      trustProxyFrom: ["127.0.0.1"],
      externalOrigins: ["http://hub.example.com"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("origin-not-https");
  });

  it("accepts a matched trustProxyFrom / externalOrigins pair", () => {
    const r = parseHubLanConfig({
      ...valid,
      trustProxyFrom: ["127.0.0.1"],
      externalOrigins: ["https://hub.example.com"],
    });
    expect(r).toEqual({
      ok: true,
      lan: { ...valid, trustProxyFrom: ["127.0.0.1"], externalOrigins: ["https://hub.example.com"] },
    });
  });

  it("rejects trustProxyFrom set without externalOrigins (proxy-config-mismatch)", () => {
    const r = parseHubLanConfig({ ...valid, trustProxyFrom: ["127.0.0.1"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("proxy-config-mismatch");
  });

  it("rejects externalOrigins set without trustProxyFrom (proxy-config-mismatch)", () => {
    const r = parseHubLanConfig({ ...valid, externalOrigins: ["https://hub.example.com"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("proxy-config-mismatch");
  });

  it("rejects a non-array extraHosts/trustProxyFrom/externalOrigins", () => {
    expect(parseHubLanConfig({ ...valid, extraHosts: "x" }).ok).toBe(false);
    expect(parseHubLanConfig({ ...valid, trustProxyFrom: "x" }).ok).toBe(false);
    expect(parseHubLanConfig({ ...valid, externalOrigins: "x" }).ok).toBe(false);
  });

  // 回审需求 #3（v2）: externalOrigins 的 host 部分再评 classifyHostToken，拒绝 numeric/denylisted/ipv6（§2.4）。
  // v1 修复曾误判 numeric 分支在这个验证函数里不可达（因为 `parseOrigin` 当时用 `new URL().host`
  // 取 host，而 WHATWG 会把裸数字单标签改写成真 IPv4（`new URL("https://123").host``
  // === "0.0.0.123"`）——这正是 v2 复审打回的 #1：该改写不仅让 numeric 分支不可达，还会让
  // `https://123` 被当作合法 IPv4 放行。修复后 `parseOrigin` 不再用 `new URL()` 取 host，而是用
  // 正则直接抽取原始 authority，classifyHostToken 现在能真正看到调用方写的原始数字串，
  // numeric 分支对此验证函数可达且必要。
  it("rejects numeric-host externalOrigins entries (decimal, hex, and short/two-part WHATWG-IPv4-rewritable forms)", () => {
    for (const h of ["123", "1", "0x7f", "1.2", "202507220006"]) {
      const r = parseHubLanConfig({ ...valid, trustProxyFrom: ["127.0.0.1"], externalOrigins: [`https://${h}`] });
      expect(r.ok, h).toBe(false);
      if (!r.ok) expect(r.detail, h).toContain("numeric");
    }
  });

  it("rejects a denylisted-host externalOrigins entry", () => {
    const r = parseHubLanConfig({ ...valid, trustProxyFrom: ["127.0.0.1"], externalOrigins: ["https://dev"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("denylisted");
  });

  it("still accepts fqdn / single-label / ipv4 / dot-local / localhost externalOrigins hosts", () => {
    for (const host of ["hub.example.com", "myhost", "192.168.1.5", "myhost.local", "localhost"]) {
      const r = parseHubLanConfig({ ...valid, trustProxyFrom: ["127.0.0.1"], externalOrigins: [`https://${host}`] });
      expect(r.ok, host).toBe(true);
    }
  });
});

// 回审需求 #2: main.ts 在 parseHubLanConfig 成功后另外校验 lan.port !== config.port（§9.1）。
describe("checkLanPortConflict (plan §9.1)", () => {
  const lan = { port: 7879, extraHosts: [], trustProxyFrom: [], externalOrigins: [] };

  it("accepts a lan.port that differs from the loopback port", () => {
    expect(checkLanPortConflict(lan, 8787)).toEqual({ ok: true });
  });

  it("rejects a lan.port equal to the loopback port", () => {
    const r = checkLanPortConflict(lan, 7879);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("must not equal webHub.port");
  });
});

describe("startHub: lanConfigError / lanAssembly stub (plan §1.4.2, §1.4.3, contract ⑪)", () => {
  it("deps.lanConfigError ⇒ hub.json.lan is off/bad-config and RunningHub.lan is undefined", async () => {
    const home = tmp.make("wh-lanconfig-");
    const fe = fakeFrontend();
    const hub = await startHub(config({ home }), fe, {
      uid: process.getuid?.() ?? 0,
      lanConfigError: { detail: "port[0]=99999999: out of range" },
    });
    if ("exists" in hub) throw new Error("unexpected exists");
    hubs.push(hub);
    expect(hub.lan).toBeUndefined();
    expect(hub.lanStatus()).toEqual({ state: "off", reason: "bad-config", detail: "port[0]=99999999: out of range" });
    expect(fe.deps[0]!.lan).toBeUndefined();
  });

  it("config.lan and deps.lanConfigError together is a caller contract violation (rejects, not silently ignored)", async () => {
    const home = tmp.make("wh-lanconfig-bad-");
    await expect(
      startHub(
        { ...config({ home }), lan: { port: 7879, extraHosts: [], trustProxyFrom: [], externalOrigins: [] } },
        fakeFrontend(),
        { uid: process.getuid?.() ?? 0, lanConfigError: { detail: "x" } },
      ),
    ).rejects.toThrow(/lanConfigError/);
    // nothing was bound
    const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
    expect(existsSync(paths.socketPath)).toBe(false);
  });

  it("a valid config.lan with the default (stub) lanAssembly ⇒ startHub rejects E_NOT_IMPLEMENTED:LD and cleans up", async () => {
    const home = tmp.make("wh-lanconfig-ld-");
    const uid = process.getuid?.() ?? 0;
    await expect(
      startHub(
        { ...config({ home }), lan: { port: 7879, extraHosts: [], trustProxyFrom: [], externalOrigins: [] } },
        fakeFrontend(),
        { uid },
      ),
    ).rejects.toThrow("E_NOT_IMPLEMENTED:LD");
    const paths = resolveHubPaths({ home, uid });
    expect(existsSync(paths.socketPath)).toBe(false); // singleton released on failure
    expect(existsSync(paths.hubJson)).toBe(false); // hub.json is never written before the LD step
    // restartable afterwards (proves the failed attempt didn't leak the socket/lock)
    const hub = await startHub(config({ home }), fakeFrontend(), { uid });
    if ("exists" in hub) throw new Error("unexpected exists");
    hubs.push(hub);
  });
});
