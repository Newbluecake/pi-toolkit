/**
 * web-hub-slash-args plan §5 (P4): the `/webhub status` cmd-args line — pure renderer matrix
 * (mode × live-cap states) plus a wiring-level check that `wireWebHub`'s control object reads
 * the LIVE link's caps (n/a while disconnected, on/off per hello_ack) using the same fakeNet
 * harness as wiring-cmd-args.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cmdArgsStatusLevel,
  formatCmdArgsStatusLines,
  type CmdArgsMode,
} from "../../../src/web-hub/agent/cmd-args-status.js";
import { CMD_ARGS_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import { wireWebHub, type WebHubDeps } from "../../../src/web-hub/agent/index.js";
import { ackFrame, fakeCtx, fakeNet, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir("wh-d-cmdargs-status-");
  resetGlobals();
});
afterEach(() => {
  resetGlobals();
  tmp.cleanup();
});

function lines(mode: CmdArgsMode, hubCaps: readonly string[] | undefined): string[] {
  return formatCmdArgsStatusLines({ mode, hubCaps });
}

describe("formatCmdArgsStatusLines (pure)", () => {
  it("mode off: single neutral line, cap never consulted", () => {
    expect(lines("off", undefined)).toEqual(["cmd-args: off"]);
    expect(lines("off", [CMD_ARGS_HUB_CAP])).toEqual(["cmd-args: off"]);
    expect(lines("off", [])).toEqual(["cmd-args: off"]);
  });

  it("no live link (hubCaps undefined): n/a marker", () => {
    for (const mode of ["all", "toolkit"] as const) {
      expect(lines(mode, undefined)).toEqual([`cmd-args: ${mode} · hub-cap n/a`]);
    }
  });

  it("live link with the cap: on", () => {
    expect(lines("all", ["cmd.v1", CMD_ARGS_HUB_CAP])).toEqual(["cmd-args: all · hub-cap on"]);
    expect(lines("toolkit", [CMD_ARGS_HUB_CAP])).toEqual(["cmd-args: toolkit · hub-cap on"]);
  });

  it("live link without the cap: off + actionable suffix (old hub vs pending restart)", () => {
    expect(lines("all", ["cmd.v1", "command.v1"])).toEqual([
      "cmd-args: all · hub-cap off (old hub, or /webhub restart pending)",
    ]);
    // an empty caps array is a live hub that advertised nothing — cap off, not n/a
    expect(lines("toolkit", [])).toEqual(["cmd-args: toolkit · hub-cap off (old hub, or /webhub restart pending)"]);
  });

  it("English compact tokens only: no CJK codepoints anywhere (AGENTS.md UI-text rule)", () => {
    for (const mode of ["all", "toolkit", "off"] as const) {
      for (const caps of [undefined, [], [CMD_ARGS_HUB_CAP]] as const) {
        for (const line of lines(mode, caps)) {
          expect(/[\u4e00-\u9fff]/.test(line)).toBe(false);
          expect(line.startsWith("cmd-args: ")).toBe(true);
        }
      }
    }
  });

  it("levelOf: warning only for a live link missing the cap", () => {
    expect(cmdArgsStatusLevel("cmd-args: all · hub-cap off (old hub, or /webhub restart pending)")).toBe("warning");
    expect(cmdArgsStatusLevel("cmd-args: all · hub-cap on")).toBe("info");
    expect(cmdArgsStatusLevel("cmd-args: all · hub-cap n/a")).toBe("info");
    expect(cmdArgsStatusLevel("cmd-args: off")).toBe("info");
    expect(cmdArgsStatusLevel(undefined)).toBe("info");
  });
});

describe("wireWebHub control.cmdArgs (wiring)", () => {
  const flush = () => new Promise<void>((r) => setImmediate(r));

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

  it("reads the LIVE link's caps: n/a before connect, on/off per hello_ack, off after teardown", async () => {
    const { pi, fire } = fakePi();
    (pi as unknown as { getCommands: () => unknown[] }).getCommands = () => [];
    const { ctx } = fakeCtx({ mode: "rpc" });
    const d = deps();
    const n = fakeNet();
    d.netConnect = n.netConnect;
    const control = wireWebHub(pi, d);
    // before any connection: n/a (the settings default is "all")
    expect(control.cmdArgs?.statusLines()).toEqual(["cmd-args: all · hub-cap n/a"]);

    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await flush();
    const s = n.sockets[0]!;
    s.emit("connect");
    s.hub(ackFrame("k1", 4242, ["command.v1", CMD_ARGS_HUB_CAP]));
    await flush();
    expect(control.cmdArgs?.statusLines()).toEqual(["cmd-args: all · hub-cap on"]);
  });

  it("a live link WITHOUT the cap renders cap off + the actionable suffix", async () => {
    // separate `it`: the process-global CONN_KEY connection is a singleton, so a second
    // wireWebHub in the same test would reuse the first link and never open n2's socket.
    const { pi, fire } = fakePi();
    (pi as unknown as { getCommands: () => unknown[] }).getCommands = () => [];
    const { ctx } = fakeCtx({ mode: "rpc" });
    const n = fakeNet();
    const d = deps({ netConnect: n.netConnect });
    const control = wireWebHub(pi, d);
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await flush();
    const s = n.sockets[0]!;
    s.emit("connect");
    s.hub(ackFrame("k2", 4243, ["command.v1"]));
    await flush();
    expect(control.cmdArgs?.statusLines()).toEqual([
      "cmd-args: all · hub-cap off (old hub, or /webhub restart pending)",
    ]);
  });

  it("settings off renders the off line even with a cap-carrying live link", async () => {
    const { pi, fire } = fakePi();
    (pi as unknown as { getCommands: () => unknown[] }).getCommands = () => [];
    const { ctx } = fakeCtx({ mode: "rpc" });
    const n = fakeNet();
    const d = deps({
      settings: { ...SETTINGS, commandComplete: "off" },
      netConnect: n.netConnect,
    });
    const control = wireWebHub(pi, d);
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await flush();
    const s = n.sockets[0]!;
    s.emit("connect");
    s.hub(ackFrame("k3", 4244, ["command.v1", CMD_ARGS_HUB_CAP]));
    await flush();
    expect(control.cmdArgs?.statusLines()).toEqual(["cmd-args: off"]);
    expect(control.cmdArgs?.levelOf("cmd-args: off")).toBe("info");
  });
});
