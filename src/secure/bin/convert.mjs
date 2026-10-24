// pi-secure convert orchestration — package V4 of docs/dev/data-encryption/convert-plan.md (r3, §1 / §2 / §5 / §6).
//
// `pi-secure convert <明文目录> [<名字>]` / `--resume <名字>` / `--abort <名字>`:
//   早检（原目录，只为尽早拒绝）→ 确认 → 认领名字、建库、挂载（口令全在改名之前）→ 原目录同级
//   `mv -n -T` 改名为备份 → 备份整树只读 → 冻结后复扫占用 → 备份上的权威检查（= 基线）→ 从备份
//   拷入 work → 读回校验 + git → 项目 sessionDir → 会话/memory 复制（V3）→ 持久化屏障 → 复核备份
//   基线 → 原路径建符号链接 → 清除登记项 pending（唯一提交点）→ 收尾。
//
// User rulings / invariants (convert-plan r3 + V2 threat-model ruling):
//   • NOTHING of the source is ever deleted or modified in content: the original directory is only
//     renamed (RENAME_NOREPLACE, identity-judged) to a sibling backup and made read-only; rollback
//     restores the modes and renames it back. Old sessions and memory are only read.
//   • Rollback / --abort NEVER delete the new vault (r3.1 B3): after "unmounted ∧ lease idle ∧ no
//     occupants ∧ identity matches" it is renamed (RENAME_NOREPLACE) to `<名字>.aborted-<txid>` for
//     the user to delete; only an EMPTY mount point created by this txid may be rmdir'ed. Deleted
//     are only our own symlink (identity-checked), our own .txn files and the registry entry still
//     carrying `pending === convert:<txid>`.
//   • A state file is never its own authorization (r3.1 B1): --abort/--resume first bind every path
//     in it to the registry entry and to the derived paths (authorizeState), prove a recorded worker
//     group gone (B4), and --resume re-proves the vault identities + copy evidence (M5).
//   • The only commit point is clearing `pending` (step 14); afterwards no --abort.
//   • --resume only completes link + commit, and only from phase synced|linked.
//   • Every decision on recovery is made from the ACTUAL on-disk state (lstat + dev/ino); the phase
//     name only selects which action is allowed.
//   • Threat model: a TARGETED malicious same-uid process is out of scope; benign concurrent
//     modification is excluded by the occupancy scan (cwd/exe/fd/maps of same-uid processes).
//
// Plain ESM, zero dependencies beyond Node ≥22 built-ins + the sibling engines tree.mjs (V2) and
// sessions.mjs (V3). helper.mjs (V0) is NOT imported: every launcher facility arrives through the
// injected `ports` object (V6 assembles it from helper.mjs; tests pass fakes) — no import cycle.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs, { constants as fsc } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as T from "./tree.mjs";
import * as S from "./sessions.mjs";

// ───────────────────────────── constants ─────────────────────────────

/** §6 exit codes used by convert. */
export const CONVERT_EXIT = Object.freeze({
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
  SIGINT: 130,
  SIGTERM: 143,
});

/** §5 fixed bounds (data-proportional steps are bounded by the tree worker's stall watchdog). */
export const CONVERT_BUDGET = Object.freeze({
  occupancyMs: 5_000,
  occupancyMaxProcs: 32_768,
  occupancyMaxFdsPerProc: 65_536,
  occupancyRecheckRounds: 3,
  occupancyRecheckDelayMs: 100,
  gitMs: 30_000,
  gitMaxOut: 4 * 1024 * 1024,
  fsckBaseMs: 30_000,
  fsckPerGiBMs: 60_000,
  fsckMaxMs: 30 * 60_000,
  lockHandshakeMs: 5_000,
  groupReapMs: 2_000,
  leftoverReapMs: 3_000,
  gitFileMaxBytes: 4096,
});

export const CONVERT_PHASES = Object.freeze(["claimed", "renaming", "backed-up", "synced", "linked"]);

/** §1.3 系统目录 (double safety). `/lib*` is matched as a prefix family. */
export const SYSTEM_DIRS = Object.freeze([
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib*",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/run",
  "/var",
  "/opt",
  "/srv",
  "/snap",
  "/tmp",
]);

const VAULT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const TXID_RE = /^[0-9a-f]{16}$/;
/** Environment entry every worker / guard / git child of a conversion carries (round-2 B2). */
export const TXID_ENV = "PI_SECURE_TXID";
const STATE_V = 1;
const DIR_READ = fsc.O_RDONLY | fsc.O_DIRECTORY | fsc.O_NOFOLLOW;

/** Typed failure: `exit` is the §6 code; `keepState` ⇒ no rollback (step 13 EEXIST, step 14). */
export class ConvertError extends Error {
  constructor(exit, message, { code, lines, keepState = false } = {}) {
    super(message);
    this.name = "ConvertError";
    this.exit = exit;
    this.code = code ?? "convert";
    this.lines = lines ?? [];
    this.keepState = keepState;
  }
}
const CE = (exit, message, extra) => new ConvertError(exit, message, extra);

// ───────────────────────────── small fs helpers ─────────────────────────────

function lstatBigOrNull(p) {
  try {
    return fs.lstatSync(p, { bigint: true });
  } catch {
    return null;
  }
}
function idOf(st) {
  return { dev: String(st.dev), ino: String(st.ino) };
}
function sameId(a, b) {
  return !!a && !!b && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
}
function pathWithin(p, root) {
  if (p === root) return true;
  const base = root.endsWith("/") ? root : root + "/";
  return p.startsWith(base);
}
function realpathOr(p, fallback = p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return fallback;
  }
}
/** realpath of the nearest existing ancestor + the missing tail (never throws). */
function realpathNearest(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}
function nearestExisting(p) {
  let cur = path.resolve(p);
  for (;;) {
    if (lstatBigOrNull(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}
function fsyncDir(p) {
  const fd = fs.openSync(p, DIR_READ);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
/** Open `parent` as a directory fd and require its identity. → fd (caller closes). */
function openDirExpect(parent, expect) {
  const fd = fs.openSync(parent, DIR_READ);
  const st = fs.fstatSync(fd, { bigint: true });
  if (expect && !sameId(st, expect)) {
    fs.closeSync(fd);
    throw CE(CONVERT_EXIT.BUSY, `目录 ${parent} 已被替换（身份不符），停止`, { code: "parent-changed" });
  }
  return fd;
}
const fdPath = (fd, name) => `/proc/self/fd/${fd}/${name}`;

// ───────────────────────────── §1.1 arguments ─────────────────────────────

/** Default vault name: basename lower-cased, illegal chars → "-", cut to 32; undefined if still invalid. */
export function deriveVaultName(src) {
  let n = path
    .basename(path.resolve(src))
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 32);
  n = n.replace(/^[-_]+/, "");
  return VAULT_NAME_RE.test(n) ? n : undefined;
}

export const CONVERT_USAGE = [
  "pi-secure convert <明文目录> [<名字>] [--path <挂载点>] [--no-sessions] [--sessions-from <目录>]… [--private] [--assume-unreadable-idle]",
  "pi-secure convert --resume <名字> [--assume-unreadable-idle]",
  "pi-secure convert --abort  <名字> [--assume-unreadable-idle]",
].join("\n");

/**
 * → {mode:"convert", src, name?, mnt?, noSessions, sessionsFrom[], private, assumeUnreadableIdle?}
 *   | {mode:"resume"|"abort", name, assumeUnreadableIdle?}
 * throws ConvertError(2) on any malformed input. The only "assume" flag is
 * `--assume-unreadable-idle` (user ruling 2026-10-24, M8): the NON-interactive substitute for
 * confirming the uninspectable same-uid processes seen at the first occupancy check of this run;
 * the convert confirmation itself (typing the vault name, Q8) has no bypass.
 */
export function parseConvertArgs(args) {
  const usage = (why) => CE(CONVERT_EXIT.USAGE, `${why}\n用法：\n${CONVERT_USAGE}`, { code: "usage" });
  const pos = [];
  let mode = "convert";
  let resumeName;
  let mnt;
  let noSessions = false;
  let priv = false;
  let assume = false;
  const sessionsFrom = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = () => {
      const v = args[++i];
      if (v === undefined || v === "") throw usage(`${a} 缺少参数值`);
      return v;
    };
    if (a === "--resume" || a === "--abort") {
      if (mode !== "convert" || resumeName !== undefined) throw usage("--resume / --abort 只能出现一次");
      mode = a.slice(2);
      resumeName = val();
    } else if (a === "--path") {
      if (mnt !== undefined) throw usage("--path 只能出现一次");
      mnt = val();
    } else if (a.startsWith("--path=")) {
      if (mnt !== undefined) throw usage("--path 只能出现一次");
      mnt = a.slice(7);
      if (!mnt) throw usage("--path 缺少参数值");
    } else if (a === "--no-sessions") noSessions = true;
    else if (a === "--sessions-from") sessionsFrom.push(val());
    else if (a.startsWith("--sessions-from=")) {
      const v = a.slice("--sessions-from=".length);
      if (!v) throw usage("--sessions-from 缺少参数值");
      sessionsFrom.push(v);
    } else if (a === "--private") priv = true;
    else if (a === "--assume-unreadable-idle") assume = true;
    else if (a === "--") {
      pos.push(...args.slice(i + 1));
      break;
    } else if (a.startsWith("-")) throw usage(`未知参数：${a}`);
    else pos.push(a);
  }
  if (mode !== "convert") {
    if (pos.length || mnt !== undefined || noSessions || priv || sessionsFrom.length)
      throw usage(`--${mode} 不接受其他参数`);
    if (!VAULT_NAME_RE.test(resumeName)) throw usage(`保险库名不合法：${resumeName}`);
    return { mode, name: resumeName, ...(assume ? { assumeUnreadableIdle: true } : {}) };
  }
  if (pos.length < 1 || pos.length > 2) throw usage("需要 <明文目录> [<名字>]");
  if (noSessions && sessionsFrom.length) throw usage("--no-sessions 不与 --sessions-from 同用");
  const name = pos[1];
  if (name !== undefined && !VAULT_NAME_RE.test(name))
    throw usage(`保险库名不合法：${name}（须匹配 ${VAULT_NAME_RE}）`);
  return {
    mode,
    src: pos[0],
    ...(name ? { name } : {}),
    ...(mnt ? { mnt } : {}),
    noSessions,
    sessionsFrom,
    private: priv,
    ...(assume ? { assumeUnreadableIdle: true } : {}),
  };
}

/** `~/x` / absolute ⇒ absolute; relative ⇒ against `cwd` when known; else undefined. */
export function expandUserPath(raw, { home, cwd }) {
  if (typeof raw !== "string" || raw === "") return undefined;
  if (raw === "~") return path.resolve(home);
  if (raw.startsWith("~/")) return path.resolve(home, raw.slice(2));
  if (raw.startsWith("/")) return path.resolve(raw);
  if (cwd && path.isAbsolute(cwd)) return path.resolve(cwd, raw);
  return undefined;
}

// ───────────────────────────── §1.3 path rules ─────────────────────────────

function inSystemDir(p, systemDirs) {
  for (const d of systemDirs) {
    if (d.endsWith("*")) {
      const stem = d.slice(0, -1);
      const first = "/" + (p.split("/")[1] ?? "");
      if (first.startsWith(stem)) return d;
    } else if (pathWithin(p, d)) return d;
  }
  return undefined;
}

/**
 * §1.3 路径 + 系统目录 rows, on BOTH spellings (literal and realpath). Pure (the caller lstat'ed).
 * `vaults`: [{name, dir, mnt}] registered vaults (plus their physical spellings when resolvable).
 * → problems [{code, path, detail?}] (all exit 65)
 */
export function pathRuleProblems({ src, srcReal, home, agentDir, vaults = [], systemDirs = SYSTEM_DIRS }) {
  const out = [];
  const homeReal = realpathOr(home, path.resolve(home));
  const spellings = [...new Set([path.resolve(src), srcReal])];
  for (const p of spellings) {
    const homes = [...new Set([path.resolve(home), homeReal])];
    if (!homes.some((h) => p !== h && pathWithin(p, h)))
      out.push({ code: "path-home", path: p, detail: "须严格位于 $HOME 之下" });
    for (const h of homes) {
      if (p !== h && pathWithin(p, h)) {
        const first = p.slice(h.length + 1).split("/")[0] ?? "";
        if (first.startsWith(".")) out.push({ code: "path-dot", path: p, detail: `位于 ${path.join(h, first)} 之下` });
      }
    }
    const sys = inSystemDir(p, systemDirs);
    if (sys) out.push({ code: "path-system", path: p, detail: sys });
    for (const v of vaults) {
      for (const q of [...new Set([v.dir, v.mnt, realpathNearest(v.dir), realpathNearest(v.mnt)].filter(Boolean))]) {
        if (pathWithin(p, q)) out.push({ code: "path-vault", path: p, detail: `位于保险库 ${v.name} 的 ${q} 之内` });
        else if (pathWithin(q, p)) out.push({ code: "path-vault", path: p, detail: `包含保险库 ${v.name} 的 ${q}` });
      }
    }
    if (agentDir) {
      for (const a of [...new Set([path.resolve(agentDir), realpathNearest(agentDir)])])
        if (pathWithin(a, p) || pathWithin(p, a))
          out.push({ code: "path-agent", path: p, detail: `与 pi agent 目录 ${a} 重叠` });
    }
  }
  const seen = new Set();
  return out.filter((x) => {
    const k = `${x.code}\0${x.detail ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const PATH_PROBLEM_TEXT = {
  "path-home": "不在 $HOME 之下（或就是 $HOME / 其祖先）",
  "path-dot": "位于 $HOME/.* 之下",
  "path-system": "位于系统目录之下",
  "path-vault": "与已登记保险库重叠",
  "path-agent": "与 pi agent 目录重叠",
  "path-symlink": "源路径本身是符号链接",
  "path-not-dir": "不是目录",
  "vault-in-tree": "保险库位置落在源目录之内",
};
function formatPathProblems(ps) {
  return ps.map((p) => `  ${p.path ?? ""}：${PATH_PROBLEM_TEXT[p.code] ?? p.code}${p.detail ? `（${p.detail}）` : ""}`);
}

// ───────────────────────────── bounded child processes (git) ─────────────────────────────

/**
 * Round-2 B2: does /proc/<pid>/environ carry exactly `PI_SECURE_TXID=<txid>`?
 * → true | false | undefined (unreadable / gone — never treated as proof)
 */
function environHasTxid(pid, txid, procRoot) {
  try {
    const b = fs.readFileSync(`${procRoot}/${pid}/environ`);
    return b.toString("latin1").split("\0").includes(`${TXID_ENV}=${txid}`);
  } catch {
    return undefined;
  }
}

/**
 * Round-2 B2: a process group may be signalled only when EVERY live member is proven to belong to
 * this conversion: same uid, started no earlier than the recorded leader start, and its initial
 * environment carries this txid exactly (every worker / guard / git child is started with
 * `PI_SECURE_TXID=<txid>`); a present leader (even a zombie) must have the recorded start time.
 * Start time alone only proves "not reused", never "ours" — a tampered state.worker pointing at an
 * unrelated group fails here. → {ok:true, empty?} | {ok:false, why}
 */
export function proveGroupOurs(pgid, { txid, uid = process.getuid(), procRoot = "/proc", leaderStart }) {
  if (!TXID_RE.test(String(txid))) return { ok: false, why: "缺少事务标记" };
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return { ok: false, why: "pgid 不合法" };
  const scan = T.scanGroup(pgid, procRoot);
  if (!scan.complete) return { ok: false, why: "/proc 扫描不完整" };
  if (scan.members.length === 0) return { ok: true, empty: true };
  if (scan.leader && leaderStart !== undefined && scan.leader.start !== String(leaderStart))
    return { ok: false, why: "组长的启动时间与记录不符" };
  for (const m of scan.members) {
    if (leaderStart !== undefined && BigInt(m.start) < BigInt(leaderStart))
      return { ok: false, why: `成员 ${m.pid} 早于记录的组长启动` };
    let st;
    try {
      st = fs.statSync(`${procRoot}/${m.pid}`);
    } catch {
      return { ok: false, why: `成员 ${m.pid} 无法读取` };
    }
    if (st.uid !== uid) return { ok: false, why: `成员 ${m.pid} 属于其他用户` };
    if (environHasTxid(m.pid, txid, procRoot) !== true)
      return { ok: false, why: `成员 ${m.pid} 的环境中没有本事务标记 ${TXID_ENV}=${txid}` };
  }
  return { ok: true };
}

/** Signal process group `pgid` only after proveGroupOurs. → the proof (+ sent:true when signalled) */
export function signalGroupIfOurs(pgid, sig, opts) {
  const p = proveGroupOurs(pgid, opts);
  if (!p.ok || p.empty) return p;
  try {
    process.kill(-pgid, sig);
  } catch {
    /* gone meanwhile */
  }
  return { ...p, sent: true };
}

/**
 * r3.1 B4 owner-death guard. Every worker / git child runs as
 * `sh -c OWNER_GUARD_SH pi-secure-guard <argv…>`: the sh (group leader) records its parent pid,
 * starts a watcher subshell (stdin/stdout/stderr detached) and runs `<argv…>` in the foreground
 * with the original stdin/stdout/stderr. The watcher re-reads the sh's PPid every 0.25 s; once it
 * changes (the orchestrator died — even by SIGKILL — and the sh was re-parented) or the sh is gone,
 * it SIGKILLs the whole process group. Pure sh builtins + `sleep`; no pid-reuse ambiguity (the sh
 * reads its OWN /proc/$$/status, `$$` is the parent shell inside the subshell, POSIX).
 */
export const OWNER_GUARD_SH = [
  "p0=",
  'while read -r k v; do if [ "$k" = PPid: ]; then p0=$v; break; fi; done </proc/$$/status',
  '[ -n "$p0" ] || exit 125',
  "(",
  "  while :; do",
  "    p=",
  '    while read -r k v; do if [ "$k" = PPid: ]; then p=$v; break; fi; done </proc/$$/status',
  '    if [ "$p" != "$p0" ]; then kill -KILL 0; fi',
  "    sleep 0.25",
  "  done",
  ") </dev/null >/dev/null 2>&1 &",
  "g=$!",
  '"$@"',
  "rc=$?",
  'kill -KILL "$g" 2>/dev/null',
  "exit $rc",
].join("\n");

/** Wrap `argv` (absolute argv[0]) in the owner-death guard. */
export function guardArgv(argv) {
  return ["/bin/sh", "-c", OWNER_GUARD_SH, "pi-secure-guard", ...argv];
}

/**
 * Run `cmd args` in its OWN process group with a hard deadline. Output capped. After the ending the
 * group is SIGKILLed while it provably still is ours and confirmed empty through a COMPLETE /proc
 * scan (fail-closed, like tree.mjs): `clean:false` otherwise.
 * → {kind:"exit", code, signal, stdout, stderr, clean} | {kind:"timeout", clean} | {kind:"error", message}
 */
export function runBounded(
  cmd,
  args,
  {
    cwd = "/",
    env,
    timeoutMs,
    maxOut = CONVERT_BUDGET.gitMaxOut,
    spawnImpl = spawn,
    procRoot = "/proc",
    guard = false,
    txid,
    uid = process.getuid(),
  } = {},
) {
  return new Promise((resolve) => {
    let child;
    try {
      const argv = guard ? guardArgv([cmd, ...args]) : [cmd, ...args];
      child = spawnImpl(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ kind: "error", message: String(e && e.message) });
      return;
    }
    const pgid = child.pid;
    const leaderStart = pgid === undefined ? undefined : T.readProcStart(pgid, procRoot);
    const bufs = { out: [], err: [], outN: 0, errN: 0 };
    let overflow = false;
    child.stdout?.on("data", (b) => {
      if (bufs.outN + b.length > maxOut) overflow = true;
      else {
        bufs.out.push(b);
        bufs.outN += b.length;
      }
    });
    child.stderr?.on("data", (b) => {
      if (bufs.errN < 8192) {
        bufs.err.push(b);
        bufs.errN += b.length;
      }
    });
    let done = false;
    // round-2 B2: every signal needs the environ proof (txid) — also for our own child's group
    const kill = () => signalGroupIfOurs(pgid, "SIGKILL", { txid, uid, procRoot, leaderStart });
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (pgid === undefined) {
        resolve(r);
        return;
      }
      const until = Date.now() + CONVERT_BUDGET.groupReapMs;
      const poll = () => {
        const s = T.scanGroup(pgid, procRoot);
        const clean = s.complete && s.members.length === 0;
        if (clean || Date.now() >= until) {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          resolve({ ...r, clean });
          return;
        }
        kill();
        setTimeout(poll, 50);
      };
      poll();
    };
    const timer = setTimeout(() => {
      kill();
      finish({ kind: "timeout" });
    }, timeoutMs);
    child.on("error", (e) => finish({ kind: "error", message: String(e && e.message) }));
    child.on("close", (code, signal) =>
      finish({
        kind: "exit",
        code: code ?? 128,
        signal: signal ?? undefined,
        stdout: Buffer.concat(bufs.out).toString("utf8"),
        stderr: Buffer.concat(bufs.err).toString("utf8"),
        overflow,
      }),
    );
  });
}

// ───────────────────────────── §1.3.1 git rules ─────────────────────────────

/** Fixed PATH for git children (same policy as the web-hub worktree-diff runner, src/git/diff.ts). */
export const GIT_PATH = "/usr/bin:/bin";

/**
 * §1.3.1 minimal git environment (r3.1 hardening, mirrors worktree-diff's `envPolicy:"minimal"`):
 * NOTHING inherited except HOME; PATH pinned; global + system config and system attributes off;
 * optional locks, pager, prompts and lazy fetches off.
 */
export function gitEnv(env, { ceiling } = {}) {
  const out = { PATH: GIT_PATH };
  if (typeof env?.HOME === "string") out.HOME = env.HOME;
  out.LC_ALL = "C";
  out.GIT_CONFIG_GLOBAL = "/dev/null";
  out.GIT_CONFIG_NOSYSTEM = "1";
  out.GIT_ATTR_NOSYSTEM = "1";
  out.GIT_OPTIONAL_LOCKS = "0";
  out.GIT_NO_LAZY_FETCH = "1";
  out.GIT_PAGER = "cat";
  out.GIT_TERMINAL_PROMPT = "0";
  if (ceiling) out.GIT_CEILING_DIRECTORIES = ceiling;
  return out;
}

/** Global options on EVERY git call (the per-repo attr-source + driver neutralization is added on top). */
export const GIT_BASE_ARGS = Object.freeze([
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
]);

/** Empty-tree oids per object format (identical to src/git/diff.ts WTDIFF_EMPTY_TREE). */
export const GIT_EMPTY_TREE = Object.freeze({
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
});
/** Executable filter/diff driver slots (identical to src/git/diff.ts DRIVER_SCAN_REGEXP). */
export const GIT_DRIVER_SCAN_REGEXP = "^(filter|diff)\\..+\\.(clean|smudge|process|required|textconv|command)$";
/** Driver names allowed into `-c filter.<n>.*` slots (src/git/diff.ts WTDIFF_DRIVER_NAME_RE). */
const GIT_DRIVER_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Blank every filter/diff command slot of every configured driver name (worktree-diff L2). */
export function gitNeutralizeArgs(names) {
  const args = [];
  for (const n of names) {
    if (!GIT_DRIVER_NAME_RE.test(n)) continue;
    args.push(
      "-c",
      `filter.${n}.clean=`,
      "-c",
      `filter.${n}.smudge=`,
      "-c",
      `filter.${n}.process=`,
      "-c",
      `filter.${n}.required=false`,
      "-c",
      `diff.${n}.textconv=`,
      "-c",
      `diff.${n}.command=`,
    );
  }
  return args;
}

/** One git call, bounded (`runBounded`). → {ok, code, out, err} ; timeout/unclean ⇒ ok:false, kind */
async function git(ctx, dir, args, { timeoutMs = CONVERT_BUDGET.gitMs, hard = [] } = {}) {
  const bin = T.findOnPath(ctx.bins.git, ctx.env.PATH ?? "");
  if (!bin) return { ok: false, kind: "error", message: "git not found" };
  const r = await runBounded(bin, [...GIT_BASE_ARGS, ...hard, "-C", dir, ...args], {
    cwd: "/",
    env: { ...gitEnv(ctx.env, { ceiling: path.dirname(dir) }), ...txidEnv(ctx) },
    timeoutMs,
    spawnImpl: ctx.spawnImpl,
    guard: true,
    txid: ctx.txid,
    uid: ctx.uid,
    procRoot: ctx.procRoot,
  });
  if (r.kind === "error") return { ok: false, kind: "error", message: r.message };
  if (r.kind === "timeout") return { ok: false, kind: "timeout" };
  if (!r.clean) return { ok: false, kind: "unclean" };
  if (r.overflow) return { ok: false, kind: "overflow" };
  return { ok: true, code: r.code, out: r.stdout, err: r.stderr };
}

/**
 * Per-repo hardening (worktree-diff L1+L2): `--attr-source=<empty tree>` for the repo's object
 * format replaces every attribute source, and every filter/diff driver name found in the repo's
 * config gets all its command slots blanked. Anything not provable ⇒ {ok:false} (caller refuses).
 * → {ok:true, hard:[…args]} | {ok:false, detail}
 */
export async function gitHardening(ctx, top) {
  const of = await git(ctx, top, ["rev-parse", "--show-object-format"]);
  const format = of.ok && of.code === 0 ? of.out.trim() : undefined;
  if (format !== "sha1" && format !== "sha256")
    return { ok: false, detail: `无法确定对象格式（${of.kind ?? `exit ${of.code}`}）` };
  const sc = await git(ctx, top, ["config", "--name-only", "--get-regexp", GIT_DRIVER_SCAN_REGEXP]);
  if (!sc.ok || (sc.code !== 0 && sc.code !== 1)) return { ok: false, detail: "无法读取 filter/diff 驱动配置" };
  const names = new Set();
  for (const key of sc.code === 0 ? sc.out.split("\n") : []) {
    if (!key) continue;
    const first = key.indexOf(".");
    const last = key.lastIndexOf(".");
    const name = first >= 0 && last > first ? key.slice(first + 1, last) : "";
    if (!GIT_DRIVER_NAME_RE.test(name)) return { ok: false, detail: `无法安全禁用的驱动名：${JSON.stringify(key)}` };
    names.add(name);
  }
  return {
    ok: true,
    hard: [`--attr-source=${GIT_EMPTY_TREE[format]}`, ...gitNeutralizeArgs([...names].sort())],
  };
}

/** Lexical: is `p` (absolute) inside the tree? `roots` maps original spellings onto `treeRoot`. */
function insideTree(p, roots) {
  return roots.some((r) => pathWithin(path.resolve(p), r));
}

/**
 * Read a small regular file through O_NOFOLLOW.
 * → {kind:"absent"} (ENOENT only) | {kind:"ok", text} | {kind:"error", detail} (symlink, not
 * regular, too big, EACCES, … — callers refuse: r3.1 M7, never "treat as absent").
 */
function readSmall(p, max = CONVERT_BUDGET.gitFileMaxBytes) {
  let fd;
  try {
    fd = fs.openSync(p, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { kind: "error", detail: "不是普通文件" };
    if (st.size > max) return { kind: "error", detail: `超过 ${max} 字节` };
    const b = Buffer.alloc(st.size);
    const n = fs.readSync(fd, b, 0, st.size, 0);
    return { kind: "ok", text: b.subarray(0, n).toString("utf8") };
  } catch (e) {
    if (e && e.code === "ENOENT") return { kind: "absent" };
    return { kind: "error", detail: e && e.code === "ELOOP" ? "是符号链接" : String((e && e.code) || e) };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Parse `git worktree list --porcelain`: records are separated by blank lines. */
export function countWorktreeRecords(text) {
  return text
    .split(/\n\s*\n/)
    .map((r) => r.trim())
    .filter((r) => r.startsWith("worktree ")).length;
}

/**
 * §1.3.1 on `treeRoot` (the frozen backup for the authoritative check; the original for the early
 * check). `gitEntries` come from the tree manifest (tree.mjs gitEntries). `origRoots` = original
 * literal + realpath spellings (absolute paths under them are inside after conversion).
 * Every git call carries the per-repo hardening (`gitHardening`); a repo that cannot be hardened is
 * `git-uncertain`. No porcelain `status` (it can run clean/process filters and refresh the index —
 * r3.1 M6): content equality of the copy is proven byte-for-byte by tree verify, .git included.
 * → {problems:[{code, rel, detail}], repos:[{rel, head}], prereq?:true}
 */
export async function gitRuleProblems(treeRoot, { gitEntries = [], origRoots = [], ctx }) {
  const problems = [];
  const repos = [];
  if (gitEntries.length === 0) return { problems, repos };
  if (!T.findOnPath(ctx.bins.git, ctx.env.PATH ?? "")) return { problems, repos, prereq: true };
  const treeReal = realpathOr(treeRoot);
  const map = (abs) => {
    const p = path.resolve(abs);
    for (const o of origRoots) if (pathWithin(p, o)) return path.join(treeRoot, path.relative(o, p));
    return p;
  };
  const roots = [path.resolve(treeRoot), treeReal];
  const fail = (code, rel, detail) => problems.push({ code, rel, detail });
  const gitDirs = [];
  for (const g of gitEntries) {
    const abs = path.join(treeRoot, g.rel);
    if (g.type === "file") {
      const r = readSmall(abs);
      const m = r.kind === "ok" ? /^gitdir:\s*(.+?)\s*$/m.exec(r.text) : null;
      if (!m) {
        fail("git-file", g.rel, r.kind === "error" ? `.git 文件无法读取（${r.detail}）` : ".git 文件无法解析");
        continue;
      }
      const target = map(path.resolve(path.dirname(abs), m[1]));
      if (!insideTree(target, roots)) fail("git-gitdir-outside", g.rel, `gitdir 指向树外：${m[1]}`);
      else gitDirs.push({ rel: g.rel, dir: target, top: path.dirname(abs) });
    } else if (g.type === "dir") gitDirs.push({ rel: g.rel, dir: abs, top: path.dirname(abs) });
    else if (g.type === "symlink") fail("git-symlink", g.rel, ".git 是符号链接");
    else fail("git-file", g.rel, `.git 类型不支持（${g.type}）`);
  }
  for (const gd of gitDirs) {
    const alt = readSmall(path.join(gd.dir, "objects", "info", "alternates"), 1024 * 1024);
    if (alt.kind === "error") fail("git-uncertain", gd.rel, `objects/info/alternates 无法读取（${alt.detail}）`);
    else if (alt.kind === "ok") {
      for (const line of alt.text.split("\n").map((l) => l.trim())) {
        if (!line || line.startsWith("#")) continue;
        const t = map(path.resolve(path.join(gd.dir, "objects"), line));
        if (!insideTree(t, roots)) fail("git-alternates", gd.rel, `alternates 指向树外：${line}`);
      }
    }
    const common = readSmall(path.join(gd.dir, "commondir"));
    if (common.kind === "error") fail("git-uncertain", gd.rel, `commondir 无法读取（${common.detail}）`);
    else if (common.kind === "ok") {
      const t = map(path.resolve(gd.dir, common.text.trim()));
      if (!insideTree(t, roots)) fail("git-commondir", gd.rel, `commondir 指向树外：${common.text.trim()}`);
    }
  }
  if (problems.length) return { problems, repos };
  for (const gd of gitDirs) {
    const isRoot = gd.rel === ".git";
    const hz = await gitHardening(ctx, gd.top);
    if (!hz.ok) {
      fail("git-uncertain", gd.rel, `无法确认 git 只读（${hz.detail}）`);
      continue;
    }
    const g = (args) => git(ctx, gd.top, args, { hard: hz.hard });
    const top = await g(["rev-parse", "--show-toplevel"]);
    if (!top.ok || top.code !== 0) {
      fail("git-uncertain", gd.rel, `git rev-parse 失败（${top.kind ?? `exit ${top.code}`}）`);
      continue;
    }
    if (top.out.trim() !== realpathOr(gd.top)) fail("git-toplevel", gd.rel, `toplevel = ${top.out.trim()}`);
    const cd = await g(["rev-parse", "--git-common-dir"]);
    if (!cd.ok || cd.code !== 0) fail("git-uncertain", gd.rel, "git rev-parse --git-common-dir 失败");
    else if (!insideTree(map(path.resolve(gd.top, cd.out.trim())), roots))
      fail("git-commondir", gd.rel, `common dir 在树外：${cd.out.trim()}`);
    const wt = await g(["config", "--get", "core.worktree"]);
    if (!wt.ok || (wt.code !== 0 && wt.code !== 1)) fail("git-uncertain", gd.rel, "git config 读取失败");
    else if (wt.code === 0) {
      const val = wt.out.trim();
      const resolved = map(path.resolve(gd.dir, val));
      // root repo: any core.worktree refuses (§1.3.1); nested repos (submodules keep a relative
      // core.worktree pointing at their own checkout) refuse when it leaves the tree or the checkout.
      if (isRoot || !insideTree(resolved, roots) || path.resolve(resolved) !== path.resolve(gd.top))
        fail("git-core-worktree", gd.rel, `core.worktree = ${val}`);
    }
    const wl = await g(["worktree", "list", "--porcelain"]);
    if (!wl.ok || wl.code !== 0) fail("git-uncertain", gd.rel, "git worktree list 失败");
    else if (countWorktreeRecords(wl.out) > 1)
      fail("git-linked-worktree", gd.rel, "存在 linked worktree（先 git worktree remove / prune）");
    if (isRoot) {
      const head = await g(["rev-parse", "-q", "--verify", "HEAD"]);
      if (!head.ok || (head.code !== 0 && head.code !== 1)) fail("git-uncertain", gd.rel, "git rev-parse HEAD 失败");
      repos.push({ rel: gd.rel, head: head.ok && head.code === 0 ? head.out.trim() : null });
    }
  }
  return { problems, repos };
}

const GIT_PROBLEM_TEXT = {
  "git-file": ".git 文件无法解析",
  "git-symlink": ".git 是符号链接",
  "git-gitdir-outside": "gitdir 指向树外",
  "git-alternates": "objects/info/alternates 指向树外",
  "git-commondir": "git common dir 在树外",
  "git-toplevel": "git toplevel 与目录根不一致",
  "git-core-worktree": "配置了 core.worktree",
  "git-linked-worktree": "存在 linked worktree",
  "git-uncertain": "git 检查失败或超时",
};
function formatGitProblems(ps) {
  return ps.map((p) => `  ${p.rel}：${GIT_PROBLEM_TEXT[p.code] ?? p.code}${p.detail ? `（${p.detail}）` : ""}`);
}

// ───────────────────────────── §1.3 occupancy ─────────────────────────────

const stripDeleted = (s) => (s.endsWith(" (deleted)") ? s.slice(0, -" (deleted)".length) : s);

/**
 * Same-uid processes whose cwd, exe, any fd target or any mapped file lies inside one of `roots`
 * (physical spellings — the kernel reports physical paths). Processes of other uids are skipped;
 * same-uid processes whose /proc entries cannot be read (non-dumpable, e.g. ssh-agent, sd-pam, the
 * user's sshd session) are listed in `unreadablePids` with pid / comm / starttime / exe (when
 * readable) — nothing proves they do not use the tree, so the caller requires an explicit user
 * confirmation of exactly these identities (`confirmUnreadable`, user ruling 2026-10-24).
 * Over `deadlineMs` ⇒ {kind:"timeout"}; more than `maxProcs` pids ⇒ {kind:"too-many"} — both mean
 * "uncertain" and the caller refuses (75).
 * → {kind:"done", occupants:[{pid, comm, via, path}], unreadable, unreadablePids:[{pid, comm}]} | {kind:"timeout"} | {kind:"too-many", count} | {kind:"error", message}
 */
export async function scanOccupants(
  roots,
  {
    procRoot = "/proc",
    uid = process.getuid(),
    selfPid = process.pid,
    deadlineMs = CONVERT_BUDGET.occupancyMs,
    maxProcs = CONVERT_BUDGET.occupancyMaxProcs,
    excludePids = [],
    recheckRounds = CONVERT_BUDGET.occupancyRecheckRounds,
    recheckDelayMs = CONVERT_BUDGET.occupancyRecheckDelayMs,
  } = {},
) {
  const deadline = Date.now() + deadlineMs;
  const rs = [...new Set(roots.map((r) => path.resolve(r)))];
  const hit = (p) => typeof p === "string" && p.startsWith("/") && rs.some((r) => pathWithin(stripDeleted(p), r));
  const skip = new Set([selfPid, ...excludePids]);
  let names;
  try {
    names = (await fsp.readdir(procRoot)).filter((n) => /^\d+$/.test(n) && !skip.has(Number(n)));
  } catch (e) {
    return { kind: "error", message: String(e && e.message) };
  }
  if (names.length > maxProcs) return { kind: "too-many", count: names.length };
  const gone = (e) => e && (e.code === "ENOENT" || e.code === "ESRCH");
  /** One pid → "skip" (gone / other uid / zombie) | {found, blocked, comm} | {kind: error/timeout/too-many} */
  const inspect = async (n) => {
    const base = path.join(procRoot, n);
    let st;
    try {
      st = await fsp.stat(base);
    } catch (e) {
      if (gone(e)) return "skip";
      return { kind: "error", message: String(e && e.message) };
    }
    if (st.uid !== uid) return "skip";
    let start;
    try {
      // a zombie / dead task has no cwd, fds or mappings left: it cannot hold anything
      const stat = await fsp.readFile(path.join(base, "stat"), "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" || fields[0] === "X") return "skip";
      if (/^\d+$/.test(fields[19] ?? "")) start = fields[19];
    } catch (e) {
      if (gone(e)) return "skip";
    }
    const found = [];
    let blocked = false;
    let exe;
    for (const via of ["cwd", "exe"]) {
      try {
        const t = await fsp.readlink(path.join(base, via));
        if (via === "exe") exe = stripDeleted(t);
        if (hit(t)) found.push({ via, path: stripDeleted(t) });
      } catch (e) {
        if (!gone(e) && via === "cwd") blocked = true;
      }
    }
    try {
      const fds = await fsp.readdir(path.join(base, "fd"));
      if (fds.length > CONVERT_BUDGET.occupancyMaxFdsPerProc) return { kind: "too-many", count: fds.length };
      for (const fd of fds) {
        if (Date.now() >= deadline) return { kind: "timeout" };
        try {
          const t = await fsp.readlink(path.join(base, "fd", fd));
          if (hit(t)) found.push({ via: `fd ${fd}`, path: stripDeleted(t) });
        } catch {
          /* closed meanwhile */
        }
      }
    } catch (e) {
      if (!gone(e)) blocked = true;
    }
    try {
      const maps = await fsp.readFile(path.join(base, "maps"), "utf8");
      for (const line of maps.split("\n")) {
        const i = line.indexOf("/");
        if (i < 0) continue;
        const p = line.slice(i);
        if (hit(p)) {
          found.push({ via: "maps", path: stripDeleted(p) });
          break;
        }
      }
    } catch (e) {
      if (!gone(e)) blocked = true;
    }
    let comm = "?";
    if (found.length || blocked) {
      try {
        comm = (await fsp.readFile(path.join(base, "comm"), "utf8")).trim();
      } catch {
        /* keep ? */
      }
    }
    return { found, blocked, comm, start, exe };
  };
  const occupants = [];
  let pendingUnreadable = [];
  for (const n of names) {
    if (Date.now() >= deadline) return { kind: "timeout" };
    const r = await inspect(n);
    if (r === "skip") continue;
    if (r.kind) return r;
    if (r.found.length) occupants.push({ pid: Number(n), comm: r.comm, via: r.found[0].via, path: r.found[0].path });
    else if (r.blocked) pendingUnreadable.push(n);
  }
  // A process that is exiting / exec'ing is momentarily uninspectable: re-inspect the unreadable
  // ones a few times (bounded); only those STILL uninspectable are reported (and refused).
  let unreadablePids = [];
  for (let round = 0; round <= recheckRounds && pendingUnreadable.length; round++) {
    if (round > 0) {
      if (Date.now() + recheckDelayMs >= deadline) return { kind: "timeout" };
      await new Promise((res) => setTimeout(res, recheckDelayMs));
    }
    const still = [];
    unreadablePids = [];
    for (const n of pendingUnreadable) {
      const r = await inspect(n);
      if (r === "skip") continue;
      if (r.kind) return r;
      if (r.found.length) occupants.push({ pid: Number(n), comm: r.comm, via: r.found[0].via, path: r.found[0].path });
      else if (r.blocked) {
        still.push(n);
        unreadablePids.push({
          pid: Number(n),
          comm: r.comm,
          ...(r.start !== undefined ? { start: r.start } : {}),
          ...(r.exe !== undefined ? { exe: r.exe } : {}),
        });
      }
    }
    pendingUnreadable = still;
  }
  return { kind: "done", occupants, unreadable: unreadablePids.length, unreadablePids };
}

async function requireNoOccupants(roots, ctx, what) {
  const r = await (ctx.scanOccupants ?? scanOccupants)(roots, {
    procRoot: ctx.procRoot,
    uid: ctx.uid,
    excludePids: ctx.excludePids?.() ?? [],
  });
  if (r.kind === "timeout")
    throw CE(
      CONVERT_EXIT.DEADLINE,
      `${what}：占用扫描超时（${CONVERT_BUDGET.occupancyMs} ms），无法确认无进程使用，拒绝`,
    );
  if (r.kind === "too-many")
    throw CE(CONVERT_EXIT.DEADLINE, `${what}：进程/文件描述符过多（${r.count}），无法在预算内确认，拒绝`);
  if (r.kind === "error") throw CE(CONVERT_EXIT.DEADLINE, `${what}：占用扫描失败（${r.message}），拒绝`);
  if (r.occupants.length) {
    const lines = r.occupants.slice(0, 20).map((o) => `  pid ${o.pid} ${o.comm}  ${o.via} → ${o.path}`);
    if (r.occupants.length > 20) lines.push(`  …共 ${r.occupants.length} 个`);
    throw CE(CONVERT_EXIT.BUSY, `${what}：以下进程正在使用该目录，请先退出它们：`, { lines, code: "occupied" });
  }
  if (r.unreadablePids.length) await confirmUnreadable(r.unreadablePids, ctx, what);
  return r;
}

// ───────────────────── uninspectable same-uid processes (user ruling 2026-10-24) ─────────────────────

/** Identity of a listed process: pid + starttime (only meaningful when `start` is known). */
export const unreadableKey = (p) => `${p.pid}:${p.start}`;

/** Boot time (seconds since epoch) from <procRoot>/stat, for printing start times. */
function bootTimeS(procRoot) {
  try {
    const m = /^btime (\d+)$/m.exec(fs.readFileSync(path.join(procRoot, "stat"), "utf8"));
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}
const CLK_TCK = 100; // Linux USER_HZ on every supported arch

/** One line per process: pid, comm, exe (when readable), start time (when known). */
export function describeUnreadable(p, procRoot = "/proc") {
  const bt = bootTimeS(procRoot);
  const when =
    p.start !== undefined && bt !== undefined
      ? new Date((bt + Number(p.start) / CLK_TCK) * 1000).toISOString()
      : undefined;
  return `  pid ${p.pid}  ${p.comm}  exe ${p.exe ?? "（不可读）"}  启动于 ${when ?? "（未知）"}`;
}

/** At most this many uninspectable processes are listed for a confirmation (round-2 M6). */
export const UNREADABLE_LIST_MAX = 200;

/**
 * User ruling 2026-10-24 (M8) + round-2 M5/M6: same-uid processes whose cwd/fd/maps cannot be read
 * are listed IN FULL and must be confirmed; the confirmation covers exactly what was shown.
 *   • identity = pid + starttime. A process whose starttime cannot be read has no identity: it is
 *     never put into the (persisted) confirmed set — every scan lists it again and needs a fresh
 *     confirmation (interactive) / the explicit flag (non-interactive); nothing is inherited across
 *     runs for it.
 *   • more than UNREADABLE_LIST_MAX unconfirmed processes ⇒ 75 without asking (cannot be shown).
 *   • interactive (ports.isTty): full list on stdout + prompt; only an exact `y` / `yes` continues.
 *   • non-interactive: full list on stderr; `--assume-unreadable-idle` confirms the FIRST set of
 *     identifiable processes of this run only (a later new identity ⇒ 75, never extended); processes
 *     without identity are accepted under the flag each time they are listed; no flag ⇒ 75.
 * Without a confirmation channel (`ctx.unreadable` absent) ⇒ 75.
 */
export async function confirmUnreadable(list, ctx, what) {
  const u = ctx.unreadable;
  const fresh = list.filter((p) => p.start === undefined || !u?.acked.has(unreadableKey(p)));
  if (fresh.length === 0) return;
  const head = `${what}：以下同 uid 进程无法检查（/proc 读不到其 cwd/fd/maps），无法确认它们是否在使用该目录：`;
  if (fresh.length > UNREADABLE_LIST_MAX)
    throw CE(
      CONVERT_EXIT.DEADLINE,
      `${what}：有 ${fresh.length} 个无法检查的同 uid 进程，超过可逐一列出确认的上限 ${UNREADABLE_LIST_MAX}，拒绝；请先退出其中一部分`,
      { code: "occupancy-uncertain" },
    );
  const lines = fresh.map((p) => describeUnreadable(p, ctx.procRoot));
  const identified = fresh.filter((p) => p.start !== undefined);
  const anon = fresh.length - identified.length;
  const anonNote = anon
    ? [`  （其中 ${anon} 个读不到启动时间、无法绑定身份：本次确认只对这一次检查有效，之后每次都会重新询问）`]
    : [];
  if (u && u.interactive) {
    u.out(head);
    for (const l of [...lines, ...anonNote]) u.out(l);
    u.out("确认它们不碰该目录后输入 y 继续（其他任何输入都中止）。");
    let a;
    try {
      a = await u.prompt("继续？[y/N] ");
    } catch {
      a = undefined;
    }
    const t = a === null || a === undefined ? "" : String(a).trim();
    if (t !== "y" && t !== "yes")
      throw CE(CONVERT_EXIT.DEADLINE, `${what}：未确认无法检查的进程，拒绝`, { lines, code: "unreadable-declined" });
  } else if (u && u.assume && (!u.assumeSpent || identified.length === 0)) {
    // non-interactive: the complete list goes to stderr, exactly what the flag now covers
    const errOut = u.err ?? u.out;
    errOut(`${what}：按 --assume-unreadable-idle，视以下无法检查的同 uid 进程为不使用该目录：`);
    for (const l of [...lines, ...anonNote]) errOut(l);
  } else if (u && u.assume) {
    throw CE(
      CONVERT_EXIT.DEADLINE,
      `${what}：确认之后又出现了新的无法检查的同 uid 进程；非交互模式不能沿用之前的确认，拒绝：`,
      { lines, code: "occupancy-uncertain" },
    );
  } else {
    throw CE(CONVERT_EXIT.DEADLINE, head, {
      lines: [
        ...lines,
        ...anonNote,
        "  确认它们不碰该目录后：在终端中运行以逐个确认，或（非交互）加 --assume-unreadable-idle 重新执行；也可先退出这些进程",
      ],
      code: "occupancy-uncertain",
    });
  }
  if (identified.length) {
    const at = new Date().toISOString();
    for (const p of identified) u.acked.set(unreadableKey(p), { ...p, at });
    u.assumeSpent = true;
    u.persist?.();
  }
}

// ───────────────────────────── convert lock (§1.3 并发) ─────────────────────────────

/**
 * Global convert lock `flock -n` held by a helper child for the WHOLE command: the child (`flock …
 * sh -c 'echo locked; exec cat'`) keeps the lock while its stdin pipe from us stays open, so the
 * lock dies with us — no orphan can hold it. → Promise<{release(), pid}> ; busy ⇒ ConvertError 73.
 */
export function acquireConvertLock(
  lockPath,
  { flockBin = "flock", env = process.env, spawnImpl = spawn, uid = process.getuid() } = {},
) {
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dst = fs.lstatSync(dir);
  if (!dst.isDirectory() || dst.uid !== uid || (dst.mode & 0o022) !== 0)
    throw CE(CONVERT_EXIT.CONFIG, `${dir} 须为本用户的目录（不可组/其他可写）`);
  const fd = fs.openSync(lockPath, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_NOFOLLOW, 0o600);
  const st = fs.fstatSync(fd);
  fs.closeSync(fd);
  if (!st.isFile() || st.uid !== uid) throw CE(CONVERT_EXIT.CONFIG, `${lockPath} 须为本用户的普通文件`);
  if (!T.findOnPath(flockBin, env.PATH ?? "")) throw CE(CONVERT_EXIT.PREREQ, "缺少 flock（util-linux）");
  return new Promise((resolve, reject) => {
    const child = spawnImpl(flockBin, ["-n", "-E", "73", lockPath, "sh", "-c", "echo locked; exec cat >/dev/null"], {
      cwd: "/",
      env,
      // own process group: a terminal Ctrl-C must not release the lock while we roll back
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    let buf = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(CE(CONVERT_EXIT.DEADLINE, "获取转换锁超时"));
    }, CONVERT_BUDGET.lockHandshakeMs);
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(CE(CONVERT_EXIT.PREREQ, `无法执行 flock：${e && e.message}`));
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        code === 73
          ? CE(CONVERT_EXIT.LOCK_BUSY, `另一个 pi-secure convert 正在进行（${lockPath} 被持有）`, { code: "lock-busy" })
          : CE(CONVERT_EXIT.LOCK_BUSY, `转换锁获取失败（flock exit ${code}）`),
      );
    });
    child.stdout.on("data", (b) => {
      buf += b.toString("utf8");
      if (!settled && buf.includes("locked\n")) {
        settled = true;
        clearTimeout(timer);
        child.stdout.destroy();
        child.unref();
        child.stdin.unref?.();
        resolve({
          pid: child.pid,
          release: () =>
            new Promise((res) => {
              if (child.exitCode !== null || child.signalCode !== null) return res();
              const t = setTimeout(() => {
                child.kill("SIGKILL");
                res();
              }, 2_000);
              child.once("exit", () => {
                clearTimeout(t);
                res();
              });
              child.stdin.end();
            }),
        });
      }
    });
  });
}

// ───────────────────────────── §1.6 state file ─────────────────────────────

export function txnFiles(txnDir, name) {
  const b = path.join(txnDir, `convert-${name}`);
  return { json: `${b}.json`, modes: `${b}.modes`, base: `${b}.base`, hashes: `${b}.hashes` };
}

/** `.txn/` must be OUR private directory (0700 class, not a symlink). Created with its parent. */
export function ensureTxnDir(txnDir, uid = process.getuid()) {
  fs.mkdirSync(path.dirname(txnDir), { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(txnDir, { mode: 0o700 });
  } catch (e) {
    if (!e || e.code !== "EEXIST") throw e;
  }
  const st = fs.lstatSync(txnDir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0)
    throw CE(CONVERT_EXIT.CONFIG, `${txnDir} 须为本用户的 0700 目录（不得是符号链接）`);
}

const isAbs = (p) => typeof p === "string" && path.isAbsolute(p) && path.resolve(p) === p;
const isId = (x) => !!x && typeof x === "object" && /^\d+$/.test(String(x.dev)) && /^\d+$/.test(String(x.ino));

/** Strict shape validation of a state object; → problem string or undefined. */
export function stateProblem(s, name) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "不是对象";
  if (s.v !== STATE_V) return `版本 ${s.v} 不认识`;
  if (!TXID_RE.test(String(s.txid))) return "txid 不合法";
  if (s.name !== name) return "name 不符";
  if (!CONVERT_PHASES.includes(s.phase)) return `phase ${s.phase} 不认识`;
  if (!isAbs(s.origin) || !isAbs(s.originReal) || !isAbs(s.backup)) return "路径字段不合法";
  if (path.dirname(s.backup) !== path.dirname(s.originReal)) return "备份不在原目录同级";
  if (!s.vault || !isAbs(s.vault.dir) || !isAbs(s.vault.mnt)) return "vault 字段不合法";
  if (!s.ids || !isId(s.ids.originParent) || !isId(s.ids.origin)) return "ids 不合法";
  for (const k of ["vaultDir", "vaultParent", "mnt", "mntParent", "cipher"])
    if (s.ids[k] !== undefined && !isId(s.ids[k])) return `ids.${k} 不合法`;
  if (s.link !== undefined && !isId(s.link)) return "link 不合法";
  if (s.modesCount !== undefined && (!Number.isSafeInteger(s.modesCount) || s.modesCount < 1))
    return "modesCount 不合法";
  for (const k of ["layoutAttempted", "linking", "freezeStarted", "frozen"])
    if (s[k] !== undefined && typeof s[k] !== "boolean") return `${k} 不合法`;
  if (s.worker !== undefined) {
    const w = s.worker;
    if (
      !w ||
      typeof w !== "object" ||
      !Number.isSafeInteger(w.pid) ||
      w.pid <= 1 ||
      w.pgid !== w.pid ||
      (w.start !== undefined && !/^\d+$/.test(String(w.start))) ||
      typeof w.op !== "string"
    )
      return "worker 不合法";
  }
  if (s.unreadableAck !== undefined) {
    const a = s.unreadableAck;
    if (
      !Array.isArray(a) ||
      a.length > 1024 ||
      !a.every(
        (p) =>
          p &&
          typeof p === "object" &&
          Number.isSafeInteger(p.pid) &&
          p.pid > 0 &&
          /^\d+$/.test(String(p.start)) && // round-2 M5: only identifiable processes are ever persisted
          typeof p.comm === "string" &&
          typeof p.at === "string",
      )
    )
      return "unreadableAck 不合法";
  }
  if (s.settingsDone !== undefined && !(s.settingsDone && isId(s.settingsDone.file))) return "settingsDone 不合法";
  if (s.sessionsDone !== undefined) {
    const d = s.sessionsDone;
    if (
      !d ||
      typeof d.skipped !== "boolean" ||
      !Number.isSafeInteger(d.sessions) ||
      d.sessions < 0 ||
      !Number.isSafeInteger(d.memory) ||
      d.memory < 0 ||
      !isId(d.state)
    )
      return "sessionsDone 不合法";
  }
  if (s.barrierDone !== undefined && !(s.barrierDone && isId(s.barrierDone.cipher))) return "barrierDone 不合法";
  if (s.copyVerified !== undefined) {
    const c = s.copyVerified;
    if (!c || typeof c !== "object" || !isId(c.work) || !Number.isSafeInteger(c.entries) || c.entries < 0)
      return "copyVerified 不合法";
  }
  return undefined;
}

/** tmp (O_EXCL|O_NOFOLLOW 0600) + fsync + rename + fsync `.txn/` (§1.6 persistence order). */
export function writeState(txnDir, s) {
  const f = txnFiles(txnDir, s.name).json;
  const tmp = `${f}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const body = JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2) + "\n";
  const fd = fs.openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, f);
  fsyncDir(txnDir);
}

/** → state | null (absent). Unreadable / malformed ⇒ ConvertError 78 (never guessed). */
export function readState(txnDir, name, uid = process.getuid()) {
  const f = txnFiles(txnDir, name).json;
  let fd;
  try {
    fd = fs.openSync(f, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw CE(CONVERT_EXIT.CONFIG, `无法读取状态文件 ${f}：${e && e.message}`);
  }
  let text;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== uid || st.size > 1024 * 1024)
      throw CE(CONVERT_EXIT.CONFIG, `状态文件 ${f} 须为本用户的普通文件`);
    text = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    throw CE(CONVERT_EXIT.CONFIG, `状态文件 ${f} 不是 JSON`);
  }
  const p = stateProblem(s, name);
  if (p) throw CE(CONVERT_EXIT.CONFIG, `状态文件 ${f} 不合法：${p}`);
  return s;
}

/** For `pi-secure status` (V6): interrupted conversions → [{name, phase, txid}]. Never throws. */
export function listInterruptedConverts(txnDir) {
  let names = [];
  try {
    names = fs.readdirSync(txnDir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names.sort()) {
    const m = /^convert-([a-z0-9][a-z0-9_-]{0,31})\.json$/.exec(n);
    if (!m) continue;
    try {
      const s = readState(txnDir, m[1]);
      if (s) out.push({ name: s.name, phase: s.phase, txid: s.txid });
    } catch {
      out.push({ name: m[1], phase: "invalid", txid: "" });
    }
  }
  return out;
}

export function formatInterruptedLine(e) {
  return `convert ${e.name}: interrupted (${e.phase}) · --resume|--abort`;
}

/** Remove our own .txn files (exact names; missing is fine). → leftover paths */
function removeTxnFiles(txnDir, name) {
  const left = [];
  const f = txnFiles(txnDir, name);
  for (const p of [f.modes, f.base, f.hashes, f.json]) {
    try {
      fs.unlinkSync(p);
    } catch (e) {
      if (!e || e.code !== "ENOENT") left.push(p);
    }
  }
  try {
    fsyncDir(txnDir);
  } catch {
    /* best effort */
  }
  return left;
}

// ───────────────────────────── worker plumbing ─────────────────────────────

/** Map a worker outcome to a result or a ConvertError (stalled / unclean / crash ⇒ unknown). */
function workerResult(op, r, failExit = CONVERT_EXIT.IO) {
  if (r.kind === "result") return r.result;
  if (r.kind === "error") {
    const exit = typeof r.exit === "number" && r.exit > 1 ? r.exit : failExit;
    return { __error: CE(exit, `${op}：${r.message}`, { code: r.code }) };
  }
  if (r.kind === "stalled")
    return { __error: CE(CONVERT_EXIT.DEADLINE, `${op}：60 s 无进展，已终止（结果未知）`, { code: "stalled" }) };
  if (r.kind === "unclean")
    return { __error: CE(CONVERT_EXIT.IO, `${op}：worker 进程组未能确认清理（结果未知）`, { code: "unclean" }) };
  if (r.kind === "crashed")
    return { __error: CE(failExit, `${op}：worker 异常退出（${r.signal ?? `exit ${r.code}`}）`, { code: "crashed" }) };
  return { __error: CE(failExit, `${op}：无法启动 worker（${r.message ?? r.kind}）`, { code: "spawn" }) };
}

/**
 * Spawn for workers: owner-death guarded argv (B4) and, BEFORE the spawn returns (i.e. before the
 * supervisor writes the spec to the worker's stdin), the worker group identity is handed to
 * `ctx.onWorkerSpawn` — the flows persist it into the state file so a later --abort/--resume can
 * prove the group gone (`reapRecordedWorker`). Round-2 B1: a worker is never started while an older
 * worker record is still unresolved (`ctx.workerSpawnAllowed`).
 */
function workerSpawn(ctx, op) {
  const base = ctx.spawnImpl ?? spawn;
  return (cmd, args, opts) => {
    if (ctx.workerSpawnAllowed && !ctx.workerSpawnAllowed())
      throw new Error("上一个 worker 进程组尚未被证明已结束，不启动新的 worker");
    const c = base(cmd, args, opts);
    if (c.pid !== undefined && ctx.onWorkerSpawn) {
      const start = T.readProcStart(c.pid, ctx.procRoot);
      try {
        ctx.onWorkerSpawn({ pid: c.pid, pgid: c.pid, start: start === undefined ? undefined : String(start), op });
      } catch {
        // identity could not be persisted ⇒ the worker must not run. The ONE signal without the
        // environ proof: a pid-exact SIGKILL to our own still-unreaped child (its pid cannot have
        // been reused; before exec its environ is still ours, so the proof could fail spuriously).
        // The guard's watcher then sees its sh gone and kills the rest of the group.
        c.kill("SIGKILL");
      }
    }
    return c;
  };
}

/** `{PI_SECURE_TXID: <txid>}` once the conversion has a txid (round-2 B2). */
function txidEnv(ctx) {
  return TXID_RE.test(String(ctx.txid)) ? { [TXID_ENV]: ctx.txid } : {};
}

async function treeOp(ctx, op, spec, label = op) {
  const r = await T.superviseWorker({
    op,
    spec,
    argv: guardArgv(ctx.treeArgv(op)),
    env: { ...ctx.workerEnv, ...txidEnv(ctx) },
    spawnImpl: workerSpawn(ctx, op),
    procRoot: ctx.procRoot,
    ...(ctx.workerBudget ?? {}),
    onProgress: ctx.onProgress,
  });
  if (r.kind !== "unclean") ctx.onWorkerDone?.(); // group proven empty ⇒ forget its identity
  const res = workerResult(label, r);
  if (res && res.__error) throw res.__error;
  return res;
}

async function convertOp(ctx, op, spec) {
  const r = await T.superviseWorker({
    op,
    spec,
    argv: guardArgv(ctx.convertArgv(op)),
    env: { ...ctx.workerEnv, ...txidEnv(ctx) },
    spawnImpl: workerSpawn(ctx, op),
    procRoot: ctx.procRoot,
    ...(ctx.workerBudget ?? {}),
  });
  if (r.kind !== "unclean") ctx.onWorkerDone?.();
  const res = workerResult(op, r);
  if (res && res.__error) throw res.__error;
  return res;
}

export const CONVERT_WORKER_OPS = Object.freeze(["sessions-plan", "sessions"]);

/** Worker body for the sessions steps (§2, V3 engine). Progress = one unit per file attempt. */
export async function runConvertOp(op, spec, emit = () => {}) {
  let units = 0;
  const hooks = {
    beforeVerify: () => {
      units++;
      emit({ t: "progress", op, units, bytes: 0 });
    },
  };
  const need = (k) => {
    if (!isAbs(spec[k])) throw new Error(`spec.${k} 必须是绝对路径`);
    return spec[k];
  };
  if (op === "sessions-plan") {
    const roots = [need("root"), ...(spec.rootRealpath ? [need("rootRealpath")] : [])];
    const disc = S.discoverSessionSources({
      root: need("root"),
      rootRealpath: spec.rootRealpath,
      treeRoot: need("treeRoot"),
      agentDir: need("agentDir"),
      home: need("home"),
      globalSessionDir: spec.globalSessionDir,
      envSessionDir: spec.envSessionDir,
      extraDirs: spec.extraDirs ?? [],
    });
    const plan = S.planSessionCopy({
      sources: disc.sources,
      matchRoots: [...new Set(roots)],
      newRoot: need("newRoot"),
    });
    const slugs = S.memoryExactSlugs({
      root: need("root"),
      rootRealpath: spec.rootRealpath,
      memoryRoot: need("memoryRoot"),
    });
    return {
      sessions: plan.copySet.size,
      sources: disc.sources.length,
      invalid: Array.isArray(plan.invalid) ? plan.invalid.length : 0,
      partial: !!plan.partial,
      memory: slugs.filter((x) => {
        try {
          return fs.statSync(x.dir).isDirectory();
        } catch {
          return false;
        }
      }).length,
    };
  }
  if (op === "sessions") {
    const report = S.convertCopySessionsAndMemory({
      root: need("root"),
      rootRealpath: spec.rootRealpath,
      treeRoot: need("treeRoot"),
      newRoot: need("newRoot"),
      agentDir: need("agentDir"),
      home: need("home"),
      memoryRoot: need("memoryRoot"),
      destStateDir: need("destStateDir"),
      globalSessionDir: spec.globalSessionDir,
      envSessionDir: spec.envSessionDir,
      extraDirs: spec.extraDirs ?? [],
      hooks,
    });
    const foreign = S.listForeignHeaderMatches(spec.foreignDirs ?? [], report.roots);
    emit({ t: "progress", op, units: units + 1, bytes: 0 });
    const memFiles = (report.memory?.results ?? []).flatMap((r) => r.files ?? []);
    return {
      counts: report.sessions.counts,
      conflicts: report.sessions.conflicts.map((c) => `${c.src} → ${c.dest}`),
      // r3.1 M10: file-level incompleteness (sessions AND memory) fails step 10; only the §2.2#4
      // closure budget (`partial`) stays report-only — nothing is deleted, the copied part is whole.
      sessionsPartial: (report.sessions.partial ?? []).map((c) => `${c.src}（${c.reason ?? "partial"}）`),
      memoryConflicts: memFiles.filter((f) => f.status === "conflict").map((f) => `${f.src} → ${f.dest}`),
      memoryPartial: memFiles.filter((f) => f.status === "partial").map((f) => `${f.src}（${f.reason ?? "partial"}）`),
      memoryComplete: memFiles.filter((f) => f.status === "complete").length,
      partial: report.plan.partial === true,
      memoryAmbiguous: (report.memory?.ambiguity?.length ?? 0) > 0,
      cleanup: String(S.formatManualCleanup(report)).split("\n"),
      foreign: foreign.matches.map((f) => f.file),
    };
  }
  throw new Error(`未知 convert worker op：${op}`);
}

async function convertWorkerMain(op) {
  const emit = (o) => fs.writeSync(1, `${JSON.stringify(o)}\n`);
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const spec = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = await runConvertOp(op, spec, emit);
    emit({ t: "result", op, ok: true, result });
    return 0;
  } catch (e) {
    emit({
      t: "error",
      op,
      code: (e && e.code) || "convert",
      exit: CONVERT_EXIT.IO,
      message: String((e && e.message) || e),
    });
    return 1;
  }
}

export const selfPath = () => fileURLToPath(import.meta.url);
export function convertWorkerArgv(op, nodeBin = process.execPath) {
  return [nodeBin, selfPath(), "__convert-work", op];
}

// ───────────────────────────── context ─────────────────────────────

/** Test seam gate (mirror of helper.mjs testSeam, no import): value iff PI_SECURE_TEST_SEAMS=1 (V7 review M1). */
export function testSeam(name, env = process.env) {
  const v = env[name];
  if (v === undefined || v === "") return undefined;
  return env.PI_SECURE_TEST_SEAMS === "1" ? v : undefined;
}

/** Test seam (§7.2-3): `PI_SECURE_TEST_CONVERT_FAIL_AT=<step>:<before|after>` — can only make the flow FAIL. Gated. */
export function parseFailAt(env = process.env) {
  const m = /^(\d{1,2}):(before|after)$/.exec(testSeam("PI_SECURE_TEST_CONVERT_FAIL_AT", env) ?? "");
  if (!m) return undefined;
  const step = Number(m[1]);
  return step >= 0 && step <= 15 ? { step, when: m[2] } : undefined;
}

/**
 * Test seam (V7, §7.2-4/5/7): `PI_SECURE_TEST_CONVERT_STOP_AT=<step>:<before|mid|after>` — the
 * orchestrator SIGSTOPs ITSELF at that point (`mid` exists only for step 3: phase "renaming" is
 * persisted, the rename has not run). It can only DELAY the flow: the test then either SIGKILLs the
 * stopped process (an interruption at an exact phase) or changes the world and SIGCONTs it (a race
 * at an exact point). Unset/malformed ⇒ no effect. V7 review M1: honoured ONLY together with
 * PI_SECURE_TEST_SEAMS=1; when armed, cmdConvert announces it on stderr at start and stopPoint prints
 * step/when/pid right before stopping. A pause after the final backup re-verification is covered by
 * the stale-evidence re-check before step 13 (V7 review M2, STALE_EVIDENCE_MS).
 */
export function parseStopAt(env = process.env) {
  const m = /^(\d{1,2}):(before|mid|after)$/.exec(testSeam("PI_SECURE_TEST_CONVERT_STOP_AT", env) ?? "");
  if (!m) return undefined;
  const step = Number(m[1]);
  return step >= 0 && step <= 15 ? { step, when: m[2] } : undefined;
}

function stopPoint(ctx, step, when) {
  if (ctx.stopAt && ctx.stopAt.step === step && ctx.stopAt.when === when) {
    try {
      process.stderr.write(`pi-secure: 测试缝：convert 在第 ${step} 步（${when}）暂停（pid ${process.pid}）\n`);
    } catch {
      /* stderr gone */
    }
    process.kill(process.pid, "SIGSTOP");
  }
}

/**
 * Runtime context with defaults. Everything here is PLAIN data / OS access (no launcher logic):
 * paths, binaries, uid/gid, the spawn used for workers (tracked for interruption), clocks.
 */
export function defaultConvertContext(env = process.env, over = {}) {
  const home = over.home ?? env.HOME ?? "/";
  const agentDir =
    over.agentDir ??
    (env.PI_CODING_AGENT_DIR ? path.resolve(env.PI_CODING_AGENT_DIR) : path.join(home, ".pi", "agent"));
  const shareDir = path.join(home, ".local", "share", "pi-toolkit-secure");
  const ctx = {
    env,
    home,
    cwd: undefined,
    uid: process.getuid(),
    gid: process.getgid(),
    agentDir,
    memoryRoot: env.ARMORY_MEMORY_ROOT ? path.resolve(env.ARMORY_MEMORY_ROOT) : path.join(agentDir, "memory"),
    globalSessionDir: undefined,
    txnDir: path.join(shareDir, ".txn"),
    lockPath: path.join(shareDir, ".convert.lock"),
    bins: { mv: "mv", sync: "sync", getfattr: "getfattr", flock: "flock", git: "git" },
    systemDirs: SYSTEM_DIRS,
    procRoot: "/proc",
    now: () => new Date(),
    rand: () => Math.floor(Math.random() * 0x10000),
    treeArgv: (op) => T.treeWorkerArgv(op),
    convertArgv: (op) => convertWorkerArgv(op),
    workerEnv: env,
    failAt: parseFailAt(env),
    stopAt: parseStopAt(env),
    signals: process,
    ...over,
  };
  if (ctx.globalSessionDir === undefined) {
    const value = S.readSessionDirFromSettings(path.join(ctx.agentDir, "settings.json"));
    if (value) ctx.globalSessionDir = S.resolveSessionDirValue(value, { home: ctx.home, projRoot: ctx.agentDir });
  }
  return ctx;
}

// ───────────────────────────── interruption ─────────────────────────────

/**
 * SIGINT/SIGTERM/SIGHUP handling (§1.4 中断): the first signal is recorded, every tracked worker /
 * child group is sent SIGTERM so the current step ends quickly (its result is then "unknown" ⇒
 * rollback); during step 14 (`deferred`) nothing is killed — the commit is milliseconds.
 */
function createInterrupts(signals, proofOpts = () => ({})) {
  const st = { sig: null, deferred: false, children: new Set(), handlers: [] };
  // round-2 B2: TERM only groups proven to carry this conversion's txid (mv children of
  // renameNoReplace carry none and simply finish — they are short and bounded by tree.mjs)
  const term = (c) => signalGroupIfOurs(c.pid, "SIGTERM", { ...proofOpts(), leaderStart: c.__piStart });
  const killAll = () => {
    for (const c of st.children) term(c);
  };
  st.install = () => {
    for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const h = () => {
        if (st.sig) return;
        st.sig = s;
        if (!st.deferred) killAll();
      };
      signals.on(s, h);
      st.handlers.push([s, h]);
    }
  };
  st.remove = () => {
    for (const [s, h] of st.handlers) signals.removeListener(s, h);
    st.handlers = [];
  };
  st.track = (baseSpawn) => (cmd, args, opts) => {
    const c = baseSpawn(cmd, args, opts);
    if (opts && opts.detached && c.pid !== undefined) {
      c.__piStart = T.readProcStart(c.pid, proofOpts().procRoot ?? "/proc");
      st.children.add(c);
      c.on("exit", () => st.children.delete(c));
      if (st.sig && !st.deferred) term(c);
    }
    return c;
  };
  st.exitCode = () => (st.sig === "SIGINT" ? CONVERT_EXIT.SIGINT : CONVERT_EXIT.SIGTERM);
  st.check = () => {
    if (st.sig) throw CE(st.exitCode(), `收到 ${st.sig}，中止`, { code: "interrupted" });
  };
  return st;
}

// ───────────────────────────── vault set-aside (R-A, r3.1 B3) ─────────────────────────────

/** Sibling `<base>.aborted-<txid>` of a vault path (never overwritten). */
export function abortedPath(p, txid) {
  return path.join(path.dirname(p), `${path.basename(p)}.aborted-${txid}`);
}

/** Identity-checked rmdir of an EMPTY directory through its pinned parent fd. → {ok} | {ok:false, reason} */
function rmdirEmptyOwn(p, expect, expectParent) {
  let fd;
  try {
    fd = openDirExpect(path.dirname(p), expectParent);
  } catch (e) {
    return { ok: false, reason: `${path.dirname(p)} 身份不符或无法打开（${e.code ?? e.message}）` };
  }
  try {
    const at = fdPath(fd, path.basename(p));
    const st = fs.lstatSync(at, { bigint: true });
    if (!st.isDirectory() || !sameId(st, expect)) return { ok: false, reason: `${p} 身份与本次创建的不符，保留` };
    if (fs.readdirSync(at).length !== 0) return { ok: false, reason: "not-empty" };
    fs.rmdirSync(at); // residual (V2 probe parity): a same-uid racer could swap in another EMPTY dir here
    fs.fsyncSync(fd);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.code === "ENOTEMPTY" ? "not-empty" : `${p}：${e.code ?? e.message}` };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * r3.1 B3 — the new vault is NEVER deleted: `<p>` (identity `expect`) is renamed with
 * RENAME_NOREPLACE to the sibling `<base>.aborted-<txid>`; an EMPTY mount point created by this txid
 * may instead be rmdir'ed after the identity check (`allowRmdir`). Idempotent: `<p>` gone and the
 * aborted name holding `expect` ⇒ already done.
 * → {ok:true, line?} | {ok:false, reason}
 */
async function setAside(ctx, { p, expect, expectParent, txid, allowRmdir }) {
  const to = abortedPath(p, txid);
  const st = lstatBigOrNull(p);
  if (!st) {
    const t = lstatBigOrNull(to);
    if (t && sameId(t, expect))
      return { ok: true, line: `${p} 已在先前改名为 ${to}（内含本次拷贝的密文，核对后可自行删除）` };
    return { ok: true };
  }
  if (!sameId(st, expect)) return { ok: false, reason: `${p} 身份与本次创建的不符，保留` };
  const parentSt = lstatBigOrNull(path.dirname(p));
  const parentId = expectParent ?? (parentSt ? idOf(parentSt) : undefined);
  if (!parentId) return { ok: false, reason: `${path.dirname(p)} 不存在，保留 ${p}` };
  if (allowRmdir && st.isDirectory()) {
    const r = rmdirEmptyOwn(p, expect, parentId);
    if (r.ok) return { ok: true, line: `已删除本次创建的空挂载点 ${p}` };
    if (r.reason !== "not-empty") return r;
  }
  const r = await T.renameNoReplace({
    parent: path.dirname(p),
    from: path.basename(p),
    to: path.basename(to),
    expect,
    expectParent: parentId,
    mvBin: ctx.bins.mv,
    spawnImpl: ctx.spawnImpl,
  });
  if (!r.ok) return { ok: false, reason: `无法把 ${p} 改名为 ${to}（${r.reason ?? r.state}），保留` };
  try {
    fsyncDir(path.dirname(p));
  } catch {
    /* best effort */
  }
  return { ok: true, line: `新库 ${p} 已改名为 ${to}（内含本次拷贝的密文，核对后可自行删除）` };
}

/** Pure createLayout skeleton (crash between createLayout and recording its ids)? */
function isSkeleton(v, dir) {
  const kids =
    dir === v.dir
      ? { cipher: "emptydir", "mount.lock": "emptyfile", "mount.lease": "emptyfile" }
      : { work: "emptyfile", state: "emptyfile" };
  const st = lstatBigOrNull(dir);
  if (!st || !st.isDirectory()) return false;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return names.every((n) => {
    const kind = kids[n];
    const c = lstatBigOrNull(path.join(dir, n));
    if (!kind || !c) return false;
    if (kind === "emptyfile") return c.isFile() && c.size === 0n;
    if (!c.isDirectory()) return false;
    try {
      return fs.readdirSync(path.join(dir, n)).length === 0;
    } catch {
      return false;
    }
  });
}

// ───────────────────────────── link helpers (step 13 / R-B 1) ─────────────────────────────

/** symlink(<target>, <parent>/<base>) through the identity-checked parent fd. → {dev, ino} ; EEXIST ⇒ "exists" */
function symlinkAt(parent, parentId, base, target) {
  const fd = openDirExpect(parent, parentId);
  try {
    try {
      fs.symlinkSync(target, fdPath(fd, base));
    } catch (e) {
      if (e && e.code === "EEXIST") return "exists";
      throw e;
    }
    const st = fs.lstatSync(fdPath(fd, base), { bigint: true });
    fs.fsyncSync(fd);
    return idOf(st);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Remove OUR symlink at <parent>/<base>: it is first moved (RENAME_NOREPLACE, identity-judged) to a
 * private name `.pi-secure-unlink-<txid>` in the same directory, then the moved entry is re-checked
 * (still a symlink with the recorded identity and target) and only then unlinked. A swapped-in
 * object is moved back (NOREPLACE) and reported — never deleted.
 * → {ok:true} | {ok:false, reason}
 */
async function removeOwnLink(ctx, { parent, parentId, base, linkId, target, txid }) {
  const tmp = `.pi-secure-unlink-${txid}`;
  const r = await T.renameNoReplace({
    parent,
    from: base,
    to: tmp,
    expect: linkId,
    expectParent: parentId,
    mvBin: ctx.bins.mv,
    spawnImpl: ctx.spawnImpl,
  });
  const tmpPath = path.join(parent, tmp);
  if (!r.ok) {
    const st = lstatBigOrNull(tmpPath);
    if (st && !sameId(st, linkId) && !lstatBigOrNull(path.join(parent, base)))
      await T.renameNoReplace({
        parent,
        from: tmp,
        to: base,
        expect: idOf(st),
        expectParent: parentId,
        mvBin: ctx.bins.mv,
        spawnImpl: ctx.spawnImpl,
      });
    return { ok: false, reason: `无法移开原路径上的链接（${r.reason ?? r.state}）` };
  }
  const fd = openDirExpect(parent, parentId);
  try {
    const st = fs.lstatSync(fdPath(fd, tmp), { bigint: true });
    if (!st.isSymbolicLink() || !sameId(st, linkId) || fs.readlinkSync(fdPath(fd, tmp)) !== target)
      return { ok: false, reason: `${tmpPath} 已不是本次创建的链接，保留` };
    fs.unlinkSync(fdPath(fd, tmp));
    fs.fsyncSync(fd);
    return { ok: true };
  } finally {
    fs.closeSync(fd);
  }
}

// ───────────────────────────── recovery authorization (r3.1 B1/B2/B4/M5) ─────────────────────────────

/** Persist the identity of every worker group into the state (B4); forget it once proven empty. */
function bindWorkerTracking(ctx, state, persist) {
  if (ctx.unreadable) {
    for (const a of state.unreadableAck ?? []) ctx.unreadable.acked.set(unreadableKey(a), a);
    ctx.unreadable.persist = () => {
      state.unreadableAck = [...ctx.unreadable.acked.values()];
      persist();
    };
    if (ctx.unreadable.acked.size && (state.unreadableAck?.length ?? 0) !== ctx.unreadable.acked.size)
      ctx.unreadable.persist(); // confirmations made before the state file existed (step 0)
  }
  // round-2 B1: never overwrite an unresolved worker record (the old group may still be alive)
  ctx.workerSpawnAllowed = () => state.worker === undefined;
  ctx.onWorkerSpawn = (w) => {
    state.worker = w;
    persist();
  };
  ctx.onWorkerDone = () => {
    if (state.worker === undefined) return;
    delete state.worker;
    persist();
  };
}
function unbindWorkerTracking(ctx) {
  ctx.workerSpawnAllowed = undefined;
  if (ctx.unreadable) ctx.unreadable.persist = undefined;
  ctx.onWorkerSpawn = undefined;
  ctx.onWorkerDone = undefined;
}

const BACKUP_SUFFIX_RE = /^\.pi-secure-backup-\d{8}-\d{6}-[0-9a-f]{4}$/;

/**
 * r3.1 B1: a state file is NOT its own authorization. Before --abort / --resume touches anything,
 * every path in it must equal what convert itself derives — `<dir>` = defaultVaultDir(name),
 * `<dir>`/`<mnt>` = the registry entry when one exists (a non-default `<mnt>` without an entry is
 * accepted only if the state proves this txid never laid out a vault), the backup = this origin's
 * `.pi-secure-backup-<ts>-<rand>` sibling, the origin = a canonical path passing the §1.3 path
 * rules whose parent still has the recorded identity. Any mismatch ⇒ 78, nothing touched.
 */
export function authorizeState(s, { ports, ctx, entry }) {
  const why = [];
  const home = ctx.home;
  const wantDir = ports.defaultVaultDir(s.name, home);
  if (s.vault.dir !== wantDir) why.push(`vault.dir ${s.vault.dir} ≠ 推导路径 ${wantDir}`);
  if (entry) {
    if (entry.dir !== s.vault.dir) why.push(`vault.dir 与登记项（${entry.dir}）不一致`);
    if (entry.mnt !== s.vault.mnt) why.push(`vault.mnt 与登记项（${entry.mnt}）不一致`);
  } else if (
    s.vault.mnt !== ports.defaultVaultMnt(s.name, home) &&
    (s.layoutAttempted || s.ids.vaultDir || s.ids.mnt || s.ids.cipher)
  )
    why.push(`登记项已不存在，无法确认非默认挂载点 ${s.vault.mnt}`);
  const ob = path.basename(s.originReal);
  const bb = path.basename(s.backup);
  if (!bb.startsWith(ob) || !BACKUP_SUFFIX_RE.test(bb.slice(ob.length))) why.push(`备份名 ${bb} 不是 ${ob} 的备份名`);
  const parent = path.dirname(s.originReal);
  if (realpathOr(parent, "") !== parent) why.push(`originReal 的父目录 ${parent} 不是物理路径`);
  if (path.basename(s.origin) !== ob || realpathOr(path.dirname(s.origin), "") !== parent)
    why.push(`origin ${s.origin} 与 originReal ${s.originReal} 不对应`);
  const pst = lstatBigOrNull(parent);
  if (!pst || !pst.isDirectory() || !sameId(pst, s.ids.originParent)) why.push(`${parent} 的身份与记录不符`);
  const pp = pathRuleProblems({
    src: s.origin,
    srcReal: s.originReal,
    home,
    agentDir: ctx.agentDir,
    vaults: (ports.listVaults?.() ?? []).filter((x) => x.name !== s.name),
    systemDirs: ctx.systemDirs,
  });
  if (pp.length) why.push(...formatPathProblems(pp).map((l) => l.trim()));
  if (why.length)
    throw CE(CONVERT_EXIT.CONFIG, "状态文件中的路径/身份与登记项及推导路径不符，拒绝（未做任何改动）：", {
      lines: why.map((w) => `  ${w}`),
      code: "state-unauthorized",
    });
}

/**
 * r3.1 B4 + round-2 B1/B2: prove the worker group recorded in the state is gone BEFORE any recovery
 * (automatic rollback, --abort, --resume). A leader with ANOTHER start time ⇒ the pid was reused,
 * which the kernel never does while a group with that id still exists ⇒ ours is gone (no signal).
 * Otherwise members are SIGKILLed only after proveGroupOurs (uid + start + environ txid); an
 * incomplete scan, an unprovable member or a group still alive at the deadline ⇒ {clean:false} —
 * the caller does NOTHING and keeps the state with its worker record (exit 75).
 * → {clean:true} | {clean:false, detail}
 */
export async function reapRecordedWorker(s, ctx) {
  const w = s.worker;
  if (!w) return { clean: true };
  const deadline = Date.now() + CONVERT_BUDGET.leftoverReapMs;
  for (;;) {
    const scan = T.scanGroup(w.pgid, ctx.procRoot);
    if (!scan.complete) return { clean: false, detail: "/proc 扫描不完整" };
    if (scan.members.length === 0) return { clean: true };
    if (scan.leader && w.start !== undefined && scan.leader.start !== String(w.start)) return { clean: true };
    const p = signalGroupIfOurs(w.pgid, "SIGKILL", {
      txid: s.txid,
      uid: ctx.uid,
      procRoot: ctx.procRoot,
      leaderStart: w.start,
    });
    if (!p.ok) return { clean: false, detail: `无法证明属于本次转换：${p.why}；未发送任何信号` };
    if (p.empty) return { clean: true };
    if (Date.now() >= deadline) return { clean: false, detail: "进程组在期限内未结束" };
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** --resume entry: reapRecordedWorker or 75; on success the record is forgotten. */
async function reapLeftoverWorker(s, ctx, persist) {
  const r = await reapRecordedWorker(s, ctx);
  if (!r.clean)
    throw CE(
      CONVERT_EXIT.DEADLINE,
      `上次转换遗留的 worker 进程组 ${s.worker.pgid}（${s.worker.op}）无法证明已结束（${r.detail}），未做任何改动；稍后重试`,
      { code: "worker-leftover" },
    );
  if (s.worker !== undefined) {
    delete s.worker;
    persist();
  }
}

export const MODES_REL_MAX_BYTES = 4096;
export const MODES_REL_MAX_DEPTH = 256;

/** r3.1 B2: strict `rel` of a persisted .modes record. → problem string | undefined */
export function modesRelProblem(rel) {
  if (typeof rel !== "string") return "rel 不是字符串";
  if (rel === "") return undefined;
  if (rel.includes("\0")) return "含 NUL";
  if (Buffer.byteLength(rel, "utf8") > MODES_REL_MAX_BYTES) return "过长";
  if (rel.startsWith("/")) return "是绝对路径";
  const parts = rel.split("/");
  if (parts.length > MODES_REL_MAX_DEPTH) return "层级过深";
  if (parts.some((x) => x === "" || x === "." || x === "..")) return "含空组件、. 或 ..";
  if (path.posix.normalize(rel) !== rel) return "未规范化";
  return undefined;
}

/** Validate the whole persisted .modes file before ANY restore (fail closed). → problem | undefined */
export function modesFileProblem(file, rootId, expectCount) {
  let m;
  try {
    m = T.readModesFile(file);
  } catch (e) {
    return `无法读取（${e.message}）`;
  }
  if (!m.header || !isId(m.header.rootId) || !sameId(m.header.rootId, rootId)) return "rootId 与本次源目录不符";
  // round-2 M3: an empty / truncated / padded record cannot restore the frozen tree
  if (m.records.length === 0) return "记录为空";
  if (expectCount !== undefined && m.records.length !== expectCount)
    return `条目数 ${m.records.length} 与冻结时记录的 ${expectCount} 不符`;
  let roots = 0;
  for (const r of m.records) {
    if (!r || typeof r !== "object") return "记录不是对象";
    const p = modesRelProblem(r.rel);
    if (p) return `记录 ${JSON.stringify(String(r.rel).slice(0, 80))} ${p}`;
    if (r.rel === "" && ++roots > 1) return "根记录重复";
    if (!Number.isSafeInteger(r.mode) || r.mode < 0 || r.mode > 0o7777) return `记录 ${r.rel} 的 mode 不合法`;
  }
  if (roots !== 1) return "缺少根记录";
  return undefined;
}

/**
 * r3.1 M5: --resume may only link + commit a copy proven complete AND still the same vault: the
 * state's completion evidence (step 8) must exist, `<dir>` and `<cipher>` must still have the
 * identities recorded at creation (gocryptfs.conf present), and the mount point must be either
 * our unmounted directory or the very mount whose `work` was verified. Anything else ⇒ 76.
 */
async function verifyVaultForResume(s, v, { ports, ctx }) {
  const bad = (m) => CE(CONVERT_EXIT.BUSY, `不能完成：${m}；请核对后执行 pi-secure convert --abort ${s.name}`);
  // round-2 M4: evidence of EVERY step between the copy and the link (8 verify, 9 settings, 10
  // sessions/memory, 11 barrier); a missing one is never skipped — the conversion has to be redone
  const missing = [
    !s.copyVerified && "第 8 步（副本校验）",
    !s.settingsDone && "第 9 步（项目 sessionDir）",
    !s.sessionsDone && "第 10 步（会话 / memory 复制）",
    !s.barrierDone && "第 11 步（持久化屏障）",
  ].filter(Boolean);
  if (missing.length) throw bad(`状态中缺少完成证据：${missing.join("、")}——不能跳过，需要重新转换`);
  if (!s.copyVerified) throw bad("状态中没有副本校验完成的证据");
  if (!s.ids.vaultDir || !s.ids.mnt || !s.ids.cipher) throw bad("状态中缺少新库身份");
  const phys = ports.physicalPaths(v);
  const tgt = (p) => {
    try {
      return T.dirTarget(p);
    } catch {
      return undefined;
    }
  };
  const d = tgt(phys.realDir);
  if (!d || !sameId(d, s.ids.vaultDir)) throw bad(`${v.dir} 不在或身份与创建时记录的不符`);
  const c = tgt(phys.realCipher);
  if (!c || !sameId(c, s.ids.cipher)) throw bad(`${v.cipher} 不在或身份与创建时记录的不符`);
  const conf = lstatBigOrNull(path.join(phys.realCipher, "gocryptfs.conf"));
  if (!conf || !conf.isFile()) throw bad(`${v.cipher}/gocryptfs.conf 缺失`);
  let ms = "unknown";
  try {
    ms = await ports.probeMountState(v);
  } catch {
    ms = "unknown";
  }
  if (!sameId(s.barrierDone.cipher, s.ids.cipher)) throw bad("持久化屏障的对象不是本次新库的密文目录");
  if (ms === "absent") {
    // unmounted: the plaintext evidence (settings / state dir) cannot be re-observed; the barrier
    // made it durable and the cipher dir is the same object
    const m = lstatBigOrNull(v.mnt);
    if (!m || !m.isDirectory() || !sameId(m, s.ids.mnt)) throw bad(`${v.mnt} 不在或身份与创建时记录的不符`);
  } else if (ms === "mounted") {
    const w = lstatBigOrNull(path.join(phys.realMnt, "work"));
    if (!w || !sameId(w, s.copyVerified.work))
      throw bad(`新库当前挂载的 work 不是校验过的那一个（重新挂载过？先 fusermount3 -u ${v.mnt}）`);
    const f = lstatBigOrNull(path.join(phys.realMnt, "work", ".pi", "settings.json"));
    if (!f || !sameId(f, s.settingsDone.file)) throw bad("保险库内的项目 .pi/settings.json 与第 9 步写入的不是同一个");
    const d = lstatBigOrNull(path.join(phys.realMnt, "state"));
    if (!d || !sameId(d, s.sessionsDone.state)) throw bad("保险库 state 目录与第 10 步时的不是同一个");
  } else throw bad(`${v.mnt} 的挂载状态无法确认（${ms}）`);
}

// ───────────────────────────── recovery (R-B / R-A, --abort) ─────────────────────────────

function vaultOf(ports, s) {
  return ports.deriveVault(s.name, s.vault.dir, s.vault.mnt);
}

/**
 * Converge an interrupted / failed conversion back to the original state from the ACTUAL on-disk
 * state (§1.6 R-B then R-A). Never modifies or deletes anything inside the backup except restoring
 * its modes and renaming it back. → {done, remaining:[…], lines:[…]}
 */
export async function recoverConvert(s, { ports, ctx }) {
  const lines = [];
  const remaining = [];
  // round-2 B1: no recovery step (not even a chmod) while the recorded worker group may still run
  const rw = await reapRecordedWorker(s, ctx);
  if (!rw.clean)
    return {
      done: false,
      blocked: true,
      lines,
      remaining: [
        `遗留 worker 进程组 ${s.worker.pgid}（${s.worker.op}）无法证明已结束（${rw.detail}）——未做任何恢复，状态与 worker 记录保留；稍后执行 pi-secure convert --abort ${s.name}`,
      ],
    };
  if (s.worker !== undefined) {
    if (ctx.onWorkerDone) ctx.onWorkerDone();
    else delete s.worker;
  }
  const v = vaultOf(ports, s);
  const parent = path.dirname(s.originReal);
  const base = path.basename(s.originReal);
  const bbase = path.basename(s.backup);
  const files = txnFiles(ctx.txnDir, s.name);
  // ── R-B 1: our symlink on the original path
  let originSt = lstatBigOrNull(s.originReal);
  if (originSt && originSt.isSymbolicLink()) {
    let target;
    try {
      target = fs.readlinkSync(s.originReal);
    } catch {
      target = undefined;
    }
    const ours =
      target === v.work && (s.link ? sameId(originSt, s.link) : s.linking === true && Number(originSt.uid) === ctx.uid);
    if (ours) {
      const r = await removeOwnLink(ctx, {
        parent,
        parentId: s.ids.originParent,
        base,
        linkId: idOf(originSt),
        target,
        txid: s.txid,
      });
      if (r.ok) lines.push(`已删除原路径上的符号链接 ${s.originReal}`);
      else remaining.push(r.reason);
    }
    originSt = lstatBigOrNull(s.originReal);
  }
  // ── R-B 2: restore the recorded modes on wherever the source tree is now (idempotent) ──
  const backupSt = lstatBigOrNull(s.backup);
  const atBackup = !!backupSt && sameId(backupSt, s.ids.origin);
  const atOrigin = !atBackup && !!originSt && sameId(originSt, s.ids.origin);
  const treePath = atBackup ? s.backup : atOrigin ? s.originReal : undefined;
  if (treePath) {
    if (lstatBigOrNull(files.modes)) {
      // r3.1 B2: the persisted record is validated as a whole BEFORE anything is chmod'ed; any bad
      // record ⇒ no restore at all (fail closed). tree.mjs then reaches every entry through the
      // root fd bound by header.rootId, component by component with O_NOFOLLOW.
      const bad = modesFileProblem(files.modes, s.ids.origin, s.modesCount);
      if (bad)
        remaining.push(`权限记录 ${files.modes} 不合法（${bad}）——拒绝按它恢复权限，源目录树仍是只读；请人工处理`);
      else {
        try {
          const r = await treeOp(ctx, "restore-modes", { root: treePath, modesFile: files.modes }, "恢复权限");
          if (r.skipped?.length) {
            // r3.1 M9: any entry not restored ⇒ rollback incomplete (state + .modes kept)
            remaining.push(
              `${r.skipped.length} 个条目未能恢复权限（例如 ${r.skipped[0].rel || "."}：${r.skipped[0].reason}）——请人工检查；恢复记录保留在 ${files.modes}`,
            );
          } else lines.push(`已恢复源目录树权限（${r.restored} 项改回，${r.unchanged} 项本就一致）`);
        } catch (e) {
          remaining.push(`恢复权限失败：${e.message}`);
        }
      }
    } else if (s.freezeStarted || s.frozen) {
      // r3.1 M9: frozen (or maybe frozen) but no record ⇒ the modes cannot be restored
      remaining.push(`权限记录 ${files.modes} 缺失（源目录树可能仍是只读）——无法自动恢复权限，请人工处理`);
    }
  }
  // ── R-B 3: rename the backup back (RENAME_NOREPLACE; an occupied original path is never replaced) ──
  let home = atOrigin;
  if (atBackup) {
    if (originSt) {
      remaining.push(`原路径 ${s.originReal} 已被占用——不覆盖，备份保留在 ${s.backup}（核对后自行处理）`);
    } else {
      const r = await T.renameNoReplace({
        parent,
        from: bbase,
        to: base,
        expect: s.ids.origin,
        expectParent: s.ids.originParent,
        mvBin: ctx.bins.mv,
        spawnImpl: ctx.spawnImpl,
      });
      if (r.ok) {
        try {
          fsyncDir(parent);
        } catch {
          /* persisted by the next sync anyway */
        }
        home = true;
        lines.push(`已把备份改回原名 ${s.originReal}`);
      } else remaining.push(`备份改回原名失败（${r.reason ?? r.state}）；备份仍在 ${s.backup}`);
    }
  } else if (!atOrigin) {
    if (backupSt) remaining.push(`${s.backup} 不是本次的备份（身份不符），不动它`);
    remaining.push(`找不到本次转换的源目录（${s.originReal} 与 ${s.backup} 的身份都不符），新库保留`);
  }
  // ── R-A: the new vault — only once the source is provably home again ──
  if (home) {
    const ra = await rollbackVault(s, v, { ports, ctx });
    lines.push(...ra.lines);
    remaining.push(...ra.remaining);
  }
  if (remaining.length === 0) {
    unbindWorkerTracking(ctx);
    const left = removeTxnFiles(ctx.txnDir, s.name);
    if (left.length) remaining.push(`无法删除状态文件：${left.join(", ")}`);
  }
  return { done: remaining.length === 0, remaining, lines };
}

async function rollbackVault(s, v, { ports, ctx }) {
  const lines = [];
  const remaining = [];
  let dirSt = lstatBigOrNull(v.dir);
  let mntSt = lstatBigOrNull(v.mnt);
  const ours = !!(s.ids.vaultDir || s.ids.mnt || s.layoutAttempted);
  if (!ours && (dirSt || mntSt)) {
    // this txid never reached createLayout: whatever sits there (maybe a concurrent winner's vault,
    // even mounted) is not ours — never unmount, never delete; just note it
    lines.push(`${[dirSt && v.dir, mntSt && v.mnt].filter(Boolean).join("、")} 不是本次创建的，未改动`);
  }
  const touched = ours && (dirSt || mntSt);
  if (touched) {
    let mstate = "absent";
    try {
      mstate = await ports.probeMountState(v);
    } catch {
      mstate = "unknown";
    }
    if (mstate !== "absent" && mstate !== "foreign") {
      const f = await ports.finalizeBounded(v);
      try {
        mstate = await ports.probeMountState(v);
      } catch {
        mstate = "unknown";
      }
      if (mstate !== "absent") {
        remaining.push(`新库仍挂载（${mstate}）：${(f.lines ?? []).join("；")}`);
        return { lines, remaining };
      }
      lines.push(`已卸载新库 ${v.mnt}`);
    } else if (mstate === "foreign") {
      remaining.push(`${v.mnt} 上挂着别的文件系统，不动它`);
      return { lines, remaining };
    }
    // re-observe AFTER the unmount: while mounted, lstat(<mnt>) is the FUSE root, not our directory
    dirSt = lstatBigOrNull(v.dir);
    mntSt = lstatBigOrNull(v.mnt);
    if (dirSt) {
      let lease = "unknown";
      try {
        lease = await ports.leaseState(v);
      } catch {
        lease = "unknown";
      }
      if (lease !== "free" && lease !== "absent") {
        remaining.push(`新库租约未空闲（${lease}），保留 ${v.dir}`);
        return { lines, remaining };
      }
    }
    const roots = [dirSt && realpathOr(v.dir), mntSt && realpathOr(v.mnt)].filter(Boolean);
    try {
      await requireNoOccupants(roots, ctx, "新库");
    } catch (e) {
      remaining.push(`${e.message}${e.lines?.length ? "\n" + e.lines.join("\n") : ""}`);
      return { lines, remaining };
    }
    // r3.1 B3: set aside (never delete) — mount point first (it could sit below <dir>), then <dir>
    const plan = [];
    if (s.ids.vaultDir || s.ids.mnt) {
      if (mntSt || s.ids.mnt)
        plan.push(
          s.ids.mnt
            ? { p: v.mnt, expect: s.ids.mnt, expectParent: s.ids.mntParent, allowRmdir: true }
            : { reason: `${v.mnt} 未记录身份，保留` },
        );
      if (dirSt || s.ids.vaultDir)
        plan.push(
          s.ids.vaultDir
            ? { p: v.dir, expect: s.ids.vaultDir, expectParent: s.ids.vaultParent, allowRmdir: false }
            : { reason: `${v.dir} 未记录身份，保留` },
        );
    } else {
      // crash between createLayout and recording its ids: only a PURE skeleton is moved aside
      for (const [p, st] of [
        [v.mnt, mntSt],
        [v.dir, dirSt],
      ]) {
        if (!st) continue;
        if (isSkeleton(v, p)) plan.push({ p, expect: idOf(st), allowRmdir: false });
        else plan.push({ reason: `${p} 不是纯骨架（未记录身份），保留` });
      }
    }
    for (const step of plan) {
      if (step.reason) {
        remaining.push(step.reason);
        continue;
      }
      const r = await setAside(ctx, { ...step, txid: s.txid });
      if (r.ok) {
        if (r.line) lines.push(r.line);
      } else remaining.push(r.reason);
    }
    if (remaining.length) return { lines, remaining };
  }
  try {
    const r = await ports.removeVaultEntry(s.name, { pending: `convert:${s.txid}` }, { home: ctx.home });
    // V0 removeVaultEntry: {kind:"missing"} = no entry (never registered, or removed by an earlier
    // pass) — idempotent success by V0 contract (V0-report §2), nothing to report.
    if (r.kind === "ok") lines.push(`已撤销登记 secure.vaults.${s.name}`);
    else if (r.kind === "mismatch") lines.push(`登记项 ${s.name} 不属于本次转换（${r.reason}），未改动`);
  } catch (e) {
    remaining.push(`撤销登记失败：${e.message}`);
  }
  return { lines, remaining };
}

// ───────────────────────────── helpers for the flow ─────────────────────────────

const RENAME_IDENTITY_REASONS = new Set([
  "parent-identity",
  "parent-path",
  "source-identity",
  "identity-mismatch",
  "parent-path-changed",
]);
/**
 * Step-3 rename failure → exit code (r3.1 acceptance minor): an identity mismatch (someone swapped
 * the source / parent) ⇒ 76; otherwise provably nothing moved ("unchanged") ⇒ 65; anything else
 * (outcome unknown) ⇒ 74. Identity is checked first: a swapped source is a state conflict even
 * though nothing of ours moved.
 */
export function renameExit(rn) {
  if (RENAME_IDENTITY_REASONS.has(rn.reason)) return CONVERT_EXIT.BUSY;
  if (rn.state === "unchanged") return CONVERT_EXIT.CONTENT;
  return CONVERT_EXIT.IO;
}

function asConvertError(e, fallback = CONVERT_EXIT.IO) {
  if (e instanceof ConvertError) return e;
  if (e instanceof T.TreeError) return CE(e.exit ?? fallback, e.message, { code: e.code });
  if (e && typeof e.code === "number" && e.code >= 1 && e.code <= 255)
    return CE(e.code, String(e.message), { code: "port" });
  if (e && (e.code === "ENOSPC" || e.code === "EDQUOT"))
    return CE(CONVERT_EXIT.IO, `空间不足：${e.message}`, { code: "ENOSPC" });
  return CE(fallback, String((e && e.message) || e), { code: (e && e.code) || "error" });
}

function treeProblemsError(res, what) {
  const exit = T.problemsExit(res) || CONVERT_EXIT.CONTENT;
  return CE(exit, `${what}：发现 ${res.total} 个问题，拒绝转换：`, {
    lines: T.formatProblems(res, 20),
    code: "content",
  });
}

function gitProblemsError(g, what) {
  if (g.prereq) return CE(CONVERT_EXIT.PREREQ, `${what}：树内有 .git 但找不到 git`);
  return CE(CONVERT_EXIT.CONTENT, `${what}：git 结构不符合要求：`, {
    lines: formatGitProblems(g.problems),
    code: "git",
  });
}

function spaceError(problems) {
  return CE(CONVERT_EXIT.IO, "空间检查失败：", { lines: problems.map((p) => `  ${p.detail}`), code: "space" });
}

function fsckTimeoutMs(bytes) {
  const gib = Math.ceil(bytes / 1024 ** 3);
  return Math.min(CONVERT_BUDGET.fsckMaxMs, CONVERT_BUDGET.fsckBaseMs + gib * CONVERT_BUDGET.fsckPerGiBMs);
}

function failPoint(ctx, step, when) {
  stopPoint(ctx, step, when);
  if (ctx.failAt && ctx.failAt.step === step && ctx.failAt.when === when)
    throw CE(CONVERT_EXIT.IO, `测试缝：第 ${step} 步（${when}）注入失败`, { code: "test-fail" });
}

function printLines(fn, lines) {
  for (const l of lines) fn(l);
}

// ───────────────────────────── cmdConvert ─────────────────────────────

/**
 * `pi-secure convert …` entry (V6 dispatches here). → exit code. Never throws for expected failures.
 *   ports: launcher facilities (see V4-report §2): registerVault, patchVaultEntry, removeVaultEntry,
 *          getVaultEntry, listVaults, deriveVault, defaultVaultDir, defaultVaultMnt, physicalPaths,
 *          createLayout, layoutPreflight (V8), initCipher, unlockVault, ensureVaultDirs, syncProjectSettings,
 *          probeMountState, finalizeBounded, leaseState, preflight, isTty, prompt, out, err
 *   ctx  : defaultConvertContext(...) (paths, binaries, workers, seams)
 */
export async function cmdConvert(args, { ports, ctx: ctxIn } = {}) {
  const ctx = ctxIn ?? defaultConvertContext();
  const out = ports.out;
  const err = ports.err;
  ctx.say ??= out; // M2 re-verification notices
  let opts;
  try {
    opts = parseConvertArgs(args);
  } catch (e) {
    const ce = asConvertError(e);
    err(ce.message);
    return ce.exit;
  }
  // V7 review M1: an armed STOP seam is announced before anything (lock, prompts, state) happens
  if (ctx.stopAt)
    err(
      `!!! 测试缝已启用：convert 将在第 ${ctx.stopAt.step} 步（${ctx.stopAt.when}）暂停（PI_SECURE_TEST_CONVERT_STOP_AT，仅供测试）`,
    );
  const intr = createInterrupts(ctx.signals, () => ({ txid: ctx.txid, uid: ctx.uid, procRoot: ctx.procRoot }));
  const baseSpawn = ctx.spawnImpl ?? spawn;
  ctx.spawnImpl = intr.track(baseSpawn);
  let lock;
  try {
    if (opts.mode === "convert") {
      if (!ports.isTty()) throw CE(CONVERT_EXIT.USAGE, "convert 需要在终端中运行（口令、确认与 master key 都走终端）");
      const pf = ports.preflight();
      if (!pf.ok) throw CE(CONVERT_EXIT.PREREQ, "前置检查失败：", { lines: pf.problems.map((p) => `  - ${p}`) });
      const missing = ["mv", "sync", "getfattr", "flock"].filter((b) => !T.findOnPath(ctx.bins[b], ctx.env.PATH ?? ""));
      if (missing.length)
        throw CE(
          CONVERT_EXIT.PREREQ,
          `缺少前置工具：${missing.map((b) => (b === "getfattr" ? "getfattr（attr 包）" : b)).join("、")}`,
        );
    }
    // uninspectable-process confirmations of THIS run (user ruling 2026-10-24); flows preload the
    // state's recorded ones (--resume/--abort) and persist new ones into the state file
    ctx.unreadable = {
      acked: new Map(),
      interactive: !!ports.isTty(),
      assume: !!opts.assumeUnreadableIdle,
      assumeSpent: false,
      prompt: (q) => ports.prompt(q),
      out: ports.out,
      err: ports.err,
      persist: undefined,
    };
    lock = await acquireConvertLock(ctx.lockPath, { flockBin: ctx.bins.flock, env: ctx.env, uid: ctx.uid });
    ctx.excludePids = () => [lock.pid];
    if (opts.mode === "convert") return await convertFlow(opts, { ports, ctx, intr });
    if (opts.mode === "resume") return await resumeFlow(opts.name, { ports, ctx, intr });
    return await abortFlow(opts.name, { ports, ctx, intr });
  } catch (e) {
    const ce = asConvertError(e);
    err(`pi-secure convert：${ce.message}`);
    printLines(err, ce.lines);
    return ce.exit;
  } finally {
    intr.remove();
    if (lock) await lock.release();
  }
}

// ───────────────────────────── the forward flow (§1.4) ─────────────────────────────

async function convertFlow(opts, { ports, ctx, intr }) {
  const out = ports.out;
  const err = ports.err;
  const { home, uid } = ctx;
  // the txid exists from the very start: every worker / git child carries it (round-2 B2)
  ctx.txid = randomBytes(8).toString("hex");
  // ── step 0: early checks on the ORIGINAL (only to refuse early; never an authorization) ──
  failPoint(ctx, 0, "before");
  const src = expandUserPath(opts.src, { home, cwd: ctx.cwd });
  if (!src) throw CE(CONVERT_EXIT.USAGE, `明文目录须为绝对路径或 ~/ 开头：${opts.src}`);
  const name = opts.name ?? deriveVaultName(src);
  if (!name) throw CE(CONVERT_EXIT.USAGE, `无法从 ${path.basename(src)} 推出合法的保险库名，请显式给出 <名字>`);
  const srcSt = lstatBigOrNull(src);
  if (!srcSt) throw CE(CONVERT_EXIT.NOT_FOUND, `找不到 ${src}`);
  if (srcSt.isSymbolicLink())
    throw CE(CONVERT_EXIT.CONTENT, "路径检查失败：", {
      lines: formatPathProblems([{ code: "path-symlink", path: src }]),
    });
  if (!srcSt.isDirectory())
    throw CE(CONVERT_EXIT.CONTENT, "路径检查失败：", {
      lines: formatPathProblems([{ code: "path-not-dir", path: src }]),
    });
  const srcReal = fs.realpathSync(src);
  const srcId = idOf(srcSt);
  const parentReal = path.dirname(srcReal);
  const base = path.basename(srcReal);
  const vaults = (ports.listVaults() ?? []).map((x) => ({ name: x.name, dir: x.dir, mnt: x.mnt }));
  const pathProblems = pathRuleProblems({
    src,
    srcReal,
    home,
    agentDir: ctx.agentDir,
    vaults,
    systemDirs: ctx.systemDirs,
  });
  if (pathProblems.length)
    throw CE(CONVERT_EXIT.CONTENT, "路径检查失败：", { lines: formatPathProblems(pathProblems) });
  const parentProblems = T.checkParentDir(parentReal, { uid });
  if (parentProblems.length)
    throw CE(CONVERT_EXIT.CONTENT, "父目录检查失败：", {
      lines: T.formatProblems({ problems: parentProblems, total: parentProblems.length }),
    });
  const parentSt = lstatBigOrNull(parentReal);
  const parentId = idOf(parentSt);
  const dir = ports.defaultVaultDir(name, home);
  let mnt = ports.defaultVaultMnt(name, home);
  if (opts.mnt !== undefined) {
    mnt = expandUserPath(opts.mnt, { home });
    if (!mnt || !opts.mnt.match(/^(~\/|\/)/))
      throw CE(CONVERT_EXIT.USAGE, `--path 须为绝对路径或 ~/ 开头：${opts.mnt}`);
  }
  const v = ports.deriveVault(name, dir, mnt);
  for (const q of [v.dir, v.mnt, realpathNearest(v.dir), realpathNearest(v.mnt)])
    if (pathWithin(q, srcReal) || pathWithin(q, src))
      throw CE(CONVERT_EXIT.CONFIG, "保险库位置检查失败：", {
        lines: formatPathProblems([{ code: "vault-in-tree", path: q }]),
      });
  if (ports.getVaultEntry(name) !== undefined)
    throw CE(
      CONVERT_EXIT.CONFIG,
      `保险库名 ${name} 已登记（secure.vaults.${name}）；换一个名字：pi-secure convert ${src} <名字>`,
    );
  // V8: createLayout's position + mount-point ancestor rules, judged NOW (same functions, via the
  // port) so a non-compliant location is refused before any prompt, claim, password or write
  // (.txn included); step 2 re-checks them as defense in depth.
  const lp = ports.layoutPreflight(v, { others: vaults, home });
  if (lp) throw CE(CONVERT_EXIT.CONFIG, lp.title, { lines: lp.lines.map((l) => `  - ${l}`) });
  ensureTxnDir(ctx.txnDir, uid);
  if (readState(ctx.txnDir, name))
    throw CE(CONVERT_EXIT.BUSY, `保险库 ${name} 有未完成的转换：pi-secure convert --resume|--abort ${name}`);
  if (lstatBigOrNull(v.dir)) throw CE(CONVERT_EXIT.CONFIG, `${v.dir} 已存在——不接管已有目录`);
  if (lstatBigOrNull(v.mnt)) throw CE(CONVERT_EXIT.CONFIG, `挂载点 ${v.mnt} 已存在——不接管已有目录；换名字或用 --path`);
  await requireNoOccupants([srcReal], ctx, "源目录被占用");
  out(`检查 ${src} …`);
  const early = await treeOp(
    ctx,
    "check",
    {
      root: srcReal,
      expectRoot: srcId,
      linkRoots: [...new Set([src, srcReal])],
      uid,
      gid: ctx.gid,
      getfattrBin: ctx.bins.getfattr,
    },
    "早检",
  );
  if (early.total > 0) throw treeProblemsError(early, "早检");
  const g0 = await gitRuleProblems(srcReal, { gitEntries: early.gitEntries, origRoots: [], ctx });
  if (g0.prereq || g0.problems.length) throw gitProblemsError(g0, "早检");
  const spaceAt = nearestExisting(v.dir);
  const sp0 = T.checkSpace(T.statfsInfo(spaceAt), early.estimate);
  if (sp0.length) throw spaceError(sp0);
  let preview;
  if (!opts.noSessions) {
    const approxWork = path.join(realpathNearest(v.mnt), "work"); // preview only (counts)
    preview = await convertOp(
      ctx,
      "sessions-plan",
      sessionsSpec(ctx, { src, srcReal, treeRoot: srcReal, realWork: approxWork, opts }),
    );
  }
  let backup;
  for (let i = 0; i < 8 && !backup; i++) {
    const b = path.join(parentReal, T.backupName(base, ctx.now(), ctx.rand));
    if (!lstatBigOrNull(b)) backup = b;
  }
  if (!backup) throw CE(CONVERT_EXIT.CONTENT, "无法为备份选出一个未被占用的名字");
  // plan + confirmation
  const sm = early.summary;
  out(
    [
      `将把明文目录转换为保险库 ${name}：`,
      `  源：${src}${src !== srcReal ? `（物理路径 ${srcReal}）` : ""}`,
      `  内容：${sm.entries} 个条目（${sm.files} 文件 / ${sm.dirs} 目录 / ${sm.symlinks} 符号链接），${sm.bytes} 字节`,
      `  保险库：元数据 ${v.dir}，挂载点 ${v.mnt}，项目根 ${v.work}`,
      `  原目录将改名为只读备份：${backup}（由你核对后自行删除，期间占用双倍空间）`,
      preview
        ? `  会话：${preview.sessions} 个会话文件、${preview.memory} 个 memory 目录将被复制（源文件不动）`
        : "  会话：跳过（--no-sessions）",
      `  从改名到建立链接（含拷贝与校验）期间原路径 ${src} 不存在；口令与确认都在改名之前完成。`,
      `  完成后 ${src} 是指向 ${v.work} 的符号链接；备份、旧会话与 SSD 上的数据块仍是明文残留。`,
      ...(early.warnings?.length ? [`  警告：${early.warnings.length} 个指向树外的绝对符号链接（目标仍是明文）`] : []),
    ].join("\n"),
  );
  const answer = await ports.prompt(`确认请输入保险库名 ${name}：`);
  if (answer === null || answer === undefined || String(answer).trim() !== name) {
    out("已取消，未做任何修改");
    return CONVERT_EXIT.FAIL;
  }
  intr.install();
  failPoint(ctx, 0, "after");
  // ── step 1: txid + state file ──
  intr.check();
  failPoint(ctx, 1, "before");
  const state = {
    v: STATE_V,
    txid: ctx.txid,
    name,
    phase: "claimed",
    origin: src,
    originReal: srcReal,
    backup,
    vault: { dir: v.dir, mnt: v.mnt },
    ids: { originParent: parentId, origin: srcId },
    opts: { noSessions: !!opts.noSessions, sessionsFrom: opts.sessionsFrom ?? [], private: !!opts.private },
    createdAt: new Date().toISOString(),
  };
  try {
    writeState(ctx.txnDir, state);
  } catch (e) {
    throw CE(CONVERT_EXIT.IO, `无法写状态文件（未做任何修改）：${e.message}`);
  }
  const persist = () => writeState(ctx.txnDir, state);
  bindWorkerTracking(ctx, state, persist);
  let committed = false;
  let sessionsReport;
  try {
    failPoint(ctx, 1, "after");
    await forwardSteps({
      ports,
      ctx,
      intr,
      state,
      v,
      persist,
      opts,
      srcId,
      parentId,
      parentReal,
      base,
      onSessions: (r) => (sessionsReport = r),
    });
    // ── step 14: the only commit point (not interruptible) ──
    intr.check();
    failPoint(ctx, 14, "before");
    await refreshIfStale(ctx, state, 14); // V7 review M2 (a mismatch ⇒ rollback, link removed by R-B 1)
    intr.deferred = true;
    let r;
    try {
      r = await ports.patchVaultEntry(
        name,
        { pending: `convert:${state.txid}` },
        { remove: ["pending"], set: { origin: src, backup } },
        { home },
      );
    } catch (e) {
      throw CE(CONVERT_EXIT.IO, `提交失败：${e.message}；请执行 pi-secure convert --resume ${name}`, {
        keepState: true,
      });
    }
    if (!r || r.kind !== "ok")
      throw CE(
        CONVERT_EXIT.IO,
        `提交失败（${r?.kind ?? "?"}${r?.reason ? `：${r.reason}` : ""}）；请执行 pi-secure convert --resume ${name}`,
        {
          keepState: true,
        },
      );
    committed = true;
    failPoint(ctx, 14, "after");
  } catch (e) {
    if (committed) {
      const ce = asConvertError(e);
      err(`转换已提交，但收尾出错：${ce.message}`);
      return finishCommitted({ ports, ctx, state, v, sessionsReport, out, err, intr });
    }
    const ce = asConvertError(e);
    intr.deferred = true; // recovery runs to completion; a second signal changes nothing
    err(`pi-secure convert：${ce.message}`);
    printLines(err, ce.lines);
    if (ce.keepState) {
      err(
        `状态已保存（${state.phase}）：清理后 pi-secure convert --resume ${name}，或 pi-secure convert --abort ${name}`,
      );
      return intr.sig ? intr.exitCode() : ce.exit;
    }
    const rec = await recoverConvert(state, { ports, ctx });
    printLines(out, rec.lines);
    if (rec.blocked) {
      err(`未回滚：\n  - ${rec.remaining.join("\n  - ")}`);
      return CONVERT_EXIT.DEADLINE;
    }
    if (rec.done) {
      out("已回滚：源目录已回到原路径并恢复权限；新库已卸载、撤销登记并改名保留（见上，未删除）");
      return intr.sig ? intr.exitCode() : ce.exit;
    }
    err(
      `回滚不完整（状态文件与恢复记录已保留）：\n  - ${rec.remaining.join("\n  - ")}\n人工处理后执行：pi-secure convert --abort ${name}`,
    );
    return intr.sig ? intr.exitCode() : CONVERT_EXIT.IO;
  }
  return finishCommitted({ ports, ctx, state, v, sessionsReport, out, err, intr });
}

function sessionsSpec(ctx, { src, srcReal, treeRoot, realWork, opts, destStateDir }) {
  return {
    root: src,
    rootRealpath: srcReal,
    treeRoot,
    newRoot: realWork,
    agentDir: path.resolve(ctx.agentDir),
    home: path.resolve(ctx.home),
    memoryRoot: path.resolve(ctx.memoryRoot),
    ...(destStateDir ? { destStateDir } : {}),
    ...(ctx.globalSessionDir ? { globalSessionDir: ctx.globalSessionDir } : {}),
    ...(ctx.env.PI_CODING_AGENT_SESSION_DIR ? { envSessionDir: ctx.env.PI_CODING_AGENT_SESSION_DIR } : {}),
    extraDirs: (opts.sessionsFrom ?? []).map((d) => expandUserPath(d, { home: ctx.home, cwd: ctx.cwd }) ?? d),
    foreignDirs: [
      path.join(ctx.agentDir, "cache", "consult-sessions"),
      path.join(ctx.home, ".pi", "agent", "web-hub", "spawn", "fork-src"),
    ],
  };
}

/** Steps 2–13. Throws ConvertError; the caller rolls back unless `keepState`. */
async function forwardSteps({
  ports,
  ctx,
  intr,
  state,
  v,
  persist,
  opts,
  srcId,
  parentId,
  parentReal,
  base,
  onSessions,
}) {
  const out = ports.out;
  const { home, uid } = ctx;
  const files = txnFiles(ctx.txnDir, state.name);
  const pending = `convert:${state.txid}`;
  // ── step 2: claim name, create layout, init, mount ──
  intr.check();
  failPoint(ctx, 2, "before");
  await ports.registerVault(
    state.name,
    { dir: v.dir, mnt: v.mnt, ...(opts.private ? { private: true } : {}) },
    { home, expectAbsent: true, pending },
  );
  if (lstatBigOrNull(v.dir) || lstatBigOrNull(v.mnt))
    throw CE(CONVERT_EXIT.CONFIG, `${v.dir} 或 ${v.mnt} 已出现——不接管`);
  state.layoutAttempted = true;
  persist();
  try {
    await ports.createLayout(v, { others: ports.listVaults().filter((x) => x.name !== state.name), home });
  } finally {
    const d = lstatBigOrNull(v.dir);
    const m = lstatBigOrNull(v.mnt);
    if (d && m && d.isDirectory() && m.isDirectory() && lstatBigOrNull(v.lease)) {
      state.ids.vaultDir = idOf(d);
      state.ids.mnt = idOf(m);
      const dp = lstatBigOrNull(path.dirname(v.dir));
      const mp = lstatBigOrNull(path.dirname(v.mnt));
      if (dp) state.ids.vaultParent = idOf(dp);
      if (mp) state.ids.mntParent = idOf(mp);
      persist();
    }
  }
  intr.check();
  out("即将初始化保险库：gocryptfs 会要求输入两次新口令，然后在终端打印 master key（只显示这一次，请抄下离线保存）。");
  const code = await ports.initCipher(v);
  intr.check();
  if (code !== 0) throw CE(CONVERT_EXIT.FAIL, `gocryptfs -init 失败（exit ${code}）`);
  out("挂载新库（再输入一次口令）：");
  const mounted = await ports.unlockVault(v, { postMount: false });
  intr.check();
  const phys = ports.physicalPaths(v);
  const realMnt = mounted?.realMnt ?? phys.realMnt;
  const realWork = path.join(realMnt, "work");
  const { realCipher, realDir } = phys;
  state.ids.cipher = idOf(fs.lstatSync(realCipher, { bigint: true }));
  persist();
  await ports.ensureVaultDirs(v, { realMnt });
  const workSt = fs.lstatSync(realWork, { bigint: true });
  const workId = idOf(workSt);
  if (fs.readdirSync(realWork).length !== 0) throw CE(CONVERT_EXIT.IO, `${v.work} 不是空目录`);
  // passwords may have taken minutes: the source must still be the same object, unoccupied
  const again = lstatBigOrNull(state.originReal);
  if (!again || !sameId(again, srcId)) throw CE(CONVERT_EXIT.BUSY, `源目录 ${state.originReal} 在确认后被替换或移走`);
  await requireNoOccupants([state.originReal], ctx, "源目录被占用");
  failPoint(ctx, 2, "after");
  // ── step 3: rename to backup (RENAME_NOREPLACE, identity-judged) ──
  intr.check();
  failPoint(ctx, 3, "before");
  state.phase = "renaming";
  persist();
  stopPoint(ctx, 3, "mid"); // test seam only: phase "renaming" persisted, rename not yet done
  const rn = await T.renameNoReplace({
    parent: parentReal,
    from: base,
    to: path.basename(state.backup),
    expect: srcId,
    expectParent: parentId,
    mvBin: ctx.bins.mv,
    spawnImpl: ctx.spawnImpl,
  });
  if (!rn.ok)
    throw CE(
      renameExit(rn),
      `改名为备份失败（${rn.reason ?? rn.state}）${rn.state === "unchanged" ? "，源目录未改动" : ""}`,
      {
        code: "rename",
      },
    );
  fsyncDir(parentReal);
  state.phase = "backed-up";
  persist();
  failPoint(ctx, 3, "after");
  // ── step 4: read-only (modes recorded first) ──
  intr.check();
  failPoint(ctx, 4, "before");
  state.freezeStarted = true; // r3.1 M9: from here on a missing .modes means "rollback incomplete"
  persist();
  await treeOp(ctx, "freeze", { root: state.backup, modesFile: files.modes, expectRoot: srcId }, "只读");
  state.frozen = true;
  // round-2 M3: the number of records frozen — the rollback refuses a .modes that differs
  state.modesCount = T.readModesFile(files.modes).records.length;
  persist();
  failPoint(ctx, 4, "after");
  // ── step 5: post-freeze rescan ──
  intr.check();
  failPoint(ctx, 5, "before");
  const backupReal = realpathOr(state.backup);
  await requireNoOccupants([backupReal], ctx, "备份被占用");
  const mp = T.mountProblems(T.readMountinfo(), [state.backup, backupReal]);
  if (mp.length) throw CE(CONVERT_EXIT.CONTENT, "备份树内有挂载点：", { lines: mp.map((p) => `  ${p.path}`) });
  failPoint(ctx, 5, "after");
  // ── step 6: authoritative check on the frozen backup = the baseline ──
  intr.check();
  failPoint(ctx, 6, "before");
  const auth = await treeOp(
    ctx,
    "check",
    {
      root: state.backup,
      expectRoot: srcId,
      linkRoots: [...new Set([state.origin, state.originReal])],
      uid,
      gid: ctx.gid,
      getfattrBin: ctx.bins.getfattr,
      manifestOut: files.base,
    },
    "权威检查",
  );
  if (auth.total > 0) throw treeProblemsError(auth, "权威检查（备份）");
  const g = await gitRuleProblems(state.backup, {
    gitEntries: auth.gitEntries,
    origRoots: [...new Set([state.origin, state.originReal])],
    ctx,
  });
  if (g.prereq || g.problems.length) throw gitProblemsError(g, "权威检查（备份）");
  const sp = T.checkSpace(T.statfsInfo(realDir), auth.estimate);
  if (sp.length) throw spaceError(sp);
  failPoint(ctx, 6, "after");
  // ── step 7: copy ──
  intr.check();
  failPoint(ctx, 7, "before");
  out(`拷贝 ${auth.summary.files} 个文件（${auth.summary.bytes} 字节）进保险库 …`);
  await treeOp(
    ctx,
    "copy",
    {
      src: state.backup,
      dst: realWork,
      baselineFile: files.base,
      modesFile: files.modes,
      hashesOut: files.hashes,
      expectDst: workId,
      applyRootMeta: false,
    },
    "拷贝",
  );
  failPoint(ctx, 7, "after");
  // ── step 8: verify (+ git) ──
  intr.check();
  failPoint(ctx, 8, "before");
  const ver = await treeOp(
    ctx,
    "verify",
    {
      dst: realWork,
      baselineFile: files.base,
      modesFile: files.modes,
      hashesFile: files.hashes,
      expectDst: workId,
      applyRootMeta: false,
    },
    "校验",
  );
  if (!ver.ok)
    throw CE(CONVERT_EXIT.IO, `校验失败（${ver.diffs.length} 处不一致）：`, {
      lines: ver.diffs.slice(0, 20).map((d) => `  ${d.rel ?? ""}：${d.what ?? d.kind ?? JSON.stringify(d)}`),
    });
  if (g.repos.length) {
    const rootRepo = g.repos.find((r) => r.rel === ".git");
    if (rootRepo) {
      // r3.1 M6: hardened plumbing only — HEAD + fsck; no porcelain status (byte equality of the
      // whole tree, .git included, is already proven by verify above).
      const hz = await gitHardening(ctx, realWork);
      if (!hz.ok) throw CE(CONVERT_EXIT.IO, `校验失败：无法确认 git 只读（${hz.detail}）`);
      const head = await git(ctx, realWork, ["rev-parse", "-q", "--verify", "HEAD"], { hard: hz.hard });
      const headVal = head.ok && head.code === 0 ? head.out.trim() : head.ok && head.code === 1 ? null : undefined;
      if (headVal === undefined || headVal !== rootRepo.head)
        throw CE(CONVERT_EXIT.IO, "校验失败：保险库副本的 git HEAD 与备份不一致");
      const fsck = await git(ctx, realWork, ["fsck", "--connectivity-only", "--no-dangling"], {
        timeoutMs: fsckTimeoutMs(auth.summary.bytes),
        hard: hz.hard,
      });
      if (!fsck.ok || fsck.code !== 0)
        throw CE(CONVERT_EXIT.IO, `校验失败：git fsck 未通过（${fsck.kind ?? `exit ${fsck.code}`}）`, {
          lines: fsck.err
            ? fsck.err
                .split("\n")
                .slice(0, 10)
                .map((l) => `  ${l}`)
            : [],
        });
    }
  }
  // r3.1 M5: completion evidence for --resume (identity of the verified copy target + entry count)
  state.copyVerified = { work: workId, entries: Number(ver.checked ?? 0) };
  persist();
  failPoint(ctx, 8, "after");
  // ── step 9: project sessionDir ──
  intr.check();
  failPoint(ctx, 9, "before");
  const ps = await ports.syncProjectSettings(v, { fix: true, home });
  if (!ps || ps.kind === "conflict") throw CE(CONVERT_EXIT.IO, `无法写入项目 sessionDir：${ps?.message ?? "?"}`);
  // round-2 M4: per-step completion evidence (step 9) — identity of the written project settings
  const settingsSt = lstatBigOrNull(path.join(realWork, ".pi", "settings.json"));
  if (!settingsSt || !settingsSt.isFile()) throw CE(CONVERT_EXIT.IO, "项目 .pi/settings.json 未写入保险库");
  state.settingsDone = { file: idOf(settingsSt) };
  persist();
  failPoint(ctx, 9, "after");
  // ── step 10: sessions + memory (copy only) ──
  intr.check();
  failPoint(ctx, 10, "before");
  let lastSessions;
  if (!opts.noSessions) {
    const rep = await convertOp(
      ctx,
      "sessions",
      sessionsSpec(ctx, {
        src: state.origin,
        srcReal: state.originReal,
        treeRoot: state.backup,
        realWork,
        opts,
        destStateDir: path.join(realMnt, "state"),
      }),
    );
    const bad = [
      ...(rep.conflicts ?? []).map((c) => `会话冲突：${c}`),
      ...(rep.sessionsPartial ?? []).map((c) => `会话未完整复制：${c}`),
      ...(rep.memoryConflicts ?? []).map((c) => `memory 冲突：${c}`),
      ...(rep.memoryPartial ?? []).map((c) => `memory 未完整复制：${c}`),
    ];
    if (bad.length)
      throw CE(CONVERT_EXIT.IO, "会话 / memory 复制不完整（冲突或未能完整复制），不提交：", {
        lines: bad.slice(0, 20).map((c) => `  ${c}`),
        code: "sessions-incomplete",
      });
    onSessions(rep);
    lastSessions = rep;
  }
  // round-2 M4: step-10 evidence (counts + identity of the vault state dir)
  const stateSt = lstatBigOrNull(path.join(realMnt, "state"));
  if (!stateSt || !stateSt.isDirectory()) throw CE(CONVERT_EXIT.IO, "保险库 state 目录不在");
  state.sessionsDone = {
    skipped: !!opts.noSessions,
    sessions: Number(lastSessions?.counts?.complete ?? 0),
    memory: Number(lastSessions?.memoryComplete ?? 0),
    state: idOf(stateSt),
  };
  persist();
  failPoint(ctx, 10, "after");
  // ── step 11: persistence barrier ──
  intr.check();
  failPoint(ctx, 11, "before");
  const cipherT = T.dirTarget(realCipher);
  if (!sameId(cipherT, state.ids.cipher)) throw CE(CONVERT_EXIT.IO, `${realCipher} 身份与挂载时记录的不符`);
  const dirT = T.dirTarget(realDir);
  if (!sameId(dirT, state.ids.vaultDir)) throw CE(CONVERT_EXIT.IO, `${realDir} 身份与创建时记录的不符`);
  await treeOp(
    ctx,
    "sync",
    {
      syncfs: [cipherT],
      fsyncDirs: [dirT, T.dirTarget(path.dirname(realMnt)), T.dirTarget(realpathOr(ctx.txnDir))],
      syncBin: ctx.bins.sync,
    },
    "持久化屏障",
  );
  state.barrierDone = { cipher: idOf(cipherT) }; // round-2 M4: step-11 evidence
  state.phase = "synced";
  persist();
  failPoint(ctx, 11, "after");
  // ── step 12: re-verify the backup against the baseline ──
  intr.check();
  failPoint(ctx, 12, "before");
  await reverifyBackup(ctx, state);
  failPoint(ctx, 12, "after");
  // ── step 13: the link ──
  intr.check();
  failPoint(ctx, 13, "before");
  await refreshIfStale(ctx, state, 13); // V7 review M2: a pause since step 12 voids its evidence
  await linkOrigin(ctx, state, v, persist);
  failPoint(ctx, 13, "after");
}

/**
 * V7 review M2 — stale-evidence bound. Step 12's occupancy scan + baseline comparison are the last
 * proof that the backup (= what the vault holds) is unchanged. Between that proof and the
 * irreversible points (step 13 link, step 14 commit; the same pair in --resume) the flow does no
 * user interaction and no data-proportional work: milliseconds. A pause there — Ctrl+Z/SIGSTOP,
 * laptop suspend, scheduler stall, a debugger — lets the world change while the evidence looks
 * fresh. So right before each irreversible point: if more than STALE_EVIDENCE_MS passed since the
 * last successful re-verification, run it again in full (occupancy + compare-baseline, step-12
 * semantics; a mismatch takes the existing failure path — rollback in the forward flow, refusal in
 * --resume — never success). 5 s: three orders of magnitude above the normal gap, so it never fires
 * in a healthy run, yet any human-scale pause is caught; a spurious re-check only costs time.
 * Both clocks are consulted: the monotonic one stops during system suspend (CLOCK_MONOTONIC), the
 * wall clock does not; any backwards wall jump counts as stale as well.
 */
export const STALE_EVIDENCE_MS = 5_000;
export function evidenceStamp() {
  return { mono: process.hrtime.bigint(), wall: Date.now() };
}
export function evidenceStale(stamp, now = evidenceStamp(), limitMs = STALE_EVIDENCE_MS) {
  if (!stamp) return true;
  const mono = Number((now.mono - stamp.mono) / 1_000_000n);
  const wall = now.wall - stamp.wall;
  return mono > limitMs || wall > limitMs || wall < -1_000;
}
async function refreshIfStale(ctx, state, step) {
  if (!evidenceStale(ctx.backupVerifiedAt, (ctx.evidenceNow ?? evidenceStamp)())) return false;
  ctx.say?.(`距上次备份复核已超过 ${STALE_EVIDENCE_MS / 1000} 秒（暂停/休眠？），第 ${step} 步之前重新复核备份 …`);
  await reverifyBackup(ctx, state);
  return true;
}

async function reverifyBackup(ctx, state) {
  const files = txnFiles(ctx.txnDir, state.name);
  await requireNoOccupants([realpathOr(state.backup)], ctx, "备份被占用");
  const cmp = await treeOp(ctx, "compare-baseline", { root: state.backup, baselineFile: files.base }, "复核备份");
  if (!cmp.same)
    throw CE(CONVERT_EXIT.IO, `备份在转换期间被改动（${cmp.diffs.length} 处），保险库副本不再可信：`, {
      lines: cmp.diffs
        .slice(0, 20)
        .map((d) => `  ${d.rel ?? ""}：${d.kind}${d.fields ? `（${d.fields.join(",")}）` : ""}`),
      code: "backup-changed",
    });
  ctx.backupVerifiedAt = (ctx.evidenceNow ?? evidenceStamp)(); // M2: evidence timestamp (end of the proof)
}

/** Step 13 (also --resume). EEXIST / foreign object ⇒ 76 keepState. */
async function linkOrigin(ctx, state, v, persist) {
  const parent = path.dirname(state.originReal);
  const base = path.basename(state.originReal);
  const cur = lstatBigOrNull(state.originReal);
  if (cur) {
    if (
      cur.isSymbolicLink() &&
      fs.readlinkSync(state.originReal) === v.work &&
      (!state.link || sameId(cur, state.link))
    ) {
      state.link = idOf(cur);
    } else
      throw CE(CONVERT_EXIT.BUSY, `原路径 ${state.originReal} 已被占用（转换期间被重新创建）——不覆盖`, {
        keepState: true,
        code: "origin-occupied",
      });
  } else {
    state.linking = true;
    persist();
    const r = symlinkAt(parent, state.ids.originParent, base, v.work);
    if (r === "exists")
      throw CE(CONVERT_EXIT.BUSY, `原路径 ${state.originReal} 已被占用（转换期间被重新创建）——不覆盖`, {
        keepState: true,
        code: "origin-occupied",
      });
    state.link = r;
  }
  state.phase = "linked";
  persist();
}

async function finishCommitted({ ports, ctx, state, v, sessionsReport, out, err }) {
  // ── step 15 ──
  unbindWorkerTracking(ctx);
  const left = removeTxnFiles(ctx.txnDir, state.name);
  if (left.length) err(`无法删除状态文件（转换已完成，可手动删除）：${left.join(", ")}`);
  const f = await ports.finalizeBounded(v);
  printLines(f.code === 0 ? out : err, f.lines ?? []);
  if (f.code !== 0) out(`保险库保持挂载；稍后 pi-secure lock ${state.name}`);
  printLines(out, completionLines(ctx, state, v, sessionsReport));
  return CONVERT_EXIT.OK;
}

/** POSIX sh single-argument quoting for the printed manual-cleanup commands (V6 status reuses it). */
export function shellQuote(p) {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** §1.7 completion output. */
export function completionLines(ctx, state, v, sessionsReport) {
  const q = shellQuote;
  const lines = [
    `完成：${state.origin} 已转换为保险库 ${state.name}；原路径现在是指向 ${v.work} 的符号链接（锁定时不可进入）。`,
    `原目录已改名为只读备份：${state.backup}。请在确认保险库内容无误后自行删除：chmod -R u+w -- ${q(state.backup)} && rm -rf -- ${q(state.backup)}`,
    "SSD / CoW 文件系统上删除 ≠ 擦除：备份与旧会话的数据块可能仍可恢复（R17/R26）。",
  ];
  if (sessionsReport) {
    lines.push(...(sessionsReport.cleanup ?? []));
    if (sessionsReport.partial)
      lines.push("注意：部分子会话引用超出预算或无法追踪，已复制发现的部分（不影响源文件）。");
    if (sessionsReport.memoryAmbiguous) lines.push("注意：memory 目录 slug 有歧义，未复制 memory（旧目录不动）。");
    if (sessionsReport.foreign?.length) {
      lines.push("以下缓存/快照中也含有该项目的明文会话（逐条核对后可手动删除）：");
      for (const f of sessionsReport.foreign.slice(0, 50)) lines.push(`  ${f}`);
    }
  }
  lines.push(
    `其他可能仍含该项目明文的位置：git 远端、备份、${path.join(ctx.agentDir, "crashes.json")}（R1）、pi-debug.log（R4）、traffic.db（R10）、web-hub 状态目录 ${path.join(ctx.home, ".pi", "agent", "web-hub")}（R12）。`,
    "插件按进程冻结域判定：已在运行的 pi 进程需要重启后才认得新的原路径登记（origin）。",
    "session-nav 的子会话识别缓存与 web-hub 历史列表按预算增量更新，旧条目可能短时间仍可见。",
    `之后：cd ${state.origin} && pi-secure run ${state.name}，或 pi-secure unlock ${state.name}。`,
  );
  return lines;
}

// ───────────────────────────── --resume / --abort (§1.6) ─────────────────────────────

async function resumeFlow(name, { ports, ctx, intr }) {
  const out = ports.out;
  ensureTxnDir(ctx.txnDir, ctx.uid);
  const s = readState(ctx.txnDir, name);
  if (!s) throw CE(CONVERT_EXIT.NOT_FOUND, `保险库 ${name} 没有未完成的转换`);
  const pending = `convert:${s.txid}`;
  const entry = ports.getVaultEntry(name);
  const committedAlready = entry && entry.pending === undefined && entry.origin === s.origin;
  if (!committedAlready && (!entry || entry.pending !== pending))
    throw CE(
      CONVERT_EXIT.BUSY,
      `登记项 secure.vaults.${name} 不属于本次转换（${entry ? `pending=${entry.pending ?? "无"}` : "不存在"}）；只能 --abort`,
    );
  if (s.phase !== "synced" && s.phase !== "linked")
    throw CE(
      CONVERT_EXIT.BUSY,
      `转换停在 ${s.phase} 阶段：拷贝、校验或持久化尚未完成，不能完成链接。请执行 pi-secure convert --abort ${name} 后重新转换`,
    );
  authorizeState(s, { ports, ctx, entry });
  ctx.txid = s.txid;
  const persist = () => writeState(ctx.txnDir, s);
  await reapLeftoverWorker(s, ctx, persist);
  bindWorkerTracking(ctx, s, persist);
  const v = vaultOf(ports, s);
  intr.install();
  if (!committedAlready) {
    await verifyVaultForResume(s, v, { ports, ctx });
    const b = lstatBigOrNull(s.backup);
    if (!b || !sameId(b, s.ids.origin))
      throw CE(CONVERT_EXIT.BUSY, `备份 ${s.backup} 不在或身份不符，不能完成；请核对后 --abort`);
    const refuse = (e) => {
      // an uncertain occupancy check (75) stays 75: it is not a state conflict
      if (e && e.exit === CONVERT_EXIT.DEADLINE) throw e;
      throw CE(CONVERT_EXIT.BUSY, `${e.message}；请执行 pi-secure convert --abort ${name}`, { lines: e.lines });
    };
    await reverifyBackup(ctx, s).catch(refuse);
    intr.check();
    await refreshIfStale(ctx, s, 13).catch(refuse); // V7 review M2
    await linkOrigin(ctx, s, v, persist);
    out(`已建立链接 ${s.originReal} → ${v.work}`);
    intr.check();
    await refreshIfStale(ctx, s, 14).catch(refuse); // V7 review M2: refused ⇒ state stays linked, --abort
    intr.deferred = true;
    let r;
    try {
      r = await ports.patchVaultEntry(
        name,
        { pending },
        { remove: ["pending"], set: { origin: s.origin, backup: s.backup } },
        { home: ctx.home },
      );
    } catch (e) {
      throw CE(CONVERT_EXIT.IO, `提交失败：${e.message}；稍后再次 --resume`);
    }
    if (!r || r.kind !== "ok") throw CE(CONVERT_EXIT.IO, `提交失败（${r?.kind}）；稍后再次 --resume`);
  }
  return finishCommitted({ ports, ctx, state: s, v, sessionsReport: undefined, out, err: ports.err });
}

async function abortFlow(name, { ports, ctx, intr }) {
  const out = ports.out;
  const err = ports.err;
  ensureTxnDir(ctx.txnDir, ctx.uid);
  const s = readState(ctx.txnDir, name);
  if (!s) throw CE(CONVERT_EXIT.NOT_FOUND, `保险库 ${name} 没有未完成的转换`);
  const entry = ports.getVaultEntry(name);
  const pending = `convert:${s.txid}`;
  if (entry !== undefined && entry.pending !== pending) {
    if (entry.pending === undefined && entry.origin === s.origin)
      throw CE(CONVERT_EXIT.BUSY, `转换已完成，不能撤销；备份仍在 ${s.backup}`);
    throw CE(
      CONVERT_EXIT.BUSY,
      `登记项 secure.vaults.${name} 不属于本次转换（pending=${entry.pending ?? "无"}），拒绝 --abort`,
    );
  }
  authorizeState(s, { ports, ctx, entry });
  ctx.txid = s.txid;
  const persist = () => writeState(ctx.txnDir, s);
  bindWorkerTracking(ctx, s, persist);
  intr.install();
  intr.deferred = true; // rollback always runs to the end once started
  const rec = await recoverConvert(s, { ports, ctx }); // proves the recorded worker group gone first
  printLines(out, rec.lines);
  if (rec.blocked) {
    err(`未回滚：\n  - ${rec.remaining.join("\n  - ")}`);
    return CONVERT_EXIT.DEADLINE;
  }
  if (rec.done) {
    out("已回滚：源目录已回到原路径并恢复权限；新库已卸载、撤销登记并改名保留（见上，未删除）");
    return intr.sig ? intr.exitCode() : CONVERT_EXIT.FAIL;
  }
  err(
    `回滚不完整（状态文件与恢复记录已保留）：\n  - ${rec.remaining.join("\n  - ")}\n人工处理后再次执行：pi-secure convert --abort ${name}`,
  );
  return CONVERT_EXIT.IO;
}

// ───────────────────────────── entry ─────────────────────────────

let isEntry = false;
try {
  isEntry = !!process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
} catch {
  isEntry = false;
}
if (isEntry) {
  if (process.argv[2] !== "__convert-work" || !CONVERT_WORKER_OPS.includes(process.argv[3] ?? "")) {
    process.stderr.write("convert.mjs: 用法 __convert-work <op>（内部 worker 入口）\n");
    process.exit(2);
  }
  convertWorkerMain(process.argv[3]).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`convert.mjs: 内部错误：${e}\n`);
      process.exit(1);
    },
  );
}
