// memory-plan §7.8 / sysprompt-stable plan v3.1 §4.6 (M3): wireMemory closure
// wiring, driven by an inline fakePi that mirrors pi's real registration
// semantics (`on()` appends, every handler fires — loader.ts). M3 changed
// `wireMemory` to register the `pi_project_memory` section into a
// `PromptSectionHub` instead of registering its own `before_agent_start`
// hook, so these tests build a real hub (via `createPromptSectionHub`) in
// `mode: "legacy"` (byte-identical to the pre-M3 hook: the fold reflects the
// live provider value every turn, with no snapshot/update-message layer in
// the way) and drive the hub's `before_agent_start` handler.
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
import { createPromptSectionHub, type PromptSectionHub } from "../../src/sysprompt/hub.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTool = ToolDefinition<any, any, any>;
type Handler = (event: any, ctx: any) => unknown;

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
  handlers: Map<string, Handler[]>;
  hub: PromptSectionHub;
}

/** Mirrors pi's registration semantics: `on()` appends, every handler fires
 *  (loader.ts on()). The hub AND wireMemory both register `session_start`
 *  (hub for its own read-back state, wireMemory to clear frozenBlocks) —
 *  both must fire, which is why this fake keeps a list per event rather than
 *  the single-handler map used by tests/sysprompt/hub.test.ts. */
function fakePi(): Host {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, AnyTool>();
  const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
  const pi = {
    registerTool: (def: AnyTool) => tools.set(def.name, def),
    registerCommand: (name: string, options: never) => commands.set(name, options as never),
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
  // `mode: "legacy"` reproduces the pre-M3 hook's exact contract: the fold
  // reflects each provider's live value on every turn (no frozen snapshot,
  // no tail update messages) — the same shape these tests asserted on before
  // the section/hub split existed. wakeReplay is off (no pi-ai transcript
  // helpers needed here; covered by tests/sysprompt/*).
  const hub = createPromptSectionHub(pi, { mode: () => "legacy", wakeReplay: false, adoptForeignForcedPrompt: false });
  return { pi, tools, commands, handlers, hub };
}

function emit(host: Host, event: string, payload: unknown, ctx: unknown = {}): unknown[] {
  return (host.handlers.get(event) ?? []).map((h) => h(payload, ctx));
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
  wireMemory(host.pi, {
    settings: { ...DEFAULT_SETTINGS.memory, ...settings },
    isChildSession: false,
    sections: host.hub,
  });
}

function hookOf(host: Host) {
  const [handler] = host.handlers.get("before_agent_start") ?? [];
  if (!handler) throw new Error("before_agent_start not registered");
  return (systemPrompt: string) =>
    handler(
      { type: "before_agent_start", prompt: "", systemPrompt, systemPromptOptions: { cwd } },
      fakeCtx(cwd).ctx,
    ) as { systemPrompt: string } | undefined;
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

describe("wireMemory (§7.8, M3: registers into the hub)", () => {
  test("registers the memory tool, /mem command, and both hooks", () => {
    const host = fakePi();
    wire(host);
    expect(host.tools.has("memory")).toBe(true);
    expect(host.commands.has("mem")).toBe(true);
    // The hub owns before_agent_start unconditionally (registered at
    // createPromptSectionHub time, before wireMemory runs); wireMemory adds
    // its OWN session_start listener (frozenBlocks.clear()) alongside the
    // hub's session_start listener.
    expect(host.handlers.has("before_agent_start")).toBe(true);
    expect(host.handlers.get("session_start")?.length).toBeGreaterThanOrEqual(2);
  });

  test("settings.enabled is NOT read here — the gate lives in the assembly layer (Nit 7)", () => {
    const host = fakePi();
    wire(host, { enabled: false });
    expect(host.tools.has("memory")).toBe(true);
    expect(host.handlers.has("before_agent_start")).toBe(true);
  });

  test("hook serves the shared RenderCache: second call with unchanged files does not re-render", () => {
    const host = fakePi();
    wire(host);
    seedMemoryFile("a.md", "alpha");
    const hook = hookOf(host);
    const first = hook("BASE");
    const second = hook("BASE");
    expect(counters.renders).toBe(1);
    expect(second!.systemPrompt).toBe(first!.systemPrompt);
    expect(first!.systemPrompt).toContain("alpha");
  });

  test("freezeInjectionAfterWrite=false: a tool write invalidates the cache and the next turn re-renders", async () => {
    const host = fakePi();
    wire(host);
    seedMemoryFile("a.md", "alpha");
    const hook = hookOf(host);
    const before = hook("BASE");
    expect(before!.systemPrompt).not.toContain("bravo");
    await writeViaTool(host, "b.md", "bravo");
    const after = hook("BASE");
    expect(counters.renders).toBe(2);
    expect(after!.systemPrompt).toContain("bravo");
  });

  test("freezeInjectionAfterWrite=true: bytes stay frozen until session_start thaws", async () => {
    const host = fakePi();
    wire(host, { freezeInjectionAfterWrite: true });
    seedMemoryFile("a.md", "alpha");
    const hook = hookOf(host);
    const before = hook("BASE");
    await writeViaTool(host, "b.md", "bravo");
    const frozen = hook("BASE");
    expect(counters.renders).toBe(1); // no re-render while frozen
    expect(frozen!.systemPrompt).toBe(before!.systemPrompt);
    expect(frozen!.systemPrompt).not.toContain("bravo");
    // /new (session_start) thaws; the write takes effect.
    emit(host, "session_start", { type: "session_start", reason: "new" }, fakeCtx(cwd).ctx);
    const thawed = hook("BASE");
    expect(counters.renders).toBe(2);
    expect(thawed!.systemPrompt).toContain("bravo");
  });

  test("R3: freeze with no prior render freezes to NO block; session_start restores rendering", async () => {
    const host = fakePi();
    wire(host, { freezeInjectionAfterWrite: true });
    const hook = hookOf(host);
    // write before the hook ever ran ⇒ cache.peek misses ⇒ frozen to undefined
    await writeViaTool(host, "a.md", "alpha");
    expect(hook("BASE")).toBeUndefined();
    emit(host, "session_start", { type: "session_start", reason: "new" }, fakeCtx(cwd).ctx);
    const after = hook("BASE");
    expect(after!.systemPrompt).toContain("alpha");
  });
});
