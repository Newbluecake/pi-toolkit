/** Tool-only terminal-domain snapshot. Does NOT seal writers, acquire the singleton,
 * initialize state or read auth. Caller must hold the installation maintenance lease.
 * Held FDs + exact membership/metadata/bytes checks detect trusted-operator races;
 * this is not protection against malicious same-uid writers. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { HeldDirectory, digest, json } from "../terminal-v2-maintenance/files.js";
export const TERMINAL_SOURCE_NAMES = [
  ".terminal-authority-archive-v1",
  ".terminal-initialized-v1",
  "terminal-resource-fence-v1.json",
  "terminal-v1",
] as const;
export interface SourceMetadata {
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}
export interface SourceMember {
  name: string;
  type: "file" | "directory";
}
export interface SourceDirectory {
  path: string;
  type: "directory";
  metadata: SourceMetadata;
  members: SourceMember[];
}
export interface SourceFile {
  path: string;
  type: "file";
  metadata: SourceMetadata;
  sha256: string;
}
export interface TerminalSourceManifest {
  v: 1;
  kind: "terminal-retained-source";
  state: { path: string; dev: number; ino: number; uid: number; mode: number };
  selected: string[];
  directories: SourceDirectory[];
  files: SourceFile[];
}
export interface TerminalSourceSnapshot {
  manifest: TerminalSourceManifest;
  manifestSha256: string;
  files: ReadonlyMap<string, { entry: SourceFile; bytes: Buffer }>;
  verify(): void;
  close(): void;
}
const error = (code: string, path: string): never => {
  throw new Error(`${code}:${path}`);
};
const metadata = (s: Stats): SourceMetadata => ({
  dev: s.dev,
  ino: s.ino,
  uid: s.uid,
  gid: s.gid,
  mode: s.mode,
  nlink: s.nlink,
  size: s.size,
  mtimeMs: s.mtimeMs,
  ctimeMs: s.ctimeMs,
});
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function safeName(name: string): void {
  if (!name || name === "." || name === ".." || /[\0/]/.test(name) || Buffer.byteLength(name) > 255)
    error("E_SOURCE_NAME", name);
}
function names(dir: HeldDirectory, cap: number): string[] {
  dir.check();
  const raw = readdirSync(`/proc/self/fd/${dir.fd}`, { encoding: "buffer" });
  if (raw.length > cap) error("E_SOURCE_CAPACITY", dir.path);
  const result = raw.map((b) => {
    const name = b.toString("utf8");
    if (!Buffer.from(name).equals(b)) error("E_SOURCE_NAME_ENCODING", dir.path);
    safeName(name);
    return name;
  });
  return result.sort();
}
function at(dir: HeldDirectory, name: string) {
  safeName(name);
  return `/proc/self/fd/${dir.fd}/${name}`;
}
function member(dir: HeldDirectory, name: string): SourceMember {
  const s = lstatSync(at(dir, name));
  if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) error("E_SOURCE_SPECIAL", join(dir.path, name));
  return { name, type: s.isDirectory() ? "directory" : "file" };
}
function read(dir: HeldDirectory, name: string, max: number) {
  dir.check();
  const path = at(dir, name),
    before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1) error("E_SOURCE_FILE", path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (
      !equal(metadata(s), metadata(before)) ||
      !s.isFile() ||
      s.uid !== process.getuid?.() ||
      (s.mode & 0o022) !== 0 ||
      s.nlink !== 1 ||
      !Number.isSafeInteger(s.size) ||
      s.size < 0 ||
      s.size > max
    )
      error("E_SOURCE_FILE", join(dir.path, name));
    const b = Buffer.alloc(s.size + 1);
    let n = 0;
    while (n < b.length) {
      const got = readSync(fd, b, n, b.length - n, n);
      if (!got) break;
      n += got;
    }
    if (n !== s.size || !equal(metadata(s), metadata(fstatSync(fd))) || !equal(metadata(s), metadata(lstatSync(path))))
      error("E_SOURCE_CHANGED", join(dir.path, name));
    return { metadata: metadata(s), bytes: b.subarray(0, n) };
  } finally {
    closeSync(fd);
  }
}
export function captureTerminalSource(state: HeldDirectory, guard: () => void): TerminalSourceSnapshot {
  const held: HeldDirectory[] = [],
    directories: SourceDirectory[] = [];
  const files = new Map<string, { entry: SourceFile; bytes: Buffer; dir: HeldDirectory; name: string }>();
  let bytes = 0,
    closed = false;
  const check = () => {
    if (closed) error("E_SOURCE_CLOSED", state.path);
    guard();
    state.check();
  };
  // Only the terminal subset of the parent listing is pinned: unrelated auth changes
  // are neither inspected nor claimed as part of a whole-state consistent snapshot.
  const selectedNow = () => names(state, 4096).filter((n) => (TERMINAL_SOURCE_NAMES as readonly string[]).includes(n));
  const selected = selectedNow();
  const visit = (parent: HeldDirectory, name: string, relative: string, depth: number) => {
    check();
    if (depth > 8) error("E_SOURCE_CAPACITY", relative);
    const item = member(parent, name);
    if (item.type === "directory") {
      if (held.length >= 128) error("E_SOURCE_CAPACITY", relative);
      const dir = new HeldDirectory(join(parent.path, name));
      held.push(dir);
      const members = names(dir, 512).map((n) => member(dir, n));
      directories.push({ path: relative, type: "directory", metadata: metadata(fstatSync(dir.fd)), members });
      for (const child of members) visit(dir, child.name, `${relative}/${child.name}`, depth + 1);
    } else {
      if (files.size >= 512) error("E_SOURCE_CAPACITY", relative);
      const captured = read(parent, name, 16 * 1024 * 1024 - bytes);
      bytes += captured.bytes.length;
      const entry: SourceFile = {
        path: relative,
        type: "file",
        metadata: captured.metadata,
        sha256: digest(captured.bytes),
      };
      files.set(relative, { entry, bytes: captured.bytes, dir: parent, name });
    }
    check();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    for (const dir of held.reverse()) dir.close();
  };
  try {
    for (const name of selected) visit(state, name, name, 1);
    const s = state.identity;
    const manifest: TerminalSourceManifest = {
      v: 1,
      kind: "terminal-retained-source",
      state: { path: state.path, dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode },
      selected,
      directories: directories.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      files: [...files.values()].map((f) => f.entry).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    };
    const manifestSha256 = digest(json(manifest));
    const verify = () => {
      check();
      if (digest(json(manifest)) !== manifestSha256) error("E_SOURCE_MANIFEST_CHANGED", state.path);
      if (!equal(selected, selectedNow())) error("E_SOURCE_CHANGED", state.path);
      for (const entry of directories) {
        check();
        const dir = held.find((d) => d.path === join(state.path, entry.path))!;
        dir.check();
        if (
          !equal(entry.metadata, metadata(fstatSync(dir.fd))) ||
          !equal(
            entry.members,
            names(dir, 512).map((n) => member(dir, n)),
          )
        )
          error("E_SOURCE_CHANGED", entry.path);
      }
      for (const f of files.values()) {
        check();
        const now = read(f.dir, f.name, f.bytes.length);
        if (!equal(f.entry.metadata, now.metadata) || !f.bytes.equals(now.bytes))
          error("E_SOURCE_CHANGED", f.entry.path);
      }
      check();
    };
    verify();
    return { manifest, manifestSha256, files, verify, close };
  } catch (e) {
    close();
    throw e;
  }
}
