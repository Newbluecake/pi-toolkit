/**
 * traffic-merge plan §2.2/§6（T3）：`traffic.*` 设置组——默认值（enabled=false ⇒ 冻结面）、
 * 逐字段容错解析（web.host 两枚举、port 1024..65535）、secure/locked 域强制 enabled=false
 * （applySecureDomainOverrides 是两个文件加载入口的共同出口，各验一次）。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  loadSettingsFromFile,
  readSettingsNoMigrate,
} from "../../src/config/settings.js";
import { DEFAULT_TRAFFIC_SETTINGS, parseTrafficSettings } from "../../src/traffic/settings.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import { freezeDomain, makeFakeVault, type FakeVault } from "../secure/helpers.js";

let v: FakeVault | undefined;
afterEach(() => {
  resetSecureDomainForTests();
  v?.cleanup();
  v = undefined;
});

describe("traffic settings: defaults (§2.2)", () => {
  it("pins enabled=false (frozen face), childSessions=true (ruling ①), web 127.0.0.1:4177 (ruling ②)", () => {
    expect(DEFAULT_TRAFFIC_SETTINGS).toEqual({
      enabled: false,
      childSessions: true,
      web: { host: "127.0.0.1", port: 4177 },
    });
    expect(DEFAULT_SETTINGS.traffic).toEqual(DEFAULT_TRAFFIC_SETTINGS);
  });

  it("absent / malformed block ⇒ defaults, never throws", () => {
    for (const input of [undefined, null, 42, "x", [], {}])
      expect(parseTrafficSettings(input)).toEqual(DEFAULT_TRAFFIC_SETTINGS);
    expect(loadSettings({ traffic: "bogus" }).traffic).toEqual(DEFAULT_TRAFFIC_SETTINGS);
  });

  it("field-by-field fallback: only valid fields survive, the rest fall back", () => {
    expect(parseTrafficSettings({ enabled: true, childSessions: 1, web: { host: "0.0.0.0", port: "5000" } })).toEqual({
      enabled: true,
      childSessions: true, // invalid type ⇒ default
      web: { host: "0.0.0.0", port: 4177 }, // invalid port type ⇒ default
    });
    expect(parseTrafficSettings({ web: { port: 1023 } }).web.port).toBe(4177);
    expect(parseTrafficSettings({ web: { port: 65536 } }).web.port).toBe(4177);
    expect(parseTrafficSettings({ web: { port: 65535 } }).web.port).toBe(65535);
    expect(parseTrafficSettings({ web: { port: 1024 } }).web.port).toBe(1024);
    expect(parseTrafficSettings({ web: { host: "localhost" } }).web.host).toBe("127.0.0.1");
    expect(parseTrafficSettings({ childSessions: false }).childSessions).toBe(false);
  });
});

describe("traffic secure override (§6, T3)", () => {
  const USER = { traffic: { enabled: true, childSessions: false, web: { host: "0.0.0.0", port: 4321 } } };

  it("plain / no verdict ⇒ user settings pass through untouched", () => {
    expect(loadSettings(USER).traffic).toEqual(USER.traffic);
    v = makeFakeVault();
    freezeDomain(v, { cwd: v.outside });
    expect(loadSettings(USER).traffic).toEqual(USER.traffic);
  });

  it("secure ⇒ traffic.enabled=false; childSessions/web shape preserved (clone, not strip)", () => {
    v = makeFakeVault();
    freezeDomain(v);
    const s = loadSettings(USER);
    expect(s.traffic.enabled).toBe(false);
    expect(s.traffic.childSessions).toBe(false);
    expect(s.traffic.web).toEqual({ host: "0.0.0.0", port: 4321 });
    expect(s.traffic).not.toBe(DEFAULT_SETTINGS.traffic);
    expect(DEFAULT_SETTINGS.traffic.enabled).toBe(false); // never mutated
  });

  it("locked ⇒ traffic.enabled=false too (D8 pushes off)", () => {
    v = makeFakeVault();
    freezeDomain(v, { mountinfo: v.unmounted });
    expect(loadSettings(USER).traffic.enabled).toBe(false);
  });

  it("both file entry points (loadSettingsFromFile / readSettingsNoMigrate) are overridden", () => {
    v = makeFakeVault();
    const file = join(v.tmp, "user-settings.json");
    writeFileSync(file, JSON.stringify(USER));
    freezeDomain(v);
    for (const s of [loadSettingsFromFile(file), readSettingsNoMigrate(file)]) {
      expect(s.traffic.enabled).toBe(false);
      expect(s.traffic.web.port).toBe(4321);
    }
  });
});
