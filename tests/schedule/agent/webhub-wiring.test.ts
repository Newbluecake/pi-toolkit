/**
 * scheduled-reports A0: `wireWebHub` × the schedule port — `sched.v1` agent cap, `HubConfig.schedule`
 * (key absence = off), the link view the router sends through, and the sched frame hooks.
 * Without the port every surface stays byte-identical (no cap, no key, no hooks).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireWebHub, type WebHubDeps } from "../../../src/web-hub/agent/index.js";
import type { ScheduleWebHubPort, SchedHubLink } from "../../../src/schedule/agent/coordinator.js";
import {
  ackFrame,
  fakeCtx,
  fakeNet,
  fakePi,
  pathsIn,
  resetGlobals,
  SETTINGS,
  tmpDir,
} from "../../web-hub/agent/helpers.js";

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir("wh-sched-");
  resetGlobals();
});
afterEach(() => {
  resetGlobals();
  tmp.cleanup();
});

const flush = () => new Promise<void>((r) => setImmediate(r));

function port(): ScheduleWebHubPort & {
  link: SchedHubLink | undefined;
  runs: unknown[];
  receipts: unknown[];
  decides: unknown[];
  caps: number;
} {
  const p = {
    link: undefined as SchedHubLink | undefined,
    runs: [] as unknown[],
    receipts: [] as unknown[],
    decides: [] as unknown[],
    caps: 0,
    hubConfig: () => ({ dir: "/var/sched", toleranceS: 60 as const }),
    bindLink(l: SchedHubLink) {
      p.link = l;
    },
    onSchedRun: (f: unknown) => p.runs.push(f),
    onSchedReceipts: (f: unknown) => p.receipts.push(f),
    onSchedDecide: (f: unknown) => p.decides.push(f),
    onHubCaps: () => {
      p.caps += 1;
    },
  };
  return p;
}

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

async function live(d: WebHubDeps, hubCaps: string[]) {
  const { pi, fire } = fakePi();
  const n = fakeNet();
  d.netConnect = n.netConnect;
  wireWebHub(pi, d);
  fire("session_start", { type: "session_start", reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
  await flush();
  const s = n.sockets[0]!;
  s.emit("connect");
  s.hub(ackFrame("k1", 4242, hubCaps));
  return s;
}

async function launchedConfig(over: Partial<WebHubDeps>): Promise<Record<string, unknown>> {
  const loader = join(tmp.dir, "fake-jiti-cli.mjs");
  writeFileSync(loader, "");
  const spawnImpl = vi.fn(() => ({ on: () => undefined, unref: () => undefined }) as never);
  const { pi, fire } = fakePi();
  const settings = { ...SETTINGS, autoStart: true, nodeLoader: loader, ...(over.settings ?? {}) };
  wireWebHub(pi, {
    ...deps(),
    netConnect: (() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }) as never,
    spawnImpl,
    ...over,
    settings,
  });
  fire("session_start", { type: "session_start", reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
  await flush();
  await flush();
  expect(spawnImpl).toHaveBeenCalledTimes(1);
  const call = spawnImpl.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
  return JSON.parse(call[2].env.PI_WEBHUB_CONFIG ?? "{}") as Record<string, unknown>;
}

describe("wireWebHub × schedule port", () => {
  it("hello carries sched.v1 only with the port; hub frames reach the port; caps hook fires per hello_ack", async () => {
    const p = port();
    const s = await live(deps({ schedule: p }), ["sched.v1"]);
    const hello = s.frames().find((f) => f.t === "hello") as { caps: string[] };
    expect(hello.caps).toContain("sched.v1");
    expect(p.caps).toBe(1);
    expect(p.link?.ready()).toBe(true);
    p.link!.send({ t: "sched_changed", sessionId: "sid-1" });
    expect(s.frames()).toContainEqual({ t: "sched_changed", sessionId: "sid-1" });
    const run = {
      t: "sched_run" as const,
      reqId: "fsAbCdEfGhIjKlMnOpQrStUvWxYz0123",
      sessionId: "sid-1",
      taskId: "s_abcdefgh",
      defHash: "a".repeat(64),
      expiresAt: 1,
    };
    s.hub(run);
    s.hub({ t: "sched_receipts" as const, sessionId: "sid-1", reportIds: ["b".repeat(64)] });
    expect(p.runs).toEqual([run]);
    expect(p.receipts).toHaveLength(1);
  });

  it("the link is not ready while the hub lacks sched.v1", async () => {
    const p = port();
    await live(deps({ schedule: p }), []);
    expect(p.link?.ready()).toBe(false);
  });

  it("#61 C2: hello carries sched.confirm.v1 with the port; sched_decide reaches it; confirmReady needs both caps", async () => {
    const p = port();
    const s = await live(deps({ schedule: p }), ["sched.v1", "sched.confirm.v1"]);
    const hello = s.frames().find((f) => f.t === "hello") as { caps: string[] };
    expect(hello.caps).toContain("sched.v1");
    expect(hello.caps).toContain("sched.confirm.v1");
    expect(p.link?.ready()).toBe(true);
    expect(p.link?.confirmReady?.()).toBe(true);
    const decide = {
      t: "sched_decide" as const,
      reqId: "fsAbCdEfGhIjKlMnOpQrStUvWxYz0123",
      sessionId: "sid-1",
      offerId: "ofAbCdEfGhIjKlMnOpQrStUvWxYz0123",
      taskId: "s_abcdefgh",
      defHash: "a".repeat(64),
      decision: "approve" as const,
      expiresAt: 1,
    };
    s.hub(decide);
    expect(p.decides).toEqual([decide]);
  });

  it("#61 C2: sched.v1 without sched.confirm.v1 ⇒ link ready but NOT confirmReady (TUI-only)", async () => {
    const p = port();
    await live(deps({ schedule: p }), ["sched.v1"]);
    expect(p.link?.ready()).toBe(true);
    expect(p.link?.confirmReady?.()).toBe(false);
  });

  it("#61 C2: no port ⇒ no sched.confirm.v1 in hello (pre-feature shape)", async () => {
    const s = await live(deps(), ["sched.v1", "sched.confirm.v1"]);
    const hello = s.frames().find((f) => f.t === "hello") as { caps: string[] };
    expect(hello.caps).not.toContain("sched.confirm.v1");
  });

  it("no port ⇒ no sched.v1 in hello (pre-feature shape)", async () => {
    const s = await live(deps(), ["sched.v1"]);
    const hello = s.frames().find((f) => f.t === "hello") as { caps: string[] };
    expect(hello.caps).not.toContain("sched.v1");
  });

  it("HubConfig.schedule is written with the port and control on", async () => {
    expect((await launchedConfig({ schedule: port() })).schedule).toEqual({ dir: "/var/sched", toleranceS: 60 });
  });
  it("HubConfig.schedule is absent without the port", async () => {
    expect(await launchedConfig({})).not.toHaveProperty("schedule");
  });
  it("HubConfig.schedule is absent when the store dir is unusable", async () => {
    const broken = port();
    broken.hubConfig = () => undefined;
    expect(await launchedConfig({ schedule: broken })).not.toHaveProperty("schedule");
  });
});
