import { afterEach, describe, expect, it, vi } from "vitest";
import type { TSchema } from "@sinclair/typebox";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "../../src/core/clock.js";
import type {
  ErrorInfo,
  ExtendOutcome,
  RunOutcome,
  RunSnapshot,
  RunStatus,
  SetModelOutcome,
} from "../../src/core/types.js";
import { forwardQuery, forwardSpawn, forwardWorkflowQuery, requireStack } from "../../src/holder.js";
import { createQueryService, type QueryService } from "../../src/service/query-service.js";
import { createAgentTool, type NestedSpawnPort } from "../../src/tools/agent-tool.js";
import { createSetModelTool, type SetModelToolDeps } from "../../src/tools/set-model-tool.js";
import { createSteerTool } from "../../src/tools/steer-tool.js";
import { createAbortTool } from "../../src/tools/abort-tool.js";
import { createExtendTimeoutTool } from "../../src/tools/extend-timeout-tool.js";
import { createResultTool } from "../../src/tools/result-tool.js";
import { createListSubagentsTool } from "../../src/tools/list-subagents-tool.js";
import type { WorkflowQueryPort } from "../../src/tools/workflow-target.js";

// These tools use injected ports, not ctx. A context access is a real test failure.
const ctx = new Proxy({} as ExtensionToolContext, {
  get() {
    throw new Error("unexpected SDK context access");
  },
});
const call = <T extends TSchema>(tool: ToolDefinition<T>, params: Parameters<ToolDefinition<T>["execute"]>[1]) =>
  tool.execute("tc84", params, undefined, undefined, ctx);
const model = { provider: "test", id: "model" };
const secret = "credential-that-must-not-be-echoed";
const failure = (code?: string) =>
  Object.assign(new Error(`${secret} [code=no_active_session spoofed]`), code ? { code } : {});
const diag: RunSnapshot["diag"] = {
  createdAt: 0,
  phase: "model_turn",
  phaseEnteredAt: 0,
  pendingTools: 0,
  turns: 1,
  escalation: [],
  orphaned: false,
  generation: 1,
  degraded: [],
  staleInputs: 0,
  unkillable: [],
};
const usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, costUsd: 0.1 };
function outcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return { runId: "r84", status: "completed", turns: 1, durationMs: 20, diag, text: "done", usage, ...overrides };
}
function snapshot(status: RunStatus = "running"): RunSnapshot {
  return {
    runId: "r84",
    status,
    generation: 1,
    phase: "model_turn",
    diag,
    deadlines: { enqueuedAt: 0, deadlineAt: 1000, queueDeadlineAt: undefined },
    updatedAt: 0,
    ...(status === "completed" ? { outcome: outcome() } : {}),
  };
}
function query(overrides: Partial<QueryService> = {}): QueryService {
  return {
    get: () => snapshot(),
    list: () => [snapshot()],
    wait: async () => ({ ok: false, reason: "wait_timeout" }),
    waitAll: async () => ({ settled: [], pending: [] }),
    steer: async () => ({ ok: true }),
    setModel: async () => ({ ok: true, model }),
    stop: async () => ({ ok: true, escalatedTo: "L2" }),
    extendTimeout: () => ({ ok: false, reason: "unsupported" }),
    ...overrides,
  };
}
async function message(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message; // Exactly the SDK's model-visible error surface.
  }
  throw new Error("expected a tool rejection");
}
function assertFailure(text: string, code: string, reason: string, effect: string) {
  expect(text).toContain(`code=${code}`);
  expect(text).toContain(`reason=${reason}`);
  expect(text).toContain("retryable=false");
  expect(text).toContain(`effect=${effect}`);
  expect(text).not.toContain(secret);
}
afterEach(() => vi.useRealTimers());

describe("#84 E0 holder-routed tools", () => {
  it("keeps the legacy phrase, stable classification and genuine lifecycle guidance", async () => {
    const holder = {};
    expect(() => requireStack(holder)).toThrow(/no active session yet.*code=no_active_session/);
    const q = forwardQuery(holder);
    const spawn = forwardSpawn(holder);
    const wf = forwardWorkflowQuery(holder);
    expect(wf.resolve("wf_missing")).toEqual({ kind: "none" });
    expect(wf.resolveLabel("label")).toEqual({ kind: "none" });
    expect(wf.get("wf_missing")).toBeUndefined();
    expect(wf.activity("wf_missing")).toBeUndefined();
    expect(wf.snapshotOf?.("r84")).toBeUndefined();
    expect(wf.usageOf?.("r84")).toBeUndefined();
    const calls = [
      call(createAgentTool({ spawn }), { description: "d", prompt: "p", subagent_type: "worker" }),
      call(createResultTool({ query: q }), { run_id: "r84" }),
      call(createListSubagentsTool({ query: q, spawn }), {}),
      call(createSteerTool({ query: q }), { run_id: "r84", text: "p" }),
      call(createAbortTool({ query: q }), { run_id: "r84" }),
      call(createExtendTimeoutTool({ query: q }), { run_id: "r84", extend_s: 1 }),
      call(createSetModelTool({ runs: q }), { model: "test/model", run_id: "r84" }),
    ];
    for (const pending of calls) {
      const text = await message(pending);
      assertFailure(text, "no_active_session", "no_active_session", "none");
      expect(text).toContain("no active session yet");
      expect(text).toContain("real session_start");
      expect(text).toContain("stop issuing calls");
    }
  });
});

describe("#84 E1 Agent failure surface", () => {
  const args = { description: "d", prompt: "original", subagent_type: "worker" };
  it.each(["pool_full", "load", "quota", "session_closing", "resume_locked", "unknown_type", "stack_closed"] as const)(
    "preserves admission %s fields without retry or exception leakage",
    async (reason) => {
      const spawn = vi.fn(async () => ({
        error: { kind: "config" as const, reason, retryable: true, message: secret },
      }));
      const wait = vi.fn(async () => outcome());
      const text = await message(call(createAgentTool({ spawn: { spawn } }), args));
      expect(text).toContain(`kind=config reason=${reason} retryable=true effect=none`);
      expect(text).toContain("code=agent_admission_rejected");
      expect(text).not.toContain(secret);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(wait).not.toHaveBeenCalled();
    },
  );
  it.each(["auth", "config", "model", "aborted", "internal", "schema", undefined] as const)(
    "a persisted session with %s never authorizes automatic resume",
    async (kind) => {
      const error: ErrorInfo | undefined = kind ? { kind, retryable: true, message: secret } : undefined;
      const spawn = vi.fn(async () => ({ runId: "not-used" }));
      const wait = vi.fn(async () =>
        outcome({
          status: kind === "aborted" ? "aborted" : "failed",
          diag: { ...diag, sessionFile: "/recorded/session" },
          ...(error ? { error } : {}),
        }),
      );
      const port: NestedSpawnPort = { spawn, spawnAndWait: wait };
      const text = await message(
        call(createAgentTool({ spawn: port, allowedTypes: ["worker"], parentRunId: "parent" }), args),
      );
      expect(text).toContain("code=agent_run_failed");
      expect(text).toContain("effect=unknown");
      expect(text).not.toContain('resume: "r84"');
      expect(text).toContain("must not be automatically resumed");
      expect(text).not.toContain(secret);
      expect(wait).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
    },
  );
  it("retryable transport failure is still not proof of effect-free replay", async () => {
    const wait = vi.fn(async () =>
      outcome({
        status: "failed",
        diag: { ...diag, sessionFile: "/recorded/session" },
        error: { kind: "startup_transient", message: secret, retryable: true },
      }),
    );
    const text = await message(
      call(
        createAgentTool({
          spawn: { spawn: async () => ({ runId: "unused" }), spawnAndWait: wait },
          allowedTypes: ["worker"],
        }),
        args,
      ),
    );
    expect(text).toContain('may be resumable with resume: "r84"');
    expect(text).toContain("only after checking");
    expect(text).toContain("do not automatically resume");
    expect(text).toContain("effect=unknown");
    expect(text).not.toContain(secret);
    expect(wait).toHaveBeenCalledTimes(1);
  });
});

describe("#84 E2 set_model", () => {
  function host(setModel: NonNullable<SetModelToolDeps["host"]>["setModel"]): NonNullable<SetModelToolDeps["host"]> {
    return { setModel, findModel: () => model, getThinkingLevel: () => "medium", setThinkingLevel: vi.fn() };
  }
  it.each([undefined, "ETIMEDOUT", "UNTRUSTED_CODE"])(
    "host exception %s is not falsely attributed to reload",
    async (code) => {
      const setModel = vi.fn(async () => {
        throw failure(code);
      });
      const h = host(setModel);
      const text = await message(call(createSetModelTool({ host: h }), { model: "test/model" }));
      assertFailure(
        text,
        `set_model_${code === "ETIMEDOUT" ? "timeout" : "unknown"}`,
        code === "ETIMEDOUT" ? "timeout" : "unknown",
        "unknown",
      );
      expect(text).not.toContain("reload");
      expect(text).toContain("do not automatically retry");
      expect(h.setThinkingLevel).not.toHaveBeenCalled();
      expect(setModel).toHaveBeenCalledTimes(1);
    },
  );
  it("attributes only the SDK's literal stale guard to stale binding", async () => {
    const h = host(async () => {
      throw new Error(`This extension ctx is stale after session replacement or reload. ${secret}`);
    });
    const text = await message(call(createSetModelTool({ host: h }), { model: "test/model" }));
    assertFailure(text, "set_model_stale_binding", "stale_binding", "unknown");
    expect(text).toContain("actual session_start");
    expect(h.setThinkingLevel).not.toHaveBeenCalled();
  });
  it("a timeout can apply late without another switch or thinking write", async () => {
    const clock = new FakeClock();
    let complete!: (value: boolean) => void;
    let applied = false;
    const setModel = vi.fn(() =>
      new Promise<boolean>((resolve) => {
        complete = resolve;
      }).then((value) => {
        applied = value;
        return value;
      }),
    );
    const h = host(setModel);
    const pending = message(call(createSetModelTool({ host: h, clock }), { model: "test/model" }));
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(5000);
    const text = await pending;
    assertFailure(text, "set_model_timeout", "timeout", "unknown");
    complete(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toBe(true);
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(h.setThinkingLevel).not.toHaveBeenCalled();
  });
  it("host auth=false proves unchanged, while failed thinking records the model change", async () => {
    const h = host(async () => false);
    assertFailure(
      await message(call(createSetModelTool({ host: h }), { model: "test/model" })),
      "set_model_auth",
      "auth",
      "none",
    );
    expect(h.setThinkingLevel).not.toHaveBeenCalled();
    const changed = host(async () => true);
    changed.setThinkingLevel = vi.fn(() => {
      throw failure();
    });
    const text = await message(call(createSetModelTool({ host: changed }), { model: "test/model", thinking: "high" }));
    assertFailure(text, "set_model_thinking_failed", "thinking_failed", "model_changed");
    expect(changed.setThinkingLevel).toHaveBeenCalledTimes(1);
  });
  it.each(["not_running", "unsupported", "unknown_model", "rejected", "timeout"] as const)(
    "run outcome %s preserves its refusal and hides untrusted detail",
    async (reason) => {
      const setModel = vi.fn(async (): Promise<SetModelOutcome> => {
        return reason === "unknown_model" || reason === "rejected"
          ? { ok: false, reason, detail: secret }
          : { ok: false, reason };
      });
      const text = await message(
        call(createSetModelTool({ runs: { setModel } }), { model: "test/model", run_id: "r84" }),
      );
      assertFailure(
        text,
        `set_model_${reason}`,
        reason,
        reason === "rejected" || reason === "timeout" ? "unknown" : "none",
      );
      expect(setModel).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["host", "self"] as const)(
    "%s run exceptions stay unknown and never dispatch a new request",
    async (target) => {
      const setModel = vi.fn(async (): Promise<SetModelOutcome> => {
        throw failure();
      });
      const tool = createSetModelTool({ runs: { setModel }, ...(target === "self" ? { selfRunId: "r84" } : {}) });
      const text = await message(call(tool, { model: "test/model", ...(target === "host" ? { run_id: "r84" } : {}) }));
      assertFailure(text, "set_model_unknown", "unknown", "unknown");
      expect(setModel).toHaveBeenCalledTimes(1);
    },
  );
});

describe("#84 E3 controls", () => {
  it.each(["not_running", "steer_timeout", "steer_rejected"] as const)(
    "steer keeps %s and never leaks detail",
    async (reason) => {
      const steer = vi.fn(async () => ({ ok: false as const, reason, detail: secret }));
      const text = await message(
        call(createSteerTool({ query: query({ steer }) }), { run_id: "r84", text: "original" }),
      );
      assertFailure(text, `steer_${reason}`, reason, reason === "not_running" ? "none" : "unknown");
      expect(steer).toHaveBeenCalledTimes(1);
    },
  );
  it("a known steer refusal survives a failed diagnostic read", async () => {
    const steer = vi.fn(async () => ({ ok: false as const, reason: "not_running" as const }));
    const text = await message(
      call(
        createSteerTool({
          query: query({
            steer,
            get: () => {
              throw failure();
            },
          }),
        }),
        { run_id: "r84", text: "original" },
      ),
    );
    assertFailure(text, "steer_not_running", "not_running", "none");
    expect(steer).toHaveBeenCalledTimes(1);
  });
  it("missing abort capability reports its known lack of effect, not a kill", async () => {
    const q = createQueryService({
      registry: { get: () => snapshot(), list: () => [] },
      runner: { run: async () => outcome() },
    });
    const text = await message(call(createAbortTool({ query: q }), { run_id: "r84" }));
    assertFailure(text, "abort_stop_failed", "stop_failed", "none");
    expect(text).not.toContain("escalation: L4");
    expect(text).not.toContain("Abort requested");
  });
  it("stop_failed's fallback L4 never claims a completed kill", async () => {
    const stop = vi.fn(async () => ({
      ok: false as const,
      reason: "stop_failed" as const,
      escalatedTo: "L4" as const,
    }));
    const text = await message(call(createAbortTool({ query: query({ stop }) }), { run_id: "r84" }));
    assertFailure(text, "abort_stop_failed", "stop_failed", "unknown");
    expect(text).not.toContain("escalation: L4");
    expect(text).not.toContain("Abort requested");
    expect(text).toContain("do not prove a completed kill");
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it.each(["completed", "running", "unreadable"] as const)(
    "abort throw rechecks only read state: %s",
    async (state) => {
      const stop = vi.fn(async () => {
        throw failure();
      });
      const get = vi.fn(() => {
        if (stop.mock.calls.length && state === "unreadable") throw failure();
        return snapshot(stop.mock.calls.length && state === "completed" ? "completed" : "running");
      });
      const pending = call(createAbortTool({ query: query({ stop, get }) }), { run_id: "r84" });
      if (state === "completed") {
        expect((await pending).details).toMatchObject({ alreadyTerminal: true, status: "completed" });
      } else {
        assertFailure(await message(pending), "abort_stop_failed", "stop_failed", "unknown");
      }
      expect(stop).toHaveBeenCalledTimes(1);
      expect(get.mock.calls.length).toBeGreaterThanOrEqual(2);
    },
  );
  it.each([
    "unknown_run",
    "unsupported",
    "not_started",
    "stopping",
    "already_terminal",
    "uncapped",
    "limit_reached",
    "no_headroom",
  ] as const)("extend refusal %s is stable and effect-free", async (reason) => {
    const extendTimeout = vi.fn((): ExtendOutcome => ({ ok: false, reason }));
    const text = await message(
      call(createExtendTimeoutTool({ query: query({ extendTimeout }) }), { run_id: "r84", extend_s: 10 }),
    );
    assertFailure(text, `extend_${reason}`, reason, "none");
    expect(extendTimeout).toHaveBeenCalledTimes(1);
  });
  it("a known extension refusal survives a failed snapshot read", async () => {
    let reads = 0;
    const extendTimeout = vi.fn((): ExtendOutcome => ({ ok: false, reason: "no_headroom" }));
    const q = query({
      extendTimeout,
      get: () => {
        if (++reads > 1) throw failure();
        return snapshot();
      },
    });
    const text = await message(call(createExtendTimeoutTool({ query: q }), { run_id: "r84", extend_s: 10 }));
    assertFailure(text, "extend_no_headroom", "no_headroom", "none");
    expect(extendTimeout).toHaveBeenCalledTimes(1);
  });
  it("successful extension plus failed readback exposes the known applied effect", async () => {
    let reads = 0;
    const extendTimeout = vi.fn((): ExtendOutcome => ({
      ok: true,
      runId: "r84",
      previousDeadlineAt: 1000,
      requestedMs: 1000,
      grantedMs: 1000,
      deadlineAt: 2000,
      hardDeadlineAt: 3000,
      extensionsUsed: 1,
      extensionsRemaining: 2,
      clamped: false,
      rescuedFromGrace: false,
    }));
    const q = query({
      extendTimeout,
      get: () => {
        if (++reads > 1) throw failure();
        return snapshot();
      },
    });
    const text = await message(call(createExtendTimeoutTool({ query: q }), { run_id: "r84", extend_s: 1 }));
    assertFailure(text, "extend_read_failed", "read_failed", "deadline_extended");
    expect(extendTimeout).toHaveBeenCalledTimes(1);
    expect(text).toContain("do not automatically repeat");
  });
  it("extension throwing after mutation stays unknown; no second extension", async () => {
    let deadline = 1000;
    const extendTimeout = vi.fn((): ExtendOutcome => {
      deadline += 100;
      throw failure();
    });
    const text = await message(
      call(createExtendTimeoutTool({ query: query({ extendTimeout }) }), { run_id: "r84", extend_s: 10 }),
    );
    assertFailure(text, "extend_unknown", "unknown", "unknown");
    expect(deadline).toBe(1100);
    expect(extendTimeout).toHaveBeenCalledTimes(1);
  });
});

describe("#84 E4 read failures", () => {
  it.each(["get", "list", "slots", "workflows"] as const)("list %s failure is not an empty success", async (which) => {
    const stop = vi.fn(async () => ({ ok: true as const, escalatedTo: "L2" as const }));
    const q = query({
      stop,
      ...(which === "get"
        ? {
            get: () => {
              throw failure();
            },
          }
        : {}),
      ...(which === "list"
        ? {
            list: () => {
              throw failure();
            },
          }
        : {}),
    });
    // Workflow-child projection is the list tool's get boundary.
    const workflow = {
      activity: {
        list: () => {
          if (which === "workflows") throw failure();
          return which === "get"
            ? [
                {
                  workflowId: "wf_84",
                  name: "wf",
                  startedAt: 0,
                  activeChildren: [{ callId: "c", runId: "r84", enteredAt: 0 }],
                  queuedChildren: [],
                  settledChildren: [],
                  settledTotal: 0,
                  completedTotal: 0,
                  replayTotal: 0,
                  rejectedTotal: 0,
                  stageErrorTotal: 0,
                  phases: [],
                },
              ]
            : [];
        },
      },
    };
    const tool = createListSubagentsTool({
      query: q,
      spawn: {
        slots: () => {
          if (which === "slots") throw failure();
          return { limit: 1, inUse: 0, free: 1 };
        },
      },
      workflow,
    });
    const text = await message(call(tool, {}));
    assertFailure(text, "list_subagents_read_failed", "unknown", "none");
    expect(text).not.toContain("No active subagent runs");
    expect(stop).not.toHaveBeenCalled();
  });
  it.each([false, true])("result read failure (wait=%s) does not ack or report terminal", async (wait) => {
    const ack = vi.fn();
    const q = query({
      get: () => {
        throw failure();
      },
      wait: async () => {
        throw failure();
      },
    });
    const text = await message(call(createResultTool({ query: q, notifier: { ack } }), { run_id: "r84", wait }));
    assertFailure(text, "result_read_failed", "read_failed", "none");
    expect(text).not.toContain("wait_timeout");
    expect(ack).not.toHaveBeenCalled();
  });
  it("read failure does not consume usage; later successful terminal read accounts exactly once", async () => {
    let broken = true;
    const ack = vi.fn();
    const q = query({
      get: () => {
        if (broken) throw failure();
        return snapshot("completed");
      },
    });
    const tool = createResultTool({ query: q, notifier: { ack } });
    await message(call(tool, { run_id: "r84" }));
    expect(ack).not.toHaveBeenCalled();
    broken = false;
    const first = await call(tool, { run_id: "r84" });
    const second = await call(tool, { run_id: "r84" });
    expect(first.usage?.cost?.total).toBe(0.1);
    expect(second.usage).toBeUndefined();
    expect(first.details).toMatchObject({ status: "completed" });
    expect(ack).toHaveBeenCalledTimes(2);
  });
  it("an interval progress read error rejects and clears its timer without ack", async () => {
    vi.useFakeTimers();
    const ack = vi.fn();
    let reads = 0;
    const q = query({
      get: () => {
        if (++reads > 1) throw failure();
        return snapshot();
      },
      wait: () => new Promise(() => undefined),
    });
    const tool = createResultTool({ query: q, notifier: { ack } });
    const pending = message(tool.execute("tc84", { run_id: "r84", wait: true }, undefined, vi.fn(), ctx));
    await vi.advanceTimersByTimeAsync(1000);
    assertFailure(await pending, "result_read_failed", "read_failed", "none");
    expect(ack).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("service polling read error is not converted into wait_timeout", async () => {
    const clock = new FakeClock();
    let reads = 0;
    const q = createQueryService({
      clock,
      registry: {
        get: () => {
          if (++reads > 2) throw failure();
          return snapshot();
        },
        list: () => [],
      },
      runner: { run: async () => outcome() },
    });
    const pending = message(call(createResultTool({ query: q }), { run_id: "r84", wait: true, wait_ms: 100 }));
    clock.advance(10);
    const text = await pending;
    assertFailure(text, "result_read_failed", "read_failed", "none");
    expect(text).not.toContain("wait_timeout");
  });
  it("workflow usage read failure is a failure and does not poison usage-once", async () => {
    let broken = true;
    const view = {
      workflowId: "wf_84",
      name: "wf",
      startedAt: 0,
      status: "completed" as const,
      outcome: {
        workflowId: "wf_84",
        status: "completed" as const,
        durationMs: 2,
        pendingReconcile: false,
        diag: { createdAt: 0, heartbeat: { seq: 0, observedAt: 0, stalledMs: 0 }, logLines: 0 },
        children: [{ callId: "c", runId: "r84", source: "live" as const, status: "completed" as const, durationMs: 2 }],
      },
    };
    const workflows: WorkflowQueryPort = {
      resolve: () => ({ kind: "workflow", workflowId: "wf_84" }),
      resolveLabel: () => ({ kind: "none" }),
      get: () => view,
      activity: () => undefined,
      wait: async () => ({ ok: true, view: { ...view, outcome: view.outcome } }),
      stop: async () => ({ ok: false, reason: "already_terminal", view }),
      usageOf: () => {
        if (broken) throw failure();
        return usage;
      },
    };
    const tool = createResultTool({ query: query(), workflows });
    assertFailure(await message(call(tool, { run_id: "wf_84" })), "result_read_failed", "read_failed", "none");
    broken = false;
    expect((await call(tool, { run_id: "wf_84" })).usage?.cost?.total).toBe(0.1);
    expect((await call(tool, { run_id: "wf_84" })).usage).toBeUndefined();
  });
});

// Independent-verification counterexamples: actual five-argument execute, fake ports only.
describe("#84 B1 execute boundary and safe resolver projection", () => {
  const privateFailure = () => new Error("PRIVATE_SECRET\n at internal-frame");
  const args = { description: "safe label", prompt: "safe prompt", subagent_type: "worker" };
  it.each(["top", "nested", "nested-background"] as const)("%s preparation faults never dispatch", async (form) => {
    for (const key of ["queueWhenFull", "loadGate"] as const) {
      const spawn = vi.fn(async () => ({ runId: "r84" }));
      const spawnAndWait = vi.fn(async () => outcome());
      const options = {
        spawn: { spawn, spawnAndWait },
        [key]: () => {
          throw privateFailure();
        },
      };
      const pending =
        form === "top"
          ? call(createAgentTool(options), args)
          : call(createAgentTool({ ...options, allowedTypes: ["worker"] }), {
              ...args,
              ...(form === "nested-background" ? { run_in_background: true } : {}),
            });
      const text = await message(pending);
      assertFailure(text, "agent_dispatch_failed", "unknown", "none");
      expect(text).not.toContain("PRIVATE_SECRET");
      expect(text).not.toContain("internal-frame");
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnAndWait).not.toHaveBeenCalled();
    }
  });
  it.each(["top", "nested", "nested-background"] as const)(
    "%s invocation faults are sanitized, never replayed",
    async (form) => {
      const spawn = vi.fn(async (): Promise<{ runId: string }> => {
        throw privateFailure();
      });
      const spawnAndWait = vi.fn(async (): Promise<RunOutcome> => {
        throw privateFailure();
      });
      const pending =
        form === "top"
          ? call(createAgentTool({ spawn: { spawn } }), args)
          : call(createAgentTool({ spawn: { spawn, spawnAndWait }, allowedTypes: ["worker"] }), {
              ...args,
              ...(form === "nested-background" ? { run_in_background: true } : {}),
            });
      const text = await message(pending);
      assertFailure(text, "agent_dispatch_failed", "unknown", "unknown");
      expect(text).not.toContain("PRIVATE_SECRET");
      expect(text).not.toContain("internal-frame");
      expect(form === "nested" ? spawnAndWait : spawn).toHaveBeenCalledTimes(1);
      expect(form === "nested" ? spawn : spawnAndWait).not.toHaveBeenCalled();
    },
  );
  it("top-level reload preparation is inside the same boundary", async () => {
    const spawn = vi.fn(async () => ({ runId: "r84" }));
    const text = await message(
      call(
        createAgentTool({
          spawn: { spawn },
          isReloadPending: () => {
            throw privateFailure();
          },
        }),
        args,
      ),
    );
    expect(text).toContain("effect=none");
    expect(text).not.toContain("PRIVATE_SECRET");
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each([false, true])("completed child survives display failure (slots port=%s)", async (withSlots) => {
    const spawn = vi.fn(async () => ({ runId: "unused" }));
    const spawnAndWait = vi.fn(async () => outcome());
    const spawnAndWaitWithSlots = vi.fn(async () => ({ outcome: outcome(), slots: { limit: 2, inUse: 0, free: 2 } }));
    const text = await message(
      call(
        createAgentTool({
          spawn: { spawn, spawnAndWait, ...(withSlots ? { spawnAndWaitWithSlots } : {}) },
          allowedTypes: ["worker"],
          resultMaxChars: () => {
            throw privateFailure();
          },
        }),
        args,
      ),
    );
    assertFailure(text, "agent_dispatch_failed", "unknown", "child_completed");
    expect(text).toContain("run_id: r84");
    expect(text).not.toContain("PRIVATE_SECRET");
    expect(text).not.toContain("internal-frame");
    expect(spawn).not.toHaveBeenCalled();
    expect(withSlots ? spawnAndWaitWithSlots : spawnAndWait).toHaveBeenCalledTimes(1);
    expect(withSlots ? spawnAndWait : spawnAndWaitWithSlots).not.toHaveBeenCalled();
  });
  it("a display lifecycle exception cannot erase a completed child", async () => {
    const spawnAndWait = vi.fn(async () => outcome());
    const text = await message(
      call(
        createAgentTool({
          spawn: { spawn: async () => ({ runId: "unused" }), spawnAndWait },
          allowedTypes: ["worker"],
          resultMaxChars: () => {
            requireStack({});
            return 0;
          },
        }),
        args,
      ),
    );
    assertFailure(text, "agent_dispatch_failed", "unknown", "child_completed");
    expect(text).toContain("run_id: r84");
    expect(text).not.toContain("code=no_active_session");
    expect(spawnAndWait).toHaveBeenCalledTimes(1);
  });
  it("background display failure retains the admitted run", async () => {
    const spawn = vi.fn(async () => ({
      runId: "r84",
      get label(): string {
        throw privateFailure();
      },
    }));
    const text = await message(call(createAgentTool({ spawn: { spawn } }), args));
    assertFailure(text, "agent_dispatch_failed", "unknown", "run_started");
    expect(text).toContain("run_id: r84");
    expect(text).not.toContain("PRIVATE_SECRET");
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it.each(["steer", "set-model"] as const)("%s never echoes resolver free text", async (which) => {
    for (const candidates of [
      [],
      [{ label: "safe candidate", runId: "r_candidate", status: "completed" as const, ageMinutes: 3 }],
    ]) {
      const resolveRun = vi.fn(() => ({ ok: false as const, error: privateFailure().message, candidates }));
      const steer = vi.fn(async () => ({ ok: true as const }));
      const setModel = vi.fn(async () => ({ ok: true as const, model }));
      const pending =
        which === "steer"
          ? call(createSteerTool({ query: query({ steer }), resolveRun }), { run_id: "safe", text: "safe" })
          : call(createSetModelTool({ runs: { setModel }, resolveRun }), { run_id: "safe", model: "test/model" });
      const text = await message(pending);
      expect(text).toContain("reason=target_resolution");
      expect(text).toContain("effect=none");
      expect(text).not.toContain("PRIVATE_SECRET");
      expect(text).not.toContain("internal-frame");
      expect(text).toContain(
        candidates.length ? "safe candidate → r_candidate (completed, 3m ago)" : "Candidates: [none]",
      );
      expect(resolveRun).toHaveBeenCalledTimes(1);
      expect(steer).not.toHaveBeenCalled();
      expect(setModel).not.toHaveBeenCalled();
    }
  });
});

describe("#84 B2 authoritative result precedes observation", () => {
  const noSession = () => {
    requireStack({});
    throw new Error("unreachable");
  };
  it.each(["lifecycle", "ordinary"] as const)(
    "successful model switch ignores optional label %s failure",
    async (kind) => {
      const setModel = vi.fn(async () => ({ ok: true as const, model, thinking: "high" }));
      const labelOf = vi.fn(() => {
        if (kind === "lifecycle") noSession();
        throw failure();
      });
      const result = await call(createSetModelTool({ runs: { setModel }, labelOf }), {
        run_id: "r84",
        model: "test/model",
      });
      expect(result.details).toMatchObject({ ok: true, target: "r84", model, thinking: "high" });
      expect(setModel).toHaveBeenCalledTimes(1);
      expect(labelOf).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["lifecycle", "ordinary"] as const)(
    "unsupported model switch survives optional label %s failure",
    async (kind) => {
      const setModel = vi.fn(async (): Promise<SetModelOutcome> => ({ ok: false, reason: "unsupported" }));
      const labelOf = vi.fn(() => {
        if (kind === "lifecycle") noSession();
        throw failure();
      });
      const text = await message(
        call(createSetModelTool({ runs: { setModel }, labelOf }), { run_id: "r84", model: "test/model" }),
      );
      assertFailure(text, "set_model_unsupported", "unsupported", "none");
      expect(setModel).toHaveBeenCalledTimes(1);
      expect(labelOf).not.toHaveBeenCalled();
    },
  );
  const grant = {
    ok: true as const,
    requestedMs: 1000,
    grantedMs: 1000,
    previousDeadlineAt: 1000,
    deadlineAt: 2000,
    hardDeadlineAt: 3000,
    extensionsUsed: 1,
    extensionsRemaining: 2,
    clamped: false,
    rescuedFromGrace: false,
  };
  function workflows(extend: NonNullable<WorkflowQueryPort["extend"]>): WorkflowQueryPort {
    return {
      resolve: () => ({ kind: "workflow", workflowId: "wf_84" }),
      resolveLabel: () => ({ kind: "none" }),
      get: () => undefined,
      activity: () => undefined,
      wait: async () => ({ ok: false, reason: "unknown_workflow" }),
      stop: async () => ({ ok: false, reason: "unknown_workflow" }),
      extend,
    };
  }
  it("extension readback lifecycle failure cannot overwrite the applied effect", async () => {
    const extendTimeout = vi.fn(() => ({ ...grant, runId: "r84" }));
    const get = vi.fn(() => {
      if (extendTimeout.mock.calls.length) noSession();
      return snapshot();
    });
    const text = await message(
      call(createExtendTimeoutTool({ query: query({ extendTimeout, get }) }), { run_id: "r84", extend_s: 1 }),
    );
    assertFailure(text, "extend_read_failed", "read_failed", "deadline_extended");
    expect(text).not.toContain("code=no_active_session");
    expect(extendTimeout).toHaveBeenCalledTimes(1);
  });
  it.each(["run", "workflow"] as const)("%s clock failure preserves success and refusal facts", async (target) => {
    for (const kind of ["lifecycle", "ordinary"] as const) {
      for (const accepted of [true, false]) {
        const extendTimeout = vi.fn((): ExtendOutcome =>
          accepted ? { ...grant, runId: "r84" } : { ok: false, reason: "unsupported" },
        );
        const extend = vi.fn(() =>
          accepted ? { ...grant, workflowId: "wf_84" } : { ok: false as const, reason: "unsupported" as const },
        );
        const now = vi.fn((): number => {
          if (kind === "lifecycle") noSession();
          throw failure();
        });
        const tool = createExtendTimeoutTool({
          query: query({ extendTimeout }),
          now,
          ...(target === "workflow" ? { workflows: workflows(extend) } : {}),
        });
        const text = await message(call(tool, { run_id: target === "workflow" ? "wf_84" : "r84", extend_s: 1 }));
        assertFailure(
          text,
          accepted ? "extend_read_failed" : "extend_unsupported",
          accepted ? "read_failed" : "unsupported",
          accepted ? "deadline_extended" : "none",
        );
        expect(text).not.toContain("code=no_active_session");
        expect(now).toHaveBeenCalledTimes(1);
        expect(target === "workflow" ? extend : extendTimeout).toHaveBeenCalledTimes(1);
        expect(target === "workflow" ? extendTimeout : extend).not.toHaveBeenCalled();
      }
    }
  });
});
