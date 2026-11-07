import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET, MAX_DEADLINE_SPAN_MS } from "../../src/core/deadline.js";
import { MemoryOutboxStore, MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, DeadlineBudget, RunSnapshot, SpawnRequest } from "../../src/core/types.js";
import { loadSettings } from "../../src/config/settings.js";
import { createNotifier, type PersistedDelivery } from "../../src/delivery/notifier.js";
import { RuntimeRunner, type ResolvedSpawnRequest } from "../../src/runtime/runner.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import { threadThroughRequestFields } from "../../src/service/request-threading.js";
import { createAgentTool, type AgentToolParams, type NestedAgentToolParams } from "../../src/tools/agent-tool.js";

const worker: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
let dir: string;
let captured: { request: ResolvedSpawnRequest; budget: DeadlineBudget }[];

function stack(
  budget: Partial<DeadlineBudget> = {},
  typeBudget?: Partial<DeadlineBudget>,
  extensionsEnabled = true,
  pending = false,
) {
  const clock = new FakeClock();
  const file = join(dir, "session.jsonl");
  writeFileSync(file, "{}\n");
  let releasePrompt!: () => void;
  const heldPrompt = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  const handle: SessionHandle = {
    sessionId: "s1",
    sessionFile: file,
    prompt: () => (pending ? heldPrompt : Promise.resolve()),
    steer: async () => undefined,
    requestAbort: async () => {
      releasePrompt();
    },
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "done",
    getUsage: () => undefined,
  };
  const driver: SessionDriver = {
    create: async () => handle,
    resume: async () => handle,
    bind: async () => undefined,
    onLateArrival: () => undefined,
  };
  const hostBudget = { ...DEFAULT_BUDGET, ...budget };
  const config = { ...worker, ...(typeBudget ? { budgetOverride: typeBudget } : {}) };
  const pool = new SingleSlotPool(clock, 4);
  const store = new MemoryRunStore();
  const snapshots: RunSnapshot[] = [];
  const notifier = createNotifier({
    store: new MemoryOutboxStore<PersistedDelivery>(),
    sender: () => undefined,
    cancelBuffered: () => undefined,
    clock,
  });
  const runner = createRuntimeRunnerAdapter({
    clock,
    driver,
    pool,
    store,
    reaper: new EscalatingReaper(clock),
    notifier,
    watchdog: new EventWatchdog({ clock, budget: hostBudget, getState: () => undefined, dispatch: () => undefined }),
  });
  const svc = createSpawnService({
    types: {
      configHashOf: () => "agent62-fixture",
      get: () => config,
      list: () => [config],
      reload: async () => ({ types: [config], errors: [] }),
    },
    pool,
    runner,
    budget: hostBudget,
    now: () => clock.now(),
    extensionsEnabled,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  return { svc, hostBudget, snapshots, clock, releasePrompt };
}
async function settle() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}
async function dispatch(s: ReturnType<typeof stack>, params: Partial<NestedAgentToolParams> = {}, nested = false) {
  const tool = nested
    ? createAgentTool({ spawn: s.svc, allowedTypes: ["worker"], parentRunId: "parent", forceSlotless: true })
    : createAgentTool({ spawn: s.svc });
  const result = await tool.execute(
    "tc",
    { description: "floor", prompt: "p", subagent_type: "worker", ...params } as AgentToolParams,
    undefined,
    undefined,
    {} as never,
  );
  await settle();
  expect(result.content.some((c) => c.type === "text" && c.text.includes("config error"))).toBe(false);
  expect(captured.at(-1)).toBeDefined();
  return captured.at(-1)!;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-min-total-"));
  captured = [];
  const original = RuntimeRunner.prototype.run;
  vi.spyOn(RuntimeRunner.prototype, "run").mockImplementation(function (this: RuntimeRunner, request, budget) {
    captured.push({ request, budget });
    return original.call(this, request, budget);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("#62 real Agent tool → admission → runtime budget", () => {
  it.each([1, 1799, 1800, 3600])("explicit %is is floored after all merges", async (timeout_s) => {
    const s = stack({}, { totalMs: 120_000, minTotalMs: 0 });
    const { request, budget } = await dispatch(s, { timeout_s });
    expect(budget.totalMs).toBe(Math.max(timeout_s * 1000, 1_800_000));
    expect(budget.totalGraceMs).toBe(600_000);
    expect(request.timeoutPolicy).toBe("extendable");
    expect(request).not.toHaveProperty("agentToolDispatch");
    expect(s.snapshots.at(-1)?.diag).not.toHaveProperty("agentToolDispatch");
  });
  it.each([false, true])(
    "nested blocking/background=%s uses the same floor and actual grace600",
    async (run_in_background) => {
      const got = await dispatch(stack(), { timeout_s: 1, run_in_background }, true);
      expect(got.budget.totalMs).toBe(1_800_000);
      expect(got.budget.totalGraceMs).toBe(600_000);
      expect(got.request.slotless).toBe(true);
    },
  );
  it("a real nested runtime enters the default 600s grace, despite the frozen nested text", async () => {
    // Isolate the total clock; the production phase budgets are unchanged by the floor.
    const s = stack({ firstEventMs: 3_600_000 }, undefined, true, true);
    await dispatch(s, { timeout_s: 1, run_in_background: true }, true);
    s.clock.advance(1_800_000);
    await settle();
    expect(s.snapshots.at(-1)?.deadlines.graceUntil).toBe(2_400_000);
    s.releasePrompt();
    await settle();
    expect(s.snapshots.at(-1)?.status).toBe("completed");
  });
  it("omitted timeout still floors a short type default", async () => {
    const got = await dispatch(stack({}, { totalMs: 120_000, minTotalMs: 0 }));
    expect(got.budget.totalMs).toBe(1_800_000);
  });
  it("keeps a personal totalS7200 when timeout is omitted", async () => {
    const got = await dispatch(stack(loadSettings({ budget: { totalS: 7200 } }).budget));
    expect(got.budget.totalMs).toBe(7_200_000);
  });
  it.each([
    [0, 1000],
    [30_000, 30_000],
  ])("host floor %s can lower/disable the default", async (minTotalMs, expected) => {
    const got = await dispatch(stack({ minTotalMs }), { timeout_s: 1 });
    expect(got.budget.totalMs).toBe(expected);
  });
  it("a host live edit affects only newly admitted runs, not existing budgets", async () => {
    const s = stack();
    const first = await dispatch(s, { timeout_s: 1 });
    s.hostBudget.minTotalMs = 20_000;
    const second = await dispatch(s, { timeout_s: 1 });
    expect(first.budget.totalMs).toBe(1_800_000);
    expect(second.budget.totalMs).toBe(20_000);
  });
  it("floors a fixed-policy resume without granting it grace or extensions", async () => {
    const s = stack();
    const original = await s.svc.spawn({ type: "worker", prompt: "p", budgetOverride: { totalMs: 1000 } });
    if ("error" in original) throw Error(original.error.message);
    await settle();
    const got = await dispatch(s, { resume: original.runId });
    expect(got.budget.totalMs).toBe(1_800_000);
    expect(got.request.timeoutPolicy).toBe("fixed");
    expect(got.budget.maxTotalFactor).toBe(1);
    const snap = s.snapshots.at(-1)!;
    expect(snap.deadlines.hardDeadlineAt).toBe(snap.deadlines.deadlineAt);
  });
  it("extend.enabled=false preserves the policy kill switch after flooring", async () => {
    const got = await dispatch(stack({}, undefined, false), { timeout_s: 1 });
    expect(got.budget.totalMs).toBe(1_800_000);
    expect(got.budget.maxExtensions).toBe(0);
  });
  it("an absolute deadline remains earlier than the Agent minimum", async () => {
    const s = stack();
    const port = { spawn: (req: SpawnRequest) => s.svc.spawn({ ...req, deadlineAt: 3000 }) };
    await createAgentTool({ spawn: port }).execute(
      "tc",
      { description: "cap", prompt: "p", subagent_type: "worker", timeout_s: 1 },
      undefined,
      undefined,
      {} as never,
    );
    await settle();
    expect(captured[0]!.budget.totalMs).toBe(1_800_000);
    expect(s.snapshots.at(-1)?.deadlines.deadlineAt).toBe(3000);
    expect(s.snapshots.at(-1)?.deadlines.hardDeadlineAt).toBe(3000);
  });
});

describe("#62 programmatic exclusions and hostile budget input", () => {
  it.each([undefined, "fixed", "extendable"] as const)(
    "non-Agent %s is not floored even with both reject flags",
    async (timeoutPolicy) => {
      const s = stack();
      await s.svc.spawnAndWait({
        type: "worker",
        prompt: "p",
        poolFullPolicy: "reject",
        loadPolicy: "reject",
        budgetOverride: { totalMs: 1000 },
        ...(timeoutPolicy ? { timeoutPolicy } : {}),
      });
      expect(captured.at(-1)?.budget.totalMs).toBe(1000);
    },
  );
  it("type/request floor values cannot lower the host floor", async () => {
    const s = stack({}, { minTotalMs: 0, totalMs: 120_000 });
    await s.svc.spawnAndWait({
      type: "worker",
      prompt: "p",
      agentToolDispatch: true,
      budgetOverride: { totalMs: 1000, minTotalMs: 0 },
    });
    expect(captured.at(-1)?.budget.totalMs).toBe(1_800_000);
  });
  it.each([NaN, Infinity, -Infinity, -1])("invalid host floor %s cannot poison a bounded total", async (minTotalMs) => {
    const got = await dispatch(stack({ minTotalMs }), { timeout_s: 1 });
    expect(got.budget.totalMs).toBe(1_800_000);
    expect(Number.isFinite(got.budget.totalMs)).toBe(true);
  });
  it("huge finite host floors use the existing span clamp", async () => {
    const got = await dispatch(stack({ minTotalMs: Number.MAX_VALUE }), { timeout_s: 1 });
    expect(got.budget.totalMs).toBe(MAX_DEADLINE_SPAN_MS);
  });
  it("the marker is explicitly excluded from request threading", () => {
    expect(threadThroughRequestFields({ type: "worker", prompt: "p", agentToolDispatch: true })).not.toHaveProperty(
      "agentToolDispatch",
    );
  });
});
