/** I1 actual production startup: no test-owned hook consumer. Own temporary
 * memory root + real SDK scopes owner + ORIGINAL C scan/lock and namespace. */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  type ExtensionContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { createPromptSectionHub } from "../../src/sysprompt/hub.js";
import { afterEach, expect, it, vi } from "vitest";
import { fakePi, emitAll } from "./helpers/schedule-activate.js";
import { startupFixture, startupTree } from "../memory/govern/revision-startup-helpers.js";
import { loadSettings } from "../../src/config/settings.js";
import { wireMemoryScopes } from "../../src/memory/scopes/wire.js";
import { wireMemory } from "../../src/memory/index.js";
import { memoryDirFor } from "../../src/memory/paths.js";
import { recordWorktreeOrigin, forgetWorktreeOrigin } from "../../src/core/worktree-origin.js";
import * as auditModule from "../../src/memory/govern/revision-audit.js";
import * as lockModule from "../../src/memory/lock.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) close();
});
async function host(
  options: {
    session?: boolean;
    hub?: boolean;
    enabled?: boolean;
    child?: boolean;
    domain?: "plain" | "secure" | "locked";
    noOwner?: boolean;
    gate?: boolean;
    worktree?: boolean;
  } = {},
) {
  const fixture = await startupFixture(["marker-missing", "unknown", "corrupt"]);
  const root = fs.mkdtempSync(join(tmpdir(), "memory-i1-startup-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project"),
    tree = join(root, "tree");
  fs.mkdirSync(cwd);
  fs.mkdirSync(tree);
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(root, "memory"));
  const dir = memoryDirFor(cwd);
  fs.mkdirSync(join(root, "memory"));
  // Canonical slug symlinks are an existing supported memory-root contract.
  fs.symlinkSync(fixture.dir, dir, "dir");
  if (options.worktree) {
    recordWorktreeOrigin(tree, cwd);
    cleanup.push(() => forgetWorktreeOrigin(tree));
  }
  const f = fakePi(),
    lifecycle = new AbortController();
  const settings = loadSettings({
    memory: {
      enabled: options.enabled ?? true,
      scopes: { session: options.session ?? true, hub: options.hub ?? false },
      layout: "blocks",
      governance: { enabled: false },
      jev: { enabled: false },
      migrate: { auto: false },
      doctor: { notifyOnStart: false },
      incremental: { enabled: false, auto: false, jobCostCapUsd: 0 },
    },
  }).memory;
  const manager = SessionManager.inMemory(cwd),
    notify = vi.fn();
  const ctx = {
    cwd: options.worktree ? tree : cwd,
    mode: "tui",
    hasUI: true,
    ui: { notify },
    sessionManager: manager,
    isIdle: () => true,
    hasPendingMessages: () => false,
  } as unknown as ExtensionContext;
  const domain = options.domain ?? "plain",
    child = options.child ?? false;
  const scopes = options.noOwner
    ? undefined
    : wireMemoryScopes(f.pi, {
        settings,
        domain,
        child,
        gate: { check: () => ({ ok: true }) },
        locked: () => false,
        remote: () => undefined,
        hubPaths: () => ({ stateDir: join(root, "absent-hub") }),
      });
  cleanup.push(
    () => scopes?.dispose(),
    () => lifecycle.abort(),
  );
  wireMemory(f.pi, {
    settings,
    isChildSession: child,
    secureDomainKind: domain,
    ...(scopes ? { scopes } : {}),
    sessionSignal: () => lifecycle.signal,
    writeGate: { capture() {}, check: () => (options.gate === false ? { ok: false, reason: "locked" } : { ok: true }) },
    sections: { register: vi.fn() } as never,
  });
  const scans = vi.fn();
  const factory = auditModule.createRevisionAuditPort;
  vi.spyOn(auditModule, "createRevisionAuditPort").mockImplementation((path, deps) => {
    const c = factory(path, deps);
    return {
      ...c,
      scanPendingLocked() {
        expect(path).toBe(fixture.dir);
        expect(fs.existsSync(join(path, ".lock"))).toBe(true);
        scans();
        return c.scanPendingLocked();
      },
    };
  });
  return {
    ...f,
    fixture,
    ctx,
    manager,
    scopes,
    notify,
    scans,
    lifecycle,
    start: () => emitAll(f, "session_start", { type: "session_start", reason: "startup" }, ctx),
  };
}
it.each([false, true])(
  "production natural startup resolves worktree=%s once, real owner and C, disabled provider/auto/cap independent",
  async (worktree) => {
    const h = await host({ worktree });
    const before = startupTree(h.fixture.dir);
    expect(h.scopes?.current()).toBeUndefined();
    await h.start();
    expect(h.scopes?.current()?.manager).toBe(h.manager);
    expect(h.scans).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledTimes(1);
    const text = String(h.notify.mock.calls[0]?.[0]);
    expect(text).toContain("commit-unknown=2");
    expect(text).toContain("corrupted=1");
    expect(text).toContain("committed=0");
    expect(text).not.toContain("PRIVATE_TEST_BODY");
    expect(text).not.toContain(h.fixture.dir);
    expect(h.manager.getBranch()).toEqual([]);
    expect(startupTree(h.fixture.dir)).toEqual(before);
  },
);
it.each(["off", "child", "rpc", "web", "secure", "locked", "all-off", "no-owner", "gate"])(
  "production %s never scans",
  async (mode) => {
    const h = await host({
      enabled: mode !== "off",
      child: mode === "child",
      session: mode !== "all-off",
      noOwner: mode === "no-owner",
      gate: mode !== "gate",
      ...(mode === "secure" || mode === "locked" ? { domain: mode } : {}),
    });
    if (mode === "rpc") Object.assign(h.ctx, { mode: "rpc" });
    if (mode === "web") Object.assign(h.ctx, { webInvocation: true });
    const before = startupTree(h.fixture.dir);
    await h.start();
    expect(h.scans).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(startupTree(h.fixture.dir)).toEqual(before);
  },
);
it.each(["manager", "tree", "reload", "host-after-unlock"])(
  "production %s lifetime revokes pending startup warning",
  async (mode) => {
    const h = await host();
    const original = lockModule.withMemoryDirLock;
    vi.spyOn(lockModule, "withMemoryDirLock").mockImplementation(async (dir, body, opts) => {
      const result = await original(dir, body, opts);
      if (h.scans.mock.calls.length) {
        if (mode === "manager") h.scopes!.context({ ...h.ctx, sessionManager: SessionManager.inMemory(h.ctx.cwd) });
        if (mode === "tree" || mode === "reload")
          await emitAll(h, mode === "tree" ? "session_tree" : "session_shutdown", { reason: "reload" }, h.ctx);
        if (mode === "host-after-unlock") h.lifecycle.abort();
      }
      return result;
    });
    await h.start();
    expect(h.scans).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
  },
);
it("production hub-only uses existing actual owner without constructing a session store", async () => {
  const h = await host({ session: false, hub: true });
  await h.start();
  expect(h.scopes?.current()?.session).toBeUndefined();
  expect(h.scans).toHaveBeenCalledTimes(1);
  expect(h.notify).toHaveBeenCalledTimes(1);
});

it("real SDK native TUI session_start supplies the actual context/owner/warning and worktree origin exactly once", async () => {
  const fixture = await startupFixture(["marker-missing"]);
  const root = fs.mkdtempSync(join(tmpdir(), "i1-native-sdk-"));
  const cwd = join(root, "origin"),
    tree = join(root, "tree"),
    agentDir = join(root, "agent");
  fs.mkdirSync(cwd);
  fs.mkdirSync(tree);
  fs.mkdirSync(agentDir);
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(root, "memory"));
  fs.mkdirSync(join(root, "memory"));
  fs.symlinkSync(fixture.dir, memoryDirFor(cwd), "dir");
  recordWorktreeOrigin(tree, cwd);
  const settings = loadSettings({
    memory: {
      enabled: true,
      scopes: { session: true, hub: false },
      jev: { enabled: false },
      governance: { enabled: false },
      incremental: { enabled: false },
      migrate: { auto: false },
      doctor: { notifyOnStart: false },
    },
  }).memory;
  const manager = SessionManager.inMemory(tree),
    notify = vi.fn();
  const settingsManager = SettingsManager.create(tree, agentDir);
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    authPath: join(agentDir, "absent-auth.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const contexts: ExtensionContext[] = [];
  let scopes: ReturnType<typeof wireMemoryScopes>;
  const loader = new DefaultResourceLoader({
    cwd: tree,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [
      (api) => {
        scopes = wireMemoryScopes(api, {
          settings,
          child: false,
          domain: "plain",
          gate: { check: () => ({ ok: true }) },
          locked: () => false,
          remote: () => undefined,
          hubPaths: () => undefined,
        });
        wireMemory(api, {
          settings,
          ...(scopes ? { scopes } : {}),
          isChildSession: false,
          secureDomainKind: "plain",
          sections: createPromptSectionHub(api, {
            mode: () => "stable",
            wakeReplay: false,
            adoptForeignForcedPrompt: false,
          }),
        });
        api.on("session_start", (_event, ctx) => {
          contexts.push(ctx);
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: tree,
    agentDir,
    sessionManager: manager,
    settingsManager,
    modelRuntime: runtime,
    resourceLoader: loader,
    tools: [],
  });
  const before = startupTree(fixture.dir),
    beforeBranch = manager.getBranch();
  const factory = auditModule.createRevisionAuditPort,
    scans = vi.fn();
  vi.spyOn(auditModule, "createRevisionAuditPort").mockImplementation((dir, deps) => {
    const audit = factory(dir, deps);
    return {
      ...audit,
      scanPendingLocked() {
        expect(fs.existsSync(join(dir, ".lock"))).toBe(true);
        scans();
        return audit.scanPendingLocked();
      },
    };
  });
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("native startup must not call a provider"));
  try {
    // Only the notification UI boundary is test-owned. SDK constructs its real
    // live context and emits its natural startup; no fabricated context object.
    await session.bindExtensions({ mode: "tui", uiContext: { notify } as unknown as ExtensionUIContext });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.mode).toBe("tui");
    expect(contexts[0]!.hasUI).toBe(true);
    expect(contexts[0]!.sessionManager).toBe(manager);
    expect(scopes!.current()?.manager).toBe(manager);
    expect(scans).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain("commit-unknown=1");
    expect(fetch).not.toHaveBeenCalled();
    expect(manager.getBranch()).toEqual(beforeBranch);
    expect(startupTree(fixture.dir)).toEqual(before);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    forgetWorktreeOrigin(tree);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
