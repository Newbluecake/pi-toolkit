/**
 * web-hub-spawn plan §SP3 (arch v2 §4.5 + §4.2/#7): the known-directory scan, admission and the
 * pre-fork cwd pin — the ONLY module that decides "which directory may a managed session start
 * in" and "is it still the same directory at fork time".
 *
 * Known directories are the union of three sources (arch §4.5): ① every registry card's `cwd`,
 * ② session-file headers under `<agentDir>/sessions` (newest `.jsonl` per session dir, modified
 * within 30 days, `cwd` read from the first line's ≤4 KiB head), ③ the spawn history the caller
 * injects. Every candidate is realpath'd and kept only if it still is a directory; entries are
 * ordered by last-activity descending and capped at `KNOWN_DIR_LIMIT` (50) — the capped list is
 * BOTH what `GET /api/headless/dirs` returns and the membership set `admit` tests against, so
 * the UI's recent list and the admission verdict can never disagree. The scan caches for
 * `KNOWN_CACHE_MS`, is single-flight, and is bounded by `min(KNOWN_SCAN_BUDGET_MS, deadline
 * remaining)`; when the budget runs out mid-scan the partial result is returned (`partial:true`)
 * and — for `admit` — acts fail-closed: a directory not in the (possibly partial) set simply is
 * not known.
 *
 * `admit` follows arch §4.5's four steps verbatim (validate → realpath/stat/access with dev/ino
 * capture → known membership → roots match on realpath'd, path-SEGMENT-aligned roots), and
 * `pinSync` is the synchronous TOCTOU re-check arch §4.2 mandates before every fork:
 * `open(O_RDONLY|O_DIRECTORY)` + `fstat` must reproduce admit's dev/ino, and the child is
 * started with `cwd = /proc/self/fd/<fd>` so the pinned inode — not a re-lookup of the path —
 * becomes the working directory. The caller owns the fd from the `{ok:true}` result on and MUST
 * `closeSync(fd)` after `spawn()` returns (try/finally); `pinSync` closes it itself on every
 * failure path.
 *
 * Degrading rules: every per-entry fs error (vanished dir, unreadable header, broken symlink)
 * drops just that entry; the registry/spawnHistory callbacks and the sessions-root readdir are
 * each individually guarded — the scan never throws, it just knows less. `hub/spawn/**` is
 * `as`-free by contract (plan SP7 source scan), so all narrowing here is type guards +
 * `in`-narrowing.
 */
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { access, open, readdir, realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { SPAWN_CWD_MAX_BYTES } from "../../protocol/spawn.js";
import type { DirEntryWire } from "../../protocol/spawn.js";
import { raceDeadline } from "../req-deadline.js";
import type { ReqDeadline } from "../req-deadline.js";
import type { SpawnRegistryPort } from "./ports.js";

// ---------------------------------------------------------------------------
// tunables (arch §4.5 — every number the scan/admit budgets are built from)
// ---------------------------------------------------------------------------

/** Freshness window of the known-directories scan result. */
export const KNOWN_CACHE_MS = 60_000;
/** Hard cap of one full known-directories scan (`min(this, deadline remaining)`). */
export const KNOWN_SCAN_BUDGET_MS = 2_000;
/** Max entries returned / membership-tested (`GET /api/headless/dirs`'s `recent`). */
export const KNOWN_DIR_LIMIT = 50;
/** Session dirs whose newest `.jsonl` is older than this fall out of source ②. */
export const KNOWN_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Head bytes read from a session file to find its first (header) line. */
export const SESSION_HEADER_BYTES = 4 * 1024;
/** Per-call realpath budget inside `admit` (`min(this, deadline remaining)`, arch §4.5 step 2). */
export const ADMIT_REALPATH_BUDGET_MS = 2_000;

// ---------------------------------------------------------------------------
// injectable fs surface
// ---------------------------------------------------------------------------

/** The slice of `fs.Stats` this module needs (structural, so fakes stay trivial). */
export interface DirStat {
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  isDirectory(): boolean;
}

/** All filesystem effects of the dir service, injectable per-method via `deps.fs`. */
export interface DirFs {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<DirStat>;
  access(path: string, mode: number): Promise<void>;
  /** Names of subdirectories of `dir` (non-recursive, plain names — not paths). */
  readdirDirs(dir: string): Promise<string[]>;
  /** Names of regular files directly inside `dir` (plain names — not paths). */
  readdirFiles(dir: string): Promise<string[]>;
  /** Reads up to `bytes` from the file's start, decoded as UTF-8 (header probe). */
  readHead(path: string, bytes: number): Promise<string>;
  /** `pinSync`'s synchronous trio — flags arrive as `O_RDONLY | O_DIRECTORY`. */
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): DirStat;
  closeSync(fd: number): void;
}

/** Real-filesystem defaults; tests wrap/count/delay individual methods on top of this. */
export const defaultDirFs: DirFs = {
  realpath: (path) => realpath(path),
  stat: (path) => stat(path),
  access: (path, mode) => access(path, mode),
  readdirDirs: async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) if (e.isDirectory()) out.push(e.name);
    return out;
  },
  readdirFiles: async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) if (e.isFile()) out.push(e.name);
    return out;
  },
  readHead: async (path, bytes) => {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(bytes);
      const r = await fh.read(buf, 0, bytes, 0);
      return buf.subarray(0, r.bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
  },
  openSync: (path, flags) => openSync(path, flags),
  fstatSync: (fd) => fstatSync(fd),
  closeSync: (fd) => closeSync(fd),
};

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

/** arch §4.5's rejection reasons, in gate order (`empty`…`relative` are step 1's own checks).
 * `"moved"` is session-history plan §4.6.1's session-backed addition: the realpath'd path no
 * longer matches the literal path the caller resolved it from (header cwd became a symlink
 * target, arch §14's gone/moved user ruling). */
export type AdmitRejection =
  "empty" | "nul" | "too-long" | "relative" | "not-found" | "not-dir" | "no-access" | "not-allowed" | "moved";

/** `admit`'s verdict: on success carries the pinned identity fork will re-verify. */
export type AdmitResult =
  { ok: true; realpath: string; dev: number; ino: number; known: boolean } | { ok: false; reason: AdmitRejection };

/**
 * `pinSync`'s verdict: `changed` = a directory still sits at the path but it is a DIFFERENT one
 * (dev/ino mismatch, or the open/fstat path hit something unexpected); `gone` = nothing that can
 * be a directory answers at the path anymore (ENOENT / ENOTDIR).
 */
export type PinResult = { ok: true; fd: number; cwdArg: string } | { ok: false; reason: "changed" | "gone" };

export interface DirServiceDeps {
  home: string;
  /** SP10 passes `process.env.PI_CODING_AGENT_DIR ?? \`${home}/.pi/agent\``; source ② reads `<agentDir>/sessions`. */
  agentDir: string;
  roots: readonly string[];
  registry: Pick<SpawnRegistryPort, "list">;
  /** SP7's store records, projected to just what ordering needs. */
  spawnHistory: () => readonly { cwd: string; updatedAt: number }[];
  now: () => number;
  fs?: Partial<DirFs>;
}

export interface DirService {
  known(deadline: ReqDeadline): Promise<{ entries: readonly DirEntryWire[]; partial: boolean }>;
  /**
   * session-history plan §4.6.1: `opts.sessionBacked` is set by the POST session branch. After
   * step 2 (resolve, verify directory-ness, R|X access, dev/ino capture) a session-backed cwd is
   * NOT required to be in `known`/`roots` membership (the session itself already proves the
   * caller has standing for it) — it only has to still be the literal path the caller resolved
   * (`rp !== expanded` ⇒ `"moved"`, the same gone/moved distinction history rows surface). Omitted
   * `opts` ⇒ the exact pre-feature code path.
   */
  admit(
    raw: string,
    scope: "known" | "roots",
    deadline: ReqDeadline,
    opts?: { sessionBacked?: true },
  ): Promise<AdmitResult>;
  pinSync(admitted: { realpath: string; dev: number; ino: number }): PinResult;
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

function utf8ByteLength(s: string): number {
  return textEncoder.encode(s).length;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errCode(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null && "code" in e && typeof e.code === "string") return e.code;
  return undefined;
}

/** `raceDeadline` rejects with `Error("E_DEADLINE")` — the only timeout signal this module sees. */
function isDeadlineError(e: unknown): boolean {
  return e instanceof Error && e.message === "E_DEADLINE";
}

/** `~` → home, `~/x` → home/x; anything else (incl. `~user`) passes through untouched. */
export function expandTilde(raw: string, home: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return `${home}${raw.slice(1)}`;
  return raw;
}

/**
 * Extracts `cwd` from a session file's head text (source ②): the first line must be complete
 * within the head (a first line longer than the 4 KiB probe means "skip" — we never read
 * further), must be a JSON object, and must carry an absolute `cwd` within the cwd byte cap.
 * `type:"session"` is deliberately NOT required — the contract is "first line carries cwd"
 * (arch §4.5), and staying shape-tolerant keeps future pi header tweaks from silently emptying
 * the recent list.
 */
export function parseSessionHeaderHead(text: string): string | undefined {
  const nl = text.indexOf("\n");
  if (nl < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(0, nl));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const cwd = parsed["cwd"];
  if (typeof cwd !== "string" || cwd === "" || !cwd.startsWith("/")) return undefined;
  if (utf8ByteLength(cwd) > SPAWN_CWD_MAX_BYTES) return undefined;
  return cwd;
}

/**
 * Path-SEGMENT-aligned containment (arch §4.5 step 4: `/home/a` never matches `/home/ab`):
 * a realpath equal to the root, or starting with `root + "/"`, is inside. `/` contains every
 * absolute path; a trailing slash on the root is normalized away first.
 */
export function withinRoot(realRoot: string, path: string): boolean {
  const root = realRoot.length > 1 && realRoot.endsWith("/") ? realRoot.slice(0, -1) : realRoot;
  if (root === "/") return true;
  return root === path || path.startsWith(`${root}/`);
}

// ---------------------------------------------------------------------------
// the service
// ---------------------------------------------------------------------------

export function createDirService(deps: DirServiceDeps): DirService {
  const fs: DirFs = { ...defaultDirFs, ...deps.fs };
  const sessionsRoot = `${deps.agentDir}/sessions`;

  interface ScanState {
    entries: readonly DirEntryWire[];
    knownSet: ReadonlySet<string>;
    partial: boolean;
    at: number;
  }

  let cache: ScanState | undefined;
  let inflight: Promise<ScanState> | undefined;

  /** Cache-if-fresh, single-flight, else scan with `min(KNOWN_SCAN_BUDGET_MS, remaining)`. */
  async function currentScan(deadline: ReqDeadline): Promise<ScanState> {
    if (cache !== undefined && deps.now() - cache.at < KNOWN_CACHE_MS) return cache;
    if (inflight !== undefined) return inflight;
    const budgetMs = Math.max(0, Math.min(KNOWN_SCAN_BUDGET_MS, deadline.remaining()));
    const started = scan(budgetMs);
    inflight = started;
    try {
      const st = await started;
      cache = st;
      return st;
    } finally {
      if (inflight === started) inflight = undefined;
    }
  }

  async function scan(budgetMs: number): Promise<ScanState> {
    const deadlineAt = deps.now() + budgetMs;
    let partial = false;
    const left = (): number => deadlineAt - deps.now();
    const out = (): boolean => left() <= 0;
    const bound = <T>(p: Promise<T>): Promise<T> => raceDeadline(p, Math.max(0, left()));
    const markTimeout = (e: unknown): void => {
      if (isDeadlineError(e)) partial = true;
    };

    const byCwd = new Map<string, number>();
    const bump = (cwd: string, at: number): void => {
      const prev = byCwd.get(cwd);
      if (prev === undefined || at > prev) byCwd.set(cwd, at);
    };

    // Source ① — registry cards (sync; a throwing list() only loses this source).
    try {
      for (const view of deps.registry.list()) bump(view.cwd, view.lastFrameAt);
    } catch {
      /* degrade */
    }

    // Source ③ — spawn history.
    try {
      for (const h of deps.spawnHistory()) bump(h.cwd, h.updatedAt);
    } catch {
      /* degrade */
    }

    // Source ② — session headers: per session dir the newest `.jsonl` (mtime), kept when its
    // mtime is within KNOWN_SESSION_MAX_AGE_MS, its ≤4 KiB head parses to a cwd.
    try {
      const names = await bound(fs.readdirDirs(sessionsRoot));
      for (const name of names) {
        if (out()) {
          partial = true;
          break;
        }
        const dir = `${sessionsRoot}/${name}`;
        try {
          const files = await bound(fs.readdirFiles(dir));
          let newest: { file: string; mtimeMs: number } | undefined;
          for (const f of files) {
            if (!f.endsWith(".jsonl")) continue;
            if (out()) {
              partial = true;
              break;
            }
            try {
              const st = await bound(fs.stat(`${dir}/${f}`));
              if (newest === undefined || st.mtimeMs > newest.mtimeMs) {
                newest = { file: `${dir}/${f}`, mtimeMs: st.mtimeMs };
              }
            } catch {
              /* file raced away — try the next one */
            }
          }
          if (newest === undefined) continue;
          if (deps.now() - newest.mtimeMs > KNOWN_SESSION_MAX_AGE_MS) continue;
          const head = await bound(fs.readHead(newest.file, SESSION_HEADER_BYTES));
          const cwd = parseSessionHeaderHead(head);
          if (cwd !== undefined) bump(cwd, newest.mtimeMs);
        } catch (e) {
          markTimeout(e); // E_DEADLINE ⇒ partial; any fs error ⇒ this session dir only
        }
      }
    } catch (e) {
      markTimeout(e); // sessions root unreadable / budget hit before it could be listed
    }

    // realpath + is-directory filter; ties between cwds that resolve to the same realpath keep
    // the max activity time (dedupe).
    const byRealpath = new Map<string, number>();
    for (const [cwd, at] of byCwd) {
      if (out()) {
        partial = true;
        break;
      }
      try {
        const rp = await bound(fs.realpath(cwd));
        const st = await bound(fs.stat(rp));
        if (!st.isDirectory()) continue;
        const prev = byRealpath.get(rp);
        if (prev === undefined || at > prev) byRealpath.set(rp, at);
      } catch {
        /* gone / unreadable / not a dir — dropped */
      }
    }

    const ranked: DirEntryWire[] = [...byRealpath.entries()].map(([rp, at]) => ({
      cwd: rp,
      label: basename(rp),
      at,
    }));
    ranked.sort((a, b) => b.at - a.at);
    const entries = ranked.slice(0, KNOWN_DIR_LIMIT);
    return { entries, knownSet: new Set(entries.map((e) => e.cwd)), partial, at: deps.now() };
  }

  async function known(deadline: ReqDeadline): Promise<{ entries: readonly DirEntryWire[]; partial: boolean }> {
    const st = await currentScan(deadline);
    return { entries: st.entries, partial: st.partial };
  }

  async function admit(
    raw: string,
    scope: "known" | "roots",
    deadline: ReqDeadline,
    opts?: { sessionBacked?: true },
  ): Promise<AdmitResult> {
    // Step 1 — shape gates (arch §4.5): the wire layer already caps cwd, this re-checks.
    if (raw === "") return { ok: false, reason: "empty" };
    if (raw.includes("\0")) return { ok: false, reason: "nul" };
    if (utf8ByteLength(raw) > SPAWN_CWD_MAX_BYTES) return { ok: false, reason: "too-long" };
    const expanded = expandTilde(raw, deps.home);
    if (!expanded.startsWith("/")) return { ok: false, reason: "relative" };

    const realpathStepMs = (): number => Math.max(0, Math.min(ADMIT_REALPATH_BUDGET_MS, deadline.remaining()));

    // Step 2 — resolve, verify directory-ness and R|X access, capture dev/ino.
    let rp: string;
    try {
      rp = await raceDeadline(fs.realpath(expanded), realpathStepMs());
    } catch {
      return { ok: false, reason: "not-found" }; // gone, dangling symlink — or the budget died
    }
    let st: DirStat;
    try {
      st = await raceDeadline(fs.stat(rp), Math.max(0, deadline.remaining()));
    } catch (e) {
      return { ok: false, reason: errCode(e) === "ENOENT" ? "not-found" : "no-access" };
    }
    if (!st.isDirectory()) return { ok: false, reason: "not-dir" };
    try {
      await raceDeadline(fs.access(rp, constants.R_OK | constants.X_OK), Math.max(0, deadline.remaining()));
    } catch {
      return { ok: false, reason: "no-access" };
    }

    // session-history plan §4.6.1: a session-backed admit skips the known/roots membership scan
    // entirely — the resolved session already proves standing. It only still has to be the exact
    // literal path the caller handed in (a symlinked/moved header cwd ⇒ "moved", never silently
    // followed).
    if (opts?.sessionBacked === true) {
      if (rp !== expanded) return { ok: false, reason: "moved" };
      return { ok: true, realpath: rp, dev: st.dev, ino: st.ino, known: true };
    }

    // Step 3 — known membership (shared cache/scan; a partial scan is fail-closed).
    const scanState = await currentScan(deadline);
    if (scanState.knownSet.has(rp)) return { ok: true, realpath: rp, dev: st.dev, ino: st.ino, known: true };

    // Step 4 — roots (scope "roots" only): each root realpath'd NOW, segment-aligned.
    if (scope === "roots") {
      for (const rootRaw of deps.roots) {
        const rootExpanded = expandTilde(rootRaw, deps.home);
        if (!rootExpanded.startsWith("/") || rootExpanded.includes("\0")) continue;
        let rootRp: string;
        try {
          rootRp = await raceDeadline(fs.realpath(rootExpanded), realpathStepMs());
        } catch {
          continue; // root itself gone/unreadable ⇒ it matches nothing
        }
        if (withinRoot(rootRp, rp)) return { ok: true, realpath: rp, dev: st.dev, ino: st.ino, known: false };
      }
    }
    return { ok: false, reason: "not-allowed" };
  }

  function closeQuiet(fd: number): void {
    try {
      fs.closeSync(fd);
    } catch {
      /* best effort */
    }
  }

  function pinSync(admitted: { realpath: string; dev: number; ino: number }): PinResult {
    let fd: number;
    try {
      fd = fs.openSync(admitted.realpath, constants.O_RDONLY | constants.O_DIRECTORY);
    } catch (e) {
      const code = errCode(e);
      return { ok: false, reason: code === "ENOENT" || code === "ENOTDIR" ? "gone" : "changed" };
    }
    try {
      const st = fs.fstatSync(fd);
      if (st.dev !== admitted.dev || st.ino !== admitted.ino) {
        closeQuiet(fd);
        return { ok: false, reason: "changed" };
      }
      return { ok: true, fd, cwdArg: `/proc/self/fd/${String(fd)}` };
    } catch {
      closeQuiet(fd);
      return { ok: false, reason: "changed" };
    }
  }

  return { known, admit, pinSync };
}
