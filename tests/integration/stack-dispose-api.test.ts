import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import { buildSessionStack } from "../../src/stack.js";
import { FLEET_WIDGET_KEY } from "../../src/ui/fleet-widget.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

/**
 * #56 ⑦ step 7-2: the `rebuild-handoff` entry of `Stack.dispose` is the SAME step list the next build in this module runs
 * over `previousParts`. Production only reaches it through that next build; this pins that calling it on a stack consumes
 * the handoff (the slot is cleared), so the next build neither double-disposes nor reaches a stale component.
 * The ordered, per-entry behaviour itself is pinned by stack-teardown-matrix.test.ts.
 */
let homeSandbox: ReturnType<typeof sandboxHome> | undefined;
beforeEach(() => {
  homeSandbox = sandboxHome();
});
afterEach(() => {
  homeSandbox?.restore();
  homeSandbox = undefined;
});

const fakePi = () =>
  ({
    registerTool: () => undefined,
    registerCommand: () => undefined,
    on: () => undefined,
    sendMessage: () => undefined,
    appendEntry: () => undefined,
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  }) as unknown as ExtensionAPI;
const types = {
  get: () => undefined,
  list: () => [],
  reload: async () => ({ types: [], errors: [] }),
} as unknown as AgentTypeRegistry;

describe("Stack.dispose rebuild-handoff entry", () => {
  it("disposes the stack's own parts; the next build then finds the slot consumed", () => {
    const ctx = {
      sessionManager: { getEntries: () => [], getSessionId: () => "s" },
      modelRegistry: { getAvailable: () => [], find: () => undefined },
      ui: { setWidget: () => undefined },
      cwd: process.cwd(),
    } as unknown as ExtensionContext;
    const settings = { ...DEFAULT_SETTINGS, fleetWidget: true };
    const first = buildSessionStack(fakePi(), ctx, settings, types, []);
    const widget = first.fleetWidget;
    expect(widget).toBeDefined();
    const disposeCalls = vi.spyOn(widget!, "dispose");
    first.dispose({ kind: "rebuild-handoff" });
    expect(disposeCalls).toHaveBeenCalledTimes(1);
    first.dispose({ kind: "rebuild-handoff" }); // the slot is cleared: nothing left to dispose
    expect(disposeCalls).toHaveBeenCalledTimes(1);
    const second = buildSessionStack(fakePi(), ctx, settings, types, []);
    expect(disposeCalls).toHaveBeenCalledTimes(1); // the next build's own handoff has nothing of `first` left
    // control: without an explicit call, the next build is what disposes the previous stack's widget
    const secondWidgetDispose = vi.spyOn(second.fleetWidget!, "dispose");
    const third = buildSessionStack(fakePi(), ctx, settings, types, []);
    expect(secondWidgetDispose).toHaveBeenCalledTimes(1);
    for (const stack of [first, second, third]) stack.bashJobs?.dispose();
  });
});
