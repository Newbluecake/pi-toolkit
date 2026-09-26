import { describe, expect, it, vi } from "vitest";
import {
  CHILD_CACHE_KEEPALIVE_CUSTOM_TYPE,
  CHILD_SWITCH_CAPABILITY_CUSTOM_TYPE,
  CHILD_SWITCH_CONTEXT_SOURCE,
  CHILD_SWITCH_REJECTED_CUSTOM_TYPE,
  CHILD_SWITCH_SELFCHECK_CUSTOM_TYPE,
  mapContextUsage,
  mapEvent,
  PiSessionDriver,
  PiSessionHandle,
} from "../../src/runtime/session-driver.js";

/**
 * Regression: pi's Usage carries cost as nested `cost.total`, not a flat
 * `costUsd`. Passing the raw object through left `costUsd` undefined and
 * `base + undefined` poisoned the lifetime accumulator with NaN — the fleet
 * widget rendered "$NaN". mapEvent must map + clamp at the boundary.
 */
describe("session-driver mapEvent: usage mapping (pi Usage → UsageDelta)", () => {
  it("maps a full pi usage object, flattening cost.total into costUsd", () => {
    const ev = mapEvent({
      type: "message_end",
      message: {
        usage: {
          input: 10,
          output: 5,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 18,
          cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
        },
      },
    });
    expect(ev).toEqual({
      t: "message_end",
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, costUsd: 0.003 },
    });
  });

  it("clamps a missing cost object to costUsd 0 instead of NaN", () => {
    const ev = mapEvent({ type: "message_end", message: { usage: { input: 3, output: 1 } } });
    expect(ev).toEqual({
      t: "message_end",
      usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
    });
  });

  it("clamps non-finite provider fields (NaN/undefined) to 0", () => {
    const ev = mapEvent({
      type: "message_end",
      message: {
        usage: {
          input: Number.NaN,
          output: undefined,
          cacheRead: 1,
          cacheWrite: 0,
          cost: { total: Number.POSITIVE_INFINITY },
        },
      },
    });
    expect(ev).toEqual({
      t: "message_end",
      usage: { input: 0, output: 0, cacheRead: 1, cacheWrite: 0, costUsd: 0 },
    });
  });

  it("omits usage entirely when the message carries none", () => {
    for (const raw of [{ type: "message_end", message: {} }, { type: "message_end" }]) {
      const ev = mapEvent(raw);
      expect(ev).toEqual({ t: "message_end" });
      expect(ev && "usage" in ev).toBe(false);
    }
  });
});

describe("session-driver context usage mapping", () => {
  it("validates and normalizes context usage", () => {
    expect(mapContextUsage({ tokens: 12, contextWindow: 262_144, percent: 12.34 })).toEqual({
      tokens: 12,
      contextWindow: 262_144,
      percent: 12.34,
    });
    expect(mapContextUsage({ tokens: null, contextWindow: 262_144, percent: null })).toEqual({
      tokens: null,
      contextWindow: 262_144,
      percent: null,
    });
    expect(mapContextUsage({ tokens: -1, contextWindow: 262_144, percent: 120 })).toEqual({
      tokens: null,
      contextWindow: 262_144,
      percent: 100,
    });
    expect(mapContextUsage({ tokens: Number.NaN, contextWindow: 262_144, percent: -5 })).toEqual({
      tokens: null,
      contextWindow: 262_144,
      percent: 0,
    });
    for (const value of [0, -1, Number.NaN, undefined])
      expect(mapContextUsage({ tokens: 1, contextWindow: value, percent: 1 })).toBeUndefined();
  });

  it("samples after message_end and compaction_end", async () => {
    let subscribe: ((event: unknown) => void) | undefined;
    const getContextUsage = vi.fn(() => ({ tokens: 32_768, contextWindow: 262_144, percent: 12.5 }));
    const handle = { session: { subscribe: (cb: (event: unknown) => void) => (subscribe = cb), getContextUsage } };
    const events: unknown[] = [];
    await new PiSessionDriver().bind(handle as never, (event) => events.push(event));
    subscribe?.({ type: "message_end" });
    subscribe?.({ type: "compaction_end", aborted: false });
    expect(getContextUsage).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      { t: "message_end" },
      { t: "context_usage", usage: { tokens: 32_768, contextWindow: 262_144, percent: 12.5 } },
      { t: "compaction_end", aborted: false },
      { t: "context_usage", usage: { tokens: 32_768, contextWindow: 262_144, percent: 12.5 } },
    ]);
  });

  it("disables sampling once capability is absent or throws", async () => {
    for (const hasCapability of [false, true]) {
      let subscribe: ((event: unknown) => void) | undefined;
      const getContextUsage = hasCapability
        ? vi.fn(() => {
            throw new Error("x");
          })
        : undefined;
      const session = {
        subscribe: (cb: (event: unknown) => void) => (subscribe = cb),
        ...(getContextUsage === undefined ? {} : { getContextUsage }),
      };
      const events: unknown[] = [];
      await new PiSessionDriver().bind({ session } as never, (event) => events.push(event));
      subscribe?.({ type: "message_end" });
      subscribe?.({ type: "compaction_end", aborted: false });
      expect(events.map((event) => (event as { t: string }).t)).toEqual(["message_end", "compaction_end"]);
      if (getContextUsage) expect(getContextUsage).toHaveBeenCalledTimes(1);
    }
  });
});

describe("session-driver mapEvent: message_update streaming (assistantMessageEvent)", () => {
  it("maps thinking_delta to a thinking_delta driver event", () => {
    const ev = mapEvent({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "let me" }] },
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "let me" },
    });
    expect(ev).toEqual({ t: "thinking_delta", delta: "let me" });
  });

  it("maps text_delta to a text_delta driver event (block-array content never matches the legacy string check)", () => {
    const ev = mapEvent({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
    });
    expect(ev).toEqual({ t: "text_delta", delta: "hello" });
  });

  it("ignores non-delta assistant events (thinking_start/text_end/toolcall_delta…)", () => {
    for (const ae of [
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_end", contentIndex: 0, content: "done" },
      { type: "text_start", contentIndex: 0 },
      { type: "toolcall_delta", contentIndex: 0, delta: "{}" },
    ]) {
      const ev = mapEvent({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: ae,
      });
      expect(ev).toBeUndefined();
    }
  });

  it("keeps the legacy plain-string content fallback (non-assistant messages)", () => {
    const ev = mapEvent({ type: "message_update", message: { content: "plain" } });
    expect(ev).toEqual({ t: "text_delta", delta: "plain" });
  });
});

/**
 * child-context-switch plan P0 (§2.3.1, T-F4): pi's own automatic compaction
 * failing is surfaced two ways — the mapped `compaction_end` event itself
 * carries `failed: true`, and `bind()` emits an additional `compaction_failed`
 * diagnostic event right after it, carrying pi's raw reason/message. Neither
 * happens for an aborted compaction (a cancellation, not a failure) even if
 * pi also set errorMessage on it.
 */
describe("session-driver mapEvent/bind: compaction_end failure diagnostics (T-F4)", () => {
  it("maps a successful compaction_end without a failed flag", () => {
    expect(mapEvent({ type: "compaction_end", aborted: false })).toEqual({ t: "compaction_end", aborted: false });
  });

  it("maps a failed (non-aborted) compaction_end with failed:true", () => {
    expect(mapEvent({ type: "compaction_end", aborted: false, errorMessage: "boom" })).toEqual({
      t: "compaction_end",
      aborted: false,
      failed: true,
    });
  });

  it("never sets failed on an aborted compaction, even with an errorMessage", () => {
    expect(mapEvent({ type: "compaction_end", aborted: true, errorMessage: "boom" })).toEqual({
      t: "compaction_end",
      aborted: true,
    });
  });

  it("bind() emits a companion compaction_failed event only for a failed (non-aborted) compaction_end", async () => {
    let subscribe: ((event: unknown) => void) | undefined;
    const session = { subscribe: (cb: (event: unknown) => void) => (subscribe = cb) };
    const events: unknown[] = [];
    await new PiSessionDriver().bind({ session } as never, (event) => events.push(event));
    subscribe?.({ type: "compaction_end", aborted: false, reason: "overflow", errorMessage: "recovery failed" });
    expect(events).toEqual([
      { t: "compaction_end", aborted: false, failed: true },
      { t: "compaction_failed", reason: "overflow", message: "recovery failed" },
    ]);
  });

  it("bind() emits no compaction_failed for an aborted compaction", async () => {
    let subscribe: ((event: unknown) => void) | undefined;
    const session = { subscribe: (cb: (event: unknown) => void) => (subscribe = cb) };
    const events: unknown[] = [];
    await new PiSessionDriver().bind({ session } as never, (event) => events.push(event));
    subscribe?.({ type: "compaction_end", aborted: true, errorMessage: "cancelled mid-flight" });
    expect(events).toEqual([{ t: "compaction_end", aborted: true }]);
  });

  it("bind() emits no compaction_failed for a successful compaction_end", async () => {
    let subscribe: ((event: unknown) => void) | undefined;
    const session = { subscribe: (cb: (event: unknown) => void) => (subscribe = cb) };
    const events: unknown[] = [];
    await new PiSessionDriver().bind({ session } as never, (event) => events.push(event));
    subscribe?.({ type: "compaction_end", aborted: false });
    expect(events).toEqual([{ t: "compaction_end", aborted: false }]);
  });
});

/**
 * child-context-switch plan P0 (§2.1 step 2 / §2.3.1 point 4 / §2.4, T-K5):
 * `entry_appended` recognition for the three shapes written by other
 * packages' child-session extensions.
 */
describe("session-driver mapEvent: entry_appended (T-K5, boundary-draft switch/selfcheck/capability/keepalive)", () => {
  it("maps a committed boundary-draft switch_context compaction to context_switch", () => {
    const ev = mapEvent({
      type: "entry_appended",
      entry: {
        type: "compaction",
        id: "e9",
        fromHook: true,
        details: {
          source: CHILD_SWITCH_CONTEXT_SOURCE,
          seq: 2,
          keepRecent: true,
          dropped: { fromEntryId: "e3", toEntryId: "e8", entries: 5, tokensBefore: 1000, tokensAfterEstimate: 200 },
        },
      },
    });
    expect(ev).toEqual({
      t: "context_switch",
      seq: 2,
      keepRecent: true,
      dropped: { fromEntryId: "e3", toEntryId: "e8", entries: 5, tokensBefore: 1000, tokensAfterEstimate: 200 },
    });
  });

  it("ignores a compaction entry from someone else's source, or one that is not fromHook", () => {
    expect(
      mapEvent({
        type: "entry_appended",
        entry: { type: "compaction", id: "e1", fromHook: true, details: { source: "someone-else" } },
      }),
    ).toBeUndefined();
    expect(
      mapEvent({
        type: "entry_appended",
        entry: { type: "compaction", id: "e1", details: { source: CHILD_SWITCH_CONTEXT_SOURCE } },
      }),
    ).toBeUndefined();
  });

  it("maps a failed self-check custom entry to switch_selfcheck_failed", () => {
    const ev = mapEvent({
      type: "entry_appended",
      entry: {
        type: "custom",
        id: "e1",
        customType: CHILD_SWITCH_SELFCHECK_CUSTOM_TYPE,
        data: { ok: false, reason: "run-ended-after-switch" },
      },
    });
    expect(ev).toEqual({ t: "switch_selfcheck_failed", reason: "run-ended-after-switch" });
  });

  it("ignores a self-check entry that is not ok:false", () => {
    expect(
      mapEvent({
        type: "entry_appended",
        entry: { type: "custom", id: "e1", customType: CHILD_SWITCH_SELFCHECK_CUSTOM_TYPE, data: { ok: true } },
      }),
    ).toBeUndefined();
  });

  it("maps a capability custom entry to switch_capability", () => {
    const ev = mapEvent({
      type: "entry_appended",
      entry: {
        type: "custom",
        id: "e1",
        customType: CHILD_SWITCH_CAPABILITY_CUSTOM_TYPE,
        data: { reason: "l1-event-shape" },
      },
    });
    expect(ev).toEqual({ t: "switch_capability", reason: "l1-event-shape" });
  });

  it("maps a rejected custom entry to context_switch_rejected (P3 acceptance follow-up)", () => {
    const ev = mapEvent({
      type: "entry_appended",
      entry: {
        type: "custom",
        id: "e1",
        customType: CHILD_SWITCH_REJECTED_CUSTOM_TYPE,
        data: { reason: "unpersisted" },
      },
    });
    expect(ev).toEqual({ t: "context_switch_rejected", reason: "unpersisted" });
  });

  it("defaults a rejected entry's missing reason to 'unknown'", () => {
    const ev = mapEvent({
      type: "entry_appended",
      entry: { type: "custom", id: "e1", customType: CHILD_SWITCH_REJECTED_CUSTOM_TYPE, data: {} },
    });
    expect(ev).toEqual({ t: "context_switch_rejected", reason: "unknown" });
  });

  it("maps a cache-keepalive audit entry with costUsd>0 to a message_end usage delta", () => {
    const ev = mapEvent({
      type: "entry_appended",
      entry: {
        type: "custom",
        id: "e1",
        customType: CHILD_CACHE_KEEPALIVE_CUSTOM_TYPE,
        data: { costUsd: 0.05, cacheReadTokens: 200_000, cacheWriteTokens: 0, budgetChargeUsd: 0.05 },
      },
    });
    expect(ev).toEqual({
      t: "message_end",
      usage: { input: 0, output: 0, cacheRead: 200_000, cacheWrite: 0, costUsd: 0.05 },
    });
  });

  it("does not map a keepalive audit entry with no (or zero) costUsd — an unproven ping's budgetChargeUsd never enters usage", () => {
    expect(
      mapEvent({
        type: "entry_appended",
        entry: {
          type: "custom",
          id: "e1",
          customType: CHILD_CACHE_KEEPALIVE_CUSTOM_TYPE,
          data: { budgetChargeUsd: 0.02 },
        },
      }),
    ).toBeUndefined();
    expect(
      mapEvent({
        type: "entry_appended",
        entry: { type: "custom", id: "e1", customType: CHILD_CACHE_KEEPALIVE_CUSTOM_TYPE, data: { costUsd: 0 } },
      }),
    ).toBeUndefined();
  });

  it("ignores unrelated entry_appended shapes (other custom entries, plain non-hook compactions)", () => {
    expect(
      mapEvent({ type: "entry_appended", entry: { type: "custom", id: "e1", customType: "some:other-thing" } }),
    ).toBeUndefined();
    expect(mapEvent({ type: "entry_appended", entry: { type: "message", id: "e1" } })).toBeUndefined();
    expect(mapEvent({ type: "entry_appended", entry: null })).toBeUndefined();
  });

  it("bind() resamples context_usage after a committed context_switch, same as message_end/compaction_end", async () => {
    let subscribe: ((event: unknown) => void) | undefined;
    const getContextUsage = vi.fn(() => ({ tokens: 1_000, contextWindow: 262_144, percent: 0.4 }));
    const session = { subscribe: (cb: (event: unknown) => void) => (subscribe = cb), getContextUsage };
    const events: unknown[] = [];
    await new PiSessionDriver().bind({ session } as never, (event) => events.push(event));
    subscribe?.({
      type: "entry_appended",
      entry: {
        type: "compaction",
        id: "e9",
        fromHook: true,
        details: {
          source: CHILD_SWITCH_CONTEXT_SOURCE,
          seq: 1,
          keepRecent: false,
          dropped: { fromEntryId: "e1", toEntryId: "e5", entries: 3, tokensBefore: 500, tokensAfterEstimate: 50 },
        },
      },
    });
    expect(events.map((e) => (e as { t: string }).t)).toEqual(["context_switch", "context_usage"]);
    expect(getContextUsage).toHaveBeenCalledTimes(1);
  });
});

/**
 * child-context-switch plan P0 (§2.3.1 v3.1): PiSessionHandle.getSwitchTail()
 * is the runner's settlement fallback self-check — a synchronous, read-only
 * scan of the persisted branch that does not depend on any event forwarding.
 */
describe("PiSessionHandle.getSwitchTail (§2.3.1 v3.1 runner settlement fallback)", () => {
  function handleWithBranch(branch: readonly Record<string, unknown>[]): PiSessionHandle {
    const session = {
      sessionId: "s1",
      sessionFile: undefined,
      sessionManager: { getBranch: () => branch },
    };
    return new PiSessionHandle(session as never);
  }

  it("returns undefined when no switch_context compaction is on the branch", () => {
    const h = handleWithBranch([{ type: "message", id: "e1", message: { role: "user" } }]);
    expect(h.getSwitchTail()).toBeUndefined();
  });

  it("reports assistantAfter:false right after a committed switch with nothing following", () => {
    const h = handleWithBranch([
      { type: "message", id: "e1", message: { role: "user" } },
      {
        type: "compaction",
        id: "e2",
        fromHook: true,
        details: { source: CHILD_SWITCH_CONTEXT_SOURCE, seq: 3 },
      },
      { type: "custom_message", id: "e3" },
    ]);
    expect(h.getSwitchTail()).toEqual({ seq: 3, entryId: "e2", assistantAfter: false });
  });

  it("reports assistantAfter:true once an assistant message entry follows", () => {
    const h = handleWithBranch([
      { type: "compaction", id: "e2", fromHook: true, details: { source: CHILD_SWITCH_CONTEXT_SOURCE, seq: 1 } },
      { type: "custom_message", id: "e3" },
      { type: "message", id: "e4", message: { role: "assistant", content: [] } },
    ]);
    expect(h.getSwitchTail()).toEqual({ seq: 1, entryId: "e2", assistantAfter: true });
  });

  it("uses the LAST matching compaction on the branch when there is more than one", () => {
    const h = handleWithBranch([
      { type: "compaction", id: "e1", fromHook: true, details: { source: CHILD_SWITCH_CONTEXT_SOURCE, seq: 1 } },
      { type: "message", id: "e2", message: { role: "assistant", content: [] } },
      { type: "compaction", id: "e5", fromHook: true, details: { source: CHILD_SWITCH_CONTEXT_SOURCE, seq: 2 } },
    ]);
    expect(h.getSwitchTail()).toEqual({ seq: 2, entryId: "e5", assistantAfter: false });
  });

  it("ignores a compaction that is not ours (different source, or pi's own non-hook compaction)", () => {
    const h = handleWithBranch([
      { type: "compaction", id: "e1", fromHook: true, details: { source: "someone-else" } },
      { type: "compaction", id: "e2" },
    ]);
    expect(h.getSwitchTail()).toBeUndefined();
  });
});
