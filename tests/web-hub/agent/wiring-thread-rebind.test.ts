/**
 * fabric-thread rebind plan r3 §4.2 (P0b): the AGENT-side `thr.rebind.v1` cap + the
 * `feishuBot.threads.rebind` HubConfig leaf.
 *   - hello caps: `thr.rebind.v1` is tail-appended IMMEDIATELY after `thr.v1` iff
 *     `threadsCapOn() && threadsRebindCapOn()` (§4.2); either gate off ⇒ absent;
 *   - HubConfig: the `rebind` leaf rides `feishuBot.threads` only when on (rebind off ⇒
 *     byte-identical config, A16); the harness hands `threadsHubConfig` exactly what
 *     src/index.ts would build.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { wireWebHub, type WebHubDeps } from "../../../src/web-hub/agent/index.js";
import { DEFAULT_FEISHU_BOT_SETTINGS } from "../../../src/web-hub/agent/settings.js";
import type { FeishuThreadsHubConfig } from "../../../src/web-hub/protocol/feishu.js";
import { THREAD_CAP, THREAD_REBIND_CAP } from "../../../src/web-hub/protocol/version.js";
import type { AgentFrame } from "../../../src/web-hub/protocol/messages.js";
import { ackFrame, fakeCtx, fakeNet, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir("wh-d-thr-rebind-");
  resetGlobals();
});
afterEach(() => {
  resetGlobals();
  tmp.cleanup();
});

const THREADS: FeishuThreadsHubConfig = {
  handbackWindowMin: 10,
  startTimeoutMin: 8,
  retainMin: 15,
  replyPerThreadPerMin: 6,
  replyPerThreadPerHour: 60,
};

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

const flush = () => new Promise<void>((r) => setImmediate(r));

/** Drive wireWebHub to a live connection over fakeNet; return the agent's hello caps. */
async function helloCaps(over: Partial<WebHubDeps>): Promise<string[]> {
  const n = fakeNet();
  const { pi, fire } = fakePi();
  wireWebHub(pi, deps({ netConnect: n.netConnect, ...over }));
  fire("session_start", { type: "session_start", reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
  await flush();
  const s = n.sockets[0]!;
  s.emit("connect");
  s.hub(ackFrame("k1", 4242, ["cmd.v1", THREAD_CAP, THREAD_REBIND_CAP]));
  const hello = s.frames().find((f: AgentFrame) => f.t === "hello") as { caps: string[] };
  return hello.caps;
}

describe("wireWebHub — thr.rebind.v1 agent cap (rebind-plan r3 §4.2, P0b)", () => {
  it("rebind on: thr.rebind.v1 tail-appended immediately after thr.v1", async () => {
    const caps = await helloCaps({ threadsCapOn: () => true, threadsRebindCapOn: () => true });
    expect(caps).toContain(THREAD_CAP);
    expect(caps).toContain(THREAD_REBIND_CAP);
    expect(caps[caps.indexOf(THREAD_CAP) + 1]).toBe(THREAD_REBIND_CAP);
  });

  it.each([
    ["unset", undefined],
    ["off", () => false],
  ] as const)("rebind %s: thr.v1 without thr.rebind.v1", async (_name, threadsRebindCapOn) => {
    const caps = await helloCaps({
      threadsCapOn: () => true,
      ...(threadsRebindCapOn === undefined ? {} : { threadsRebindCapOn }),
    });
    expect(caps).toContain(THREAD_CAP);
    expect(caps).not.toContain(THREAD_REBIND_CAP);
  });

  it("threadsCapOn off ⇒ NEITHER thread cap, even with rebind on (§4.2: threadsCapOn() && rebindOn())", async () => {
    const caps = await helloCaps({ threadsCapOn: () => false, threadsRebindCapOn: () => true });
    expect(caps).not.toContain(THREAD_CAP);
    expect(caps).not.toContain(THREAD_REBIND_CAP);
  });
});

describe("wireWebHub — HubConfig feishuBot.threads.rebind leaf (P0b)", () => {
  async function spawnedConfig(threads: FeishuThreadsHubConfig): Promise<Record<string, unknown>> {
    const nodeLoader = join(tmp.dir, "fake-jiti-cli.mjs");
    writeFileSync(nodeLoader, "");
    const spawnImpl = vi.fn(() => ({ on: () => undefined, unref: () => undefined }) as never);
    const { pi, fire } = fakePi();
    wireWebHub(
      pi,
      deps({
        settings: { ...SETTINGS, autoStart: true, nodeLoader },
        netConnect: (() => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }) as never,
        spawnImpl,
        feishuBot: { ...DEFAULT_FEISHU_BOT_SETTINGS, enabled: true },
        threadsCapOn: () => true,
        threadsHubConfig: () => threads,
      }),
    );
    fire("session_start", { type: "session_start", reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
    await flush();
    await flush();
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const env = (spawnImpl.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2].env;
    return JSON.parse(env.PI_WEBHUB_CONFIG) as Record<string, unknown>;
  }

  it("rebind:true reaches the hub config verbatim", async () => {
    const cfg = await spawnedConfig({ ...THREADS, rebind: true });
    const feishuBot = cfg["feishuBot"] as { threads: Record<string, unknown> };
    expect(feishuBot.threads).toEqual({ ...THREADS, rebind: true });
  });

  it("rebind absent ⇒ the threads block stays the five clamped leaves (A16 byte-parity)", async () => {
    const cfg = await spawnedConfig(THREADS);
    const feishuBot = cfg["feishuBot"] as { threads: Record<string, unknown> };
    expect(feishuBot.threads).toEqual(THREADS);
    expect(feishuBot.threads).not.toHaveProperty("rebind");
  });
});
