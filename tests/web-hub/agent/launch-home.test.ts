/** D-B-launchHome: the hub launch home is an explicit seam, never inferred from HubPaths. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { wireWebHub, type WebHubDeps } from "../../../src/web-hub/agent/index.js";
import { fakeCtx, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir("wh-launch-home-");
  resetGlobals();
});
afterEach(() => {
  resetGlobals();
  tmp.cleanup();
});

function nodeLoader(): string {
  const file = join(tmp.dir, "fake-jiti-cli.mjs");
  writeFileSync(file, "");
  return file;
}

function connect(): typeof import("node:net").connect {
  return (() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }) as unknown as typeof import("node:net").connect;
}

async function launchedConfig(over: Partial<WebHubDeps> = {}): Promise<Record<string, unknown>> {
  const spawnImpl = vi.fn(() => ({ on: () => undefined, unref: () => undefined }) as never);
  const { pi, fire } = fakePi();
  wireWebHub(pi, {
    settings: { ...SETTINGS, autoStart: true, nodeLoader: nodeLoader() },
    fleet: () => [],
    env: { HOME: tmp.dir },
    paths: pathsIn(tmp.dir),
    argv1: "/nonexistent/pi",
    buildInfo: async () => ({ pluginVersion: "1.0.0", buildId: "test" }),
    netConnect: connect(),
    spawnImpl,
    ...over,
  });
  fire("session_start", { type: "session_start", reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(spawnImpl).toHaveBeenCalledTimes(1);
  const call = spawnImpl.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
  return JSON.parse(call[2].env.PI_WEBHUB_CONFIG ?? "{}") as Record<string, unknown>;
}

describe("wireWebHub launchHome", () => {
  it("uses the explicit launchHome even when paths points at a different sandbox", async () => {
    const launchHome = join(tmp.dir, "launched-home");
    const config = await launchedConfig({ launchHome });
    expect(config.home).toBe(launchHome);
  });

  it("keeps the historical HOME resolution when launchHome is omitted", async () => {
    const config = await launchedConfig();
    expect(config.home).toBe(tmp.dir);
  });
});
