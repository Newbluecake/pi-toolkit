// web-hub plan §包 I: webHub.* settings block — parser tolerance + spec surface.
// Style follows memory-settings.test.ts.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  parseWebHubLanValidation,
  parseWebHubSettings,
} from "../../src/config/settings.js";
import {
  currentOf,
  defaultOf,
  isKnownSettingKey,
  parseSettingValue,
  SETTING_SPECS,
} from "../../src/config/setting-specs.js";

const defaults = DEFAULT_SETTINGS.webHub;
const lanDefaults = defaults.lan!;

describe("web-hub settings", () => {
  it("pins the defaults (plan 包 I: 5 keys, enabled=false; W3-LI 例外：补 lan 五键默认值)", () => {
    expect(defaults).toEqual({
      enabled: false,
      autoStart: true,
      port: 7878,
      idleExitMinutes: 10,
      nodeLoader: "",
      lan: { enabled: false, port: 7879, extraHosts: [], trustProxyFrom: [], externalOrigins: [] },
    });
  });

  it("loadSettings({}) carries webHub.enabled=false (default off, zero side effects)", () => {
    const s = loadSettings({});
    expect(s.webHub).toEqual(defaults);
    expect(s.webHub.enabled).toBe(false);
  });

  it("falls back for missing and non-object blocks", () => {
    for (const input of [undefined, null, 0, "nope", true, [], [1, 2]]) {
      expect(parseWebHubSettings(input)).toEqual(defaults);
    }
    expect(parseWebHubSettings({})).toEqual(defaults);
  });

  it("tolerates garbage field-by-field and never throws", () => {
    expect(
      parseWebHubSettings({
        enabled: "yes",
        autoStart: 1,
        port: "7878",
        idleExitMinutes: "10",
        nodeLoader: 42,
      }),
    ).toEqual(defaults);
  });

  it("rejects out-of-range port / idleExitMinutes individually", () => {
    for (const port of [-1, 65_536, 3.14, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseWebHubSettings({ port }), `port=${String(port)}`).toEqual(defaults);
    }
    // port 0 (ephemeral) is legal
    expect(parseWebHubSettings({ port: 0 }).port).toBe(0);
    for (const idle of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseWebHubSettings({ idleExitMinutes: idle }), `idle=${String(idle)}`).toEqual(defaults);
    }
    // non-integer idle is allowed (finite ≥ 1), port must be an integer
    expect(parseWebHubSettings({ idleExitMinutes: 1.5 }).idleExitMinutes).toBe(1.5);
  });

  it("keeps valid fields while falling back the invalid ones", () => {
    expect(
      parseWebHubSettings({
        enabled: true,
        autoStart: false,
        port: 9000,
        idleExitMinutes: 30,
        nodeLoader: "/x/jiti.mjs",
      }),
    ).toEqual({
      enabled: true,
      autoStart: false,
      port: 9000,
      idleExitMinutes: 30,
      nodeLoader: "/x/jiti.mjs",
      lan: lanDefaults,
    });
    expect(parseWebHubSettings({ enabled: true, port: -1 })).toEqual({ ...defaults, enabled: true });
  });

  it("is wired into loadSettings", () => {
    expect(loadSettings({ webHub: "invalid" }).webHub).toEqual(defaults);
    expect(loadSettings({ webHub: { enabled: true, port: 1 } }).webHub).toEqual({
      ...defaults,
      enabled: true,
      port: 1,
    });
  });

  it("exposes the five webHub.* keys in SETTING_SPECS, all non-live", () => {
    const keys = ["webHub.enabled", "webHub.autoStart", "webHub.port", "webHub.idleExitMinutes", "webHub.nodeLoader"];
    for (const key of keys) {
      expect(isKnownSettingKey(key), key).toBe(true);
      const spec = SETTING_SPECS[key]!;
      expect(spec.live, key).toBeUndefined();
      expect(spec.time, key).toBeUndefined();
      expect(currentOf(DEFAULT_SETTINGS, spec), key).not.toBe("(unset)");
    }
    expect(SETTING_SPECS["webHub.enabled"]).toMatchObject({ kind: "boolean", path: "webHub.enabled" });
    expect(SETTING_SPECS["webHub.autoStart"]).toMatchObject({ kind: "boolean", path: "webHub.autoStart" });
    expect(SETTING_SPECS["webHub.port"]).toMatchObject({
      kind: "number",
      path: "webHub.port",
      min: 0,
      max: 65_535,
      integer: true,
    });
    expect(SETTING_SPECS["webHub.idleExitMinutes"]).toMatchObject({
      kind: "number",
      path: "webHub.idleExitMinutes",
      min: 1,
    });
    expect(SETTING_SPECS["webHub.nodeLoader"]).toMatchObject({ kind: "string", path: "webHub.nodeLoader" });
    // defaults surfaced in the editor
    expect(defaultOf(SETTING_SPECS["webHub.port"]!)).toBe(7878);
  });

  // ── S1-W3 LI: webHub.lan.* (plan §9.1) ──────────────────────────────────

  describe("webHub.lan.*", () => {
    it("defaults to disabled with empty lists (lan-plan §9.1)", () => {
      expect(parseWebHubSettings({}).lan).toEqual(lanDefaults);
      expect(parseWebHubSettings(undefined).lan).toEqual(lanDefaults);
      expect(parseWebHubSettings({ lan: "nope" }).lan).toEqual(lanDefaults);
      expect(parseWebHubSettings({ lan: [] }).lan).toEqual(lanDefaults);
    });

    it("parses enabled + port, rejecting out-of-range/non-integer ports individually", () => {
      expect(parseWebHubSettings({ lan: { enabled: true } }).lan).toEqual({ ...lanDefaults, enabled: true });
      expect(parseWebHubSettings({ lan: { port: 8000 } }).lan.port).toBe(8000);
      for (const port of [0, -1, 65_536, 3.14, Number.NaN, "8000"]) {
        expect(parseWebHubSettings({ lan: { port } }).lan.port, `port=${String(port)}`).toBe(7879);
      }
    });

    it("lan.port must differ from webHub.port — collision falls back to the lan default", () => {
      expect(parseWebHubSettings({ port: 8000, lan: { port: 8000 } }).lan.port).toBe(7879);
      // no collision ⇒ kept
      expect(parseWebHubSettings({ port: 8000, lan: { port: 9000 } }).lan.port).toBe(9000);
    });

    it("splits + classifies extraHosts, dropping invalid tokens (never bad-config here)", () => {
      const parsed = parseWebHubSettings({
        lan: { extraHosts: "HUB.example.com, 192.168.1.5 , dev, 202507220006," },
      });
      expect(parsed.lan.extraHosts).toEqual(["hub.example.com", "192.168.1.5"]);
    });

    it("trustProxyFrom keeps only IPv4 literals (paired with externalOrigins so no mismatch trips)", () => {
      const parsed = parseWebHubSettings({
        lan: {
          trustProxyFrom: "127.0.0.1, hub.example.com, 192.168.1.10",
          externalOrigins: "https://hub.example.com",
        },
      });
      expect(parsed.lan.trustProxyFrom).toEqual(["127.0.0.1", "192.168.1.10"]);
    });

    it("externalOrigins keeps only https origins whose host clears classifyHostToken", () => {
      const parsed = parseWebHubSettings({
        lan: {
          trustProxyFrom: "127.0.0.1",
          externalOrigins: "https://hub.example.com, http://hub.example.com, https://dev, not-a-url",
        },
      });
      expect(parsed.lan.trustProxyFrom).toEqual(["127.0.0.1"]);
      expect(parsed.lan.externalOrigins).toEqual(["https://hub.example.com"]);
    });

    it("trustProxyFrom/externalOrigins must be set together — mismatch zeroes both (fail-closed)", () => {
      const onlyProxy = parseWebHubSettings({ lan: { trustProxyFrom: "127.0.0.1" } });
      expect(onlyProxy.lan.trustProxyFrom).toEqual([]);
      expect(onlyProxy.lan.externalOrigins).toEqual([]);
      const onlyOrigin = parseWebHubSettings({ lan: { externalOrigins: "https://hub.example.com" } });
      expect(onlyOrigin.lan.trustProxyFrom).toEqual([]);
      expect(onlyOrigin.lan.externalOrigins).toEqual([]);
      const both = parseWebHubSettings({
        lan: { trustProxyFrom: "127.0.0.1", externalOrigins: "https://hub.example.com" },
      });
      expect(both.lan.trustProxyFrom).toEqual(["127.0.0.1"]);
      expect(both.lan.externalOrigins).toEqual(["https://hub.example.com"]);
    });

    it("parseWebHubLanValidation surfaces invalidExtraHosts + proxyMismatch for status-line consumers", () => {
      const v = parseWebHubLanValidation({ extraHosts: "dev, 202507220006, a_b", trustProxyFrom: "127.0.0.1" }, 7878);
      expect(v.invalidExtraHosts).toEqual([
        { token: "dev", reason: "denylisted" },
        { token: "202507220006", reason: "numeric" },
        { token: "a_b", reason: "syntax" },
      ]);
      expect(v.proxyMismatch).toBe(true); // trustProxyFrom set, externalOrigins empty

      expect(parseWebHubLanValidation({}, 7878)).toEqual({ invalidExtraHosts: [], proxyMismatch: false });
    });

    it("loadSettings round-trips webHub.lan through the top-level parser", () => {
      const s = loadSettings({ webHub: { lan: { enabled: true, port: 9001, extraHosts: "a.local" } } });
      expect(s.webHub.lan).toEqual({
        enabled: true,
        port: 9001,
        extraHosts: ["a.local"],
        trustProxyFrom: [],
        externalOrigins: [],
      });
    });

    it("exposes the five webHub.lan.* keys in SETTING_SPECS, all non-live", () => {
      const keys = [
        "webHub.lan.enabled",
        "webHub.lan.port",
        "webHub.lan.extraHosts",
        "webHub.lan.trustProxyFrom",
        "webHub.lan.externalOrigins",
      ];
      for (const key of keys) {
        expect(isKnownSettingKey(key), key).toBe(true);
        const spec = SETTING_SPECS[key]!;
        expect(spec.live, key).toBeUndefined();
        expect(spec.time, key).toBeUndefined();
        expect(currentOf(DEFAULT_SETTINGS, spec), key).not.toBe("(unset)");
      }
      expect(SETTING_SPECS["webHub.lan.enabled"]).toMatchObject({ kind: "boolean", path: "webHub.lan.enabled" });
      expect(SETTING_SPECS["webHub.lan.port"]).toMatchObject({
        kind: "number",
        path: "webHub.lan.port",
        min: 1,
        max: 65_535,
        integer: true,
      });
      for (const key of ["webHub.lan.extraHosts", "webHub.lan.trustProxyFrom", "webHub.lan.externalOrigins"]) {
        expect(SETTING_SPECS[key], key).toMatchObject({ kind: "string", csv: true });
      }
      // csv display domain: array → comma-joined string, not the raw array/(unset)
      expect(defaultOf(SETTING_SPECS["webHub.lan.extraHosts"]!)).toBe("");
      expect(defaultOf(SETTING_SPECS["webHub.lan.port"]!)).toBe(7879);
    });

    it("parseSettingValue splits/trims csv input and round-trips through writeSetting-shaped output", () => {
      const spec = SETTING_SPECS["webHub.lan.extraHosts"]!;
      const parsed = parseSettingValue(spec, " a.local , 192.168.1.5 ,, b.local ");
      expect(parsed).toEqual({
        ok: true,
        stored: "a.local,192.168.1.5,b.local",
        live: ["a.local", "192.168.1.5", "b.local"],
      });
      // empty string clears the list (unlike a plain non-csv "string" spec, which rejects "")
      expect(parseSettingValue(spec, "")).toEqual({ ok: true, stored: "", live: [] });
      const currentValue = currentOf(
        {
          ...DEFAULT_SETTINGS,
          webHub: { ...DEFAULT_SETTINGS.webHub, lan: { ...lanDefaults, extraHosts: ["x.local"] } },
        },
        spec,
      );
      expect(currentValue).toBe("x.local");
    });
  });
});
