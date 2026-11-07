// settings-rename P1 (plan §3.6, T-SC1…T-SC4): secure fail-closed rules around the new settings location —
// S6b secure-section mismatch, agentDir nested with a vault, locked-reason hints and the stale-launcher probe.
// Domain and launcher are driven over the same sandbox; the launcher CLI through the real bash entry (no FUSE
// needed: every refusal here happens before any mount work).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderSecureStatus, staleLauncherWarning } from "../../src/secure/command.js";
import { computeSecureDomain, type SecureDomainDeps } from "../../src/secure/domain.js";
import { resolveSettingsLocation } from "../../src/secure/settings-lock.js";
import { resolveAgentDir } from "../../src/core/agent-dir.js";

const REPO = join(import.meta.dirname, "..", "..");
const BIN = join(REPO, "src", "secure", "bin", "pi-secure");
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS module, no typings by design
const H: any = await import(pathToFileURL(join(REPO, "src", "secure", "bin", "helper.mjs")).href);

let root: string;
let home: string;
let agent: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-settings-sec-")));
  home = join(root, "home");
  agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
});
afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(root, { recursive: true, force: true });
});

const vaultDir = () => join(home, ".local", "share", "pi-toolkit-secure", "acme");
const vaultMnt = () => join(home, "secure", "acme");
const registry = (extra: Record<string, unknown> = {}) => ({
  secure: { vaults: { acme: { dir: vaultDir(), mnt: vaultMnt() } } },
  ...extra,
});
const W = (dir: string, name: string, v: unknown) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), typeof v === "string" ? v : JSON.stringify(v), { mode: 0o600 });
};
function domain(env: Record<string, string | undefined> = {}, extra: Partial<SecureDomainDeps> = {}) {
  return computeSecureDomain({
    home,
    env,
    cwd: home,
    readMountinfo: () => "",
    readSelfMntNs: () => undefined,
    readBootId: () => undefined,
    ...extra,
  });
}
function cli(argv: string[], env: Record<string, string> = {}) {
  const r = spawnSync(BIN, argv, {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8", TMPDIR: tmpdir(), ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("T-SC1 S6b: diverging secure sections fail closed (domain AND launcher)", () => {
  it("different secure sections ⇒ domain config invalid; launcher cfg invalid, resolveVault 78, run/unlock exit 78, status shows !", () => {
    W(agent, "pi-toolkit.json", registry());
    W(agent, "pi-subagent.json", { secure: { vaults: { other: { dir: "/d/o", mnt: "/m/o" } } } });
    const d = domain();
    expect(d.config.valid).toBe(false);
    expect(d.config.error).toMatch(/两份设置文件的 secure 段不一致/);
    expect(d.config.enabled).toBe(true);
    const { cfg, file } = H.loadSecureConfig(home);
    expect(file).toBe(join(agent, "pi-toolkit.json"));
    expect(cfg.valid).toBe(false);
    expect(cfg.error).toMatch(/两份设置文件的 secure 段不一致/);
    expect(H.resolveVault("acme", { home })).toMatchObject({ kind: "error", code: 78 });
    expect(cli(["run", "acme"]).code).toBe(78);
    expect(cli(["unlock", "acme"]).code).toBe(78);
    const st = cli(["status"]);
    expect(st.out).toMatch(/settings: .*pi-toolkit\.json {2}! .*两份设置文件的 secure 段不一致/);
  });

  it("identical secure sections (key order ignored) or none on either side ⇒ valid, NEW wins for the rest", () => {
    W(
      agent,
      "pi-toolkit.json",
      `{"a":1,"secure":{"vaults":{"acme":{"mnt":${JSON.stringify(vaultMnt())},"dir":${JSON.stringify(vaultDir())}}}}}`,
    );
    W(agent, "pi-subagent.json", registry({ a: 2 }));
    expect(domain().config.valid).toBe(true);
    expect(domain().vaults).toHaveLength(1);
    expect(H.loadSecureConfig(home).cfg.valid).toBe(true);
    rmSync(join(agent, "pi-toolkit.json"));
    rmSync(join(agent, "pi-subagent.json"));
    W(agent, "pi-toolkit.json", { a: 1 });
    W(agent, "pi-subagent.json", { a: 2 });
    expect(domain().config.valid).toBe(true);
    expect(H.loadSecureConfig(home).cfg.valid).toBe(true);
  });

  it("registry only in the legacy file of a diverged pair ⇒ mismatch too (never silently plain)", () => {
    W(agent, "pi-toolkit.json", { a: 1 });
    W(agent, "pi-subagent.json", registry());
    expect(domain().config.valid).toBe(false);
    expect(H.loadSecureConfig(home).cfg.valid).toBe(false);
  });

  it("an unreadable legacy half of S6b is an invalid section as well", () => {
    W(agent, "pi-toolkit.json", registry());
    W(agent, "pi-subagent.json", "{broken");
    expect(domain().config.valid).toBe(false);
    expect(H.loadSecureConfig(home).readError).toMatch(/invalid JSON/);
  });
});

describe("T-SC2 agentDir nested with a vault ⇒ locked / 78 (env-selected only)", () => {
  const nestedInside = () => join(vaultMnt(), "work", "agent");
  const containing = () => join(home, "secure");

  for (const [label, p] of [
    ["inside the mount point", nestedInside],
    ["inside the metadata dir", () => join(vaultDir(), "agent")],
    ["containing the mount point", containing],
  ] as const) {
    it(`PI_CODING_AGENT_DIR ${label}`, () => {
      W(agent, "pi-subagent.json", registry()); // P is empty ⇒ the registry is inherited from H
      const env = { PI_CODING_AGENT_DIR: p() };
      const d = domain(env);
      expect(d.kind).toBe("locked");
      if (d.kind === "locked") {
        expect(d.reason).toMatch(/PI_CODING_AGENT_DIR（.+）位于保险库 acme 内：不支持/);
        expect(d.vaultName).toBe("acme");
      }
      process.env.PI_CODING_AGENT_DIR = p();
      const lc = H.loadSecureConfig(home);
      expect(lc.agentProblem).toMatch(/位于保险库 acme 内/);
      expect(H.resolveVault("acme", { home })).toMatchObject({ kind: "error", code: 78 });
      expect(H.resolveVault("acme", { home, allowAgentInVault: true })).toMatchObject({ kind: "ok" });
      const e = { PI_CODING_AGENT_DIR: p() };
      for (const argv of [
        ["run", "acme"],
        ["unlock", "acme"],
        ["init", "acme"],
      ]) {
        const r = cli(argv, e);
        expect([argv[0], r.code]).toEqual([argv[0], 78]);
        expect(r.err).toMatch(/位于保险库 acme 内/);
      }
      const st = cli(["status"], e);
      expect(st.out).toMatch(/settings: .*pi-subagent\.json {2}\[inherited\]/);
      expect(st.out).toMatch(/ {2}! PI_CODING_AGENT_DIR（.+）位于保险库 acme 内/);
      expect(cli(["lock", "acme"], e).err).not.toMatch(/位于保险库/); // locking is never blocked by it
    });
  }

  it("an unrelated env agentDir, and the default dir, never trigger it", () => {
    W(agent, "pi-subagent.json", registry());
    const other = join(root, "elsewhere");
    expect(domain({ PI_CODING_AGENT_DIR: other }).kind).toBe("plain");
    expect(domain({}).kind).toBe("plain");
    expect(domain({ PI_CODING_AGENT_DIR: "" }).kind).toBe("plain");
    process.env.PI_CODING_AGENT_DIR = other;
    expect(H.loadSecureConfig(home).agentProblem).toBeUndefined();
    delete process.env.PI_CODING_AGENT_DIR;
    expect(Object.keys(H.loadSecureConfig(home)).sort()).toEqual(["cfg", "file"]); // default shape unchanged
  });

  it("not enabled / not usable ⇒ no lock (nothing to protect)", () => {
    W(agent, "pi-subagent.json", { secure: { enabled: false, vaults: registry().secure.vaults } });
    expect(domain({ PI_CODING_AGENT_DIR: nestedInside() }).kind).toBe("plain");
  });
});

describe("T-SC3 locked-reason hint and legacy launcher semantics", () => {
  it("unregistered PI_SECURE_VAULT: hint only when the agentDir came from the env", () => {
    const P = join(root, "agent2");
    W(P, "pi-toolkit.json", registry());
    const withEnv = domain({ PI_SECURE_VAULT: "nope", PI_CODING_AGENT_DIR: P });
    expect(withEnv.kind).toBe("locked");
    if (withEnv.kind === "locked") {
      expect(withEnv.reason).toContain("PI_SECURE_VAULT=nope 不是已登记的保险库（设置文件 ");
      expect(withEnv.reason).toContain(join(P, "pi-toolkit.json"));
      expect(withEnv.reason).toContain("请确认 pi-secure 在同一环境下运行");
    }
    W(agent, "pi-subagent.json", registry());
    const plain = domain({ PI_SECURE_VAULT: "nope" });
    expect(plain.kind === "locked" && plain.reason).toBe("PI_SECURE_VAULT=nope 不是已登记的保险库");
  });

  it("an old launcher refuses to rewrite the compat symlink (existing behaviour, regression)", () => {
    W(agent, "pi-toolkit.json", registry());
    symlinkSync("pi-toolkit.json", join(agent, "pi-subagent.json"));
    expect(() => H.assertWritableSettingsFile(join(agent, "pi-subagent.json"))).toThrow(/符号链接/);
    expect(() => H.assertWritableSettingsFile(join(agent, "pi-toolkit.json"))).not.toThrow();
  });

  it("the launcher reads the agentDir's file; status tags the source only off the default dir", () => {
    const P = join(root, "agent2");
    W(P, "pi-toolkit.json", registry());
    W(agent, "pi-subagent.json", { secure: { vaults: {} } });
    const dflt = cli(["status"]);
    expect(dflt.out).toMatch(/settings: \S+\/home\/\.pi\/agent\/pi-subagent\.json\n/);
    const env = cli(["status"], { PI_CODING_AGENT_DIR: P });
    expect(env.out).toContain(`settings: ${join(P, "pi-toolkit.json")}  [agentDir: env]`);
    const rel = cli(["status"], { PI_CODING_AGENT_DIR: "rel/dir" });
    expect(rel.out).toMatch(/PI_CODING_AGENT_DIR 是相对路径，已忽略/);
    expect(rel.out).toMatch(/settings: \S+\/home\/\.pi\/agent\/pi-subagent\.json\n/);
  });
});

describe("T-SC4 /secure status: stale pi-secure launcher probe", () => {
  function locationOf(files: Record<string, string | null>): ReturnType<typeof resolveSettingsLocation> {
    for (const n of ["pi-toolkit.json", "pi-subagent.json"]) rmSync(join(agent, n), { force: true });
    for (const [n, v] of Object.entries(files)) {
      if (v === null || n === "link") continue;
      writeFileSync(join(agent, n), v);
    }
    if (files["link"] !== undefined) symlinkSync("pi-toolkit.json", join(agent, "pi-subagent.json"));
    return resolveSettingsLocation(resolveAgentDir({}, home));
  }
  let installN = 0;
  function fakeInstall(helperText: string | null): string {
    const n = ++installN;
    const bin = join(root, `oldcheckout${n}`, "src", "secure", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pi-secure"), "#!/bin/sh\n", { mode: 0o755 });
    if (helperText !== null) writeFileSync(join(bin, "helper.mjs"), helperText);
    const link = join(root, `pathbin${n}`, "pi-secure");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(bin, "pi-secure"), link);
    return link;
  }
  const S5 = () => locationOf({ "pi-toolkit.json": "{}", link: "" });
  const S1 = () => locationOf({ "pi-subagent.json": "{}" });

  it("not on PATH ⇒ silent", () => {
    expect(staleLauncherWarning({ packageRoot: REPO, location: S5(), which: () => undefined })).toBeUndefined();
  });
  it("PATH entry is THIS checkout ⇒ silent", () => {
    const link = join(root, "pathbin", "pi-secure");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(BIN, link);
    expect(staleLauncherWarning({ packageRoot: REPO, location: S5(), which: () => link })).toBeUndefined();
  });
  it("an old helper without the marker + S5 ⇒ warning naming the fix; S1 / no location ⇒ silent", () => {
    const link = fakeInstall("export const SETTINGS = 1;\n");
    const w = staleLauncherWarning({ packageRoot: REPO, location: S5(), which: () => link });
    expect(w).toMatch(/^警告：PATH 上的 pi-secure（.+）是旧版，不认识 pi-toolkit\.json/);
    expect(w).toContain(`ln -sf ${join(REPO, "src", "secure", "bin", "pi-secure")} ~/.local/bin/pi-secure`);
    rmSync(join(agent, "pi-toolkit.json"));
    rmSync(join(agent, "pi-subagent.json"));
    expect(staleLauncherWarning({ packageRoot: REPO, location: S1(), which: () => link })).toBeUndefined();
    expect(staleLauncherWarning({ packageRoot: REPO, location: undefined, which: () => link })).toBeUndefined();
  });
  it("a helper carrying the marker ⇒ silent; an unreadable helper ⇒ silent", () => {
    const link = fakeInstall('export const SETTINGS_FILE_NAME = "pi-toolkit.json";\n');
    expect(staleLauncherWarning({ packageRoot: REPO, location: S5(), which: () => link })).toBeUndefined();
    const link2 = fakeInstall(null);
    expect(staleLauncherWarning({ packageRoot: REPO, location: S5(), which: () => link2 })).toBeUndefined();
  });
  it("only the first 64 KiB are consulted (readHead seam sees the real helper file)", () => {
    const link = fakeInstall("x".repeat(100_000) + 'SETTINGS_FILE_NAME = "pi-toolkit.json"');
    expect(staleLauncherWarning({ packageRoot: REPO, location: S5(), which: () => link })).toMatch(/^警告/);
  });
  it("THIS checkout's helper carries the marker within the first 64 KiB (so a current launcher never warns)", () => {
    const head = spawnSync("head", ["-c", String(64 * 1024), join(REPO, "src", "secure", "bin", "helper.mjs")], {
      encoding: "utf8",
    }).stdout;
    expect(head).toContain('SETTINGS_FILE_NAME = "pi-toolkit.json"');
  });

  it("renderSecureStatus: warning goes right before the launcher line; settings line only off the default dir", () => {
    const d = domain();
    const base = renderSecureStatus({
      domain: d,
      runtimeLock: undefined,
      agentDir: agent,
      packageRoot: "/pkg",
      env: {},
    });
    const loc = S5();
    const same = renderSecureStatus({
      domain: d,
      runtimeLock: undefined,
      agentDir: agent,
      packageRoot: "/pkg",
      env: {},
      settings: loc,
    });
    expect(same).toBe(base); // default dir ⇒ byte-identical
    const P = join(root, "agent2");
    const inherited = resolveSettingsLocation({ dir: P, home: agent, source: "env" });
    const t = renderSecureStatus({
      domain: d,
      runtimeLock: undefined,
      agentDir: agent,
      packageRoot: "/pkg",
      env: {},
      settings: inherited,
      launcherWarning: "警告：X",
    });
    const lines = t.split("\n");
    expect(lines.at(-2)).toBe("警告：X");
    expect(lines.at(-1)).toMatch(/^启动器：ln -s /);
    expect(lines.some((l) => l.startsWith("设置文件：") && l.includes("继承 ~/.pi/agent"))).toBe(true);
  });
});
