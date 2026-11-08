import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  fakeModel,
  fakeModelRuntime,
  textTurn,
  assistantTextMsg,
  createFakeUiContext,
  createUiCallLog,
} from "../conformance/topic-switch-runtime-harness.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import { resetGlobals, BASELINE } from "./helpers/schedule-activate.js";
import type { MemoryScopesWiring } from "../../src/memory/scopes/wire.js";
import type { Stack } from "../../src/stack.js";
const observed = vi.hoisted(() => ({
  scopes: [] as MemoryScopesWiring[],
  stacks: [] as Stack[],
  runners: [] as import("../../src/service/ports.js").Runner[],
  childRuntime: undefined as unknown,
  children: [] as import("@earendil-works/pi-coding-agent").AgentSession[],
}));
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
  const sdk = await original<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...sdk,
    createAgentSession: async (options: Parameters<typeof sdk.createAgentSession>[0]) => {
      const inject = observed.childRuntime !== undefined && options?.modelRuntime === undefined;
      const result = await sdk.createAgentSession(
        inject ? { ...options, modelRuntime: observed.childRuntime as never } : options,
      );
      if (inject) observed.children.push(result.session);
      return result;
    },
  };
});
vi.mock("../../src/service/runtime-adapter.js", async (original) => {
  const actual = await original<typeof import("../../src/service/runtime-adapter.js")>();
  return {
    ...actual,
    createRuntimeRunnerAdapter: (...args: Parameters<typeof actual.createRuntimeRunnerAdapter>) => {
      const result = actual.createRuntimeRunnerAdapter(...args);
      observed.runners.push(result);
      return result;
    },
  };
});
vi.mock("../../src/memory/scopes/wire.js", async (original) => {
  const actual = await original<typeof import("../../src/memory/scopes/wire.js")>();
  return {
    ...actual,
    wireMemoryScopes: (...args: Parameters<typeof actual.wireMemoryScopes>) => {
      const result = actual.wireMemoryScopes(...args);
      if (result) observed.scopes.push(result);
      return result;
    },
  };
});
vi.mock("../../src/stack.js", async (original) => {
  const actual = await original<typeof import("../../src/stack.js")>();
  return {
    ...actual,
    buildSessionStack: (...args: Parameters<typeof actual.buildSessionStack>) => {
      const result = actual.buildSessionStack(...args);
      observed.stacks.push(result);
      return result;
    },
  };
});
import activate from "../../src/index.js";
const roots: string[] = [];
afterEach(() => {
  resetGlobals();
  resetSecureDomainForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
  observed.scopes = [];
  observed.stacks = [];
  observed.childRuntime = undefined;
  observed.children = [];
  observed.runners = [];
});

async function fixture(mode: "tui" | "rpc" = "tui", scopedWrite?: object, persistChildren = false) {
  resetGlobals();
  resetSecureDomainForTests();
  const cwd = mkdtempSync(join(tmpdir(), "memory39-assembly-"));
  roots.push(cwd);
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir);
  vi.stubEnv("HOME", cwd);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(cwd, "memory"));
  writeFileSync(
    join(agentDir, "pi-toolkit.json"),
    JSON.stringify({
      ...BASELINE,
      concurrencyLimit: 1,
      rememberAgents: persistChildren,
      fast: { enabled: false },
      quota: { enabled: false },
      load: { enabled: false },
      title: { enabled: false },
      memory: {
        enabled: true,
        allowWriteInChildSessions: true,
        freezeInjectionAfterWrite: true,
        scopes: { session: true, hub: true },
        layout: "legacy",
        toolSurface: "legacy",
        jev: { enabled: false },
      },
    }),
  );
  mkdirSync(join(cwd, ".pi", "agent", "agents"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "agent", "agents", "memory-worker.md"),
    "---\nname: memory-worker\ndescription: offline memory worker\ncan_spawn: memory-worker\n---\nOffline worker.",
  );
  const model = fakeModel();
  const local = fakeModelRuntime(model, [
    ...(scopedWrite
      ? [
          {
            toolCall: true,
            build: (m: typeof model) => ({
              ...assistantTextMsg(m, ""),
              content: [{ type: "toolCall", id: "actual-scoped-user", name: "scoped_memory", arguments: scopedWrite }],
              stopReason: "toolUse",
            }),
          },
        ]
      : []),
    { toolCall: false, build: (m) => assistantTextMsg(m, "offline") },
  ]);
  const manager = SessionManager.inMemory(cwd);
  const settings = SettingsManager.create(cwd, agentDir);
  let api!: ExtensionAPI, context!: ExtensionContext;
  const errors: unknown[] = [];
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        api = pi;
        activate(pi);
        pi.on("session_start", (_event, ctx) => {
          context = ctx;
        });
      },
    ],
  });
  await loader.reload();
  const created = await createAgentSession({
    cwd,
    agentDir,
    sessionManager: manager,
    model: model as never,
    modelRuntime: local as never,
    settingsManager: settings,
    resourceLoader: loader,
  });
  const ui = createFakeUiContext(createUiCallLog());
  const select = vi.fn(async (_title: string, options: string[]) => options[1]);
  ui.select = select;
  await created.session.bindExtensions({
    mode,
    uiContext: ui,
    shutdownHandler: async () => {},
    onError: (error) => {
      errors.push(error);
    },
  });
  return {
    ...created,
    manager,
    cwd,
    agentDir,
    local,
    api,
    select,
    errors,
    ctx: () => context,
    scopes: observed.scopes.at(-1)!,
    stack: observed.stacks.at(-1)!,
  };
}
describe("#39 actual root activation with official SDK and offline provider", () => {
  it("Web-off native commands, actual manager/store/shared owner, model ownagent, and real three-layer prompt", async () => {
    const f = await fixture();
    try {
      expect(f.errors).toEqual([]);
      expect(f.stack).toBeDefined();
      const r = f.scopes.current()!;
      expect(r.manager).toBe(f.manager);
      expect(r.owner).toBe(f.scopes.current()!.owner);
      await f.session.prompt("/mem session add native session rule");
      expect(r.session!.view().items.map((i) => i.item.text)).toEqual(["native session rule"]);
      await f.session.prompt("/mem hub add shared hub rule");
      expect(r.hub!.view().items.map((i) => i.text)).toEqual(["shared hub rule"]);
      expect(f.select).not.toHaveBeenCalled();
      const result = await r.tool.run("actual-agent", {
        op: "create",
        storageScope: "session",
        text: "own agent rule",
      });
      expect(result).toMatchObject({ ok: true });
      expect(r.session!.view().items.map((i) => i.item.authority)).toEqual(["user", "agent"]);
      // Production section registration, not manual sections. Project body is an owned fixture.
      const { memoryDirFor } = await import("../../src/memory/paths.js");
      const dir = memoryDirFor(f.cwd);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "core.md"), "---\nsource: agent\n---\n# Core\n\n- project rule\n");
      await f.session.prompt("actual provider turn");
      expect(f.session.getLastAssistantText()).toBe("offline");
      const request = JSON.stringify(f.local.requestMessages.at(-1));
      expect(request).toContain("native session rule");
      expect(request).toContain("shared hub rule");
      expect(request).toContain("project rule");
      const memoryTool = f.session.extensionRunner.getToolDefinition("memory")!;
      await memoryTool.execute(
        "actual-project-write",
        { action: "write", name: "core.md", content: "# Core\n\n- replacement project body" },
        undefined,
        undefined,
        f.session.extensionRunner.createToolContext("actual-project-write", undefined),
      );
      await f.session.prompt("after real project write");
      const frozenRequest = JSON.stringify(f.local.requestMessages.at(-1));
      expect(frozenRequest).toContain("project rule");
      expect(frozenRequest).not.toContain("replacement project body");
      expect(f.errors).toEqual([]);
      const oldGroup = f.scopes.group()!;
      oldGroup.dispose();
      oldGroup.dispose();
      expect(r.signal.aborted).toBe(true);
      expect(f.scopes.current()).toBeUndefined();
    } finally {
      await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      f.session.dispose();
    }
  });
  it("RPC has no local native command authority even with UI", async () => {
    const f = await fixture("rpc");
    try {
      await f.session.prompt("/mem session add not native");
      expect(f.scopes.current()!.session!.view().items).toEqual([]);
      expect(f.select).not.toHaveBeenCalled();
    } finally {
      await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      f.session.dispose();
    }
  });
  it("actual child activate binds before context, inherits P2 capture, ownagent writes but old allow=true cannot write project", async () => {
    const f = await fixture();
    try {
      const r = f.scopes.current()!;
      await f.session.prompt("/mem session add inherited user rule");
      await f.session.prompt("/mem hub add child readonly hub rule");
      const { captureMemorySeed } = await import("../../src/memory/scopes/wire.js");
      const capture = captureMemorySeed(f.scopes.group(), {});
      expect(capture.state).toBe("captured");
      expect(Object.isFrozen(capture)).toBe(true);
      if (capture.state !== "captured") throw Error("seed unavailable");
      const plugin = join(f.cwd, "child-activate.ts");
      writeFileSync(
        plugin,
        `import activate from ${JSON.stringify(join(import.meta.dirname, "../../src/index.ts"))}; export default activate;`,
      );
      writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ extensions: [plugin], cacheWarming: "off" }));
      const model = fakeModel();
      const call = (name: string, args: object, id: string) => ({
        toolCall: true,
        build: (m: typeof model) => ({
          ...assistantTextMsg(m, ""),
          content: [{ type: "toolCall", id, name, arguments: args }],
          stopReason: "toolUse",
        }),
      });
      const local = fakeModelRuntime(model, [
        call("memory", { action: "write", name: "forbidden.md", content: "must not write" }, "deny-content"),
        call("scoped_memory", { op: "create", storageScope: "session", text: "child own agent" }, "own-agent"),
        { toolCall: false, build: (m) => assistantTextMsg(m, "child offline complete") },
      ]);
      const { PiSessionDriver, PiSessionHandle } = await import("../../src/runtime/session-driver.js");
      const group = f.scopes.group()!;
      const driver = new PiSessionDriver(false, () => model, undefined, undefined, group.gate, {
        ...group.childBinding,
        strict: true,
      });
      const child = (await driver.create({
        cwd: f.cwd,
        agentDir: f.agentDir,
        persist: false,
        model: { provider: model.provider, id: model.id },
        memorySeed: capture.seed,
        modelRuntime: local,
      } as import("../../src/core/types.js").SessionSpec)) as InstanceType<typeof PiSessionHandle>;
      try {
        // Receiver must already be bound before SDK context/bindExtensions/first prompt.
        child.session.setActiveToolsByName(["memory", "scoped_memory"]);
        await child.prompt("local child task");
        expect(child.session.getLastAssistantText()).toBe("child offline complete");
        const branch = child.session.sessionManager.getBranch();
        const results = branch
          .filter((e) => e.type === "message" && e.message.role === "toolResult")
          .map((e) => (e.type === "message" ? e.message : undefined));
        expect(results).toMatchObject([
          { role: "toolResult", isError: true },
          { role: "toolResult", isError: false },
        ]);
        const { foldSessionMemory } = await import("../../src/memory/scopes/session-fold.js");
        const view = foldSessionMemory(branch, child.sessionId);
        expect(view.items.map((i) => i.item.text)).toEqual(["inherited user rule", "child own agent"]);
        expect(view.items[0]!.inherited).toMatchObject({ kind: "spawn", fromSid: r.owner.sid });
        expect(r.session!.view().items.map((i) => i.item.text)).toEqual(["inherited user rule"]);
        const requests = JSON.stringify(local.requestMessages);
        expect(requests).toContain("child readonly hub rule");
        const { existsSync } = await import("node:fs");
        const { memoryDirFor } = await import("../../src/memory/paths.js");
        expect(existsSync(join(memoryDirFor(f.cwd), "forbidden.md"))).toBe(false);
      } finally {
        child.dispose();
      }
    } finally {
      await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      f.session.dispose();
    }
  });

  it("actual native SDK tool call uses same root proof/approval/cap/store exact user confirmation", async () => {
    const body = "Full native confirmed body\n中文 exact";
    const f = await fixture("tui", { op: "create", storageScope: "session", authority: "user", text: body });
    try {
      f.session.setActiveToolsByName(["scoped_memory"]);
      await f.session.prompt("real interactive user request");
      expect(f.session.getLastAssistantText()).toBe("offline");
      expect(f.select).toHaveBeenCalledTimes(1);
      expect(f.select.mock.calls[0]![0]).toContain(body);
      const item = f.scopes.current()!.session!.view().items[0]!.item;
      expect(item).toMatchObject({ text: body, authority: "user", grant: { via: "dialog", channel: "tui" } });
      expect(f.errors).toEqual([]);
    } finally {
      await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      f.session.dispose();
    }
  });
  it("actual TUI SDK hub create with explicit user authority confirms exact body", async () => {
    const body = "TUI hub create exact body";
    const f = await fixture("tui", {
      op: "create",
      storageScope: "hub",
      authority: "user",
      topic: "general",
      text: body,
    });
    try {
      f.session.setActiveToolsByName(["scoped_memory"]);
      await f.session.prompt("create shared memory");
      expect(f.select).toHaveBeenCalledTimes(1);
      expect(f.select.mock.calls[0]![0]).toContain(body);
      expect(f.scopes.current()!.hub!.view().items[0]).toMatchObject({
        text: body,
        grant: { via: "dialog", channel: "tui" },
      });
      expect(f.errors).toEqual([]);
    } finally {
      await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      f.session.dispose();
    }
  });
  it("actual TUI SDK hub delete with explicit agent authority confirms original body", async () => {
    const args = { op: "delete", storageScope: "hub", authority: "agent", id: "general.001", rev: "" };
    const f = await fixture("tui", args);
    try {
      const hub = f.scopes.current()!.hub!;
      await f.session.prompt("/mem hub add TUI hub delete exact body");
      const item = hub.management.inspect(args.id);
      if (!item.ok) throw Error(item.code);
      args.rev = item.rev;
      f.session.setActiveToolsByName(["scoped_memory"]);
      await f.session.prompt("delete shared memory");
      expect(f.select).toHaveBeenCalledTimes(1);
      expect(f.select.mock.calls[0]![0]).toContain("TUI hub delete exact body");
      expect(hub.view().items).toEqual([]);
      const { resolveHubPaths } = await import("../../src/web-hub/protocol/paths.js");
      const stateDir = resolveHubPaths({ home: f.cwd, uid: process.getuid?.() ?? 0 }).stateDir;
      const audit = readFileSync(join(stateDir, "hub-memory", "audit.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(audit.at(-1)).toMatchObject({ op: "delete", via: "dialog", channel: "tui" });
      expect(f.errors).toEqual([]);
    } finally {
      await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      f.session.dispose();
    }
  });
  it("real Stack SpawnService slot FIFO freezes seeds; nested uses direct parent's live branch and stale capture refuses", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = fakeModel();
    observed.childRuntime = fakeModelRuntime(model, [
      { toolCall: false, gate, build: (m) => assistantTextMsg(m, "child done") },
    ]);
    const { PiSessionDriver } = await import("../../src/runtime/session-driver.js");
    const create = vi.spyOn(PiSessionDriver.prototype, "create");
    const { foldSessionMemory } = await import("../../src/memory/scopes/session-fold.js");
    const seedTexts = (sm: SessionManager) =>
      foldSessionMemory(sm.getBranch(), sm.getSessionId()).items.map((i) => i.item.text);
    try {
      await f.scopes
        .current()!
        .tool.run("initial", { op: "create", storageScope: "session", text: "root at admission" });
      const spawn = (prompt: string, extra = {}) =>
        f.stack.spawn.spawn({
          type: "memory-worker",
          prompt,
          cwd: f.cwd,
          modelOverride: { provider: model.provider, id: model.id },
          ...extra,
        });
      const first = await spawn("occupy slot");
      if ("error" in first) throw Error(first.error.message);
      await vi.waitFor(() => expect(observed.children).toHaveLength(1));
      const second = await spawn("queued child");
      if ("error" in second) throw Error(second.error.message);
      expect(second.queued).toBeDefined();
      await f.scopes
        .current()!
        .tool.run("changed", { op: "create", storageScope: "session", text: "root after admission" });
      const parentManager = observed.children[0]!.sessionManager;
      const stamp = new Date().toISOString();
      parentManager.appendCustomEntry("subagent:memory-session", {
        v: 1,
        sid: parentManager.getSessionId(),
        op: "put",
        item: { id: "n2", authority: "agent", text: "direct parent only", created: stamp, updated: stamp },
      });
      const nested = await spawn("nested slotless", { parentRunId: first.runId, slotless: true });
      if ("error" in nested) throw Error(nested.error.message);
      await vi.waitFor(() => expect(observed.children).toHaveLength(2));
      expect(seedTexts(observed.children[1]!.sessionManager)).toEqual(["root at admission", "direct parent only"]);
      expect(seedTexts(observed.children[1]!.sessionManager)).not.toContain("root after admission");
      // Reentrant actual branch read changes live state: no fallback-to-root or empty admission.
      const branchRead = parentManager.getBranch.bind(parentManager);
      const stale = vi.spyOn(parentManager, "getBranch").mockImplementation(() => {
        void observed.runners.at(-1)!.abort?.(first.runId);
        return branchRead();
      });
      const before = create.mock.calls.length;
      const rejected = await spawn("must refuse", { parentRunId: first.runId, slotless: true });
      expect(rejected).toMatchObject({
        error: { kind: "config", message: expect.stringContaining("memory seed capture failed") },
      });
      expect(create.mock.calls).toHaveLength(before);
      stale.mockRestore();
      const sidParent = await spawn("SDK sid guard parent", { slotless: true });
      if ("error" in sidParent) throw Error(sidParent.error.message);
      await vi.waitFor(() => expect(observed.runners.at(-1)!.getRunState?.(sidParent.runId)?.sessionId).toBeDefined());
      const sid = observed.runners.at(-1)!.getRunState?.(sidParent.runId)!.sessionId;
      const sidSession = observed.children.find((child) => child.sessionId === sid)!;
      expect(sidSession).toBeDefined();
      sidSession.sessionManager.newSession();
      const beforeSid = create.mock.calls.length;
      const sidMismatch = await spawn("must refuse changed SDK sid", { parentRunId: sidParent.runId, slotless: true });
      expect(sidMismatch).toMatchObject({
        error: { kind: "config", message: expect.stringContaining("memory seed capture failed") },
      });
      expect(create.mock.calls).toHaveLength(beforeSid);
      release();
      const done = await f.stack.spawn.waitAll({
        runIds: [first.runId, second.runId, nested.runId, sidParent.runId],
        waitMs: 15000,
      });
      expect(done.pending).toEqual([]);
      const queuedSpec = create.mock.calls.find(([spec]) => spec.prompt?.includes("queued child"))?.[0];
      expect(queuedSpec?.memorySeed?.items.map((i) => i.text)).toEqual(["root at admission"]);
    } finally {
      release();
      await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      f.session.dispose();
    }
  });

  it("real Stack workflow worker captures per call before local FIFO and preserves queued snapshot through actual service/driver", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = fakeModel();
    observed.childRuntime = fakeModelRuntime(model, [
      { toolCall: false, gate, build: (m) => assistantTextMsg(m, "workflow child") },
    ]);
    const { PiSessionDriver } = await import("../../src/runtime/session-driver.js");
    const create = vi.spyOn(PiSessionDriver.prototype, "create");
    try {
      const store = f.scopes.current()!.session!;
      await f.scopes
        .current()!
        .tool.run("initial", { op: "create", storageScope: "session", text: "workflow admitted body" });
      let sampled!: () => void;
      const twoSamples = new Promise<void>((resolve) => {
        sampled = resolve;
      });
      const snapshot = store.snapshot.bind(store);
      let captures = 0;
      vi.spyOn(store, "snapshot").mockImplementation(() => {
        const result = snapshot();
        if (++captures === 2) sampled();
        return result;
      });
      const orchestrator = f.stack.workflow.createOrchestrator("wf_memory39_p4c");
      const run = orchestrator.run({
        workflowId: "wf_memory39_p4c",
        script: `export const meta={name:"memory39",description:"offline"}; const opts={agentType:"memory-worker",model:"${model.provider}/${model.id}"}; const a=agent("fifo-one",opts); const b=agent("fifo-two",opts); await Promise.all([a,b]); return await agent("after-fifo",opts);`,
        budget: {
          ...f.stack.workflow.defaultBudget,
          heartbeatMs: 0,
          workflowTotalMs: 30000,
          workerBootMs: 10000,
          maxParallel: 1,
        },
      });
      await twoSamples;
      await f.scopes
        .current()!
        .tool.run("mutate", { op: "create", storageScope: "session", text: "workflow later body" });
      release();
      const result = await run;
      expect(result.status).toBe("completed");
      expect(captures).toBe(3);
      const seeds = create.mock.calls.map(([spec]) => spec.memorySeed?.items.map((i) => i.text));
      expect(seeds).toEqual([
        ["workflow admitted body"],
        ["workflow admitted body"],
        ["workflow admitted body", "workflow later body"],
      ]);
    } finally {
      release();
      await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      f.session.dispose();
    }
  });

  it.each(["rebuild-handoff", "defensive", "shutdown"] as const)(
    "scopes-on actual Stack %s closes authority synchronously first, even with uncooperative popup",
    async (kind) => {
      const f = await fixture();
      try {
        const log: string[] = [];
        const group = f.scopes.group()!,
          r = f.scopes.current()!;
        const dispose = group.dispose.bind(group);
        vi.spyOn(group, "dispose").mockImplementation(() => {
          log.push("memory");
          dispose();
        });
        const bg = f.stack.backgroundCompletions.dispose.bind(f.stack.backgroundCompletions);
        vi.spyOn(f.stack.backgroundCompletions, "dispose").mockImplementation(() => {
          log.push("background");
          bg();
        });
        if (f.stack.xs) {
          const xs = f.stack.xs.dispose.bind(f.stack.xs);
          vi.spyOn(f.stack.xs, "dispose").mockImplementation(() => {
            log.push("xs");
            xs();
          });
        }
        f.select.mockImplementation(() => new Promise(() => {}));
        r.tracker.noteInteractive(r.owner);
        const pending = r.tool.run("pending-popup", {
          op: "create",
          storageScope: "session",
          authority: "user",
          text: "must not outlive owner",
        });
        await vi.waitFor(() => expect(f.select).toHaveBeenCalledTimes(1));
        const { readSettingsNoMigrate } = await import("../../src/config/settings.js");
        const env = {
          ctx: f.ctx(),
          settings: readSettingsNoMigrate(),
          activation: {
            defensiveXsTeardown() {
              log.push("ledger");
            },
            releaseCapabilityAlert() {
              log.push("capability");
            },
            disposeGoalHook() {},
            scheduleSurfaceShutdown() {},
            sealChildBashJobs: async () => {},
          },
        };
        const teardown =
          kind === "rebuild-handoff"
            ? f.stack.dispose({ kind })
            : kind === "defensive"
              ? f.stack.dispose({ kind }, env)
              : f.stack.dispose({ kind, reason: "reload" }, env);
        expect(r.signal.aborted).toBe(true);
        expect(r.tracker.current()).toBeUndefined();
        expect(log[0]).toBe("memory");
        expect(log.indexOf("background")).toBeGreaterThan(0);
        expect(await pending).toMatchObject({ ok: false });
        await teardown;
        expect(f.scopes.current()).toBeUndefined();
      } finally {
        await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        f.session.dispose();
      }
    },
  );

  it("actual Stack terminal resume opens original child history without recapturing/reseeding parent", async () => {
    const f = await fixture("tui", undefined, true);
    const model = fakeModel();
    observed.childRuntime = fakeModelRuntime(model, [textTurn("persisted offline child")]);
    const { PiSessionDriver } = await import("../../src/runtime/session-driver.js");
    const resume = vi.spyOn(PiSessionDriver.prototype, "resume");
    try {
      const root = f.scopes.current()!;
      await root.tool.run("initial", { op: "create", storageScope: "session", text: "resume original seed" });
      const snapshot = vi.spyOn(root.session!, "snapshot");
      const first = await f.stack.spawn.spawnAndWait({
        type: "memory-worker",
        prompt: "persist offline",
        cwd: f.cwd,
        modelOverride: { provider: model.provider, id: model.id },
      });
      expect(first.status).toBe("completed");
      expect(first.diag.sessionFile).toBeDefined();
      const old = observed.children[0]!.sessionManager;
      const { isLiveSessionFile } = await import("../../src/core/live-session-files.js");
      await vi.waitFor(() => expect(isLiveSessionFile(first.diag.sessionFile!)).toBe(false));
      await root.tool.run("later", { op: "create", storageScope: "session", text: "must not resume inherit" });
      const second = await f.stack.spawn.spawnAndWait({
        type: "memory-worker",
        prompt: "resume offline",
        cwd: f.cwd,
        resumeFrom: first.runId,
        modelOverride: { provider: model.provider, id: model.id },
      });
      expect(second.status).toBe("completed");
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(resume.mock.calls).toHaveLength(1);
      expect(resume.mock.calls[0]![1].memorySeed).toBeUndefined();
      const reopened = observed.children[1]!.sessionManager;
      expect(reopened).not.toBe(old);
      expect(reopened.getSessionId()).toBe(old.getSessionId());
      const entries = reopened
        .getBranch()
        .filter((e) => e.type === "custom" && e.customType === "subagent:memory-session");
      expect(entries).toHaveLength(1);
      expect(JSON.stringify(entries)).toContain("resume original seed");
      expect(JSON.stringify(entries)).not.toContain("must not resume inherit");
    } finally {
      await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      f.session.dispose();
    }
  });
});
