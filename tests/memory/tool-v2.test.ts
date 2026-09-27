// optimize-plan §4 / §10 I group (todo #22 P2): the v2 memory tool factory,
// end-to-end. Per-test tmpdir + paths injection (same style as tool.test.ts);
// never the real ~/.pi/agent/memory.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type MemorySettings } from "../../src/config/settings.js";
import { memoryDirFor, type MemoryPaths } from "../../src/memory/paths.js";
import { createMemoryToolV2, type MemoryToolV2Deps } from "../../src/memory/tool-v2.js";
import type { TieredRenderInput, TieredRenderResult } from "../../src/memory/contracts.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Fixture {
  tmp: string;
  cwd: string;
  paths: MemoryPaths;
  memDir: string;
}

function fixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-toolv2-"));
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  const paths = { memoryRoot: join(tmp, "mem"), ccProjectsRoot: join(tmp, "cc") };
  return { tmp, cwd, paths, memDir: memoryDirFor(cwd, paths) };
}

function fakeCtx(cwd: string, opts: { hasUI?: boolean } = {}) {
  const hasUI = opts.hasUI !== false;
  const ctx = { mode: hasUI ? "tui" : "rpc", hasUI, cwd, ui: { notify: () => {} } } as unknown as ExtensionContext;
  return ctx;
}

function makeTool(
  fx: Fixture,
  over: {
    settings?: Partial<MemorySettings>;
    isChildSession?: boolean;
    renderBlock?: MemoryToolV2Deps["renderBlock"];
  } = {},
) {
  const onAfterWrite = vi.fn();
  const tool = createMemoryToolV2({
    settings: { ...DEFAULT_SETTINGS.memory, ...over.settings },
    isChildSession: over.isChildSession ?? false,
    onAfterWrite,
    paths: fx.paths,
    ...(over.renderBlock ? { renderBlock: over.renderBlock } : {}),
  });
  return { tool, onAfterWrite };
}

async function exec(
  tool: ReturnType<typeof createMemoryToolV2>,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
) {
  return (await tool.execute("call-1", params, undefined, undefined, ctx)) as {
    content: { type: string; text: string }[];
  };
}

function textOf(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((c) => c.text).join("\n");
}

function writeFile(dir: string, name: string, body: string, mtimeIso?: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
  if (mtimeIso) {
    const t = new Date(mtimeIso).getTime() / 1000;
    utimesSync(join(dir, name), t, t);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ───────────────────────────── I1: view ─────────────────────────────

describe("I1: view", () => {
  test("directory listing on empty dir hints at /mem import", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    const result = await exec(tool, { command: "view" }, fakeCtx(fx.cwd));
    expect(textOf(result)).toContain("No memory");
    expect(textOf(result)).toContain("/mem import");
  });

  test("directory listing shows name/description/when/size/updated/status/pin/source", async () => {
    const fx = fixture();
    writeFile(
      fx.memDir,
      "quota.md",
      "---\ndescription: quota stuff\nread_when: quota; ladder\nupdated: 2026-09-01T00:00:00.000Z\npin: true\nsource: agent\n---\n\nbody\n",
    );
    const { tool } = makeTool(fx);
    const out = textOf(await exec(tool, { command: "view" }, fakeCtx(fx.cwd)));
    expect(out).toContain("quota.md");
    expect(out).toContain("quota stuff");
    expect(out).toContain("when: quota; ladder");
    expect(out).toContain("2026-09-01");
    expect(out).toContain("active");
    expect(out).toContain("pin");
    expect(out).toContain("agent");
  });

  test("full-file view returns line-numbered content, coordinate system includes frontmatter", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "---\nx: 1\n---\nhello\nworld\n");
    const { tool } = makeTool(fx);
    const out = textOf(await exec(tool, { command: "view", path: "a.md" }, fakeCtx(fx.cwd)));
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^\s*1\t---$/);
    expect(lines[3]).toMatch(/^\s*4\thello$/);
  });

  test("view_range selects lines, -1 means to the end, out-of-range clamps with a note", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "l1\nl2\nl3\nl4\nl5");
    const { tool } = makeTool(fx);
    const range = textOf(await exec(tool, { command: "view", path: "a.md", view_range: [2, 3] }, fakeCtx(fx.cwd)));
    expect(range).toContain("l2");
    expect(range).toContain("l3");
    expect(range).not.toContain("l1");
    expect(range).not.toContain("l4");
    const toEnd = textOf(await exec(tool, { command: "view", path: "a.md", view_range: [4, -1] }, fakeCtx(fx.cwd)));
    expect(toEnd).toContain("l4");
    expect(toEnd).toContain("l5");
    const clamped = textOf(await exec(tool, { command: "view", path: "a.md", view_range: [1, 999] }, fakeCtx(fx.cwd)));
    expect(clamped).toContain("clamped");
  });

  test("view with section: exact, unique-prefix, ambiguous, and not-found", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "# T\n\n## Alpha\nx\n\n## Alpha Beta\ny\n\n## Gamma\nz\n");
    const { tool } = makeTool(fx);
    const exact = textOf(await exec(tool, { command: "view", path: "a.md", section: "Gamma" }, fakeCtx(fx.cwd)));
    expect(exact).toContain("z");
    expect(exact).toContain("section L");
    const prefix = textOf(await exec(tool, { command: "view", path: "a.md", section: "gam" }, fakeCtx(fx.cwd)));
    expect(prefix).toContain("z");
    await expect(exec(tool, { command: "view", path: "a.md", section: "al" }, fakeCtx(fx.cwd))).rejects.toThrow(
      /ambiguous/,
    );
    await expect(exec(tool, { command: "view", path: "a.md", section: "nope" }, fakeCtx(fx.cwd))).rejects.toThrow(
      /no section matching/,
    );
  });

  test("view of a file >16KB truncates and suggests view_range", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "big.md", "x".repeat(20_000));
    const { tool } = makeTool(fx);
    const out = textOf(await exec(tool, { command: "view", path: "big.md" }, fakeCtx(fx.cwd)));
    expect(out).toContain("truncated");
    expect(out).toContain("view_range");
  });

  test("path variants /memories, /memories/, '', omitted all mean the directory", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "hi");
    const { tool } = makeTool(fx);
    for (const p of ["/memories", "/memories/", "", undefined]) {
      const params: Record<string, unknown> = { command: "view" };
      if (p !== undefined) params.path = p;
      const out = textOf(await exec(tool, params, fakeCtx(fx.cwd)));
      expect(out).toContain("a.md");
    }
  });
});

// ───────────────────────────── I2: create ─────────────────────────────

describe("I2: create", () => {
  test("creates a new file with agent provenance", async () => {
    const fx = fixture();
    const { tool, onAfterWrite } = makeTool(fx);
    const out = textOf(
      await exec(tool, { command: "create", path: "a.md", file_text: "# A\nhello\n" }, fakeCtx(fx.cwd)),
    );
    expect(out).toContain("created a.md");
    const onDisk = readFileSync(join(fx.memDir, "a.md"), "utf8");
    expect(onDisk).toContain("source: agent");
    expect(onDisk).toContain("hello");
    expect(onAfterWrite).toHaveBeenCalledTimes(1);
  });

  test("create on an existing file errors, suggesting str_replace/insert/write", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "existing");
    const { tool } = makeTool(fx);
    await expect(exec(tool, { command: "create", path: "a.md", file_text: "x" }, fakeCtx(fx.cwd))).rejects.toThrow(
      /already exists/,
    );
  });

  test("core file over coreBytes on create is rejected with a split suggestion; over-topicMax topic file rejected too", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx, { settings: { coreBytes: 50, topicMaxBytes: 50 } });
    await expect(
      exec(
        tool,
        { command: "create", path: "core.md", file_text: "# Core\n\n## Big\n" + "x".repeat(100) },
        fakeCtx(fx.cwd),
      ),
    ).rejects.toThrow(/over the .* core limit/);
    await expect(
      exec(
        tool,
        { command: "create", path: "topic.md", file_text: "# T\n\n## Big\n" + "x".repeat(100) },
        fakeCtx(fx.cwd),
      ),
    ).rejects.toThrow(/over the .* hard limit/);
  });

  test("missing description only warns via T3 doctor-adjacent feedback, never rejects create", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    const out = textOf(
      await exec(tool, { command: "create", path: "a.md", file_text: "no frontmatter here" }, fakeCtx(fx.cwd)),
    );
    expect(out).toContain("created a.md");
  });
});

// ───────────────────────────── I3: str_replace ─────────────────────────────

describe("I3: str_replace", () => {
  test("unique match is replaced, snippet returned with line numbers", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "---\nsource: agent\n---\nline1\nfind me\nline3\n");
    const { tool } = makeTool(fx);
    const out = textOf(
      await exec(tool, { command: "str_replace", path: "a.md", old_str: "find me", new_str: "found" }, fakeCtx(fx.cwd)),
    );
    expect(out).toContain("found");
    const onDisk = readFileSync(join(fx.memDir, "a.md"), "utf8");
    expect(onDisk).toContain("found");
    expect(onDisk).not.toContain("find me");
  });

  test("zero matches errors, suggesting search", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "hello");
    const { tool } = makeTool(fx);
    await expect(
      exec(tool, { command: "str_replace", path: "a.md", old_str: "nope" }, fakeCtx(fx.cwd)),
    ).rejects.toThrow(/search/);
  });

  test("multiple matches errors, listing line numbers", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "dup\nother\ndup\n");
    const { tool } = makeTool(fx);
    await expect(exec(tool, { command: "str_replace", path: "a.md", old_str: "dup" }, fakeCtx(fx.cwd))).rejects.toThrow(
      /lines: 1, 3/,
    );
  });

  test("omitting new_str deletes the matched text", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "before REMOVE_ME after");
    const { tool } = makeTool(fx);
    await exec(tool, { command: "str_replace", path: "a.md", old_str: "REMOVE_ME " }, fakeCtx(fx.cwd));
    const onDisk = readFileSync(join(fx.memDir, "a.md"), "utf8");
    expect(onDisk).toContain("before after");
  });
});

// ───────────────────────────── I4: insert ─────────────────────────────

describe("I4: insert", () => {
  test("insert by line number", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "l1\nl2\nl3");
    const { tool } = makeTool(fx);
    await exec(tool, { command: "insert", path: "a.md", insert_line: 1, insert_text: "NEW" }, fakeCtx(fx.cwd));
    const onDisk = readFileSync(join(fx.memDir, "a.md"), "utf8");
    expect(onDisk.split("\n")).toEqual(["l1", "NEW", "l2", "l3"]);
  });

  test("insert by section inserts at the section's end", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "# T\n\n## Alpha\nx\n\n## Beta\ny\n");
    const { tool } = makeTool(fx);
    await exec(tool, { command: "insert", path: "a.md", section: "Alpha", insert_text: "INSERTED" }, fakeCtx(fx.cwd));
    const onDisk = readFileSync(join(fx.memDir, "a.md"), "utf8");
    const lines = onDisk.split("\n");
    const insertedIdx = lines.indexOf("INSERTED");
    expect(insertedIdx).toBeGreaterThan(lines.indexOf("x"));
    expect(insertedIdx).toBeLessThan(lines.indexOf("## Beta"));
  });

  test("insert_line landing inside frontmatter errors", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "---\na: 1\n---\nbody\n");
    const { tool } = makeTool(fx);
    await expect(
      exec(tool, { command: "insert", path: "a.md", insert_line: 2, insert_text: "x" }, fakeCtx(fx.cwd)),
    ).rejects.toThrow(/frontmatter/);
  });

  test("insert_line:0 with frontmatter normalizes to after the fence, with a note", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "---\na: 1\n---\nbody\n");
    const { tool } = makeTool(fx);
    const out = textOf(
      await exec(tool, { command: "insert", path: "a.md", insert_line: 0, insert_text: "X" }, fakeCtx(fx.cwd)),
    );
    expect(out).toContain("inserted after frontmatter");
    const onDisk = readFileSync(join(fx.memDir, "a.md"), "utf8");
    expect(onDisk.split("\n")[3]).toBe("X");
  });

  test("both or neither of insert_line/section errors", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "l1\nl2");
    const { tool } = makeTool(fx);
    await expect(exec(tool, { command: "insert", path: "a.md", insert_text: "x" }, fakeCtx(fx.cwd))).rejects.toThrow(
      /exactly one/,
    );
    await expect(
      exec(tool, { command: "insert", path: "a.md", insert_line: 1, section: "S", insert_text: "x" }, fakeCtx(fx.cwd)),
    ).rejects.toThrow(/exactly one/);
  });
});

// ───────────────────────────── I5: delete / rename ─────────────────────────────

describe("I5: delete / rename", () => {
  test("delete soft-deletes into .trash with a unique id; recovery hint returned", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "---\nsource: agent\n---\ncontent");
    const { tool } = makeTool(fx);
    const out = textOf(await exec(tool, { command: "delete", path: "a.md" }, fakeCtx(fx.cwd)));
    expect(out).toContain("deleted a.md");
    expect(out).toContain("/mem restore --trash");
    expect(existsSync(join(fx.memDir, "a.md"))).toBe(false);
    const trashFiles = readdirSync(join(fx.memDir, ".trash"));
    expect(trashFiles.some((f: string) => f.endsWith("-a.md"))).toBe(true);
  });

  test("deleting two files of the same name produces two different trash ids", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "---\nsource: agent\n---\nv1");
    const { tool } = makeTool(fx);
    await exec(tool, { command: "delete", path: "a.md" }, fakeCtx(fx.cwd));
    writeFile(fx.memDir, "a.md", "---\nsource: agent\n---\nv2");
    await exec(tool, { command: "delete", path: "a.md" }, fakeCtx(fx.cwd));
    const trashFiles: string[] = readdirSync(join(fx.memDir, ".trash"));
    const named = trashFiles.filter((f) => f.endsWith("-a.md"));
    expect(named).toHaveLength(2);
    expect(named[0]).not.toBe(named[1]);
  });

  test("rename: target exists errors; invalid name errors; frontmatter preserved", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "---\nsource: agent\ntopic: a\n---\nbody");
    writeFile(fx.memDir, "b.md", "existing");
    const { tool } = makeTool(fx);
    await expect(
      exec(tool, { command: "rename", old_path: "a.md", new_path: "b.md" }, fakeCtx(fx.cwd)),
    ).rejects.toThrow(/already exists/);
    await expect(
      exec(tool, { command: "rename", old_path: "a.md", new_path: "../evil.md" }, fakeCtx(fx.cwd)),
    ).rejects.toThrow();
    await exec(tool, { command: "rename", old_path: "a.md", new_path: "c.md" }, fakeCtx(fx.cwd));
    const onDisk = readFileSync(join(fx.memDir, "c.md"), "utf8");
    expect(onDisk).toContain("topic: a");
  });
});

// ───────────────────────────── I6: search (end-to-end) ─────────────────────────────

describe("I6: search", () => {
  test("end-to-end search returns coordinate-formatted hits", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "cache-ttl.md", "# Cache TTL\n\n## Upstream facts\nkeepalive matters here\n");
    const { tool } = makeTool(fx);
    const out = textOf(await exec(tool, { command: "search", query: "keepalive" }, fakeCtx(fx.cwd)));
    expect(out).toContain("cache-ttl.md");
    expect(out).toContain("Upstream facts");
    expect(out).toContain("L4");
  });

  test("no matches yields a friendly message", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "hello");
    const { tool } = makeTool(fx);
    const out = textOf(await exec(tool, { command: "search", query: "zzz" }, fakeCtx(fx.cwd)));
    expect(out).toContain("no matches");
  });
});

// ───────────────────────────── I7: aliases (end-to-end smoke; full matrix in normalize.test.ts) ─────────────────────────────

describe("I7: aliases end-to-end", () => {
  test("legacy action:write / action:append succeed through the same tool", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    await exec(tool, { action: "write", name: "a.md", content: "hello" }, fakeCtx(fx.cwd));
    await exec(tool, { action: "append", name: "a.md", content: "more" }, fakeCtx(fx.cwd));
    const onDisk = readFileSync(join(fx.memDir, "a.md"), "utf8");
    expect(onDisk).toContain("hello");
    expect(onDisk).toContain("more");
  });

  test("path+name same value accepted; different values conflict", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    await exec(tool, { command: "create", path: "a.md", name: "a.md", file_text: "x" }, fakeCtx(fx.cwd));
    expect(existsSync(join(fx.memDir, "a.md"))).toBe(true);
    await expect(
      exec(tool, { command: "create", path: "b.md", name: "c.md", file_text: "x" }, fakeCtx(fx.cwd)),
    ).rejects.toThrow(/conflicting/);
  });
});

// ───────────────────────────── I8: hand-written files ─────────────────────────────

describe("I8: hand-written files (user-authored, no source:agent)", () => {
  test("str_replace/insert succeed with a warning; frontmatter bytes unchanged", async () => {
    const fx = fixture();
    const original = "---\ntopic: mine\n---\nmy own notes\n";
    writeFile(fx.memDir, "mine.md", original);
    const { tool } = makeTool(fx);
    const out = textOf(
      await exec(
        tool,
        { command: "str_replace", path: "mine.md", old_str: "my own", new_str: "MY OWN" },
        fakeCtx(fx.cwd),
      ),
    );
    expect(out).toContain("user-authored");
    const onDisk = readFileSync(join(fx.memDir, "mine.md"), "utf8");
    expect(onDisk.startsWith("---\ntopic: mine\n---\n")).toBe(true);
    expect(onDisk).not.toContain("source: agent");
    expect(onDisk).not.toContain("updated:");
  });

  test("str_replace touching the frontmatter region is rejected", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "mine.md", "---\ntopic: mine\n---\nbody\n");
    const { tool } = makeTool(fx);
    await expect(
      exec(
        tool,
        { command: "str_replace", path: "mine.md", old_str: "topic: mine", new_str: "topic: yours" },
        fakeCtx(fx.cwd),
      ),
    ).rejects.toThrow(/frontmatter/);
  });

  test("write-override / delete / rename are rejected on a hand-written file", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "mine.md", "---\ntopic: mine\n---\nbody\n");
    const { tool } = makeTool(fx);
    await expect(exec(tool, { action: "write", name: "mine.md", content: "new" }, fakeCtx(fx.cwd))).rejects.toThrow(
      /user-authored/,
    );
    await expect(exec(tool, { command: "delete", path: "mine.md" }, fakeCtx(fx.cwd))).rejects.toThrow(/user-authored/);
    expect(existsSync(join(fx.memDir, "mine.md"))).toBe(true); // rejected delete leaves the file in place, not .trash
    writeFile(fx.memDir, "mine2.md", "---\ntopic: mine\n---\nbody\n");
    await expect(
      exec(tool, { command: "rename", old_path: "mine2.md", new_path: "renamed.md" }, fakeCtx(fx.cwd)),
    ).rejects.toThrow(/user-authored/);
  });

  test("append succeeds with a warning on a hand-written file", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "mine.md", "---\ntopic: mine\n---\nbody\n");
    const { tool } = makeTool(fx);
    const out = textOf(await exec(tool, { action: "append", name: "mine.md", content: "more" }, fakeCtx(fx.cwd)));
    expect(out).toContain("user-authored");
    const onDisk = readFileSync(join(fx.memDir, "mine.md"), "utf8");
    expect(onDisk).toContain("more");
    expect(onDisk).not.toContain("source: agent");
  });

  test("a CC-imported copy (drift header, no source:agent) is treated as hand-written", async () => {
    const fx = fixture();
    const ccCopy = "> **pi copy** — imported from Claude Code memory.\n\nsome content\n";
    writeFile(fx.memDir, "cc.md", ccCopy);
    const { tool } = makeTool(fx);
    await expect(
      exec(tool, { action: "write", name: "cc.md", content: "overwritten" }, fakeCtx(fx.cwd)),
    ).rejects.toThrow(/user-authored/);
  });

  test("a CC-imported copy is also rejected for delete (same provenance rule)", async () => {
    const fx = fixture();
    const ccCopy = "> **pi copy** — imported from Claude Code memory.\n\nsome content\n";
    writeFile(fx.memDir, "cc.md", ccCopy);
    const { tool } = makeTool(fx);
    await expect(exec(tool, { command: "delete", path: "cc.md" }, fakeCtx(fx.cwd))).rejects.toThrow(/user-authored/);
    expect(existsSync(join(fx.memDir, "cc.md"))).toBe(true);
  });
});

// ───────────────────────────── I9: T3 budget / hard limits ─────────────────────────────

describe("I9: T3 budget feedback + hard upper limits", () => {
  test("budget line reports values, including block level via the injected renderBlock port", async () => {
    const fx = fixture();
    const result: TieredRenderResult = {
      text: "…",
      bytes: 2200,
      level: 2,
      omittedSections: [],
      demotedPinned: [],
      fullIndexLines: 1,
      tailKind: "compact",
    };
    const { tool } = makeTool(fx, { renderBlock: (_input: TieredRenderInput) => result });
    const out = textOf(await exec(tool, { command: "create", path: "quota.md", file_text: "hi" }, fakeCtx(fx.cwd)));
    expect(out).toMatch(/budget: quota\.md/);
    expect(out).toMatch(/block .*\(L2\)/);
  });

  test("exact duplicate line is flagged; a short/novel line is not", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "pitfalls.md", "some pre-existing long enough sentence here\n");
    const { tool } = makeTool(fx);
    const dup = textOf(
      await exec(
        tool,
        { command: "create", path: "topic.md", file_text: "some pre-existing long enough sentence here" },
        fakeCtx(fx.cwd),
      ),
    );
    expect(dup).toContain("duplicate line");
    const fx2 = fixture();
    const { tool: tool2 } = makeTool(fx2);
    const novel = textOf(
      await exec(tool2, { command: "create", path: "topic.md", file_text: "short" }, fakeCtx(fx2.cwd)),
    );
    expect(novel).not.toContain("duplicate line");
  });

  test("hard upper limit only trips when the file GROWS past it; shrinking an already-over-limit file is allowed", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx, { settings: { topicMaxBytes: 50 } });
    // already over the limit
    writeFile(fx.memDir, "big.md", "x".repeat(100));
    // shrinking (still large, but smaller than before) is allowed
    await expect(
      exec(
        tool,
        { command: "str_replace", path: "big.md", old_str: "x".repeat(100), new_str: "x".repeat(80) },
        fakeCtx(fx.cwd),
      ),
    ).resolves.toBeDefined();
    // growing further is rejected
    await expect(
      exec(
        tool,
        { command: "str_replace", path: "big.md", old_str: "x".repeat(80), new_str: "x".repeat(90) },
        fakeCtx(fx.cwd),
      ),
    ).rejects.toThrow(/over the .* limit/);
  });

  test("topicWarnBytes: over-warn but under-max is allowed, with a warning", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx, { settings: { topicWarnBytes: 10, topicMaxBytes: 1000 } });
    const out = textOf(
      await exec(tool, { command: "create", path: "a.md", file_text: "x".repeat(50) }, fakeCtx(fx.cwd)),
    );
    expect(out).toContain("warn threshold");
  });

  test("append that would push the file over its hard limit is rejected wholly (zero bytes written)", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "x".repeat(40));
    const { tool } = makeTool(fx, { settings: { topicMaxBytes: 50 } });
    await expect(
      exec(tool, { action: "append", name: "a.md", content: "y".repeat(40) }, fakeCtx(fx.cwd)),
    ).rejects.toThrow();
    const onDisk = readFileSync(join(fx.memDir, "a.md"), "utf8");
    expect(onDisk).toBe("x".repeat(40));
  });
});

// ───────────────────────────── I9b: maxWriteBytes / maxFileBytes hard caps ─────────────────────────────

describe("I9b: maxWriteBytes (per-write payload) and maxFileBytes (absolute file cap)", () => {
  test("create rejects a file_text over maxWriteBytes; nothing is written", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx, { settings: { maxWriteBytes: 10 } });
    await expect(
      exec(tool, { command: "create", path: "a.md", file_text: "x".repeat(20) }, fakeCtx(fx.cwd)),
    ).rejects.toThrow(/per-write limit/);
    expect(existsSync(join(fx.memDir, "a.md"))).toBe(false);
  });

  test("str_replace rejects when new_str alone is over maxWriteBytes; file unchanged", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "---\nsource: agent\n---\nhello world\n");
    const { tool } = makeTool(fx, { settings: { maxWriteBytes: 10 } });
    await expect(
      exec(
        tool,
        { command: "str_replace", path: "a.md", old_str: "hello world", new_str: "y".repeat(20) },
        fakeCtx(fx.cwd),
      ),
    ).rejects.toThrow(/per-write limit/);
    expect(readFileSync(join(fx.memDir, "a.md"), "utf8")).toContain("hello world");
  });

  test("insert rejects an insert_text over maxWriteBytes; file unchanged", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "---\nsource: agent\n---\nhello\n");
    const { tool } = makeTool(fx, { settings: { maxWriteBytes: 10 } });
    await expect(
      exec(tool, { command: "insert", path: "a.md", insert_line: 3, insert_text: "z".repeat(20) }, fakeCtx(fx.cwd)),
    ).rejects.toThrow(/per-write limit/);
    expect(readFileSync(join(fx.memDir, "a.md"), "utf8")).not.toContain("z".repeat(20));
  });

  test('action:"write" rejects content over maxWriteBytes', async () => {
    const fx = fixture();
    const { tool } = makeTool(fx, { settings: { maxWriteBytes: 10 } });
    await expect(
      exec(tool, { action: "write", name: "a.md", content: "x".repeat(20) }, fakeCtx(fx.cwd)),
    ).rejects.toThrow(/per-write limit/);
    expect(existsSync(join(fx.memDir, "a.md"))).toBe(false);
  });

  test('action:"append" rejects content over maxWriteBytes; nothing is written', async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "---\nsource: agent\n---\nbody\n");
    const { tool } = makeTool(fx, { settings: { maxWriteBytes: 10 } });
    const before = readFileSync(join(fx.memDir, "a.md"), "utf8");
    await expect(
      exec(tool, { action: "append", name: "a.md", content: "w".repeat(20) }, fakeCtx(fx.cwd)),
    ).rejects.toThrow(/per-write limit/);
    expect(readFileSync(join(fx.memDir, "a.md"), "utf8")).toBe(before);
  });

  test("maxFileBytes is an absolute cap independent of maxWriteBytes and topicMaxBytes", async () => {
    const fx = fixture();
    // maxWriteBytes large enough to let the payload through; topicMaxBytes
    // large enough to never trip \u2014 only the absolute maxFileBytes cap should fire.
    const { tool } = makeTool(fx, { settings: { maxWriteBytes: 1000, topicMaxBytes: 1000, maxFileBytes: 50 } });
    await expect(
      exec(tool, { command: "create", path: "a.md", file_text: "x".repeat(60) }, fakeCtx(fx.cwd)),
    ).rejects.toThrow(/absolute file cap/);
  });

  test("maxFileBytes trips even while SHRINKING an already-over-cap file (unconditional, unlike topicMaxBytes)", async () => {
    const fx = fixture();
    // pre-existing file already over maxFileBytes (written directly to disk,
    // bypassing the tool \u2014 simulates a file grandfathered in before this cap
    // existed, or grown past it by a legacy/hand-written writer).
    writeFile(fx.memDir, "a.md", "---\nsource: agent\n---\n" + "x".repeat(200));
    const { tool } = makeTool(fx, { settings: { maxWriteBytes: 1000, topicMaxBytes: 1000, maxFileBytes: 50 } });
    await expect(
      exec(
        tool,
        { command: "str_replace", path: "a.md", old_str: "x".repeat(200), new_str: "y".repeat(60) },
        fakeCtx(fx.cwd),
      ),
    ).rejects.toThrow(/absolute file cap/);
  });
});

// ───────────────────────────── I9c: frontmatter structural validation ─────────────────────────────

describe("I9c: frontmatter validation rejects structural errors (e.g. illegal status)", () => {
  test("create rejects an illegal status value with an actionable message", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    await expect(
      exec(tool, { command: "create", path: "a.md", file_text: "---\nstatus: bogus\n---\nbody\n" }, fakeCtx(fx.cwd)),
    ).rejects.toThrow(/status .* not one of active\|stale\|archived/);
    expect(existsSync(join(fx.memDir, "a.md"))).toBe(false);
  });

  test('action:"write" rejects an illegal status value; nothing is written', async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    await expect(
      exec(tool, { action: "write", name: "a.md", content: "---\nstatus: bogus\n---\nbody\n" }, fakeCtx(fx.cwd)),
    ).rejects.toThrow(/status .* not one of/);
    expect(existsSync(join(fx.memDir, "a.md"))).toBe(false);
  });

  test("str_replace on an agent file is rejected when it newly introduces an illegal status", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "---\nsource: agent\nstatus: active\n---\nbody\n");
    const { tool } = makeTool(fx);
    await expect(
      exec(
        tool,
        { command: "str_replace", path: "a.md", old_str: "status: active", new_str: "status: bogus" },
        fakeCtx(fx.cwd),
      ),
    ).rejects.toThrow(/status .* not one of/);
    expect(readFileSync(join(fx.memDir, "a.md"), "utf8")).toContain("status: active");
  });

  test("str_replace on a file with a PRE-EXISTING illegal status is allowed when it doesn't touch frontmatter (grandfathered, not a new error)", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "---\nsource: agent\nstatus: bogus\n---\nhello world\n");
    const { tool } = makeTool(fx);
    const out = textOf(
      await exec(
        tool,
        { command: "str_replace", path: "a.md", old_str: "hello world", new_str: "hello there" },
        fakeCtx(fx.cwd),
      ),
    );
    expect(out).toContain("edited a.md");
    expect(readFileSync(join(fx.memDir, "a.md"), "utf8")).toContain("hello there");
  });

  test("insert on a file with a PRE-EXISTING illegal status is allowed (insert can never touch frontmatter)", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "---\nsource: agent\nstatus: bogus\n---\nhello\n");
    const { tool } = makeTool(fx);
    await expect(
      exec(tool, { command: "insert", path: "a.md", insert_line: 4, insert_text: "more" }, fakeCtx(fx.cwd)),
    ).resolves.toBeDefined();
    expect(readFileSync(join(fx.memDir, "a.md"), "utf8")).toContain("more");
  });

  test("append on a file with a PRE-EXISTING illegal status is allowed (append never touches frontmatter)", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "---\nsource: agent\nstatus: bogus\n---\nbody\n");
    const { tool } = makeTool(fx);
    await expect(
      exec(tool, { action: "append", name: "a.md", content: "more" }, fakeCtx(fx.cwd)),
    ).resolves.toBeDefined();
    expect(readFileSync(join(fx.memDir, "a.md"), "utf8")).toContain("more");
  });
});

// ───────────────────────────── I10: child sessions ─────────────────────────────

describe("I10: child sessions", () => {
  test("all mutating commands are rejected by default; view/search remain available", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "hello");
    const { tool } = makeTool(fx, { isChildSession: true });
    const ctx = fakeCtx(fx.cwd);
    await expect(exec(tool, { command: "create", path: "b.md", file_text: "x" }, ctx)).rejects.toThrow(/read-only/);
    await expect(
      exec(tool, { command: "str_replace", path: "a.md", old_str: "hello", new_str: "x" }, ctx),
    ).rejects.toThrow(/read-only/);
    await expect(exec(tool, { command: "delete", path: "a.md" }, ctx)).rejects.toThrow(/read-only/);
    await expect(exec(tool, { command: "rename", old_path: "a.md", new_path: "c.md" }, ctx)).rejects.toThrow(
      /read-only/,
    );
    await expect(exec(tool, { action: "append", name: "a.md", content: "x" }, ctx)).rejects.toThrow(/read-only/);
    const viewed = textOf(await exec(tool, { command: "view" }, ctx));
    expect(viewed).toContain("a.md");
    const searched = textOf(await exec(tool, { command: "search", query: "hello" }, ctx));
    expect(searched).toContain("a.md");
  });

  test("allowWriteInChildSessions:true permits a child session to write", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx, { isChildSession: true, settings: { allowWriteInChildSessions: true } });
    await exec(tool, { command: "create", path: "a.md", file_text: "x" }, fakeCtx(fx.cwd));
    expect(existsSync(join(fx.memDir, "a.md"))).toBe(true);
  });
});

// ───────────────────────────── I11: fencing + concurrency ─────────────────────────────

describe("I11: path fencing", () => {
  test("path traversal / absolute paths outside the memory dir are rejected", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    for (const bad of ["../x.md", "a/b.md", "/etc/x.md"]) {
      await expect(exec(tool, { command: "create", path: bad, file_text: "x" }, fakeCtx(fx.cwd))).rejects.toThrow();
    }
  });

  test("/memories/x.md prefix is accepted", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    await exec(tool, { command: "create", path: "/memories/a.md", file_text: "x" }, fakeCtx(fx.cwd));
    expect(existsSync(join(fx.memDir, "a.md"))).toBe(true);
  });

  test("a file-level symlink target is rejected for both view and mutation", async () => {
    const fx = fixture();
    mkdirSync(fx.memDir, { recursive: true });
    writeFileSync(join(fx.memDir, "real.md"), "secret outside content is not this, just a normal file");
    symlinkSync(join(fx.memDir, "real.md"), join(fx.memDir, "link.md"));
    const { tool } = makeTool(fx);
    await expect(exec(tool, { command: "view", path: "link.md" }, fakeCtx(fx.cwd))).rejects.toThrow();
    await expect(
      exec(tool, { command: "str_replace", path: "link.md", old_str: "x", new_str: "y" }, fakeCtx(fx.cwd)),
    ).rejects.toThrow();
  });
});

describe("I11: concurrent-modification detection", () => {
  test("a read-modify-write op detects an external change and refuses to overwrite it", async () => {
    vi.resetModules();
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "original content here");
    vi.doMock("../../src/memory/safe-fs.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/memory/safe-fs.js")>("../../src/memory/safe-fs.js");
      let first = true;
      return {
        ...actual,
        readRegular: (dir: string, name: string) => {
          const result = actual.readRegular(dir, name);
          if (first) {
            first = false;
            // Simulate an external (non-lock-respecting) writer racing in
            // right after our initial read, using plain fs (test-only).
            writeFileSync(join(dir, name), "raced external content");
          }
          return result;
        },
      };
    });
    const { createMemoryToolV2: createRaced } = await import("../../src/memory/tool-v2.js");
    const tool = createRaced({
      settings: DEFAULT_SETTINGS.memory,
      isChildSession: false,
      onAfterWrite: () => {},
      paths: fx.paths,
    });
    await expect(
      exec(tool, { command: "str_replace", path: "a.md", old_str: "original", new_str: "changed" }, fakeCtx(fx.cwd)),
    ).rejects.toThrow(/changed concurrently/);
    const onDisk = readFileSync(join(fx.memDir, "a.md"), "utf8");
    expect(onDisk).toBe("raced external content");
    vi.doUnmock("../../src/memory/safe-fs.js");
  });
});

// ───────────────────────────── I12: onAfterWrite ─────────────────────────────

describe("I12: onAfterWrite", () => {
  test("exactly one call per successful mutating command; zero on failure", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "a.md", "hello");
    const { tool, onAfterWrite } = makeTool(fx);
    await exec(tool, { command: "str_replace", path: "a.md", old_str: "hello", new_str: "world" }, fakeCtx(fx.cwd));
    expect(onAfterWrite).toHaveBeenCalledTimes(1);
    await expect(exec(tool, { command: "create", path: "a.md", file_text: "x" }, fakeCtx(fx.cwd))).rejects.toThrow();
    expect(onAfterWrite).toHaveBeenCalledTimes(1);
    await exec(tool, { command: "view" }, fakeCtx(fx.cwd));
    expect(onAfterWrite).toHaveBeenCalledTimes(1);
  });
});
