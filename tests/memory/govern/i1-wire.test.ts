import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wireMemory, type WireMemoryOpts } from "../../../src/memory/index.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import { memoryDirFor } from "../../../src/memory/paths.js";
import * as sweepModule from "../../../src/memory/govern/sweep.js";
import * as toolModule from "../../../src/memory/tool-v3.js";
import * as reviewModule from "../../../src/memory/jev/first-user-review.js";
import { createFakeRegistry } from "../jev/helpers/fake-registry.js";
import { blockRaw } from "../blocks/helpers.js";

const roots: string[] = [];
const realSweepRunner = sweepModule.createSweepRunner;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(
  options: {
    jev?: boolean;
    child?: boolean;
    locked?: boolean;
    migrated?: boolean;
    governance?: boolean;
    exists?: boolean;
    denyGate?: boolean;
    memoryOff?: boolean;
    secure?: boolean;
    noRegistry?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "i1-wire-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd);
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(root, "memory"));
  const dir = memoryDirFor(cwd);
  if (options.exists !== false) {
    mkdirSync(join(dir, "blocks"), { recursive: true });
    writeFileSync(
      join(dir, "blocks/.layout.json"),
      JSON.stringify(
        options.migrated
          ? { v: 1, source: "migrate", gen: 1, runId: "20261108T090000000Z-123-abcdef", files: [] }
          : { v: 1, source: "fresh" },
      ),
    );
    writeFileSync(
      join(dir, "blocks/rule.001.md"),
      blockRaw({ id: "rule.001", authority: "user", scope: "global", body: "a".repeat(600) }),
    );
  }
  const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  const sections = new Map<string, any>();
  const pi = {
    on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    sendMessage: vi.fn(),
    getActiveTools: () => [],
  } as unknown as ExtensionAPI;
  const sweep = vi.fn(async () => ({ operations: 0, archived: [], stopped: "done", suggestions: 0 }));
  const runnerOptions: Parameters<typeof sweepModule.createSweepRunner>[0][] = [];
  vi.spyOn(sweepModule, "createSweepRunner").mockImplementation((options) => {
    runnerOptions.push(options);
    return { runSweep: sweep };
  });
  let afterWrite: ((cwd: string, origin?: string) => void) | undefined;
  const makeTool = toolModule.createMemoryToolV3;
  vi.spyOn(toolModule, "createMemoryToolV3").mockImplementation((deps) => {
    afterWrite = deps.onAfterWrite;
    return makeTool(deps);
  });
  const clientRegistry = createFakeRegistry({ available: ["opencode/jev-1.13-free", "opencode/jev-1.13"] }).registry;
  const ctx = {
    cwd,
    hasUI: false,
    ui: {},
    modelRegistry: clientRegistry,
    sessionManager: { getBranch: () => [], getSessionId: () => "one" },
  };
  const settings = {
    ...DEFAULT_MEMORY_SETTINGS,
    enabled: options.memoryOff !== true,
    layout: "blocks" as const,
    residentBytes: 100,
    jev: {
      ...DEFAULT_MEMORY_SETTINGS.jev,
      enabled: options.jev === true,
      predict: { ...DEFAULT_MEMORY_SETTINGS.jev.predict, enabled: false },
    },
    governance: { enabled: options.governance !== false },
    migrate: { ...DEFAULT_MEMORY_SETTINGS.migrate, auto: false },
    doctor: { ...DEFAULT_MEMORY_SETTINGS.doctor, notifyOnStart: false },
  };
  wireMemory(pi, {
    settings,
    isChildSession: options.child === true,
    ...(options.locked
      ? { secureDomainKind: "locked" as const }
      : options.secure
        ? { secureDomainKind: "secure" as const }
        : {}),
    ...(options.denyGate
      ? { writeGate: { capture() {}, check: () => ({ ok: false as const, reason: "locked" as const }) } }
      : {}),
    todo: () => ({ list: () => [{ id: 1, subject: "task", status: "pending" }] }),
    sections: {
      register: (name: string, section: any) => sections.set(name, section),
      _state: () => undefined,
    } as unknown as WireMemoryOpts["sections"],
  });
  if (options.noRegistry) delete (ctx as { modelRegistry?: unknown }).modelRegistry;
  const emit = async (name: string, event: any) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  const render = () => sections.get("pi_project_memory").provider({ ctx, promptText: "", optionsCwd: cwd });
  return {
    cwd,
    dir,
    pi,
    ctx,
    handlers,
    sweep,
    emit,
    render,
    runnerOptions,
    write: (origin?: string) => afterWrite?.(cwd, origin),
  };
}

it("Jev off observes budget without a turn handler and consumes on the next write", async () => {
  const h = setup();
  await h.emit("session_start", {});
  expect(h.handlers.has("turn_end")).toBe(false);
  h.sweep.mockClear();
  h.render();
  h.render();
  expect(h.sweep).not.toHaveBeenCalled();
  h.write();
  expect(h.sweep).toHaveBeenCalledTimes(1);
  expect(h.sweep.mock.calls[0]?.[1]).toBe("budget");
  expect(h.sweep.mock.calls[0]?.[4]).toMatchObject({ residentBudget: 100 });
  h.sweep.mockClear();
  h.render();
  h.write();
  expect(h.sweep.mock.calls[0]?.[1]).toBe("write");
  await h.emit("session_shutdown", { reason: "reload" });
});

it.each(["memory dir busy", "not-executed"])(
  "a %s budget attempt remains dormant until a later external write",
  async (stopped) => {
    const h = setup();
    await h.emit("session_start", {});
    h.sweep.mockClear();
    h.render();
    h.sweep.mockResolvedValueOnce({ operations: 0, archived: [], stopped, suggestions: 0 });
    h.write();
    await Promise.resolve();
    h.render();
    expect(h.sweep).toHaveBeenCalledTimes(1);
    h.write();
    expect(h.sweep).toHaveBeenCalledTimes(2);
    expect(h.sweep.mock.calls[1]?.[1]).toBe("budget");
    await h.emit("session_shutdown", { reason: "reload" });
  },
);

it("task completion with prior snapshot and matching result reaches the merged sweep", async () => {
  const h = setup({ jev: true });
  await h.emit("session_start", {});
  h.sweep.mockClear();
  const input = { taskId: "1", status: "completed" };
  await h.emit("tool_call", { toolName: "TaskUpdate", toolCallId: "task", input });
  await h.emit("tool_result", {
    toolName: "TaskUpdate",
    toolCallId: "task",
    input,
    content: [],
    isError: false,
    details: { action: "update", changed: true, task: { id: 1, status: "completed" } },
  });
  await h.emit("turn_end", { message: { stopReason: "stop" } });
  expect(h.sweep).toHaveBeenCalledTimes(1);
  expect(h.sweep.mock.calls[0]?.[1]).toBe("task-done");
  await h.emit("session_shutdown", { reason: "reload" });
});

it("coalesces repeated event signals with release priority, without creating a turn", async () => {
  const h = setup({ jev: true });
  await h.emit("session_start", {});
  h.sweep.mockClear();
  for (const [i, command] of ["git push", "git push", "gh release create v1"].entries()) {
    const input = { command };
    await h.emit("tool_call", { toolName: "bash", toolCallId: `${i}`, input });
    await h.emit("tool_result", {
      toolName: "bash",
      toolCallId: `${i}`,
      input,
      content: [],
      isError: false,
      structuredContent: { exit_code: 0 },
    });
  }
  expect(h.sweep).not.toHaveBeenCalled();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
  await h.emit("turn_end", { message: { stopReason: "stop" } });
  expect(h.sweep).toHaveBeenCalledTimes(1);
  expect(h.sweep.mock.calls[0]?.[1]).toBe("release");
  await h.emit("session_shutdown", { reason: "reload" });
});

it("an aborted turn clears pending events without a later replay", async () => {
  const h = setup({ jev: true });
  await h.emit("session_start", {});
  h.sweep.mockClear();
  const input = { command: "git push" };
  await h.emit("tool_call", { toolName: "bash", toolCallId: "p", input });
  await h.emit("tool_result", {
    toolName: "bash",
    toolCallId: "p",
    input,
    content: [],
    isError: false,
    structuredContent: { exit_code: 0 },
  });
  await h.emit("turn_end", { message: { stopReason: "aborted" } });
  await h.emit("turn_end", { message: { stopReason: "stop" } });
  expect(h.sweep).not.toHaveBeenCalled();
  await h.emit("session_shutdown", { reason: "reload" });
});

it("Jev on merges multiple events and budget at one existing turn_end", async () => {
  const h = setup({ jev: true });
  await h.emit("session_start", {});
  h.sweep.mockClear();
  h.render();
  for (const [i, command] of ["git push", "gh release create v1"].entries()) {
    const input = { command };
    await h.emit("tool_call", { toolName: "bash", toolCallId: `${i}`, input });
    await h.emit("tool_result", {
      toolName: "bash",
      toolCallId: `${i}`,
      input,
      content: [],
      isError: false,
      structuredContent: { exit_code: 0 },
    });
  }
  expect(h.sweep).not.toHaveBeenCalled();
  await h.emit("turn_end", { message: { stopReason: "stop" } });
  expect(h.sweep).toHaveBeenCalledTimes(1);
  expect(h.sweep.mock.calls[0]?.[1]).toBe("budget");
  await h.emit("turn_end", { message: { stopReason: "stop" } });
  expect(h.sweep).toHaveBeenCalledTimes(1);
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
  await h.emit("session_shutdown", { reason: "reload" });
});

it.each([
  { child: true },
  { locked: true },
  { governance: false },
  { exists: false },
  { denyGate: true },
  { memoryOff: true },
  { secure: true },
  { noRegistry: true },
])("inadmissible auto paths remain inert %o", async (options) => {
  const h = setup({ ...options, jev: true });
  await h.emit("session_start", {});
  h.sweep.mockClear();
  h.render();
  await h.emit("turn_end", { message: { stopReason: "stop" } });
  expect(h.sweep).not.toHaveBeenCalled();
  if (options.exists === false) expect(existsSync(h.dir)).toBe(false);
  await h.emit("session_shutdown", { reason: "reload" });
});

it("sweep-origin invalidation updates budget observation without scheduling another sweep", async () => {
  const h = setup({ jev: true });
  await h.emit("session_start", {});
  h.sweep.mockClear();
  h.render();
  await h.emit("turn_end", { message: { stopReason: "stop" } });
  expect(h.sweep).toHaveBeenCalledTimes(1);
  writeFileSync(
    join(h.dir, "blocks/rule.001.md"),
    blockRaw({ id: "rule.001", authority: "user", scope: "global", body: "b".repeat(650) }),
  );
  h.write("sweep");
  h.render();
  await h.emit("turn_end", { message: { stopReason: "stop" } });
  expect(h.sweep).toHaveBeenCalledTimes(1);
  h.write();
  await h.emit("turn_end", { message: { stopReason: "stop" } });
  expect(h.sweep).toHaveBeenCalledTimes(3);
  expect(h.sweep.mock.calls[1]?.[1]).toBe("write");
  expect(h.sweep.mock.calls[2]?.[1]).toBe("budget");
  await h.emit("session_shutdown", { reason: "reload" });
});

it("the sweep gate refuses a replaced blocks directory even before another callback", async () => {
  const h = setup({ jev: true });
  await h.emit("session_start", {});
  h.render();
  await h.emit("turn_end", { message: { stopReason: "stop" } });
  const guard = h.runnerOptions.at(-1)?.gate;
  expect(guard?.check(h.dir).ok).toBe(true);
  renameSync(join(h.dir, "blocks"), join(h.dir, "old-blocks"));
  mkdirSync(join(h.dir, "blocks"));
  writeFileSync(join(h.dir, "blocks/.layout.json"), '{"v":1,"source":"fresh"}');
  expect(guard?.check(h.dir)).toEqual({ ok: false, reason: "identity-changed" });
  await h.emit("session_shutdown", { reason: "reload" });
});

it("session restart rejects a late successful result from the old epoch", async () => {
  const h = setup({ jev: true });
  await h.emit("session_start", {});
  const input = { command: "git push" };
  await h.emit("tool_call", { toolName: "bash", toolCallId: "old", input });
  await h.emit("session_start", {});
  h.sweep.mockClear();
  await h.emit("tool_result", {
    toolName: "bash",
    toolCallId: "old",
    input,
    content: [],
    isError: false,
    structuredContent: { exit_code: 0 },
  });
  await h.emit("turn_end", { message: { stopReason: "stop" } });
  expect(h.sweep).not.toHaveBeenCalled();
  await h.emit("session_shutdown", { reason: "reload" });
});

it("R2: registry loss cannot suppress abort revocation or revive old events and results", async () => {
  let reviewOptions: Parameters<typeof reviewModule.createFirstUserReviewHost>[0] | undefined;
  const dispose = vi.fn();
  vi.spyOn(reviewModule, "createFirstUserReviewHost").mockImplementation((opts) => {
    reviewOptions = opts;
    return { run: () => new Promise(() => {}), dispose, cancel: vi.fn() };
  });
  const h = setup({ jev: true, migrated: true });
  await h.emit("session_start", {});
  const initialSignal = h.sweep.mock.calls[0]?.[2] as AbortSignal;
  const initialGate = h.runnerOptions[0]?.gate;
  expect(initialSignal.aborted).toBe(false);
  expect(initialGate?.check(h.dir).ok).toBe(true);
  expect(reviewOptions?.isCurrent()).toBe(true);
  writeFileSync(join(h.dir, "blocks/.migration-report.json"), '{"files":[]}');
  for (const id of ["expired.001", "expired.002"]) {
    writeFileSync(
      join(h.dir, "blocks", `${id}.md`),
      blockRaw({ id, authority: "agent", expires: "2000-01-01", body: "expired" }),
    );
  }
  let releaseSweep = () => {},
    sweepStarted = () => {};
  const held = new Promise<void>((resolve) => {
    releaseSweep = resolve;
  });
  const started = new Promise<void>((resolve) => {
    sweepStarted = resolve;
  });
  let yieldCount = 0;
  const realRunner = realSweepRunner({
    enabled: true,
    gate: initialGate,
    yield: async () => {
      if (++yieldCount === 1) {
        sweepStarted();
        await held;
      }
    },
  });
  const realSweep = realRunner.runSweep(h.dir, "write", initialSignal);
  await started;
  h.sweep.mockClear();
  const first = { command: "git push" };
  await h.emit("tool_call", { toolName: "bash", toolCallId: "success", input: first });
  await h.emit("tool_result", {
    toolName: "bash",
    toolCallId: "success",
    input: first,
    content: [],
    isError: false,
    structuredContent: { exit_code: 0 },
  });
  const late = { command: "gh release create v1" };
  await h.emit("tool_call", { toolName: "bash", toolCallId: "late", input: late });
  const registry = h.ctx.modelRegistry;
  delete (h.ctx as { modelRegistry?: unknown }).modelRegistry;
  await h.emit("turn_end", { message: { stopReason: "aborted" } });
  expect(initialSignal.aborted).toBe(true);
  expect(initialGate?.check(h.dir).ok).toBe(false);
  expect(reviewOptions?.signal?.aborted).toBe(true);
  expect(reviewOptions?.isCurrent()).toBe(false);
  expect(dispose).toHaveBeenCalled();
  releaseSweep();
  const stopped = await realSweep;
  expect(stopped.stopped).toContain("ABORTED");
  expect(stopped.archived).toHaveLength(1);
  expect(existsSync(join(h.dir, "blocks/expired.002.md"))).toBe(true);
  h.ctx.modelRegistry = registry;
  await h.emit("tool_result", {
    toolName: "bash",
    toolCallId: "late",
    input: late,
    content: [],
    isError: false,
    structuredContent: { exit_code: 0 },
  });
  await h.emit("turn_end", { message: { stopReason: "stop" } });
  expect(h.sweep).not.toHaveBeenCalled();
  expect(existsSync(join(h.dir, "blocks/.jev/governance-markers.json"))).toBe(false);
  await h.emit("session_shutdown", { reason: "reload" });
});

it("R1: a deferred event is not replayed by an empty turn but merges with a later event", async () => {
  const h = setup({ jev: true });
  await h.emit("session_start", {});
  h.sweep.mockClear();
  h.sweep.mockResolvedValueOnce({ operations: 0, archived: [], stopped: "not-executed", suggestions: 0 });
  const command = async (id: string, value: string) => {
    const input = { command: value };
    await h.emit("tool_call", { toolName: "bash", toolCallId: id, input });
    await h.emit("tool_result", {
      toolName: "bash",
      toolCallId: id,
      input,
      content: [],
      isError: false,
      structuredContent: { exit_code: 0 },
    });
  };
  await command("a", "gh release create v1");
  await h.emit("turn_end", { message: { stopReason: "stop" } });
  await Promise.resolve();
  await h.emit("turn_end", { message: { stopReason: "stop" } });
  expect(h.sweep).toHaveBeenCalledTimes(1);
  await command("b", "git push");
  await h.emit("turn_end", { message: { stopReason: "stop" } });
  expect(h.sweep).toHaveBeenCalledTimes(2);
  expect(h.sweep.mock.calls[1]?.[1]).toBe("release");
  await h.emit("session_shutdown", { reason: "reload" });
});

it("the production startup review writes a completed migration marker", async () => {
  const h = setup({ jev: true, migrated: true });
  await h.emit("session_start", {});
  const marker = join(h.dir, "blocks/.jev/governance-markers.json");
  await vi.waitFor(() => {
    expect(JSON.parse(readFileSync(marker, "utf8")).markers["first-user-review/v1"]).toMatchObject({
      eligibleUsers: 1,
      selectedUsers: 1,
      reviewedPairs: 0,
    });
  });
  await h.emit("session_shutdown", { reason: "reload" });
});

it("shutdown revokes an in-flight first review's signal and owner", async () => {
  let captured: Parameters<typeof reviewModule.createFirstUserReviewHost>[0] | undefined;
  const run = vi.fn(() => new Promise<{ status: "incomplete" }>(() => {}));
  const dispose = vi.fn();
  vi.spyOn(reviewModule, "createFirstUserReviewHost").mockImplementation((opts) => {
    captured = opts;
    return { run, dispose, cancel: vi.fn() };
  });
  const h = setup({ jev: true, migrated: true });
  await h.emit("session_start", {});
  expect(captured?.isCurrent()).toBe(true);
  await h.emit("session_shutdown", { reason: "reload" });
  expect(captured?.signal?.aborted).toBe(true);
  expect(captured?.isCurrent()).toBe(false);
  expect(dispose).toHaveBeenCalled();
  expect(existsSync(join(h.dir, "blocks/.jev/governance-markers.json"))).toBe(false);
});

it("startup calls review host once and empty turns do not retry", async () => {
  const run = vi.fn(async () => ({ status: "skipped" as const }));
  const dispose = vi.fn();
  vi.spyOn(reviewModule, "createFirstUserReviewHost").mockReturnValue({ run, dispose, cancel: vi.fn() });
  const h = setup({ jev: true, migrated: true });
  await h.emit("session_start", {});
  expect(run).toHaveBeenCalledTimes(1);
  await h.emit("turn_end", { message: { stopReason: "stop" } });
  expect(run).toHaveBeenCalledTimes(1);
  await h.emit("session_shutdown", { reason: "reload" });
  expect(dispose).toHaveBeenCalled();
});
