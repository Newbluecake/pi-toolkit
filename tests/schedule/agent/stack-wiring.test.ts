/**
 * scheduled-reports A0: the REAL buildSessionStack × schedule wiring. Off (no wiring — the default)
 * ⇒ the stack carries no `schedule` key and nothing touches the schedule store or the retired global
 * file; on ⇒ a per-session agent with the §3.3 mode of the ctx, disposed/marked on shutdown.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sandboxHome } from "../../integration/helpers/home-sandbox.js";
import { loadSettings } from "../../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../../src/config/agent-types.js";
import { isEpochDisposed, wireSchedule } from "../../../src/schedule/agent/wire.js";
import type { Stack } from "../../../src/stack.js";

let home: ReturnType<typeof sandboxHome> | undefined;
beforeEach(() => {
  home = sandboxHome();
});
afterEach(() => {
  home?.restore();
  home = undefined;
});

function harness(mode: string, file: string | undefined) {
  const pi = {
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: () => () => undefined },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode,
    hasUI: false,
    cwd: home!.home,
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getSessionId: () => "019a0000-aaaa-7bbb-8ccc-dddddddddddd",
      getSessionFile: () => file,
      getSessionDir: () => "",
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: { setWidget: vi.fn(), setStatus: vi.fn(), notify: vi.fn() },
  } as unknown as ExtensionContext;
  const types = {
    get: () => undefined,
    list: () => [],
    reload: async () => ({ types: [], errors: [] }),
  } as unknown as AgentTypeRegistry;
  return { pi, ctx, types };
}

function cleanup(stack: Stack): void {
  stack.schedule?.dispose();
  stack.rpc.close();
  stack.bashJobRecovery?.dispose();
  stack.backgroundCompletions.dispose();
  stack.fleetWidget?.dispose();
  stack.keepalive?.dispose();
  stack.quota?.dispose();
  stack.load?.dispose();
  stack.consult.close();
}

describe("buildSessionStack × schedule", () => {
  it("off (default): no schedule key, no store dir, no retired global file", async () => {
    const settings = loadSettings({});
    expect(settings.schedule.enabled).toBe(false);
    const { pi, ctx, types } = harness("tui", join(home!.home, "s.jsonl"));
    const { buildSessionStack } = await import("../../../src/stack.js");
    const stack = buildSessionStack(pi, ctx, settings, types, []);
    try {
      expect("schedule" in stack).toBe(false);
      expect(existsSync(join(home!.home, ".pi", "agent", "schedules"))).toBe(false);
      expect(existsSync(join(home!.home, ".pi", "agent", "pi-subagent-schedules.json"))).toBe(false);
    } finally {
      cleanup(stack);
    }
  });

  it("on: the stack carries a per-session agent with the ctx's mode; dispose marks the epoch", async () => {
    const settings = loadSettings({});
    const agentDir = join(home!.home, ".pi", "agent");
    const { pi, ctx, types } = harness("tui", join(home!.home, "s.jsonl"));
    const wiring = wireSchedule(pi, {
      settings: { ...settings.schedule, enabled: true },
      agentDir,
      secure: { kind: "plain", vaults: [], config: {} } as never,
      webHub: false,
      current: () => undefined,
      flockProbe: () => true,
    });
    const { buildSessionStack } = await import("../../../src/stack.js");
    const stack = buildSessionStack(pi, ctx, settings, types, [], "startup", undefined, undefined, {}, wiring);
    try {
      expect(stack.schedule?.mode.kind).toBe("interactive");
      expect(stack.schedule?.sessionId).toBe("019a0000-aaaa-7bbb-8ccc-dddddddddddd");
      await stack.schedule!.start();
      // nothing exists yet ⇒ nothing created by starting the clock
      expect(existsSync(join(agentDir, "schedules"))).toBe(false);
      const epoch = stack.schedule!.epoch;
      await stack.schedule!.shutdown();
      expect(isEpochDisposed(epoch)).toBe(true);
    } finally {
      cleanup(stack);
    }
  });

  it("on, print mode: agent exists but never arms", async () => {
    const settings = loadSettings({});
    const { pi, ctx, types } = harness("print", join(home!.home, "s.jsonl"));
    const wiring = wireSchedule(pi, {
      settings: { ...settings.schedule, enabled: true },
      agentDir: join(home!.home, ".pi", "agent"),
      secure: { kind: "plain", vaults: [], config: {} } as never,
      webHub: false,
      current: () => undefined,
      flockProbe: () => true,
    });
    const { buildSessionStack } = await import("../../../src/stack.js");
    const stack = buildSessionStack(pi, ctx, settings, types, [], "startup", undefined, undefined, {}, wiring);
    try {
      expect(stack.schedule?.mode.kind).toBe("print");
      expect(stack.schedule?.clock).toBeUndefined();
    } finally {
      cleanup(stack);
    }
  });
});
