import { appendFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSessionFileInDomain,
  canonicalPath,
  computeSecureDomain,
  getSecureDomain,
  initSecureDomain,
  isPrivateNsSession,
  judgePrivateNsGate,
  hubSpawnBlockedReason,
  secureConfigNsFactor,
  privateNsEvidence,
  readPrivateRecordFd,
  resetSecureDomainForTests,
  secureChildSessionDir,
  secureStatePaths,
  type PrivateNsGateDeps,
  type PrivateNsIo,
  type PrivateRecordRead,
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

  it("cwd at the mount point itself ⇒ secure", () => {
    v = makeFakeVault();
    expect(judge(v, { cwd: v.mnt }).kind).toBe("secure");
  });

  // ── legacy layout (§L.3): plugin judgment keeps the OLD derivations ──
  it("legacy vault: cwd reached through the old ~/secure/<name> entry link ⇒ secure when mounted", () => {
    v = makeFakeVault({ legacy: true });
    expect(v.link).toBeDefined();
    expect(judge(v, { cwd: join(v.link!, "sub") }).kind).toBe("secure");
  });
  it("legacy vault: mounted at <dir>/mnt ⇒ secure; unmounted ⇒ locked", () => {
    v = makeFakeVault({ legacy: true });
    expect(judge(v, { cwd: v.work }).kind).toBe("secure");
    const d = judge(v, { mountinfo: v.unmounted });
    expect(d.kind).toBe("locked");
  });

  it("cwd inside the vault but not mounted ⇒ locked", () => {
    v = makeFakeVault();
    const d = judge(v, { mountinfo: v.unmounted });
    expect(d.kind).toBe("locked");
    if (d.kind === "locked") expect(d.reason).toContain("未挂载");
  });

  it("a foreign filesystem ON THE MOUNT POINT ⇒ locked via the foreign branch (review L0 #5)", () => {
    v = makeFakeVault();
    const d = judge(v, { mountinfo: mountLine(v.mnt, "tmpfs", "tmpfs") }); // tmpfs AT the real mount point
    expect(d.kind).toBe("locked");
    if (d.kind === "locked") expect(d.reason).toContain("不是它自己的 gocryptfs 挂载");
    // …and a truly absent mount point is the distinct 未挂载 branch
    const absent = judge(v, { mountinfo: v.unmounted });
    if (absent.kind === "locked") expect(absent.reason).toContain("未挂载");
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
    expect(() => assertSessionFileInDomain(join(v!.sessions, "x.jsonl"))).not.toThrow();
    expect(() => assertSessionFileInDomain(join(v!.outside, "x.jsonl"))).toThrow(/保险库外/);
  });

  it("plain with vaults ⇒ resume of a vault file is refused (canonical and literal mount-point spelling)", () => {
    v = makeFakeVault();
    freezeDomain(v, { cwd: v.outside });
    expect(secureChildSessionDir()).toBeUndefined();
    expect(() => assertSessionFileInDomain(join(v!.sessions, "x.jsonl"))).toThrow(/acme/);
    expect(() => assertSessionFileInDomain(join(v!.mnt, "state", "sessions", "x.jsonl"))).toThrow(/acme/);
    expect(() => assertSessionFileInDomain(join(v!.outside, "x.jsonl"))).not.toThrow();
  });
  it("plain with a LEGACY vault ⇒ resume via the old entry-link spelling is refused", () => {
    v = makeFakeVault({ legacy: true });
    freezeDomain(v, { cwd: v.outside });
    expect(() => assertSessionFileInDomain(join(v!.link!, "x.jsonl"))).toThrow(/acme/);
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
    expect(canonicalPath(join(v.mnt, "work", "a", "b", "c.txt"))).toBe(join(v.work, "a", "b", "c.txt"));
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

// ── private-plan §2.9: evidence-based private-ns judgment (N3) ──────────────────────────────

function recordText(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 3,
    instanceId: "9f3c00aa11bb22cc33dd44ee55ff6677",
    name: "acme",
    phase: "session",
    bootId: "boot-1",
    createdAt: "2026-10-23T19:30:00.000+08:00",
    realCipher: "/cipher",
    realMnt: "/mnt/acme",
    lease: { dev: "8:1", ino: 145137 },
    owner: { pid: 1200, start: 9876543 },
    ns: { mnt: "mnt:[111]", user: "user:[112]" },
    ...over,
  });
}

/** files: string ⇒ text record; null ⇒ absent; {rejected} ⇒ rejected read. */
type FileMap = Record<string, string | null | { rejected: string }>;

function readOf(files: FileMap | undefined): (file: string) => PrivateRecordRead {
  return (file) => {
    const v = files?.[file];
    if (v === undefined || v === null) return { kind: "absent" };
    if (typeof v === "string") return { kind: "text", text: v };
    return { kind: "rejected", reason: v.rejected };
  };
}

/** ns seams: fixed self ns / boot, per-file record map; every call counted. */
function nsIo(opts: { self?: string | undefined; boot?: string | undefined; files?: FileMap } = {}): PrivateNsIo {
  return {
    readSelfMntNs: () => opts.self,
    readBootId: () => opts.boot ?? "boot-1",
    readPrivateRecord: readOf(opts.files),
  };
}

function judgeNs(
  fv: FakeVault,
  over: {
    cwd?: string;
    env?: Record<string, string>;
    selfNs?: string | undefined;
    boot?: string | undefined;
    files?: FileMap;
  } = {},
) {
  return computeSecureDomain({
    env: over.env ?? {},
    cwd: over.cwd ?? fv.work,
    home: fv.home,
    settingsPath: fv.settingsPath,
    readMountinfo: () => fv.mounted,
    ...(over.selfNs !== undefined || over.boot !== undefined || over.files !== undefined
      ? {
          readSelfMntNs: () => over.selfNs,
          readBootId: () => over.boot ?? "boot-1",
          readPrivateRecord: readOf(over.files),
        }
      : {}),
  });
}

describe("private-ns evidence judgment (private-plan §2.9)", () => {
  it("matching record ns ⇒ ns on the SECURE variant, via record, with the vault", () => {
    v = makeFakeVault();
    const d = judgeNs(v, { selfNs: "mnt:[111]", files: { [join(v.dir, "private.json")]: recordText() } });
    expect(d.kind).toBe("secure");
    expect(d.ns).toEqual({
      via: "record",
      vault: expect.objectContaining({ vault: expect.objectContaining({ name: "acme" }) }),
    });
  });

  it("matching record + NON-vault cwd ⇒ ns on the PLAIN variant too (kind-independent)", () => {
    v = makeFakeVault();
    const d = judgeNs(v, {
      cwd: v.outside,
      selfNs: "mnt:[111]",
      files: { [join(v.dir, "private.json")]: recordText() },
    });
    expect(d.kind).toBe("plain");
    expect(d.ns?.via).toBe("record");
  });

  it("record ns + unmounted vault ⇒ ns on the LOCKED variant (the --lazy shape)", () => {
    v = makeFakeVault();
    const fv = v;
    const d = computeSecureDomain({
      env: {},
      cwd: v.work,
      home: fv.home,
      settingsPath: fv.settingsPath,
      readMountinfo: () => fv.unmounted,
      readSelfMntNs: () => "mnt:[111]",
      readBootId: () => "boot-1",
      readPrivateRecord: (file) =>
        file === join(fv.dir, "private.json") ? { kind: "text", text: recordText() } : { kind: "absent" },
    });
    expect(d.kind).toBe("locked");
    expect(d.ns?.via).toBe("record");
  });

  it("record from ANOTHER boot never matches (ns ids are recycled across reboots)", () => {
    v = makeFakeVault();
    const d = judgeNs(v, {
      selfNs: "mnt:[111]",
      boot: "boot-2",
      files: { [join(v.dir, "private.json")]: recordText() },
    });
    expect(d.ns).toBeUndefined();
  });

  it("record ns ≠ self ns ⇒ no evidence", () => {
    v = makeFakeVault();
    const d = judgeNs(v, { selfNs: "mnt:[999]", files: { [join(v.dir, "private.json")]: recordText() } });
    expect(d.ns).toBeUndefined();
  });

  it("corrupt record (parse failure) ⇒ no evidence from that vault", () => {
    v = makeFakeVault();
    const d = judgeNs(v, { selfNs: "mnt:[111]", files: { [join(v.dir, "private.json")]: "{corrupt" } });
    expect(d.ns).toBeUndefined();
  });

  it("record without ns field (claim-time starting record) ⇒ no evidence", () => {
    v = makeFakeVault();
    const d = judgeNs(v, {
      selfNs: "mnt:[111]",
      files: { [join(v.dir, "private.json")]: recordText({ phase: "starting", ns: undefined }) },
    });
    expect(d.ns).toBeUndefined();
  });

  it("PI_SECURE_NS=1 hint alone ⇒ ns via hint, vault named from PI_SECURE_VAULT when registered", () => {
    v = makeFakeVault();
    const d = judgeNs(v, { cwd: v.outside, env: { PI_SECURE_NS: "1" }, selfNs: "mnt:[999]" });
    expect(d.ns?.via).toBe("hint");
    expect(d.ns?.vault).toBeUndefined();
    const named = judgeNs(v, {
      cwd: v.outside,
      env: { PI_SECURE_NS: "1", PI_SECURE_VAULT: "acme" },
      selfNs: "mnt:[999]",
    });
    expect(named.ns?.via).toBe("hint");
    expect(named.ns?.vault?.vault.name).toBe("acme");
  });

  it('evidence wins over the hint (via stays "record")', () => {
    v = makeFakeVault();
    const d = judgeNs(v, {
      selfNs: "mnt:[111]",
      env: { PI_SECURE_NS: "1" },
      files: { [join(v.dir, "private.json")]: recordText() },
    });
    expect(d.ns?.via).toBe("record");
  });

  it("unusable /proc reads ⇒ no evidence, hint still applies (only more conservative)", () => {
    expect(privateNsEvidence([], {}, nsIo({ self: undefined, boot: "boot-1" }))).toBeUndefined();
    expect(privateNsEvidence([], { PI_SECURE_NS: "1" }, nsIo({ self: undefined }))).toEqual({ via: "hint" });
  });

  it("multiple vaults: the OTHER vault's record never matches ours", () => {
    v = makeFakeVault();
    const other = makeFakeVault({ name: "beta" });
    try {
      // both registered in one settings file
      writeFileSync(
        v.settingsPath,
        JSON.stringify({
          secure: {
            vaults: {
              acme: { dir: v.dir, mnt: v.mnt },
              beta: { dir: other.dir, mnt: other.mnt },
            },
          },
        }),
      );
      const d = judgeNs(v, {
        selfNs: "mnt:[222]",
        files: {
          // beta has a live private instance; we are NOT in it (self=222 vs beta=111);
          // acme has a stale record from another boot
          [join(other.dir, "private.json")]: recordText({ name: "beta" }),
          [join(v.dir, "private.json")]: recordText({ bootId: "boot-old" }),
        },
      });
      expect(d.ns).toBeUndefined();
    } finally {
      other.cleanup();
    }
  });

  it("non-ns ⇒ NO ns key on any variant (deep-equal freeze F5)", () => {
    v = makeFakeVault();
    for (const d of [judgeNs(v, {}), judgeNs(v, { cwd: v.outside })]) {
      expect("ns" in d && d.ns !== undefined).toBe(false);
      expect(JSON.stringify(d)).not.toContain('"ns"');
    }
  });

  it("isPrivateNsSession reads the FROZEN verdict (survives across later reads)", () => {
    v = makeFakeVault();
    const fv = v;
    resetSecureDomainForTests();
    initSecureDomain({
      env: { PI_SECURE_NS: "1", PI_SECURE_VAULT: "acme" },
      cwd: fv!.work,
      home: fv!.home,
      settingsPath: fv!.settingsPath,
      readMountinfo: () => fv!.mounted,
      readSelfMntNs: () => "mnt:[999]",
      readBootId: () => "boot-1",
    });
    expect(isPrivateNsSession()?.via).toBe("hint");
    expect(isPrivateNsSession()?.vault?.vault.name).toBe("acme");
    resetSecureDomainForTests();
    expect(isPrivateNsSession()).toBeUndefined();
  });
});

describe("readPrivateRecordFd — the fd-bound on-disk reader (§3.2 + review N3 #3)", () => {
  it("accepts an own-uid regular file within 4 KiB and hands the parser its text", async () => {
    const { parsePrivateRecord } = await import("../../src/secure/config.js");
    v = makeFakeVault();
    const file = join(v.dir, "private.json");
    writeFileSync(file, recordText());
    const r = readPrivateRecordFd(file);
    expect(r).toEqual({ kind: "text", text: recordText() });
    const parsed = parsePrivateRecord(r.kind === "text" ? r.text : "");
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") expect(parsed.record.name).toBe("acme");
  });

  it("missing ⇒ absent; symlink (O_NOFOLLOW) / empty / over-limit / non-regular ⇒ rejected", () => {
    v = makeFakeVault();
    expect(readPrivateRecordFd(join(v.dir, "missing.json"))).toEqual({ kind: "absent" });
    const real = join(v.dir, "real.json");
    writeFileSync(real, recordText());
    symlinkSync(real, join(v.dir, "link.json"));
    expect(readPrivateRecordFd(join(v.dir, "link.json"))).toMatchObject({ kind: "rejected", reason: "ELOOP" });
    const empty = join(v.dir, "empty.json");
    writeFileSync(empty, "");
    expect(readPrivateRecordFd(empty)).toEqual({ kind: "rejected", reason: "empty" });
    const big = join(v.dir, "big.json");
    writeFileSync(big, "x".repeat(4097));
    expect(readPrivateRecordFd(big)).toEqual({ kind: "rejected", reason: "over-limit" });
    const dir = join(v.dir, "adir.json");
    mkdirSync(dir);
    expect(readPrivateRecordFd(dir)).toEqual({ kind: "rejected", reason: "not-regular" });
  });

  it("a file whose size lies below the cap but GROWS past it mid-read is still over-limit (4097-byte cap)", () => {
    v = makeFakeVault();
    const file = join(v.dir, "growing.json");
    // 4096 valid-JSON-looking bytes + 1 extra: the cap itself catches it even if fstat saw ≤4096
    writeFileSync(file, " ".repeat(4096));
    appendFileSync(file, "x");
    expect(readPrivateRecordFd(file)).toEqual({ kind: "rejected", reason: "over-limit" });
  });
});

describe("/secure status — private-ns lines + record hint (private-plan §2.9)", () => {
  it("ns session ⇒ 「私有命名空间」 + the fixed boundary sentence (§5.1 短句)", () => {
    v = makeFakeVault();
    const d = judgeNs(v, {
      selfNs: "mnt:[111]",
      files: { [join(v.dir, "private.json")]: recordText() },
    });
    const text = renderSecureStatus({
      domain: d,
      runtimeLock: undefined,
      agentDir: "/agent",
      packageRoot: "/pkg",
      env: {},
    });
    expect(text).toContain("私有命名空间：是（acme）");
    expect(text).toContain(
      "边界：防路径直读/扫描/备份/其他程序的无意识访问；不防同 uid 定向进程（/proc/<pid>/root、setns）",
    );
  });

  it("hint-only ns (no vault resolvable) ⇒ 「是」 without a name", () => {
    v = makeFakeVault();
    const fv = v;
    const d = judgeNs(fv, { cwd: fv.outside, env: { PI_SECURE_NS: "1" } });
    const text = renderSecureStatus({
      domain: d,
      runtimeLock: undefined,
      agentDir: "/agent",
      packageRoot: "/pkg",
      env: {},
    });
    expect(text).toContain("私有命名空间：是\n");
  });

  it("non-ns status text is byte-identical (no ns lines at all)", () => {
    v = makeFakeVault();
    const d = judge(v, {});
    const text = renderSecureStatus({
      domain: d,
      runtimeLock: undefined,
      agentDir: "/agent",
      packageRoot: "/pkg",
      env: {},
    });
    expect(text).not.toContain("私有命名空间");
    expect(text).not.toContain("边界：");
  });

  it("plain session: a vault with private.json on disk gets the record hint suffix", () => {
    v = makeFakeVault();
    const fv = v;
    writeFileSync(join(fv.dir, "private.json"), recordText());
    const d = judge(fv, { cwd: fv.outside });
    const text = renderSecureStatus({
      domain: d,
      runtimeLock: undefined,
      agentDir: "/agent",
      packageRoot: "/pkg",
      env: {},
      readMountinfo: () => fv.mounted,
    });
    expect(text).toContain("（存在 --private 实例记录，用 pi-secure status 查看）");
  });

  it("plain session: no private.json ⇒ the vault row is unchanged (freeze F5)", () => {
    v = makeFakeVault();
    const fv = v;
    const d = judge(fv, { cwd: fv.outside });
    const text = renderSecureStatus({
      domain: d,
      runtimeLock: undefined,
      agentDir: "/agent",
      packageRoot: "/pkg",
      env: {},
      readMountinfo: () => fv.mounted,
      existsPrivateRecord: () => false,
    });
    expect(text).not.toContain("--private");
    expect(text).toContain(`  - acme：mounted · ${v.dir} · 挂载点 ${v.mnt}\n`);
  });
});

// ── security review N3 #1 (ruling 2026-10-24): the fail-safe three-state GATE judgment ──────

/** judgePrivateNsGate harness: vaults parsed off the fake settings, every IO seam counted. */
function gate(
  fv: FakeVault,
  over: {
    env?: Record<string, string>;
    selfNs?: string | undefined;
    boot?: string | undefined;
    files?: FileMap;
  } = {},
): { verdict: import("../../src/secure/domain.js").PrivateNsGateVerdict; calls: Record<string, number> } {
  const calls = { self: 0, boot: 0, record: 0 };
  const files: FileMap = over.files ?? {};
  const vaults = computeSecureDomain({
    env: {},
    cwd: fv.outside,
    home: fv.home,
    settingsPath: fv.settingsPath,
    readMountinfo: () => fv.mounted,
  }).vaults;
  const deps: PrivateNsGateDeps = {
    env: over.env ?? {},
    vaults,
    readSelfMntNs: () => {
      calls.self += 1;
      return over.selfNs;
    },
    readBootId: () => {
      calls.boot += 1;
      return "boot" in over ? over.boot : "boot-1";
    },
    readPrivateRecord: (file) => {
      calls.record += 1;
      return readOf(files)(file);
    },
  };
  return { verdict: judgePrivateNsGate(deps), calls };
}

describe("judgePrivateNsGate — fail-safe three states (review N3 #1)", () => {
  it("NO registered vaults and no hint ⇒ not-ns with ZERO filesystem IO (freeze: unconfigured stays byte-identical)", () => {
    const g = judgePrivateNsGate({
      env: {},
      vaults: [],
      readSelfMntNs: () => {
        throw new Error("must not be called");
      },
      readBootId: () => {
        throw new Error("must not be called");
      },
      readPrivateRecord: () => {
        throw new Error("must not be called");
      },
    });
    expect(g).toEqual({ gate: "not-ns" });
  });

  it("vaults registered but every record absent, no hint ⇒ not-ns, and /proc is NOT read (lazy)", () => {
    v = makeFakeVault();
    const { verdict, calls } = gate(v, { selfNs: "mnt:[111]" });
    expect(verdict.gate).toBe("not-ns");
    expect(calls.record).toBe(1); // the one private.json open
    expect(calls.self).toBe(0); // nothing to match ⇒ no /proc reads
    expect(calls.boot).toBe(0);
  });

  it("same-boot record whose ns.mnt equals ours ⇒ in-ns (reason = vault name)", () => {
    v = makeFakeVault();
    const { verdict } = gate(v, { selfNs: "mnt:[111]", files: { [join(v.dir, "private.json")]: recordText() } });
    expect(verdict).toEqual({ gate: "in-ns", reason: "acme" });
  });

  it("same-boot record with a DIFFERENT ns ⇒ not-ns (another terminal's private instance)", () => {
    v = makeFakeVault();
    const { verdict } = gate(v, { selfNs: "mnt:[999]", files: { [join(v.dir, "private.json")]: recordText() } });
    expect(verdict.gate).toBe("not-ns");
  });

  it("corrupt record ⇒ unknown (never 'no evidence')", () => {
    v = makeFakeVault();
    const { verdict } = gate(v, { selfNs: "mnt:[111]", files: { [join(v.dir, "private.json")]: "{corrupt" } });
    expect(verdict.gate).toBe("unknown");
    expect(verdict.reason).toContain("损坏");
  });

  it("existing-but-unreadable record (open/stat/read rejected) ⇒ unknown", () => {
    v = makeFakeVault();
    const { verdict } = gate(v, {
      selfNs: "mnt:[111]",
      files: { [join(v.dir, "private.json")]: { rejected: "EACCES" } },
    });
    expect(verdict.gate).toBe("unknown");
    expect(verdict.reason).toContain("不可读");
  });

  it("PI_SECURE_NS=1 without matching evidence ⇒ unknown; with evidence ⇒ in-ns (evidence wins)", () => {
    v = makeFakeVault();
    const no = gate(v, { env: { PI_SECURE_NS: "1" }, selfNs: "mnt:[999]" });
    expect(no.verdict.gate).toBe("unknown");
    expect(no.verdict.reason).toContain("PI_SECURE_NS");
    const yes = gate(v, {
      env: { PI_SECURE_NS: "1" },
      selfNs: "mnt:[111]",
      files: { [join(v.dir, "private.json")]: recordText() },
    });
    expect(yes.verdict.gate).toBe("in-ns");
  });

  it("hint set but records absent ⇒ unknown WITHOUT /proc reads", () => {
    v = makeFakeVault();
    const { verdict, calls } = gate(v, { env: { PI_SECURE_NS: "1" } });
    expect(verdict.gate).toBe("unknown");
    expect(calls.self).toBe(0);
  });

  it("record exists but /proc/self/ns/mnt (or boot_id) unreadable ⇒ unknown", () => {
    v = makeFakeVault();
    const a = gate(v, { selfNs: undefined, files: { [join(v.dir, "private.json")]: recordText() } });
    expect(a.verdict.gate).toBe("unknown");
    const b = gate(v, { selfNs: "mnt:[111]", boot: undefined, files: { [join(v.dir, "private.json")]: recordText() } });
    expect(b.verdict.gate).toBe("unknown");
  });

  it("same-boot claim record WITHOUT ns (starting phase) ⇒ unknown", () => {
    v = makeFakeVault();
    const { verdict } = gate(v, {
      selfNs: "mnt:[111]",
      files: { [join(v.dir, "private.json")]: recordText({ phase: "starting", ns: undefined }) },
    });
    expect(verdict.gate).toBe("unknown");
    expect(verdict.reason).toContain("认领");
  });

  it("different-boot record: ns differs ⇒ not-ns; ns id COLLIDES with ours ⇒ unknown (id reuse)", () => {
    v = makeFakeVault();
    const diff = gate(v, {
      selfNs: "mnt:[999]",
      files: { [join(v.dir, "private.json")]: recordText({ bootId: "boot-old" }) },
    });
    expect(diff.verdict.gate).toBe("not-ns");
    const collide = gate(v, {
      selfNs: "mnt:[111]",
      files: { [join(v.dir, "private.json")]: recordText({ bootId: "boot-old" }) },
    });
    expect(collide.verdict.gate).toBe("unknown");
  });

  it("a corrupt sibling vault outweighs everything (unknown), but an absent sibling does not", () => {
    v = makeFakeVault();
    const other = makeFakeVault({ name: "beta" });
    try {
      writeFileSync(
        v.settingsPath,
        JSON.stringify({
          secure: { vaults: { acme: { dir: v.dir, mnt: v.mnt }, beta: { dir: other.dir, mnt: other.mnt } } },
        }),
      );
      const matchPlusAbsent = gate(v, {
        selfNs: "mnt:[111]",
        files: { [join(v.dir, "private.json")]: recordText() },
      });
      expect(matchPlusAbsent.verdict.gate).toBe("in-ns");
      const matchPlusCorrupt = gate(v, {
        selfNs: "mnt:[111]",
        files: {
          [join(v.dir, "private.json")]: recordText(),
          [join(other.dir, "private.json")]: "{corrupt",
        },
      });
      expect(matchPlusCorrupt.verdict.gate).toBe("unknown");
    } finally {
      other.cleanup();
    }
  });

  it("vaults default to the FROZEN domain's list (production plumbing)", () => {
    v = makeFakeVault();
    const fv = v;
    resetSecureDomainForTests();
    initSecureDomain({
      env: {},
      cwd: fv!.outside,
      home: fv!.home,
      settingsPath: fv!.settingsPath,
      readMountinfo: () => fv!.mounted,
    });
    const verdict = judgePrivateNsGate({
      env: {},
      readSelfMntNs: () => "mnt:[111]",
      readBootId: () => "boot-1",
      readPrivateRecord: (file) =>
        file === join(fv!.dir, "private.json") ? { kind: "text", text: recordText() } : { kind: "absent" },
    });
    expect(verdict).toEqual({ gate: "in-ns", reason: "acme" });
    expect(hubSpawnBlockedReason()).toBeUndefined(); // real IO here: no records on disk ⇒ not-ns
  });
});

// ── security review N3 round 2: config-state factor + zero-IO on the compute path ───────────

/** Counting/throwing ns seams — any call means the zero-IO promise broke. */
function countingIo(calls: {
  self: number;
  boot: number;
  record: number;
}): Pick<PrivateNsGateDeps, "readSelfMntNs" | "readBootId" | "readPrivateRecord"> {
  return {
    readSelfMntNs: () => {
      calls.self += 1;
      return "mnt:[1]";
    },
    readBootId: () => {
      calls.boot += 1;
      return "boot-1";
    },
    readPrivateRecord: () => {
      calls.record += 1;
      return { kind: "absent" };
    },
  };
}

describe("review round 2 #2 — zero /proc IO without a secure section", () => {
  it("computeSecureDomain (no section, no hint): NEITHER /proc NOR any private.json is read", () => {
    v = makeFakeVault();
    const calls = { self: 0, boot: 0, record: 0 };
    const d = computeSecureDomain({
      env: {},
      cwd: v.outside,
      home: v.home,
      settingsPath: join(v!.tmp, "missing-settings.json"),
      readMountinfo: () => v!.unmounted,
      ...countingIo(calls),
    });
    expect(d.kind).toBe("plain");
    expect(d.ns).toBeUndefined();
    expect(calls).toEqual({ self: 0, boot: 0, record: 0 });
  });

  it("computeSecureDomain (no section + hint): the hint verdict needs no /proc read either", () => {
    v = makeFakeVault();
    const calls = { self: 0, boot: 0, record: 0 };
    const d = computeSecureDomain({
      env: { PI_SECURE_NS: "1" },
      cwd: v.outside,
      home: v.home,
      settingsPath: join(v!.tmp, "missing-settings.json"),
      readMountinfo: () => v!.unmounted,
      ...countingIo(calls),
    });
    expect(d.kind).toBe("plain");
    expect(d.ns?.via).toBe("hint");
    expect(calls).toEqual({ self: 0, boot: 0, record: 0 });
  });

  it("with registered vaults the /proc reads DO happen (the cost is real, not dead code)", () => {
    v = makeFakeVault();
    const calls = { self: 0, boot: 0, record: 0 };
    computeSecureDomain({
      env: {},
      cwd: v.outside,
      home: v.home,
      settingsPath: v!.settingsPath,
      readMountinfo: () => v!.unmounted,
      ...countingIo(calls),
    });
    expect(calls.self).toBe(1);
    expect(calls.boot).toBe(1);
    expect(calls.record).toBe(1); // the one vault's private.json
  });
});

describe("review round 2 #1 — a present-but-unusable secure section gates to unknown", () => {
  function frozenGate(
    settings: unknown,
    env: Record<string, string> = {},
  ): import("../../src/secure/domain.js").PrivateNsGateVerdict {
    resetSecureDomainForTests();
    writeFileSync(join(v!.tmp, "r2-settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
    initSecureDomain({
      env,
      cwd: v!.outside,
      home: v!.home,
      settingsPath: join(v!.tmp, "r2-settings.json"),
      readMountinfo: () => v!.unmounted,
      warn: () => undefined,
    });
    return judgePrivateNsGate({
      env,
      readPrivateRecord: () => {
        throw new Error("records must not even be scanned while the config is unusable");
      },
    });
  }

  it("corrupt JSON ⇒ unknown (never not-ns from a broken config)", () => {
    v = makeFakeVault();
    const verdict = frozenGate("{oops");
    expect(verdict.gate).toBe("unknown");
    expect(verdict.reason).toContain("secure 配置存在但不可用");
  });

  it("wrong section shape (secure.vaults not an object) ⇒ unknown", () => {
    v = makeFakeVault();
    expect(frozenGate({ secure: { vaults: [1, 2] } }).gate).toBe("unknown");
  });

  it("ANY invalid vault entry poisons the whole registry ⇒ unknown", () => {
    v = makeFakeVault();
    const verdict = frozenGate({ secure: { vaults: { acme: { dir: v.dir, mnt: v.mnt }, "Bad Name": { dir: "/x" } } } });
    expect(verdict.gate).toBe("unknown");
    expect(verdict.reason).toContain("不可用");
  });

  it("valid-but-disabled section ⇒ not-ns (deliberate off, not a failure)", () => {
    v = makeFakeVault();
    expect(frozenGate({ secure: { enabled: false, vaults: { acme: { dir: v.dir, mnt: v.mnt } } } }).gate).toBe(
      "not-ns",
    );
  });

  it("genuinely absent section ⇒ not-ns (unchanged freeze)", () => {
    v = makeFakeVault();
    resetSecureDomainForTests();
    writeFileSync(join(v!.tmp, "r2-empty.json"), JSON.stringify({}));
    initSecureDomain({
      env: {},
      cwd: v!.outside,
      home: v!.home,
      settingsPath: join(v!.tmp, "r2-empty.json"),
      readMountinfo: () => v!.unmounted,
      warn: () => undefined,
    });
    expect(judgePrivateNsGate({ env: {} }).gate).toBe("not-ns");
  });

  it("secureConfigNsFactor matrix", () => {
    expect(secureConfigNsFactor(undefined)).toBe("absent");
    expect(secureConfigNsFactor({ present: false, enabled: true, valid: true, vaults: [], invalid: [] })).toBe(
      "absent",
    );
    expect(
      secureConfigNsFactor({ present: true, enabled: true, valid: false, vaults: [], invalid: [], error: "x" }),
    ).toBe("unusable");
    expect(
      secureConfigNsFactor({
        present: true,
        enabled: true,
        valid: true,
        vaults: [],
        invalid: [{ name: "B", reason: "dir" }],
      }),
    ).toBe("unusable");
    expect(secureConfigNsFactor({ present: true, enabled: false, valid: true, vaults: [], invalid: [] })).toBe("off");
    expect(secureConfigNsFactor({ present: true, enabled: true, valid: true, vaults: [], invalid: [] })).toBe("ok");
  });
});
