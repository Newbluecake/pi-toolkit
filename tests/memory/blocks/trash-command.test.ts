import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../../src/config/settings.js";
import { createMemCommand } from "../../../src/memory/command.js";
import { createMemoryToolV3 } from "../../../src/memory/tool-v3.js";
import { memoryDirFor } from "../../../src/memory/paths.js";
import { parseBlockFile } from "../../../src/memory/blocks/format.js";
import { listTrashEntries } from "../../../src/memory/trash.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "mem-trash-command-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const paths = { memoryRoot: join(root, "memory"), ccProjectsRoot: join(root, "cc") };
  const dir = memoryDirFor(cwd, paths),
    blocks = join(dir, "blocks");
  const notes: string[] = [];
  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui",
    ui: { notify: (text: string) => notes.push(text) },
  } as unknown as ExtensionContext & ExtensionCommandContext;
  const settings = DEFAULT_SETTINGS.memory;
  const tool = createMemoryToolV3({ settings, paths, isChildSession: false, onAfterWrite: () => {} });
  const cmd = createMemCommand({ paths, settings });
  return { cwd, dir, blocks, paths, notes, ctx, tool, cmd };
}
async function deleted(f: ReturnType<typeof setup>) {
  await f.tool.execute("1", { command: "create", topic: "quota", text: "- recover me" }, undefined, undefined, f.ctx);
  const name = "quota.001.md";
  const raw = readFileSync(join(f.blocks, name), "utf8");
  const block = parseBlockFile(name, raw);
  if ("stray" in block) throw new Error("invalid block");
  await f.tool.execute("2", { command: "delete", path: block.id, rev: block.rev }, undefined, undefined, f.ctx);
  return { block, name, id: listTrashEntries(f.blocks)[0]!.id };
}
test("default command route lists and restores deleted block with exact body and rev", async () => {
  const f = setup();
  const b = await deleted(f);
  await f.cmd.handler("restore --trash", f.ctx);
  expect(f.notes.at(-1)).toContain(`${b.id} — ${b.name}`);
  await f.cmd.handler(`restore --trash ${b.id}`, f.ctx);
  expect(f.notes.at(-1)).toContain("restored quota.001.md");
  const restored = parseBlockFile(b.name, readFileSync(join(f.blocks, b.name), "utf8"));
  expect("stray" in restored).toBe(false);
  if ("stray" in restored) throw new Error("stray");
  expect(restored.body).toBe(b.block.body);
  expect(restored.rev).toBe(b.block.rev);
  await f.cmd.handler("restore --trash", f.ctx);
  expect(f.notes.at(-1)).toBe("trash is empty");
});
test("conflicts and denied gate leave both copies intact", async () => {
  const f = setup();
  const b = await deleted(f);
  writeFileSync(join(f.blocks, b.name), "existing");
  await f.cmd.handler(`restore --trash ${b.id}`, f.ctx);
  expect(f.notes.at(-1)).toContain("already exists");
  expect(readFileSync(join(f.blocks, b.name), "utf8")).toBe("existing");
  rmSync(join(f.blocks, b.name));
  const gate = { check: () => ({ ok: false as const, reason: "locked" as const }), capture: () => {} };
  await createMemCommand({ paths: f.paths, writeGate: gate }).handler(`restore --trash ${b.id}`, f.ctx);
  expect(f.notes.at(-1)).toContain("E_WRITE_GATE");
  expect(existsSync(join(f.blocks, b.name))).toBe(false);
  expect(listTrashEntries(f.blocks)).toHaveLength(1);
});
test("files trash stays separate and invalid blocks path fails closed", async () => {
  const f = setup();
  mkdirSync(join(f.dir, ".trash"), { recursive: true });
  const id = "20261109T000000000Z-42-abcdef";
  writeFileSync(join(f.dir, ".trash", `${id}-old.md`), "legacy");
  writeFileSync(join(f.dir, "live.md"), "legacy");
  await f.cmd.handler("restore --trash", f.ctx);
  expect(f.notes.at(-1)).toContain(`${id} — old.md`);
  await f.cmd.handler(`restore --trash ${id}`, f.ctx);
  expect(readFileSync(join(f.dir, "old.md"), "utf8")).toBe("legacy");
  writeFileSync(join(f.dir, ".trash", `${id}-old.md`), "legacy");
  symlinkSync(f.dir, f.blocks);
  await f.cmd.handler("restore --trash", f.ctx);
  expect(f.notes.at(-1)).toContain("E_UNMIGRATED");
  rmSync(f.blocks);
  rmSync(join(f.dir, "live.md"));
  rmSync(join(f.dir, "old.md"));
  const b = await deleted(f);
  await f.cmd.handler("restore --trash", f.ctx);
  expect(f.notes.at(-1)).toContain(b.id);
  expect(f.notes.at(-1)).not.toContain(id);
  await f.cmd.handler(`restore --trash ${id}`, f.ctx);
  expect(f.notes.at(-1)).toContain("no trash entry");
});

test("trash file symlinks are never followed during restore", async () => {
  const f = setup();
  const b = await deleted(f);
  const entry = listTrashEntries(f.blocks)[0]!;
  const target = join(f.dir, "outside.txt");
  writeFileSync(target, b.block.raw);
  rmSync(join(f.blocks, ".trash", entry.fileName));
  symlinkSync(target, join(f.blocks, ".trash", entry.fileName));
  await f.cmd.handler(`restore --trash ${b.id}`, f.ctx);
  expect(f.notes.at(-1)).toMatch(/symlink|regular|ELOOP/i);
  expect(existsSync(join(f.blocks, b.name))).toBe(false);
  expect(readFileSync(target, "utf8")).toBe(b.block.raw);
});
