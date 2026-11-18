/** Tool-only anchored filesystem operations. No inferred paths, reset, unlink or GC.
 * Same-uid trusted maintenance, not openat2 protection against malicious same-uid code.
 * Directory replacement is detected and writes stay on held /proc/self/fd anchors.
 */
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  writeSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fail } from "./audit.js";
export const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export interface Fingerprint {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  sha256: string;
}
export interface CapturedFile {
  name: string;
  bytes: Buffer;
  fingerprint: Fingerprint;
}
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
function directory(st: Stats) {
  if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) fail("unsafe-directory");
}
export function canonical(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) fail("explicit-canonical-path-required");
  // Check every ancestor without following symlinks. Intermediate system/home paths
  // need not be 0700, but must not be writable by unrelated users.
  for (let p = path; ; p = dirname(p)) {
    const st = lstatSync(p);
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      (st.uid !== 0 && st.uid !== process.getuid?.()) ||
      ((st.mode & 0o022) !== 0 && !(st.uid === 0 && (st.mode & 0o1000) !== 0))
    )
      fail("unsafe-path-chain");
    if (p === dirname(p)) break;
  }
  if (realpathSync(path) !== path) fail("unsafe-path-chain");
}
export class HeldDirectory {
  readonly fd: number;
  readonly identity: Stats;
  constructor(readonly path: string) {
    canonical(path);
    this.fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    this.identity = fstatSync(this.fd);
    try {
      this.check();
    } catch (e) {
      closeSync(this.fd);
      throw e;
    }
  }
  at(name: string): string {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || name === "." || name === "..") fail("unsafe-name");
    return `/proc/self/fd/${this.fd}/${name}`;
  }
  check(): void {
    canonical(this.path);
    directory(this.identity);
    const now = lstatSync(this.path);
    directory(now);
    if (!same(this.identity, now) || !same(this.identity, fstatSync(this.fd))) fail("directory-replaced");
  }
  names(): string[] {
    this.check();
    const names = readdirSync(`/proc/self/fd/${this.fd}`).sort();
    if (names.length > 256) fail("directory-capacity");
    return names;
  }
  absent(name: string): boolean {
    this.check();
    try {
      lstatSync(this.at(name));
      return false;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw e;
    }
  }
  read(name: string, max = 65536, links = 1): CapturedFile {
    this.check();
    const fd = openSync(this.at(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (
        !st.isFile() ||
        st.uid !== process.getuid?.() ||
        (st.mode & 0o777) !== 0o600 ||
        st.nlink !== links ||
        !Number.isSafeInteger(st.size) ||
        st.size < 0 ||
        st.size > max
      )
        fail("unsafe-file");
      const bytes = Buffer.alloc(st.size + 1);
      let n = 0;
      while (n < bytes.length) {
        const got = readSync(fd, bytes, n, bytes.length - n, n);
        if (!got) break;
        n += got;
      }
      const after = fstatSync(fd);
      if (
        n !== st.size ||
        !same(st, lstatSync(this.at(name))) ||
        !same(st, after) ||
        st.mtimeMs !== after.mtimeMs ||
        st.ctimeMs !== after.ctimeMs
      )
        fail("file-changed");
      const exact = bytes.subarray(0, n);
      return {
        name,
        bytes: exact,
        fingerprint: {
          dev: st.dev,
          ino: st.ino,
          size: st.size,
          mtimeMs: st.mtimeMs,
          ctimeMs: st.ctimeMs,
          sha256: digest(exact),
        },
      };
    } finally {
      closeSync(fd);
    }
  }
  verify(file: CapturedFile, links = 1): void {
    const now = this.read(file.name, file.bytes.length, links);
    if (JSON.stringify(file.fingerprint) !== JSON.stringify(now.fingerprint) || !file.bytes.equals(now.bytes))
      fail("file-changed");
  }
  create(name: string, bytes: Buffer): CapturedFile {
    this.check();
    const fd = openSync(
      this.at(name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      let written = 0;
      while (written < bytes.length) {
        const n = writeSync(fd, bytes, written, bytes.length - written);
        if (!n) fail("short-write");
        written += n;
      }
      fsyncSync(fd);
      const original = fstatSync(fd),
        captured = this.read(name, bytes.length);
      if (
        original.dev !== captured.fingerprint.dev ||
        original.ino !== captured.fingerprint.ino ||
        !captured.bytes.equals(bytes)
      )
        fail("file-changed");
      this.verify(captured);
      return captured;
    } finally {
      closeSync(fd);
    }
  }
  /** Re-establish durability on retry; parsing a surviving filename is insufficient.
   * Pin read bytes/inodes before and after fsync of the exact reopened file. */
  syncFile(file: CapturedFile, links = 1): void {
    this.verify(file, links);
    const fd = openSync(this.at(file.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (st.dev !== file.fingerprint.dev || st.ino !== file.fingerprint.ino || st.nlink !== links)
        fail("file-changed");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.verify(file, links);
  }
  mkdir(name: string): HeldDirectory {
    this.check();
    mkdirSync(this.at(name), { mode: 0o700 });
    this.check();
    return new HeldDirectory(join(this.path, name));
  }
  sync(): void {
    this.check();
    fsyncSync(this.fd);
    this.check();
  }
  close(): void {
    closeSync(this.fd);
  }
}
export const json = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
export function parse(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return fail("invalid-json");
  }
}
export function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}
