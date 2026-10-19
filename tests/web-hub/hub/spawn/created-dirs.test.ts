import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CREATED_DIRS_FILE_MAX_BYTES,
  CREATED_DIRS_MAX,
  CREATED_DIRS_TTL_MS,
  createCreatedDirsStore,
  type CreatedDirRecord,
  type CreatedDirsStoreDeps,
} from "../../../../src/web-hub/hub/spawn/created-dirs.js";
import { SPAWN_CWD_MAX_BYTES } from "../../../../src/web-hub/protocol/spawn.js";
import { memLog } from "../helpers.js";

let dir = "";
let file = "";
let now = 1_800_000_000_000;
let log = memLog();
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pwh-created-"));
  file = join(dir, "spawn/created-dirs.json");
  now = 1_800_000_000_000;
  log = memLog();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const by = { listener: "lan", user: "u1" } satisfies CreatedDirRecord["by"];
function record(path = "/work/new", createdAt = now): CreatedDirRecord {
  return { path, dev: 1, ino: 2, createdAt, by };
}
function store(over: Partial<CreatedDirsStoreDeps> = {}) {
  return createCreatedDirsStore({ file, now: () => now, log, ...over });
}
function envelope(entries: readonly unknown[], extra = ""): string {
  return JSON.stringify({ v: 1, entries }) + extra;
}
function seed(raw: string, mode = 0o600): void {
  mkdirSync(join(dir, "spawn"), { recursive: true, mode: 0o700 });
  writeFileSync(file, raw, { mode });
  chmodSync(file, mode);
}
function warns() {
  return log.lines.filter((l) => l.level === "warn");
}
function residues() {
  return readdirSync(join(dir, "spawn")).filter((n) => n.includes(".tmp-"));
}

describe("created dirs persistence", () => {
  it("missing file is silent; creates 0700 parent and 0600 envelope, restart round-trips", () => {
    const s = store();
    expect(s.list()).toEqual([]);
    expect(warns()).toEqual([]);
    expect(s.add({ path: "/work/new", dev: 1, ino: 2 }, by)).toEqual({ ok: true });
    expect(statSync(join(dir, "spawn")).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, entries: [record()] });
    expect(store().list()).toEqual([record()]);
  });

  it("sweeps regular tmp residues only, never the envelope or foreign dirs/symlinks", () => {
    seed(envelope([record()]));
    writeFileSync(`${file}.tmp-dead`, "unfinished");
    mkdirSync(`${file}.tmp-dir`);
    symlinkSync(file, `${file}.tmp-link`);
    const before = readFileSync(file);
    expect(store().list()).toEqual([record()]);
    expect(residues().sort()).toEqual(["created-dirs.json.tmp-dir", "created-dirs.json.tmp-link"]);
    expect(readFileSync(file)).toEqual(before);
  });

  it.each(["directory", "symlink", "foreign-uid", "oversize", "bad-json", "v2"])(
    "%s is empty + one warning, untouched",
    (kind) => {
      seed(envelope([record()]));
      if (kind === "directory") {
        rmSync(file);
        mkdirSync(file);
      }
      if (kind === "symlink") {
        renameSync(file, `${file}.target`);
        symlinkSync(`${file}.target`, file);
      }
      if (kind === "oversize") writeFileSync(file, " ".repeat(CREATED_DIRS_FILE_MAX_BYTES + 1));
      if (kind === "bad-json") writeFileSync(file, "{broken");
      if (kind === "v2") writeFileSync(file, '{"v":2,"entries":[]}');
      const before = lstatSync(file);
      const bytes = before.isFile() ? readFileSync(file) : undefined;
      const s = store(kind === "foreign-uid" ? { getuid: () => (process.getuid?.() ?? 0) + 1 } : {});
      expect(s.list()).toEqual([]);
      expect(warns()).toHaveLength(1);
      expect(lstatSync(file).ino).toBe(before.ino);
      expect(lstatSync(file).mode).toBe(before.mode);
      if (bytes !== undefined) expect(readFileSync(file)).toEqual(bytes);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "FIFO swapped in at open: nonblocking fd opens, fstat rejects, never reads",
    () => {
      seed(envelope([record()]));
      let checked = false;
      const s = store({
        fs: {
          openSync: (p, flags, mode) => {
            expect(p).toBe(file);
            expect(flags & constants.O_NONBLOCK).not.toBe(0);
            expect(flags & constants.O_NOFOLLOW).not.toBe(0);
            expect(flags & constants.O_NOCTTY).not.toBe(0);
            // No lstat pre-check: the swap happens at the only open boundary.
            rmSync(p);
            const fifo = spawnSync("mkfifo", [p], { timeout: 2_000 });
            expect(fifo.status).toBe(0);
            return openSync(p, flags, mode);
          },
          fstatSync: (fd) => {
            checked = true;
            return fstatSync(fd);
          },
          readSync: () => {
            throw new Error("must not read FIFO");
          },
        },
      });
      expect(checked).toBe(true);
      expect(s.list()).toEqual([]);
      expect(lstatSync(file).isFIFO()).toBe(true);
      expect(warns()).toHaveLength(1);
    },
  );

  it("repairs mode through the opened fd even if its pathname is swapped", () => {
    seed(envelope([record()]), 0o644);
    let repairedFd = -1;
    const s = store({
      fs: {
        openSync: (p, flags, mode) => {
          const fd = openSync(p, flags, mode);
          renameSync(file, `${file}.opened`);
          writeFileSync(file, "replacement", { mode: 0o644 });
          chmodSync(file, 0o644);
          return fd;
        },
        fchmodSync: (fd, mode) => {
          repairedFd = fd;
          fchmodSync(fd, mode);
        },
      },
    });
    expect(s.list()).toEqual([record()]);
    expect(repairedFd).toBeGreaterThan(2);
    expect(statSync(`${file}.opened`).mode & 0o777).toBe(0o600);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(warns()).toHaveLength(1);
  });

  it("fchmod failure is best effort and warns only once", () => {
    seed(envelope([record()]), 0o644);
    expect(
      store({
        fs: {
          fchmodSync: () => {
            throw new Error("denied");
          },
        },
      }).list(),
    ).toEqual([record()]);
    expect(warns()).toHaveLength(1);
  });

  it("drops bad entries singly, dedupes newest, trims to newest 50 in memory without writing", () => {
    const entries = Array.from({ length: 55 }, (_, i) => record(`/work/${i}`, now - i));
    const invalid = [
      null,
      {},
      record("relative"),
      record("/nul\0x"),
      record(`/${"x".repeat(SPAWN_CWD_MAX_BYTES)}`),
      { ...record(), dev: -1 },
      { ...record(), ino: 1.5 },
      { ...record(), dev: Number.MAX_SAFE_INTEGER + 1 },
      { ...record(), createdAt: "now" },
      record("/future", now + 300_001),
      { ...record(), by: { listener: "other" } },
      { ...record(), by: { listener: "lan", user: 3 } },
    ];
    seed(envelope([...entries, record("/work/0", now + 1), ...invalid]));
    const before = readFileSync(file);
    const list = store().list();
    expect(list).toHaveLength(CREATED_DIRS_MAX);
    expect(list[0]).toEqual(record("/work/0", now + 1));
    expect(list.at(-1)?.path).toBe("/work/49");
    expect(readFileSync(file)).toEqual(before);
  });

  it("TTL at load/read/add, and list cannot mutate the stored records", () => {
    seed(envelope([record("/expired", now - CREATED_DIRS_TTL_MS), record("/fresh")]));
    const s = store();
    expect(s.list()).toEqual([record("/fresh")]);
    const copy = s.list()[0];
    if (copy === undefined) throw new Error("missing record");
    copy.path = "/tampered";
    copy.by.listener = "loopback";
    expect(s.list()[0]?.path).toBe("/fresh");
    now += CREATED_DIRS_TTL_MS;
    expect(s.list()).toEqual([]);
    expect(s.add({ path: "/next", dev: 3, ino: 4 }, by)).toEqual({ ok: true });
    expect(store().list()).toHaveLength(1);
    expect(store().list()[0]?.path).toBe("/next");
  });

  it("escaped and multibyte paths round-trip without altering identity/provenance", () => {
    const paths = ['/work/quote"', "/work/back\\slash", "/work/new\nline", "/work/\u0001\u001f\t", "/work/目录🙂"];
    const s = store();
    for (const path of paths) {
      now++;
      expect(s.add({ path, dev: 4, ino: 7 }, by)).toEqual({ ok: true });
    }
    expect(
      store()
        .list()
        .map((r) => r.path),
    ).toEqual([...paths].reverse());
    expect(
      store()
        .list()
        .every((r) => r.dev === 4 && r.ino === 7 && r.by.user === "u1"),
    ).toBe(true);
  });

  it("exact UTF-8 cap loads, cap+1 is rejected, even when fstat understates a growing file", () => {
    const raw = envelope([record("/目录")]);
    seed(raw + " ".repeat(CREATED_DIRS_FILE_MAX_BYTES - Buffer.byteLength(raw)));
    expect(statSync(file).size).toBe(CREATED_DIRS_FILE_MAX_BYTES);
    expect(store().list()).toEqual([record("/目录")]);
    writeFileSync(file, readFileSync(file, "utf8") + " ");
    expect(store().list()).toEqual([]);
    expect(store({ fs: { fstatSync: (fd) => ({ ...fstatSync(fd), size: 0, isFile: () => true }) } }).list()).toEqual(
      [],
    );
  });

  it("trims oldest by serialized UTF-8 bytes; every written envelope reloads below cap", () => {
    const s = store();
    const paths: string[] = [];
    for (let i = 0; i < 20; i++) {
      now++;
      const path = `/${i}${"\u0001".repeat(SPAWN_CWD_MAX_BYTES - 4)}`;
      paths.push(path);
      expect(s.add({ path, dev: 1, ino: i }, by)).toEqual({ ok: true });
      expect(statSync(file).size).toBeLessThanOrEqual(CREATED_DIRS_FILE_MAX_BYTES);
      expect(store().list()).toEqual(s.list());
    }
    expect(s.list().length).toBeLessThan(paths.length);
    expect(s.list()[0]?.path).toBe(paths.at(-1));
    expect(s.list().map((r) => r.path)).not.toContain(paths[0]);
  });

  it("new add survives count/byte trimming despite future-dated loaded entries; same path replaces unconditionally", () => {
    seed(envelope(Array.from({ length: 50 }, (_, i) => record(`/future/${i}`, now + 100 + i))));
    const s = store();
    expect(s.add({ path: "/new", dev: 9, ino: 9 }, by)).toEqual({ ok: true });
    expect(s.list()).toHaveLength(50);
    expect(s.list().some((r) => r.path === "/new")).toBe(true);
    expect(s.add({ path: "/future/49", dev: 8, ino: 8 }, by)).toEqual({ ok: true });
    expect(s.list().find((r) => r.path === "/future/49")).toEqual({ ...record("/future/49"), dev: 8, ino: 8 });
  });

  it("short write then continue commits only after full write and close", () => {
    seed(envelope([record("/old")]));
    let written = 0;
    let closed = false;
    const s = store({
      fs: {
        writeSync: (fd, buf, off, len) => {
          const n = writeSync(fd, buf, off, Math.min(7, len), null);
          written += n;
          return n;
        },
        closeSync: (fd) => {
          closeSync(fd);
          closed = true;
        },
        renameSync: (from, to) => {
          expect(closed).toBe(true);
          expect(written).toBe(statSync(from).size);
          renameSync(from, to);
        },
      },
    });
    closed = false;
    expect(s.add({ path: "/new", dev: 3, ino: 4 }, by)).toEqual({ ok: true });
    expect(store().list()).toEqual(s.list());
    expect(s.list()).toHaveLength(2);
    expect(residues()).toEqual([]);
  });

  it.each(["error", "zero", "close", "rename"])("%s failure keeps old bytes + memory and cleans tmp", (kind) => {
    seed(envelope([record("/old")]));
    const before = readFileSync(file);
    let writes = 0;
    const s = store({
      fs: {
        writeSync: (fd, buf, off, len) => {
          writes++;
          if (kind === "zero") return 0;
          if (kind === "error" && writes > 1) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          return writeSync(fd, buf, off, Math.min(7, len), null);
        },
        closeSync: (fd) => {
          closeSync(fd);
          if (kind === "close" && writes > 0) throw new Error("close failed");
        },
        renameSync: (from, to) => {
          if (kind === "rename") throw new Error("rename failed");
          renameSync(from, to);
        },
      },
    });
    const old = s.list();
    expect(s.add({ path: "/new", dev: 3, ino: 4 }, by).ok).toBe(false);
    expect(s.list()).toEqual(old);
    expect(readFileSync(file)).toEqual(before);
    expect(residues()).toEqual([]);
  });

  it("post-rename check failure does not grant in memory (disk can already be ahead)", () => {
    seed(envelope([record("/old")]));
    const s = store({
      fs: {
        lstatSync: (p) => {
          if (p === file) throw new Error("post-rename stat failed");
          return lstatSync(p);
        },
      },
    });
    const before = s.list();
    expect(s.add({ path: "/new", dev: 3, ino: 4 }, by).ok).toBe(false);
    expect(s.list()).toEqual(before);
    expect(
      store()
        .list()
        .some((r) => r.path === "/new"),
    ).toBe(true);
  });
});

describe("created dirs exact write boundary", () => {
  it("an exactly-cap write reloads; the next overflowing add trims oldest, never the new record", () => {
    const emptyUser = { ...record("/boundary"), by: { listener: "lan", user: "" } };
    const padding = CREATED_DIRS_FILE_MAX_BYTES - Buffer.byteLength(envelope([emptyUser]));
    const boundaryBy = { listener: "lan", user: "u".repeat(padding) } satisfies CreatedDirRecord["by"];
    const s = store();
    expect(s.add({ path: "/boundary", dev: 1, ino: 2 }, boundaryBy)).toEqual({ ok: true });
    expect(statSync(file).size).toBe(CREATED_DIRS_FILE_MAX_BYTES);
    expect(store().list()).toEqual(s.list());
    now++;
    expect(s.add({ path: "/next", dev: 3, ino: 4 }, by)).toEqual({ ok: true });
    expect(s.list().map((r) => r.path)).toEqual(["/next"]);
    expect(store().list()).toEqual(s.list());
  });
});
