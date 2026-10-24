/**
 * V4 convert — forward flow, state file and `--resume` / `--abort` (convert-plan.md §1.4 / §1.5 /
 * §1.6 / §1.7 / §7.1 convert-state).
 *
 * Covers: the state-file format and persistence order; a full successful conversion (git repo,
 * sessions, memory) with every §1.7 output promise; the PI_SECURE_TEST_CONVERT_FAIL_AT seam at every
 * step boundary ⇒ complete rollback to the original directory (content AND modes); barrier failure;
 * a backup modified before step 12; the original path re-created before step 13 (76, keep state,
 * then --resume); SIGINT during the copy (130, rolled back); and the phase × actual-state decision
 * table for --resume / --abort built from real on-disk states (pending cleared ⇒ abort refused,
 * phase < synced ⇒ resume refused, an abort never touches backup content — only modes + one rename,
 * an occupied original path keeps the backup, a busy vault keeps the vault, foreign objects are never
 * deleted).
 *
 * All in private mktemp dirs with fake launcher ports (no FUSE). Never touches ~/secure or ~/.pi.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireGocryptfsTestLock } from "./gocryptfs-test-lock.js";
import {
  C,
  CONVERT_PATH,
  H,
  REPO,
  T,
  TREE_PATH,
  cleanupTmps,
  fixtureScanOccupants,
  git,
  gitInit,
  makeEnv,
  script,
  snapshot,
  wrappedTreeArgv,
} from "./convert-fixtures.js";

const HELPER_PATH = join(REPO, "src", "secure", "bin", "helper.mjs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS module
const S: any = await import(pathToFileURL(join(REPO, "src", "secure", "bin", "sessions.mjs")).href);

afterAll(cleanupTmps);

type E_ = ReturnType<typeof makeEnv>;
const TXID = "0123456789abcdef";
const idOf = (p: string) => {
  const st = lstatSync(p, { bigint: true });
  return { dev: String(st.dev), ino: String(st.ino) };
};
const backups = (E: E_) => readdirSync(E.home).filter((n) => n.includes("pi-secure-backup"));

/** `<name>.aborted-<txid>` siblings of the vault dir / mount point (r3.1 B3: set aside, never deleted). */
function abortedOf(E: E_) {
  const v = E.vault();
  const list = (p: string) => {
    const parent = join(p, "..");
    if (!existsSync(parent)) return [];
    const base = p.slice(p.lastIndexOf("/") + 1);
    return readdirSync(parent)
      .filter((n) => new RegExp(`^${base}\\.aborted-[0-9a-f]{16}$`).test(n))
      .map((n) => join(parent, n));
  };
  return { dir: list(v.dir), mnt: list(v.mnt) };
}

/**
 * The world is back to "never converted": source as before, no vault at its paths, no entry, no
 * state. `vault`: true ⇒ the vault was created, so it must sit (never deleted) under `.aborted-<txid>`.
 */
function expectRolledBack(E: E_, before: Record<string, unknown>, o: { vault?: boolean } = {}) {
  expect(lstatSync(E.src).isDirectory()).toBe(true);
  expect(snapshot(E.src)).toEqual(before);
  const v = E.vault();
  expect(existsSync(v.dir)).toBe(false);
  expect(existsSync(v.mnt)).toBe(false);
  if (o.vault) {
    const a = abortedOf(E);
    expect(a.dir.length).toBe(1);
    expect(existsSync(join(a.dir[0]!, "cipher", "gocryptfs.conf"))).toBe(true); // ciphertext kept for the user
    expect(E.out.join("\n")).toContain("内含本次拷贝的密文，核对后可自行删除");
  } else if (o.vault === false) expect(abortedOf(E)).toEqual({ dir: [], mnt: [] });
  expect(E.reg.size).toBe(0);
  expect(readdirSync(E.txnDir).filter((n) => n.startsWith("convert-"))).toEqual([]);
  expect(backups(E)).toEqual([]);
}

describe("§1.6 state file", () => {
  it("round-trips, validates strictly, persists atomically and lists interrupted conversions", () => {
    const E = makeEnv("st", { project: false });
    C.ensureTxnDir(E.txnDir);
    const s = {
      v: 1,
      txid: TXID,
      name: "acme",
      phase: "backed-up",
      origin: "/h/u/acme",
      originReal: "/h/u/acme",
      backup: "/h/u/acme.pi-secure-backup-20261024-010203-abcd",
      vault: { dir: "/h/u/.local/share/pi-toolkit-secure/acme", mnt: "/h/u/secure/acme" },
      ids: { originParent: { dev: "1", ino: "2" }, origin: { dev: "1", ino: "3" } },
    };
    C.writeState(E.txnDir, s);
    expect(C.readState(E.txnDir, "acme")).toMatchObject(s);
    expect(readdirSync(E.txnDir)).toEqual(["convert-acme.json"]); // no tmp leftovers
    expect(lstatSync(join(E.txnDir, "convert-acme.json")).mode & 0o777).toBe(0o600);
    expect(C.listInterruptedConverts(E.txnDir)).toEqual([{ name: "acme", phase: "backed-up", txid: TXID }]);
    expect(C.formatInterruptedLine({ name: "acme", phase: "synced" })).toBe(
      "convert acme: interrupted (synced) · --resume|--abort",
    );
    expect(C.readState(E.txnDir, "other")).toBeNull();
    const bad = [
      { ...s, txid: "xyz" },
      { ...s, phase: "deleting" },
      { ...s, backup: "/elsewhere/acme.bak" },
      { ...s, origin: "rel/path" },
      { ...s, ids: { originParent: { dev: "a", ino: "2" }, origin: s.ids.origin } },
      { ...s, v: 2 },
    ];
    for (const b of bad) expect(C.stateProblem(b, "acme"), JSON.stringify(b)).toBeTruthy();
    writeFileSync(join(E.txnDir, "convert-acme.json"), "not json");
    expect(() => C.readState(E.txnDir, "acme")).toThrow(expect.objectContaining({ exit: 78 }));
    expect(C.listInterruptedConverts(E.txnDir)).toEqual([{ name: "acme", phase: "invalid", txid: "" }]);
    chmodSync(E.txnDir, 0o770);
    expect(() => C.ensureTxnDir(E.txnDir)).toThrow(expect.objectContaining({ exit: 78 }));
  });
});

describe("§1.4 forward flow", () => {
  it("converts: backup read-only, link, vault copy verified, sessions/memory copied, commit, §1.7 output", async () => {
    const E = makeEnv("ok");
    gitInit(E.src);
    writeFileSync(join(E.src, "untracked.txt"), "u");
    const slug = `--${E.src.slice(1).replace(/[/\\:]/g, "-")}--`;
    const sdir = join(E.agentDir, "sessions", slug);
    mkdirSync(sdir, { recursive: true });
    const sessText = `${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-10-24T00:00:00Z", cwd: E.src })}\n{"type":"message"}\n`;
    writeFileSync(join(sdir, "s1.jsonl"), sessText);
    const mdir = join(E.agentDir, "memory", E.src.replace(/\//g, "-"));
    mkdirSync(mdir, { recursive: true });
    writeFileSync(join(mdir, "core.md"), "# mem\n");
    const before = snapshot(E.src);
    const head = git(E.src, "rev-parse", "HEAD").trim();
    const code = await E.run([E.src]);
    expect(E.err).toEqual([]);
    expect(code).toBe(0);
    const v = E.vault();
    const realWork = join(H.physicalPaths(v).realMnt, "work");
    // original path → link to <work>
    expect(lstatSync(E.src).isSymbolicLink()).toBe(true);
    expect(readlinkSync(E.src)).toBe(v.work);
    // backup: same content, write bits stripped
    const [bname] = backups(E);
    expect(bname).toMatch(/^proj\.pi-secure-backup-\d{8}-\d{6}-[0-9a-f]{4}$/);
    const bsnap = snapshot(join(E.home, bname!));
    const strip = (o: Record<string, any>) =>
      Object.fromEntries(Object.entries(o).map(([k, e]) => [k, { ...e, mode: undefined }]));
    expect(strip(bsnap)).toEqual(strip(before));
    for (const [rel, e] of Object.entries(bsnap) as [string, any][])
      if (e.type !== "l") expect(parseInt(e.mode, 8) & 0o222, rel).toBe(0);
    // vault copy: identical incl. modes (root and .pi/ excepted)
    const wsnap = snapshot(realWork) as Record<string, any>;
    const settings = JSON.parse(readFileSync(join(realWork, ".pi", "settings.json"), "utf8"));
    expect(settings.sessionDir).toBe(v.sessionDir);
    for (const k of Object.keys(wsnap)) if (k === "." || k === ".pi" || k.startsWith(".pi/")) delete wsnap[k];
    const bwant = { ...before } as Record<string, any>;
    delete bwant["."];
    expect(wsnap).toEqual(bwant);
    expect(git(realWork, "rev-parse", "HEAD").trim()).toBe(head);
    // sessions + memory copied, sources untouched
    const copied = readFileSync(join(H.physicalPaths(v).realMnt, "state", "sessions", "default", "s1.jsonl"), "utf8");
    expect(JSON.parse(copied.split("\n")[0]!).cwd).toBe(realWork);
    expect(readFileSync(join(sdir, "s1.jsonl"), "utf8")).toBe(sessText);
    expect(readdirSync(join(H.physicalPaths(v).realMnt, "state", "memory")).length).toBe(1);
    expect(readFileSync(join(mdir, "core.md"), "utf8")).toBe("# mem\n");
    // commit: pending cleared, origin + backup recorded; state files gone; mount through postMount:false
    expect(E.reg.get("proj")).toEqual({ dir: v.dir, mnt: v.mnt, origin: E.src, backup: join(E.home, bname!) });
    expect(readdirSync(E.txnDir)).toEqual([]);
    expect(E.calls).toContain("unlock postMount=false");
    const out = E.out.join("\n");
    expect(out).toContain(`原目录已改名为只读备份：${join(E.home, bname!)}`);
    expect(out).toContain(`chmod -R u+w -- '${join(E.home, bname!)}' && rm -rf -- '${join(E.home, bname!)}'`);
    expect(out).toContain("删除 ≠ 擦除");
    expect(out).toContain(join(sdir, "s1.jsonl")); // old session listed for manual deletion
    expect(out).toContain("需要重启");
  });

  const STEPS = [
    "0:after",
    "1:before",
    "1:after",
    "2:before",
    "2:after",
    "3:before",
    "3:after",
    "4:before",
    "4:after",
    "5:before",
    "5:after",
    "6:before",
    "6:after",
    "7:before",
    "7:after",
    "8:before",
    "8:after",
    "9:before",
    "9:after",
    "10:before",
    "10:after",
    "11:before",
    "11:after",
    "12:before",
    "12:after",
    "13:before",
    "13:after",
    "14:before",
  ];
  it.each(STEPS)("fail at %s ⇒ 74 and a complete rollback (content + modes)", async (at) => {
    const E = makeEnv(`f${at.replace(":", "")}`, { failAt: at });
    gitInit(E.src);
    const before = snapshot(E.src);
    const code = await E.run([E.src]);
    expect(code).toBe(74);
    expect(E.err.join("\n")).toContain("测试缝");
    if (at !== "0:after" && at !== "1:before") expect(E.out.join("\n")).toContain("已回滚");
    // the vault exists from step 2's createLayout on (2:after) — then it is set aside, never deleted
    expectRolledBack(E, before, { vault: STEPS.indexOf(at) >= STEPS.indexOf("2:after") });
  });

  it("fail right after the commit (14:after) still finishes as a success", async () => {
    const E = makeEnv("f14a", { failAt: "14:after" });
    expect(await E.run([E.src])).toBe(0);
    expect(lstatSync(E.src).isSymbolicLink()).toBe(true);
    expect(E.reg.get("proj").pending).toBeUndefined();
    expect(readdirSync(E.txnDir)).toEqual([]);
  });

  it("barrier failure (sync -f exits non-zero) ⇒ 74, rolled back", async () => {
    const E = makeEnv("bar");
    const before = snapshot(E.src);
    const badSync = script(E.bin, "sync", "exit 1");
    expect(
      await E.run([E.src], { bins: { mv: "mv", sync: badSync, getfattr: E.getfattr, flock: "flock", git: "git" } }),
    ).toBe(74);
    expect(E.err.join("\n")).toContain("持久化屏障");
    expectRolledBack(E, before, { vault: true });
  });

  it("backup modified before step 12 ⇒ 74, rolled back, the write survives in the restored original", async () => {
    const E = makeEnv("mod");
    const before = snapshot(E.src) as Record<string, any>;
    E.world.treeArgvOverride = (op) =>
      op === "compare-baseline"
        ? wrappedTreeArgv(
            E.base,
            op,
            `const f = path.join(B, "a.txt"); fs.chmodSync(f, 0o644); fs.appendFileSync(f, "LATE"); fs.chmodSync(f, 0o444);`,
          )
        : undefined;
    expect(await E.run([E.src])).toBe(74);
    expect(E.err.join("\n")).toContain("备份在转换期间被改动");
    expect(readFileSync(join(E.src, "a.txt"), "utf8")).toBe("hello\nLATE");
    const after = snapshot(E.src) as Record<string, any>;
    expect(after["a.txt"].mode).toBe(before["a.txt"].mode);
    expect({ ...after, "a.txt": 0, "src/hard": 0 }).toEqual({ ...before, "a.txt": 0, "src/hard": 0 });
    expect(E.reg.size).toBe(0);
    expect(existsSync(E.vault().dir)).toBe(false);
  });

  it("original path re-created before step 13 ⇒ 76, state kept (synced); after cleanup --resume completes", async () => {
    const E = makeEnv("occ13");
    E.world.treeArgvOverride = (op) =>
      op === "compare-baseline" ? wrappedTreeArgv(E.base, op, `fs.mkdirSync(${JSON.stringify(E.src)});`) : undefined;
    expect(await E.run([E.src])).toBe(76);
    expect(E.err.join("\n")).toContain("已被占用");
    expect(C.readState(E.txnDir, "proj").phase).toBe("synced");
    expect(E.reg.get("proj").pending).toMatch(/^convert:[0-9a-f]{16}$/);
    expect(backups(E).length).toBe(1);
    expect(readdirSync(E.src)).toEqual([]); // the squatter is untouched
    rmdirSync(E.src);
    E.world.treeArgvOverride = undefined;
    expect(await E.run(["--resume", "proj"])).toBe(0);
    expect(readlinkSync(E.src)).toBe(E.vault().work);
    expect(E.reg.get("proj").pending).toBeUndefined();
    expect(E.reg.get("proj").origin).toBe(E.src);
    expect(readdirSync(E.txnDir)).toEqual([]);
  });

  it("losing the name race at step 2 ⇒ 78; the winner's (even mounted) vault is never unmounted or deleted", async () => {
    const E = makeEnv("race");
    const before = snapshot(E.src);
    const v = E.vault();
    E.ports.registerVault = () => {
      E.ports.createLayout(v); // the concurrent winner
      writeFileSync(join(v.cipher, "winner"), "w");
      E.world.mounted = true;
      throw Object.assign(new Error("保险库 proj 已登记"), { code: 78 });
    };
    expect(await E.run([E.src])).toBe(78);
    expect(E.out.join("\n")).toContain("已回滚");
    expect(readFileSync(join(v.cipher, "winner"), "utf8")).toBe("w");
    expect(E.world.mounted).toBe(true);
    expect(E.calls).not.toContain("finalize");
    expect(snapshot(E.src)).toEqual(before);
    expect(readdirSync(E.txnDir)).toEqual([]);
  });

  it("SIGINT during the copy ⇒ 130, rolled back", async () => {
    const E = makeEnv("int");
    const before = snapshot(E.src);
    E.world.onOut = (l) => {
      if (l.startsWith("拷贝")) E.world.signals.emit("SIGINT");
    };
    expect(await E.run([E.src])).toBe(130);
    expect(E.out.join("\n")).toContain("已回滚");
    expectRolledBack(E, before, { vault: true });
  });
});

// ───────────────────────────── phase × actual state ─────────────────────────────

interface Built {
  state: any;
  v: any;
  backup: string;
  files: any;
}

async function build(
  E: E_,
  phase: string,
  o: { renamed?: boolean; frozen?: boolean; base?: boolean; linked?: boolean; mounted?: boolean } = {},
): Promise<Built> {
  const v = E.vault();
  const backup = join(E.home, "proj.pi-secure-backup-20261024-000000-abcd");
  const ids: any = { originParent: idOf(E.home), origin: idOf(E.src) };
  E.reg.set("proj", { dir: v.dir, mnt: v.mnt, pending: `convert:${TXID}` });
  E.ports.createLayout(v);
  await E.ports.initCipher(v);
  ids.vaultDir = idOf(v.dir);
  ids.mnt = idOf(v.mnt);
  ids.vaultParent = idOf(join(v.dir, ".."));
  ids.mntParent = idOf(join(v.mnt, ".."));
  ids.cipher = idOf(v.cipher);
  let evidence: any = {};
  const done = phase === "synced" || phase === "linked";
  if (o.mounted) {
    await E.ports.unlockVault(v, { postMount: false });
    H.ensureVaultDirs(v, { realMnt: H.physicalPaths(v).realMnt });
    writeFileSync(join(v.work, "copied.txt"), "copy");
    mkdirSync(join(v.work, ".pi"));
    writeFileSync(join(v.work, ".pi", "settings.json"), "{}\n");
    if (done)
      evidence = {
        copyVerified: { work: idOf(v.work), entries: 1 },
        settingsDone: { file: idOf(join(v.work, ".pi", "settings.json")) },
        sessionsDone: { skipped: false, sessions: 0, memory: 0, state: idOf(join(v.mnt, "state")) },
        barrierDone: { cipher: ids.cipher },
      };
  } else if (done)
    evidence = {
      copyVerified: { work: ids.mnt, entries: 1 },
      settingsDone: { file: ids.mnt },
      sessionsDone: { skipped: false, sessions: 0, memory: 0, state: ids.mnt },
      barrierDone: { cipher: ids.cipher },
    };
  C.ensureTxnDir(E.txnDir);
  const files = C.txnFiles(E.txnDir, "proj");
  if (o.renamed) renameSync(E.src, backup);
  let modesCount: number | undefined;
  if (o.frozen) {
    T.freezeTree(backup, files.modes, { expectRoot: ids.origin });
    modesCount = T.readModesFile(files.modes).records.length;
  }
  if (o.base) T.writeManifestFile(files.base, T.takeBaseline(backup));
  let link;
  if (o.linked) {
    symlinkSync(v.work, E.src);
    link = idOf(E.src);
  }
  const state = {
    v: 1,
    txid: TXID,
    name: "proj",
    phase,
    origin: E.src,
    originReal: E.src,
    backup,
    vault: { dir: v.dir, mnt: v.mnt },
    ids,
    ...(link ? { link } : {}),
    ...evidence,
    ...(o.frozen ? { freezeStarted: true, frozen: true, modesCount } : {}),
    layoutAttempted: true,
    opts: { noSessions: false, sessionsFrom: [], private: false },
    createdAt: new Date().toISOString(),
  };
  C.writeState(E.txnDir, state);
  E.calls.length = 0;
  return { state, v, backup, files };
}

describe("§1.6 --abort decision table", () => {
  it("claimed (nothing renamed) ⇒ new vault + entry removed, exit 1", async () => {
    const E = makeEnv("a1");
    const before = snapshot(E.src);
    await build(E, "claimed");
    expect(await E.run(["--abort", "proj"])).toBe(1);
    expect(E.out.join("\n")).toContain("已回滚");
    expectRolledBack(E, before, { vault: true });
  });

  it("renaming after the rename happened ⇒ renamed back (same inode)", async () => {
    const E = makeEnv("a2");
    const before = snapshot(E.src, true);
    const ino = lstatSync(E.src).ino;
    await build(E, "renaming", { renamed: true });
    expect(await E.run(["--abort", "proj"])).toBe(1);
    expect(lstatSync(E.src).ino).toBe(ino);
    expect(snapshot(E.src, true)).toEqual(before);
    expect(E.reg.size).toBe(0);
  });

  it("backed-up + frozen ⇒ modes restored and renamed back; backup content never touched (inode/mtime/bytes)", async () => {
    const E = makeEnv("a3");
    const before = snapshot(E.src, true);
    await build(E, "backed-up", { renamed: true, frozen: true });
    expect(await E.run(["--abort", "proj"])).toBe(1);
    expect(snapshot(E.src, true)).toEqual(before); // same inodes, contents, mtimes AND modes
    expect(E.calls.filter((c) => c.startsWith("remove"))).toEqual(["remove proj"]);
    expectRolledBack(E, snapshot(E.src), { vault: true });
  });

  it("synced but the original path is occupied ⇒ keep backup (never replaced), keep vault + state, exit 74", async () => {
    const E = makeEnv("a4");
    const b = await build(E, "synced", { renamed: true, frozen: true, base: true, mounted: true });
    mkdirSync(E.src);
    writeFileSync(join(E.src, "squatter"), "s");
    expect(await E.run(["--abort", "proj"])).toBe(74);
    expect(E.err.join("\n")).toContain("已被占用");
    expect(readFileSync(join(E.src, "squatter"), "utf8")).toBe("s");
    expect(existsSync(join(b.backup, "a.txt"))).toBe(true);
    expect(existsSync(b.v.dir)).toBe(true);
    expect(E.reg.get("proj").pending).toBe(`convert:${TXID}`);
    expect(C.readState(E.txnDir, "proj")).not.toBeNull();
  });

  it("linked (our link) ⇒ link removed, renamed back, vault set aside (copy inside kept)", async () => {
    const E = makeEnv("a5");
    const before = snapshot(E.src);
    await build(E, "linked", { renamed: true, frozen: true, base: true, linked: true, mounted: true });
    expect(await E.run(["--abort", "proj"])).toBe(1);
    expectRolledBack(E, before, { vault: true });
    const a = abortedOf(E);
    expect(readFileSync(join(a.mnt[0]!, "work", "copied.txt"), "utf8")).toBe("copy"); // fake mount = plain dir
    expect(readdirSync(E.home).filter((n) => n.startsWith(".pi-secure-unlink"))).toEqual([]);
  });

  it("a symlink that is not provably ours is never deleted ⇒ 74, backup kept", async () => {
    const E = makeEnv("a6");
    const b = await build(E, "linked", { renamed: true, frozen: true, base: true, linked: true });
    symlinkSync(b.v.work, `${E.src}.new`); // same target, different inode (ours still allocated)
    renameSync(`${E.src}.new`, E.src);
    expect(idOf(E.src)).not.toEqual(b.state.link);
    expect(await E.run(["--abort", "proj"])).toBe(74);
    expect(lstatSync(E.src).isSymbolicLink()).toBe(true);
    expect(existsSync(b.backup)).toBe(true);
  });

  it("pending cleared (committed) ⇒ abort refused; pending of another txid ⇒ refused", async () => {
    const E = makeEnv("a7");
    const b = await build(E, "linked", { renamed: true, frozen: true, base: true, linked: true });
    E.reg.set("proj", { dir: b.v.dir, mnt: b.v.mnt, origin: E.src, backup: b.backup });
    expect(await E.run(["--abort", "proj"])).toBe(76);
    expect(E.err.join("\n")).toContain("转换已完成，不能撤销");
    E.reg.set("proj", { dir: b.v.dir, mnt: b.v.mnt, pending: "convert:ffffffffffffffff" });
    expect(await E.run(["--abort", "proj"])).toBe(76);
    expect(readlinkSync(E.src)).toBe(b.v.work);
    expect(existsSync(b.backup)).toBe(true);
  });

  it("busy vault ⇒ source restored, vault kept, 74; a later --abort finishes", async () => {
    const E = makeEnv("a8");
    const before = snapshot(E.src);
    await build(E, "synced", { renamed: true, frozen: true, base: true, mounted: true });
    E.world.busy = true;
    expect(await E.run(["--abort", "proj"])).toBe(74);
    expect(E.err.join("\n")).toContain("新库仍挂载");
    expect(snapshot(E.src)).toEqual(before);
    expect(existsSync(E.vault().dir)).toBe(true);
    E.world.busy = false;
    expect(await E.run(["--abort", "proj"])).toBe(1);
    expectRolledBack(E, before, { vault: true });
  });

  it("vault dir replaced by a foreign one ⇒ never deleted, reported", async () => {
    const E = makeEnv("a9");
    const b = await build(E, "claimed");
    renameSync(b.v.dir, `${b.v.dir}.ours`);
    mkdirSync(b.v.dir);
    writeFileSync(join(b.v.dir, "foreign"), "f");
    expect(await E.run(["--abort", "proj"])).toBe(74);
    expect(E.err.join("\n")).toContain("身份与本次创建的不符");
    expect(readFileSync(join(b.v.dir, "foreign"), "utf8")).toBe("f");
  });

  it("crash inside createLayout (ids never recorded) ⇒ only a pure skeleton is moved aside", async () => {
    const E = makeEnv("a10");
    const b = await build(E, "claimed");
    const st = C.readState(E.txnDir, "proj");
    delete st.ids.vaultDir;
    delete st.ids.mnt;
    C.writeState(E.txnDir, st);
    unlinkSync(join(b.v.cipher, "gocryptfs.conf"));
    expect(await E.run(["--abort", "proj"])).toBe(1);
    expect(existsSync(b.v.dir)).toBe(false);
    expect(existsSync(b.v.mnt)).toBe(false);
    expect(abortedOf(E).dir.length).toBe(1);
    expect(abortedOf(E).mnt.length).toBe(1);
    // …but a skeleton with content inside is kept
    const E2 = makeEnv("a11");
    const b2 = await build(E2, "claimed");
    const st2 = C.readState(E2.txnDir, "proj");
    delete st2.ids.vaultDir;
    delete st2.ids.mnt;
    C.writeState(E2.txnDir, st2);
    expect(await E2.run(["--abort", "proj"])).toBe(74);
    expect(existsSync(join(b2.v.cipher, "gocryptfs.conf"))).toBe(true);
  });

  it("no interrupted conversion ⇒ 66", async () => {
    const E = makeEnv("a12");
    expect(await E.run(["--abort", "proj"])).toBe(66);
    expect(await E.run(["--resume", "proj"])).toBe(66);
  });
});

describe("§1.6 --resume decision table", () => {
  it.each(["claimed", "renaming", "backed-up"])("phase %s ⇒ refused (76), nothing changes", async (phase) => {
    const E = makeEnv(`r-${phase}`);
    const b = await build(E, phase, { renamed: phase !== "claimed", frozen: phase === "backed-up" });
    expect(await E.run(["--resume", "proj"])).toBe(76);
    expect(E.err.join("\n")).toContain("--abort");
    expect(E.reg.get("proj").pending).toBe(`convert:${TXID}`);
    expect(existsSync(E.src)).toBe(phase === "claimed");
    expect(C.readState(E.txnDir, "proj").phase).toBe(phase);
    void b;
  });

  it("synced ⇒ link + commit, no password, state cleaned", async () => {
    const E = makeEnv("r-synced");
    const b = await build(E, "synced", { renamed: true, frozen: true, base: true, mounted: true });
    expect(await E.run(["--resume", "proj"])).toBe(0);
    expect(readlinkSync(E.src)).toBe(b.v.work);
    expect(E.reg.get("proj")).toEqual({ dir: b.v.dir, mnt: b.v.mnt, origin: E.src, backup: b.backup });
    expect(E.calls.some((c) => c.startsWith("unlock") || c === "initCipher")).toBe(false);
    expect(readdirSync(E.txnDir)).toEqual([]);
  });

  it("synced but the backup changed since the baseline ⇒ refused (76), nothing linked", async () => {
    const E = makeEnv("r-mod");
    const b = await build(E, "synced", { renamed: true, frozen: true, base: true });
    await new Promise((r) => setTimeout(r, 40));
    chmodSync(join(b.backup, "a.txt"), 0o644);
    writeFileSync(join(b.backup, "a.txt"), "changed");
    expect(await E.run(["--resume", "proj"])).toBe(76);
    expect(existsSync(E.src)).toBe(false);
    expect(E.reg.get("proj").pending).toBe(`convert:${TXID}`);
  });

  it("linked and already committed ⇒ only the leftovers are cleaned", async () => {
    const E = makeEnv("r-done");
    const b = await build(E, "linked", { renamed: true, frozen: true, base: true, linked: true });
    E.reg.set("proj", { dir: b.v.dir, mnt: b.v.mnt, origin: E.src, backup: b.backup });
    expect(await E.run(["--resume", "proj"])).toBe(0);
    expect(readdirSync(E.txnDir)).toEqual([]);
    expect(E.calls.filter((c) => c.startsWith("patch"))).toEqual([]);
  });
});

// ───────────────────────────── r3.1 security review + acceptance ─────────────────────────────

const modeOf = (p: string) => lstatSync(p).mode & 0o7777;
const readStateRaw = (E: E_) => JSON.parse(readFileSync(join(E.txnDir, "convert-proj.json"), "utf8"));

describe("r3.1 B1: a tampered state file is never its own authorization", () => {
  /** Everything the abort/resume could touch, observed before; must be identical after. */
  function frozenWorld(E: E_, b: Built, extra: string[]) {
    return () => ({
      backup: snapshot(b.backup, true),
      vdir: existsSync(b.v.dir) ? snapshot(b.v.dir, true) : null,
      vmnt: existsSync(b.v.mnt) ? snapshot(b.v.mnt, true) : null,
      extra: extra.map((p) => snapshot(p, true)),
      reg: JSON.stringify([...E.reg]),
      state: readFileSync(join(E.txnDir, "convert-proj.json"), "utf8"),
      src: existsSync(E.src),
    });
  }
  const tamper = async (tag: string, edit: (st: any, b: Built, other: string) => void) => {
    const E = makeEnv(tag);
    const b = await build(E, "synced", { renamed: true, frozen: true, base: true, mounted: true });
    const other = join(E.home, "unrelated");
    mkdirSync(other);
    writeFileSync(join(other, "keep"), "k");
    const st = readStateRaw(E);
    edit(st, b, other);
    C.writeState(E.txnDir, st);
    const take = frozenWorld(E, b, [other]);
    const before = take();
    for (const mode of ["--abort", "--resume"]) {
      E.err.length = 0;
      expect(await E.run([mode, "proj"]), mode).toBe(78);
      expect(E.err.join("\n"), E.err.join("\n")).toMatch(/不符|不合法/);
      expect(take()).toEqual(before);
    }
    expect(E.calls.filter((c) => c !== "finalize")).toEqual([]);
    return E;
  };

  it("vault.mnt + ids.mnt pointed at an unrelated directory ⇒ refused, nothing touched", async () => {
    await tamper("t-mnt", (st, _b, other) => {
      st.vault.mnt = other;
      st.ids.mnt = idOf(other);
    });
  });

  it("backup pointed at an unrelated sibling (ids forged to match) ⇒ refused", async () => {
    await tamper("t-bak", (st, _b, other) => {
      st.backup = other;
      st.ids.origin = idOf(other);
    });
    await tamper("t-bak2", (st, _b, other) => {
      const fake = join(E_home(st), "notproj.pi-secure-backup-20261024-000000-abcd");
      mkdirSync(fake);
      st.backup = fake;
      st.ids.origin = idOf(fake);
      void other;
    });
  });

  it("vault.dir not the derived path ⇒ refused", async () => {
    await tamper("t-dir", (st, _b, other) => {
      st.vault.dir = other;
      st.ids.vaultDir = idOf(other);
    });
  });

  it("registry mnt differs from the state ⇒ refused", async () => {
    const E = makeEnv("t-reg2");
    const b = await build(E, "synced", { renamed: true, frozen: true, base: true, mounted: true });
    E.reg.set("proj", { dir: b.v.dir, mnt: join(E.home, "elsewhere"), pending: `convert:${TXID}` });
    const before = snapshot(b.backup, true);
    expect(await E.run(["--abort", "proj"])).toBe(78);
    expect(await E.run(["--resume", "proj"])).toBe(78);
    expect(snapshot(b.backup, true)).toEqual(before);
    expect(existsSync(b.v.dir)).toBe(true);
    expect(existsSync(E.src)).toBe(false);
  });

  it("origin outside $HOME rules / parent identity changed ⇒ refused", async () => {
    await tamper("t-orig", (st) => {
      st.origin = join(E_home(st), ".config", "proj");
      st.originReal = st.origin;
      st.backup = join(E_home(st), ".config", "proj.pi-secure-backup-20261024-000000-abcd");
    });
    await tamper("t-par", (st, _b, other) => {
      st.ids.originParent = idOf(other);
    });
  });
});
/** home of a state built by build(): dirname(origin). */
function E_home(st: any): string {
  return st.originReal.slice(0, st.originReal.lastIndexOf("/"));
}

describe("r3.1 B2: a persisted .modes record is validated before any restore", () => {
  it("rel validator rejects .., absolute, empty/./ components, NUL, non-normalized, too long/deep", () => {
    for (const bad of [
      "..",
      "a/../b",
      "/etc",
      "a//b",
      "./a",
      "a/.",
      "a/",
      "a\0b",
      "x".repeat(4097),
      Array(257).fill("a").join("/"),
      7,
    ])
      expect(C.modesRelProblem(bad), String(bad).slice(0, 20)).toBeTruthy();
    for (const ok of ["", "a", "a/b/c", ".hidden/x", "a..b"]) expect(C.modesRelProblem(ok)).toBeUndefined();
  });

  it('a record with rel ".." ⇒ the WHOLE restore is refused (fail closed): parent mode untouched, tree stays read-only, state kept, 74', async () => {
    const E = makeEnv("b2");
    const b = await build(E, "backed-up", { renamed: true, frozen: true });
    const m = T.readModesFile(b.files.modes);
    const rootRec = m.records.find((r: any) => r.rel === "");
    const evil = [...m.records, { ...rootRec, rel: "..", mode: 0o777 }];
    unlinkSync(b.files.modes);
    T.writeNdjsonExclusive(b.files.modes, { ...m.header, count: evil.length }, evil);
    const homeMode = modeOf(E.home);
    const aMode = modeOf(join(b.backup, "a.txt"));
    expect(await E.run(["--abort", "proj"])).toBe(74);
    expect(E.err.join("\n")).toContain("权限记录");
    expect(E.err.join("\n")).toContain("回滚不完整");
    expect(modeOf(E.home)).toBe(homeMode); // never chmod'ed outside the tree
    // data is home again (rename back), but its modes were NOT restored from the bad record
    expect(modeOf(join(E.src, "a.txt"))).toBe(aMode);
    expect(existsSync(b.files.modes)).toBe(true);
    expect(C.readState(E.txnDir, "proj")).not.toBeNull();
  });
});

describe("r3.1 B4: worker owner-death + leftover worker groups", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitFor = async (f: () => boolean, ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (f()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return f();
  };

  it("orchestrator SIGKILLed during the copy ⇒ the guarded worker group dies on its own; --abort then restores", async () => {
    const E = makeEnv("own");
    const before = snapshot(E.src);
    const regFile = join(E.base, "registry.json");
    const slowCopy = wrappedTreeArgv(E.base, "copy", "await new Promise((r) => setTimeout(r, 120000));");
    const harness = join(E.base, "harness.mjs");
    writeFileSync(
      harness,
      `
import fs from "node:fs";
import path from "node:path";
const C = await import(${JSON.stringify(pathToFileURL(CONVERT_PATH).href)});
const H = await import(${JSON.stringify(pathToFileURL(HELPER_PATH).href)});
const T = await import(${JSON.stringify(pathToFileURL(TREE_PATH).href)});
const home = ${JSON.stringify(E.home)}, agentDir = ${JSON.stringify(E.agentDir)}, regFile = ${JSON.stringify(regFile)};
const reg = new Map();
const save = () => fs.writeFileSync(regFile, JSON.stringify([...reg]));
const pre = await C.scanOccupants(["/nonexistent-pi-secure-root"]);
const preSet = new Set(pre.kind === "done" ? pre.unreadablePids.map((p) => p.pid) : []);
const ports = {
  registerVault: (name, entry, o) => { reg.set(name, { ...entry, pending: o.pending }); save(); },
  patchVaultEntry: () => ({ kind: "mismatch", reason: "harness" }),
  removeVaultEntry: () => ({ kind: "missing" }),
  getVaultEntry: (n) => reg.get(n),
  listVaults: () => [...reg].map(([name, e]) => ({ name, ...e })),
  deriveVault: H.deriveVault, defaultVaultDir: H.defaultVaultDir, defaultVaultMnt: H.defaultVaultMnt, physicalPaths: H.physicalPaths,
  createLayout: (v) => {
    fs.mkdirSync(path.join(v.dir, ".."), { recursive: true, mode: 0o700 });
    fs.mkdirSync(v.dir, { mode: 0o700 }); fs.mkdirSync(v.cipher, { mode: 0o700 });
    fs.mkdirSync(path.join(v.mnt, ".."), { recursive: true, mode: 0o700 }); fs.mkdirSync(v.mnt, { mode: 0o700 });
    for (const n of ["work", "state"]) fs.writeFileSync(path.join(v.mnt, n), "", { mode: 0o400 });
    fs.writeFileSync(v.lock, "", { mode: 0o600 }); fs.writeFileSync(v.lease, "", { mode: 0o600 });
  },
  initCipher: async (v) => { fs.writeFileSync(path.join(v.cipher, "gocryptfs.conf"), "{}\\n", { mode: 0o400 }); return 0; },
  unlockVault: async (v) => { for (const n of ["work", "state"]) fs.rmSync(path.join(v.mnt, n), { force: true }); return { how: "mounted-now", realMnt: H.physicalPaths(v).realMnt }; },
  ensureVaultDirs: H.ensureVaultDirs, syncProjectSettings: H.syncProjectSettings,
  probeMountState: async () => "mounted", finalizeBounded: async () => ({ code: 0, lines: [] }), leaseState: async () => "free",
  preflight: () => ({ ok: true, problems: [] }), isTty: () => true, prompt: async () => "proj",
  out: (l) => process.stdout.write(l + "\\n"), err: (l) => process.stderr.write(l + "\\n"),
};
const env = { ...process.env, HOME: home };
delete env.PI_CODING_AGENT_SESSION_DIR; delete env.PI_CODING_AGENT_DIR; delete env.ARMORY_MEMORY_ROOT; delete env.PI_SECURE_TEST_CONVERT_FAIL_AT;
const ctx = C.defaultConvertContext(env, {
  home, agentDir, memoryRoot: path.join(agentDir, "memory"),
  systemDirs: C.SYSTEM_DIRS.filter((d) => d !== "/tmp"),
  bins: { mv: "mv", sync: "sync", getfattr: ${JSON.stringify(E.getfattr)}, flock: "flock", git: "git" },
  treeArgv: (op) => (op === "copy" ? ${JSON.stringify(slowCopy)} : T.treeWorkerArgv(op)),
  scanOccupants: async (roots, o) => { const r = await C.scanOccupants(roots, o); if (r.kind !== "done") return r; const u = r.unreadablePids.filter((p) => !preSet.has(p.pid)); return { ...r, unreadablePids: u, unreadable: u.length }; },
});
process.exit(await C.cmdConvert([${JSON.stringify(E.src)}], { ports, ctx }));
`,
    );
    const child = spawn(process.execPath, [harness], { stdio: ["ignore", "pipe", "pipe"] });
    let outText = "";
    child.stdout.on("data", (d) => (outText += d));
    child.stderr.on("data", (d) => (outText += d));
    const stateFile = join(E.txnDir, "convert-proj.json");
    const gotWorker = await waitFor(() => {
      try {
        return JSON.parse(readFileSync(stateFile, "utf8")).worker?.op === "copy";
      } catch {
        return false;
      }
    }, 60_000);
    expect(gotWorker, outText).toBe(true);
    const w = JSON.parse(readFileSync(stateFile, "utf8")).worker;
    expect(alive(w.pid)).toBe(true);
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    // the owner guard notices the re-parenting and SIGKILLs the whole worker group by itself
    expect(await waitFor(() => T.groupMembers(w.pgid)?.length === 0, 5_000)).toBe(true);
    // the convert lock died with the orchestrator (stdin pipe); --abort proves the group gone first
    for (const [k, v] of JSON.parse(readFileSync(regFile, "utf8"))) E.reg.set(k, v);
    E.world.mounted = true;
    expect(await E.run(["--abort", "proj"])).toBe(1);
    expectRolledBack(E, before, { vault: true });
  }, 120_000);

  it("a recorded live worker group provably ours ⇒ --abort SIGKILLs it, then rolls back", async () => {
    const E = makeEnv("own2");
    const before = snapshot(E.src);
    await build(E, "backed-up", { renamed: true, frozen: true });
    // a leftover worker of THIS txid: started with PI_SECURE_TXID=<txid> like every real worker
    const k = spawn("sleep", ["60"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PI_SECURE_TXID: TXID },
    });
    await waitFor(() => T.readProcStart(k.pid!) !== undefined, 2_000);
    const st = readStateRaw(E);
    st.worker = { pid: k.pid, pgid: k.pid, start: T.readProcStart(k.pid!), op: "freeze" };
    C.writeState(E.txnDir, st);
    const exited = new Promise((r) => k.once("exit", r));
    expect(await E.run(["--abort", "proj"])).toBe(1);
    await exited;
    expect(k.signalCode).toBe("SIGKILL");
    expectRolledBack(E, before, { vault: true });
  });

  it("a recorded pid now led by ANOTHER process (pid reused) is never signalled; abort proceeds", async () => {
    const E = makeEnv("own3");
    await build(E, "claimed");
    const k = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    await waitFor(() => T.readProcStart(k.pid!) !== undefined, 2_000);
    const st = readStateRaw(E);
    st.worker = { pid: k.pid, pgid: k.pid, start: "1", op: "freeze" }; // not this leader's start time
    C.writeState(E.txnDir, st);
    expect(await E.run(["--abort", "proj"])).toBe(1);
    expect(alive(k.pid!)).toBe(true);
    k.kill("SIGKILL");
  });

  it("the group cannot be proven gone (/proc not enumerable) ⇒ 75, nothing touched", async () => {
    const E = makeEnv("own4");
    const b = await build(E, "backed-up", { renamed: true, frozen: true });
    const st = readStateRaw(E);
    st.worker = { pid: 999999, pgid: 999999, start: "5", op: "freeze" };
    C.writeState(E.txnDir, st);
    const snap = snapshot(b.backup, true);
    expect(await E.run(["--abort", "proj"], { procRoot: join(E.base, "no-proc") })).toBe(75);
    expect(await E.run(["--resume", "proj"], { procRoot: join(E.base, "no-proc") })).toBe(76); // phase gate first
    expect(snapshot(b.backup, true)).toEqual(snap);
    expect(E.reg.get("proj").pending).toBe(`convert:${TXID}`);
    expect(E.calls).toEqual([]);
  });
});

describe("r3.1 B3: the new vault is set aside, never deleted", () => {
  it("an EMPTY mount point created by this txid is rmdir'ed; the vault dir is renamed (NOREPLACE, never over an existing name)", async () => {
    const E = makeEnv("b3");
    const before = snapshot(E.src);
    const b = await build(E, "claimed");
    for (const n of ["work", "state"]) unlinkSync(join(b.v.mnt, n)); // as after a real mount + unmount
    const squat = C.abortedPath(b.v.dir, "ffffffffffffffff");
    mkdirSync(squat); // a leftover of ANOTHER txid is never touched
    expect(await E.run(["--abort", "proj"])).toBe(1);
    expect(E.out.join("\n")).toContain("已删除本次创建的空挂载点");
    expect(abortedOf(E).mnt).toEqual([]);
    expect(existsSync(C.abortedPath(b.v.dir, TXID))).toBe(true);
    expect(existsSync(squat)).toBe(true);
    expectRolledBack(E, before);
  });

  it("the aborted name already taken ⇒ never overwritten: vault kept, 74", async () => {
    const E = makeEnv("b3b");
    const b = await build(E, "claimed");
    mkdirSync(C.abortedPath(b.v.dir, TXID));
    writeFileSync(join(C.abortedPath(b.v.dir, TXID), "x"), "x");
    expect(await E.run(["--abort", "proj"])).toBe(74);
    expect(readFileSync(join(C.abortedPath(b.v.dir, TXID), "x"), "utf8")).toBe("x");
    expect(existsSync(join(b.v.cipher, "gocryptfs.conf"))).toBe(true);
    expect(C.readState(E.txnDir, "proj")).not.toBeNull();
  });
});

describe("r3.1 M5: --resume re-proves the vault and the copy evidence", () => {
  it("no copy evidence in the state ⇒ 76, nothing linked, pending kept", async () => {
    const E = makeEnv("m5a");
    await build(E, "synced", { renamed: true, frozen: true, base: true, mounted: true });
    const st = readStateRaw(E);
    delete st.copyVerified;
    C.writeState(E.txnDir, st);
    expect(await E.run(["--resume", "proj"])).toBe(76);
    expect(E.err.join("\n")).toContain("第 8 步（副本校验）");
    expect(existsSync(E.src)).toBe(false);
    expect(E.reg.get("proj").pending).toBe(`convert:${TXID}`);
  });

  it("vault dir / cipher replaced, or the mounted work is not the verified one ⇒ 76, nothing linked", async () => {
    const E = makeEnv("m5b");
    const b = await build(E, "synced", { renamed: true, frozen: true, base: true });
    renameSync(b.v.cipher, `${b.v.cipher}.old`);
    mkdirSync(b.v.cipher);
    writeFileSync(join(b.v.cipher, "gocryptfs.conf"), "{}");
    expect(await E.run(["--resume", "proj"])).toBe(76);
    expect(E.err.join("\n")).toContain("身份与创建时记录的不符");
    expect(existsSync(E.src)).toBe(false);
    const E2 = makeEnv("m5c");
    await build(E2, "synced", { renamed: true, frozen: true, base: true, mounted: true });
    const st = readStateRaw(E2);
    st.copyVerified.work = st.ids.mnt; // evidence for another work
    C.writeState(E2.txnDir, st);
    expect(await E2.run(["--resume", "proj"])).toBe(76);
    expect(E2.err.join("\n")).toContain("不是校验过的那一个");
    expect(existsSync(E2.src)).toBe(false);
    expect(E2.reg.get("proj").pending).toBe(`convert:${TXID}`);
  });
});

describe("r3.1 M9: rollback reports INCOMPLETE when modes cannot be restored", () => {
  it("frozen but .modes missing ⇒ data renamed home, 74 「回滚不完整」, state kept", async () => {
    const E = makeEnv("m9a");
    const b = await build(E, "backed-up", { renamed: true, frozen: true });
    unlinkSync(b.files.modes);
    expect(await E.run(["--abort", "proj"])).toBe(74);
    expect(E.err.join("\n")).toContain("权限记录");
    expect(E.err.join("\n")).toContain("回滚不完整");
    expect(lstatSync(E.src).isDirectory()).toBe(true);
    expect(C.readState(E.txnDir, "proj")).not.toBeNull();
    expect(E.out.join("\n")).not.toContain("已回滚：");
  });

  it("an entry replaced inside the frozen backup ⇒ skipped ⇒ 74 「回滚不完整」, .modes + state kept", async () => {
    const E = makeEnv("m9b");
    const b = await build(E, "backed-up", { renamed: true, frozen: true });
    const d = join(b.backup, "src", "deep");
    const dm = modeOf(d);
    chmodSync(d, 0o755);
    renameSync(join(d, "data.bin"), join(d, "data.old"));
    writeFileSync(join(d, "data.bin"), "replaced"); // same name, another inode
    chmodSync(join(d, "data.bin"), 0o444);
    unlinkSync(join(d, "data.old"));
    chmodSync(d, dm);
    expect(await E.run(["--abort", "proj"])).toBe(74);
    expect(E.err.join("\n")).toContain("未能恢复权限");
    expect(existsSync(b.files.modes)).toBe(true);
    expect(C.readState(E.txnDir, "proj")).not.toBeNull();
  });
});

describe("r3.1 M10: memory conflict / partial fails step 10", () => {
  it("a memory file conflicting in the vault ⇒ 74, never committed, rolled back", async () => {
    const E = makeEnv("m10");
    const mdir = join(E.agentDir, "memory", E.src.replace(/\//g, "-"));
    mkdirSync(mdir, { recursive: true });
    writeFileSync(join(mdir, "core.md"), "# mem\n");
    const before = snapshot(E.src);
    E.world.onOut = (l) => {
      if (!l.startsWith("拷贝")) return;
      const v = E.vault();
      const realMnt = H.physicalPaths(v).realMnt;
      const d = join(realMnt, "state", "memory", S.memorySlug(join(realMnt, "work")));
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "core.md"), "different\n");
    };
    expect(await E.run([E.src])).toBe(74);
    expect(E.err.join("\n")).toContain("memory 冲突");
    expect(E.calls.filter((c) => c.startsWith("patch"))).toEqual([]);
    expectRolledBack(E, before, { vault: true });
    expect(readFileSync(join(mdir, "core.md"), "utf8")).toBe("# mem\n");
  });
});

describe("acceptance: dedicated interruption cases", () => {
  it("step-13 orphan link (linking:true, no link id): --resume adopts and commits; --abort removes it", async () => {
    const E = makeEnv("v13r");
    const b = await build(E, "synced", { renamed: true, frozen: true, base: true, mounted: true });
    symlinkSync(b.v.work, E.src);
    const ino = lstatSync(E.src).ino;
    const st = readStateRaw(E);
    st.linking = true;
    C.writeState(E.txnDir, st);
    expect(await E.run(["--resume", "proj"])).toBe(0);
    expect(lstatSync(E.src).ino).toBe(ino);
    expect(E.reg.get("proj").pending).toBeUndefined();
    const E2 = makeEnv("v13a");
    const before = snapshot(E2.src);
    const b2 = await build(E2, "synced", { renamed: true, frozen: true, base: true, mounted: true });
    symlinkSync(b2.v.work, E2.src);
    const st2 = readStateRaw(E2);
    st2.linking = true;
    C.writeState(E2.txnDir, st2);
    expect(await E2.run(["--abort", "proj"])).toBe(1);
    expectRolledBack(E2, before, { vault: true });
  });

  it("--resume with the original path occupied ⇒ 76, squatter untouched, nothing committed, state kept", async () => {
    const E = makeEnv("vocc");
    await build(E, "synced", { renamed: true, frozen: true, base: true, mounted: true });
    mkdirSync(E.src);
    writeFileSync(join(E.src, "squatter"), "s");
    expect(await E.run(["--resume", "proj"])).toBe(76);
    expect(E.err.join("\n")).toContain("已被占用");
    expect(readFileSync(join(E.src, "squatter"), "utf8")).toBe("s");
    expect(E.reg.get("proj").pending).toBe(`convert:${TXID}`);
    expect(C.readState(E.txnDir, "proj").phase).toBe("synced");
  });

  it("--abort with only the state file (no registry entry, no layout) ⇒ exit 1, nothing else touched", async () => {
    const E = makeEnv("vonly");
    const before = snapshot(E.src, true);
    C.ensureTxnDir(E.txnDir);
    const v = E.vault();
    C.writeState(E.txnDir, {
      v: 1,
      txid: TXID,
      name: "proj",
      phase: "claimed",
      origin: E.src,
      originReal: E.src,
      backup: join(E.home, "proj.pi-secure-backup-20261024-000000-abcd"),
      vault: { dir: v.dir, mnt: v.mnt },
      ids: { originParent: idOf(E.home), origin: idOf(E.src) },
      opts: { noSessions: false, sessionsFrom: [], private: false },
    });
    expect(await E.run(["--abort", "proj"])).toBe(1);
    expect(snapshot(E.src, true)).toEqual(before);
    expect(readdirSync(E.txnDir)).toEqual([]);
    expect(E.calls.filter((c) => c !== "remove proj")).toEqual([]);
    expect(existsSync(v.dir)).toBe(false);
  });

  it("rename failure exit codes: unchanged ⇒ 65, identity mismatch ⇒ 76, unknown ⇒ 74", () => {
    expect(C.renameExit({ ok: false, state: "unchanged", reason: "target-exists" })).toBe(65);
    expect(C.renameExit({ ok: false, state: "unchanged", reason: "source-identity" })).toBe(76);
    expect(C.renameExit({ ok: false, state: "unchanged", reason: "parent-identity" })).toBe(76);
    expect(C.renameExit({ ok: false, state: "unknown", reason: "identity-mismatch" })).toBe(76);
    expect(C.renameExit({ ok: false, state: "unknown", reason: "mv-unclean" })).toBe(74);
  });
});

// ───────────────────────────── user ruling 2026-10-24: uninspectable processes ─────────────────────────────

describe("user ruling: uninspectable processes on --resume / --abort", () => {
  const A = { pid: 4_000_011, comm: "ghost-a", start: "111" };
  const B = { pid: 4_000_012, comm: "ghost-b", start: "222" };
  const ghosts = (list: any[]) => async (roots: string[], opts: any) => {
    const r = await fixtureScanOccupants(roots, opts);
    return r.kind !== "done"
      ? r
      : { ...r, unreadablePids: [...r.unreadablePids, ...list], unreadable: r.unreadable + list.length };
  };

  it("non-interactive --resume: no flag ⇒ 75 (hint names the flag), nothing linked; with the flag ⇒ completes", async () => {
    const E = makeEnv("u-res");
    const b = await build(E, "synced", { renamed: true, frozen: true, base: true, mounted: true });
    E.ports.isTty = () => false;
    expect(await E.run(["--resume", "proj"], { scanOccupants: ghosts([A]) })).toBe(75);
    expect(E.err.join("\n")).toContain("--assume-unreadable-idle");
    expect(E.err.join("\n")).toContain(`pid ${A.pid}  ghost-a`);
    expect(existsSync(E.src)).toBe(false);
    expect(E.reg.get("proj").pending).toBe(`convert:${TXID}`);
    expect(C.readState(E.txnDir, "proj").phase).toBe("synced");
    expect(await E.run(["--resume", "proj", "--assume-unreadable-idle"], { scanOccupants: ghosts([A]) })).toBe(0);
    expect(readlinkSync(E.src)).toBe(b.v.work);
    expect(E.err.join("\n")).toContain("按 --assume-unreadable-idle"); // non-interactive: full list on stderr
    expect(E.err.join("\n")).toContain(`pid ${A.pid}  ghost-a`);
  });

  it("--resume re-checks against the recorded confirmation: unchanged ⇒ no new confirmation; changed ⇒ asked for the new one only", async () => {
    const E = makeEnv("u-rec");
    await build(E, "synced", { renamed: true, frozen: true, base: true, mounted: true });
    const st = readStateRaw(E);
    st.unreadableAck = [{ ...A, at: "2026-10-24T03:00:00.000Z" }];
    C.writeState(E.txnDir, st);
    E.ports.isTty = () => false;
    expect(await E.run(["--resume", "proj"], { scanOccupants: ghosts([A]) })).toBe(0); // same identity, no flag needed
    const E2 = makeEnv("u-rec2");
    await build(E2, "synced", { renamed: true, frozen: true, base: true, mounted: true });
    const st2 = readStateRaw(E2);
    st2.unreadableAck = [{ ...A, at: "2026-10-24T03:00:00.000Z" }];
    C.writeState(E2.txnDir, st2);
    const asked: string[] = [];
    E2.ports.prompt = async (q: string) => {
      asked.push(E2.out.filter((l) => l.startsWith("  pid ")).join("\n"));
      return q.includes("继续") ? "y" : "";
    };
    expect(await E2.run(["--resume", "proj"], { scanOccupants: ghosts([A, B]) })).toBe(0);
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain(`pid ${B.pid}`);
    expect(asked[0]).not.toContain(`pid ${A.pid}`);
    // a restarted process (same pid, new start time) is NOT covered by the recorded confirmation
    const E3 = makeEnv("u-rec3");
    await build(E3, "synced", { renamed: true, frozen: true, base: true, mounted: true });
    const st3 = readStateRaw(E3);
    st3.unreadableAck = [{ ...A, at: "2026-10-24T03:00:00.000Z" }];
    C.writeState(E3.txnDir, st3);
    E3.ports.isTty = () => false;
    expect(await E3.run(["--resume", "proj"], { scanOccupants: ghosts([{ ...A, start: "999" }]) })).toBe(75);
    expect(existsSync(E3.src)).toBe(false);
  });

  it("non-interactive --abort: without the flag the new vault is kept (rollback incomplete, 74); with it ⇒ exit 1", async () => {
    const E = makeEnv("u-abt");
    const before = snapshot(E.src);
    await build(E, "backed-up", { renamed: true, frozen: true });
    E.ports.isTty = () => false;
    expect(await E.run(["--abort", "proj"], { scanOccupants: ghosts([A]) })).toBe(74);
    expect(E.err.join("\n")).toContain("回滚不完整");
    expect(E.err.join("\n")).toContain("--assume-unreadable-idle");
    expect(snapshot(E.src)).toEqual(before); // the source is home anyway
    expect(existsSync(E.vault().dir)).toBe(true);
    expect(await E.run(["--abort", "proj", "--assume-unreadable-idle"], { scanOccupants: ghosts([A]) })).toBe(1);
    expectRolledBack(E, before, { vault: true });
  });
});

// ───────────────────────────── security re-review round 2 ─────────────────────────────

describe("round 2 B1/B2: recovery waits for the recorded worker group; signals need the txid proof", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitFor = async (f: () => boolean, ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until && !f()) await new Promise((r) => setTimeout(r, 50));
    return f();
  };

  it("automatic rollback after a freeze worker that does not die: NO recovery step (modes untouched), 75, state + worker kept", async () => {
    const E = makeEnv("r2b1");
    const pidFile = join(E.base, "lingering.pid");
    // the freeze worker leaves a member in its group that carries NO txid (env -i) and stays alive;
    // the supervisor is made unable to prove the group empty (worker-only procRoot) ⇒ "unclean"
    E.world.treeArgvOverride = (op) =>
      op === "freeze"
        ? wrappedTreeArgv(
            E.base,
            op,
            `const { spawn } = await import("node:child_process"); const k = spawn("env", ["-i", "sleep", "60"], { stdio: "ignore" }); fs.writeFileSync(${JSON.stringify(pidFile)}, String(k.pid)); k.unref();`,
          )
        : undefined;
    let freezeNext = false;
    E.world.onOut = (l) => {
      if (l.startsWith("挂载新库")) freezeNext = true;
    };
    const budget = {
      killGraceMs: 200,
      abandonMs: 200,
      get procRoot() {
        return freezeNext ? join(E.base, "no-proc") : "/proc";
      },
    };
    const code = await E.run([E.src], { workerBudget: budget });
    const lingering = Number(readFileSync(pidFile, "utf8"));
    try {
      expect(code).toBe(75);
      expect(E.err.join("\n")).toContain("未做任何恢复");
      const st = C.readState(E.txnDir, "proj");
      expect(st.worker?.op).toBe("freeze");
      expect(alive(lingering)).toBe(true); // never signalled: no txid in its environ
      // nothing recovered: the frozen backup is still the backup and still read-only
      expect(existsSync(E.src)).toBe(false);
      const [bname] = backups(E);
      expect(modeOf(join(E.home, bname!, "a.txt")) & 0o222).toBe(0);
      expect(E.reg.get("proj").pending).toMatch(/^convert:/);
    } finally {
      process.kill(lingering, "SIGKILL");
    }
    // once it is gone, --abort completes
    await waitFor(() => !alive(lingering), 3_000);
    expect(await E.run(["--abort", "proj"])).toBe(1);
    expect(lstatSync(E.src).isDirectory()).toBe(true);
  }, 60_000);

  it("state.worker tampered to an UNRELATED real process group (correct start time) ⇒ zero signals, 75, nothing touched", async () => {
    const E = makeEnv("r2b2");
    const b = await build(E, "synced", { renamed: true, frozen: true, base: true, mounted: true });
    const k = spawn("sleep", ["60"], { detached: true, stdio: "ignore" }); // no PI_SECURE_TXID
    try {
      await waitFor(() => T.readProcStart(k.pid!) !== undefined, 2_000);
      const st = readStateRaw(E);
      st.worker = { pid: k.pid, pgid: k.pid, start: T.readProcStart(k.pid!), op: "freeze" };
      C.writeState(E.txnDir, st);
      const snap = snapshot(b.backup, true);
      for (const mode of ["--abort", "--resume"]) {
        E.err.length = 0;
        expect(await E.run([mode, "proj"]), mode).toBe(75);
        expect(E.err.join("\n")).toContain("无法证明属于本次转换");
        expect(alive(k.pid!)).toBe(true);
        expect(k.signalCode).toBeNull();
      }
      expect(snapshot(b.backup, true)).toEqual(snap);
      expect(existsSync(E.src)).toBe(false);
      expect(C.readState(E.txnDir, "proj").worker.pid).toBe(k.pid);
    } finally {
      k.kill("SIGKILL");
    }
  });

  it("proveGroupOurs: txid entry must be exact; another uid/start or a missing entry is never proof", async () => {
    const k = spawn("sleep", ["30"], {
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH, PI_SECURE_TXID: TXID },
    });
    const k2 = spawn("sleep", ["30"], {
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH, PI_SECURE_TXID: `${TXID}0` },
    });
    try {
      await waitFor(() => T.readProcStart(k.pid!) !== undefined && T.readProcStart(k2.pid!) !== undefined, 2_000);
      const start = T.readProcStart(k.pid!);
      expect(C.proveGroupOurs(k.pid, { txid: TXID, leaderStart: start }).ok).toBe(true);
      expect(C.proveGroupOurs(k.pid, { txid: "fedcba9876543210", leaderStart: start }).ok).toBe(false);
      expect(C.proveGroupOurs(k.pid, { txid: TXID, leaderStart: "1" }).ok).toBe(false);
      expect(C.proveGroupOurs(k.pid, { txid: TXID, uid: process.getuid()! + 1, leaderStart: start }).ok).toBe(false);
      expect(C.proveGroupOurs(k2.pid, { txid: TXID, leaderStart: T.readProcStart(k2.pid!) }).ok).toBe(false); // prefix ≠ exact
      expect(alive(k.pid!) && alive(k2.pid!)).toBe(true);
    } finally {
      k.kill("SIGKILL");
      k2.kill("SIGKILL");
    }
  });
});

describe("round 2 M3: a .modes record that does not match the frozen tree is incomplete", () => {
  it("rootId right but ZERO records ⇒ 74 回滚不完整, metadata kept; count differing from the frozen count ⇒ 74", async () => {
    for (const how of ["empty", "short"]) {
      const E = makeEnv(`r2m3-${how}`);
      const b = await build(E, "backed-up", { renamed: true, frozen: true });
      const m = T.readModesFile(b.files.modes);
      const recs = how === "empty" ? [] : m.records.slice(0, -1);
      unlinkSync(b.files.modes);
      T.writeNdjsonExclusive(b.files.modes, { ...m.header, count: recs.length }, recs);
      const aMode = modeOf(join(b.backup, "a.txt"));
      expect(await E.run(["--abort", "proj"]), how).toBe(74);
      expect(E.err.join("\n")).toContain(how === "empty" ? "记录为空" : "与冻结时记录的");
      expect(E.err.join("\n")).toContain("回滚不完整");
      expect(modeOf(join(E.src, "a.txt"))).toBe(aMode); // not restored from the bad record
      expect(existsSync(b.files.modes)).toBe(true);
      expect(C.readState(E.txnDir, "proj")).not.toBeNull();
    }
  });

  it("the forward flow records the frozen record count in the state", async () => {
    const E = makeEnv("r2m3c");
    let st: any;
    let recs = -1;
    E.world.onOut = (l) => {
      if (!l.startsWith("拷贝")) return;
      st = readStateRaw(E);
      recs = T.readModesFile(C.txnFiles(E.txnDir, "proj").modes).records.length;
    };
    expect(await E.run([E.src])).toBe(0);
    expect(recs).toBeGreaterThan(5);
    expect(st.modesCount).toBe(recs);
  });
});

describe("round 2 M4: --resume needs the evidence of steps 8, 9, 10 AND 11", () => {
  it.each(["settingsDone", "sessionsDone", "barrierDone", "copyVerified"])(
    "interrupted after step 8 with phase forged to synced (%s missing) ⇒ 76, nothing linked, pending kept",
    async (k) => {
      const E = makeEnv(`r2m4-${k}`);
      await build(E, "synced", { renamed: true, frozen: true, base: true, mounted: true });
      const st = readStateRaw(E);
      delete st[k];
      if (k === "settingsDone") {
        delete st.sessionsDone;
        delete st.barrierDone;
      }
      C.writeState(E.txnDir, st);
      expect(await E.run(["--resume", "proj"])).toBe(76);
      expect(E.err.join("\n")).toContain("缺少完成证据");
      expect(existsSync(E.src)).toBe(false);
      expect(E.reg.get("proj").pending).toBe(`convert:${TXID}`);
    },
  );

  it("evidence present but the settings file / state dir in the mounted vault is not the recorded one ⇒ 76", async () => {
    const E = makeEnv("r2m4b");
    const b = await build(E, "synced", { renamed: true, frozen: true, base: true, mounted: true });
    const f = join(b.v.work, ".pi", "settings.json");
    writeFileSync(`${f}.new`, "{}\n");
    renameSync(`${f}.new`, f);
    expect(await E.run(["--resume", "proj"])).toBe(76);
    expect(E.err.join("\n")).toContain("第 9 步写入的不是同一个");
    expect(existsSync(E.src)).toBe(false);
  });

  it("the forward flow persists all four evidences before synced", async () => {
    const E = makeEnv("r2m4c");
    const snapAt12 = join(E.base, "state-at-12.json");
    E.world.treeArgvOverride = (op) =>
      op === "compare-baseline"
        ? wrappedTreeArgv(
            E.base,
            op,
            `fs.copyFileSync(${JSON.stringify(join(E.txnDir, "convert-proj.json"))}, ${JSON.stringify(snapAt12)});`,
          )
        : undefined;
    expect(await E.run([E.src])).toBe(0);
    const st = JSON.parse(readFileSync(snapAt12, "utf8"));
    expect(st.phase).toBe("synced");
    for (const k of ["copyVerified", "settingsDone", "sessionsDone", "barrierDone"]) expect(st[k], k).toBeTruthy();
    expect(st.barrierDone.cipher).toEqual(st.ids.cipher);
  });
});

// ───────────────────────────── V7 review M2: stale evidence before the irreversible points ─────────────────────────────

describe("V7 review M2: a pause after the final backup re-verification voids its evidence", () => {
  /** A clock that advances 6 s per reading (every check sees the evidence as stale). */
  const jumpingClock = () => {
    let t = 0;
    return () => ({ mono: BigInt(++t) * 6_000_000_000n, wall: 1_800_000_000_000 + t * 6_000 });
  };
  const countCompare = (E: E_) => {
    const n = { compare: 0 };
    E.world.treeArgvOverride = (op: string) => {
      if (op === "compare-baseline") n.compare++;
      return undefined;
    };
    return n;
  };
  const touchBackup = (E: E_) => {
    const f = join(E.home, backups(E)[0]!, "a.txt");
    chmodSync(f, 0o644);
    writeFileSync(f, "changed during the pause");
  };

  it("pure helper: >5 s on EITHER clock, or a backwards wall jump, is stale; missing evidence is stale", () => {
    const s0 = { mono: 10_000_000_000n, wall: 1_000_000 };
    expect(C.STALE_EVIDENCE_MS).toBe(5_000);
    expect(C.evidenceStale(s0, { mono: s0.mono + 4_000_000_000n, wall: s0.wall + 4_000 })).toBe(false);
    expect(C.evidenceStale(s0, { mono: s0.mono + 5_001_000_000n, wall: s0.wall + 10 })).toBe(true); // Ctrl+Z / SIGSTOP
    expect(C.evidenceStale(s0, { mono: s0.mono + 10_000_000n, wall: s0.wall + 3_600_000 })).toBe(true); // suspend
    expect(C.evidenceStale(s0, { mono: s0.mono + 10_000_000n, wall: s0.wall - 2_000 })).toBe(true);
    expect(C.evidenceStale(undefined)).toBe(true);
  });

  it("forward flow, no pause: exactly ONE baseline comparison, no re-check notice", async () => {
    const E = makeEnv("m2-fresh");
    const n = countCompare(E);
    expect(await E.run([E.src])).toBe(0);
    expect(n.compare).toBe(1);
    expect(E.out.join("\n")).not.toContain("重新复核备份");
  });

  it("forward flow, stale but unchanged: re-verified before step 13 AND step 14, then success", async () => {
    const E = makeEnv("m2-stale-ok");
    const n = countCompare(E);
    expect(await E.run([E.src], { evidenceNow: jumpingClock() })).toBe(0);
    expect(n.compare).toBe(3);
    expect(E.out.filter((l) => l.includes("重新复核备份")).length).toBe(2);
    expect(lstatSync(E.src).isSymbolicLink()).toBe(true);
  });

  it.each([13, 14])(
    "forward flow, backup changed during a pause before step %i ⇒ rolled back (74), never success, the write survives",
    async (step) => {
      const E = makeEnv(`m2-chg-${step}`);
      let notices = 0;
      const say = (l: string) => {
        E.out.push(l);
        if (l.includes("重新复核备份") && ++notices === (step === 13 ? 1 : 2)) touchBackup(E);
      };
      expect(await E.run([E.src], { evidenceNow: jumpingClock(), say })).toBe(74);
      expect(E.err.join("\n")).toContain("备份在转换期间被改动");
      expect(E.out.join("\n")).toContain("已回滚");
      expect(E.out.join("\n")).not.toContain("完成：");
      expect(lstatSync(E.src).isDirectory()).toBe(true); // our link (step 14 case) was removed first
      expect(readFileSync(join(E.src, "a.txt"), "utf8")).toBe("changed during the pause");
      expect(E.reg.get("proj")).toBeUndefined();
    },
  );

  it.each([13, 14])(
    "--resume, backup changed during a pause before step %i ⇒ refused (76), no commit, --abort restores",
    async (step) => {
      const E = makeEnv(`m2-res-${step}`);
      await build(E, "synced", { renamed: true, frozen: true, base: true, mounted: true });
      let notices = 0;
      const say = (l: string) => {
        E.out.push(l);
        if (l.includes("重新复核备份") && ++notices === (step === 13 ? 1 : 2)) touchBackup(E);
      };
      expect(await E.run(["--resume", "proj"], { evidenceNow: jumpingClock(), say })).toBe(76);
      expect(E.err.join("\n")).toContain("备份在转换期间被改动");
      expect(E.reg.get("proj").pending).toBe(`convert:${TXID}`); // not committed
      expect(existsSync(E.src)).toBe(step === 14); // step 14: our link exists, state stays "linked"
      expect(C.readState(E.txnDir, "proj").phase).toBe(step === 14 ? "linked" : "synced");
      expect(await E.run(["--abort", "proj"])).toBe(1);
      expect(lstatSync(E.src).isDirectory()).toBe(true);
      expect(readFileSync(join(E.src, "a.txt"), "utf8")).toBe("changed during the pause");
    },
  );
});

// ───────────────────────────── real gocryptfs (fake password file, mktemp only) ─────────────────────────────

const which = (b: string) => spawnSync("sh", ["-c", `command -v ${b}`]).status === 0;
const FUSE_OK = process.platform === "linux" && ["gocryptfs", "fusermount3", "flock", "timeout"].every(which);

describe.skipIf(!FUSE_OK)("real gocryptfs mount (fake password file, mktemp only)", () => {
  let release: (() => void) | undefined;
  const mounts: string[] = [];
  beforeAll(async () => {
    release = await acquireGocryptfsTestLock(560_000);
  }, 600_000); // the cross-file gocryptfs test lock may be held by another real-mount suite
  afterAll(() => {
    for (const m of mounts) spawnSync("timeout", ["10", "fusermount3", "-u", m]);
    release?.();
  });

  /** Ports that drive REAL gocryptfs with a throw-away password file (no TTY). */
  function realPorts(E: E_) {
    const pf = join(E.base, "pass");
    writeFileSync(pf, "fake-test-password-not-secret\n", { mode: 0o600 });
    const mountedNow = (v: any) => {
      const mi = readFileSync("/proc/self/mountinfo", "utf8");
      return H.vaultMountState(mi, H.physicalPaths(v).realMnt, H.physicalPaths(v).realCipher);
    };
    Object.assign(E.ports, {
      initCipher: async (v: any) =>
        spawnSync("timeout", ["20", "gocryptfs", "-init", "-q", "-passfile", pf, "--", v.cipher]).status ?? 1,
      unlockVault: async (v: any) => {
        const r = spawnSync("timeout", ["20", "gocryptfs", "-q", "-nonempty", "-passfile", pf, "--", v.cipher, v.mnt]);
        if (r.status !== 0) throw Object.assign(new Error(`mount failed: ${r.stderr}`), { code: 1 });
        mounts.push(v.mnt);
        return { how: "mounted-now", realMnt: H.physicalPaths(v).realMnt };
      },
      probeMountState: async (v: any) => mountedNow(v),
      finalizeBounded: async (v: any) => {
        const r = spawnSync("timeout", ["10", "fusermount3", "-u", v.mnt]);
        return r.status === 0 ? { code: 0, lines: [`${v.name}：已卸载`] } : { code: 1, lines: [String(r.stderr)] };
      },
    });
  }

  it("converts for real: copy, read-back verify, git and barrier through FUSE; only ciphertext on disk", async () => {
    const E = makeEnv("fuse-ok");
    realPorts(E);
    gitInit(E.src);
    const before = snapshot(E.src);
    expect(await E.run([E.src])).toBe(0);
    const v = E.vault();
    expect(
      H.vaultMountState(
        readFileSync("/proc/self/mountinfo", "utf8"),
        H.physicalPaths(v).realMnt,
        H.physicalPaths(v).realCipher,
      ),
    ).toBe("absent");
    const names = readdirSync(v.cipher).filter((n) => !n.startsWith("gocryptfs."));
    expect(names.length).toBeGreaterThan(0); // encrypted names, never "a.txt"
    expect(names).not.toContain("a.txt");
    const [bname] = backups(E);
    const strip = (o: Record<string, any>) =>
      Object.fromEntries(Object.entries(o).map(([k, e]) => [k, { ...e, mode: undefined }]));
    expect(strip(snapshot(join(E.home, bname!)))).toEqual(strip(before));
  }, 120_000);

  it("fails at step 12 on a real mount ⇒ unmounted, vault set aside as .aborted-<txid>, original restored", async () => {
    const E = makeEnv("fuse-fail", { failAt: "12:before" });
    realPorts(E);
    const before = snapshot(E.src);
    expect(await E.run([E.src])).toBe(74);
    expectRolledBack(E, before, { vault: true });
    const a = abortedOf(E);
    expect(readdirSync(join(a.dir[0]!, "cipher")).filter((n) => !n.startsWith("gocryptfs.")).length).toBeGreaterThan(0);
  }, 120_000);
});
