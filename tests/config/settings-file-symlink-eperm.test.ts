// settings-rename P2 (T-MG6 ②, the symlink-EPERM leg): on a filesystem that cannot create the compat
// symlink, a write over a crash-window S6a heals by stepping back to S1 and the content lands in LEGACY —
// still never S6b. `symlinkSync` is faulted through a node:fs mock (the heal lives in settings-lock.ts and
// imports it by name), sandbox HOME only.
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ symlink: false }));
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  return {
    ...orig,
    default: orig,
    symlinkSync: (...args: Parameters<typeof orig.symlinkSync>) => {
      if (fault.symlink) throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      return orig.symlinkSync(...args);
    },
  };
});

const { persistSettingOverride, loadSettingsFromFile, defaultSettingsPath } =
  await import("../../src/config/settings.js");
const { resolveSettingsFile } = await import("../../src/secure/settings-lock.js");
const { sandboxHome } = await import("../integration/helpers/home-sandbox.js");

let sandbox: ReturnType<typeof sandboxHome>;
let agent: string;
beforeEach(() => {
  sandbox = sandboxHome();
  agent = join(realpathSync(sandbox.home), ".pi", "agent");
  mkdirSync(agent, { recursive: true });
  fault.symlink = true;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  fault.symlink = false;
  vi.restoreAllMocks();
  sandbox.restore();
});

const arrange = () => {
  writeFileSync(join(agent, "pi-toolkit.json"), JSON.stringify({ a: 1 }), { mode: 0o600 });
  linkSync(join(agent, "pi-toolkit.json"), join(agent, "pi-subagent.json")); // S6a
};

describe("write over S6a on a filesystem without symlinks", () => {
  it("persistSettingOverride: reverts to S1 and writes the legacy file", () => {
    arrange();
    expect(persistSettingOverride("budget.idleS", 33)).toBeUndefined();
    expect(resolveSettingsFile(agent)).toMatchObject({ kind: "legacy", legacyType: "file" });
    expect(existsSync(join(agent, "pi-toolkit.json"))).toBe(false);
    expect(lstatSync(join(agent, "pi-subagent.json")).isFile()).toBe(true);
    const j = JSON.parse(readFileSync(join(agent, "pi-subagent.json"), "utf8"));
    expect(j.budget.idleS).toBe(33);
    expect(j.a).toBe(1);
    expect(defaultSettingsPath()).toBe(join(agent, "pi-subagent.json"));
  });
  it("ms→s write-back: steps back to S1 (never S6b), postpones the rewrite; the retry at the resolved path lands", () => {
    writeFileSync(join(agent, "pi-toolkit.json"), JSON.stringify({ budget: { idleMs: 90_000 } }), { mode: 0o600 });
    linkSync(join(agent, "pi-toolkit.json"), join(agent, "pi-subagent.json"));
    loadSettingsFromFile(join(agent, "pi-toolkit.json"));
    expect(resolveSettingsFile(agent)).toMatchObject({ kind: "legacy", legacyType: "file" });
    expect(JSON.parse(readFileSync(join(agent, "pi-subagent.json"), "utf8")).budget.idleMs).toBe(90_000);
    // next activate: defaultSettingsPath() now resolves LEGACY, and the same rewrite succeeds there
    loadSettingsFromFile(defaultSettingsPath());
    const j = JSON.parse(readFileSync(join(agent, "pi-subagent.json"), "utf8"));
    expect(j.budget.idleS).toBe(90);
    expect(j.budget.idleMs).toBeUndefined();
    expect(resolveSettingsFile(agent)).toMatchObject({ kind: "legacy", legacyType: "file" });
  });
});
