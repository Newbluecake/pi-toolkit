import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restartHub, type HubIdentityRecord, type RestartDeps } from "../../../src/web-hub/agent/restart.js";
import type { HubCtlAckFrame, LanResFrame } from "../../../src/web-hub/protocol/messages.js";
import type { IdentityVerdict } from "../../../src/web-hub/agent/proc-identity.js";

function baseDeps(over: Partial<RestartDeps> = {}): RestartDeps {
  return {
    isLiveWithCap: () => false,
    request: async () => {
      throw new Error("should not be called");
    },
    readHubRecord: () => undefined,
    pidAlive: () => false,
    verifyIdentity: async (): Promise<IdentityVerdict> => ({ ok: true }),
    readStartTicksNow: async () => undefined,
    kill: () => undefined,
    spawn: () => undefined,
    now: () => 0,
    ...over,
  };
}

describe("restartHub (plan §8.2; LE)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ctl.v1 path: acks, pid exits, respawns — never touches /proc identity", async () => {
    const record: HubIdentityRecord = { pid: 555, procStartTicks: 1, argv: ["a", "b", "c"] };
    let alive = true;
    const kill = vi.fn();
    const verifyIdentity = vi.fn(async (): Promise<IdentityVerdict> => ({ ok: true }));
    const readStartTicksNow = vi.fn(async () => 1);
    const spawn = vi.fn();
    const deps = baseDeps({
      isLiveWithCap: (cap) => cap === "ctl.v1",
      request: async (frame): Promise<HubCtlAckFrame> => ({ t: "hub_ctl_ack", rid: frame.rid }),
      readHubRecord: () => record,
      pidAlive: () => alive,
      kill,
      verifyIdentity,
      readStartTicksNow,
      spawn,
      now: () => Date.now(),
    });
    const done = vi.fn();
    void restartHub(deps).then(done);
    await vi.advanceTimersByTimeAsync(50);
    alive = false;
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toHaveBeenCalledWith({ kind: "restarted" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
    expect(verifyIdentity).not.toHaveBeenCalled();
    expect(readStartTicksNow).not.toHaveBeenCalled();
  });

  it("ctl.v1 acked but pid never exits within 5s ⇒ failed, no spawn, no /proc reads", async () => {
    const record: HubIdentityRecord = { pid: 555, procStartTicks: 1, argv: ["a", "b", "c"] };
    const kill = vi.fn();
    const verifyIdentity = vi.fn(async (): Promise<IdentityVerdict> => ({ ok: true }));
    const spawn = vi.fn();
    const deps = baseDeps({
      isLiveWithCap: (cap) => cap === "ctl.v1",
      request: async (frame): Promise<HubCtlAckFrame> => ({ t: "hub_ctl_ack", rid: frame.rid }),
      readHubRecord: () => record,
      pidAlive: () => true,
      kill,
      verifyIdentity,
      spawn,
      now: () => Date.now(),
    });
    const done = vi.fn();
    void restartHub(deps).then(done);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(done.mock.calls[0]?.[0]?.kind).toBe("failed");
    expect(spawn).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(verifyIdentity).not.toHaveBeenCalled();
  });

  it("ctl.v1 available but hub never acks (hung) ⇒ falls back to /proc identity path", async () => {
    const record: HubIdentityRecord = { pid: 777, procStartTicks: 42, argv: ["a", "b", "c"] };
    const kill = vi.fn();
    const readStartTicksNow = vi.fn(async () => 42);
    const request = vi.fn((): Promise<HubCtlAckFrame | LanResFrame> => new Promise(() => undefined));
    const deps = baseDeps({
      isLiveWithCap: (cap) => cap === "ctl.v1",
      request,
      readHubRecord: () => record,
      verifyIdentity: async (): Promise<IdentityVerdict> => ({ ok: true }),
      readStartTicksNow,
      kill,
      now: () => Date.now(),
    });
    const done = vi.fn();
    void restartHub(deps).then(done);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(done).toHaveBeenCalledWith({ kind: "signalled" });
    expect(kill).toHaveBeenCalledWith(777, "SIGTERM");
  });

  it("no ctl.v1 cap at all ⇒ straight to /proc fallback, never calls request()", async () => {
    const record: HubIdentityRecord = { pid: 9, procStartTicks: 5, argv: ["a", "b", "c"] };
    const request = vi.fn();
    const deps = baseDeps({
      isLiveWithCap: () => false,
      request,
      readHubRecord: () => record,
      verifyIdentity: async (): Promise<IdentityVerdict> => ({ ok: true }),
      readStartTicksNow: async () => 5,
      kill: vi.fn(),
    });
    const outcome = await restartHub(deps);
    expect(outcome).toEqual({ kind: "signalled" });
    expect(request).not.toHaveBeenCalled();
  });

  it("P1 old hub (no procStartTicks/argv) ⇒ manual message, process.kill never called", async () => {
    const kill = vi.fn();
    const deps = baseDeps({
      readHubRecord: () => ({ pid: 321 }),
      kill,
    });
    const outcome = await restartHub(deps);
    expect(outcome.kind).toBe("manual");
    if (outcome.kind === "manual") {
      expect(outcome.message).toContain("321");
      expect(outcome.message).toMatch(/旧版本/);
      expect(outcome.message).not.toMatch(/undefined/);
    }
    expect(kill).not.toHaveBeenCalled();
  });

  it("hub.json missing entirely ⇒ manual, no kill", async () => {
    const kill = vi.fn();
    const outcome = await restartHub(baseDeps({ readHubRecord: () => undefined, kill }));
    expect(outcome.kind).toBe("manual");
    expect(kill).not.toHaveBeenCalled();
  });

  it("non-linux verdict ⇒ manual (same manual-steps message shape as P1 old hub), no kill", async () => {
    const kill = vi.fn();
    const record: HubIdentityRecord = { pid: 88, procStartTicks: 1, argv: ["a", "b", "c"] };
    const outcome = await restartHub(
      baseDeps({
        readHubRecord: () => record,
        verifyIdentity: async (): Promise<IdentityVerdict> => ({ ok: false, reason: "non-linux" }),
        kill,
      }),
    );
    expect(outcome.kind).toBe("manual");
    if (outcome.kind === "manual") expect(outcome.message).toMatch(/旧版本/);
    expect(kill).not.toHaveBeenCalled();
  });

  it.each([["argv-shape"], ["starttime-mismatch"], ["cmdline-mismatch"], ["uid-mismatch"]] as const)(
    "identity reject reason %s ⇒ manual, no kill (PID reuse / similar path / uid mismatch)",
    async (reason) => {
      const kill = vi.fn();
      const record: HubIdentityRecord = { pid: 42, procStartTicks: 1, argv: ["a", "b", "c"] };
      const outcome = await restartHub(
        baseDeps({
          readHubRecord: () => record,
          verifyIdentity: async (): Promise<IdentityVerdict> => ({ ok: false, reason }),
          kill,
        }),
      );
      expect(outcome).toEqual({ kind: "manual", message: expect.stringContaining(reason) });
      expect(kill).not.toHaveBeenCalled();
    },
  );

  it("identity ok, but the pid was replaced between check and signal (race window) ⇒ manual, no kill", async () => {
    const kill = vi.fn();
    const record: HubIdentityRecord = { pid: 42, procStartTicks: 1, argv: ["a", "b", "c"] };
    const outcome = await restartHub(
      baseDeps({
        readHubRecord: () => record,
        verifyIdentity: async (): Promise<IdentityVerdict> => ({ ok: true }),
        readStartTicksNow: async () => 999,
        kill,
      }),
    );
    expect(outcome.kind).toBe("manual");
    if (outcome.kind === "manual") expect(outcome.message).toMatch(/starttime-mismatch/);
    expect(kill).not.toHaveBeenCalled();
  });

  it("race re-check read failure (process vanished) ⇒ manual, no kill", async () => {
    const kill = vi.fn();
    const record: HubIdentityRecord = { pid: 42, procStartTicks: 1, argv: ["a", "b", "c"] };
    const outcome = await restartHub(
      baseDeps({
        readHubRecord: () => record,
        verifyIdentity: async (): Promise<IdentityVerdict> => ({ ok: true }),
        readStartTicksNow: async () => undefined,
        kill,
      }),
    );
    expect(outcome.kind).toBe("manual");
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("ctlLivenessProbe (plan §8.2: the ctl path reads no /proc)", () => {
  it("probes with kill(pid, 0) only and never reads /proc", async () => {
    const pid = await import("../../../src/web-hub/protocol/pid.js");
    const { ctlLivenessProbe } = await import("../../../src/web-hub/agent/restart.js");
    const kills: number[] = [];
    // alive: kill(pid, 0) succeeds; a /proc read (if any) would throw from the probe's own stub — result must be true without it.
    expect(ctlLivenessProbe(4242, (p) => void kills.push(p))).toBe(true);
    // dead: ESRCH
    const esrch = Object.assign(new Error("no such process"), { code: "ESRCH" });
    expect(
      ctlLivenessProbe(4242, () => {
        throw esrch;
      }),
    ).toBe(false);
    expect(kills).toEqual([4242]);
    void pid;
  });

  it("the production wiring never passes a /proc-reading probe to restartHub", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../../../src/web-hub/agent/index.ts", import.meta.url), "utf8");
    expect(src).toMatch(/pidAlive: \(pid\) => ctlLivenessProbe\(pid\)/);
  });
});
