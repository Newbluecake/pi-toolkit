import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSessionFileInDomain,
  canonicalPath,
  computeSecureDomain,
  getSecureDomain,
  initSecureDomain,
  resetSecureDomainForTests,
  secureChildSessionDir,
  secureStatePaths,
} from "../../src/secure/domain.js";
import { secureGuardsNeeded } from "../../src/secure/guards.js";
import { renderSecureStatus, secureCommandWanted } from "../../src/secure/command.js";
import { freezeDomain, makeFakeVault, mountLine, type FakeVault } from "./helpers.js";

let v: FakeVault | undefined;
afterEach(() => {
  resetSecureDomainForTests();
  v?.cleanup();
  v = undefined;
});

function judge(fv: FakeVault, over: { cwd?: string; env?: Record<string, string>; mountinfo?: string } = {}) {
  return computeSecureDomain({
    env: over.env ?? {},
    cwd: over.cwd ?? fv.work,
    home: fv.home,
    settingsPath: fv.settingsPath,
    readMountinfo: () => over.mountinfo ?? fv.mounted,
  });
}

describe("domain judgment matrix (plan §2.4 step 1)", () => {
  it("no settings file ⇒ plain without vaults ⇒ zero guard wiring", () => {
    v = makeFakeVault();
    const d = computeSecureDomain({ env: {}, cwd: v.work, home: v.home, settingsPath: join(v.tmp, "missing.json") });
    expect(d.kind).toBe("plain");
    expect(d.vaults).toEqual([]);
    expect(d.config.present).toBe(false);
    expect(secureGuardsNeeded(d)).toBe(false);
  });

  it("cwd inside a mounted vault ⇒ secure (via cwd)", () => {
    v = makeFakeVault();
    const d = judge(v, { cwd: join(v.work, "sub") });
    expect(d.kind).toBe("secure");
    if (d.kind === "secure") {
      expect(d.via).toBe("cwd");
      expect(d.vault.vault.name).toBe("acme");
    }
  });

  it("cwd reached through the ~/secure/<name> entry link ⇒ secure", () => {
    v = makeFakeVault();
    expect(judge(v, { cwd: join(v.link, "sub") }).kind).toBe("secure");
  });

  it("cwd inside the vault but not mounted ⇒ locked", () => {
    v = makeFakeVault();
    const d = judge(v, { mountinfo: v.unmounted });
    expect(d.kind).toBe("locked");
    if (d.kind === "locked") expect(d.reason).toContain("未挂载");
  });

  it("a foreign filesystem on the mount point ⇒ locked", () => {
    v = makeFakeVault();
    const d = judge(v, { mountinfo: mountLine(join(v.dir, "mnt"), "tmpfs", "tmpfs") });
    expect(d.kind).toBe("locked");
  });

  it("mountinfo says mounted but <state> is still the sentinel file ⇒ locked (plugin-side defence)", () => {
    v = makeFakeVault({ stateIsSentinel: true });
    const d = judge(v);
    expect(d.kind).toBe("locked");
    if (d.kind === "locked") expect(d.reason).toContain("state");
  });

  it("cwd outside every vault ⇒ plain, vaults kept for D4", () => {
    v = makeFakeVault();
    const d = judge(v, { cwd: v.outside });
    expect(d.kind).toBe("plain");
    expect(d.vaults.map((x) => x.vault.name)).toEqual(["acme"]);
    expect(secureGuardsNeeded(d)).toBe(true);
  });

  it("PI_SECURE_VAULT selects the vault even from another cwd", () => {
    v = makeFakeVault();
    const d = judge(v, { cwd: v.outside, env: { PI_SECURE_VAULT: "acme" } });
    expect(d.kind).toBe("secure");
    if (d.kind === "secure") expect(d.via).toBe("env");
  });

  it("PI_SECURE_VAULT naming an unknown vault ⇒ locked", () => {
    v = makeFakeVault();
    const d = judge(v, { cwd: v.outside, env: { PI_SECURE_VAULT: "nope" } });
    expect(d.kind).toBe("locked");
    if (d.kind === "locked") expect(d.reason).toContain("nope");
  });

  it("PI_SECURE_VAULT with secure.enabled=false or a broken section ⇒ locked (fail closed)", () => {
    v = makeFakeVault();
    writeFileSync(v.settingsPath, JSON.stringify({ secure: { enabled: false, vaults: { acme: { dir: v.dir } } } }));
    expect(judge(v, { env: { PI_SECURE_VAULT: "acme" } }).kind).toBe("locked");
    writeFileSync(v.settingsPath, JSON.stringify({ secure: { vaults: [] } }));
    expect(judge(v, { env: { PI_SECURE_VAULT: "acme" } }).kind).toBe("locked");
  });

  it("secure.enabled=false without env ⇒ plain, no vaults (no guards)", () => {
    v = makeFakeVault();
    writeFileSync(v.settingsPath, JSON.stringify({ secure: { enabled: false, vaults: { acme: { dir: v.dir } } } }));
    const d = judge(v);
    expect(d.kind).toBe("plain");
    expect(d.vaults).toEqual([]);
  });

  it("security review #2: corrupt JSON ⇒ enabled-but-invalid section (not a silent plain): guards + /secure wired", () => {
    v = makeFakeVault();
    writeFileSync(v.settingsPath, "{oops");
    const d = judge(v);
    expect(d.kind).toBe("plain");
    expect(d.vaults).toEqual([]);
    expect(d.config).toMatchObject({ present: true, enabled: true, valid: false });
    expect(d.config.error).toContain("JSON");
    expect(secureGuardsNeeded(d)).toBe(true);
    expect(secureCommandWanted(d)).toBe(true);
    expect(judge(v, { env: { PI_SECURE_VAULT: "acme" } }).kind).toBe("locked");
  });

  it("security review #2: an unreadable settings file is invalid too", () => {
    v = makeFakeVault();
    mkdirSync(join(v.tmp, "dir-settings.json"));
    const d = computeSecureDomain({
      env: {},
      cwd: v.work,
      home: v.home,
      settingsPath: join(v.tmp, "dir-settings.json"),
    });
    expect(d.config).toMatchObject({ present: true, valid: false });
    expect(d.config.error).toContain("EISDIR");
  });

  it("security review #2: initSecureDomain warns once for a broken section, never for a missing file", () => {
    v = makeFakeVault();
    writeFileSync(v.settingsPath, "{oops");
    const warn: string[] = [];
    const deps = {
      env: {},
      cwd: v.outside,
      home: v.home,
      settingsPath: v.settingsPath,
      warn: (m: string) => warn.push(m),
    };
    resetSecureDomainForTests();
    initSecureDomain(deps);
    initSecureDomain(deps); // frozen: no second warning
    expect(warn.length).toBe(1);
    expect(warn[0]).toContain("/secure status");
    resetSecureDomainForTests();
    const quiet: string[] = [];
    initSecureDomain({ ...deps, settingsPath: join(v.tmp, "missing.json"), warn: (m: string) => quiet.push(m) });
    expect(quiet).toEqual([]);
  });
});

describe("initSecureDomain freezes once and redirects env (plan §2.4 step 1)", () => {
  it("secure: TMPDIR / ARMORY_MEMORY_ROOT / PI_SECURE_* set, ORIG recorded, tmp dir created", () => {
    v = makeFakeVault();
    const { domain, env } = freezeDomain(v, { env: { TMPDIR: "/tmp/orig", HOME: v.home } });
    expect(domain.kind).toBe("secure");
    expect(env.TMPDIR).toBe(join(v.state, "tmp"));
    expect(env.ARMORY_MEMORY_ROOT).toBe(join(v.state, "memory"));
    expect(env.PI_SECURE_SESSION).toBe("1");
    expect(env.PI_SECURE_VAULT).toBe("acme");
    expect(JSON.parse(env.PI_SECURE_ORIG_ENV!)).toEqual({ TMPDIR: "/tmp/orig", ARMORY_MEMORY_ROOT: null });
    expect(existsSync(join(v.state, "tmp"))).toBe(true);
  });

  it("an ORIG written by the launcher is never overwritten", () => {
    v = makeFakeVault();
    const orig = JSON.stringify({ TMPDIR: "/launcher/tmp", ARMORY_MEMORY_ROOT: "/m" });
    const { env } = freezeDomain(v, {
      env: { PI_SECURE_ORIG_ENV: orig, TMPDIR: join(v.state, "tmp"), PI_SECURE_VAULT: "acme" },
    });
    expect(env.PI_SECURE_ORIG_ENV).toBe(orig);
  });

  it("plain and locked verdicts leave the env object untouched", () => {
    v = makeFakeVault();
    const plainEnv = { TMPDIR: "/t" };
    freezeDomain(v, { cwd: v.outside, env: plainEnv });
    expect(plainEnv).toEqual({ TMPDIR: "/t" });
    const lockedEnv = { TMPDIR: "/t" };
    freezeDomain(v, { env: lockedEnv, mountinfo: v.unmounted });
    expect(lockedEnv).toEqual({ TMPDIR: "/t" });
  });

  it("second call returns the frozen verdict (child sessions / reload) without re-mutating env", () => {
    v = makeFakeVault();
    const { domain } = freezeDomain(v);
    const env2: Record<string, string | undefined> = {};
    const again = initSecureDomain({ env: env2, cwd: v.outside, home: v.home, settingsPath: v.settingsPath });
    expect(again).toBe(domain);
    expect(getSecureDomain()).toBe(domain);
    expect(env2).toEqual({});
    expect(Object.isFrozen(domain)).toBe(true);
  });
});

describe("placement helpers (session-driver / consult / resume)", () => {
  it("no verdict ⇒ legacy behaviour", () => {
    expect(secureChildSessionDir()).toBeUndefined();
    expect(secureStatePaths()).toBeUndefined();
    expect(() => assertSessionFileInDomain("/anything.jsonl")).not.toThrow();
  });

  it("secure ⇒ in-vault sessions dir, resume only from inside the vault", () => {
    v = makeFakeVault();
    freezeDomain(v);
    expect(secureChildSessionDir()).toBe(v.sessions);
    expect(secureStatePaths()?.consult).toBe(join(v.state, "cache", "consult-sessions"));
    expect(() => assertSessionFileInDomain(join(v.sessions, "x.jsonl"))).not.toThrow();
    expect(() => assertSessionFileInDomain(join(v.outside, "x.jsonl"))).toThrow(/保险库外/);
  });

  it("plain with vaults ⇒ resume of a vault file is refused (literal and via link)", () => {
    v = makeFakeVault();
    freezeDomain(v, { cwd: v.outside });
    expect(secureChildSessionDir()).toBeUndefined();
    expect(() => assertSessionFileInDomain(join(v!.sessions, "x.jsonl"))).toThrow(/acme/);
    expect(() => assertSessionFileInDomain(join(v!.link, "x.jsonl"))).toThrow(/acme/);
    expect(() => assertSessionFileInDomain(join(v!.outside, "x.jsonl"))).not.toThrow();
  });

  it("locked ⇒ child creation and resume both refused", () => {
    v = makeFakeVault();
    freezeDomain(v, { mountinfo: v.unmounted });
    expect(() => secureChildSessionDir()).toThrow(/锁定/);
    expect(() => assertSessionFileInDomain(join(v!.outside, "x.jsonl"))).toThrow(/锁定/);
  });

  it("canonicalPath resolves the nearest existing ancestor", () => {
    v = makeFakeVault();
    mkdirSync(join(v.work, "a"), { recursive: true });
    expect(canonicalPath(join(v.link, "a", "b", "c.txt"))).toBe(join(v.work, "a", "b", "c.txt"));
  });
});

describe("/secure status text (security review #2/#3/#5)", () => {
  it("reports a broken section, the restart note, and remote traffic-record as unverifiable", () => {
    v = makeFakeVault();
    writeFileSync(v.settingsPath, "{oops");
    const d = judge(v, { cwd: v.outside });
    const agentDir = join(v.tmp, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-traffic-record"] }));
    const text = renderSecureStatus({ domain: d, runtimeLock: undefined, agentDir, packageRoot: "/pkg", env: {} });
    expect(text).toContain("非法");
    expect(text).toContain("JSON");
    expect(text).toContain("需重启 pi 进程");
    expect(text).toContain("/reload 不会重新判定");
    expect(text).toContain("远端安装，无法在本地核验");
    expect(text).not.toContain("警告：traffic-record");
  });
});
