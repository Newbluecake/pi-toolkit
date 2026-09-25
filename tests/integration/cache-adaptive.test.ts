import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "./helpers/home-sandbox.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionStack } from "../../src/stack.js";
import { wireCacheTtl } from "../../src/cache-ttl/cache-ttl.js";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";

let homeSandbox: ReturnType<typeof sandboxHome> | undefined;
beforeEach(() => {
  homeSandbox = sandboxHome();
});
afterEach(() => {
  homeSandbox?.restore();
  homeSandbox = undefined;
});

/**
 * End-to-end wiring for the adaptive TTL decider: a real `buildSessionStack` +
 * `wireCacheTtl`, driven the way `index.ts` assembles them (holder read-through
 * `() => holder.current?.adaptive`). Covers the assembly seam the pure
 * `adaptive-state` unit tests cannot reach: the stack's injected `signals()`
 * closure (`query.list()` + `bashJobs.backgroundJobCount()`) and the
 * `adaptiveEnabled` gate.
 */

function fakePi() {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const pi = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage: () => undefined,
    appendEntry: vi.fn(),
    events: { on: () => () => undefined, emit: vi.fn() },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  };
  const emit = async (event: string, payload: unknown = {}, ctx: unknown = {}) => {
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
    return results;
  };
  return { pi: pi as unknown as ExtensionAPI, emit };
}

/**
 * The ledger entry carries `model: "claude-x"` so the M1 anchor
 * (`ledger.modelId === ctx.model.id`) can match — without it every request is
 * judged cold, which would hide the warm path from this test.
 */
function fakeCtx(ledgerModel: string | undefined = "claude-x"): ExtensionContext {
  return {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: false,
    sessionManager: {
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            ...(ledgerModel === undefined ? {} : { model: ledgerModel }),
            usage: { cacheRead: 300_000, cacheWrite: 4_000, input: 5, output: 5, cost: { total: 0 } },
          },
        },
      ],
      getSessionId: () => "session-under-test",
      getBranch: () => [],
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined, getApiKeyAndHeaders: vi.fn() },
    model: {
      provider: "anthropic",
      api: "anthropic-messages",
      id: "claude-x",
      baseUrl: "https://api.anthropic.com",
      headers: {},
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  } as unknown as ExtensionContext;
}

const emptyTypes = {
  get: () => undefined,
  list: () => [],
  reload: async () => ({ types: [], errors: [] }),
} as unknown as AgentTypeRegistry;

/**
 * Keepalive is OFF by default here: with it on, F1 (verification-2026-09-25)
 * refuses every new 1h prefix until the session has shown a gap beyond the ping
 * horizon, which would hide the adaptive-only machinery these tests pin. The
 * keepalive-on arbitration has its own test at the end of the file.
 */
function settingsWith(overrides: Partial<AgentSettings["cacheTtl"]> = {}): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    fleetWidget: false,
    cacheTtl: {
      ...DEFAULT_SETTINGS.cacheTtl,
      mode: "adaptive",
      adaptiveEnabled: true,
      keepalive: false,
      ...overrides,
    },
  };
}

function ephemeralPayload() {
  return {
    model: "claude-x",
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
    max_tokens: 512,
    stream: true,
  };
}

/**
 * `before_provider_request` returns `undefined` to mean "payload unchanged"
 * (passthrough), so an absent result is itself the no-ttl assertion.
 */
function ttlOf(result: unknown): unknown {
  const messages = (result as { messages?: { content?: { cache_control?: { ttl?: unknown } }[] }[] } | undefined)
    ?.messages;
  return messages?.[0]?.content?.[0]?.cache_control?.ttl;
}

describe("cache adaptive — real buildSessionStack + wireCacheTtl", () => {
  it("builds the service, injects live signals, and writes ttl:1h on an armed UI gate", async () => {
    const { pi, emit } = fakePi();
    const settings = settingsWith();
    const ctx = fakeCtx();
    const stack = buildSessionStack(pi, ctx, settings, emptyTypes, []);
    try {
      expect(stack.adaptive).toBeDefined();
      const holder: { current?: { adaptive?: typeof stack.adaptive } } = { current: stack };
      wireCacheTtl(pi, settings, { adaptive: () => holder.current?.adaptive });

      // Nothing armed: the injected closure reports all-zero (no runs, no bash
      // jobs) so the decider must decline rather than upgrade.
      const [idle] = await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      expect(ttlOf(idle)).toBeUndefined();
      expect(stack.adaptive?.snapshot().lastDecision?.reason).toBe("no-signal");

      // Arm the blocking UI gate exactly as index.ts's ui_prompt_start
      // forwarder would. The idle request above already recorded
      // `lastRequestStartedAt`, and the ledger is fresh (entrySeq beats the
      // invalidate watermark, modelId matches ctx.model.id), so this takes the
      // WARM branch — `episodeJustArmed` bypasses the refresh throttle.
      stack.adaptive?.noteUiPromptStart("session-under-test", stack.adaptive.instanceId);
      const [armed] = await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      expect(ttlOf(armed)).toBe("1h");

      const snap = stack.adaptive?.snapshot();
      expect(snap?.lastDecision?.upgrade).toBe(true);
      expect(snap?.lastDecision?.class).toBe("warm");
      expect(snap?.lastDecision?.signals).toContain("ui-gate");
      expect(snap?.warmUpgrades).toBe(1);
      expect(snap?.coldUpgradesUsed).toBe(0);
      expect(snap?.breaker).toBeUndefined();
    } finally {
      stack.adaptive?.dispose();
      stack.keepalive?.dispose();
      stack.scheduler.stop();
      stack.rpc.close();
    }
  });

  it("task #14: compact-hint's switchImminent reaches the decider through the stack wiring", async () => {
    const { pi, emit } = fakePi();
    const settings = settingsWith();
    const ctx = fakeCtx();
    const stack = buildSessionStack(pi, ctx, settings, emptyTypes, []);
    try {
      const holder: { current?: { adaptive?: typeof stack.adaptive } } = { current: stack };
      wireCacheTtl(pi, settings, { adaptive: () => holder.current?.adaptive });
      await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      stack.adaptive?.noteUiPromptStart("session-under-test", stack.adaptive.instanceId);

      // The same armed request that upgrades in the test above is refused while
      // compact-hint reports the prefix is about to be discarded (a pending handoff
      // counts regardless of usage; the stack's predicate reads it at request time).
      let pending = true;
      stack.compactHint.imminence = { hintPercent: 50, forcePercent: 88, handoffPending: () => pending };
      const [refused] = await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      expect(ttlOf(refused)).toBeUndefined();
      expect(stack.adaptive?.snapshot().lastDecision?.reason).toBe("switch-imminent");

      // Control: clearing the flag lets the still-armed gate upgrade (falsifiable).
      pending = false;
      const [armed] = await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      expect(ttlOf(armed)).toBe("1h");
    } finally {
      stack.adaptive?.dispose();
      stack.keepalive?.dispose();
      stack.scheduler.stop();
      stack.rpc.close();
    }
  });

  it("takes the COLD branch when the ledger fails the M1 model anchor", async () => {
    // A ledger whose entry carries no model id cannot be proven to describe the
    // current model's cache, so it must not be judged warm (that is exactly the
    // post-compact / post-model-switch trap M1 closes). The cold branch is
    // reachable here because an armed UI gate satisfies the horizon gate.
    const { pi, emit } = fakePi();
    const settings = settingsWith();
    const ctx = fakeCtx(undefined);
    const stack = buildSessionStack(pi, ctx, settings, emptyTypes, []);
    try {
      const holder: { current?: { adaptive?: typeof stack.adaptive } } = { current: stack };
      wireCacheTtl(pi, settings, { adaptive: () => holder.current?.adaptive });

      stack.adaptive?.noteUiPromptStart("session-under-test", stack.adaptive.instanceId);
      const [armed] = await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      expect(ttlOf(armed)).toBe("1h");

      const snap = stack.adaptive?.snapshot();
      expect(snap?.lastDecision?.class).toBe("cold");
      expect(snap?.coldUpgradesUsed).toBe(1);
      expect(snap?.warmUpgrades).toBe(0);
      expect(snap?.breaker).toBeUndefined();

      // The cold budget defaults to 1 per session, so an immediate second cold
      // request must be refused rather than paying 0.75P again.
      const [again] = await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      expect(ttlOf(again)).toBeUndefined();
      expect(stack.adaptive?.snapshot().coldUpgradesUsed).toBe(1);
    } finally {
      stack.adaptive?.dispose();
      stack.keepalive?.dispose();
      stack.scheduler.stop();
      stack.rpc.close();
    }
  });

  it("entry fee (plan.md §16.3): the first upgrade may rewrite the whole prefix without tripping; the second may not", async () => {
    // Field trace (audited session): warm upgrade Δ̂≈966 settles as
    // cacheRead=0 / cacheWrite=83139 / cacheWrite1h=83139 — the upstream honored
    // ttl:"1h" and rewrote the prefix because a 1h request does not read a
    // 5m-written entry. That is the entry fee, not a route pathology.
    const { pi, emit } = fakePi();
    const settings = settingsWith();
    const entries: unknown[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          model: "claude-x",
          usage: { cacheRead: 77_096, cacheWrite: 966, input: 5, output: 5, cost: { total: 0 } },
        },
      },
    ];
    const ctx = fakeCtx();
    (ctx as unknown as { sessionManager: { getEntries: () => unknown[] } }).sessionManager.getEntries = () => entries;
    const settle = (usage: Record<string, unknown>) =>
      entries.push({ type: "message", message: { role: "assistant", model: "claude-x", usage } });

    const stack = buildSessionStack(pi, ctx, settings, emptyTypes, []);
    try {
      const holder: { current?: { adaptive?: typeof stack.adaptive } } = { current: stack };
      wireCacheTtl(pi, settings, { adaptive: () => holder.current?.adaptive });
      const sid = "session-under-test";

      await emit("before_provider_request", { payload: ephemeralPayload() }, ctx); // records lastRequestStartedAt
      stack.adaptive?.noteUiPromptStart(sid, stack.adaptive.instanceId);

      // 1) The transition: upgraded, then settles as a full-prefix 1h rewrite.
      const [fee] = await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      expect(ttlOf(fee)).toBe("1h");
      settle({ cacheRead: 0, cacheWrite: 83_139, cacheWrite1h: 83_139, input: 5, output: 5, cost: { total: 0 } });
      await emit("turn_end", {}, ctx);

      let snap = stack.adaptive?.snapshot();
      expect(snap?.breaker).toBeUndefined(); // used to be `warm-miss` here
      expect(snap?.feeUpgrades).toBe(1);
      expect(snap?.feeWriteTokens).toBe(83_139);
      expect(snap?.upgradeWriteTokens).toBe(0);

      // 2) Steady state: the prefix is 1h-backed now, so the same shape IS a
      //    real violation and must still disable the session.
      //    16k = past the refresh throttle (16k) while the covered prediction
      //    tail + Δ = 16k + 16k stays within maxDeltaTokens (32k) — plan.md §18.
      settle({ cacheRead: 84_000, cacheWrite: 16_000, input: 5, output: 5, cost: { total: 0 } });
      await emit("turn_end", {}, ctx);
      const [second] = await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      expect(ttlOf(second)).toBe("1h");
      //    F5 (verification-2026-09-25): a COLLAPSED read here would be prefix
      //    drift, booked as another entry fee and not judged — the violation that
      //    must still trip is a covered 1h→1h settlement that READ the prefix yet
      //    wrote far beyond max(3 × (tail + Δ), floor) = 96k.
      settle({
        cacheRead: 100_000,
        cacheWrite: 120_000,
        cacheWrite1h: 120_000,
        input: 5,
        output: 5,
        cost: { total: 0 },
      });
      await emit("turn_end", {}, ctx);

      snap = stack.adaptive?.snapshot();
      expect(snap?.breaker?.reason).toBe("warm-write-too-expensive");

      // 3) `/reload` (field-2026-09-24 §3.1): session_start rebuilds the whole
      //    stack. The breaker and the spent fee budget are session-permanent, so
      //    the rebuilt service must rehydrate them from the audit entries this
      //    stack wrote — it used to start from zero and pay a fresh entry fee.
      const branch = vi
        .mocked(pi.appendEntry)
        .mock.calls.map(([customType, data]) => ({ type: "custom", customType, data }));
      (ctx as unknown as { sessionManager: { getBranch: () => unknown[] } }).sessionManager.getBranch = () => branch;
      const reloaded = buildSessionStack(pi, ctx, settings, emptyTypes, []);
      try {
        const after = reloaded.adaptive?.snapshot();
        expect(after?.breaker?.reason).toBe("warm-write-too-expensive");
        expect(after?.feeWriteTokens).toBe(snap?.feeWriteTokens); // identical to the pre-reload counters
        expect(after?.upgradeWriteTokens).toBe(snap?.upgradeWriteTokens);
        holder.current = reloaded;
        reloaded.adaptive?.noteUiPromptStart(sid, reloaded.adaptive.instanceId);
        const [again] = await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
        expect(ttlOf(again)).toBeUndefined(); // still refused after the rebuild
      } finally {
        reloaded.adaptive?.dispose();
        reloaded.keepalive?.dispose();
        reloaded.scheduler.stop();
        reloaded.rpc.close();
      }
    } finally {
      stack.adaptive?.dispose();
      stack.keepalive?.dispose();
      stack.scheduler.stop();
      stack.rpc.close();
    }
  });

  it("adaptiveEnabled:false leaves the service unbuilt and never writes a ttl", async () => {
    const { pi, emit } = fakePi();
    const settings = settingsWith({ adaptiveEnabled: false });
    const ctx = fakeCtx();
    const stack = buildSessionStack(pi, ctx, settings, emptyTypes, []);
    try {
      expect(stack.adaptive).toBeUndefined();
      const holder: { current?: { adaptive?: typeof stack.adaptive } } = { current: stack };
      wireCacheTtl(pi, settings, { adaptive: () => holder.current?.adaptive });

      // Even with a signal that WOULD arm the decider, the flag-off path must
      // behave like today's auto/on/off: no consultation, no ttl rewrite.
      const [result] = await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      expect(ttlOf(result)).toBeUndefined();
    } finally {
      stack.keepalive?.dispose();
      stack.scheduler.stop();
      stack.rpc.close();
    }
  });

  it("F1: with keepalive on, no new 1h prefix until a gap beyond the ping horizon; then keepalive stands down", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_000_000_000);
    const { pi, emit } = fakePi();
    const settings = settingsWith({ keepalive: true });
    const entries: unknown[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          model: "claude-x",
          usage: { cacheRead: 300_000, cacheWrite: 4_000, input: 5, output: 5, cost: { total: 0 } },
        },
      },
    ];
    const ctx = fakeCtx();
    (ctx as unknown as { sessionManager: { getEntries: () => unknown[] } }).sessionManager.getEntries = () => entries;
    const stack = buildSessionStack(pi, ctx, settings, emptyTypes, []);
    try {
      const holder: { current?: { adaptive?: typeof stack.adaptive } } = { current: stack };
      wireCacheTtl(pi, settings, { adaptive: () => holder.current?.adaptive });
      const sid = "session-under-test";
      // 11 pings × 240 s + one 300 s TTL = 49 min.
      expect(stack.keepalive?.gapHorizonMs()).toBe(2_940_000);

      stack.adaptive?.noteUiPromptStart(sid, stack.adaptive.instanceId);
      await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      vi.setSystemTime(Date.now() + 20_000);
      const [covered] = await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      expect(ttlOf(covered)).toBeUndefined();
      expect(stack.adaptive?.snapshot().lastDecision?.reason).toBe("keepalive-covers");

      // A 50-min gap: longer than any ping window can bridge. The request that
      // ENDS it is still refused (the ring learns the gap at this decision)...
      vi.setSystemTime(Date.now() + 50 * 60_000);
      const [afterGap] = await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      expect(ttlOf(afterGap)).toBeUndefined();
      // ...and the next one opens the prefix: the session has earned the fee.
      vi.setSystemTime(Date.now() + 20_000);
      const [opened] = await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      expect(ttlOf(opened)).toBe("1h");
      expect(stack.adaptive?.coversPrefix()).toBe(false); // unsettled

      entries.push({
        type: "message",
        message: {
          role: "assistant",
          model: "claude-x",
          usage: { cacheRead: 0, cacheWrite: 304_000, cacheWrite1h: 304_000, input: 5, output: 5, cost: { total: 0 } },
        },
      });
      await emit("turn_end", {}, ctx);
      // Settled + confirmed 1h + no tail ⇒ the keepalive dep sees a covered prefix.
      expect(stack.adaptive?.coversPrefix()).toBe(true);
    } finally {
      vi.useRealTimers();
      stack.adaptive?.dispose();
      stack.keepalive?.dispose();
      stack.scheduler.stop();
      stack.rpc.close();
    }
  });
});
