// memory-plan §7.6: the `/mem` command handler. Driven directly with an
// inline fake ExtensionCommandContext; per-test tmpdir + paths injection.

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createMemCommand } from "../../src/memory/command.js";
import { forgetWorktreeOrigin, recordWorktreeOrigin } from "../../src/core/worktree-origin.js";
import { memoryDirFor, toSlug, type MemoryPaths } from "../../src/memory/paths.js";
import { DRIFT_HEADER } from "../../src/memory/store.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Fixture {
  tmp: string;
  cwd: string;
  paths: MemoryPaths;
}

function fixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-cmd-"));
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
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}

/** A fake Claude Code project with a memory/ subdir under the fixture CC root. */
function ccProject(fx: Fixture, slug: string, files: Record<string, string>): void {
  const dir = join(fx.paths.ccProjectsRoot, slug, "memory");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
}

describe("/mem command (§7.6)", () => {
  test("no args lists; empty dir prints the import hint", async () => {
    const fx = fixture();
    const cmd = createMemCommand({ paths: fx.paths });
    const { ctx, notifications } = fakeCtx(fx.cwd);
    await cmd.handler("", ctx);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.message).toContain("/mem import");
    expect(notifications[0]!.level).toBe("info");
  });

  test("list shows files with sizes", async () => {
    const fx = fixture();
    const dir = memoryDirFor(fx.cwd, fx.paths);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), "12345");
    const cmd = createMemCommand({ paths: fx.paths });
    const { ctx, notifications } = fakeCtx(fx.cwd);
    await cmd.handler("list", ctx);
    expect(notifications[0]!.message).toContain("a.md");
    expect(notifications[0]!.message).toContain("5B");
    // auto-scaling unit: a >1KiB file renders as kB, not raw bytes
    writeFileSync(join(dir, "big.md"), "x".repeat(5626));
    await cmd.handler("list", ctx);
    expect(notifications[1]!.message).toContain("big.md (5.5kB)");
  });

  test("path prints the memory dir", async () => {
    const fx = fixture();
    const cmd = createMemCommand({ paths: fx.paths });
    const { ctx, notifications } = fakeCtx(fx.cwd);
    await cmd.handler("path", ctx);
    expect(notifications[0]!.message).toContain(memoryDirFor(fx.cwd, fx.paths));
  });

  test("import with no CC projects warns", async () => {
    const fx = fixture();
    const cmd = createMemCommand({ paths: fx.paths });
    const { ctx, notifications } = fakeCtx(fx.cwd);
    await cmd.handler("import", ctx);
    expect(notifications[0]!.level).toBe("warning");
    expect(notifications[0]!.message).toContain("No Claude Code projects");
  });

  test("import (bare) imports every discovered CC project with the new drift header", async () => {
    const fx = fixture();
    ccProject(fx, "-Users-x-a", { "one.md": "AAA" });
    ccProject(fx, "-Users-x-b", { "two.md": "BBB", "three.md": "CCC" });
    // projects without a memory/ subdir are not discovered
    mkdirSync(join(fx.paths.ccProjectsRoot, "-Users-x-empty"), { recursive: true });
    const cmd = createMemCommand({ paths: fx.paths });
    const { ctx, notifications } = fakeCtx(fx.cwd);
    await cmd.handler("import", ctx);
    const msg = notifications[0]!.message;
    expect(msg).toContain("3 file(s)");
    expect(msg).toContain("-Users-x-a");
    expect(msg).toContain("-Users-x-b");
    const { readFileSync } = await import("node:fs");
    const imported = readFileSync(join(fx.paths.memoryRoot, "-Users-x-a", "one.md"), "utf8");
    expect(imported).toContain(DRIFT_HEADER.split("\n")[0]!.slice(0, 20));
    expect(imported).toContain("AAA");
  });

  test("import is idempotent (skip) and --force overwrites", async () => {
    const fx = fixture();
    ccProject(fx, "-Users-x-a", { "one.md": "v1" });
    const cmd = createMemCommand({ paths: fx.paths });
    const first = fakeCtx(fx.cwd);
    await cmd.handler("import all", first.ctx);
    const second = fakeCtx(fx.cwd);
    await cmd.handler("import all", second.ctx);
    expect(second.notifications[0]!.message).toContain("1 skipped");
    // local edit survives a plain re-import
    const target = join(fx.paths.memoryRoot, "-Users-x-a", "one.md");
    const { readFileSync } = await import("node:fs");
    writeFileSync(join(fx.paths.ccProjectsRoot, "-Users-x-a", "memory", "one.md"), "v2");
    const third = fakeCtx(fx.cwd);
    await cmd.handler("import --force all", third.ctx);
    expect(readFileSync(target, "utf8")).toContain("v2");
  });

  test("import <slug> imports a single project; unknown slug warns, never throws", async () => {
    const fx = fixture();
    ccProject(fx, toSlug(fx.cwd), { "mine.md": "M" });
    const cmd = createMemCommand({ paths: fx.paths });
    const ok = fakeCtx(fx.cwd);
    await cmd.handler(`import ${toSlug(fx.cwd)}`, ok.ctx);
    expect(ok.notifications[0]!.message).toContain("1 file(s)");
    const bad = fakeCtx(fx.cwd);
    await cmd.handler("import -no-such-project", bad.ctx);
    expect(bad.notifications[0]!.level).toBe("warning");
    expect(bad.notifications[0]!.message).toContain("memory error");
  });

  test("todo #22 §3.3: an explicit slug list is serial — the first rejection stops the batch, already-imported slugs keep their files", async () => {
    const fx = fixture();
    ccProject(fx, "a", { "a.md": "A" });
    ccProject(fx, "c", { "c.md": "C" });
    const cmd = createMemCommand({ paths: fx.paths });
    const { ctx, notifications } = fakeCtx(fx.cwd);
    await cmd.handler("import a bad c", ctx);
    expect(notifications[0]!.level).toBe("warning");
    expect(notifications[0]!.message).toContain("memory error");
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(fx.paths.memoryRoot, "a", "a.md"))).toBe(true); // "a" imported before the failure
    expect(existsSync(join(fx.paths.memoryRoot, "c"))).toBe(false); // "c" never reached
  });

  test("todo #22 §1's “顺手修”: /mem cwd resolves worktree origin, matching the tool/inject hook (B3)", async () => {
    const fx = fixture();
    const mainCwd = join(fx.tmp, "main");
    const wtCwd = join(fx.tmp, "wt");
    mkdirSync(mainCwd, { recursive: true });
    mkdirSync(wtCwd, { recursive: true });
    recordWorktreeOrigin(wtCwd, mainCwd);
    try {
      const cmd = createMemCommand({ paths: fx.paths });
      const { ctx, notifications } = fakeCtx(wtCwd);
      await cmd.handler("path", ctx);
      expect(notifications[0]!.message).toContain(memoryDirFor(realpathSync(mainCwd), fx.paths));
      expect(notifications[0]!.message).not.toContain(memoryDirFor(wtCwd, fx.paths));
    } finally {
      forgetWorktreeOrigin(wtCwd);
    }
  });
});

describe("/mem getArgumentCompletions", () => {
  test("empty prefix returns all subcommands", () => {
    const fx = fixture();
    const cmd = createMemCommand({ paths: fx.paths });
    const items = cmd.getArgumentCompletions("")!;
    expect(items.map((i) => i.value).sort()).toEqual(["doctor", "import", "list", "path", "restore", "tidy"]);
  });

  test("prefix filters subcommands", () => {
    const fx = fixture();
    const cmd = createMemCommand({ paths: fx.paths });
    expect(cmd.getArgumentCompletions("d")!.map((i) => i.value)).toEqual(["doctor"]);
  });

  test("second level: tidy options and restore --trash", () => {
    const fx = fixture();
    const cmd = createMemCommand({ paths: fx.paths });
    expect(
      cmd
        .getArgumentCompletions("tidy ")!
        .map((i) => i.value)
        .sort(),
    ).toEqual(["tidy --dry-run", "tidy --frontmatter"]);
    expect(cmd.getArgumentCompletions("tidy --d")!.map((i) => i.value)).toEqual(["tidy --dry-run"]);
    expect(cmd.getArgumentCompletions("restore ")!.map((i) => i.value)).toEqual(["restore --trash"]);
    expect(cmd.getArgumentCompletions("import ")!.map((i) => i.value)).toEqual(["import --force"]);
  });

  test("unknown prefix returns empty and never throws", () => {
    const fx = fixture();
    const cmd = createMemCommand({ paths: fx.paths });
    expect(cmd.getArgumentCompletions("bogus")).toEqual([]);
    expect(cmd.getArgumentCompletions("tidy --bogus")).toEqual([]);
    expect(() => cmd.getArgumentCompletions(null as unknown as string)).not.toThrow();
  });
});
