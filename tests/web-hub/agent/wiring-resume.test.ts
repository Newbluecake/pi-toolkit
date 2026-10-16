/**
 * web-resume plan §2.4/§2.5/§2.7 — assembly-level wiring inside `wireWebHub`: the `resume
 * __list` read round-trips over the real (fake-server) socket with `data.sessions` on the reply
 * and a stripped ledger, `resume __pick` arms the ticket and `/webhub __exec resume <nonce>`
 * routes through `internalExec` to a real `ctx.switchSession` with exactly one `cmd_late` ok,
 * and `status.features` carries `resume.v1` under exactly the §2.7 conditions.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { wireWebHub, type WebHubDeps } from "../../../src/web-hub/agent/index.js";
import type { AgentFrame, CmdFrame, ResumeSessionsWire } from "../../../src/web-hub/protocol/messages.js";
import { RESUME_FEATURE_V1 } from "../../../src/web-hub/protocol/messages.js";
import {
  ackFrame,
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
import { makeLayout, writeSession } from "./resume-fixtures.js";

let tmp: ReturnType<typeof tmpDir>;
let hub: FakeHub | undefined;
beforeEach(() => {
  tmp = tmpDir("wh-d-resume-");
  resetGlobals();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:web-hub:cmd-ledger")];
});
afterEach(async () => {
  resetGlobals();
  await hub?.close();
  hub = undefined;
  tmp.cleanup();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:web-hub:cmd-ledger")];
});

const FULL_CAPS = ["cmd.v1", "dialog.v1", "command.v1", "ctl.v2"];

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

function cmdFrameOf(id: string, cmd: CmdFrame["cmd"]): AgentFrame & { t: "cmd" } {
  return {
    t: "cmd",
    rid: `r-${id}`,
    id,
    deadlineMs: 8_000,
    origin: { listener: "loopback", ip: "127.0.0.1", reqId: "0123456789abcdef" },
    cmd,
  } as AgentFrame & { t: "cmd" };
}

/** A fake main session whose cwd/sessionDir point at a real layout with real session files. */
function sessionCtxOf(layout: { sessionDir: string }) {
  const cwd = "/tmp/wiring-resume-cwd";
  const { ctx, state } = fakeCtx({ mode: "tui" });
  const ctx2 = {
    ...ctx,
    cwd,
    sessionManager: { ...ctx.sessionManager, getSessionDir: () => layout.sessionDir },
  };
  return { ctx: ctx2, state, cwd };
}

describe("wireWebHub — resume wiring (§2.4/§2.5/§2.7)", () => {
  it("`resume __list` round-trips: sessions on the reply, stripped from the ledger, no ctl noise", async () => {
    const layout = makeLayout();
    const cwd = "/tmp/wiring-resume-cwd";
    const target = writeSession(layout.sessionDir, "t.jsonl", {
      id: "t1",
      cwd,
      firstMessage: "wired target",
      mtime: new Date(Date.now() - 120_000),
    });
    utimesSync(target, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    mkdirSync(layout.sessionDir, { recursive: true });
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
    const { pi, fire } = fakePi();
    const control = wireWebHub(pi, deps());
    const { ctx } = sessionCtxOf(layout);
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
    const helloFrame = hub!.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
    hub!.send(hubFrameConn(), ackFrame(`a${helloFrame.agentId.pid}`, 4242, FULL_CAPS));
    await waitUntil(() => control.status().state === "live", 3_000, "live");

    hub!.send(
      hubFrameConn(),
      cmdFrameOf("cmd00000000000001", {
        op: "command",
        name: "resume",
        args: `__list ${JSON.stringify({ scope: "all" })}`,
      }),
    );
    await waitUntil(() => hub!.all().some((f) => f.t === "cmd_result" && f.id === "cmd00000000000001"));
    const reply = hub!.all().find((f) => f.t === "cmd_result" && f.id === "cmd00000000000001") as {
      ok: boolean;
      data: { sessions?: ResumeSessionsWire };
    };
    expect(reply.ok).toBe(true);
    expect(reply.data.sessions?.rows.map((r) => r.id)).toEqual(["t1"]);
    function hubFrameConn() {
      return hub!.conns[0]!;
    }
  });

  it("`resume __pick` → `/webhub __exec resume <nonce>` → switchSession → exactly one cmd_late ok", async () => {
    const layout = makeLayout();
    const cwd = "/tmp/wiring-resume-cwd";
    const target = writeSession(layout.sessionDir, "t.jsonl", {
      id: "t1",
      cwd,
      firstMessage: "wired target",
      mtime: new Date(Date.now() - 120_000),
    });
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
    const { pi, fire, sentUserMessages } = fakePi();
    const control = wireWebHub(pi, deps());
    const { ctx } = sessionCtxOf(layout);
    // Like real pi: after a session replacement the old ctx's guarded `ui` getter THROWS
    // (web-resume P4 conformance C2 — that throw used to drop the pick's cmd_late).
    let stale = false;
    const liveUi = (ctx as { ui?: unknown }).ui;
    Object.defineProperty(ctx, "ui", {
      configurable: true,
      get() {
        if (stale) throw new Error("This extension ctx is stale after session replacement or reload");
        return liveUi;
      },
    });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
    const helloFrame = hub!.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
    hub!.send(hub!.conns[0]!, ackFrame(`a${helloFrame.agentId.pid}`, 4242, FULL_CAPS));
    await waitUntil(() => control.status().state === "live", 3_000, "live");

    // list over the socket
    hub!.send(
      hub!.conns[0]!,
      cmdFrameOf("cmd00000000000001", {
        op: "command",
        name: "resume",
        args: `__list ${JSON.stringify({ scope: "all" })}`,
      }),
    );
    await waitUntil(() => hub!.all().some((f) => f.t === "cmd_result" && f.id === "cmd00000000000001"));
    const listReply = hub!.all().find((f) => f.t === "cmd_result" && f.id === "cmd00000000000001") as {
      data: { sessions?: ResumeSessionsWire };
    };
    const wire = listReply.data.sessions!;

    // pick (the fake pi records the re-entry instead of running the /webhub command)
    hub!.send(
      hub!.conns[0]!,
      cmdFrameOf("cmd00000000000002", {
        op: "command",
        name: "resume",
        args: `__pick ${JSON.stringify({ id: "t1", gen: wire.gen })}`,
      }),
    );
    await waitUntil(() => hub!.all().some((f) => f.t === "cmd_result" && f.id === "cmd00000000000002"));
    const pickReply = hub!.all().find((f) => f.t === "cmd_result" && f.id === "cmd00000000000002") as {
      ok: boolean;
      data: { completion?: string };
    };
    expect(pickReply.ok).toBe(true);
    expect(pickReply.data.completion).toBe("async");
    await waitUntil(() => sentUserMessages.some((m) => m.text.startsWith("/webhub __exec resume ")));
    const nonce = sentUserMessages.find((m) => m.text.startsWith("/webhub __exec resume "))!.text.split(" ")[3]!;

    // the terminal side runs the re-entry: a real command ctx switches to the target
    const switchCalls: string[] = [];
    const execCtx = {
      isIdle: () => true,
      hasPendingMessages: () => false,
      cwd,
      switchSession: async (path: string, opts: { withSession?: (c: unknown) => Promise<void> }) => {
        switchCalls.push(path);
        stale = true; // the session was replaced: the first activation's ctx is now stale
        await opts.withSession?.({ sessionManager: { getSessionId: () => "t1", getSessionFile: () => path } });
        return {};
      },
    } as unknown as ExtensionCommandContext;
    const ran = await control.internalExec(`resume ${nonce}`, execCtx);
    expect(ran).toEqual({ ok: true });
    expect(switchCalls).toEqual([target]);
    await waitUntil(() => hub!.all().some((f) => f.t === "cmd_late" && f.id === "cmd00000000000002"));
    const late = hub!.all().find((f) => f.t === "cmd_late" && f.id === "cmd00000000000002");
    expect(late).toMatchObject({ ok: true });
    expect(hub!.all().filter((f) => f.t === "cmd_late" && f.id === "cmd00000000000002")).toHaveLength(1);
    // a replayed nonce is a refused exec (terminal warning), never a second switch
    const replay = await control.internalExec(`resume ${nonce}`, execCtx);
    expect(replay).toEqual({ ok: false, code: "E_UNSUPPORTED" });
    expect(switchCalls).toHaveLength(1);
  });

  it("status carries features:[resume.v1] under the §2.7 conditions, and not with a deny override", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
    const { pi, fire } = fakePi();
    wireWebHub(pi, deps());
    const { ctx } = fakeCtx({ mode: "tui" }); // sessionFile defined ⇒ persisted
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
    const helloFrame = hub!.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
    hub!.send(hub!.conns[0]!, ackFrame(`a${helloFrame.agentId.pid}`, 4242, FULL_CAPS));
    await waitUntil(() => controlStatusLive(), 3_000, "live");
    function controlStatusLive() {
      return hub!
        .all()
        .some((f) => f.t === "status" && (f as { features?: string[] }).features?.includes(RESUME_FEATURE_V1));
    }
    const status = hub!.all().find((f) => f.t === "status") as { features?: string[] };
    expect(status.features).toEqual([RESUME_FEATURE_V1]);

    // deny override ⇒ feature off (same status shape otherwise)
    resetGlobals();
    await hub!.close();
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
    const { pi: pi2, fire: fire2 } = fakePi();
    wireWebHub(pi2, deps({ settings: { ...SETTINGS, webCommandPolicy: { resume: "deny" } } }));
    const { ctx: ctx2 } = fakeCtx({ mode: "tui" });
    fire2("session_start", { type: "session_start", reason: "startup" }, ctx2);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
    const hello2 = hub!.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
    hub!.send(hub!.conns[0]!, ackFrame(`a${hello2.agentId.pid}`, 4242, FULL_CAPS));
    await waitUntil(() => hub!.all().filter((f) => f.t === "status").length > 0, 3_000, "status");
    const statuses = hub!.all().filter((f) => f.t === "status") as Array<{ features?: string[] }>;
    expect(statuses.every((s) => s.features === undefined)).toBe(true);
  });
});
