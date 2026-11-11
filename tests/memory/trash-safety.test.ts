import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createMemCommand } from "../../src/memory/command.js";
import { restoreFromTrash } from "../../src/memory/trash.js";
import { memoryDirFor } from "../../src/memory/paths.js";
import { renameNoClobber } from "../../src/memory/safe-fs.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: vi.fn(actual.linkSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    renameSync: vi.fn(actual.renameSync),
  };
});
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
const roots: string[] = [];
beforeEach(() => {
  vi.mocked(fs.linkSync).mockImplementation(actual.linkSync);
  vi.mocked(fs.unlinkSync).mockImplementation(actual.unlinkSync);
  vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
  vi.clearAllMocks();
});
afterEach(() => {
  for (const root of roots.splice(0)) actual.rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = actual.mkdtempSync(join(tmpdir(), "restore-strict-"));
  roots.push(root);
  const cwd = join(root, "project"),
    paths = { memoryRoot: join(root, "memory"), ccProjectsRoot: join(root, "cc") };
  const dir = memoryDirFor(cwd, paths),
    id = "20261109T000000000Z-42-abcdef";
  actual.mkdirSync(join(dir, ".trash"), { recursive: true });
  const source = join(dir, ".trash", `${id}-note.md`),
    target = join(dir, "note.md");
  actual.writeFileSync(source, "trash bytes");
  const notes: { text: string; level: string }[] = [];
  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui",
    ui: { notify: (text: string, level: string) => notes.push({ text, level }) },
  } as unknown as ExtensionCommandContext;
  const afterWrite = vi.fn();
  const command = createMemCommand({ paths, onAfterWrite: afterWrite });
  return { cwd, paths, dir, id, source, target, ctx, command, notes, afterWrite };
}
function fail(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`forced ${code}`), { code });
}
function noSourceRename(source: string): void {
  expect(vi.mocked(fs.renameSync).mock.calls.filter(([src]) => String(src) === source)).toEqual([]);
}

test.each(["EPERM", "ENOTSUP", "EXDEV"])(
  "%s cannot downgrade file restore to check-then-rename, even when a competing target appears",
  async (code) => {
    for (const race of [false, true]) {
      const f = setup();
      vi.mocked(fs.linkSync).mockImplementation((src, dst) => {
        if (String(src) === f.source) {
          if (race) actual.writeFileSync(dst, "external writer");
          throw fail(code);
        }
        actual.linkSync(src, dst);
      });
      await expect(restoreFromTrash(f.cwd, f.id, "skip", f.paths)).rejects.toMatchObject({
        code: "NO_HARDLINK",
        mutated: false,
      });
      expect(actual.readFileSync(f.source, "utf8")).toBe("trash bytes");
      if (race) expect(actual.readFileSync(f.target, "utf8")).toBe("external writer");
      else expect(actual.existsSync(f.target)).toBe(false);
      noSourceRename(f.source);
    }
  },
);

test("an atomic link sees a concurrently created destination as EEXIST and keeps both originals", async () => {
  const f = setup();
  vi.mocked(fs.linkSync).mockImplementation((src, dst) => {
    if (String(src) === f.source) actual.writeFileSync(dst, "external writer");
    actual.linkSync(src, dst);
  });
  await expect(restoreFromTrash(f.cwd, f.id, "skip", f.paths)).rejects.toMatchObject({
    code: "EXISTS",
    mutated: false,
  });
  expect(actual.readFileSync(f.source, "utf8")).toBe("trash bytes");
  expect(actual.readFileSync(f.target, "utf8")).toBe("external writer");
  noSourceRename(f.source);
});

test("native no-link refusal is a warning error, never a restored notice or write callback", async () => {
  const f = setup();
  vi.mocked(fs.linkSync).mockImplementation((src, dst) => {
    if (String(src) === f.source) {
      actual.writeFileSync(dst, "external writer");
      throw fail("EPERM");
    }
    actual.linkSync(src, dst);
  });
  await f.command.handler(`restore --trash ${f.id}`, f.ctx);
  expect(f.notes.at(-1)).toMatchObject({
    level: "warning",
    text: expect.stringContaining("Restore refused: atomic no-clobber link unavailable"),
  });
  expect(f.notes.some((n) => n.text.includes("restore --trash: restored"))).toBe(false);
  expect(f.afterWrite).not.toHaveBeenCalled();
  expect(actual.readFileSync(f.source, "utf8")).toBe("trash bytes");
  expect(actual.readFileSync(f.target, "utf8")).toBe("external writer");
});

test.each([false, true])(
  "link/unlink half-state (unlink completed=%s) is explicitly mutated and never pretends nothing happened",
  async (unlinked) => {
    const f = setup();
    vi.mocked(fs.unlinkSync).mockImplementation((path) => {
      if (String(path) === f.source) {
        if (unlinked) actual.unlinkSync(path);
        throw fail("EIO");
      }
      actual.unlinkSync(path);
    });
    await expect(restoreFromTrash(f.cwd, f.id, "skip", f.paths)).rejects.toMatchObject({
      code: "RESTORE_PARTIAL",
      mutated: true,
      message: expect.stringContaining("destination may have changed"),
    });
    expect(actual.readFileSync(f.target, "utf8")).toBe("trash bytes");
    expect(actual.existsSync(f.source)).toBe(!unlinked);
    noSourceRename(f.source);
  },
);

test("native partial restore reports both-path inspection and invalidates caches without reporting success", async () => {
  const f = setup();
  vi.mocked(fs.unlinkSync).mockImplementation((path) => {
    if (String(path) === f.source) throw fail("EIO");
    actual.unlinkSync(path);
  });
  await f.command.handler(`restore --trash ${f.id}`, f.ctx);
  expect(f.notes.at(-1)).toMatchObject({
    level: "warning",
    text: expect.stringContaining("destination may have changed"),
  });
  expect(f.notes.at(-1)?.text).toContain("inspect both");
  expect(f.notes.at(-1)?.text).not.toContain("effect:none");
  expect(f.notes.some((n) => n.text.includes("restore --trash: restored"))).toBe(false);
  expect(f.afterWrite).toHaveBeenCalledTimes(1);
  expect(f.afterWrite).toHaveBeenCalledWith(f.cwd);
  expect(actual.readFileSync(f.source, "utf8")).toBe("trash bytes");
  expect(actual.readFileSync(f.target, "utf8")).toBe("trash bytes");
});

test("successful strict restore links and removes only the source", async () => {
  const f = setup();
  await expect(restoreFromTrash(f.cwd, f.id, "skip", f.paths)).resolves.toEqual({ restored: true });
  expect(actual.readFileSync(f.target, "utf8")).toBe("trash bytes");
  expect(actual.existsSync(f.source)).toBe(false);
  noSourceRename(f.source);
});

test("legacy rename callers keep their existing unsupported-link fallback and note", () => {
  const f = setup();
  vi.mocked(fs.linkSync).mockImplementation(() => {
    throw fail("EPERM");
  });
  expect(renameNoClobber(f.dir, join(".trash", `${f.id}-note.md`), "note.md")).toEqual({
    note: "non-atomic rename (no hard links)",
  });
  expect(actual.readFileSync(f.target, "utf8")).toBe("trash bytes");
  expect(actual.existsSync(f.source)).toBe(false);
  expect(vi.mocked(fs.renameSync).mock.calls.some(([src]) => String(src) === f.source)).toBe(true);
});
