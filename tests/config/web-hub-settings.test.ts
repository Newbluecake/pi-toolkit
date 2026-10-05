// web-hub plan §包 I: webHub.* settings block — parser tolerance + spec surface.
// Style follows memory-settings.test.ts.

import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  loadWebHubLanSettingsWarnings,
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
const spawnDefaults = defaults.spawn!;

describe("web-hub settings", () => {
  it("pins the defaults (plan 包 I: 5 keys, enabled=false; W3-LI 例外：补 lan 五键默认值; v2.1 control-plane: control/remoteAskUser/webCommands default true, webCommandPolicy {}; web-hub-spawn §SP2: 补 spawn 八键默认值)", () => {
    expect(defaults).toEqual({
      enabled: false,
      autoStart: true,
      port: 7878,
      idleExitMinutes: 10,
      nodeLoader: "",
      control: true,
      remoteAskUser: true,
      webCommands: true,
      webCommandPolicy: {},
      uploads: "on",
      preview: "on",
      lan: { enabled: false, port: 7879, extraHosts: [], trustProxyFrom: [], externalOrigins: [] },
      spawn: {
        enabled: false,
        roots: [],
        maxProcesses: 4,
        maxPerPrincipal: 2,
        ratePerMinute: 3,
        maxLifetimeMinutes: 720,
        registerTimeoutS: 30,
        lan: "off",
      },
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
      control: true,
      remoteAskUser: true,
      webCommands: true,
      webCommandPolicy: {},
      uploads: "on",
      preview: "on",
      lan: lanDefaults,
      spawn: spawnDefaults,
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

    it("list-valued LAN settings also accept JSON string arrays (hand-written settings.json form)", () => {
      const parsed = parseWebHubSettings({
        lan: {
          extraHosts: ["HUB.example.com", " 192.168.1.5 ", "dev", 42, "a.local, b.local"],
          trustProxyFrom: ["127.0.0.1"],
          externalOrigins: ["https://hub.example.com"],
        },
      });
      expect(parsed.lan.extraHosts).toEqual(["hub.example.com", "192.168.1.5", "a.local", "b.local"]);
      expect(parsed.lan.trustProxyFrom).toEqual(["127.0.0.1"]);
      expect(parsed.lan.externalOrigins).toEqual(["https://hub.example.com"]);
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

    describe("loadWebHubLanSettingsWarnings (LI wiring: src/index.ts → createWebHubCommand)", () => {
      let dir: string;
      let path: string;

      beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "pi-subagent-webhub-lan-warn-"));
        path = join(dir, "pi-subagent.json");
      });

      it("reads the same invalidExtraHosts/proxyMismatch off disk that parseWebHubLanValidation would compute", () => {
        writeFileSync(
          path,
          JSON.stringify({
            webHub: { port: 7878, lan: { extraHosts: "dev, 202507220006", trustProxyFrom: "127.0.0.1" } },
          }),
          "utf8",
        );
        expect(loadWebHubLanSettingsWarnings(path)).toEqual({
          invalidExtraHosts: [
            { token: "dev", reason: "denylisted" },
            { token: "202507220006", reason: "numeric" },
          ],
          proxyMismatch: true,
        });
      });

      it("defaults to empty warnings for a missing file, malformed JSON, or a missing/malformed webHub block", () => {
        const empty = { invalidExtraHosts: [], proxyMismatch: false };
        expect(loadWebHubLanSettingsWarnings(path)).toEqual(empty); // file doesn't exist
        writeFileSync(path, "not json", "utf8");
        expect(loadWebHubLanSettingsWarnings(path)).toEqual(empty);
        writeFileSync(path, JSON.stringify({ webHub: "nope" }), "utf8");
        expect(loadWebHubLanSettingsWarnings(path)).toEqual(empty);
        writeFileSync(path, JSON.stringify({ concurrencyLimit: 3 }), "utf8");
        expect(loadWebHubLanSettingsWarnings(path)).toEqual(empty);
      });

      it("resolves webHub.port the same way parseWebHubSettings does, so a lan.port collision with a custom webHub.port still falls back correctly", () => {
        writeFileSync(
          path,
          JSON.stringify({ webHub: { port: 9000, lan: { port: 9000, trustProxyFrom: "127.0.0.1" } } }),
          "utf8",
        );
        // lan.port === webHub.port ⇒ parseWebHubLanBlock falls back lan.port to its own default
        // internally; only trustProxyFrom-without-externalOrigins should surface as a warning here.
        expect(loadWebHubLanSettingsWarnings(path)).toEqual({ invalidExtraHosts: [], proxyMismatch: true });
      });
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

// v2.1 control-plane settings (plan §8): webHub.control / webHub.remoteAskUser /
// webHub.webCommands / webHub.webCommandPolicy — all non-live, activate-time snapshot.
describe("web-hub control-plane settings (plan §8)", () => {
  it("defaults: control/remoteAskUser/webCommands true, webCommandPolicy {}", () => {
    expect(defaults.control).toBe(true);
    expect(defaults.remoteAskUser).toBe(true);
    expect(defaults.webCommands).toBe(true);
    expect(defaults.webCommandPolicy).toEqual({});
  });

  it("parses explicit booleans and falls back to default for non-boolean garbage", () => {
    expect(parseWebHubSettings({ control: false }).control).toBe(false);
    expect(parseWebHubSettings({ remoteAskUser: false }).remoteAskUser).toBe(false);
    expect(parseWebHubSettings({ webCommands: false }).webCommands).toBe(false);
    for (const garbage of ["yes", 1, null, [], {}]) {
      expect(parseWebHubSettings({ control: garbage }).control, JSON.stringify(garbage)).toBe(true);
      expect(parseWebHubSettings({ remoteAskUser: garbage }).remoteAskUser, JSON.stringify(garbage)).toBe(true);
      expect(parseWebHubSettings({ webCommands: garbage }).webCommands, JSON.stringify(garbage)).toBe(true);
    }
  });

  it("webCommandPolicy accepts a plain object of name -> allow|confirm|deny", () => {
    const parsed = parseWebHubSettings({
      webCommandPolicy: { compact: "confirm", "webhub restart": "deny", reload: "allow" },
    });
    expect(parsed.webCommandPolicy).toEqual({ compact: "confirm", "webhub restart": "deny", reload: "allow" });
  });

  it("webCommandPolicy accepts a JSON-encoded string (TUI settings editor shape)", () => {
    const parsed = parseWebHubSettings({ webCommandPolicy: '{"compact":"confirm"}' });
    expect(parsed.webCommandPolicy).toEqual({ compact: "confirm" });
  });

  it("webCommandPolicy drops entries with an invalid name or a non-allow|confirm|deny value", () => {
    const parsed = parseWebHubSettings({
      webCommandPolicy: { "bad name!": "deny", ok: "maybe", good: "allow" },
    });
    expect(parsed.webCommandPolicy).toEqual({ good: "allow" });
  });

  it("webCommandPolicy falls back to {} for non-object / unparseable-JSON input", () => {
    for (const garbage of ["not json", 42, null, [], true]) {
      expect(parseWebHubSettings({ webCommandPolicy: garbage }).webCommandPolicy, JSON.stringify(garbage)).toEqual({});
    }
  });

  it("exposes all four keys in SETTING_SPECS, none live", () => {
    for (const key of ["webHub.control", "webHub.remoteAskUser", "webHub.webCommands", "webHub.webCommandPolicy"]) {
      expect(isKnownSettingKey(key), key).toBe(true);
      const spec = SETTING_SPECS[key]!;
      expect(spec.live, key).toBeUndefined();
    }
    expect(SETTING_SPECS["webHub.control"]).toMatchObject({ kind: "boolean", path: "webHub.control" });
    expect(SETTING_SPECS["webHub.remoteAskUser"]).toMatchObject({ kind: "boolean", path: "webHub.remoteAskUser" });
    expect(SETTING_SPECS["webHub.webCommands"]).toMatchObject({ kind: "boolean", path: "webHub.webCommands" });
    expect(SETTING_SPECS["webHub.webCommandPolicy"]).toMatchObject({
      kind: "string",
      path: "webHub.webCommandPolicy",
    });
  });

  it("is wired into loadSettings", () => {
    const s = loadSettings({ webHub: { control: false, webCommandPolicy: { compact: "deny" } } });
    expect(s.webHub.control).toBe(false);
    expect(s.webHub.webCommandPolicy).toEqual({ compact: "deny" });
    expect(s.webHub.remoteAskUser).toBe(true);
    expect(s.webHub.webCommands).toBe(true);
  });
});

// web-hub-upload plan §6 U1: webHub.uploads is tri-valued ("on" | "loopback" | "off"), default "on".
describe("webHub.uploads (web-hub-upload plan §6 U1)", () => {
  it('defaults to "on"', () => {
    expect(defaults.uploads).toBe("on");
    expect(parseWebHubSettings({}).uploads).toBe("on");
    expect(parseWebHubSettings(undefined).uploads).toBe("on");
  });

  it("accepts each of the three valid values", () => {
    expect(parseWebHubSettings({ uploads: "on" }).uploads).toBe("on");
    expect(parseWebHubSettings({ uploads: "loopback" }).uploads).toBe("loopback");
    expect(parseWebHubSettings({ uploads: "off" }).uploads).toBe("off");
  });

  it('falls back to "on" for any invalid value, never throwing', () => {
    for (const garbage of ["ON", "Loopback", "yes", 1, true, null, undefined, [], {}, ""]) {
      expect(parseWebHubSettings({ uploads: garbage }).uploads, JSON.stringify(garbage)).toBe("on");
    }
  });

  it("is wired into loadSettings", () => {
    expect(loadSettings({ webHub: { uploads: "loopback" } }).webHub.uploads).toBe("loopback");
    expect(loadSettings({ webHub: { uploads: "bogus" } }).webHub.uploads).toBe("on");
  });

  it("exposes webHub.uploads in SETTING_SPECS as a non-live enum", () => {
    expect(isKnownSettingKey("webHub.uploads")).toBe(true);
    const spec = SETTING_SPECS["webHub.uploads"]!;
    expect(spec.live).toBeUndefined();
    expect(spec).toMatchObject({ kind: "enum", path: "webHub.uploads", values: ["on", "loopback", "off"] });
    expect(defaultOf(spec)).toBe("on");
  });
});

// web-hub-preview plan v3 §4.1/U1 (PV1): webHub.preview is tri-valued like webHub.uploads,
// default "on" (U1 — user ruling 2026-10-05, risk explicitly accepted per plan §5.1).
describe("webHub.preview (web-hub-preview plan v3 §4.1/U1)", () => {
  it('defaults to "on" (U1)', () => {
    expect(defaults.preview).toBe("on");
    expect(parseWebHubSettings({}).preview).toBe("on");
    expect(parseWebHubSettings(undefined).preview).toBe("on");
  });

  it("accepts each of the three valid values", () => {
    expect(parseWebHubSettings({ preview: "on" }).preview).toBe("on");
    expect(parseWebHubSettings({ preview: "loopback" }).preview).toBe("loopback");
    expect(parseWebHubSettings({ preview: "off" }).preview).toBe("off");
  });

  it('falls back to "on" for any invalid value, never throwing', () => {
    for (const garbage of ["ON", "Loopback", "lan", "yes", 1, true, null, undefined, [], {}, ""]) {
      expect(parseWebHubSettings({ preview: garbage }).preview, JSON.stringify(garbage)).toBe("on");
    }
  });

  it("is wired into loadSettings", () => {
    expect(loadSettings({ webHub: { preview: "loopback" } }).webHub.preview).toBe("loopback");
    expect(loadSettings({ webHub: { preview: "off" } }).webHub.preview).toBe("off");
    expect(loadSettings({ webHub: { preview: "bogus" } }).webHub.preview).toBe("on");
  });

  it("exposes webHub.preview in SETTING_SPECS as a non-live enum carrying the restart + loopback notes", () => {
    expect(isKnownSettingKey("webHub.preview")).toBe(true);
    const spec = SETTING_SPECS["webHub.preview"]!;
    expect(spec.live).toBeUndefined();
    expect(spec).toMatchObject({ kind: "enum", path: "webHub.preview", values: ["on", "loopback", "off"] });
    expect(defaultOf(spec)).toBe("on");
    // plan PV1: 设置说明必须写明 — 修改后需要 /reload 再 /webhub restart；
    // LAN 上若有其他使用者建议 loopback（§5.1/U1 的缓解提示）
    expect(spec.description).toContain("/reload then /webhub restart");
    expect(spec.description).toContain("loopback if others use your LAN");
  });
});

// web-hub-spawn plan §SP2 / arch v2 §6.2: webHub.spawn.* — default off, tolerant per-field parse
// (numeric clamps, root-entry drop), eight spec keys, all non-live.
describe("webHub.spawn.* (web-hub-spawn plan §SP2 / arch §6.2)", () => {
  it("defaults: enabled=false, empty roots, arch §6.2 numeric defaults, lan off", () => {
    expect(spawnDefaults).toEqual({
      enabled: false,
      roots: [],
      maxProcesses: 4,
      maxPerPrincipal: 2,
      ratePerMinute: 3,
      maxLifetimeMinutes: 720,
      registerTimeoutS: 30,
      lan: "off",
    });
    expect(parseWebHubSettings({}).spawn).toEqual(spawnDefaults);
    expect(parseWebHubSettings(undefined).spawn).toEqual(spawnDefaults);
    // non-object spawn blocks fall back wholesale, never throw
    for (const garbage of [null, 0, "nope", true, [], ["/x"]]) {
      expect(parseWebHubSettings({ spawn: garbage }).spawn, JSON.stringify(garbage)).toEqual(spawnDefaults);
    }
  });

  it("enabled: keeps a real boolean, falls back to false for anything else", () => {
    expect(parseWebHubSettings({ spawn: { enabled: true } }).spawn?.enabled).toBe(true);
    for (const garbage of ["yes", 1, null, undefined, []]) {
      expect(parseWebHubSettings({ spawn: { enabled: garbage } }).spawn?.enabled, JSON.stringify(garbage)).toBe(false);
    }
  });

  it("roots: accepts both the CSV string and the JSON array form (splitLanCsv 同源)", () => {
    expect(parseWebHubSettings({ spawn: { roots: "~/a, /srv/b ,~/c" } }).spawn?.roots).toEqual([
      "~/a",
      "/srv/b",
      "~/c",
    ]);
    expect(parseWebHubSettings({ spawn: { roots: ["/srv/b", "~/a"] } }).spawn?.roots).toEqual(["/srv/b", "~/a"]);
    // arrays may themselves carry commas (settings-editor stored form)
    expect(parseWebHubSettings({ spawn: { roots: ["/a,/b"] } }).spawn?.roots).toEqual(["/a", "/b"]);
  });

  it("roots: drops entries that are not / or ~ prefixed, contain NUL, or exceed 4096 bytes", () => {
    expect(parseWebHubSettings({ spawn: { roots: ["relative", "~/ok", "C:\\win", "/abs", ""] } }).spawn?.roots).toEqual(
      ["~/ok", "/abs"],
    );
    expect(parseWebHubSettings({ spawn: { roots: ["/a\0b"] } }).spawn?.roots).toEqual([]);
    expect(parseWebHubSettings({ spawn: { roots: ["/" + "x".repeat(4096)] } }).spawn?.roots).toEqual([]); // 4097 bytes
    expect(parseWebHubSettings({ spawn: { roots: "/" + "x".repeat(4096) } }).spawn?.roots).toEqual([]);
    // exactly 4096 bytes still passes
    expect(parseWebHubSettings({ spawn: { roots: ["/" + "x".repeat(4095)] } }).spawn?.roots).toEqual([
      "/" + "x".repeat(4095),
    ]);
  });

  it("roots: keeps at most 16 entries (first 16 of the valid ones)", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `/r${String(i)}`);
    const roots = parseWebHubSettings({ spawn: { roots: twenty } }).spawn?.roots;
    expect(roots).toHaveLength(16);
    expect(roots?.[0]).toBe("/r0");
    expect(roots?.[15]).toBe("/r15");
  });

  it("numeric fields clamp into arch §6.2's ranges (round, then clamp; never throw)", () => {
    const s = parseWebHubSettings({
      spawn: {
        maxProcesses: 99, // -> 16
        maxPerPrincipal: 0, // -> 1
        ratePerMinute: 2.6, // round -> 3
        maxLifetimeMinutes: 5, // -> 10
        registerTimeoutS: 1e6, // -> 120
      },
    }).spawn!;
    expect(s.maxProcesses).toBe(16);
    expect(s.maxPerPrincipal).toBe(1);
    expect(s.ratePerMinute).toBe(3);
    expect(s.maxLifetimeMinutes).toBe(10);
    expect(s.registerTimeoutS).toBe(120);
    // mid-range values pass through untouched
    const mid = parseWebHubSettings({
      spawn: { maxProcesses: 8, maxPerPrincipal: 3, ratePerMinute: 10, maxLifetimeMinutes: 1440, registerTimeoutS: 60 },
    }).spawn!;
    expect(mid.maxProcesses).toBe(8);
    expect(mid.maxPerPrincipal).toBe(3);
    expect(mid.ratePerMinute).toBe(10);
    expect(mid.maxLifetimeMinutes).toBe(1440);
    expect(mid.registerTimeoutS).toBe(60);
  });

  it("numeric fields fall back to defaults for non-finite / non-number garbage", () => {
    for (const garbage of ["4", NaN, Infinity, -Infinity, null, undefined, [], {}]) {
      const s = parseWebHubSettings({ spawn: { maxProcesses: garbage } }).spawn!;
      expect(s.maxProcesses, JSON.stringify(garbage)).toBe(spawnDefaults.maxProcesses);
    }
  });

  it("lan: keeps off/known/roots, anything else falls back to off", () => {
    expect(parseWebHubSettings({ spawn: { lan: "known" } }).spawn?.lan).toBe("known");
    expect(parseWebHubSettings({ spawn: { lan: "roots" } }).spawn?.lan).toBe("roots");
    for (const garbage of ["OFF", "any", 42, null, undefined, true, []]) {
      expect(parseWebHubSettings({ spawn: { lan: garbage } }).spawn?.lan, JSON.stringify(garbage)).toBe("off");
    }
  });

  it("is wired into loadSettings and round-trips a full block", () => {
    const s = loadSettings({
      webHub: {
        spawn: {
          enabled: true,
          roots: "~/proj",
          maxProcesses: 6,
          maxPerPrincipal: 2,
          ratePerMinute: 5,
          maxLifetimeMinutes: 1440,
          registerTimeoutS: 45,
          lan: "known",
        },
      },
    }).webHub.spawn;
    expect(s).toEqual({
      enabled: true,
      roots: ["~/proj"],
      maxProcesses: 6,
      maxPerPrincipal: 2,
      ratePerMinute: 5,
      maxLifetimeMinutes: 1440,
      registerTimeoutS: 45,
      lan: "known",
    });
  });

  it("exposes the eight webHub.spawn.* keys in SETTING_SPECS, all non-live", () => {
    const keys = [
      "webHub.spawn.enabled",
      "webHub.spawn.roots",
      "webHub.spawn.maxProcesses",
      "webHub.spawn.maxPerPrincipal",
      "webHub.spawn.ratePerMinute",
      "webHub.spawn.maxLifetimeMinutes",
      "webHub.spawn.registerTimeoutS",
      "webHub.spawn.lan",
    ];
    for (const key of keys) {
      expect(isKnownSettingKey(key), key).toBe(true);
      const spec = SETTING_SPECS[key]!;
      expect(spec.live, key).toBeUndefined();
      expect(spec.time, key).toBeUndefined();
      expect(currentOf(DEFAULT_SETTINGS, spec), key).not.toBe("(unset)");
    }
    expect(SETTING_SPECS["webHub.spawn.enabled"]).toMatchObject({ kind: "boolean", path: "webHub.spawn.enabled" });
    expect(SETTING_SPECS["webHub.spawn.roots"]).toMatchObject({
      kind: "string",
      csv: true,
      path: "webHub.spawn.roots",
    });
    // numeric knobs: editor bounds aligned with parseWebHubSpawnBlock's clamps
    expect(SETTING_SPECS["webHub.spawn.maxProcesses"]).toMatchObject({
      kind: "number",
      path: "webHub.spawn.maxProcesses",
      min: 1,
      max: 16,
      integer: true,
    });
    expect(SETTING_SPECS["webHub.spawn.maxPerPrincipal"]).toMatchObject({ min: 1, max: 16 });
    expect(SETTING_SPECS["webHub.spawn.ratePerMinute"]).toMatchObject({ min: 1, max: 30 });
    expect(SETTING_SPECS["webHub.spawn.maxLifetimeMinutes"]).toMatchObject({ min: 10, max: 10_080 });
    expect(SETTING_SPECS["webHub.spawn.registerTimeoutS"]).toMatchObject({ min: 10, max: 120 });
    expect(SETTING_SPECS["webHub.spawn.lan"]).toMatchObject({
      kind: "enum",
      path: "webHub.spawn.lan",
      values: ["off", "known", "roots"],
    });
    // defaults surfaced in the editor (csv array → joined string)
    expect(defaultOf(SETTING_SPECS["webHub.spawn.roots"]!)).toBe("");
    expect(defaultOf(SETTING_SPECS["webHub.spawn.maxProcesses"]!)).toBe(4);
    expect(defaultOf(SETTING_SPECS["webHub.spawn.lan"]!)).toBe("off");
    // every description notes the /reload + /webhub restart dance (plan §SP2)
    for (const key of keys) {
      expect(SETTING_SPECS[key]!.description, key).toContain("/webhub restart");
    }
  });

  it("parseSettingValue round-trips csv roots input through the stored/live split", () => {
    const spec = SETTING_SPECS["webHub.spawn.roots"]!;
    const parsed = parseSettingValue(spec, " ~/a , /srv/b ,,");
    expect(parsed).toEqual({ ok: true, stored: "~/a,/srv/b", live: ["~/a", "/srv/b"] });
    expect(parseSettingValue(spec, "")).toEqual({ ok: true, stored: "", live: [] });
  });
});
