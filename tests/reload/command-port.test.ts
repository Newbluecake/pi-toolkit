import { afterEach, describe, expect, it, vi } from "vitest";
import { createReloadCommandPort, RELOAD_SETTLE_MS } from "../../src/reload/command-port.js";
import { consumeReloadContinue } from "../../src/reload/continue.js";
import { DeferredReloadController } from "../../src/reload/defer.js";

function harness(mode = "tui") {
  const ctl = new DeferredReloadController({ fire: vi.fn() });
  ctl.arm(1);
  const state = { idle: false };
  const calls: string[] = [];
  const sendMessage = vi.fn();
  const ctx = {
    mode,
    isIdle: () => state.idle,
    hasPendingMessages: () => false,
    abort: vi.fn(() => {
      calls.push("abort");
    }),
    waitForIdle: vi.fn(async () => {
      expect(ctl.pending).toBe(true);
      calls.push("idle");
      state.idle = true;
    }),
    reload: vi.fn(async () => {
      expect(ctl.pending).toBe(false);
      if (mode === "tui") expect(state.idle).toBe(true);
      calls.push("reload");
    }),
    sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/tmp/s1.jsonl" },
    ui: { notify: vi.fn() },
  };
  const port = createReloadCommandPort(() => ctl, { sendMessage });
  return { ctx, ctl, state, calls, port, sendMessage };
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:reload-continue")];
});

describe("explicit now/force TUI reload streaming guard", () => {
  it("aborts and settles the active TUI turn before reload, preserving its interruption", async () => {
    const h = harness();
    await h.port.reload(h.ctx as never);
    expect(h.calls).toEqual(["abort", "idle", "reload"]);
    expect(h.ctx.reload).toHaveBeenCalledTimes(1);
    expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(true);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("bounds a hanging idle wait, retains admission gate and writes no handoff", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.ctx.waitForIdle.mockImplementation(() => new Promise(() => undefined));
    const reloading = h.port.reload(h.ctx as never);
    await vi.advanceTimersByTimeAsync(RELOAD_SETTLE_MS - 1);
    expect(h.ctx.reload).not.toHaveBeenCalled();
    expect(h.ctx.ui.notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await reloading;
    expect(h.ctx.reload).not.toHaveBeenCalled();
    expect(h.ctl.pending).toBe(true);
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("within 5s"), "warning");
    expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not call reload when idle wait rejects", async () => {
    const h = harness();
    h.ctx.waitForIdle.mockRejectedValue(new Error("settle error"));
    await h.port.reload(h.ctx as never);
    expect(h.ctx.reload).not.toHaveBeenCalled();
    expect(h.ctl.pending).toBe(true);
    expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(false);
  });

  it("rechecks streaming after an idle wait that did not settle", async () => {
    const h = harness();
    h.ctx.waitForIdle.mockResolvedValue(undefined);
    await h.port.reload(h.ctx as never);
    expect(h.ctx.reload).not.toHaveBeenCalled();
    expect(h.ctl.pending).toBe(true);
    expect(h.ctx.ui.notify).toHaveBeenCalledTimes(1);
  });

  it("cancellation during the wait prevents reload and leaves no continuation marker", async () => {
    const h = harness();
    h.ctx.waitForIdle.mockImplementation(async () => {
      h.port.cancel(h.ctx as never);
      h.state.idle = true;
    });
    await h.port.reload(h.ctx as never);
    expect(h.ctx.reload).not.toHaveBeenCalled();
    expect(h.ctl.pending).toBe(false);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(false);
  });

  it("idle TUI reload does not abort or wait and does not mark clean work", async () => {
    const h = harness();
    h.state.idle = true;
    await h.port.reload(h.ctx as never);
    expect(h.ctx.abort).not.toHaveBeenCalled();
    expect(h.ctx.waitForIdle).not.toHaveBeenCalled();
    expect(h.ctx.reload).toHaveBeenCalledTimes(1);
    expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(false);
  });

  it.each(["rpc"])("%s uses its own available reload API without TUI settling", async (mode) => {
    const h = harness(mode);
    await h.port.reload(h.ctx as never);
    expect(h.ctx.abort).not.toHaveBeenCalled();
    expect(h.ctx.waitForIdle).not.toHaveBeenCalled();
    expect(h.ctx.reload).toHaveBeenCalledTimes(1);
    expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(true);
  });
});

describe("print/json cannot reload", () => {
  it.each(["print", "json"])("%s does not call even an exposed reload API", async (mode) => {
    const h = harness(mode);
    // The normal command path never arms, so there is no existing request here.
    h.ctl.disarm();
    h.port.arm(1, h.ctx as never);
    await h.port.reload(h.ctx as never);
    expect(h.ctx.reload).not.toHaveBeenCalled();
    expect(h.ctx.abort).not.toHaveBeenCalled();
    expect(h.ctx.waitForIdle).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.ctl.pending).toBe(false);
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("print/json 模式不支持"), "warning");
    expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #30 reload-result plan §1 D1/D3 — phase-event emission (life/execId attribution)

interface PhaseEvent {
  life: string;
  execId: string;
  by?: string;
  kind: string;
  waitingFor?: "runs" | "idle";
  activeRuns?: number;
  open?: boolean;
  message?: string;
}

function phaseHarness(opts: { mode?: string; webCmdId?: string } = {}) {
  const ctl = new DeferredReloadController({ fire: vi.fn() });
  const events: PhaseEvent[] = [];
  const state = { idle: false };
  const calls: string[] = [];
  const ctx = {
    mode: opts.mode ?? "tui",
    isIdle: () => state.idle,
    hasPendingMessages: () => false,
    abort: vi.fn(() => {
      calls.push("abort");
    }),
    waitForIdle: vi.fn(async () => {
      calls.push("idle");
      state.idle = true;
    }),
    reload: vi.fn(async () => {
      calls.push("reload");
    }),
    sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/tmp/s1.jsonl" },
    ui: { notify: vi.fn() },
    ...(opts.webCmdId !== undefined ? { webCmdId: opts.webCmdId } : {}),
  };
  const port = createReloadCommandPort(
    () => ctl,
    { sendMessage: vi.fn() },
    (e) => events.push(e as unknown as PhaseEvent),
  );
  return { ctx, ctl, events, state, calls, port };
}

describe("#30 phase events: life/execId attribution (D1)", () => {
  it("arm emits deferred{runs,activeRuns}; an identical refresh emits nothing, a changed one updates", () => {
    const h = phaseHarness({ webCmdId: "cmd-web-000000001" });
    h.state.idle = true;
    h.port.arm(2, h.ctx as never);
    h.port.arm(2, h.ctx as never); // refresh, same shape ⇒ deduped (D6 zero-change)
    h.port.arm(1, h.ctx as never); // refresh, count changed ⇒ new fact
    const rows = h.events.map((e) => [e.kind, e.by, e.waitingFor, e.activeRuns]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(["deferred", "cmd-web-000000001", "runs", 2]);
    expect(rows[1]).toEqual(["deferred", "cmd-web-000000001", "runs", 1]);
    expect(h.events[0]!.life).toBe(h.events[1]!.life); // one lifecycle
  });

  it("TUI facts carry no by; unavailable closes the lifecycle (D3)", () => {
    const h = phaseHarness({ mode: "print" });
    h.ctl.arm(1);
    h.port.unavailable(h.ctx as never);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.kind).toBe("unavailable");
    expect(h.events[0]!.by).toBeUndefined();
    expect(h.ctx.ui.notify).toHaveBeenCalled(); // the user-facing notice is unchanged
  });

  it("A1: a second now while the first awaits settle rotates execId; the first attempt's late callbacks are dropped", async () => {
    const h = phaseHarness();
    h.ctl.arm(1);
    const gates: Array<() => void> = [];
    h.ctx.waitForIdle.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          gates.push(resolve);
        }),
    );
    const first = h.port.reload(h.ctx as never); // now #1 (streaming)
    for (let i = 0; i < 4; i++) await Promise.resolve(); // let #1 reach its waitForIdle
    const second = h.port.reload(h.ctx as never); // now #2 supersedes it
    for (let i = 0; i < 4; i++) await Promise.resolve(); // #2 reaches its waitForIdle too
    expect(h.events.map((e) => e.kind)).toEqual(["exec", "exec"]);
    const [e1, e2] = h.events as [{ execId: string }, { execId: string }];
    expect(e1.execId).not.toBe(e2.execId); // each attempt gets a fresh execId
    gates[1]!(); // only #2 settles
    h.state.idle = true;
    await second;
    gates[0]!(); // #1 settles late — its settle/started must never be emitted
    h.state.idle = true;
    await first;
    expect(h.events.map((e) => e.kind)).toEqual(["exec", "exec", "started", "returned"]);
    expect(h.events.filter((e) => e.kind === "started" || e.kind === "returned").map((e) => e.execId)).toEqual([
      e2.execId,
      e2.execId,
    ]);
    expect(h.calls.filter((c) => c === "reload")).toHaveLength(1); // reload ran once
  });

  it("A2: a stale attempt's settle-failure cannot overwrite the newer attempt's started", async () => {
    const h = phaseHarness();
    h.ctl.arm(1);
    const gates: Array<() => void> = [];
    h.ctx.waitForIdle.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          gates.push(resolve);
        }),
    );
    const first = h.port.reload(h.ctx as never);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const second = h.port.reload(h.ctx as never);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const secondExec = (h.events[1] as { execId: string }).execId;
    gates[1]!();
    h.state.idle = true;
    await second; // emits started for the current execution
    // the stale attempt's wait resolves into a still-streaming ctx ⇒ settle-failure path
    h.state.idle = false;
    gates[0]!();
    await first;
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toEqual(["exec", "exec", "started", "returned"]); // no settle from exec #1
    expect(h.events.filter((e) => e.kind === "started" || e.kind === "returned").map((e) => e.execId)).toEqual([
      secondExec,
      secondExec,
    ]);
  });

  it("A13: cancel during the bounded wait closes the lifecycle; the attempt's late facts are dropped", async () => {
    const h = phaseHarness();
    h.ctl.arm(1);
    let resolveIdle!: () => void;
    h.ctx.waitForIdle.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveIdle = resolve;
        }),
    );
    const pending = h.port.reload(h.ctx as never);
    for (let i = 0; i < 4; i++) await Promise.resolve(); // reach the waitForIdle
    h.port.cancel(h.ctx as never); // user cancels during the 5s wait
    resolveIdle();
    h.state.idle = true;
    await pending;
    expect(h.events.map((e) => e.kind)).toEqual(["exec", "cancel"]);
    expect(h.ctx.reload).not.toHaveBeenCalled();
  });

  it("started/returned/threw ride the same attempt; threw keeps the rethrow and carries the message (D3)", async () => {
    const h = phaseHarness({ webCmdId: "cmd-web-000000002" });
    h.state.idle = true;
    await h.port.reload(h.ctx as never);
    expect(h.events.map((e) => e.kind)).toEqual(["exec", "started", "returned"]);
    h.ctx.reload.mockRejectedValueOnce(new Error("boom"));
    const boomed = h.port.reload(h.ctx as never).catch(() => undefined);
    await boomed;
    expect(h.events.at(-1)).toMatchObject({ kind: "threw", message: "boom", by: "cmd-web-000000002" });
    // lifecycle closed by the throw ⇒ a fresh request opens a new life
    const before = h.events.at(-1)!.life;
    await h.port.reload(h.ctx as never);
    expect(h.events.at(-1)!.life).not.toBe(before);
  });
});
