/**
 * Wiring-level regression tests for src/reload/index.ts (wireDeferredReload).
 *
 * The load-bearing assertion: the fire message MUST carry
 * `expandPromptTemplates: true`. pi's sendUserMessage defaults that flag to
 * false, and command dispatch in prompt() is gated behind it — without the
 * flag the injected `/agent reload fire` bypasses _tryExecuteExtensionCommand
 * and is delivered to the LLM as a plain user message (observed live in the
 * deferred-reload e2e test: the model received the fire text, reload never
 * ran).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { writeReloadContinue } from "../../src/reload/continue.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { wireDeferredReload } from "../../src/reload/index.js";

function fakePi() {
  const busHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const piHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const sent: Array<{ content: unknown; options: unknown }> = [];
  const messages = vi.fn();
  const unsubs: Array<() => void> = [];
  const pi = {
    events: {
      on: (channel: string, handler: (...args: unknown[]) => void) => {
        const list = busHandlers.get(channel) ?? [];
        list.push(handler);
        busHandlers.set(channel, list);
        const unsub = vi.fn(() => {
          busHandlers.set(
            channel,
            (busHandlers.get(channel) ?? []).filter((h) => h !== handler),
          );
        });
        unsubs.push(unsub);
        return unsub;
      },
      emit: () => undefined,
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const list = piHandlers.get(event) ?? [];
      list.push(handler);
      piHandlers.set(event, list);
    },
    sendMessage: messages,
    sendUserMessage: (content: unknown, options: unknown) => {
      sent.push({ content, options });
      return Promise.resolve();
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    sent,
    messages,
    piHandlers,
    unsubs,
    emitBus: (channel: string) => (busHandlers.get(channel) ?? []).forEach((h) => h()),
    emitPi: (event: string, ...args: unknown[]) => (piHandlers.get(event) ?? []).forEach((h) => h(...args)),
  };
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:reload-continue")];
});

describe("wireDeferredReload", () => {
  it("fires via sendUserMessage with expandPromptTemplates: true (command-dispatch gate)", () => {
    const { pi, sent, emitBus } = fakePi();
    let active = 1;
    const ctl = wireDeferredReload(pi, { settings: DEFAULT_SETTINGS, activeRunCount: () => active });

    ctl.arm(1);
    active = 0;
    emitBus("subagent:completed");

    expect(sent).toEqual([
      { content: "/agent reload fire", options: { deliverAs: "followUp", expandPromptTemplates: true } },
    ]);
  });

  it("does not fire while disarmed, and re-checks the count on every settle", () => {
    const { pi, sent, emitBus } = fakePi();
    let active = 2;
    const ctl = wireDeferredReload(pi, { settings: DEFAULT_SETTINGS, activeRunCount: () => active });

    emitBus("subagent:failed"); // never armed
    expect(sent).toEqual([]);

    ctl.arm(2);
    active = 1;
    emitBus("subagent:completed"); // still busy
    expect(sent).toEqual([]);

    active = 0;
    emitBus("subagent:failed"); // drained
    expect(sent).toHaveLength(1);
  });

  it("recounts when a background workflow settles (no run event marks a workflow's end)", () => {
    const { pi, sent, emitBus } = fakePi();
    let active = 1; // the workflow itself, between child runs
    const ctl = wireDeferredReload(pi, { settings: DEFAULT_SETTINGS, activeRunCount: () => active });
    ctl.arm(1);
    emitBus("subagent:workflow:settled"); // still counted as busy → no fire
    expect(sent).toEqual([]);
    active = 0;
    emitBus("subagent:workflow:settled");
    expect(sent).toHaveLength(1);
  });

  it("drops all bus subscriptions on session_shutdown (the bus survives /reload)", () => {
    const { pi, unsubs, emitPi, emitBus, sent } = fakePi();
    const ctl = wireDeferredReload(pi, { settings: DEFAULT_SETTINGS, activeRunCount: () => 0 });

    emitPi("session_shutdown");
    expect(unsubs).toHaveLength(3);
    for (const unsub of unsubs) expect(unsub).toHaveBeenCalledTimes(1);

    ctl.arm(0);
    emitBus("subagent:completed"); // handlers are gone — nothing fires
    emitBus("subagent:workflow:settled");
    expect(sent).toEqual([]);
  });

  it("does not install the editor wrapper outside TUI mode or when reload.defer is off", () => {
    const { pi, emitPi } = fakePi();
    wireDeferredReload(pi, { settings: DEFAULT_SETTINGS, activeRunCount: () => 0 });
    const ctx = { mode: "rpc", ui: { setEditorComponent: vi.fn(), getEditorComponent: () => undefined } };
    emitPi("session_start", {}, ctx);
    expect(ctx.ui.setEditorComponent).not.toHaveBeenCalled();

    const { pi: pi2, emitPi: emitPi2 } = fakePi();
    wireDeferredReload(pi2, {
      settings: { ...DEFAULT_SETTINGS, reload: { defer: false } },
      activeRunCount: () => 0,
    });
    const tuiCtx = { mode: "tui", ui: { setEditorComponent: vi.fn(), getEditorComponent: () => undefined } };
    emitPi2("session_start", {}, tuiCtx);
    expect(tuiCtx.ui.setEditorComponent).not.toHaveBeenCalled();
  });
});

describe("continuation via the existing session_start hook", () => {
  it.each([true, false])("matching reload wakes once (idle=%s), even with defer off", (idle) => {
    const h = fakePi();
    const sessionManager = { getSessionId: () => "s1", getSessionFile: () => "/tmp/s1.jsonl" };
    const ctx = {
      mode: "tui",
      sessionManager,
      isIdle: () => idle,
      ui: { setEditorComponent: vi.fn(), getEditorComponent: () => undefined },
    };
    writeReloadContinue(ctx as never);
    wireDeferredReload(h.pi, {
      settings: { ...DEFAULT_SETTINGS, reload: { defer: false } },
      activeRunCount: () => 0,
    });
    // No new handlers are allowed: reuse exactly the two existing lifecycle hooks.
    expect([...h.piHandlers.keys()]).toEqual(["session_start", "session_shutdown"]);
    expect([...h.piHandlers.values()].map((handlers) => handlers.length)).toEqual([1, 1]);
    h.emitPi("session_start", { reason: "reload" }, ctx);
    h.emitPi("session_start", { reason: "reload" }, ctx);
    expect(h.messages).toHaveBeenCalledTimes(1);
    expect(h.messages).toHaveBeenCalledWith(
      {
        customType: "subagent:reload-continue",
        display: true,
        content: expect.stringContaining("reload 已完成（插件已更新）"),
      },
      { triggerTurn: true, ...(!idle ? { deliverAs: "followUp" } : {}) },
    );
    expect(h.messages.mock.calls[0]![0].content).toContain("get_run_result");
    expect(ctx.ui.setEditorComponent).not.toHaveBeenCalled();
  });

  it.each(["startup", "new", "resume", "fork"])("does not wake on %s and discards handoff", (reason) => {
    const h = fakePi();
    const ctx = {
      mode: "rpc",
      isIdle: () => true,
      sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/tmp/s1.jsonl" },
    };
    writeReloadContinue(ctx as never);
    wireDeferredReload(h.pi, { settings: DEFAULT_SETTINGS, activeRunCount: () => 0 });
    h.emitPi("session_start", { reason }, ctx);
    h.emitPi("session_start", { reason: "reload" }, ctx);
    expect(h.messages).not.toHaveBeenCalled();
  });

  it("re-activation consumes a handoff made by the previous command facade", async () => {
    const { createReloadCommandPort } = await import("../../src/reload/command-port.js");
    const old = fakePi();
    const ctl = wireDeferredReload(old.pi, { settings: DEFAULT_SETTINGS, activeRunCount: () => 0 });
    const sessionManager = { getSessionId: () => "s1", getSessionFile: () => "/tmp/s1.jsonl" };
    const fresh = fakePi();
    const newContext = { sessionManager, isIdle: () => true, mode: "rpc" };
    const reload = vi.fn(async () => {
      old.emitPi("session_shutdown", { reason: "reload" });
      wireDeferredReload(fresh.pi, { settings: DEFAULT_SETTINGS, activeRunCount: () => 0 });
      fresh.emitPi("session_start", { reason: "reload" }, newContext);
    });
    const port = createReloadCommandPort(() => ctl, old.pi);
    const oldContext = { sessionManager, isIdle: () => false, hasPendingMessages: () => false, reload };
    await port.reload(oldContext as never);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(fresh.messages).toHaveBeenCalledTimes(1);
    expect(fresh.messages.mock.calls[0]![1]).toEqual({ triggerTurn: true });
    expect(old.messages).not.toHaveBeenCalled();
    for (const unsub of old.unsubs) expect(unsub).toHaveBeenCalledTimes(1);
  });
});

describe("natural-idle wait lifecycle cleanup (existing hooks only)", () => {
  it.each(["session_start", "session_shutdown"])("%s invalidates waits and clears timers", async (event) => {
    vi.useFakeTimers();
    const h = fakePi();
    const ctl = wireDeferredReload(h.pi, { settings: DEFAULT_SETTINGS, activeRunCount: () => 0 });
    let idle!: () => void;
    const pending = new Promise<void>((resolve) => {
      idle = resolve;
    });
    ctl.arm(1);
    ctl.waitForIdle(
      () => pending,
      () => true,
      vi.fn(),
    );
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    h.emitPi(event, { reason: "new" }, { mode: "rpc" });
    expect(ctl.pending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    idle();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(h.sent).toEqual([]);
  });
});
