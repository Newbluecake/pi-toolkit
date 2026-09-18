// memory-plan §7.5: the `memory` tool, driven directly (no fakePi needed —
// createMemoryTool returns the ToolDefinition; the inline fake ctx is the
// only pi surface it touches). No shared mocks; per-test tmpdir + paths
// injection, never the real ~/.pi/agent/memory.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type MemorySettings } from "../../src/config/settings.js";
import { forgetWorktreeOrigin, recordWorktreeOrigin } from "../../src/core/worktree-origin.js";
import { memoryDirFor, type MemoryPaths } from "../../src/memory/paths.js";
import { createMemoryTool, type MemoryToolParams } from "../../src/memory/tool.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Fixture {
  tmp: string;
  cwd: string;
  paths: MemoryPaths;
}

function fixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-tool-"));
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  return { tmp, cwd, paths: { memoryRoot: join(tmp, "mem"), ccProjectsRoot: join(tmp, "cc") } };
}

function fakeCtx(cwd: string, opts: { hasUI?: boolean } = {}) {
  const notifications: { message: string; level?: string }[] = [];
  const hasUI = opts.hasUI !== false;
  const ctx = {
    mode: hasUI ? "tui" : "rpc",
    hasUI,
    cwd,
    ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
  } as unknown as ExtensionContext;
  return { ctx, notifications };
}

function makeTool(fx: Fixture, over: { settings?: Partial<MemorySettings>; isChildSession?: boolean } = {}) {
  const onAfterWrite = vi.fn();
  const tool = createMemoryTool({
    settings: { ...DEFAULT_SETTINGS.memory, ...over.settings },
    isChildSession: over.isChildSession ?? false,
    onAfterWrite,
    paths: fx.paths,
  });
  return { tool, onAfterWrite };
}

async function exec(
  tool: ReturnType<typeof createMemoryTool>,
  params: Partial<MemoryToolParams>,
  ctx: ExtensionContext,
) {
  return (await tool.execute("call-1", params, undefined, undefined, ctx)) as {
    content: { type: string; text: string }[];
  };
}

function textOf(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((c) => c.text).join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("memory tool (§7.5)", () => {
  test("list on an empty directory hints at /mem import and does not call onAfterWrite", async () => {
    const fx = fixture();
    const { tool, onAfterWrite } = makeTool(fx);
    const { ctx } = fakeCtx(fx.cwd);
    const result = await exec(tool, { action: "list" }, ctx);
    expect(textOf(result)).toContain("No memory");
    expect(textOf(result)).toContain("/mem import");
    expect(onAfterWrite).not.toHaveBeenCalled();
  });

  test("action defaults to list; non-empty output carries name and size", async () => {
    const fx = fixture();
    const dir = memoryDirFor(fx.cwd, fx.paths);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "decisions.md"), "use ESM\n");
    const { tool } = makeTool(fx);
    const { ctx } = fakeCtx(fx.cwd);
    const result = await exec(tool, {}, ctx);
    expect(textOf(result)).toContain("decisions.md");
    expect(textOf(result)).toContain("8B"); // "use ESM\n" is 8 bytes
  });

  test("write persists with provenance frontmatter and fires onAfterWrite once", async () => {
    const fx = fixture();
    const { tool, onAfterWrite } = makeTool(fx);
    const { ctx, notifications } = fakeCtx(fx.cwd);
    const result = await exec(tool, { action: "write", name: "notes.md", content: "hello 世界" }, ctx);
    const onDisk = readFileSync(join(memoryDirFor(fx.cwd, fx.paths), "notes.md"), "utf8");
    expect(onDisk).toContain("source: agent");
    expect(onDisk).toContain("hello 世界");
    expect(textOf(result)).toContain("notes.md");
    expect(onAfterWrite).toHaveBeenCalledTimes(1);
    expect(onAfterWrite).toHaveBeenCalledWith(fx.cwd);
    // B1: main-session write notifies with file name + byte count.
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.message).toContain("memory write: notes.md");
    expect(notifications[0]!.message).toMatch(/\+\d+B/);
  });

  test("write without name/content THROWS (Nit 13: no Error-as-text)", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    const { ctx } = fakeCtx(fx.cwd);
    await expect(exec(tool, { action: "write", content: "x" }, ctx)).rejects.toThrow(/requires 'name'/);
    await expect(exec(tool, { action: "write", name: "a.md" }, ctx)).rejects.toThrow(/requires 'content'/);
    await expect(exec(tool, { action: "append", name: "a.md" }, ctx)).rejects.toThrow(/requires 'content'/);
  });

  test("illegal file names throw", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    const { ctx } = fakeCtx(fx.cwd);
    for (const name of ["../x.md", "a/b.md", "x.txt", ".md", ".."]) {
      await expect(exec(tool, { action: "write", name, content: "x" }, ctx)).rejects.toThrow();
    }
  });

  test("append accumulates across calls", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    const { ctx } = fakeCtx(fx.cwd);
    await exec(tool, { action: "append", name: "log.md", content: "first" }, ctx);
    await exec(tool, { action: "append", name: "log.md", content: "second" }, ctx);
    const onDisk = readFileSync(join(memoryDirFor(fx.cwd, fx.paths), "log.md"), "utf8");
    expect(onDisk).toContain("first");
    expect(onDisk).toContain("second");
    expect(onDisk.indexOf("first")).toBeLessThan(onDisk.indexOf("second"));
  });

  test("B1: child sessions reject write/append by default but can list", async () => {
    const fx = fixture();
    const { tool, onAfterWrite } = makeTool(fx, { isChildSession: true });
    const { ctx } = fakeCtx(fx.cwd);
    await expect(exec(tool, { action: "write", name: "a.md", content: "x" }, ctx)).rejects.toThrow(
      /child sessions are read-only/,
    );
    await expect(exec(tool, { action: "append", name: "a.md", content: "x" }, ctx)).rejects.toThrow(
      /child sessions are read-only/,
    );
    expect(onAfterWrite).not.toHaveBeenCalled();
    const listed = await exec(tool, { action: "list" }, ctx);
    expect(textOf(listed)).toContain("No memory");
  });

  test("B1: allowWriteInChildSessions=true lets a child session write", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx, {
      isChildSession: true,
      settings: { allowWriteInChildSessions: true },
    });
    const { ctx } = fakeCtx(fx.cwd);
    await exec(tool, { action: "write", name: "a.md", content: "from child" }, ctx);
    expect(readFileSync(join(memoryDirFor(fx.cwd, fx.paths), "a.md"), "utf8")).toContain("from child");
  });

  test("B1: hasUI=false stays silent (no notify)", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    const { ctx, notifications } = fakeCtx(fx.cwd, { hasUI: false });
    await exec(tool, { action: "write", name: "a.md", content: "x" }, ctx);
    expect(notifications).toHaveLength(0);
  });

  test("B3: a worktree cwd writes into the main repository memory dir", async () => {
    const fx = fixture();
    const mainCwd = join(fx.tmp, "main");
    const wtCwd = join(fx.tmp, "wt");
    mkdirSync(mainCwd, { recursive: true });
    mkdirSync(wtCwd, { recursive: true });
    recordWorktreeOrigin(wtCwd, mainCwd);
    try {
      const { tool } = makeTool(fx);
      const { ctx } = fakeCtx(wtCwd);
      await exec(tool, { action: "write", name: "wt.md", content: "via worktree" }, ctx);
      const { realpathSync } = await import("node:fs");
      const mainDir = memoryDirFor(realpathSync(mainCwd), fx.paths);
      expect(existsSync(join(mainDir, "wt.md"))).toBe(true);
      // nothing leaked into a worktree-keyed dir
      expect(existsSync(memoryDirFor(realpathSync(wtCwd), fx.paths))).toBe(false);
    } finally {
      forgetWorktreeOrigin(wtCwd);
    }
  });
});
