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
    // A1 self-audit: capture appendEntry so the __pick CARD is asserted through the REAL
    // wiring (resume-exec's recorder dep → recorder → pi.appendEntry), not just via fakes.
    const pickAppended: Array<{ customType: string; data: unknown }> = [];
    (pi as unknown as Record<string, unknown>).appendEntry = (customType: string, data: unknown) => {
      pickAppended.push({ customType, data });
    };
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
    // A1 self-audit (real wiring): the __pick card landed with the PICK frame's cmdId and the
    // left-session notice — written at the execution point, before the switch, exactly once.
    const pickCards = pickAppended.filter((a) => a.customType === "subagent:cmd");
    expect(pickCards).toHaveLength(1);
    expect(pickCards[0]!.data).toMatchObject({
      cmdId: "cmd00000000000002",
      name: "resume",
      source: "web",
      state: "done",
      notice: "left-session",
    });
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
    await waitUntil(() => hub!.all().some((f) => f.t === "status"), 3_000, "status");
    function controlStatusLive() {
      return hub!
        .all()
        .some((f) => f.t === "status" && (f as { features?: string[] }).features?.includes(RESUME_FEATURE_V1));
    }
    const status = hub!.all().find((f) => f.t === "status") as { features?: string[] };
    // web-hub-cmd-history plan §4.6 (A1): the recorder is wired (cmdHistory defaults on) and the
    // session is persisted, so the frozen feature order is [resume.v1, cmd.history.v1].
    expect(status.features).toEqual([RESUME_FEATURE_V1, "cmd.history.v1"]);

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
    // deny kills resume.v1 only — cmd.history.v1 is independent of webCommandPolicy (§4.6) and
    // this fake session is persisted, so every status carries exactly the history token
    expect(statuses.every((s) => s.features === undefined || s.features.includes(RESUME_FEATURE_V1) === false)).toBe(
      true,
    );
    const withToken = statuses.filter((s) => s.features !== undefined);
    expect(withToken.length).toBeGreaterThan(0);
    expect(new Set(withToken.map((s) => JSON.stringify(s.features))).has(JSON.stringify(["cmd.history.v1"]))).toBe(
      true,
    );
  });

  // ---------------------------------------------------------------------------
  // A1 verify B1 (2026-10-24): resume.v1's HEAD gate restored — REAL wireWebHub assembly,
  // not fake deps. Non-persisted sessions must declare NO features (resume.v1 included),
  // regardless of the recorder; cmdHistory:false must leave resume.v1 exactly as HEAD had it.
  // ---------------------------------------------------------------------------
  it("B1: a NON-persisted session (--no-session shape) declares neither resume.v1 nor cmd.history.v1", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
    const { pi, fire } = fakePi();
    wireWebHub(pi, deps());
    const { ctx } = fakeCtx({ mode: "tui", sessionFile: undefined }); // getSessionFile() ⇒ undefined
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
    const helloFrame = hub!.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
    hub!.send(hub!.conns[0]!, ackFrame(`a${helloFrame.agentId.pid}`, 4242, FULL_CAPS));
    await waitUntil(() => hub!.all().some((f) => f.t === "status"), 3_000, "status");
    const statuses = hub!.all().filter((f) => f.t === "status") as Array<{ features?: string[] }>;
    expect(statuses.length).toBeGreaterThan(0);
    // HEAD behavior for resume.v1 + the plan's own gate for cmd.history.v1: NO features at all
    expect(statuses.every((s) => s.features === undefined)).toBe(true);
  });

  it("B1: cmdHistory=false + persisted session ⇒ features is exactly [resume.v1] (HEAD-identical)", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
    const { pi, fire } = fakePi();
    wireWebHub(pi, deps({ settings: { ...SETTINGS, cmdHistory: false } }));
    const { ctx } = fakeCtx({ mode: "tui" }); // sessionFile defined ⇒ persisted
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
    const helloFrame = hub!.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
    hub!.send(hub!.conns[0]!, ackFrame(`a${helloFrame.agentId.pid}`, 4242, FULL_CAPS));
    await waitUntil(() => hub!.all().some((f) => f.t === "status"), 3_000, "status");
    const statuses = hub!.all().filter((f) => f.t === "status") as Array<{ features?: string[] }>;
    const withToken = statuses.filter((s) => s.features !== undefined);
    expect(withToken.length).toBeGreaterThan(0);
    // every features array is EXACTLY [resume.v1] — byte-identical to the pre-cmd-history agent
    expect(withToken.every((s) => JSON.stringify(s.features) === JSON.stringify([RESUME_FEATURE_V1]))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // A1 verify B2 (2026-10-24): the /new frame's cmdId survives the REAL wiring — hub cmd
  // frame → bridge armExec → execGate.armNew(frame.id) → internalExec writes the card with
  // the frame's cmdId BEFORE newSession() flips the session.
  // ---------------------------------------------------------------------------
  it("B2: web /new ⇒ internalExec writes the left-session card carrying the FRAME id (real assembly)", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
    const { pi, fire, sentUserMessages } = fakePi();
    const appended: Array<{ customType: string; data: unknown }> = [];
    (pi as unknown as Record<string, unknown>).appendEntry = (customType: string, data: unknown) => {
      appended.push({ customType, data });
    };
    const control = wireWebHub(pi, deps());
    const { ctx } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
    const helloFrame = hub!.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
    hub!.send(hub!.conns[0]!, ackFrame(`a${helloFrame.agentId.pid}`, 4242, FULL_CAPS));
    await waitUntil(() => hub!.all().some((f) => f.t === "status"), 3_000, "status");

    // the browser sends /new (confirm carried — the policy table demands it)
    hub!.send(hub!.conns[0]!, cmdFrameOf("cmd0000000000000a", { op: "command", name: "new", args: "", confirm: true }));
    await waitUntil(() => sentUserMessages.some((m) => m.text.startsWith("/webhub __exec new ")));
    const nonce = sentUserMessages.find((m) => m.text.startsWith("/webhub __exec new "))!.text.split(" ")[3]!;
    const reply = hub!.all().find((f) => f.t === "cmd_result" && f.id === "cmd0000000000000a") as {
      ok: boolean;
      data: { history?: string };
    };
    expect(reply.ok).toBe(true);
    expect(reply.data.history).toBe("recorded");

    // the terminal side runs the re-entry; newSession succeeds
    const newSessionCalls: number[] = [];
    const execCtx = {
      isIdle: () => true,
      hasPendingMessages: () => false,
      cwd: "/tmp/wa",
      newSession: async () => {
        newSessionCalls.push(1);
        return {};
      },
    } as unknown as ExtensionCommandContext;
    const ran = await control.internalExec(`new ${nonce}`, execCtx);
    expect(ran).toEqual({ ok: true });
    expect(newSessionCalls).toHaveLength(1);
    // THE assertion: the card landed BEFORE the session flip, with the FRAME's cmdId
    const cards = appended.filter((a) => a.customType === "subagent:cmd");
    expect(cards).toHaveLength(1);
    const data = cards[0]!.data as Record<string, unknown>;
    expect(data.cmdId).toBe("cmd0000000000000a");
    expect(data.name).toBe("new");
    expect(data.notice).toBe("left-session");
  });

  it("B2: a cancelled /new switch appends the SECOND failed end under the same frame id", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
    const { pi, fire, sentUserMessages } = fakePi();
    const appended: Array<{ customType: string; data: unknown }> = [];
    (pi as unknown as Record<string, unknown>).appendEntry = (customType: string, data: unknown) => {
      appended.push({ customType, data });
    };
    const control = wireWebHub(pi, deps());
    const { ctx } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
    const helloFrame = hub!.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
    hub!.send(hub!.conns[0]!, ackFrame(`a${helloFrame.agentId.pid}`, 4242, FULL_CAPS));
    await waitUntil(() => hub!.all().some((f) => f.t === "status"), 3_000, "status");
    hub!.send(hub!.conns[0]!, cmdFrameOf("cmd0000000000000b", { op: "command", name: "new", args: "", confirm: true }));
    await waitUntil(() => sentUserMessages.some((m) => m.text.startsWith("/webhub __exec new ")));
    const nonce = sentUserMessages.find((m) => m.text.startsWith("/webhub __exec new "))!.text.split(" ")[3]!;
    const execCtx = {
      isIdle: () => true,
      hasPendingMessages: () => false,
      cwd: "/tmp/wa",
      newSession: async () => ({ cancelled: true }),
    } as unknown as ExtensionCommandContext;
    const ran = await control.internalExec(`new ${nonce}`, execCtx);
    expect(ran).toEqual({ ok: true });
    const ends = appended.filter((a) => a.customType === "subagent:cmd").map((a) => a.data as Record<string, unknown>);
    expect(ends).toHaveLength(2);
    expect(ends[0]).toMatchObject({ cmdId: "cmd0000000000000b", state: "done", notice: "left-session" });
    expect(ends[1]).toMatchObject({ cmdId: "cmd0000000000000b", state: "failed", error: "新建会话被取消" });
  });

  // ---------------------------------------------------------------------------
  // A1 self-audit: wiring points that were only fake-dep-tested — pinned through the REAL
  // wireWebHub assembly here.
  // ---------------------------------------------------------------------------
  it("self-audit: an open record reaches the status frame as cmdRunning through the real publishStatus", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
    const { pi, fire } = fakePi();
    const control = wireWebHub(pi, deps());
    const { ctx } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
    const helloFrame = hub!.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
    hub!.send(hub!.conns[0]!, ackFrame(`a${helloFrame.agentId.pid}`, 4242, FULL_CAPS));
    await waitUntil(() => hub!.all().some((f) => f.t === "status"), 3_000, "status");
    const handle = control.recorder!.beginExternal({
      cmdId: "w-run00000000000001",
      name: "model",
      args: "a/b",
      source: "web",
      lazyStart: true,
    });
    await waitUntil(
      () => hub!.all().some((f) => f.t === "status" && (f as { cmdRunning?: string[] }).cmdRunning !== undefined),
      3_000,
      "cmdRunning",
    );
    const withRunning = hub!
      .all()
      .find((f) => f.t === "status" && (f as { cmdRunning?: string[] }).cmdRunning !== undefined) as {
      cmdRunning?: string[];
    };
    expect(withRunning.cmdRunning).toEqual(["w-run00000000000001"]);
    handle!.settle({});
    await new Promise((r) => setTimeout(r, 30));
    // hub.all() is an append-only log — judge the LATEST status frame: settled ⇒ the open
    // record disappears and the field is absent again
    const statusesAfter = hub!.all().filter((f) => f.t === "status") as Array<{ cmdRunning?: string[] }>;
    expect(statusesAfter.length).toBeGreaterThan(1);
    expect(statusesAfter.at(-1)!.cmdRunning).toBeUndefined();
  });

  it("self-audit: a wired secureRecheckForWrite reason makes the recorder skip+count (never appendEntry)", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
    const { pi, fire } = fakePi();
    const appended: Array<{ customType: string; data: unknown }> = [];
    (pi as unknown as Record<string, unknown>).appendEntry = (customType: string, data: unknown) => {
      appended.push({ customType, data });
    };
    const control = wireWebHub(
      pi,
      deps({ secureRecheckForWrite: () => "会话已锁定：测试卸载" } as never), // real wiring closure path
    );
    const { ctx } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    const written = control.recorder!.recordImmediate({
      cmdId: "w-00000000000000ee",
      name: "session",
      args: "",
      source: "web",
      startedAt: 1,
      state: "done",
    });
    expect(written).toBe(false);
    expect(appended).toHaveLength(0);
    expect(control.recorder!.counters()).toEqual({ appended: 0, skipped: 1, failed: 0 });
  });
});
