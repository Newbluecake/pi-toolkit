import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  birthOf,
  closeQuiet,
  createDarwinPathBackend,
  darwinPathBackend,
  darwinSnapshotEqual,
  fdPath,
  linuxPathBackend,
  lstatAt,
  openDirAt,
  openDirPath,
  openStoreRoot,
  readFileAt,
  resolveStoreRoot,
  SchedFsError,
  type PathBackend,
} from "../../../src/schedule/core/paths.js";
import {
  atomicWriteAt,
  ensureStoreRoot,
  gcSessionReports,
  openSessionStore,
  recycleSessionDir,
  writeReportLocked,
} from "../../../src/schedule/core/writer.js";
import { listSessionDirs } from "../../../src/schedule/core/reader.js";
import { CLOSE_MANIFEST } from "./fdpath-manifest.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});

const key = Symbol.for("pi-subagent:sched-fd-paths:v1");
const registry = () => (globalThis as any)[key] as { map: Map<number, any>; lastSweepAt: number } | undefined;
const size = () => registry()?.map.size ?? 0;
const dirs: string[] = [];
const fds: number[] = [];
function temp() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "sched-paths-")));
  dirs.push(d);
  return d;
}
function opened(path: string, backend: PathBackend) {
  const d = openDirPath(path, { backend });
  fds.push(d.fd);
  return d.fd;
}
function reason(fn: () => unknown, expected: string) {
  try {
    fn();
    throw new Error("expected refusal");
  } catch (e) {
    expect(e).toBeInstanceOf(SchedFsError);
    expect((e as SchedFsError).reason).toBe(expected);
  }
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const fd of fds.splice(0)) closeQuiet(fd);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.each([linuxPathBackend, darwinPathBackend])("$platform path backend", (backend) => {
  const test = it.skipIf(!backend.available());
  test("reason alignment: missing, symlink, owner, mode, not-dir, not-file, too-large, bad-name", () => {
    const d = temp();
    const fd = opened(d, backend);
    writeFileSync(join(d, "file"), "abc", { mode: 0o600 });
    mkdirSync(join(d, "child"), { mode: 0o700 });
    symlinkSync(join(d, "child"), join(d, "alias"));
    reason(() => openDirAt(fd, "missing"), "missing");
    reason(() => openDirAt(fd, "alias"), "symlink");
    reason(() => openDirAt(fd, "file"), "not-dir");
    reason(() => readFileAt(fd, "child", 100), "not-file");
    reason(() => readFileAt(fd, "file", 1), "too-large");
    reason(() => readFileAt(fd, "file", 100, { uid: fstatSync(fd).uid + 1 }), "owner");
    chmodSync(join(d, "child"), 0o777);
    reason(() => openDirAt(fd, "child"), "mode");
    reason(() => openDirAt(fd, "../x"), "bad-name");
    const fifo = spawnSync("mkfifo", [join(d, "pipe")]);
    expect(fifo.status).toBe(0);
    reason(() => readFileAt(fd, "pipe", 100), "not-file");
    expect(readFileAt(fd, "file", 100).bytes.toString()).toBe("abc");
    vi.mocked(fs.readSync).mockImplementationOnce((() => {
      writeFileSync(join(d, "file"), "");
      return 0;
    }) as typeof fs.readSync);
    reason(() => readFileAt(fd, "file", 100), "io");
  });
  test("intentional difference: Darwin refuses intermediate symlinks that Linux lstatAt follows", () => {
    const d = temp(),
      outside = temp();
    writeFileSync(join(outside, "x"), "outside");
    symlinkSync(outside, join(d, "link"));
    const fd = opened(d, backend);
    if (backend.platform === "darwin") reason(() => backend.lstatAt(fd, "link/x"), "symlink");
    else expect(backend.lstatAt(fd, "link/x").isFile()).toBe(true);
    expect(readdirSync(outside)).toEqual(["x"]);
  });
  test("vault literal and canonical routes reject before creation; dev/ino pins reject replacement", () => {
    const d = temp();
    const path = join(d, "root");
    mkdirSync(path, { mode: 0o700 });
    symlinkSync(path, join(d, "alias"));
    reason(() => resolveStoreRoot(join(d, "alias"), { backend, inVault: (p) => p === join(d, "alias") }), "vault");
    reason(
      () => ensureStoreRoot(join(d, "alias", "new"), { backend, inVault: (p) => p === join(path, "new") }),
      "vault",
    );
    expect(existsSync(join(path, "new"))).toBe(false);
    const root = resolveStoreRoot(path, { backend });
    renameSync(path, path + "-old");
    mkdirSync(path, { mode: 0o700 });
    reason(() => openStoreRoot(root), "moved");
  });
  test("ancestor replaced by symlink is moved", () => {
    const d = temp();
    mkdirSync(join(d, "ancestor"), { mode: 0o700 });
    mkdirSync(join(d, "ancestor", "root"), { mode: 0o700 });
    const root = resolveStoreRoot(join(d, "ancestor", "root"), { backend });
    renameSync(join(d, "ancestor"), join(d, "old"));
    symlinkSync(join(d, "old"), join(d, "ancestor"));
    reason(() => openStoreRoot(root), "moved");
  });
  test("all fdPath sites: transaction/report allocation/atomic write/GC/repair/recycle/list", async () => {
    const d = temp();
    const root = ensureStoreRoot(join(d, "store"), { backend });
    const store = openSessionStore({
      root,
      sessionId: "paths-test",
      self: { pid: process.pid, start: 1, host: "fixture", boot: "fixture" },
      epoch: "test",
      acquire: () => "held",
    });
    expect(await store.transact(() => ({ value: 7, write: true }))).toMatchObject({ ok: true, value: 7 });
    expect(
      await writeReportLocked(store, {
        reportFile: "reports/" + "a".repeat(64) + ".md",
        allocateUnique: true,
        data: Buffer.from("report"),
        now: Date.now(),
      }),
    ).toMatchObject({ ok: true, value: { written: true } });
    expect(await gcSessionReports(store, Date.now())).toMatchObject({ ok: true });
    expect(listSessionDirs(root)).toMatchObject({ kind: "ok", dirs: ["paths-test"] });
    store.withDir((fd) => atomicWriteAt(fd, "state.json", Buffer.from("broken")));
    expect(await store.repair()).toMatchObject({ ok: true });
    expect(await recycleSessionDir(store, Date.now() + 3 * 86_400_000)).toMatchObject({
      ok: true,
      value: { recycled: true },
    });
  });
});

describe("Darwin snapshots and registry", () => {
  it.each(["auto", "off"] as const)(
    "D1/D3 %s: completed replacements invalidate and unregister; intermediate links refused",
    (birthtime) => {
      const d = temp();
      mkdirSync(join(d, "reports"), { mode: 0o700 });
      const outside = temp();
      const backend = createDarwinPathBackend({ birthtime });
      const fd = opened(d, backend);
      const base = size();
      symlinkSync(outside, join(d, "link"));
      reason(() => backend.lstatAt(fd, "link/x"), "symlink");
      expect(readdirSync(outside)).toEqual([]);
      expect(size()).toBe(base);
      expect(() => backend.lstatAt(fd, "absent/x")).toThrow(expect.objectContaining({ code: "ENOENT" }));
      const rep = openDirAt(fd, "reports");
      fds.push(rep.fd);
      renameSync(join(d, "reports"), join(d, "old"));
      mkdirSync(join(d, "reports"), { mode: 0o700 });
      reason(() => backend.path(rep.fd, "x"), "moved");
      expect(registry()?.map.has(rep.fd)).toBe(false);
      reason(() => backend.path(rep.fd, "x"), "io");
      let armed = true;
      const hooked = createDarwinPathBackend({
        birthtime,
        hooks: {
          beforeVerify(point) {
            if (point === "path" && armed) {
              armed = false;
              renameSync(d, d + "-old");
              dirs.push(d + "-old");
              mkdirSync(d, { mode: 0o700 });
            }
          },
        },
      });
      reason(() => hooked.path(fd), "moved");
      expect(registry()?.map.has(fd)).toBe(false);
      reason(() => hooked.path(fd), "io");
    },
  );
  it("D2 UNCOVERED WINDOW U1 (documented, not guaranteed): next verification refuses", () => {
    const d = temp();
    const fd = opened(d, darwinPathBackend);
    let armed = true;
    const backend = createDarwinPathBackend({
      hooks: {
        afterVerify(point) {
          if (point === "path" && armed) {
            armed = false;
            renameSync(d, d + "-old");
            dirs.push(d + "-old");
            mkdirSync(d, { mode: 0o700 });
          }
        },
      },
    });
    backend.path(fd); // No guarantee about a pathname syscall in this window.
    reason(() => backend.path(fd), "moved");
    expect(registry()?.map.has(fd)).toBe(false);
  });
  it("rejects multi-segment path; lstatAt closes every intermediate fd over 4096 iterations", () => {
    const d = temp();
    mkdirSync(join(d, "reports"), { mode: 0o700 });
    writeFileSync(join(d, "reports", "x"), "x");
    const fd = opened(d, darwinPathBackend);
    const base = size();
    reason(() => darwinPathBackend.path(fd, "reports/x"), "bad-name");
    for (let i = 0; i < 4096; i++) expect(lstatAt(fd, "reports/x").isFile()).toBe(true);
    expect(size()).toBe(base);
    for (const rel of ["", "../x", "a//x", "a/".repeat(9) + "x"])
      reason(() => darwinPathBackend.lstatAt(fd, rel), "bad-name");
    reason(() => darwinPathBackend.lstatAt(fd, "reports/x/no"), "not-dir");
    expect(size()).toBe(base);
  });
  it("lstatAt failures and confirm failures leave fd counts and registry unchanged", () => {
    const d = temp();
    mkdirSync(join(d, "one"), { mode: 0o700 });
    mkdirSync(join(d, "one", "two"), { mode: 0o700 });
    const fd = opened(d, darwinPathBackend);
    const base = size();
    const count = () => readdirSync(existsSync("/proc/self/fd") ? "/proc/self/fd" : "/dev/fd").length;
    const descriptors = count();
    symlinkSync(temp(), join(d, "one", "link"));
    for (const rel of ["one/missing/x", "one/link/x", "one/two/missing"]) {
      expect(() => lstatAt(fd, rel)).toThrow(
        rel.includes("link")
          ? expect.objectContaining({ reason: "symlink" })
          : expect.objectContaining({ code: "ENOENT" }),
      );
      expect(size()).toBe(base);
      expect(count()).toBe(descriptors);
    }
    chmodSync(join(d, "one", "two"), 0o777);
    reason(() => lstatAt(fd, "one/two/x"), "mode");
    expect(size()).toBe(base);
    expect(count()).toBe(descriptors);
    chmodSync(join(d, "one", "two"), 0o700);
    reason(() => lstatAt(fd, "one/x", { uid: fstatSync(fd).uid + 1 }), "owner");
    expect(size()).toBe(base);
    const bad = createDarwinPathBackend({
      hooks: {
        beforeVerify(point) {
          if (point === "confirm-post") throw new SchedFsError("moved", "injected");
        },
      },
    });
    reason(() => openDirPath(d, { backend: bad }), "moved");
    expect(size()).toBe(base);
    expect(count()).toBe(descriptors);
  });
  it("registry: 10000 opens/closes, direct close and fd reuse cannot route stale paths", () => {
    const d = temp();
    const base = size();
    for (let i = 0; i < 10000; i++) closeQuiet(openDirPath(d, { backend: darwinPathBackend }).fd);
    expect(size()).toBe(base);
    const old = openDirPath(d, { backend: darwinPathBackend }).fd;
    closeSync(old);
    writeFileSync(join(d, "file"), "new object");
    const reused = openSync(join(d, "file"), constants.O_RDONLY);
    fds.push(reused);
    expect(reused).toBe(old);
    reason(() => fdPath(reused), "moved");
    expect(registry()?.map.has(reused)).toBe(false);
    reason(() => darwinPathBackend.path(reused), "io");
  });
  it("registry: capacity fail closed, TTL sweep, closeQuiet, reload shared pure records", async () => {
    const d = temp();
    let clock = 0;
    const backend = createDarwinPathBackend({ capacity: size() + 2, ttlMs: 10, now: () => clock });
    const a = opened(d, backend),
      b = opened(d, backend);
    const base = size();
    reason(() => openDirPath(d, { backend }), "io");
    expect(size()).toBe(base);
    expect(backend.path(a)).toBe(d);
    clock = 60_001;
    const c = opened(d, backend);
    expect(registry()?.map.has(a)).toBe(false);
    reason(() => backend.path(a), "io");
    closeQuiet(b);
    closeQuiet(c);
    const shared = opened(d, darwinPathBackend);
    vi.resetModules();
    const fresh = await import("../../../src/schedule/core/paths.js");
    expect(fresh.fdPath(shared)).toBe(d);
    fresh.closeQuiet(shared);
    expect(registry()?.map.has(shared)).toBe(false);
  });
  it.each([0, NaN, -1, 10, 11])("birthOf normalizes untrusted %s", (birthtimeMs) => {
    expect(birthOf({ birthtimeMs, ctimeMs: 10 })).toBe(null);
  });
  it("birthOf and snapshot comparison preserve asymmetric fallback", () => {
    expect(birthOf({ birthtimeMs: 2, ctimeMs: 10 })).toBe(2);
    for (const [a, b, equal] of [
      [null, null, true],
      [null, 2, true],
      [2, null, false],
      [2, 2, true],
      [2, 3, false],
    ] as const)
      expect(darwinSnapshotEqual({ dev: 1, ino: 2, bt: a }, { dev: 1, ino: 2, bt: b })).toBe(equal);
    expect(darwinSnapshotEqual({ dev: 1, ino: 2, bt: null }, { dev: 2, ino: 2, bt: null })).toBe(false);
    expect(darwinSnapshotEqual({ dev: 1, ino: 2, bt: null }, { dev: 1, ino: 3, bt: null })).toBe(false);
  });
  it("CLOSE_MANIFEST audit: registered directory descriptors only close through closeQuiet", () => {
    const sites: string[] = [];
    for (const file of ["paths.ts", "lock.ts", "writer.ts"]) {
      const source = readFileSync(new URL("../../../src/schedule/core/" + file, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      let fn = "";
      for (const line of source.split("\n")) {
        const declaration = line.match(/function\s+(\w+)/);
        if (declaration) fn = declaration[1]!;
        if (/(?<![.\w])closeSync\(/.test(line)) sites.push(file + ":" + fn);
      }
    }
    expect(sites.sort()).toEqual([...CLOSE_MANIFEST].sort());
  });
  it("read-only source contains no write primitive", () => {
    const source = readFileSync(new URL("../../../src/schedule/core/paths.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /\b(writeSync|writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync|rmdirSync|mkdirSync|linkSync|symlinkSync|chmodSync|chownSync|truncateSync|ftruncateSync|copyFileSync|utimesSync|O_CREAT|O_WRONLY|O_RDWR|O_TRUNC|O_APPEND)\b/,
    );
  });
});
