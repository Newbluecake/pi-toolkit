/**
 * Package A2 (capture-pairing-plan r7 §3.3/§3.4): the service's side of the pipeline transport — capability
 * probe, `activationDisabled` (kept outside SessionTotals), runtime `transport-unsupported` diagnosis on an
 * explicit success only, physical-IO `io-busy`, outcome mapping/refund and the child ledger lease on every path.
 * The transport itself (A1) is replaced by the fake sender in ./fake-pipeline.ts, which implements the frozen
 * contract of `pipeline-ping-types.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { probeKeepaliveTransport } from "../../src/adapters/pi-compat.js";
import { createChildKeepaliveLedger } from "../../src/cache-ttl/ping-ledger.js";
import {
  KEEPALIVE_AUDIT_CUSTOM_TYPE,
  readBackKeepaliveSessionState,
  type CapturedRequest,
} from "../../src/cache-ttl/keepalive-state.js";
import type { PipelineDiag, PipelineOutcome } from "../../src/cache-ttl/pipeline-ping-types.js";
import type { CacheTtlSettings } from "../../src/config/settings.js";
import type { CacheKeepaliveDeps, CacheKeepaliveService } from "../../src/service/cache-keepalive.js";
import { createCacheKeepaliveService, diagOf, fakeSender, type FakeSender } from "./fake-pipeline.js";

const SETTINGS: CacheTtlSettings = {
  mode: "auto",
  keepalive: true,
  keepaliveIntervalMs: 240_000,
  keepaliveMinPrefixTokens: 20_000,
};

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function fakeCtx(overrides: Record<string, unknown> = {}) {
  return {
    ui: { setStatus: vi.fn() },
    mode: "tui",
    model: {
      provider: "anthropic",
      api: "anthropic-messages",
      id: "claude-x",
      baseUrl: "https://api.anthropic.com",
      headers: {},
      cost: { cacheRead: 0.3, cacheWrite: 3.75, tiers: [] },
    },
    modelRegistry: { find: vi.fn(), streamSimple: vi.fn() },
    sessionManager: { getSessionId: () => "s1" },
    ...overrides,
  };
}

function capture(instance: string, tokens = 30_000, payloadExtra: Record<string, unknown> = {}): CapturedRequest {
  return {
    sessionId: "s1",
    instance,
    payload: {
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      stream: true,
      ...payloadExtra,
    },
    fingerprint: {
      sessionId: "s1",
      provider: "anthropic",
      api: "anthropic-messages",
      modelId: "claude-x",
      ctxModelId: "claude-x",
      baseUrl: "https://api.anthropic.com",
      authHeaderKeys: "",
      breakpointPath: "messages.0",
      thinkingDigest: "",
      systemDigest: "",
      toolsDigest: "",
      messageCount: 1,
    },
    shape: { ephemeralBreakpoints: 1, ttl1h: false, hasThinking: false, maxTokens: 100 },
    prefix: { tokens, source: "usage" },
    capturedAt: 0,
  };
}

const provenHit: PipelineOutcome = {
  kind: "usage",
  usage: { inputTokens: 10, outputTokens: 1, cacheRead: 500, cacheWrite: 0, cacheWrite1h: undefined },
  diag: diagOf({ sawMessageStart: true }),
};
const provenWrite: PipelineOutcome = {
  kind: "usage",
  usage: { inputTokens: 10, outputTokens: 1, cacheRead: 0, cacheWrite: 777, cacheWrite1h: undefined },
  diag: diagOf({ sawMessageStart: true }),
};

function harness(
  overrides: Partial<CacheKeepaliveDeps> = {},
  ctxOverrides: Record<string, unknown> = {},
  options: { probeFacade?: boolean } = {},
) {
  const clock = new FakeClock(0);
  const ctx = fakeCtx(ctxOverrides);
  let self: CacheKeepaliveService | undefined;
  const appendEntry = vi.fn();
  const service = createCacheKeepaliveService(
    {
      clock,
      ctx: ctx as never,
      sessionId: "s1",
      settings: { ...SETTINGS },
      backgroundBusy: () => true,
      isCurrent: (s) => self === s,
      appendEntry,
      ...overrides,
    },
    options,
  );
  self = service;
  return { clock, ctx, service, appendEntry };
}

function openWindow(h: ReturnType<typeof harness>, tokens = 30_000): void {
  h.service.noteRequest(capture(h.service.instanceId, tokens));
  h.service.noteRequestSettled("s1", h.service.instanceId);
}

const scripted = (outcome: PipelineOutcome | ((call: number) => PipelineOutcome), options = {}): FakeSender =>
  fakeSender(undefined, {
    ...options,
    scripted: (_input, call) => (typeof outcome === "function" ? outcome(call) : outcome),
  });

describe("probeKeepaliveTransport (pi-compat, structural)", () => {
  it("ok iff the registry facade exposes streamSimple as a function", () => {
    expect(probeKeepaliveTransport({ registry: { streamSimple: () => undefined } })).toEqual({ ok: true });
  });
  it.each([undefined, null, {}, { streamSimple: "nope" }, 42])(
    "missing facade %j ⇒ transport-unsupported",
    (registry) => {
      expect(probeKeepaliveTransport({ registry })).toEqual({
        ok: false,
        reason: "transport-unsupported",
        missing: ["modelRegistry.streamSimple"],
      });
    },
  );
  it("a throwing registry getter is a missing capability, never a crash", () => {
    const registry = {
      get streamSimple(): never {
        throw new Error("stale ctx");
      },
    };
    expect(probeKeepaliveTransport({ registry }).ok).toBe(false);
  });
  it("declared-unsupported fetch option / raw event callback are reported as missing", () => {
    const registry = { streamSimple: () => undefined };
    expect(probeKeepaliveTransport({ registry, declared: { fetchOption: false, rawEventCallback: false } })).toEqual({
      ok: false,
      reason: "transport-unsupported",
      missing: ["streamSimple.fetch option", "streamSimple.onProviderStreamEvent"],
    });
    expect(probeKeepaliveTransport({ registry, declared: { fetchOption: true } }).ok).toBe(true);
  });
});

describe("activation-only disable — capability probe at construction", () => {
  it("no streamSimple facade ⇒ keepalive disabled cleanly: terminal activation-disabled skip, zero dispatches, nothing persisted", async () => {
    const sender = scripted(provenHit);
    const { service, clock, appendEntry } = harness(
      { sendPipelinePing: sender.send, persistSessionState: true },
      { modelRegistry: { find: vi.fn() } },
      { probeFacade: false },
    );
    expect(service.report().activationDisabled).toMatchObject({ reason: "transport-unsupported" });
    openWindow({ clock, ctx: undefined as never, service, appendEntry });
    clock.advance(240_000);
    await flush();
    expect(sender.calls).toHaveLength(0);
    const report = service.report();
    expect(report.lastSkip).toBe("activation-disabled");
    expect(report.lastTerminalSkip?.reason).toBe("activation-disabled");
    expect(clock.pendingTimers).toBe(0); // terminal: not re-armed
    expect(report.session.disabled).toBeUndefined(); // a skip, never a persisted breaker
    // Every audit entry's session snapshot is breaker state only: no trace of the activation-only disable.
    for (const [, data] of appendEntry.mock.calls as Array<[string, { session?: unknown }]>) {
      expect(JSON.stringify(data.session ?? {})).not.toContain("transport-unsupported");
      expect(JSON.stringify(data.session ?? {})).not.toContain("activation");
    }
  });

  it("/reload forgets activationDisabled but reads back real breakers (a fresh service on the same branch)", async () => {
    // Service A: a real proven-write trips the permanent breaker; it persists via audit snapshots.
    const first = harness({ sendPipelinePing: scripted(provenWrite).send, persistSessionState: true });
    openWindow(first);
    first.clock.advance(240_000);
    await flush();
    expect(first.service.report().session.disabled?.reason).toBe("proven-write");
    // Service B (same branch, facade MISSING): activation-disabled AND still carries the breaker.
    const branch = (first.appendEntry.mock.calls as Array<[string, unknown]>).map(([customType, data]) => ({
      type: "custom",
      customType,
      data,
    }));
    expect(branch.every((e) => e.customType === KEEPALIVE_AUDIT_CUSTOM_TYPE)).toBe(true);
    const restored = readBackKeepaliveSessionState(branch);
    expect(restored?.disabled?.reason).toBe("proven-write");
    const missing = harness(
      { restoredState: restored, persistSessionState: true },
      { modelRegistry: { find: vi.fn() } },
      { probeFacade: false },
    );
    expect(missing.service.report().activationDisabled).toBeDefined();
    expect(missing.service.report().session.disabled?.reason).toBe("proven-write");
    // Service C (after /reload with a working facade): the activation-only disable is GONE, the breaker stays.
    const reloaded = harness({ restoredState: restored, persistSessionState: true });
    expect(reloaded.service.report().activationDisabled).toBeUndefined();
    expect(reloaded.service.report().session.disabled?.reason).toBe("proven-write");
  });
});

describe("runtime transport-unsupported diagnosis — only on an explicit success", () => {
  const explicit = (extra: Partial<PipelineDiag> = {}): PipelineDiag =>
    diagOf({ explicitSuccess: true, piStopReason: "stop", ...extra });

  it.each<[string, PipelineOutcome]>([
    ["accepted-then-lost, pi succeeded, no raw message_start", { kind: "accepted-then-lost", diag: explicit() }],
    [
      "not-sent{capability}: pi succeeded without ever calling the base fetch",
      { kind: "not-sent", reason: "capability", diag: explicit({ baseFetchCalls: 0 }) },
    ],
  ])("latches transport-unsupported: %s", async (_label, outcome) => {
    const sender = scripted(outcome);
    const { service, clock, appendEntry } = harness({ sendPipelinePing: sender.send });
    openWindow({ clock, ctx: undefined as never, service, appendEntry });
    clock.advance(240_000);
    await flush();
    expect(service.report().activationDisabled).toMatchObject({ reason: "transport-unsupported" });
    expect(service.report().session.disabled).toBeUndefined(); // never a persisted breaker
    // Terminal from now on: more windows/ticks send nothing.
    const callsAfterLatch = sender.calls.length;
    service.noteRequest(capture(service.instanceId, 31_000));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(300_000);
    await flush();
    expect(sender.calls).toHaveLength(callsAfterLatch);
    expect(service.report().lastSkip).toBe("activation-disabled");
  });

  it.each<[string, PipelineOutcome]>([
    ["auth failure", { kind: "not-sent", reason: "auth", diag: diagOf({ baseFetchCalls: 0, onPayloadCalls: 0 }) }],
    ["epoch cancel (guard)", { kind: "not-sent", reason: "guard", diag: diagOf({ baseFetchCalls: 0 }) }],
    ["200-then-drop without pi success", { kind: "accepted-then-lost", diag: diagOf() }],
    ["malformed", { kind: "malformed", diag: diagOf() }],
    ["http 400", { kind: "http", status: 400, diag: diagOf({ httpStatus: 400 }) }],
    ["network", { kind: "network", diag: diagOf() }],
    [
      "explicit success that DID deliver message_start (usage path)",
      { ...provenHit, diag: explicit({ sawMessageStart: true }) } as PipelineOutcome,
    ],
    [
      "explicit success but the deadline already fired",
      { kind: "accepted-then-lost", diag: explicit({ deadlineHit: true }) },
    ],
    [
      "usage presence alone (no explicit success)",
      { ...provenHit, diag: diagOf({ sawMessageStart: false, explicitSuccess: false }) } as PipelineOutcome,
    ],
  ])("never latches: %s", async (_label, outcome) => {
    const { service, clock } = harness({ sendPipelinePing: scripted(outcome).send });
    openWindow({ clock, ctx: undefined as never, service, appendEntry: vi.fn() });
    clock.advance(240_000);
    await flush();
    expect(service.report().activationDisabled).toBeUndefined();
  });

  it("an explicit success after WE aborted (dispose/preemption) is not evidence", async () => {
    let release: (() => void) | undefined;
    const holding: FakeSender["send"] = (input) =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            outcome: { kind: "accepted-then-lost", diag: diagOf({ explicitSuccess: true, piStopReason: "stop" }) },
            settled: Promise.resolve(),
          });
        void input;
      });
    const { service, clock } = harness({ sendPipelinePing: holding });
    openWindow({ clock, ctx: undefined as never, service, appendEntry: vi.fn() });
    clock.advance(240_000);
    await flush();
    service.noteRequest(capture(service.instanceId, 40_000)); // real request preempts ⇒ aborts our controller
    release?.();
    await flush();
    expect(service.report().activationDisabled).toBeUndefined();
  });
});

describe("physical IO: io-busy until `settled`", () => {
  it("logical outcome known but settled pending ⇒ the next due tick skips io-busy (non-terminal, still re-arming) until settled", async () => {
    const sender = scripted(provenHit, { holdSettled: true });
    const { service, clock } = harness({ sendPipelinePing: sender.send });
    openWindow({ clock, ctx: undefined as never, service, appendEntry: vi.fn() });
    clock.advance(240_000);
    await flush();
    expect(sender.calls).toHaveLength(1);
    expect(service.report().session.pings).toBe(1); // the logical outcome was applied
    expect(service.report().ioBusy).toBe(true);

    // Next ping is due at 480_000; with IO still unsettled it must NOT dispatch.
    clock.advance(245_000);
    await flush();
    expect(sender.calls).toHaveLength(1);
    expect(service.report().lastSkip).toBe("io-busy");
    expect(clock.pendingTimers).toBeGreaterThan(0); // non-terminal: ticks keep coming

    sender.releaseSettled();
    await flush();
    expect(service.report().ioBusy).toBe(false);
    clock.advance(15_000);
    await flush();
    expect(sender.calls).toHaveLength(2);
  });

  it("a transport that never settles keeps io-busy until dispose (fail closed): no second transport, ever", async () => {
    const sender = scripted(provenHit, { holdSettled: true });
    const { service, clock } = harness({ sendPipelinePing: sender.send });
    openWindow({ clock, ctx: undefined as never, service, appendEntry: vi.fn() });
    clock.advance(240_000);
    await flush();
    for (let i = 0; i < 5; i += 1) {
      clock.advance(60_000);
      await flush();
    }
    expect(sender.calls).toHaveLength(1);
    expect(service.report().ioBusy).toBe(true);
    service.dispose();
  });

  it("a retry never starts while the previous transport's IO is unsettled: the unproven outcome finalizes instead", async () => {
    const sender = scripted({ kind: "http", status: 503, diag: diagOf({ httpStatus: 503 }) }, { holdSettled: true });
    const { service, clock } = harness({ sendPipelinePing: sender.send });
    openWindow({ clock, ctx: undefined as never, service, appendEntry: vi.fn() });
    clock.advance(240_000);
    await flush();
    clock.advance(2_000); // the 2s backoff elapses — IO still busy
    await flush();
    expect(sender.calls).toHaveLength(1); // no retry
    const report = service.report();
    expect(report.window.pingInFlight).toBe(false);
    expect(report.session.unprovenTotal).toBe(1); // counted as the final outcome (a 503 may have been processed)
  });

  it("a retry DOES start once the previous transport settled (settled resolves right away)", async () => {
    const sender = scripted((call) =>
      call === 1 ? { kind: "http", status: 503, diag: diagOf({ httpStatus: 503 }) } : provenHit,
    );
    const { service, clock } = harness({ sendPipelinePing: sender.send });
    openWindow({ clock, ctx: undefined as never, service, appendEntry: vi.fn() });
    clock.advance(240_000);
    await flush();
    clock.advance(2_000);
    await flush();
    expect(sender.calls).toHaveLength(2);
    expect(service.report().session.pings).toBe(1);
    expect(service.report().session.unprovenTotal).toBe(0);
  });
});

describe("child ledger lease settles on every path", () => {
  const childOpts = (ledger: ReturnType<typeof createChildKeepaliveLedger>): Partial<CacheKeepaliveDeps> => ({
    pingLedger: ledger,
    maxConcurrentPings: 1,
    runBudgetUsd: 100,
    processBudgetUsd: 100,
    allowHeadless: true,
    reportCost: true,
    statusBar: false,
  });
  const run = async (sender: FakeSender["send"], mutate?: (h: ReturnType<typeof harness>) => void) => {
    const ledger = createChildKeepaliveLedger();
    const h = harness({ ...childOpts(ledger), sendPipelinePing: sender });
    openWindow(h, 270_000);
    h.service.noteToolStart("s1", h.service.instanceId);
    h.clock.advance(240_000);
    await flush();
    mutate?.(h);
    await flush();
    return { ledger, ...h };
  };

  it.each<[string, PipelineOutcome]>([
    ["proven-hit", provenHit],
    ["proven-write", provenWrite],
    ["not-sent", { kind: "not-sent", reason: "auth", diag: diagOf({ baseFetchCalls: 0 }) }],
    ["http 400", { kind: "http", status: 400, diag: diagOf({ httpStatus: 400 }) }],
    ["accepted-then-lost", { kind: "accepted-then-lost", diag: diagOf() }],
  ])("%s ⇒ slot released", async (_label, outcome) => {
    const { ledger, service } = await run(scripted(outcome).send);
    expect(ledger.activeCount()).toBe(0);
    service.dispose();
  });

  it("a sender that throws (contract violation) is a zero-network not-sent: refunded, slot released, no busy leak", async () => {
    const { ledger, service } = await run(() => {
      throw new Error("boom");
    });
    expect(ledger.activeCount()).toBe(0);
    expect(service.report().window.pings).toBe(0);
    expect(service.report().ioBusy).toBe(false);
    expect(service.report().session.unprovenTotal).toBe(0);
  });

  it("dispose while the transport is in flight: signal aborted, slot released", async () => {
    let signal: AbortSignal | undefined;
    const hung: FakeSender["send"] = (input) =>
      new Promise((resolve) => {
        signal = input.signal;
        input.signal?.addEventListener("abort", () =>
          resolve({
            outcome: { kind: "not-sent", reason: "aborted", diag: diagOf({ baseFetchCalls: 0 }) },
            settled: Promise.resolve(),
          }),
        );
      });
    const { ledger, service } = await run(hung);
    expect(ledger.activeCount()).toBe(1);
    service.dispose();
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(ledger.activeCount()).toBe(0);
  });

  it("a settled outcome refunds nothing it shouldn't: proven-write charges the cache-write price, not-sent charges 0", async () => {
    const hit = await run(scripted(provenWrite).send);
    const written = (hit.appendEntry.mock.calls as Array<[string, { kind: string; budgetChargeUsd?: number }]>).find(
      ([, d]) => d.kind === "unproven",
    );
    expect(written?.[1].budgetChargeUsd).toBeGreaterThan(0);
    const none = await run(scripted({ kind: "not-sent", reason: "auth", diag: diagOf({ baseFetchCalls: 0 }) }).send);
    expect(
      (none.appendEntry.mock.calls as Array<[string, { kind: string }]>).some(([, d]) => d.kind === "unproven"),
    ).toBe(false);
  });
});

describe("child ledger lease: exactly-once settle (A3 gate G8)", () => {
  /** Ledger whose every acquired lease counts its `settle` calls (the real ledger is idempotent, which hides a double settle). */
  function spiedLedger() {
    const real = createChildKeepaliveLedger();
    const settles: ReturnType<typeof vi.fn>[] = [];
    const tryAcquire: typeof real.tryAcquire = (input) => {
      const result = real.tryAcquire(input);
      if (!result.ok) return result;
      const settle = vi.fn(result.lease.settle.bind(result.lease));
      settles.push(settle);
      return { ok: true, lease: { ...result.lease, settle } };
    };
    // `real` is a class instance: spreading it would drop its prototype methods
    // (spent24h, …), so delegate everything except tryAcquire through a Proxy.
    const ledger = new Proxy(real, {
      get(target, prop) {
        if (prop === "tryAcquire") return tryAcquire;
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    return { ledger, real, settles };
  }
  const childDeps = (ledger: ReturnType<typeof createChildKeepaliveLedger>): Partial<CacheKeepaliveDeps> => ({
    pingLedger: ledger,
    maxConcurrentPings: 1,
    runBudgetUsd: 100,
    processBudgetUsd: 100,
    allowHeadless: true,
    reportCost: true,
    statusBar: false,
  });
  const armed = async (h: ReturnType<typeof harness>) => {
    openWindow(h, 270_000);
    h.service.noteToolStart("s1", h.service.instanceId);
    h.clock.advance(240_000);
    await flush();
  };

  it("dispose mid-flight: the lease is settled exactly once even after the aborted ping unwinds through runPing's finally", async () => {
    const { ledger, real, settles } = spiedLedger();
    const hung: FakeSender["send"] = (input) =>
      new Promise((resolve) => {
        input.signal?.addEventListener("abort", () =>
          resolve({
            outcome: { kind: "not-sent", reason: "aborted", diag: diagOf({ baseFetchCalls: 0 }) },
            settled: Promise.resolve(),
          }),
        );
      });
    const h = harness({ ...childDeps(ledger), sendPipelinePing: hung });
    await armed(h);
    expect(real.activeCount()).toBe(1);
    expect(settles).toHaveLength(1);
    expect(settles[0]).not.toHaveBeenCalled();
    h.service.dispose();
    await flush(); // runPing's aborted sender resolves and its `finally` runs
    expect(settles[0]).toHaveBeenCalledTimes(1);
    expect(real.activeCount()).toBe(0);
  });

  it("dispose mid-flight with a sender that NEVER resolves: dispose alone settles the lease (no hang, no leak), still exactly once", async () => {
    const { ledger, real, settles } = spiedLedger();
    const h = harness({ ...childDeps(ledger), sendPipelinePing: () => new Promise(() => undefined) });
    await armed(h);
    h.service.dispose();
    await flush();
    expect(settles[0]).toHaveBeenCalledTimes(1);
    expect(real.activeCount()).toBe(0);
  });

  it("dispose after the ping completed: runPing already settled, dispose adds nothing (exactly once)", async () => {
    const { ledger, real, settles } = spiedLedger();
    const h = harness({ ...childDeps(ledger), sendPipelinePing: scripted(provenHit).send });
    await armed(h);
    expect(settles[0]).toHaveBeenCalledTimes(1);
    h.service.dispose();
    await flush();
    expect(settles[0]).toHaveBeenCalledTimes(1);
    expect(real.activeCount()).toBe(0);
  });

  it("a still-unsettled physical transport keeps io-busy but never delays or duplicates the lease settle", async () => {
    const { ledger, real, settles } = spiedLedger();
    const sender = scripted(provenHit, { holdSettled: true });
    const h = harness({ ...childDeps(ledger), sendPipelinePing: sender.send });
    await armed(h);
    expect(h.service.report().ioBusy).toBe(true);
    expect(settles[0]).toHaveBeenCalledTimes(1); // logical outcome ⇒ settled once, IO still busy
    h.service.dispose();
    sender.releaseSettled();
    await flush();
    expect(settles[0]).toHaveBeenCalledTimes(1);
    expect(real.activeCount()).toBe(0);
  });

  it.each<[string, PipelineOutcome]>([
    ["not-sent", { kind: "not-sent", reason: "auth", diag: diagOf({ baseFetchCalls: 0 }) }],
    ["proven-write", provenWrite],
    ["http 400", { kind: "http", status: 400, diag: diagOf({ httpStatus: 400 }) }],
  ])("%s: exactly one settle on the normal path", async (_label, outcome) => {
    const { ledger, real, settles } = spiedLedger();
    const h = harness({ ...childDeps(ledger), sendPipelinePing: scripted(outcome).send });
    await armed(h);
    h.service.dispose();
    await flush();
    expect(settles[0]).toHaveBeenCalledTimes(1);
    expect(real.activeCount()).toBe(0);
  });
});

describe("capture → service (payload-only, strict P′ replaces P)", () => {
  it("a second noteRequest for the same turn (strict-tools P′) replaces the first capture and bumps the epoch; pings use the replacement body", async () => {
    const sender = scripted(provenHit);
    const { service, clock } = harness({ sendPipelinePing: sender.send });
    service.noteRequest(capture(service.instanceId, 30_000));
    const epochP = service.report().window.windowEpoch;
    service.noteRequest(capture(service.instanceId, 30_000, { tools: [{ name: "t", strict: true }] }));
    expect(service.report().window.windowEpoch).toBe(epochP + 1);
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]!.body.tools).toEqual([{ name: "t", strict: true }]);
    expect(sender.calls[0]!.body.max_tokens).toBe(1);
  });
});
