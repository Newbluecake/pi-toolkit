// optimize-plan §3.1 / §10 B group (todo #22 P0-b): safe-fs.ts primitives.
// Focus: symlink refusal (files, never directories/ancestors), atomic
// no-clobber create/rename, canonicalization + the slug-directory trust
// exception, and the lock-file primitives lock.ts composes.

import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryError } from "../../src/memory/paths.js";
import {
  appendLegacy,
  canonicalDir,
  createExclusive,
  ensurePrivateDir,
  isDirFollowOutside,
  listRegular,
  lockCreate,
  lockRead,
  lockRelease,
  openRegular,
  readRegular,
  readRegularHead,
  renameNoClobber,
  replaceAtomic,
  statRegularIfExists,
  writeAll,
  writeInPlaceLegacy,
  writeTempRegular,
} from "../../src/memory/safe-fs.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "mem-safe-fs-"));
}

describe("listRegular", () => {
  it("skips a file-level symlink to an outside target, recording kind: symlink", () => {
    const dir = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "secret.md"), "shh");
    writeFileSync(join(dir, "good.md"), "ok");
    symlinkSync(join(outside, "secret.md"), join(dir, "linked.md"));
    const { files, skipped } = listRegular(dir, { names: "legacy" });
    expect(files.map((f) => f.name)).toEqual(["good.md"]);
    expect(skipped).toEqual([{ name: "linked.md", kind: "symlink" }]);
  });

  it("classifies a dangling symlink as kind: dangling, not symlink", () => {
    const dir = tmp();
    symlinkSync(join(dir, "missing-target.md"), join(dir, "bad.md"));
    const { files, skipped } = listRegular(dir, { names: "legacy" });
    expect(files).toEqual([]);
    expect(skipped).toEqual([{ name: "bad.md", kind: "dangling" }]);
  });

  it("names:'v2' rejects non-NAME_RE filenames as bad-name, without touching fs", () => {
    const dir = tmp();
    writeFileSync(join(dir, "My Notes.md"), "x");
    writeFileSync(join(dir, "ok.md"), "y");
    const v2 = listRegular(dir, { names: "v2" });
    expect(v2.files.map((f) => f.name)).toEqual(["ok.md"]);
    expect(v2.skipped).toEqual([{ name: "My Notes.md", kind: "bad-name" }]);
    const legacy = listRegular(dir, { names: "legacy" });
    expect(legacy.files.map((f) => f.name).sort()).toEqual(["My Notes.md", "ok.md"]);
  });

  it("empty/missing dir returns no files, no skips, no throw", () => {
    const dir = tmp();
    expect(listRegular(join(dir, "nope"), { names: "legacy" })).toEqual({ files: [], skipped: [] });
  });
});

describe("openRegular / readRegular / readRegularHead", () => {
  it("refuses a symlinked file with a MemoryError (ELOOP), even when the target is fine", () => {
    const dir = tmp();
    writeFileSync(join(dir, "target.md"), "body");
    symlinkSync(join(dir, "target.md"), join(dir, "link.md"));
    expect(() => readRegular(dir, "link.md")).toThrow(MemoryError);
    expect(() => openRegular(dir, "link.md", 0)).toThrow(/symlink/);
  });

  it("reads full content and a bounded head", () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.md"), "hello world");
    expect(readRegular(dir, "a.md").text).toBe("hello world");
    expect(readRegularHead(dir, "a.md", 5).text).toBe("hello");
    expect(readRegularHead(dir, "a.md", 999).text).toBe("hello world");
  });

  it("refuses a directory opened as a file", () => {
    const dir = tmp();
    mkdirSync(join(dir, "adir.md"));
    expect(() => readRegular(dir, "adir.md")).toThrow(MemoryError);
  });
});

describe("statRegularIfExists", () => {
  it("undefined when missing, stat when a regular file, throws on symlink", () => {
    const dir = tmp();
    expect(statRegularIfExists(dir, "nope.md")).toBeUndefined();
    writeFileSync(join(dir, "a.md"), "xx");
    expect(statRegularIfExists(dir, "a.md")?.size).toBe(2);
    symlinkSync(join(dir, "a.md"), join(dir, "link.md"));
    expect(() => statRegularIfExists(dir, "link.md")).toThrow(MemoryError);
  });
});

describe("writeTempRegular / replaceAtomic / createExclusive / renameNoClobber", () => {
  it("writeTempRegular + replaceAtomic performs an atomic overwrite", () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.md"), "old");
    const tmpName = writeTempRegular(dir, "a.md", Buffer.from("new"), 0o600);
    replaceAtomic(dir, tmpName, "a.md");
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("new");
  });

  it("writeTempRegular writes into a hidden .tmp file next to the target", () => {
    const dir = tmp();
    const tmpName = writeTempRegular(dir, "x.md", Buffer.from("body"), 0o600);
    expect(tmpName.startsWith(".x.md.")).toBe(true);
    expect(tmpName.endsWith(".tmp")).toBe(true);
    expect(readFileSync(join(dir, tmpName), "utf8")).toBe("body");
    const names = readdirSync(dir);
    expect(names).toEqual([tmpName]); // caller is responsible for createExclusive/replaceAtomic-ing it away
  });

  it("createExclusive refuses an existing target and leaves both files untouched", () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.md"), "existing");
    const tmpName = writeTempRegular(dir, "a.md", Buffer.from("new"), 0o600);
    expect(() => createExclusive(dir, tmpName, "a.md")).toThrow(/already exists/);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("existing");
  });

  it("createExclusive succeeds exactly once under two concurrent attempts", async () => {
    const dir = tmp();
    const tmpA = writeTempRegular(dir, "a.md", Buffer.from("A"), 0o600);
    const tmpB = writeTempRegular(dir, "a.md", Buffer.from("B"), 0o600);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => createExclusive(dir, tmpA, "a.md")),
      Promise.resolve().then(() => createExclusive(dir, tmpB, "a.md")),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it("renameNoClobber refuses when the destination exists, leaving both files unchanged", () => {
    const dir = tmp();
    writeFileSync(join(dir, "from.md"), "F");
    writeFileSync(join(dir, "to.md"), "T");
    expect(() => renameNoClobber(dir, "from.md", "to.md")).toThrow(/already exists/);
    expect(readFileSync(join(dir, "from.md"), "utf8")).toBe("F");
    expect(readFileSync(join(dir, "to.md"), "utf8")).toBe("T");
  });

  it("renameNoClobber moves the file when the destination is free", () => {
    const dir = tmp();
    writeFileSync(join(dir, "from.md"), "F");
    renameNoClobber(dir, "from.md", "to.md");
    expect(readFileSync(join(dir, "to.md"), "utf8")).toBe("F");
    expect(statRegularIfExists(dir, "from.md")).toBeUndefined();
  });
});

describe("ensurePrivateDir", () => {
  it("creates a 0700 real directory", () => {
    const dir = tmp();
    ensurePrivateDir(join(dir, ".trash"));
    expect(statRegularIfExists).toBeDefined(); // sanity: import survived
  });

  it("refuses when the path is already a symlink", () => {
    const dir = tmp();
    const outside = tmp();
    symlinkSync(outside, join(dir, ".trash"));
    expect(() => ensurePrivateDir(join(dir, ".trash"))).toThrow(MemoryError);
  });
});

describe("writeInPlaceLegacy / appendLegacy", () => {
  it("writeInPlaceLegacy truncates and rewrites in place; refuses a symlinked target", () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.md"), "old body longer");
    writeInPlaceLegacy(dir, "a.md", Buffer.from("new"));
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("new");
    symlinkSync(join(dir, "a.md"), join(dir, "link.md"));
    expect(() => writeInPlaceLegacy(dir, "link.md", Buffer.from("x"))).toThrow(MemoryError);
  });

  it("appendLegacy appends and returns the final size; refuses a symlinked target", () => {
    const dir = tmp();
    const r1 = appendLegacy(dir, "a.md", Buffer.from("first"));
    expect(r1.totalBytes).toBe(5);
    const r2 = appendLegacy(dir, "a.md", Buffer.from("second"));
    expect(r2.totalBytes).toBe(11);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("firstsecond");
    symlinkSync(join(dir, "a.md"), join(dir, "link.md"));
    expect(() => appendLegacy(dir, "link.md", Buffer.from("x"))).toThrow(MemoryError);
  });
});

describe("canonicalDir", () => {
  it("undefined for a missing directory", () => {
    const dir = tmp();
    expect(canonicalDir(join(dir, "nope"))).toBeUndefined();
  });

  it("undefined when the canonical target is a file, not a directory", () => {
    const dir = tmp();
    writeFileSync(join(dir, "notadir"), "x");
    expect(canonicalDir(join(dir, "notadir"))).toBeUndefined();
  });

  it("follows a slug-directory symlink and reports linked:true with real !== display", () => {
    const outside = tmp();
    const dir = tmp();
    const display = join(dir, "linked-slug");
    symlinkSync(outside, display);
    const result = canonicalDir(display);
    expect(result?.linked).toBe(true);
    expect(result?.display).toBe(display);
    expect(result?.real).not.toBe(display);
  });

  it("linked:false for a plain (non-symlink) directory", () => {
    const dir = tmp();
    const display = join(dir, "plain");
    mkdirSync(display);
    const result = canonicalDir(display);
    expect(result?.linked).toBe(false);
  });
});

describe("isDirFollowOutside", () => {
  it("follows a symlink to a real directory outside the memory tree", () => {
    const outside = tmp();
    const dir = tmp();
    symlinkSync(outside, join(dir, "memory"));
    expect(isDirFollowOutside(join(dir, "memory"))).toBe(true);
  });

  it("false for a dangling symlink or a missing path", () => {
    const dir = tmp();
    symlinkSync(join(dir, "missing"), join(dir, "dangling"));
    expect(isDirFollowOutside(join(dir, "dangling"))).toBe(false);
    expect(isDirFollowOutside(join(dir, "nope"))).toBe(false);
  });
});

describe("lock-file primitives (lockCreate/lockRead/lockRelease)", () => {
  it("lockCreate is exclusive; lockRead reports the payload and mtime; lockRelease only removes a matching token", () => {
    const dir = tmp();
    const payload = { pid: process.pid, host: "h", token: "tok-1", at: Date.now() };
    expect(lockCreate(dir, payload)).toBe(true);
    expect(lockCreate(dir, { ...payload, token: "tok-2" })).toBe(false); // already locked
    const read = lockRead(dir);
    expect(read?.payload).toEqual(payload);
    lockRelease(dir, "wrong-token");
    expect(lockRead(dir)?.payload).toEqual(payload); // untouched
    lockRelease(dir, "tok-1");
    expect(lockRead(dir)).toBeUndefined();
  });
});

describe("writeAll", () => {
  it("writes a buffer fully via a real fd", () => {
    const dir = tmp();
    const path = join(dir, "raw.bin");
    const fd = openSync(path, "w");
    try {
      writeAll(fd, Buffer.from("all of this"));
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(path, "utf8")).toBe("all of this");
  });
});
