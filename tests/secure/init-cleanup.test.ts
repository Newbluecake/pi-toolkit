/**
 * init cleanup (user ruling 2026-10-24) — removeInitVault / recordInitCipher / unclaimInitEntry,
 * no FUSE: the layout is made by the real createLayout, the registration by the real (flock'ed)
 * registerVault, the "cipher" files are written by the test. Every swap keeps the replaced object
 * alive (renamed, never removed) so a freed inode number cannot be handed to the impostor.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  fstatSync,
  linkSync,
  utimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS module
const H: any = await import(pathToFileURL(join(REPO, "src", "secure", "bin", "helper.mjs")).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const T: any = await import(pathToFileURL(join(REPO, "src", "secure", "bin", "tree.mjs")).href);

function fstatId(fd: number) {
  const st = fstatSync(fd, { bigint: true });
  return { dev: String(st.dev), ino: String(st.ino) };
}
/** True while some process holds a flock on `file` (non-blocking probe through flock -n). */
function lockHeld(file: string): boolean {
  return spawnSync("flock", ["-n", "-E", "9", file, "true"]).status === 9;
}

const HAVE = process.platform === "linux" && spawnSync("sh", ["-c", "command -v flock mv"]).status === 0;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function world(name = "acme", { beforeRecord }: { beforeRecord?: (cipher: string) => void } = {}) {
  const r = mkdtempSync(join(tmpdir(), "pi-secure-initclean-"));
  roots.push(r);
  const home = join(r, "home");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
  const v = H.deriveVault(name, H.defaultVaultDir(name, home), H.defaultVaultMnt(name, home));
  const made = H.createLayout(v, { home, hold: true });
  const written = H.initWrittenEntry(v, false);
  H.registerVault(name, written, { home, expectAbsent: true });
  H.prepareInitCipher(v, made);
  for (const n of H.INIT_CIPHER_NAMES) writeFileSync(join(v.cipher, n), "{}", { mode: 0o400 });
  beforeRecord?.(v.cipher);
  H.recordInitCipher(v, made);
  const settings = () => JSON.parse(readFileSync(join(home, ".pi", "agent", "pi-subagent.json"), "utf8"));
  const run = (o: Record<string, unknown> = {}) =>
    H.removeInitVault(v, made, { written, home, probe: async () => "absent", leaseWaitS: 1, lockWaitS: 1, ...o });
  return { r, home, v, made, written, settings, run };
}

describe.skipIf(!HAVE)("init cleanup: removeInitVault", () => {
  it("createLayout records every object it creates; recordInitCipher keeps only gocryptfs.conf/diriv", () => {
    const w = world();
    expect(Object.keys(w.made).sort()).toEqual(
      [
        "cipher",
        "cipherFiles",
        "cipherT0",
        "dir",
        "dirFiles",
        "dirParent",
        "fds",
        "mnt",
        "mntFiles",
        "mntParent",
        "t0",
      ].sort(),
    );
    // the evidence is HELD: every recorded identity is the fstat of an open fd
    for (const k of ["dir", "cipher", "mnt", "dirParent", "mntParent"])
      expect(fstatId(w.made.fds[k]), k).toEqual(w.made[k]);
    for (const n of ["mount.lock", "mount.lease"]) expect(fstatId(w.made.fds.dirFiles[n])).toEqual(w.made.dirFiles[n]);
    expect(Object.keys(w.made.dirFiles).sort()).toEqual(["mount.lease", "mount.lock"]);
    expect(Object.keys(w.made.mntFiles).sort()).toEqual(["state", "work"]);
    expect(Object.keys(w.made.cipherFiles).sort()).toEqual(["gocryptfs.conf", "gocryptfs.diriv"]);
    expect(w.made.cipherProblem).toBeUndefined();
  });

  it("happy path: unclaimed, every recorded object removed, parents and other files untouched", async () => {
    const w = world();
    const siblings = join(dirname(w.v.dir), "other-vault");
    mkdirSync(siblings);
    const r = await w.run();
    expect(r.kept).toEqual([]);
    expect(r.unclaimed).toBe("deleted");
    expect(r.removed).toHaveLength(9);
    expect(w.made.fds).toBeUndefined(); // holds closed at the end
    expect(existsSync(w.v.dir)).toBe(false);
    expect(existsSync(w.v.mnt)).toBe(false);
    expect(w.settings().secure.vaults).toEqual({});
    expect(readdirSync(dirname(w.v.dir))).toEqual(["other-vault"]); // no tombstone left behind
    expect(readdirSync(dirname(w.v.mnt))).toEqual([]);
    expect(H.formatInitCleanup(w.v, r)).toEqual([
      "  已撤销登记 secure.vaults.acme",
      ...r.removed.map((p: string) => `  已删除：${p}`),
    ]);
    expect(r.removed).toEqual([
      ...H.INIT_CIPHER_NAMES.map((n: string) => join(w.v.cipher, n)),
      w.v.cipher,
      w.v.lock,
      w.v.lease,
      w.v.dir,
      join(w.v.mnt, "work"),
      join(w.v.mnt, "state"),
      w.v.mnt,
    ]);
  });

  it("an entry that existed before the claim is RESTORED, not deleted", async () => {
    const r0 = mkdtempSync(join(tmpdir(), "pi-secure-initclean-"));
    roots.push(r0);
    const home = join(r0, "home");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
    const before = { dir: "/nonexistent/old-dir", mnt: "/nonexistent/old-mnt" };
    H.registerVault("acme", before, { home, expectAbsent: true });
    const v = H.deriveVault("acme", H.defaultVaultDir("acme", home), H.defaultVaultMnt("acme", home));
    const made = H.createLayout(v, { home, hold: true });
    const written = H.initWrittenEntry(v, false);
    H.registerVault("acme", written, { home, expectEntry: before });
    H.prepareInitCipher(v, made);
    H.recordInitCipher(v, made);
    const r = await H.removeInitVault(v, made, { written, before, home, probe: async () => "absent" });
    expect(r.kept).toEqual([]);
    expect(r.unclaimed).toBe("restored");
    expect(H.formatInitCleanup(v, r)[0]).toBe("  已把 secure.vaults.acme 恢复为本次 init 之前的登记");
    expect(JSON.parse(readFileSync(join(home, ".pi", "agent", "pi-subagent.json"), "utf8")).secure.vaults.acme).toEqual(
      before,
    );
  });

  /** Nothing deleted, entry intact, and the given path reported with a reason matching `why`. */
  async function expectNothingTouched(w: ReturnType<typeof world>, path: string, why: RegExp, o = {}) {
    const r = await w.run(o);
    expect(r.removed).toEqual([]);
    expect(r.unclaimed).toBe("skipped");
    const k = r.kept.find((x: { path: string }) => x.path === path);
    expect(k, JSON.stringify(r.kept)).toBeDefined();
    expect(k.reason).toMatch(why);
    expect(w.settings().secure.vaults.acme).toEqual(w.written);
    expect(H.formatInitCleanup(w.v, r)).toContain(`  保留未动：${k.path}（${k.reason}）`);
    return r;
  }

  it("cipher holds an unexpected name ⇒ nothing is cleaned (only reported)", async () => {
    const w = world();
    writeFileSync(join(w.v.cipher, "extra"), "x");
    H.recordInitCipher(w.v, w.made);
    expect(w.made.cipherProblem).toMatch(/extra/);
    await expectNothingTouched(w, w.v.cipher, /无法证明是本次 gocryptfs -init 产物的条目：extra/);
    expect(readdirSync(w.v.cipher).sort()).toEqual(["extra", "gocryptfs.conf", "gocryptfs.diriv"]);
  });

  it("a file swapped after creation (the work sentinel) ⇒ nothing deleted, the impostor survives", async () => {
    const w = world();
    const work = join(w.v.mnt, "work");
    renameSync(work, join(w.r, "work.orig")); // keep the original inode alive, outside the vault
    writeFileSync(work, "", { mode: 0o400 });
    await expectNothingTouched(w, work, /原位置上已不是本次创建的对象/);
    expect(existsSync(work)).toBe(true);
  });

  it("the mount point's parent replaced by a symlink ⇒ nothing deleted", async () => {
    const w = world();
    const outside = join(w.r, "outside");
    mkdirSync(join(outside, "acme"), { recursive: true });
    writeFileSync(join(outside, "acme", "work"), "precious");
    renameSync(dirname(w.v.mnt), join(w.r, "secure-real"));
    symlinkSync(outside, dirname(w.v.mnt));
    await expectNothingTouched(w, w.v.mnt, /父目录路径 .* 已不指向本次持有的目录/);
    expect(readFileSync(join(outside, "acme", "work"), "utf8")).toBe("precious");
    expect(readdirSync(join(w.r, "secure-real", "acme")).sort()).toEqual(["state", "work"]);
  });

  it("an extra entry in the mount point (plaintext written while locked?) ⇒ nothing deleted", async () => {
    const w = world();
    writeFileSync(join(w.v.mnt, "stray"), "data");
    await expectNothingTouched(w, w.v.mnt, /非本次创建的条目：stray/);
  });

  it("still mounted (checked INSIDE the locks) ⇒ nothing deleted", async () => {
    const w = world();
    let probedUnderLock = false;
    await expectNothingTouched(w, w.v.mnt, /挂载状态不是 absent（mounted）/, {
      probe: async () => {
        probedUnderLock = lockHeld(w.v.lock) && lockHeld(w.v.lease);
        return "mounted";
      },
    });
    expect(probedUnderLock).toBe(true);
  });

  it("settings entry changed concurrently ⇒ CAS refuses, nothing deleted", async () => {
    const w = world();
    const file = join(w.home, ".pi", "agent", "pi-subagent.json");
    const s = w.settings();
    s.secure.vaults.acme = { ...w.written, private: true };
    writeFileSync(file, JSON.stringify(s));
    const r = await w.run();
    expect(r.unclaimed).toBe("mismatch");
    expect(r.removed).toEqual([]);
    expect(r.kept[0].reason).toMatch(/已不是本次 init 写入的内容/);
    expect(existsSync(w.v.dir) && existsSync(w.v.mnt)).toBe(true);
    expect(w.settings().secure.vaults.acme.private).toBe(true);
  });

  it("an object swapped AFTER the preflight (at the tombstone) is never unlinked: moved back, reported", async () => {
    const w = world();
    const held = join(w.r, "held-lock");
    const treeImpl = {
      ...T,
      renameNoReplace: async (a: { parent: string; from: string; to: string }) => {
        const res = await T.renameNoReplace(a);
        if (res.ok && a.from === "mount.lock") {
          renameSync(join(a.parent, a.to), held); // keep the original inode alive
          writeFileSync(join(a.parent, a.to), "impostor");
        }
        return res;
      },
    };
    const r = await w.run({ treeImpl });
    expect(r.unclaimed).toBe("deleted");
    const k = r.kept.find((x: { path: string }) => x.path === w.v.lock);
    expect(k.reason).toMatch(/墓碑身份与本次对象不符，已改回原名/);
    expect(readFileSync(w.v.lock, "utf8")).toBe("impostor"); // moved back, NOT deleted
    expect(r.kept.find((x: { path: string }) => x.path === w.v.dir).reason).toMatch(/目录非空，已改回原名/);
    expect(existsSync(w.v.mnt)).toBe(false); // the unrelated half still got cleaned
    expect(readdirSync(dirname(w.v.dir)).filter((n) => n.startsWith(".pi-secure-rm-"))).toEqual([]);
  });

  // ───────────── security review r1 regressions ─────────────

  it("r1 #1: another holder of mount.lock (or mount.lease) ⇒ nothing deleted, entry intact", async () => {
    for (const which of ["lock", "lease"] as const) {
      const w = world();
      const f = which === "lock" ? w.v.lock : w.v.lease;
      const holder = spawn("flock", [f, "sleep", "30"], { stdio: "ignore" });
      try {
        for (let i = 0; i < 100 && !lockHeld(f); i++) await new Promise((r) => setTimeout(r, 20));
        const r = await w.run();
        expect(r.removed).toEqual([]);
        expect(r.unclaimed).toBe("skipped");
        expect(r.kept[0].reason).toMatch(/被占用/);
        expect(w.settings().secure.vaults.acme).toEqual(w.written);
        expect(existsSync(join(w.v.cipher, "gocryptfs.conf"))).toBe(true);
      } finally {
        holder.kill("SIGKILL");
      }
    }
  }, 30_000);

  it("r1 #1: the lock is proven to be on THIS run's lock files (a swapped mount.lock ⇒ refused)", async () => {
    const w = world();
    renameSync(w.v.lock, `${w.v.lock}.orig`);
    writeFileSync(w.v.lock, "", { mode: 0o600 });
    const r = await w.run();
    expect(r.removed).toEqual([]);
    expect(r.kept[0].reason).toMatch(/加锁的文件不是本次创建的/);
  });

  it("r1 #3: the identities come from HELD fds — a directory removed and re-created at the same path never matches", async () => {
    const w = world();
    // remove the original mount point the "normal" way and re-create it with the same contents
    for (const n of ["work", "state"]) rmSync(join(w.v.mnt, n));
    rmdirSync(w.v.mnt);
    mkdirSync(w.v.mnt, { mode: 0o700 });
    for (const n of ["work", "state"]) writeFileSync(join(w.v.mnt, n), "", { mode: 0o400 });
    await expectNothingTouched(w, w.v.mnt, /原位置上已不是本次创建的对象/);
    expect(readdirSync(w.v.mnt).sort()).toEqual(["state", "work"]);
  });

  it("r1 #3: without the held evidence nothing is deleted at all", async () => {
    const w = world();
    const fds = w.made.fds;
    w.made.fds = undefined; // evidence lost (e.g. not created with hold)
    try {
      const r = await w.run();
      expect(r.removed).toEqual([]);
      expect(r.kept.some((k: { reason: string }) => /身份证据（持有的 fd）不在/.test(k.reason))).toBe(true);
    } finally {
      w.made.fds = fds;
      H.closeInitHolds(w.made);
    }
  });

  describe("r1 #2: cipher provenance", () => {
    it("a file already in cipher BEFORE -init ⇒ cipher not cleaned", async () => {
      const w = world();
      writeFileSync(join(w.v.cipher, "planted"), "x");
      H.prepareInitCipher(w.v, w.made);
      expect(w.made.cipherProblem).toMatch(/gocryptfs -init 之前 cipher 已非空：.*planted/);
      H.recordInitCipher(w.v, w.made);
      await expectNothingTouched(w, w.v.cipher, /之前 cipher 已非空/);
    });
    it.each([
      [
        "an old mtime (restored from a backup)",
        (f: string) => utimesSync(f, new Date(2020, 0, 1), new Date(2020, 0, 1)),
      ],
      ["a second hard link", (f: string) => linkSync(f, `${f}.second`)],
      [
        "an oversized file",
        (f: string) => (chmodSync(f, 0o600), writeFileSync(f, Buffer.alloc(H.INIT_CIPHER_MAX_BYTES + 1))),
      ],
    ])("gocryptfs.conf with %s ⇒ not provable ⇒ nothing cleaned", async (_what, mutate) => {
      const outside: string[] = [];
      const w = world("acme", {
        beforeRecord: (cipher) => {
          const conf = join(cipher, "gocryptfs.conf");
          mutate(conf);
          if (existsSync(`${conf}.second`)) {
            const elsewhere = join(dirname(dirname(dirname(cipher))), "second-link");
            renameSync(`${conf}.second`, elsewhere); // the extra link lives OUTSIDE the vault
            outside.push(elsewhere);
          }
        },
      });
      expect(w.made.cipherProblem).toMatch(/无法证明是本次 gocryptfs -init 产物的条目：gocryptfs.conf/);
      await expectNothingTouched(w, w.v.cipher, /gocryptfs.conf/);
      for (const o of outside) expect(existsSync(o)).toBe(true);
    });
  });

  it.each([
    [
      "non-empty (plaintext written into the sentinel)",
      (f: string) => (chmodSync(f, 0o600), writeFileSync(f, "secret"), chmodSync(f, 0o400)),
      /大小为 6 字节/,
    ],
    ["mode changed", (f: string) => chmodSync(f, 0o644), /权限为 644（创建时为 400）/],
    ["hard-linked elsewhere", (f: string) => linkSync(f, `${f}.second`), /链接数为 2/],
  ])("r1 #4: a sentinel that is %s ⇒ kept, nothing deleted", async (_what, mutate, why) => {
    const w = world();
    const work = join(w.v.mnt, "work");
    mutate(work);
    if (existsSync(`${work}.second`)) renameSync(`${work}.second`, join(w.r, "second-link")); // not a stray entry
    await expectNothingTouched(w, work, why);
  });

  it("r1 #5: renameNoReplace says 'unknown' although it DID move ⇒ found at the tombstone, deleted, nothing left", async () => {
    const w = world();
    const treeImpl = {
      ...T,
      renameNoReplace: async (a: { from: string }) => {
        const res = await T.renameNoReplace(a);
        return a.from === "mount.lease" && res.ok ? { ok: false, state: "unknown", reason: "post-lstat:EIO" } : res;
      },
    };
    const r = await w.run({ treeImpl });
    expect(r.kept).toEqual([]);
    expect(r.removed).toContain(w.v.lease);
    expect(existsSync(w.v.dir)).toBe(false);
  });

  it("r1 #5: a primitive that throws is contained: reported with its location, the rest still cleaned", async () => {
    const w = world();
    const treeImpl = {
      ...T,
      renameNoReplace: async (a: { from: string }) => {
        if (a.from === "work") throw new Error("boom");
        return T.renameNoReplace(a);
      },
    };
    const r = await w.run({ treeImpl });
    expect(r.unclaimed).toBe("deleted");
    const work = join(w.v.mnt, "work");
    expect(r.kept.find((k: { path: string }) => k.path === work).reason).toMatch(/boom.*原样保留/);
    expect(r.kept.find((k: { path: string }) => k.path === w.v.mnt).reason).toMatch(/目录非空/);
    expect(existsSync(w.v.dir)).toBe(false); // the other half is gone
    const out = H.formatInitCleanup(w.v, r);
    expect(out[0]).toBe("  已撤销登记 secure.vaults.acme");
    expect(out.at(-1)).toMatch(/登记已处理，但以上对象仍在：.*手工删除上列路径/);
  });

  it("r1 minor: the report reflects a skipped cleanup (no 'deleted' claim, registration untouched)", async () => {
    const w = world();
    writeFileSync(join(w.v.mnt, "stray"), "x");
    const r = await w.run();
    const out = H.formatInitCleanup(w.v, r);
    expect(out[0]).toBe("  登记未动：secure.vaults.acme");
    expect(out.some((l: string) => l.startsWith("  已删除"))).toBe(false);
    expect(out.at(-1)).toContain("清理（自行确认后执行）");
  });

  // ───────────── security review r2 regressions ─────────────

  it("r2 #3: the held evidence for every created file IS its O_EXCL creating fd (never a by-name re-open)", () => {
    const w = world();
    const flagsOf = (fd: number) =>
      parseInt(/^flags:\s+([0-7]+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))![1]!, 8);
    for (const fd of [...Object.values(w.made.fds.dirFiles), ...Object.values(w.made.fds.mntFiles)] as number[]) {
      const f = flagsOf(fd);
      expect(f & 0o10000000, "not an O_PATH re-open").toBe(0);
      expect(f & 0o3, "the O_WRONLY creating fd").toBe(1);
    }
    H.closeInitHolds(w.made);
  });

  /** Moves `work` to its tombstone for real, then lets `after(parent, tomb)` act before the checks. */
  const tombHook = (after: (parent: string, tomb: string) => void, backUnknown = false) => ({
    ...T,
    renameNoReplace: async (a: { parent: string; from: string; to: string }) => {
      const res = await T.renameNoReplace(a);
      if (res.ok && a.from === "work") after(a.parent, a.to);
      if (res.ok && backUnknown && a.to === "work") return { ok: false, state: "unknown", reason: "post-lstat:EIO" };
      return res;
    },
  });

  it("r2 #4: data written into a sentinel AFTER the preflight (same inode) is caught at the tombstone, never unlinked", async () => {
    const w = world();
    const work = join(w.v.mnt, "work");
    const r = await w.run({
      treeImpl: tombHook((parent, tomb) => {
        const t = join(parent, tomb);
        chmodSync(t, 0o600);
        writeFileSync(t, "late"); // same inode, written through the path like an ordinary writer
        chmodSync(t, 0o400);
      }),
    });
    const k = r.kept.find((x: { path: string }) => x.path === work);
    expect(k.reason).toMatch(/墓碑上的文件已不是创建时的形状（大小为 4 字节/);
    expect(k.reason).toMatch(/已改回原名/);
    expect(readFileSync(work, "utf8")).toBe("late");
  });

  it("r2 #5: a rename back that reports 'unknown' but DID happen is reported where it actually is", async () => {
    const w = world();
    const work = join(w.v.mnt, "work");
    const r = await w.run({
      treeImpl: tombHook((parent, tomb) => {
        const t = join(parent, tomb);
        chmodSync(t, 0o600);
        writeFileSync(t, "late");
      }, true),
    });
    const k = r.kept.find((x: { path: string }) => x.path === work);
    expect(k.reason.endsWith(`，已改回原名 ${work}`), k.reason).toBe(true); // not "留在 <墓碑>"
    expect(existsSync(work)).toBe(true);
    expect(readdirSync(w.v.mnt).filter((n) => n.startsWith(".pi-secure-rm-"))).toEqual([]);
  });

  it("r2 #5: coordinates come from the held parent fd's CURRENT path (parent renamed meanwhile)", async () => {
    const w = world();
    const moved = `${w.v.mnt}.moved`;
    const r = await w.run({
      treeImpl: tombHook((parent, tomb) => {
        const t = join(parent, tomb);
        chmodSync(t, 0o600);
        writeFileSync(t, "late");
        renameSync(w.v.mnt, moved); // the whole mount point dir moves away
      }),
    });
    const k = r.kept.find((x: { path: string }) => x.path === join(w.v.mnt, "work"));
    expect(k.reason).toMatch(
      new RegExp(`留在 ${moved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.pi-secure-rm-[0-9a-f]{8}`),
    );
    expect(k.reason).not.toContain(`${w.v.mnt}/.pi-secure-rm-`);
  });

  it("unclaimInitEntryUnlocked: missing file / missing entry / exact match only", () => {
    const w = world();
    expect(H.unclaimInitEntryUnlocked("acme", { ...w.written, private: true }, undefined, w.home).kind).toBe(
      "mismatch",
    );
    expect(H.unclaimInitEntryUnlocked("acme", w.written, undefined, w.home)).toEqual({ kind: "ok", action: "deleted" });
    expect(H.unclaimInitEntryUnlocked("acme", w.written, undefined, w.home)).toEqual({ kind: "missing" });
    expect(H.unclaimInitEntryUnlocked("acme", w.written, undefined, join(w.r, "nohome"))).toEqual({ kind: "missing" });
  });
});
