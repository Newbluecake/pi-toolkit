import { afterEach, describe, expect, it, vi } from "vitest";
import { createJevClient } from "../../../src/memory/jev/client.js";
import {
  DEFAULT_JEV_FAST_PATH,
  type ClassifierRegistryLike,
  type ClassifyContext,
  type ClassifyResult,
  type ControlledClassifyTransport,
  type JevConfig,
  type JevRequest,
} from "../../../src/memory/jev/contracts.js";
import { clearHealthTable } from "../../../src/memory/jev/health.js";

const ids = ["test/a", "test/b"];
const question = { type: "bool" as const, instructions: "x", criteria: { true: "t", false: "f" } };
function config(overrides: Partial<JevConfig> = {}): JevConfig {
  return {
    classifiers: [ids[0]!],
    proxy: "",
    childSessions: false,
    recall: { threshold: 0.6, maxEntries: 3, maxBytes: 4096, waitMs: 2000 },
    reviewIntervalDays: 7,
    maxCostUsd: 1000,
    maxCalls: 1000,
    fastPath: DEFAULT_JEV_FAST_PATH,
    predict: {
      enabled: false,
      childSessions: false,
      maxEntries: 3,
      maxBytes: 4096,
      cooldownMs: 0,
      hintU: false,
      cacheTtlMin: 10,
      model: {
        enabled: false,
        models: [],
        threshold: 0.5,
        waitMs: 0,
        requestBudgetMs: 4000,
        maxCallsPerDay: 1,
        maxUsdPerDay: 0,
      },
    },
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const result = (cost?: number, stopReason: ClassifyResult["stopReason"] = "stop"): ClassifyResult => ({
  stopReason,
  answers: { q: { type: "bool", probability: 0.9 } },
  provider: "test",
  model: "a",
  ...(cost === undefined ? {} : { usage: { input: 1, cost: { total: cost } } }),
});
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** Local controlled transport, deliberately NOT a stock-SDK adapter. Its wire
 * carries enforceable token limits. One byte = one token in this local protocol;
 * the local classifier checks that bound before accepting the input. Production
 * System One/Decisions do not implement this protocol or offer these guarantees. */
function harness(
  options: {
    enabled?: boolean;
    transport?: boolean;
    config?: Partial<JevConfig>;
    prepare?: (id: string, context: ClassifyContext) => { input: number; output: number; price: number } | undefined;
    respond?: (
      index: number,
      id: string,
      context: ClassifyContext,
      signal?: AbortSignal,
    ) => Promise<ClassifyResult> | ClassifyResult;
  } = {},
) {
  const calls: { id: string; context: ClassifyContext; signal: AbortSignal | undefined }[] = [];
  const wire: { max_input_tokens: number; max_output_tokens: number; context: ClassifyContext }[] = [];
  const registry: ClassifierRegistryLike = {
    getAvailableOfType: async () => ids.map((id) => ({ provider: "test", id: id.split("/")[1]! })),
    getModelOfType: (_t, provider, id) => ({ provider, id }),
    classify: (model, context, opts) => {
      const m = model as { provider: string; id: string; limits?: { input: number; output: number } };
      if (m.limits !== undefined && Buffer.byteLength(JSON.stringify(context)) > m.limits.input)
        throw new Error("local input token bound rejected");
      const id = `${m.provider}/${m.id}`;
      calls.push({ id, context, signal: opts?.signal });
      return Promise.resolve(options.respond?.(calls.length - 1, id, context, opts?.signal) ?? result(0.1)).then(
        (value) => {
          if (m.limits !== undefined && Buffer.byteLength(JSON.stringify(value.answers)) > m.limits.output)
            return {
              ...value,
              stopReason: "error" as const,
              answers: {},
              errorMessage: "local output token bound enforced",
            };
          return value;
        },
      );
    },
  };
  const transport: ControlledClassifyTransport = {
    prepare(input) {
      const bounds =
        options.prepare === undefined
          ? { input: 1000, output: 1000, price: 100 }
          : options.prepare(input.requestChainId, input.context);
      if (bounds === undefined) return undefined;
      return {
        adapterId: "local-bounded-v1",
        chainVersion: "1",
        bounds: {
          maxInputTokens: bounds.input,
          maxOutputTokens: bounds.output,
          priceUsdPerMillion: { input: bounds.price, output: bounds.price },
        },
        dispatch(opts) {
          wire.push({ max_input_tokens: bounds.input, max_output_tokens: bounds.output, context: input.context });
          // No retry/abort race here: original classifier promise reaches client.
          return registry.classify!({ ...input.model, limits: bounds }, input.context, opts);
        },
        resolveRoute: () => undefined,
      };
    },
  };
  const client = createJevClient({
    config: config(options.config),
    isChild: false,
    now: () => Date.now(),
    p50: { enabled: options.enabled ?? true, ...(options.transport === false ? {} : { transport }) },
  });
  const ask = (overrides: Partial<JevRequest> = {}) =>
    client.ask({
      duty: "recall",
      registry,
      state: { request: "bounded" },
      questions: { q: question },
      budgetMs: 2000,
      mode: "sync",
      ...overrides,
    });
  return { client, ask, calls, wire, registry };
}
afterEach(() => {
  clearHealthTable();
  vi.useRealTimers();
});

describe("P50 controlled classify budget kernel — real semaphore", () => {
  it.each(["sync", "background"] as const)(
    "%s: active cap, exactly four queued, no cross-channel borrowing",
    async (mode) => {
      vi.useFakeTimers();
      const pending = deferred<ClassifyResult>();
      const h = harness({ respond: () => pending.promise });
      const active = mode === "sync" ? 3 : 4;
      const tasks = Array.from({ length: active + 4 }, () => h.ask({ mode }));
      await flush();
      expect(h.calls).toHaveLength(active);
      expect(h.client.usage().budget?.queued[mode]).toBe(4);
      expect(await h.ask({ mode })).toMatchObject({ ok: false, reason: "budget" });
      expect(h.calls).toHaveLength(active); // other channel still has empty slots
      pending.resolve(result(0.1));
      await Promise.all(tasks);
      expect(h.calls).toHaveLength(active + 4);
      expect(h.client.usage()).toMatchObject({
        calls: active + 4,
        budget: {
          outstanding: 0,
          zombies: 0,
          reservedCostUsd: 0,
          reservedCalls: 0,
          queued: { sync: 0, background: 0 },
        },
      });
    },
  );

  it("both channel caps coexist on the same ledger; all calls counted at dispatch", async () => {
    vi.useFakeTimers();
    const pending = deferred<ClassifyResult>();
    const h = harness({ respond: () => pending.promise });
    const sync = Array.from({ length: 7 }, () => h.ask());
    const background = Array.from({ length: 8 }, () => h.ask({ mode: "background" }));
    await flush();
    expect(h.calls).toHaveLength(7);
    expect(h.client.usage()).toMatchObject({
      calls: 7,
      budget: { outstanding: 7, queued: { sync: 4, background: 4 } },
    });
    pending.resolve(result(0.1));
    await Promise.all([...sync, ...background]);
    expect(h.client.usage().calls).toBe(15);
  });

  it("timeout retains outstanding; queued->zombie and same-request failover dispatch zero; late usage adjusts once", async () => {
    vi.useFakeTimers();
    const pending = deferred<ClassifyResult>();
    const h = harness({ config: { classifiers: ids }, respond: () => pending.promise });
    const tasks = Array.from({ length: 7 }, () => h.ask());
    await flush();
    expect(h.client.usage().calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1000);
    const outcomes = await Promise.all(tasks);
    expect(outcomes.every((o) => !o.ok && o.reason === "budget")).toBe(true);
    expect(h.calls.map((c) => c.id)).toEqual([ids[0], ids[0], ids[0]]);
    expect(h.client.usage().costUsd).toBeCloseTo(0.6);
    expect(h.client.usage()).toMatchObject({
      calls: 3,
      budget: { outstanding: 3, zombies: 3, reservedCostUsd: 0, costSource: "reserve" },
    });
    expect(await h.ask()).toMatchObject({ ok: false, reason: "budget" });
    expect(await h.ask({ mode: "background" })).toMatchObject({ ok: false, reason: "budget" });
    pending.resolve(result(0.05));
    await flush();
    expect(h.client.usage().costUsd).toBeCloseTo(0.15);
    expect(h.client.usage().budget).toMatchObject({ outstanding: 0, zombies: 0, costSource: "usage" });
    expect(h.client.usage().budget?.adjustmentUsd).toBeCloseTo(-0.45);
    const settled = h.client.usage();
    await flush();
    expect(h.client.usage()).toEqual(settled);
    expect((await h.ask()).ok).toBe(true);
    expect(h.client.usage().calls).toBe(4);
  });

  it("timeout then late over-reservation keeps FULL actual fees and latches admission closed", async () => {
    vi.useFakeTimers();
    const pending = deferred<ClassifyResult>();
    const h = harness({ config: { classifiers: ids }, respond: () => pending.promise });
    const outcome = h.ask();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
    expect(h.client.usage().costUsd).toBeCloseTo(0.2);
    pending.resolve(result(2));
    await flush();
    expect(h.client.usage()).toMatchObject({
      costUsd: 2,
      calls: 1,
      budget: { outstanding: 0, zombies: 0, exhausted: true, costSource: "usage" },
    });
    expect(h.client.usage().budget?.overReservedUsd).toBeCloseTo(1.8);
    expect(h.client.usage().budget?.adjustmentUsd).toBeCloseTo(1.8);
    expect(await h.ask()).toMatchObject({ ok: false, reason: "budget" });
    expect(h.calls).toHaveLength(1);
  });

  it("queued->overrun cancels all unused reservations without another dispatch", async () => {
    vi.useFakeTimers();
    const pending = deferred<ClassifyResult>();
    const h = harness({ respond: () => pending.promise });
    const tasks = Array.from({ length: 7 }, () => h.ask());
    await flush();
    pending.resolve(result(1));
    const outcomes = await Promise.all(tasks);
    expect(outcomes.slice(0, 3).every((o) => o.ok)).toBe(true);
    expect(outcomes.slice(3).every((o) => !o.ok && o.reason === "budget")).toBe(true);
    expect(h.calls).toHaveLength(3);
    expect(h.client.usage()).toMatchObject({
      costUsd: 3,
      calls: 3,
      budget: { reservedCostUsd: 0, reservedCalls: 0, outstanding: 0, exhausted: true },
    });
    expect(h.client.usage().budget?.overReservedUsd).toBeCloseTo(2.4);
  });

  it("settled error usage is billed and overrun blocks failover and context halves", async () => {
    for (const message of ["500 retry", "maximum context exceeded"]) {
      clearHealthTable();
      const h = harness({
        config: { classifiers: ids },
        respond: () => ({ ...result(1, "error"), errorMessage: message }),
      });
      expect(await h.ask({ questions: { q: question, q2: question } })).toMatchObject({ ok: false, reason: "budget" });
      expect(h.calls).toHaveLength(1);
      expect(h.client.usage()).toMatchObject({ calls: 1, costUsd: 1, budget: { exhausted: true } });
    }
  });

  it("known failover error usage and both context halves use the same reservation ledger", async () => {
    const h = harness({
      config: { classifiers: ids },
      respond: (i, id, ctx) => {
        if (i === 0) return { ...result(0.02, "error"), errorMessage: "451 blocked" };
        if (i === 1) return { ...result(0.03, "error"), errorMessage: "maximum context exceeded" };
        return {
          ...result(0.04),
          provider: "test",
          model: id.split("/")[1]!,
          answers: Object.fromEntries(Object.keys(ctx.questions).map((k) => [k, { type: "bool", probability: 0.8 }])),
        };
      },
    });
    const outcome = await h.ask({ questions: { q: question, q2: question } });
    expect(outcome).toMatchObject({ ok: true, missing: [], costUsd: 0.13 });
    expect(h.calls.map((c) => c.id)).toEqual([ids[0], ids[1], ids[1], ids[1]]);
    expect(h.client.usage()).toMatchObject({
      calls: 4,
      costUsd: 0.13,
      budget: { reservedCostUsd: 0, reservedCalls: 0, outstanding: 0, costSource: "usage" },
    });
  });

  it.each([undefined, NaN, -1, Infinity])(
    "unusable actual usage %s stays reserve-estimated, including rejection",
    async (cost) => {
      const h = harness({ respond: () => result(cost) });
      expect(await h.ask()).toMatchObject({ ok: true, costUsd: 0.2 });
      expect(h.client.usage()).toMatchObject({ costUsd: 0.2, calls: 1, budget: { costSource: "reserve" } });
    },
  );

  it("late rejection releases outstanding, retains the reserve estimate, and permits future admission", async () => {
    vi.useFakeTimers();
    const pending = deferred<ClassifyResult>();
    const h = harness({ respond: () => pending.promise });
    const task = h.ask();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await task;
    expect(h.client.usage().budget?.zombies).toBe(1);
    pending.reject(new Error("provider disconnected"));
    await flush();
    expect(h.client.usage()).toMatchObject({
      costUsd: 0.2,
      calls: 1,
      budget: { outstanding: 0, zombies: 0, costSource: "reserve", exhausted: false },
    });
  });

  it("queued abort releases reservation immediately without waiting for provider timeout", async () => {
    vi.useFakeTimers();
    const pending = deferred<ClassifyResult>();
    const h = harness({ respond: () => pending.promise });
    const active = Array.from({ length: 3 }, () => h.ask());
    await flush();
    const abort = new AbortController();
    const queued = h.ask({ signal: abort.signal });
    await flush();
    expect(h.client.usage().budget?.queued.sync).toBe(1);
    abort.abort();
    expect(await queued).toMatchObject({ ok: false, reason: "aborted" });
    expect(h.client.usage().budget?.queued.sync).toBe(0);
    expect(h.calls).toHaveLength(3);
    pending.resolve(result(0.1));
    await Promise.all(active);
    expect(h.client.usage().budget?.reservedCalls).toBe(0);
  });

  it("abortBackground revokes queued/active background but not live sync", async () => {
    vi.useFakeTimers();
    const pending = deferred<ClassifyResult>();
    const h = harness({ respond: () => pending.promise });
    const bg = Array.from({ length: 8 }, () => h.ask({ mode: "background" }));
    const sync = h.ask();
    await flush();
    h.client.abortBackground();
    expect((await Promise.all(bg)).every((o) => !o.ok && o.reason === "aborted")).toBe(true);
    expect(h.calls).toHaveLength(5);
    expect(h.client.usage().budget).toMatchObject({ outstanding: 5, zombies: 4, queued: { background: 0 } });
    pending.resolve(result(0.1));
    expect((await sync).ok).toBe(true);
    expect(h.client.usage().budget).toMatchObject({ outstanding: 0, zombies: 0 });
  });

  it("dispose revokes queued and running, late settle only accounts, never publishes status or revives", async () => {
    vi.useFakeTimers();
    const pending = deferred<ClassifyResult>();
    const h = harness({ respond: () => pending.promise });
    const status = vi.fn();
    h.client.onStatusChange(status);
    const tasks = Array.from({ length: 7 }, () => h.ask());
    await flush();
    h.client.dispose();
    h.client.dispose();
    expect((await Promise.all(tasks)).every((o) => !o.ok && o.reason === "aborted")).toBe(true);
    expect(h.client.usage()).toMatchObject({
      calls: 3,
      budget: { outstanding: 3, zombies: 3, reservedCostUsd: 0, reservedCalls: 0, disposed: true },
    });
    pending.resolve(result(0.1));
    await flush();
    expect(h.client.usage().costUsd).toBeCloseTo(0.3);
    expect(status).not.toHaveBeenCalled();
    expect(await h.ask()).toMatchObject({ ok: false, reason: "aborted" });
    expect(h.calls).toHaveLength(3);
  });

  it("synchronous host callback before dispatch cannot bypass disposal", async () => {
    let dispose = () => {};
    const h = harness();
    const guarded = createJevClient({
      config: config({ proxy: "local" }),
      isChild: false,
      now: Date.now,
      p50: {
        enabled: true,
        transport: {
          prepare: (input) => ({
            adapterId: "x",
            chainVersion: "1",
            bounds: { maxInputTokens: 1, maxOutputTokens: 1, priceUsdPerMillion: { input: 1, output: 1 } },
            dispatch: (opts) => h.registry.classify!(input.model, input.context, opts),
            resolveRoute: () => undefined,
          }),
        },
      },
      makeFetch: () => {
        dispose();
        return undefined;
      },
    });
    dispose = () => guarded.dispose();
    const outcome = await guarded.ask({
      duty: "recall",
      registry: h.registry,
      state: {},
      questions: { q: question },
      mode: "sync",
      budgetMs: 1000,
    });
    expect(outcome).toMatchObject({ ok: false, reason: "aborted" });
    expect(h.calls).toHaveLength(0);
    expect(guarded.usage().calls).toBe(0);
  });

  it("reservation identity/release are idempotent; named job balance cannot be reset by changing cap", async () => {
    const h = harness();
    const token = h.client.reserveClientAttempt({ mode: "sync", maxProviderCalls: 2, worstCostUsd: 0.4 });
    expect(token).toBeDefined();
    h.client.releaseClientAttempt({ ...token! });
    expect(h.client.usage().budget?.reservedCostUsd).toBeCloseTo(0.4);
    h.client.releaseClientAttempt(token!);
    h.client.settleClientAttempt(token!);
    expect(h.client.usage().budget).toMatchObject({ reservedCostUsd: 0, reservedCalls: 0 });
    expect((await h.ask({ jobId: "j", jobCostCapUsd: 0.4 })).ok).toBe(true);
    expect(await h.ask({ jobId: "j", jobCostCapUsd: 0.4 })).toMatchObject({ ok: false, reason: "budget" });
    expect(await h.ask({ jobId: "j", jobCostCapUsd: 10 })).toMatchObject({ ok: false, reason: "budget" });
    expect(await h.ask({ jobId: "no-cap" })).toMatchObject({ ok: false, reason: "budget" });
    expect(await h.ask({ jobId: "zero", jobCostCapUsd: 0 })).toMatchObject({ ok: false, reason: "budget" });
    expect(h.calls).toHaveLength(1);
  });

  it("calls/fees are reserved for the entire failover + split plan before dispatch", async () => {
    const byCalls = harness({ config: { classifiers: ids, maxCalls: 3 } });
    expect(await byCalls.ask()).toMatchObject({ ok: false, reason: "budget" }); // four possible dispatches
    expect(byCalls.calls).toHaveLength(0);
    const byCost = harness({ config: { maxCostUsd: 0.39 } });
    expect(await byCost.ask()).toMatchObject({ ok: false, reason: "budget" });
    expect(byCost.calls).toHaveLength(0);
  });

  it("a verified local wire includes both bounds and the exact immutable outbound DTO", async () => {
    const h = harness();
    const state = { request: "before" };
    const task = h.ask({ state });
    state.request = "after";
    expect((await task).ok).toBe(true);
    expect(h.wire).toEqual([
      {
        max_input_tokens: 1000,
        max_output_tokens: 1000,
        context: { state: { request: "before" }, questions: { q: question } },
      },
    ]);
    expect(Object.isFrozen(h.wire[0]?.context.state)).toBe(true);
    expect(h.calls[0]?.context).toBe(h.wire[0]?.context);
  });

  it.each([
    undefined,
    { input: 1000, output: 0, price: 1 },
    { input: 0, output: 1000, price: 1 },
    { input: 1000, output: NaN, price: 1 },
    { input: 1000, output: 1000, price: NaN },
    { input: 1000, output: 1000, price: -1 },
    { input: Infinity, output: 1000, price: 1 },
  ])("missing/non-executable bounds or price %j means zero dispatch, never zero-cost bypass", async (bound) => {
    const h = harness({ prepare: () => bound });
    expect(await h.ask()).toMatchObject({ ok: false, reason: "unavailable" });
    expect(h.calls).toHaveLength(0);
    expect(h.client.usage().calls).toBe(0);
  });

  it("local controlled transport enforces its output bound, not just a decorative option", async () => {
    const h = harness({ prepare: () => ({ input: 1000, output: 1, price: 100 }) });
    expect(await h.ask()).toMatchObject({
      ok: false,
      reason: "all-failed",
      detail: expect.stringContaining("output token bound enforced"),
    });
    expect(h.calls).toHaveLength(1);
    expect(h.wire[0]?.max_output_tokens).toBe(1);
  });

  it("request deadline bounds a never-settling availability probe without provider dispatch", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.registry.getAvailableOfType = () => new Promise(() => {});
    const task = h.ask({ budgetMs: 100 });
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(await task).toMatchObject({ ok: false, reason: "timeout" });
    expect(h.client.usage()).toMatchObject({
      calls: 0,
      costUsd: 0,
      budget: { reservedCostUsd: 0, reservedCalls: 0, outstanding: 0 },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("queued deadline releases unused reservation while live provider slots remain occupied", async () => {
    vi.useFakeTimers();
    const pending = deferred<ClassifyResult>();
    const h = harness({ respond: () => pending.promise });
    const active = Array.from({ length: 3 }, () => h.ask());
    await flush();
    const task = h.ask({ budgetMs: 100 });
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(await task).toMatchObject({ ok: false, reason: "timeout" });
    expect(h.calls).toHaveLength(3);
    expect(h.client.usage().budget).toMatchObject({ outstanding: 3, zombies: 0, queued: { sync: 0 } });
    pending.resolve(result(0.1));
    await Promise.all(active);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("all normal/abort/dispose timers are cleaned, including segmented year-long budgets", async () => {
    vi.useFakeTimers();
    const pending = deferred<ClassifyResult>();
    const h = harness({ respond: () => pending.promise });
    const task = h.ask({ budgetMs: Infinity });
    await flush();
    await vi.advanceTimersByTimeAsync(2);
    expect(h.client.usage()).toMatchObject({ calls: 1, budget: { outstanding: 1, zombies: 0 } });
    h.client.dispose();
    expect(await task).toMatchObject({ ok: false, reason: "aborted" });
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve(result(0.1));
    await flush();
    expect(h.client.usage().budget).toMatchObject({ outstanding: 0, zombies: 0 });
  });

  it("explicitly on without controlled transport is unavailable, even for a tiny input", async () => {
    const h = harness({ transport: false });
    expect(await h.ask({ state: { x: "a" } })).toMatchObject({ ok: false, reason: "unavailable" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("Jev on / P50 off legacy differential baseline", () => {
  it.each(["sync", "background"] as const)("%s queue remains unbounded and usage shape unchanged", async (mode) => {
    vi.useFakeTimers();
    const pending = deferred<ClassifyResult>();
    const h = harness({ enabled: false, respond: () => pending.promise });
    const tasks = Array.from({ length: 14 }, () => h.ask({ mode }));
    await flush();
    expect(h.calls).toHaveLength(mode === "sync" ? 3 : 4);
    expect(h.client.usage()).toEqual({ calls: 0, costUsd: 0 });
    pending.resolve(result(0.1));
    await Promise.all(tasks);
    expect(h.calls).toHaveLength(14);
    expect(h.wire).toHaveLength(0);
    expect(h.client.usage().calls).toBe(14);
    expect(h.client.usage().budget).toBeUndefined();
  });

  it("old timeout failover still runs despite outstanding ignored-abort provider; late usage remains ignored", async () => {
    vi.useFakeTimers();
    const pending = deferred<ClassifyResult>();
    const h = harness({
      enabled: false,
      config: { classifiers: ids },
      respond: (i) => (i === 0 ? pending.promise : result(0.1)),
    });
    const task = h.ask();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await task).toEqual({
      ok: true,
      model: ids[1],
      answers: result().answers,
      missing: [],
      costUsd: 0.1,
      latencyMs: 1000,
    });
    expect(h.client.usage()).toEqual({ costUsd: 0.1, calls: 1 });
    pending.resolve(result(5));
    await flush();
    expect(h.client.usage()).toEqual({ costUsd: 0.1, calls: 1 });
    expect(h.calls).toHaveLength(2);
  });

  it("legacy calls/cost limits still check only ask entry, not intra-chain; old caller-facing result is exact", async () => {
    const h = harness({
      enabled: false,
      config: { classifiers: ids, maxCalls: 1, maxCostUsd: 0.05 },
      respond: (i) => (i === 0 ? { ...result(8, "error"), errorMessage: "451 blocked" } : result(0.1)),
    });
    expect(await h.ask()).toEqual({
      ok: true,
      model: ids[1],
      answers: result().answers,
      missing: [],
      costUsd: 0.1,
      latencyMs: expect.any(Number),
    });
    expect(h.client.usage()).toEqual({ costUsd: 0.1, calls: 2 });
    expect(await h.ask()).toEqual({ ok: false, reason: "budget", detail: "per-activation cost/call cap reached" });
    expect(h.calls).toHaveLength(2);
    expect(h.wire).toHaveLength(0);
  });
});
