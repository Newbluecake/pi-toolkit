import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireWebHub, type WebHubDeps } from "../../../src/web-hub/agent/index.js";
import { writeRestoreVetoSync } from "../../../src/web-hub/agent/admin-cmds.js";
import { shouldSpawnHub } from "../../../src/web-hub/agent/launcher.js";
import * as identity from "../../../src/web-hub/agent/proc-identity.js";
import * as restart from "../../../src/web-hub/agent/restart.js";
import * as markers from "../../../src/web-hub/protocol/stop-marker.js";
import { ackFrame, fakeCtx, fakeNet, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
let stoppedFile: string;
beforeEach(() => {
  vi.useFakeTimers();
  tmp = tmpDir("wh-restart-fence-");
  stoppedFile = join(tmp.dir, "stopped");
  resetGlobals();
});
afterEach(() => {
  resetGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  tmp.cleanup();
});

function otherAgentCanSpawn(): boolean {
  return shouldSpawnHub({
    autoStart: true,
    headless: false,
    launcherOk: true,
    lastSpawnAt: undefined,
    now: Date.now(),
    stoppedFile,
  });
}

async function live(over: Partial<WebHubDeps> = {}, caps = ["ctl.v1"], startupWaitMs = 0) {
  const nodeLoader = join(tmp.dir, "jiti.mjs");
  writeFileSync(nodeLoader, "");
  const net = fakeNet();
  const { pi, fire } = fakePi();
  const spawnImpl = vi.fn(() => ({ on: () => undefined, unref: () => undefined }) as never);
  const control = wireWebHub(pi, {
    settings: {
      ...SETTINGS,
      nodeLoader,
      proxy: { enabled: true, portRange: "7900-7949", maxProxies: 8 },
    },
    fleet: () => [],
    env: { HOME: tmp.dir },
    paths: { ...pathsIn(tmp.dir), stoppedFile },
    buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "restart-test" }),
    argv1: "/nonexistent/pi",
    netConnect: net.netConnect,
    spawnImpl,
    ...over,
  });
  fire("session_start", { reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
  await vi.advanceTimersByTimeAsync(startupWaitMs);
  const socket = net.sockets[0]!;
  socket.emit("connect");
  socket.hub(ackFrame("a1-key", 4242, caps));
  expect(control.status().state).toBe("live");
  return {
    control,
    socket,
    spawnImpl,
    ack: () => {
      const frame = socket.frames().find((f) => f.t === "hub_ctl");
      expect(frame).toMatchObject({ op: "shutdown", reason: "restart" });
      socket.hub({ t: "hub_ctl_ack", rid: String(frame!.rid) });
    },
  };
}

function readMarker(): markers.StopMarker {
  return JSON.parse(readFileSync(stoppedFile, "utf8")) as markers.StopMarker;
}

function hubRecord(): void {
  writeFileSync(pathsIn(tmp.dir).hubJson, JSON.stringify({ pid: 555, procStartTicks: 42, argv: ["a", "b", "c"] }));
}

describe("wireWebHub restart fence", () => {
  it("fences before shutdown, blocks another agent during waitExit, then clears immediately before one fresh-config spawn", async () => {
    const h = await live();
    hubRecord();
    expect(writeRestoreVetoSync(tmp.dir)).toEqual({ ok: true });
    const veto = join(tmp.dir, "spawn", "restore.veto");
    expect(existsSync(veto)).toBe(true);
    let alive = true;
    vi.spyOn(restart, "ctlLivenessProbe").mockImplementation(() => alive);
    const write = h.socket.write.bind(h.socket);
    vi.spyOn(h.socket, "write").mockImplementation((chunk) => {
      if (JSON.parse(chunk).t === "hub_ctl") {
        expect(existsSync(veto)).toBe(false);
        expect(readMarker()).toMatchObject({ v: 1, pid: process.pid, at: Date.now(), by: "agent", fence: "restart" });
        expect(otherAgentCanSpawn()).toBe(false);
      }
      return write(chunk);
    });
    h.spawnImpl.mockImplementation(() => {
      expect(markers.readStopMarkerSync(stoppedFile)).toEqual({ state: "absent" });
      return { on: () => undefined, unref: () => undefined } as never;
    });
    const done = h.control.lan.restart();
    h.ack();
    await vi.advanceTimersByTimeAsync(50);
    expect(otherAgentCanSpawn()).toBe(false);
    expect(h.spawnImpl).not.toHaveBeenCalled();
    alive = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(await done).toEqual({ kind: "restarted" });
    expect(h.spawnImpl).toHaveBeenCalledTimes(1);
    const call = h.spawnImpl.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(JSON.parse(call[2].env.PI_WEBHUB_CONFIG!).proxy).toEqual({ portRange: [7900, 7949], maxProxies: 8 });
    expect(otherAgentCanSpawn()).toBe(true);
  });

  it("keeps the fence through asynchronous build-info preparation", async () => {
    let resolveInfo!: (info: { pluginVersion: string; buildId: string }) => void;
    const info = new Promise<{ pluginVersion: string; buildId: string }>((resolve) => (resolveInfo = resolve));
    // Session attachment uses the bounded fallback; restart still waits for this promise.
    const h = await live({ buildInfo: () => info }, ["ctl.v1"], 3_000);
    const done = h.control.lan.restart();
    h.ack();
    await vi.advanceTimersByTimeAsync(0);
    expect(otherAgentCanSpawn()).toBe(false);
    expect(h.spawnImpl).not.toHaveBeenCalled();
    resolveInfo({ pluginVersion: "2.0.0", buildId: "fresh" });
    expect(await done).toEqual({ kind: "restarted" });
    expect(h.spawnImpl).toHaveBeenCalledTimes(1);
    expect(markers.readStopMarkerSync(stoppedFile)).toEqual({ state: "absent" });
  });

  it.each(["stopped", "unknown"])("preserves an existing %s marker without writing or removing it", async (state) => {
    const h = await live();
    if (state === "stopped") markers.writeStopMarkerSync(stoppedFile);
    else mkdirSync(stoppedFile);
    const write = vi.spyOn(markers, "writeStopMarkerSync");
    const remove = vi.spyOn(markers, "removeRestartFenceSync");
    const done = h.control.lan.restart();
    h.ack();
    expect(await done).toEqual({ kind: "restarted" });
    await vi.advanceTimersByTimeAsync(0);
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(markers.readStopMarkerSync(stoppedFile).state).toBe(state);
    expect(h.spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("a fence write failure retains the legacy spawn path", async () => {
    const h = await live();
    vi.spyOn(markers, "writeStopMarkerSync").mockImplementation(() => {
      throw new Error("EACCES");
    });
    const remove = vi.spyOn(markers, "removeRestartFenceSync");
    const done = h.control.lan.restart();
    h.ack();
    expect(await done).toEqual({ kind: "restarted" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawnImpl).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(markers.readStopMarkerSync(stoppedFile)).toEqual({ state: "absent" });
  });

  it("cleans the fence on ack timeout and /proc fallback without spawning", async () => {
    const h = await live();
    hubRecord();
    vi.spyOn(identity, "verifyProcIdentity").mockResolvedValue({ ok: true });
    vi.spyOn(identity, "readStartTicksNow").mockResolvedValue(42);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const done = h.control.lan.restart();
    expect(otherAgentCanSpawn()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await done).toEqual({ kind: "signalled" });
    expect(kill).toHaveBeenCalledWith(555, "SIGTERM");
    expect(h.spawnImpl).not.toHaveBeenCalled();
    expect(markers.readStopMarkerSync(stoppedFile)).toEqual({ state: "absent" });
  });

  it("cleans the fence when the old hub never exits (failed)", async () => {
    const h = await live();
    hubRecord();
    vi.spyOn(restart, "ctlLivenessProbe").mockReturnValue(true);
    const done = h.control.lan.restart();
    h.ack();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await done).toMatchObject({ kind: "failed" });
    expect(h.spawnImpl).not.toHaveBeenCalled();
    expect(markers.readStopMarkerSync(stoppedFile)).toEqual({ state: "absent" });
  });

  it("cleans the fence if the launcher cannot be resolved", async () => {
    const h = await live({ settings: { ...SETTINGS, nodeLoader: "/nonexistent/jiti-cli.mjs" } });
    const done = h.control.lan.restart();
    h.ack();
    expect(await done).toEqual({ kind: "restarted" });
    expect(h.spawnImpl).not.toHaveBeenCalled();
    expect(markers.readStopMarkerSync(stoppedFile)).toEqual({ state: "absent" });
  });

  it("cleans the fence on a manual fallback", async () => {
    const h = await live({}, []);
    expect(await h.control.lan.restart()).toMatchObject({ kind: "manual" });
    expect(h.spawnImpl).not.toHaveBeenCalled();
    expect(markers.readStopMarkerSync(stoppedFile)).toEqual({ state: "absent" });
  });

  it("cleans the fence when the fallback throws", async () => {
    const h = await live({}, []);
    hubRecord();
    vi.spyOn(identity, "verifyProcIdentity").mockRejectedValue(new Error("probe failed"));
    await expect(h.control.lan.restart()).rejects.toThrow("probe failed");
    expect(h.spawnImpl).not.toHaveBeenCalled();
    expect(markers.readStopMarkerSync(stoppedFile)).toEqual({ state: "absent" });
  });

  it.each(["stop", "other-fence"])("does not remove a replacement %s during spawn or finally", async (kind) => {
    const h = await live();
    const done = h.control.lan.restart();
    const ours = readMarker();
    const replacement: markers.StopMarker = {
      v: 1,
      at: ours.at + 1,
      pid: process.pid,
      by: "agent",
      ...(kind === "other-fence" ? { fence: "restart" as const } : {}),
    };
    markers.writeStopMarkerSync(stoppedFile, replacement);
    h.ack();
    expect(await done).toEqual({ kind: "restarted" });
    expect(h.spawnImpl).toHaveBeenCalledTimes(1);
    expect(readMarker()).toEqual(replacement);
  });
});
