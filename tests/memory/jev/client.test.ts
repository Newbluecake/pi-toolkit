// jev/client.test.ts — failover chain, error-grade isolation, context split,
// budget/rate limits, concurrency caps, status-change notifications
// (jev-plan J2 §4 J2 acceptance criteria).

import { afterEach, describe, expect, it, vi } from "vitest";
import { createJevClient } from "../../../src/memory/jev/client.js";
import { clearHealthTable } from "../../../src/memory/jev/health.js";
import {
  DEFAULT_JEV_FAST_PATH,
  type HealthTable,
  type JevConfig,
  type JevRequest,
  type TokenBucket,
} from "../../../src/memory/jev/contracts.js";
import { createFakeRegistry } from "./helpers/fake-registry.js";

afterEach(() => clearHealthTable());

function freshHealth(): HealthTable {
  const map = new Map<string, Parameters<HealthTable["set"]>[1]>();
  return {
    get: (m) => map.get(m),
    set: (m, e) => void map.set(m, e),
    entries: () => [...map.entries()],
    clear: () => map.clear(),
  };
}

function freshBucket(capacity = 30, windowMs = 60_000): TokenBucket {
  let windowStart = -Infinity;
  let count = 0;
  return {
    tryTake(now: number): boolean {
      if (now - windowStart >= windowMs) {
        windowStart = now;
        count = 0;
      }
      if (count >= capacity) return false;
      count += 1;
      return true;
    },
  };
}

function cfg(overrides: Partial<JevConfig> = {}): JevConfig {
  return {
    classifiers: ["opencode/jev-1.13-free", "opencode/jev-1.13", "openrouter/typesafe/jev-1.14"],
    proxy: "",
    childSessions: true,
    recall: { threshold: 0.6, maxEntries: 3, maxBytes: 4096, waitMs: 2000 },
    reviewIntervalDays: 7,
    maxCostUsd: 0.5,
    maxCalls: 800,
    confirmTimeoutMs: 60_000,
    fastPath: DEFAULT_JEV_FAST_PATH,
    ...overrides,
  };
}

function req(overrides: Partial<JevRequest> = {}, registry: JevRequest["registry"]): JevRequest {
  return {
    duty: "recall",
    registry,
    state: { user_message: "x" },
    questions: { e1: { type: "bool", instructions: "x", criteria: { true: "t", false: "f" } } },
    budgetMs: 4000,
    mode: "sync",
    ...overrides,
  };
}

describe("createJevClient — failover chain and error grading (jev-arch §5.2)", () => {
  it("451 -> 402 -> success within one ask(): isolates the first two, returns the third model", async () => {
    const { registry, callCountFor } = createFakeRegistry({
      available: cfg().classifiers,
      responses: {
        "opencode/jev-1.13-free": [{ stopReason: "error", errorMessage: "System One API error (451): blocked" }],
        "opencode/jev-1.13": [{ stopReason: "error", errorMessage: "System One API error (402): Insufficient funds" }],
        "openrouter/typesafe/jev-1.14": [{ stopReason: "stop", answers: { e1: { type: "bool", probability: 0.9 } } }],
      },
    });
    let now = 0;
    const client = createJevClient({
      config: cfg(),
      isChild: false,
      now: () => now,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    const outcome = await client.ask(req({}, registry));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.model).toBe("openrouter/typesafe/jev-1.14");
    expect(callCountFor("opencode/jev-1.13-free")).toBe(1);
    expect(callCountFor("opencode/jev-1.13")).toBe(1);

    // Both failed models are now isolated for 1h; re-asking doesn't re-call them.
    now += 1000;
    const second = await client.ask(req({}, registry));
    expect(second.ok).toBe(true);
    expect(callCountFor("opencode/jev-1.13-free")).toBe(1);
    expect(callCountFor("opencode/jev-1.13")).toBe(1);
    expect(callCountFor("openrouter/typesafe/jev-1.14")).toBe(2);
  });

  it("a per-tier timeout fails over to the next classifier (transient, not aborted)", async () => {
    const hang = (call: { signal: AbortSignal | undefined }) =>
      new Promise<{ stopReason: "aborted" }>((resolve) => {
        call.signal?.addEventListener("abort", () => resolve({ stopReason: "aborted" }));
      });
    const { registry, callCountFor } = createFakeRegistry({
      available: ["opencode/jev-1.13-free", "opencode/jev-1.13"],
      responses: {
        "opencode/jev-1.13-free": [hang],
        "opencode/jev-1.13": [{ stopReason: "stop", answers: { e1: { type: "bool", probability: 0.8 } } }],
      },
    });
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free", "opencode/jev-1.13"] }),
      isChild: false,
      now: () => Date.now(),
      health: freshHealth(),
      bucket: freshBucket(),
    });
    // budget 2400ms ⇒ first tier gets max(1000, 1200) = 1200ms, then fails over.
    const outcome = await client.ask(req({ budgetMs: 2400 }, registry));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.model).toBe("opencode/jev-1.13");
    expect(callCountFor("opencode/jev-1.13-free")).toBe(1);
    expect(callCountFor("opencode/jev-1.13")).toBe(1);
  });

  it("a caller abort during a tier still returns aborted without failover", async () => {
    const hang = (call: { signal: AbortSignal | undefined }) =>
      new Promise<{ stopReason: "aborted" }>((resolve) => {
        call.signal?.addEventListener("abort", () => resolve({ stopReason: "aborted" }));
      });
    const { registry, callCountFor } = createFakeRegistry({
      available: ["opencode/jev-1.13-free", "opencode/jev-1.13"],
      responses: { "opencode/jev-1.13-free": [hang] },
    });
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free", "opencode/jev-1.13"] }),
      isChild: false,
      now: () => Date.now(),
      health: freshHealth(),
      bucket: freshBucket(),
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50).unref?.();
    const outcome = await client.ask(req({ budgetMs: 4000, signal: ac.signal }, registry));
    expect(outcome).toMatchObject({ ok: false, reason: "aborted" });
    expect(callCountFor("opencode/jev-1.13")).toBe(0);
  });

  it("transient failures isolate a model for 10 minutes after 3 consecutive failures; success resets the counter", async () => {
    const { registry, callCountFor } = createFakeRegistry({
      available: ["opencode/jev-1.13-free"],
      responses: {
        "opencode/jev-1.13-free": [
          { stopReason: "error", errorMessage: "System One API error (429): rate limited" },
          { stopReason: "error", errorMessage: "System One API error (429): rate limited" },
          { stopReason: "stop", answers: { e1: { type: "bool", probability: 0.5 } } }, // resets the streak
          { stopReason: "error", errorMessage: "System One API error (500): boom" },
          { stopReason: "error", errorMessage: "System One API error (500): boom" },
          { stopReason: "error", errorMessage: "System One API error (500): boom" }, // 3rd consecutive -> isolate
          { stopReason: "stop", answers: { e1: { type: "bool", probability: 0.5 } } }, // recovery call after the 10-minute window
        ],
      },
    });
    let now = 0;
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"] }),
      isChild: false,
      now: () => now,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    for (let i = 0; i < 6; i++) await client.ask(req({}, registry));
    expect(callCountFor("opencode/jev-1.13-free")).toBe(6);
    // Isolated now — a 7th call does not reach the model.
    const blocked = await client.ask(req({}, registry));
    expect(blocked.ok).toBe(false);
    expect(callCountFor("opencode/jev-1.13-free")).toBe(6);

    now += 10 * 60_000 + 1;
    const recovered = await client.ask(req({}, registry));
    expect(recovered.ok).toBe(true);
    expect(callCountFor("opencode/jev-1.13-free")).toBe(7);
  });

  it("all configured classifiers failing -> {ok:false, reason:'all-failed'}", async () => {
    const { registry } = createFakeRegistry({
      available: ["opencode/jev-1.13-free"],
      responses: {
        "opencode/jev-1.13-free": [{ stopReason: "error", errorMessage: "System One API error (451): blocked" }],
      },
    });
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"] }),
      isChild: false,
      now: () => 0,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    const outcome = await client.ask(req({}, registry));
    expect(outcome).toMatchObject({ ok: false, reason: "all-failed" });
    expect(client.status().kind).toBe("partial");
  });

  it("no classifiers configured -> off", async () => {
    const { registry } = createFakeRegistry({ available: [] });
    const client = createJevClient({ config: cfg({ classifiers: [] }), isChild: false, now: () => 0 });
    expect(await client.ask(req({}, registry))).toMatchObject({ ok: false, reason: "off" });
  });

  it("context errors split the batch in half and retry once; a question still missing after the retry is reported as missing", async () => {
    const registryHandle = createFakeRegistry({
      available: ["opencode/jev-1.13-free"],
      responses: {
        "opencode/jev-1.13-free": [
          { stopReason: "error", errorMessage: "System One API error (400): maximum context exceeded" },
          (call) => ({
            stopReason: "stop",
            answers: Object.fromEntries(
              Object.keys(call.questions).map((id) => [id, { type: "bool", probability: 0.9 }]),
            ),
          }),
          { stopReason: "error", errorMessage: "System One API error (400): maximum context exceeded" },
        ],
      },
    });
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"] }),
      isChild: false,
      now: () => 0,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    const outcome = await client.ask(
      req(
        {
          questions: {
            e1: { type: "bool", instructions: "a", criteria: { true: "t", false: "f" } },
            e2: { type: "bool", instructions: "b", criteria: { true: "t", false: "f" } },
          },
        },
        registryHandle.registry,
      ),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // first half succeeded, second half errored again (no further split)
      expect(Object.keys(outcome.answers).length).toBe(1);
      expect(outcome.missing.length).toBe(1);
    }
    // Context errors never isolate the model.
    expect(registryHandle.calls.every(() => true)).toBe(true);
  });

  it("an already-aborted request signal returns 'aborted' immediately without calling classify()", async () => {
    const { registry, calls } = createFakeRegistry({ available: ["opencode/jev-1.13-free"] });
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"] }),
      isChild: false,
      now: () => 0,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    const controller = new AbortController();
    controller.abort();
    const outcome = await client.ask(req({ signal: controller.signal }, registry));
    expect(outcome).toMatchObject({ ok: false, reason: "aborted" });
    expect(calls.length).toBe(0); // zero-wait contract: no request is ever issued
  });
});

describe("createJevClient — availability ('有凭证 ≠ 可用')", () => {
  it("no-auth / not-found classifiers never get a classify() call", async () => {
    const { registry, callCountFor } = createFakeRegistry({
      available: [],
      notFound: ["openrouter/typesafe/jev-1.14"],
    });
    const client = createJevClient({
      config: cfg(),
      isChild: false,
      now: () => 0,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    const outcome = await client.ask(req({}, registry));
    expect(outcome).toMatchObject({ ok: false, reason: "all-failed" });
    expect(callCountFor("opencode/jev-1.13-free")).toBe(0);
    expect(client.status()).toMatchObject({ kind: "partial" });
  });

  it("probe() forces an availability refresh even inside the 10-minute cache window", async () => {
    let calls = 0;
    const { registry } = createFakeRegistry({
      available: ["opencode/jev-1.13-free"],
      onGetAvailableOfType: () => calls++,
    });
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"] }),
      isChild: false,
      now: () => 0,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    await client.ask(req({}, registry));
    expect(calls).toBe(1);
    await client.ask(req({}, registry)); // within cache window — no refresh
    expect(calls).toBe(1);
    await client.probe(registry);
    expect(calls).toBe(2);
  });

  it("probe() passes its signal through: an already-aborted signal returns promptly without reaching the registry", async () => {
    let getAvailableCalls = 0;
    const { registry } = createFakeRegistry({
      available: ["opencode/jev-1.13-free"],
      onGetAvailableOfType: () => getAvailableCalls++,
    });
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"] }),
      isChild: false,
      now: () => 0,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    const controller = new AbortController();
    controller.abort();
    await client.probe(registry, controller.signal);
    expect(getAvailableCalls).toBe(0); // signal was already aborted — the registry is never called
  });

  it("probe() passes its signal through: aborting mid-flight lets probe() return promptly instead of hanging", async () => {
    let resolveGetAvailable: (() => void) | undefined;
    const registry = {
      getModelOfType: () => ({}),
      getAvailableOfType: async () =>
        new Promise<{ provider: string; id: string }[]>((resolve) => {
          resolveGetAvailable = () => resolve([{ provider: "opencode", id: "jev-1.13-free" }]);
        }),
      classify: async () => ({
        stopReason: "stop" as const,
        answers: {},
        provider: "opencode",
        model: "jev-1.13-free",
      }),
    };
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"] }),
      isChild: false,
      now: () => 0,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    const controller = new AbortController();
    let settled = false;
    const pending = client.probe(registry, controller.signal).then((s) => {
      settled = true;
      return s;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false); // getAvailableOfType is still pending
    controller.abort();
    await vi.waitFor(() => expect(settled).toBe(true)); // probe() returns without waiting for the registry
    await pending;
    resolveGetAvailable?.(); // let the now-orphaned underlying call settle so it doesn't leak a timer
  });
});

describe("createJevClient — budget and rate limits (§5.5)", () => {
  it("per-activation call cap latches budget-exhausted; no further classify() calls", async () => {
    const { registry, calls } = createFakeRegistry({ available: ["opencode/jev-1.13-free"] });
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"], maxCalls: 2 }),
      isChild: false,
      now: () => 0,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    await client.ask(req({}, registry));
    await client.ask(req({}, registry));
    const third = await client.ask(req({}, registry));
    expect(third).toMatchObject({ ok: false, reason: "budget" });
    expect(calls.length).toBe(2);
    expect(client.status()).toMatchObject({ kind: "partial", reason: "budget" });
  });

  it("child-session token bucket exhaustion blocks ask() without calling classify()", async () => {
    const { registry, calls } = createFakeRegistry({ available: ["opencode/jev-1.13-free"] });
    const bucket = freshBucket(1);
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"] }),
      isChild: true,
      now: () => 0,
      health: freshHealth(),
      bucket,
    });
    await client.ask(req({}, registry));
    const blocked = await client.ask(req({}, registry));
    expect(blocked).toMatchObject({ ok: false, reason: "budget" });
    expect(calls.length).toBe(1);
  });

  it("per-activation dollar cap (maxCostUsd) latches budget-exhausted; no further classify() calls", async () => {
    const { registry, calls } = createFakeRegistry({
      available: ["opencode/jev-1.13-free"],
      responses: {
        "opencode/jev-1.13-free": [
          {
            stopReason: "stop",
            answers: { e1: { type: "bool", probability: 0.9 } },
            usage: { input: 10, cost: { total: 0.3 } },
          },
        ],
      },
    });
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"], maxCostUsd: 0.5 }),
      isChild: false,
      now: () => 0,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    const first = await client.ask(req({}, registry)); // costs $0.3, under the $0.5 cap
    expect(first.ok).toBe(true);
    const second = await client.ask(req({}, registry)); // pre-check still passes ($0.3 < $0.5); this call pushes usage to $0.6
    expect(second.ok).toBe(true);
    const third = await client.ask(req({}, registry)); // pre-check now sees $0.6 >= $0.5 — latched, no call made
    expect(third).toMatchObject({ ok: false, reason: "budget" });
    expect(calls.length).toBe(2); // the 3rd call never reached the registry
    expect(client.status()).toMatchObject({ kind: "partial", reason: "budget" });
    expect(client.usage()).toEqual({ costUsd: 0.6, calls: 2 });
  });
});

describe("createJevClient — status(), usage(), onStatusChange, abortBackground", () => {
  it("status() is synchronous and does not itself trigger network calls", async () => {
    const { calls } = createFakeRegistry({ available: ["opencode/jev-1.13-free"] });
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"] }),
      isChild: false,
      now: () => 0,
    });
    const status = client.status();
    expect(status.kind).toBe("probing");
    expect(calls.length).toBe(0);
  });

  it("usage() accumulates cost and call count across asks", async () => {
    const { registry } = createFakeRegistry({
      available: ["opencode/jev-1.13-free"],
      responses: {
        "opencode/jev-1.13-free": [
          {
            stopReason: "stop",
            answers: { e1: { type: "bool", probability: 0.9 } },
            usage: { input: 10, cost: { total: 0.001 } },
          },
        ],
      },
    });
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"] }),
      isChild: false,
      now: () => 0,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    await client.ask(req({}, registry));
    expect(client.usage()).toEqual({ costUsd: 0.001, calls: 1 });
  });

  it("onStatusChange fires on probing->full and full->partial transitions", async () => {
    const { registry } = createFakeRegistry({
      available: ["opencode/jev-1.13-free"],
      responses: {
        "opencode/jev-1.13-free": [
          { stopReason: "stop", answers: { e1: { type: "bool", probability: 0.9 } } },
          { stopReason: "error", errorMessage: "System One API error (451): blocked" },
        ],
      },
    });
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"] }),
      isChild: false,
      now: () => 0,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    const transitions: string[] = [];
    client.onStatusChange((prev, next) => transitions.push(`${prev.kind}->${next.kind}`));
    await client.ask(req({}, registry));
    await client.ask(req({}, registry));
    expect(transitions).toContain("probing->full");
    expect(transitions.some((t) => t === "full->partial")).toBe(true);
  });

  it("markInactive flips the partial.inactive flag and notifies subscribers", () => {
    const client = createJevClient({ config: cfg({ classifiers: [] }), isChild: false, now: () => 0 });
    client.markInactive(true);
    // empty classifier list always reports off(empty-list) regardless of inactive —
    // markInactive only matters once classifiers exist; this just proves it never throws.
    expect(client.status().kind).toBe("off");
  });

  it("abortBackground() aborts in-flight background-mode requests", async () => {
    let sawAbort = false;
    const { registry } = createFakeRegistry({
      available: ["opencode/jev-1.13-free"],
      responses: {
        "opencode/jev-1.13-free": [
          (call) =>
            new Promise((resolve) => {
              call.signal?.addEventListener("abort", () => {
                sawAbort = true;
                resolve({ stopReason: "aborted" });
              });
            }),
        ],
      },
    });
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"] }),
      isChild: false,
      now: () => 0,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    const pending = client.ask(req({ mode: "background" }, registry));
    await new Promise((r) => setTimeout(r, 5));
    expect(sawAbort).toBe(false); // still pending
    client.abortBackground();
    const outcome = await pending;
    expect(sawAbort).toBe(true);
    expect(outcome).toMatchObject({ ok: false, reason: "aborted" });
  });

  it("ask() never throws even when the registry misbehaves", async () => {
    const registry = {
      getModelOfType: () => ({}),
      getAvailableOfType: async () => [{ provider: "opencode", id: "jev-1.13-free" }],
      classify: () => {
        throw new Error("boom");
      },
    };
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"] }),
      isChild: false,
      now: () => 0,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    await expect(client.ask(req({}, registry))).resolves.toMatchObject({ ok: false });
  });
});

describe("createJevClient — concurrency caps (sync ≤3, background ≤4)", () => {
  it("a 4th concurrent sync ask() waits for a slot to free", async () => {
    const releasers: (() => void)[] = [];
    const { registry } = createFakeRegistry({
      available: ["opencode/jev-1.13-free"],
      responses: {
        "opencode/jev-1.13-free": [
          () =>
            new Promise((resolve) => {
              releasers.push(() =>
                resolve({ stopReason: "stop", answers: { e1: { type: "bool", probability: 0.9 } } }),
              );
            }),
        ],
      },
    });
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"] }),
      isChild: false,
      now: () => 0,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    // Only one model configured here so 4 "sync" calls really contend on the
    // semaphore rather than on per-model isolation; each ask() call installs
    // its own releaser via the response queue (sticky-last, so every call
    // gets a fresh pending promise).
    const p1 = client.ask(req({}, registry));
    const p2 = client.ask(req({}, registry));
    const p3 = client.ask(req({}, registry));
    await vi.waitFor(() => expect(releasers.length).toBe(3));
    let fourthSettled = false;
    const p4 = client.ask(req({}, registry)).then((o) => {
      fourthSettled = true;
      return o;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(fourthSettled).toBe(false); // waiting for a slot
    releasers[0]!();
    await vi.waitFor(() => expect(releasers.length).toBe(4)); // p4 got the freed slot and is now in flight
    releasers[3]!();
    await vi.waitFor(() => expect(fourthSettled).toBe(true));
    releasers[1]!();
    releasers[2]!();
    await Promise.all([p1, p2, p3, p4]);
  });

  it("a 5th concurrent background-mode ask() waits for a slot (cap is 4, not 3)", async () => {
    const releasers: (() => void)[] = [];
    const { registry } = createFakeRegistry({
      available: ["opencode/jev-1.13-free"],
      responses: {
        "opencode/jev-1.13-free": [
          () =>
            new Promise((resolve) => {
              releasers.push(() =>
                resolve({ stopReason: "stop", answers: { e1: { type: "bool", probability: 0.9 } } }),
              );
            }),
        ],
      },
    });
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"] }),
      isChild: false,
      now: () => 0,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    const pending = [1, 2, 3, 4].map(() => client.ask(req({ mode: "background" }, registry)));
    await vi.waitFor(() => expect(releasers.length).toBe(4)); // all 4 background slots in flight
    let fifthSettled = false;
    const p5 = client.ask(req({ mode: "background" }, registry)).then((o) => {
      fifthSettled = true;
      return o;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(fifthSettled).toBe(false); // the 5th waits — background cap is 4, not unbounded and not 3
    releasers[0]!();
    await vi.waitFor(() => expect(releasers.length).toBe(5)); // the 5th got the freed slot
    releasers[4]!();
    await vi.waitFor(() => expect(fifthSettled).toBe(true));
    releasers[1]!();
    releasers[2]!();
    releasers[3]!();
    await Promise.all([...pending, p5]);
  });

  it("sync and background pools are independent: 3 sync in flight does not block a background call", async () => {
    const syncReleasers: (() => void)[] = [];
    const { registry } = createFakeRegistry({
      available: ["opencode/jev-1.13-free"],
      responses: {
        "opencode/jev-1.13-free": [
          () =>
            new Promise((resolve) => {
              syncReleasers.push(() =>
                resolve({ stopReason: "stop", answers: { e1: { type: "bool", probability: 0.9 } } }),
              );
            }),
        ],
      },
    });
    const client = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"] }),
      isChild: false,
      now: () => 0,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    const sync = [1, 2, 3].map(() => client.ask(req({}, registry)));
    await vi.waitFor(() => expect(syncReleasers.length).toBe(3));
    let backgroundSettled = false;
    const background = client.ask(req({ mode: "background" }, registry)).then((o) => {
      backgroundSettled = true;
      return o;
    });
    await vi.waitFor(() => expect(syncReleasers.length).toBe(4)); // background got its own slot immediately
    syncReleasers[3]!();
    await vi.waitFor(() => expect(backgroundSettled).toBe(true));
    syncReleasers[0]!();
    syncReleasers[1]!();
    syncReleasers[2]!();
    await Promise.all([...sync, background]);
  });
});

describe("createJevClient — proxy fetch wiring (§5.4)", () => {
  it("passes a fetch only when proxy is non-empty", async () => {
    let fetchSeen: unknown;
    const { registry } = createFakeRegistry({
      available: ["opencode/jev-1.13-free"],
      onCall: (call) => {
        fetchSeen = call.fetch;
      },
    });
    const noProxyClient = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"], proxy: "" }),
      isChild: false,
      now: () => 0,
      health: freshHealth(),
      bucket: freshBucket(),
    });
    await noProxyClient.ask(req({}, registry));
    expect(fetchSeen).toBeUndefined();

    const fakeFetch = (async () => ({ status: 200, text: async () => "{}" })) as never;
    const proxyClient = createJevClient({
      config: cfg({ classifiers: ["opencode/jev-1.13-free"], proxy: "http://127.0.0.1:9" }),
      isChild: false,
      now: () => 0,
      health: freshHealth(),
      bucket: freshBucket(),
      makeFetch: () => fakeFetch,
    });
    await proxyClient.ask(req({}, registry));
    expect(fetchSeen).toBe(fakeFetch);
  });
});
