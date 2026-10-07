// plan §6.7.1/§6.7.2 — /webhub token rotate / stop / start agent-side facade (C8).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubConnection } from "../../../src/web-hub/agent/connection.js";
import { readRotateIntentSync } from "../../../src/web-hub/protocol/rotate-intent.js";
import { readTokenFile } from "../../../src/web-hub/protocol/token-file.js";
import { resolveHubPaths } from "../../../src/web-hub/protocol/paths.js";
import { readStopMarkerSync, writeStopMarkerSync } from "../../../src/web-hub/protocol/stop-marker.js";

const mockCurrentConnection = vi.fn<() => HubConnection | undefined>(() => undefined);

vi.mock("../../../src/web-hub/agent/connection.js", () => ({
  currentConnection: () => mockCurrentConnection(),
}));

let dir: string;
let originalHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "admin-cmds-"));
  originalHome = process.env.HOME;
  process.env.HOME = dir;
  mockCurrentConnection.mockReset();
  mockCurrentConnection.mockReturnValue(undefined);
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function paths() {
  return resolveHubPaths({ home: dir, uid: process.getuid?.() ?? 0 });
}

function fakeConn(over: Partial<HubConnection> = {}): HubConnection {
  return {
    implVersion: "test#1",
    attach: () => {},
    detach: () => {},
    send: () => {},
    setSlot: () => {},
    bufferedBytes: 0,
    nextSeq: () => 1,
    seq: 0,
    status: () => ({ state: "live" }) as never,
    close: () => {},
    request: async () => {
      throw new Error("not stubbed");
    },
    caps: [],
    ...over,
  } as HubConnection;
}

describe("createAdminCommands().rotateToken()", () => {
  it("no live connection ⇒ offline path: writes intent + atomically replaces the token, leaves phase token-written for the hub's own recovery to delete", async () => {
    const { createAdminCommands } = await import("../../../src/web-hub/agent/admin-cmds.js");
    const p = paths();
    mkdirSync(p.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(p.tokenFile, "old-token\n", { mode: 0o600 });
    const outcome = await createAdminCommands().rotateToken();
    expect(outcome).toEqual({ kind: "offline" });
    expect(readTokenFile(p.tokenFile)).not.toBe("old-token");
    const intent = readRotateIntentSync(p.rotateIntentFile!);
    expect(intent).toEqual({
      state: "present",
      intent: expect.objectContaining({ by: "agent", phase: "token-written" }),
    });
  });

  it("live but caps lack ctl.v2 ⇒ { kind: 'stale-hub' }, no fs writes", async () => {
    const { createAdminCommands } = await import("../../../src/web-hub/agent/admin-cmds.js");
    const p = paths();
    mockCurrentConnection.mockReturnValue(fakeConn({ caps: ["ctl.v1"] }));
    const outcome = await createAdminCommands().rotateToken();
    expect(outcome).toEqual({ kind: "stale-hub" });
    expect(readRotateIntentSync(p.rotateIntentFile!)).toEqual({ state: "absent" });
  });

  it("live + ctl.v2 ⇒ sends hub_ctl{rotate_token} and reports the ack's revoked counts", async () => {
    const { createAdminCommands } = await import("../../../src/web-hub/agent/admin-cmds.js");
    const requested: unknown[] = [];
    mockCurrentConnection.mockReturnValue(
      fakeConn({
        caps: ["ctl.v1", "ctl.v2"],
        request: async (frame) => {
          requested.push(frame);
          return { t: "hub_ctl_ack", rid: (frame as { rid: string }).rid, revoked: { loopback: 1, lan: 2 } };
        },
      }),
    );
    const outcome = await createAdminCommands().rotateToken();
    expect(outcome).toEqual({ kind: "rotated", path: "online", revoked: { loopback: 1, lan: 2 } });
    expect(requested).toHaveLength(1);
    expect((requested[0] as { op: string }).op).toBe("rotate_token");
  });

  it("live + ctl.v2 but the ack never arrives ⇒ times out to { kind: 'unknown' } after 3s", async () => {
    vi.useFakeTimers();
    const { createAdminCommands } = await import("../../../src/web-hub/agent/admin-cmds.js");
    mockCurrentConnection.mockReturnValue(
      fakeConn({
        caps: ["ctl.v2"],
        request: () => new Promise(() => {}), // never resolves
      }),
    );
    const promise = createAdminCommands().rotateToken();
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(promise).resolves.toEqual({ kind: "unknown" });
  });

  it("live + ctl.v2 but request() rejects ⇒ { kind: 'error', message }", async () => {
    const { createAdminCommands } = await import("../../../src/web-hub/agent/admin-cmds.js");
    mockCurrentConnection.mockReturnValue(
      fakeConn({
        caps: ["ctl.v2"],
        request: async () => {
          throw new Error("socket reset");
        },
      }),
    );
    const outcome = await createAdminCommands().rotateToken();
    expect(outcome).toEqual({ kind: "error", message: "socket reset" });
  });

  it("live + ctl.v2 but the ack frame is the wrong type ⇒ { kind: 'error' } naming the frame type", async () => {
    const { createAdminCommands } = await import("../../../src/web-hub/agent/admin-cmds.js");
    mockCurrentConnection.mockReturnValue(
      fakeConn({
        caps: ["ctl.v2"],
        request: async () => ({ t: "lan_res", rid: "x", ok: true }) as never,
      }),
    );
    const outcome = await createAdminCommands().rotateToken();
    expect(outcome).toEqual({ kind: "error", message: "E_UNEXPECTED_FRAME: lan_res" });
  });
});

describe("createAdminCommands().stop()", () => {
  it("marker write failure ⇒ never touches the connection, reports marker-write-failed", async () => {
    const { createAdminCommands } = await import("../../../src/web-hub/agent/admin-cmds.js");
    const p = paths();
    // Make the stoppedFile path itself a directory so the atomic write's mkdir/rename fails.
    rmSync(p.stateDir, { recursive: true, force: true });
    mkdirSync(p.stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(p.stoppedFile!); // occupy the target path with a directory
    const requestCalls: unknown[] = [];
    mockCurrentConnection.mockReturnValue(
      fakeConn({
        caps: ["ctl.v2"],
        request: async (frame) => {
          requestCalls.push(frame);
          return { t: "hub_ctl_ack", rid: "x" };
        },
      }),
    );
    const outcome = await createAdminCommands().stop();
    expect(outcome.kind).toBe("marker-write-failed");
    expect(requestCalls).toEqual([]);
  });

  it("marker write succeeds, hub live with ctl.v2 ⇒ sends reason:'stop' and reports stopped once the pid is gone", async () => {
    const { createAdminCommands } = await import("../../../src/web-hub/agent/admin-cmds.js");
    const requested: unknown[] = [];
    mockCurrentConnection.mockReturnValue(
      fakeConn({
        caps: ["ctl.v1", "ctl.v2"],
        request: async (frame) => {
          requested.push(frame);
          return { t: "hub_ctl_ack", rid: (frame as { rid: string }).rid };
        },
      }),
    );
    const outcome = await createAdminCommands().stop();
    expect(outcome).toEqual({ kind: "stopped" });
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ op: "shutdown", reason: "stop" });
    const p = paths();
    expect(readStopMarkerSync(p.stoppedFile!).state).toBe("stopped");
  });

  it("marker write succeeds, no live connection ⇒ falls back to /proc identity path (no hub.json ⇒ manual)", async () => {
    const { createAdminCommands } = await import("../../../src/web-hub/agent/admin-cmds.js");
    mockCurrentConnection.mockReturnValue(undefined);
    const outcome = await createAdminCommands().stop();
    expect(outcome.kind).toBe("manual");
    const p = paths();
    expect(readStopMarkerSync(p.stoppedFile!).state).toBe("stopped");
  });
});

describe("createAdminCommands().start()", () => {
  it("marker present ⇒ removes it and reports started", async () => {
    const { createAdminCommands } = await import("../../../src/web-hub/agent/admin-cmds.js");
    const p = paths();
    writeStopMarkerSync(p.stoppedFile!);
    const outcome = await createAdminCommands().start();
    expect(outcome).toEqual({ kind: "started" });
    expect(readStopMarkerSync(p.stoppedFile!)).toEqual({ state: "absent" });
  });

  it("marker present but removal fails ⇒ reports started-marker-remove-failed with a code, does not throw", async () => {
    const { createAdminCommands } = await import("../../../src/web-hub/agent/admin-cmds.js");
    const p = paths();
    rmSync(p.stateDir, { recursive: true, force: true });
    mkdirSync(p.stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(p.stoppedFile!); // a directory can't be unlinkSync'd like a regular file
    const outcome = await createAdminCommands().start();
    expect(outcome.kind).toBe("started-marker-remove-failed");
    if (outcome.kind === "started-marker-remove-failed") {
      expect(typeof outcome.code).toBe("string");
      expect(outcome.code.length).toBeGreaterThan(0);
    }
  });

  it("marker absent ⇒ removeStopMarkerSync is a no-op, still reports started", async () => {
    const { createAdminCommands } = await import("../../../src/web-hub/agent/admin-cmds.js");
    const outcome = await createAdminCommands().start();
    expect(outcome).toEqual({ kind: "started" });
  });
});

describe("web-hub-spawn-restore D13: the one-shot restore.veto", () => {
  const vetoOf = (): string => join(paths().stateDir, "spawn", "restore.veto");

  it("stop() writes the veto (0600, spawn dir 0700) after the stop marker, before signaling the hub", async () => {
    const { createAdminCommands } = await import("../../../src/web-hub/agent/admin-cmds.js");
    const { existsSync, statSync } = await import("node:fs");
    let vetoAtRequest: boolean | undefined;
    mockCurrentConnection.mockReturnValue(
      fakeConn({
        caps: ["ctl.v1", "ctl.v2"],
        request: async (frame) => {
          vetoAtRequest = existsSync(vetoOf());
          return { t: "hub_ctl_ack", rid: (frame as { rid: string }).rid };
        },
      }),
    );
    const outcome = await createAdminCommands().stop();
    expect(outcome).toEqual({ kind: "stopped" });
    expect(vetoAtRequest).toBe(true); // on disk BEFORE the hub_ctl{stop} went out
    expect(statSync(vetoOf()).mode & 0o777).toBe(0o600);
    expect(statSync(join(paths().stateDir, "spawn")).mode & 0o777).toBe(0o700);
  });

  it("a veto write failure never blocks the stop", async () => {
    const { createAdminCommands } = await import("../../../src/web-hub/agent/admin-cmds.js");
    const p = paths();
    mkdirSync(p.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(p.stateDir, "spawn"), "not a dir"); // mkdir/write under it must fail
    const requested: unknown[] = [];
    mockCurrentConnection.mockReturnValue(
      fakeConn({
        caps: ["ctl.v1", "ctl.v2"],
        request: async (frame) => {
          requested.push(frame);
          return { t: "hub_ctl_ack", rid: (frame as { rid: string }).rid };
        },
      }),
    );
    const outcome = await createAdminCommands().stop();
    expect(outcome).toEqual({ kind: "stopped" });
    expect(requested[0]).toMatchObject({ op: "shutdown", reason: "stop" });
    const { writeRestoreVetoSync } = await import("../../../src/web-hub/agent/admin-cmds.js");
    const direct = writeRestoreVetoSync(p.stateDir);
    expect(direct.ok).toBe(false);
  });

  it("start() never touches the veto; clearRestoreVetoSync removes it (ENOENT = success)", async () => {
    const { createAdminCommands, writeRestoreVetoSync, clearRestoreVetoSync } =
      await import("../../../src/web-hub/agent/admin-cmds.js");
    const { existsSync } = await import("node:fs");
    const p = paths();
    expect(writeRestoreVetoSync(p.stateDir)).toEqual({ ok: true });
    await createAdminCommands().start();
    expect(existsSync(vetoOf())).toBe(true); // /webhub start does not clear it (plan §8.3)
    expect(clearRestoreVetoSync(p.stateDir)).toEqual({ ok: true });
    expect(existsSync(vetoOf())).toBe(false);
    expect(clearRestoreVetoSync(p.stateDir)).toEqual({ ok: true }); // already gone
  });
});

describe("web-hub-spawn-restore D13: /webhub restart clears the veto BEFORE restartHub (wiring pin)", () => {
  it("agent/index.ts's restart() calls clearRestoreVetoSync(paths.stateDir) ahead of the hub_ctl path", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/web-hub/agent/index.ts", "utf8");
    const m = /const restart = \(\): Promise<RestartOutcome> => \{([\s\S]*?)\n  \};/.exec(src);
    expect(m).not.toBeNull();
    const body = m![1]!;
    expect(body.indexOf("clearRestoreVetoSync(paths.stateDir)")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("clearRestoreVetoSync")).toBeLessThan(body.indexOf("restartHubWithDeps()"));
  });
});
