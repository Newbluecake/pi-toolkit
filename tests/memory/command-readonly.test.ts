import { createHash } from "node:crypto";
import {
  lstatSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as safeFs from "../../src/memory/safe-fs.js";
import * as lease from "../../src/memory/tidy/lease.js";
import * as txn from "../../src/memory/tidy/txn.js";
import * as jevClient from "../../src/memory/jev/client.js";
import { executeMemoryRead } from "../../src/memory/command-readonly.js";
import { memoryDirFor } from "../../src/memory/paths.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../src/memory/settings.js";

function snapshotTree(root: string): unknown[] {
  const visit = (path: string, relative: string): unknown[] => {
    const stat = lstatSync(path, { bigint: true });
    const entry = {
      path: relative,
      kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      mode: stat.mode.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      sha256: stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : undefined,
    };
    return [
      entry,
      ...(stat.isDirectory()
        ? readdirSync(path)
            .sort()
            .flatMap((name) => visit(join(path, name), join(relative, name)))
        : []),
    ];
  };
  return visit(root, ".");
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("context-free Web memory reads", () => {
  test("path and empty listing do not create memory directories", () => {
    const root = mkdtempSync(join(tmpdir(), "mem-web-read-"));
    roots.push(root);
    const cwd = join(root, "project");
    const paths = { memoryRoot: join(root, "memory"), ccProjectsRoot: join(root, "cc") };
    expect(executeMemoryRead("path", cwd, paths)).toEqual({
      ok: true,
      output: `memory dir: ${memoryDirFor(cwd, paths)}`,
    });
    expect(executeMemoryRead("list", cwd, paths)).toEqual({ ok: true, output: `(no memory for ${cwd})` });
    expect(existsSync(paths.memoryRoot)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
  test("lists real files without changing their bytes or directory contents", () => {
    const root = mkdtempSync(join(tmpdir(), "mem-web-read-"));
    roots.push(root);
    const cwd = join(root, "project");
    const paths = { memoryRoot: join(root, "memory"), ccProjectsRoot: join(root, "cc") };
    const dir = memoryDirFor(cwd, paths);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), "hello");
    const before = snapshotTree(dir);
    expect(executeMemoryRead("list", cwd, paths)).toEqual({ ok: true, output: "  a.md (5B)" });
    expect(snapshotTree(dir)).toEqual(before);
    expect(readdirSync(dir)).toEqual(["a.md"]);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("hello");
  });
  test("restore listings and migration previews preserve a real directory tree", () => {
    const root = mkdtempSync(join(tmpdir(), "mem-web-read-"));
    roots.push(root);
    const cwd = join(root, "project");
    const paths = { memoryRoot: join(root, "memory"), ccProjectsRoot: join(root, "cc") };
    const dir = memoryDirFor(cwd, paths);
    mkdirSync(join(dir, ".trash"), { recursive: true });
    mkdirSync(join(dir, "blocks"));
    writeFileSync(join(dir, "note.md"), "# Topic\n\nExample\n");
    writeFileSync(join(dir, ".trash", "20260101T000000000Z-123-abcdef-old.md"), "old");
    writeFileSync(join(dir, "blocks", ".migration-report.json"), '{"result":"ok"}');
    const forbidden = [
      vi.spyOn(safeFs, "ensureMemoryDir"),
      vi.spyOn(safeFs, "ensurePrivateDir"),
      vi.spyOn(safeFs, "writeTempRegular"),
      vi.spyOn(safeFs, "replaceAtomic"),
      vi.spyOn(lease, "leaseCreate"),
      vi.spyOn(lease, "leaseRefresh"),
      vi.spyOn(txn, "recoverRun"),
      vi.spyOn(jevClient, "createJevClient"),
    ];
    const before = [
      readFileSync(join(dir, "note.md"), "utf8"),
      readFileSync(join(dir, ".trash", "20260101T000000000Z-123-abcdef-old.md"), "utf8"),
      readdirSync(dir).sort(),
      readdirSync(join(dir, "blocks")),
      readdirSync(join(dir, ".trash")),
    ];
    expect(executeMemoryRead("restore --trash", cwd, paths)).toEqual({
      ok: true,
      output: "  20260101T000000000Z-123-abcdef — old.md",
    });
    expect(executeMemoryRead("restore", cwd, paths)).toEqual({
      ok: true,
      output: "  (trash) 20260101T000000000Z-123-abcdef — old.md",
    });
    expect(executeMemoryRead("restore --legacy", cwd, paths)).toEqual(executeMemoryRead("restore", cwd, paths));
    expect(executeMemoryRead("migrate --report", cwd, paths)).toEqual({ ok: true, output: '{"result":"ok"}' });
    const preview = executeMemoryRead("migrate --dry-run", cwd, paths);
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error("preview failed");
    expect(JSON.parse(preview.output).files[0].name).toBe("note.md");
    expect([
      readFileSync(join(dir, "note.md"), "utf8"),
      readFileSync(join(dir, ".trash", "20260101T000000000Z-123-abcdef-old.md"), "utf8"),
      readdirSync(dir).sort(),
      readdirSync(join(dir, "blocks")),
      readdirSync(join(dir, ".trash")),
    ]).toEqual(before);
    expect(readFileSync(join(dir, "blocks", ".migration-report.json"), "utf8")).toBe('{"result":"ok"}');
    for (const spy of forbidden) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
  test.each([
    "tidy --batch --status",
    "tidy --status --batch",
    "tidy --batch --dry-run",
    "tidy --dry-run --batch",
    "tidy --dry-run --frontmatter",
    "tidy --frontmatter --dry-run",
  ])("%s reads a populated tree without mutation or recovery", (args) => {
    const root = mkdtempSync(join(tmpdir(), "mem-web-read-"));
    roots.push(root);
    const cwd = join(root, "project");
    const paths = { memoryRoot: join(root, "memory"), ccProjectsRoot: join(root, "cc") };
    const dir = memoryDirFor(cwd, paths);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "topic.md"), "# Example\n\ncontent\n");
    mkdirSync(join(dir, "archive"));
    mkdirSync(join(dir, ".backup", "20260101T000000000Z-123-abcdef"), { recursive: true });
    writeFileSync(join(dir, ".backup", "20260101T000000000Z-123-abcdef", "manifest.json"), "{}\n");
    writeFileSync(
      join(dir, ".tidy-run.json"),
      JSON.stringify({ pid: 123, host: "test-host", token: "abc", at: 1700000000000, epoch: 0, draining: [] }),
    );
    writeFileSync(join(dir, ".lock"), JSON.stringify({ pid: 123, host: "test-host", at: 1700000000000 }));
    const before = snapshotTree(dir);
    const forbidden = [
      vi.spyOn(safeFs, "ensureMemoryDir"),
      vi.spyOn(safeFs, "ensurePrivateDir"),
      vi.spyOn(safeFs, "writeTempRegular"),
      vi.spyOn(safeFs, "replaceAtomic"),
      vi.spyOn(lease, "leaseCreate"),
      vi.spyOn(lease, "leaseRefresh"),
      vi.spyOn(txn, "recoverRun"),
      vi.spyOn(jevClient, "createJevClient"),
    ];
    try {
      const result = executeMemoryRead(args, cwd, paths, DEFAULT_MEMORY_SETTINGS);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("read failed");
      const expected = args.includes("--status")
        ? "lock: pid 123 on test-host"
        : args.includes("--frontmatter")
          ? '"name": "topic.md"'
          : "archive candidates 0; normalize batches 0; reported 0";
      expect(result.output).toContain(expected);
      if (args.includes("--status")) {
        expect(result.output).toContain("lease: pid 123 on test-host");
        expect(result.output).toContain("invalid manifest:");
      }
      expect(snapshotTree(dir)).toEqual(before);
      for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of forbidden) spy.mockRestore();
    }
  });
  test("tidy respects batch configuration and block layout without mutating either", () => {
    const root = mkdtempSync(join(tmpdir(), "mem-web-read-"));
    roots.push(root);
    const cwd = join(root, "project");
    const paths = { memoryRoot: join(root, "memory"), ccProjectsRoot: join(root, "cc") };
    const dir = memoryDirFor(cwd, paths);
    mkdirSync(dir, { recursive: true });
    const disabled = {
      ...DEFAULT_MEMORY_SETTINGS,
      tidy: { ...DEFAULT_MEMORY_SETTINGS.tidy, batch: { ...DEFAULT_MEMORY_SETTINGS.tidy.batch, enabled: false } },
    };
    for (const args of ["tidy --batch --status", "tidy --batch --dry-run"]) {
      expect(executeMemoryRead(args, cwd, paths, disabled)).toMatchObject({ ok: false, code: "E_MEM_WEB_UNSUPPORTED" });
      expect(executeMemoryRead(args, cwd, paths)).toMatchObject({ ok: false, code: "E_MEM_WEB_UNSUPPORTED" });
    }
    mkdirSync(join(dir, "blocks"));
    writeFileSync(join(dir, "blocks", ".layout.json"), "{}");
    writeFileSync(join(dir, "blocks", "nested.md"), "block content");
    const before = snapshotTree(dir);
    for (const args of ["tidy --batch --status", "tidy --batch --dry-run", "tidy --dry-run --frontmatter"])
      expect(executeMemoryRead(args, cwd, paths, DEFAULT_MEMORY_SETTINGS)).toMatchObject({
        ok: false,
        code: "E_MEM_WEB_UNSUPPORTED",
      });
    expect(snapshotTree(dir)).toEqual(before);
  });
  test.each(["init", "restore --trash 123", "tidy --dry-run", "migrate --status", "list unexpected"])(
    "%s fails closed with no filesystem changes",
    (args) => {
      const root = mkdtempSync(join(tmpdir(), "mem-web-read-"));
      roots.push(root);
      const paths = { memoryRoot: join(root, "memory"), ccProjectsRoot: join(root, "cc") };
      expect(executeMemoryRead(args, join(root, "project"), paths)).toEqual({
        ok: false,
        code: "E_MEM_WEB_UNSUPPORTED",
        message: "该命令暂不支持 Web 通道",
      });
      expect(readdirSync(root)).toEqual([]);
    },
  );
});
