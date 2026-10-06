import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { wireWebHub, type WebHubDeps } from "../../../src/web-hub/agent/index.js";
import type { AgentFrame, SessionModelsWire } from "../../../src/web-hub/protocol/messages.js";
import {
  fakeCtx,
  fakePi,
  pathsIn,
  resetGlobals,
  SETTINGS,
  startFakeHub,
  tmpDir,
  waitUntil,
  type FakeHub,
} from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
let hub: FakeHub | undefined;

beforeEach(() => {
  tmp = tmpDir("wh-d-models-");
  resetGlobals();
});

afterEach(async () => {
  vi.useRealTimers();
  resetGlobals();
  await hub?.close();
  hub = undefined;
  tmp.cleanup();
});

function deps(over: Partial<WebHubDeps> = {}): WebHubDeps {
  return {
    settings: SETTINGS,
    fleet: () => [],
    env: { HOME: tmp.dir },
    paths: pathsIn(tmp.dir),
    buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "1.2.3@test" }),
    argv1: "/nonexistent/pi",
    ...over,
  };
}

function fixture(): SessionModelsWire {
  return JSON.parse(
    readFileSync(new URL("../../fixtures/web-hub-models/v1-session.json", import.meta.url), "utf8"),
  ) as SessionModelsWire;
}

function sessionFrames(): Array<Extract<AgentFrame, { t: "session" }>> {
  return (hub?.all() ?? []).filter((frame): frame is Extract<AgentFrame, { t: "session" }> => frame.t === "session");
}

describe("web-hub model session wiring", () => {
  it("attaches the M1 projection and refreshes it on resources_discover", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const { pi, fire } = fakePi();
    const { ctx } = fakeCtx();
    const available = [{ provider: "openai", id: "gpt-5", name: "GPT 5", contextWindow: 400_000, reasoning: true }];
    Object.assign(ctx as object, {
      modelRegistry: { getAvailable: () => available, getError: () => undefined },
      scopedModels: [{ model: available[0], thinkingLevel: "high" }],
    });
    wireWebHub(pi, deps());
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => sessionFrames().length >= 1, 3_000, "initial session");
    expect(sessionFrames()[0]?.models?.items).toEqual(
      expect.arrayContaining([{ ...fixture().items[1], scoped: true }]),
    );

    fire("model_select", { type: "model_select", model: { provider: "openai", id: "gpt-5" } }, ctx);
    await waitUntil(() => sessionFrames().length >= 2, 3_000, "model event");
    fire("resources_discover", {}, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sessionFrames()).toHaveLength(2);

    available.push({ provider: "zai", id: "glm-5", name: "GLM 5" });
    fire("resources_discover", {}, ctx);
    await waitUntil(() => sessionFrames().length >= 3, 3_000, "model refresh");
    expect(sessionFrames().at(-1)?.models?.items.at(-1)).toMatchObject({ provider: "zai", id: "glm-5" });
    fire("resources_discover", {}, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sessionFrames()).toHaveLength(3);
  });

  it("refreshes exactly once on the fifth real interval tick and not on the tenth without a change", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { pi, fire } = fakePi();
    const { ctx } = fakeCtx();
    const available = [{ provider: "p", id: "m" }];
    Object.assign(ctx as object, {
      modelRegistry: { getAvailable: () => available },
      scopedModels: [],
    });
    wireWebHub(pi, deps());
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => sessionFrames().length >= 1, 3_000, "initial session");

    // connectWith performs the initial onTick synchronously; four interval ticks reach onTick #5.
    available.push({ provider: "p", id: "m2" });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sessionFrames()).toHaveLength(2);
    expect(sessionFrames().at(-1)?.models?.items).toEqual(expect.arrayContaining([{ provider: "p", id: "m2" }]));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sessionFrames()).toHaveLength(2);
  });

  it.each([
    ["control", { control: false }],
    ["web commands", { webCommands: false }],
  ] as const)("omits models when %s are disabled", async (_label, settings) => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const { pi, fire } = fakePi();
    const { ctx } = fakeCtx();
    Object.assign(ctx as object, {
      modelRegistry: { getAvailable: () => [{ provider: "p", id: "m" }] },
      scopedModels: [],
    });
    wireWebHub(pi, deps({ settings: { ...SETTINGS, ...settings } }));
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => sessionFrames().length >= 1, 3_000, "disabled session");
    expect(sessionFrames()[0]).not.toHaveProperty("models");
  });

  it("turns stale model getters into an error snapshot without throwing", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const { pi, fire } = fakePi();
    const { ctx } = fakeCtx();
    Object.defineProperty(ctx, "modelRegistry", {
      get() {
        throw new Error("stale");
      },
    });
    Object.defineProperty(ctx, "scopedModels", {
      get() {
        throw new Error("stale");
      },
    });
    wireWebHub(pi, deps());
    expect(() => fire("session_start", { type: "session_start", reason: "startup" }, ctx)).not.toThrow();
    await waitUntil(() => sessionFrames().length >= 1, 3_000, "error session");
    expect(sessionFrames()[0]?.models).toMatchObject({ status: "error", items: [] });
  });

  it("clears the fingerprint at a session boundary and sends the next attach", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const { pi, fire } = fakePi();
    const { ctx } = fakeCtx();
    Object.assign(ctx as object, {
      modelRegistry: { getAvailable: () => [{ provider: "p", id: "m" }] },
      scopedModels: [],
    });
    wireWebHub(pi, deps());
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => sessionFrames().length >= 1, 3_000, "first attach");
    fire("session_shutdown", { type: "session_shutdown", reason: "new" }, ctx);
    fire("session_start", { type: "session_start", reason: "new" }, ctx);
    await waitUntil(() => sessionFrames().length >= 2, 3_000, "second attach");
    expect(sessionFrames().at(-1)?.reason).toBe("new");
    const firstModels = sessionFrames()[0]?.models;
    const nextModels = sessionFrames().at(-1)?.models;
    expect(nextModels && firstModels && { ...nextModels, sampledAt: 0 }).toEqual(
      firstModels && { ...firstModels, sampledAt: 0 },
    );
  });
});
