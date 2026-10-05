/**
 * Assembly-level wiring for the P2 control plane (plan §4.1/§3.1): `cmd`/`cmd_result` round-trip
 * over the real (fake-server) unix socket, dialog-op routing exclusivity, caps broadcast, and the
 * `ctl`/`status.queue` slots actually reaching the wire. Per-op business logic itself is covered
 * by `commands.test.ts`/`ledger.test.ts`/`queue-mirror.test.ts` — this file only proves the pieces
 * are wired together correctly inside `wireWebHub`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createWebHubCommand } from "../../../src/commands/webhub.js";
import { currentConnection } from "../../../src/web-hub/agent/connection.js";
import { wireWebHub, type WebHubDeps } from "../../../src/web-hub/agent/index.js";
import type { AgentFrame, CmdFrame } from "../../../src/web-hub/protocol/messages.js";
import {
  ackFrame,
  fakeCtx,
  fakeNet,
  fakePi,
  pathsIn,
  resetGlobals,
  SETTINGS,
  startFakeHub,
  tmpDir,
  waitUntil,
  type FakeHub,
} from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
let hub: FakeHub | undefined;
beforeEach(() => {
  tmp = tmpDir("wh-d-control-");
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

const FULL_CAPS = ["cmd.v1", "dialog.v1", "command.v1", "ctl.v2"];

/** Connects and completes the handshake with a hub advertising the full P2 cap set. */
async function connectFullCaps(depsOver: Partial<WebHubDeps> = {}): Promise<{
  control: ReturnType<typeof wireWebHub>;
  fire: ReturnType<typeof fakePi>["fire"];
  sentUserMessages: ReturnType<typeof fakePi>["sentUserMessages"];
}> {
  hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
  const { pi, fire, sentUserMessages } = fakePi();
  const control = wireWebHub(pi, deps(depsOver));
  const { ctx } = fakeCtx({ mode: "tui" });
  fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
  const helloFrame = hub!.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
  hub!.send(hub!.conns[0]!, ackFrame(`a${helloFrame.agentId.pid}`, 4242, FULL_CAPS));
  await waitUntil(() => control.status().state === "live", 3_000, "live");
  return { control, fire, sentUserMessages };
}

function cmdFrame(id: string, cmd: CmdFrame["cmd"]): AgentFrame & { t: "cmd" } {
  return {
    t: "cmd",
    rid: `r-${id}`,
    id,
    deadlineMs: 8_000,
    origin: { listener: "loopback", ip: "127.0.0.1", reqId: "0123456789abcdef" },
    cmd,
  } as AgentFrame & {
    t: "cmd";
  };
}

describe("wireWebHub — caps broadcast (§3.1/D10)", () => {
  it("advertises cmd.v1/dialog.v1/command.v1 by default (control/remoteAskUser/webCommands all default-on)", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const { pi, fire } = fakePi();
    wireWebHub(pi, deps());
    const { ctx } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
    const hello = hub.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
    expect(hello.caps).toEqual(expect.arrayContaining(["ev.v1", "cmd.v1", "dialog.v1", "command.v1"]));
  });

  it("control:false drops all three P2 caps", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const { pi, fire } = fakePi();
    wireWebHub(pi, deps({ settings: { ...SETTINGS, control: false } }));
    const { ctx } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
    const hello = hub.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
    expect(hello.caps).not.toContain("cmd.v1");
    expect(hello.caps).not.toContain("dialog.v1");
    expect(hello.caps).not.toContain("command.v1");
  });

  it("webCommands:false drops only command.v1", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const { pi, fire } = fakePi();
    wireWebHub(pi, deps({ settings: { ...SETTINGS, webCommands: false } }));
    const { ctx } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
    const hello = hub.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
    expect(hello.caps).toContain("cmd.v1");
    expect(hello.caps).not.toContain("command.v1");
  });

  describe("web-hub-upload plan §5.1: webHub.uploads → upload.v1/upload.lan.v1 caps", () => {
    async function helloFor(settings: Partial<WebHubDeps["settings"]>): Promise<string[]> {
      await hub?.close();
      hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
      const { pi, fire } = fakePi();
      wireWebHub(pi, deps({ settings: { ...SETTINGS, ...settings } }));
      const { ctx } = fakeCtx({ mode: "tui" });
      fire("session_start", { type: "session_start", reason: "startup" }, ctx);
      await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
      const hello = hub!.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
      return hello.caps;
    }

    it('uploads:"on" (also the default/unset) advertises both upload.v1 and upload.lan.v1', async () => {
      expect(await helloFor({ uploads: "on" })).toEqual(expect.arrayContaining(["upload.v1", "upload.lan.v1"]));
      expect(await helloFor({})).toEqual(expect.arrayContaining(["upload.v1", "upload.lan.v1"]));
    });

    it('uploads:"loopback" advertises only upload.v1', async () => {
      const caps = await helloFor({ uploads: "loopback" });
      expect(caps).toContain("upload.v1");
      expect(caps).not.toContain("upload.lan.v1");
    });

    it('uploads:"off" advertises neither', async () => {
      const caps = await helloFor({ uploads: "off" });
      expect(caps).not.toContain("upload.v1");
      expect(caps).not.toContain("upload.lan.v1");
    });

    it("control:false drops upload caps too, regardless of uploads setting", async () => {
      const caps = await helloFor({ uploads: "on", control: false });
      expect(caps).not.toContain("upload.v1");
      expect(caps).not.toContain("upload.lan.v1");
    });
  });
});

describe("wireWebHub — cmd round trip over the socket (§4.1/§4.2)", () => {
  it("abort ⇒ cmd_result{ok:true} arrives back over the same socket", async () => {
    const { control } = await connectFullCaps();
    hub!.send(hub!.conns[0]!, cmdFrame("cmd0000000000001", { op: "abort" }));
    await waitUntil(() => hub!.all().some((f) => f.t === "cmd_result"));
    const result = hub!.all().find((f) => f.t === "cmd_result");
    expect(result).toMatchObject({ id: "cmd0000000000001", ok: true, data: { op: "abort" } });
    void control;
  });

  it("prompt observed via the input event ⇒ cmd_result{delivery:'observed'} and a ctl frame follow", async () => {
    const { fire } = await connectFullCaps();
    const { ctx } = fakeCtx({ mode: "tui" });
    hub!.send(hub!.conns[0]!, cmdFrame("cmd0000000000001", { op: "prompt", text: "hello web", deliver: "steer" }));
    // the cmd frame travels over a real socket; give it one round trip before observing it.
    await new Promise((r) => setTimeout(r, 30));
    fire("input", { type: "input", text: "hello web", source: "extension", streamingBehavior: "steer" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "cmd_result" && f.id === "cmd0000000000001"));
    const result = hub!.all().find((f) => f.t === "cmd_result" && f.id === "cmd0000000000001");
    expect(result).toMatchObject({ ok: true, data: { op: "prompt", delivery: "observed", behavior: "steer" } });
    await waitUntil(() => hub!.all().some((f) => f.t === "ctl" && f.items.some((i) => i.cmdId === "cmd0000000000001")));
  });

  it("control:false ⇒ E_UNSUPPORTED even if a cmd frame somehow arrives (defense in depth)", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
    const { pi, fire } = fakePi();
    wireWebHub(pi, deps({ settings: { ...SETTINGS, control: false } }));
    const { ctx } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
    const helloFrame = hub!.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
    hub!.send(hub!.conns[0]!, ackFrame(`a${helloFrame.agentId.pid}`, 4242, FULL_CAPS));
    await waitUntil(() => (currentConnection()?.status().state ?? "off") === "live");
    hub!.send(hub!.conns[0]!, cmdFrame("cmd0000000000001", { op: "abort" }));
    await waitUntil(() => hub!.all().some((f) => f.t === "cmd_result"));
    expect(hub!.all().find((f) => f.t === "cmd_result")).toMatchObject({ ok: false, code: "E_UNSUPPORTED" });
  });

  it("dialog_answer is routed exclusively to the dialog bridge (never reaches commandHandler) and gets a real reply once the bridge is wired (todo #32 finding 2)", async () => {
    await connectFullCaps();
    hub!.send(
      hub!.conns[0]!,
      cmdFrame("cmd0000000000001", {
        op: "dialog_answer",
        dialogId: "ask:1",
        epoch: "e",
        answers: [{ selected: ["a"], other: null }],
      }),
    );
    // The dialog was never opened, so the bridge replies E_DIALOG_CLOSED — the point of this test
    // is that it replies *at all* (the wired bridge, not the unconfigured pre-fix stub that never
    // called `send`), and that the reply never touches the ledger-backed `commandHandler` path
    // (no separate E_UNSUPPORTED/E_STALE_CTX from that side).
    await waitUntil(() => hub!.all().some((f) => f.t === "cmd_result" && f.id === "cmd0000000000001"));
    expect(hub!.all().find((f) => f.t === "cmd_result" && f.id === "cmd0000000000001")).toMatchObject({
      ok: false,
      code: "E_DIALOG_CLOSED",
    });
  });

  it("askUserRemote() returns a live port that opens a dialog reaching the wire (todo #32 finding 2: was hardcoded to undefined)", async () => {
    const { control } = await connectFullCaps();
    const port = control.askUserRemote();
    expect(port).toBeDefined();
    const session = port!.open({
      toolCallId: "tool-1",
      questions: [{ question: "Q", header: "Q", options: [{ label: "A" }, { label: "B" }], allowOther: true }],
      allowCancel: true,
    });
    expect(session).toBeDefined();
    await waitUntil(() => hub!.all().some((f) => f.t === "dialogs" && f.open.length > 0));
    const opened = hub!.all().find((f) => f.t === "dialogs" && f.open.length > 0) as Extract<
      AgentFrame,
      { t: "dialogs" }
    >;
    const dialogId = opened.open[0]!.dialogId;
    let claimed: unknown;
    session!.setOnRemote((outcome) => {
      claimed = outcome;
      return true;
    });
    hub!.send(
      hub!.conns[0]!,
      cmdFrame("cmd0000000000002", {
        op: "dialog_answer",
        dialogId,
        epoch: opened.epoch,
        answers: [{ selected: ["A"], other: null }],
      }),
    );
    await waitUntil(() => hub!.all().some((f) => f.t === "cmd_result" && f.id === "cmd0000000000002"));
    expect(hub!.all().find((f) => f.t === "cmd_result" && f.id === "cmd0000000000002")).toMatchObject({ ok: true });
    expect(claimed).toMatchObject({ kind: "answer" });
  });

  it("/new's `/webhub __exec` nonce round-trips through internalExec and calls ctx.newSession() (acc32-B4)", async () => {
    const { control, sentUserMessages } = await connectFullCaps();
    hub!.send(hub!.conns[0]!, cmdFrame("cmd0000000000003", { op: "command", name: "new", args: "", confirm: true }));
    await waitUntil(() => sentUserMessages.length > 0);
    const match = sentUserMessages[0]!.text.match(/^\/webhub __exec new ([0-9a-f]{32})$/);
    expect(match).not.toBeNull();
    const nonce = match![1]!;

    let newSessionCalls = 0;
    const execCtx = { newSession: async () => (newSessionCalls += 1) && { cancelled: false } };
    const bad = await control.internalExec(`new ${nonce}x`, execCtx);
    expect(bad).toEqual({ ok: false, code: "E_UNSUPPORTED" });
    expect(newSessionCalls).toBe(0);

    const ok = await control.internalExec(`new ${nonce}`, execCtx);
    expect(ok).toEqual({ ok: true });
    expect(newSessionCalls).toBe(1);

    // one-shot: the same nonce cannot be replayed.
    const replay = await control.internalExec(`new ${nonce}`, execCtx);
    expect(replay).toEqual({ ok: false, code: "E_UNSUPPORTED" });
    expect(newSessionCalls).toBe(1);
  });
});

describe("/webhub __exec nonce TTL boundary (acc32-B4 revised per verifier r_29729WTC: plan §4.6's 5s-TTL pendingExec slot, index.ts's `armExec`/`takeExec`)", () => {
  /** Real end-to-end arming: dispatches `/new` over the socket exactly like a live web client
   * would (the same cmdFrame → builtin-bridge → armExec path acc32-B4's own e2e test above
   * exercises), so these boundary cases walk the real armExec→takeExec→newSession chain instead
   * of poking the closure-private nonce slot directly. */
  async function armNewNonce(nowFn: () => number): Promise<{
    control: ReturnType<typeof wireWebHub>;
    nonce: string;
    execCtx: { newSession: () => Promise<{ cancelled: boolean }> };
    newSessionCalls: () => number;
  }> {
    const { control, sentUserMessages } = await connectFullCaps({ now: nowFn });
    hub!.send(hub!.conns[0]!, cmdFrame("cmd0000000000004", { op: "command", name: "new", args: "", confirm: true }));
    await waitUntil(() => sentUserMessages.length > 0);
    const match = sentUserMessages[0]!.text.match(/^\/webhub __exec new ([0-9a-f]{32})$/);
    expect(match).not.toBeNull();
    const nonce = match![1]!;
    let calls = 0;
    const execCtx = { newSession: async () => ((calls += 1), { cancelled: false }) };
    return { control, nonce, execCtx, newSessionCalls: () => calls };
  }

  it("succeeds at exactly the 5s TTL boundary (now() === expiresAt, the inclusive edge)", async () => {
    let t = 10_000;
    const { control, nonce, execCtx, newSessionCalls } = await armNewNonce(() => t);
    t += 5_000; // arming time + the full TTL, still allowed (takeExec rejects only now() > expiresAt)
    const ok = await control.internalExec(`new ${nonce}`, execCtx);
    expect(ok).toEqual({ ok: true });
    expect(newSessionCalls()).toBe(1);
  });

  it("fails 1ms past the 5s TTL (now() > expiresAt)", async () => {
    let t = 10_000;
    const { control, nonce, execCtx, newSessionCalls } = await armNewNonce(() => t);
    t += 5_001;
    const bad = await control.internalExec(`new ${nonce}`, execCtx);
    expect(bad).toEqual({ ok: false, code: "E_UNSUPPORTED" });
    expect(newSessionCalls()).toBe(0);
  });

  it("fails when the already-consumed nonce is replayed, even well inside the original TTL window", async () => {
    let t = 10_000;
    const { control, nonce, execCtx, newSessionCalls } = await armNewNonce(() => t);
    const first = await control.internalExec(`new ${nonce}`, execCtx);
    expect(first).toEqual({ ok: true });
    t += 1; // 4999ms of the original 5s window still remain
    const replay = await control.internalExec(`new ${nonce}`, execCtx);
    expect(replay).toEqual({ ok: false, code: "E_UNSUPPORTED" });
    expect(newSessionCalls()).toBe(1);
  });
});

describe("the full `/webhub __exec` command-handler path drives the real armExec→takeExec→newSession chain (acc32-B4 revised per verifier r_29729WTC)", () => {
  function fakeCommandCtx(): {
    ctx: ExtensionCommandContext;
    notes: Array<[string, string | undefined]>;
    newSessionCalls: () => number;
  } {
    const notes: Array<[string, string | undefined]> = [];
    let calls = 0;
    const ctx = {
      ui: { notify: (message: string, level?: string) => notes.push([message, level]) },
      newSession: async () => {
        calls += 1;
        return { cancelled: false };
      },
    } as unknown as ExtensionCommandContext;
    return { ctx, notes, newSessionCalls: () => calls };
  }

  it("a real terminal-typed `/webhub __exec new <nonce>` succeeds silently and calls ctx.newSession(); a replay surfaces the command's own warning notify", async () => {
    const { control, sentUserMessages } = await connectFullCaps();
    hub!.send(hub!.conns[0]!, cmdFrame("cmd0000000000005", { op: "command", name: "new", args: "", confirm: true }));
    await waitUntil(() => sentUserMessages.length > 0);
    const match = sentUserMessages[0]!.text.match(/^\/webhub __exec new ([0-9a-f]{32})$/);
    expect(match).not.toBeNull();
    const nonce = match![1]!;

    // This is `createWebHubCommand`'s REAL handler (not a fake `WebHubControl`, unlike
    // tests/commands/webhub.test.ts) wired to the REAL `control` this session's builtin bridge
    // armed the nonce through — the same object pi's own command dispatcher would hand the
    // followUp `/webhub __exec new <nonce>` message to.
    const webhubCmd = createWebHubCommand({ control: () => control });
    const { ctx, notes, newSessionCalls } = fakeCommandCtx();
    await webhubCmd.handler(`__exec new ${nonce}`, ctx);
    expect(newSessionCalls()).toBe(1);
    expect(notes).toHaveLength(0); // success is silent (no warning notify)

    // Replaying the now-consumed nonce: internalExec rejects, and the command handler itself
    // (not internalExec) is what surfaces the terminal warning.
    await webhubCmd.handler(`__exec new ${nonce}`, ctx);
    expect(newSessionCalls()).toBe(1);
    expect(notes).toEqual([["无效或已过期的 /webhub __exec 调用。", "warning"]]);
  });
});

describe("wireWebHub — status.queue reaches the wire (§4.4/D6)", () => {
  it("a queued web steer prompt shows up in the status slot's queue field", async () => {
    const { fire } = await connectFullCaps();
    const { ctx } = fakeCtx({ mode: "tui" });
    hub!.send(hub!.conns[0]!, cmdFrame("cmd0000000000001", { op: "prompt", text: "queued text", deliver: "steer" }));
    await new Promise((r) => setTimeout(r, 30));
    fire("input", { type: "input", text: "queued text", source: "extension", streamingBehavior: "steer" }, ctx);
    await waitUntil(() =>
      hub!.all().some((f) => f.t === "status" && (f.queue ?? []).some((q) => q.cmdId === "cmd0000000000001")),
    );
  });
});

// ---------------------------------------------------------------------------
// fleet-drawer (F2): runtx caps matrix (§8.4 #2, 18 combos), compat posture
// (hello_ack.caps without runtx.v1 ⇒ run service silently inert — F0 reviewer's
// ruling assigned to F2), and the wire-level run_tx_req/run_watch plumbing.
// ---------------------------------------------------------------------------

import type { RunDiagnostics, RunSnapshot } from "../../../src/core/types.js";
import type { QueryControlPort } from "../../../src/web-hub/agent/index.js";
import type { RunTxReplyFrame } from "../../../src/web-hub/protocol/run-transcript.js";

function runDiag(overrides: Partial<RunDiagnostics> = {}): RunDiagnostics {
  return {
    createdAt: 0,
    phase: "model_turn",
    phaseEnteredAt: 0,
    pendingTools: 0,
    turns: 1,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
    ...overrides,
  };
}

function runSnap(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    generation: 1,
    status: "running",
    phase: "model_turn",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: runDiag(),
    updatedAt: 0,
    ...overrides,
  };
}

function fakeQuery(over: Partial<QueryControlPort> = {}): QueryControlPort & { observeCalls: string[] } {
  const observeCalls: string[] = [];
  return {
    observeCalls,
    get: () => undefined,
    steer: async () => ({ ok: true }),
    stop: async () => ({ ok: true, escalatedTo: "L2" }),
    observe: (runId) => {
      observeCalls.push(runId);
      return { kind: "unknown" };
    },
    ...over,
  };
}

describe("wireWebHub — runtx caps matrix (§8.4 #2: control × uploads × subagentTranscript = 18 combos)", () => {
  const P1 = ["ev.v1", "fleet.v1", "snapshot.v1", "branch.v1"];
  const cases: Array<{ control: boolean; uploads: "on" | "loopback" | "off"; runtx: "all" | "loopback" | "off" }> = [];
  for (const control of [true, false]) {
    for (const uploads of ["on", "loopback", "off"] as const) {
      for (const runtx of ["all", "loopback", "off"] as const) cases.push({ control, uploads, runtx });
    }
  }

  it.each(cases)("control=$control uploads=$uploads subagentTranscript=$runtx", async ({ control, uploads, runtx }) => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const { pi, fire } = fakePi();
    wireWebHub(pi, deps({ settings: { ...SETTINGS, control, uploads, subagentTranscript: runtx } }));
    const { ctx } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
    const hello = hub.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
    const expected = [...P1];
    // runtx is the READ plane: advertised regardless of `control`.
    if (runtx === "all") expected.push("runtx.v1", "runtx.lan.v1");
    else if (runtx === "loopback") expected.push("runtx.v1");
    if (control) {
      expected.push("cmd.v1", "dialog.v1", "command.v1");
      if (uploads === "on") expected.push("upload.v1", "upload.lan.v1");
      else if (uploads === "loopback") expected.push("upload.v1");
    }
    expect([...hello.caps].sort()).toEqual([...expected].sort());
    await hub.close();
    hub = undefined;
    resetGlobals();
  });
});

describe("wireWebHub — runtx compat posture (F0 reviewer ruling → F2)", () => {
  it("hello_ack.caps WITHOUT runtx.v1 ⇒ run_tx_req unanswered and run_watch never observes", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
    const query = fakeQuery({ get: () => ({ status: "running", diag: {} }) });
    const { pi, fire } = fakePi();
    const control = wireWebHub(pi, deps({ query: () => query }));
    const { ctx } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
    const helloFrame = hub.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
    hub.send(hub.conns[0]!, ackFrame(`a${helloFrame.agentId.pid}`, 4242, FULL_CAPS)); // no runtx.v1
    await waitUntil(() => control.status().state === "live", 3_000, "live");
    hub.send(hub.conns[0]!, { t: "run_watch", runId: "r_ABCDEFGH", on: true });
    hub.send(hub.conns[0]!, { t: "run_tx_req", rid: "q1", runId: "r_ABCDEFGH", limit: 50, maxBytes: 1 << 20 });
    await new Promise((r) => setTimeout(r, 200));
    expect(hub.all().some((f) => f.t === "run_tx_reply")).toBe(false);
    expect(hub.all().some((f) => f.t === "run_ev")).toBe(false);
    expect(query.observeCalls).toEqual([]);
  });

  it('subagentTranscript:"off" ⇒ silently inert even when the hub advertises runtx.v1', async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
    const query = fakeQuery({ get: () => ({ status: "running", diag: {} }) });
    const { pi, fire } = fakePi();
    const control = wireWebHub(pi, deps({ settings: { ...SETTINGS, subagentTranscript: "off" }, query: () => query }));
    const { ctx } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
    const helloFrame = hub.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
    expect(helloFrame.caps).not.toContain("runtx.v1");
    hub.send(hub.conns[0]!, ackFrame(`a${helloFrame.agentId.pid}`, 4242, [...FULL_CAPS, "runtx.v1"]));
    await waitUntil(() => control.status().state === "live", 3_000, "live");
    hub.send(hub.conns[0]!, { t: "run_watch", runId: "r_ABCDEFGH", on: true });
    hub.send(hub.conns[0]!, { t: "run_tx_req", rid: "q1", runId: "r_ABCDEFGH", limit: 50, maxBytes: 1 << 20 });
    await new Promise((r) => setTimeout(r, 200));
    expect(hub.all().some((f) => f.t === "run_tx_reply")).toBe(false);
    expect(query.observeCalls).toEqual([]);
  });
});

describe("wireWebHub — runtx wire plumbing (F2)", () => {
  const RUN = "r_ABCDEFGH";
  const branchEntry = {
    id: "e1",
    parentId: null,
    type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  };

  async function connectRuntx(query: QueryControlPort): Promise<void> {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
    const { pi, fire } = fakePi();
    const control = wireWebHub(pi, deps({ query: () => query }));
    const { ctx } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
    const helloFrame = hub.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
    hub.send(hub.conns[0]!, ackFrame(`a${helloFrame.agentId.pid}`, 4242, [...FULL_CAPS, "runtx.v1"]));
    await waitUntil(() => control.status().state === "live", 3_000, "live");
  }

  it("terminal run ⇒ deterministic source:file reply (sessionFile + finalLeafId)", async () => {
    const query = fakeQuery({
      get: () => ({ status: "completed", diag: { sessionFile: "/tmp/run.jsonl", finalLeafId: "leaf-1" } }),
    });
    await connectRuntx(query);
    hub!.send(hub!.conns[0]!, { t: "run_tx_req", rid: "q1", runId: RUN, limit: 50, maxBytes: 1 << 20 });
    await waitUntil(() => hub!.all().some((f) => f.t === "run_tx_reply"));
    const reply = hub!.all().find((f) => f.t === "run_tx_reply") as RunTxReplyFrame;
    expect(reply).toEqual({
      t: "run_tx_reply",
      rid: "q1",
      runId: RUN,
      ok: true,
      source: "file",
      status: "completed",
      sessionFile: "/tmp/run.jsonl",
      finalLeafId: "leaf-1",
    });
  });

  it("live run: run_watch attaches a tap (observe called), events flow as run_ev, snapshot answers watching:true", async () => {
    let listener: { onEvent(e: unknown): void; onEnd(status: string): void } | undefined;
    const query = fakeQuery({
      get: () => ({ status: "running", diag: {} }),
      branchOf: () => [branchEntry],
      observe: (_id, l) => {
        listener = l;
        return { kind: "attached", detach: () => undefined };
      },
    });
    await connectRuntx(query);
    hub!.send(hub!.conns[0]!, { t: "run_watch", runId: RUN, on: true });
    await waitUntil(() => listener !== undefined, 3_000, "observe attached");
    listener!.onEvent({ type: "turn_start", turnIndex: 1 });
    await waitUntil(() => hub!.all().some((f) => f.t === "run_ev"), 3_000, "run_ev");
    const ev = hub!.all().find((f) => f.t === "run_ev") as Extract<AgentFrame, { t: "run_ev" }>;
    expect(ev).toMatchObject({ runId: RUN, seq: 1, e: { type: "turn_start" } });
    hub!.send(hub!.conns[0]!, { t: "run_tx_req", rid: "q2", runId: RUN, limit: 50, maxBytes: 1 << 20 });
    await waitUntil(() => hub!.all().some((f) => f.t === "run_tx_reply" && f.rid === "q2"), 3_000, "reply");
    const reply = hub!.all().find((f) => f.t === "run_tx_reply" && f.rid === "q2") as RunTxReplyFrame;
    expect(reply).toMatchObject({ ok: true, source: "live", watching: true, seq: 1, tapId: ev.tapId });
    if (reply.ok && reply.source === "live") expect(reply.entries.map((e) => e.id)).toEqual(["e1"]);
  });

  it("unknown run ⇒ E_NOT_FOUND/unknown_run", async () => {
    await connectRuntx(fakeQuery());
    hub!.send(hub!.conns[0]!, { t: "run_tx_req", rid: "q3", runId: RUN, limit: 50, maxBytes: 1 << 20 });
    await waitUntil(() => hub!.all().some((f) => f.t === "run_tx_reply"));
    expect(hub!.all().find((f) => f.t === "run_tx_reply")).toMatchObject({
      ok: false,
      code: "E_NOT_FOUND",
      reason: "unknown_run",
    });
  });
});

describe("wireWebHub — fleet omitted counts (fleet-drawer §3.2/#12)", () => {
  it("more terminal runs than the 8-row cap ⇒ the fleet slot carries omitted", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const terminals = Array.from({ length: 10 }, (_, i) =>
      runSnap({ runId: `run-${i}`, status: "completed", phase: "settled", updatedAt: i }),
    );
    const { pi, fire } = fakePi();
    wireWebHub(pi, deps({ fleet: () => terminals }));
    const { ctx } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "fleet"), 3_000, "fleet frame");
    const fleet = hub.all().find((f) => f.t === "fleet") as Extract<AgentFrame, { t: "fleet" }>;
    expect(fleet.runs).toHaveLength(8);
    expect(fleet.omitted).toEqual({ active: 0, terminal: 2 });
  });

  it("nothing dropped ⇒ no omitted key on the fleet frame", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const { pi, fire } = fakePi();
    wireWebHub(pi, deps({ fleet: () => [runSnap()] }));
    const { ctx } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "fleet"), 3_000, "fleet frame");
    const fleet = hub.all().find((f) => f.t === "fleet") as Extract<AgentFrame, { t: "fleet" }>;
    expect(fleet).not.toHaveProperty("omitted");
  });
});

describe("wireWebHub — runtx session replacement (F2 P1 regression: reset, not kill)", () => {
  const RUN = "r_CDEFGH12";

  it("session_shutdown(new) → session_start: run service answers again; the old tap stays fully unbound", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
    const listeners: Array<{ onEvent(e: unknown): void; onEnd(status: string): void }> = [];
    const detaches: string[] = [];
    const query = fakeQuery({
      get: () => ({ status: "running", diag: {} }),
      branchOf: () => [],
      observe: (_id, l) => {
        listeners.push(l);
        return { kind: "attached", detach: () => detaches.push(_id) };
      },
    });
    const { pi, fire } = fakePi();
    const control = wireWebHub(pi, deps({ query: () => query }));
    const { ctx } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
    const helloFrame = hub.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
    hub.send(hub.conns[0]!, ackFrame(`a${helloFrame.agentId.pid}`, 4242, [...FULL_CAPS, "runtx.v1"]));
    await waitUntil(() => control.status().state === "live", 3_000, "live");
    hub.send(hub.conns[0]!, { t: "run_watch", runId: RUN, on: true });
    await waitUntil(() => listeners.length === 1, 3_000, "first tap attached");

    // Same-activation session replacement (/new): shutdown → start, same wireWebHub instance.
    fire("session_shutdown", { type: "session_shutdown", reason: "new" }, ctx);
    expect(detaches).toEqual([RUN]); // old tap/observer fully unbound at the boundary
    const { ctx: ctx2 } = fakeCtx({ mode: "tui" });
    fire("session_start", { type: "session_start", reason: "new" }, ctx2);
    await waitUntil(() => control.status().state === "live", 3_000, "live after /new");

    // The stale listener must never produce a frame in the new session.
    listeners[0]!.onEvent({ type: "turn_start", turnIndex: 99 });
    await new Promise((r) => setTimeout(r, 150));
    expect(hub.all().some((f) => f.t === "run_ev")).toBe(false);

    // …and the run service answers the NEW session's watch/req (the P1 bug: permanently dead).
    hub.send(hub.conns[0]!, { t: "run_watch", runId: RUN, on: true });
    await waitUntil(() => listeners.length === 2, 3_000, "second tap attached");
    listeners[1]!.onEvent({ type: "turn_start", turnIndex: 1 });
    await waitUntil(() => hub!.all().some((f) => f.t === "run_ev"), 3_000, "run_ev after /new");
    hub.send(hub.conns[0]!, { t: "run_tx_req", rid: "q9", runId: RUN, limit: 50, maxBytes: 1 << 20 });
    await waitUntil(() => hub!.all().some((f) => f.t === "run_tx_reply" && f.rid === "q9"), 3_000, "reply after /new");
    expect(hub.all().find((f) => f.t === "run_tx_reply" && f.rid === "q9")).toMatchObject({
      ok: true,
      source: "live",
      watching: true,
    });
  });
});
