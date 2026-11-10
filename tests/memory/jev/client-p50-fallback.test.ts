/** Real sole client/semaphores/A budget, controllable original provider promises.
 * No handler/client mocks, real waits, network or paid provider. */
import { afterEach, expect, it, vi } from "vitest";
import { createJevClient, type JevClientHandle, type P50ClientCapabilities } from "../../../src/memory/jev/client.js";
import type {
  ClassifierRegistryLike,
  ClassifyResult,
  JevRequest,
  ControlledClassifyTransport,
} from "../../../src/memory/jev/contracts.js";
import { jevConfigOf } from "../../../src/memory/jev/config.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import { clearHealthTable } from "../../../src/memory/jev/health.js";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const answer = (): ClassifyResult => ({
  provider: "fallback",
  model: "model",
  stopReason: "stop",
  answers: { q: { type: "bool", probability: 0.9 } },
  usage: { input: 1, cost: { total: 0.000001 } },
});
async function flush() {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.useRealTimers();
  clearHealthTable();
});
function fixture(options: { off?: boolean; noQuote?: boolean; maxCalls?: number; maxCostUsd?: number } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const legacy: { pending: ReturnType<typeof deferred<ClassifyResult>>; signal?: AbortSignal }[] = [];
  const bounded: { pending: ReturnType<typeof deferred<ClassifyResult>>; signal: AbortSignal }[] = [];
  const model = { provider: "fallback", id: "model" };
  const registry: ClassifierRegistryLike = {
    getModelOfType: () => model,
    getAvailableOfType: async () => [model],
    classify(_model, _context, opts) {
      const pending = deferred<ClassifyResult>();
      legacy.push({ pending, ...(opts?.signal ? { signal: opts.signal } : {}) });
      return pending.promise; // deliberately ignores abort: original promise settles only when test releases it
    },
  };
  const transport: ControlledClassifyTransport = {
    prepare: (input) =>
      options.noQuote
        ? undefined
        : {
            adapterId: "offline-bounded",
            chainVersion: "1",
            // This fixture protocol defines one byte/token, with an enforced fixed
            // output vocabulary. Not a production tokenizer/cap certification.
            bounds: {
              maxInputTokens: Buffer.byteLength(JSON.stringify(input.context)),
              maxOutputTokens: 64,
              priceUsdPerMillion: { input: 1, output: 1 },
            },
            dispatch(opts) {
              const pending = deferred<ClassifyResult>();
              bounded.push({ pending, signal: opts.signal });
              return pending.promise;
            },
            resolveRoute: () => undefined,
          },
  };
  const capability: P50ClientCapabilities = {
    transport,
    revision: { transport: { prepare: () => undefined }, models: [], coverageModels: [] },
  };
  const state = {
    capability: undefined as P50ClientCapabilities | undefined,
    onCurrent: undefined as (() => void) | undefined,
  };
  const client: JevClientHandle = createJevClient({
    config: {
      ...jevConfigOf(DEFAULT_MEMORY_SETTINGS),
      classifiers: ["fallback/model"],
      maxCalls: options.maxCalls ?? 1000,
      maxCostUsd: options.maxCostUsd ?? 100,
    },
    now: Date.now,
    isChild: false,
    ...(options.off
      ? {}
      : {
          p50: {
            enabled: true,
            current: () => {
              state.onCurrent?.();
              return state.capability;
            },
          },
        }),
  });
  const ask = (patch: Partial<JevRequest> = {}) =>
    client.ask({
      duty: "tag",
      registry,
      mode: "sync",
      budgetMs: 30_000,
      state: { test: "x" },
      questions: { q: { type: "bool", instructions: "x", criteria: { true: "t", false: "f" } } },
      ...patch,
    });
  cleanup.push(async () => {
    client.dispose();
    // Drain at most the finite requests created by these tests, including a
    // broken implementation's extra dispatches, without real timers/hangs.
    for (let i = 0; i < 20; i++) {
      for (const c of [...legacy, ...bounded]) c.pending.resolve(answer());
      await flush();
    }
  });
  return { client, registry, state, capability, legacy, bounded, ask };
}

it("reviewer counterexample: dynamic effective-off nine sync asks have active3/queued4, never queued6 or post-dispose success/dispatch", async () => {
  const h = fixture();
  const results = [] as Awaited<ReturnType<typeof h.ask>>[];
  const asks = Array.from({ length: 9 }, () =>
    h.ask().then((r) => {
      results.push(r);
      return r;
    }),
  );
  await flush();
  expect(h.legacy).toHaveLength(3);
  expect(h.client.usage().budget?.queued.sync).toBe(4);
  expect(results).toHaveLength(2);
  expect(results.every((r) => !r.ok && r.reason === "budget")).toBe(true);
  h.client.dispose();
  await flush();
  for (const c of h.legacy) c.pending.resolve(answer());
  const settled = await Promise.all(asks);
  await flush();
  expect(h.legacy).toHaveLength(3);
  expect(settled.every((r) => !r.ok)).toBe(true);
  expect(h.client.usage().budget).toMatchObject({ disposed: true, queued: { sync: 0, background: 0 } });
  expect(vi.getTimerCount()).toBe(0);
});

it("queued4 is admitted, the fifth queued request rejects, and normal dynamic fallback remains executable", async () => {
  const h = fixture();
  const asks = Array.from({ length: 7 }, () => h.ask());
  await flush();
  expect(h.legacy).toHaveLength(3);
  expect(h.client.usage().budget?.queued.sync).toBe(4);
  let rejected: Awaited<ReturnType<typeof h.ask>> | undefined;
  void h.ask().then((r) => {
    rejected = r;
  });
  await flush();
  expect(rejected).toMatchObject({ ok: false, reason: "budget" });
  for (let i = 0; i < 7; i++) {
    await flush();
    expect(h.legacy[i]).toBeDefined();
    h.legacy[i]!.pending.resolve(answer());
  }
  expect((await Promise.all(asks)).every((r) => r.ok)).toBe(true);
  expect(h.legacy).toHaveLength(7);
  expect(h.client.usage().budget?.queued.sync).toBe(0);
});

it("reviewer stronger counterexample: queued legacy cannot dispatch across off/on/off while A named background job is a zombie", async () => {
  const h = fixture();
  const active = Array.from({ length: 3 }, () => h.ask());
  const queued = h.ask();
  await flush();
  expect(h.legacy).toHaveLength(3);
  expect(h.client.usage().budget?.queued.sync).toBe(1);
  h.state.capability = h.capability;
  const control = new AbortController();
  const named = h.ask({ mode: "background", jobId: "same-A-job", jobCostCapUsd: 0.1, signal: control.signal });
  await flush();
  expect(h.bounded).toHaveLength(1);
  expect(h.client.usage().budget?.outstanding).toBe(1);
  h.state.capability = undefined;
  control.abort();
  expect(await named).toMatchObject({ ok: false, reason: "aborted" });
  expect(h.client.usage().budget).toMatchObject({ outstanding: 1, zombies: 1 });
  for (const c of h.legacy) c.pending.resolve(answer());
  await flush();
  expect(h.legacy).toHaveLength(3);
  expect(await queued).toMatchObject({ ok: false });
  expect((await Promise.all(active)).every((r) => !r.ok)).toBe(true);
  expect(await h.ask()).toMatchObject({ ok: false, reason: "budget" });
  h.bounded[0]!.pending.resolve(answer());
  await flush();
  expect(h.client.usage().budget).toMatchObject({ outstanding: 0, zombies: 0 });
  const fresh = h.ask();
  await flush();
  expect(h.legacy).toHaveLength(4);
  h.legacy[3]!.pending.resolve(answer());
  expect((await fresh).ok).toBe(true);
});

it("queued caller/epoch abort cancels without acquiring a slot or dispatching", async () => {
  const h = fixture();
  const active = Array.from({ length: 3 }, () => h.ask());
  await flush();
  const epoch = new AbortController();
  const queued = h.ask({ signal: epoch.signal });
  await flush();
  expect(h.client.usage().budget?.queued.sync).toBe(1);
  epoch.abort();
  await flush();
  expect(h.client.usage().budget?.queued.sync).toBe(0);
  expect(await queued).toMatchObject({ ok: false, reason: "aborted" });
  for (const c of h.legacy) c.pending.resolve(answer());
  expect((await Promise.all(active)).every((r) => r.ok)).toBe(true);
  expect(h.legacy).toHaveLength(3);
});

it("dynamic background fallback uses existing active4/queued4 and abortBackground cancels queued and in-flight authority", async () => {
  const h = fixture();
  const asks = Array.from({ length: 8 }, () => h.ask({ mode: "background" }));
  await flush();
  expect(h.legacy).toHaveLength(4);
  expect(h.client.usage().budget?.queued.background).toBe(4);
  let rejected: Awaited<ReturnType<typeof h.ask>> | undefined;
  void h.ask({ mode: "background" }).then((r) => {
    rejected = r;
  });
  await flush();
  expect(rejected).toMatchObject({ ok: false, reason: "budget" });
  h.client.abortBackground();
  await flush();
  expect(h.client.usage().budget?.queued.background).toBe(0);
  expect((await Promise.all(asks)).every((r) => !r.ok && r.reason === "aborted")).toBe(true);
  for (const c of h.legacy) c.pending.resolve(answer());
  await flush();
  expect(h.legacy).toHaveLength(4);
  expect(h.client.usage().budget?.queued.background).toBe(0);
});

it("quote-unavailable fallback cannot silently switch capability after queueing", async () => {
  const h = fixture({ noQuote: true });
  h.state.capability = h.capability;
  const active = Array.from({ length: 3 }, () => h.ask());
  const queued = h.ask();
  await flush();
  expect(h.legacy).toHaveLength(3);
  h.state.capability = undefined;
  for (const c of h.legacy) c.pending.resolve(answer());
  await flush();
  expect(h.legacy).toHaveLength(3);
  expect(await queued).toMatchObject({ ok: false, reason: "aborted" });
  expect((await Promise.all(active)).every((r) => !r.ok)).toBe(true);
});

it("P50 completely off keeps the original legacy unlimited queue and disposal contract", async () => {
  const h = fixture({ off: true });
  const asks = Array.from({ length: 9 }, () => h.ask());
  await flush();
  expect(h.legacy).toHaveLength(3);
  expect(h.client.usage()).not.toHaveProperty("budget");
  h.client.dispose();
  for (let i = 0; i < 9; i++) {
    await flush();
    expect(h.legacy[i]).toBeDefined();
    h.legacy[i]!.pending.resolve(answer());
  }
  expect((await Promise.all(asks)).every((r) => r.ok)).toBe(true);
  expect(h.legacy).toHaveLength(9);
});

it("a real A reservation acquired while fallback waits blocks dequeue without creating another pool or dispatch", async () => {
  const h = fixture();
  const active = Array.from({ length: 3 }, () => h.ask());
  const queued = h.ask();
  await flush();
  const reservation = h.client.reserveClientAttempt({
    mode: "background",
    maxProviderCalls: 1,
    worstCostUsd: 0.01,
    jobId: "reserved-A",
    jobCostCapUsd: 0.1,
  });
  expect(reservation).toBeDefined();
  h.legacy[0]!.pending.resolve(answer());
  await flush();
  expect(await queued).toMatchObject({ ok: false, reason: "budget" });
  expect(h.legacy).toHaveLength(3);
  for (const c of h.legacy) c.pending.resolve(answer());
  expect((await Promise.all(active)).every((r) => r.ok)).toBe(true);
  h.client.releaseClientAttempt(reservation!);
  expect(h.client.usage().budget?.reservedCalls).toBe(0);
});

it("final dispatch check is AFTER registry host callbacks: a late real reservation cannot slip through", async () => {
  const h = fixture();
  const original = h.registry.getModelOfType!;
  let token: ReturnType<typeof h.client.reserveClientAttempt>;
  h.registry.getModelOfType = (...args) => {
    token = h.client.reserveClientAttempt({ mode: "background", maxProviderCalls: 1, worstCostUsd: 0.01 });
    return original(...args);
  };
  expect(await h.ask()).toMatchObject({ ok: false, reason: "budget" });
  expect(token).toBeDefined();
  expect(h.legacy).toHaveLength(0);
  expect(h.client.usage().calls).toBe(0);
  h.client.releaseClientAttempt(token!);
  h.registry.getModelOfType = original;
  const normal = h.ask();
  await flush();
  expect(h.legacy).toHaveLength(1);
  h.legacy[0]!.pending.resolve(answer());
  expect((await normal).ok).toBe(true);
});

it("final dispatch check also catches reentrant dispose after acquisition/availability and before the provider", async () => {
  const h = fixture();
  const original = h.registry.getModelOfType!;
  h.registry.getModelOfType = (...args) => {
    h.client.dispose();
    return original(...args);
  };
  expect(await h.ask()).toMatchObject({ ok: false, reason: "aborted" });
  expect(h.legacy).toHaveLength(0);
  expect(h.client.usage().calls).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("dynamic fallback counts actual dispatches for maxCalls, including concurrent in-flight calls, not only successes", async () => {
  const h = fixture({ maxCalls: 3 });
  const active = Array.from({ length: 3 }, () => h.ask());
  const queued = h.ask();
  await flush();
  expect(h.legacy).toHaveLength(3);
  expect(h.client.usage().calls).toBe(3);
  h.legacy[0]!.pending.resolve(answer());
  await flush();
  expect(await queued).toMatchObject({ ok: false, reason: "budget" });
  expect(h.legacy).toHaveLength(3);
  for (const c of h.legacy) c.pending.resolve(answer());
  expect((await Promise.all(active)).every((r) => r.ok)).toBe(true);
  expect(h.client.usage().calls).toBe(3);
});

it("queue time consumes the same finite request deadline and cancellation removes the waiter", async () => {
  const h = fixture();
  const active = Array.from({ length: 3 }, () => h.ask());
  await flush();
  const queued = h.ask({ budgetMs: 10 });
  await flush();
  expect(h.client.usage().budget?.queued.sync).toBe(1);
  await vi.advanceTimersByTimeAsync(10);
  expect(await queued).toMatchObject({ ok: false, reason: "timeout" });
  expect(h.client.usage().budget?.queued.sync).toBe(0);
  expect(h.legacy).toHaveLength(3);
  for (const c of h.legacy) c.pending.resolve(answer());
  expect((await Promise.all(active)).every((r) => r.ok)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["epoch", "caller", "dispose"] as const)(
  "reported legacy cost settles once on its ORIGINAL promise after %s; lost authority cannot erase shared spending",
  async (reason) => {
    const h = fixture({ maxCostUsd: 0.001 });
    const control = new AbortController();
    const request = h.ask({ signal: control.signal });
    await flush();
    expect(h.legacy).toHaveLength(1);
    if (reason === "epoch") h.state.capability = h.capability;
    else if (reason === "caller") control.abort();
    else h.client.dispose();
    if (reason !== "epoch") expect(await request).toMatchObject({ ok: false, reason: "aborted" });
    h.legacy[0]!.pending.resolve({ ...answer(), usage: { input: 1, cost: { total: 0.01 } } });
    expect(await request).toMatchObject({ ok: false, reason: "aborted" });
    await flush();
    expect(h.client.usage().costUsd).toBe(0.01);
    expect(h.client.usage().budget?.exhausted).toBe(true);
    expect(await h.ask()).toMatchObject({ ok: false, reason: reason === "dispose" ? "aborted" : "budget" });
    expect(h.bounded).toHaveLength(0);
    await flush();
    expect(h.client.usage().costUsd).toBe(0.01);
  },
);

it.each(["dispose", "caller-abort", "background-abort"] as const)(
  "FINAL current callback synchronously %s but returns SAME undefined capability: zero real provider dispatch",
  async (action) => {
    const h = fixture();
    const control = new AbortController();
    const model = h.registry.getModelOfType!;
    const original = h.registry.classify!;
    const dispatches: { disposed: boolean | undefined; aborted: boolean | undefined }[] = [];
    h.registry.classify = (...args) => {
      dispatches.push({ disposed: h.client.usage().budget?.disposed, aborted: args[2]?.signal?.aborted });
      return original(...args);
    };
    let triggered = false;
    h.registry.getModelOfType = (...args) => {
      // Arm only after dequeue/availability, so the callback below runs INSIDE
      // the final real guard.current, not merely the initial admission check.
      h.state.onCurrent = () => {
        if (triggered) return;
        triggered = true;
        if (action === "dispose") h.client.dispose();
        else if (action === "caller-abort") control.abort();
        else h.client.abortBackground();
      };
      return model(...args);
    };
    expect(
      await h.ask({ mode: action === "background-abort" ? "background" : "sync", signal: control.signal }),
    ).toMatchObject({ ok: false, reason: "aborted" });
    expect(triggered).toBe(true);
    expect(dispatches).toEqual([]);
    expect(h.legacy).toHaveLength(0);
    expect(h.client.usage().calls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("FINAL current callback returning SAME capability without revocation still permits real fallback", async () => {
  const h = fixture();
  const model = h.registry.getModelOfType!;
  let finalReads = 0;
  h.registry.getModelOfType = (...args) => {
    h.state.onCurrent = () => {
      finalReads++;
    };
    return model(...args);
  };
  const request = h.ask();
  await flush();
  expect(finalReads).toBeGreaterThan(0);
  expect(h.legacy).toHaveLength(1);
  expect(h.legacy[0]!.signal?.aborted).toBe(false);
  expect(h.client.usage().budget?.disposed).toBe(false);
  h.legacy[0]!.pending.resolve(answer());
  expect((await request).ok).toBe(true);
});

it("FINAL current callback creates a real A reservation but returns SAME capability: reread budgets after callback", async () => {
  const h = fixture();
  const model = h.registry.getModelOfType!;
  let token: ReturnType<typeof h.client.reserveClientAttempt>;
  h.registry.getModelOfType = (...args) => {
    h.state.onCurrent = () => {
      token ??= h.client.reserveClientAttempt({ mode: "background", maxProviderCalls: 1, worstCostUsd: 0.01 });
    };
    return model(...args);
  };
  expect(await h.ask()).toMatchObject({ ok: false, reason: "budget" });
  expect(token).toBeDefined();
  expect(h.legacy).toHaveLength(0);
  expect(h.client.usage().calls).toBe(0);
  h.client.releaseClientAttempt(token!);
});

it("FINAL current callback can fire the attempt deadline synchronously: never dispatch with its already-aborted signal", async () => {
  const h = fixture();
  const model = h.registry.getModelOfType!;
  let fired = false;
  h.registry.getModelOfType = (...args) => {
    h.state.onCurrent = () => {
      if (!fired) {
        fired = true;
        vi.advanceTimersByTime(15_000);
      }
    };
    return model(...args);
  };
  expect(await h.ask()).toMatchObject({ ok: false, reason: "all-failed" });
  expect(fired).toBe(true);
  expect(h.legacy).toHaveLength(0);
  expect(h.client.usage().calls).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
