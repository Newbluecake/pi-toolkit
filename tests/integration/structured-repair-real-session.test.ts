/**
 * Structured-output repair turn (structured-output-repair-plan.md §3.4): real
 * `AgentSession` + real `PiSessionDriver.bind` + the real adapter/runner/watchdog
 * stack, with the REAL child wiring (`wireChildSession` — keepalive +
 * context-switch) loaded through DefaultResourceLoader. The driver's create()
 * builds the session from `spec.customTools` / `spec.tools` exactly like
 * PiSessionDriver.create would, except the model runtime is the scripted fake.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { wireChildSession } from "../../src/child/wire.js";
import { readSettingsNoMigrate } from "../../src/config/settings.js";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { STRUCTURED_REPAIR_PROMPT } from "../../src/core/structured-repair.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, RunOutcome } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import {
  PiSessionDriver,
  PiSessionHandle,
  CHILD_CACHE_KEEPALIVE_CUSTOM_TYPE,
} from "../../src/runtime/session-driver.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import type { RunnerSpec } from "../../src/service/ports.js";
import type { SpawnRequest } from "../../src/service/spawn-service.js";
import type { Notifier } from "../../src/delivery/notifier.js";

function fakeModel() {
  return {
    id: "fake-model",
    name: "Fake Model",
    api: "anthropic-messages",
    provider: "fake-provider",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
}
type FakeModel = ReturnType<typeof fakeModel>;

interface ScriptedTurn {
  toolCall: boolean;
  /** the never-completing variant for §3.4-C */
  hang?: boolean;
  build: (model: FakeModel) => unknown;
}

function assistantTextMsg(model: FakeModel, text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
function assistantToolCallMsg(model: FakeModel, toolCallId: string, name: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

const HANDOFF_ARGS = {
  goal: "Deliver the structured-output repair turn.",
  progress: "Wired the runner repair round and the adapter capture window.",
  next_steps: "Run the real-session integration suite and report.",
  keep_recent: false,
};

const objSchema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };

const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeModelRuntime(model: FakeModel, scripted: ScriptedTurn[]) {
  let call = 0;
  return {
    streamSimple: (_m: unknown, _context: { messages?: unknown[] }) => {
      const turn = scripted[call] ?? scripted[scripted.length - 1]!;
      call += 1;
      const stream = createAssistantMessageEventStream();
      if (turn.hang) return stream; // never pushes anything: the request stays in flight
      const message = turn.build(model) as { stopReason?: string };
      if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: turn.toolCall ? "toolUse" : "stop", message });
      return stream;
    },
    getAuth: async () => undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ ok: true }),
    isUsingOAuth: () => false,
    getAvailableSnapshot: () => [model],
    getModel: () => model,
    callCount: () => call,
  };
}

async function sleep0(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

interface CaseResult {
  outcome: RunOutcome;
  sessionPrompts: string[];
  modelRuntime: ReturnType<typeof fakeModelRuntime>;
  handle: PiSessionHandle;
  dispose: () => void;
}

async function runSchemaCase(opts: {
  scripted: ScriptedTurn[];
  request?: Partial<SpawnRequest>;
  /** §3.4-C: FakeClock ms to advance once the repair prompt is in flight and the 3rd model call started. */
  advanceAfterThirdCallMs?: number;
}): Promise<CaseResult> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-structured-repair-"));
  dirs.push(cwd);
  const model = fakeModel();
  const modelRuntime = fakeModelRuntime(model, opts.scripted);
  // plan §3.4 harness: keepalive + context-switch both enabled through the
  // REAL wireChildSession (pre-guard child wiring).
  const baseSettings = readSettingsNoMigrate(join(cwd, "does-not-exist.json"));
  const settings = {
    ...baseSettings,
    cacheTtl: { ...baseSettings.cacheTtl, keepalive: true, childKeepalive: true },
    compact: { ...baseSettings.compact, childSessions: true },
  };
  const sessionPrompts: string[] = [];
  let handleRef: PiSessionHandle | undefined;
  const realDriverForBind = new PiSessionDriver();
  const driver: SessionDriver = {
    create: async (spec) => {
      const settingsManager = SettingsManager.create(cwd, join(cwd, ".pi-agent"));
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: join(cwd, ".pi-agent"),
        settingsManager,
        extensionFactories: [(pi: unknown) => wireChildSession(pi as never, settings)] as never,
      });
      await loader.reload();
      const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
      const { session } = await createAgentSession({
        cwd,
        model: model as never,
        modelRuntime: modelRuntime as never,
        sessionManager,
        settingsManager,
        resourceLoader: loader,
        ...(spec.tools === undefined ? {} : { tools: spec.tools }),
        ...(spec.customTools === undefined ? {} : { customTools: spec.customTools }),
      } as never);
      const handle = new PiSessionHandle(session);
      const origPrompt = handle.prompt.bind(handle);
      handle.prompt = (text: string) => {
        sessionPrompts.push(text);
        return origPrompt(text);
      };
      handleRef = handle;
      return handle;
    },
    bind: (h, onEvent) => realDriverForBind.bind(h as PiSessionHandle, onEvent),
    onLateArrival: () => undefined,
  };
  const clock = new FakeClock(1_000_000);
  const pool = new SingleSlotPool(clock, 1);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const notifier: Notifier = {
    enqueue: vi.fn(),
    finalize: vi.fn(() => "missing" as const),
    settleBatch: () => undefined,
    ack: () => false,
    peek: () => undefined,
    consume: () => false,
    reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
    verifyPersisted: () => ({ missing: [] }),
    stats: { staged: 0, pending: 0, batched: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
    degraded: [],
    ackedSuppressions: 0,
    dispose: () => undefined,
  };
  const runnerRef: { current?: ReturnType<typeof createRuntimeRunnerAdapter> } = {};
  const watchdog = new EventWatchdog({
    clock,
    budget: DEFAULT_BUDGET,
    getState: (id, gen) => runnerRef.current?.getRunState(id, gen),
    dispatch: (id, gen, input) => {
      if (input.kind === "deadline_fired") runnerRef.current?.fireDeadline(id, gen, input);
    },
  });
  const adapter = createRuntimeRunnerAdapter({
    clock,
    driver,
    pool,
    store,
    watchdog,
    reaper,
    notifier,
    childSwitchContextGrant: () => true,
  });
  runnerRef.current = adapter;
  const spec: RunnerSpec = {
    runId: "r-structured-repair",
    type,
    request: {
      type: "worker",
      prompt: "answer with structured output",
      schema: objSchema,
      ...opts.request,
    } as SpawnRequest,
    budget: DEFAULT_BUDGET,
  };
  const runP = adapter.run(spec);
  if (opts.advanceAfterThirdCallMs !== undefined) {
    // wait until the repair prompt is in flight AND its post-switch model call started
    for (let i = 0; i < 500 && (sessionPrompts.length < 2 || modelRuntime.callCount() < 3); i++) await sleep0();
    expect(sessionPrompts).toHaveLength(2);
    expect(modelRuntime.callCount()).toBeGreaterThanOrEqual(3);
    clock.advance(opts.advanceAfterThirdCallMs);
  }
  const outcome = await Promise.race([
    runP,
    (async () => {
      for (let i = 0; i < 500; i++) await sleep0();
      throw new Error("real-session run did not settle within the real-time budget");
    })(),
  ]);
  for (let i = 0; i < 20; i++) await sleep0();
  const handle = handleRef!;
  return {
    outcome,
    sessionPrompts,
    modelRuntime,
    handle,
    dispose: () => {
      try {
        handle.session.dispose?.();
      } catch {
        /* best effort */
      }
    },
  };
}

describe("structured repair turn against a real AgentSession with real child wiring", () => {
  it("A: turn1 plain text → repair turn submits via StructuredOutput → closing text: completed, 3 provider calls, no keepalive pings", async () => {
    const r = await runSchemaCase({
      scripted: [
        {
          toolCall: false,
          build: (m) => assistantTextMsg(m, 'I could not call the tool, here is JSON: {"answer":"42"}'),
        },
        { toolCall: true, build: (m) => assistantToolCallMsg(m, "tc-repair", "StructuredOutput", { answer: "42" }) },
        { toolCall: false, build: (m) => assistantTextMsg(m, "submitted, done") },
      ],
    });
    try {
      expect(r.outcome.status).toBe("completed");
      expect(r.outcome.structuredResult).toEqual({ answer: "42" });
      expect(r.outcome.diag.structuredRepair).toBe("succeeded");
      expect(r.sessionPrompts).toHaveLength(2);
      expect(r.sessionPrompts[1]).toBe(STRUCTURED_REPAIR_PROMPT);
      // the run still reports the FIRST prompt's final text
      expect(r.outcome.text).toContain("here is JSON");
      // 3 model turns total — the keepalive service (armed through the real
      // wireChildSession) inserted no provider ping between the settles
      expect(r.modelRuntime.callCount()).toBe(3);
      expect(r.outcome.diag.turns).toBe(3);
      // the repair prompt really is on the session branch as a user message
      const branch = r.handle.session.sessionManager.getBranch() as Array<Record<string, unknown>>;
      const repairUserMsg = branch.some(
        (e) =>
          e["type"] === "message" &&
          (e["message"] as { role?: string } | undefined)?.role === "user" &&
          JSON.stringify(e["message"]).includes("You finished without calling the StructuredOutput tool"),
      );
      expect(repairUserMsg).toBe(true);
      // child keepalive ledger: zero entries for this session
      const keepaliveEntries = branch.filter((e) => e["customType"] === CHILD_CACHE_KEEPALIVE_CUSTOM_TYPE);
      expect(keepaliveEntries).toHaveLength(0);
    } finally {
      r.dispose();
    }
  });

  it("B: the repair turn still answers in plain text — failed(schema) with the repair suffix", async () => {
    const r = await runSchemaCase({
      scripted: [
        { toolCall: false, build: (m) => assistantTextMsg(m, "no tool call") },
        { toolCall: false, build: (m) => assistantTextMsg(m, "still no tool call") },
      ],
    });
    try {
      expect(r.outcome.status).toBe("failed");
      expect(r.outcome.error?.message).toContain("(after one repair turn)");
      expect(r.sessionPrompts).toHaveLength(2);
      expect(r.outcome.diag.structuredRepair).toBe("failed");
    } finally {
      r.dispose();
    }
  });

  it("C: the repair turn switches context and the next request never lands — failed(model) self-check, not completed", async () => {
    const r = await runSchemaCase({
      scripted: [
        { toolCall: false, build: (m) => assistantTextMsg(m, "plain answer first") },
        { toolCall: true, build: (m) => assistantToolCallMsg(m, "tc-switch", "switch_context", HANDOFF_ARGS) },
        { toolCall: false, hang: true, build: (m) => assistantTextMsg(m, "never lands") },
      ],
      // local close of the repair window (120s) while the 3rd request hangs
      advanceAfterThirdCallMs: 120_000,
    });
    try {
      expect(r.outcome.status).toBe("failed");
      expect(r.outcome.error?.kind).toBe("model");
      expect(r.outcome.error?.message).toContain("context switch self-check failed");
      expect(r.outcome.structuredResult).toBeUndefined();
      expect(r.handle.getSwitchTail()?.assistantAfter).toBe(false);
    } finally {
      r.dispose();
    }
  });

  it("D: readonly domain — the enforcer's turn-boundary re-checks keep StructuredOutput active and the repair submits", async () => {
    const r = await runSchemaCase({
      scripted: [
        { toolCall: false, build: (m) => assistantTextMsg(m, "text only first") },
        { toolCall: true, build: (m) => assistantToolCallMsg(m, "tc-ro", "StructuredOutput", { answer: "ok" }) },
        { toolCall: false, build: (m) => assistantTextMsg(m, "done") },
      ],
      request: { toolDomain: "readonly", suppressDelivery: true },
    });
    try {
      expect(r.outcome.status).toBe("completed");
      expect(r.outcome.structuredResult).toEqual({ answer: "ok" });
      expect(r.sessionPrompts).toHaveLength(2);
    } finally {
      r.dispose();
    }
  });
});
