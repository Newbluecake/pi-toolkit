import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEventBus,
  SessionManager,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import { wireMemory } from "../../../src/memory/index.js";
import { wireMemoryScopes } from "../../../src/memory/scopes/wire.js";
import { MEMORY_BIND_EVENT, type MemoryBindRequest } from "../../../src/memory/scopes/child-bind.js";
import { createPromptSectionHub } from "../../../src/sysprompt/hub.js";
import { fakePi } from "../../integration/helpers/schedule-activate.js";
import { memoryDirFor } from "../../../src/memory/paths.js";
import { writeMemoryFile } from "../../../src/memory/store.js";
import { runMemInit } from "../../../src/memory/init-command.js";
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("scopes-on child hard readonly content (including old allow=true)", () => {
  it.each(["legacy", "v2", "v3"] as const)(
    "%s actual wiring denies before mkdir, without changing original surface",
    async (surface) => {
      const cwd = mkdtempSync(join(tmpdir(), "memory39-readonly-"));
      dirs.push(cwd);
      vi.stubEnv("ARMORY_MEMORY_ROOT", join(cwd, "memory"));
      const f = fakePi(),
        bus = createEventBus();
      f.pi.events = bus;
      const settings = {
        ...DEFAULT_MEMORY_SETTINGS,
        allowWriteInChildSessions: true,
        toolSurface: surface === "legacy" ? ("legacy" as const) : ("v2" as const),
        layout: surface === "v3" ? ("blocks" as const) : ("legacy" as const),
        scopes: { session: true, hub: false },
        jev: { ...DEFAULT_MEMORY_SETTINGS.jev, enabled: false },
      };
      const scopes = wireMemoryScopes(f.pi, {
        settings,
        child: true,
        domain: "plain",
        gate: { check: () => ({ ok: true }) },
        locked: () => false,
        remote: () => undefined,
        hubPaths: () => undefined,
      })!;
      const manager = SessionManager.inMemory(cwd);
      const request: MemoryBindRequest = {
        v: 1,
        owner: { runId: "child", incarnation: {} },
        manager,
        reason: "created",
        reply() {},
      };
      bus.emit(MEMORY_BIND_EVENT, request);
      const sections = createPromptSectionHub(f.pi, {
        mode: () => "stable",
        wakeReplay: false,
        adoptForeignForcedPrompt: false,
      });
      wireMemory(f.pi, { settings, scopes, isChildSession: true, sections });
      const ctx = {
        cwd,
        mode: "rpc",
        hasUI: false,
        sessionManager: manager,
        isIdle: () => true,
        hasPendingMessages: () => false,
      } as unknown as ExtensionContext;
      const tool = f.tools.get("memory") as import("@earendil-works/pi-coding-agent").ToolDefinition;
      const args =
        surface === "legacy"
          ? { action: "write", name: "bad.md", content: "forbidden" }
          : { command: "create", path: "bad.md", file_text: "forbidden" };
      await expect(
        tool.execute(
          "blocked",
          args,
          undefined,
          undefined,
          ctx as import("@earendil-works/pi-coding-agent").ExtensionToolContext,
        ),
      ).rejects.toThrow(/read-only|E_READONLY/);
      const command = f.commands.get("mem") as { handler(args: string, ctx: ExtensionCommandContext): Promise<void> };
      await command.handler("import all", ctx as ExtensionCommandContext);
      await command.handler("init", ctx as ExtensionCommandContext);
      expect(existsSync(memoryDirFor(cwd))).toBe(false);
      expect(settings.allowWriteInChildSessions).toBe(true); // caller snapshot never mutated
      const scoped = scopes.current()!;
      expect(
        await scoped.tool.run("own", { op: "create", storageScope: "session", text: "own child fact" }),
      ).toMatchObject({ ok: true });
      expect(
        await scoped.tool.run("authority", {
          op: "create",
          storageScope: "session",
          text: "not allowed",
          authority: "agent",
        }),
      ).toMatchObject({ ok: false, code: "E_CHILD_AUTHORITY" });
      expect(await scoped.tool.run("hub", { op: "view", storageScope: "hub" })).toMatchObject({
        ok: false,
        code: "E_SCOPE_DISABLED",
      });
      scopes.dispose();
      bus.clear();
    },
  );
  it("independent real content gate defeats internal allowWrite:true and init before mkdir", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "memory39-internal-deny-"));
    dirs.push(cwd);
    const paths = { memoryRoot: join(cwd, "memory"), ccProjectsRoot: join(cwd, "cc") };
    const gate: import("../../../src/memory/contracts.js").MemoryWriteGate = {
      check: () => ({ ok: false, reason: "locked" }),
      bootstrap: () => ({ ok: false, reason: "locked" }),
      capture: vi.fn(),
    };
    expect(() =>
      writeMemoryFile(
        cwd,
        "bad.md",
        "no",
        { allowWrite: true, maxWriteBytes: 4096, maxFileBytes: 4096, writeGate: gate },
        paths,
      ),
    ).toThrow("writes not allowed");
    await expect(
      runMemInit(cwd, {
        paths,
        isChildSession: true,
        settings: { ...DEFAULT_MEMORY_SETTINGS, allowWriteInChildSessions: true },
        writeGate: gate,
      }),
    ).rejects.toThrow("writes not allowed");
    expect(existsSync(memoryDirFor(cwd, paths))).toBe(false);
    expect(gate.capture).not.toHaveBeenCalled();
  });
});

import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import type { ClassifierRegistryLike } from "../../../src/memory/jev/contracts.js";
import { readIndex } from "../../../src/memory/jev/index-store.js";
import { EntryIndex } from "../../../src/memory/jev/entries.js";

describe("scopes-on real wireJev child derived writes", () => {
  it.each([false, true])(
    "A cooldown + diag ring; P rules=%s, predictor model always disabled",
    async (predictRules) => {
      const cwd = mkdtempSync(join(tmpdir(), "memory39-child-derived-"));
      dirs.push(cwd);
      vi.stubEnv("ARMORY_MEMORY_ROOT", join(cwd, "memory"));
      const dir = memoryDirFor(cwd);
      mkdirSync(dir, { recursive: true });
      const raw =
        "# Core\n\n## Rules\n\n- git push requires explicit checks <!-- mem user tags=+git-push -->\n- 派发子 agent 前确认范围 <!-- mem user tags=+dispatch -->\n";
      writeFileSync(join(dir, "rules.md"), raw);
      const f = fakePi(),
        bus = createEventBus();
      f.pi.events = bus;
      f.pi.registerMessageRenderer = () => {};
      const classifiers = ["opencode/jev-1.13-free", "opencode/jev-1.13"];
      const registry: ClassifierRegistryLike = {
        getModelOfType: (_type, provider, id) => ({ provider, id }),
        getAvailableOfType: async () =>
          classifiers.map((value) => {
            const [provider, id] = value.split("/");
            return { provider: provider!, id: id! };
          }),
        classify: async (model) => {
          const target = model as { provider: string; id: string };
          return {
            stopReason: "error",
            answers: {},
            provider: target.provider,
            model: target.id,
            errorMessage: "owned classifier diagnostic",
          };
        },
      };
      const settings = {
        ...DEFAULT_MEMORY_SETTINGS,
        layout: "tiered" as const,
        toolSurface: "v2" as const,
        allowWriteInChildSessions: true,
        scopes: { session: true, hub: false },
        jev: {
          ...DEFAULT_MEMORY_SETTINGS.jev,
          enabled: true,
          childSessions: true,
          classifiers,
          predict: {
            ...DEFAULT_MEMORY_SETTINGS.jev.predict,
            enabled: predictRules,
            childSessions: true,
            model: { ...DEFAULT_MEMORY_SETTINGS.jev.predict.model, enabled: false },
          },
        },
      };
      const secureGate = { check: vi.fn(() => ({ ok: true as const })), capture: vi.fn() };
      const scopes = wireMemoryScopes(f.pi, {
        settings,
        child: true,
        domain: "plain",
        gate: { check: () => ({ ok: true }) },
        locked: () => false,
        remote: () => undefined,
        hubPaths: () => undefined,
      })!;
      const manager = SessionManager.inMemory(cwd);
      bus.emit(MEMORY_BIND_EVENT, {
        v: 1,
        owner: { runId: "derived-child", incarnation: {} },
        manager,
        reason: "created",
        reply() {},
      } satisfies MemoryBindRequest);
      const sections = createPromptSectionHub(f.pi, {
        mode: () => "stable",
        wakeReplay: false,
        adoptForeignForcedPrompt: false,
      });
      wireMemory(f.pi, { settings, scopes, writeGate: secureGate, isChildSession: true, sections });
      const ctx = {
        cwd,
        mode: "rpc",
        hasUI: false,
        modelRegistry: registry,
        sessionManager: manager,
        isIdle: () => true,
        hasPendingMessages: () => false,
      } as unknown as ExtensionCommandContext;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fire = async (name: string, event: unknown) => {
        const out: unknown[] = [];
        for (const fn of f.handlers.get(name) ?? []) out.push(await fn(event, ctx));
        return out;
      };
      try {
        // Child has no startup probe/backfill/review. Real BAS supplies U/optional P rule path only.
        await fire("before_agent_start", {
          type: "before_agent_start",
          messageType: "user",
          prompt: "派两个子 agent 并行做",
        });
        await fire("tool_call", {
          type: "tool_call",
          toolName: "bash",
          toolCallId: "push",
          input: { command: "git push" },
        });
        const entries = new EntryIndex().get(dir);
        const a = entries.find((e) => e.body.includes("git push"))!;
        const p = entries.find((e) => e.body.includes("派发"))!;
        await vi.waitFor(() => expect(readIndex(dir).index.aInjectedAt?.[a.hash]).toBeDefined());
        if (predictRules) await vi.waitFor(() => expect(readIndex(dir).index.pInjectedAt?.[p.hash]).toBeDefined());
        else expect(readIndex(dir).index.pInjectedAt).toBeUndefined();
        expect(secureGate.check).toHaveBeenCalled();
        expect(readIndex(dir).index.entries).toEqual({}); // no auto tagging, review or promotion side effects
        expect(readFileSync(join(dir, "rules.md"), "utf8")).toBe(raw);
        const cmd = f.commands.get("mem") as { handler(args: string, ctx: ExtensionCommandContext): Promise<void> };
        await cmd.handler("import all", ctx);
        await cmd.handler("init", ctx);
        await cmd.handler("review --run", ctx);
        expect(readFileSync(join(dir, "rules.md"), "utf8")).toBe(raw);
        await fire("tool_call", {
          type: "tool_call",
          toolName: "bash",
          toolCallId: "diag",
          get input() {
            throw Error("owned-child-diag");
          },
        });
        // Existing child diagnostics are ring/report-only, not a new persistence grant.
        const notes: string[] = [];
        await cmd.handler("jev", {
          ...ctx,
          hasUI: true,
          ui: { notify: (text: string) => notes.push(text) },
        } as unknown as ExtensionCommandContext);
        expect(notes.join("\n")).toContain("tool_call failed: owned-child-diag");
        expect(warn).not.toHaveBeenCalled();
        expect(readdirSync(dir).filter((name) => name.endsWith(".md"))).toEqual(["rules.md"]);
        expect(readdirSync(join(dir, ".jev")).filter((name) => !name.includes("lock"))).toEqual(["index.json"]);
      } finally {
        scopes.dispose();
        bus.clear();
        warn.mockRestore();
      }
    },
  );
});
