import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fakePi, emitAll } from "../../integration/helpers/schedule-activate.js";
import { wireMemory } from "../../../src/memory/index.js";
import { wireMemoryScopes } from "../../../src/memory/scopes/wire.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import { createPromptSectionHub } from "../../../src/sysprompt/hub.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each(["shutdown", "dispose"] as const)(
  "%s cannot reopen via context/tree/tool; a real session_start restores writes through the same dispatcher",
  async (stop) => {
    const cwd = mkdtempSync(join(tmpdir(), "unified-lifecycle-"));
    dirs.push(cwd);
    vi.stubEnv("ARMORY_MEMORY_ROOT", join(cwd, "memory"));
    const f = fakePi();
    const settings = {
      ...DEFAULT_MEMORY_SETTINGS,
      scopes: { session: true, hub: false },
      jev: { ...DEFAULT_MEMORY_SETTINGS.jev, enabled: false },
    };
    let manager = SessionManager.inMemory(cwd);
    f.pi.appendEntry = (type, data) => manager.appendCustomEntry(type, data);
    const context = (): ExtensionContext =>
      ({
        cwd,
        mode: "rpc",
        hasUI: false,
        sessionManager: manager,
        isIdle: () => true,
        hasPendingMessages: () => false,
      }) as ExtensionContext;
    const scopes = wireMemoryScopes(f.pi, {
      settings,
      child: false,
      domain: "plain",
      gate: { check: () => ({ ok: true }) },
      locked: () => false,
      remote: () => undefined,
      hubPaths: () => {
        throw Error("hub-off must not resolve paths");
      },
    })!;
    const sections = createPromptSectionHub(f.pi, {
      mode: () => "stable",
      wakeReplay: false,
      adoptForeignForcedPrompt: false,
    });
    wireMemory(f.pi, { settings, scopes, isChildSession: false, sections });
    const registered = f.tools.get("scoped_memory") as ToolDefinition;
    const create = async (text: string) => {
      const result = await registered.execute(
        "lifecycle",
        { op: "create", storageScope: "session", text },
        undefined,
        undefined,
        context(),
      );
      return JSON.parse((result.content[0] as { text: string }).text);
    };
    try {
      await emitAll(f, "session_start", { type: "session_start", reason: "startup" }, context());
      expect(await create("before close")).toMatchObject({ ok: true });
      const old = scopes.current()!;
      const oldManager = manager;
      const branch = oldManager.getBranch();
      if (stop === "dispose") scopes.dispose();
      else await emitAll(f, "session_shutdown", { type: "session_shutdown" }, context());
      expect(old.signal.aborted).toBe(true);
      expect(scopes.current()).toBeUndefined();
      scopes.context(context());
      await emitAll(f, "session_tree", { type: "session_tree" }, context());
      expect(scopes.current()).toBeUndefined();
      const failure = await create("forbidden after close");
      expect(failure).toMatchObject({ ok: false, code: "E_STALE_SESSION" });
      expect(await create("another forbidden write")).toEqual(failure);
      expect(scopes.current()).toBeUndefined();
      expect(oldManager.getBranch()).toEqual(branch);
      manager = SessionManager.inMemory(cwd);
      scopes.context(context());
      expect(scopes.current()).toBeUndefined();
      expect(manager.getBranch()).toEqual([]);
      await emitAll(f, "session_start", { type: "session_start", reason: "reload" }, context());
      expect(scopes.current()!.owner.incarnation).not.toBe(old.owner.incarnation);
      expect(scopes.current()!.signal.aborted).toBe(false);
      expect(await create("new session fact")).toMatchObject({ ok: true });
      expect(
        scopes
          .current()!
          .session!.view()
          .items.map((i) => i.item.text),
      ).toEqual(["new session fact"]);
      expect(manager.getBranch()).toHaveLength(1);
      expect(oldManager.getBranch()).toEqual(branch);
      expect(f.tools.get("scoped_memory")).toBe(registered);
      expect([...f.tools.keys()].filter((name) => name === "memory" || name === "scoped_memory")).toEqual([
        "scoped_memory",
        "memory",
      ]);
    } finally {
      scopes.dispose();
    }
  },
);
