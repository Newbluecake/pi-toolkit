import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSettings,
  loadSettingsFromFile,
  readSettingsNoMigrate,
  DEFAULT_SETTINGS,
} from "../../src/config/settings.js";
import { parseWebHubTerminalBlock } from "../../src/web-hub/agent/settings.js";
import { SETTING_SPECS, defaultOf } from "../../src/config/setting-specs.js";

const key = Symbol.for("pi-subagent:secure-domain");
const globals = globalThis as Record<symbol, unknown>;
const saved = globals[key];
afterEach(() => {
  if (saved === undefined) delete globals[key];
  else globals[key] = saved;
});
describe("terminal sparse settings / D8 (§2.1–2.2)", () => {
  it("default/off raw settings and DEFAULT_SETTINGS remain sparse", () => {
    delete globals[key];
    expect(Object.hasOwn(loadSettings({}).webHub, "terminal")).toBe(false);
    expect(Object.hasOwn(DEFAULT_SETTINGS.webHub, "terminal")).toBe(false);
  });
  it("seconds boundary and non-live bounded specs", () => {
    delete globals[key];
    expect(
      loadSettings({ webHub: { terminal: { enabled: true, inputIdleS: 301, maxLifetimeS: 901 } } }).webHub.terminal,
    ).toEqual({
      enabled: true,
      maxPerSession: 2,
      maxPerPrincipal: 2,
      maxTotal: 8,
      inputIdleMs: 301000,
      maxLifetimeMs: 901000,
    });
    expect(defaultOf(SETTING_SPECS["webHub.terminal.inputIdleS"]!)).toBe(3600);
    expect(defaultOf(SETTING_SPECS["webHub.terminal.enabled"]!)).toBe(false);
    for (const [key, spec] of Object.entries(SETTING_SPECS).filter(([k]) => k.startsWith("webHub.terminal."))) {
      expect(spec.live, key).toBeUndefined();
    }
  });
  it("invalid finite/range/zero values return named warnings and safe defaults", () => {
    const { terminal, warnings } = parseWebHubTerminalBlock({
      enabled: "yes",
      maxTotal: Infinity,
      maxPerSession: 0,
      inputIdleMs: 0,
      maxLifetimeMs: 1,
    });
    expect(terminal).toMatchObject({
      enabled: false,
      maxTotal: 8,
      maxPerSession: 2,
      inputIdleMs: 3600000,
      maxLifetimeMs: 28800000,
    });
    expect(warnings.map((w) => w.key).sort()).toEqual(
      [
        "webHub.terminal.enabled",
        "webHub.terminal.inputIdleMs",
        "webHub.terminal.maxLifetimeMs",
        "webHub.terminal.maxPerSession",
        "webHub.terminal.maxTotal",
      ].sort(),
    );
  });
  it.each(["locked", "secure"])("%s forces explicit enabled false without default mutation", (kind) => {
    // Frozen-domain port fixture only: never mounts/probes a real vault.
    globals[key] =
      kind === "locked"
        ? { kind: "locked", reason: "test" }
        : { kind: "secure", vault: { name: "test", dir: "/owned-test-vault", mntReal: "/owned-test-vault/mnt" } };
    const before = JSON.stringify(DEFAULT_SETTINGS);
    expect(loadSettings({ webHub: { terminal: { enabled: true } } }).webHub.terminal?.enabled).toBe(false);
    expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(before);
    const dir = mkdtempSync(join(tmpdir(), "p1c-settings-"));
    try {
      const file = join(dir, "pi-toolkit.json"),
        raw = JSON.stringify({ webHub: { terminal: { enabled: true, inputIdleS: 3600 } } });
      writeFileSync(file, raw, { mode: 0o600 });
      expect(loadSettingsFromFile(file).webHub.terminal?.enabled).toBe(false);
      expect(readSettingsNoMigrate(file).webHub.terminal?.enabled).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(raw);
      expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
