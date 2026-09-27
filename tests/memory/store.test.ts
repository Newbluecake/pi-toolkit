import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertAllowWrite,
  discoverCCProjects,
  DRIFT_HEADER,
  importAll,
  importProject,
  listMemory,
  resolveMemoryFile,
  writeMemoryFile,
  type WriteOptions,
} from "../../src/memory/store.js";
import { MemoryError, memoryDirFor, type MemoryPaths } from "../../src/memory/paths.js";

const NOW = "2026-01-02T03:04:05.000Z";

function fixture(): { paths: MemoryPaths; cwd: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "mem-store-"));
  const paths: MemoryPaths = { memoryRoot: join(root, "mem"), ccProjectsRoot: join(root, "cc") };
  const cwd = "/proj/app";
  return { paths, cwd, dir: memoryDirFor(cwd, paths) };
}

function wopts(over: Partial<WriteOptions> = {}): WriteOptions {
  return { allowWrite: true, maxWriteBytes: 65_536, maxFileBytes: 262_144, nowIso: NOW, ...over };
}

function writeRaw(dir: string, name: string, body: string, mtimeSec?: number): void {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, body);
  if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec);
}

describe("listMemory", () => {
  it("returns [] for a missing directory", () => {
    const { paths, cwd } = fixture();
    expect(listMemory(cwd, paths)).toEqual([]);
  });

  it("filters non-md files (mcp-traces.jsonl regression)", () => {
    const { paths, cwd, dir } = fixture();
    writeRaw(dir, "notes.md", "n");
    writeRaw(dir, "mcp-traces.jsonl", "{}");
    writeRaw(dir, "readme.txt", "t");
    expect(listMemory(cwd, paths).map((f) => f.name)).toEqual(["notes.md"]);
  });

  it("sorts newest-first by mtimeMs", () => {
    const { paths, cwd, dir } = fixture();
    writeRaw(dir, "old.md", "o", 1_000);
    writeRaw(dir, "new.md", "n", 3_000);
    writeRaw(dir, "mid.md", "m", 2_000);
    expect(listMemory(cwd, paths).map((f) => f.name)).toEqual(["new.md", "mid.md", "old.md"]);
  });

  it("skips entries whose stat fails (dangling symlink) without sinking the listing", () => {
    const { paths, cwd, dir } = fixture();
    writeRaw(dir, "good.md", "g");
    symlinkSync(join(dir, "missing-target.md"), join(dir, "bad.md"));
    const files = listMemory(cwd, paths);
    expect(files.map((f) => f.name)).toEqual(["good.md"]);
    expect(files[0]?.path).toBe(join(dir, "good.md"));
    expect(files[0]?.size).toBe(1);
  });

  it("slug directory itself a symlink: lists through the REAL target, output equivalent to a plain dir (打回修复 §3.1)", () => {
    const { paths, cwd, dir } = fixture();
    const real = `${dir}-real`;
    writeRaw(real, "alpha.md", "alpha body", 5_000);
    writeRaw(real, "beta.md", "beta body", 6_000);
    symlinkSync(real, dir); // `dir` (the display slug path) does not exist yet — becomes a symlink to `real`
    const viaSymlink = listMemory(cwd, paths);

    // Baseline: an equivalent PLAIN (non-symlink) directory with the same files.
    const baseline = fixture();
    writeRaw(baseline.dir, "alpha.md", "alpha body", 5_000);
    writeRaw(baseline.dir, "beta.md", "beta body", 6_000);
    const viaPlain = listMemory(baseline.cwd, baseline.paths);

    expect(viaSymlink.map((f) => ({ name: f.name, size: f.size, mtimeMs: f.mtimeMs }))).toEqual(
      viaPlain.map((f) => ({ name: f.name, size: f.size, mtimeMs: f.mtimeMs })),
    );
    // The actual fs read happened against the REAL target, not the symlink display path.
    expect(viaSymlink.every((f) => f.path.startsWith(real))).toBe(true);
  });

  it("slug-dir symlink + a file-level symlink inside it: the file-level symlink is still refused everywhere (N2, combined case)", () => {
    const { paths, cwd, dir } = fixture();
    const real = `${dir}-real`;
    writeRaw(real, "good.md", "g");
    symlinkSync(join(real, "missing.md"), join(real, "bad.md"));
    symlinkSync(real, dir);
    const files = listMemory(cwd, paths);
    expect(files.map((f) => f.name)).toEqual(["good.md"]);
  });
});

describe("writeMemoryFile — basics", () => {
  it("creates parent dir 0700 and file 0600", () => {
    const { paths, cwd, dir } = fixture();
    const res = writeMemoryFile(cwd, "a.md", "hello", wopts(), paths);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(res.path).mode & 0o777).toBe(0o600);
    expect(res.created).toBe(true);
    expect(res.path).toBe(join(dir, "a.md"));
  });

  it("overwrites an existing file (created=false)", () => {
    const { paths, cwd, dir } = fixture();
    writeRaw(dir, "a.md", "old body");
    const res = writeMemoryFile(cwd, "a.md", "new body", wopts(), paths);
    expect(res.created).toBe(false);
    expect(readFileSync(res.path, "utf8")).toContain("new body");
    expect(readFileSync(res.path, "utf8")).not.toContain("old body");
  });

  it("append creates, appends, and bridges a missing trailing newline", () => {
    const { paths, cwd, dir } = fixture();
    const r1 = writeMemoryFile(cwd, "a.md", "first", wopts({ append: true }), paths);
    expect(r1.created).toBe(true);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("first");
    const r2 = writeMemoryFile(cwd, "a.md", "second", wopts({ append: true }), paths);
    expect(r2.created).toBe(false);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("first\nsecond"); // 补尾换行
    writeMemoryFile(cwd, "a.md", "third\n", wopts({ append: true }), paths);
    writeMemoryFile(cwd, "a.md", "fourth", wopts({ append: true }), paths);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("first\nsecond\nthird\nfourth");
  });

  it("rejects the filename matrix", () => {
    const { paths, cwd } = fixture();
    for (const bad of ["../x.md", "a/b.md", "x.txt", ".md", "..", "a".repeat(200) + ".md", "x.MD", " x.md"]) {
      expect(() => writeMemoryFile(cwd, bad, "c", wopts(), paths), bad).toThrow(MemoryError);
    }
  });

  it("enforces maxWriteBytes by UTF-8 bytes (multibyte counts fully)", () => {
    const { paths, cwd } = fixture();
    const content = "中".repeat(10); // 30 bytes
    expect(() => writeMemoryFile(cwd, "a.md", content, wopts({ maxWriteBytes: 29 }), paths)).toThrow(/per-write limit/);
    expect(() => writeMemoryFile(cwd, "a.md", content, wopts({ maxWriteBytes: 30 }), paths)).not.toThrow();
  });

  it("enforces maxFileBytes on append cumulative size", () => {
    const { paths, cwd, dir } = fixture();
    writeRaw(dir, "a.md", "x".repeat(90) + "\n");
    expect(() =>
      writeMemoryFile(cwd, "a.md", "y".repeat(20), wopts({ append: true, maxFileBytes: 100 }), paths),
    ).toThrow(/file cap/);
    expect(() =>
      writeMemoryFile(cwd, "a.md", "y".repeat(9), wopts({ append: true, maxFileBytes: 100 }), paths),
    ).not.toThrow();
  });

  it("enforces maxFileBytes on write (post-provenance size)", () => {
    const { paths, cwd } = fixture();
    expect(() => writeMemoryFile(cwd, "a.md", "x".repeat(200), wopts({ maxFileBytes: 100 }), paths)).toThrow(
      /file cap/,
    );
  });

  it("WriteResult fields: bytesWritten=user content bytes, totalBytes=on-disk bytes", () => {
    const { paths, cwd } = fixture();
    const content = "中文内容"; // 12 bytes
    const res = writeMemoryFile(cwd, "a.md", content, wopts(), paths);
    expect(res.bytesWritten).toBe(12);
    expect(res.totalBytes).toBe(statSync(res.path).size);
    expect(res.totalBytes).toBeGreaterThan(res.bytesWritten); // provenance fm included in totalBytes only
  });

  it("structural gate: allowWrite=false throws MemoryError('writes not allowed') (R7)", () => {
    const { paths, cwd } = fixture();
    expect(() => writeMemoryFile(cwd, "a.md", "c", wopts({ allowWrite: false }), paths)).toThrow(
      new MemoryError("writes not allowed"),
    );
    expect(existsSync(memoryDirFor(cwd, paths))).toBe(false); // nothing created
  });
});

// P0-b 打回修复（§14.1）：`assertAllowWrite` / `resolveMemoryFile` 打回前未导出，新增最小单测。
describe("assertAllowWrite (R7, extracted from writeMemoryFile's own gate)", () => {
  it("throws MemoryError('writes not allowed') when allowWrite is not exactly true", () => {
    expect(() => assertAllowWrite(false)).toThrow(new MemoryError("writes not allowed"));
  });

  it("does not throw when allowWrite is true", () => {
    expect(() => assertAllowWrite(true)).not.toThrow();
  });
});

describe("resolveMemoryFile (方案 §4.2 第 4 条, P2 tool-v2 的路径围栏， P0 从 store 抽出)", () => {
  const dir = "/mem/-proj-app";

  it('undefined / "" / "/memories" / "/memories/" all mean "the directory itself"', () => {
    for (const input of [undefined, "", "/memories", "/memories/"]) {
      expect(resolveMemoryFile(input, dir)).toEqual({ kind: "dir" });
    }
  });

  it("strips a leading /memories/ prefix before validating the file name", () => {
    expect(resolveMemoryFile("/memories/notes.md", dir)).toEqual({ kind: "file", name: "notes.md" });
  });

  it("accepts a bare *.md name (no /memories/ prefix)", () => {
    expect(resolveMemoryFile("notes.md", dir)).toEqual({ kind: "file", name: "notes.md" });
  });

  it("rejects a path that fails NAME_RE (path separators, non-.md, etc.)", () => {
    for (const bad of ["/memories/../x.md", "/memories/a/b.md", "/memories/x.txt", "../x.md"]) {
      expect(() => resolveMemoryFile(bad, dir), bad).toThrow(MemoryError);
    }
  });

  it("a name that passes NAME_RE resolves under the given dir, with dirname(resolve(dir,name)) === dir (the second guard's happy path)", () => {
    expect(resolveMemoryFile("notes.md", `${dir}/nested`)).toEqual({ kind: "file", name: "notes.md" });
  });
});

describe("writeMemoryFile — provenance (B1)", () => {
  it("write without frontmatter prepends source: agent + updated (injected nowIso)", () => {
    const { paths, cwd, dir } = fixture();
    writeMemoryFile(cwd, "a.md", "body", wopts(), paths);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe(`---\nsource: agent\nupdated: ${NOW}\n---\n\nbody`);
  });

  it("write with frontmatter upserts both keys and preserves pin: true", () => {
    const { paths, cwd, dir } = fixture();
    writeRaw(dir, "a.md", "---\npin: true\n---\n\nbody");
    writeMemoryFile(cwd, "a.md", "---\npin: true\n---\n\nnew body", wopts(), paths);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe(
      `---\npin: true\nsource: agent\nupdated: ${NOW}\n---\n\nnew body`,
    );
  });

  it("append never adds frontmatter to a file that lacks it (R4 pure append)", () => {
    const { paths, cwd, dir } = fixture();
    writeMemoryFile(cwd, "a.md", "plain\n", wopts({ append: true }), paths);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("plain\n");
  });

  it("append does NOT touch existing frontmatter (R4: updated is maintained by write only)", () => {
    // NOTE: §7.3's bullet "append 有 fm → 仅 updated 更新" is stale — §5.3's
    // matrix + R4 pin pure-append semantics (no read-modify-write). Locked here.
    const { paths, cwd, dir } = fixture();
    writeRaw(dir, "a.md", "---\nsource: agent\nupdated: 1999-01-01\n---\n\nbody\n");
    writeMemoryFile(cwd, "a.md", "more\n", wopts({ append: true }), paths);
    const text = readFileSync(join(dir, "a.md"), "utf8");
    expect(text).toBe("---\nsource: agent\nupdated: 1999-01-01\n---\n\nbody\nmore\n");
    expect(text.match(/source: agent/g)).toHaveLength(1); // no duplicate fm
  });
});

describe("importProject", () => {
  function ccFixture(): { paths: MemoryPaths; srcDir: string } {
    const f = fixture();
    const srcDir = join(f.paths.ccProjectsRoot, "-proj-a", "memory");
    mkdirSync(srcDir, { recursive: true });
    return { paths: f.paths, srcDir };
  }

  it("copies files with the pi-toolkit drift-header, 0600, dir 0700", async () => {
    const { paths, srcDir } = ccFixture();
    writeFileSync(join(srcDir, "notes.md"), "cc body");
    const res = await importProject("-proj-a", false, paths);
    const destFile = join(paths.memoryRoot, "-proj-a", "notes.md");
    expect(res).toMatchObject({ project: "-proj-a", files: 1, skipped: 0 });
    expect(readFileSync(destFile, "utf8")).toBe(DRIFT_HEADER + "cc body");
    expect(DRIFT_HEADER).toContain("pi-toolkit `/mem import`");
    expect(statSync(destFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(paths.memoryRoot, "-proj-a")).mode & 0o777).toBe(0o700); // Nit 9
  });

  it("counts bytes with Buffer.byteLength (multibyte fixture, Nit 9)", async () => {
    const { paths, srcDir } = ccFixture();
    writeFileSync(join(srcDir, "cn.md"), "中文"); // 6 bytes, length 2
    const res = await importProject("-proj-a", false, paths);
    expect(res.bytes).toBe(6);
  });

  it("is idempotent (skip) unless force", async () => {
    const { paths, srcDir } = ccFixture();
    writeFileSync(join(srcDir, "notes.md"), "v1");
    await importProject("-proj-a", false, paths);
    const destFile = join(paths.memoryRoot, "-proj-a", "notes.md");
    writeFileSync(destFile, "locally edited");
    const skipped = await importProject("-proj-a", false, paths);
    expect(skipped).toMatchObject({ files: 0, skipped: 1 });
    expect(readFileSync(destFile, "utf8")).toBe("locally edited");
    const forced = await importProject("-proj-a", true, paths);
    expect(forced).toMatchObject({ files: 1, skipped: 0 });
    expect(readFileSync(destFile, "utf8")).toBe(DRIFT_HEADER + "v1");
  });

  it("rejects with a MemoryError when the source project has no memory (async: a rejected Promise, never a synchronous throw)", async () => {
    const { paths } = fixture();
    const call = importProject("-nope", false, paths);
    await expect(call).rejects.toThrow(MemoryError);
  });

  it("import output carries NO provenance frontmatter (drift-header is its provenance)", async () => {
    const { paths, srcDir } = ccFixture();
    writeFileSync(join(srcDir, "notes.md"), "body");
    await importProject("-proj-a", false, paths);
    const text = readFileSync(join(paths.memoryRoot, "-proj-a", "notes.md"), "utf8");
    expect(text).not.toContain("source: agent");
  });
});

describe("discoverCCProjects", () => {
  it("returns [] when the CC root is missing", () => {
    const { paths } = fixture();
    expect(discoverCCProjects(paths)).toEqual([]);
  });

  it("lists only projects with a memory/ dir, sorted", () => {
    const { paths } = fixture();
    mkdirSync(join(paths.ccProjectsRoot, "-b-proj", "memory"), { recursive: true });
    mkdirSync(join(paths.ccProjectsRoot, "-a-proj", "memory"), { recursive: true });
    mkdirSync(join(paths.ccProjectsRoot, "-no-mem"), { recursive: true });
    expect(discoverCCProjects(paths)).toEqual(["-a-proj", "-b-proj"]);
  });

  it("skips entries whose stat explodes (dangling memory symlink, Nit 8)", () => {
    const { paths } = fixture();
    mkdirSync(join(paths.ccProjectsRoot, "-good", "memory"), { recursive: true });
    mkdirSync(join(paths.ccProjectsRoot, "-bad"), { recursive: true });
    symlinkSync(join(paths.ccProjectsRoot, "-bad", "missing-target"), join(paths.ccProjectsRoot, "-bad", "memory"));
    expect(discoverCCProjects(paths)).toEqual(["-good"]);
  });
});

describe("importAll", () => {
  it("aggregates results across discovered projects", async () => {
    const { paths } = fixture();
    for (const slug of ["-a", "-b"]) {
      const dir = join(paths.ccProjectsRoot, slug, "memory");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "n.md"), `body ${slug}`);
    }
    const results = await importAll(false, paths);
    expect(results.map((r) => r.project)).toEqual(["-a", "-b"]);
    expect(results.every((r) => r.files === 1)).toBe(true);
    // second run: everything skipped
    const again = await importAll(false, paths);
    expect(again.every((r) => r.files === 0 && r.skipped === 1)).toBe(true);
  });
});
