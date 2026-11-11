import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryActivitySnapshot } from "../../../src/memory/govern/activity.js";
import type { HumanDispatchBridge, HumanDispatchDeps } from "../../../src/web-hub/agent/human-dispatch-proof.js";
import {
  createHumanDispatchProof,
  createHumanDispatchHookOwner,
} from "../../../src/web-hub/agent/human-dispatch-proof.js";
import { createHumanTurnTracker } from "../../../src/memory/scopes/op-cap.js";
import type { MemoryOwner } from "../../../src/memory/scopes/types.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function fixture() {
  const owner: MemoryOwner = { incarnation: {}, sid: "activity", sessionEpoch: 1, branchGen: 1 };
  const tracker = createHumanTurnTracker();
  const state = { idle: true, pending: false, enabled: true };
  const ctx = { mode: "tui" as const, isIdle: () => state.idle, hasPendingMessages: () => state.pending };
  const deps: HumanDispatchDeps = { owner: () => owner, context: () => ctx, enabled: () => state.enabled, tracker };
  const proof = createHumanDispatchProof(deps);
  return { owner, tracker, state, ctx, deps, proof, activity: proof.activity! };
}

afterEach(() => vi.restoreAllMocks());

describe("human dispatch proof activity owner", () => {
  it("publishes the canonical snapshot and advances time on input, never on snapshot reads", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    const f = fixture();
    expect(f.activity.snapshot(100)).toEqual({
      generation: 0,
      lastActivityAt: 100,
      running: false,
      toolsInFlight: 0,
      liveIdle: true,
      hasPendingMessages: false,
    });
    now.mockReturnValue(200);
    expect(f.proof.onInput({ source: "interactive" })).toBeUndefined();
    const after = f.activity.snapshot(200);
    expect(after.lastActivityAt).toBe(200);
    expect(after.generation).toBe(1);
    now.mockReturnValue(300);
    expect(f.activity.snapshot(300)).toEqual(after);
    f.proof.dispose();
  });

  it("publishes once after each lifecycle hook with final running state and timestamp", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    const f = fixture();
    const observed: MemoryActivitySnapshot[] = [];
    const unsubscribe = f.activity.subscribe!(() => observed.push(f.activity.snapshot(Date.now())));
    expect(observed).toEqual([]);
    now.mockReturnValue(200);
    f.proof.onInput({ source: "interactive" });
    now.mockReturnValue(300);
    f.proof.onBeforeAgentStart({ messageType: "user" });
    now.mockReturnValue(400);
    f.proof.onAgentStart();
    now.mockReturnValue(500);
    f.proof.onSettled();
    expect(
      observed.map(({ running, lastActivityAt, generation }) => ({ running, lastActivityAt, generation })),
    ).toEqual([
      { running: false, lastActivityAt: 200, generation: 1 },
      { running: true, lastActivityAt: 300, generation: 1 },
      { running: true, lastActivityAt: 400, generation: 1 },
      { running: false, lastActivityAt: 500, generation: 2 },
    ]);
    unsubscribe();
    unsubscribe();
    f.proof.onInput({ source: "extension" });
    f.proof.onAgentStart();
    f.proof.onSettled();
    expect(observed).toHaveLength(4);
    f.proof.dispose();
  });

  it("tracks calls idempotently, keeps long tools across settlement and recognizes duplicate results", () => {
    const f = fixture();
    const listener = vi.fn();
    f.activity.subscribe!(listener);
    f.activity.noteToolCall("long", 100);
    f.activity.noteToolCall("long", 100);
    f.activity.noteToolCall("other", 100);
    expect(f.activity.snapshot(100).toolsInFlight).toBe(2);
    f.proof.onAgentStart();
    expect(f.activity.snapshot(100).running).toBe(true);
    f.proof.onSettled();
    expect(f.activity.snapshot(100)).toMatchObject({ running: false, toolsInFlight: 2 });
    f.activity.noteToolResult("long", 100);
    f.activity.noteToolResult("long", 100);
    expect(f.activity.snapshot(100)).toMatchObject({ toolsInFlight: 1, liveIdle: true });
    f.activity.noteToolResult("other", 100);
    expect(f.activity.snapshot(100)).toMatchObject({ toolsInFlight: 0, liveIdle: true });
    expect(listener).toHaveBeenCalledTimes(8);
    f.proof.dispose();
  });

  it("unknown result is sticky fail-closed, including after ordinary input and settlement", () => {
    const f = fixture();
    f.activity.noteToolCall("known", 100);
    f.activity.noteToolResult("unassociated", 100);
    expect(f.activity.snapshot(100)).toMatchObject({ toolsInFlight: 1, liveIdle: undefined });
    f.activity.noteToolResult("known", 100);
    f.proof.onInput({ source: "interactive" });
    f.proof.onBeforeAgentStart({ messageType: "user" });
    f.proof.onSettled();
    expect(f.activity.snapshot(100)).toMatchObject({ toolsInFlight: 0, running: false, liveIdle: undefined });
    // No invented wire field: the canonical type encodes unknown through liveIdle.
    expect(Object.keys(f.activity.snapshot(100)).sort()).toEqual([
      "generation",
      "hasPendingMessages",
      "lastActivityAt",
      "liveIdle",
      "running",
      "toolsInFlight",
    ]);
    f.proof.dispose();
  });

  it("bounds completed IDs; an evicted late result fails closed instead of guessing idle", () => {
    const f = fixture();
    for (let i = 0; i < 257; i++) {
      f.activity.noteToolCall(String(i), 100);
      f.activity.noteToolResult(String(i), 100);
    }
    f.activity.noteToolResult("256", 100);
    expect(f.activity.snapshot(100).liveIdle).toBe(true);
    f.activity.noteToolResult("0", 100);
    expect(f.activity.snapshot(100)).toMatchObject({ toolsInFlight: 0, liveIdle: undefined });
    f.proof.dispose();
  });

  it("re-reads live context without advancing activity time", () => {
    const f = fixture();
    const before = f.activity.snapshot(100);
    f.state.idle = false;
    f.state.pending = true;
    expect(f.activity.snapshot(200)).toEqual({ ...before, liveIdle: false, hasPendingMessages: true });
    f.deps.context = () => ({ mode: "rpc", isIdle: () => true, hasPendingMessages: () => false });
    expect(f.activity.snapshot(300)).toEqual(before);
    f.proof.dispose();
  });

  it.each(["missing-context", "context-throw", "missing-method", "method-throw", "invalid-result", "disabled"])(
    "%s is unknown, not evidence of idle",
    (failure) => {
      const f = fixture();
      if (failure === "missing-context") f.deps.context = () => undefined;
      if (failure === "context-throw")
        f.deps.context = () => {
          throw new Error("stale");
        };
      if (failure === "missing-method") {
        f.ctx.isIdle = undefined as never;
        f.ctx.hasPendingMessages = undefined as never;
      }
      if (failure === "method-throw") {
        f.ctx.isIdle = () => {
          throw new Error("stale");
        };
        f.ctx.hasPendingMessages = () => {
          throw new Error("stale");
        };
      }
      if (failure === "invalid-result") {
        f.ctx.isIdle = () => 1 as never;
        f.ctx.hasPendingMessages = () => 0 as never;
      }
      if (failure === "disabled") f.state.enabled = false;
      expect(f.activity.snapshot(100)).toMatchObject({ liveIdle: undefined, hasPendingMessages: undefined });
      f.proof.dispose();
    },
  );

  it("recorder activity invalidates same-ms leases without invalidating the human turn", () => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    const f = fixture();
    f.proof.onInput({ source: "interactive" });
    f.proof.onBeforeAgentStart({ messageType: "user" });
    const turn = f.tracker.current();
    expect(turn?.channel).toBe("tui");
    const invalidate = vi.spyOn(f.tracker, "invalidate");
    const listener = vi.fn();
    f.activity.subscribe!(listener);
    const snapshots = [f.activity.snapshot(100)];
    f.activity.noteToolCall("same-ms", 100);
    snapshots.push(f.activity.snapshot(100));
    f.activity.noteToolResult("same-ms", 100);
    snapshots.push(f.activity.snapshot(100));
    f.activity.noteMemoryWrite(100);
    snapshots.push(f.activity.snapshot(100));
    expect(snapshots.map((s) => s.lastActivityAt)).toEqual([100, 100, 100, 100]);
    expect(snapshots.map((s) => s.generation)).toEqual([1, 2, 3, 4]);
    expect(f.tracker.current()).toBe(turn);
    expect(invalidate).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(3);
    f.proof.dispose();
  });

  it.each(["session", "tree", "shutdown"] as const)("%s revocation notifies after invalidation", (reason) => {
    const f = fixture();
    const snapshots: MemoryActivitySnapshot[] = [];
    f.activity.subscribe!(() => snapshots.push(f.activity.snapshot(100)));
    f.proof.revoke(reason);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ generation: 1, liveIdle: reason === "shutdown" ? undefined : true });
    f.proof.dispose();
  });

  it("initial session_start revocation does not poison the newly-opened owner", () => {
    const f = fixture();
    const on = vi.fn();
    createHumanDispatchHookOwner(f.proof)({ on } as unknown as ExtensionAPI);
    // Scopes opens the new owner BEFORE the proof's session_start hook runs.
    on.mock.calls.find(([name]) => name === "session_start")![1]();
    expect(f.activity.snapshot(100)).toMatchObject({ generation: 1, liveIdle: true });
    f.proof.onInput({ source: "interactive" });
    f.proof.onBeforeAgentStart({ messageType: "user" });
    expect(f.tracker.current()?.channel).toBe("tui");
    f.proof.onSettled();
    expect(f.activity.snapshot(100)).toMatchObject({ running: false, toolsInFlight: 0, liveIdle: true });
    f.proof.dispose();
  });

  it("isolates listener errors and retires subscriptions after disposed state is visible", () => {
    const f = fixture();
    const snapshots: MemoryActivitySnapshot[] = [];
    f.activity.subscribe!(() => {
      throw new Error("observer failed");
    });
    f.activity.subscribe!(() => snapshots.push(f.activity.snapshot(100)));
    f.proof.onAgentStart();
    f.proof.settled(f.owner);
    expect(snapshots.map((s) => s.running)).toEqual([true, false]);
    f.proof.dispose();
    expect(snapshots[2]).toMatchObject({ liveIdle: undefined, hasPendingMessages: undefined });
    f.proof.onSettled();
    f.activity.noteMemoryWrite(100);
    f.activity.subscribe!(() => snapshots.push(f.activity.snapshot(100)));
    f.proof.dispose();
    expect(snapshots).toHaveLength(3);
  });

  it("does not add or reorder SDK hooks", () => {
    const f = fixture();
    const on = vi.fn();
    createHumanDispatchHookOwner(f.proof)({ on } as unknown as ExtensionAPI);
    expect(on.mock.calls.map(([name]) => name)).toEqual([
      "input",
      "before_agent_start",
      "agent_start",
      "agent_end",
      "agent_settled",
      "session_start",
      "session_tree",
      "session_shutdown",
    ]);
    f.proof.dispose();
  });
});

/** Legacy callers need neither supply nor read activity. The complete non-activity
 * return/authority transcript is pinned, and optional reads cannot alter it. */
function legacyTranscript(readActivity: boolean): string {
  const f = fixture();
  const returns: unknown[] = [];
  const observe = <T>(value: T): T => {
    returns.push(value === undefined ? "undefined" : value);
    if (readActivity) f.proof.activity?.snapshot(Date.now());
    return value;
  };
  const turn = () => observe(f.tracker.current()?.channel);
  observe(f.proof.onInput({ source: "interactive" }));
  turn();
  observe(f.proof.onBeforeAgentStart({ messageType: "user" }));
  turn();
  observe(f.proof.onAgentStart());
  observe(f.proof.onSettled());
  turn();
  const origin = { listener: "loopback" as const, ip: "127.0.0.1", reqId: "legacy" };
  observe(
    f.proof.dispatchWeb("cmd", origin, () => {
      observe(f.proof.onInput({ source: "extension" }));
      observe(f.proof.onBeforeAgentStart({ messageType: "user" }));
      turn();
      return 37;
    }),
  );
  observe(f.proof.settled(f.owner));
  turn();
  const token = f.proof.claim(f.owner, { source: "interactive" });
  observe(token === undefined ? "missing" : "opaque-token");
  observe(f.proof.confirmStart(token!, f.owner)?.channel);
  observe(f.proof.revoke("abort"));
  turn();
  observe(f.proof.onInput({ source: "rpc" }));
  observe(f.proof.onBeforeAgentStart({ messageType: "custom" }));
  turn();
  observe(f.proof.dispose());
  turn();
  return JSON.stringify(returns);
}

it("legacy return values and authority transcript remain byte-identical without consuming activity", () => {
  const expected =
    '["undefined","undefined","undefined","tui","undefined","undefined","undefined","undefined","undefined","web",37,"undefined","undefined","opaque-token","tui","undefined","undefined","undefined","undefined","undefined","undefined","undefined"]';
  expect(legacyTranscript(false)).toBe(expected);
  expect(legacyTranscript(true)).toBe(expected);
  // Structural compatibility: old bridge implementations need not publish activity.
  const optional: Pick<HumanDispatchBridge, "activity"> = {};
  expect(optional.activity).toBeUndefined();
});
