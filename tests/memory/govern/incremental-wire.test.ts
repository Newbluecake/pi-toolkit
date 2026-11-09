import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wireMemory, type WireMemoryOpts } from "../../../src/memory/index.js";
import { wireMemoryScopes, type MemoryScopesWiring } from "../../../src/memory/scopes/wire.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import { memoryDirFor } from "../../../src/memory/paths.js";
import * as sweepModule from "../../../src/memory/govern/sweep.js";
import * as toolModule from "../../../src/memory/tool-v3.js";
import { createFakeRegistry } from "../jev/helpers/fake-registry.js";
import { blockRaw } from "../blocks/helpers.js";
import type { MemoryActivityOwner, MemoryActivitySnapshot } from "../../../src/memory/govern/activity.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function setup(
  options: {
    noOwner?: boolean;
    scopesOff?: boolean;
    incrementalOff?: boolean;
    domain?: "plain" | "secure" | "locked";
    child?: boolean;
  } = {},
) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const root = mkdtempSync(join(tmpdir(), "p50-wire-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd);
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(root, "memory"));
  const dir = memoryDirFor(cwd),
    blocks = join(dir, "blocks");
  mkdirSync(blocks, { recursive: true });
  writeFileSync(join(blocks, ".layout.json"), JSON.stringify({ v: 1, source: "fresh" }));
  writeFileSync(
    join(blocks, "rule.001.md"),
    blockRaw({ id: "rule.001", authority: "agent", body: "durable testing convention" }),
  );
  const original = readFileSync(join(blocks, "rule.001.md"));
  const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  const pi = {
    on: (name: string, fn: any) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    sendMessage: vi.fn(),
    getActiveTools: () => [],
  } as unknown as ExtensionAPI;
  const settings = {
    ...DEFAULT_MEMORY_SETTINGS,
    scopes: { session: !options.scopesOff, hub: false },
    incremental: { ...DEFAULT_MEMORY_SETTINGS.incremental, enabled: !options.incrementalOff },
    jev: { ...DEFAULT_MEMORY_SETTINGS.jev, predict: { ...DEFAULT_MEMORY_SETTINGS.jev.predict, enabled: false } },
    migrate: { auto: false },
    doctor: { ...DEFAULT_MEMORY_SETTINGS.doctor, notifyOnStart: false },
  };
  const { registry, calls } = createFakeRegistry({ available: ["opencode/jev-1.13-free", "opencode/jev-1.13"] });
  const ctx = {
    cwd,
    hasUI: false,
    ui: {},
    modelRegistry: registry,
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
    sessionManager: { getBranch: () => [], getSessionId: () => "one" },
  };
  const state = { generation: 0, lastActivityAt: 0, running: false, unknown: false };
  const tools = new Set<string>();
  const finished = new Set<string>();
  const activity: MemoryActivityOwner = {
    snapshot: vi.fn((): MemoryActivitySnapshot => ({
      generation: state.generation,
      lastActivityAt: state.lastActivityAt,
      running: state.running,
      toolsInFlight: tools.size,
      liveIdle: state.unknown ? undefined : ctx.isIdle(),
      hasPendingMessages: ctx.hasPendingMessages(),
    })),
    noteToolCall: vi.fn((id, now) => {
      tools.add(id);
      state.lastActivityAt = now;
      state.generation++;
    }),
    noteToolResult: vi.fn((id, now) => {
      if (!tools.delete(id) && !finished.has(id)) state.unknown = true;
      finished.add(id);
      state.lastActivityAt = now;
      state.generation++;
    }),
    noteMemoryWrite: vi.fn((now) => {
      state.lastActivityAt = now;
      state.generation++;
    }),
  }; // Test-owned fake port deliberately has NO subscribe.
  const runtime = { owner: { sessionEpoch: 1 }, capability: () => "ok", current: () => true };
  let scopes: MemoryScopesWiring | undefined;
  if (options.scopesOff) {
    scopes = wireMemoryScopes(pi, {
      settings,
      child: false,
      domain: "plain",
      gate: { check: () => ({ ok: true }) },
      locked: () => false,
      remote: () => undefined,
      hubPaths: () => undefined,
    });
    expect(scopes).toBeUndefined();
  } else {
    scopes = {
      current: () => runtime,
      group: () => undefined,
      activity: () => (options.noOwner ? undefined : activity),
      attachDispatcher() {},
      command: async () => ({ handled: false }),
      context() {},
      dispose() {},
      proof: {},
    } as unknown as MemoryScopesWiring;
  }
  const sweep = vi.fn(async () => ({ operations: 0, archived: [], stopped: "done", suggestions: 0 }));
  vi.spyOn(sweepModule, "createSweepRunner").mockReturnValue({ runSweep: sweep });
  let afterWrite: ((cwd: string, origin?: string) => void) | undefined;
  const createTool = toolModule.createMemoryToolV3;
  vi.spyOn(toolModule, "createMemoryToolV3").mockImplementation((deps) => {
    afterWrite = deps.onAfterWrite;
    return createTool(deps);
  });
  const batch = vi.fn(() => ({ kind: "settled" as const }));
  wireMemory(pi, {
    settings,
    ...(scopes ? { scopes } : {}),
    isChildSession: options.child === true,
    secureDomainKind: options.domain ?? "plain",
    incrementalBatchHandler: batch,
    incrementalAdmission: () => true,
    todo: () => ({ list: () => [{ id: 1, subject: "task", status: "pending" }] }),
    sections: { register() {}, _state: () => undefined } as unknown as WireMemoryOpts["sections"],
  });
  const emit = async (name: string, event: any = {}) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
  };
  await emit("session_start");
  const write = async (n = 5, origin?: string) => {
    for (let i = 0; i < n; i++) afterWrite?.(cwd, origin);
    await vi.advanceTimersByTimeAsync(0);
  };
  return {
    dir,
    blocks,
    original,
    settings,
    calls,
    activity,
    state,
    ctx,
    tools,
    handlers,
    emit,
    write,
    batch,
    sweep,
    pi,
  };
}

it.each(["tool_result", "turnEnd"])("no subscribe: existing %s hook naturally wakes the scheduler", async (source) => {
  const h = await setup();
  h.state.running = source === "turnEnd";
  if (source === "tool_result")
    await h.emit("tool_call", { toolName: "read", toolCallId: "long", input: { path: "a" } });
  await h.write();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(h.batch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  if (source === "tool_result")
    await h.emit("tool_result", {
      toolName: "read",
      toolCallId: "long",
      input: { path: "a" },
      content: [],
      isError: false,
    });
  else {
    h.state.running = false;
    h.state.lastActivityAt = Date.now();
    await h.emit("turn_end", { message: { stopReason: "stop" } });
  }
  await vi.advanceTimersByTimeAsync(1999);
  expect(h.batch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.batch).toHaveBeenCalledTimes(1);
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
  expect(readFileSync(join(h.blocks, "rule.001.md"))).toEqual(h.original);
});

it("no subscribe: turnEnd schedules only one live check for a later onSettled", async () => {
  const h = await setup();
  h.state.running = true;
  await h.write();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(h.batch).not.toHaveBeenCalled();
  await h.emit("turn_end", { message: { stopReason: "stop" } });
  // The real proof's onSettled may occur AFTER Jev's turn_end handler.
  h.state.running = false;
  h.state.lastActivityAt = Date.now();
  await vi.advanceTimersByTimeAsync(1999);
  expect(h.batch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.batch).toHaveBeenCalledTimes(1);
});
it("no subscribe: a still-busy fallback check does not create a polling loop", async () => {
  const h = await setup();
  h.state.running = true;
  await h.write();
  await vi.advanceTimersByTimeAsync(15_000);
  await h.emit("turn_end", { message: { stopReason: "stop" } });
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.batch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("activity recording is not skipped when the classifier registry is temporarily unavailable", async () => {
  const h = await setup();
  delete (h.ctx as { modelRegistry?: unknown }).modelRegistry;
  await h.emit("tool_call", { toolName: "read", toolCallId: "long-no-registry", input: { path: "a" } });
  await h.write();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(h.activity.noteToolCall).toHaveBeenCalledWith("long-no-registry", 0);
  expect(h.batch).not.toHaveBeenCalled();
  await h.emit("tool_result", {
    toolName: "read",
    toolCallId: "long-no-registry",
    input: { path: "a" },
    content: [],
    isError: false,
  });
  expect(h.activity.noteToolResult).toHaveBeenCalledWith("long-no-registry", 15000);
  expect(h.tools.size).toBe(0);
});

it.each(["scopes-off", "missing-proof-activity"])(
  "%s is fail-closed: zero P50 timer/client/revision write",
  async (mode) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = await setup({ scopesOff: mode === "scopes-off", noOwner: true });
    const before = readdirSync(h.blocks, { recursive: true }).sort();
    await h.write();
    await h.emit("tool_call", {
      toolName: "TaskUpdate",
      toolCallId: "done",
      input: { taskId: "1", status: "completed" },
    });
    await h.emit("tool_result", {
      toolName: "TaskUpdate",
      toolCallId: "done",
      input: { taskId: "1", status: "completed" },
      content: [],
      isError: false,
      details: { action: "update", changed: true, task: { id: 1, status: "completed" } },
    });
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(h.batch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    // #36 first-review may create its pre-existing empty index on task-done.
    // P50 must not create revision evidence/proposals or invoke a model.
    const after = readdirSync(h.blocks, { recursive: true }).sort();
    expect(after.filter((name) => name !== ".jev" && name !== ".jev/index.json")).toEqual(before);
    // Existing Jev classification/review remains allowed; compare its calls to
    // P50-off rather than falsely attributing all classifier traffic to P50.
    const baseline = await setup({ scopesOff: mode === "scopes-off", noOwner: true, incrementalOff: true });
    await baseline.write();
    await baseline.emit("tool_call", {
      toolName: "TaskUpdate",
      toolCallId: "done",
      input: { taskId: "1", status: "completed" },
    });
    await baseline.emit("tool_result", {
      toolName: "TaskUpdate",
      toolCallId: "done",
      input: { taskId: "1", status: "completed" },
      content: [],
      isError: false,
      details: { action: "update", changed: true, task: { id: 1, status: "completed" } },
    });
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(h.calls.map((c) => [c.id, c.questions])).toEqual(baseline.calls.map((c) => [c.id, c.questions]));
    expect(readdirSync(h.blocks, { recursive: true }).sort()).toEqual(
      readdirSync(baseline.blocks, { recursive: true }).sort(),
    );
    expect(readFileSync(join(h.blocks, "rule.001.md"))).toEqual(h.original);
    expect(h.activity.snapshot).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((call) => String(call[0]).startsWith("p50:")).length).toBe(1);
  },
);

it.each([undefined, "external", "unknown", "sweep", "revision", "p50-auto"])(
  "real onAfterWrite origin=%s shares sweep/P50 suppression",
  async (origin) => {
    const h = await setup();
    h.sweep.mockClear();
    await h.write(5, origin);
    await vi.advanceTimersByTimeAsync(15_000);
    const internal = ["sweep", "revision", "p50-auto"].includes(origin ?? "");
    expect(h.batch).toHaveBeenCalledTimes(internal ? 0 : 1);
    expect(h.sweep).toHaveBeenCalledTimes(internal ? 0 : 5);
    expect(h.activity.noteMemoryWrite).toHaveBeenCalledTimes(5);
  },
);

it.each(["success", "failed", "unchanged", "unknown-task", "subagent"])(
  "only proven TaskUpdate completed is eligible: %s",
  async (outcome) => {
    const h = await setup();
    await h.write(3);
    const input = { taskId: outcome === "unknown-task" ? "999" : "1", status: "completed" };
    const toolName = outcome === "subagent" ? "Agent" : "TaskUpdate";
    await h.emit("tool_call", { toolName, toolCallId: "task", input });
    await h.emit("tool_result", {
      toolName,
      toolCallId: "task",
      input,
      content: [],
      isError: outcome === "failed",
      details: {
        action: "update",
        changed: outcome !== "unchanged",
        task: { id: Number(input.taskId), status: "completed" },
      },
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(h.batch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.batch).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
  },
);

it.each(["abort", "shutdown", "reload"])("existing %s lifecycle cancels incremental waiting", async (reason) => {
  const h = await setup();
  await h.write();
  if (reason === "abort") await h.emit("turn_end", { message: { stopReason: "aborted" } });
  else await h.emit("session_shutdown", { reason });
  await vi.advanceTimersByTimeAsync(1_000_000);
  expect(h.batch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await h.write();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(h.batch).not.toHaveBeenCalled();
});

it.each([{ incrementalOff: true }, { domain: "secure" as const }, { domain: "locked" as const }, { child: true }])(
  "off/secure/child creates no P50 work: %j",
  async (options) => {
    const h = await setup(options);
    await h.write();
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(h.batch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);
