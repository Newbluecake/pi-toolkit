/**
 * web-hub-upload plan §包 U2: unit tests for `hub/upload-fs.ts` — directory hygiene (#3),
 * complete writes (#6), deadline racing (§2.2.5), and the hardlink probe (v3 #4). Fault
 * injection goes through `UploadFsDeps` fakes; happy paths use a real tmpdir.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createUploadDir,
  defaultUploadFsDeps,
  ensureUploadDir,
  fsStep,
  openFileNoFollow,
  PART_CREATE_FLAGS,
  PART_WRITE_FLAGS,
  probeHardlink,
  raceDeadlineUnref,
  syncDir,
  unrefDelay,
  UploadDirCreateError,
  UploadFsError,
  verifyDirChain,
  writeAllAt,
  type DirChainEntry,
  type UploadFileHandle,
  type UploadFsDeps,
} from "../../../src/web-hub/hub/upload-fs.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wh-uploadfs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const real = defaultUploadFsDeps();
const noDeadline = { at: real.now() + 60_000 };

describe("ensureUploadDir (§2.2.1 #3)", () => {
  it("creates a 0700 non-symlink dir and returns its identity", async () => {
    const p = `${dir}/uploads`;
    const id = await ensureUploadDir(p, { create: true }, real, noDeadline);
    expect(statSync(p).mode & 0o777).toBe(0o700);
    expect(id).toEqual({ dev: id.dev, ino: id.ino });
    expect(id.ino).toBeGreaterThan(0);
    // idempotent on an existing valid dir
    const id2 = await ensureUploadDir(p, { create: true }, real, noDeadline);
    expect(id2).toEqual(id);
  });

  it("repairs a widened mode back to 0700", async () => {
    const p = `${dir}/uploads`;
    mkdirSync(p, { mode: 0o700 });
    chmodSync(p, 0o755);
    expect(statSync(p).mode & 0o777).toBe(0o755);
    await ensureUploadDir(p, { create: true }, real, noDeadline);
    expect(statSync(p).mode & 0o777).toBe(0o700);
  });

  it("rejects a symlink (never follows it, unlike stat)", async () => {
    const target = `${dir}/target`;
    mkdirSync(target);
    const link = `${dir}/uploads`;
    symlinkSync(target, link);
    await expect(ensureUploadDir(link, { create: true }, real, noDeadline)).rejects.toThrow(/symlink/);
  });

  it("rejects a non-directory and a foreign owner, with create:false treating ENOENT as io", async () => {
    const file = `${dir}/notadir`;
    writeFileSync(file, "x");
    await expect(ensureUploadDir(file, { create: true }, real, noDeadline)).rejects.toThrow(/not a directory/);
    await expect(ensureUploadDir(`${dir}/missing`, { create: false }, real, noDeadline)).rejects.toMatchObject({
      reason: "io",
    });

    const foreign: Partial<UploadFsDeps> = { getuid: () => real.getuid() + 12345 };
    const p = `${dir}/mine`;
    mkdirSync(p, { mode: 0o700 });
    await expect(ensureUploadDir(p, { create: true }, { ...real, ...foreign }, noDeadline)).rejects.toMatchObject({
      reason: "owner-mismatch",
    });
  });
});

describe("createUploadDir (§2.1 id dirs)", () => {
  it("mkdir-first: a pre-existing entry surfaces as raw EEXIST (id 不复用), not a validation error", async () => {
    const p = `${dir}/s-sess/abc`;
    mkdirSync(`${dir}/s-sess`, { recursive: true });
    mkdirSync(p);
    await expect(createUploadDir(p, real, noDeadline)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("wraps post-mkdir validation failures in UploadDirCreateError(created:true)", async () => {
    // fake lstat reports the freshly created dir as a symlink → validation fails after mkdir
    const target = `${dir}/s-x`;
    const lying: Partial<UploadFsDeps> = {
      lstat: (p) =>
        real
          .lstat(p)
          .then((st) =>
            p === target ? { ...st, isDirectory: () => false, isSymbolicLink: () => true, isFile: () => false } : st,
          ),
    };
    await expect(createUploadDir(target, { ...real, ...lying }, noDeadline)).rejects.toBeInstanceOf(
      UploadDirCreateError,
    );
    expect(existsSync(target)).toBe(true); // created, then rejected — caller cleans up
  });
});

describe("verifyDirChain / openFileNoFollow (§2.2.1 #3)", () => {
  async function makeChain(): Promise<DirChainEntry[]> {
    const rootId = await ensureUploadDir(`${dir}/uploads`, { create: true }, real, noDeadline);
    const bucketId = await ensureUploadDir(`${dir}/uploads/s-sess`, { create: true }, real, noDeadline);
    const idId = await ensureUploadDir(`${dir}/uploads/s-sess/uploadid12345678`, { create: true }, real, noDeadline);
    return [
      { path: `${dir}/uploads`, id: rootId },
      { path: `${dir}/uploads/s-sess`, id: bucketId },
      { path: `${dir}/uploads/s-sess/uploadid12345678`, id: idId },
    ];
  }

  it("verifies an intact chain and rejects a replaced directory (identity mismatch)", async () => {
    const chain = await makeChain();
    await expect(verifyDirChain(chain, real, noDeadline)).resolves.toBeUndefined();
    const replaced: DirChainEntry[] = [...chain];
    replaced[1] = { path: chain[1]!.path, id: { dev: 1, ino: 2 } };
    await expect(verifyDirChain(replaced, real, noDeadline)).rejects.toBeInstanceOf(UploadFsError);
  });

  it("openFileNoFollow refuses a symlink part (ELOOP) and never writes through it", async () => {
    const chain = await makeChain();
    const victim = `${chain[2]!.path}/victim.txt`;
    writeFileSync(victim, "do-not-touch");
    symlinkSync(victim, `${chain[2]!.path}/x.part`);
    // re-open of an existing path (no O_EXCL): O_NOFOLLOW turns the symlink into ELOOP
    await expect(
      openFileNoFollow(chain, "x.part", PART_WRITE_FLAGS, undefined, real, noDeadline),
    ).rejects.toMatchObject({
      code: "ELOOP",
    });
    expect(readFileSync(victim, "utf8")).toBe("do-not-touch");
  });

  it("openFileNoFollow closes the handle and throws on chain mismatch after open", async () => {
    const chain = await makeChain();
    const closes: number[] = [];
    // part must exist for the open to succeed
    const h = await real.open(`${chain[2]!.path}/real.part`, PART_CREATE_FLAGS, 0o600);
    await h.close();
    const fakeOpen = async (p: string, flags: number, mode?: number): Promise<UploadFileHandle> => {
      const inner = await real.open(p, flags, mode);
      return {
        write: (buf, off, len, pos) => inner.write(buf, off, len, pos),
        truncate: (n) => inner.truncate(n),
        datasync: () => inner.datasync(),
        sync: () => inner.sync(),
        stat: () => inner.stat(),
        close: async () => {
          closes.push(1);
          return inner.close();
        },
      };
    };
    const brokenChain: DirChainEntry[] = [chain[0]!, chain[1]!, { path: chain[2]!.path, id: { dev: 9, ino: 9 } }];
    await expect(
      openFileNoFollow(brokenChain, "real.part", PART_WRITE_FLAGS, undefined, { ...real, open: fakeOpen }, noDeadline),
    ).rejects.toThrow(/chain-mismatch/);
    expect(closes.length).toBe(1);
  });
});

describe("writeAllAt (§2.2.2 #6)", () => {
  it("loops a partial-writing handle to completion at the right positions", async () => {
    const written: Array<{ offset: number; length: number; position: number; wrote: number }> = [];
    let call = 0;
    const handle: UploadFileHandle = {
      write: async (buf, offset, length, position) => {
        call += 1;
        // first two calls write only half of the requested slice
        const n = call <= 2 ? Math.max(1, Math.floor(length / 2)) : length;
        written.push({ offset, length, position, wrote: n });
        return { bytesWritten: n };
      },
      truncate: async () => undefined,
      datasync: async () => undefined,
      sync: async () => undefined,
      stat: async () => ({
        dev: 1,
        ino: 1,
        uid: 0,
        mode: 0,
        size: 0,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      }),
      close: async () => undefined,
    };
    const buf = Buffer.alloc(100, 0xab);
    await writeAllAt(handle, buf, 1000, noDeadline, real);
    // every write started at position 1000 + bytes actually written so far, never regressing
    let acc = 0;
    for (const w of written) {
      expect(w.position).toBe(1000 + acc);
      expect(w.offset).toBe(0); // writeAllAt re-slices from the remaining offset
      acc += w.wrote;
    }
    expect(acc).toBe(100);
    expect(written.length).toBeGreaterThanOrEqual(3); // partial writes forced extra rounds
  });

  it("a 0-byte write is a short-write error; a thrown write propagates", async () => {
    const zero: UploadFileHandle = {
      ...fakeHandle(),
      write: async () => ({ bytesWritten: 0 }),
    };
    await expect(writeAllAt(zero, Buffer.alloc(10), 0, noDeadline, real)).rejects.toMatchObject({
      reason: "short-write",
    });
    const throwing: UploadFileHandle = {
      ...fakeHandle(),
      write: async () => {
        throw new Error("ENOSPC: no space");
      },
    };
    await expect(writeAllAt(throwing, Buffer.alloc(10), 0, noDeadline, real)).rejects.toThrow(/ENOSPC/);
  });
});

describe("fsStep / raceDeadlineUnref / unrefDelay (§2.2.5)", () => {
  it("never initiates the call once the deadline has expired", async () => {
    let initiated = false;
    const dl = { at: real.now() - 1 };
    await expect(
      fsStep(
        () => {
          initiated = true;
          return Promise.resolve(1);
        },
        dl,
        real.now,
      ),
    ).rejects.toMatchObject({ reason: "deadline" });
    expect(initiated).toBe(false);
  });

  it("times out a hung step with the §2.2.5 deadline error", async () => {
    const dl = { at: real.now() + 40 };
    await expect(fsStep(() => new Promise<never>(() => undefined), dl, real.now)).rejects.toMatchObject({
      reason: "deadline",
    });
  });

  it("every timer it creates is unref'd (hasRef() === false)", async () => {
    const created: Array<{ hasRef(): boolean }> = [];
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const t = origSetTimeout(fn, ms, ...(rest as []));
      created.push(t);
      return t;
    }) as typeof globalThis.setTimeout;
    try {
      const p = fsStep(() => new Promise<never>(() => undefined), { at: real.now() + 30_000 }, real.now);
      await expect(p).rejects.toBeInstanceOf(UploadFsError);
      await unrefDelay(1);
      await expect(raceDeadlineUnref(new Promise<never>(() => undefined), 5)).rejects.toBeInstanceOf(UploadFsError);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
    expect(created.length).toBeGreaterThanOrEqual(3);
    for (const t of created) expect(t.hasRef()).toBe(false);
  });
});

describe("probeHardlink (v3 #4)", () => {
  it("succeeds on a normal filesystem and leaves no probe files behind", async () => {
    await probeHardlink(dir, real, noDeadline);
    const names = await defaultUploadFsDeps().readdir(dir);
    expect(names.filter((n) => n.startsWith(".probe-"))).toEqual([]);
  });

  it("propagates EPERM and still cleans up both names", async () => {
    const realDeps = defaultUploadFsDeps();
    const eperm: Partial<UploadFsDeps> = {
      link: () => {
        const e = new Error("operation not permitted") as Error & { code: string };
        e.code = "EPERM";
        return Promise.reject(e);
      },
    };
    await expect(probeHardlink(dir, { ...realDeps, ...eperm }, noDeadline)).rejects.toMatchObject({ code: "EPERM" });
    const names = await realDeps.readdir(dir);
    expect(names.filter((n) => n.startsWith(".probe-"))).toEqual([]);
  });
});

describe("syncDir (§2.2.3 step 5, deadline threading §2.2.5)", () => {
  it("threads the caller deadline: an expired budget never initiates the dir open", async () => {
    let opened = false;
    const deps: Partial<UploadFsDeps> = {
      open: (p, flags, mode) => {
        opened = true;
        return real.open(p, flags, mode);
      },
    };
    await expect(syncDir(dir, { ...real, ...deps }, { at: real.now() - 1 })).rejects.toMatchObject({
      reason: "deadline",
    });
    expect(opened).toBe(false);
  });

  it("with budget left it fsyncs the directory and resolves", async () => {
    await expect(syncDir(dir, real, { at: real.now() + 5_000 })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fakeHandle(): UploadFileHandle {
  return {
    write: async () => ({ bytesWritten: 0 }),
    truncate: async () => undefined,
    datasync: async () => undefined,
    sync: async () => undefined,
    stat: async () => ({
      dev: 1,
      ino: 1,
      uid: 0,
      mode: 0,
      size: 0,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    }),
    close: async () => undefined,
  };
}
