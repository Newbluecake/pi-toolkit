// web-hub plan §包 I: webHub.* settings block — parser tolerance + spec surface.
// Style follows memory-settings.test.ts.

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, parseWebHubSettings } from "../../src/config/settings.js";
import { currentOf, defaultOf, isKnownSettingKey, SETTING_SPECS } from "../../src/config/setting-specs.js";

const defaults = DEFAULT_SETTINGS.webHub;

describe("web-hub settings", () => {
  it("pins the defaults (plan 包 I: 5 keys, enabled=false)", () => {
    expect(defaults).toEqual({
      enabled: false,
      autoStart: true,
      port: 7878,
      idleExitMinutes: 10,
      nodeLoader: "",
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
    ).toEqual({ enabled: true, autoStart: false, port: 9000, idleExitMinutes: 30, nodeLoader: "/x/jiti.mjs" });
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
});
