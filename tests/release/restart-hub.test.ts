/**
 * D — scripts/release/restart-hub.ts. Orchestration is exercised with fakes (every branch of the
 * skip / ctl / fallback / observe matrix), the wire client against a real unix-socket server that
 * speaks just enough of the hub protocol, and the mapping of results to exit code + log level.
 * The real-process end to end lives in tests/integration/web-hub-restart-script.test.ts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  connectControl,
  parseWaitMs,
  reportResult,
  restartRunningHub,
  DEFAULT_WAIT_NEW_HUB_MS,
  type RestartHubDeps,
  type RestartHubResult,
} from "../../scripts/release/restart-hub.js";
import type { HubCtlAckFrame, HubCtlFrame } from "../../src/web-hub/protocol/messages.js";
import { encodeFrame, NdjsonDecoder } from "../../src/web-hub/protocol/ndjson.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";

const ALIVE = process.pid; // a pid that is certainly alive
const OTHER_ALIVE = process.ppid; // a different live pid for "the new hub"

type Logged = Array<[string, string]>;

function makeDeps(over: Partial<RestartHubDeps> = {}): { deps: RestartHubDeps; logs: Logged; killed: number[] } {
  const logs: Logged = [];
  const killed: number[] = [];
  const paths = resolveHubPaths({ home: "/tmp/none", uid: 1 });
  const deps: RestartHubDeps = {
    paths,
    diskVersion: () => "0.10.2",
    readRecord: () => ({ pid: ALIVE, version: "0.10.2" }),
    stopMarkerSet: () => false,
    connect: async () => ({
      ok: true,
      caps: ["ctl.v1", "ctl.v2"],
      request: async (f: HubCtlFrame) => ({ t: "hub_ctl_ack", rid: f.rid }) as HubCtlAckFrame,
      close: () => {},
    }),
    restartDeps: {
      readHubRecord: () => ({ pid: ALIVE }),
      // the old hub "exits" as soon as the ack landed
      pidAlive: () => false,
      verifyIdentity: async () => ({ ok: true as const }),
      readStartTicksNow: async () => undefined,
      kill: (pid) => {
        killed.push(pid);
      },
      now: Date.now,
    },
    waitNewHubMs: 0,
    sleep: async () => {},
    log: (l, m) => {
      logs.push([l, m]);
    },
    ...over,
  };
  return { deps, logs, killed };
}

describe("restartRunningHub — skips never touch the hub", () => {
  it("no hub.json ⇒ skipped(no-hub), INFO, no connect", async () => {
    const connect = vi.fn();
    const { deps, logs } = makeDeps({ readRecord: () => undefined, connect });
    expect(await restartRunningHub(deps)).toEqual({ kind: "skipped", reason: "no-hub" });
    expect(connect).not.toHaveBeenCalled();
    expect(logs[0]![0]).toBe("INFO");
  });

  it("hub.json names a dead pid ⇒ skipped(no-hub)", async () => {
    const connect = vi.fn();
    const { deps } = makeDeps({ readRecord: () => ({ pid: 2_147_483_000 }), connect });
    expect(await restartRunningHub(deps)).toEqual({ kind: "skipped", reason: "no-hub" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("hub.json without a pid ⇒ skipped(no-hub)", async () => {
    const { deps } = makeDeps({ readRecord: () => ({ version: "1.0.0" }) });
    expect(await restartRunningHub(deps)).toEqual({ kind: "skipped", reason: "no-hub" });
  });

  it("stop marker set (/webhub stop) ⇒ skipped(stopped): a stopped hub is never resurrected", async () => {
    const connect = vi.fn();
    const { deps, logs } = makeDeps({ stopMarkerSet: () => true, connect });
    expect(await restartRunningHub(deps)).toEqual({ kind: "skipped", reason: "stopped" });
    expect(connect).not.toHaveBeenCalled();
    expect(logs.map(([l]) => l)).toEqual(["INFO"]);
  });

  it("hub without ctl.v1 ⇒ skipped(no-ctl) with a WARN telling the user what to do", async () => {
    const close = vi.fn();
    const { deps, logs } = makeDeps({
      connect: async () => ({
        ok: true,
        caps: ["ev.v1"],
        request: async () => ({ t: "hub_ctl_ack", rid: "x" }),
        close,
      }),
    });
    expect(await restartRunningHub(deps)).toEqual({ kind: "skipped", reason: "no-ctl" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(logs[0]![0]).toBe("WARN");
    expect(logs[0]![1]).toContain("/webhub restart");
  });
});

describe("restartRunningHub — ctl path", () => {
  it("sends hub_ctl shutdown/restart over the live link, closes it, and reports the new hub", async () => {
    const sent: HubCtlFrame[] = [];
    const close = vi.fn();
    let polls = 0;
    const { deps } = makeDeps({
      connect: async () => ({
        ok: true,
        caps: ["ctl.v1"],
        request: async (f: HubCtlFrame) => {
          sent.push(f);
          return { t: "hub_ctl_ack", rid: f.rid } as HubCtlAckFrame;
        },
        close,
      }),
      // first read: the old hub; afterwards: a new live pid reporting the disk version
      readRecord: () => (polls++ === 0 ? { pid: ALIVE } : { pid: OTHER_ALIVE, version: "0.10.2" }),
      waitNewHubMs: 1_000,
    });
    const r = await restartRunningHub(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: "hub_ctl", op: "shutdown", reason: "restart" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(r).toEqual({
      kind: "restarted",
      oldPid: ALIVE,
      newHub: { state: "up", pid: OTHER_ALIVE, version: "0.10.2", matchesDisk: true },
    });
  });

  it("a new hub that reports a DIFFERENT version than the checkout is flagged (matchesDisk=false)", async () => {
    let polls = 0;
    const { deps } = makeDeps({
      readRecord: () => (polls++ === 0 ? { pid: ALIVE } : { pid: OTHER_ALIVE, version: "0.10.1" }),
      waitNewHubMs: 1_000,
    });
    const r = await restartRunningHub(deps);
    expect(r).toMatchObject({ kind: "restarted", newHub: { state: "up", matchesDisk: false, version: "0.10.1" } });
    const lines: Logged = [];
    expect(reportResult(r, (l, m) => lines.push([l, m]))).toBe(0);
    expect(lines[0]![0]).toBe("WARN");
  });

  it("nobody respawns within the wait ⇒ not-yet (a success, not a failure)", async () => {
    let t = 0;
    const { deps } = makeDeps({
      readRecord: () => ({ pid: ALIVE }), // hub.json still names the dead old pid
      waitNewHubMs: 50,
      sleep: async (ms) => {
        t += ms;
        await new Promise((r) => setTimeout(r, 20));
      },
    });
    const r = await restartRunningHub(deps);
    expect(r).toEqual({ kind: "restarted", oldPid: ALIVE, newHub: { state: "not-yet" } });
    expect(t).toBeGreaterThan(0); // it really polled (bounded by waitNewHubMs, not forever)
    const lines: Logged = [];
    expect(reportResult(r, (l, m) => lines.push([l, m]))).toBe(0);
    expect(lines[0]![0]).toBe("INFO");
  });

  it("the old hub never exits after the ack ⇒ failed (no blind kill on the ctl path)", async () => {
    const base = makeDeps();
    const { deps, killed } = {
      ...base,
      deps: {
        ...base.deps,
        restartDeps: {
          ...base.deps.restartDeps,
          pidAlive: () => true,
          now: (() => {
            let t = 0;
            return () => (t += 3_000); // jump past the 5 s exit deadline immediately
          })(),
        },
      },
    };
    const r = await restartRunningHub(deps);
    expect(r.kind).toBe("failed");
    expect(killed).toEqual([]);
  });
});

describe("restartRunningHub — no channel ⇒ identity-verified fallback only", () => {
  it.each(["no-socket", "rejected", "timeout"] as const)(
    "connect %s ⇒ SIGTERM only after identity + starttime recheck",
    async (reason) => {
      const base = makeDeps();
      const { deps, killed } = {
        ...base,
        deps: {
          ...base.deps,
          connect: async () => ({ ok: false as const, reason }),
          restartDeps: {
            ...base.deps.restartDeps,
            readHubRecord: () => ({
              pid: ALIVE,
              procStartTicks: 42,
              argv: ["node", "/x/jiti-cli.mjs", "/p/src/web-hub/hub/main.ts"],
            }),
            verifyIdentity: async () => ({ ok: true as const }),
            readStartTicksNow: async () => 42,
            pidAlive: () => false,
          },
        },
      };
      const r = await restartRunningHub(deps);
      expect(killed).toEqual([ALIVE]);
      expect(r.kind).toBe("restarted"); // `signalled` is reported as a restart once the pid is gone
    },
  );

  it("identity cannot be proven ⇒ failed with the manual instruction, and NO signal", async () => {
    const base = makeDeps();
    const { deps, killed } = {
      ...base,
      deps: {
        ...base.deps,
        connect: async () => ({ ok: false as const, reason: "no-socket" as const }),
        restartDeps: {
          ...base.deps.restartDeps,
          readHubRecord: () => ({ pid: ALIVE }), // a P1 record without procStartTicks/argv
        },
      },
    };
    const r = await restartRunningHub(deps);
    expect(killed).toEqual([]);
    expect(r.kind).toBe("failed");
    expect((r as { message: string }).message).toContain("kill");
  });
});

describe("reportResult / parseWaitMs", () => {
  const lines: Logged = [];
  const log: RestartHubDeps["log"] = (l, m) => lines.push([l, m]);
  afterEach(() => {
    lines.length = 0;
  });

  it("skipped ⇒ exit 0 and silent (the skip already logged)", () => {
    expect(reportResult({ kind: "skipped", reason: "no-hub" }, log)).toBe(0);
    expect(lines).toEqual([]);
  });

  it("failed ⇒ exit 1 + WARN carrying the reason", () => {
    expect(reportResult({ kind: "failed", message: "boom" }, log)).toBe(1);
    expect(lines).toEqual([["WARN", "could not restart the hub: boom"]]);
  });

  it("up + matches ⇒ OK naming the pid and version", () => {
    const r: RestartHubResult = {
      kind: "restarted",
      oldPid: 1,
      newHub: { state: "up", pid: 9, version: "0.10.2", matchesDisk: true },
    };
    expect(reportResult(r, log)).toBe(0);
    expect(lines[0]![0]).toBe("OK");
    expect(lines[0]![1]).toContain("v0.10.2");
  });

  it("parseWaitMs: flag > env > default; garbage ⇒ default; capped", () => {
    expect(parseWaitMs(["--wait-ms", "1500"], {})).toBe(1500);
    expect(parseWaitMs([], { PI_TOOLKIT_HUB_RESTART_WAIT_MS: "700" })).toBe(700);
    expect(parseWaitMs(["--wait-ms", "700"], { PI_TOOLKIT_HUB_RESTART_WAIT_MS: "9" })).toBe(700);
    expect(parseWaitMs(["--wait-ms", "abc"], {})).toBe(DEFAULT_WAIT_NEW_HUB_MS);
    expect(parseWaitMs(["--wait-ms"], {})).toBe(DEFAULT_WAIT_NEW_HUB_MS);
    expect(parseWaitMs(["--wait-ms", "1000000"], {})).toBe(DEFAULT_WAIT_NEW_HUB_MS); // >6 digits rejected
    expect(parseWaitMs(["--wait-ms", "500000"], {})).toBe(120_000);
  });
});

// ---------------------------------------------------------------------------
// connectControl against a real unix socket
// ---------------------------------------------------------------------------

describe("connectControl (wire client)", () => {
  const dirs: string[] = [];
  const servers: net.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function fakeHub(
    onHello: (sock: net.Socket, hello: Record<string, unknown>) => void,
    onFrame?: (sock: net.Socket, f: Record<string, unknown>) => void,
  ): Promise<ReturnType<typeof resolveHubPaths>> {
    const home = mkdtempSync(join(tmpdir(), "pwh-rh-"));
    dirs.push(home);
    const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(paths.socketDir, { recursive: true });
    const server = net.createServer((sock) => {
      const dec = new NdjsonDecoder({
        onFrame: (raw) => {
          const f = raw as Record<string, unknown>;
          if (f["t"] === "hello") onHello(sock, f);
          else onFrame?.(sock, f);
        },
        onError: () => {},
      });
      sock.on("data", (c) => dec.push(c));
      sock.on("error", () => {});
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(paths.socketPath, () => r()));
    return paths;
  }

  it("hello → hello_ack(caps) → request resolves with the matching hub_ctl_ack", async () => {
    let seenHello: Record<string, unknown> | undefined;
    const paths = await fakeHub(
      (sock, hello) => {
        seenHello = hello;
        sock.write(
          encodeFrame({
            t: "hello_ack",
            hubVersion: "1.0.0",
            buildId: "b",
            proto: { major: 1, minor: 2 },
            agentKey: "k",
            pingMs: 1,
            leaseMs: 1,
            http: { port: 1 },
            caps: ["ctl.v1"],
          }),
        );
      },
      (sock, f) => {
        if (f["t"] === "hub_ctl") sock.write(encodeFrame({ t: "hub_ctl_ack", rid: f["rid"] }));
      },
    );
    const link = await connectControl(paths, 2_000);
    expect(link.ok).toBe(true);
    if (!link.ok) return;
    expect(link.caps).toEqual(["ctl.v1"]);
    const ack = await link.request({ t: "hub_ctl", rid: "r-1", op: "shutdown", reason: "restart" }, "ctl.v1");
    expect(ack).toEqual({ t: "hub_ctl_ack", rid: "r-1" });
    link.close();
    // The hello never claims a version that could look newer than the hub (no supersede trigger).
    expect(seenHello).toMatchObject({ t: "hello", pluginVersion: "0.0.0", kind: "rpc" });
    expect(String((seenHello!["agentId"] as { nonce: string }).nonce)).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it("hello_reject ⇒ { ok:false, reason:'rejected' }", async () => {
    const paths = await fakeHub((sock) => {
      sock.write(encodeFrame({ t: "hello_reject", code: "E_PROTO", message: "no", retryAfterMs: 1 }));
    });
    expect(await connectControl(paths, 2_000)).toEqual({ ok: false, reason: "rejected" });
  });

  it("no hello_ack within the deadline ⇒ timeout (bounded, never hangs)", async () => {
    const paths = await fakeHub(() => {});
    const t0 = Date.now();
    expect(await connectControl(paths, 150)).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("nothing listening ⇒ no-socket", async () => {
    const home = mkdtempSync(join(tmpdir(), "pwh-rh-none-"));
    dirs.push(home);
    const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
    expect(await connectControl(paths, 2_000)).toEqual({ ok: false, reason: "no-socket" });
  });
});
