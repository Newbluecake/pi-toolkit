/**
 * P1 launcher helper (`src/secure/bin/helper.mjs`) — pure-function unit tests
 * (docs/dev/data-encryption/plan.md §2.1–§2.5, §6 "单测 helper.mjs").
 *
 * - parity: the shared fixture `tests/fixtures/secure-contract-parity.json` (also run by P2 against
 *   src/secure/config.ts — the two sides never import each other)
 * - argument audit with the REAL pi `parseArgs` (devDependency pi 1.3.x)
 * - project sessionDir sync, layout/sentinel checks, /proc cwd scan, swap/core/traffic-record
 *   detection, bounded `finalize` with injected stages, run env / -C resolution
 *
 * Nothing here mounts anything; FUSE-backed behaviour lives in launcher-fuse.test.ts.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const HELPER = join(REPO, "src", "secure", "bin", "helper.mjs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS module, no typings by design
const H: any = await import(pathToFileURL(HELPER).href);
const PI_PKG = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent");
type ParseArgs = (a: string[]) => Record<string, unknown>;
const parseArgs: ParseArgs = (await import(pathToFileURL(join(PI_PKG, "dist", "cli", "args.js")).href)).parseArgs;

const scratch: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(d, 0o700);
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) {
    try {
      chmodSync(d, 0o700);
    } catch {
      /* ignore */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

interface ParityFixture {
  home: string;
  settings: { name: string; input: unknown; expect: unknown; probe?: string[] }[];
  mountinfo: { name: string; mountinfo: string; realMnt: string; realCipher: string; expect: string }[];
}
const PARITY: ParityFixture = JSON.parse(
  readFileSync(join(REPO, "tests", "fixtures", "secure-contract-parity.json"), "utf8"),
) as ParityFixture;

describe("contract parity (shared fixture with src/secure/config.ts)", () => {
  it("fixture is non-trivial", () => {
    expect(PARITY.settings.length).toBeGreaterThanOrEqual(10);
    expect(PARITY.mountinfo.length).toBeGreaterThanOrEqual(8);
  });
  for (const c of PARITY.settings) {
    it(`settings: ${c.name}`, () => {
      const io = { legacyMntDir: (mnt: string) => (c.probe ?? []).includes(mnt) };
      expect(JSON.parse(JSON.stringify(H.parseSecureConfig(c.input, PARITY.home, io)))).toEqual(c.expect);
    });
  }
  for (const c of PARITY.mountinfo) {
    it(`mountinfo: ${c.name}`, () => {
      expect(H.vaultMountState(c.mountinfo, c.realMnt, c.realCipher)).toBe(c.expect);
    });
  }
  it("derived paths follow the §L.1 layout (mnt IS the mount point)", () => {
    const r = H.parseSecureConfig({ secure: { vaults: { acme: {} } } }, "/home/u", { legacyMntDir: () => false });
    expect(r.vaults[0]).toEqual({
      name: "acme",
      dir: "/home/u/.local/share/pi-toolkit-secure/acme",
      mnt: "/home/u/secure/acme",
      cipher: "/home/u/.local/share/pi-toolkit-secure/acme/cipher",
      work: "/home/u/secure/acme/work",
      state: "/home/u/secure/acme/state",
      sessionDir: "/home/u/secure/acme/state/sessions/default",
      lock: "/home/u/.local/share/pi-toolkit-secure/acme/mount.lock",
      lease: "/home/u/.local/share/pi-toolkit-secure/acme/mount.lease",
    });
  });
});

describe("argument audit with the real pi parseArgs (§2.2.1 + P0 C4)", () => {
  const v = H.deriveVault("acme", "/vault/acme", "/home/u/secure/acme");
  const sessionsRoot = join(v.state, "sessions");
  const audit = (argv: string[], cwd = v.work) =>
    H.auditParsedArgs(parseArgs(argv), { cwd, sessionsRoot, home: "/home/u" });

  it("the real parseArgs passes the shape self-test", () => {
    expect(H.parseArgsShapeOk(parseArgs)).toBe(true);
  });
  it("a drifted parseArgs fails the shape self-test (fail closed)", () => {
    expect(H.parseArgsShapeOk(() => ({ messages: [], fileArgs: [] }))).toBe(false);
    expect(
      H.parseArgsShapeOk(() => {
        throw new Error("x");
      }),
    ).toBe(false);
    expect(H.auditParsedArgs({ messages: [] }, { cwd: v.work, sessionsRoot }).ok).toBe(false);
  });

  const allowed: [string, string[]][] = [
    ["no args", []],
    ["--version", ["--version"]],
    ["-p message", ["-p", "hello"]],
    ["--fork <outside path> (copies INTO the vault)", ["--fork", "/home/u/.pi/agent/sessions/x/old.jsonl"]],
    ["--fork <id>", ["--fork", "0193abcd"]],
    ["--session <id>", ["--session", "0193abcd"]],
    ["--session <path inside sessions/>", ["--session", join(sessionsRoot, "default", "a.jsonl")]],
    ["--session relative path resolving inside", ["--session", "../state/sessions/default/a.jsonl"]],
    ["@file (read into the vault session)", ["@/etc/hostname", "summarize"]],
    ["--no-session", ["--no-session", "-p", "hi"]],
    ["--session-id", ["--session-id", "11111111-1111-4111-8111-111111111111"]],
    ["-c / -r", ["-c"]],
    ["model/thinking flags", ["--model", "a/b", "--thinking", "high"]],
    ["`--` makes everything after a message", ["--", "--session-dir", "/tmp/x", "--export", "y", "--no-extensions"]],
  ];
  for (const [name, argv] of allowed) {
    it(`allows ${name}`, () => {
      expect(audit(argv)).toEqual({ ok: true });
    });
  }

  const rejected: [string, string[], RegExp][] = [
    ["--session-dir <x>", ["--session-dir", "/tmp/x"], /--session-dir/],
    ['--session-dir "" (presence, not truthiness)', ["--session-dir", ""], /--session-dir/],
    ["dangling --session-dir", ["-p", "hi", "--session-dir"], /--session-dir/],
    ["--session-dir=x form", ["--session-dir=/tmp/x"], /--session-dir/],
    ["dangling --fork", ["--fork"], /--fork/],
    ["dangling --session", ["--session"], /--session/],
    ["--session <path outside the vault>", ["--session", "/home/u/.pi/agent/sessions/x/a.jsonl"], /--session/],
    ["--session a.jsonl (relative, resolves to cwd = work, not sessions/)", ["--session", "a.jsonl"], /--session/],
    ["--session ../../escape", ["--session", "../state/sessions/../../../x.jsonl"], /--session/],
    ["--session ~/x.jsonl", ["--session", "~/x.jsonl"], /--session/],
    ["--session <sessions root itself>", ["--session", `${sessionsRoot}/`], /--session/],
    ["--no-extensions", ["--no-extensions"], /--no-extensions/],
    ["-ne", ["-ne"], /--no-extensions/],
    ["-e <path>", ["-e", "/x/ext.ts"], /extension/],
    ["--extension <path>", ["--extension", "/x/ext.ts"], /extension/],
    ["--export <file>", ["--export", "/tmp/s.jsonl"], /--export/],
  ];
  for (const [name, argv, re] of rejected) {
    it(`rejects ${name}`, () => {
      const r = audit(argv);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(re);
    });
  }

  it("physical pass: a symlink under sessions/ that points outside is rejected", () => {
    const root = tmp("ps-audit-");
    const sessions = join(root, "state", "sessions");
    mkdirSync(join(sessions, "default"), { recursive: true });
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(sessions, "evil"));
    const p = parseArgs(["--session", join(sessions, "evil", "a.jsonl")]);
    expect(H.auditParsedArgs(p, { cwd: root, sessionsRoot: sessions }).ok).toBe(true); // lexical: inside
    const r = H.auditParsedArgs(p, { cwd: root, sessionsRoot: sessions, physical: true });
    expect(r.ok).toBe(false);
    const ok = parseArgs(["--session", join(sessions, "default", "new.jsonl")]);
    expect(H.auditParsedArgs(ok, { cwd: root, sessionsRoot: sessions, physical: true }).ok).toBe(true);
  });

  it("sessionArgIsPath mirrors pi main.js", () => {
    expect(H.sessionArgIsPath("abc")).toBe(false);
    expect(H.sessionArgIsPath("a/b")).toBe(true);
    expect(H.sessionArgIsPath("a\\b")).toBe(true);
    expect(H.sessionArgIsPath("x.jsonl")).toBe(true);
  });
});

describe("pi package discovery", () => {
  it("findPiPackage walks up from the real pi entry to the package root", () => {
    expect(H.findPiPackage(join(PI_PKG, "dist", "cli.js"))).toBe(
      join(REPO, "node_modules", "@earendil-works", "pi-coding-agent"),
    );
  });
  it("returns undefined for a foreign binary", () => {
    expect(H.findPiPackage("/bin/sh")).toBeUndefined();
  });
});

describe("project sessionDir sync (§2.3)", () => {
  function vault() {
    const root = tmp("ps-sync-");
    const v = H.deriveVault("acme", join(root, "v"), join(root, "m"));
    mkdirSync(v.work, { recursive: true });
    mkdirSync(v.sessionDir, { recursive: true });
    return v;
  }
  const file = (v: { work: string }) => join(v.work, ".pi", "settings.json");

  it("writes a fresh file, then is idempotent", () => {
    const v = vault();
    expect(H.syncProjectSettings(v).kind).toBe("written");
    expect(JSON.parse(readFileSync(file(v), "utf8"))).toEqual({ sessionDir: v.sessionDir });
    expect(H.syncProjectSettings(v).kind).toBe("unchanged");
  });
  it("merges only sessionDir into an existing settings file", () => {
    const v = vault();
    mkdirSync(join(v.work, ".pi"));
    writeFileSync(file(v), JSON.stringify({ theme: "dark", packages: ["x"] }));
    expect(H.syncProjectSettings(v).kind).toBe("written");
    expect(JSON.parse(readFileSync(file(v), "utf8"))).toEqual({
      theme: "dark",
      packages: ["x"],
      sessionDir: v.sessionDir,
    });
  });
  it("a different sessionDir is a conflict (nothing written) until --fix-settings, which backs up first", () => {
    const v = vault();
    mkdirSync(join(v.work, ".pi"));
    const orig = JSON.stringify({ sessionDir: "/home/u/old-sessions", theme: "x" });
    writeFileSync(file(v), orig);
    const r = H.syncProjectSettings(v);
    expect(r.kind).toBe("conflict");
    expect(r.message).toContain("--fix-settings");
    expect(readFileSync(file(v), "utf8")).toBe(orig);
    const f = H.syncProjectSettings(v, { fix: true, now: new Date(2026, 9, 23, 13, 0, 0) });
    expect(f.kind).toBe("fixed");
    expect(f.backup).toBe(`${file(v)}.bak-20261023-130000`);
    expect(readFileSync(f.backup, "utf8")).toBe(orig);
    expect(JSON.parse(readFileSync(file(v), "utf8"))).toEqual({ sessionDir: v.sessionDir, theme: "x" });
  });
  it("equivalent spellings (trailing slash, symlinked path) count as the same value", () => {
    const v = vault();
    mkdirSync(join(v.work, ".pi"));
    writeFileSync(file(v), JSON.stringify({ sessionDir: `${v.sessionDir}/` }));
    expect(H.syncProjectSettings(v).kind).toBe("unchanged");
    const alias = join(v.mnt, "..", "alias");
    symlinkSync(v.mnt, alias);
    writeFileSync(file(v), JSON.stringify({ sessionDir: join(alias, "state", "sessions", "default") }));
    expect(H.syncProjectSettings(v).kind).toBe("unchanged");
  });
  it("unparsable settings: conflict; --fix-settings backs up and writes a minimal object", () => {
    const v = vault();
    mkdirSync(join(v.work, ".pi"));
    writeFileSync(file(v), "{ // jsonc\n}");
    expect(H.syncProjectSettings(v).kind).toBe("conflict");
    const f = H.syncProjectSettings(v, { fix: true });
    expect(f.kind).toBe("fixed");
    expect(f.droppedOtherKeys).toBe(true);
    expect(JSON.parse(readFileSync(file(v), "utf8"))).toEqual({ sessionDir: v.sessionDir });
  });
  it("a symlinked .pi or settings.json is refused, never followed", () => {
    const v = vault();
    const elsewhere = join(v.dir, "..", "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(v.work, ".pi"));
    expect(H.syncProjectSettings(v, { fix: true }).kind).toBe("conflict");
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe("layout / sentinels (§L.1)", () => {
  /** A scratch "home": dir under <root>/v, mount point at the DEFAULT <root>/secure/<name>. */
  function fresh(name = "acme") {
    const root = tmp("ps-layout-");
    const v = H.deriveVault(name, join(root, "v"), H.defaultVaultMnt(name, root));
    H.createLayout(v, { home: root });
    writeFileSync(join(v.cipher, "gocryptfs.conf"), "{}");
    return { root, v };
  }
  it("createLayout builds private dirs + 0-byte 0400 sentinels + lock + lease (no entry symlink)", () => {
    const { v } = fresh();
    expect(H.checkLayout(v, { home: join(v.mnt, "..", "..") })).toEqual({ exists: true, problems: [] });
    expect(readdirSync(v.mnt).sort()).toEqual(["state", "work"]);
    for (const n of ["work", "state"]) {
      const st = lstatSync(join(v.mnt, n));
      expect(st.isFile()).toBe(true);
      expect(st.size).toBe(0);
      expect(st.mode & 0o7777).toBe(0o400);
    }
    expect(existsSync(v.lock)).toBe(true);
    const lease = lstatSync(v.lease);
    expect(lease.isFile()).toBe(true);
    expect(lease.size).toBe(0);
    expect(lease.mode & 0o777).toBe(0o600);
    expect(existsSync(join(v.mnt, "..", "..", "secure"))).toBe(true); // ~/secure was created 0700
    expect(() => H.createLayout(v, { home: join(v.mnt, "..", "..") })).toThrow(/已存在/);
  });
  it("createLayout refuses an existing mount point (78) and a non-default missing parent", () => {
    const root = tmp("ps-layout2-");
    const v = H.deriveVault("acme", join(root, "v2"), join(root, "elsewhere", "acme"));
    try {
      H.createLayout(v, { home: root });
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: number }).code).toBe(H.EXIT.CONFIG);
      expect((e as Error).message).toMatch(/挂载点父目录.*不存在/);
    }
    const root2 = tmp("ps-layout3-");
    const v2 = H.deriveVault("acme", join(root2, "v2"), join(root2, "mnt-here"));
    mkdirSync(join(root2, "mnt-here"), { mode: 0o700 });
    try {
      H.createLayout(v2, { home: root2 });
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: number }).code).toBe(H.EXIT.CONFIG);
      expect((e as Error).message).toMatch(/挂载点.*已存在/);
    }
    expect(existsSync(join(root2, "v2"))).toBe(false);
  });
  /** Security review L0 #1: both LEXICAL and PHYSICAL addresses, full 2×2 bidirectional matrix. */
  it("position rules: lexical containment both ways + all four cross-vault directions", () => {
    const root = tmp("ps-pos-");
    const home = join(root, "home");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    const mk = (name: string, dir: string, mnt: string) => H.deriveVault(name, dir, mnt);
    expect(H.positionProblems(mk("a", join(root, "a"), join(root, "a", "inside")), [], home)).toHaveLength(1);
    expect(H.positionProblems(mk("a", join(root, "m", "a"), join(root, "m")), [], home)).toHaveLength(1);
    const other = mk("b", join(root, "b"), join(root, "bb"));
    // every {new.mnt,new.dir} × {other.mnt,other.dir} pair, BOTH directions (review #1's two missing pairs included)
    expect(H.positionProblems(mk("a", join(root, "x"), join(root, "b", "sub")), [other], home).length).toBe(1); // om ⊆ new.mnt
    expect(H.positionProblems(mk("a", join(root, "x"), join(root, "bb", "sub")), [other], home).length).toBe(1); // od ⊆ new.mnt
    expect(H.positionProblems(mk("a", join(root, "b", "sub2"), join(root, "y")), [other], home).length).toBe(1); // new.dir ⊆ od
    expect(H.positionProblems(mk("a", join(root, "bb", "sub2"), join(root, "y")), [other], home).length).toBe(1); // new.dir ⊆ om
    expect(H.positionProblems(mk("a", join(root, "x"), join(root, "y")), [other], home)).toHaveLength(0);
    expect(
      H.positionProblems(mk("a", join(root, "x"), join(home, ".pi", "agent", "deep")), [other], home),
    ).toHaveLength(1);
    // a vault overlapping ITSELF via its own name in `others` is ignored
    const self = mk("a", join(root, "a"), join(root, "aa"));
    expect(H.positionProblems(self, [self, other], home)).toHaveLength(0);
  });
  /** Review r2 B: the exact two directions the pre-review predicate MISSED (strict ancestry, so no
   *  other containment pair fires) — verified to FAIL under the old six-condition predicate (see
   *  L0-report §安全复审第 2 轮处置 for the differential run). */
  it("review #1/r2 B: new.mnt ⊇ other.dir and new.dir ⊇ other.mnt (the two previously-missed directions)", () => {
    const root = tmp("ps-pos3-");
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    // new.mnt (root/b) is a STRICT ANCESTOR of other.dir (root/b/deep)
    const other = H.deriveVault("b", join(root, "b", "deep"), join(root, "bb"));
    const v1 = H.deriveVault("a", join(root, "x"), join(root, "b"));
    expect(H.positionProblems(v1, [other], home)).toHaveLength(1);
    // new.dir (root/k2) is a STRICT ANCESTOR of other.mnt (root/k2/sub)
    const other2 = H.deriveVault("b", join(root, "b2"), join(root, "k2", "sub"));
    const v2 = H.deriveVault("a", join(root, "k2"), join(root, "y"));
    expect(H.positionProblems(v2, [other2], home)).toHaveLength(1);
    // sanity: disjoint placements stay clean
    expect(H.positionProblems(H.deriveVault("a", join(root, "z"), join(root, "z2")), [other, other2], home)).toEqual(
      [],
    );
  });

  it("review #1: a parent-dir SYMLINK cannot smuggle the mount point into a forbidden zone (physical compare)", () => {
    const root = tmp("ps-pos2-");
    const home = join(root, "home");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
    symlinkSync(join(home, ".pi", "agent"), join(home, "agent-alias"));
    const v = H.deriveVault("a", join(root, "meta-a"), join(home, "agent-alias", "acme"));
    expect(H.positionProblems(v, [], home)).toHaveLength(1); // lexical looks fine; physical hits the agent dir
    // the same trick against ANOTHER vault's metadata subtree
    const home2 = join(root, "home2");
    const other = H.deriveVault("b", join(home2, "vaults", "b"), join(home2, "secure", "b"));
    mkdirSync(join(home2, "vaults", "b"), { recursive: true, mode: 0o700 });
    symlinkSync(join(home2, "vaults", "b"), join(home2, "link-to-b"));
    const v2 = H.deriveVault("a", join(root, "meta-a2"), join(home2, "link-to-b", "acme"));
    expect(H.positionProblems(v2, [other], home2)).toHaveLength(1);
    // and the reverse: our DIR behind a symlink inside another vault's MNT
    const home3 = join(root, "home3");
    const other3 = H.deriveVault("b", join(home3, "vaults", "b"), join(home3, "secure", "b"));
    mkdirSync(join(home3, "secure", "b"), { recursive: true, mode: 0o700 });
    symlinkSync(join(home3, "secure", "b"), join(home3, "link-to-bmnt"));
    const v3 = H.deriveVault("a", join(home3, "link-to-bmnt", "meta"), join(home3, "secure", "a"));
    expect(H.positionProblems(v3, [other3], home3)).toHaveLength(1);
  });
  /** Security review L0 #2: the WHOLE ancestor chain of the mount point is validated. */
  /** Full new-layout skeleton on disk so checkLayout gets past the <dir> side. */
  function buildSkeleton(dir: string, mnt: string, name = "a") {
    const v = H.deriveVault(name, dir, mnt);
    mkdirSync(v.mnt, { recursive: true, mode: 0o700 });
    for (const n of ["work", "state"]) {
      writeFileSync(join(v.mnt, n), "");
      chmodSync(join(v.mnt, n), 0o400);
    }
    mkdirSync(v.dir, { recursive: true, mode: 0o700 });
    mkdirSync(v.cipher, { mode: 0o700 });
    writeFileSync(join(v.cipher, "gocryptfs.conf"), "{}");
    writeFileSync(v.lock, "", { mode: 0o600 });
    writeFileSync(v.lease, "", { mode: 0o600 });
    return v;
  }
  it("review #2: ancestor chain — symlink level or group-writable non-sticky level under HOME ⇒ problem", () => {
    const root = tmp("ps-anc-");
    const home = join(root, "home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "real-mid"), { mode: 0o700 });
    symlinkSync(join(root, "real-mid"), join(home, "mid")); // a symlink level below HOME
    const v = buildSkeleton(join(root, "meta"), join(home, "mid", "acme"));
    expect(H.checkLayout(v, { home }).problems.join()).toMatch(/须为真实目录/);
    const home2 = join(root, "home2");
    mkdirSync(join(home2, "gww"), { recursive: true, mode: 0o770 }); // group-writable, not sticky
    const v2 = buildSkeleton(join(root, "meta2"), join(home2, "gww", "acme"));
    expect(H.checkLayout(v2, { home: home2 }).problems.join()).toMatch(/组\/其他可写/);
  });
  it("review #2: a clean chain passes; outside HOME the chain runs to / (sticky /tmp allowed)", () => {
    const root = tmp("ps-anc2-");
    const home = join(root, "home"); // HOME nowhere near the mount point ⇒ chain runs up to /
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const v = buildSkeleton(join(root, "meta"), join(root, "mnt-here", "a"));
    // /tmp is root-owned, world-writable BUT sticky ⇒ allowed
    expect(H.checkLayout(v, { home }).problems).toEqual([]);
    chmodSync(join(root, "mnt-here"), 0o770); // group-writable non-sticky anywhere on the chain
    expect(H.checkLayout(v, { home }).problems.join()).toMatch(/组\/其他可写/);
    chmodSync(join(root, "mnt-here"), 0o700);
    // r2 A1: NO home exemption any more — the in-home chain continues through $HOME up to /
    // (all levels comply here: home is ours 0700, /tmp is root+sticky, / is root)
    const root2 = tmp("ps-anc3-");
    const home2 = join(root2, "home");
    mkdirSync(join(home2, "secure"), { recursive: true, mode: 0o700 });
    const v2 = buildSkeleton(join(root2, "meta"), join(home2, "secure", "a"));
    expect(H.checkLayout(v2, { home: home2 }).problems).toEqual([]);
  });
  it("review #2: mount-point identity pin — a path swap (or vanish) between checks is detected", () => {
    const root = tmp("ps-pin-");
    const v = H.deriveVault("a", join(root, "meta"), join(root, "mnt"));
    mkdirSync(v.mnt, { mode: 0o700 });
    const pin = H.pinMountPoint(v);
    expect(typeof pin.dev).toBe("number");
    expect(typeof pin.ino).toBe("number");
    expect(H.mountPointPinStillValid(v, pin)).toBe(true);
    renameSync(v.mnt, join(root, "moved-away")); // swap: validated dir away, another dir in place
    mkdirSync(v.mnt, { mode: 0o700 });
    expect(() => H.mountPointPinStillValid(v, pin)).toThrow(/被替换/);
    H.closeMountPointPin(pin);
    const v2 = { ...v, mnt: join(root, "mnt2") };
    mkdirSync(v2.mnt, { mode: 0o700 });
    const pin2 = H.pinMountPoint(v2);
    rmSync(v2.mnt, { recursive: true });
    expect(() => H.mountPointPinStillValid(v2, pin2)).toThrow(/消失/);
  });
  it("review #2/r2: post-mount identity — fd readlink == pin path, mountinfo entry, parent dev/ino, fuse dev", () => {
    const root = tmp("ps-ver-");
    const v = H.deriveVault("a", join(root, "meta"), join(root, "mnt"));
    mkdirSync(v.mnt, { mode: 0o700 });
    const pin = H.pinMountPoint(v);
    expect(pin.path).toBe(realpathSync(v.mnt)); // captured pre-mount, physical
    expect(pin.parent.dev).toBe(statSync(root).dev); // parent identity pinned too
    const st = statSync(v.mnt);
    const parentSt = statSync(root);
    const maj = (st.dev >> 8) & 0xfff; // reverse of glibc makedev for the small devices fuse uses
    const min = st.dev & 0xff;
    expect(H.devFromMajMin(maj, min)).toBe(st.dev);
    const okLine = `40 25 ${maj}:${min} / ${pin.path} rw - fuse.gocryptfs ${join(v.dir, "cipher")} rw`;
    const statByPath = (p: string) => (p === v.mnt ? st : parentSt);
    expect(
      H.verifyMountPointIdentity(v, pin, {
        readMountinfo: () => okLine + "\n",
        stat: statByPath,
        readlink: () => pin.path, // (a) the pinned inode never moved
      }),
    ).toBe(true);
    // (a) violated: the pinned dir was renamed away during the mount window
    const pin2 = H.pinMountPoint(v);
    expect(() =>
      H.verifyMountPointIdentity(v, pin2, {
        readMountinfo: () => okLine + "\n",
        stat: statByPath,
        readlink: () => join(root, "moved-elsewhere"),
      }),
    ).toThrow(/被改名\/替换/);
    // (c) violated: the parent directory itself was swapped
    const pin3 = H.pinMountPoint(v);
    const otherParent = { ...parentSt, ino: parentSt.ino === 1 ? 2 : 1 };
    expect(() =>
      H.verifyMountPointIdentity(v, pin3, {
        readMountinfo: () => okLine + "\n",
        stat: (p: string) => (p === v.mnt ? st : otherParent),
        readlink: () => pin3.path,
      }),
    ).toThrow(/父目录.*身份变化/);
    // (b)/(+) violated: the path hosts a DIFFERENT device than the mountinfo line
    const pin4 = H.pinMountPoint(v);
    const otherSt = { ...st, dev: st.dev === 47 ? 48 : 47 };
    const badLine = `40 25 0:99 / ${pin.path} rw - fuse.gocryptfs ${join(v.dir, "cipher")} rw`;
    expect(() =>
      H.verifyMountPointIdentity(v, pin4, {
        readMountinfo: () => badLine + "\n",
        stat: (p: string) => (p === v.mnt ? otherSt : parentSt),
        readlink: () => pin4.path,
      }),
    ).toThrow(/身份核验失败/);
    // (b) violated: no entry at the pinned path for OUR cipher
    const pin5 = H.pinMountPoint(v);
    expect(() =>
      H.verifyMountPointIdentity(v, pin5, { readMountinfo: () => "", stat: statByPath, readlink: () => pin5.path }),
    ).toThrow(/没有.*gocryptfs 条目/);
  });
  it("review #2/r2 A1: the ancestor chain now runs to / — HOME itself is checked, no exemption", () => {
    const root = tmp("ps-anc4-");
    const home = join(root, "home");
    mkdirSync(join(home, "secure"), { recursive: true, mode: 0o700 });
    const v = buildSkeleton(join(root, "meta"), join(home, "secure", "a"));
    expect(H.checkLayout(v, { home }).problems).toEqual([]); // clean home passes
    chmodSync(home, 0o770); // a group-writable shared HOME ⇒ the chain is untrustworthy
    const problems = H.checkLayout(v, { home }).problems.join();
    expect(problems).toContain(home);
    expect(problems).toMatch(/组\/其他可写/);
    chmodSync(home, 0o700);
    expect(H.checkLayout(v, { home }).problems).toEqual([]);
  });
  it("review #2/r2 A1: foreign-uid level ⇒ rejected; sticky only excuses ROOT-owned dirs", () => {
    const root = tmp("ps-anc5-");
    const dir = join(root, "x", "acme");
    const v = H.deriveVault("a", join(root, "meta"), dir);
    const me = process.getuid();
    const stFor = (uid: number, mode: number) => ({ isDirectory: () => true, isSymbolicLink: () => false, uid, mode });
    const foreign = me === 12345 ? 54321 : 12345; // a uid that is neither ours nor root
    const fakeLstat = (uid: number, mode: number) => (p: string) =>
      p.endsWith("/x") ? stFor(uid, mode) : lstatSync(p);
    // a level owned by another non-root user
    expect(H.mntAncestorProblems(v, me, { lstat: fakeLstat(foreign, 0o700) }).join()).toMatch(
      new RegExp(`属于其他用户（uid ${foreign}）`),
    );
    // sticky + world-writable but owned by US (not root) ⇒ still rejected ("sticky 只豁免 root")
    expect(H.mntAncestorProblems(v, me, { lstat: fakeLstat(me, 0o1777) }).join()).toMatch(/组\/其他可写.*属主非 root/);
    // sticky + world-writable + root-owned ⇒ the ONLY exception (like /tmp)
    expect(H.mntAncestorProblems(v, me, { lstat: fakeLstat(0, 0o1777) }).join()).toBe("");
  });
  it("missing gocryptfs.conf ⇒ incomplete; missing/wrong lease ⇒ problem (new layout only)", () => {
    const root = tmp("ps-layout4-");
    const v = H.deriveVault("acme", join(root, "v"), H.defaultVaultMnt("acme", root));
    H.createLayout(v, { home: root });
    expect(H.checkLayout(v, { home: root }).problems.join()).toMatch(/gocryptfs\.conf/);
    writeFileSync(join(v.cipher, "gocryptfs.conf"), "{}");
    rmSync(v.lease);
    expect(H.checkLayout(v, { home: root }).problems.join()).toMatch(/mount\.lease 缺失/);
    writeFileSync(v.lease, "", { mode: 0o600 });
    chmodSync(v.lease, 0o644);
    expect(H.checkLayout(v, { home: root }).problems.join()).toMatch(/mount\.lease 须为本用户的 0600/);
    chmodSync(v.lease, 0o600);
    expect(H.checkLayout(v, { home: root }).problems).toEqual([]);
  });
  it("an extra entry under <mnt>/ is refused (78 at mount time)", () => {
    const { root, v } = fresh();
    writeFileSync(join(v.mnt, "extra"), "");
    expect(H.checkLayout(v, { home: root }).problems.join()).toMatch(/多余条目：extra/);
  });
  it("a sentinel with content / wrong mode / replaced by a dir is refused", () => {
    const { root, v } = fresh();
    chmodSync(join(v.mnt, "work"), 0o600);
    writeFileSync(join(v.mnt, "work"), "x");
    expect(H.checkLayout(v, { home: root }).problems.join()).toMatch(/哨兵 .*work/);
    const v2 = fresh();
    chmodSync(join(v2.v.mnt, "state"), 0o600);
    rmSync(join(v2.v.mnt, "state"));
    mkdirSync(join(v2.v.mnt, "state"));
    expect(H.checkLayout(v2.v, { home: v2.root }).problems.join()).toMatch(/哨兵 .*state/);
  });
  it("group/other-accessible dirs are refused", () => {
    const { root, v } = fresh();
    chmodSync(v.dir, 0o750);
    expect(H.checkLayout(v, { home: root }).problems.join()).toMatch(/0700/);
  });
  it("mounted=true skips the sentinel checks (parent + position rules still apply)", () => {
    const { root, v } = fresh();
    writeFileSync(join(v.mnt, "extra"), "");
    expect(H.checkLayout(v, { mounted: true, home: root }).problems).toEqual([]);
  });

  // ── legacy layout (§L.3): read-only compat ──
  function legacyVault() {
    const root = tmp("ps-legacy-");
    const v = H.deriveLegacyVault("old", join(root, "v"));
    mkdirSync(join(root, "v", "cipher"), { recursive: true, mode: 0o700 });
    writeFileSync(join(v.cipher, "gocryptfs.conf"), "{}");
    mkdirSync(v.mnt, { mode: 0o700 });
    for (const n of ["work", "state"]) {
      writeFileSync(join(v.mnt, n), "", { mode: 0o400 });
    }
    writeFileSync(v.lock, "", { mode: 0o600 });
    return v;
  }
  it("a legacy vault parses from a link key / an on-disk <dir>/mnt; layout stays legacy-clean without a lease", () => {
    expect(H.parseSecureConfig({ secure: { vaults: { old: { link: "/entry/old" } } } }, "/home/u").vaults[0].mnt).toBe(
      "/home/u/.local/share/pi-toolkit-secure/old/mnt",
    );
    const home = tmp("ps-legacy2-");
    const dir = join(home, ".local", "share", "pi-toolkit-secure", "old");
    mkdirSync(join(dir, "mnt"), { recursive: true, mode: 0o700 });
    const r = H.parseSecureConfig({ secure: { vaults: { old: {} } } }, home); // real fs probe hits <dir>/mnt
    expect(r.vaults[0].layout).toBe("legacy");
    const explicit = H.parseSecureConfig({ secure: { vaults: { old: { mnt: join(home, "secure", "old") } } } }, home);
    expect(explicit.vaults[0].layout).toBeUndefined();
    expect(explicit.vaults[0].mnt).toBe(join(home, "secure", "old"));
  });
  it("legacy vaults: no lease/parent/position problems; refusal text names export→import", () => {
    const v = legacyVault();
    expect(H.checkLayout(v)).toEqual({ exists: true, problems: [] });
    expect(H.legacyRefusal(v)).toMatch(/旧布局（挂载点 .*\/mnt）/);
    expect(H.legacyRefusal(v)).toMatch(/pi-secure export old <文件>/);
  });
  it("physicalPaths NEVER realpaths the mount point itself (legacy: <dir>/mnt)", () => {
    const root = tmp("ps-phys-");
    const home = join(root, "home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    // mnt exists as a SYMLINK to elsewhere: a realpath through it would escape; we must NOT follow it
    const v = H.deriveVault("acme", join(root, "v"), join(home, "secure", "acme"));
    mkdirSync(join(root, "v"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "secure"), { recursive: true, mode: 0o700 });
    symlinkSync("/etc", join(home, "secure", "acme"));
    const pp = H.physicalPaths(v);
    expect(pp.realMnt).toBe(join(realpathSync(join(home, "secure")), "acme"));
    expect(pp.realMnt).not.toBe("/etc");
    const lg = H.physicalPaths(H.deriveLegacyVault("old", join(root, "v")));
    expect(lg.realMnt).toBe(join(realpathSync(join(root, "v")), "mnt"));
  });
});

describe("/proc cwd occupancy scan (§2.5 step 2)", () => {
  function fakeProc(entries: Record<string, string>) {
    const root = tmp("ps-proc-");
    for (const [pid, cwd] of Object.entries(entries)) {
      mkdirSync(join(root, pid));
      symlinkSync(cwd, join(root, pid, "cwd"));
      writeFileSync(join(root, pid, "comm"), `proc${pid}\n`);
    }
    mkdirSync(join(root, "self"));
    mkdirSync(join(root, "77")); // unreadable cwd (no link) ⇒ ignored
    return root;
  }
  it("finds processes whose cwd is the mount or below; ignores prefixes, self and unreadable", async () => {
    const proc = fakeProc({
      "10": "/v/mnt/work/a",
      "11": "/v/mntx",
      "12": "/v/mnt",
      "13": "/v/mnt/state (deleted)",
      "99": "/v/mnt",
    });
    const r = await H.scanCwdOccupants("/v/mnt", { deadline: Date.now() + 2000, procRoot: proc, selfPid: 99 });
    expect(r.kind).toBe("done");
    expect(r.occupants.map((o: { pid: number }) => o.pid).sort()).toEqual([10, 12, 13]);
    expect(r.occupants.find((o: { pid: number }) => o.pid === 10).comm).toBe("proc10");
  });
  it("too many entries ⇒ too-many (finalize then refuses to unmount)", async () => {
    const proc = fakeProc({ "1": "/", "2": "/", "3": "/" });
    expect(
      (await H.scanCwdOccupants("/v/mnt", { deadline: Date.now() + 2000, procRoot: proc, maxEntries: 2 })).kind,
    ).toBe("too-many");
  });
  it("respects the deadline", async () => {
    const proc = fakeProc({ "1": "/" });
    const t0 = Date.now();
    const r = await H.scanCwdOccupants("/v/mnt", { deadline: Date.now() + 200, procRoot: proc, delayMs: 5000 });
    expect(r.kind).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(1500);
  });
  it("the real /proc is scannable and sees a child sitting in a temp dir", async () => {
    const d = tmp("ps-occ-");
    const child = spawn("sleep", ["5"], { cwd: d, stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 100));
      const r = await H.scanCwdOccupants(d, { deadline: Date.now() + 3000 });
      expect(r.kind).toBe("done");
      expect(r.occupants.map((o: { pid: number }) => o.pid)).toContain(child.pid);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("bounded finalize (§2.5, injected stages)", () => {
  const v = H.deriveVault("acme", "/nonexistent/acme", "/nonexistent/link");
  const deps = (over: Record<string, unknown>) => ({
    mountState: () => "mounted",
    scan: async () => ({ kind: "done", occupants: [] }),
    unmount: async () => ({ kind: "exit", code: 0, stderr: "" }),
    ...over,
  });
  it("not mounted ⇒ ok, nothing spawned", async () => {
    let called = false;
    const r = await H.finalize(v, {
      deps: deps({ mountState: () => "absent", unmount: async () => ((called = true), {}) }),
    });
    expect(r.code).toBe(0);
    expect(called).toBe(false);
  });
  it("foreign mount ⇒ refuse", async () => {
    const r = await H.finalize(v, { deps: deps({ mountState: () => "foreign" }) });
    expect(r.code).toBe(H.EXIT.FAIL);
  });
  it("occupants ⇒ list ≤10 pids, do not unmount", async () => {
    let called = false;
    const occupants = Array.from({ length: 12 }, (_, i) => ({ pid: 100 + i, comm: "bash", cwd: "/x" }));
    const r = await H.finalize(v, {
      deps: deps({ scan: async () => ({ kind: "done", occupants }), unmount: async () => ((called = true), {}) }),
    });
    expect(r.code).toBe(H.EXIT.BUSY);
    expect(called).toBe(false);
    expect(r.lines.filter((l: string) => l.includes("pid ")).length).toBe(10);
    expect(r.lines.join("\n")).toMatch(/共 12 个/);
  });
  it("--lazy unmounts even with occupants", async () => {
    let lazySeen: unknown;
    const r = await H.finalize(v, {
      lazy: true,
      deps: deps({
        mountState: (() => {
          let n = 0;
          return () => (n++ === 0 ? "mounted" : "absent");
        })(),
        scan: async () => ({ kind: "done", occupants: [{ pid: 1, comm: "x", cwd: "/x" }] }),
        unmount: async (o: { lazy: boolean }) => ((lazySeen = o.lazy), { kind: "exit", code: 0, stderr: "" }),
      }),
    });
    expect(r.code).toBe(0);
    expect(lazySeen).toBe(true);
  });
  it("scan timeout ⇒ skip unmount with a warning", async () => {
    const r = await H.finalize(v, { deps: deps({ scan: async () => ({ kind: "timeout" }) }) });
    expect(r.code).toBe(H.EXIT.DEADLINE);
    expect(r.lines[0]).toMatch(/扫描超时/);
  });
  it("unmount timeout / lock timeout / EBUSY / other failure are reported distinctly", async () => {
    const cases: [unknown, number, RegExp][] = [
      [{ kind: "timeout" }, H.EXIT.DEADLINE, /预算内完成/],
      [{ kind: "exit", code: 73, stderr: "" }, H.EXIT.LOCK_BUSY, /mount\.lock/],
      [
        { kind: "exit", code: 1, stderr: "fusermount3: failed to unmount /x: Device or resource busy\n" },
        H.EXIT.BUSY,
        /EBUSY/,
      ],
      [{ kind: "exit", code: 1, stderr: "fusermount3: entry for /x not found\n" }, H.EXIT.FAIL, /not found/],
    ];
    for (const [u, code, re] of cases) {
      const r = await H.finalize(v, { deps: deps({ unmount: async () => u }) });
      expect(r.code).toBe(code);
      expect(r.lines.join("\n")).toMatch(re);
    }
  });
  it("stale mount skips the scan and goes straight to unmount", async () => {
    let scanned = false;
    const states = ["stale", "absent"];
    const r = await H.finalize(v, {
      deps: deps({
        mountState: () => states.shift(),
        scan: async () => ((scanned = true), { kind: "done", occupants: [] }),
      }),
    });
    expect(r.code).toBe(0);
    expect(scanned).toBe(false);
  });
  it("success is verified against mountinfo", async () => {
    const r = await H.finalize(v, { deps: deps({}) }); // mountState stays "mounted"
    expect(r.code).toBe(H.EXIT.FAIL);
    expect(r.lines[0]).toMatch(/挂载仍在/);
  });
  it("all stages share ONE budget: a scan eating the budget leaves no time to unmount", async () => {
    let called = false;
    const r = await H.finalize(v, {
      budgetMs: 1500,
      deps: deps({
        scan: async () => (await new Promise((res) => setTimeout(res, 800)), { kind: "done", occupants: [] }),
        unmount: async () => ((called = true), {}),
      }),
    });
    expect(called).toBe(false);
    expect(r.code).toBe(H.EXIT.DEADLINE);
  });
});

describe("swap / core / traffic-record detection (warn only)", () => {
  const header = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n";
  it("no swap ⇒ no warning", () => {
    expect(H.swapWarnings(header)).toEqual([]);
  });
  it("plain partition/file swap ⇒ warning", () => {
    const w = H.swapWarnings(`${header}/swap.img  file  2097148  0  -2\n`, {
      realpath: (p: string) => p,
      sys: () => undefined,
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/swap \/swap\.img/);
  });
  it("dm-crypt swap ⇒ quiet; zram without writeback ⇒ quiet; with writeback / unknown ⇒ warning", () => {
    const sys = (p: string) =>
      ({
        "/sys/block/dm-1/dm/uuid": "CRYPT-PLAIN-swap\n",
        "/sys/block/zram0/backing_dev": "none\n",
        "/sys/block/zram1/backing_dev": "/dev/sdb2\n",
      })[p];
    const text = `${header}/dev/mapper/cryptswap partition 1 0 -2\n/dev/zram0 partition 1 0 100\n/dev/zram1 partition 1 0 100\n/dev/zram2 partition 1 0 100\n`;
    const w = H.swapWarnings(text, { sys, realpath: (p: string) => (p === "/dev/mapper/cryptswap" ? "/dev/dm-1" : p) });
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/zram1.*writeback/);
    expect(w[1]).toMatch(/zram2/);
  });
  it("piped core_pattern warns (ulimit does not cover it); a plain one does not", () => {
    expect(H.coreWarnings("|/usr/share/apport/apport -p%p\n")[0]).toMatch(/apport/);
    expect(H.coreWarnings("core\n")).toEqual([]);
  });
  it("traffic-record: declared ⇒ quiet, undeclared ⇒ warn, unresolvable ⇒ warn, absent ⇒ quiet", () => {
    const home = tmp("ps-tr-");
    const agent = join(home, ".pi", "agent");
    const pkgOk = join(home, "ok", "pi-traffic-record");
    const pkgBad = join(home, "bad", "pi-traffic-record");
    mkdirSync(pkgOk, { recursive: true });
    mkdirSync(pkgBad, { recursive: true });
    mkdirSync(agent, { recursive: true });
    writeFileSync(
      join(pkgOk, "package.json"),
      JSON.stringify({ name: "x", piSecure: { honors: "PI_SECURE_SESSION/1" } }),
    );
    writeFileSync(join(pkgBad, "package.json"), JSON.stringify({ name: "x" }));
    const set = (packages: unknown[]) => writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages }));
    set([pkgOk, "../../other"]);
    expect(H.trafficRecordWarnings(home, agent)).toEqual([]);
    set([{ source: pkgBad }]);
    expect(H.trafficRecordWarnings(home, agent)[0]).toMatch(/未声明 piSecure/);
    set(["npm:@x/pi-traffic-record"]);
    expect(H.trafficRecordWarnings(home, agent)[0]).toMatch(/找不到/);
    set([]);
    expect(H.trafficRecordWarnings(home, agent)).toEqual([]);
  });
  it("this machine's real traffic-record checkout declares the contract (P3 landed)", () => {
    const real = "/home/bluecake/ai/pi-traffic-record/package.json";
    if (!existsSync(real)) return;
    const home = tmp("ps-tr2-");
    const agent = join(home, "agent");
    mkdirSync(agent);
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: ["/home/bluecake/ai/pi-traffic-record"] }));
    expect(H.trafficRecordWarnings(home, agent)).toEqual([]);
  });
  it("gocryptfs version parsing / comparison", () => {
    expect(H.parseGocryptfsVersion("gocryptfs 1.8.0; go-fuse 2.0.3; 2024-11-18 go1.18.1 linux/amd64")).toEqual([
      1, 8, 0,
    ]);
    expect(H.parseGocryptfsVersion("gocryptfs v2.4.0 without_openssl; go-fuse v2.4.0")).toEqual([2, 4, 0]);
    expect(H.parseGocryptfsVersion("nope")).toBeUndefined();
    expect(H.versionAtLeast([1, 8, 0], [1, 8])).toBe(true);
    expect(H.versionAtLeast([1, 7, 9], [1, 8])).toBe(false);
    expect(H.versionAtLeast([2, 0, 0], [1, 8])).toBe(true);
  });
});

describe("run env + -C resolution (§2.2 run, §2.4 env contract)", () => {
  const v = H.deriveVault("acme", "/vault/acme", "/home/u/secure/acme");
  it("sets the secure env, records originals, strips stale PI_SECURE_* and the env sessionDir", () => {
    const env = H.piChildEnv(v, `${v.work}/sub`, {
      PATH: "/bin",
      TMPDIR: "/tmp/orig",
      PI_SECURE_FOO: "stale",
      PI_CODING_AGENT_SESSION_DIR: "/elsewhere",
    });
    expect(env).toEqual({
      PATH: "/bin",
      TMPDIR: `${v.state}/tmp`,
      ARMORY_MEMORY_ROOT: `${v.state}/memory`,
      PI_SECURE_VAULT: "acme",
      PI_SECURE_SESSION: "1",
      PI_SECURE_ORIG_ENV: JSON.stringify({ TMPDIR: "/tmp/orig", ARMORY_MEMORY_ROOT: null }),
      PWD: `${v.work}/sub`,
    });
  });
  it("keeps an existing PI_SECURE_ORIG_ENV (nested launch never records vault paths as originals)", () => {
    const orig = JSON.stringify({ TMPDIR: null, ARMORY_MEMORY_ROOT: "/m" });
    const env = H.piChildEnv(v, v.work, { PI_SECURE_ORIG_ENV: orig, TMPDIR: "/other/state/tmp" });
    expect(env.PI_SECURE_ORIG_ENV).toBe(orig);
  });
  it("-C stays inside work", () => {
    expect(H.resolveRunCwd(v, undefined)).toBe(v.work);
    expect(H.resolveRunCwd(v, "pkg/a")).toBe(`${v.work}/pkg/a`);
    expect(H.resolveRunCwd(v, `${v.work}/pkg`)).toBe(`${v.work}/pkg`);
    expect(() => H.resolveRunCwd(v, "../state")).toThrow(/跳出/);
    expect(() => H.resolveRunCwd(v, `${v.mnt}/state`)).toThrow(/不在保险库/);
    expect(() => H.resolveRunCwd(v, "/etc")).toThrow(/不在保险库/);
  });
  it("-C physical check rejects a symlink pointing out of work", () => {
    const root = tmp("ps-cwd-");
    const w = H.deriveVault("acme", join(root, "v"), join(root, "l"));
    mkdirSync(join(w.work, "real"), { recursive: true });
    symlinkSync("/etc", join(w.work, "out"));
    expect(H.resolveRunCwd(w, "real", { physical: true })).toBe(join(w.work, "real"));
    expect(() => H.resolveRunCwd(w, "out", { physical: true })).toThrow(/保险库外/);
    expect(() => H.resolveRunCwd(w, "missing", { physical: true })).toThrow(/不存在/);
  });
});

describe("settings registration", () => {
  it("registerVault keeps unrelated keys and is atomic (0600 on create)", () => {
    const home = tmp("ps-reg-");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    const f = join(home, ".pi", "agent", "pi-subagent.json");
    writeFileSync(f, JSON.stringify({ hud: { enabled: true }, secure: { enabled: true, vaults: { old: {} } } }));
    chmodSync(f, 0o640);
    H.registerVault("acme", { dir: "/d/acme", mnt: "/l/acme" }, { home });
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({
      hud: { enabled: true },
      secure: { enabled: true, vaults: { old: {}, acme: { dir: "/d/acme", mnt: "/l/acme" } } },
    });
    expect(readdirSync(join(home, ".pi", "agent")).sort()).toEqual([".pi-subagent.json.lock", "pi-subagent.json"]);
    expect(statSync(f).mode & 0o777).toBe(0o640 & ~0o022);
    const r = H.resolveVault("acme", { home });
    expect(r.kind).toBe("ok");
    expect(r.vault.sessionDir).toBe("/l/acme/state/sessions/default");
  });
  it("refuses to rewrite an unparsable settings file", () => {
    const home = tmp("ps-reg-");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "pi-subagent.json"), "{bad");
    expect(() => H.registerVault("acme", { dir: "/d", mnt: "/l" }, { home })).toThrow(/拒绝改写/);
    expect(H.resolveVault("acme", { home }).kind).toBe("error");
  });
  it("resolveVault: bad name, unknown vault, invalid entry", () => {
    const home = tmp("ps-reg-");
    expect(H.resolveVault("Bad", { home }).code).toBe(H.EXIT.USAGE);
    expect(H.resolveVault("acme", { home }).code).toBe(H.EXIT.NOT_FOUND);
    expect(H.resolveVault("acme", { home, allowUnregistered: true }).registered).toBe(false);
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "pi-subagent.json"),
      JSON.stringify({ secure: { vaults: { acme: { dir: "rel" } } } }),
    );
    expect(H.resolveVault("acme", { home }).code).toBe(H.EXIT.CONFIG);
  });
});

// ───────────────────────────── security review fixes (P1 reject → r2) ─────────────────────────────

describe("review #1: every private dir component is checked (no symlinked state/sessions)", () => {
  function mountedLike() {
    const root = tmp("ps-r1-");
    const v = H.deriveVault("acme", join(root, "v"), join(root, "l"));
    mkdirSync(v.mnt, { recursive: true });
    const outside = join(root, "outside");
    mkdirSync(outside);
    return { root, v, outside };
  }
  it("a symlinked INTERMEDIATE component (state/sessions → outside) is refused and nothing is created outside", () => {
    const { v, outside } = mountedLike();
    mkdirSync(v.state);
    symlinkSync(outside, join(v.state, "sessions"));
    expect(() => H.ensureVaultDirs(v)).toThrow(/sessions 须为本用户的普通目录/);
    expect(readdirSync(outside)).toEqual([]);
  });
  it("…also when the final dir already exists behind the link", () => {
    const { v, outside } = mountedLike();
    mkdirSync(v.state);
    mkdirSync(join(outside, "default"));
    symlinkSync(outside, join(v.state, "sessions"));
    expect(() => H.ensureVaultDirs(v)).toThrow(/sessions 须为本用户的普通目录/);
    expect(readdirSync(outside)).toEqual(["default"]);
  });
  it("a symlinked state itself, or a file where a dir belongs, is refused", () => {
    const a = mountedLike();
    symlinkSync(a.outside, a.v.state);
    expect(() => H.ensureVaultDirs(a.v)).toThrow(/state 须为本用户的普通目录/);
    expect(readdirSync(a.outside)).toEqual([]);
    const b = mountedLike();
    mkdirSync(b.v.state);
    writeFileSync(join(b.v.state, "tmp"), "");
    expect(() => H.ensureVaultDirs(b.v)).toThrow(/tmp 须为本用户的普通目录/);
  });
  it("creates the full private tree level by level when absent", () => {
    const { v } = mountedLike();
    H.ensureVaultDirs(v);
    for (const d of ["sessions/default", "tmp", "bash-jobs", "workflows", "consult", "memory"])
      expect(statSync(join(v.state, d)).isDirectory()).toBe(true);
    expect(statSync(join(v.state, "sessions")).mode & 0o777).toBe(0o700);
  });
  it("realpath must equal the expected path under the CONFIRMED mount root", () => {
    const { v, root } = mountedLike();
    H.ensureVaultDirs(v);
    expect(() => H.ensureVaultDirs(v, { realMnt: join(root, "some-other-mount") })).toThrow(/不在已确认的挂载/);
  });
  it("verifyRunPaths: sessionDir / tmp / memory / cwd must physically be inside the mount", () => {
    const { v, outside } = mountedLike();
    H.ensureVaultDirs(v);
    const cwd = realpathSync(v.work);
    expect(H.verifyRunPaths(v, cwd).sessionDir).toBe(join(realpathSync(v.mnt), "state", "sessions", "default"));
    // pi would write --session-dir through a link planted AFTER ensureVaultDirs
    rmSync(v.sessionDir, { recursive: true });
    symlinkSync(outside, v.sessionDir);
    expect(() => H.verifyRunPaths(v, cwd)).toThrow(/不在保险库挂载内/);
    rmSync(v.sessionDir);
    mkdirSync(v.sessionDir);
    expect(() => H.verifyRunPaths(v, outside)).toThrow(/cwd/);
    symlinkSync(".", join(v.work, "self"));
    expect(() => H.verifyRunPaths(v, join(cwd, "self"))).toThrow(/cwd/); // non-canonical (symlinked) spelling
  });
});

describe("review #2: physical -C returns the canonical cwd the audit and the child share", () => {
  function tree() {
    const root = tmp("ps-r2-");
    const v = H.deriveVault("acme", join(root, "v"), join(root, "l"));
    mkdirSync(join(v.work, "a", "b"), { recursive: true });
    mkdirSync(join(v.state, "sessions", "default"), { recursive: true });
    symlinkSync(join(v.work, "a", "b"), join(v.work, "deep")); // shallow name → deeper dir
    return v;
  }
  it("default and -C both come back canonical (realpath)", () => {
    const v = tree();
    expect(H.resolveRunCwd(v, undefined, { physical: true })).toBe(realpathSync(v.work));
    expect(H.resolveRunCwd(v, "deep", { physical: true })).toBe(realpathSync(join(v.work, "a", "b")));
    expect(H.resolveRunCwd(v, "deep")).toBe(join(v.work, "deep")); // lexical pass keeps the lexical path
  });
  it("a relative --session that is inside lexically but outside physically is caught by the 2nd pass", () => {
    const v = tree();
    const p = parseArgs(["--session", "../../state/sessions/default/x.jsonl"]);
    const sessionsRoot = join(v.state, "sessions");
    const lex = H.resolveRunCwd(v, "deep");
    expect(H.auditParsedArgs(p, { cwd: lex, sessionsRoot }).ok).toBe(true); // W/deep/../.. = mnt
    const canon = H.resolveRunCwd(v, "deep", { physical: true });
    const r = H.auditParsedArgs(p, { cwd: canon, sessionsRoot: realpathSync(sessionsRoot), physical: true });
    expect(r.ok).toBe(false); // W/a/b/../.. = W → W/state/… is NOT the vault's sessions dir
  });
});

describe("review #3: mount probing never blocks the main thread", () => {
  const v = H.deriveVault("acme", "/nonexistent/acme", "/nonexistent/l");
  it("a mount probe that never settles is cut off at its deadline ⇒ 'hung' + leftover-mount warning, inside the budget", async () => {
    const t0 = Date.now();
    const r = await H.finalize(v, { budgetMs: 3000, deps: { mountState: () => new Promise(() => {}) } });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.code).toBe(H.EXIT.DEADLINE);
    expect(r.lines[0]).toMatch(/挂载探测超时.*可能仍挂载.*fusermount3 -uz/);
  });
  it("probeReaddirChild runs the readdir in a child: ok / error / timeout (child killed, not awaited)", async () => {
    const d = tmp("ps-r3-");
    expect(await H.probeReaddirChild(d, Date.now() + 5000)).toBe("ok");
    expect(await H.probeReaddirChild(join(d, "missing"), Date.now() + 5000)).toBe("error");
    const t0 = Date.now();
    expect(await H.probeReaddirChild(d, Date.now() + 1)).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it("probeMountState on a plain dir is 'absent' and never consults the readdir probe", async () => {
    const d = tmp("ps-r3b-");
    let called = false;
    const w = H.deriveVault("x", d, join(d, "l"));
    const st = await H.probeMountState(w, { readdirProbe: async () => ((called = true), "ok") });
    expect(st).toBe("absent");
    expect(called).toBe(false);
  });
  it("the helper source has no synchronous IO in the mount-probe / finalize path", () => {
    const src = readFileSync(HELPER, "utf8");
    const body = (name: string) => {
      const i = src.indexOf(`export async function ${name}(`);
      const j = src.indexOf("\n}\n", i);
      return src.slice(i, j);
    };
    for (const fn of ["probeMountState", "finalize"]) expect(body(fn)).not.toMatch(/Sync\(/);
    expect(src).not.toMatch(/liveMountState/);
  });
});

describe("review #5/#6: settings file writes are locked, and never through a symlink", () => {
  function agentHome() {
    const home = tmp("ps-r5-");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    return { home, file: join(home, ".pi", "agent", "pi-subagent.json") };
  }
  it("two processes registering different vaults concurrently lose nothing", async () => {
    const { home, file } = agentHome();
    writeFileSync(file, JSON.stringify({ keep: true }));
    const worker = (prefix: string) =>
      new Promise<number | null>((resolve) => {
        const script = `const H = await import(${JSON.stringify(pathToFileURL(HELPER).href)});
          for (let i = 0; i < 12; i++) H.registerVault("${prefix}" + i, { dir: "/d/${prefix}" + i, mnt: "/l/${prefix}" + i }, { home: ${JSON.stringify(home)} });`;
        const c = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
        c.on("close", resolve);
      });
    const codes = await Promise.all([worker("a"), worker("b")]);
    expect(codes).toEqual([0, 0]);
    const j = JSON.parse(readFileSync(file, "utf8"));
    expect(j.keep).toBe(true);
    expect(Object.keys(j.secure.vaults).sort()).toEqual(
      [...Array.from({ length: 12 }, (_, i) => `a${i}`), ...Array.from({ length: 12 }, (_, i) => `b${i}`)].sort(),
    );
  }, 60_000);
  it("without the lock the same race DOES lose registrations (the test can see the bug)", async () => {
    const { home, file } = agentHome();
    writeFileSync(file, "{}");
    const worker = (prefix: string) =>
      new Promise<void>((resolve) => {
        const script = `const H = await import(${JSON.stringify(pathToFileURL(HELPER).href)});
          for (let i = 0; i < 60; i++) H.registerVaultUnlocked("${prefix}" + i, "/d/x", "/l/x", ${JSON.stringify(home)});`;
        spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" }).on("close", () =>
          resolve(),
        );
      });
    await Promise.all([worker("a"), worker("b"), worker("c")]);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).secure.vaults).length).toBeLessThan(180);
  }, 60_000);
  it("a symlinked settings file is refused; link and target stay untouched", () => {
    const { home, file } = agentHome();
    const target = join(home, "real-settings.json");
    writeFileSync(target, JSON.stringify({ a: 1 }));
    chmodSync(target, 0o600);
    symlinkSync(target, file);
    expect(() => H.registerVault("acme", { dir: "/d", mnt: "/l" }, { home })).toThrow(/符号链接/);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(JSON.stringify({ a: 1 }));
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
  it("a directory / fifo in place of the settings file is refused", () => {
    const { home, file } = agentHome();
    mkdirSync(file);
    expect(() => H.registerVault("acme", { dir: "/d", mnt: "/l" }, { home })).toThrow(/不是普通文件/);
    const b = agentHome();
    expect(spawnSync("mkfifo", [b.file]).status).toBe(0);
    expect(() => H.registerVault("acme", { dir: "/d", mnt: "/l" }, { home: b.home })).toThrow(/不是普通文件/);
  });
  it("modes: new file 0600; existing 0666 loses group/other write (never 0777)", () => {
    const a = agentHome();
    H.registerVault("acme", { dir: "/d", mnt: "/l" }, { home: a.home });
    expect(statSync(a.file).mode & 0o777).toBe(0o600);
    const b = agentHome();
    writeFileSync(b.file, "{}");
    chmodSync(b.file, 0o666);
    H.registerVault("acme", { dir: "/d", mnt: "/l" }, { home: b.home });
    expect(statSync(b.file).mode & 0o777).toBe(0o644);
    expect(H.settingsWriteMode(undefined)).toBe(0o600);
    expect(H.settingsWriteMode({ mode: 0o120777 })).toBe(0o755 & 0o777); // a raw link mode is never passed in, but is clamped anyway
  });
  it("a symlinked lock file fails closed", () => {
    const { home } = agentHome();
    symlinkSync("/tmp/whatever", join(home, ".pi", "agent", ".pi-subagent.json.lock"));
    expect(() => H.registerVault("acme", { dir: "/d", mnt: "/l" }, { home })).toThrow();
    expect(existsSync(join(home, ".pi", "agent", "pi-subagent.json"))).toBe(false);
  });
});
