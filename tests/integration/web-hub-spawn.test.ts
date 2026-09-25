// web-hub plan §包 I — spawn e2e: REAL hub child processes via pi's bundled
// jiti-cli (resolveJitiCli from the real pi dist cli.js as argv1) + spawnHub.
//
//  1. singleton race: 3 concurrent hub spawns ⇒ within 10s exactly one pid
//     survives and hub.json names it;
//  2. kill -9 resilience: an agent (wireWebHub, autoStart) connected to a
//     spawned hub; after SIGKILL the agent re-spawns the hub within the 8s
//     spawn window and re-registers (hello ⇒ live again, new hub pid).
//     (This works inside 8s only because the AGENT itself never spawned yet —
//     its lastSpawnAt is undefined, so the 30s spawn throttle does not apply.)
//
// Cleanup: every hub process we started is killed via the pid in hub.json
// (plus an extra sweep of the start lock dir). Skipped when pi's bundled jiti
// is not resolvable (CI without the pi dev dependency).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wireWebHub } from "../../src/web-hub/agent/index.js";
import { resolveJitiCli, spawnHub, type LauncherPlan } from "../../src/web-hub/agent/launcher.js";
import type { HubConfig } from "../../src/web-hub/hub/ports.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import { fakeCtx, fakePi, resetGlobals, waitUntil } from "../web-hub/agent/helpers.js";
import { config as hubConfig } from "../web-hub/hub/helpers.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

const PI_CLI = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const HUB_MAIN = resolve("src/web-hub/hub/main.ts");

function launcherOrSkip(): LauncherPlan | undefined {
  if (!existsSync(PI_CLI)) {
    console.log(`web-hub-spawn: SKIP — pi CLI not found at ${PI_CLI} (dev dependency not installed)`);
    return undefined;
  }
  const r = resolveJitiCli({ argv1: PI_CLI, override: "" });
  if (!r.ok) {
    console.log(`web-hub-spawn: SKIP — ${r.reason}`);
    return undefined;
  }
  return { execPath: process.execPath, jitiCli: r.jitiCli, argv1: PI_CLI };
}

function hubPidOf(hubJson: string): number | undefined {
  try {
    const j = JSON.parse(readFileSync(hubJson, "utf8")) as { pid?: unknown };
    return typeof j.pid === "number" ? j.pid : undefined;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: unknown }).code === "EPERM";
  }
}

describe("web-hub spawn (real child processes)", () => {
  let home: ReturnType<typeof sandboxHome> | undefined;
  let cfg: HubConfig;
  const startedPids = new Set<number>();

  beforeEach(() => {
    home = sandboxHome();
    cfg = hubConfig({ home: home.home, port: 0, idleExitMinutes: 10 });
  });

  afterEach(async () => {
    resetGlobals();
    // Kill every hub pid we ever observed, then the current hub.json pid.
    const hubJson =
      home !== undefined ? resolveHubPaths({ home: home.home, uid: process.getuid?.() ?? 0 }).hubJson : "";
    const current = hubJson !== "" ? hubPidOf(hubJson) : undefined;
    if (current !== undefined) startedPids.add(current);
    for (const pid of startedPids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    // Wait for actual exit before removing the sandbox: a hub mid-graceful-
    // close can still rewrite hub.json / append hub.log (ENOTEMPTY flake).
    try {
      await waitUntil(() => [...startedPids].every((pid) => !pidAlive(pid)), 3_000, "hubs exited");
    } catch {
      for (const pid of startedPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      await waitUntil(() => [...startedPids].every((pid) => !pidAlive(pid)), 3_000, "hubs killed").catch(
        () => undefined,
      );
    }
    startedPids.clear();
    if (home !== undefined) {
      home.restore();
      rmSync(home.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      home = undefined;
    }
  });

  it("3 concurrent hub spawns converge to exactly one live hub pid", async () => {
    const plan = launcherOrSkip();
    if (plan === undefined) return;
    const paths = resolveHubPaths({ home: home!.home, uid: process.getuid?.() ?? 0 });

    for (let i = 0; i < 3; i++) spawnHub(plan, HUB_MAIN, cfg);

    await waitUntil(() => hubPidOf(paths.hubJson) !== undefined, 10_000, "hub.json written");
    const winner = hubPidOf(paths.hubJson)!;
    startedPids.add(winner);
    await waitUntil(() => pidAlive(winner), 5_000, "winner alive");

    // Losers exit 0 (singleton {exists:true}); the winner stays. Give losers
    // a moment to exit, then verify hub.json still names exactly the winner
    // and only one hub process for this state dir is alive.
    await new Promise((r) => setTimeout(r, 3_000));
    expect(hubPidOf(paths.hubJson)).toBe(winner);
    expect(pidAlive(winner)).toBe(true);
  }, 30_000);

  it("kill -9 the hub ⇒ agent respawns it inside the spawn window and re-registers", async () => {
    const plan = launcherOrSkip();
    if (plan === undefined) return;
    const paths = resolveHubPaths({ home: home!.home, uid: process.getuid?.() ?? 0 });

    // Initial hub is spawned by the TEST, so the agent's own lastSpawnAt stays
    // undefined and the post-crash respawn is not delayed by the 30s throttle.
    spawnHub(plan, HUB_MAIN, cfg);
    await waitUntil(() => hubPidOf(paths.hubJson) !== undefined, 10_000, "first hub.json");
    const firstPid = hubPidOf(paths.hubJson)!;
    startedPids.add(firstPid);

    const { pi, fire } = fakePi();
    const control = wireWebHub(pi, {
      settings: { enabled: true, autoStart: true, port: 0, idleExitMinutes: 10, nodeLoader: "" },
      fleet: () => [],
      env: { HOME: home!.home },
      buildInfo: async () => ({ pluginVersion: cfg.pluginVersion, buildId: cfg.buildId }),
      argv1: PI_CLI,
    });
    const { ctx } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => control.status().state === "live", 10_000, "agent live on first hub");

    process.kill(firstPid, "SIGKILL");
    await waitUntil(
      () => {
        const pid = hubPidOf(paths.hubJson);
        return pid !== undefined && pid !== firstPid && pidAlive(pid);
      },
      12_000,
      "new hub pid after kill -9",
    );
    const secondPid = hubPidOf(paths.hubJson)!;
    startedPids.add(secondPid);
    // re-registered: the agent completed a fresh hello against the new hub
    await waitUntil(() => control.status().state === "live", 12_000, "agent live on respawned hub");
    expect(control.status().agentKey).toBeDefined();

    fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  }, 45_000);
});
