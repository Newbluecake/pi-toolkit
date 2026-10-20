import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_EXTERNAL_AGENTS_SETTINGS } from "../../src/config/settings.js";
import { formatAvailableModelsForPrompt } from "../../src/config/available-models.js";
import { createExternalAgentsPort } from "../../src/external-agent/port.js";
import { availableModelsSection } from "../../src/sysprompt/core-sections.js";
import { createPromptSectionHub } from "../../src/sysprompt/hub.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
function makePort(enabled = true) {
  const root = mkdtempSync(join(tmpdir(), "prompt-availability-"));
  roots.push(root);
  return createExternalAgentsPort({
    settings: {
      droid: { ...DEFAULT_EXTERNAL_AGENTS_SETTINGS.droid, enabled, binary: process.execPath, models: ["glm-5.3"] },
    },
    agentDir: root,
    clock: new FakeClock(1_000),
    registry: () => [],
    piProviders: () => [],
    warnOnce: () => {},
  })?.port;
}
const PI = [{ provider: "pi", id: "native" }];
const ctx = { scopedModels: [], sessionManager: { getBranch: () => [] } } as unknown as ExtensionContext;

describe("models availability through the real stable sysprompt hub", () => {
  it("rerenders the provider every turn, detects removal/recovery in content identity, and emits tail updates without changing the frozen head", () => {
    const port = makePort()!;
    const registration = availableModelsSection({
      stackAvailable: () => PI,
      externalModels: () => [{ provider: "droid", models: port.advertised(), total: 1 }],
    });
    const render = vi.spyOn(registration, "provider");
    type Hook = (
      event: never,
      ctx: ExtensionContext,
    ) => { systemPrompt?: string; message?: { content: string } } | undefined;
    const hooks = new Map<string, Hook>();
    const pi = {
      on: (event: string, fn: Hook) => hooks.set(event, fn),
      appendEntry: vi.fn(),
    } as unknown as ExtensionAPI;
    const hub = createPromptSectionHub(pi, {
      mode: () => "stable",
      wakeReplay: false,
      adoptForeignForcedPrompt: false,
    });
    hub.register("pi_subagent_models", registration);
    const turn = () => hooks.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "go" } as never, ctx)!;
    const first = turn();
    expect(first.systemPrompt).toContain("### External agent models (droid)");
    expect(first.message).toBeUndefined();
    port.observeAvailability!("droid", { source: "run", authError: "No access token" });
    const failed = turn();
    expect(failed.systemPrompt).toBe(first.systemPrompt);
    expect(failed.message?.content).toContain("REPLACES");
    expect(failed.message?.content).toContain(formatAvailableModelsForPrompt(PI));
    expect(failed.message?.content).not.toContain("### External agent models (droid)");
    expect(turn().message).toBeUndefined(); // same content ⇒ no duplicate update
    port.observeAvailability!("droid", { source: "run", ok: true });
    const recovered = turn();
    expect(recovered.systemPrompt).toBe(first.systemPrompt);
    expect(recovered.message?.content).toContain("### External agent models (droid)");
    expect(recovered.message?.content).toContain("droid/glm-5.3");
    expect(render).toHaveBeenCalledTimes(4);
    port.dispose();
  });

  it("settings-disabled droid remains byte-identical to the existing pi-only prompt", () => {
    const port = makePort(false);
    expect(port).toBeUndefined();
    const registration = availableModelsSection({
      stackAvailable: () => PI,
      externalModels: () =>
        port === undefined ? undefined : [{ provider: "droid", models: port.advertised(), total: 1 }],
    });
    expect(registration.provider({ ctx, promptText: "" })).toBe(formatAvailableModelsForPrompt(PI));
  });
});
