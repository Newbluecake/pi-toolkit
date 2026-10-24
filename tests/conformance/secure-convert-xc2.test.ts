/**
 * XC2 (docs/dev/data-encryption/convert-plan.md §7.3) — the freeze gate of package format
 * `pi-secure-vault/2`: how REAL gocryptfs represents files, directories, symlinks, hardlinks, long file
 * names and xattrs in its cipher directory, and that src/secure/bin/tar.mjs round-trips a real cipher
 * tree (export → validating import into a staging root → mount the STAGED cipher → identical plaintext).
 * Also pins XC3's FeatureFlags fact (init flags == CONF_FEATURE_FLAGS) as a side effect.
 *
 * Self-gating (skipped without gocryptfs / fusermount3 / flock / usable /dev/fuse). Everything happens in
 * a private mktemp dir with a TEST-ONLY fake password via -passfile; every mount is unmounted and the
 * scratch dir removed in afterAll. Holds the cross-suite gocryptfs test lock (global mounts would make
 * `run --private` suites flaky). V7 folds this into tests/conformance/secure-convert.test.ts.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireGocryptfsTestLock } from "../secure/gocryptfs-test-lock.js";

const REPO = join(import.meta.dirname, "..", "..");
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS module, no typings by design
const T: any = await import(pathToFileURL(join(REPO, "src", "secure", "bin", "tar.mjs")).href);

const FAKE_PW = "TESTPASS-fake-not-a-secret";
const which = (b: string): boolean => spawnSync("sh", ["-c", `command -v ${b}`]).status === 0;
const fuseOk = (): boolean =>
  spawnSync("sh", ["-c", "[ -c /dev/fuse ] && [ -r /dev/fuse ] && [ -w /dev/fuse ]"]).status === 0;
const HAVE = process.platform === "linux" && ["gocryptfs", "fusermount3", "flock", "timeout"].every(which) && fuseOk();
const HAVE_PY = which("python3");

let root = "";
let release: (() => void) | undefined;
let disposed = false;
const mounts: string[] = [];

function run(cmd: string, args: string[], timeoutS = 30): { status: number | null; out: string } {
  const r = spawnSync("timeout", [String(timeoutS), cmd, ...args], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
function mounted(mnt: string): boolean {
  return readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .some((l) => l.split(" ")[4] === mnt);
}
function init(cipher: string): void {
  mkdirSync(cipher, 0o700);
  const r = run("gocryptfs", ["-init", "-q", "-passfile", join(root, "pf"), "--", cipher]);
  expect(r.status, r.out).toBe(0);
}
function mount(cipher: string, mnt: string): void {
  mkdirSync(mnt, { recursive: true, mode: 0o700 });
  // The gocryptfs daemon inherits stdout/stderr: with pipes, spawnSync would wait for an EOF that never
  // comes (the daemon lives on) ⇒ hang. Route both to a file fd instead.
  const log = join(root, "mount.log");
  const fd = openSync(log, "a", 0o600);
  let status: number | null;
  try {
    status = spawnSync("timeout", ["30", "gocryptfs", "-q", "-passfile", join(root, "pf"), "--", cipher, mnt], {
      stdio: ["ignore", fd, fd],
    }).status;
  } finally {
    closeSync(fd);
  }
  expect(status, readFileSync(log, "utf8")).toBe(0);
  expect(mounted(mnt)).toBe(true);
  mounts.push(mnt);
}
function umount(mnt: string): void {
  const r = run("fusermount3", ["-u", mnt], 15);
  expect(r.status, r.out).toBe(0);
  mounts.splice(mounts.indexOf(mnt), 1);
}
/**
 * Cleanup boundary (security review V1 #3, same rule as the N4 harness): this suite only ever unmounts the
 * mounts IT made (recorded in `mounts`, all under its own root) and only deletes the root IT created — proven
 * by a random per-run token written into `<root>/.xc2-owner` right after mkdtemp, an lstat'd directory (not
 * a symlink) owned by this uid. Leftovers of other runs (same name prefix or not) are only REPORTED.
 */
const RUN_TOKEN = randomBytes(16).toString("hex");
const OWNER_FILE = ".xc2-owner";
function ownRoot(d: string): boolean {
  try {
    const st = lstatSync(d);
    const uid = process.getuid?.();
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) return false;
    const mk = lstatSync(join(d, OWNER_FILE));
    if (!mk.isFile() || (uid !== undefined && mk.uid !== uid)) return false;
    return readFileSync(join(d, OWNER_FILE), "utf8") === RUN_TOKEN;
  } catch {
    return false;
  }
}
function reportForeignLeftovers(): void {
  const prefix = join(tmpdir(), "pi-secure-xc2-");
  const foreign = readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .map((l) => l.split(" ")[4])
    .filter(
      (mp): mp is string => mp !== undefined && mp.startsWith(prefix) && (root === "" || !mp.startsWith(`${root}/`)),
    );
  if (foreign.length > 0)
    console.warn(
      `[XC2] left alone (not created by this run): gocryptfs mounts ${foreign.join(", ")} — unmount manually`,
    );
}
function touchNs(p: string, at: string): void {
  expect(spawnSync("touch", ["-h", "-d", `@${at}`, p]).status).toBe(0);
}
function pyListXattr(p: string): string[] {
  const r = spawnSync(
    "python3",
    ["-c", "import os,sys,json;print(json.dumps(os.listxattr(sys.argv[1],follow_symlinks=False)))", p],
    {
      encoding: "utf8",
    },
  );
  return r.status === 0 ? (JSON.parse(r.stdout) as string[]) : [];
}

interface CEnt {
  rel: string;
  kind: "d" | "f" | "l" | "p" | "o";
  mode: number;
  nlink: number;
  ino: bigint;
  mtimeNs: bigint;
  size: number;
  target?: string;
}
function walkCipher(c: string): CEnt[] {
  const out: CEnt[] = [];
  const walk = (p: string, rel: string): void => {
    const st = lstatSync(p, { bigint: true });
    const kind = st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : st.isFile() ? "f" : st.isFIFO() ? "p" : "o";
    out.push({
      rel,
      kind,
      mode: Number(st.mode & 0o7777n),
      nlink: Number(st.nlink),
      ino: st.ino,
      mtimeNs: st.mtimeNs,
      size: Number(st.size),
      ...(kind === "l" ? { target: readlinkSync(p) } : {}),
    });
    if (kind === "d") for (const n of readdirSync(p).sort()) walk(join(p, n), rel === "" ? n : `${rel}/${n}`);
  };
  walk(c, "");
  return out;
}
/** Plaintext facts for the round-trip comparison (hardlink groups by first path). */
function plainFacts(m: string): Record<string, string> {
  const out: Record<string, string> = {};
  const groups = new Map<bigint, string>();
  const walk = (p: string, rel: string): void => {
    const st = lstatSync(p, { bigint: true });
    const kind = st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f";
    let g = "";
    if (kind === "f" && st.nlink > 1n) {
      g = groups.get(st.ino) ?? rel;
      groups.set(st.ino, g);
    }
    const body =
      kind === "f"
        ? `${createHash("sha256").update(readFileSync(p)).digest("hex")}#${st.size}`
        : kind === "l"
          ? readlinkSync(p)
          : "";
    out[rel] =
      `${kind}|${kind === "l" ? "" : (st.mode & 0o7777n).toString(8)}|${kind === "l" ? "" : st.nlink}|${g}|${body}`;
    if (kind === "d") for (const n of readdirSync(p)) walk(join(p, n), `${rel}/${n}`);
  };
  walk(m, ".");
  return out;
}

/** rel → mtime (ns). Compared with a 2 µs tolerance: Node passes float seconds and libuv truncates to µs, so the
 *  importer restores mtimes to ≤~1.3 µs (the package itself carries the exact ns value). */
function mtimesOf(top: string, rootRel: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const walk = (p: string, rel: string): void => {
    const st = lstatSync(p, { bigint: true });
    out.set(rel, st.mtimeNs);
    if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n), `${rel}/${n}`);
  };
  walk(top, rootRel);
  return out;
}
function expectMtimesClose(got: Map<string, bigint>, want: Map<string, bigint>): void {
  expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
  for (const [k, v] of want) {
    const d = got.get(k)! - v;
    expect(d >= -2000n && d <= 2000n, `${k}: Δ ${d} ns`).toBe(true);
  }
}

describe.skipIf(!HAVE)("XC2 — real gocryptfs cipher representation + package round trip", () => {
  let A: CEnt[] = [];
  let conf = "";
  let xattrPlain = false;
  let xattrCipher: string[] = [];
  const LONG = "L".repeat(250);

  beforeAll(async () => {
    // other real-mount suites (possibly from parallel runs) may hold the lock for minutes
    const rel = await acquireGocryptfsTestLock(400_000);
    if (disposed) {
      rel(); // the hook already timed out and afterAll ran: never mount after cleanup
      return;
    }
    release = rel;
    reportForeignLeftovers();
    root = mkdtempSync(join(tmpdir(), "pi-secure-xc2-"));
    chmodSync(root, 0o700);
    writeFileSync(join(root, OWNER_FILE), RUN_TOKEN, { mode: 0o600, flag: "wx" });
    writeFileSync(join(root, "pf"), `${FAKE_PW}\n`, { mode: 0o600 });

    // ── vault A: everything, incl. things the package must refuse (FIFO, setuid, xattr) ──
    const cA = join(root, "cA");
    const mA = join(root, "mA");
    init(cA);
    conf = readFileSync(join(cA, "gocryptfs.conf"), "utf8");
    mount(cA, mA);
    writeFileSync(join(mA, "f"), "hello\n", { mode: 0o644 });
    chmodSync(join(mA, "f"), 0o644);
    mkdirSync(join(mA, "d"), 0o755);
    chmodSync(join(mA, "d"), 0o755);
    writeFileSync(join(mA, "d", "inner"), "x");
    mkdirSync(join(mA, "empty"));
    symlinkSync("f", join(mA, "relsym"));
    symlinkSync("/etc/passwd", join(mA, "abssym"));
    symlinkSync("../../../../escape", join(mA, "dotsym"));
    symlinkSync("a".repeat(3000), join(mA, "longtarget"));
    linkSync(join(mA, "f"), join(mA, "hard1"));
    linkSync(join(mA, "f"), join(mA, "d", "hard2"));
    linkSync(join(mA, "relsym"), join(mA, "hardsym")); // link(2) does not follow: hardlinked symlink
    writeFileSync(join(mA, LONG), "long");
    writeFileSync(join(mA, "suid"), "s");
    chmodSync(join(mA, "suid"), 0o4755);
    expect(spawnSync("mkfifo", [join(mA, "fifo")]).status).toBe(0);
    writeFileSync(join(mA, "xa"), "x");
    if (HAVE_PY) {
      const r = spawnSync("python3", [
        "-c",
        "import os,sys;os.setxattr(sys.argv[1],'user.demo',b'secret-xattr')",
        join(mA, "xa"),
      ]);
      xattrPlain = r.status === 0;
    }
    touchNs(join(mA, "f"), "1600000000.123456789");
    touchNs(join(mA, "relsym"), "1500000000.5");
    const xaIno = lstatSync(join(mA, "xa")).ino; // gocryptfs passes inode numbers through
    umount(mA);
    A = walkCipher(cA);
    const xaCipher = A.find((e) => e.ino === BigInt(xaIno) && e.kind === "f");
    xattrCipher = xaCipher && HAVE_PY ? pyListXattr(join(cA, xaCipher.rel)) : [];
  }, 600_000);

  afterAll(() => {
    disposed = true;
    // only our own mounts (each recorded by mount(), all below our root)
    for (const m of [...mounts]) if (m.startsWith(`${root}/`)) spawnSync("timeout", ["15", "fusermount3", "-u", m]);
    for (const m of [...mounts])
      if (m.startsWith(`${root}/`) && mounted(m)) spawnSync("timeout", ["15", "fusermount3", "-uz", m]);
    const stillMounted = readFileSync("/proc/self/mountinfo", "utf8").includes(` ${root}/`);
    if (root !== "" && ownRoot(root) && !stillMounted) {
      spawnSync("chmod", ["-R", "u+rwx", root]);
      rmSync(root, { recursive: true, force: true });
    } else if (root !== "") console.warn(`[XC2] scratch dir kept (ownership/mount not proven clear): ${root}`);
    release?.();
  });

  it("XC3: init writes the strict conf shape and exactly the allowed FeatureFlags", () => {
    const c = T.validateGocryptfsConf(conf);
    expect(c.FeatureFlags).toEqual(T.CONF_FEATURE_FLAGS);
    expect(c.Version).toBe(2);
  });

  it("the cipher holds only dirs, regular files and symlinks — plus a FIFO for a plaintext FIFO", () => {
    const kinds = new Map<string, number>();
    for (const e of A) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
    expect([...kinds.keys()].sort()).toEqual(["d", "f", "l", "p"]);
    expect(kinds.get("p")).toBe(1);
    expect(kinds.get("o")).toBeUndefined();
  });

  it("every cipher name is in the package alphabet; encrypted names are raw base64url; dirs carry gocryptfs.diriv", () => {
    for (const e of A.slice(1)) {
      for (const seg of e.rel.split("/")) {
        expect(seg).toMatch(/^[A-Za-z0-9._=-]{1,255}$/);
        if (!seg.startsWith("gocryptfs.")) expect(seg).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    }
    for (const d of A.filter((e) => e.kind === "d")) {
      const iv = A.find((e) => e.rel === (d.rel === "" ? "gocryptfs.diriv" : `${d.rel}/gocryptfs.diriv`));
      expect(iv, d.rel).toMatchObject({ kind: "f", size: 16, mode: 0o440 });
    }
    expect(A.find((e) => e.rel === "gocryptfs.conf")).toMatchObject({ kind: "f", mode: 0o400 });
  });

  it("a long plaintext name becomes a gocryptfs.longname.<hash> file + .name sidecar", () => {
    const ln = A.filter((e) => /^gocryptfs\.longname\.[A-Za-z0-9_-]{43}(\.name)?$/.test(e.rel));
    expect(ln.length).toBe(2);
    expect(ln.every((e) => e.kind === "f")).toBe(true);
  });

  it("symlink targets are raw base64url (no '/', no '.'), ≤4095 bytes, even for absolute / escaping plaintext targets", () => {
    const syms = A.filter((e) => e.kind === "l");
    expect(syms.length).toBe(5); // relsym, abssym, dotsym, longtarget, hardsym
    for (const s of syms) {
      expect(s.target).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(s.target!.length).toBeLessThanOrEqual(4095);
      expect(s.mode).toBe(0o777);
    }
    expect(Math.max(...syms.map((s) => s.target!.length))).toBeGreaterThan(4000); // 3000-byte plaintext target
  });

  it("hardlinks are preserved as cipher hardlinks (files and symlinks alike)", () => {
    const fileGroup = A.filter((e) => e.kind === "f" && e.nlink === 3);
    expect(fileGroup.length).toBe(3);
    expect(new Set(fileGroup.map((e) => e.ino)).size).toBe(1);
    const symGroup = A.filter((e) => e.kind === "l" && e.nlink === 2);
    expect(symGroup.length).toBe(2);
    expect(new Set(symGroup.map((e) => e.ino)).size).toBe(1);
  });

  it("XC1: plaintext mode bits (incl. setuid) and ns mtimes are stored as the cipher's own mode/mtime", () => {
    expect(A.some((e) => e.kind === "f" && e.mode === 0o4755)).toBe(true);
    expect(A.some((e) => e.kind === "f" && e.mtimeNs === 1600000000123456789n && e.mode === 0o644)).toBe(true);
    expect(A.some((e) => e.kind === "l" && e.mtimeNs === 1500000000500000000n)).toBe(true);
    expect(A.some((e) => e.kind === "d" && e.mode === 0o755)).toBe(true);
  });

  it.skipIf(!HAVE_PY)(
    "plaintext xattrs become encrypted user.gocryptfs.* xattrs on the cipher file (the tar never carries them)",
    () => {
      expect(xattrPlain).toBe(true);
      expect(xattrCipher.length).toBe(1);
      expect(xattrCipher[0]).toMatch(/^user\.gocryptfs\.[A-Za-z0-9_-]+$/);
      expect(xattrCipher[0]).not.toContain("demo");
    },
  );

  it("the writer refuses vault A (FIFO / setuid) instead of silently dropping anything", () => {
    const fd = openSync(join(root, "A.tar"), "wx", 0o600);
    try {
      let reason = "";
      try {
        T.writePackage({
          cipherDir: join(root, "cA"),
          fd,
          name: "xc2a",
          gocryptfsVersion: "gocryptfs 1.8.0",
          origRealWork: "/x/work",
        });
      } catch (e) {
        reason = (e as { reason: string }).reason;
      }
      expect(["special-file", "mode-range"]).toContain(reason);
    } finally {
      closeSync(fd);
    }
  });

  it("round trip: a real cipher tree → package → staged import → mounted staged cipher shows the identical plaintext", () => {
    const cB = join(root, "cB");
    const mB = join(root, "mB");
    init(cB);
    mount(cB, mB);
    writeFileSync(join(mB, "f"), "hello\n");
    mkdirSync(join(mB, "d"), 0o750);
    mkdirSync(join(mB, "empty"));
    let deep = mB;
    for (let i = 0; i < 5; i++) {
      deep = join(deep, `deep-${i}-${"n".repeat(60)}`); // cipher path > 255 bytes ⇒ pax path
      mkdirSync(deep);
    }
    writeFileSync(join(deep, "leaf"), "leaf");
    writeFileSync(join(mB, LONG), "long name");
    writeFileSync(join(mB, "empty-file"), "");
    const big = Buffer.alloc(2 * 1024 * 1024 + 77);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
    writeFileSync(join(mB, "big"), big, { mode: 0o600 });
    writeFileSync(join(mB, "ro"), "ro", { mode: 0o400 });
    symlinkSync("f", join(mB, "relsym"));
    symlinkSync("/etc/hostname", join(mB, "abssym"));
    symlinkSync("b".repeat(3000), join(mB, "longtarget"));
    linkSync(join(mB, "f"), join(mB, "d", "hard"));
    linkSync(join(mB, "big"), join(deep, "hardbig"));
    linkSync(join(mB, "relsym"), join(mB, "hardsym"));
    touchNs(join(mB, "f"), "1600000000.123456789");
    touchNs(join(mB, "relsym"), "1500000000.5");
    touchNs(join(mB, "d"), "1400000000.25");
    const want = plainFacts(mB);
    const wantM = mtimesOf(mB, ".");
    umount(mB);

    const pkg = join(root, "B.tar");
    const fd = openSync(pkg, "wx", 0o600);
    let w;
    try {
      w = T.writePackage({
        cipherDir: cB,
        fd,
        name: "xc2b",
        gocryptfsVersion: "gocryptfs 1.8.0",
        origRealWork: `${root}/mB/work`,
      });
    } finally {
      closeSync(fd);
    }
    expect(w.manifest.totals.symlinks).toBe(4);
    expect(w.manifest.totals.hardlinks).toBe(2);
    if (which("tar")) expect(spawnSync("tar", ["-tf", pkg]).status).toBe(0);

    const S = join(root, "stage");
    mkdirSync(S, 0o700);
    const r = T.readPackage({ pkgPath: pkg, stagingRoot: S });
    expect(r.manifest).toEqual(w.manifest);
    const mS = join(root, "mS");
    mount(join(S, "cipher"), mS);
    const got = plainFacts(mS);
    const gotM = mtimesOf(mS, ".");
    umount(mS);
    // hardlinked symlinks come back as independent symlinks (same text); compare everything else exactly
    expect(got).toEqual(want);
    expectMtimesClose(gotM, wantM);
  });
});
