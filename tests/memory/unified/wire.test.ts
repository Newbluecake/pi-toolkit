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
import { memoryDirFor } from "../../../src/memory/paths.js";
import { dirFormat, toolSurfaceFor } from "../../../src/memory/blocks/naming.js";
import { MemoryToolParamsV2 } from "../../../src/memory/tool-surface.js";
import { MemoryToolParamsV4 } from "../../../src/memory/unified/surface.js";
import type { MemorySettings } from "../../../src/memory/settings.js";
import { createMemoryTool } from "../../../src/memory/tool.js";
import { MEMORY_BIND_EVENT, type MemoryBindRequest } from "../../../src/memory/scopes/child-bind.js";
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
function setup(
  child = false,
  session = true,
  hub = false,
  secureDomainKind: "plain" | "secure" | "locked" = "plain",
  override: Partial<MemorySettings> = {},
  arrange?: (cwd: string) => void,
) {
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
    ...override,
  };
  arrange?.(cwd);
  const hubPaths = vi.fn(() => ({ stateDir: join(cwd, "hub") }));
  const scopes = wireMemoryScopes(f.pi, {
    settings,
    child,
    domain: secureDomainKind,
    gate: { check: () => ({ ok: true }) },
    locked: () => false,
    remote: () => undefined,
    hubPaths,
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
    hubPaths,
    approve: () => resolveSelect?.(select.mock.calls.at(-1)?.[1][1]),
  };
}
function text(result: unknown): string {
  return (result as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
}

it.each(["memory", "scoped_memory"] as const)(
  "wires registered v4/alias through session, tree and shutdown (pending %s)",
  async (pendingTool) => {
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
        const failure = JSON.parse(
          text(
            await h.call("memory", {
              command: "update",
              path: "gate.001",
              text: "- changed",
              ...(rev ? { rev } : {}),
            }),
          ),
        );
        expect(failure).toMatchObject({
          ok: false,
          code: rev ? "E_CONFLICT" : "E_REV_REQUIRED",
          ...(rev ? { originalMessage: message } : {}),
        });
      }
      expect(JSON.parse(text(await h.call("scoped_memory", { op: "view" })))).toMatchObject({
        ok: false,
        code: "E_SCOPE_DISABLED",
      });
      expect(h.f.tools.get("memory")?.parameters).toEqual(MemoryToolParamsV4);
      const v4Created = JSON.parse(
        text(await h.call("memory", { command: "create", scope: "session", text: "v4 session write" })),
      );
      expect(v4Created).toMatchObject({ ok: true });
      expect(v4Created).not.toHaveProperty("deprecation");
      const created = JSON.parse(
        text(await h.call("scoped_memory", { op: "create", storageScope: "session", text: "session fact" })),
      );
      expect(created).toMatchObject({
        ok: true,
        deprecation: {
          replacement: { tool: "memory", params: { command: "create", scope: "session", text: "session fact" } },
        },
      });
      const viewed = JSON.parse(
        text(await h.call("scoped_memory", { op: "view", storageScope: "session", id: created.id })),
      );
      const replayed = JSON.parse(text(await h.call("memory", viewed.deprecation.replacement.params)));
      expect(replayed).toEqual({ ok: true, id: created.id, rev: viewed.rev, item: viewed.item });
      const failed = JSON.parse(
        text(
          await h.call("scoped_memory", {
            op: "update",
            storageScope: "session",
            id: created.id,
            rev: "stale",
            text: "changed",
          }),
        ),
      );
      expect(failed).toMatchObject({ ok: false, code: "E_CONFLICT" });
      expect(failed).not.toHaveProperty("deprecation");
      // Deliver the actual input and before-agent-start hooks synchronously within the same SDK dispatch context.
      for (const fn of h.f.handlers.get("input") ?? [])
        fn({ type: "input", source: "interactive", text: "remember" }, h.ctx);
      for (const fn of h.f.handlers.get("before_agent_start") ?? [])
        fn({ type: "before_agent_start", messageType: "user", prompt: "remember" }, h.ctx);
      const before = snapshot(h.cwd);
      const entriesBefore = h.manager.getBranch();
      const pending = h.call(pendingTool, {
        ...(pendingTool === "memory"
          ? { command: "create", scope: "session" }
          : { op: "create", storageScope: "session" }),
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
      const one = text(
        await h.call("scoped_memory", { op: "create", storageScope: "session", text: "after shutdown" }),
      );
      const two = text(
        await h.call("scoped_memory", { op: "create", storageScope: "session", text: "after shutdown" }),
      );
      expect.soft(JSON.parse(one)).toMatchObject({ ok: false, code: "E_STALE_SESSION" });
      expect.soft(two).toBe(one);
      const v4Stopped = JSON.parse(
        text(await h.call("memory", { command: "create", scope: "session", text: "after shutdown" })),
      );
      expect(v4Stopped).toMatchObject({ ok: false, code: "E_SCOPE_DISABLED" });
      expect.soft(snapshot(h.cwd)).toEqual(stopped);
      expect.soft(h.manager.getBranch()).toEqual(stoppedEntries);
    } finally {
      h.scopes?.dispose();
      h.f.pi.events.clear();
    }
  },
);

it("creates child hub-only wiring without registering scoped_memory", async () => {
  const h = setup(true, false, true);
  try {
    expect(Boolean(h.scopes)).toBe(true);
    expect(h.counts()).toEqual({ memory: 1, scoped: 0 });
    expect(h.f.tools.has("scoped_memory")).toBe(false);
    expect(h.f.tools.get("memory")?.parameters).toEqual(MemoryToolParamsV4);
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
  "%s follows actual toolSurfaceFor for the registered v4 surface",
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
      expect(tool.parameters).toEqual(actual === "v3" ? MemoryToolParamsV4 : MemoryToolParamsV2);
      expect("scope" in props).toBe(actual === "v3");
      expect("command" in props).toBe(true);
      expect(actual === "v3" && "scope" in props).toBe(actual === "v3");
    } finally {
      h.scopes?.dispose();
      h.f.pi.events.clear();
    }
  },
);

it.each(["getBranch", "getLeafId", "getSessionFile"] as const)(
  "registered v4 reports %s exceptions as read errors, not disabled or poison",
  async (getter) => {
    const h = setup(false, true, true);
    try {
      await h.emit("session_start", { type: "session_start", reason: "startup" });
      const before = snapshot(h.cwd);
      const spy = vi.spyOn(h.manager, getter).mockImplementation(() => {
        throw Error(`${getter} failed: broken getter`);
      });
      try {
        if (getter === "getSessionFile") expect(h.scopes?.current()).toBeUndefined();
        const result = JSON.parse(text(await h.call("memory", { command: "view", scope: "all" })));
        expect(result).toMatchObject({
          ok: true,
          partial: true,
          scopeStatus: {
            session: {
              state: "error",
              code: "E_INTERNAL",
              message: "session memory read failed",
              originalMessage: `${getter} failed: broken getter`,
            },
          },
        });
        expect(result.groups).not.toHaveProperty("session");
        expect(result.groups).toHaveProperty("project");
        expect(snapshot(h.cwd)).toEqual(before);
        expect(h.select).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    } finally {
      h.scopes?.dispose();
      h.f.pi.events.clear();
    }
  },
);

it.each([
  ["tiered", "v2"],
  ["legacy", "legacy"],
] as const)(
  "%s configuration retains old project surface and real scoped session/Hub CRUD without replacements",
  async (layout, toolSurface) => {
    const h = setup(false, true, true, "plain", { layout, toolSurface }, (cwd) => {
      for (const dir of [memoryDirFor(cwd), memoryDirFor(process.cwd())]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "core.md"), "- original files memory\n");
      }
    });
    try {
      await h.emit("session_start", { type: "session_start", reason: "startup" });
      const tool = h.f.tools.get("memory") as ToolDefinition;
      const expected =
        toolSurface === "v2"
          ? MemoryToolParamsV2
          : createMemoryTool({ settings: h.settings, isChildSession: false, onAfterWrite() {} }).parameters;
      expect(dirFormat(memoryDirFor(process.cwd()))).toBe("files");
      expect(tool.parameters).toEqual(expected);
      expect(tool.parameters.properties).not.toHaveProperty("scope");
      expect(h.counts()).toEqual({ memory: 1, scoped: 1 });
      const humanTurn = () => {
        for (const fn of h.f.handlers.get("agent_settled") ?? []) fn({ type: "agent_settled" }, h.ctx);
        for (const fn of h.f.handlers.get("input") ?? [])
          fn({ type: "input", source: "interactive", text: "remember" }, h.ctx);
        for (const fn of h.f.handlers.get("before_agent_start") ?? [])
          fn({ type: "before_agent_start", messageType: "user", prompt: "remember" }, h.ctx);
      };
      const call = async (params: object, approve = false) => {
        const dialogs = h.select.mock.calls.length;
        if (approve) humanTurn();
        const pending = h.call("scoped_memory", params);
        if (approve) {
          for (let n = 0; n < 30 && h.select.mock.calls.length === dialogs; n++)
            await new Promise<void>((r) => setImmediate(r));
          expect(
            h.select.mock.calls.length,
            h.select.mock.calls.length === dialogs ? text(await pending) : "dialog opened",
          ).toBe(dialogs + 1);
          h.approve();
        }
        const result = JSON.parse(text(await pending));
        expect(result).toMatchObject({ ok: true });
        expect(result).not.toHaveProperty("deprecation");
        return result;
      };
      for (const storageScope of ["session", "hub"] as const) {
        const hub = storageScope === "hub";
        const made = await call(
          { op: "create", storageScope, text: "real initial body", ...(hub ? { topic: "shared" } : {}) },
          hub,
        );
        const viewed = await call({ op: "view", storageScope, id: made.id });
        expect(viewed.item.text).toBe("real initial body");
        expect(viewed.rev).toEqual(expect.any(String));
        await call({ op: "update", storageScope, id: made.id, rev: viewed.rev, text: "real updated body" }, hub);
        const updated = await call({ op: "view", storageScope, id: made.id });
        expect(updated.item.text).toBe("real updated body");
        expect(updated.rev).not.toBe(viewed.rev);
        await call({ op: "delete", storageScope, id: made.id, rev: updated.rev }, hub);
        const gone = JSON.parse(text(await h.call("scoped_memory", { op: "view", storageScope, id: made.id })));
        expect(gone).toMatchObject({ ok: false, code: "E_NOT_FOUND" });
        expect(gone).not.toHaveProperty("deprecation");
      }
      expect(h.select).toHaveBeenCalledTimes(3);
    } finally {
      h.scopes?.dispose();
      h.f.pi.events.clear();
    }
  },
);

it.each([
  [false, "plain", false],
  [false, "secure", true],
  [false, "locked", true],
] as const)("child=%s domain=%s enabled=%s keeps the original project factory", (child, domain, enabled) => {
  const h = setup(child, true, true, domain, { enabled });
  try {
    expect(h.f.tools.get("memory")?.parameters.properties).not.toHaveProperty("scope");
    expect(h.counts()).toEqual({ memory: 1, scoped: enabled && domain === "plain" ? 1 : 0 });
  } finally {
    h.scopes?.dispose();
    h.f.pi.events.clear();
  }
});

it("plain child sees registered v4, keeps authority precedence, omits all Hub data and cannot write after close", async () => {
  const h = setup(true, true, true);
  try {
    h.f.pi.events.emit(MEMORY_BIND_EVENT, {
      v: 1,
      owner: { runId: "unified-child", incarnation: {} },
      manager: h.manager,
      reason: "created",
      reply() {},
    } satisfies MemoryBindRequest);
    expect(h.counts()).toEqual({ memory: 1, scoped: 1 });
    expect(h.f.tools.get("memory")?.parameters).toEqual(MemoryToolParamsV4);
    expect(h.f.tools.get("memory")?.description).toContain("Current session is a child");
    const made = JSON.parse(
      text(await h.call("memory", { command: "create", scope: "session", text: "child session fact" })),
    );
    expect(made).toMatchObject({ ok: true });
    const childAlias = JSON.parse(
      text(await h.call("scoped_memory", { op: "view", storageScope: "session", id: made.id })),
    );
    expect(childAlias).toMatchObject({
      ok: true,
      deprecation: { replacement: { tool: "memory", params: { command: "view", scope: "session", id: made.id } } },
    });
    const raw = h.scopes!.group()!.runtime()!;
    const hubReads = vi.spyOn(raw.hub!.management, "status");
    const read = JSON.parse(text(await h.call("memory", { command: "view", scope: "all" })));
    expect(read).toMatchObject({
      ok: true,
      partial: true,
      groups: { session: { kind: "items", items: [{ id: made.id, item: { text: "child session fact" } }] } },
    });
    expect(read.groups).not.toHaveProperty("hub");
    expect(read.scopeStatus.hub).toEqual({ state: "disabled", code: "E_SCOPE_DISABLED", message: expect.any(String) });
    for (const secret of ["id", "text", "rev", "grant", "items"])
      expect(read.scopeStatus.hub).not.toHaveProperty(secret);
    // Even a constructed child hub provider is never read by the new facade.
    await h.call("memory", { command: "search", scope: "all", query: "fact" });
    expect(hubReads).not.toHaveBeenCalled();
    for (const authority of ["agent", "user"]) {
      expect(
        JSON.parse(text(await h.call("memory", { command: "view", scope: "hub", authority, unknown: true }))),
      ).toMatchObject({ ok: false, code: "E_CHILD_AUTHORITY" });
      expect(
        JSON.parse(text(await h.call("scoped_memory", { op: "view", storageScope: "hub", authority, unknown: true }))),
      ).toMatchObject({ ok: false, code: "E_CHILD_AUTHORITY" });
    }
    expect(h.select).not.toHaveBeenCalled();
    await h.emit("session_tree", { type: "session_tree" });
    expect(h.counts()).toEqual({ memory: 1, scoped: 1 });
    h.scopes!.dispose(); // Child teardown owns scopes disposal rather than main-session hooks.
    await h.emit("session_shutdown", { type: "session_shutdown" });
    const branch = h.manager.getBranch(),
      files = snapshot(h.cwd);
    expect(
      JSON.parse(text(await h.call("memory", { command: "create", scope: "session", text: "late child write" }))),
    ).toMatchObject({ ok: false, code: "E_SCOPE_DISABLED" });
    expect(h.manager.getBranch()).toEqual(branch);
    expect(snapshot(h.cwd)).toEqual(files);
    expect(h.counts()).toEqual({ memory: 1, scoped: 1 });
  } finally {
    h.scopes?.dispose();
    h.f.pi.events.clear();
  }
});
