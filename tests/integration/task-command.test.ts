import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryOutboxStore, MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig } from "../../src/core/types.js";
import { createNotifier, type PersistedDelivery } from "../../src/delivery/notifier.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createLiveRunRegistry } from "../../src/service/run-registry.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createQueryService } from "../../src/service/query-service.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import { createTaskCommand, TASK_STARTED_CUSTOM_TYPE } from "../../src/commands/task.js";

/**
 * Cross-layer delivery check for `/task` (acceptance #2): a run dispatched by
 * the /task command must settle through the exact same notification path as a
 * main-session Agent-tool background run — real SpawnService → real
 * RuntimeRunnerAdapter (scripted driver) → real Notifier over a real
 * MemoryOutboxStore, assembled the way wiring.test.ts does it. If /task ever
 * grew a private delivery shortcut, the two sender receipts below diverge.
 */

const never = <T>() => new Promise<T>(() => undefined);

function fastBudget() {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 200,
    startupMs: 200,
    bindMs: 200,
    firstEventMs: 200,
    idleMs: 200,
    modelTurnMs: 400,
    toolMs: 200,
    totalMs: 500,
    totalGraceMs: 0,
    abortGraceMs: 20,
    steerMs: 10,
    reapMs: 20,
    retrySlackMs: 20,
  };
}

function handle(overrides: Partial<SessionHandle> = {}): SessionHandle {
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
    getLastAssistantText: () => "task done",
    getUsage: () => undefined,
    ...overrides,
  };
}

function buildHarness(clock: FakeClock, driver: SessionDriver) {
  const budget = fastBudget();
  const pool = new SingleSlotPool(clock, 1);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const runnerRef: { current?: ReturnType<typeof createRuntimeRunnerAdapter> } = {};
  const watchdog = new EventWatchdog({
    clock,
    budget,
    tickMs: 10,
    getState: (runId, gen) => runnerRef.current?.getRunState?.(runId, gen),
    dispatch: (runId, gen, input) => {
      if (input.kind === "deadline_fired") runnerRef.current?.fireDeadline?.(runId, gen, input);
    },
  });
  const outbox = new MemoryOutboxStore<PersistedDelivery>();
  const sent: PersistedDelivery[] = [];
  const notifier = createNotifier({
    store: outbox,
    clock,
    cancelBuffered: () => undefined,
    sender: (payload) => void sent.push(payload as PersistedDelivery),
  });
  const runner = createRuntimeRunnerAdapter({ clock, driver, pool, store, watchdog, reaper, notifier });
  runnerRef.current = runner;
  const type: AgentTypeConfig = {
    name: "general-purpose",
    description: "general",
    systemPrompt: "",
    promptMode: "append",
  };
  const types = {
    get: (name: string) => (name === "general-purpose" ? type : undefined),
    list: () => [type],
    reload: async () => ({ types: [type], errors: [] }),
  };
  const spawnService = createSpawnService({ types, pool, runner, now: () => clock.now(), budget });
  const registry = createLiveRunRegistry(spawnService, store);
  const queryService = createQueryService({ registry, runner, clock });
  // The context-only start record (/task's own write; NOT part of the shared
  // delivery path) — captured separately so the assertion can tell them apart.
  const startRecords: Array<{ message: unknown; options: unknown }> = [];
  const command = createTaskCommand({
    spawn: (req) => spawnService.spawn(req),
    sendMessage: (message, options) => startRecords.push({ message, options }),
  });
  const notify = vi.fn();
  const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;
  return { spawnService, registry, queryService, sent, startRecords, command, notify, ctx };
}

async function drain(clock: FakeClock, ticks: number, stepMs = 1) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    clock.advance(stepMs);
    await Promise.resolve();
  }
}

describe("/task integration: completion notification path", () => {
  it("delivers the /task run's completion through the same notifier path as an Agent background run", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const h = buildHarness(clock, driver);

    // 1) /task dispatch (user command).
    await h.command.handler("fix the login timeout bug\nverify with tests", h.ctx);
    expect(h.notify).toHaveBeenCalledOnce(); // user toast, not an error
    expect(h.startRecords).toHaveLength(1);
    const record = h.startRecords[0]! as {
      message: { customType: string; content: string; details: { runId: string; label: string } };
      options: { triggerTurn: boolean };
    };
    expect(record.message.customType).toBe(TASK_STARTED_CUSTOM_TYPE);
    expect(record.options).toEqual({ triggerTurn: false });

    // 2) A main-session Agent-tool background dispatch: the exact request
    // shape spawnInBackground builds (label via description, detachSignalOnStart,
    // no ack / parent / budget override).
    const agentSpawned = await h.spawnService.spawn({
      type: "general-purpose",
      prompt: "agent-tool background run",
      label: "agent-tool background run",
      detachSignalOnStart: true,
    });
    if ("error" in agentSpawned) throw new Error(agentSpawned.error.message);

    await drain(clock, 60);

    // Both runs completed through the shared runner.
    const taskRunId = record.message.details.runId;
    expect(h.registry.get(taskRunId)?.status).toBe("completed");
    expect(h.registry.get(agentSpawned.runId)?.status).toBe("completed");

    // Both completions were handed to the SAME notifier sender, with the
    // identical DeliveryPayload shape the outbox expects (runId:generation
    // key, terminal status, label) — no private delivery path for /task.
    const taskNotice = h.sent.find((p) => p.runId === taskRunId);
    const agentNotice = h.sent.find((p) => p.runId === agentSpawned.runId);
    expect(taskNotice).toBeDefined();
    expect(agentNotice).toBeDefined();
    for (const notice of [taskNotice, agentNotice]) {
      expect(notice!.status).toBe("completed");
      expect(notice!.key).toBe(`${notice!.runId}:1`);
      expect(notice!.key.split(":")).toHaveLength(2);
      expect(typeof notice!.label).toBe("string");
    }

    // The /task run is a root run: label registered, resolvable via the query
    // service exactly like an Agent run (get_subagent_result / @mention / steer).
    expect(h.queryService.get(taskRunId)?.diag.label).toBe("fix-the-login-timeout-bug");
  });

  it("uniquifies repeated /task labels through SpawnService like Agent dispatches", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle({ prompt: () => never() }),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const h = buildHarness(clock, driver);
    await h.command.handler("same task", h.ctx);
    await h.command.handler("same task", h.ctx);
    const labels = h.startRecords.map((r) => (r.message as { details: { label: string } }).details.label);
    expect(labels[0]).toBe("same-task");
    expect(labels[1]).toBe("same-task-2");
  });
});
