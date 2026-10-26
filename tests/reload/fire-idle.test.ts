import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createStatusCommand, type StatusCommandDeps } from "../../src/commands/status.js";
import { createReloadCommandPort } from "../../src/reload/command-port.js";
import { consumeReloadContinue } from "../../src/reload/continue.js";
import { DeferredReloadController, RELOAD_IDLE_WAIT_MS } from "../../src/reload/defer.js";

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function harness() {
  const clock = new FakeClock();
  const queued: string[] = [];
  const fire = vi.fn(() => queued.push("reload fire"));
  const ctl = new DeferredReloadController({ fire, clock });
  const state = { idle: false, busy: 1, pending: false };
  const branch: Array<{ type: string; id: string; message: { role: string; stopReason?: string } }> = [
    { type: "message", id: "old-final", message: { role: "assistant", stopReason: "stop" } },
  ];
  let resolveIdle!: () => void;
  let rejectIdle!: (err: Error) => void;
  const idlePromise = new Promise<void>((resolve, reject) => {
    resolveIdle = resolve;
    rejectIdle = reject;
  });
  const sendMessage = vi.fn();
  const port = createReloadCommandPort(() => ctl, { sendMessage });
  const ctx = {
    mode: "tui",
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    waitForIdle: vi.fn(() => idlePromise),
    abort: vi.fn(() => {
      state.idle = true;
      resolveIdle();
    }),
    reload: vi.fn(async () => {
      expect(state.idle).toBe(true);
      expect(ctl.pending).toBe(false);
    }),
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: () => "s1",
      getSessionFile: () => "/tmp/s1.jsonl",
      getBranch: () => branch,
    },
  };
  const cmd = createStatusCommand({
    query: { list: () => (state.busy ? [{ runId: "r1", status: "running" }] : []) },
    reload: port,
  } as unknown as StatusCommandDeps);
  const command = (text: string) => cmd.handler(text, ctx as never);
  const drain = async () => {
    state.busy = 0;
    ctl.handleRunSettled(0);
    expect(queued.shift()).toBe("reload fire");
    await command("reload fire");
    await flush();
  };
  const idle = async (stopReason: string | undefined = "stop") => {
    state.idle = true;
    branch.push({
      type: "message",
      id: "new-final",
      message: { role: "assistant", ...(stopReason ? { stopReason } : {}) },
    });
    resolveIdle();
    await flush();
  };
  return { clock, queued, ctl, state, ctx, branch, sendMessage, command, drain, idle, rejectIdle, fire };
}

afterEach(() => delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:reload-continue")]);

describe("deferred fire waits for natural idle without awaiting the command", () => {
  it("returns from the command while streaming, then re-fires and reloads WITHOUT abort", async () => {
    const h = harness();
    await h.command("reload");
    await h.drain(); // resolves although waitForIdle is still unresolved
    expect(h.ctx.waitForIdle).toHaveBeenCalledTimes(1);
    expect(h.ctx.abort).not.toHaveBeenCalled();
    expect(h.ctx.reload).not.toHaveBeenCalled();
    expect(h.ctl.pending).toBe(true);
    expect(h.clock.pendingTimers).toBe(1);
    await h.idle();
    expect(h.queued.shift()).toBe("reload fire");
    await h.command("reload fire");
    expect(h.ctx.reload).toHaveBeenCalledTimes(1);
    expect(h.ctx.abort).not.toHaveBeenCalled();
    expect(h.clock.pendingTimers).toBe(0);
    // Newly completed normal response + no queue => no unnecessary continuation.
    expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(false);
  });

  it("cancel invalidates the wait, removes its timer and ignores late idle", async () => {
    const h = harness();
    await h.command("reload");
    await h.drain();
    await h.command("reload cancel");
    expect(h.ctl.pending).toBe(false);
    expect(h.clock.pendingTimers).toBe(0);
    await h.idle();
    h.clock.advance(RELOAD_IDLE_WAIT_MS);
    expect(h.queued).toEqual([]);
    expect(h.ctx.reload).not.toHaveBeenCalled();
    expect(h.ctx.abort).not.toHaveBeenCalled();
    expect(h.ctx.ui.notify.mock.calls.some(([s]) => String(s).includes("30 分钟"))).toBe(false);
  });

  it("now supersedes a natural wait with abort+reload and never sends its stale fire", async () => {
    const h = harness();
    await h.command("reload");
    await h.drain();
    await h.command("reload now");
    await flush();
    expect(h.ctx.abort).toHaveBeenCalledTimes(1);
    expect(h.ctx.reload).toHaveBeenCalledTimes(1);
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.queued).toEqual([]);
    expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(true);
  });

  it("times out at 30 minutes, remains pending and never aborts or later auto-fires", async () => {
    const h = harness();
    await h.command("reload");
    await h.drain();
    h.clock.advance(RELOAD_IDLE_WAIT_MS - 1);
    expect(h.ctx.ui.notify.mock.calls.some(([s]) => String(s).includes("30 分钟"))).toBe(false);
    h.clock.advance(1);
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("30 分钟"), "warning");
    expect(h.ctl.pending).toBe(true);
    expect(h.ctx.abort).not.toHaveBeenCalled();
    expect(h.ctx.reload).not.toHaveBeenCalled();
    expect(h.clock.pendingTimers).toBe(0);
    await h.idle();
    h.ctl.handleRunSettled(0);
    expect(h.queued).toEqual([]);
    expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(false);
    await h.command("reload cancel");
    expect(h.ctl.pending).toBe(false);
  });

  it("timeout still permits now, and repeated fire does not extend the original deadline", async () => {
    const h = harness();
    await h.command("reload");
    await h.drain();
    h.clock.advance(RELOAD_IDLE_WAIT_MS / 2);
    await h.command("reload fire");
    expect(h.ctx.waitForIdle).toHaveBeenCalledTimes(1);
    h.clock.advance(RELOAD_IDLE_WAIT_MS / 2);
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("30 分钟"), "warning");
    await h.command("reload now");
    expect(h.ctx.abort).toHaveBeenCalledTimes(1);
    expect(h.ctx.reload).toHaveBeenCalledTimes(1);
  });

  it("idle re-fire re-counts new admitted activity and re-arms, without a duplicate model notice", async () => {
    const h = harness();
    await h.command("reload");
    await h.drain();
    h.state.busy = 1;
    await h.idle();
    expect(h.queued.shift()).toBe("reload fire");
    await h.command("reload fire");
    expect(h.ctl.pending).toBe(true);
    expect(h.ctl.rememberedActiveCount).toBe(1);
    expect(h.ctx.reload).not.toHaveBeenCalled();
    expect(h.ctx.abort).not.toHaveBeenCalled();
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    h.state.busy = 0;
    h.ctl.handleRunSettled(0);
    expect(h.queued.shift()).toBe("reload fire");
    await h.command("reload fire");
    expect(h.ctx.reload).toHaveBeenCalledTimes(1);
  });

  it.each(["toolUse", "aborted", "error", undefined])(
    "non-normal assistant ending %s preserves continuation",
    async (reason) => {
      const h = harness();
      await h.command("reload");
      await h.drain();
      await h.idle(reason ?? "");
      expect(h.queued.shift()).toBe("reload fire");
      await h.command("reload fire");
      expect(h.ctx.reload).toHaveBeenCalledTimes(1);
      expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(true);
    },
  );

  it("missing queue probe does not claim normal-stop suppression", async () => {
    const h = harness();
    await h.command("reload");
    await h.drain();
    await h.idle();
    h.queued.shift();
    delete (h.ctx as { hasPendingMessages?: unknown }).hasPendingMessages;
    await h.command("reload fire");
    expect(h.ctx.reload).toHaveBeenCalledTimes(1);
    expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(true);
  });

  it("pending messages defeat normal-stop suppression", async () => {
    const h = harness();
    await h.command("reload");
    await h.drain();
    h.state.pending = true;
    await h.idle();
    h.queued.shift();
    await h.command("reload fire");
    expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(true);
  });

  it("records streaming first seen while waiting, even if the arm was idle", async () => {
    const h = harness();
    h.state.idle = true;
    await h.command("reload");
    expect(h.ctl.interruptedAtArm).toBe(false);
    h.state.idle = false;
    await h.drain();
    expect(h.ctl.waitedWhileStreaming).toBe(true);
    await h.idle("aborted");
    h.queued.shift();
    await h.command("reload fire");
    expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(true);
  });

  it("an old assistant stop is not proof of normal completion", async () => {
    const h = harness();
    await h.command("reload");
    await h.drain();
    await h.idle();
    h.branch.pop(); // only the pre-arm response remains
    h.queued.shift();
    await h.command("reload fire");
    expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(true);
  });

  it("wait failure is handled without an unhandled rejection, abort or reload", async () => {
    const h = harness();
    await h.command("reload");
    await h.drain();
    h.rejectIdle(new Error("wait failed"));
    await flush();
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("等待模型空闲失败"), "warning");
    expect(h.ctl.pending).toBe(true);
    expect(h.ctx.abort).not.toHaveBeenCalled();
    expect(h.ctx.reload).not.toHaveBeenCalled();
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("a bare reload with no child activity also waits naturally", async () => {
    const h = harness();
    h.state.busy = 0;
    await h.command("reload");
    expect(h.ctl.pending).toBe(true);
    expect(h.ctx.abort).not.toHaveBeenCalled();
    expect(h.ctx.reload).not.toHaveBeenCalled();
    await h.idle();
    h.queued.shift();
    await h.command("reload fire");
    expect(h.ctx.reload).toHaveBeenCalledTimes(1);
    expect(consumeReloadContinue(h.ctx as never, "reload")).toBe(false);
  });
});
