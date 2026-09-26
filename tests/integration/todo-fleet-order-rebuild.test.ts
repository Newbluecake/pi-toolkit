// todo #18 (todo widget above the agent tree): the fleet widget subscribes to
// TODO_WIDGET_MOUNTED_EVENT on the process-wide `pi.events` bus, which
// survives /reload and same-module stack rebuilds. This pins that repeated
// buildSessionStack calls never accumulate subscriptions (the previous
// session's controller is disposed at the top of the next build), and that the
// session_shutdown path (index.ts → stack.fleetWidget.dispose()) drops the
// last one too.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "./helpers/home-sandbox.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import { TODO_WIDGET_MOUNTED_EVENT } from "../../src/ui/widget-mount-events.js";

let homeSandbox: ReturnType<typeof sandboxHome> | undefined;

beforeEach(() => {
  homeSandbox = sandboxHome();
});

afterEach(() => {
  homeSandbox?.restore();
  homeSandbox = undefined;
});

function fakeBus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    count: (channel: string) => listeners.get(channel)?.size ?? 0,
    emit: (channel: string, data?: unknown) => {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
    },
    on: (channel: string, handler: (data: unknown) => void) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(handler);
      return () => void set!.delete(handler);
    },
  };
}

describe("todo #18: fleet widget mount-signal subscription across stack rebuilds", () => {
  it("never accumulates TODO_WIDGET_MOUNTED_EVENT listeners and drops the last one on dispose", async () => {
    const bus = fakeBus();
    const pi = {
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
      events: { emit: bus.emit, on: bus.on },
    } as unknown as ExtensionAPI;
    const setWidget = vi.fn();
    const ctx = {
      mode: "tui",
      hasUI: true,
      sessionManager: { getEntries: () => [], getBranch: () => [] },
      modelRegistry: { getAvailable: () => [], find: () => undefined },
      ui: { setWidget, setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const types = {
      get: () => undefined,
      list: () => [],
      reload: async () => ({ types: [], errors: [] }),
    } as unknown as AgentTypeRegistry;
    const settings = {
      ...DEFAULT_SETTINGS,
      fleetWidget: true,
      bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
    };
    const { buildSessionStack } = await import("../../src/stack.js");

    const first = buildSessionStack(pi, ctx, settings, types, []);
    expect(first.fleetWidget).toBeDefined();
    expect(bus.count(TODO_WIDGET_MOUNTED_EVENT)).toBe(1);

    const second = buildSessionStack(pi, ctx, settings, types, []);
    const third = buildSessionStack(pi, ctx, settings, types, []);
    expect(bus.count(TODO_WIDGET_MOUNTED_EVENT)).toBe(1);

    // An emitted signal reaches only the live controller (no throw from the
    // disposed ones either).
    expect(() => bus.emit(TODO_WIDGET_MOUNTED_EVENT)).not.toThrow();

    // index.ts's session_shutdown path.
    third.fleetWidget?.dispose();
    expect(bus.count(TODO_WIDGET_MOUNTED_EVENT)).toBe(0);
    void second;
  });
});
