import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  AgentSession,
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import { toCreateOptions } from "../../src/runtime/session-driver.js";

// This zero-prompt suite forbids transport entirely (stronger than loopback-only).
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Fast offline fixture: network forbidden"));
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.mocked(globalThis.fetch).mockRestore();
});

describe("Fast V2 public SDK canonical loader", () => {
  it.each([false, true])("settings-discovered receiver and independent observer, systemPrompt=%s", async (override) => {
    const root = mkdtempSync(join(tmpdir(), "fast-loader-"));
    const cwd = join(root, "work");
    const agentDir = join(root, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    const plugin = join(root, "receiver.mjs");
    writeFileSync(
      plugin,
      `export default function(pi) { pi.events.on("subagent:fast-bind", (r) => { r.reply({ manager: r.manager, mode: "on" }); }); }`,
    );
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [plugin] }));
    const bus = createEventBus();
    let observed = 0;
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      eventBus: bus,
      ...(override ? { systemPromptOverride: () => "isolated fast loader prompt" } : {}),
      extensionFactories: [
        (pi) => {
          pi.on("session_start", () => {
            observed++;
          });
        },
      ],
    });
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const manager = SessionManager.inMemory(cwd);
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
        modelsStorePath: join(root, "models-cache"),
        allowModelNetwork: false,
      });
      ({ session } = await createAgentSession({
        cwd,
        agentDir,
        settingsManager,
        resourceLoader: loader,
        sessionManager: manager,
        modelRuntime,
        model: modelRuntime.getModel("openai", "gpt-4o-mini")!,
        noTools: "all",
      }));
      await session.bindExtensions({});
      let reply: unknown;
      bus.emit("subagent:fast-bind", {
        manager,
        reply: (value: unknown) => {
          reply = value;
        },
      });
      expect(reply).toEqual({ manager, mode: "on" });
      expect(observed).toBe(1);
      if (override) expect(session.systemPrompt).toBe(`isolated fast loader prompt\n\n<cwd>\n${cwd}\n</cwd>`);
      let wrong = false;
      createEventBus().emit("subagent:fast-bind", {
        reply: () => {
          wrong = true;
        },
      });
      expect(wrong).toBe(false);
      expect(manager.getBranch().some((e) => e.type === "message")).toBe(false);
    } finally {
      session?.dispose();
      bus.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([false, true])("no seed preserves original default/custom-prompt path, override=%s", async (override) => {
    const root = mkdtempSync(join(tmpdir(), "fast-loader-legacy-"));
    const cwd = join(root, "work");
    const agentDir = join(root, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    const plugin = join(root, "observer.mjs");
    writeFileSync(
      plugin,
      `export default function(pi) { pi.registerCommand("fast_loader_own_fixture", { description: "offline discovery", handler: async () => {} }); }`,
    );
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [plugin] }));
    const prompt = vi.spyOn(AgentSession.prototype, "prompt");
    let session: AgentSession | undefined;
    try {
      const options = await toCreateOptions(
        { cwd, agentDir, ...(override ? { systemPrompt: "legacy override" } : {}) },
        cwd,
      );
      expect(Object.hasOwn(options, "resourceLoader")).toBe(override);
      expect(Object.hasOwn(options, "fastSeed")).toBe(false);
      expect(Object.hasOwn(options, "eventBus")).toBe(false);
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
        modelsStorePath: join(root, "catalog"),
        allowModelNetwork: false,
      });
      const created = await createAgentSession({
        ...options,
        cwd,
        agentDir,
        modelRuntime,
        model: modelRuntime.getModel("openai", "gpt-4o-mini")!,
        sessionManager: SessionManager.inMemory(cwd),
      });
      session = created.session;
      expect(created.extensionsResult.errors).toEqual([]);
      expect(
        created.extensionsResult.extensions.some((extension) => extension.commands.has("fast_loader_own_fixture")),
      ).toBe(true);
      if (override) expect(session.systemPrompt).toContain("legacy override");
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      session?.dispose();
      prompt.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
