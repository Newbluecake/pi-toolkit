// pi-secure export / import / relocation transaction (convert-plan r3 §3.2–§3.5, package V5).
//
// Zero-dependency ESM, plain Node (same rules as helper.mjs). This module owns:
//   - cmdExport          §3.2  ciphertext-only package under `flock -o mount.lock` (worker), link() publish
//   - cmdImport          §3.3  claim name → validate+stage untrusted package → publish into self-made dirs → commit
//   - cmdImportAbort / cmdImportResume   §3.3 recovery table
//   - relocateVault      §3.4  stateful relocation (`relocate:{from,to,txid,phase}`), re-entrant; V6 wires it
//                              into `init --fix-settings`; cmdImport uses it for `--verify-password`
//   - verifyVaultPassword       `--verify-password` without an address change (mount + unmount only)
//   - listImportStates   status lines for V6's describeVault
// helper.mjs `main`/USAGE wiring is V6. The only CLI surface of this file is the INTERNAL worker entry
// `node archive.mjs __archive-work <op> <json>` (spawned by the supervisor below, never by users).
//
// Threat model (V2 ruling): the package is untrusted — including the DECRYPTED tree a relocation walks
// (the exporter chose the password, so every plaintext name/link inside the vault is attacker data);
// a targeted same-uid process is out of scope. Side-effecting helper ports and every host probe are
// INJECTED (`defaultPorts()`), so the transaction/recovery matrix is unit-testable without FUSE.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CliError,
  EXIT,
  V0_PORTS,
  VAULT_NAME_RE,
  checkLayout,
  defaultVaultDir,
  defaultVaultMnt,
  deriveVault,
  homeDir,
  loadSecureConfig,
  mntAncestorProblems,
  physicalPaths,
  positionProblems,
  probeMountState,
  readJsonFile,
  resolveVault,
  settingsFilePath,
  vaultInstanceView,
} from "./helper.mjs";
import { PkgError, discardStaging, readPackage, scanCipherTree, writePackage } from "./tar.mjs";
import { memorySlug, relocateSessionContent, stateSessionsDirFor } from "./sessions.mjs";
import { mntIdOf, readProcStart, reapGroup } from "./tree.mjs";

const fsc = fs.constants;
const SELF = fileURLToPath(import.meta.url);

/** convert-plan §6 codes used here (helper's EXIT has no 65/74/130). */
export const AX = Object.freeze({
  OK: 0,
  FAIL: 1,
  USAGE: 2,
  CONTENT: 65,
  NOT_FOUND: 66,
  PREREQ: 69,
  LOCK_BUSY: 73,
  IO: 74,
  DEADLINE: 75,
  BUSY: 76,
  BAD_PASSWORD: 77,
  CONFIG: 78,
  INTERRUPTED: 130,
});

/** §5 budgets. */
export const BUDGET = Object.freeze({
  stallMs: 60_000, // worker without progress ⇒ TERM
  termGraceMs: 2_000, // TERM → group SIGKILL (reapGroup)
  reapMs: 1_000, // SIGKILL polling until the group is provably empty, then give up (⇒ "unclean")
  mountLockWaitS: 10, // flock -w on mount.lock (export)
  txnLockWaitS: 10, // flock -w on .txn/import-<name>.lock (import / abort / resume)
  progressEveryMs: 1_000, // worker progress line throttle
  xattrScanMs: 60_000,
  xattrMaxEntries: 1_000_000,
  syncMs: 60_000,
  sessionFileMaxBytes: 256 * 1024 * 1024,
  projectSettingsMaxBytes: 1024 * 1024,
  exportSpaceFactor: 1.02,
  exportSpaceSlack: 1024 * 1024,
  importSpaceFactor: 1.05,
  importSpaceSlack: 64 * 1024 * 1024,
  stateFileMaxBytes: 64 * 1024,
});

const FLOCK_TIMEOUT_CODE = 73;
const TXID_RE = /^[0-9a-f]{24}$/;
const IMPORT_PHASES = ["claimed", "staging", "staged", "publishing", "published", "committed"];
export const RELOCATE_PHASES = ["pending", "sessions", "memory", "settings", "synced"];
const DIR_OPEN = fsc.O_RDONLY | fsc.O_DIRECTORY | fsc.O_NOFOLLOW;
const GOCRYPTFS_FSTYPE = "fuse.gocryptfs";

// ───────────────────────────── small fs helpers ─────────────────────────────

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p, { bigint: true });
  } catch {
    return null;
  }
}
/** dev+ino identity as strings (bigint-safe, JSON-serializable). */
function idOf(st) {
  return st ? { dev: String(st.dev), ino: String(st.ino) } : null;
}
function sameId(st, id) {
  return Boolean(st && id && String(st.dev) === id.dev && String(st.ino) === id.ino);
}
function fsyncDir(dir) {
  const fd = fs.openSync(dir, fsc.O_RDONLY | fsc.O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function closeQuiet(fd) {
  if (fd === undefined) return;
  try {
    fs.closeSync(fd);
  } catch {
    /* already closed */
  }
}
function createEmpty0600(p) {
  fs.closeSync(fs.openSync(p, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600));
}
function errCode(e) {
  return e && typeof e === "object" && typeof e.code === "string" ? e.code : String(e?.message ?? e);
}
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isAbs = (p) => typeof p === "string" && path.isAbsolute(p) && p.length <= 4096 && !p.includes("\0");

/** Any thrown value ⇒ {code, message}. PkgError keeps its 65/74, CliError its code, errno ⇒ 74. */
export function toFailure(e, fallback = AX.FAIL) {
  if (e instanceof PkgError) return { code: e.exitCode, message: `包内容不合格：${e.message}`, reason: e.reason };
  if (e instanceof CliError) return { code: e.code, message: e.message, ...(e.unclean ? { unclean: true } : {}) };
  if (e && typeof e === "object" && typeof e.code === "string" && typeof e.errno === "number")
    return { code: AX.IO, message: `IO 失败：${e.code}${e.path ? ` ${e.path}` : ""}` };
  if (e && typeof e === "object" && Number.isInteger(e.exitCode)) return { code: e.exitCode, message: e.message };
  return { code: fallback, message: String(e?.message ?? e) };
}
const fail = (code, message) => new CliError(code, message);

/**
 * Three-state registration lookup (review B3). Only `absent` — settings file READABLE, structure
 * valid, no such key — is a proof that the name is not registered; `no-file` (settings missing) and
 * `unknown` (unreadable / bad JSON / bad structure / non-object entry) never authorize a deletion.
 * → {kind:"present", entry} | {kind:"absent"} | {kind:"no-file"} | {kind:"unknown", reason}
 */
export function vaultEntryState(name, home = homeDir()) {
  const r = readJsonFile(settingsFilePath(home));
  if (r.kind === "missing") return { kind: "no-file" };
  if (r.kind !== "ok") return { kind: "unknown", reason: r.message };
  const root = r.value;
  if (!isPlain(root)) return { kind: "unknown", reason: "settings 顶层不是对象" };
  if (root.secure === undefined) return { kind: "absent" };
  if (!isPlain(root.secure)) return { kind: "unknown", reason: "secure 不是对象" };
  const vaults = root.secure.vaults;
  if (vaults === undefined) return { kind: "absent" };
  if (!isPlain(vaults)) return { kind: "unknown", reason: "secure.vaults 不是对象" };
  if (!Object.hasOwn(vaults, name)) return { kind: "absent" };
  const e = vaults[name];
  if (!isPlain(e)) return { kind: "unknown", reason: `secure.vaults.${name} 不是对象` };
  return { kind: "present", entry: e };
}
const unknownEntry = (name, es) =>
  fail(AX.CONFIG, `无法确认保险库 ${name} 的登记状态（${es.reason ?? es.kind}）——不做任何改动，请人工检查设置文件`);

// ───────────────────────────── xattr scan (§3.2, review M8) ─────────────────────────────

/** getfattr -d output ⇒ [{file, key}] — EVERY attribute counts (r3: any xattr refuses). */
export function parseGetfattr(text) {
  const found = [];
  let file = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("# file: ")) file = line.slice(8);
    else if (line.trim() !== "" && !line.startsWith("#")) found.push({ file, key: line.split("=")[0] });
  }
  return found;
}

// bounded, no-follow walk; argv only (never a shell); exit 3 ⇒ entry cap exceeded
const PY_XATTR = `
import os, sys, json
root, cap = sys.argv[1], int(sys.argv[2])
n, found = 0, []
def chk(p):
    global n
    n += 1
    if n > cap: sys.exit(3)
    for k in os.listxattr(p, follow_symlinks=False):
        found.append([p, k])
def boom(e): raise e
chk(root)
for d, dirs, files in os.walk(root, followlinks=False, onerror=boom):
    for x in dirs + files: chk(os.path.join(d, x))
print(json.dumps({"n": n, "total": len(found), "found": found[:16]}))
`;

/**
 * Complete xattr scan of `dir` → [{file, key}] (empty ⇔ provably none). getfattr when installed —
 * any non-zero exit / signal / timeout / overflow ⇒ 74 (never "no xattrs"); getfattr missing ⇒
 * python3 os.listxattr fallback (same strictness); neither ⇒ 69 (install attr).
 */
export function scanCipherXattrs(
  dir,
  {
    getfattrBin = "getfattr",
    pythonBin = "python3",
    timeoutMs = BUDGET.xattrScanMs,
    maxEntries = BUDGET.xattrMaxEntries,
  } = {},
) {
  const opts = { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
  const g = spawnSync(getfattrBin, ["-R", "-h", "-d", "-m", "-", "--absolute-names", "--", dir], opts);
  if (!(g.error && g.error.code === "ENOENT")) {
    if (g.error || g.signal || g.status !== 0)
      throw fail(
        AX.IO,
        `getfattr 扫描失败（${g.error ? errCode(g.error) : g.signal ? `signal ${g.signal}` : `exit ${g.status}`}：${String(
          g.stderr ?? "",
        )
          .trim()
          .slice(0, 300)}）——无法证明密文无扩展属性，拒绝导出`,
      );
    return parseGetfattr(g.stdout ?? "");
  }
  const p = spawnSync(pythonBin, ["-I", "-c", PY_XATTR, dir, String(maxEntries)], opts);
  if (p.error && p.error.code === "ENOENT")
    throw fail(
      AX.PREREQ,
      "无法检查密文的扩展属性：getfattr 与 python3 都不可用——请安装 attr 包（sudo apt install attr）",
    );
  if (p.error || p.signal || p.status !== 0)
    throw fail(
      AX.IO,
      `扩展属性扫描（python3）失败（${p.error ? errCode(p.error) : p.signal ? `signal ${p.signal}` : `exit ${p.status}`}）——拒绝导出`,
    );
  let r;
  try {
    r = JSON.parse(String(p.stdout).trim().split("\n").pop() ?? "");
  } catch {
    throw fail(AX.IO, "扩展属性扫描（python3）输出无法解析——拒绝导出");
  }
  if (!r || !Number.isInteger(r.total) || !Array.isArray(r.found)) throw fail(AX.IO, "扩展属性扫描输出无效——拒绝导出");
  const found = r.found.map(([file, key]) => ({ file: String(file), key: String(key) }));
  for (let i = found.length; i < r.total; i++) found.push({ file: "…", key: "…" });
  return found;
}

// ───────────────────────────── default ports ─────────────────────────────

function defaultStatfsFree(p) {
  // nearest existing ancestor (the target itself may not exist yet)
  let cur = path.resolve(p);
  for (;;) {
    try {
      const s = fs.statfsSync(cur);
      return Number(s.bavail) * Number(s.bsize);
    } catch (e) {
      const up = path.dirname(cur);
      if (errCode(e) !== "ENOENT" || up === cur) throw e;
      cur = up;
    }
  }
}

function defaultGocryptfsVersion() {
  const r = spawnSync("gocryptfs", ["-version"], {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = String(r.stdout ?? "")
    .split("\n")[0]
    .trim();
  return /^[\x20-\x7e]{1,200}$/.test(line) ? line : "unknown";
}

/** The real port set. Tests replace any subset. */
export function defaultPorts() {
  return {
    ...V0_PORTS,
    probeMountState,
    vaultInstanceView,
    runWorker: spawnWorker,
    txnLock: acquireTxnLock,
    isTTY: () => Boolean(process.stdin.isTTY && process.stderr.isTTY),
    txid: () => randomBytes(12).toString("hex"),
    now: () => new Date(),
    gocryptfsVersion: defaultGocryptfsVersion,
    statfsFree: defaultStatfsFree,
    onInterrupt: (cb) => {
      process.on("SIGINT", cb);
      return () => process.off("SIGINT", cb);
    },
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`pi-secure: ${s}\n`),
  };
}
function withPorts(p) {
  return { ...defaultPorts(), ...(p ?? {}) };
}

// ───────────────────────────── per-transaction lock (review B2) ─────────────────────────────

export function txnLockPath(name, home = homeDir()) {
  return path.join(txnDir(home), `import-${name}.lock`);
}

/**
 * Exclusive lock for ONE import transaction (`.txn/import-<name>.lock`), held by a
 * `flock -x -w <s> <lock> sh -c 'read'` holder whose stdin is our pipe: release = close the pipe; if
 * this process dies (even SIGKILL) the pipe EOFs and the holder exits, so a crash never wedges the
 * lock. import, abort and resume all take it before reading the state and keep it until done.
 * → Promise<{release()}>; rejects CliError 73 (busy after `waitS`), 69 (no flock), 78 (bad lock file).
 */
export function acquireTxnLock(name, home = homeDir(), { waitS = BUDGET.txnLockWaitS } = {}) {
  ensureTxnDir(home);
  const file = txnLockPath(name, home);
  const fd = fs.openSync(file, fsc.O_RDONLY | fsc.O_CREAT | fsc.O_NOFOLLOW | fsc.O_NONBLOCK, 0o600);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid()) throw fail(AX.CONFIG, `事务锁文件 ${file} 不是本用户的普通文件`);
  } finally {
    fs.closeSync(fd);
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(
        "flock",
        ["-x", "-w", String(waitS), "-E", String(FLOCK_TIMEOUT_CODE), file, "sh", "-c", "echo locked; read _ || true"],
        { detached: true, cwd: "/", stdio: ["pipe", "pipe", "ignore"] },
      );
    } catch (e) {
      reject(fail(AX.PREREQ, `无法执行 flock：${errCode(e)}`));
      return;
    }
    let out = "";
    let held = false;
    const guard = setTimeout(
      () => {
        if (held) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* gone */
        }
        reject(fail(AX.LOCK_BUSY, `等待 ${name} 的导入事务锁超时`));
      },
      (waitS + 5) * 1000,
    );
    child.on("error", (e) => {
      clearTimeout(guard);
      reject(fail(AX.PREREQ, `无法执行 flock：${errCode(e)}`));
    });
    child.stdout.on("data", (b) => {
      out += b.toString();
      if (!held && out.includes("locked")) {
        held = true;
        clearTimeout(guard);
        child.stdout.destroy();
        child.unref();
        child.stdin.unref?.();
        let released = false;
        resolve({
          release() {
            if (released) return;
            released = true;
            try {
              child.stdin.end();
            } catch {
              /* gone */
            }
          },
        });
      }
    });
    child.on("exit", (code) => {
      if (held) return;
      clearTimeout(guard);
      reject(
        code === FLOCK_TIMEOUT_CODE
          ? fail(AX.LOCK_BUSY, `另一个 pi-secure import/abort/resume 正在处理 ${name}（事务锁等待 ${waitS} 秒超时）`)
          : fail(AX.PREREQ, `事务锁 flock 异常退出（${code}）`),
      );
    });
  });
}

// ───────────────────────────── worker supervision (§5, review M6) ─────────────────────────────

/**
 * Run `node archive.mjs __archive-work <op> <json>` in its own process group (optionally under
 * `flock -o -E 73 -w 10 <lockFile>`). Every stdout line is JSON: `{"p":…}` progress (resets the stall
 * watchdog), `{"ok":result}` / `{"err":{code,message,reason?}}` final. 60 s without a line (or
 * `signal` aborted) ⇒ SIGTERM the group; termGraceMs later the reviewed tree.mjs `reapGroup` SIGKILLs
 * the group while it provably is still ours and polls until a COMPLETE /proc scan shows it empty —
 * a leader exiting on TERM does NOT cancel this (I5). The same reap also runs after a normal close
 * (leftover descendants). Not provably empty ⇒ `{kind:"unclean", outcome, leftover}` (outcome
 * unknown — callers must not run destructive rollbacks on it). Never throws.
 * → {kind:"ok",result} | {kind:"err",code,message,reason?} | {kind:"lock-busy"} | {kind:"stalled"}
 *   | {kind:"aborted"} | {kind:"died",status,signal,stderr} | {kind:"unclean",outcome,leftover}
 */
export function spawnWorker(
  op,
  payload,
  {
    lockFile,
    stallMs = BUDGET.stallMs,
    termGraceMs = BUDGET.termGraceMs,
    reapMs = BUDGET.reapMs,
    onProgress,
    signal,
    env,
  } = {},
) {
  const nodeArgs = ["--max-old-space-size=1024", SELF, "__archive-work", op, JSON.stringify(payload)];
  const [cmd, args] = lockFile
    ? [
        "flock",
        [
          "-o",
          "-E",
          String(FLOCK_TIMEOUT_CODE),
          "-w",
          String(BUDGET.mountLockWaitS),
          lockFile,
          process.execPath,
          ...nodeArgs,
        ],
      ]
    : [process.execPath, nodeArgs];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        detached: true,
        cwd: "/",
        stdio: ["ignore", "pipe", "pipe"],
        env: env ?? process.env,
      });
    } catch (e) {
      resolve({ kind: "err", code: AX.PREREQ, message: `无法启动 worker：${errCode(e)}` });
      return;
    }
    const pgid = child.pid;
    const leaderState = { leaderReaped: false, leaderStart: pgid === undefined ? undefined : readProcStart(pgid) };
    let final;
    let exitInfo;
    let buf = "";
    let stderr = "";
    let escalated; // "stalled" | "aborted"
    let finishing = false;
    let stall;
    const outcome = () => {
      if (escalated) return { kind: escalated };
      if (final && "ok" in final) return { kind: "ok", result: final.ok };
      if (final && "err" in final) {
        const e = isPlain(final.err) ? final.err : {};
        return {
          kind: "err",
          code: Number.isInteger(e.code) ? e.code : AX.FAIL,
          message: String(e.message ?? "worker 失败"),
          ...(e.reason ? { reason: String(e.reason) } : {}),
        };
      }
      if (lockFile && exitInfo?.status === FLOCK_TIMEOUT_CODE) return { kind: "lock-busy" };
      return {
        kind: "died",
        status: exitInfo?.status ?? null,
        signal: exitInfo?.signal ?? null,
        stderr: stderr.trim().slice(0, 2000),
      };
    };
    const finish = () => {
      if (finishing) return;
      finishing = true;
      clearTimeout(stall);
      signal?.removeEventListener?.("abort", onAbort);
      if (pgid === undefined) return resolve(outcome());
      reapGroup({ pgid, deadline: Date.now() + reapMs, state: leaderState }).then((g) => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        const o = outcome();
        resolve(g.clean ? o : { kind: "unclean", outcome: o, leftover: g.leftover, scan: g.scan });
      });
    };
    const escalate = (why) => {
      if (escalated || finishing) return;
      escalated = why;
      clearTimeout(stall);
      if (!leaderState.leaderReaped)
        try {
          process.kill(-pgid, "SIGTERM");
        } catch {
          /* gone */
        }
      setTimeout(finish, termGraceMs); // ref'd; the leader's close never cancels it
    };
    const arm = () => {
      clearTimeout(stall);
      stall = setTimeout(() => escalate("stalled"), stallMs); // ref'd (§5)
    };
    arm();
    const onAbort = () => escalate("aborted");
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (b) => {
      buf += b.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isPlain(msg) || escalated || finishing) continue;
        arm();
        if ("p" in msg) {
          try {
            onProgress?.(msg.p);
          } catch {
            /* observer errors never kill the worker */
          }
        } else if (("ok" in msg || "err" in msg) && final === undefined) final = msg;
      }
      if (buf.length > 1024 * 1024) buf = ""; // a runaway line is not a protocol line
    });
    child.stderr.on("data", (b) => {
      if (stderr.length < 64 * 1024) stderr += b.toString("utf8");
    });
    child.on("exit", (status, sig) => {
      leaderState.leaderReaped = true;
      exitInfo = { status, signal: sig };
    });
    child.on("error", (e) => {
      if (final === undefined) final = { err: { code: AX.PREREQ, message: `无法启动 worker：${errCode(e)}` } };
      if (!escalated) finish();
    });
    child.on("close", (status, sig) => {
      exitInfo ??= { status, signal: sig };
      if (!escalated) finish(); // escalated ⇒ the termGrace timer finishes (incl. the group KILL)
    });
  });
}

/** Worker outcome (non-ok) ⇒ CliError with the §6 code. */
function workerFailure(r, what, name) {
  switch (r.kind) {
    case "err":
      return Object.assign(fail(r.code, r.message), r.reason ? { reason: r.reason } : {});
    case "lock-busy":
      return fail(
        AX.LOCK_BUSY,
        `另一个 pi-secure 正在挂载、卸载或导出 ${name}（mount.lock 等待 ${BUDGET.mountLockWaitS} 秒超时）`,
      );
    case "stalled":
      return fail(AX.DEADLINE, `${what}停滞超过 ${BUDGET.stallMs / 1000} 秒无进展，已终止`);
    case "aborted":
      return fail(AX.INTERRUPTED, `${what}被中断`);
    case "unclean":
      return Object.assign(
        fail(
          AX.DEADLINE,
          `${what} worker 进程组未能确认清空（残留 pid ${(r.leftover ?? []).join(", ") || "?"}），结果未知`,
        ),
        { unclean: true },
      );
    default:
      return fail(
        AX.IO,
        `${what} worker 异常退出（status ${r.status ?? "-"} signal ${r.signal ?? "-"}）${r.stderr ? `：${r.stderr}` : ""}`,
      );
  }
}

async function runOp(ports, op, payload, what, name, opts = {}) {
  const r = await ports.runWorker(op, payload, opts);
  if (r.kind !== "ok") throw workerFailure(r, what, name);
  return r.result;
}

// ───────────────────────────── worker ops (run inside the worker process) ─────────────────────────────

function progressEmitter(emit) {
  let last = 0;
  return (p) => {
    const t = Date.now();
    if (t - last < BUDGET.progressEveryMs) return;
    last = t;
    emit({ p });
  };
}

/**
 * §3.2 step 2 body — runs while `mount.lock` is held (inside `flock -o`). Admission is re-judged here
 * under the lock: global mountinfo must be `absent` (stale too ⇒ 76); private record non-stale or a
 * busy lease ⇒ 76. Reads ONLY `v.cipher` (lstat walk + file contents) and the lock/lease metadata —
 * never the mount point or anything under it. `deps.onCreated(id)` receives the partial's identity
 * right after its O_EXCL creation — the ONLY credential any cleanup may use (review M5).
 * payload: {vault, out, partial, origRealWork, gocryptfsVersion}.
 */
export async function exportLocked(payload, deps = {}) {
  const d = {
    probeMountState,
    vaultInstanceView,
    scanXattrs: (dir) => scanCipherXattrs(dir),
    statfsFree: defaultStatfsFree,
    onProgress: () => {},
    onCreated: () => {},
    ...deps,
  };
  const { vault: v, out, partial, origRealWork, gocryptfsVersion } = payload;
  const st = await d.probeMountState(v);
  if (st !== "absent")
    throw fail(
      AX.BUSY,
      st === "stale"
        ? `保险库 ${v.name} 的挂载已失效（stale）——先 pi-secure lock ${v.name} 清理再导出`
        : `保险库 ${v.name} 当前已挂载（${st}）——先 pi-secure lock ${v.name} 再导出`,
    );
  const view = await d.vaultInstanceView(v, st);
  if (view.state !== "none" && view.state !== "stale")
    throw fail(
      AX.BUSY,
      `保险库 ${v.name} 有正在运行或无法判定的私有实例 / 租约被占用（${view.state}${view.reason ? `:${view.reason}` : ""}）——拒绝导出`,
    );
  const xa = d.scanXattrs(v.cipher);
  if (xa.length)
    throw fail(
      AX.CONTENT,
      `密文目录带扩展属性（${xa
        .slice(0, 5)
        .map((x) => `${x.file} ${x.key}`)
        .join(
          "; ",
        )}${xa.length > 5 ? ` 等 ${xa.length} 个` : ""}），包格式不承载 xattr（gocryptfs 把明文 xattr 存为密文 xattr，丢弃即丢数据）——拒绝导出`,
    );
  const entries = scanCipherTree(v.cipher);
  let cipherBytes = 0;
  for (const e of entries) if (e.type === "file") cipherBytes += e.size;
  const need = Math.ceil(cipherBytes * BUDGET.exportSpaceFactor + BUDGET.exportSpaceSlack);
  const free = d.statfsFree(path.dirname(out));
  if (free < need) throw fail(AX.IO, `输出文件系统空间不足：需要 ${need} 字节，可用 ${free}`);
  let fd;
  try {
    fd = fs.openSync(partial, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  } catch (e) {
    // EEXIST: not ours — never removed (no credential)
    throw fail(errCode(e) === "EEXIST" ? AX.CONFIG : AX.IO, `无法独占创建 ${partial}：${errCode(e)}`);
  }
  const created = idOf(fs.fstatSync(fd, { bigint: true }));
  d.onCreated(created);
  let published = false;
  try {
    const r = writePackage({
      cipherDir: v.cipher,
      fd,
      name: v.name,
      gocryptfsVersion,
      origRealWork,
      onProgress: d.onProgress,
    });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.linkSync(partial, out);
    } catch (e) {
      if (errCode(e) === "EEXIST") throw fail(AX.CONFIG, `目标文件 ${out} 已存在——不覆盖`);
      throw fail(AX.IO, `发布 ${out} 失败：${errCode(e)}`);
    }
    published = true;
    removeOwnFile(partial, created);
    fsyncDir(path.dirname(out));
    return { totals: r.manifest.totals, bytesWritten: r.bytesWritten, cipherBytes };
  } finally {
    closeQuiet(fd);
    if (!published) removeOwnFile(partial, created);
  }
}

/** Unlink `p` only when it still is the regular file of identity `id` (the creation credential).
 *  No credential ⇒ never deleted. */
function removeOwnFile(p, id) {
  if (!id) return false;
  const cur = lstatOrNull(p);
  if (!cur || !cur.isFile() || !sameId(cur, id)) return false;
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

// ── fd-anchored access to a decrypted vault tree (review B1) ──
// The plaintext tree is attacker data: every component below the mount root is opened with
// O_DIRECTORY|O_NOFOLLOW relative to its parent fd (`/proc/self/fd/<fd>/<name>`), must stay on the
// root's mount, and a symlink/non-directory component refuses (65). Nothing is ever resolved through
// a path string inside the vault, so no read or write can leave it.

/** mount id + fstype of the TOP mount at `realMnt` (last mountinfo line wins), or undefined. */
function topMountAt(realMnt) {
  let last;
  for (const line of fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
    const sep = line.indexOf(" - ");
    if (sep < 0) continue;
    const pre = line.slice(0, sep).split(" ");
    const mp = (pre[4] ?? "").replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
    if (mp === realMnt) last = { id: pre[0], fsType: line.slice(sep + 3).split(" ")[0] };
  }
  return last;
}

function anchorVaultRoot(realMnt, mountCheck) {
  let fd;
  try {
    fd = fs.openSync(realMnt, DIR_OPEN);
  } catch (e) {
    throw fail(
      errCode(e) === "ELOOP" || errCode(e) === "ENOTDIR" ? AX.CONTENT : AX.IO,
      `无法打开挂载根 ${realMnt}：${errCode(e)}`,
    );
  }
  const mid = mntIdOf(fd);
  if (mid === undefined) {
    closeQuiet(fd);
    throw fail(AX.IO, "无法读取挂载根的 mnt_id（/proc/self/fdinfo）");
  }
  if (mountCheck !== false) {
    const m = topMountAt(realMnt);
    if (!m || m.fsType !== GOCRYPTFS_FSTYPE || m.id !== mid) {
      closeQuiet(fd);
      throw fail(AX.IO, `${realMnt} 不是本库的 gocryptfs 挂载根——拒绝迁址`);
    }
  }
  return { fd, mid };
}

/** `<parentFd>/<name>` as a directory fd on mount `mid`; ENOENT ⇒ undefined (or created when asked). */
function openVaultDir(parentFd, name, mid, label, { create = false } = {}) {
  const p = `/proc/self/fd/${parentFd}/${name}`;
  if (create) {
    try {
      fs.mkdirSync(p, { mode: 0o700 });
    } catch (e) {
      if (errCode(e) !== "EEXIST") throw e;
    }
  }
  let fd;
  try {
    fd = fs.openSync(p, DIR_OPEN);
  } catch (e) {
    if (errCode(e) === "ENOENT") return undefined;
    if (errCode(e) === "ELOOP" || errCode(e) === "ENOTDIR")
      throw fail(AX.CONTENT, `库内 ${label} 是符号链接或不是目录——拒绝迁址（不跟随包内链接）`);
    throw e;
  }
  if (mntIdOf(fd) !== mid) {
    closeQuiet(fd);
    throw fail(AX.CONTENT, `库内 ${label} 不在本库挂载上——拒绝迁址`);
  }
  return fd;
}

function openVaultChain(realMnt, mountCheck, comps, { create = false } = {}) {
  const root = anchorVaultRoot(realMnt, mountCheck);
  let cur = root.fd;
  let label = "";
  try {
    for (const c of comps) {
      label = label ? `${label}/${c}` : c;
      const next = openVaultDir(cur, c, root.mid, label, { create });
      closeQuiet(cur);
      cur = next;
      if (cur === undefined) return { fd: undefined, mid: root.mid };
    }
    return { fd: cur, mid: root.mid };
  } catch (e) {
    closeQuiet(cur);
    throw e;
  }
}

/** Read a regular file `<dirFd>/<name>` without following a symlink; size-capped. → {buf, st} | undefined. */
function readVaultFile(dirFd, name, label, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(`/proc/self/fd/${dirFd}/${name}`, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch (e) {
    if (errCode(e) === "ENOENT") return undefined;
    if (errCode(e) === "ELOOP") throw fail(AX.CONTENT, `库内 ${label} 是符号链接——拒绝迁址`);
    throw e;
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) throw fail(AX.CONTENT, `库内 ${label} 不是普通文件——拒绝迁址`);
    if (st.size > BigInt(maxBytes)) throw fail(AX.CONTENT, `库内 ${label} 超过 ${maxBytes} 字节——拒绝迁址`);
    const buf = Buffer.alloc(Number(st.size));
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return { buf: buf.subarray(0, off), st };
  } finally {
    fs.closeSync(fd);
  }
}

/** Atomic replace of `<dirFd>/<name>` (tmp O_EXCL|O_NOFOLLOW in the same dir fd → fsync → rename). */
function writeVaultFileAtomic(dirFd, name, buf, mode, times) {
  const tmpName = `.${name}.reloc-${randomBytes(4).toString("hex")}`;
  const tmp = `/proc/self/fd/${dirFd}/${tmpName}`;
  const fd = fs.openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, mode);
  try {
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fchmodSync(fd, mode);
    if (times) fs.futimesSync(fd, times.atime, times.mtime);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw e;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, `/proc/self/fd/${dirFd}/${name}`);
}

function sameSessionDirValue(value, want, home) {
  if (typeof value !== "string" || value === "") return false;
  if (value === want) return true;
  const expanded = value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
  return path.isAbsolute(expanded) && path.resolve(expanded) === want;
}
function stamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** §3.4 step 2, fd-anchored: `<mnt>/state/sessions/default/*.jsonl`. */
export function relocateSessionsAnchored({ realMnt, mountCheck, rules }, emit = () => {}) {
  const { fd } = openVaultChain(realMnt, mountCheck, ["state", "sessions", "default"]);
  if (fd === undefined) return { changed: 0, unchanged: 0 };
  let changed = 0;
  let unchanged = 0;
  try {
    const names = fs
      .readdirSync(`/proc/self/fd/${fd}`)
      .filter((n) => n.endsWith(".jsonl") && !n.startsWith("."))
      .sort();
    for (const name of names) {
      const label = `state/sessions/default/${name}`;
      const f = readVaultFile(fd, name, label, BUDGET.sessionFileMaxBytes);
      if (!f) continue;
      const r = relocateSessionContent(f.buf, rules);
      if (r.anyChange) {
        writeVaultFileAtomic(fd, name, r.content, Number(f.st.mode & 0o777n) || 0o600, {
          atime: Number(f.st.atimeNs) / 1e9,
          mtime: Number(f.st.mtimeNs) / 1e9,
        });
        changed++;
      } else unchanged++;
      emit({ p: { files: changed + unchanged } });
    }
    fs.fsyncSync(fd);
    return { changed, unchanged };
  } finally {
    closeQuiet(fd);
  }
}

/** §3.4 step 3, fd-anchored: rename `state/memory/<slug(from)>` → `<slug(to)>` (a real dir only). */
export function relocateMemoryAnchored({ realMnt, mountCheck, from, to }) {
  const fromSlug = memorySlug(path.resolve(from));
  const toSlug = memorySlug(path.resolve(to));
  if (!fromSlug || !toSlug || fromSlug.includes("/") || toSlug.includes("/") || fromSlug === toSlug)
    return { renamed: false, reason: "absent" };
  const { fd } = openVaultChain(realMnt, mountCheck, ["state", "memory"]);
  if (fd === undefined) return { renamed: false, reason: "absent" };
  try {
    const src = lstatOrNull(`/proc/self/fd/${fd}/${fromSlug}`);
    if (!src) return { renamed: false, reason: "absent", fromSlug, toSlug };
    if (!src.isDirectory() || src.isSymbolicLink())
      throw fail(AX.CONTENT, `库内 state/memory/${fromSlug} 是符号链接或不是目录——拒绝迁址`);
    if (lstatOrNull(`/proc/self/fd/${fd}/${toSlug}`))
      return { renamed: false, reason: "target-exists", fromSlug, toSlug };
    fs.renameSync(`/proc/self/fd/${fd}/${fromSlug}`, `/proc/self/fd/${fd}/${toSlug}`);
    fs.fsyncSync(fd);
    return { renamed: true, fromSlug, toSlug };
  } finally {
    closeQuiet(fd);
  }
}

/** §3.4 step 4, fd-anchored twin of helper's syncProjectSettings(v, {fix:true}) for `<mnt>/work/.pi/settings.json`. */
export function relocateSettingsAnchored({ realMnt, mountCheck, want, home, now }) {
  const { fd: piFd } = openVaultChain(realMnt, mountCheck, ["work", ".pi"], { create: true });
  try {
    const f = readVaultFile(piFd, "settings.json", "work/.pi/settings.json", BUDGET.projectSettingsMaxBytes);
    let obj = {};
    let parsedOk = true;
    if (f) {
      try {
        const v = JSON.parse(f.buf.toString("utf8"));
        if (isPlain(v)) obj = v;
        else parsedOk = false;
      } catch {
        parsedOk = false;
      }
    }
    if (parsedOk && sameSessionDirValue(obj.sessionDir, want, home)) return { kind: "unchanged" };
    const mode = f ? Number(f.st.mode & 0o777n) || 0o600 : 0o600;
    let backup;
    if (f && (!parsedOk || obj.sessionDir !== undefined)) {
      backup = `settings.json.bak-${stamp(new Date(now ?? Date.now()))}`;
      const bfd = fs.openSync(
        `/proc/self/fd/${piFd}/${backup}`,
        fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW,
        mode,
      );
      try {
        let off = 0;
        while (off < f.buf.length) off += fs.writeSync(bfd, f.buf, off, f.buf.length - off);
        fs.fsyncSync(bfd);
      } finally {
        fs.closeSync(bfd);
      }
    }
    const next = parsedOk ? { ...obj, sessionDir: want } : { sessionDir: want };
    writeVaultFileAtomic(piFd, "settings.json", Buffer.from(`${JSON.stringify(next, null, 2)}\n`), mode);
    fs.fsyncSync(piFd);
    return backup ? { kind: "fixed", backup: path.join(realMnt, "work", ".pi", backup) } : { kind: "written" };
  } finally {
    closeQuiet(piFd);
  }
}

const WORKER_OPS = {
  async export(payload, emit) {
    return exportLocked(payload, {
      onProgress: progressEmitter(emit),
      onCreated: (id) => emit({ p: { partial: id } }),
    });
  },
  async read(payload, emit) {
    const r = readPackage({
      pkgPath: payload.pkgPath,
      stagingRoot: payload.stagingRoot,
      onProgress: progressEmitter(emit),
    });
    return { origRealWork: r.manifest.origRealWork, name: r.manifest.name, totals: r.manifest.totals, bytes: r.bytes };
  },
  async "relocate-sessions"(payload, emit) {
    return relocateSessionsAnchored(payload, emit);
  },
  async "relocate-memory"(payload) {
    return relocateMemoryAnchored(payload);
  },
  async "relocate-settings"(payload) {
    return relocateSettingsAnchored(payload);
  },
  async sync(payload) {
    const r = spawnSync("sync", ["-f", payload.path], { stdio: "ignore", timeout: BUDGET.syncMs });
    if (r.error || r.status !== 0)
      throw fail(AX.IO, `sync -f ${payload.path} 失败（${r.error ? errCode(r.error) : `exit ${r.status}`}）`);
    return { synced: payload.path };
  },
};

async function workerMain(argv) {
  const emit = (obj) => fs.writeSync(1, `${JSON.stringify(obj)}\n`);
  const [sub, op, json] = argv;
  if (sub !== "__archive-work" || !Object.hasOwn(WORKER_OPS, op ?? "")) {
    process.stderr.write("archive.mjs: internal entry only (__archive-work <op> <json>)\n");
    return AX.USAGE;
  }
  // test seam (same precedent as helper's PI_SECURE_TEST_WORKER_DELAY): silent delay before the op,
  // so the stall watchdog can be exercised against a real worker process
  // second seam: a same-group descendant that IGNORES SIGTERM and holds none of our pipes (I5 test)
  const orphanPidFile = process.env.PI_SECURE_TEST_ARCHIVE_ORPHAN_PIDFILE;
  if (orphanPidFile) {
    const o = spawn("sh", ["-c", "trap '' TERM; sleep 60"], { stdio: "ignore" });
    fs.writeFileSync(orphanPidFile, String(o.pid));
    o.unref();
  }
  const delay = Number(process.env.PI_SECURE_TEST_ARCHIVE_STALL_MS ?? 0);
  if (Number.isFinite(delay) && delay > 0) await new Promise((r) => setTimeout(r, Math.min(delay, 600_000)));
  try {
    const result = await WORKER_OPS[op](JSON.parse(json ?? "null"), emit);
    emit({ ok: result ?? null });
    return 0;
  } catch (e) {
    const f = toFailure(e, AX.IO);
    emit({ err: { code: f.code, message: f.message, ...(f.reason ? { reason: f.reason } : {}) } });
    return 1;
  }
}

// ───────────────────────────── export (§3.2) ─────────────────────────────

/**
 * `pi-secure export <名字> <文件>` → exit code. opts: {name, file, home?, cwd?}.
 * Pre-lock fast checks here; the authoritative admission + write run in the locked worker.
 */
export async function cmdExport(opts, portsIn) {
  const ports = withPorts(portsIn);
  const home = opts.home ?? homeDir();
  const name = opts.name;
  let partial;
  let created; // identity reported by the worker right after ITS O_EXCL creation
  let out;
  let unsub;
  /** Cleanup of the partial: only with the creation credential; otherwise report, never delete. */
  const cleanup = () => {
    if (!partial) return { published: false };
    const pst = lstatOrNull(partial);
    const ost = out ? lstatOrNull(out) : null;
    const published = Boolean(created && sameId(ost, created));
    if (!pst) return { published };
    if (created) removeOwnFile(partial, created);
    else ports.err(`遗留文件 ${partial} 无法证明由本次导出创建，未删除`);
    return { published };
  };
  try {
    if (typeof opts.file !== "string" || opts.file === "")
      throw fail(AX.USAGE, "用法：pi-secure export <名字> <文件.tar>");
    const rv = resolveVault(name, { home });
    if (rv.kind === "error") throw fail(rv.code, rv.message);
    const v = rv.vault;
    const es = vaultEntryState(name, home);
    if (es.kind !== "present") throw unknownEntry(name, es);
    if (es.entry.pending !== undefined)
      throw fail(AX.BUSY, `保险库 ${name} 有未完成的转换/导入（${es.entry.pending}）：先 --resume 或 --abort`);
    if (es.entry.relocate !== undefined)
      throw fail(AX.CONFIG, `保险库 ${name} 迁址未完成：pi-secure init ${name} --fix-settings 继续`);
    out = path.resolve(opts.cwd ?? process.cwd(), opts.file);
    if (lstatOrNull(out)) throw fail(AX.CONFIG, `目标文件 ${out} 已存在——不覆盖`);
    const parent = lstatOrNull(path.dirname(out));
    if (!parent || !parent.isDirectory()) throw fail(AX.NOT_FOUND, `输出目录 ${path.dirname(out)} 不存在`);
    const c = lstatOrNull(v.cipher);
    const conf = lstatOrNull(path.join(v.cipher, "gocryptfs.conf"));
    if (!c || !c.isDirectory() || c.isSymbolicLink() || !conf || !conf.isFile())
      throw fail(AX.CONFIG, `保险库 ${name} 的密文目录 ${v.cipher} 不完整（init 未完成？）`);
    const txid = ports.txid();
    partial = `${out}.partial-${txid}`;
    const origRealWork = path.join(physicalPaths(v).realMnt, "work");
    const ac = new AbortController();
    unsub = ports.onInterrupt(() => ac.abort());
    const r = await ports.runWorker(
      "export",
      { vault: v, out, partial, origRealWork, gocryptfsVersion: ports.gocryptfsVersion() },
      {
        lockFile: v.lock,
        signal: ac.signal,
        onProgress: (p) => {
          if (isPlain(p) && isPlain(p.partial) && created === undefined) created = p.partial;
        },
      },
    );
    if (r.kind !== "ok") {
      const { published } = cleanup();
      if (r.kind === "aborted") {
        ports.err(published ? `已中断；导出文件 ${out} 已完整发布` : `已中断；未生成 ${out}`);
        return AX.INTERRUPTED;
      }
      partial = undefined; // cleaned
      throw workerFailure(r, "导出", name);
    }
    const t = r.result.totals;
    ports.out(
      `已导出 ${t.files} 个文件 ${t.bytes} 字节到 ${out}。` +
        "该包与密文目录同样敏感：拿到它的人可以离线暴力破解口令，请使用强口令。",
    );
    return AX.OK;
  } catch (e) {
    cleanup();
    const f = toFailure(e);
    ports.err(f.message);
    return f.code;
  } finally {
    unsub?.();
  }
}

// ───────────────────────────── import state file (§3.3 / §1.6 写法) ─────────────────────────────

export function secureRoot(home = homeDir()) {
  return path.dirname(defaultVaultDir("x", home));
}
export function txnDir(home = homeDir()) {
  return path.join(secureRoot(home), ".txn");
}
export function importStatePath(name, home = homeDir()) {
  return path.join(txnDir(home), `import-${name}.json`);
}

function ensureTxnDir(home) {
  const dir = txnDir(home);
  fs.mkdirSync(secureRoot(home), { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if (errCode(e) !== "EEXIST") throw e;
  }
  const st = lstatOrNull(dir);
  if (!st || !st.isDirectory() || st.isSymbolicLink() || Number(st.uid) !== process.getuid() || Number(st.mode) & 0o077)
    throw fail(AX.CONFIG, `${dir} 须为本用户的 0700 目录`);
  return dir;
}

/** tmp + fsync + rename + fsync `.txn/`. */
export function writeImportState(state, home = homeDir()) {
  const dir = ensureTxnDir(home);
  const file = importStatePath(state.name, home);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = fs.openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  let id;
  try {
    id = idOf(fs.fstatSync(fd, { bigint: true }));
    fs.writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    removeOwnFile(tmp, id);
    throw e;
  }
  fsyncDir(dir);
}

const isId = (x) => x === null || (isPlain(x) && typeof x.dev === "string" && typeof x.ino === "string");

/** → {kind:"none"} | {kind:"ok", state} | {kind:"corrupt", reason}. Strict shape (never trusted blindly). */
export function readImportState(name, home = homeDir()) {
  const file = importStatePath(name, home);
  const st = lstatOrNull(file);
  if (!st) return { kind: "none" };
  if (
    !st.isFile() ||
    Number(st.uid) !== process.getuid() ||
    Number(st.mode) & 0o077 ||
    Number(st.size) > BUDGET.stateFileMaxBytes
  )
    return { kind: "corrupt", reason: "not an own 0600 small regular file" };
  let s;
  try {
    s = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { kind: "corrupt", reason: "json" };
  }
  const ok =
    isPlain(s) &&
    s.v === 1 &&
    s.name === name &&
    TXID_RE.test(s.txid ?? "") &&
    IMPORT_PHASES.includes(s.phase) &&
    isAbs(s.pkg) &&
    isAbs(s.staging) &&
    isAbs(s.dir) &&
    isAbs(s.mnt) &&
    path.resolve(s.mnt) === s.mnt &&
    isPlain(s.ids) &&
    isId(s.ids.staging ?? null) &&
    isId(s.ids.dir ?? null) &&
    isId(s.ids.mnt ?? null) &&
    (s.origRealWork === undefined || isAbs(s.origRealWork)) &&
    // derived, not free: a tampered state file cannot point the rollback at another dir/staging;
    // `mnt` is bound to the registration in rollbackImport / resume (review M4)
    s.dir === defaultVaultDir(name, home) &&
    s.staging === path.join(path.dirname(s.dir), `.${name}.import-${s.txid}`);
  return ok ? { kind: "ok", state: s } : { kind: "corrupt", reason: "shape" };
}

function removeImportState(name, home) {
  const file = importStatePath(name, home);
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if (errCode(e) !== "ENOENT") throw e;
  }
  try {
    fsyncDir(txnDir(home));
  } catch {
    /* best-effort */
  }
}

/** Status lines for V6's describeVault / status (one per unfinished import). */
export function listImportStates(home = homeDir()) {
  const lines = [];
  let names = [];
  try {
    names = fs.readdirSync(txnDir(home));
  } catch {
    return lines;
  }
  for (const f of names.sort()) {
    const m = /^import-([a-z0-9][a-z0-9_-]{0,31})\.json$/.exec(f);
    if (!m) continue;
    const r = readImportState(m[1], home);
    if (r.kind === "ok")
      lines.push(
        r.state.phase === "published" || r.state.phase === "committed"
          ? `import ${m[1]}: interrupted (${r.state.phase}) · --resume|--abort`
          : `import ${m[1]}: interrupted (${r.state.phase}) · --abort`,
      );
    else if (r.kind === "corrupt")
      lines.push(`import ${m[1]}: state file unreadable (${r.reason}) · 人工检查 ${importStatePath(m[1], home)}`);
  }
  return lines;
}

// ───────────────────────────── import (§3.3) ─────────────────────────────

function sentinelOnlyMnt(mnt) {
  let names;
  try {
    names = fs.readdirSync(mnt);
  } catch {
    return false;
  }
  for (const n of names) {
    if (n !== "work" && n !== "state") return false;
    const s = lstatOrNull(path.join(mnt, n));
    if (!s || !s.isFile() || s.size !== 0n) return false;
  }
  return true;
}

function writeSentinels(mnt) {
  for (const n of ["work", "state"]) {
    const f = path.join(mnt, n);
    fs.closeSync(fs.openSync(f, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o400));
    fs.chmodSync(f, 0o400);
  }
}

/**
 * Undo everything THIS txid created (recovery-table rows 1–3), identity-checked. CALLER HOLDS the
 * transaction lock. Authorization first (reviews B2/B3/M4): the registration is re-read and must be
 * provably uncommitted — `present` with OUR pending and the SAME dir/mnt as the state file, or
 * `absent` (readable settings, no key). `unknown` / `no-file` / committed / foreign ⇒ nothing is
 * touched. Then staging (dev+ino) → `<dir>` (dev+ino, global mount absent) → `<mnt>` (dev+ino, only
 * the two sentinels, and — without a registration to bind it — only the default mount point) →
 * registration (only ours) → state file. → {done, remaining[], committed?}.
 */
export async function rollbackImport(state, ports, home) {
  const remaining = [];
  const { name, txid } = state;
  const ids = state.ids ?? {};
  const v = deriveVault(name, state.dir, state.mnt);
  const es = vaultEntryState(name, home);
  let mntBound;
  if (es.kind === "present") {
    if (es.entry.pending !== `import:${txid}`)
      return {
        done: false,
        committed: es.entry.pending === undefined,
        remaining: [
          es.entry.pending === undefined
            ? `登记项 secure.vaults.${name} 已提交（pending 已清除）——导入结果保留，未删除任何东西`
            : `登记项 secure.vaults.${name} 的 pending 为 ${JSON.stringify(es.entry.pending)}，不属于本事务——未删除任何东西`,
        ],
      };
    if (es.entry.dir !== state.dir || es.entry.mnt !== state.mnt)
      return {
        done: false,
        remaining: [`登记项 secure.vaults.${name} 的 dir/mnt 与状态文件不符——未删除任何东西，请人工检查`],
      };
    mntBound = true;
  } else if (es.kind === "absent") {
    mntBound = state.mnt === defaultVaultMnt(name, home);
  } else
    return {
      done: false,
      remaining: [`无法确认 ${name} 的登记状态（${es.reason ?? es.kind}）——保留一切，请人工检查设置文件后再 --abort`],
    };
  // 1. staging
  const sst = lstatOrNull(state.staging);
  if (sst) {
    if (ids.staging && sameId(sst, ids.staging)) {
      try {
        discardStaging(state.staging);
      } catch (e) {
        remaining.push(`暂存目录 ${state.staging}（删除失败：${toFailure(e).message}）`);
      }
    } else remaining.push(`暂存目录 ${state.staging}（身份与状态文件不符，未动）`);
  }
  // 2. <dir>
  const dst = lstatOrNull(state.dir);
  if (dst && ids.dir) {
    if (!sameId(dst, ids.dir)) remaining.push(`${state.dir}（身份与状态文件不符，未动）`);
    else {
      const ms = await ports.probeMountState(v);
      if (ms !== "absent") remaining.push(`${state.dir}（保险库仍挂载：${ms}，未删除）`);
      else {
        try {
          discardStaging(state.dir);
        } catch (e) {
          remaining.push(`${state.dir}（删除失败：${toFailure(e).message}）`);
        }
      }
    }
  } else if (dst && (state.phase === "publishing" || state.phase === "published")) {
    // never recorded ⇒ cannot be proven ours (pre-existing, a racer's, or a crash between mkdir and
    // the state write) — never touched, only reported
    remaining.push(`${state.dir}（未记录身份，无法证明属于本次导入，未动）`);
  }
  // 3. <mnt>
  const mst = lstatOrNull(state.mnt);
  if (mst && ids.mnt) {
    if (!mntBound) remaining.push(`${state.mnt}（无登记项可佐证、且不是缺省挂载点，无法证明归属，未动）`);
    else if (!sameId(mst, ids.mnt)) remaining.push(`${state.mnt}（身份与状态文件不符，未动）`);
    else if (!sentinelOnlyMnt(state.mnt)) remaining.push(`${state.mnt}（含哨兵以外的条目，人工检查后删除）`);
    else {
      try {
        for (const n of ["work", "state"])
          if (lstatOrNull(path.join(state.mnt, n))) fs.unlinkSync(path.join(state.mnt, n));
        fs.rmdirSync(state.mnt);
      } catch (e) {
        remaining.push(`${state.mnt}（删除失败：${errCode(e)}）`);
      }
    }
  }
  if (remaining.length) return { done: false, remaining };
  // 4. registration (only ours) and 5. state file
  if (es.kind === "present") {
    try {
      const r = ports.removeVaultEntry(name, { pending: `import:${txid}` }, { home });
      if (r.kind === "mismatch") return { done: false, remaining: [`登记项 secure.vaults.${name}（${r.reason}）`] };
    } catch (e) {
      return { done: false, remaining: [`登记项 secure.vaults.${name}（${toFailure(e).message}）`] };
    }
  }
  removeImportState(name, home);
  return { done: true, remaining };
}

/** Commit point (step 7): clear `pending` (only ours), adding `relocate` when the address changed. */
function commitImport(state, ports, home) {
  const v = deriveVault(state.name, state.dir, state.mnt);
  const realWork = path.join(physicalPaths(v).realMnt, "work");
  const relocate =
    state.origRealWork !== undefined && state.origRealWork !== realWork
      ? { from: state.origRealWork, to: realWork, txid: state.txid, phase: "pending" }
      : undefined;
  const r = ports.patchVaultEntry(
    state.name,
    { pending: `import:${state.txid}` },
    relocate ? { set: { relocate }, remove: ["pending"] } : { remove: ["pending"] },
    { home },
  );
  if (r.kind !== "ok")
    throw fail(
      AX.IO,
      `提交登记失败（${r.kind}${r.reason ? `：${r.reason}` : ""}）；数据已发布，状态文件保留：pi-secure import --resume ${state.name}`,
    );
  return { relocate };
}

function relocateHint(name) {
  return `迁址仍待完成：pi-secure init ${name} --fix-settings（完成前 run/unlock/export 会被拒绝）`;
}

/** Failure codes a rolled-back import keeps (everything else is reported as 74). */
const KEEP_CODES = new Set([AX.CONTENT, AX.LOCK_BUSY, AX.DEADLINE, AX.BUSY, AX.CONFIG, AX.INTERRUPTED]);

/**
 * `pi-secure import <文件> <名字> [--path <挂载点>] [--verify-password]` → exit code.
 * opts: {file, name, path?, verifyPassword?, home?, cwd?, lockWaitS?}.
 */
export async function cmdImport(opts, portsIn) {
  const ports = withPorts(portsIn);
  const home = opts.home ?? homeDir();
  const name = opts.name;
  const cwd = opts.cwd ?? process.cwd();
  let state;
  let committed = false;
  let lock;
  const ac = new AbortController();
  const unsub = ports.onInterrupt(() => ac.abort());
  const interrupted = () => {
    if (ac.signal.aborted) throw fail(AX.INTERRUPTED, "导入被中断");
  };
  try {
    if (typeof opts.file !== "string" || opts.file === "")
      throw fail(AX.USAGE, "用法：pi-secure import <文件.tar> <名字> [--path <挂载点>] [--verify-password]");
    if (typeof name !== "string" || !VAULT_NAME_RE.test(name))
      throw fail(AX.USAGE, `保险库名不合法：${JSON.stringify(name)}（需匹配 ${VAULT_NAME_RE}）`);
    if (opts.verifyPassword && !ports.isTTY()) throw fail(AX.USAGE, "--verify-password 需要在终端（TTY）中运行");
    lock = await ports.txnLock(name, home, opts.lockWaitS !== undefined ? { waitS: opts.lockWaitS } : undefined);
    // entry first: a same-name racer registers BEFORE writing its state file, so the loser sees 78
    // (§3.5); a state file without an entry is a crashed rollback ⇒ 76 (--abort finishes it)
    const es = vaultEntryState(name, home);
    if (es.kind === "present") throw fail(AX.CONFIG, `名字 ${name} 已登记——import 只针对新名字`);
    if (es.kind === "unknown") throw unknownEntry(name, es);
    const prev = readImportState(name, home);
    if (prev.kind !== "none")
      throw fail(AX.BUSY, `保险库 ${name} 有未完成的导入：pi-secure import --resume ${name} 或 --abort ${name}`);
    const { cfg, readError } = loadSecureConfig(home);
    if (readError) throw fail(AX.CONFIG, `设置文件无法读取：${readError}`);
    if (!cfg.valid) throw fail(AX.CONFIG, `设置文件 secure 段非法：${cfg.error}`);
    const dir = defaultVaultDir(name, home);
    const mnt = opts.path !== undefined ? path.resolve(cwd, opts.path) : defaultVaultMnt(name, home);
    const v = deriveVault(name, dir, mnt);
    if (lstatOrNull(dir)) throw fail(AX.CONFIG, `${dir} 已存在——不接管已有目录`);
    if (lstatOrNull(mnt))
      throw fail(AX.CONFIG, `挂载点 ${mnt} 已存在——不接管已有目录；确认无用后删除，或用 --path 换位置`);
    const pos = positionProblems(v, cfg.vaults, home);
    if (pos.length) throw fail(AX.CONFIG, `位置检查失败：\n  - ${pos.join("\n  - ")}`);
    const mntParent = lstatOrNull(path.dirname(mnt));
    if (!mntParent && mnt !== defaultVaultMnt(name, home))
      throw fail(AX.CONFIG, `挂载点父目录 ${path.dirname(mnt)} 不存在（仅缺省 ~/secure 会自动创建）`);
    if (mntParent) {
      const pp = mntAncestorProblems(v, process.getuid());
      if (pp.length) throw fail(AX.CONFIG, `挂载点祖先目录检查失败：\n  - ${pp.join("\n  - ")}`);
    }
    const pkg = path.resolve(cwd, opts.file);
    const pst = lstatOrNull(pkg);
    if (!pst) throw fail(AX.NOT_FOUND, `文件 ${pkg} 不存在`);
    if (!pst.isFile() || Number(pst.uid) !== process.getuid()) throw fail(AX.CONTENT, `${pkg} 不是本用户的普通文件`);
    const need = Math.ceil(Number(pst.size) * BUDGET.importSpaceFactor + BUDGET.importSpaceSlack);
    const free = ports.statfsFree(path.dirname(dir));
    if (free < need) throw fail(AX.IO, `空间不足：需要 ${need} 字节，可用 ${free}`);

    // 1. claim the name (settings lock, expectAbsent) — 73/78 from the port
    const txid = ports.txid();
    if (!TXID_RE.test(txid)) throw new Error(`bad txid ${txid}`);
    ports.registerVault(name, { dir, mnt }, { home, expectAbsent: true, pending: `import:${txid}` });
    state = {
      v: 1,
      txid,
      name,
      phase: "claimed",
      pkg,
      staging: path.join(path.dirname(dir), `.${name}.import-${txid}`),
      dir,
      mnt,
      ids: { staging: null, dir: null, mnt: null },
      createdAt: ports.now().toISOString(),
    };
    const save = (patch) => {
      Object.assign(state, patch);
      writeImportState(state, home);
    };
    try {
      writeImportState(state, home);
    } catch (e) {
      ports.removeVaultEntry(name, { pending: `import:${txid}` }, { home });
      state = undefined;
      throw e;
    }

    // 2. staging root (exclusive)
    fs.mkdirSync(state.staging, { mode: 0o700 });
    save({ phase: "staging", ids: { ...state.ids, staging: idOf(lstatOrNull(state.staging)) } });

    // 3–5. validating read in a worker (untrusted input never touches anything but S)
    const sig = { signal: ac.signal };
    const read = await runOp(ports, "read", { pkgPath: pkg, stagingRoot: state.staging }, "校验型读取", name, sig);
    save({ phase: "staged", origRealWork: read.origRealWork });

    // 6. publish into self-made dirs
    interrupted();
    save({ phase: "publishing" });
    publishStaged(state, v, save, cfg, home);
    await runOp(ports, "sync", { path: dir }, "落盘", name, sig);
    save({ phase: "published" });
    interrupted();

    // 7. commit
    const { relocate } = commitImport(state, ports, home);
    committed = true;
    removeImportState(name, home);
    lock.release();
    lock = undefined;
    const t = read.totals;
    ports.out(`已导入保险库 ${name}：${t.files} 个文件 ${t.bytes} 字节；元数据 ${dir}，挂载点 ${mnt}。`);
    if (!opts.verifyPassword) {
      if (relocate) ports.out(relocateHint(name));
      return AX.OK;
    }
    // 8. --verify-password ALWAYS verifies (review M9): relocation when the address changed, else a
    //    bounded mount + unmount; the from==to shortcut only skips the rewrite, never the password
    const rr = relocate ? await relocateVault({ name, home }, ports) : await verifyVaultPassword({ name, home }, ports);
    if (rr.code === AX.OK) return AX.OK;
    if (rr.code === AX.BAD_PASSWORD) {
      ports.err(`包已导入并校验；口令未验证${relocate ? `；${relocateHint(name)}` : ""}`);
      return AX.BAD_PASSWORD;
    }
    ports.err(
      relocate
        ? `导入完成；迁址未完成：pi-secure init ${name} --fix-settings 继续（${rr.message}）`
        : `导入完成；口令验证未完成：${rr.message}`,
    );
    return AX.FAIL;
  } catch (e) {
    const f = toFailure(e);
    if (state && !committed) {
      if (f.unclean) {
        ports.err(`${f.message}\n  worker 未能确认终止，状态保留未回滚；稍后执行：pi-secure import --abort ${name}`);
        return f.code;
      }
      const rb = await rollbackImport(state, ports, home);
      if (rb.done) {
        ports.err(`${f.message}\n  已回滚（本次导入创建的目录与登记已删除）`);
        return KEEP_CODES.has(f.code) ? f.code : AX.IO;
      }
      ports.err(
        `${f.message}\n  回滚未完成，剩余：\n  - ${rb.remaining.join("\n  - ")}\n  处理后执行：pi-secure import --abort ${name}`,
      );
      return AX.IO;
    }
    ports.err(f.message);
    return f.code;
  } finally {
    lock?.release();
    unsub?.();
  }
}

/** §3.3 step 6 (state saved after every identity-bearing creation). */
function publishStaged(state, v, save, cfg, home) {
  const S = state.staging;
  const checkS = () => {
    if (!sameId(lstatOrNull(S), state.ids.staging)) throw fail(AX.IO, `暂存目录 ${S} 身份变化，中止发布`);
  };
  checkS();
  createEmpty0600(path.join(S, "mount.lock"));
  createEmpty0600(path.join(S, "mount.lease"));
  try {
    fs.mkdirSync(state.dir, { mode: 0o700 });
  } catch (e) {
    throw fail(errCode(e) === "EEXIST" ? AX.CONFIG : AX.IO, `无法独占创建 ${state.dir}：${errCode(e)}`);
  }
  save({ ids: { ...state.ids, dir: idOf(lstatOrNull(state.dir)) } });
  for (const n of ["cipher", "mount.lock", "mount.lease"]) {
    checkS();
    if (!sameId(lstatOrNull(state.dir), state.ids.dir)) throw fail(AX.IO, `${state.dir} 身份变化，中止发布`);
    const to = path.join(state.dir, n);
    if (lstatOrNull(to)) throw fail(AX.IO, `${to} 已存在（不覆盖），中止发布`);
    fs.renameSync(path.join(S, n), to);
  }
  // the package restores the exporter's cipher-root mode; this vault's layout rule is a private
  // 0700 dir (checkLayout) — normalize only the root we just moved into our own <dir>
  fs.chmodSync(path.join(state.dir, "cipher"), 0o700);
  checkS();
  const left = fs.readdirSync(S);
  if (left.length) throw fail(AX.IO, `暂存目录仍有条目：${left.slice(0, 5).join(", ")}`);
  fs.rmdirSync(S);
  if (!lstatOrNull(path.dirname(state.mnt))) {
    if (state.mnt !== defaultVaultMnt(state.name, home))
      throw fail(AX.CONFIG, `挂载点父目录 ${path.dirname(state.mnt)} 不存在`);
    fs.mkdirSync(path.dirname(state.mnt), { recursive: true, mode: 0o700 });
  }
  const pp = mntAncestorProblems(v, process.getuid());
  if (pp.length) throw fail(AX.CONFIG, `挂载点祖先目录检查失败：\n  - ${pp.join("\n  - ")}`);
  try {
    fs.mkdirSync(state.mnt, { mode: 0o700 });
  } catch (e) {
    throw fail(errCode(e) === "EEXIST" ? AX.CONFIG : AX.IO, `挂载点 ${state.mnt} 无法独占创建：${errCode(e)}`);
  }
  save({ ids: { ...state.ids, mnt: idOf(lstatOrNull(state.mnt)) } });
  writeSentinels(state.mnt);
  const lay = checkLayout(v, { mounted: false, others: cfg.vaults, home });
  if (lay.problems.length) throw fail(AX.IO, `发布后布局检查失败：\n  - ${lay.problems.join("\n  - ")}`);
}

/** Shared head of abort/resume: validate name, take the txn lock, read the state. */
async function openTxn(opts, ports) {
  const home = opts.home ?? homeDir();
  const name = opts.name;
  if (typeof name !== "string" || !VAULT_NAME_RE.test(name))
    throw fail(AX.USAGE, `保险库名不合法：${JSON.stringify(name)}`);
  const lock = await ports.txnLock(name, home, opts.lockWaitS !== undefined ? { waitS: opts.lockWaitS } : undefined);
  try {
    const r = readImportState(name, home);
    if (r.kind === "none") throw fail(AX.NOT_FOUND, `没有 ${name} 的未完成导入`);
    if (r.kind === "corrupt")
      throw fail(
        AX.CONFIG,
        `状态文件 ${importStatePath(name, home)} 无法解析（${r.reason}）——不做任何改动，请人工检查`,
      );
    return { home, name, lock, s: r.state };
  } catch (e) {
    lock.release();
    throw e;
  }
}

/** `pi-secure import --abort <名字>` → exit code (0 rolled back · 1 refused · 74 incomplete). */
export async function cmdImportAbort(opts, portsIn) {
  const ports = withPorts(portsIn);
  let txn;
  try {
    txn = await openTxn(opts, ports);
    const { home, name, s } = txn;
    const es = vaultEntryState(name, home);
    if (es.kind === "unknown" || es.kind === "no-file") throw unknownEntry(name, es);
    if (es.kind === "present" && es.entry.pending !== `import:${s.txid}`)
      throw fail(
        AX.FAIL,
        es.entry.pending === undefined
          ? `导入已提交，不能撤销（保险库 ${name} 已可用；如需删除请自行处理）。清理状态文件：pi-secure import --resume ${name}`
          : `登记项 pending 为 ${JSON.stringify(es.entry.pending)}，不属于本次导入（${s.txid}）——不做任何改动`,
      );
    const rb = await rollbackImport(s, ports, home);
    if (rb.done) {
      ports.out(`已回滚 ${name} 的导入（${s.txid}）`);
      return AX.OK;
    }
    ports.err(`回滚未完成，剩余：\n  - ${rb.remaining.join("\n  - ")}`);
    return rb.committed ? AX.FAIL : AX.IO;
  } catch (e) {
    const f = toFailure(e);
    ports.err(f.message);
    return f.code;
  } finally {
    txn?.lock.release();
  }
}

/** `pi-secure import --resume <名字>` → exit code: only finishes the commit (step 7) of a published import. */
export async function cmdImportResume(opts, portsIn) {
  const ports = withPorts(portsIn);
  let txn;
  try {
    txn = await openTxn(opts, ports);
    const { home, name, s } = txn;
    const es = vaultEntryState(name, home);
    if (es.kind === "unknown" || es.kind === "no-file") throw unknownEntry(name, es);
    if (es.kind === "absent") throw fail(AX.FAIL, `${name} 没有登记项——不能继续，只能 --abort`);
    const entry = es.entry;
    if (entry.dir !== s.dir || entry.mnt !== s.mnt)
      throw fail(AX.FAIL, `登记项的 dir/mnt 与状态文件不符——不做任何改动，请人工检查`);
    const dirOk = sameId(lstatOrNull(s.dir), s.ids.dir);
    const mntOk = sameId(lstatOrNull(s.mnt), s.ids.mnt);
    if (entry.pending === undefined) {
      // committed before the state file was removed
      if (!dirOk) throw fail(AX.FAIL, `${s.dir} 与状态文件不符——不做任何改动，请人工检查`);
      removeImportState(name, home);
      ports.out(`导入 ${name} 早已提交；已清理状态文件。`);
      if (entry.relocate !== undefined) ports.out(relocateHint(name));
      return AX.OK;
    }
    if (entry.pending !== `import:${s.txid}`) throw fail(AX.FAIL, `登记项不属于本次导入（${s.txid}）——不做任何改动`);
    if (s.phase !== "published")
      throw fail(
        AX.FAIL,
        `导入停在 ${s.phase} 阶段，尚未发布完成，不能继续：pi-secure import --abort ${name} 后重新导入`,
      );
    if (!dirOk || !mntOk) throw fail(AX.FAIL, `${s.dir} 或 ${s.mnt} 与状态文件不符——只能 --abort（或人工检查）`);
    const v = deriveVault(name, s.dir, s.mnt);
    const { cfg } = loadSecureConfig(home);
    const lay = checkLayout(v, { mounted: false, others: (cfg.vaults ?? []).filter((x) => x.name !== name), home });
    if (lay.problems.length) throw fail(AX.FAIL, `布局检查失败，不能继续：\n  - ${lay.problems.join("\n  - ")}`);
    await runOp(ports, "sync", { path: s.dir }, "落盘", name);
    const { relocate } = commitImport(s, ports, home);
    removeImportState(name, home);
    ports.out(`已完成 ${name} 的导入登记。`);
    if (relocate) ports.out(relocateHint(name));
    return AX.OK;
  } catch (e) {
    const f = toFailure(e);
    ports.err(f.message);
    return f.code;
  } finally {
    txn?.lock.release();
  }
}

// ───────────────────────────── relocation transaction (§3.4) ─────────────────────────────

/**
 * Common admission for every V5 mount (review M7): new-layout, NOT private (private vaults relocate
 * only through V6's setup-mode entry), not mounted anywhere (global mountinfo absent) and no live /
 * undecidable private instance or busy lease. → {v}; throws CliError.
 */
async function admitOwnMount(name, home, ports) {
  const rv = resolveVault(name, { home });
  if (rv.kind === "error") throw fail(rv.code, rv.message);
  const v = rv.vault;
  if (v.layout === "legacy") throw fail(AX.CONFIG, `旧布局保险库 ${name} 不支持迁址/口令验证`);
  if (v.private === true)
    throw fail(
      AX.CONFIG,
      `保险库 ${name} 是私有库：迁址/口令验证必须在私有挂载命名空间（setup 模式）内进行，当前版本拒绝——请等待 pi-secure init ${name} --fix-settings 的私有库路径`,
    );
  const st = await ports.probeMountState(v);
  if (st !== "absent")
    throw fail(AX.BUSY, `保险库 ${name} 当前已挂载（${st}）——先 pi-secure lock ${name}，再执行迁址/口令验证`);
  const view = await ports.vaultInstanceView(v, st);
  if (view.state !== "none" && view.state !== "stale")
    throw fail(AX.BUSY, `保险库 ${name} 有正在运行或无法判定的私有实例 / 租约被占用（${view.state}）——拒绝`);
  return { v };
}

/** Mount raw for our own exclusive use; a pre-existing mount (`already`) is refused untouched. */
async function ownRawMount(v, ports) {
  const m = await ports.unlockVault(v, { postMount: false });
  if (m?.how === "already")
    throw Object.assign(fail(AX.BUSY, `保险库 ${v.name} 已被其他进程挂载——拒绝在别人的挂载上操作（未改动）`), {
      foreignMount: true,
    });
  return m;
}

/**
 * Controlled relocation entry (V6: `init <名字> --fix-settings`; V5: `import --verify-password`).
 * Requires `relocate:{from,to,txid,phase}` on the entry. Mounts RAW (`unlockVault(v,{postMount:false})`)
 * on a vault that was unmounted and is not private, then — each step re-entrant, `phase` advanced under
 * the settings lock with the `relocateTxid` guard before it — sessions → memory → project sessionDir
 * (all fd-anchored inside the mount, workers) → `sync -f <realCipher>` → clear `relocate` (only this
 * txid) → unmount (always: the mount is ours). → {code, message?, warnings[]}. Never throws.
 */
export async function relocateVault({ name, home = homeDir() }, portsIn) {
  const ports = withPorts(portsIn);
  const warnings = [];
  const es = vaultEntryState(name, home);
  if (es.kind !== "present") return { code: AX.CONFIG, message: unknownEntry(name, es).message, warnings };
  const entry = es.entry;
  const rel = entry.relocate;
  if (!isPlain(rel) || !isAbs(rel.from) || !isAbs(rel.to) || typeof rel.txid !== "string")
    return { code: AX.CONFIG, message: `保险库 ${name} 没有待完成的迁址`, warnings };
  if (entry.pending !== undefined)
    return { code: AX.BUSY, message: `保险库 ${name} 有未完成的转换/导入（${entry.pending}）`, warnings };
  let mounted;
  let v;
  let result;
  try {
    ({ v } = await admitOwnMount(name, home, ports));
    const realWorkNow = path.join(physicalPaths(v).realMnt, "work");
    if (realWorkNow !== rel.to)
      throw fail(AX.CONFIG, `迁址目标 ${rel.to} 与保险库当前工作目录 ${realWorkNow} 不一致——请人工检查登记项`);
    const phase = (p) => {
      const r = ports.patchVaultEntry(
        name,
        { relocateTxid: rel.txid },
        { set: { relocate: { ...rel, phase: p } } },
        { home },
      );
      if (r.kind !== "ok") throw fail(AX.IO, `更新迁址阶段失败（${r.kind}${r.reason ? `：${r.reason}` : ""}）`);
    };
    const m = await ownRawMount(v, ports);
    mounted = true;
    const realMnt = m?.realMnt ?? physicalPaths(v).realMnt;
    const base = { realMnt, mountCheck: true };
    phase("sessions");
    const sr = await runOp(
      ports,
      "relocate-sessions",
      {
        ...base,
        rules: {
          from: rel.from,
          to: rel.to,
          fromSessionsDir: stateSessionsDirFor(rel.from),
          toSessionsDir: stateSessionsDirFor(rel.to),
        },
      },
      "会话迁址",
      name,
    );
    phase("memory");
    const mr = await runOp(ports, "relocate-memory", { ...base, from: rel.from, to: rel.to }, "memory 迁址", name);
    if (mr.reason === "target-exists")
      warnings.push(`memory 目标目录 state/memory/${mr.toSlug} 已存在，未合并（state/memory/${mr.fromSlug} 保留）`);
    phase("settings");
    const pr = await runOp(
      ports,
      "relocate-settings",
      { ...base, want: v.sessionDir, home, now: ports.now().getTime() },
      "项目 sessionDir 改写",
      name,
    );
    if (pr.kind === "fixed") warnings.push(`已备份原项目设置到 ${pr.backup}`);
    await runOp(ports, "sync", { path: physicalPaths(v).realCipher }, "落盘", name);
    phase("synced");
    const c = ports.patchVaultEntry(name, { relocateTxid: rel.txid }, { remove: ["relocate"] }, { home });
    if (c.kind !== "ok") throw fail(AX.IO, `清除迁址标记失败（${c.kind}${c.reason ? `：${c.reason}` : ""}）`);
    result = { code: AX.OK, warnings, sessions: sr, memory: mr };
  } catch (e) {
    const f = toFailure(e);
    result = { code: f.code, message: f.message, warnings };
  }
  if (mounted) await unmountOwn(v, ports, result);
  for (const w of result.warnings) ports.err(w);
  if (result.code === AX.OK) ports.out(`保险库 ${name} 迁址完成（${rel.from} → ${rel.to}）。`);
  else ports.err(result.message);
  return result;
}

async function unmountOwn(v, ports, result) {
  const fr = await ports.finalizeBounded(v);
  if (fr && fr.code !== 0) {
    result.warnings.push(`卸载未完成：${(fr.lines ?? []).join("; ")}（pi-secure lock ${v.name}）`);
    if (result.code === AX.OK) result.code = fr.code;
  }
}

/**
 * `--verify-password` when no relocation is needed (review M9): same admission as relocateVault,
 * a raw mount (gocryptfs reads the password from the TTY) and a bounded unmount; nothing is written.
 */
export async function verifyVaultPassword({ name, home = homeDir() }, portsIn) {
  const ports = withPorts(portsIn);
  const result = { code: AX.OK, warnings: [] };
  let v;
  let mounted;
  try {
    ({ v } = await admitOwnMount(name, home, ports));
    await ownRawMount(v, ports);
    mounted = true;
  } catch (e) {
    const f = toFailure(e);
    Object.assign(result, { code: f.code, message: f.message });
  }
  if (mounted) await unmountOwn(v, ports, result);
  for (const w of result.warnings) ports.err(w);
  if (result.code === AX.OK) ports.out(`保险库 ${name} 口令验证通过。`);
  return result;
}

// ───────────────────────────── internal worker entry ─────────────────────────────

const isEntry = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === SELF;
  } catch {
    return false;
  }
})();
if (isEntry) {
  workerMain(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`archive.mjs: ${e?.stack ?? e}\n`);
      process.exit(AX.FAIL);
    },
  );
}
