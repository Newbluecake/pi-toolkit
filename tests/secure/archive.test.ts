/**
 * V5 (docs/dev/data-encryption/convert-plan.md r3 §3.2–§3.5, §7.1 archive row) — pi-secure export /
 * import / relocation transaction (`src/secure/bin/archive.mjs`).
 *
 * Every test runs in its own mktemp HOME (passed explicitly as `home`), marked with this run's random
 * token; cleanup removes only those directories. The real V0 settings ports (registerVault /
 * patchVaultEntry / removeVaultEntry, flock on the temp settings file) and the real worker process
 * (`node archive.mjs __archive-work …`, incl. `flock -o mount.lock` for export) are used unless a test
 * injects a fault. Mounting is faked (a plain dir stands in for the mounted tree) except in the
 * self-gating real-gocryptfs block at the end (fake password via -passfile, file-fd mount stdio).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireGocryptfsTestLock } from "./gocryptfs-test-lock.js";

const REPO = join(import.meta.dirname, "..", "..");
const load = async (rel: string) => import(pathToFileURL(join(REPO, rel)).href);
/* eslint-disable @typescript-eslint/no-explicit-any -- plain-JS modules, no typings by design */
const A: any = await load("src/secure/bin/archive.mjs");
const H: any = await load("src/secure/bin/helper.mjs");
const T: any = await load("src/secure/bin/tar.mjs");
const S: any = await load("src/secure/bin/sessions.mjs");
const G: any = await load("tests/fixtures/secure-tar-corpus/gen.mjs");
/* eslint-enable @typescript-eslint/no-explicit-any */

const TOKEN = randomBytes(6).toString("hex");
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    // own-token dirs only
    if (!r.includes(`pi-secure-v5-${TOKEN}-`)) continue;
    spawnSync("chmod", ["-R", "u+rwx", r]);
    rmSync(r, { recursive: true, force: true });
  }
});

type Lines = { out: string[]; err: string[] };
interface Env {
  home: string;
  lines: Lines;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ports: (extra?: Record<string, any>) => Record<string, any>;
}

function mkEnv(): Env {
  const home = mkdtempSync(join(tmpdir(), `pi-secure-v5-${TOKEN}-`));
  roots.push(home);
  mkdirSync(join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
  const lines: Lines = { out: [], err: [] };
  return {
    home,
    lines,
    ports: (extra = {}) => ({
      isTTY: () => false,
      gocryptfsVersion: () => "gocryptfs 1.8.0; go-fuse 2.0.3",
      onInterrupt: () => () => {},
      out: (s: string) => lines.out.push(s),
      err: (s: string) => lines.err.push(s),
      ...extra,
    }),
  };
}

function settingsPath(home: string): string {
  return join(home, ".pi", "agent", "pi-subagent.json");
}
function readSettings(home: string): any {
  try {
    return JSON.parse(readFileSync(settingsPath(home), "utf8"));
  } catch {
    return {};
  }
}
function writeVaults(home: string, vaults: Record<string, unknown>): void {
  const cur = readSettings(home);
  writeFileSync(settingsPath(home), JSON.stringify({ ...cur, secure: { vaults } }, null, 2), { mode: 0o600 });
}
function entry(home: string, name: string): any {
  return readSettings(home)?.secure?.vaults?.[name];
}

/** The corpus baseline package (valid; origRealWork /home/u/secure/corpus/work). */
function writePkg(env: Env, buf: Buffer = G.assemble(G.baseline()), name = "pkg.tar"): string {
  const p = join(env.home, name);
  writeFileSync(p, buf, { mode: 0o600 });
  return p;
}

/** Recursive listing of `root` (relative path + type + size), for zero-residue assertions. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (p: string, rel: string) => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    out.push(`${rel}|${st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f"}|${st.isFile() ? st.size : ""}`);
    if (st.isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n), `${rel}/${n}`);
  };
  walk(root, "");
  return out;
}
const withoutTxn = (snap: string[]) => snap.filter((l) => !l.includes("/.txn"));

/** A complete, unmounted new-layout vault built from the baseline package's cipher tree. */
function mkVault(env: Env, name: string, opts: { register?: boolean; extra?: Record<string, unknown> } = {}): any {
  const dir = H.defaultVaultDir(name, env.home);
  const mnt = join(env.home, "secure", name);
  const v = H.deriveVault(name, dir, mnt);
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
  const stage = mkdtempSync(join(env.home, `.stage-`));
  chmodSync(stage, 0o700);
  T.readPackage({ pkgPath: writePkg(env, undefined, `src-${name}.tar`), stagingRoot: stage });
  spawnSync("mv", ["-T", join(stage, "cipher"), v.cipher]);
  rmSync(stage, { recursive: true, force: true });
  chmodSync(v.cipher, 0o700);
  writeFileSync(v.lock, "", { mode: 0o600 });
  writeFileSync(v.lease, "", { mode: 0o600 });
  mkdirSync(dirname(mnt), { recursive: true, mode: 0o700 });
  mkdirSync(mnt, { mode: 0o700 });
  for (const n of ["work", "state"]) writeFileSync(join(mnt, n), "", { mode: 0o400 });
  if (opts.register !== false) {
    const cur = readSettings(env.home)?.secure?.vaults ?? {};
    writeVaults(env.home, { ...cur, [name]: { dir, mnt, ...(opts.extra ?? {}) } });
  }
  return v;
}

function expectNoImportResidue(env: Env, name: string): void {
  const dir = H.defaultVaultDir(name, env.home);
  expect(existsSync(dir)).toBe(false);
  expect(existsSync(join(env.home, "secure", name))).toBe(false);
  expect(
    readdirSync(dirname(dir)).filter((n) => n.startsWith(`.${name}.import-`) && !n.endsWith("f".repeat(24))),
  ).toEqual([]);
  expect(entry(env.home, name)).toBeUndefined();
  expect(existsSync(A.importStatePath(name, env.home))).toBe(false);
}

/** Real worker, but relocation ops skip the "is this the gocryptfs mount root" check: the tests stand a
 *  plain directory in for the mounted tree. `fault(op)` may short-circuit an op with a fake outcome. */
function fakeMountWorker(fault: (op: string) => unknown = () => undefined) {
  return async (op: string, p: Record<string, unknown>, o: unknown) =>
    fault(op) ?? A.spawnWorker(op, op.startsWith("relocate-") ? { ...p, mountCheck: false } : p, o);
}

const which = (b: string): boolean => spawnSync("sh", ["-c", `command -v ${b}`]).status === 0;

// ───────────────────────────── worker supervision ─────────────────────────────

describe("spawnWorker (§5 worker model)", () => {
  it("stall watchdog: no progress for stallMs ⇒ TERM/KILL the group ⇒ stalled", async () => {
    const env = mkEnv();
    const t0 = Date.now();
    const r = await A.spawnWorker(
      "sync",
      { path: env.home },
      { stallMs: 300, env: { ...process.env, PI_SECURE_TEST_ARCHIVE_STALL_MS: "20000" } },
    );
    expect(r.kind).toBe("stalled");
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it("abort signal ⇒ aborted; worker error ⇒ typed code; unknown op ⇒ died", async () => {
    const ac = new AbortController();
    const p = A.spawnWorker(
      "sync",
      { path: "/" },
      { signal: ac.signal, env: { ...process.env, PI_SECURE_TEST_ARCHIVE_STALL_MS: "20000" } },
    );
    setTimeout(() => ac.abort(), 200);
    expect((await p).kind).toBe("aborted");
    const e = await A.spawnWorker("read", { pkgPath: "/nonexistent-v5", stagingRoot: "/nonexistent-v5" });
    expect(e).toMatchObject({ kind: "err", code: 74 });
    const d = await A.spawnWorker("no-such-op", {});
    expect(d.kind).toBe("died");
  });
});

// ───────────────────────────── export (§3.2) ─────────────────────────────

describe("export (§3.2)", () => {
  it("real flock + worker: ciphertext-only package, link() published 0600, round-trips through readPackage", async () => {
    const env = mkEnv();
    const v = mkVault(env, "src");
    const before = snapshot(v.cipher);
    // I-plaintext: the mount point is unreadable during export — any access under it would fail
    chmodSync(v.mnt, 0o000);
    const out = join(env.home, "out.tar");
    const code = await A.cmdExport({ name: "src", file: out, home: env.home }, env.ports());
    chmodSync(v.mnt, 0o700);
    expect(code, env.lines.err.join("\n")).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readdirSync(env.home).filter((n) => n.includes(".partial-"))).toEqual([]);
    expect(env.lines.out.join("\n")).toMatch(/已导出 5 个文件 \d+ 字节到 .*out\.tar。该包与密文目录同样敏感/);
    expect(snapshot(v.cipher)).toEqual(before); // source untouched
    const stage = mkdtempSync(join(env.home, "rt-"));
    const r = T.readPackage({ pkgPath: out, stagingRoot: stage });
    expect(r.manifest.name).toBe("src");
    expect(r.manifest.origRealWork).toBe(join(H.physicalPaths(v).realMnt, "work"));
    expect(r.manifest.entries.every((e: { path: string }) => e.path.startsWith("pi-secure-vault/cipher"))).toBe(true);
    expect(snapshot(join(stage, "cipher"))).toEqual(before);
  });

  it("pre-lock refusals: pending 76 · relocate 78 · unknown 66 · target exists 78 (untouched) · parent missing 66", async () => {
    const env = mkEnv();
    mkVault(env, "pend", { extra: { pending: "import:abc" } });
    mkVault(env, "relo", {
      extra: { relocate: { from: "/a/work", to: "/b/work", txid: "t1", phase: "pending" } },
    });
    mkVault(env, "ok");
    const out = join(env.home, "o.tar");
    expect(await A.cmdExport({ name: "pend", file: out, home: env.home }, env.ports())).toBe(76);
    expect(await A.cmdExport({ name: "relo", file: out, home: env.home }, env.ports())).toBe(78);
    expect(await A.cmdExport({ name: "nope", file: out, home: env.home }, env.ports())).toBe(66);
    writeFileSync(out, "keep-me");
    expect(await A.cmdExport({ name: "ok", file: out, home: env.home }, env.ports())).toBe(78);
    expect(readFileSync(out, "utf8")).toBe("keep-me");
    expect(await A.cmdExport({ name: "ok", file: join(env.home, "no", "x.tar"), home: env.home }, env.ports())).toBe(
      66,
    );
  });

  it("legacy-layout vaults can be exported (read-only compat)", async () => {
    const env = mkEnv();
    const dir = join(env.home, "legacy-vault");
    mkdirSync(dir, { mode: 0o700 });
    const stage = mkdtempSync(join(env.home, ".st-"));
    T.readPackage({ pkgPath: writePkg(env), stagingRoot: stage });
    spawnSync("mv", ["-T", join(stage, "cipher"), join(dir, "cipher")]);
    mkdirSync(join(dir, "mnt"), { mode: 0o700 });
    writeVaults(env.home, { old: { dir, link: join(env.home, "secure", "old") } });
    const out = join(env.home, "legacy.tar");
    expect(await A.cmdExport({ name: "old", file: out, home: env.home }, env.ports())).toBe(0);
    const r = T.readPackage({ pkgPath: out, stagingRoot: mkdtempSync(join(env.home, "rt-")) });
    expect(r.manifest.origRealWork).toBe(join(dir, "mnt", "work"));
  });

  describe("exportLocked admission matrix (§3.5 row 1) — refusals never create the partial", () => {
    const cases: [string, string, Record<string, unknown>, number][] = [
      ["mounted", "mounted", { state: "none" }, 76],
      ["stale mount", "stale", { state: "none" }, 76],
      ["hung probe", "hung", { state: "none" }, 76],
      ["foreign", "foreign", { state: "none" }, 76],
      ["private session", "absent", { state: "session" }, 76],
      ["lease unrecorded", "absent", { state: "unrecorded" }, 76],
      ["lease unknown", "absent", { state: "unknown", reason: "lease-unknown" }, 76],
      ["private starting", "absent", { state: "starting" }, 76],
      ["corrupt record", "absent", { state: "corrupt" }, 76],
    ];
    for (const [label, mount, view, code] of cases)
      it(`${label} ⇒ ${code}`, async () => {
        const env = mkEnv();
        const v = mkVault(env, "x");
        const out = join(env.home, "x.tar");
        const partial = `${out}.partial-p`;
        let err: any;
        try {
          await A.exportLocked(
            { vault: v, out, partial, origRealWork: "/r/work", gocryptfsVersion: "g" },
            {
              probeMountState: async () => mount,
              vaultInstanceView: async () => view,
              scanXattrs: () => [],
            },
          );
        } catch (e) {
          err = e;
        }
        expect(err?.code).toBe(code);
        expect(existsSync(partial)).toBe(false);
        expect(existsSync(out)).toBe(false);
      });

    const deps = (over: Record<string, unknown> = {}) => ({
      probeMountState: async () => "absent",
      vaultInstanceView: async () => ({ state: "none", lease: "free" }),
      scanXattrs: () => [],
      ...over,
    });
    it("stale private record ⇒ allowed", async () => {
      const env = mkEnv();
      const v = mkVault(env, "x");
      const out = join(env.home, "x.tar");
      const r = await A.exportLocked(
        { vault: v, out, partial: `${out}.partial-p`, origRealWork: "/r/work", gocryptfsVersion: "g" },
        deps({ vaultInstanceView: async () => ({ state: "stale", reason: "boot" }) }),
      );
      expect(r.totals.files).toBe(5);
      expect(existsSync(`${out}.partial-p`)).toBe(false);
    });
    it("cipher xattr ⇒ 65; no space ⇒ 74; target appears before link ⇒ 78 untouched + partial removed", async () => {
      const env = mkEnv();
      const v = mkVault(env, "x");
      const out = join(env.home, "x.tar");
      const pl = { vault: v, out, partial: `${out}.partial-p`, origRealWork: "/r/work", gocryptfsVersion: "g" };
      await expect(
        A.exportLocked(pl, deps({ scanXattrs: () => [{ file: "f", key: "user.x" }] })),
      ).rejects.toMatchObject({ code: 65 });
      await expect(A.exportLocked(pl, deps({ statfsFree: () => 10 }))).rejects.toMatchObject({ code: 74 });
      // racer creates the final name while the package is being written
      const racing = deps({
        onProgress: () => {
          if (!existsSync(out)) writeFileSync(out, "racer");
        },
      });
      await expect(A.exportLocked(pl, racing)).rejects.toMatchObject({ code: 78 });
      expect(readFileSync(out, "utf8")).toBe("racer");
      expect(existsSync(pl.partial)).toBe(false);
      // r3: ANY attribute counts — security.selinux is not exempt (review M8)
      expect(A.parseGetfattr("# file: /a\nuser.k=1\nsecurity.selinux=x\n\n# file: /b\n")).toEqual([
        { file: "/a", key: "user.k" },
        { file: "/a", key: "security.selinux" },
      ]);
    });
  });

  it("mount.lock held by another pi-secure ⇒ 73 after the 10 s wait, no partial", async () => {
    const env = mkEnv();
    const v = mkVault(env, "busy");
    const holder: ChildProcess = spawn("flock", ["-x", v.lock, "sleep", "30"], { stdio: "ignore", detached: true });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const out = join(env.home, "b.tar");
      const code = await A.cmdExport({ name: "busy", file: out, home: env.home }, env.ports());
      expect(code).toBe(73);
      expect(env.lines.err.join("\n")).toMatch(/另一个 pi-secure 正在挂载、卸载或导出 busy/);
      expect(readdirSync(env.home).filter((n) => n.startsWith("b.tar"))).toEqual([]);
    } finally {
      process.kill(-holder.pid!, "SIGKILL");
    }
  }, 30_000);

  it("real lease holder (another gocryptfs / private instance) ⇒ 76", async () => {
    const env = mkEnv();
    const v = mkVault(env, "lz");
    const holder: ChildProcess = spawn("flock", ["-x", v.lease, "sleep", "30"], { stdio: "ignore", detached: true });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const code = await A.cmdExport({ name: "lz", file: join(env.home, "lz.tar"), home: env.home }, env.ports());
      expect(code, env.lines.err.join("\n")).toBe(76);
      expect(readdirSync(env.home).filter((n) => n.startsWith("lz.tar"))).toEqual([]);
    } finally {
      process.kill(-holder.pid!, "SIGKILL");
    }
  });

  it("SIGINT ⇒ worker aborted, partial deleted, 130", async () => {
    const env = mkEnv();
    mkVault(env, "int");
    const out = join(env.home, "i.tar");
    let fire: () => void = () => {};
    const code = await A.cmdExport(
      { name: "int", file: out, home: env.home },
      env.ports({
        txid: () => "aaaaaaaaaaaaaaaaaaaaaaaa",
        onInterrupt: (cb: () => void) => {
          fire = cb;
          return () => {};
        },
        runWorker: async (
          _op: string,
          p: { partial: string },
          o: { signal: AbortSignal; onProgress: (x: unknown) => void },
        ) => {
          writeFileSync(p.partial, "half", { mode: 0o600 });
          const st = lstatSync(p.partial, { bigint: true });
          o.onProgress({ partial: { dev: String(st.dev), ino: String(st.ino) } }); // the creation credential
          fire();
          expect(o.signal.aborted).toBe(true);
          return { kind: "aborted" };
        },
      }),
    );
    expect(code).toBe(130);
    expect(existsSync(`${out}.partial-aaaaaaaaaaaaaaaaaaaaaaaa`)).toBe(false);
    expect(existsSync(out)).toBe(false);
  });
});

// ───────────────────────────── import (§3.3) ─────────────────────────────

describe("import (§3.3)", () => {
  it("happy path: claim → validating read in staging → publish into self-made dirs → commit (+relocate)", async () => {
    const env = mkEnv();
    const pkg = writePkg(env);
    const code = await A.cmdImport({ file: pkg, name: "neu", home: env.home }, env.ports());
    expect(code, env.lines.err.join("\n")).toBe(0);
    const dir = H.defaultVaultDir("neu", env.home);
    const mnt = join(env.home, "secure", "neu");
    expect(readdirSync(dir).sort()).toEqual(["cipher", "mount.lease", "mount.lock"]);
    expect(statSync(join(dir, "cipher")).mode & 0o777).toBe(0o700);
    expect(readdirSync(mnt).sort()).toEqual(["state", "work"]);
    const v = H.deriveVault("neu", dir, mnt);
    expect(H.checkLayout(v, { home: env.home }).problems).toEqual([]);
    const e = entry(env.home, "neu");
    expect(e.pending).toBeUndefined();
    expect(e.relocate).toMatchObject({
      from: "/home/u/secure/corpus/work",
      to: join(H.physicalPaths(v).realMnt, "work"),
      phase: "pending",
    });
    expect(existsSync(A.importStatePath("neu", env.home))).toBe(false);
    expect(readdirSync(dirname(dir)).filter((n) => n.includes(".import-"))).toEqual([]);
    expect(env.lines.out.join("\n")).toMatch(/迁址仍待完成：pi-secure init neu --fix-settings/);
    // §3.4: an outstanding relocate makes export refuse 78
    expect(await A.cmdExport({ name: "neu", file: join(env.home, "z.tar"), home: env.home }, env.ports())).toBe(78);
  });

  it("export → import round trip with --path; no relocate when the address is unchanged", async () => {
    const env = mkEnv();
    mkVault(env, "orig");
    const out = join(env.home, "orig.tar");
    expect(await A.cmdExport({ name: "orig", file: out, home: env.home }, env.ports())).toBe(0);
    mkdirSync(join(env.home, "elsewhere"), { mode: 0o700 });
    const mnt = join(env.home, "elsewhere", "copy");
    expect(await A.cmdImport({ file: out, name: "copy", path: mnt, home: env.home }, env.ports())).toBe(0);
    expect(entry(env.home, "copy")).toMatchObject({ mnt });
    expect(entry(env.home, "copy").relocate.from).toBe(join(env.home, "secure", "orig", "work"));
    // a package whose origRealWork already equals the new realWork ⇒ no relocate marker
    const p = G.baseline();
    p.meta.origRealWork = join(env.home, "secure", "same", "work");
    expect(
      await A.cmdImport({ file: writePkg(env, G.assemble(p), "same.tar"), name: "same", home: env.home }, env.ports()),
    ).toBe(0);
    expect(entry(env.home, "same").relocate).toBeUndefined();
  });

  it("refusals before any change: bad name 2 · TTY 2 · registered 78 · dir/mnt exist 78 (untouched) · missing 66 · not regular 65 · space 74 · unfinished 76", async () => {
    const env = mkEnv();
    const pkg = writePkg(env);
    const p = env.ports();
    expect(await A.cmdImport({ file: pkg, name: "Bad!", home: env.home }, p)).toBe(2);
    expect(await A.cmdImport({ file: pkg, name: "t", verifyPassword: true, home: env.home }, p)).toBe(2);
    mkVault(env, "taken");
    expect(await A.cmdImport({ file: pkg, name: "taken", home: env.home }, p)).toBe(78);
    // pre-existing user data at <dir> / <mnt>
    const dir = H.defaultVaultDir("pre", env.home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "user-data"), "precious");
    expect(await A.cmdImport({ file: pkg, name: "pre", home: env.home }, p)).toBe(78);
    expect(readFileSync(join(dir, "user-data"), "utf8")).toBe("precious");
    const mnt = join(env.home, "secure", "pre2");
    mkdirSync(mnt, { recursive: true });
    writeFileSync(join(mnt, "notes"), "mine");
    expect(await A.cmdImport({ file: pkg, name: "pre2", home: env.home }, p)).toBe(78);
    expect(readFileSync(join(mnt, "notes"), "utf8")).toBe("mine");
    expect(entry(env.home, "pre")).toBeUndefined();
    expect(entry(env.home, "pre2")).toBeUndefined();
    expect(await A.cmdImport({ file: join(env.home, "nope.tar"), name: "m", home: env.home }, p)).toBe(66);
    mkdirSync(join(env.home, "adir.tar"));
    expect(await A.cmdImport({ file: join(env.home, "adir.tar"), name: "m", home: env.home }, p)).toBe(65);
    expect(await A.cmdImport({ file: pkg, name: "m", home: env.home }, env.ports({ statfsFree: () => 0 }))).toBe(74);
    expectNoImportResidue(env, "m");
    A.writeImportState(
      {
        v: 1,
        txid: "bbbbbbbbbbbbbbbbbbbbbbbb",
        name: "half",
        phase: "claimed",
        pkg,
        staging: join(dirname(H.defaultVaultDir("half", env.home)), ".half.import-bbbbbbbbbbbbbbbbbbbbbbbb"),
        dir: H.defaultVaultDir("half", env.home),
        mnt: join(env.home, "secure", "half"),
        ids: { staging: null, dir: null, mnt: null },
        createdAt: new Date().toISOString(),
      },
      env.home,
    );
    expect(await A.cmdImport({ file: pkg, name: "half", home: env.home }, p)).toBe(76);
  });

  describe("malicious packages ⇒ 65, zero residue, registration removed, decoys untouched", () => {
    // cases with a custom `budget` only fail under that reduced budget — import uses the default one
    const bad = (
      G.CASES as { id: string; category: string; reasons: string[]; budget?: object; build: () => Buffer }[]
    ).filter((c) => c.reasons.length > 0 && c.budget === undefined);
    // one case per category plus every MANIFEST-link case (B6), bounded for runtime
    const seen = new Set<string>();
    const pick = bad.filter((c) => {
      if (c.id.includes("link") || !seen.has(c.category)) {
        seen.add(c.category);
        return true;
      }
      return false;
    });
    it("corpus pick is non-trivial", () => {
      expect(pick.length).toBeGreaterThan(20);
    });
    it.each(pick.map((c) => [c.id, c]))("%s", async (_id, c) => {
      const env = mkEnv();
      const root = H.defaultVaultDir("x", env.home);
      mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
      // decoys: a neighbour vault dir, a look-alike staging name of ANOTHER txid, a file in ~/secure
      mkdirSync(join(dirname(root), "other"), { mode: 0o700 });
      writeFileSync(join(dirname(root), "other", "keep"), "k");
      mkdirSync(join(dirname(root), ".mal.import-ffffffffffffffffffffffff"), { mode: 0o700 });
      mkdirSync(join(env.home, "secure"), { mode: 0o700 });
      writeFileSync(join(env.home, "secure", "decoy"), "d");
      const before = withoutTxn(snapshot(env.home));
      const pkg = writePkg(env, (c as { build: () => Buffer }).build(), "mal.tar");
      const code = await A.cmdImport({ file: pkg, name: "mal", home: env.home }, env.ports());
      expect(code, env.lines.err.join("\n")).toBe(65);
      expectNoImportResidue(env, "mal");
      expect(withoutTxn(snapshot(env.home)).filter((l) => !l.startsWith("/mal.tar") && !l.startsWith("/.pi"))).toEqual(
        before.filter((l) => !l.startsWith("/.pi")),
      );
    });
  });

  it("same-name concurrent imports ⇒ exactly one wins, the loser gets 78 and deletes nothing of the winner", async () => {
    const env = mkEnv();
    const pkg = writePkg(env);
    const codes = await Promise.all([
      A.cmdImport({ file: pkg, name: "dup", home: env.home }, env.ports()),
      A.cmdImport({ file: pkg, name: "dup", home: env.home }, env.ports()),
    ]);
    expect([...codes].sort()).toEqual([0, 78]);
    const dir = H.defaultVaultDir("dup", env.home);
    expect(readdirSync(dir).sort()).toEqual(["cipher", "mount.lease", "mount.lock"]);
    expect(entry(env.home, "dup").pending).toBeUndefined();
    expect(readdirSync(dirname(dir)).filter((n) => n.includes(".import-"))).toEqual([]);
  });

  it("racer creates <mnt> during the read ⇒ 78; racer's dir untouched; our dir/staging/registration rolled back", async () => {
    const env = mkEnv();
    const mnt = join(env.home, "secure", "race");
    const code = await A.cmdImport(
      { file: writePkg(env), name: "race", home: env.home },
      env.ports({
        runWorker: async (op: string, p: unknown, o: unknown) => {
          const r = await A.spawnWorker(op, p, o);
          if (op === "read") {
            mkdirSync(mnt, { recursive: true });
            writeFileSync(join(mnt, "theirs"), "t");
          }
          return r;
        },
      }),
    );
    expect(code).toBe(78);
    expect(readFileSync(join(mnt, "theirs"), "utf8")).toBe("t");
    expect(existsSync(H.defaultVaultDir("race", env.home))).toBe(false);
    expect(entry(env.home, "race")).toBeUndefined();
    expect(existsSync(A.importStatePath("race", env.home))).toBe(false);
  });

  it("failure at the persistence barrier (sync) ⇒ 74, fully rolled back", async () => {
    const env = mkEnv();
    const code = await A.cmdImport(
      { file: writePkg(env), name: "sy", home: env.home },
      env.ports({
        runWorker: async (op: string, p: unknown, o: unknown) =>
          op === "sync" ? { kind: "err", code: 74, message: "sync -f failed" } : A.spawnWorker(op, p, o),
      }),
    );
    expect(code).toBe(74);
    expectNoImportResidue(env, "sy");
  });

  it("stalled read worker ⇒ 75, rolled back", async () => {
    const env = mkEnv();
    const code = await A.cmdImport(
      { file: writePkg(env), name: "st", home: env.home },
      env.ports({ runWorker: async () => ({ kind: "stalled" }) }),
    );
    expect(code).toBe(75);
    expectNoImportResidue(env, "st");
  });

  it("I-C2: commit landed but its reply was lost ⇒ nothing deleted (the published vault stays)", async () => {
    const env = mkEnv();
    const code = await A.cmdImport(
      { file: writePkg(env), name: "lost", home: env.home },
      env.ports({
        patchVaultEntry: (...args: unknown[]) => {
          H.patchVaultEntry(...args);
          throw new H.CliError(1, "__vault-patch 输出无法解析");
        },
      }),
    );
    expect(code).toBe(74);
    const dir = H.defaultVaultDir("lost", env.home);
    expect(readdirSync(dir).sort()).toEqual(["cipher", "mount.lease", "mount.lock"]);
    expect(entry(env.home, "lost").pending).toBeUndefined();
    expect(env.lines.err.join("\n")).toMatch(/已提交（pending 已清除）——导入结果保留/);
    // resume cleans the leftover state file
    expect(await A.cmdImportResume({ name: "lost", home: env.home }, env.ports())).toBe(0);
    expect(existsSync(A.importStatePath("lost", env.home))).toBe(false);
  });

  describe("recovery table (§3.3) — import --abort / --resume", () => {
    /** A REAL crash (SIGKILL) at the commit point: the import runs in a child process whose
     *  patchVaultEntry port kills it, so no rollback can run — exactly the published+pending state. */
    function crashAfterPublish(env: Env, name: string): number | null {
      const script = join(env.home, "crash.mjs");
      writeFileSync(
        script,
        `import * as A from ${JSON.stringify(pathToFileURL(join(REPO, "src/secure/bin/archive.mjs")).href)};\n` +
          `await A.cmdImport({ file: process.argv[2], name: process.argv[3], home: process.argv[4] }, {\n` +
          `  isTTY: () => false, out: () => {}, err: () => {}, onInterrupt: () => () => {},\n` +
          `  patchVaultEntry: () => process.kill(process.pid, "SIGKILL"),\n` +
          `});\n`,
      );
      const r = spawnSync(process.execPath, [script, writePkg(env), name, env.home], { timeout: 60_000 });
      return r.signal === "SIGKILL" ? 137 : r.status;
    }

    it("row 3: published + pending ⇒ --resume commits (relocate set), state removed", async () => {
      const env = mkEnv();
      expect(crashAfterPublish(env, "r3")).toBe(137);
      const st = A.readImportState("r3", env.home);
      expect(st.kind).toBe("ok");
      expect(st.state.phase).toBe("published");
      expect(entry(env.home, "r3").pending).toBe(`import:${st.state.txid}`);
      expect(A.listImportStates(env.home)).toEqual(["import r3: interrupted (published) · --resume|--abort"]);
      expect(await A.cmdImportResume({ name: "r3", home: env.home }, env.ports()), env.lines.err.join("\n")).toBe(0);
      expect(entry(env.home, "r3").pending).toBeUndefined();
      expect(entry(env.home, "r3").relocate.txid).toBe(st.state.txid);
      expect(existsSync(A.importStatePath("r3", env.home))).toBe(false);
      // committed ⇒ abort no longer applies (no state file)
      expect(await A.cmdImportAbort({ name: "r3", home: env.home }, env.ports())).toBe(66);
    });

    it("row 3': published + pending ⇒ --abort removes dir, mnt, registration and state", async () => {
      const env = mkEnv();
      expect(crashAfterPublish(env, "r3b")).toBe(137);
      expect(await A.cmdImportAbort({ name: "r3b", home: env.home }, env.ports())).toBe(0);
      expectNoImportResidue(env, "r3b");
    });

    function manualState(env: Env, name: string, phase: string) {
      const txid = "c".repeat(24);
      const dir = H.defaultVaultDir(name, env.home);
      const mnt = join(env.home, "secure", name);
      const staging = join(dirname(dir), `.${name}.import-${txid}`);
      H.registerVault(name, { dir, mnt }, { home: env.home, expectAbsent: true, pending: `import:${txid}` });
      mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
      const state: any = {
        v: 1,
        txid,
        name,
        phase,
        pkg: join(env.home, "pkg.tar"),
        staging,
        dir,
        mnt,
        ids: { staging: null, dir: null, mnt: null },
        createdAt: new Date().toISOString(),
      };
      const id = (p: string) => {
        const s = lstatSync(p, { bigint: true });
        return { dev: String(s.dev), ino: String(s.ino) };
      };
      return { state, id, txid, dir, mnt, staging };
    }

    it("row 1: only staging ⇒ --abort deletes staging + our registration", async () => {
      const env = mkEnv();
      const m = manualState(env, "r1", "staging");
      mkdirSync(m.staging, { mode: 0o700 });
      mkdirSync(join(m.staging, "cipher"));
      writeFileSync(join(m.staging, "cipher", "f"), "x");
      chmodSync(join(m.staging, "cipher"), 0o500); // read-only dirs from the package are handled
      m.state.ids.staging = m.id(m.staging);
      A.writeImportState(m.state, env.home);
      expect(A.listImportStates(env.home)).toEqual(["import r1: interrupted (staging) · --abort"]);
      expect(await A.cmdImportResume({ name: "r1", home: env.home }, env.ports())).toBe(1); // not published
      expect(await A.cmdImportAbort({ name: "r1", home: env.home }, env.ports())).toBe(0);
      expectNoImportResidue(env, "r1");
    });

    it("row 2: our <dir> (ino match) with entries partially moved ⇒ --abort undoes all", async () => {
      const env = mkEnv();
      const m = manualState(env, "r2", "publishing");
      mkdirSync(m.staging, { mode: 0o700 });
      writeFileSync(join(m.staging, "mount.lease"), "");
      mkdirSync(m.dir, { mode: 0o700 });
      mkdirSync(join(m.dir, "cipher"));
      writeFileSync(join(m.dir, "mount.lock"), "");
      m.state.ids.staging = m.id(m.staging);
      m.state.ids.dir = m.id(m.dir);
      A.writeImportState(m.state, env.home);
      expect(await A.cmdImportAbort({ name: "r2", home: env.home }, env.ports())).toBe(0);
      expectNoImportResidue(env, "r2");
    });

    it("identity mismatch (dir replaced) ⇒ abort leaves it, keeps registration + state, 74", async () => {
      const env = mkEnv();
      const m = manualState(env, "idm", "publishing");
      mkdirSync(m.dir, { mode: 0o700 });
      m.state.ids.dir = m.id(m.dir);
      A.writeImportState(m.state, env.home);
      renameSync(m.dir, `${m.dir}.moved`); // keep the old inode alive so the new dir cannot reuse it
      mkdirSync(m.dir, { mode: 0o700 });
      writeFileSync(join(m.dir, "someone-elses"), "s");
      expect(await A.cmdImportAbort({ name: "idm", home: env.home }, env.ports())).toBe(74);
      expect(readFileSync(join(m.dir, "someone-elses"), "utf8")).toBe("s");
      expect(entry(env.home, "idm").pending).toBe(`import:${m.txid}`);
      expect(existsSync(A.importStatePath("idm", env.home))).toBe(true);
    });

    it("<mnt> with non-sentinel entries is never deleted", async () => {
      const env = mkEnv();
      const m = manualState(env, "mx", "published");
      mkdirSync(join(env.home, "secure"), { mode: 0o700 });
      mkdirSync(m.mnt, { mode: 0o700 });
      writeFileSync(join(m.mnt, "plaintext-written-while-locked"), "p");
      m.state.ids.mnt = m.id(m.mnt);
      A.writeImportState(m.state, env.home);
      expect(await A.cmdImportAbort({ name: "mx", home: env.home }, env.ports())).toBe(74);
      expect(existsSync(join(m.mnt, "plaintext-written-while-locked"))).toBe(true);
    });

    it("row 4 / foreign: committed or foreign pending ⇒ abort refuses (1) and touches nothing", async () => {
      const env = mkEnv();
      const m = manualState(env, "r4", "published");
      mkdirSync(m.dir, { mode: 0o700 });
      writeFileSync(join(m.dir, "data"), "d");
      m.state.ids.dir = m.id(m.dir);
      A.writeImportState(m.state, env.home);
      H.patchVaultEntry("r4", { pending: `import:${m.txid}` }, { remove: ["pending"] }, { home: env.home });
      expect(await A.cmdImportAbort({ name: "r4", home: env.home }, env.ports())).toBe(1);
      expect(readFileSync(join(m.dir, "data"), "utf8")).toBe("d");
      expect(entry(env.home, "r4")).toBeDefined();
      // foreign pending
      const f = manualState(env, "fp", "staging");
      A.writeImportState(f.state, env.home);
      H.patchVaultEntry(
        "fp",
        { pending: `import:${f.txid}` },
        { set: { pending: "convert:other" } },
        { home: env.home },
      );
      expect(await A.cmdImportAbort({ name: "fp", home: env.home }, env.ports())).toBe(1);
      expect(entry(env.home, "fp").pending).toBe("convert:other");
    });

    it("tampered state file paths are refused (corrupt ⇒ 78, nothing done)", async () => {
      const env = mkEnv();
      const m = manualState(env, "tp", "staging");
      m.state.dir = join(env.home, "victim");
      mkdirSync(m.state.dir);
      writeFileSync(join(m.state.dir, "v"), "v");
      A.writeImportState(m.state, env.home);
      expect(A.readImportState("tp", env.home).kind).toBe("corrupt");
      expect(await A.cmdImportAbort({ name: "tp", home: env.home }, env.ports())).toBe(78);
      expect(readFileSync(join(m.state.dir, "v"), "utf8")).toBe("v");
    });
  });
});

// ───────────────────────────── relocation (§3.4) ─────────────────────────────

describe("relocateVault (§3.4)", () => {
  /** A registered vault whose "mounted" tree is a plain dir (fake unlock returns it as realMnt). */
  function mkRelocVault(env: Env, name: string) {
    const dir = H.defaultVaultDir(name, env.home);
    const mnt = join(env.home, "secure", name);
    mkdirSync(join(dir, "cipher"), { recursive: true, mode: 0o700 });
    mkdirSync(join(mnt, "work"), { recursive: true, mode: 0o700 });
    const to = join(H.physicalPaths(H.deriveVault(name, dir, mnt)).realMnt, "work");
    const from = "/home/olduser/secure/old/work";
    const sessions = join(mnt, "state", "sessions", "default");
    mkdirSync(sessions, { recursive: true });
    const oldSessions = S.stateSessionsDirFor(from);
    const sfile = join(sessions, "2026_x.jsonl");
    writeFileSync(
      sfile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "s1",
          cwd: `${from}/proj`,
          parentSession: `${oldSessions}/p.jsonl`,
        }),
        JSON.stringify({
          type: "custom",
          customType: "subagent:run",
          data: { diag: { sessionFile: `${oldSessions}/c.jsonl` } },
        }),
        "",
      ].join("\n"),
    );
    const mem = join(mnt, "state", "memory");
    mkdirSync(join(mem, S.memorySlug(from)), { recursive: true });
    writeFileSync(join(mem, S.memorySlug(from), "core.md"), "m");
    const txid = "d".repeat(24);
    writeVaults(env.home, {
      ...(readSettings(env.home)?.secure?.vaults ?? {}),
      [name]: { dir, mnt, relocate: { from, to, txid, phase: "pending" } },
    });
    const calls: string[] = [];
    const ports = (extra: Record<string, unknown> = {}) =>
      env.ports({
        runWorker: fakeMountWorker(),
        unlockVault: async (_v: unknown, o: { postMount: boolean }) => {
          calls.push(`unlock:${o.postMount}`);
          return { how: "mounted", realMnt: H.physicalPaths(H.deriveVault(name, dir, mnt)).realMnt };
        },
        finalizeBounded: async () => {
          calls.push("finalize");
          return { code: 0, lines: [] };
        },
        ...extra,
      });
    return { dir, mnt, from, to, txid, sfile, mem, calls, ports, oldSessions };
  }

  it("raw mount → sessions → memory → sessionDir → sync → clear marker → unmount", async () => {
    const env = mkEnv();
    const r = mkRelocVault(env, "rv");
    const phases: string[] = [];
    const res = await A.relocateVault(
      { name: "rv", home: env.home },
      r.ports({
        patchVaultEntry: (n: string, g: unknown, p: { set?: { relocate?: { phase: string } } }, o: unknown) => {
          if (p.set?.relocate) phases.push(p.set.relocate.phase);
          return H.patchVaultEntry(n, g, p, o);
        },
      }),
    );
    expect(res.code, JSON.stringify(res)).toBe(0);
    expect(phases).toEqual(["sessions", "memory", "settings", "synced"]);
    expect(r.calls).toEqual(["unlock:false", "finalize"]);
    const lines = readFileSync(r.sfile, "utf8").split("\n");
    const newSessions = S.stateSessionsDirFor(r.to);
    expect(JSON.parse(lines[0]!)).toMatchObject({ cwd: `${r.to}/proj`, parentSession: `${newSessions}/p.jsonl` });
    expect(JSON.parse(lines[1]!).data.diag.sessionFile).toBe(`${newSessions}/c.jsonl`);
    expect(readFileSync(join(r.mem, S.memorySlug(r.to), "core.md"), "utf8")).toBe("m");
    expect(JSON.parse(readFileSync(join(r.mnt, "work", ".pi", "settings.json"), "utf8")).sessionDir).toBe(
      join(r.mnt, "state", "sessions", "default"),
    );
    expect(entry(env.home, "rv").relocate).toBeUndefined();
    // nothing left to do
    expect((await A.relocateVault({ name: "rv", home: env.home }, r.ports())).code).toBe(78);
  });

  it("crash mid-way keeps the marker at its phase; the next entry continues idempotently", async () => {
    const env = mkEnv();
    const r = mkRelocVault(env, "cr");
    const res = await A.relocateVault(
      { name: "cr", home: env.home },
      r.ports({
        runWorker: fakeMountWorker((op) =>
          op === "relocate-memory" ? { kind: "died", status: null, signal: "SIGKILL", stderr: "" } : undefined,
        ),
      }),
    );
    expect(res.code).toBe(74);
    expect(entry(env.home, "cr").relocate.phase).toBe("memory");
    expect(r.calls).toEqual(["unlock:false", "finalize"]); // our mount is undone on failure too
    const afterFirst = readFileSync(r.sfile, "utf8");
    // marker present ⇒ export refuses 78
    expect(await A.cmdExport({ name: "cr", file: join(env.home, "e.tar"), home: env.home }, env.ports())).toBe(78);
    const again = await A.relocateVault({ name: "cr", home: env.home }, r.ports());
    expect(again.code).toBe(0);
    expect(readFileSync(r.sfile, "utf8")).toBe(afterFirst); // already rewritten: re-entrant, unchanged
    expect(entry(env.home, "cr").relocate).toBeUndefined();
  });

  it("memory target exists ⇒ not merged, reported, relocation still completes", async () => {
    const env = mkEnv();
    const r = mkRelocVault(env, "mt");
    mkdirSync(join(r.mem, S.memorySlug(r.to)));
    writeFileSync(join(r.mem, S.memorySlug(r.to), "new.md"), "n");
    const res = await A.relocateVault({ name: "mt", home: env.home }, r.ports());
    expect(res.code).toBe(0);
    expect(res.warnings.join("\n")).toMatch(/已存在，未合并/);
    expect(existsSync(join(r.mem, S.memorySlug(r.from), "core.md"))).toBe(true);
  });

  it("wrong password (77) ⇒ marker stays, nothing rewritten, no unmount; target mismatch ⇒ 78 before mounting", async () => {
    const env = mkEnv();
    const r = mkRelocVault(env, "pw");
    const before = readFileSync(r.sfile, "utf8");
    const res = await A.relocateVault(
      { name: "pw", home: env.home },
      r.ports({
        unlockVault: async () => {
          throw new H.CliError(77, "口令连错 3 次");
        },
      }),
    );
    expect(res.code).toBe(77);
    expect(readFileSync(r.sfile, "utf8")).toBe(before);
    expect(entry(env.home, "pw").relocate.phase).toBe("pending");
    expect(r.calls).toEqual([]);
    const e = entry(env.home, "pw");
    writeVaults(env.home, { pw: { ...e, relocate: { ...e.relocate, to: "/somewhere/else/work" } } });
    expect((await A.relocateVault({ name: "pw", home: env.home }, r.ports())).code).toBe(78);
    expect(r.calls).toEqual([]);
  });

  it("import --verify-password: 77 keeps the import (exit 77) · other relocation failure ⇒ exit 1 · success ⇒ 0", async () => {
    const env = mkEnv();
    const tty = { isTTY: () => true };
    const c77 = await A.cmdImport(
      { file: writePkg(env), name: "vp", verifyPassword: true, home: env.home },
      env.ports({
        ...tty,
        unlockVault: async () => {
          throw new H.CliError(77, "口令连错 3 次");
        },
      }),
    );
    expect(c77).toBe(77);
    expect(env.lines.err.join("\n")).toMatch(
      /包已导入并校验；口令未验证；迁址仍待完成：pi-secure init vp --fix-settings/,
    );
    expect(entry(env.home, "vp").pending).toBeUndefined();
    expect(entry(env.home, "vp").relocate).toBeDefined();
    const c1 = await A.cmdImport(
      { file: writePkg(env, undefined, "p2.tar"), name: "vq", verifyPassword: true, home: env.home },
      env.ports({
        ...tty,
        unlockVault: async () => ({ how: "mounted", realMnt: "/nonexistent-v5-mnt" }),
        finalizeBounded: async () => ({ code: 0, lines: [] }),
        runWorker: fakeMountWorker((op) =>
          op === "relocate-sessions" ? { kind: "err", code: 74, message: "boom" } : undefined,
        ),
      }),
    );
    expect(c1).toBe(1);
    expect(env.lines.err.join("\n")).toMatch(/导入完成；迁址未完成：pi-secure init vq --fix-settings 继续/);
    expect(existsSync(H.defaultVaultDir("vq", env.home))).toBe(true);
  });

  // ── security review V5 #1 (B1): the DECRYPTED tree is attacker data — never follow its links ──
  describe("review B1: package-controlled symlinks inside the vault are never followed", () => {
    function outsideCanary(env: Env) {
      const out = join(env.home, `outside-${randomBytes(3).toString("hex")}`);
      mkdirSync(out, { mode: 0o700 });
      return out;
    }
    const snap = (p: string) =>
      snapshot(p).map((l) => {
        const rel = l.split("|")[0]!;
        try {
          const st = lstatSync(join(p, rel), { bigint: true });
          return `${l}|${st.mtimeNs}|${st.mode}`;
        } catch {
          return l;
        }
      });

    it("state → outside dir (sessions there are NOT rewritten) ⇒ 65", async () => {
      const env = mkEnv();
      const r = mkRelocVault(env, "ls");
      const outside = outsideCanary(env);
      // move the real state tree outside and leave a link in its place
      renameSync(join(r.mnt, "state"), join(outside, "state"));
      symlinkSync(join(outside, "state"), join(r.mnt, "state"));
      const before = snap(outside);
      const res = await A.relocateVault({ name: "ls", home: env.home }, r.ports());
      expect(res.code, JSON.stringify(res)).toBe(65);
      expect(res.message).toMatch(/state 是符号链接/);
      expect(snap(outside)).toEqual(before);
      expect(entry(env.home, "ls").relocate).toBeDefined(); // marker stays
      expect(r.calls).toEqual(["unlock:false", "finalize"]);
    });

    it("work → outside dir ⇒ 65, no .pi/settings.json created outside", async () => {
      const env = mkEnv();
      const r = mkRelocVault(env, "lw");
      const outside = outsideCanary(env);
      rmSync(join(r.mnt, "work"), { recursive: true });
      symlinkSync(outside, join(r.mnt, "work"));
      const res = await A.relocateVault({ name: "lw", home: env.home }, r.ports());
      expect(res.code, JSON.stringify(res)).toBe(65);
      expect(readdirSync(outside)).toEqual([]);
    });

    it("state/memory → outside memory dir ⇒ 65, outside slug not renamed", async () => {
      const env = mkEnv();
      const r = mkRelocVault(env, "lm");
      const outside = outsideCanary(env);
      renameSync(r.mem, join(outside, "memory"));
      symlinkSync(join(outside, "memory"), r.mem);
      const before = snap(outside);
      const res = await A.relocateVault({ name: "lm", home: env.home }, r.ports());
      expect(res.code, JSON.stringify(res)).toBe(65);
      expect(snap(outside)).toEqual(before);
      expect(existsSync(join(outside, "memory", S.memorySlug(r.from)))).toBe(true);
    });

    it("a session file / memory slug / work/.pi that is a symlink ⇒ 65, target untouched", async () => {
      for (const kind of ["session", "slug", "pi"] as const) {
        const env = mkEnv();
        const r = mkRelocVault(env, `k${kind}`);
        const outside = outsideCanary(env);
        if (kind === "session") {
          const victim = join(outside, "victim.jsonl");
          writeFileSync(victim, readFileSync(r.sfile));
          rmSync(r.sfile);
          symlinkSync(victim, r.sfile);
        } else if (kind === "slug") {
          const slugDir = join(r.mem, S.memorySlug(r.from));
          renameSync(slugDir, join(outside, "slug"));
          symlinkSync(join(outside, "slug"), slugDir);
        } else symlinkSync(outside, join(r.mnt, "work", ".pi"));
        const before = snap(outside);
        const res = await A.relocateVault({ name: `k${kind}`, home: env.home }, r.ports());
        expect(res.code, `${kind}: ${JSON.stringify(res)}`).toBe(65);
        expect(snap(outside)).toEqual(before);
      }
    });

    it("mount check: a plain directory is not accepted as the vault's gocryptfs mount root (74)", async () => {
      const env = mkEnv();
      const r = mkRelocVault(env, "mc");
      const before = readFileSync(r.sfile, "utf8");
      const res = await A.relocateVault({ name: "mc", home: env.home }, r.ports({ runWorker: A.spawnWorker }));
      expect(res.code).toBe(74);
      expect(res.message).toMatch(/不是本库的 gocryptfs 挂载根/);
      expect(readFileSync(r.sfile, "utf8")).toBe(before);
    });
  });

  // ── review M7: private vaults and pre-existing mounts are refused before anything is written ──
  describe("review M7: own exclusive raw mount only", () => {
    it("private vault ⇒ 78 · mounted ⇒ 76 · live private instance ⇒ 76 · unlock reports already ⇒ 76; no worker, no unmount", async () => {
      const env = mkEnv();
      const r = mkRelocVault(env, "pm");
      let workers = 0;
      const counting = (extra: Record<string, unknown>) =>
        r.ports({
          runWorker: async () => {
            workers++;
            return { kind: "err", code: 1, message: "must not run" };
          },
          ...extra,
        });
      const e = entry(env.home, "pm");
      writeVaults(env.home, { pm: { ...e, private: true } });
      expect((await A.relocateVault({ name: "pm", home: env.home }, counting({}))).code).toBe(78);
      writeVaults(env.home, { pm: e });
      expect(
        (await A.relocateVault({ name: "pm", home: env.home }, counting({ probeMountState: async () => "mounted" })))
          .code,
      ).toBe(76);
      expect(
        (
          await A.relocateVault(
            { name: "pm", home: env.home },
            counting({ vaultInstanceView: async () => ({ state: "session" }) }),
          )
        ).code,
      ).toBe(76);
      const already = await A.relocateVault(
        { name: "pm", home: env.home },
        counting({
          unlockVault: async () => {
            r.calls.push("unlock-already");
            return { how: "already", realMnt: r.mnt };
          },
        }),
      );
      expect(already.code).toBe(76);
      expect(workers).toBe(0);
      expect(r.calls).toEqual(["unlock-already"]); // and NOT finalize: someone else's mount is left alone
      expect(entry(env.home, "pm").relocate.phase).toBe("pending");
    });
  });
});

// ───────────────────────────── security review V5 (B2/B3/M4/M5/M6/M8/M9) ─────────────────────────────

describe("security review V5", () => {
  /** REAL crash (SIGKILL in a child process) at the commit point ⇒ published + pending state. */
  function crashImport(env: Env, name: string, extraArgs: string[] = []): void {
    const script = join(env.home, `crash-${name}.mjs`);
    writeFileSync(
      script,
      `import * as A from ${JSON.stringify(pathToFileURL(join(REPO, "src/secure/bin/archive.mjs")).href)};\n` +
        `const [file, name, home, mnt] = process.argv.slice(2);\n` +
        `await A.cmdImport({ file, name, home, ...(mnt ? { path: mnt } : {}) }, {\n` +
        `  isTTY: () => false, out: () => {}, err: () => {}, onInterrupt: () => () => {},\n` +
        `  patchVaultEntry: () => process.kill(process.pid, "SIGKILL"),\n` +
        `});\n`,
    );
    const r = spawnSync(
      process.execPath,
      [script, writePkg(env, undefined, `${name}.tar`), name, env.home, ...extraArgs],
      {
        timeout: 60_000,
      },
    );
    expect(r.signal).toBe("SIGKILL");
    expect(A.readImportState(name, env.home).state.phase).toBe("published");
  }
  const vaultFiles = (env: Env, name: string) => readdirSync(H.defaultVaultDir(name, env.home)).sort();

  it("B2: abort waits on the transaction lock while resume commits ⇒ abort never deletes the committed vault", async () => {
    const env = mkEnv();
    crashImport(env, "cc");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const resume = A.cmdImportResume(
      { name: "cc", home: env.home },
      env.ports({
        runWorker: async (op: string, p: unknown, o: unknown) => {
          if (op === "sync") await gate; // resume is inside the lock, before its commit
          return A.spawnWorker(op, p, o);
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    // a non-waiting abort is refused 73 while resume holds the lock …
    expect(await A.cmdImportAbort({ name: "cc", home: env.home, lockWaitS: 0 }, env.ports())).toBe(73);
    // … a waiting abort decides only after resume released the lock
    const abort = A.cmdImportAbort({ name: "cc", home: env.home }, env.ports());
    await new Promise((r) => setTimeout(r, 300));
    release();
    expect(await resume).toBe(0);
    const ac = await abort;
    expect([1, 66]).toContain(ac);
    expect(vaultFiles(env, "cc")).toEqual(["cipher", "mount.lease", "mount.lock"]);
    expect(entry(env.home, "cc").pending).toBeUndefined();
    expect(existsSync(join(env.home, "secure", "cc"))).toBe(true);
  }, 60_000);

  it("B2: the lock of a SIGKILLed import is released (holder exits on pipe EOF)", async () => {
    const env = mkEnv();
    crashImport(env, "kl");
    expect(await A.cmdImportAbort({ name: "kl", home: env.home, lockWaitS: 3 }, env.ports())).toBe(0);
    expectNoImportResidue(env, "kl");
  });

  it("B3: vaultEntryState is three-state; unknown / no-file never authorize a rollback", async () => {
    const env = mkEnv();
    expect(A.vaultEntryState("x", env.home)).toEqual({ kind: "no-file" });
    writeFileSync(settingsPath(env.home), "{ broken");
    expect(A.vaultEntryState("x", env.home).kind).toBe("unknown");
    writeFileSync(settingsPath(env.home), JSON.stringify({ secure: { vaults: [] } }));
    expect(A.vaultEntryState("x", env.home).kind).toBe("unknown");
    writeFileSync(settingsPath(env.home), JSON.stringify({ secure: { vaults: { x: 3 } } }));
    expect(A.vaultEntryState("x", env.home).kind).toBe("unknown");
    writeFileSync(settingsPath(env.home), JSON.stringify({ secure: { vaults: {} } }));
    expect(A.vaultEntryState("x", env.home)).toEqual({ kind: "absent" });

    for (const breakIt of ["json", "eacces", "missing"] as const) {
      const e2 = mkEnv();
      crashImport(e2, "un");
      const sp = settingsPath(e2.home);
      const good = readFileSync(sp);
      if (breakIt === "json") writeFileSync(sp, "{ not json");
      else if (breakIt === "eacces") chmodSync(sp, 0o000);
      else rmSync(sp);
      expect(await A.cmdImportAbort({ name: "un", home: e2.home }, e2.ports()), breakIt).toBe(78);
      expect(vaultFiles(e2, "un")).toEqual(["cipher", "mount.lease", "mount.lock"]);
      expect(existsSync(A.importStatePath("un", e2.home))).toBe(true);
      // and the internal rollback primitive refuses as well
      const rb = await A.rollbackImport(A.readImportState("un", e2.home).state, e2.ports(), e2.home);
      expect(rb.done).toBe(false);
      expect(vaultFiles(e2, "un")).toEqual(["cipher", "mount.lease", "mount.lock"]);
      if (breakIt === "eacces") chmodSync(sp, 0o600);
      writeFileSync(sp, good);
    }
  });

  it("B3: commit landed, then the settings file became unreadable ⇒ the failing import keeps everything", async () => {
    const env = mkEnv();
    const code = await A.cmdImport(
      { file: writePkg(env), name: "ur", home: env.home },
      env.ports({
        patchVaultEntry: (...args: unknown[]) => {
          H.patchVaultEntry(...args);
          writeFileSync(settingsPath(env.home), "{ corrupted after the commit");
          throw new H.CliError(1, "__vault-patch 输出无法解析");
        },
      }),
    );
    expect(code).toBe(74);
    expect(vaultFiles(env, "ur")).toEqual(["cipher", "mount.lease", "mount.lock"]);
    expect(env.lines.err.join("\n")).toMatch(/无法确认 ur 的登记状态/);
  });

  it("M4: a state file whose mnt does not match the registration is refused, the victim untouched", async () => {
    const env = mkEnv();
    crashImport(env, "tm");
    const victim = join(env.home, "victim");
    mkdirSync(victim, { mode: 0o700 });
    for (const n of ["work", "state"]) writeFileSync(join(victim, n), ""); // sentinel-shaped user dir
    const st = lstatSync(victim, { bigint: true });
    const s = A.readImportState("tm", env.home).state;
    A.writeImportState(
      { ...s, mnt: victim, ids: { ...s.ids, mnt: { dev: String(st.dev), ino: String(st.ino) } } },
      env.home,
    );
    expect(await A.cmdImportAbort({ name: "tm", home: env.home }, env.ports())).toBe(74);
    expect(readdirSync(victim).sort()).toEqual(["state", "work"]);
    expect(vaultFiles(env, "tm")).toEqual(["cipher", "mount.lease", "mount.lock"]); // nothing deleted at all
    expect(await A.cmdImportResume({ name: "tm", home: env.home }, env.ports())).toBe(1);
    expect(entry(env.home, "tm").pending).toMatch(/^import:/);
  });

  it("M4: without a registration a non-default mnt is never deleted (only provable artifacts)", async () => {
    const env = mkEnv();
    mkdirSync(join(env.home, "alt"), { mode: 0o700 });
    const mnt = join(env.home, "alt", "nd");
    crashImport(env, "nd", [mnt]);
    const cur = readSettings(env.home);
    delete cur.secure.vaults.nd; // the entry is provably absent now
    writeFileSync(settingsPath(env.home), JSON.stringify(cur));
    expect(await A.cmdImportAbort({ name: "nd", home: env.home }, env.ports())).toBe(74);
    expect(readdirSync(mnt).sort()).toEqual(["state", "work"]);
    expect(existsSync(H.defaultVaultDir("nd", env.home))).toBe(false); // derived dir was provably ours
  });

  it("M5: a pre-existing partial (same txid) ⇒ 78 and the canary keeps its content and identity", async () => {
    const env = mkEnv();
    mkVault(env, "pc");
    const out = join(env.home, "pc.tar");
    const partial = `${out}.partial-${"e".repeat(24)}`;
    writeFileSync(partial, "canary", { mode: 0o600 });
    const before = lstatSync(partial, { bigint: true });
    const code = await A.cmdExport(
      { name: "pc", file: out, home: env.home },
      env.ports({ txid: () => "e".repeat(24) }),
    );
    expect(code).toBe(78);
    const after = lstatSync(partial, { bigint: true });
    expect(readFileSync(partial, "utf8")).toBe("canary");
    expect(after.ino).toBe(before.ino);
    expect(existsSync(out)).toBe(false);
    expect(env.lines.err.join("\n")).toMatch(/无法证明由本次导出创建，未删除/);
  });

  it("M6: leader exits on TERM, a same-group descendant ignoring TERM (no shared pipes) is still KILLed", async () => {
    const env = mkEnv();
    const pidFile = join(env.home, "orphan.pid");
    const r = await A.spawnWorker(
      "sync",
      { path: env.home },
      {
        stallMs: 300,
        env: {
          ...process.env,
          PI_SECURE_TEST_ARCHIVE_STALL_MS: "20000",
          PI_SECURE_TEST_ARCHIVE_ORPHAN_PIDFILE: pidFile,
        },
      },
    );
    expect(r.kind).toBe("stalled");
    const pid = Number(readFileSync(pidFile, "utf8"));
    let alive = true;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      alive = !/\) [ZX] /.test(stat);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("M8: getfattr non-zero ⇒ 74 · getfattr missing ⇒ python3 fallback finds xattrs · neither ⇒ 69 · selinux counts", () => {
    const env = mkEnv();
    const dir = join(env.home, "c");
    mkdirSync(dir);
    writeFileSync(join(dir, "f"), "x");
    const bin = join(env.home, "bin");
    mkdirSync(bin);
    const failing = join(bin, "getfattr-fail");
    writeFileSync(failing, "#!/bin/sh\necho 'getfattr: Permission denied' >&2\nexit 1\n", { mode: 0o755 });
    const selinux = join(bin, "getfattr-selinux");
    writeFileSync(selinux, `#!/bin/sh\nprintf '# file: ${dir}/f\\nsecurity.selinux="x"\\n\\n'\nexit 0\n`, {
      mode: 0o755,
    });
    const none = join(bin, "no-such-binary");
    expect(() => A.scanCipherXattrs(dir, { getfattrBin: failing })).toThrow(/getfattr 扫描失败/);
    try {
      A.scanCipherXattrs(dir, { getfattrBin: failing });
    } catch (e: any) {
      expect(e.code).toBe(74);
    }
    expect(A.scanCipherXattrs(dir, { getfattrBin: selinux })).toEqual([{ file: `${dir}/f`, key: "security.selinux" }]);
    expect(A.scanCipherXattrs(dir, { getfattrBin: none })).toEqual([]);
    try {
      A.scanCipherXattrs(dir, { getfattrBin: none, pythonBin: none });
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe(69);
      expect(e.message).toMatch(/请安装 attr 包/);
    }
    const set = spawnSync("python3", [
      "-c",
      "import os,sys; os.setxattr(sys.argv[1], 'user.v5', b'1')",
      join(dir, "f"),
    ]);
    if (set.status === 0) {
      expect(A.scanCipherXattrs(dir, { getfattrBin: none })).toEqual([{ file: join(dir, "f"), key: "user.v5" }]);
      // python scan failure (entry cap) ⇒ 74, never "no xattrs"
      try {
        A.scanCipherXattrs(dir, { getfattrBin: none, maxEntries: 1 });
        expect.unreachable();
      } catch (e: any) {
        expect(e.code).toBe(74);
      }
    }
  });

  it("M8: an xattr on a real cipher file refuses the export (65) through the default scanner", async () => {
    const env = mkEnv();
    const v = mkVault(env, "xa");
    const f = join(v.cipher, "Fa0aaaaaaaaaaaaaaaaaaa");
    const set = spawnSync("python3", ["-c", "import os,sys; os.setxattr(sys.argv[1], 'user.v5', b'1')", f]);
    if (set.status !== 0) return; // filesystem without user xattrs
    const code = await A.cmdExport({ name: "xa", file: join(env.home, "xa.tar"), home: env.home }, env.ports());
    expect(code).toBe(65);
    expect(readdirSync(env.home).filter((n) => n.startsWith("xa.tar"))).toEqual([]);
  });

  it("M9: --verify-password verifies even when the package claims the same address", async () => {
    const env = mkEnv();
    const p = G.baseline();
    p.meta.origRealWork = join(env.home, "secure", "vs", "work"); // MANIFEST says: no relocation needed
    const pkg = writePkg(env, G.assemble(p), "vs.tar");
    const calls: string[] = [];
    const c77 = await A.cmdImport(
      { file: pkg, name: "vs", verifyPassword: true, home: env.home },
      env.ports({
        isTTY: () => true,
        unlockVault: async () => {
          calls.push("unlock");
          throw new H.CliError(77, "口令连错 3 次");
        },
      }),
    );
    expect(c77).toBe(77);
    expect(calls).toEqual(["unlock"]);
    expect(entry(env.home, "vs").pending).toBeUndefined(); // the import itself is kept
    expect(entry(env.home, "vs").relocate).toBeUndefined();
    const p2 = G.baseline();
    p2.meta.origRealWork = join(env.home, "secure", "vt", "work");
    const ok = await A.cmdImport(
      { file: writePkg(env, G.assemble(p2), "vt.tar"), name: "vt", verifyPassword: true, home: env.home },
      env.ports({
        isTTY: () => true,
        unlockVault: async (_v: unknown, o: { postMount: boolean }) => {
          calls.push(`unlock:${o.postMount}`);
          return { how: "mounted", realMnt: "/nonexistent-v5" };
        },
        finalizeBounded: async () => {
          calls.push("finalize");
          return { code: 0, lines: [] };
        },
      }),
    );
    expect(ok).toBe(0);
    expect(calls).toEqual(["unlock", "unlock:false", "finalize"]);
  });
});

// ───────────────────────────── real gocryptfs end-to-end ─────────────────────────────

const fuseOk = (): boolean =>
  spawnSync("sh", ["-c", "[ -c /dev/fuse ] && [ -r /dev/fuse ] && [ -w /dev/fuse ]"]).status === 0;
const HAVE_FUSE =
  process.platform === "linux" && ["gocryptfs", "fusermount3", "flock", "timeout"].every(which) && fuseOk();

describe.skipIf(!HAVE_FUSE)("real gocryptfs: export → import → relocate → plaintext intact", () => {
  let env: Env;
  let release: (() => void) | undefined;
  let disposed = false;
  const mounts: string[] = [];
  const FAKE_PW = "TESTPASS-fake-not-a-secret";
  let pf = "";

  const mountedAt = (mnt: string) =>
    readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .some((l) => l.split(" ")[4] === mnt);
  function mount(cipher: string, mnt: string): void {
    const log = join(env.home, "mount.log");
    const fd = openSync(log, "a", 0o600);
    let status: number | null;
    try {
      // daemon inherits stdio: never pipes (spawnSync would wait for EOF forever)
      status = spawnSync("timeout", ["30", "gocryptfs", "-q", "-nonempty", "-passfile", pf, "--", cipher, mnt], {
        stdio: ["ignore", fd, fd],
      }).status;
    } finally {
      closeSync(fd);
    }
    expect(status, readFileSync(log, "utf8")).toBe(0);
    mounts.push(mnt);
  }
  function umount(mnt: string): void {
    spawnSync("timeout", ["20", "fusermount3", "-u", mnt]);
    if (!mountedAt(mnt)) mounts.splice(mounts.indexOf(mnt), 1);
  }

  beforeAll(async () => {
    release = await acquireGocryptfsTestLock(400_000);
    if (disposed) {
      release();
      release = undefined;
    }
  }, 600_000);
  afterAll(() => {
    disposed = true;
    for (const m of [...mounts]) spawnSync("timeout", ["20", "fusermount3", "-uz", m]);
    release?.();
  });

  it("round trip", async () => {
    env = mkEnv();
    pf = join(env.home, "pf");
    writeFileSync(pf, FAKE_PW, { mode: 0o600 });
    // source vault (new layout) with plaintext + a session referencing its own work dir
    const dir = H.defaultVaultDir("rsrc", env.home);
    const mnt = join(env.home, "secure", "rsrc");
    const v = H.deriveVault("rsrc", dir, mnt);
    H.createLayout(v, { home: env.home });
    const init = spawnSync("timeout", ["60", "gocryptfs", "-init", "-q", "-passfile", pf, "--", v.cipher], {
      encoding: "utf8",
    });
    expect(init.status, `${init.stdout}${init.stderr}`).toBe(0);
    writeVaults(env.home, { rsrc: { dir, mnt } });
    // sentinels are 0400 files: replace them only while mounted (the mount covers them)
    mount(v.cipher, mnt);
    const realMnt = H.physicalPaths(v).realMnt;
    const fromWork = join(realMnt, "work");
    mkdirSync(join(mnt, "work"), { mode: 0o700 });
    mkdirSync(join(mnt, "state", "sessions", "default"), { recursive: true, mode: 0o700 });
    writeFileSync(join(mnt, "work", "hello.txt"), "plaintext-v5");
    writeFileSync(
      join(mnt, "state", "sessions", "default", "s.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "s", cwd: `${fromWork}/p` })}\n`,
    );
    // export refuses while mounted (§3.5)
    const out = join(env.home, "real.tar");
    expect(await A.cmdExport({ name: "rsrc", file: out, home: env.home }, env.ports())).toBe(76);
    umount(mnt);
    expect(mountedAt(mnt)).toBe(false);
    const real = env.ports();
    delete real.gocryptfsVersion; // the real `gocryptfs -version` port
    expect(await A.cmdExport({ name: "rsrc", file: out, home: env.home }, real), env.lines.err.join("\n")).toBe(0);
    // the package carries no plaintext bytes
    expect(readFileSync(out).includes(Buffer.from("plaintext-v5"))).toBe(false);

    // import under a new name + another mount point
    mkdirSync(join(env.home, "alt"), { mode: 0o700 });
    const nmnt = join(env.home, "alt", "rdst");
    expect(await A.cmdImport({ file: out, name: "rdst", path: nmnt, home: env.home }, env.ports())).toBe(0);
    const ndir = H.defaultVaultDir("rdst", env.home);
    const nv = H.deriveVault("rdst", ndir, nmnt);
    expect(entry(env.home, "rdst").relocate.from).toBe(fromWork);

    const res = await A.relocateVault(
      { name: "rdst", home: env.home },
      env.ports({
        unlockVault: async () => {
          mount(nv.cipher, nmnt);
          return { how: "mounted", realMnt: H.physicalPaths(nv).realMnt };
        },
        finalizeBounded: async () => {
          umount(nmnt);
          return { code: mountedAt(nmnt) ? 76 : 0, lines: [] };
        },
      }),
    );
    expect(res.code, JSON.stringify(res)).toBe(0);
    expect(mountedAt(nmnt)).toBe(false);
    expect(entry(env.home, "rdst").relocate).toBeUndefined();
    mount(nv.cipher, nmnt);
    try {
      expect(readFileSync(join(nmnt, "work", "hello.txt"), "utf8")).toBe("plaintext-v5");
      const head = JSON.parse(
        readFileSync(join(nmnt, "state", "sessions", "default", "s.jsonl"), "utf8").split("\n")[0]!,
      );
      expect(head.cwd).toBe(join(H.physicalPaths(nv).realMnt, "work", "p"));
      expect(JSON.parse(readFileSync(join(nmnt, "work", ".pi", "settings.json"), "utf8")).sessionDir).toBe(
        nv.sessionDir,
      );
    } finally {
      umount(nmnt);
    }
    expect(H.checkLayout(nv, { home: env.home }).problems).toEqual([]);
  }, 180_000);
  it("review B1 (real gocryptfs): a decrypted state/work symlink to outside ⇒ relocation 65, outside untouched", async () => {
    for (const kind of ["state", "work"] as const) {
      env = mkEnv();
      pf = join(env.home, "pf");
      writeFileSync(pf, FAKE_PW, { mode: 0o600 });
      const name = `ln${kind}`;
      const dir = H.defaultVaultDir(name, env.home);
      const mnt = join(env.home, "secure", name);
      const v = H.deriveVault(name, dir, mnt);
      H.createLayout(v, { home: env.home });
      const init = spawnSync("timeout", ["60", "gocryptfs", "-init", "-q", "-passfile", pf, "--", v.cipher], {
        encoding: "utf8",
      });
      expect(init.status, `${init.stdout}${init.stderr}`).toBe(0);
      writeVaults(env.home, { [name]: { dir, mnt } });
      const fromWork = join(H.physicalPaths(v).realMnt, "work");
      const outside = join(env.home, "outside");
      mkdirSync(join(outside, "sessions", "default"), { recursive: true, mode: 0o700 });
      mkdirSync(join(outside, "memory", S.memorySlug(fromWork)), { recursive: true, mode: 0o700 });
      writeFileSync(
        join(outside, "sessions", "default", "s.jsonl"),
        `${JSON.stringify({ type: "session", version: 3, id: "o", cwd: `${fromWork}/p` })}\n`,
      );
      mount(v.cipher, mnt);
      if (kind === "state") {
        mkdirSync(join(mnt, "work"), { mode: 0o700 });
        symlinkSync(outside, join(mnt, "state")); // plaintext link chosen by the exporter
      } else {
        mkdirSync(join(mnt, "state"), { mode: 0o700 });
        symlinkSync(outside, join(mnt, "work"));
      }
      umount(mnt);
      const out = join(env.home, `${name}.tar`);
      expect(await A.cmdExport({ name, file: out, home: env.home }, env.ports())).toBe(0);
      mkdirSync(join(env.home, "alt"), { mode: 0o700 });
      const nmnt = join(env.home, "alt", `${name}2`);
      expect(await A.cmdImport({ file: out, name: `${name}2`, path: nmnt, home: env.home }, env.ports())).toBe(0);
      const nv = H.deriveVault(`${name}2`, H.defaultVaultDir(`${name}2`, env.home), nmnt);
      const before = snapshot(outside);
      const beforeSession = readFileSync(join(outside, "sessions", "default", "s.jsonl"), "utf8");
      const res = await A.relocateVault(
        { name: `${name}2`, home: env.home },
        env.ports({
          unlockVault: async () => {
            mount(nv.cipher, nmnt);
            return { how: "mounted", realMnt: H.physicalPaths(nv).realMnt };
          },
          finalizeBounded: async () => {
            umount(nmnt);
            return { code: mountedAt(nmnt) ? 76 : 0, lines: [] };
          },
        }),
      );
      expect(res.code, `${kind}: ${JSON.stringify(res)}`).toBe(65);
      expect(mountedAt(nmnt)).toBe(false);
      expect(snapshot(outside)).toEqual(before);
      expect(readFileSync(join(outside, "sessions", "default", "s.jsonl"), "utf8")).toBe(beforeSession);
      expect(existsSync(join(outside, ".pi"))).toBe(false);
      expect(entry(env.home, `${name}2`).relocate).toBeDefined();
    }
  }, 180_000);
});
