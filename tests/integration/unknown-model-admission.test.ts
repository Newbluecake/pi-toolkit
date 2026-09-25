import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSessionStack, type Stack } from "../../src/stack.js";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sandboxHome } from "./helpers/home-sandbox.js";

/**
 * Assembly surface for the strict provider/id admission check: stack.ts wires
 * `modelExists` over the live `ctx.modelRegistry` (the same `find` the session
 * driver resolves through) and the unknown-model error lists the registry's
 * available models as suggestions. No run may be created for a rejected pair.
 */
const MODELS = [
  { provider: "cr-anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { provider: "cr-anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
];

function fakePi() {
  return {
    sendMessage: vi.fn(),
    appendEntry: () => undefined,
    events: { emit: () => undefined, on: () => () => undefined },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  } as unknown as ExtensionAPI;
}

function ctxWith(modelRegistry: unknown): ExtensionContext {
  return {
    cwd: "/tmp/pi-subagent-unknown-model",
    sessionManager: { getEntries: () => [], getSessionId: () => "unknown-model", getBranch: () => [] },
    modelRegistry,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    hasUI: false,
    mode: "interactive",
  } as unknown as ExtensionContext;
}

const type = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" } as never;
const types = {
  get: (name: string) => (name === "worker" ? type : undefined),
  list: () => [type],
  reload: async () => ({ types: [type], errors: [] }),
} as never;

function settings(): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    fleetWidget: false,
    bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
    cacheTtl: { ...DEFAULT_SETTINGS.cacheTtl, keepalive: false, adaptiveEnabled: false },
    quota: { ...DEFAULT_SETTINGS.quota, providers: "" },
  };
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
function build(modelRegistry: unknown): Stack {
  const home = sandboxHome();
  const stack = buildSessionStack(fakePi(), ctxWith(modelRegistry), settings(), types, []);
  cleanup.push(() => {
    stack.quota?.dispose();
    stack.scheduler.stop();
    stack.rpc.close();
    home.restore();
  });
  return stack;
}

describe("stack wiring: unknown strict model is rejected at dispatch", () => {
  it("renamed provider ⇒ config error with the cr-anthropic candidate, no run created", async () => {
    const stack = build({
      getAvailable: () => MODELS,
      getAll: () => MODELS,
      find: (p: string, id: string) => MODELS.find((m) => m.provider === p && m.id === id),
    });
    const spawned = await stack.spawn.spawn({
      type: "worker",
      prompt: "x",
      modelOverride: { provider: "cloudrouter-anthropic", id: "claude-opus-5-5" },
    });
    expect(spawned).toMatchObject({ error: { kind: "config", retryable: false } });
    const message = "error" in spawned ? spawned.error.message : "";
    expect(message).toContain('Unknown model "cloudrouter-anthropic/claude-opus-5-5"');
    expect(message).toContain("Did you mean: cr-anthropic/claude-opus-5-5");
    expect(stack.query.list()).toEqual([]);
  });

  it("a registry whose getter throws does not block admission (fail-open)", async () => {
    const registry = {
      getAvailable: () => MODELS,
      getAll: () => MODELS,
      find: () => {
        throw new Error("stale ctx");
      },
    };
    const stack = build(registry);
    const spawned = await stack.spawn.spawn({
      type: "worker",
      prompt: "x",
      modelOverride: { provider: "cloudrouter-anthropic", id: "claude-opus-5-5" },
    });
    // Admitted: the run exists (it will fail later in the driver, with its cause).
    expect("runId" in spawned).toBe(true);
    if ("runId" in spawned) await stack.spawn.abort?.(spawned.runId, "user_stop");
  });
});
