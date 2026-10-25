import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoadSettings } from "../../src/config/settings.js";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import { createLoadHintState } from "../../src/sysload/hook.js";
import type { LoadPort } from "../../src/sysload/types.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

const fake = vi.hoisted(() => {
  let gated = true;
  const port: LoadPort = {
    verdict: () => ({
      level: gated ? "crit" : "ok",
      gating: gated,
      metrics: { cpu: { level: gated ? "crit" : "ok" }, mem: { level: "ok" }, disk: [] },
      mono: 1,
      at: 1,
    }),
    top: () => undefined,
    refreshTop: vi.fn(),
  };
  const activation = { start: vi.fn(), stop: vi.fn(), port: () => port, dispose: vi.fn() };
  return { port, activation, setGated: (value: boolean) => (gated = value) };
});

vi.mock("../../src/sysload/activation.js", () => ({ createLoadActivation: vi.fn(() => fake.activation) }));

const { buildSessionStack } = await import("../../src/stack.js");

function settings(): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    load: { ...parseLoadSettings({}), enabled: true, sampleIntervalMs: 60_000 },
    fleetWidget: false,
    bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
  };
}
function host() {
  const statuses: Array<[string, string | undefined]> = [];
  const pi = {
    sendMessage: () => undefined,
    appendEntry: () => undefined,
    exec: async () => ({ code: 0, killed: false }),
    events: { emit: () => undefined, on: () => () => undefined },
  } as never;
  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => undefined,
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => "leaf",
      getSessionId: () => "load-stack",
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: { setStatus: (key: string, value: string | undefined) => statuses.push([key, value]), notify: () => undefined },
  } as never;
  return { pi, ctx, statuses };
}
const types = {
  get: (name: string) =>
    name === "worker" ? { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" } : undefined,
  list: () => [{ name: "worker", description: "worker", systemPrompt: "", promptMode: "append" }],
  reload: async () => ({ types: [], errors: [] }),
} as never;

describe("sysload stack wiring", () => {
  beforeEach(() => {
    fake.setGated(true);
    fake.activation.dispose.mockClear();
    fake.activation.start.mockClear();
    fake.port.refreshTop.mockClear();
  });

  it("wires transition/admission, arms only main-session rejection, and exposes disposal", async () => {
    const home = sandboxHome();
    const h = host();
    const hint = createLoadHintState();
    const stack = buildSessionStack(h.pi, h.ctx, settings(), types, [], "reload", hint);
    expect(stack.load).toBe(fake.activation);
    expect(stack.loadAdmission?.blocked()).toBe(true);
    expect(stack.loadTransition?.()).toMatchObject({ gateCleared: false });

    const rejected = await stack.spawn.spawn({ type: "worker", prompt: "blocked", loadPolicy: "reject" });
    expect("error" in rejected).toBe(true);
    expect(hint.rejectedSinceRecovery).toBe(true);
    expect(fake.port.refreshTop).toHaveBeenCalled();

    hint.rejectedSinceRecovery = false;
    fake.setGated(false);
    expect(stack.loadTransition?.()).toMatchObject({ gateCleared: true });
    const parent = await stack.spawn.spawn({ type: "worker", prompt: "parent" });
    expect("runId" in parent).toBe(true);
    fake.setGated(true);
    const nested = await stack.spawn.spawn({
      type: "worker",
      prompt: "nested",
      parentRunId: "runId" in parent ? parent.runId : "missing",
      loadPolicy: "reject",
    });
    expect("error" in nested).toBe(true);
    expect(hint.rejectedSinceRecovery).toBe(false);

    fake.setGated(false);
    expect(stack.loadAdmission?.blocked()).toBe(false);
    stack.load?.dispose();
    expect(fake.activation.dispose).toHaveBeenCalled();
    stack.schedule?.dispose();
    stack.rpc.close();
    home.restore();
  });
});
