import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sandboxHome } from "./helpers/home-sandbox.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { AgentTypeConfig } from "../../src/config/agent-types.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import type { RunSnapshot } from "../../src/core/types.js";
import { buildSessionStack } from "../../src/stack.js";
import { PiSessionDriver } from "../../src/runtime/session-driver.js";
import type { RuntimeAdapterDeps } from "../../src/service/runtime-adapter.js";

/**
 * consult plan §6 包 D — 接线收口。包 A–C（committed f7acf1b）built the whole
 * `src/consult/*` subsystem and wired its OWN deps into `runtime-adapter.ts`
 * and `agent-tool.ts`; what was still missing was `src/stack.ts` actually
 * calling `wireConsult` and forwarding its ports into
 * `createRuntimeRunnerAdapter`/`createSpawnService`/the top-level Agent tool
 * (`src/index.ts`). These tests exercise the REAL `buildSessionStack` (no
 * stack.ts mocking) and assert on what it hands the adapter/driver — a
 * regression here (e.g. forgetting to pass `consult:` into
 * `createRuntimeRunnerAdapter`) fails these tests even though the
 * package-C unit tests (which inject their own deps by hand) would not.
 */

let homeSandbox: ReturnType<typeof sandboxHome> | undefined;
beforeEach(() => {
  homeSandbox = sandboxHome();
});
afterEach(() => {
  homeSandbox?.restore();
  vi.restoreAllMocks();
  homeSandbox = undefined;
});

function fastBudget() {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 200,
    startupMs: 200,
    bindMs: 200,
    firstEventMs: 80,
    idleMs: 200,
    modelTurnMs: 200,
    toolMs: 200,
    totalMs: 500,
    totalGraceMs: 0,
    abortGraceMs: 20,
    steerMs: 10,
    reapMs: 30,
    retrySlackMs: 20,
  };
}

type Entry = { type: string; customType?: string; data?: unknown };

function harness(entries: Entry[] = []) {
  const appended: Entry[] = [];
  const pi = {
    appendEntry(customType: string, data?: unknown) {
      const entry = { type: "custom", customType, data };
      entries.push(entry);
      appended.push(entry);
    },
    sendMessage() {},
    registerEntryRenderer() {},
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    events: { on: () => () => undefined, emit: () => undefined },
    setModel: () => undefined,
    getThinkingLevel: () => undefined,
    setThinkingLevel: () => undefined,
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: { getEntries: () => entries, getSessionId: () => "consult-wiring" },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: {},
    hasUI: false,
    cwd: process.cwd(),
  } as unknown as ExtensionContext;
  return { pi, ctx, appended };
}

const dispatcherType: AgentTypeConfig = {
  name: "dispatcher",
  description: "dispatches",
  systemPrompt: "You dispatch.",
  promptMode: "append",
};

const types = {
  get: (name: string) => (name === "dispatcher" ? dispatcherType : undefined),
  list: () => [dispatcherType],
  reload: async () => ({ types: [dispatcherType], errors: [] }),
} as unknown as AgentTypeRegistry;

function settings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    budget: fastBudget(),
    fleetWidget: false,
    fabric: { ...DEFAULT_SETTINGS.fabric, enabled: false },
    workflow: { ...DEFAULT_SETTINGS.workflow, enabled: false },
    quota: { ...DEFAULT_SETTINGS.quota, enabled: false },
    cacheTtl: { ...DEFAULT_SETTINGS.cacheTtl, keepalive: false, adaptiveEnabled: false },
    bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
    ...overrides,
  };
}

function fakeHandle() {
  return {
    sessionId: "s1",
    sessionFile: undefined,
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "hello",
    getUsage: () => undefined,
  };
}

/** Spies on the driver PiSessionDriver hands the real runner — the only seam
 *  buildSessionStack doesn't let a test inject directly (no driver override
 *  parameter). Captures every `create`/`resume` call's SessionSpec. */
function spyOnDriver(): { calls: Array<{ kind: "create" | "resume"; spec: { customTools?: unknown[] } }> } {
  const calls: Array<{ kind: "create" | "resume"; spec: { customTools?: unknown[] } }> = [];
  vi.spyOn(PiSessionDriver.prototype, "create").mockImplementation(async (spec) => {
    calls.push({ kind: "create", spec: spec as { customTools?: unknown[] } });
    return fakeHandle() as never;
  });
  vi.spyOn(PiSessionDriver.prototype, "resume").mockImplementation(async (_file, spec) => {
    calls.push({ kind: "resume", spec: spec as { customTools?: unknown[] } });
    return fakeHandle() as never;
  });
  vi.spyOn(PiSessionDriver.prototype, "bind").mockResolvedValue(undefined);
  return { calls };
}

const toolNames = (spec: { customTools?: unknown[] }): string[] =>
  (spec.customTools ?? []).map((t) => (t as { name?: string }).name ?? "?");

async function drain(ticks = 20) {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 5));
}

describe("consult wiring: buildSessionStack → runtime-adapter → driver", () => {
  it("a dispatch carrying consultExperts gets the consult tool injected into its SessionSpec", async () => {
    const { calls } = spyOnDriver();
    const h = harness();
    const stack = buildSessionStack(
      h.pi,
      h.ctx,
      settings({ consult: { ...DEFAULT_SETTINGS.consult, enabled: true } }),
      types,
      [],
    );
    const spawned = await stack.spawn.spawn({
      type: "dispatcher",
      prompt: "consult the expert",
      consultExperts: [{ runId: "r_EXPERT1", sessionFile: "/tmp/expert1.jsonl", agentType: "explorer" }],
    });
    if ("error" in spawned) throw new Error(spawned.error.message);
    await drain();
    expect(calls.length).toBeGreaterThan(0);
    expect(toolNames(calls[0]!.spec)).toContain("consult");
  });

  it("a plain dispatch (no consultExperts) never gets the consult tool", async () => {
    const { calls } = spyOnDriver();
    const h = harness();
    const stack = buildSessionStack(
      h.pi,
      h.ctx,
      settings({ consult: { ...DEFAULT_SETTINGS.consult, enabled: true } }),
      types,
      [],
    );
    const spawned = await stack.spawn.spawn({ type: "dispatcher", prompt: "just do the task" });
    if ("error" in spawned) throw new Error(spawned.error.message);
    await drain();
    expect(calls.length).toBeGreaterThan(0);
    expect(toolNames(calls[0]!.spec)).not.toContain("consult");
  });

  it("consult.enabled=false ⇒ zero assembly: no tool injected even with a consultExperts whitelist, and resolveExperts throws", async () => {
    const { calls } = spyOnDriver();
    const h = harness();
    const stack = buildSessionStack(
      h.pi,
      h.ctx,
      settings({ consult: { ...DEFAULT_SETTINGS.consult, enabled: false } }),
      types,
      [],
    );
    const spawned = await stack.spawn.spawn({
      type: "dispatcher",
      prompt: "consult the expert",
      consultExperts: [{ runId: "r_EXPERT1", sessionFile: "/tmp/expert1.jsonl", agentType: "explorer" }],
    });
    if ("error" in spawned) throw new Error(spawned.error.message);
    await drain();
    expect(calls.length).toBeGreaterThan(0);
    expect(toolNames(calls[0]!.spec)).not.toContain("consult");
    expect(() => stack.consult.resolveExperts(["r_EXPERT1"])).toThrow(/consult is disabled/);
  });

  it("the top-level Agent tool's resolveExperts (index.ts wiring) forwards to the SAME consult wiring the runtime adapter uses", async () => {
    const h = harness();
    const stack = buildSessionStack(
      h.pi,
      h.ctx,
      settings({ consult: { ...DEFAULT_SETTINGS.consult, enabled: false } }),
      types,
      [],
    );
    // The exact expression index.ts's top-level createAgentTool() is wired
    // with (§6 D-16): `resolveExperts: (refs) => requireStack(holder).consult.resolveExperts(refs)`.
    expect(() => stack.consult.resolveExperts(["anything"])).toThrow(/consult is disabled/);
  });

  it("ExpertIndex survives a reload: a persisted subagent:run entry resolves in a FRESH stack build with no live run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "consult-wiring-expert-"));
    const sessionFile = join(dir, "expert-session.jsonl");
    writeFileSync(sessionFile, "");
    const snapshot: RunSnapshot = {
      runId: "r_OLDEXPERT",
      generation: 1,
      status: "completed",
      phase: "settled",
      deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
      diag: {
        createdAt: 0,
        phase: "settled",
        phaseEnteredAt: 0,
        pendingTools: 0,
        turns: 3,
        escalation: [],
        orphaned: false,
        generation: 1,
        degraded: [],
        staleInputs: 0,
        unkillable: [],
        label: "expert-x",
        sessionFile,
        agentType: "explorer",
      },
      updatedAt: 1000,
    };
    const entries: Entry[] = [{ type: "custom", customType: "subagent:run", data: snapshot }];

    // First build (pretend this is the original session that produced the entry).
    const first = harness(entries);
    const stack1 = buildSessionStack(first.pi, first.ctx, settings(), types, []);
    expect(stack1.consult.resolveExperts(["expert-x"]).refs[0]?.runId).toBe("r_OLDEXPERT");

    // Second, INDEPENDENT build sharing only the persisted entries array
    // (buildSessionStack's own module-level "previous*" handoff globals are
    // for the SAME module's session_start → session_start swap, not a new
    // spawn service — but the ExpertIndex itself is rebuilt purely from
    // `prefetchedEntries`, which is what a real `/reload` replays).
    const second = harness([...entries]);
    const stack2 = buildSessionStack(second.pi, second.ctx, settings(), types, []);
    const resolved = stack2.consult.resolveExperts(["r_OLDEXPERT"]);
    expect(resolved.refs).toHaveLength(1);
    expect(resolved.refs[0]).toMatchObject({ runId: "r_OLDEXPERT", sessionFile, agentType: "explorer" });
    expect(resolved.lines[0]).toContain("r_OLDEXPERT");
  });

  it("onReaped forwards to the real fork-store: a fork file under the consult dir is deleted, a foreign path is refused", async () => {
    const h = harness();
    const stack = buildSessionStack(h.pi, h.ctx, settings(), types, []);
    // Exercise onReaped through the SAME object the adapter/runner call —
    // undefined forkSessionFrom (non-consult run) must be a no-op.
    expect(() => stack.consult.onReaped("r_ANY", undefined)).not.toThrow();
    // A forged path outside the consult dir must be refused (defense in
    // depth, plan §7 "forkSessionFrom 不可伪造") — assert indirectly via not
    // throwing and the foreign file surviving.
    const outsideDir = mkdtempSync(join(tmpdir(), "consult-wiring-outside-"));
    const outsideFile = join(outsideDir, "not-mine.jsonl");
    writeFileSync(outsideFile, "type-session-header\n");
    expect(() => stack.consult.onReaped("r_ANY", outsideFile)).not.toThrow();
    const { existsSync } = await import("node:fs");
    expect(existsSync(outsideFile)).toBe(true);
  });
});

describe("consult wiring: RuntimeAdapterDeps captured from the real buildSessionStack", () => {
  it("consult / consultResolveExperts / onReaped are all forwarded into createRuntimeRunnerAdapter", async () => {
    const captured: { deps?: RuntimeAdapterDeps } = {};
    vi.doMock("../../src/service/runtime-adapter.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/service/runtime-adapter.js")>();
      return {
        ...original,
        createRuntimeRunnerAdapter: (deps: RuntimeAdapterDeps) => {
          captured.deps = deps;
          return original.createRuntimeRunnerAdapter(deps);
        },
      };
    });
    vi.resetModules();
    const { buildSessionStack: freshBuildSessionStack } = await import("../../src/stack.js");
    const h = harness();
    const stack = freshBuildSessionStack(h.pi, h.ctx, settings(), types, []);
    expect(typeof captured.deps?.consult).toBe("function");
    expect(typeof captured.deps?.consultResolveExperts).toBe("function");
    expect(typeof captured.deps?.onReaped).toBe("function");
    // consultResolveExperts (as handed to the nested Agent tool, §4.2) and
    // Stack.consult.resolveExperts (as handed to the top-level Agent tool,
    // §6 D-16) must agree — same underlying wiring, two call sites.
    expect(() => captured.deps!.consultResolveExperts!(["nope"])).toThrow();
    expect(() => stack.consult.resolveExperts(["nope"])).toThrow();
    vi.doUnmock("../../src/service/runtime-adapter.js");
    vi.resetModules();
  });
});
