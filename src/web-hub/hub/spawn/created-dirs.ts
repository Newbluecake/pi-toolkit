/**
 * created-dirs plan r2 §1: source ④'s synchronous, single-writer store. Loading never writes
 * the envelope; every add commits a bounded UTF-8 buffer through an exclusive 0600 tmp + rename.
 * Nonblocking/no-follow open followed by FD validation (not a path pre-check) rejects swapped
 * FIFOs/devices without blocking. Pre-rename failures leave disk and memory unchanged. If the
 * post-rename check fails, memory stays unchanged but disk may be ahead (fail closed, same
 * contract as prefs.ts; r2 author clarification). No timers, pi imports, or type assertions.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { SPAWN_CWD_MAX_BYTES } from "../../protocol/spawn.js";
import type { HubLog } from "../ports.js";

export const CREATED_DIRS_MAX = 50;
export const CREATED_DIRS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CREATED_DIRS_FILE_MAX_BYTES = 256 * 1024;

export interface CreatedDirRecord {
  path: string;
  dev: number;
  ino: number;
  createdAt: number;
  /** Provenance only — never used for authorization. */
  by: { listener: "loopback" | "lan"; user?: string };
}

export interface CreatedDirsStore {
  list(): readonly CreatedDirRecord[];
  add(
    rec: { path: string; dev: number; ino: number },
    by: CreatedDirRecord["by"],
  ): { ok: true } | { ok: false; code: string };
}

interface CreatedDirsStat {
  size: number;
  uid: number;
  mode: number;
  isFile(): boolean;
}

export interface CreatedDirsFs {
  readdirSync(path: string): string[];
  lstatSync(path: string): CreatedDirsStat;
  fstatSync(fd: number): CreatedDirsStat;
  fchmodSync(fd: number, mode: number): void;
  mkdirSync(path: string, opts: { recursive: true; mode: number }): void;
  openSync(path: string, flags: number, mode?: number): number;
  readSync(fd: number, buf: Buffer, offset: number, length: number): number;
  writeSync(fd: number, buf: Buffer, offset: number, length: number): number;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
}

const REAL_FS: CreatedDirsFs = {
  readdirSync: (p) => readdirSync(p),
  lstatSync: (p) => lstatSync(p),
  fstatSync: (fd) => fstatSync(fd),
  fchmodSync: (fd, mode) => fchmodSync(fd, mode),
  mkdirSync: (p, opts) => {
    mkdirSync(p, opts);
  },
  openSync: (p, flags, mode) => openSync(p, flags, mode),
  readSync: (fd, buf, off, len) => readSync(fd, buf, off, len, null),
  writeSync: (fd, buf, off, len) => writeSync(fd, buf, off, len, null),
  closeSync: (fd) => closeSync(fd),
  renameSync: (from, to) => renameSync(from, to),
  unlinkSync: (p) => unlinkSync(p),
};

export interface CreatedDirsStoreDeps {
  file: string;
  log: HubLog;
  now(): number;
  fs?: Partial<CreatedDirsFs>;
  getuid?: () => number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errCode(err: unknown): string {
  if (isObj(err) && typeof err["code"] === "string") return err["code"];
  return "E_IO";
}

function validIdentity(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

function parseRecord(v: unknown, now: number): CreatedDirRecord | undefined {
  if (!isObj(v)) return undefined;
  const { path, dev, ino, createdAt, by } = v;
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.includes("\0") ||
    Buffer.byteLength(path) > SPAWN_CWD_MAX_BYTES ||
    !validIdentity(dev) ||
    !validIdentity(ino) ||
    typeof createdAt !== "number" ||
    !Number.isFinite(createdAt) ||
    createdAt > now + 5 * 60_000 ||
    !isObj(by) ||
    (by["listener"] !== "loopback" && by["listener"] !== "lan") ||
    (by["user"] !== undefined && typeof by["user"] !== "string")
  )
    return undefined;
  return {
    path,
    dev,
    ino,
    createdAt,
    by: {
      listener: by["listener"],
      ...(by["user"] === undefined ? {} : { user: by["user"] }),
    },
  };
}

function trim(entries: readonly CreatedDirRecord[], now: number): CreatedDirRecord[] {
  const newest = new Map<string, CreatedDirRecord>();
  for (const rec of entries) {
    if (now >= rec.createdAt + CREATED_DIRS_TTL_MS) continue;
    const prev = newest.get(rec.path);
    if (prev === undefined || prev.createdAt < rec.createdAt) newest.set(rec.path, rec);
  }
  return [...newest.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, CREATED_DIRS_MAX);
}

export function createCreatedDirsStore(deps: CreatedDirsStoreDeps): CreatedDirsStore {
  const fs: CreatedDirsFs = { ...REAL_FS, ...deps.fs };
  const file = deps.file;
  const dir = dirname(file);
  const uid = deps.getuid ?? (() => process.getuid?.() ?? 0);
  let current: CreatedDirRecord[] = [];
  let warned = false;
  const warn = (detail: string): void => {
    if (warned) return;
    warned = true;
    deps.log.warn("spawn created dirs: load anomaly", { file, detail });
  };
  const unlinkQuiet = (p: string): void => {
    try {
      fs.unlinkSync(p);
    } catch {
      /* best effort */
    }
  };

  // Only our regular tmp residues are ours to remove. No pre-check of the envelope path.
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(`${basename(file)}.tmp-`)) continue;
      const p = `${dir}/${name}`;
      try {
        if (fs.lstatSync(p).isFile()) unlinkQuiet(p);
      } catch {
        /* leave foreign residue */
      }
    }
  } catch {
    /* fresh/missing state dir */
  }

  try {
    const fd = fs.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.uid !== uid() || st.size > CREATED_DIRS_FILE_MAX_BYTES) {
        warn("not-regular/foreign-uid/over-cap");
      } else {
        if ((st.mode & 0o777) !== 0o600) {
          warn("mode-not-0600");
          try {
            fs.fchmodSync(fd, 0o600);
          } catch {
            /* best effort, same fd only */
          }
        }
        // Read through cap+1, even if the file grew after fstat or fstat reported size zero.
        const buf = Buffer.alloc(CREATED_DIRS_FILE_MAX_BYTES + 1);
        let off = 0;
        while (off < buf.length) {
          const n = fs.readSync(fd, buf, off, buf.length - off);
          if (n <= 0) break;
          off += n;
        }
        if (off > CREATED_DIRS_FILE_MAX_BYTES) {
          warn("over-cap");
        } else {
          const parsed: unknown = JSON.parse(buf.subarray(0, off).toString("utf8"));
          if (!isObj(parsed) || parsed["v"] !== 1 || !Array.isArray(parsed["entries"])) {
            warn("bad-envelope");
          } else {
            const now = deps.now();
            const entries: CreatedDirRecord[] = [];
            for (const value of parsed["entries"]) {
              const rec = parseRecord(value, now);
              if (rec !== undefined) entries.push(rec);
            }
            current = trim(entries, now);
          }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if (errCode(err) !== "ENOENT") warn(errCode(err));
  }

  return {
    list: () => trim(current, deps.now()).map((rec) => ({ ...rec, by: { ...rec.by } })),
    add(rec, by) {
      const now = deps.now();
      const added = parseRecord({ ...rec, by, createdAt: now }, now);
      if (added === undefined) return { ok: false, code: "E_INVALID" };
      // A valid loaded timestamp can be up to five minutes in the future. Always keep this
      // add, even when those entries sort ahead of it; replacing a path wins unconditionally.
      const others = trim(
        current.filter((r) => r.path !== added.path),
        now,
      ).slice(0, CREATED_DIRS_MAX - 1);
      const next = [added, ...others];
      const serialize = (): Buffer =>
        Buffer.from(
          JSON.stringify({
            v: 1,
            entries: [...next].sort((a, b) => b.createdAt - a.createdAt),
          }),
        );
      let buf = serialize();
      while (buf.length > CREATED_DIRS_FILE_MAX_BYTES && next.length > 1) {
        next.pop();
        buf = serialize();
      }
      if (buf.length > CREATED_DIRS_FILE_MAX_BYTES) return { ok: false, code: "E_TOO_LARGE" };
      const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
      let ownedTmp = false;
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const fd = fs.openSync(
          tmp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        ownedTmp = true;
        try {
          // Explicit fd chmod also handles a process umask stricter than 077.
          fs.fchmodSync(fd, 0o600);
          let off = 0;
          while (off < buf.length) {
            const n = fs.writeSync(fd, buf, off, buf.length - off);
            if (n <= 0) throw Object.assign(new Error("short write"), { code: "E_SHORT_WRITE" });
            off += n;
          }
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
        const st = fs.lstatSync(file);
        if (!st.isFile() || (st.mode & 0o777) !== 0o600)
          throw Object.assign(new Error("mode re-check"), { code: "E_MODE" });
      } catch (err) {
        if (ownedTmp) unlinkQuiet(tmp);
        return { ok: false, code: errCode(err) };
      }
      current = next;
      return { ok: true };
    },
  };
}
