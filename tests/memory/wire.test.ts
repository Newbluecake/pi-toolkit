// memory-plan §7.8: wireMemory closure wiring, driven by an inline fakePi
// (skeleton per tests/todo/tools.test.ts). This is the ONE test file that
// cannot inject `paths` (WireMemoryOpts is frozen to {settings,
// isChildSession}), so it stubs ARMORY_MEMORY_ROOT to a tmpdir instead —
// defaultPaths() honors that env override (§2, original-plugin test hook).
//
// Render counting uses vi.mock on render.js (per-file mock, no shared
// helper) because the cache/freeze behavior is otherwise unobservable:
// identical output twice cannot distinguish a cache hit from a re-render.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type MemorySettings } from "../../src/config/settings.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTool = ToolDefinition<any, any, any>;

const counters = vi.hoisted(() => ({ renders: 0 }));

vi.mock("../../src/memory/render.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/memory/render.js")>();
  return {
    ...mod,
    renderMemoryBlock: (...args: Parameters<typeof mod.renderMemoryBlock>) => {
      counters.renders++;
      return mod.renderMemoryBlock(...args);
    },
  };
});

import { wireMemory } from "../../src/memory/index.js";

interface Host {
  pi: ExtensionAPI;
  tools: Map<string, AnyTool>;
  commands: Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>;
  handlers: Map<string, (event: any, ctx: any) => unknown>;
}

function fakePi(): Host {
  const host: Host = {
    pi: undefined as unknown as ExtensionAPI,
    tools: new Map(),
    commands: new Map(),
    handlers: new Map(),
  };
  host.pi = {
    registerTool: (def: AnyTool) => host.tools.set(def.name, def),
    registerCommand: (name: string, options: never) => host.commands.set(name, options),
    on: (event: string, handler: never) => host.handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  return host;
}

function fakeCtx(cwd: string) {
  const notifications: string[] = [];
  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    ui: { notify: (m: string) => notifications.push(m) },
  } as unknown as ExtensionContext;
  return { ctx, notifications };
}

let tmp = "";
let cwd = "";
let memRoot = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pi-mem-wire-"));
  cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  memRoot = join(tmp, "mem");
  vi.stubEnv("ARMORY_MEMORY_ROOT", memRoot);
  counters.renders = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function wire(host: Host, settings: Partial<MemorySettings> = {}) {
  wireMemory(host.pi, { settings: { ...DEFAULT_SETTINGS.memory, ...settings }, isChildSession: false });
}

function hookOf(host: Host) {
  const handler = host.handlers.get("before_agent_start");
  if (!handler) throw new Error("before_agent_start not registered");
  return (systemPrompt: string) =>
    handler(
      { type: "before_agent_start", prompt: "", systemPrompt, systemPromptOptions: { cwd } },
      fakeCtx(cwd).ctx,
    ) as Promise<{ systemPrompt: string } | undefined>;
}

async function writeViaTool(host: Host, name: string, content: string) {
  const tool = host.tools.get("memory");
  if (!tool) throw new Error("memory tool not registered");
  await tool.execute("c1", { action: "write", name, content }, undefined, undefined, fakeCtx(cwd).ctx);
}

function seedMemoryFile(name: string, body: string) {
  const slug = cwd.replace(/\/+$/, "").replace(/\//g, "-");
  const dir = join(memRoot, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
}

describe("wireMemory (§7.8)", () => {
  test("registers the memory tool, /mem command, and both hooks", () => {
    const host = fakePi();
    wire(host);
    expect(host.tools.has("memory")).toBe(true);
    expect(host.commands.has("mem")).toBe(true);
    expect(host.handlers.has("before_agent_start")).toBe(true);
    expect(host.handlers.has("session_start")).toBe(true);
  });

  test("settings.enabled is NOT read here — the gate lives in the assembly layer (Nit 7)", () => {
    const host = fakePi();
    wire(host, { enabled: false });
    expect(host.tools.has("memory")).toBe(true);
    expect(host.handlers.has("before_agent_start")).toBe(true);
  });

  test("hook serves the shared RenderCache: second call with unchanged files does not re-render", async () => {
    const host = fakePi();
    wire(host);
    seedMemoryFile("a.md", "alpha");
    const hook = hookOf(host);
    const first = await hook("BASE");
    const second = await hook("BASE");
    expect(counters.renders).toBe(1);
    expect(second!.systemPrompt).toBe(first!.systemPrompt);
    expect(first!.systemPrompt).toContain("alpha");
  });

  test("freezeInjectionAfterWrite=false: a tool write invalidates the cache and the next turn re-renders", async () => {
    const host = fakePi();
    wire(host);
    seedMemoryFile("a.md", "alpha");
    const hook = hookOf(host);
    const before = await hook("BASE");
    expect(before!.systemPrompt).not.toContain("bravo");
    await writeViaTool(host, "b.md", "bravo");
    const after = await hook("BASE");
    expect(counters.renders).toBe(2);
    expect(after!.systemPrompt).toContain("bravo");
  });

  test("freezeInjectionAfterWrite=true: bytes stay frozen until session_start thaws", async () => {
    const host = fakePi();
    wire(host, { freezeInjectionAfterWrite: true });
    seedMemoryFile("a.md", "alpha");
    const hook = hookOf(host);
    const before = await hook("BASE");
    await writeViaTool(host, "b.md", "bravo");
    const frozen = await hook("BASE");
    expect(counters.renders).toBe(1); // no re-render while frozen
    expect(frozen!.systemPrompt).toBe(before!.systemPrompt);
    expect(frozen!.systemPrompt).not.toContain("bravo");
    // /new (session_start) thaws; the write takes effect.
    host.handlers.get("session_start")?.({}, fakeCtx(cwd).ctx);
    const thawed = await hook("BASE");
    expect(counters.renders).toBe(2);
    expect(thawed!.systemPrompt).toContain("bravo");
  });

  test("R3: freeze with no prior render freezes to NO block; session_start restores rendering", async () => {
    const host = fakePi();
    wire(host, { freezeInjectionAfterWrite: true });
    const hook = hookOf(host);
    // write before the hook ever ran ⇒ cache.peek misses ⇒ frozen to undefined
    await writeViaTool(host, "a.md", "alpha");
    expect(await hook("BASE")).toBeUndefined();
    host.handlers.get("session_start")?.({}, fakeCtx(cwd).ctx);
    const after = await hook("BASE");
    expect(after!.systemPrompt).toContain("alpha");
  });
});
