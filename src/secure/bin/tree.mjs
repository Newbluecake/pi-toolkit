// pi-secure tree engine — package V2 of docs/dev/data-encryption/convert-plan.md (r3, §1.3 / §1.5 / §5),
// hardened after the V2 security review (V2-report.md §安全评审处置).
//
// Everything `pi-secure convert` (V4) needs to do to a directory tree, as pure-ish functions plus a
// supervised worker protocol:
//   • fd-anchored walk → manifest (every child is resolved through its PARENT's open directory fd via
//     /proc/self/fd/<dirfd>/<name>; never follows a symlink; per-directory mount-id check)
//   • the §1.3 content rules + mountinfo + xattr (getfattr on fd-anchored paths) and a second walk
//     that must equal the first (the checked manifest IS the baseline — nothing is re-baselined)
//   • parent directory rules incl. the filesystem-type whitelist; space estimate
//   • `mv -n -T` rename run INSIDE the parent's fd (cwd = /proc/<pid>/fd/<parentfd>) with an
//     after-the-fact identity judgement (XC8: mv exits 0 when it did not move anything)
//   • chmod read-only with a `.modes` record, and restore — only through inode-bound fds
//   • baseline comparison; copy into a destination bound by directory fds; fd-bound read-back verify
//   • persistence barrier on identity-checked fds: `sync -f /proc/<pid>/fd/<cipherfd>` (syncfs, XC9)
//   • worker protocol `node tree.mjs __tree-work <op>` + a supervisor that always reaps the whole
//     process group (stall watchdog 60 s: TERM → +2 s KILL → confirm the group is empty).
//
// Threat model (V2 review ruling): a TARGETED malicious same-uid process is out of scope; benign
// concurrent modification is excluded by the §1.3 occupancy check (V4). Independent of that, these
// invariants hold under ANY race and never rely on "nobody interferes":
//   I1 nothing here deletes an object it did not create in this call, and nothing deletes recursively
//   I2 plaintext is only ever created inside directories this call created under the destination fd
//   I3 no metadata/permission change ever follows a symlink (fd-bound fchmod/futimes, O_PATH magic link)
//   I4 verification and the barrier fail rather than report success on inconsistent objects
//   I5 every child process group is killed and confirmed empty before a supervised step returns
//
// Plain ESM, ZERO dependencies beyond Node ≥22 built-ins; deliberately does NOT import helper.mjs
// (helper will import this file in V6 — no cycle; the few shared helpers are re-implemented here).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { constants as fsc } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ───────────────────────────── constants ─────────────────────────────

const MiB = 1024 * 1024;

/** Budgets (convert-plan §5). Data-proportional steps are bounded only by the stall watchdog. */
export const TREE_BUDGET = Object.freeze({
  workerStallMs: 60_000,
  workerKillGraceMs: 2_000,
  workerAbandonMs: 1_000,
  renameMs: 10_000,
  syncMs: 60_000,
  getfattrBatchMs: 30_000,
  getfattrBatchArgBytes: 64 * 1024,
  getfattrMaxOutBytes: 16 * MiB,
  progressEveryEntries: 256,
  progressEveryBytes: 8 * MiB,
  maxInlineResultBytes: 64 * MiB,
  maxProblems: 200,
  listProblems: 20,
  maxDiffs: 200,
  maxDepth: 256,
  xattrBatchDirs: 64,
  groupPollMs: 50,
});

/** Suggested exit codes (convert-plan §6) attached to results; V4 decides. */
export const TREE_EXIT = Object.freeze({ CONTENT: 65, PREREQ: 69, IO: 74, DEADLINE: 75, BUSY: 76 });

/** Parent-directory filesystem whitelist (§1.3 父目录): RENAME_NOREPLACE is native on these. */
export const PARENT_FS_TYPES = Object.freeze(["ext4", "xfs", "btrfs", "f2fs", "tmpfs"]);
/** statfs(2) f_type magic numbers of the whitelist (ext2/3/4 share 0xEF53 — all served by the ext4 driver). */
export const FS_MAGIC = Object.freeze({
  ext4: 0xef53,
  xfs: 0x58465342,
  btrfs: 0x9123683e,
  f2fs: 0xf2f52010,
  tmpfs: 0x01021994,
});

export const SPACE_FACTOR = 1.1;
export const SPACE_SLACK_BYTES = 64 * MiB;
export const INODE_SLACK = 64;
/** gocryptfs 1.8 on-disk format (XC9 measured): 18-byte header, 32 bytes per 4096-byte block. */
export const GOCRYPTFS_HEADER = 18;
export const GOCRYPTFS_BLOCK = 4096;
export const GOCRYPTFS_BLOCK_OVERHEAD = 32;
/** Plaintext names longer than this become `gocryptfs.longname.*` + a `.name` side file. */
export const GOCRYPTFS_LONGNAME_BYTES = 175;
const FS_BLOCK = 4096;

const S_IFMT = 0o170000;
const TYPE_BY_FMT = new Map([
  [0o040000, "dir"],
  [0o100000, "file"],
  [0o120000, "symlink"],
  [0o010000, "fifo"],
  [0o140000, "socket"],
  [0o020000, "chardev"],
  [0o060000, "blockdev"],
]);

const MANIFEST_KIND = "pi-secure-tree-manifest";
const MODES_KIND = "pi-secure-tree-modes";
const HASHES_KIND = "pi-secure-tree-hashes";

/** Typed failure: `code` is a stable machine token, `exit` a suggested §6 exit code. */
export class TreeError extends Error {
  constructor(code, message, { exit = TREE_EXIT.IO, rel } = {}) {
    super(message);
    this.name = "TreeError";
    this.code = code;
    this.exit = exit;
    if (rel !== undefined) this.rel = rel;
  }
}

function asTreeError(e, fallbackCode = "io") {
  if (e instanceof TreeError) return e;
  const sys = e && typeof e.code === "string" ? e.code : undefined;
  const code = sys === "ENOSPC" || sys === "EDQUOT" ? "ENOSPC" : sys ? sys : fallbackCode;
  return new TreeError(code, String((e && e.message) || e), { exit: TREE_EXIT.IO });
}

// ───────────────────────────── small helpers ─────────────────────────────

export function pathWithin(p, root) {
  if (p === root) return true;
  const base = root.endsWith("/") ? root : `${root}/`;
  return p.startsWith(base);
}

function relJoin(parentRel, name) {
  return parentRel === "" ? name : `${parentRel}/${name}`;
}

function absOf(root, rel) {
  return rel === "" ? root : path.join(root, rel);
}

function depthOf(rel) {
  if (rel === "") return 0;
  let n = 1;
  for (let i = 0; i < rel.length; i++) if (rel.charCodeAt(i) === 47) n++;
  return n;
}

export function typeOfMode(mode) {
  return TYPE_BY_FMT.get(Number(mode) & S_IFMT) ?? "unknown";
}

function isValidUtf8(buf) {
  return Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
}

/** floor(ns / 1e6) for BigInt-capable decimal strings (also correct for pre-1970 times). */
export function msFloor(ns) {
  const n = BigInt(ns);
  const q = n / 1_000_000n;
  return n % 1_000_000n !== 0n && n < 0n ? q - 1n : q;
}

/** Seconds value that lands strictly inside millisecond `ms` (no double-rounding drift to ms−1). */
function secondsInsideMs(ms) {
  return (Number(ms) + 0.5) / 1000;
}

function sameId(a, b) {
  return a !== undefined && b !== undefined && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
}

function lstatBig(p) {
  return fs.lstatSync(p, { bigint: true });
}

function lstatBigOrNull(p) {
  try {
    return lstatBig(p);
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return null;
    throw e;
  }
}

function fsyncDirSync(dir) {
  const fd = fs.openSync(dir, fsc.O_RDONLY | fsc.O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Find `bin` on PATH (absolute paths are checked as-is). */
export function findOnPath(bin, envPath = process.env.PATH ?? "") {
  if (bin.includes("/")) {
    try {
      fs.accessSync(bin, fsc.X_OK);
      return bin;
    } catch {
      return undefined;
    }
  }
  for (const d of envPath.split(":")) {
    if (!d) continue;
    const p = path.join(d, bin);
    try {
      if (fs.statSync(p).isFile()) {
        fs.accessSync(p, fsc.X_OK);
        return p;
      }
    } catch {
      /* next */
    }
  }
  return undefined;
}

// ───────────────────────────── problems ─────────────────────────────

/**
 * Bounded problem collector: keeps the first `max` problems, counts every one by code.
 * Problem: {code, rel?, path?, detail?}. Codes (all exit 65 unless noted):
 *   owner group type special-bits unreadable ext-hardlink hardlinked-symlink escape-link
 *   name-encoding mount mount-uncertain xattr xattr-uncertain unstable too-deep
 *   changed-during-check parent-not-dir parent-owner parent-mode parent-not-writable fs-type
 *   space(74) inodes(74) prereq(69)
 */
export function createProblems(max = TREE_BUDGET.maxProblems) {
  const list = [];
  const counts = {};
  let total = 0;
  return {
    add(p) {
      total++;
      counts[p.code] = (counts[p.code] ?? 0) + 1;
      if (list.length < max) list.push(p);
    },
    addAll(ps) {
      for (const p of ps) this.add(p);
    },
    get total() {
      return total;
    },
    result() {
      return { problems: list.slice(), counts: { ...counts }, total, truncated: total > list.length };
    },
  };
}

const PROBLEM_TEXT = {
  owner: "属主不是本用户",
  group: "属组不是本用户主组",
  type: "特殊文件（FIFO / socket / 设备）",
  "special-bits": "带 setuid/setgid/sticky 位",
  unreadable: "不可读文件或不可进入的目录",
  "ext-hardlink": "与树外共享的硬链接",
  "hardlinked-symlink": "被硬链接的符号链接",
  "escape-link": "相对符号链接逃出根目录",
  "name-encoding": "名字或链接文本不是合法 UTF-8",
  mount: "树内或树根上有挂载点",
  xattr: "带扩展属性（xattr/ACL/capability）",
  "xattr-uncertain": "无法确认扩展属性（getfattr 出错）",
  "parent-not-dir": "父目录不是目录",
  "parent-owner": "父目录不归本用户所有",
  "parent-mode": "父目录组/其他用户可写",
  "parent-not-writable": "父目录本用户不可写",
  "fs-type": "父目录所在文件系统不在白名单（ext4/xfs/btrfs/f2fs/tmpfs）",
  unstable: "检查期间条目被替换或改动",
  "too-deep": "目录层级过深",
  "changed-during-check": "检查期间树发生了变化",
  "mount-uncertain": "无法确认挂载归属",
  space: "可用空间不足",
  inodes: "可用 inode 不足",
  prereq: "前置工具缺失",
};

/** Human lines (Chinese prose), at most `max` problem lines + a tail line. */
export function formatProblems(res, max = TREE_BUDGET.listProblems) {
  const lines = [];
  for (const p of res.problems.slice(0, max)) {
    const what = PROBLEM_TEXT[p.code] ?? p.code;
    const where = p.rel !== undefined ? (p.rel === "" ? "." : p.rel) : (p.path ?? "");
    lines.push(`  ${where}：${what}${p.detail ? `（${p.detail}）` : ""}`);
  }
  const rest = res.total - Math.min(max, res.problems.length);
  if (rest > 0) lines.push(`  …另有 ${rest} 条`);
  return lines;
}

/** Suggested exit code for a problem set (prereq ⇒ 69, space ⇒ 74, else 65); 0 when empty. */
export function problemsExit(res) {
  if (res.total === 0) return 0;
  if (res.counts.prereq) return TREE_EXIT.PREREQ;
  const content = Object.keys(res.counts).filter((c) => c !== "space" && c !== "inodes");
  if (content.length === 0) return TREE_EXIT.IO;
  return TREE_EXIT.CONTENT;
}

// ───────────────────────────── fd anchoring ─────────────────────────────

/** Linux O_PATH (Node does not export it). An O_PATH fd pins an inode without needing r/w access. */
const O_PATH = 0o10000000;
const DIR_READ = fsc.O_RDONLY | fsc.O_DIRECTORY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK;
const DIR_PIN = O_PATH | fsc.O_DIRECTORY | fsc.O_NOFOLLOW;
const ENTRY_PIN = O_PATH | fsc.O_NOFOLLOW;

/** `<name>` resolved inside the directory object behind `dirfd` (in THIS process). */
export function fdAt(dirfd, name) {
  return `/proc/self/fd/${dirfd}/${name}`;
}
/** The object behind `fd`, as a path a CHILD process can use (its own /proc/self differs). */
export function childFdPath(fd) {
  return `/proc/${process.pid}/fd/${fd}`;
}

function closeQuiet(fd) {
  if (fd === undefined) return;
  try {
    fs.closeSync(fd);
  } catch {
    /* already closed */
  }
}

function fstatBig(fd) {
  return fs.fstatSync(fd, { bigint: true });
}

function idOf(st) {
  return { dev: String(st.dev), ino: String(st.ino) };
}

/** mount id of the object behind `fd` (/proc/self/fdinfo); undefined when unreadable. */
export function mntIdOf(fd) {
  try {
    const m = /^mnt_id:\s*(\d+)$/m.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"));
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/** Open the directory `abs` (final component never followed); optional identity binding. */
function openRootDir(abs, flags, expect) {
  let fd;
  try {
    fd = fs.openSync(abs, flags);
    const st = fstatBig(fd);
    if (!st.isDirectory()) throw new TreeError("root-not-dir", `不是目录：${abs}`, { exit: TREE_EXIT.CONTENT });
    if (expect && !sameId(st, expect)) throw new TreeError("identity", `根目录不是预期的那个：${abs}`);
    return fd;
  } catch (e) {
    closeQuiet(fd);
    if (e && (e.code === "ELOOP" || e.code === "ENOTDIR"))
      throw new TreeError("root-not-dir", `不是目录（或是符号链接）：${abs}`, { exit: TREE_EXIT.CONTENT });
    throw e;
  }
}

/** Open `<dirfd>/<name>` with `flags` and require its identity to be `expect` (and a directory when asked). */
function openAtExpect(dirfd, name, flags, expect, { dir = false } = {}) {
  const fd = fs.openSync(fdAt(dirfd, name), flags);
  try {
    const st = fstatBig(fd);
    if ((dir && !st.isDirectory()) || (expect && !sameId(st, expect)))
      throw new TreeError("identity", `条目已被替换：${name}`);
    return { fd, st };
  } catch (e) {
    closeQuiet(fd);
    throw e;
  }
}

/** Names in the directory behind `fd` (raw bytes), sorted by bytes. Needs r on the directory. */
function listDirFd(fd) {
  return fs.readdirSync(`/proc/self/fd/${fd}`, { encoding: "buffer" }).sort(Buffer.compare);
}

function splitRel(rel) {
  const i = rel.lastIndexOf("/");
  return i < 0 ? { parent: "", name: rel } : { parent: rel.slice(0, i), name: rel.slice(i + 1) };
}

/**
 * Pin the directory at `rel` below `rootFd` by walking component by component (O_PATH|O_DIRECTORY|
 * O_NOFOLLOW), each one required to be the identity `ids.get(prefix)`. → fd (caller closes; for
 * rel "" a NEW pin of the root). Throws TreeError("identity") on the first mismatch.
 */
function pinDirChain(rootFd, rel, ids) {
  // the magic link itself must be followed here (it IS the pinned root) — no O_NOFOLLOW
  let cur = fs.openSync(`/proc/self/fd/${rootFd}`, O_PATH | fsc.O_DIRECTORY);
  if (rel === "") return cur;
  let prefix = "";
  try {
    for (const comp of rel.split("/")) {
      prefix = prefix === "" ? comp : `${prefix}/${comp}`;
      const want = ids.get(prefix);
      if (!want) throw new TreeError("identity", `清单里没有目录：${prefix}`);
      const { fd } = openAtExpect(cur, comp, DIR_PIN, want, { dir: true });
      closeQuiet(cur);
      cur = fd;
    }
    return cur;
  } catch (e) {
    closeQuiet(cur);
    throw e;
  }
}

/** chmod the inode behind an fd: fchmod, or (O_PATH fd ⇒ EBADF) chmod of its /proc magic link —
 *  both bound to the inode, never to a pathname. Re-reads the mode to confirm. */
function chmodFd(fd, mode) {
  try {
    fs.fchmodSync(fd, mode);
  } catch (e) {
    if (e.code !== "EBADF") throw e;
    fs.chmodSync(`/proc/self/fd/${fd}`, mode); // magic link → the pinned inode itself
  }
  const now = Number(fstatBig(fd).mode) & 0o7777;
  if (now !== mode) throw new TreeError("chmod", `mode 未生效（${now.toString(8)} ≠ ${mode.toString(8)}）`);
}

// ───────────────────────────── walk / manifest ─────────────────────────────

function entryFromStat(rel, st) {
  const mode = Number(st.mode);
  return {
    rel,
    type: typeOfMode(mode),
    mode: mode & 0o7777,
    uid: Number(st.uid),
    gid: Number(st.gid),
    size: Number(st.size),
    nlink: Number(st.nlink),
    dev: String(st.dev),
    ino: String(st.ino),
    mtimeNs: String(st.mtimeNs),
    ctimeNs: String(st.ctimeNs),
    atimeNs: String(st.atimeNs),
  };
}

/**
 * Version equality of two bigint stats (or manifest entries): dev, ino, size, mode and the
 * NANOSECOND-precision mtimeNs/ctimeNs strings — never the millisecond `mtimeMs` doubles.
 */
function sameVersion(a, b) {
  return (
    sameId(a, b) &&
    String(a.size) === String(b.size) &&
    Number(a.mode) === Number(b.mode) &&
    String(a.mtimeNs) === String(b.mtimeNs) &&
    String(a.ctimeNs) === String(b.ctimeNs)
  );
}

/**
 * fd-anchored walk of `root` (absolute; final component never followed). Pre-order, children
 * sorted by raw name bytes. Every child is lstat'ed / readlink'ed through its parent's open
 * directory fd (`/proc/self/fd/<dirfd>/<name>`) — a renamed/replaced intermediate directory can
 * never redirect the walk; a subdirectory is opened O_NOFOLLOW from its parent fd and must be the
 * inode the lstat saw. Directories on another mount (fdinfo mnt_id ≠ root's) are recorded but not
 * entered (`mount`); depth > maxDepth ⇒ `too-deep`; a symlink that changes between lstat and
 * readlink ⇒ `unstable`. At most `depth` directory fds are open at a time.
 * → {v:1, root, rootId, rootMntId, entries:[Entry], walkProblems}
 */
export function walkTree(root, { onProgress, expectRoot, maxDepth = TREE_BUDGET.maxDepth, _hooks } = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root))
    throw new TreeError("root-relative", `根目录必须是绝对路径：${root}`);
  const rootFd = openRootDir(root, DIR_READ, expectRoot);
  const frames = [];
  try {
    const rst = fstatBig(rootFd);
    const rootMntId = mntIdOf(rootFd);
    const walkProblems = [];
    if (rootMntId === undefined) walkProblems.push({ code: "mount-uncertain", rel: "" });
    const entries = [entryFromStat("", rst)];
    frames.push({ fd: rootFd, rel: "", names: listDirFd(rootFd), i: 0, depth: 0 });
    _hooks?.afterList?.("");
    let n = 1;
    while (frames.length > 0) {
      const top = frames[frames.length - 1];
      if (top.i >= top.names.length) {
        frames.pop();
        if (top.fd !== rootFd) closeQuiet(top.fd);
        continue;
      }
      const nb = top.names[top.i++];
      if (!isValidUtf8(nb)) {
        walkProblems.push({ code: "name-encoding", rel: relJoin(top.rel, nb.toString("utf8")), detail: "文件名" });
        continue;
      }
      const name = nb.toString("utf8");
      const rel = relJoin(top.rel, name);
      let st;
      try {
        st = lstatBig(fdAt(top.fd, name));
      } catch (err) {
        walkProblems.push({ code: "unstable", rel, detail: String(err.code ?? err.message) });
        continue;
      }
      const e = entryFromStat(rel, st);
      if (e.type === "symlink") {
        try {
          const buf = fs.readlinkSync(fdAt(top.fd, name), { encoding: "buffer" });
          const st2 = lstatBig(fdAt(top.fd, name));
          if (!sameVersion(st, st2)) walkProblems.push({ code: "unstable", rel, detail: "readlink" });
          if (!isValidUtf8(buf)) walkProblems.push({ code: "name-encoding", rel, detail: "链接文本" });
          e.target = buf.toString("utf8");
        } catch (err) {
          walkProblems.push({ code: "unstable", rel, detail: String(err.code ?? err.message) });
          continue;
        }
      }
      entries.push(e);
      if (++n % TREE_BUDGET.progressEveryEntries === 0) onProgress?.({ units: n });
      if (e.type !== "dir") continue;
      if (top.depth + 1 > maxDepth) {
        walkProblems.push({ code: "too-deep", rel, detail: `> ${maxDepth}` });
        continue;
      }
      let dfd;
      try {
        dfd = openAtExpect(top.fd, name, DIR_READ, st, { dir: true }).fd;
      } catch (err) {
        const code =
          err instanceof TreeError || err.code === "ELOOP" || err.code === "ENOTDIR" ? "unstable" : "unreadable";
        walkProblems.push({ code, rel, detail: String(err.code ?? err.message) });
        continue;
      }
      const mnt = mntIdOf(dfd);
      if (mnt === undefined || mnt !== rootMntId) {
        closeQuiet(dfd);
        walkProblems.push({
          code: mnt === undefined ? "mount-uncertain" : "mount",
          rel,
          detail: `mnt_id ${mnt ?? "?"}`,
        });
        continue;
      }
      let names;
      try {
        names = listDirFd(dfd);
      } catch (err) {
        closeQuiet(dfd);
        walkProblems.push({ code: "unreadable", rel, detail: String(err.code ?? err.message) });
        continue;
      }
      frames.push({ fd: dfd, rel, names, i: 0, depth: top.depth + 1 });
      _hooks?.afterList?.(rel);
    }
    onProgress?.({ units: n });
    return { v: 1, root, rootId: idOf(rst), rootMntId, entries, walkProblems };
  } finally {
    for (const f of frames) if (f.fd !== rootFd) closeQuiet(f.fd);
    closeQuiet(rootFd);
  }
}

/** parent rel → child entries (manifest order). */
function childrenMap(m) {
  const kids = new Map();
  for (const e of m.entries) {
    if (e.rel === "") continue;
    const { parent } = splitRel(e.rel);
    let arr = kids.get(parent);
    if (!arr) kids.set(parent, (arr = []));
    arr.push(e);
  }
  return kids;
}

function dirIdsOf(m) {
  const ids = new Map();
  for (const e of m.entries) if (e.type === "dir") ids.set(e.rel, { dev: e.dev, ino: e.ino });
  return ids;
}

export function manifestSummary(m) {
  const s = { entries: m.entries.length, dirs: 0, files: 0, symlinks: 0, other: 0, bytes: 0, hardlinkExtra: 0 };
  const seen = new Set();
  for (const e of m.entries) {
    if (e.type === "dir") s.dirs++;
    else if (e.type === "symlink") s.symlinks++;
    else if (e.type === "file") {
      s.files++;
      const k = `${e.dev}:${e.ino}`;
      if (seen.has(k)) s.hardlinkExtra++;
      else {
        seen.add(k);
        s.bytes += e.size;
      }
    } else s.other++;
  }
  return s;
}

/** rel of every `.git` entry (file or dir) — V4 runs the §1.3.1 git rules on these. */
export function gitEntries(m) {
  return m.entries
    .filter((e) => e.rel === ".git" || e.rel.endsWith("/.git"))
    .map((e) => ({ rel: e.rel, type: e.type }));
}

// ───────────────────────────── content rules (§1.3) ─────────────────────────────

/**
 * Lexical classification of a symlink at `rel` (relative to the tree root) — the link is NEVER
 * followed. → "rel-internal" | "escape" | "abs-internal" | "abs-external" | "invalid"
 * `linkRoots`: absolute spellings of the tree's ORIGINAL location (literal + realpath) — an
 * absolute target under one of them stays inside after conversion (origin → work symlink).
 */
export function classifyLink(rel, target, linkRoots = []) {
  if (typeof target !== "string" || target === "" || target.includes("\0")) return "invalid";
  if (target.startsWith("/")) {
    const t = path.posix.normalize(target);
    return linkRoots.some((r) => pathWithin(t, path.posix.normalize(r))) ? "abs-internal" : "abs-external";
  }
  const base = path.posix.dirname(rel);
  const joined = path.posix.normalize(path.posix.join(base, target));
  if (joined === ".." || joined.startsWith("../")) return "escape";
  return "rel-internal";
}

/**
 * The per-entry §1.3 rules over a manifest. → {problems, counts, total, truncated, warnings}
 * `uid`/`gid`: the user and their PRIMARY group (injectable for tests).
 */
export function checkTreeRules(m, { uid = process.getuid(), gid = process.getgid(), linkRoots = [] } = {}) {
  const P = createProblems();
  P.addAll(m.walkProblems ?? []);
  const warnings = [];
  const inTree = new Map();
  for (const e of m.entries) {
    if (e.type === "file" || e.type === "symlink") {
      const k = `${e.dev}:${e.ino}`;
      inTree.set(k, (inTree.get(k) ?? 0) + 1);
    }
  }
  for (const e of m.entries) {
    if (e.uid !== uid) P.add({ code: "owner", rel: e.rel, detail: `uid ${e.uid}` });
    if (e.gid !== gid) P.add({ code: "group", rel: e.rel, detail: `gid ${e.gid}` });
    if (e.type !== "dir" && e.type !== "file" && e.type !== "symlink")
      P.add({ code: "type", rel: e.rel, detail: e.type });
    if (e.mode & 0o7000) P.add({ code: "special-bits", rel: e.rel, detail: `0${e.mode.toString(8)}` });
    if (e.type === "file" && (e.mode & 0o400) === 0) P.add({ code: "unreadable", rel: e.rel, detail: "无读权限" });
    if (e.type === "dir" && (e.mode & 0o500) !== 0o500)
      P.add({ code: "unreadable", rel: e.rel, detail: "无 r/x 权限" });
    if (e.type === "file" && e.nlink > (inTree.get(`${e.dev}:${e.ino}`) ?? 0))
      P.add({ code: "ext-hardlink", rel: e.rel, detail: `nlink ${e.nlink}` });
    if (e.type === "symlink") {
      if (e.nlink > 1) P.add({ code: "hardlinked-symlink", rel: e.rel, detail: `nlink ${e.nlink}` });
      const c = classifyLink(e.rel, e.target, linkRoots);
      if (c === "escape") P.add({ code: "escape-link", rel: e.rel, detail: `→ ${e.target}` });
      else if (c === "invalid") P.add({ code: "escape-link", rel: e.rel, detail: "链接文本无效" });
      else if (c === "abs-external") warnings.push({ code: "abs-external-link", rel: e.rel, target: e.target });
    }
  }
  return { ...P.result(), warnings };
}

// ───────────────────────────── mountinfo ─────────────────────────────

export function decodeMountinfoField(field) {
  return field.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

export function parseMountinfo(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const sepAt = line.indexOf(" - ");
    if (sepAt < 0) continue;
    const pre = line.slice(0, sepAt).split(" ");
    const post = line.slice(sepAt + 3).split(" ");
    const mountPoint = pre[4];
    const fsType = post[0];
    const source = post[1];
    if (mountPoint === undefined || fsType === undefined || source === undefined) continue;
    out.push({ mountPoint: decodeMountinfoField(mountPoint), fsType, source: decodeMountinfoField(source) });
  }
  return out;
}

/** Mount points equal to or inside any of `roots` (pass BOTH the literal and the realpath spelling). */
export function mountsInside(mountinfoText, roots) {
  const rs = [...new Set(roots.filter(Boolean).map((r) => path.posix.normalize(r)))];
  return parseMountinfo(mountinfoText).filter((e) => rs.some((r) => pathWithin(e.mountPoint, r)));
}

/** The mount that serves `p` (longest mount-point prefix; the last of equals wins — stacked mounts). */
export function mountFor(mountinfoText, p) {
  let best;
  for (const e of parseMountinfo(mountinfoText)) {
    if (!pathWithin(p, e.mountPoint)) continue;
    if (!best || e.mountPoint.length >= best.mountPoint.length) best = e;
  }
  return best;
}

export function readMountinfo() {
  return fs.readFileSync("/proc/self/mountinfo", "utf8");
}

export function mountProblems(mountinfoText, roots) {
  return mountsInside(mountinfoText, roots).map((e) => ({
    code: "mount",
    path: e.mountPoint,
    detail: `${e.fsType} ${e.source}`,
  }));
}

// ───────────────────────────── xattr (getfattr) ─────────────────────────────

/** getfattr (LC_ALL=C) escapes `\\` and every non-printable BYTE as `\ooo` — decode to bytes, then UTF-8. */
function decodeGetfattrName(s) {
  const bytes = [];
  const raw = Buffer.from(s, "utf8");
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0x5c && raw[i + 1] === 0x5c) {
      bytes.push(0x5c);
      i++;
    } else if (raw[i] === 0x5c && /^[0-7]{3}$/.test(raw.subarray(i + 1, i + 4).toString("latin1"))) {
      bytes.push(parseInt(raw.subarray(i + 1, i + 4).toString("latin1"), 8) & 0xff);
      i += 3;
    } else bytes.push(raw[i]);
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Parse `getfattr -d -m - --absolute-names` output → [{path, names:[…]}] (files with ≥1 attribute). */
export function parseGetfattrDump(text) {
  const out = [];
  let cur;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("# file: ")) {
      cur = { path: decodeGetfattrName(line.slice(8)), names: [] };
      out.push(cur);
      continue;
    }
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const name = eq < 0 ? line : line.slice(0, eq);
    if (!cur) {
      cur = { path: "", names: [] };
      out.push(cur);
    }
    cur.names.push(name);
  }
  return out.filter((f) => f.names.length > 0);
}

/**
 * xattr scan over EXACTLY the manifest's objects. Each object is named to getfattr as
 * `/proc/<pid>/fd/<parentfd>/<name>` where <parentfd> is a pinned parent directory whose identity
 * matched the manifest (`-h`: the final component is inspected itself, never followed; the root is
 * `/proc/<pid>/fd/<rootfd>/.`). Batched (≤64 KiB of arguments, ≤64 pinned dirs, one progress tick
 * per batch — getfattr -R prints nothing for attribute-less files, so a recursive run could not feed
 * the stall watchdog). Binding of the NAME to the manifest inode is closed by checkTree's second
 * walk (ctime moves on every xattr change and every rename of the inode).
 * → {kind:"ok", problems, counts, total, truncated} | {kind:"missing"} (⇒ 69)
 */
export function scanXattrs(
  m,
  { bin = "getfattr", envPath, onProgress, batchMs = TREE_BUDGET.getfattrBatchMs, _hooks } = {},
) {
  const exe = findOnPath(bin, envPath);
  if (!exe) return { kind: "missing" };
  const P = createProblems();
  const ids = dirIdsOf(m);
  const byParent = new Map();
  for (const e of m.entries) {
    if (e.rel === "") continue;
    const { parent, name } = splitRel(e.rel);
    let arr = byParent.get(parent);
    if (!arr) byParent.set(parent, (arr = []));
    arr.push({ rel: e.rel, name });
  }
  const rootFd = openRootDir(m.root, DIR_PIN, m.rootId);
  let pinned = []; // fds of the current batch
  let args = [];
  let argBytes = 0;
  const argRel = new Map();
  let done = 0;
  const run = () => {
    if (args.length === 0) return true;
    _hooks?.beforeGetfattr?.(args.slice());
    const r = spawnSync(exe, ["-h", "-d", "-m", "-", "--absolute-names", "--", ...args], {
      encoding: "utf8",
      timeout: batchMs,
      killSignal: "SIGKILL",
      maxBuffer: TREE_BUDGET.getfattrMaxOutBytes,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
    });
    for (const fd of pinned) closeQuiet(fd);
    pinned = [];
    if (r.error || r.status !== 0) {
      const why = r.error ? String(r.error.code ?? r.error.message) : `exit ${r.status}`;
      P.add({
        code: "xattr-uncertain",
        rel: argRel.get(args[0]) ?? "",
        detail: `${why} ${String(r.stderr ?? "").slice(0, 200)}`.trim(),
      });
      return false;
    }
    for (const f of parseGetfattrDump(r.stdout)) {
      const rel = argRel.get(f.path);
      P.add({ code: "xattr", ...(rel !== undefined ? { rel } : { path: f.path }), detail: f.names.join(", ") });
    }
    done += args.length;
    onProgress?.({ units: done });
    args = [];
    argBytes = 0;
    argRel.clear();
    return true;
  };
  const push = (p, rel) => {
    args.push(p);
    argBytes += p.length + 1;
    argRel.set(p, rel);
  };
  try {
    const rootArg = `${childFdPath(rootFd)}/.`;
    push(rootArg, "");
    for (const [parent, kids] of byParent) {
      if (pinned.length >= TREE_BUDGET.xattrBatchDirs || argBytes >= TREE_BUDGET.getfattrBatchArgBytes) {
        if (!run()) return { kind: "ok", ...P.result() };
      }
      let pfd;
      try {
        pfd = pinDirChain(rootFd, parent, ids);
      } catch (e) {
        P.add({ code: "unstable", rel: parent, detail: e instanceof TreeError ? e.code : String(e.code ?? e.message) });
        return { kind: "ok", ...P.result() };
      }
      pinned.push(pfd);
      for (const k of kids) {
        const p = `${childFdPath(pfd)}/${k.name}`;
        if (argBytes + p.length + 1 > TREE_BUDGET.getfattrBatchArgBytes && args.length > 0) {
          // keep this parent pinned across the batch boundary: run without it, re-pin after
          const keep = pinned.pop();
          const ok = run();
          pinned.push(keep);
          if (!ok) return { kind: "ok", ...P.result() };
        }
        push(p, k.rel);
      }
    }
    run();
    return { kind: "ok", ...P.result() };
  } finally {
    for (const fd of pinned) closeQuiet(fd);
    closeQuiet(rootFd);
  }
}
// ───────────────────────────── parent directory + filesystem type ─────────────────────────────

export function fsNameForMagic(magic) {
  for (const [name, m] of Object.entries(FS_MAGIC)) if (m === Number(magic)) return name;
  return undefined;
}

/**
 * §1.3 父目录: owned by `uid`, a directory, owner-writable, not group/other-writable, and on a
 * whitelisted filesystem — BOTH statfs(2) f_type and the serving mountinfo entry must agree.
 * `parent` must already be the physical (realpath) spelling. → problems[]
 */
export function checkParentDir(
  parent,
  { uid = process.getuid(), statfs = (p) => fs.statfsSync(p), mountinfo = readMountinfo(), lstat = lstatBig } = {},
) {
  const out = [];
  let st;
  try {
    st = lstat(parent);
  } catch (e) {
    return [{ code: "parent-not-dir", path: parent, detail: String(e.code ?? e.message) }];
  }
  if (!st.isDirectory()) return [{ code: "parent-not-dir", path: parent }];
  const mode = Number(st.mode) & 0o7777;
  if (Number(st.uid) !== uid) out.push({ code: "parent-owner", path: parent, detail: `uid ${st.uid}` });
  if (mode & 0o022) out.push({ code: "parent-mode", path: parent, detail: `0${mode.toString(8)}` });
  if ((mode & 0o300) !== 0o300) out.push({ code: "parent-not-writable", path: parent, detail: `0${mode.toString(8)}` });
  let magicName;
  try {
    magicName = fsNameForMagic(statfs(parent).type);
  } catch (e) {
    out.push({ code: "fs-type", path: parent, detail: `statfs: ${e.code ?? e.message}` });
    return out;
  }
  const m = mountFor(mountinfo, parent);
  const ok = magicName !== undefined && m !== undefined && PARENT_FS_TYPES.includes(m.fsType);
  if (!ok)
    out.push({ code: "fs-type", path: parent, detail: `${m?.fsType ?? "?"} / statfs ${magicName ?? "unknown"}` });
  return out;
}

// ───────────────────────────── space estimate ─────────────────────────────

/** Ciphertext bytes gocryptfs writes for a plaintext of `size` bytes (0 ⇒ 0: empty files stay empty). */
export function gocryptfsCipherSize(size) {
  if (size <= 0) return 0;
  return GOCRYPTFS_HEADER + size + Math.ceil(size / GOCRYPTFS_BLOCK) * GOCRYPTFS_BLOCK_OVERHEAD;
}

const roundBlock = (n) => Math.ceil(n / FS_BLOCK) * FS_BLOCK;

/**
 * Conservative backend usage of copying manifest `m` into a gocryptfs vault: every unique regular
 * file's ciphertext rounded up to 4 KiB, one block + inode per directory (+ its gocryptfs.diriv),
 * per symlink, and per long-name side file. Hardlink extra names cost nothing.
 * `extraBytes`/`extraInodes`: sessions/memory copies etc. → {bytes, inodes}
 */
export function estimateVaultUsage(m, { extraBytes = 0, extraInodes = 0 } = {}) {
  let bytes = extraBytes;
  let inodes = extraInodes;
  const seen = new Set();
  for (const e of m.entries) {
    const name = e.rel === "" ? "" : e.rel.slice(e.rel.lastIndexOf("/") + 1);
    if (Buffer.byteLength(name, "utf8") > GOCRYPTFS_LONGNAME_BYTES) {
      bytes += FS_BLOCK;
      inodes += 1;
    }
    if (e.type === "dir") {
      bytes += 2 * FS_BLOCK;
      inodes += 2;
    } else if (e.type === "symlink") {
      bytes += FS_BLOCK;
      inodes += 1;
    } else if (e.type === "file") {
      const k = `${e.dev}:${e.ino}`;
      if (seen.has(k)) continue;
      seen.add(k);
      bytes += roundBlock(gocryptfsCipherSize(e.size));
      inodes += 1;
    }
  }
  return { bytes, inodes };
}

export function statfsInfo(p, statfs = (x) => fs.statfsSync(x)) {
  const s = statfs(p);
  return {
    availBytes: Number(s.bavail) * Number(s.bsize),
    freeInodes: Number(s.ffree),
    totalInodes: Number(s.files),
    type: Number(s.type),
  };
}

/**
 * §1.3 空间: avail ≥ est.bytes × 1.10 + 64 MiB, and free inodes ≥ est.inodes × 1.10 + 64 (skipped
 * when the filesystem reports no inode table — btrfs f_files = 0). → problems[] (code space/inodes)
 */
export function checkSpace(info, est) {
  const out = [];
  const needBytes = Math.ceil(est.bytes * SPACE_FACTOR) + SPACE_SLACK_BYTES;
  if (info.availBytes < needBytes)
    out.push({ code: "space", detail: `需要 ${needBytes} 字节，可用 ${info.availBytes}`, need: needBytes });
  if (info.totalInodes > 0) {
    const needInodes = Math.ceil(est.inodes * SPACE_FACTOR) + INODE_SLACK;
    if (info.freeInodes < needInodes)
      out.push({ code: "inodes", detail: `需要 ${needInodes} 个 inode，可用 ${info.freeInodes}`, need: needInodes });
  }
  return out;
}

// ───────────────────────────── rename (mv -n -T + identity judgement) ─────────────────────────────

function validName(n) {
  return typeof n === "string" && n !== "" && n !== "." && n !== ".." && !n.includes("/") && !n.includes("\0");
}

/**
 * Bounded child in its own process group. Whatever the ending (exit, timeout, spawn error), the group
 * is then killed and proven empty by reapGroup (fail-closed scan; `clean:false` when the scan was
 * incomplete or members survived; ref'd poll timers, ≤ killGraceMs).
 * → {kind:"exit",code,signal,stderr,clean,leftover,scan} | {kind:"timeout",stderr,clean,leftover,scan} | {kind:"error",message}
 */
function runChild(
  cmd,
  args,
  { cwd = "/", deadline, env, killGraceMs = 1_000, spawnImpl = spawn, procRoot = "/proc" } = {},
) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      resolve({ kind: "error", message: String(e && e.message) });
      return;
    }
    const pgid = child.pid;
    const leaderState = {
      leaderReaped: false,
      leaderStart: pgid === undefined ? undefined : readProcStart(pgid, procRoot),
    };
    child.on("exit", () => {
      leaderState.leaderReaped = true;
    });
    let stderr = "";
    child.stderr?.on("data", (b) => {
      if (stderr.length < 8192) stderr += b.toString("utf8");
    });
    let ending = false;
    let timer;
    const reapThen = (r) => {
      if (ending) return;
      ending = true;
      clearTimeout(timer);
      if (pgid === undefined) {
        resolve(r);
        return;
      }
      reapGroup({ pgid, deadline: Date.now() + killGraceMs, procRoot, state: leaderState }).then((g) => {
        child.stderr?.destroy();
        child.unref();
        resolve({ ...r, clean: g.clean, leftover: g.leftover, scan: g.scan });
      });
    };
    timer = setTimeout(() => reapThen({ kind: "timeout", stderr }), Math.max(0, deadline - Date.now()));
    timer.unref();
    child.on("error", (e) => reapThen({ kind: "error", message: String(e && e.message) }));
    child.on("close", (code, signal) => reapThen({ kind: "exit", code: code ?? 128, signal, stderr }));
  });
}

/**
 * Rename `<parent>/<from>` to `<parent>/<to>` WITHOUT ever replacing anything (convert-plan §1.5,
 * I-C6), bound to the parent DIRECTORY OBJECT: the parent is opened O_DIRECTORY|O_NOFOLLOW once,
 * `mv -n -T -- <from> <to>` runs with cwd = /proc/<pid>/fd/<parentfd> (the kernel resolves that magic
 * link to the pinned directory, so a parent path swapped meanwhile cannot redirect it; both names
 * are single components ⇒ EXDEV — mv's only copy+delete trigger — is impossible), and every
 * before/after observation of `from`/`to` goes through the same fd. The verdict NEVER looks at mv's
 * exit code (XC8): `from` gone ∧ `to` has the expected (dev, ino) ⇒ moved.
 *
 * `expect` = {dev, ino} of `from` (REQUIRED); `expectParent` = {dev, ino} of the parent (optional).
 * The parent PATH must resolve to the pinned fd before and after; if it does not afterwards the
 * result is "unknown" even when the move happened (never "unchanged").
 * → {ok:true, mv} | {ok:false, state:"unchanged"|"unknown", reason, mv?}
 *   "unchanged" = nothing of ours moved (`from` still is `expect`, `to` is not it, parent consistent).
 */
export async function renameNoReplace({
  parent,
  from,
  to,
  expect,
  expectParent,
  mvBin = "mv",
  deadline = Date.now() + TREE_BUDGET.renameMs,
  spawnImpl,
  _hooks,
}) {
  if (typeof parent !== "string" || !path.isAbsolute(parent) || !validName(from) || !validName(to) || from === to)
    return { ok: false, state: "unchanged", reason: "bad-args" };
  if (!expect || expect.dev === undefined || expect.ino === undefined)
    return { ok: false, state: "unchanged", reason: "bad-args" };
  let pfd;
  try {
    pfd = fs.openSync(parent, DIR_READ);
  } catch (e) {
    return { ok: false, state: "unchanged", reason: `parent:${e.code ?? e.message}` };
  }
  try {
    const p0 = fstatBig(pfd);
    if (expectParent && !sameId(p0, expectParent)) return { ok: false, state: "unchanged", reason: "parent-identity" };
    const pathNow = lstatBigOrNull(parent);
    if (!pathNow || !sameId(pathNow, p0)) return { ok: false, state: "unchanged", reason: "parent-path" };
    const f0 = lstatBigOrNull(fdAt(pfd, from));
    if (!f0 || !sameId(f0, expect)) return { ok: false, state: "unchanged", reason: "source-identity" };
    if (lstatBigOrNull(fdAt(pfd, to))) return { ok: false, state: "unchanged", reason: "target-exists" };

    _hooks?.beforeMv?.();
    const r = await runChild(mvBin, ["-n", "-T", "--", from, to], {
      cwd: childFdPath(pfd),
      deadline,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
      spawnImpl,
    });
    _hooks?.afterMv?.();
    const mv = r.kind === "exit" ? { exit: r.code, signal: r.signal ?? undefined } : { kind: r.kind };
    if (r.kind !== "error" && r.clean !== true)
      return { ok: false, state: "unknown", reason: "mv-unclean", mv: { ...mv, leftover: r.leftover, scan: r.scan } };

    let f1;
    let t1;
    let pathAfter;
    try {
      f1 = lstatBigOrNull(fdAt(pfd, from));
      t1 = lstatBigOrNull(fdAt(pfd, to));
      pathAfter = lstatBigOrNull(parent);
    } catch (e) {
      return { ok: false, state: "unknown", reason: `post-lstat:${e.code ?? e.message}`, mv };
    }
    if (!pathAfter || !sameId(pathAfter, p0)) return { ok: false, state: "unknown", reason: "parent-path-changed", mv };
    if (!f1 && t1 && sameId(t1, expect)) return { ok: true, mv };
    if (f1 && sameId(f1, expect) && !(t1 && sameId(t1, expect)))
      return { ok: false, state: "unchanged", reason: t1 ? "target-exists" : "not-moved", mv };
    return { ok: false, state: "unknown", reason: "identity-mismatch", mv };
  } finally {
    closeQuiet(pfd);
  }
}

export function backupName(base, now = new Date(), rand = () => Math.floor(Math.random() * 0x10000)) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const r = (rand() & 0xffff).toString(16).padStart(4, "0");
  return `${base}.pi-secure-backup-${ts}-${r}`;
}

// ───────────────────────────── NDJSON files (manifest / modes / hashes) ─────────────────────────────

/** Create `file` exclusively (0600, O_NOFOLLOW), write header + one JSON line per record, fsync file + parent. */
export function writeNdjsonExclusive(file, header, records) {
  const fd = fs.openSync(file, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  try {
    let buf = `${JSON.stringify(header)}\n`;
    for (const r of records) {
      buf += `${JSON.stringify(r)}\n`;
      if (buf.length >= MiB) {
        writeAll(fd, Buffer.from(buf, "utf8"));
        buf = "";
      }
    }
    if (buf) writeAll(fd, Buffer.from(buf, "utf8"));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirSync(path.dirname(file));
}

/** Read an NDJSON file we wrote: refuses symlinks / non-regular / other owners. → {header, records} */
export function readNdjson(file, kind, uid = process.getuid()) {
  const fd = fs.openSync(file, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  let text;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== uid) throw new TreeError("bad-file", `不是本用户的普通文件：${file}`);
    text = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let header;
  try {
    header = JSON.parse(lines[0] ?? "");
  } catch {
    throw new TreeError("bad-file", `文件头无效：${file}`);
  }
  if (!header || header.kind !== kind || header.v !== 1) throw new TreeError("bad-file", `文件类型不符：${file}`);
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]));
    } catch {
      throw new TreeError("bad-file", `第 ${i + 1} 行无效（截断？）：${file}`);
    }
  }
  if (Number.isSafeInteger(header.count) && header.count !== records.length)
    throw new TreeError("bad-file", `记录数不符（截断？）：${file}`);
  return { header, records };
}

export function writeManifestFile(file, m) {
  writeNdjsonExclusive(
    file,
    {
      kind: MANIFEST_KIND,
      v: 1,
      root: m.root,
      rootId: m.rootId,
      ...(m.rootMntId !== undefined ? { rootMntId: m.rootMntId } : {}),
      count: m.entries.length,
      walkProblems: m.walkProblems ?? [],
    },
    m.entries,
  );
}

export function readManifestFile(file) {
  const { header, records } = readNdjson(file, MANIFEST_KIND);
  return {
    v: 1,
    root: header.root,
    rootId: header.rootId,
    ...(header.rootMntId !== undefined ? { rootMntId: String(header.rootMntId) } : {}),
    entries: records,
    walkProblems: header.walkProblems ?? [],
  };
}

export function writeHashesFile(file, hashes) {
  writeNdjsonExclusive(
    file,
    { kind: HASHES_KIND, v: 1, count: hashes.size },
    [...hashes].map(([rel, sha256]) => ({ rel, sha256 })),
  );
}

export function readHashesFile(file) {
  return new Map(readNdjson(file, HASHES_KIND).records.map((r) => [r.rel, r.sha256]));
}

// ───────────────────────────── chmod read-only / restore ─────────────────────────────

/**
 * Post-order, fd-anchored chmod pass over the manifest structure: every directory is pinned from its
 * pinned parent (O_PATH|O_DIRECTORY|O_NOFOLLOW) and must be the recorded inode; every regular file is
 * pinned O_PATH|O_NOFOLLOW from its pinned parent and must be the recorded inode; the change is
 * applied through that fd (chmodFd). `want(e)` → new mode or undefined (skip). `onSkip(e, reason)`
 * set ⇒ mismatches are reported and the subtree is skipped; unset ⇒ the first mismatch throws.
 */
function chmodPass(rootFd, m, want, { onSkip, onProgress } = {}) {
  const kids = childrenMap(m);
  let n = 0;
  const counts = { changed: 0, same: 0 };
  const apply = (fd, e) => {
    const mode = want(e);
    if (mode === undefined) return;
    if ((Number(fstatBig(fd).mode) & 0o7777) === mode) {
      counts.same++;
      return;
    }
    chmodFd(fd, mode);
    counts.changed++;
  };
  const visit = (dirFd, rel) => {
    for (const e of kids.get(rel) ?? []) {
      if (++n % TREE_BUDGET.progressEveryEntries === 0) onProgress?.({ units: n });
      if (e.type !== "dir" && e.type !== "file") continue;
      const { name } = splitRel(e.rel);
      let pinned;
      try {
        pinned = openAtExpect(dirFd, name, e.type === "dir" ? DIR_PIN : ENTRY_PIN, e, { dir: e.type === "dir" });
        if (typeOfMode(pinned.st.mode) !== e.type) throw new TreeError("identity", `类型已变：${e.rel}`);
      } catch (err) {
        closeQuiet(pinned?.fd);
        if (!onSkip) throw err instanceof TreeError ? err : asTreeError(err);
        onSkip(e, err instanceof TreeError ? err.code : String(err.code ?? err.message));
        continue;
      }
      try {
        if (e.type === "dir") visit(pinned.fd, e.rel);
        apply(pinned.fd, e);
      } catch (err) {
        if (!onSkip) throw err instanceof TreeError ? err : asTreeError(err);
        onSkip(e, err instanceof TreeError ? err.code : String(err.code ?? err.message));
      } finally {
        closeQuiet(pinned.fd);
      }
    }
  };
  visit(rootFd, "");
  const root = m.entries[0];
  if (root) {
    try {
      apply(rootFd, root);
    } catch (err) {
      if (!onSkip) throw err instanceof TreeError ? err : asTreeError(err);
      onSkip(root, err instanceof TreeError ? err.code : String(err.code ?? err.message));
    }
  }
  return counts;
}

/**
 * §1.4 step 4. Refuses (nothing changed) when the walk reports ANY problem (another mount inside,
 * an unstable or unreadable entry, …) or mountinfo shows a mount at/under the root. Otherwise FIRST
 * records every entry's original mode into `modesFile` (exclusive 0600, fsync file + parent; relative
 * paths — R30), THEN removes the write bits bottom-up through inode-bound fds (dirs + regular files;
 * symlinks have no own mode, special files are left alone — the authoritative check refuses them).
 * Any identity mismatch stops the pass with TreeError("identity") — the caller restores from the file.
 * → {entries, changed, rootId}
 */
export function freezeTree(root, modesFile, { expectRoot, mountinfo, onProgress, _hooks } = {}) {
  const m = walkTree(root, { expectRoot });
  if (m.walkProblems.length > 0)
    throw Object.assign(
      new TreeError(
        "walk-problems",
        `树里有无法安全处理的条目，未做任何修改：${m.walkProblems[0].code} ${m.walkProblems[0].rel ?? ""}`,
        { exit: TREE_EXIT.CONTENT },
      ),
      {
        problems: m.walkProblems,
      },
    );
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    /* literal */
  }
  const mounts = mountsInside(mountinfo ?? readMountinfo(), [root, real]);
  if (mounts.length > 0)
    throw new TreeError("mount", `树内有挂载点，未做任何修改：${mounts[0].mountPoint}`, { exit: TREE_EXIT.CONTENT });
  writeNdjsonExclusive(
    modesFile,
    { kind: MODES_KIND, v: 1, root, rootId: m.rootId, count: m.entries.length },
    m.entries.map((e) => ({ rel: e.rel, type: e.type, mode: e.mode, dev: e.dev, ino: e.ino })),
  );
  _hooks?.beforeChmod?.();
  const rootFd = openRootDir(root, DIR_PIN, m.rootId);
  let counts;
  try {
    counts = chmodPass(rootFd, m, (e) => (e.mode & 0o222 ? e.mode & ~0o222 : undefined), { onProgress });
  } finally {
    closeQuiet(rootFd);
  }
  return { entries: m.entries.length, changed: counts.changed, rootId: m.rootId };
}

export function readModesFile(file) {
  const { header, records } = readNdjson(file, MODES_KIND);
  return { header, records };
}

/**
 * Restore the modes recorded by freezeTree. The tree root may have been renamed since: it is bound
 * by the header's rootId, every directory/file by its recorded (dev, ino) through the fd chain.
 * Only chmod, through inode-bound fds; never touches content. A missing/replaced entry (and a
 * replaced directory's whole subtree) is SKIPPED and reported.
 * → {ok, restored, unchanged, skipped:[{rel, reason}]}
 */
export function restoreModes(root, modesFile, { onProgress } = {}) {
  const { header, records } = readModesFile(modesFile);
  const skipped = [];
  let rootFd;
  try {
    rootFd = openRootDir(root, DIR_PIN, header.rootId);
  } catch (e) {
    return {
      ok: false,
      restored: 0,
      unchanged: 0,
      skipped: [{ rel: "", reason: e instanceof TreeError ? e.code : String(e.code ?? e.message) }],
    };
  }
  let counts;
  try {
    counts = chmodPass(rootFd, { entries: records }, (e) => e.mode, {
      onSkip: (e, reason) => skipped.push({ rel: e.rel, reason }),
      onProgress,
    });
  } finally {
    closeQuiet(rootFd);
  }
  return { ok: skipped.length === 0, restored: counts.changed, unchanged: counts.same, skipped };
}

// ───────────────────────────── baseline ─────────────────────────────

const BASELINE_FIELDS = ["type", "dev", "ino", "size", "mtimeNs", "ctimeNs", "mode", "nlink", "uid", "gid", "target"];

/** Baseline = a manifest (walkTree). NOTE: the convert baseline is checkTree's own manifest (step 6). */
export function takeBaseline(root, opts) {
  return walkTree(root, opts);
}

/**
 * Compare two manifests of the SAME tree (step 12). ctime catches "chmod back, write, chmod again"
 * (kernel coarse-clock granularity — see residuals). atime is ignored (reads move it). Root identity,
 * root mount id and walk problems count too. → [{rel, kind:"added"|"removed"|"changed", fields?}]
 */
export function compareBaselines(a, b, { max = TREE_BUDGET.maxDiffs } = {}) {
  const diffs = [];
  const push = (d) => {
    if (diffs.length < max) diffs.push(d);
  };
  if (a.rootId && b.rootId && !sameId(a.rootId, b.rootId)) push({ rel: "", kind: "changed", fields: ["rootId"] });
  if (a.rootMntId !== undefined && b.rootMntId !== undefined && a.rootMntId !== b.rootMntId)
    push({ rel: "", kind: "changed", fields: ["rootMntId"] });
  const bm = new Map(b.entries.map((e) => [e.rel, e]));
  for (const ea of a.entries) {
    const eb = bm.get(ea.rel);
    if (!eb) {
      push({ rel: ea.rel, kind: "removed" });
      continue;
    }
    bm.delete(ea.rel);
    const fields = BASELINE_FIELDS.filter((f) => ea[f] !== eb[f]);
    if (fields.length) push({ rel: ea.rel, kind: "changed", fields });
  }
  for (const rel of bm.keys()) push({ rel, kind: "added" });
  if ((b.walkProblems?.length ?? 0) > 0) push({ rel: "", kind: "changed", fields: ["walk"] });
  return diffs;
}

// ───────────────────────────── copy ─────────────────────────────

function writeAll(fd, buf, len = buf.length) {
  let off = 0;
  while (off < len) off += fs.writeSync(fd, buf, off, len - off);
}

function sourceMatches(st, e) {
  return (
    sameId(st, e) &&
    Number(st.size) === e.size &&
    String(st.mtimeNs) === e.mtimeNs &&
    String(st.ctimeNs) === e.ctimeNs &&
    typeOfMode(st.mode) === e.type
  );
}

function modesMapFrom(modes) {
  if (!modes) return undefined;
  if (modes instanceof Map) return modes;
  return new Map(modes.map((r) => [r.rel, r.mode]));
}

/**
 * §1.5 copy of the tree described by `baseline` (checkTree's manifest of `src`, taken AFTER freeze)
 * into the EXISTING EMPTY directory `dst` — every creation is bound to directory fds (I2/I3):
 *   • `src` is pinned and must be baseline.rootId; `dst` is opened O_DIRECTORY|O_NOFOLLOW, must be
 *     empty (and `expectDst` when given); each source directory is pinned from its pinned parent and
 *     must be the baseline inode on the source root's mount;
 *   • each destination directory is mkdir'ed through its parent's fd, opened O_NOFOLLOW from that fd,
 *     and must be an empty directory on the destination root's mount — all children are then created
 *     through THAT fd (`/proc/self/fd/<dirfd>/<name>`), so a later rename/symlink swap of the path
 *     can only ever redirect writes into the directory object we created;
 *   • files: source O_RDONLY|O_NOFOLLOW checked against the baseline (dev, ino, size, mtime, ctime)
 *     before and after reading; destination O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW 0600, sha256 while
 *     streaming, fchmod(original mode) + futimes + fsync on the fd;
 *   • directories get their original mode/mtime bottom-up through their own fd (fchmod/futimes);
 *   • symlinks: text verbatim, lutimes on the anchored path, re-read to confirm;
 *   • hardlink groups: first member copied, later members link()ed from the leader re-pinned through
 *     the recorded destination directory chain and verified by inode.
 * `modes`: original modes (Map or modes-file records; the frozen baseline lacks write bits).
 * Never overwrites (EEXIST ⇒ fail). → {files, links, symlinks, dirs, bytes, hashes: Map<leaderRel, sha256>, dstId}
 */
export function copyTree({ src, dst, baseline, modes, applyRootMeta = true, expectDst, onProgress, _hooks }) {
  const modeOf = modesMapFrom(modes);
  const origMode = (e) => {
    const m = modeOf?.get(e.rel);
    return typeof m === "number" ? m & 0o7777 : e.mode;
  };
  const kids = childrenMap(baseline);
  const hashes = new Map();
  const leaders = new Map(); // src dev:ino → {rel, dev, ino} (destination identity)
  const dstDirIds = new Map();
  const stats = { files: 0, links: 0, symlinks: 0, dirs: 0, bytes: 0 };
  let units = 0;
  let sinceTick = 0;
  const tick = (force = false) => {
    if (force || sinceTick >= TREE_BUDGET.progressEveryBytes || units % TREE_BUDGET.progressEveryEntries === 0) {
      onProgress?.({ units, bytes: stats.bytes });
      sinceTick = 0;
    }
  };
  const buf = Buffer.allocUnsafe(MiB);
  let srcRoot;
  let dstRoot;
  const frames = [];
  try {
    try {
      srcRoot = openRootDir(src, DIR_PIN, baseline.rootId);
    } catch (e) {
      throw e instanceof TreeError && e.code === "identity"
        ? new TreeError("source-changed", `源目录不是基线里的那个：${src}`)
        : e;
    }
    const srcMnt = mntIdOf(srcRoot);
    if (srcMnt === undefined || (baseline.rootMntId !== undefined && baseline.rootMntId !== srcMnt))
      throw new TreeError("source-changed", `源目录的挂载与基线不符：${src}`);
    try {
      dstRoot = openRootDir(dst, DIR_READ, expectDst);
    } catch (e) {
      throw e instanceof TreeError && e.code === "root-not-dir"
        ? new TreeError("dst-not-dir", `目标不是目录：${dst}`)
        : e;
    }
    if (listDirFd(dstRoot).length !== 0) throw new TreeError("dst-not-empty", `目标目录不是空的：${dst}`);
    const dstRootSt = fstatBig(dstRoot);
    const dstMnt = mntIdOf(dstRoot);
    if (dstMnt === undefined) throw new TreeError("mount-uncertain", `无法确认目标挂载：${dst}`);
    dstDirIds.set("", idOf(dstRootSt));

    frames.push({
      rel: "",
      srcFd: srcRoot,
      dstFd: dstRoot,
      list: kids.get("") ?? [],
      i: 0,
      entry: baseline.entries[0],
    });
    while (frames.length > 0) {
      const f = frames[frames.length - 1];
      if (f.i >= f.list.length) {
        frames.pop();
        if (f.rel !== "" || applyRootMeta) {
          fs.fchmodSync(f.dstFd, origMode(f.entry));
          fs.futimesSync(f.dstFd, secondsInsideMs(msFloor(f.entry.atimeNs)), secondsInsideMs(msFloor(f.entry.mtimeNs)));
        }
        if (f.rel !== "") {
          closeQuiet(f.srcFd);
          closeQuiet(f.dstFd);
        }
        continue;
      }
      const e = f.list[f.i++];
      const { name } = splitRel(e.rel);
      if (e.type === "dir") {
        let sfd;
        let dfd;
        try {
          sfd = openAtExpect(f.srcFd, name, DIR_PIN, e, { dir: true }).fd;
          if (mntIdOf(sfd) !== srcMnt)
            throw new TreeError("source-changed", `源目录跨了挂载：${e.rel}`, { rel: e.rel });
          fs.mkdirSync(fdAt(f.dstFd, name), 0o700);
          _hooks?.afterMkdir?.(e.rel);
          dfd = fs.openSync(fdAt(f.dstFd, name), DIR_READ);
          const dst0 = fstatBig(dfd);
          if (
            !dst0.isDirectory() ||
            Number(dst0.uid) !== process.getuid() ||
            mntIdOf(dfd) !== dstMnt ||
            listDirFd(dfd).length !== 0
          )
            throw new TreeError("dst-changed", `新建的目标目录被替换：${e.rel}`, { rel: e.rel });
          dstDirIds.set(e.rel, idOf(dst0));
          _hooks?.afterOpenDstDir?.(e.rel);
        } catch (err) {
          closeQuiet(sfd);
          closeQuiet(dfd);
          throw err;
        }
        frames.push({ rel: e.rel, srcFd: sfd, dstFd: dfd, list: kids.get(e.rel) ?? [], i: 0, entry: e });
        stats.dirs++;
      } else if (e.type === "symlink") {
        const st = lstatBig(fdAt(f.srcFd, name));
        const text = fs.readlinkSync(fdAt(f.srcFd, name));
        const st2 = lstatBig(fdAt(f.srcFd, name));
        if (!sourceMatches(st, e) || !sameVersion(st, st2) || text !== e.target)
          throw new TreeError("source-changed", `源条目在基线之后被改动：${e.rel}`, { rel: e.rel });
        fs.symlinkSync(e.target, fdAt(f.dstFd, name));
        fs.lutimesSync(fdAt(f.dstFd, name), secondsInsideMs(msFloor(e.atimeNs)), secondsInsideMs(msFloor(e.mtimeNs)));
        const d = lstatBig(fdAt(f.dstFd, name));
        if (!d.isSymbolicLink() || fs.readlinkSync(fdAt(f.dstFd, name)) !== e.target)
          throw new TreeError("dst-changed", `新建的符号链接被替换：${e.rel}`, { rel: e.rel });
        stats.symlinks++;
      } else if (e.type === "file") {
        const key = `${e.dev}:${e.ino}`;
        const leader = leaders.get(key);
        if (leader) {
          const st = lstatBig(fdAt(f.srcFd, name));
          if (!sourceMatches(st, e))
            throw new TreeError("source-changed", `源条目在基线之后被改动：${e.rel}`, { rel: e.rel });
          const { parent: lp, name: ln } = splitRel(leader.rel);
          const lfd = pinDirChain(dstRoot, lp, dstDirIds);
          try {
            const l0 = lstatBig(fdAt(lfd, ln));
            if (!sameId(l0, leader))
              throw new TreeError("dst-changed", `硬链接组首个副本被替换：${leader.rel}`, { rel: leader.rel });
            fs.linkSync(fdAt(lfd, ln), fdAt(f.dstFd, name));
          } finally {
            closeQuiet(lfd);
          }
          if (!sameId(lstatBig(fdAt(f.dstFd, name)), leader))
            throw new TreeError("dst-changed", `硬链接未指向首个副本：${e.rel}`, { rel: e.rel });
          stats.links++;
        } else {
          const r = copyOneFile(f.srcFd, f.dstFd, name, e, origMode(e), buf, (n) => {
            stats.bytes += n;
            sinceTick += n;
            tick();
          });
          hashes.set(e.rel, r.sha256);
          leaders.set(key, { rel: e.rel, ...r.dstId });
          stats.files++;
        }
      } else {
        throw new TreeError("bad-type", `不支持的条目类型 ${e.type}：${e.rel}`, {
          exit: TREE_EXIT.CONTENT,
          rel: e.rel,
        });
      }
      units++;
      tick();
    }
    tick(true);
    return { ...stats, hashes, dstId: idOf(dstRootSt) };
  } catch (e) {
    throw asTreeError(e);
  } finally {
    for (const f of frames) {
      if (f.rel === "") continue;
      closeQuiet(f.srcFd);
      closeQuiet(f.dstFd);
    }
    closeQuiet(srcRoot);
    closeQuiet(dstRoot);
  }
}

function copyOneFile(srcDirFd, dstDirFd, name, e, mode, buf, onBytes) {
  const sfd = fs.openSync(fdAt(srcDirFd, name), fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  try {
    const st0 = fstatBig(sfd);
    if (!sourceMatches(st0, e))
      throw new TreeError("source-changed", `源条目在基线之后被改动：${e.rel}`, { rel: e.rel });
    const dfd = fs.openSync(fdAt(dstDirFd, name), fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
    try {
      const h = createHash("sha256");
      let total = 0;
      for (;;) {
        const n = fs.readSync(sfd, buf, 0, buf.length, null);
        if (n === 0) break;
        h.update(buf.subarray(0, n));
        writeAll(dfd, buf, n);
        total += n;
        onBytes(n);
      }
      const st1 = fstatBig(sfd);
      if (total !== e.size || !sourceMatches(st1, e))
        throw new TreeError("source-changed", `源文件在拷贝期间被改动：${e.rel}`, { rel: e.rel });
      fs.fchmodSync(dfd, mode);
      fs.futimesSync(dfd, secondsInsideMs(msFloor(e.atimeNs)), secondsInsideMs(msFloor(e.mtimeNs)));
      fs.fsyncSync(dfd);
      return { sha256: h.digest("hex"), dstId: idOf(fstatBig(dfd)) };
    } finally {
      fs.closeSync(dfd);
    }
  } finally {
    fs.closeSync(sfd);
  }
}

// ───────────────────────────── verify (read-back) ─────────────────────────────

/** sha256 of the object behind an open fd (reads from the current offset to EOF). */
function hashFd(fd, buf, onBytes) {
  const h = createHash("sha256");
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    h.update(buf.subarray(0, n));
    onBytes?.(n);
  }
  return h.digest("hex");
}

/**
 * §1.4 step 8 read-back verification of `dst` against the baseline + the copy's hashes, bound to
 * fds: every directory is opened O_NOFOLLOW from its verified parent fd and its child-name set must
 * equal the baseline's; every file is opened O_NOFOLLOW from its parent fd and the hash is read from
 * THAT fd, with fstat before and after (dev, ino, size, mtime, ctime) required equal; type, original
 * mode, size, mtime(ms), nlink, hardlink-group inode and symlink text (lstat → readlink → lstat
 * stable) are compared. Finally the whole destination is walked again and must equal the snapshot
 * observed during verification (any change ⇒ failure, I4). → {ok, diffs:[{rel, what, want?, got?}], checked}
 */
export function verifyCopy({ dst, baseline, modes, hashes, applyRootMeta = true, expectDst, onProgress, _hooks }) {
  const modeOf = modesMapFrom(modes);
  const origMode = (e) => {
    const m = modeOf?.get(e.rel);
    return typeof m === "number" ? m & 0o7777 : e.mode;
  };
  const diffs = [];
  const push = (d) => {
    if (diffs.length < TREE_BUDGET.maxDiffs) diffs.push(d);
  };
  const kids = childrenMap(baseline);
  const groupSize = new Map();
  for (const e of baseline.entries)
    if (e.type === "file") groupSize.set(`${e.dev}:${e.ino}`, (groupSize.get(`${e.dev}:${e.ino}`) ?? 0) + 1);
  const leaderDst = new Map();
  const observed = [];
  const buf = Buffer.allocUnsafe(MiB);
  let units = 0;
  let bytes = 0;
  let sinceTick = 0;
  const onBytes = (n) => {
    bytes += n;
    sinceTick += n;
    if (sinceTick >= TREE_BUDGET.progressEveryBytes) {
      sinceTick = 0;
      onProgress?.({ units, bytes });
    }
  };
  const meta = (want, st, rel) => {
    const checkMeta = rel !== "" || applyRootMeta;
    const mode = Number(st.mode) & 0o7777;
    if (checkMeta && (want.type === "dir" || want.type === "file") && mode !== origMode(want))
      push({ rel, what: "mode", want: origMode(want), got: mode });
    if (checkMeta && msFloor(st.mtimeNs) !== msFloor(want.mtimeNs))
      push({ rel, what: "mtime", want: String(msFloor(want.mtimeNs)), got: String(msFloor(st.mtimeNs)) });
  };
  let rootFd;
  const frames = [];
  try {
    try {
      rootFd = openRootDir(dst, DIR_READ, expectDst);
    } catch (e) {
      throw asTreeError(e);
    }
    const rootSt = fstatBig(rootFd);
    const dstMnt = mntIdOf(rootFd);
    observed.push(entryFromStat("", rootSt));
    meta(baseline.entries[0], rootSt, "");
    frames.push({ rel: "", fd: rootFd, list: null, i: 0 });
    while (frames.length > 0) {
      const f = frames[frames.length - 1];
      if (f.list === null) {
        f.list = kids.get(f.rel) ?? [];
        let names;
        try {
          names = listDirFd(f.fd).map((b) => b.toString("utf8"));
        } catch (e) {
          push({ rel: f.rel, what: `list:${e.code ?? e.message}` });
          names = [];
        }
        const want = new Set(f.list.map((e) => splitRel(e.rel).name));
        for (const n of names) if (!want.has(n)) push({ rel: relJoin(f.rel, n), what: "extra" });
        f.present = new Set(names);
      }
      if (f.i >= f.list.length) {
        frames.pop();
        if (f.fd !== rootFd) closeQuiet(f.fd);
        continue;
      }
      const want = f.list[f.i++];
      const { name } = splitRel(want.rel);
      units++;
      if (units % TREE_BUDGET.progressEveryEntries === 0) onProgress?.({ units, bytes });
      if (!f.present.has(name)) {
        push({ rel: want.rel, what: "missing" });
        continue;
      }
      if (want.type === "symlink") {
        let st;
        try {
          st = lstatBig(fdAt(f.fd, name));
          if (!st.isSymbolicLink()) {
            push({ rel: want.rel, what: "type", want: "symlink", got: typeOfMode(st.mode) });
            observed.push(entryFromStat(want.rel, st));
            continue;
          }
          const text = fs.readlinkSync(fdAt(f.fd, name));
          const st2 = lstatBig(fdAt(f.fd, name));
          if (!sameVersion(st, st2)) push({ rel: want.rel, what: "unstable" });
          if (text !== want.target) push({ rel: want.rel, what: "link-text", want: want.target, got: text });
          observed.push({ ...entryFromStat(want.rel, st), target: text });
          meta(want, st, want.rel);
        } catch (e) {
          push({ rel: want.rel, what: `read:${e.code ?? e.message}` });
        }
        continue;
      }
      let fd;
      try {
        fd = fs.openSync(
          fdAt(f.fd, name),
          want.type === "dir" ? DIR_READ : fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK,
        );
      } catch (e) {
        if (e.code === "ELOOP" || e.code === "ENOTDIR")
          push({ rel: want.rel, what: "type", want: want.type, got: "other" });
        else push({ rel: want.rel, what: `read:${e.code ?? e.message}` });
        try {
          observed.push(entryFromStat(want.rel, lstatBig(fdAt(f.fd, name))));
        } catch {
          /* gone */
        }
        continue;
      }
      const st0 = fstatBig(fd);
      const gotType = typeOfMode(st0.mode);
      observed.push(entryFromStat(want.rel, st0));
      if (gotType !== want.type) {
        push({ rel: want.rel, what: "type", want: want.type, got: gotType });
        closeQuiet(fd);
        continue;
      }
      meta(want, st0, want.rel);
      if (want.type === "dir") {
        if (mntIdOf(fd) !== dstMnt) push({ rel: want.rel, what: "mount" });
        frames.push({ rel: want.rel, fd, list: null, i: 0 });
        continue;
      }
      try {
        if (Number(st0.size) !== want.size)
          push({ rel: want.rel, what: "size", want: want.size, got: Number(st0.size) });
        const key = `${want.dev}:${want.ino}`;
        if (Number(st0.nlink) !== groupSize.get(key))
          push({ rel: want.rel, what: "nlink", want: groupSize.get(key), got: Number(st0.nlink) });
        const lead = leaderDst.get(key);
        if (lead) {
          if (!sameId(st0, lead)) push({ rel: want.rel, what: "hardlink-group", want: lead.rel });
          continue;
        }
        leaderDst.set(key, { rel: want.rel, ...idOf(st0) });
        const wantHash = hashes?.get(want.rel);
        if (wantHash === undefined) {
          push({ rel: want.rel, what: "no-hash" });
          continue;
        }
        const h = hashFd(fd, buf, onBytes);
        _hooks?.afterHash?.(want.rel);
        const st1 = fstatBig(fd);
        if (!sameVersion(st0, st1)) push({ rel: want.rel, what: "unstable" });
        if (h !== wantHash) push({ rel: want.rel, what: "sha256", want: wantHash, got: h });
      } catch (e) {
        push({ rel: want.rel, what: `read:${e.code ?? e.message}` });
      } finally {
        closeQuiet(fd);
      }
    }
    // final re-check: the destination must still be exactly what was observed
    if (diffs.length === 0) {
      let fresh;
      try {
        fresh = walkTree(dst, { expectRoot: idOf(rootSt) });
      } catch (e) {
        push({ rel: "", what: `recheck:${e.code ?? e.message}` });
      }
      if (fresh) {
        const snap = { rootId: idOf(rootSt), rootMntId: dstMnt, entries: observed, walkProblems: [] };
        for (const d of compareBaselines(snap, fresh, { max: 20 }))
          push({ rel: d.rel, what: "changed-after-check", got: d.kind + (d.fields ? `:${d.fields.join(",")}` : "") });
      }
    }
  } finally {
    for (const f of frames) if (f.fd !== rootFd) closeQuiet(f.fd);
    closeQuiet(rootFd);
  }
  onProgress?.({ units, bytes });
  return { ok: diffs.length === 0, diffs, checked: units };
}

// ───────────────────────────── persistence barrier ─────────────────────────────

function isIdTarget(t) {
  return (
    t &&
    typeof t === "object" &&
    typeof t.path === "string" &&
    path.isAbsolute(t.path) &&
    t.dev !== undefined &&
    t.ino !== undefined
  );
}

/**
 * §1.5 / §1.4 step 11, fail-closed. Every target is {path, dev, ino}: the path is opened
 * O_DIRECTORY|O_NOFOLLOW and must be that exact directory (I4) before anything is synced.
 *   syncfs   : `sync -f -- /proc/<pid>/fd/<fd>` (coreutils syncfs(2) on the PINNED directory's
 *              filesystem, XC9) — pass realCipher: gocryptfs already handed every write to the
 *              backend, so this persists all ciphertext data + directory entries of that filesystem
 *   fsyncDirs: fsync(2) of each pinned directory (`<dir>`, `<mnt>`'s parent, `.txn/`)
 * Both lists must be non-empty (an empty barrier is never a persistence proof). Any mismatch /
 * failure / timeout ⇒ ok:false. → {ok, steps:[{what, path, ok, detail?}], reason?}
 */
export function syncBarrier({ syncfs = [], fsyncDirs = [], syncBin = "sync", timeoutMs = TREE_BUDGET.syncMs } = {}) {
  const steps = [];
  if (!Array.isArray(syncfs) || !Array.isArray(fsyncDirs) || syncfs.length === 0 || fsyncDirs.length === 0)
    return { ok: false, steps, reason: "empty-spec" };
  if (![...syncfs, ...fsyncDirs].every(isIdTarget)) return { ok: false, steps, reason: "bad-target" };
  const pinTarget = (t) => {
    const fd = fs.openSync(t.path, DIR_READ);
    if (!sameId(fstatBig(fd), t)) {
      closeQuiet(fd);
      throw new TreeError("identity", `不是预期的目录：${t.path}`);
    }
    return fd;
  };
  for (const t of syncfs) {
    let fd;
    try {
      fd = pinTarget(t);
      const r = spawnSync(syncBin, ["-f", "--", childFdPath(fd)], {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        stdio: ["ignore", "ignore", "pipe"],
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
      });
      const ok = !r.error && r.status === 0;
      steps.push({
        what: "syncfs",
        path: t.path,
        ok,
        ...(ok
          ? {}
          : {
              detail: r.error ? String(r.error.code ?? r.error.message) : `exit ${r.status} ${r.stderr ?? ""}`.trim(),
            }),
      });
      if (!ok) return { ok: false, steps, reason: "syncfs" };
    } catch (e) {
      steps.push({
        what: "syncfs",
        path: t.path,
        ok: false,
        detail: e instanceof TreeError ? e.code : String(e.code ?? e.message),
      });
      return { ok: false, steps, reason: "syncfs" };
    } finally {
      closeQuiet(fd);
    }
  }
  for (const t of fsyncDirs) {
    let fd;
    try {
      fd = pinTarget(t);
      fs.fsyncSync(fd);
      steps.push({ what: "fsync-dir", path: t.path, ok: true });
    } catch (e) {
      steps.push({
        what: "fsync-dir",
        path: t.path,
        ok: false,
        detail: e instanceof TreeError ? e.code : String(e.code ?? e.message),
      });
      return { ok: false, steps, reason: "fsync-dir" };
    } finally {
      closeQuiet(fd);
    }
  }
  return { ok: true, steps };
}

/** {path, dev, ino} of a directory, for syncBarrier targets (the caller records it when it is known-good). */
export function dirTarget(p) {
  const st = lstatBig(p);
  if (!st.isDirectory()) throw new TreeError("not-dir", `不是目录：${p}`);
  return { path: p, ...idOf(st) };
}

// ───────────────────────────── prerequisites ─────────────────────────────

/**
 * Behavioural probe of the tools V2 relies on (missing ⇒ exit 69). Creates ONE private directory
 * (mkdtemp, 0700) under `scratchParent` and inside it only two EMPTY directories `a` and `b` — no
 * file is ever created. `mv -n -T` must leave the existing empty `b` untouched, then (through
 * renameNoReplace) move `a` onto the never-used name `c` (judged by inode — no rmdir is needed in
 * between); `sync -f` must succeed on the pinned directory; getfattr must be on PATH.
 *
 * Cleanup (I1 — "never deletes data this call did not create"): non-recursive; it only runs while
 * the temp dir still sits at its name under the pinned `scratchParent` fd, removes each directory
 * with rmdirOwned (inode check, then rmdir of an EMPTY directory) and STOPS at the first mismatch or
 * failure; everything not removed is reported in `leftover`. Accepted residual (V2 r2 ruling): the
 * lstat→rmdir pair is not atomic, so a same-uid process racing exactly in that window (targeted —
 * outside the threat model; the temp dir is our own 0700 mkdtemp) could get an EMPTY directory it
 * swapped in removed. No file data can ever be lost (rmdir refuses non-empty directories).
 * → {ok, missing:[…], leftover:[paths]}
 */
export async function probeTreeTools({
  scratchParent,
  mvBin = "mv",
  syncBin = "sync",
  getfattrBin = "getfattr",
  envPath,
  _hooks,
} = {}) {
  const missing = [];
  const leftover = [];
  if (!findOnPath(getfattrBin, envPath)) missing.push("getfattr");
  if (!findOnPath(syncBin, envPath)) missing.push("sync");
  if (!findOnPath(mvBin, envPath)) missing.push("mv");
  if (missing.includes("mv") || missing.includes("sync")) return { ok: false, missing, leftover };
  const parentFd = fs.openSync(scratchParent, DIR_READ);
  const parentId = idOf(fstatBig(parentFd));
  let tmpFd;
  let tmpName;
  let tmpId;
  const created = []; // {name, id} inside tmp, in creation order
  try {
    const made = fs.mkdtempSync(fdAt(parentFd, ".pi-secure-probe-"));
    tmpName = path.basename(made);
    tmpFd = fs.openSync(fdAt(parentFd, tmpName), DIR_READ);
    tmpId = idOf(fstatBig(tmpFd));
    fs.fchmodSync(tmpFd, 0o700);
    for (const n of ["a", "b"]) {
      fs.mkdirSync(fdAt(tmpFd, n), 0o700);
      created.push({ name: n, id: idOf(lstatBig(fdAt(tmpFd, n))) });
    }
    _hooks?.afterCreate?.(path.join(scratchParent, tmpName));
    const tmpPath = path.join(scratchParent, tmpName);
    const a = created[0].id;
    // the real mv against an EXISTING empty target, run inside the pinned tmp dir
    const raw = spawnSync(mvBin, ["-n", "-T", "--", "a", "b"], {
      cwd: childFdPath(tmpFd),
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    const aStill = lstatBigOrNull(fdAt(tmpFd, "a"));
    const bNow = lstatBigOrNull(fdAt(tmpFd, "b"));
    const bEmpty = bNow && sameId(bNow, created[1].id) && fs.readdirSync(fdAt(tmpFd, "b")).length === 0;
    if (raw.error || !aStill || !sameId(aStill, a) || !bEmpty) missing.push("mv -n -T");
    else {
      const r2 = await renameNoReplace({ parent: tmpPath, from: "a", to: "c", expect: a, expectParent: tmpId, mvBin });
      if (r2.ok) created[0].name = "c";
      else missing.push("mv -n -T");
    }
    const s = spawnSync(syncBin, ["-f", "--", childFdPath(tmpFd)], {
      timeout: TREE_BUDGET.syncMs,
      killSignal: "SIGKILL",
    });
    if (s.error || s.status !== 0) missing.push("sync -f");
  } finally {
    if (tmpFd !== undefined) {
      const tmpPath = path.join(scratchParent, tmpName ?? "?");
      const parentOk = sameId(fstatBig(parentFd), parentId);
      const atName = lstatBigOrNull(fdAt(parentFd, tmpName));
      let stop = !parentOk || !atName || !sameId(atName, tmpId); // moved away ⇒ touch nothing
      for (const c of created.slice().reverse()) {
        if (!stop && rmdirOwned(tmpFd, c.name, c.id)) continue;
        stop = true;
        leftover.push(path.join(tmpPath, c.name));
      }
      closeQuiet(tmpFd);
      if (stop || !rmdirOwned(parentFd, tmpName, tmpId)) leftover.push(tmpPath);
    }
    closeQuiet(parentFd);
  }
  return { ok: missing.length === 0 && leftover.length === 0, missing, leftover };
}

/**
 * rmdir `<dirfd>/<name>` only if it still is the directory `id`, then confirm the name is gone.
 * rmdir never removes content. Residual: lstat→rmdir is not atomic (see probeTreeTools).
 */
function rmdirOwned(dirfd, name, id) {
  try {
    const st = lstatBig(fdAt(dirfd, name));
    if (!st.isDirectory() || !sameId(st, id)) return false;
    fs.rmdirSync(fdAt(dirfd, name));
    return lstatBigOrNull(fdAt(dirfd, name)) === null;
  } catch {
    return false;
  }
}

// ───────────────────────────── combined check (worker op "check") ─────────────────────────────

/**
 * Everything V2 owns of §1.3 on one tree, as ONE consistent snapshot: mountinfo → fd-anchored walk
 * M1 (per-directory mount ids) → per-entry rules → fd-anchored xattr scan → second walk M2 that must
 * equal M1 field by field (incl. ctime: every xattr change, chmod, write or rename of an inode moves
 * it) → mountinfo again; mounts found in EITHER mountinfo read count. The returned `manifest` is the
 * checked snapshot and MUST be used as the convert baseline (step 6) — never take a fresh baseline
 * after checking. V4 adds path/git/occupancy rules.
 * `linkRoots`: ORIGINAL location spellings (absolute-link classification); `extraRoots`: more mount
 * spellings; `mountinfo`/`mountinfoAfter`: injectable texts (tests).
 * → {manifest, problems, counts, total, truncated, warnings, gitEntries, summary, estimate, exit}
 */
export function checkTree(
  root,
  {
    uid,
    gid,
    linkRoots = [root],
    extraRoots = [],
    mountinfo,
    mountinfoAfter,
    getfattrBin,
    envPath,
    expectRoot,
    onProgress,
    _hooks,
  } = {},
) {
  const mi0 = mountinfo ?? readMountinfo();
  const m1 = walkTree(root, { onProgress, expectRoot });
  const rules = checkTreeRules(m1, { uid, gid, linkRoots });
  const P = createProblems();
  P.addAll(rules.problems);
  const xa = scanXattrs(m1, { bin: getfattrBin, envPath, onProgress, _hooks });
  if (xa.kind === "missing") P.add({ code: "prereq", detail: "getfattr（attr 包）" });
  else P.addAll(xa.problems);
  _hooks?.beforeRecheck?.();
  const m2 = walkTree(root, { onProgress, expectRoot: m1.rootId });
  for (const d of compareBaselines(m1, m2, { max: 50 }))
    P.add({ code: "changed-during-check", rel: d.rel, detail: d.kind + (d.fields ? `:${d.fields.join(",")}` : "") });
  const mi1 = mountinfoAfter ?? (mountinfo !== undefined ? mountinfo : readMountinfo());
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    /* keep literal */
  }
  const seen = new Set();
  for (const p of [
    ...mountProblems(mi0, [root, real, ...extraRoots]),
    ...mountProblems(mi1, [root, real, ...extraRoots]),
  ]) {
    if (seen.has(p.path)) continue;
    seen.add(p.path);
    P.add(p);
  }
  const res = P.result();
  for (const [k, v] of Object.entries(rules.counts)) {
    const listed = rules.problems.filter((p) => p.code === k).length;
    res.counts[k] = (res.counts[k] ?? 0) + (v - listed);
    res.total += v - listed;
  }
  if (xa.kind === "ok")
    for (const [k, v] of Object.entries(xa.counts)) {
      const listed = xa.problems.filter((p) => p.code === k).length;
      res.counts[k] = (res.counts[k] ?? 0) + (v - listed);
      res.total += v - listed;
    }
  res.truncated = res.total > res.problems.length;
  return {
    manifest: m2,
    ...res,
    warnings: rules.warnings,
    gitEntries: gitEntries(m2),
    summary: manifestSummary(m2),
    estimate: estimateVaultUsage(m2),
    exit: problemsExit(res),
  };
}

// ───────────────────────────── worker protocol ─────────────────────────────

/*
 * Wire protocol (one process per op, own process group):
 *   argv   : <node> <tree.mjs> __tree-work <op>   (or helper.mjs __convert-work <op> → workerMain)
 *   stdin  : one JSON spec object, then EOF
 *   stdout : JSON lines —
 *              {"t":"progress","op":…,"units":n,"bytes":b}   cumulative, strictly increasing
 *              {"t":"result","op":…,"ok":true,"result":{…}}   exactly once on success
 *              {"t":"error","op":…,"code":"…","exit":n,"message":"…"} exactly once on failure
 *   exit   : 0 result · 1 error · 2 unknown op (spec not read)
 * Large outputs go to files named in the spec (manifest/hashes: exclusive 0600 NDJSON + fsync).
 */
export const WORKER_OPS = Object.freeze([
  "check",
  "freeze",
  "restore-modes",
  "baseline",
  "compare-baseline",
  "copy",
  "verify",
  "sync",
]);

function needAbs(spec, k) {
  const v = spec[k];
  if (typeof v !== "string" || !path.isAbsolute(v))
    throw new TreeError("bad-spec", `spec.${k} 必须是绝对路径`, { exit: 1 });
  return v;
}

function optId(spec, k) {
  const v = spec[k];
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || v.dev === undefined || v.ino === undefined)
    throw new TreeError("bad-spec", `spec.${k} 必须是 {dev, ino}`, { exit: 1 });
  return { dev: String(v.dev), ino: String(v.ino) };
}

/** Phase-local progress counters → one cumulative, strictly increasing stream (no-delta ticks dropped). */
function cumulativeProgress(op, emit) {
  let units = 0;
  let bytes = 0;
  let lastU = 0;
  let lastB = 0;
  return (p) => {
    const u = Number(p.units ?? 0);
    const b = Number(p.bytes ?? 0);
    const du = u >= lastU ? u - lastU : u;
    const db = b >= lastB ? b - lastB : b;
    lastU = u;
    lastB = b;
    if (du <= 0 && db <= 0) return;
    units += Math.max(0, du);
    bytes += Math.max(0, db);
    emit({ t: "progress", op, units, bytes });
  };
}

/**
 * Execute one op in-process (the worker body; also directly callable in tests). `emit(obj)` gets
 * progress objects. Returns the JSON-safe result; throws TreeError.
 *   check            {root, expectRoot?, linkRoots?, extraRoots?, uid?, gid?, getfattrBin?, manifestOut?}
 *                    → checkTree result minus manifest (manifestOut = THE baseline file)
 *   freeze           {root, modesFile, expectRoot?}            → {entries, changed, rootId}
 *   restore-modes    {root, modesFile}                         → restoreModes result
 *   baseline         {root, manifestOut, expectRoot?}          → {entries, rootId, walkProblems}
 *   compare-baseline {root, baselineFile}                      → {diffs, same}
 *   copy             {src, dst, baselineFile, modesFile?, hashesOut, expectDst?, applyRootMeta?} → stats
 *   verify           {dst, baselineFile, modesFile?, hashesFile, expectDst?, applyRootMeta?}   → verifyCopy result
 *   sync             {syncfs:[{path,dev,ino}…], fsyncDirs:[{path,dev,ino}…], syncBin?, timeoutMs?}
 */
export async function runTreeOp(op, spec, emit = () => {}) {
  const onProgress = cumulativeProgress(op, emit);
  switch (op) {
    case "check": {
      const root = needAbs(spec, "root");
      const r = checkTree(root, {
        uid: spec.uid,
        gid: spec.gid,
        linkRoots: spec.linkRoots ?? [root],
        extraRoots: spec.extraRoots ?? [],
        getfattrBin: spec.getfattrBin,
        expectRoot: optId(spec, "expectRoot"),
        onProgress,
      });
      const { manifest, ...rest } = r;
      if (spec.manifestOut) writeManifestFile(needAbs(spec, "manifestOut"), manifest);
      return { ...rest, rootId: manifest.rootId };
    }
    case "freeze":
      return freezeTree(needAbs(spec, "root"), needAbs(spec, "modesFile"), {
        expectRoot: optId(spec, "expectRoot"),
        onProgress,
      });
    case "restore-modes":
      return restoreModes(needAbs(spec, "root"), needAbs(spec, "modesFile"), { onProgress });
    case "baseline": {
      const m = takeBaseline(needAbs(spec, "root"), { onProgress, expectRoot: optId(spec, "expectRoot") });
      writeManifestFile(needAbs(spec, "manifestOut"), m);
      return { entries: m.entries.length, rootId: m.rootId, walkProblems: m.walkProblems };
    }
    case "compare-baseline": {
      const a = readManifestFile(needAbs(spec, "baselineFile"));
      const b = takeBaseline(needAbs(spec, "root"), { onProgress, expectRoot: a.rootId });
      const diffs = compareBaselines(a, b);
      return { same: diffs.length === 0, diffs };
    }
    case "copy": {
      const baseline = readManifestFile(needAbs(spec, "baselineFile"));
      const modes = spec.modesFile ? readModesFile(needAbs(spec, "modesFile")).records : undefined;
      const r = copyTree({
        src: needAbs(spec, "src"),
        dst: needAbs(spec, "dst"),
        baseline,
        modes,
        expectDst: optId(spec, "expectDst"),
        applyRootMeta: spec.applyRootMeta !== false,
        onProgress,
      });
      writeHashesFile(needAbs(spec, "hashesOut"), r.hashes);
      const { hashes, ...stats } = r;
      return { ...stats, hashed: hashes.size };
    }
    case "verify": {
      const baseline = readManifestFile(needAbs(spec, "baselineFile"));
      const modes = spec.modesFile ? readModesFile(needAbs(spec, "modesFile")).records : undefined;
      return verifyCopy({
        dst: needAbs(spec, "dst"),
        baseline,
        modes,
        hashes: readHashesFile(needAbs(spec, "hashesFile")),
        expectDst: optId(spec, "expectDst"),
        applyRootMeta: spec.applyRootMeta !== false,
        onProgress,
      });
    }
    case "sync": {
      const r = syncBarrier({
        syncfs: spec.syncfs,
        fsyncDirs: spec.fsyncDirs,
        syncBin: spec.syncBin,
        timeoutMs: spec.timeoutMs,
      });
      if (!r.ok)
        throw Object.assign(
          new TreeError("barrier", `持久化屏障失败：${r.reason ?? ""} ${JSON.stringify(r.steps.at(-1) ?? {})}`),
          {
            steps: r.steps,
          },
        );
      return r;
    }
    default:
      throw new TreeError("bad-op", `未知 tree worker op：${op}`, { exit: 1 });
  }
}

async function readAllStdin(stream) {
  const chunks = [];
  let n = 0;
  for await (const c of stream) {
    n += c.length;
    if (n > 16 * MiB) throw new TreeError("bad-spec", "worker spec 过大", { exit: 1 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Worker entry: read spec from stdin, run, print JSON lines. → exit code (0/1). */
export async function workerMain(op, { stdin = process.stdin, write = (s) => fs.writeSync(1, s) } = {}) {
  const emit = (o) => write(`${JSON.stringify(o)}\n`);
  try {
    let spec;
    try {
      spec = JSON.parse(await readAllStdin(stdin));
    } catch (e) {
      throw e instanceof TreeError ? e : new TreeError("bad-spec", "worker spec 不是 JSON", { exit: 1 });
    }
    if (!spec || typeof spec !== "object" || Array.isArray(spec))
      throw new TreeError("bad-spec", "worker spec 不是对象", { exit: 1 });
    const result = await runTreeOp(op, spec, emit);
    emit({ t: "result", op, ok: true, result });
    return 0;
  } catch (e) {
    const te = asTreeError(e);
    emit({
      t: "error",
      op,
      code: te.code,
      exit: te.exit,
      message: te.message,
      ...(te.rel !== undefined ? { rel: te.rel } : {}),
    });
    return 1;
  }
}

export const selfPath = () => fileURLToPath(import.meta.url);

/** Default worker argv: this file as the entry. V6 may pass [node, helper.mjs, "__convert-work", op]. */
export function treeWorkerArgv(op, nodeBin = process.execPath) {
  return [nodeBin, selfPath(), "__tree-work", op];
}

/** starttime (clock ticks since boot, /proc/<pid>/stat field 22) as a decimal string; undefined if unreadable. */
export function readProcStart(pid, procRoot = "/proc") {
  try {
    const text = fs.readFileSync(`${procRoot}/${pid}/stat`, "utf8");
    const f = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return /^\d+$/.test(f[19] ?? "") ? f[19] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * FAIL-CLOSED scan of process group `pgid` (I5). → {complete, members:[{pid, start}], leader?}
 *   complete=false when /proc cannot be enumerated, or ANY pid's stat cannot be read for a reason
 *   other than "the process is gone" (ENOENT/ESRCH), or cannot be parsed — an unknown scan is
 *   never folded into "the group is empty".
 *   members: live (non-zombie) processes whose pgrp is `pgid`; leader: the process whose pid IS
 *   `pgid` (any state, incl. an unreaped zombie), with its starttime.
 */
export function scanGroup(pgid, procRoot = "/proc") {
  const members = [];
  let leader;
  let complete = true;
  let names;
  try {
    names = fs.readdirSync(procRoot);
  } catch {
    return { complete: false, members, leader };
  }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let text;
    try {
      text = fs.readFileSync(`${procRoot}/${n}/stat`, "utf8");
    } catch (e) {
      if (e && (e.code === "ENOENT" || e.code === "ESRCH")) continue; // gone between readdir and read
      complete = false;
      continue;
    }
    const close = text.lastIndexOf(")");
    const f = close < 0 ? [] : text.slice(close + 2).split(" ");
    // f[0] state, f[1] ppid, f[2] pgrp, …, f[19] starttime
    if (f.length < 20 || !/^\d+$/.test(f[2] ?? "") || !/^\d+$/.test(f[19] ?? "")) {
      complete = false;
      continue;
    }
    const pid = Number(n);
    if (pid === pgid) leader = { state: f[0], start: f[19] };
    if (Number(f[2]) === pgid && f[0] !== "Z" && f[0] !== "X") members.push({ pid, start: f[19] });
  }
  return { complete, members, leader };
}

/** pids of the live members of `pgid` — or null when the scan was incomplete (never "empty" on doubt). */
export function groupMembers(pgid, procRoot = "/proc") {
  const s = scanGroup(pgid, procRoot);
  return s.complete ? s.members.map((m) => m.pid) : null;
}

/**
 * May we signal process group `pgid` and be sure it is still the group of the child we spawned?
 *   • the leader is not reaped yet (its pid — hence the pgid — cannot be reused), or
 *   • a COMPLETE scan shows live members with pgrp = pgid that started no earlier than the leader,
 *     and no different process now owns the pid = pgid (a pid still used as a pgid is not reusable).
 */
function pgidStillOurs({ leaderReaped, leaderStart, scan }) {
  if (!leaderReaped) return true;
  if (!scan.complete || scan.members.length === 0 || leaderStart === undefined) return false;
  if (scan.leader && scan.leader.start !== leaderStart) return false;
  return scan.members.every((m) => BigInt(m.start) >= BigInt(leaderStart));
}

/**
 * Kill the group and prove it is empty (shared by superviseWorker and runChild). Polls until a
 * COMPLETE scan shows no live member, sending SIGKILL whenever pgidStillOurs; at `deadline` gives up.
 * Timers are ref'd (bounded). → Promise<{clean, leftover:[pid], scan:"complete"|"incomplete", killed}>
 */
function reapGroup({ pgid, deadline, procRoot = "/proc", state }) {
  return new Promise((resolve) => {
    let killed = false;
    const poll = () => {
      const scan = scanGroup(pgid, procRoot);
      const clean = scan.complete && scan.members.length === 0;
      if (clean || Date.now() >= deadline) {
        resolve({
          clean,
          leftover: scan.members.map((m) => m.pid),
          scan: scan.complete ? "complete" : "incomplete",
          killed,
        });
        return;
      }
      if (pgidStillOurs({ leaderReaped: state.leaderReaped, leaderStart: state.leaderStart, scan })) {
        try {
          process.kill(-pgid, "SIGKILL");
          killed = true;
        } catch {
          /* gone */
        }
      }
      setTimeout(poll, TREE_BUDGET.groupPollMs);
    };
    poll();
  });
}

const isPlainObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Run one worker op under the §5 supervision rules (I5). Own process group (detached ⇒ pgid = pid),
 * spec on stdin. Only STRICTLY increasing progress lines of this op reset the stall watchdog;
 * `stallMs` without one ⇒ SIGTERM the group, +killGraceMs ⇒ cleanup. Cleanup ALWAYS runs before the
 * promise settles — also after a normal exit (a worker's leftover descendants are killed too): scan
 * /proc for live members of the group, SIGKILL the group while any exist, poll until it is empty or
 * killGraceMs+abandonMs passed. Members still alive then (e.g. D-state) ⇒ {kind:"unclean"} wrapping
 * the outcome — callers treat it as UNKNOWN. Terminal lines are validated: op must match, a result
 * must be {ok:true, result:{…}} on exit 0, an error must carry a string code; anything else ⇒
 * {kind:"error", code:"protocol"}. Cleanup timers are ref'd (bounded) so the process cannot exit
 * with the promise unsettled.
 * → {kind:"result", result, progress} | {kind:"error", code, exit, message, rel?, progress}
 *   | {kind:"stalled", progress} | {kind:"crashed", code, signal, stderr, progress}
 *   | {kind:"unclean", outcome, leftover:[pid]} | {kind:"spawn-error", message}
 */
export function superviseWorker({
  op,
  spec,
  argv = treeWorkerArgv(op),
  env = process.env,
  stallMs = TREE_BUDGET.workerStallMs,
  killGraceMs = TREE_BUDGET.workerKillGraceMs,
  abandonMs = TREE_BUDGET.workerAbandonMs,
  onProgress,
  spawnImpl = spawn,
  procRoot = "/proc",
}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(argv[0], argv.slice(1), { cwd: "/", env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ kind: "spawn-error", message: String(e && e.message) });
      return;
    }
    const pgid = child.pid;
    const leaderState = {
      leaderReaped: false,
      leaderStart: pgid === undefined ? undefined : readProcStart(pgid, procRoot),
    };
    child.on("exit", () => {
      leaderState.leaderReaped = true;
    });
    let progress = { units: 0, bytes: 0, at: Date.now() };
    let result;
    let error;
    let protocol;
    let escalated; // "stalled" | "too-large"
    let outBytes = 0;
    let pending = "";
    let stderr = "";
    let settled = false;
    let cleaning = false;
    let killedByUs = false;
    let exitInfo;
    let stallTimer;
    const outcome = () => {
      if (escalated === "stalled") return { kind: "stalled", progress };
      if (escalated === "too-large")
        return { kind: "error", code: "output-too-large", exit: TREE_EXIT.IO, message: "worker 输出过大", progress };
      if (protocol) return { kind: "error", code: "protocol", exit: TREE_EXIT.IO, message: protocol, progress };
      if (result) {
        if (exitInfo && !killedByUs && exitInfo.code !== 0)
          return {
            kind: "error",
            code: "protocol",
            exit: TREE_EXIT.IO,
            message: `result 之后退出码 ${exitInfo.code}`,
            progress,
          };
        return { kind: "result", result: result.result, progress };
      }
      if (error)
        return {
          kind: "error",
          code: String(error.code),
          exit: Number.isSafeInteger(error.exit) ? error.exit : TREE_EXIT.IO,
          message: String(error.message ?? ""),
          ...(error.rel !== undefined ? { rel: String(error.rel) } : {}),
          progress,
        };
      return {
        kind: "crashed",
        code: exitInfo?.code ?? undefined,
        signal: exitInfo?.signal ?? undefined,
        stderr,
        progress,
      };
    };
    /** Signal the group only while it provably is still ours (see pgidStillOurs). */
    const killGroup = (sig) => {
      if (
        !pgidStillOurs({
          ...leaderState,
          scan: leaderState.leaderReaped ? scanGroup(pgid, procRoot) : { complete: false, members: [] },
        })
      )
        return;
      killedByUs = true;
      try {
        process.kill(-pgid, sig);
      } catch {
        /* gone */
      }
    };
    /** Kill + confirm the group is empty, then settle exactly once. */
    const cleanupAndSettle = () => {
      if (cleaning) return;
      cleaning = true;
      clearTimeout(stallTimer);
      reapGroup({ pgid, deadline: Date.now() + killGraceMs + abandonMs, procRoot, state: leaderState }).then((g) => {
        if (g.killed) killedByUs = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        child.unref();
        settled = true;
        const o = outcome();
        resolve(g.clean ? o : { kind: "unclean", outcome: o, leftover: g.leftover, scan: g.scan, killed: g.killed });
      });
    };
    const escalate = (why) => {
      if (escalated || cleaning) return;
      escalated = why;
      clearTimeout(stallTimer);
      killGroup("SIGTERM");
      setTimeout(cleanupAndSettle, killGraceMs); // ref'd; close of the leader does NOT cancel it
    };
    const arm = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (cleaning || escalated) return;
        if (result || error || protocol)
          cleanupAndSettle(); // reported, but the process lingers
        else escalate("stalled");
      }, stallMs);
      stallTimer.unref();
    };
    const terminal = (o, kind) => {
      if (result || error || protocol) {
        protocol = "重复的终态行";
        return;
      }
      if (o.op !== op) {
        protocol = `终态行 op 不符（${String(o.op)} ≠ ${op}）`;
        return;
      }
      if (kind === "result") {
        if (o.ok !== true || !isPlainObj(o.result)) protocol = "result 行结构无效";
        else result = o;
      } else if (typeof o.code !== "string" || o.code === "") protocol = "error 行结构无效";
      else error = o;
    };
    const onLine = (line) => {
      if (!line.trim().startsWith("{")) return;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        return;
      }
      if (!isPlainObj(o)) return;
      if (o.t === "progress") {
        if (o.op !== op || result || error) return;
        const u = Number(o.units);
        const b = Number(o.bytes ?? 0);
        if (!Number.isFinite(u) || !Number.isFinite(b) || u < 0 || b < 0) return;
        if (u > progress.units || b > progress.bytes) {
          progress = { units: Math.max(u, progress.units), bytes: Math.max(b, progress.bytes), at: Date.now() };
          onProgress?.(progress);
          if (!escalated && !cleaning) arm();
        }
      } else if (o.t === "result" || o.t === "error") {
        terminal(o, o.t);
        if (!escalated && !cleaning) arm();
      }
    };
    child.stdout.on("data", (b) => {
      if (settled) return;
      outBytes += b.length;
      if (outBytes > TREE_BUDGET.maxInlineResultBytes) {
        escalate("too-large");
        return;
      }
      pending += b.toString("utf8");
      let nl;
      while ((nl = pending.indexOf("\n")) >= 0) {
        onLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
    });
    child.stderr.on("data", (b) => {
      if (stderr.length < 16384) stderr += b.toString("utf8");
    });
    child.stdin.on("error", () => {
      /* worker died before reading — reported via close */
    });
    child.on("error", (e) => {
      if (exitInfo || cleaning) return;
      exitInfo = { code: undefined, signal: undefined };
      if (!escalated) {
        settled = true;
        clearTimeout(stallTimer);
        resolve({ kind: "spawn-error", message: String(e && e.message) });
      }
    });
    child.on("close", (code, signal) => {
      if (pending && !escalated) onLine(pending);
      pending = "";
      exitInfo = { code: code ?? undefined, signal: signal ?? undefined };
      if (escalated || settled) return; // the escalation timer owns cleanup
      cleanupAndSettle();
    });
    arm();
    child.stdin.end(JSON.stringify(spec ?? {}));
  });
}

// ───────────────────────────── entry ─────────────────────────────

let isEntry = false;
try {
  isEntry = !!process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
} catch {
  isEntry = false;
}
if (isEntry) {
  if (process.argv[2] !== "__tree-work" || !WORKER_OPS.includes(process.argv[3] ?? "")) {
    process.stderr.write("tree.mjs: 用法 __tree-work <op>（内部 worker 入口）\n");
    process.exit(2);
  }
  workerMain(process.argv[3]).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`tree.mjs: 内部错误：${e}\n`);
      process.exit(1);
    },
  );
}

// V5 (archive.mjs) reuses the reviewed group-reaping logic verbatim (export only, bodies unchanged).
export { pgidStillOurs, reapGroup };
