/**
 * convert-plan.md §7.3 XC8 / XC9 — the pre-gate of package V2 (`src/secure/bin/tree.mjs`), run
 * BEFORE V2 starts (V7 later folds these into `tests/conformance/secure-convert.test.ts`).
 *
 *  XC8  coreutils `mv -n -T` uses `renameat2(…, RENAME_NOREPLACE)` on a whitelisted filesystem
 *       (asserted with strace when available, otherwise by behaviour: an existing EMPTY target
 *       directory is never replaced), and exits 0 even when the target exists and nothing moved —
 *       so tree.mjs must judge every rename by an after-the-fact lstat identity check.
 *  XC9  gocryptfs hands every write to the backend file before write()/close() returns (no FUSE
 *       writeback cache: the cipher file already has its full ciphertext size while the plaintext
 *       fd is still open and was never fsynced), and `sync -f <cipher>` runs syncfs(2) on the
 *       backend filesystem.
 *  +    tree.mjs on a REAL gocryptfs mount: copyTree into the mount (O_EXCL|O_NOFOLLOW files,
 *       fchmod/futimes, symlink + lutimes, link()) and verifyCopy read-back both succeed.
 *
 * Self-gating (no env switch): XC8 needs Linux + GNU mv; XC9 needs gocryptfs/fusermount3/flock and
 * a usable /dev/fuse. Everything happens in a private mktemp dir with a TEST-ONLY fake password;
 * mounts are always unmounted in afterAll. Never touches a real vault, ~/secure or ~/.pi.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireGocryptfsTestLock } from "../secure/gocryptfs-test-lock.js";

const REPO = join(import.meta.dirname, "..", "..");
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS module, no typings by design
const T: any = await import(pathToFileURL(join(REPO, "src", "secure", "bin", "tree.mjs")).href);

function which(bin: string): string | undefined {
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}
const GNU_MV =
  process.platform === "linux" && /GNU coreutils/.test(spawnSync("mv", ["--version"], { encoding: "utf8" }).stdout);
const STRACE = which("strace") !== undefined;
const FUSE_OK =
  process.platform === "linux" &&
  ["gocryptfs", "fusermount3", "flock", "timeout"].every((b) => which(b) !== undefined) &&
  spawnSync("sh", ["-c", "[ -c /dev/fuse ] && [ -r /dev/fuse ] && [ -w /dev/fuse ]"]).status === 0;

const FAKE_PW = "TESTPASS-xc89-fake-not-a-secret";

describe.skipIf(!GNU_MV)("XC8 mv -n -T", () => {
  let tmp = "";
  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-secure-xc8-")));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("runs on a whitelisted filesystem (RENAME_NOREPLACE is native there)", () => {
    const magic = statfsSync(tmp).type;
    expect(Object.values(T.FS_MAGIC)).toContain(magic);
  });

  const mvIn = (cwd: string, ...args: string[]) => {
    if (!STRACE) return { status: spawnSync("mv", args, { cwd }).status, trace: "" };
    const traceFile = join(tmp, `trace-${Math.random().toString(36).slice(2)}`);
    const r = spawnSync(
      "strace",
      ["-f", "-qq", "-e", "trace=rename,renameat,renameat2", "-o", traceFile, "mv", ...args],
      {
        cwd,
      },
    );
    const trace = readFileSync(traceFile, "utf8");
    rmSync(traceFile);
    return { status: r.status, trace };
  };

  it("existing EMPTY target directory: exit 0, nothing moved, target not replaced", () => {
    const d = join(tmp, "empty-target");
    mkdirSync(join(d, "a"), { recursive: true });
    writeFileSync(join(d, "a", "f"), "x");
    mkdirSync(join(d, "b"));
    const a0 = lstatSync(join(d, "a"));
    const b0 = lstatSync(join(d, "b"));
    const r = mvIn(d, "-n", "-T", "--", "a", "b");
    expect(r.status).toBe(0); // ⇒ the exit code can never be trusted
    expect(lstatSync(join(d, "a")).ino).toBe(a0.ino);
    expect(lstatSync(join(d, "b")).ino).toBe(b0.ino);
    expect(readdirSync(join(d, "b"))).toEqual([]);
    if (STRACE) {
      expect(r.trace).toMatch(/renameat2\([^)]*"a"[^)]*"b"[^)]*RENAME_NOREPLACE\)\s*=\s*-1 EEXIST/);
      expect(r.trace).not.toMatch(/(^|\s)rename(at)?\(/m);
    }
    // the tree.mjs judgement reaches the same verdict
  });

  it("existing FILE target: exit 0, nothing moved", () => {
    const d = join(tmp, "file-target");
    mkdirSync(join(d, "a"), { recursive: true });
    writeFileSync(join(d, "c"), "keep");
    const r = mvIn(d, "-n", "-T", "--", "a", "c");
    expect(r.status).toBe(0);
    expect(readFileSync(join(d, "c"), "utf8")).toBe("keep");
    expect(lstatSync(join(d, "a")).isDirectory()).toBe(true);
    if (STRACE) expect(r.trace).toMatch(/RENAME_NOREPLACE\)\s*=\s*-1 EEXIST/);
  });

  it("absent target: one renameat2(RENAME_NOREPLACE) = 0, same inode under the new name", () => {
    const d = join(tmp, "absent-target");
    mkdirSync(join(d, "a"), { recursive: true });
    const a0 = lstatSync(join(d, "a"));
    const r = mvIn(d, "-n", "-T", "--", "a", "b");
    expect(r.status).toBe(0);
    expect(() => lstatSync(join(d, "a"))).toThrow(/ENOENT/);
    expect(lstatSync(join(d, "b")).ino).toBe(a0.ino);
    if (STRACE) {
      expect(r.trace).toMatch(/renameat2\([^)]*"a"[^)]*"b"[^)]*RENAME_NOREPLACE\)\s*=\s*0/);
      expect(r.trace.match(/renameat2\(/g)?.length).toBe(1);
    }
  });

  it("tree.mjs renameNoReplace judges the exit-0 no-op as a failure", async () => {
    const d = join(tmp, "judge");
    mkdirSync(join(d, "a"), { recursive: true });
    mkdirSync(join(d, "b"));
    const a0 = lstatSync(join(d, "a"), { bigint: true });
    const r = await T.renameNoReplace({
      parent: d,
      from: "a",
      to: "b",
      expect: { dev: String(a0.dev), ino: String(a0.ino) },
    });
    expect(r.ok).toBe(false);
    expect(r.state).toBe("unchanged");
  });
});

describe.skipIf(!FUSE_OK)("XC9 gocryptfs write-through + sync -f", () => {
  let tmp = "";
  let cipher = "";
  let mnt = "";
  let release: (() => void) | undefined;
  let mounted = false;

  beforeAll(async () => {
    release = await acquireGocryptfsTestLock(560_000);
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-secure-xc9-")));
    chmodSync(tmp, 0o700);
    cipher = join(tmp, "cipher");
    mnt = join(tmp, "mnt");
    mkdirSync(cipher);
    mkdirSync(mnt);
    const pf = join(tmp, "pf");
    writeFileSync(pf, `${FAKE_PW}\n`, { mode: 0o600 });
    const init = spawnSync("timeout", ["20", "gocryptfs", "-init", "-q", "-passfile", pf, "--", cipher]);
    expect(init.status).toBe(0);
    const m = spawnSync("timeout", ["20", "gocryptfs", "-q", "-passfile", pf, "--", cipher, mnt]);
    expect(m.status).toBe(0);
    mounted = true;
  }, 600_000); // the cross-file gocryptfs test lock may be held by another real-mount suite

  afterAll(() => {
    if (mounted) spawnSync("timeout", ["10", "fusermount3", "-u", mnt]);
    if (tmp) {
      spawnSync("chmod", ["-R", "u+rwx", tmp]);
      rmSync(tmp, { recursive: true, force: true });
    }
    release?.();
  });

  const cipherFiles = () => readdirSync(cipher).filter((n) => !n.startsWith("gocryptfs."));

  it("a write reaches the backend cipher file before close and without fsync", () => {
    const before = new Set(cipherFiles());
    const fd = openSync(join(mnt, "probe"), "wx", 0o600);
    try {
      const size = 1 << 20;
      writeSync(fd, Buffer.alloc(size, 7));
      const fresh = cipherFiles().filter((n) => !before.has(n));
      expect(fresh).toHaveLength(1);
      // gocryptfs 1.8 on-disk format: 18-byte header + per 4096-byte block a 32-byte overhead
      const want = 18 + size + Math.ceil(size / 4096) * 32;
      expect(statSync(join(cipher, fresh[0]!)).size).toBe(want);
      expect(T.gocryptfsCipherSize(size)).toBe(want);
      expect(fstatSync(fd).size).toBe(size);
    } finally {
      closeSync(fd);
    }
  });

  it("sync -f <cipher> runs syncfs(2)", () => {
    if (STRACE) {
      const r = spawnSync("strace", ["-qq", "-e", "trace=syncfs,sync", "sync", "-f", "--", cipher], {
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/syncfs\(\d+\)\s*=\s*0/);
      expect(r.stderr).not.toMatch(/(^|\n)sync\(\)/);
    } else {
      expect(spawnSync("sync", ["-f", "--", cipher]).status).toBe(0);
    }
  });

  it("tree.mjs syncBarrier succeeds on the backend", () => {
    const r = T.syncBarrier({ syncfs: [T.dirTarget(cipher)], fsyncDirs: [T.dirTarget(tmp)] });
    expect(r.ok).toBe(true);
  });

  it("tree.mjs copyTree + verifyCopy on the real mount", () => {
    const src = join(tmp, "src");
    mkdirSync(join(src, "d", "e"), { recursive: true });
    writeFileSync(join(src, "f.txt"), "hello");
    writeFileSync(join(src, "d", "big.bin"), Buffer.alloc(9 * 1024 * 1024 + 17, 3));
    writeFileSync(join(src, "ro"), "readonly", { mode: 0o444 });
    chmodSync(join(src, "ro"), 0o444);
    linkSync(join(src, "f.txt"), join(src, "d", "hard"));
    symlinkSync("../f.txt", join(src, "d", "rel"));
    symlinkSync("/nonexistent/target", join(src, "abs"));
    chmodSync(join(src, "d", "e"), 0o500);
    const dst = join(mnt, "work");
    mkdirSync(dst);
    const manifest = T.walkTree(src);
    const copy = T.copyTree({ src, dst, baseline: manifest });
    expect(copy.files).toBe(3);
    const v = T.verifyCopy({ dst, baseline: manifest, hashes: copy.hashes });
    expect(v.diffs).toEqual([]);
    expect(v.ok).toBe(true);
    expect(lstatSync(join(dst, "d", "hard")).ino).toBe(lstatSync(join(dst, "f.txt")).ino);
  });
});
