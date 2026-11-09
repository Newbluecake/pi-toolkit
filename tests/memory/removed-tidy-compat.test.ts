import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createMemCommand } from "../../src/memory/command.js";
import { executeMemoryRead } from "../../src/memory/command-readonly.js";
import { classifyMemoryCommand } from "../../src/memory/command-policy.js";
import { wireMemory } from "../../src/memory/index.js";
import { memoryDirFor } from "../../src/memory/paths.js";
import { parseMemorySettings } from "../../src/memory/settings.js";
import { newMemoryId, LEGACY_BACKUP_REFUSAL, LEGACY_BACKUP_RUNBOOK } from "../../src/memory/trash.js";
import * as safeFs from "../../src/memory/safe-fs.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "mem-removed-tidy-"));
  roots.push(root);
  const cwd = join(root, "project"),
    paths = { memoryRoot: join(root, "memory"), ccProjectsRoot: join(root, "cc") };
  const dir = memoryDirFor(cwd, paths);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "core.md"), "---\nsource: agent\n---\n# Core\n- keep the original rule\n");
  mkdirSync(join(dir, "archive"));
  writeFileSync(join(dir, "archive", "old.md"), "archived tidy content");
  for (const [id, raw] of [
    ["old-v1", '{"v":1,"kind":"tidy","entries":[]}'],
    ["old-v2", '{"v":2,"kind":"tidy","events":[]}'],
    ["broken", "not JSON"],
  ]) {
    mkdirSync(join(dir, ".backup", id!), { recursive: true });
    writeFileSync(join(dir, ".backup", id!, "manifest.json"), raw!);
    writeFileSync(join(dir, ".backup", id!, "journal.jsonl"), "invalid interrupted journal\n");
  }
  writeFileSync(join(dir, ".tidy-run.json"), "invalid old lease");
  const notes: { text: string; level: string | undefined }[] = [];
  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui",
    sessionManager: { getSessionId: () => root },
    ui: { notify: (text: string, level?: string) => notes.push({ text, level }) },
  } as unknown as ExtensionCommandContext;
  return { cwd, paths, dir, notes, ctx };
}
function tree(path: string): unknown {
  const st = lstatSync(path);
  return st.isDirectory()
    ? Object.fromEntries(
        readdirSync(path)
          .sort()
          .map((n) => [n, tree(join(path, n))]),
      )
    : readFileSync(path, "utf8");
}

test.each(["tiered", "legacy", "blocks"] as const)(
  "%s startup and reads ignore leftover tidy data, even corrupt journals, without changing disk",
  async (layout) => {
    const f = setup();
    vi.stubEnv("ARMORY_MEMORY_ROOT", f.paths.memoryRoot);
    const handlers = new Map<string, ((...args: any[]) => unknown)[]>();
    const pi = {
      on: (name: string, fn: (...args: any[]) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
      registerTool: () => {},
      registerCommand: () => {},
    } as unknown as ExtensionAPI;
    const settings = parseMemorySettings({
      layout,
      migrate: { auto: false },
      governance: { enabled: false },
      jev: { enabled: false },
      scopes: { session: false, hub: false },
    });
    const before = tree(f.dir);
    wireMemory(pi, { settings, isChildSession: false, sections: { register: () => {} } as never });
    for (const fn of handlers.get("session_start") ?? []) await fn({ reason: "startup" }, f.ctx);
    expect(f.notes.some((n) => n.level === "error")).toBe(false);
    const cmd = createMemCommand({ paths: f.paths, settings });
    await cmd.handler("list", f.ctx);
    expect(f.notes.at(-1)?.text).toContain("core.md");
    await cmd.handler("doctor", f.ctx);
    expect(f.notes.at(-1)?.text).toContain("/mem doctor");
    expect(executeMemoryRead("list", f.cwd, f.paths)).toMatchObject({
      ok: true,
      output: expect.stringContaining("core.md"),
    });
    expect(tree(f.dir)).toEqual(before);
    for (const fn of handlers.get("session_shutdown") ?? []) await fn({ reason: "quit" }, f.ctx);
  },
);

test.each([
  "restore",
  "restore old-v1",
  "restore old-v2",
  "restore broken",
  "restore --legacy",
  "restore --legacy old-v1",
])("%s clearly refuses removed backups without opening or changing any manifest", async (args) => {
  const f = setup(),
    before = tree(f.dir);
  const read = vi.spyOn(safeFs, "readRegular");
  await createMemCommand({ paths: f.paths }).handler(args, f.ctx);
  expect(f.notes.at(-1)).toMatchObject({
    level: "warning",
    text: expect.stringContaining("Legacy tidy backups are no longer supported"),
  });
  expect(f.notes.at(-1)?.text).toBe(`memory error: ${LEGACY_BACKUP_REFUSAL}`);
  for (const step of [
    "Stop all memory writers",
    "verify the real memory directory",
    "complete backup including hidden files",
    "read-only",
    "separate directory",
    "without overwriting live files",
    "never remove a lock based on age",
    "Do not pass old backup IDs/files to --trash, --block or migrate",
    "Stop on damaged or unknown data",
    LEGACY_BACKUP_RUNBOOK,
  ])
    expect(f.notes.at(-1)?.text).toContain(step);
  expect(executeMemoryRead(args, f.cwd, f.paths)).toEqual({
    ok: false,
    code: "E_MEM_WEB_UNSUPPORTED",
    message: LEGACY_BACKUP_REFUSAL,
  });
  expect(read).not.toHaveBeenCalled();
  read.mockRestore();
  expect(tree(f.dir)).toEqual(before);
});

test("files trash recovery ignores obsolete leases/backups, and conflicts never overwrite either copy", async () => {
  const f = setup(),
    id = newMemoryId(new Date("2026-11-09T00:00:00Z"), 42, "abcdef");
  expect(id).toBe("20261109T000000000Z-42-abcdef");
  mkdirSync(join(f.dir, ".trash"));
  const source = join(f.dir, ".trash", `${id}-note.md`);
  writeFileSync(source, "recover me");
  const backup = tree(join(f.dir, ".backup"));
  const cmd = createMemCommand({ paths: f.paths });
  await cmd.handler("restore --trash", f.ctx);
  expect(f.notes.at(-1)?.text).toContain(`${id} — note.md`);
  writeFileSync(join(f.dir, "note.md"), "keep live");
  await cmd.handler(`restore --trash ${id}`, f.ctx);
  expect(f.notes.at(-1)?.text).toContain("already exists");
  expect(readFileSync(join(f.dir, "note.md"), "utf8")).toBe("keep live");
  expect(readFileSync(source, "utf8")).toBe("recover me");
  rmSync(join(f.dir, "note.md"));
  await cmd.handler(`restore --trash ${id}`, f.ctx);
  expect(f.notes.at(-1)?.text).toBe("restore --trash: restored");
  expect(readFileSync(join(f.dir, "note.md"), "utf8")).toBe("recover me");
  expect(existsSync(source)).toBe(false);
  expect(tree(join(f.dir, ".backup"))).toEqual(backup);
  expect(readFileSync(join(f.dir, ".tidy-run.json"), "utf8")).toBe("invalid old lease");
});

test("file trash rejects denied gates and symlinked sources", async () => {
  const f = setup(),
    id = "20261109T000000000Z-42-abcdef";
  mkdirSync(join(f.dir, ".trash"));
  const source = join(f.dir, ".trash", `${id}-note.md`);
  writeFileSync(source, "safe");
  const gate = { check: () => ({ ok: false as const, reason: "locked" as const }), capture: () => {} };
  await createMemCommand({ paths: f.paths, writeGate: gate }).handler(`restore --trash ${id}`, f.ctx);
  expect(f.notes.at(-1)?.text).toContain("E_WRITE_GATE");
  expect(readFileSync(source, "utf8")).toBe("safe");
  rmSync(source);
  symlinkSync(join(f.dir, "core.md"), source);
  await createMemCommand({ paths: f.paths }).handler(`restore --trash ${id}`, f.ctx);
  expect(f.notes.at(-1)?.text).toMatch(/symlink/);
  expect(existsSync(join(f.dir, "note.md"))).toBe(false);
});

test.each([
  "tidy",
  "tidy --dry-run",
  "tidy --frontmatter",
  "tidy --batch --status",
  "tidy --batch --dry-run",
  "tidy --break-lock",
])("%s is unknown, has no completions, and has no direct Web read executor", (args) => {
  const f = setup(),
    before = tree(f.dir),
    cmd = createMemCommand({ paths: f.paths });
  expect(classifyMemoryCommand(args)).toBe("unknown");
  expect(cmd.getArgumentCompletions(args)).toEqual([]);
  expect(cmd.description).not.toContain("tidy");
  expect(executeMemoryRead(args, f.cwd, f.paths)).toMatchObject({ ok: false, code: "E_MEM_WEB_UNSUPPORTED" });
  expect(tree(f.dir)).toEqual(before);
});

test("default blocks startup can migrate files despite corrupt retired leases and backups", async () => {
  const f = setup();
  vi.stubEnv("ARMORY_MEMORY_ROOT", f.paths.memoryRoot);
  const handlers = new Map<string, ((...args: any[]) => unknown)[]>();
  const pi = {
    on: (name: string, fn: (...args: any[]) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    registerTool: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  const settings = parseMemorySettings({
    governance: { enabled: false },
    jev: { enabled: false },
    scopes: { session: false, hub: false },
  });
  expect(settings.layout).toBe("blocks");
  expect(settings.migrate.auto).toBe(true);
  const oldBackups = tree(join(f.dir, ".backup")),
    oldArchive = tree(join(f.dir, "archive"));
  wireMemory(pi, { settings, isChildSession: false, sections: { register: () => {} } as never });
  for (const fn of handlers.get("session_start") ?? []) await fn({ reason: "startup" }, f.ctx);
  expect(f.notes.some((n) => n.text.includes("memory: migrated 1 files"))).toBe(true);
  expect(existsSync(join(f.dir, "blocks", ".layout.json"))).toBe(true);
  const report = JSON.parse(readFileSync(join(f.dir, "blocks", ".migration-report.json"), "utf8"));
  expect(report.files.map((f: { name: string }) => f.name)).toEqual(["core.md"]);
  expect(tree(join(f.dir, ".backup"))).toEqual(oldBackups);
  expect(tree(join(f.dir, "archive"))).toEqual(oldArchive);
  expect(readFileSync(join(f.dir, ".tidy-run.json"), "utf8")).toBe("invalid old lease");
  for (const fn of handlers.get("session_shutdown") ?? []) await fn({ reason: "quit" }, f.ctx);
});
