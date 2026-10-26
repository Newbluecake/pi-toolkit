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
