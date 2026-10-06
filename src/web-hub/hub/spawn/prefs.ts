/**
 * web-hub-spawn default-model plan §3.1/§D1: the hub-wide 「新建会话默认模型」 preference —
 * ONE global single value in `<stateDir>/spawn-prefs.json` (`{"v":1,"defaultModel":string|null}`).
 *
 * Why global (explicit security decision D1, user ruling U1): every authenticated principal that
 * can reach `/api/headless*` is equally trusted with it — the sole LAN user is behind password
 * auth, and the same person's phone (LAN) + desktop (loopback) expect ONE shared value. Every
 * write is audited with `{principal, listener, ip, from, to}` by the routes; `lan:"off"` keeps the
 * whole surface 404 for LAN principals (the routes' own guard, no new code path here). If real
 * multi-user LAN ever appears, this decision must be reopened — not this release.
 *
 * Persistence discipline (§3.1, deliberately simpler than spawns.json — a single-value small
 * file): every `set()` is a full overwrite through a random `wx` (O_EXCL) tmp + `rename`, so the
 * disk only ever holds the OLD or the NEW value; no debounce, no timers, no generation, no
 * unhealthy state. A crash mid-write leaves a tmp residue the next load cleans (regular files
 * only); a crash after rename but before the 200 means the new value is on disk and the client
 * re-GETs it. No fsync — same rationale as `store.ts` (page cache survives the process; power
 * loss at worst reverts to the previous preference). Load failures NEVER mutate the file.
 *
 * Adversarial read shape (mirrors store.ts's discipline): non-regular (symlink/dir/FIFO),
 * foreign-uid, or >4 KiB files read as `null` with one warn and stay untouched; the content is
 * read through `open(O_RDONLY|O_NOFOLLOW)` so a TOCTOU symlink swap between lstat and read fails
 * closed; JSON/`v`/`parseSpawnModelRef` violations read as `null` (no corrupt-rename — the next
 * successful set overwrites); a mode ≠ 0600 warns and gets a best-effort chmod back to 0600.
 *
 * Failure semantics of `set()`: any throw ⇒ best-effort tmp unlink, memory UNCHANGED, the caller
 * (routes) audits the code and answers 503 `E_LAUNCHER{reason:"persist"}`. Success flips memory
 * only after the post-rename mode re-check passed.
 *
 * Zero-`as` module (`hub/spawn/**` contract, `tests/web-hub/hub/spawn/source-scan.test.ts`).
 */
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname } from "node:path";
import { parseSpawnModelRef } from "../../protocol/spawn.js";
import type { HubLog } from "../ports.js";

/** On-disk envelope version; any other `v` reads as null. */
export const SPAWN_PREFS_FILE_VERSION = 1;
/** Read cap for the prefs file (§3.1: >4 KiB ⇒ null + warn, untouched). */
export const SPAWN_PREFS_READ_MAX_BYTES = 4096;
/** The only acceptable final mode for the prefs file (and its tmp). */
export const SPAWN_PREFS_MODE = 0o600;

/** The hub-side preference surface the routes consume. */
export interface SpawnPrefs {
  /** The loaded/last-set value; `null` ⇒ no preference (fork WITHOUT `--model`). Sync, pure. */
  get(): string | null;
  /**
   * Full overwrite. `null` clears. Returns `{ok:false, code}` on any fs failure — memory is
   * unchanged then; the caller audits `code` and answers 503.
   */
  set(value: string | null): { ok: true } | { ok: false; code: string };
  /** Nothing to do — no pending writes, no timers (§3.1). */
  close(): void;
}

/** Injectable sync fs surface (same pattern as `store.ts`'s `SyncFs`; tests inject failures). */
export interface PrefsFs {
  readdirSync(path: string): string[];
  lstatSync(path: string): { isFile(): boolean; size: number; uid: number; mode: number };
  unlinkSync(path: string): void;
  openSync(path: string, flags: number, mode?: number): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number): number;
  writeSync(fd: number, data: string): number;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  chmodSync(path: string, mode: number): void;
}

const REAL_PREFS_FS: PrefsFs = {
  readdirSync: (p) => readdirSync(p),
  lstatSync: (p) => lstatSync(p),
  unlinkSync: (p) => unlinkSync(p),
  openSync: (p, flags, mode) => openSync(p, flags, mode),
  readSync: (fd, buf, off, len) => readSync(fd, buf, off, len, null),
  writeSync: (fd, data) => writeSync(fd, data),
  closeSync: (fd) => closeSync(fd),
  renameSync: (f, t) => renameSync(f, t),
  chmodSync: (p, mode) => chmodSync(p, mode),
};

export interface SpawnPrefsDeps {
  /** Path of `spawn-prefs.json` (`webHubSpawnFiles(stateDir).prefsJson`). */
  file: string;
  log: HubLog;
  /** Partial override on top of the real sync fs (tests inject ENOSPC / wx collisions). */
  fs?: Partial<PrefsFs>;
  /** Default: process.getuid. */
  getuid?: () => number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errCode(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" && err.code.length > 0) {
    return err.code;
  }
  return "E_IO";
}

export function createSpawnPrefs(deps: SpawnPrefsDeps): SpawnPrefs {
  const fs: PrefsFs = { ...REAL_PREFS_FS, ...deps.fs };
  const file = deps.file;
  const dir = dirname(file);
  const base = basename(file);
  const log = deps.log;
  const getuidFn = deps.getuid ?? (() => process.getuid?.() ?? 0);
  let warned = false; // load-time anomalies warn once per instance (§3.1 「warn 一次」)

  function warnOnce(detail: string, extra?: Record<string, unknown>): void {
    if (warned) return;
    warned = true;
    log.warn("spawn prefs: ignoring unreadable preference file", { file, detail, ...extra });
  }

  function bestEffortUnlink(path: string): void {
    try {
      fs.unlinkSync(path);
    } catch {
      /* already gone / unwritable dir — the next load retries the cleanup */
    }
  }

  /** §3.1 load step 1: sweep `<file>.tmp-*` residue from an interrupted set — REGULAR files
   *  only (a non-regular residue is foreign and never unlinked by us). */
  function cleanupTmpResidue(): void {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return; // state dir missing — nothing to sweep
    }
    const prefix = `${base}.tmp-`;
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const path = `${dir}/${name}`;
      try {
        if (fs.lstatSync(path).isFile()) bestEffortUnlink(path);
      } catch {
        /* unreadable residue — leave it */
      }
    }
  }

  function readFileBounded(fd: number, size: number): string {
    const cap = Math.min(size, SPAWN_PREFS_READ_MAX_BYTES);
    const buf = Buffer.alloc(cap);
    let off = 0;
    while (off < cap) {
      const n = fs.readSync(fd, buf, off, cap - off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  }

  function parse(raw: string): string | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnOnce("bad-json");
      return null;
    }
    if (!isObj(parsed) || parsed["v"] !== SPAWN_PREFS_FILE_VERSION) {
      warnOnce("bad-envelope");
      return null;
    }
    const dm = parsed["defaultModel"];
    if (dm === null) return null;
    if (typeof dm !== "string" || parseSpawnModelRef(dm) === null) {
      warnOnce("bad-default-model");
      return null;
    }
    return dm;
  }

  // ---------------------------------------------------------------- load (once, sync, at construction)

  cleanupTmpResidue();
  let current: string | null = null;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) {
      warnOnce("not-regular");
    } else if (st.uid !== getuidFn()) {
      warnOnce("foreign-uid");
    } else if (st.size > SPAWN_PREFS_READ_MAX_BYTES) {
      warnOnce("over-cap", { size: st.size });
    } else {
      // O_NOFOLLOW: a symlink swapped in between the lstat above and this open fails closed.
      const fd = fs.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        current = parse(readFileBounded(fd, st.size));
      } finally {
        fs.closeSync(fd);
      }
      if ((st.mode & 0o777) !== SPAWN_PREFS_MODE) {
        log.warn("spawn prefs: mode not 0600, fixing", { file });
        try {
          fs.chmodSync(file, SPAWN_PREFS_MODE);
        } catch (err) {
          log.warn("spawn prefs: chmod back to 0600 failed", { file, code: errCode(err) });
        }
      }
    }
  } catch (err) {
    // ENOENT (fresh state dir — the normal first boot) stays silent; anything else warns once.
    if (errCode(err) !== "ENOENT") warnOnce("lstat-failed", { code: errCode(err) });
  }

  // ---------------------------------------------------------------- set / surface

  function set(value: string | null): { ok: true } | { ok: false; code: string } {
    const json = JSON.stringify({ v: SPAWN_PREFS_FILE_VERSION, defaultModel: value });
    const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
    try {
      // `wx` (O_CREAT|O_EXCL, no-follow): never clobber an existing file, never write through a
      // pre-planted symlink — the random suffix makes collisions pathological anyway.
      const fd = fs.openSync(
        tmp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        SPAWN_PREFS_MODE,
      );
      try {
        fs.writeSync(fd, json);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
      // post-rename re-check: regular + 0600 (else chmod + one more look; still wrong ⇒ failure)
      const st = fs.lstatSync(file);
      if (!st.isFile() || (st.mode & 0o777) !== SPAWN_PREFS_MODE) {
        fs.chmodSync(file, SPAWN_PREFS_MODE);
        const re = fs.lstatSync(file);
        if (!re.isFile() || (re.mode & 0o777) !== SPAWN_PREFS_MODE) {
          throw new Error("mode re-check failed");
        }
      }
    } catch (err) {
      bestEffortUnlink(tmp);
      const code = errCode(err);
      log.error("spawn prefs: persist failed", { file, code });
      return { ok: false, code }; // memory unchanged — callers keep serving the old value
    }
    current = value;
    return { ok: true };
  }

  return {
    get: () => current,
    set,
    close() {
      /* no pending writes, no timers (§3.1) */
    },
  };
}
