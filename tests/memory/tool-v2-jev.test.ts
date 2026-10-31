// J5 (jev-plan §4): the v2 `memory` tool with a JevWritePort wired — write
// echo composition (jev lines BEFORE the budget line), the v4.1 §3.2 user-order
// guard's six paths, inline-comment rejection, append's deterministic
// `updated`/`source: agent` changes, the C-J12 usage landing, and — via the
// description selection — the §9.3 variant. Without a port the behavior is
// pinned byte-for-byte by tests/memory/jev/off-golden.test.ts + tool-v2.test.ts.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type MemorySettings } from "../../src/config/settings.js";
import { memoryDirFor, type MemoryPaths } from "../../src/memory/paths.js";
import { createMemoryToolV2, type MemoryToolV2Deps } from "../../src/memory/tool-v2.js";
import { MEMORY_TOOL_V2_TEXT, MEMORY_TOOL_V2_TEXT_JEV } from "../../src/memory/tool-surface.js";
import { createJevWritePort } from "../../src/memory/jev/write-port.js";
import { EntryIndex, entryHash } from "../../src/memory/jev/entries.js";
import { mergeTaxonomy } from "../../src/memory/jev/taxonomy.js";
import { withMemoryDirLock } from "../../src/memory/lock.js";
import type { JevClient, JevStatus, JevWritePort, MemEntry } from "../../src/memory/jev/contracts.js";

interface Fixture {
  tmp: string;
  cwd: string;
  paths: MemoryPaths;
  memDir: string;
}

const tmpRoots: string[] = [];

function fixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-toolv2jev-"));
  tmpRoots.push(tmp);
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  const paths = { memoryRoot: join(tmp, "mem"), ccProjectsRoot: join(tmp, "cc") };
  const memDir = memoryDirFor(cwd, paths);
  mkdirSync(memDir, { recursive: true });
  return { tmp, cwd, paths, memDir };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeFile(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
}

type ConfirmFn = (title: string, message: string, opts?: { timeout?: number }) => Promise<boolean>;

function fakeCtx(cwd: string, opts: { hasUI?: boolean; confirm?: ConfirmFn; registry?: unknown } = {}) {
  const hasUI = opts.hasUI !== false;
  const ctx = {
    mode: hasUI ? "tui" : "rpc",
    hasUI,
    cwd,
    ui: {
      notify: () => {},
      confirm:
        opts.confirm ??
        (async () => {
          return true;
        }),
    },
    ...(opts.registry !== undefined ? { modelRegistry: opts.registry } : {}),
  } as unknown as ExtensionContext;
  return ctx;
}

/** Fully scripted fake port (echo + usage + guard hooks), recording calls. */
function fakePort(over: {
  echo?: readonly string[];
  usage?: { costUsd: number; calls: number };
  touched?: (before: string, after: string, handWritten: boolean) => readonly MemEntry[];
  checkInline?: string | undefined;
  confirmTimeoutMs?: number;
  onAfterWrite?: (input: { file: string; before: string | undefined; after: string }) => void;
}): JevWritePort & { afterCalls: { cwd: string; file: string; before: string | undefined; after: string }[] } {
  const afterCalls: { cwd: string; file: string; before: string | undefined; after: string }[] = [];
  return {
    confirmTimeoutMs: over.confirmTimeoutMs ?? 60_000,
    async afterWrite(input) {
      afterCalls.push({ cwd: input.cwd, file: input.file, before: input.before, after: input.after });
      over.onAfterWrite?.(input);
      return { echo: over.echo ?? [], ...(over.usage === undefined ? {} : { usage: over.usage }) };
    },
    checkInline: () => over.checkInline,
    touchedUserEntries: (_file, before, after, handWritten) =>
      over.touched === undefined ? [] : over.touched(before, after, handWritten),
    afterCalls,
  };
}

const PARTIAL: JevStatus = { kind: "partial", reason: "451", inactive: false };

/** Real port (real guard pairing + checkInline) over a fake always-partial
 *  client — the tagging side then echoes the partial line deterministically. */
function realPort(fx: Fixture): JevWritePort {
  const client: JevClient = {
    status: () => PARTIAL,
    async ask() {
      return { ok: false, reason: "unavailable", detail: "down" };
    },
    async probe() {
      return PARTIAL;
    },
  };
  return createJevWritePort({
    client,
    entryIndex: new EntryIndex(),
    dirFor: (cwd) => memoryDirFor(cwd, fx.paths),
    taxonomyFor: () => mergeTaxonomy().taxonomy,
    confirmTimeoutMs: 60_000,
    now: () => Date.parse("2026-10-31T00:00:00Z"),
  });
}

function makeTool(
  fx: Fixture,
  over: {
    settings?: Partial<MemorySettings>;
    isChildSession?: boolean;
    jev?: JevWritePort;
  } = {},
) {
  const onAfterWrite = vi.fn();
  const tool = createMemoryToolV2({
    settings: { ...DEFAULT_SETTINGS.memory, ...over.settings },
    isChildSession: over.isChildSession ?? false,
    onAfterWrite,
    paths: fx.paths,
    ...(over.jev === undefined ? {} : { jev: over.jev }),
  });
  return { tool, onAfterWrite };
}

async function exec(
  tool: ReturnType<typeof createMemoryToolV2>,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
) {
  return (await tool.execute("call-1", params as never, undefined, undefined, ctx)) as {
    content: { type: string; text: string }[];
    usage?: { cost: { total: number } };
  };
}

function textOf(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((c) => c.text).join("\n");
}

const AGENT_FM = "---\nsource: agent\nupdated: 2026-10-01T00:00:00.000Z\n---\n\n";

/** Minimal registry that passes registryOf's method-level check (classify +
 *  getAvailableOfType present). Used everywhere except the off(pi-api) test. */
const FAKE_REGISTRY = {
  classify: () => {},
  getAvailableOfType: async () => [],
};

// ───────────────────────────── description variant (§9.3) ─────────────────────────────

describe("tool description variant", () => {
  test("no port ⇒ base description; port ⇒ jev variant; everything else shared", () => {
    const fx = fixture();
    const plain = makeTool(fx).tool;
    expect(plain.description).toBe(MEMORY_TOOL_V2_TEXT.description);
    const jeved = makeTool(fx, { jev: fakePort({}) }).tool;
    expect(jeved.description).toBe(MEMORY_TOOL_V2_TEXT_JEV.description);
    expect(jeved.parameters).toBe(plain.parameters);
    expect(jeved.promptSnippet).toBe(plain.promptSnippet);
    expect(jeved.promptGuidelines).toStrictEqual(plain.promptGuidelines);
  });
});

// ───────────────────────────── echo composition (§6.2.4 before budget) ─────────────────────────────

describe("write echo spliced before the budget line", () => {
  test.each([
    ["create", { command: "create", path: "fresh.md", file_text: "## S\n\n- fresh entry\n" }, false],
    ["str_replace", { command: "str_replace", path: "n.md", old_str: "old", new_str: "new" }, true],
    ["insert", { command: "insert", path: "n.md", insert_line: 6, insert_text: "- inserted" }, true],
    ["append", { command: "append", path: "n.md", content: "- appended" }, true],
    ["write", { command: "write", path: "n.md", file_text: "## S\n\n- whole\n" }, true],
  ] as const)("%s: echo lines land between head and budget line", async (label, params, preexisting) => {
    const fx = fixture();
    const name = (params.path as string) ?? "n.md";
    if (preexisting) writeFile(fx.memDir, "n.md", `${AGENT_FM}## S\n\n- old\n`);
    const port = fakePort({ echo: [`section: ${name} #1 (L6-6)`, "jev: pitfall 0.91 · guard 0.12 · permanent"] });
    const { tool } = makeTool(fx, { jev: port });
    const out = textOf(await exec(tool, { ...params }, fakeCtx(fx.cwd, { registry: FAKE_REGISTRY })));
    const lines = out.split("\n");
    const sectionIdx = lines.findIndex((l) => l.startsWith("section:"));
    const jevIdx = lines.findIndex((l) => l.startsWith("jev:"));
    // budget line = the "budget: <file> …" size report near the end
    const budgetIdx = lines.findIndex((l) => l.startsWith("budget:"));
    expect(sectionIdx).toBeGreaterThanOrEqual(0);
    expect(jevIdx).toBe(sectionIdx + 1);
    expect(budgetIdx).toBeGreaterThan(jevIdx);
    expect(port.afterCalls).toHaveLength(1);
    expect(port.afterCalls[0]!.file).toBe(name);
    void label;
  });

  test("usage lands on the tool result (C-J12): cost.total = costUsd", async () => {
    const fx = fixture();
    const port = fakePort({ usage: { costUsd: 0.0042, calls: 3 } });
    const { tool } = makeTool(fx, { jev: port });
    const result = await exec(
      tool,
      { command: "append", path: "n.md", content: "- x" },
      fakeCtx(fx.cwd, { registry: FAKE_REGISTRY }),
    );
    expect(result.usage).toBeDefined();
    expect(result.usage!.cost.total).toBe(0.0042);
  });

  test("afterWrite receives the in-lock before/after of the committed write", async () => {
    const fx = fixture();
    const original = `${AGENT_FM}## S\n\n- old\n`;
    writeFile(fx.memDir, "n.md", original);
    const port = fakePort({});
    const { tool } = makeTool(fx, { jev: port });
    await exec(
      tool,
      { command: "str_replace", path: "n.md", old_str: "old", new_str: "new" },
      fakeCtx(fx.cwd, { registry: FAKE_REGISTRY }),
    );
    expect(port.afterCalls[0]!.before).toBe(original);
    expect(port.afterCalls[0]!.after).toBe(readFileSync(join(fx.memDir, "n.md"), "utf8"));
    expect(port.afterCalls[0]!.after).toContain("new");
  });

  test("a throwing afterWrite degrades to the plain echo (write already committed)", async () => {
    const fx = fixture();
    const bad = {
      confirmTimeoutMs: 60_000,
      async afterWrite() {
        throw new Error("boom");
      },
      checkInline: () => undefined,
      touchedUserEntries: () => [],
    } as unknown as JevWritePort;
    const { tool } = makeTool(fx, { jev: bad });
    const out = textOf(
      await exec(
        tool,
        { command: "append", path: "n.md", content: "- x" },
        fakeCtx(fx.cwd, { registry: FAKE_REGISTRY }),
      ),
    );
    expect(out).toContain("appended to n.md");
    expect(readFileSync(join(fx.memDir, "n.md"), "utf8")).toContain("- x");
  });
});

// ───────────────────────────── lock-outside proof ─────────────────────────────

describe("jev calls happen outside the directory lock", () => {
  test("afterWrite runs with the lock free (it can re-acquire it)", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "n.md", `${AGENT_FM}## S\n\n- old\n`);
    let relocked = false;
    const port = fakePort({
      onAfterWrite: () => {
        // If the tool still held the memory dir lock this would throw "busy".
        void withMemoryDirLock(fx.memDir, () => "ok", { timeoutMs: 0, log: () => {} }).then(
          (v) => {
            relocked = v === "ok";
          },
          () => {
            relocked = false;
          },
        );
      },
    });
    const { tool } = makeTool(fx, { jev: port });
    await exec(
      tool,
      { command: "str_replace", path: "n.md", old_str: "old", new_str: "new" },
      fakeCtx(fx.cwd, { registry: FAKE_REGISTRY }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(relocked).toBe(true);
  });
});

// ───────────────────────────── user-order guard (v4.1 §3.2 six paths) ─────────────────────────────

const REFUSE = "用户未确认：用户令条目只有用户能作废。请在回复里向用户提议具体改法";

describe("user-order guard", () => {
  test("pure top insertion pairs by hash — no confirm (case 1)", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", "## Rules\n\n- 发版前确认 GitHub CI 绿\n- 第二条用户令\n");
    const confirm = vi.fn(async () => true);
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    const ctx = fakeCtx(fx.cwd, { confirm, registry: FAKE_REGISTRY });
    await exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "## Rules", new_str: "## Rules\n\n- 顶部新经验一条" },
      ctx,
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toContain("顶部新经验一条");
  });

  test("editing a user entry confirms, and a confirmed write voids the rule (case 2)", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", "## Rules\n\n- 发版前确认 GitHub CI 绿\n");
    const confirm = vi.fn(async () => true);
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    const out = textOf(
      await exec(
        tool,
        { command: "str_replace", path: "core.md", old_str: "确认 GitHub CI 绿", new_str: "确认 CI 全绿" },
        fakeCtx(fx.cwd, { confirm, registry: FAKE_REGISTRY }),
      ),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toBe("agent 请求修改用户令");
    expect(confirm.mock.calls[0]![1]).toContain("core.md");
    expect(out).toContain("voided user rule: core.md › Rules #1");
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toContain("CI 全绿");
    // partial client ⇒ not-tagged echo still present
    expect(out).toContain("jev: not tagged (partial: 451)");
  });

  test("deleting one of two identical user entries confirms (case 3)", async () => {
    const fx = fixture();
    writeFile(
      fx.memDir,
      "dup.md",
      `${AGENT_FM}## S\n\n- 相同的用户令 <!-- mem user -->\n- 相同的用户令 <!-- mem user -->\n`,
    );
    const confirm = vi.fn(async () => true);
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    await exec(
      tool,
      {
        command: "write",
        path: "dup.md",
        file_text: "## S\n\n- 相同的用户令 <!-- mem user -->\n",
      },
      fakeCtx(fx.cwd, { confirm, registry: FAKE_REGISTRY }),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test("child session refuses outright", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", "## Rules\n\n- 用户令一条\n");
    const confirm = vi.fn(async () => true);
    const { tool } = makeTool(fx, {
      isChildSession: true,
      settings: { allowWriteInChildSessions: true },
      jev: realPort(fx),
    });
    await expect(
      exec(
        tool,
        { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
        fakeCtx(fx.cwd, { confirm, registry: FAKE_REGISTRY }),
      ),
    ).rejects.toThrow(REFUSE);
    expect(confirm).not.toHaveBeenCalled();
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toContain("用户令");
  });

  test("UI-less context refuses outright", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", "## Rules\n\n- 用户令一条\n");
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    await expect(
      exec(
        tool,
        { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
        fakeCtx(fx.cwd, { hasUI: false, registry: FAKE_REGISTRY }),
      ),
    ).rejects.toThrow(REFUSE);
  });

  test("declined confirm refuses", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", "## Rules\n\n- 用户令一条\n");
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    await expect(
      exec(
        tool,
        { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
        fakeCtx(fx.cwd, { confirm: async () => false, registry: FAKE_REGISTRY }),
      ),
    ).rejects.toThrow(REFUSE);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toContain("用户令");
  });

  test("confirm timeout refuses (confirmTimeoutMs honored)", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", "## Rules\n\n- 用户令一条\n");
    const seenTimeout: number[] = [];
    const confirm: ConfirmFn = (_t, _m, opts) =>
      new Promise<boolean>((resolve) => {
        seenTimeout.push(opts?.timeout ?? -1);
        const timer = setTimeout(() => resolve(false), opts?.timeout ?? 60_000);
        timer.unref?.();
      });
    const port = createJevWritePort({
      client: {
        status: () => ({ kind: "partial", reason: "451", inactive: false }),
        async ask() {
          return { ok: false, reason: "unavailable", detail: "" };
        },
        async probe() {
          return PARTIAL;
        },
      },
      entryIndex: new EntryIndex(),
      dirFor: (cwd) => memoryDirFor(cwd, fx.paths),
      taxonomyFor: () => mergeTaxonomy().taxonomy,
      confirmTimeoutMs: 20,
      now: () => Date.parse("2026-10-31T00:00:00Z"),
    });
    const { tool } = makeTool(fx, { jev: port });
    await expect(
      exec(
        tool,
        { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
        fakeCtx(fx.cwd, { confirm, registry: FAKE_REGISTRY }),
      ),
    ).rejects.toThrow(REFUSE);
    expect(seenTimeout).toEqual([20]);
  });

  test("concurrent modification between confirm and lock ⇒ changed-concurrently error", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", "## Rules\n\n- 用户令一条\n");
    const confirm: ConfirmFn = async () => {
      // the file changes WHILE the user stares at the dialog
      writeFileSync(join(fx.memDir, "core.md"), "## Rules\n\n- 用户令一条（别处已改）\n");
      return true;
    };
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    await expect(
      exec(
        tool,
        { command: "str_replace", path: "core.md", old_str: "用户令一条", new_str: "改掉" },
        fakeCtx(fx.cwd, { confirm, registry: FAKE_REGISTRY }),
      ),
    ).rejects.toThrow(/changed concurrently/);
  });

  test("insert at line 0 adding a source:agent frontmatter block confirms; declined keeps the file byte-identical", async () => {
    const fx = fixture();
    const original = "## Rules\n\n- 用户令一条\n- 第二条用户令\n";
    writeFile(fx.memDir, "core.md", original);
    const confirm = vi.fn(async () => false);
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    await expect(
      exec(
        tool,
        { command: "insert", path: "core.md", insert_line: 0, insert_text: "---\nsource: agent\n---\n" },
        fakeCtx(fx.cwd, { confirm, registry: FAKE_REGISTRY }),
      ),
    ).rejects.toThrow(REFUSE);
    expect(confirm).toHaveBeenCalledTimes(1); // provenance flip ⇒ whole user set touched
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(original);
  });

  test("str_replace prepending the same block at offset 0 confirms too", async () => {
    const fx = fixture();
    const original = "## Rules\n\n- 用户令一条\n";
    writeFile(fx.memDir, "core.md", original);
    const confirm = vi.fn(async () => false);
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    await expect(
      exec(
        tool,
        {
          command: "str_replace",
          path: "core.md",
          old_str: "## Rules",
          new_str: "---\nsource: agent\n---\n\n## Rules",
        },
        fakeCtx(fx.cwd, { confirm, registry: FAKE_REGISTRY }),
      ),
    ).rejects.toThrow(REFUSE);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(original);
  });

  test("two-step pin: confirmed provenance flip voids the user set; a follow-up delete needs no second dialog", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", "## Rules\n\n- 用户令一条\n");
    const confirm = vi.fn(async () => true);
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    // step 1: the flip goes through BECAUSE the user confirmed it once
    const flipOut = textOf(
      await exec(
        tool,
        { command: "insert", path: "core.md", insert_line: 0, insert_text: "---\nsource: agent\n---\n" },
        fakeCtx(fx.cwd, { confirm, registry: FAKE_REGISTRY }),
      ),
    );
    expect(flipOut).toContain("voided user rule: core.md › Rules #1");
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toContain("source: agent");
    // step 2: delete after the confirmed flip — the entries are agent-default
    // now, so no second dialog (the user already approved the demotion)
    const callsBefore = confirm.mock.calls.length;
    const delOut = textOf(
      await exec(tool, { command: "delete", path: "core.md" }, fakeCtx(fx.cwd, { confirm, registry: FAKE_REGISTRY })),
    );
    expect(confirm.mock.calls.length).toBe(callsBefore);
    expect(delOut).toContain("deleted core.md (recoverable");
    expect(existsSync(join(fx.memDir, "core.md"))).toBe(false);
  });

  test("archiving a file with user entries confirms; declined keeps the bytes identical", async () => {
    const fx = fixture();
    const original = `${AGENT_FM}## S\n\n- 用户令一条 <!-- mem user -->\n`;
    writeFile(fx.memDir, "n.md", original);
    const confirm = vi.fn(async () => false);
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    await expect(
      exec(
        tool,
        { command: "str_replace", path: "n.md", old_str: "source: agent", new_str: "source: agent\nstatus: archived" },
        fakeCtx(fx.cwd, { confirm, registry: FAKE_REGISTRY }),
      ),
    ).rejects.toThrow(REFUSE);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(fx.memDir, "n.md"), "utf8")).toBe(original);
  });

  test("archiving a file without user entries never confirms", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "n.md", `${AGENT_FM}## S\n\n- 普通经验\n`);
    const confirm = vi.fn(async () => true);
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    const out = textOf(
      await exec(
        tool,
        { command: "str_replace", path: "n.md", old_str: "source: agent", new_str: "source: agent\nstatus: archived" },
        fakeCtx(fx.cwd, { confirm, registry: FAKE_REGISTRY }),
      ),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(out).toContain("edited n.md");
    expect(readFileSync(join(fx.memDir, "n.md"), "utf8")).toContain("status: archived");
  });

  test("un-archiving never confirms (visibility restored, reverse direction)", async () => {
    const fx = fixture();
    writeFile(
      fx.memDir,
      "n.md",
      `---\nsource: agent\nstatus: archived\nupdated: 2026-10-01T00:00:00.000Z\n---\n\n## S\n\n- 用户令一条 <!-- mem user -->\n`,
    );
    const confirm = vi.fn(async () => true);
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    const out = textOf(
      await exec(
        tool,
        { command: "str_replace", path: "n.md", old_str: "source: agent\nstatus: archived", new_str: "source: agent" },
        fakeCtx(fx.cwd, { confirm, registry: FAKE_REGISTRY }),
      ),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(out).toContain("edited n.md");
    expect(readFileSync(join(fx.memDir, "n.md"), "utf8")).not.toContain("archived");
  });

  test("rename never triggers the guard", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "old.md", `${AGENT_FM}## S\n\n- 用户令 <!-- mem user -->\n`);
    const confirm = vi.fn(async () => true);
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    const out = textOf(
      await exec(
        tool,
        { command: "rename", old_path: "old.md", new_path: "new.md" },
        fakeCtx(fx.cwd, { confirm, registry: FAKE_REGISTRY }),
      ),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(out).toContain("renamed old.md -> new.md");
  });

  test("deleting an agent file that carries user entries confirms; confirmed delete proceeds + voids", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "agent.md", `${AGENT_FM}## S\n\n- 用户令一条 <!-- mem user -->\n- 普通经验\n`);
    const confirm = vi.fn(async () => true);
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    const out = textOf(
      await exec(tool, { command: "delete", path: "agent.md" }, fakeCtx(fx.cwd, { confirm, registry: FAKE_REGISTRY })),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![1]).toContain("用户令");
    expect(out).toContain("deleted agent.md (recoverable");
    expect(out).toContain("voided user rule: agent.md › S #1");
    expect(existsSync(join(fx.memDir, "agent.md"))).toBe(false);
  });

  test("declined confirm refuses the delete — file still there", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "agent.md", `${AGENT_FM}## S\n\n- 用户令一条 <!-- mem user -->\n`);
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    await expect(
      exec(
        tool,
        { command: "delete", path: "agent.md" },
        fakeCtx(fx.cwd, { confirm: async () => false, registry: FAKE_REGISTRY }),
      ),
    ).rejects.toThrow(REFUSE);
    expect(existsSync(join(fx.memDir, "agent.md"))).toBe(true);
  });

  test("child session refuses the delete outright", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "agent.md", `${AGENT_FM}## S\n\n- 用户令一条 <!-- mem user -->\n`);
    const confirm = vi.fn(async () => true);
    const { tool } = makeTool(fx, {
      isChildSession: true,
      settings: { allowWriteInChildSessions: true },
      jev: realPort(fx),
    });
    await expect(
      exec(tool, { command: "delete", path: "agent.md" }, fakeCtx(fx.cwd, { confirm, registry: FAKE_REGISTRY })),
    ).rejects.toThrow(REFUSE);
    expect(confirm).not.toHaveBeenCalled();
    expect(existsSync(join(fx.memDir, "agent.md"))).toBe(true);
  });

  test("deleting an agent file without user entries never confirms", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "plain.md", `${AGENT_FM}## S\n\n- 普通经验一条\n`);
    const confirm = vi.fn(async () => true);
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    await exec(tool, { command: "delete", path: "plain.md" }, fakeCtx(fx.cwd, { confirm, registry: FAKE_REGISTRY }));
    expect(confirm).not.toHaveBeenCalled();
    expect(existsSync(join(fx.memDir, "plain.md"))).toBe(false);
  });

  test("registry present but without classifier methods ⇒ off(pi-api) echo, zero calls", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "n.md", `${AGENT_FM}## S\n\n- entry\n`);
    let asks = 0;
    const port = createJevWritePort({
      client: {
        status: () => ({ kind: "full", model: "opencode/jev-1.13-free" }),
        async ask() {
          asks += 1;
          return { ok: false, reason: "unavailable", detail: "" };
        },
        async probe() {
          return { kind: "full", model: "opencode/jev-1.13-free" };
        },
      },
      entryIndex: new EntryIndex(),
      dirFor: (cwd) => memoryDirFor(cwd, fx.paths),
      taxonomyFor: () => mergeTaxonomy().taxonomy,
      confirmTimeoutMs: 60_000,
      now: () => Date.parse("2026-10-31T00:00:00Z"),
    });
    const { tool } = makeTool(fx, { jev: port });
    const out = textOf(
      await exec(
        tool,
        { command: "str_replace", path: "n.md", old_str: "entry", new_str: "entry two" },
        fakeCtx(fx.cwd, { registry: {} }), // modelRegistry: {} — no classify/getAvailableOfType
      ),
    );
    expect(out).toContain("jev: not tagged (off: pi-api)");
    expect(asks).toBe(0);
  });
});

// ───────────────────────────── inline-comment rejection (§6.2.5) ─────────────────────────────

describe("inline-comment errors reject only when newly introduced", () => {
  test("str_replace introducing a broken comment refuses the write", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "n.md", `${AGENT_FM}## S\n\n- plain rule\n`);
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    await expect(
      exec(
        tool,
        {
          command: "str_replace",
          path: "n.md",
          old_str: "plain rule",
          new_str: "plain rule <!-- mem expires=nope -->",
        },
        fakeCtx(fx.cwd, { registry: FAKE_REGISTRY }),
      ),
    ).rejects.toThrow(/inline-comment errors/);
    expect(readFileSync(join(fx.memDir, "n.md"), "utf8")).not.toContain("expires=nope");
  });

  test("a pre-existing broken comment does not block an unrelated edit", async () => {
    const fx = fixture();
    writeFile(
      fx.memDir,
      "n.md",
      `${AGENT_FM}## S\n\n- rule with bad comment <!-- mem expires=nope -->\n- another entry\n`,
    );
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    const out = textOf(
      await exec(
        tool,
        { command: "str_replace", path: "n.md", old_str: "another entry", new_str: "another entry (edited)" },
        fakeCtx(fx.cwd, { registry: FAKE_REGISTRY }),
      ),
    );
    expect(out).toContain("edited n.md");
  });
});

// ───────────────────────────── append deterministics (§6.2.5) ─────────────────────────────

describe("append refreshes updated / stamps source: agent (port present)", () => {
  test("append to an agent file refreshes updated in place", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "n.md", `${AGENT_FM}## S\n\n- old\n`);
    const { tool } = makeTool(fx, { jev: fakePort({}) });
    await exec(
      tool,
      { command: "append", path: "n.md", content: "- more" },
      fakeCtx(fx.cwd, { registry: FAKE_REGISTRY }),
    );
    const after = readFileSync(join(fx.memDir, "n.md"), "utf8");
    expect(after).toContain("source: agent");
    expect(after).toContain(`updated: ${new Date().toISOString().slice(0, 10)}`);
    expect(after).toContain("- more");
  });

  test("append creating a new file stamps source: agent", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx, { jev: fakePort({}) });
    await exec(
      tool,
      { command: "append", path: "fresh.md", content: "- first" },
      fakeCtx(fx.cwd, { registry: FAKE_REGISTRY }),
    );
    const body = readFileSync(join(fx.memDir, "fresh.md"), "utf8");
    expect(body).toContain("source: agent");
    expect(body).toContain("- first");
  });

  test("append to a user-authored file leaves frontmatter untouched", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "hand.md", "## S\n\n- user writes this\n");
    const { tool } = makeTool(fx, { jev: fakePort({}) });
    const out = textOf(
      await exec(
        tool,
        { command: "append", path: "hand.md", content: "- agent addendum" },
        fakeCtx(fx.cwd, { registry: FAKE_REGISTRY }),
      ),
    );
    expect(out).toContain("⚠ appended to a user-authored file; frontmatter left untouched");
    const body = readFileSync(join(fx.memDir, "hand.md"), "utf8");
    expect(body.startsWith("## S\n")).toBe(true);
  });

  test("no port ⇒ append leaves bytes exactly as before (I9 parity spot check)", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "n.md", `${AGENT_FM}## S\n\n- old\n`);
    const { tool } = makeTool(fx);
    await exec(
      tool,
      { command: "append", path: "n.md", content: "- more" },
      fakeCtx(fx.cwd, { registry: FAKE_REGISTRY }),
    );
    const body = readFileSync(join(fx.memDir, "n.md"), "utf8");
    expect(body).toBe(`${AGENT_FM}## S\n\n- old\n- more`);
  });
});

// ───────────────────────────── read ops unchanged ─────────────────────────────

describe("view/search with a port", () => {
  test("view still returns line-numbered content, no jev lines", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "n.md", `${AGENT_FM}## S\n\n- one\n`);
    const { tool } = makeTool(fx, { jev: fakePort({ echo: ["SHOULD NOT APPEAR"] }) });
    const out = textOf(
      await exec(tool, { command: "view", path: "n.md" }, fakeCtx(fx.cwd, { registry: FAKE_REGISTRY })),
    );
    expect(out).not.toContain("SHOULD NOT APPEAR");
  });
});

// keep the entryHash import honest: the sidecar-key contract rides on it
void entryHash;
