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

import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { wireDeferredReload } from "../../src/reload/index.js";

function fakePi() {
  const busHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const piHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const sent: Array<{ content: unknown; options: unknown }> = [];
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
    sendUserMessage: (content: unknown, options: unknown) => {
      sent.push({ content, options });
      return Promise.resolve();
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    sent,
    unsubs,
    emitBus: (channel: string) => (busHandlers.get(channel) ?? []).forEach((h) => h()),
    emitPi: (event: string, ...args: unknown[]) => (piHandlers.get(event) ?? []).forEach((h) => h(...args)),
  };
}

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
