// `/mem init` — creates a core.md skeleton via the same locked/safe create
// path the v2 memory tool uses; idempotent; refuses archived cores and
// pin-stand-in primaries with D01's own wording; child-session gate mirrors
// the memory tool's write gate.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type MemorySettings } from "../../src/config/settings.js";
import { createMemCommand } from "../../src/memory/command.js";
import { collectDoctorFindings } from "../../src/memory/doctor-command.js";
import { coreSkeleton, handleMemInitCommand, runMemInit, type MemInitDeps } from "../../src/memory/init-command.js";
import { parseMemoryMeta } from "../../src/memory/meta.js";
import { memoryDirFor, type MemoryPaths } from "../../src/memory/paths.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Fixture {
  tmp: string;
  cwd: string;
  paths: MemoryPaths;
}

const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-init-"));
  tmpRoots.push(tmp);
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

function deps(fx: Fixture, over: Partial<MemInitDeps> = {}): MemInitDeps {
  return { paths: fx.paths, isChildSession: false, ...over };
}

function writeMemFile(fx: Fixture, name: string, body: string): void {
  const dir = memoryDirFor(fx.cwd, fx.paths);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
}

const TOPIC_FILE = `---
description: 构建与测试命令
topic: build
status: active
---

# 构建
`;

describe("runMemInit", () => {
  test("creates core.md on an empty project (memory dir missing)", async () => {
    const fx = fixture();
    const outcome = await runMemInit(fx.cwd, deps(fx));
    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") return;
    expect(outcome.topicFiles).toBe(0);
    const file = join(memoryDirFor(fx.cwd, fx.paths), "core.md");
    const content = readFileSync(file, "utf8");
    const { meta, errors } = parseMemoryMeta(content, "core");
    expect(errors).toHaveLength(0);
    expect(meta.pin).toBe(true);
    expect(meta.status).toBe("active");
    expect(meta.topic).toBe("core");
    expect(meta.description).toContain("每轮");
    expect(meta.updated).toBeDefined();
    // user command ⇒ user-authored: no `source:` stamp (tool writes carry `source: agent`)
    expect(meta.source).toBeUndefined();
    expect(content).toContain("# 核心规则（每轮）");
    // created with the tool's private-file mode
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("idempotent: an existing active core.md is left byte-for-byte untouched", async () => {
    const fx = fixture();
    const original = "---\npin: true\ntopic: core\n---\n\n# 已有核心规则\n\n- 不要动我\n";
    writeMemFile(fx, "core.md", original);
    const outcome = await runMemInit(fx.cwd, deps(fx));
    expect(outcome.kind).toBe("exists");
    expect(readFileSync(join(memoryDirFor(fx.cwd, fx.paths), "core.md"), "utf8")).toBe(original);
  });

  test("refuses an archived core.md (tells the user to set it back to active)", async () => {
    const fx = fixture();
    writeMemFile(fx, "core.md", "---\ntopic: core\nstatus: archived\n---\n\n# 旧\n");
    const outcome = await runMemInit(fx.cwd, deps(fx));
    expect(outcome.kind).toBe("archived");
  });

  test("refuses when a pin:true stand-in primary exists", async () => {
    const fx = fixture();
    writeMemFile(fx, "pitfalls.md", "---\npin: true\ndescription: 坑\ntopic: pitfalls\n---\n\n# 坑\n");
    const outcome = await runMemInit(fx.cwd, deps(fx));
    expect(outcome).toEqual({ kind: "pinStandin", name: "pitfalls.md" });
  });

  test("an archived pin file is NOT a stand-in — init proceeds", async () => {
    const fx = fixture();
    writeMemFile(fx, "old.md", "---\npin: true\ntopic: old\nstatus: archived\n---\n\n# 旧\n");
    const outcome = await runMemInit(fx.cwd, deps(fx));
    expect(outcome.kind).toBe("created");
  });

  test("counts existing non-archived topic files for the migration hint", async () => {
    const fx = fixture();
    writeMemFile(fx, "build.md", TOPIC_FILE);
    writeMemFile(fx, "cache.md", TOPIC_FILE.replace("build", "cache"));
    writeMemFile(fx, "archived.md", "---\ntopic: x\nstatus: archived\n---\n\n# x\n");
    const outcome = await runMemInit(fx.cwd, deps(fx));
    expect(outcome).toMatchObject({ kind: "created", topicFiles: 2 });
  });

  test("the freshly created skeleton is doctor-clean (no findings at all)", async () => {
    const fx = fixture();
    await runMemInit(fx.cwd, deps(fx));
    const findings = collectDoctorFindings(fx.cwd, fx.paths, DEFAULT_SETTINGS.memory);
    expect(findings).toEqual([]);
  });

  test("skeleton stays well under the default core budget", () => {
    const bytes = Buffer.byteLength(coreSkeleton(new Date().toISOString()), "utf8");
    expect(bytes).toBeLessThan(DEFAULT_SETTINGS.memory.coreBytes / 2);
  });
});

describe("handleMemInitCommand", () => {
  test("created: notifies with the path and calls onAfterWrite once", async () => {
    const fx = fixture();
    const writes: string[] = [];
    const { ctx, notifications } = fakeCtx(fx.cwd);
    await handleMemInitCommand(ctx, deps(fx, { onAfterWrite: (c) => writes.push(c) }));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.level).toBe("info");
    expect(notifications[0]!.message).toContain("core.md");
    expect(notifications[0]!.message).toContain(memoryDirFor(fx.cwd, fx.paths));
    expect(writes).toEqual([fx.cwd]);
  });

  test("migration hint lists the topic-file count and the tidy preview command", async () => {
    const fx = fixture();
    writeMemFile(fx, "build.md", TOPIC_FILE);
    const { ctx, notifications } = fakeCtx(fx.cwd);
    await handleMemInitCommand(ctx, deps(fx));
    expect(notifications[0]!.message).toContain("已有 1 个话题文件");
    expect(notifications[0]!.message).toContain("移进 core.md");
  });

  test("exists: info notice, no write, no onAfterWrite", async () => {
    const fx = fixture();
    writeMemFile(fx, "core.md", "# 已有\n");
    const writes: string[] = [];
    const { ctx, notifications } = fakeCtx(fx.cwd);
    await handleMemInitCommand(ctx, deps(fx, { onAfterWrite: (c) => writes.push(c) }));
    expect(notifications[0]!.level).toBe("info");
    expect(notifications[0]!.message).toContain("已存在");
    expect(writes).toHaveLength(0);
  });

  test("archived: warning matches D01's archived wording", async () => {
    const fx = fixture();
    writeMemFile(fx, "core.md", "---\ntopic: core\nstatus: archived\n---\n\n# 旧\n");
    const { ctx, notifications } = fakeCtx(fx.cwd);
    await handleMemInitCommand(ctx, deps(fx));
    expect(notifications[0]!.level).toBe("warning");
    expect(notifications[0]!.message).toContain("status: archived");
    expect(notifications[0]!.message).toContain("status: active");
  });

  test("pin stand-in: warning matches D01's degraded-primary fix", async () => {
    const fx = fixture();
    writeMemFile(fx, "pitfalls.md", "---\npin: true\ntopic: pitfalls\n---\n\n# 坑\n");
    const { ctx, notifications } = fakeCtx(fx.cwd);
    await handleMemInitCommand(ctx, deps(fx));
    expect(notifications[0]!.level).toBe("warning");
    expect(notifications[0]!.message).toContain("「pitfalls.md」（pin: true）");
    expect(notifications[0]!.message).toContain("改名为 core.md");
  });

  test("child session (read-only default): refuses without touching disk", async () => {
    const fx = fixture();
    const { ctx, notifications } = fakeCtx(fx.cwd);
    await handleMemInitCommand(ctx, deps(fx, { isChildSession: true }));
    expect(notifications[0]!.level).toBe("warning");
    expect(notifications[0]!.message).toContain("read-only");
    expect(readFileSyncSafe(fx)).toBe(false);
  });

  test("child session with memory.allowWriteInChildSessions: creates", async () => {
    const fx = fixture();
    const settings: MemorySettings = { ...DEFAULT_SETTINGS.memory, allowWriteInChildSessions: true };
    const { ctx } = fakeCtx(fx.cwd);
    await handleMemInitCommand(ctx, deps(fx, { isChildSession: true, settings }));
    expect(readFileSyncSafe(fx)).toBe(true);
  });
});

function readFileSyncSafe(fx: Fixture): boolean {
  try {
    readFileSync(join(memoryDirFor(fx.cwd, fx.paths), "core.md"), "utf8");
    return true;
  } catch {
    return false;
  }
}

describe("/mem init via createMemCommand (dispatch + completion)", () => {
  test("completion lists init with its Chinese description", () => {
    const cmd = createMemCommand({});
    const items = cmd.getArgumentCompletions("i");
    const init = items.find((i) => i.value === "init");
    expect(init).toBeDefined();
    expect(init!.description).toContain("初始化项目记忆");
  });

  test("dispatch: /mem init creates the skeleton and appends the doctor summary", async () => {
    const fx = fixture();
    const writes: string[] = [];
    const cmd = createMemCommand({
      paths: fx.paths,
      settings: DEFAULT_SETTINGS.memory,
      onAfterWrite: (c) => writes.push(c),
    });
    const { ctx, notifications } = fakeCtx(fx.cwd);
    await cmd.handler("init", ctx);
    expect(notifications[0]!.level).toBe("info");
    expect(notifications[0]!.message).toContain("core.md");
    expect(writes).toEqual([fx.cwd]);
    // idempotent at the command level too
    await cmd.handler("init", ctx);
    expect(notifications[1]!.message).toContain("已存在");
    expect(writes).toHaveLength(1);
  });
});
