import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createEventBus,
  SessionManager,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fakePi } from "../../integration/helpers/schedule-activate.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import { wireMemory } from "../../../src/memory/index.js";
import { wireMemoryScopes } from "../../../src/memory/scopes/wire.js";
import { createPromptSectionHub } from "../../../src/sysprompt/hub.js";
import { memoryDirFor, MemoryError } from "../../../src/memory/paths.js";
import { dirFormat, toolSurfaceFor } from "../../../src/memory/blocks/naming.js";
import { MemoryToolParamsV2, MemoryToolParamsV3 } from "../../../src/memory/tool-surface.js";
import { parseBlockFile } from "../../../src/memory/blocks/format.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function root() {
  const dir = mkdtempSync(join(tmpdir(), "unified-wire-"));
  dirs.push(dir);
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(dir, "memory"));
  return dir;
}
function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(path: string) {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) visit(name);
      else result[relative(dir, name)] = readFileSync(name).toString("base64");
    }
  }
  visit(dir);
  return result;
}
function setup(child = false, session = true, hub = false, secureDomainKind: "plain" | "locked" = "plain") {
  const cwd = root();
  const f = fakePi();
  f.pi.events = createEventBus();
  const registrations: string[] = [];
  const original = f.pi.registerTool.bind(f.pi);
  f.pi.registerTool = (tool) => {
    registrations.push(tool.name);
    original(tool);
  };
  const manager = SessionManager.inMemory(cwd);
  f.pi.appendEntry = (type, data) => {
    manager.appendCustomEntry(type, data);
  };
  const settings = {
    ...DEFAULT_MEMORY_SETTINGS,
    layout: "blocks" as const,
    scopes: { session, hub },
    jev: { ...DEFAULT_MEMORY_SETTINGS.jev, enabled: false },
  };
  const scopes = wireMemoryScopes(f.pi, {
    settings,
    child,
    domain: secureDomainKind,
    gate: { check: () => ({ ok: true }) },
    locked: () => false,
    remote: () => undefined,
    hubPaths: () => ({ stateDir: join(cwd, "hub") }),
  });
  const sections = createPromptSectionHub(f.pi, {
    mode: () => "stable",
    wakeReplay: false,
    adoptForeignForcedPrompt: false,
  });
  wireMemory(f.pi, { settings, ...(scopes ? { scopes } : {}), isChildSession: child, sections, secureDomainKind });
  let resolveSelect: ((value: string | undefined) => void) | undefined;
  const select = vi.fn(
    () =>
      new Promise<string | undefined>((resolve) => {
        resolveSelect = resolve;
      }),
  );
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    sessionManager: manager,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { select, notify() {} },
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: object) => {
    for (const fn of f.handlers.get(name) ?? []) await fn(event, ctx);
  };
  const call = (name: string, input: object, withContext = true) =>
    (f.tools.get(name) as ToolDefinition).execute(
      "test",
      input,
      undefined,
      undefined,
      withContext ? ctx : (undefined as never),
    );
  const counts = () => ({
    memory: registrations.filter((n) => n === "memory").length,
    scoped: registrations.filter((n) => n === "scoped_memory").length,
  });
  return {
    cwd,
    f,
    manager,
    scopes,
    settings,
    ctx,
    emit,
    call,
    counts,
    select,
    approve: () => resolveSelect?.(select.mock.calls[0]?.[1][1]),
  };
}
function text(result: unknown): string {
  return (result as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
}

it("wires the old registered surfaces through session, tree and shutdown", async () => {
  const h = setup();
  try {
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    expect(h.counts()).toEqual({ memory: 1, scoped: 1 });
    expect(text(await h.call("memory", { command: "create", topic: "gate", text: "- durable fact" }))).toContain(
      "gate.001",
    );
    const view = text(await h.call("memory", { command: "view", path: "gate.001" }));
    expect(view).toContain("- durable fact");
    const block = parseBlockFile(
      "gate.001.md",
      readFileSync(join(memoryDirFor(h.cwd), "blocks", "gate.001.md"), "utf8"),
    );
    if ("stray" in block) throw new Error("created block is invalid");
    for (const [rev, message] of [
      [undefined, `E_REV_REQUIRED: update requires rev — current rev ${block.rev} (view gate.001 for the latest)`],
      ["stale", `E_CONFLICT: current rev ${block.rev}\n${block.body}\nmerge and retry update with the current rev`],
    ] as const) {
      try {
        await h.call("memory", { command: "update", path: "gate.001", text: "- changed", ...(rev ? { rev } : {}) });
        throw new Error("expected MemoryError");
      } catch (error) {
        expect(error).toBeInstanceOf(MemoryError);
        expect((error as Error).message).toBe(message);
      }
    }
    expect(JSON.parse(text(await h.call("scoped_memory", { op: "view" })))).toMatchObject({
      ok: false,
      code: "E_SCOPE_DISABLED",
    });
    // Deliver the actual input and before-agent-start hooks synchronously within the same SDK dispatch context.
    for (const fn of h.f.handlers.get("input") ?? [])
      fn({ type: "input", source: "interactive", text: "remember" }, h.ctx);
    for (const fn of h.f.handlers.get("before_agent_start") ?? [])
      fn({ type: "before_agent_start", messageType: "user", prompt: "remember" }, h.ctx);
    const before = snapshot(h.cwd);
    const entriesBefore = h.manager.getBranch();
    const pending = h.call("scoped_memory", {
      op: "create",
      storageScope: "session",
      authority: "user",
      text: "approval must be revoked",
    });
    for (let i = 0; i < 20 && h.select.mock.calls.length === 0; i++) await new Promise<void>((r) => setImmediate(r));
    expect(h.select).toHaveBeenCalledTimes(1);
    await h.emit("session_tree", { type: "session_tree" });
    expect(h.counts()).toEqual({ memory: 1, scoped: 1 });
    expect(JSON.parse(text(await pending))).toMatchObject({ ok: false, code: "E_HUB_DECLINED" });
    h.approve();
    await Promise.resolve();
    expect(h.manager.getBranch()).toEqual(entriesBefore);
    expect(snapshot(h.cwd)).toEqual(before);
    await h.emit("session_shutdown", { type: "session_shutdown" });
    expect(h.counts()).toEqual({ memory: 1, scoped: 1 });
    const stopped = snapshot(h.cwd);
    const stoppedEntries = h.manager.getBranch();
    const one = text(await h.call("scoped_memory", { op: "create", storageScope: "session", text: "after shutdown" }));
    const two = text(await h.call("scoped_memory", { op: "create", storageScope: "session", text: "after shutdown" }));
    expect.soft(JSON.parse(one)).toMatchObject({ ok: false, code: "E_STALE_SESSION" });
    expect.soft(two).toBe(one);
    expect.soft(snapshot(h.cwd)).toEqual(stopped);
    expect.soft(h.manager.getBranch()).toEqual(stoppedEntries);
  } finally {
    h.scopes?.dispose();
    h.f.pi.events.clear();
  }
});

it("creates child hub-only wiring without registering scoped_memory", async () => {
  const h = setup(true, false, true);
  try {
    expect(Boolean(h.scopes)).toBe(true);
    expect(h.counts()).toEqual({ memory: 1, scoped: 0 });
    expect(h.f.tools.has("scoped_memory")).toBe(false);
    for (const name of ["session_start", "session_tree", "session_shutdown"]) {
      await h.emit(name, { type: name, reason: "startup" });
      expect(h.counts()).toEqual({ memory: 1, scoped: 0 });
    }
  } finally {
    h.scopes?.dispose();
    h.f.pi.events.clear();
  }
});

it.each([
  ["held", false, "held", "v2"],
  ["files+auto", false, "files", "v3"],
  ["secureLocked", true, "files", "v2"],
] as const)(
  "%s follows actual toolSurfaceFor while stage 1 never publishes v4",
  (_name, locked, expectedFormat, expectedSurface) => {
    const h = setup(false, false, false, locked ? "locked" : "plain");
    try {
      // wireMemory selects against process.cwd(), not the eventual invocation cwd. Re-wire after arranging that directory.
      const dir = memoryDirFor(process.cwd());
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, expectedFormat === "held" ? ".blocks-hold" : "core.md"), "test\n");
      const format = dirFormat(dir);
      expect(format).toBe(expectedFormat);
      const actual = toolSurfaceFor(h.settings, format, locked);
      expect(actual).toBe(expectedSurface);
      const f = fakePi();
      wireMemory(f.pi, {
        settings: h.settings,
        isChildSession: false,
        secureDomainKind: locked ? "locked" : "plain",
        sections: createPromptSectionHub(f.pi, {
          mode: () => "stable",
          wakeReplay: false,
          adoptForeignForcedPrompt: false,
        }),
      });
      const tool = f.tools.get("memory") as ToolDefinition;
      const props = (tool.parameters as unknown as { properties: Record<string, unknown> }).properties;
      expect(tool.parameters).toEqual(actual === "v3" ? MemoryToolParamsV3 : MemoryToolParamsV2);
      expect("scope" in props).toBe(false);
      expect("command" in props).toBe(true);
      expect(actual === "v3" && "scope" in props).toBe(false);
    } finally {
      h.scopes?.dispose();
      h.f.pi.events.clear();
    }
  },
);
