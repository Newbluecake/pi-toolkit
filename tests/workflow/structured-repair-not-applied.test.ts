import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, DriverEvent, RunSnapshot, SubagentExtensionPoints } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService, type SpawnService } from "../../src/service/spawn-service.js";
import type { Notifier } from "../../src/delivery/notifier.js";

/**
 * Structured-output repair turn (structured-output-repair-plan.md §3.3):
 * workflow children never get one. The harness reuses the real
 * SpawnService + createRuntimeRunnerAdapter stack exactly the way
 * tests/workflow/a2-window-real-spawn-service.test.ts wires it; the fake
 * child handle DELIBERATELY exposes "StructuredOutput" in getActiveTools (and
 * never submits anything) to prove the guard is the missing `schema` in the
 * SpawnRequest, not the session's tool surface: even a maliciously capable
 * child gets exactly one prompt and exactly one settlement.
 */

const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };

const TERMINAL = new Set(["completed", "failed", "timed_out", "aborted"]);

describe("workflow children never get a structured-output repair turn", () => {
  it("a StructuredOutput-capable child that never submits: one prompt, one settle, one journal record", async () => {
    const clock = new FakeClock(1_000_000);
    const prompts: string[] = [];
    let onEvent: ((e: DriverEvent) => void) | undefined;
    const handle: SessionHandle = {
      sessionId: "wf-child-1",
      sessionFile: "wf-child-1.json",
      prompt: (text) => {
        prompts.push(text);
        // a full normal text turn (the shape a repair would ride on)
        for (const e of [{ t: "turn_start" }, { t: "message_end" }, { t: "turn_end", toolResults: 0 }] as DriverEvent[])
          onEvent?.(e);
        return Promise.resolve();
      },
      steer: () => Promise.resolve(),
      requestAbort: () => Promise.resolve(),
      dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
      killableHandles: new Set(),
      setActiveTools: () => undefined,
      // deliberately capable — proves capability alone triggers nothing
      getActiveTools: () => ["read", "edit", "bash", "write", "StructuredOutput"],
      getLastAssistantText: () => "child final text",
      getUsage: () => undefined,
    };
    const driver: SessionDriver = {
      create: async () => handle,
      bind: async (_h, onE) => {
        onEvent = onE;
      },
      onLateArrival: () => undefined,
    };
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
    const journal = vi.fn();
    const onLifecycle = vi.fn();
    const pool = new SingleSlotPool(clock, 4);
    const store = new MemoryRunStore();
    const reaper = new EscalatingReaper(clock);
    const runnerRef: { current?: ReturnType<typeof createRuntimeRunnerAdapter> } = {};
    const watchdog = new EventWatchdog({
      clock,
      budget: DEFAULT_BUDGET,
      getState: (id, gen) => runnerRef.current?.getRunState(id, gen),
      dispatch: (id, gen, input) => {
        if (input.kind === "deadline_fired") runnerRef.current?.fireDeadline(id, gen, input);
      },
    });
    const runner = createRuntimeRunnerAdapter({
      clock,
      driver,
      pool,
      store,
      watchdog,
      reaper,
      notifier,
      journal,
      onLifecycle,
    });
    runnerRef.current = runner;
    const types = {
      get: (name: string) => (name === "worker" ? type : undefined),
      list: () => [type],
      reload: async () => ({ types: [type], errors: [] }),
    };
    const svc: SpawnService = createSpawnService({ types, pool, runner, now: () => clock.now() });

    const spawned = await svc.spawn({ type: "worker", prompt: "p" });
    if ("error" in spawned) throw new Error(spawned.error.message);

    let settled: { status: string } | undefined;
    for (let i = 0; i < 200 && settled === undefined; i++) {
      await Promise.resolve();
      clock.advance(50);
      await Promise.resolve();
      const state = runner.getRunState(spawned.runId);
      if (state && TERMINAL.has(state.status)) settled = { status: state.status };
    }
    if (settled === undefined) throw new Error("workflow child did not settle");
    for (let i = 0; i < 40; i++) await Promise.resolve();

    // exactly ONE prompt — no repair turn for a schema-less spawn
    expect(prompts).toHaveLength(1);
    // exactly ONE terminal settlement through every side channel
    expect(settled.status).toBe("completed");
    const terminalLifecycle = onLifecycle.mock.calls.filter((c) => TERMINAL.has((c[0] as { status: string }).status));
    expect(terminalLifecycle).toHaveLength(1);
    // one non-terminal journal record (session_created) and nothing more — a
    // repair turn could not add journal entries either, but this pins that the
    // single child run produced exactly the one record a replay would read back
    const journalRecords = (journal.mock.calls as unknown as [RunSnapshot][]).map((c) => c[0]);
    expect(journalRecords.filter((s) => s.runId === spawned.runId)).toHaveLength(1);
    expect(store.get(spawned.runId)?.outcome).toBeDefined();
  });
});
