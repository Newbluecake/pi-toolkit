/**
 * Assembly-level wiring for the P2 control plane (plan §4.1/§3.1): `cmd`/`cmd_result` round-trip
 * over the real (fake-server) unix socket, dialog-op routing exclusivity, caps broadcast, and the
 * `ctl`/`status.queue` slots actually reaching the wire. Per-op business logic itself is covered
 * by `commands.test.ts`/`ledger.test.ts`/`queue-mirror.test.ts` — this file only proves the pieces
 * are wired together correctly inside `wireWebHub`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
async function connectFullCaps(): Promise<{
  control: ReturnType<typeof wireWebHub>;
  fire: ReturnType<typeof fakePi>["fire"];
}> {
  hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
  const { pi, fire } = fakePi();
  const control = wireWebHub(pi, deps());
  const { ctx } = fakeCtx({ mode: "tui" });
  fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
  const helloFrame = hub!.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
  hub!.send(hub!.conns[0]!, ackFrame(`a${helloFrame.agentId.pid}`, 4242, FULL_CAPS));
  await waitUntil(() => control.status().state === "live", 3_000, "live");
  return { control, fire };
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

  it("dialog_answer never reaches commandHandler (routed exclusively to the dialog bridge stub, which never replies)", async () => {
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
    await new Promise((r) => setTimeout(r, 60));
    expect(hub!.all().some((f) => f.t === "cmd_result")).toBe(false);
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
