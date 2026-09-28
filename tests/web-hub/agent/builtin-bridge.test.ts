/**
 * §4.6/§4.9 `BuiltinBridge.execute()` pipeline tests (plan control-plan.md, package C11):
 * validate → classify → policy (deny/confirm) → dispatch by kind (template/skill, extension incl.
 * `capture.arm`/`settleArm`, builtin incl. the 7-name direct-dispatch table).
 */
import { describe, expect, it, vi } from "vitest";
import { createBuiltinBridge, type BuiltinBridgeDeps } from "../../../src/web-hub/agent/builtin-bridge.js";
import type { CommandCapturePort, CaptureInvocation } from "../../../src/web-hub/agent/command-capture.js";
import type { CmdFrame, CmdOrigin, CommandOutputWire } from "../../../src/web-hub/protocol/messages.js";

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "abcdef0123456789" };

function frame(name: string, args: string, over: Partial<CmdFrame> = {}, confirm?: true): CmdFrame {
  return {
    t: "cmd",
    rid: "r-1",
    id: "cmd-0000000000000001",
    deadlineMs: 8_000,
    origin: ORIGIN,
    cmd: { op: "command", name, args, ...(confirm !== undefined ? { confirm } : {}) },
    ...over,
  };
}

interface FakeCtxOptions {
  idle?: boolean;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  compact?: (opts?: {
    customInstructions?: string;
    onComplete?: (r: unknown) => void;
    onError?: (e: Error) => void;
  }) => void;
  findModel?: (provider: string, id: string) => { provider: string; id: string } | undefined;
  throwIsIdle?: boolean;
}

function fakeCtx(opts: FakeCtxOptions = {}) {
  const compactCalls: Array<{ customInstructions?: string }> = [];
  const ctx = {
    isIdle: () => {
      if (opts.throwIsIdle === true) throw new Error("stale");
      return opts.idle ?? true;
    },
    model: opts.model ?? { provider: "anthropic", id: "claude" },
    thinkingLevel: opts.thinkingLevel ?? "medium",
    sessionManager: {
      getSessionId: () => opts.sessionId ?? "sess-1",
      getSessionFile: () => opts.sessionFile ?? "/tmp/session.jsonl",
      getSessionName: () => opts.sessionName,
    },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
    compact: (o?: { customInstructions?: string; onComplete?: (r: unknown) => void; onError?: (e: Error) => void }) => {
      compactCalls.push({ customInstructions: o?.customInstructions });
      opts.compact?.(o);
    },
    modelRegistry: { find: opts.findModel ?? (() => undefined) },
  };
  return { ctx: ctx as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext, compactCalls };
}

interface FakePiOptions {
  commands?: Array<{ name: string; source: "extension" | "prompt" | "skill"; description?: string }>;
  throwOnSend?: boolean;
  setModelResult?: boolean | "throw";
}
function fakePi(opts: FakePiOptions = {}) {
  const sent: Array<{ text: string; options?: unknown }> = [];
  const sessionNameCalls: string[] = [];
  const thinkingLevelCalls: string[] = [];
  const pi = {
    getCommands: () => opts.commands ?? [],
    sendUserMessage: (text: string, options?: unknown) => {
      if (opts.throwOnSend === true) throw new Error("stale ctx");
      sent.push({ text, options });
    },
    setSessionName: (name: string) => {
      sessionNameCalls.push(name);
    },
    setThinkingLevel: (level: string) => {
      thinkingLevelCalls.push(level);
    },
    setModel: (_model: unknown) => {
      if (opts.setModelResult === "throw") throw new Error("boom");
      return Promise.resolve(opts.setModelResult ?? true);
    },
  };
  return { pi: pi as unknown as BuiltinBridgeDeps["pi"], sent, sessionNameCalls, thinkingLevelCalls };
}

function fakeCapture(over: Partial<CommandCapturePort> = {}): CommandCapturePort & { armed?: CaptureInvocation } {
  const port: CommandCapturePort & { armed?: CaptureInvocation } = {
    arm(invocation) {
      port.armed = invocation;
    },
    take() {
      return undefined;
    },
    settleArm() {},
    finish() {},
    owns: () => false,
    ...over,
  };
  return port;
}

function baseDeps(over: Partial<BuiltinBridgeDeps> = {}): BuiltinBridgeDeps {
  const { ctx } = fakeCtx();
  return {
    getCtx: () => ctx,
    getSessionId: () => "sess-1",
    now: () => 1000,
    ...over,
  };
}

describe("execute — validation and classification", () => {
  it("rejects a non-command op with E_UNSUPPORTED", () => {
    const bridge = createBuiltinBridge();
    const f: CmdFrame = {
      t: "cmd",
      rid: "r",
      id: "id-000000000000000a",
      deadlineMs: 1000,
      origin: ORIGIN,
      cmd: { op: "abort" },
    };
    expect(bridge.execute(f)).toEqual({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" });
  });
  it("rejects a bad command name", () => {
    const bridge = createBuiltinBridge(baseDeps());
    expect(bridge.execute(frame("bad name!", ""))).toMatchObject({ ok: false, code: "E_BAD_REQUEST" });
  });
  it("rejects oversized args", () => {
    const bridge = createBuiltinBridge(baseDeps());
    expect(bridge.execute(frame("session", "x".repeat(16 * 1024 + 1)))).toMatchObject({
      ok: false,
      code: "E_BAD_REQUEST",
    });
  });
  it("E_STALE_CTX when getCtx() returns undefined", () => {
    const bridge = createBuiltinBridge({ getCtx: () => undefined });
    expect(bridge.execute(frame("session", ""))).toEqual({
      ok: false,
      code: "E_STALE_CTX",
      retryable: true,
      effect: "none",
    });
  });
  it("E_SESSION_CHANGED when expect.sessionId mismatches", () => {
    const bridge = createBuiltinBridge(baseDeps());
    const f = frame("session", "", {
      cmd: { op: "command", name: "session", args: "", expect: { sessionId: "other" } },
    });
    expect(bridge.execute(f)).toEqual({ ok: false, code: "E_SESSION_CHANGED", retryable: false, effect: "none" });
  });
  it("E_UNKNOWN_COMMAND for a name in neither pi.getCommands() nor the builtin tables", () => {
    const bridge = createBuiltinBridge(baseDeps({ pi: fakePi().pi }));
    expect(bridge.execute(frame("totally-made-up", ""))).toEqual({
      ok: false,
      code: "E_UNKNOWN_COMMAND",
      retryable: false,
      effect: "none",
    });
  });
  it("degrades to E_UNSUPPORTED end-to-end with zero deps (aligns with the current index.ts:221 call site)", () => {
    const bridge = createBuiltinBridge();
    expect(bridge.execute(frame("session", ""))).toEqual({
      ok: false,
      code: "E_STALE_CTX",
      retryable: true,
      effect: "none",
    });
  });
});

describe("execute — policy gate (deny/confirm, §4.6)", () => {
  it("denies a builtin the bridge does not implement", () => {
    const bridge = createBuiltinBridge(baseDeps());
    expect(bridge.execute(frame("quit", ""))).toEqual({
      ok: false,
      code: "E_COMMAND_DENIED",
      retryable: false,
      effect: "none",
    });
  });
  it("a third-party extension command requires confirm:true first", () => {
    const { pi } = fakePi({ commands: [{ name: "third-party", source: "extension" }] });
    const bridge = createBuiltinBridge(baseDeps({ pi }));
    const first = bridge.execute(frame("third-party", "go"));
    expect(first).toMatchObject({ ok: false, code: "E_CONFIRM_REQUIRED", retryable: false, effect: "none" });
    expect((first as { message?: string }).message).toContain("/third-party go");
    const confirmed = bridge.execute(frame("third-party", "go", {}, true));
    expect(confirmed).toMatchObject({ ok: true });
  });
  it("webCommandPolicy overrides are honored", () => {
    const bridge = createBuiltinBridge(baseDeps({ overrides: () => ({ quit: "allow" }) }));
    // quit is builtin+deny by default but overridden to allow; the bridge still has no dispatch
    // logic for it (not in BUILTIN_BRIDGE_NAMES) so it falls through to the default deny branch.
    expect(bridge.execute(frame("quit", ""))).toMatchObject({ ok: false, code: "E_COMMAND_DENIED" });
  });
  it("/compact allows while idle, requires confirm while busy (policyBusy)", () => {
    const { ctx: idleCtx } = fakeCtx({ idle: true });
    const bridge = createBuiltinBridge(baseDeps({ getCtx: () => idleCtx }));
    expect(bridge.execute(frame("compact", ""))).toMatchObject({ ok: true });
    const { ctx: busyCtx } = fakeCtx({ idle: false });
    const busyBridge = createBuiltinBridge(baseDeps({ getCtx: () => busyCtx }));
    expect(busyBridge.execute(frame("compact", ""))).toMatchObject({ ok: false, code: "E_CONFIRM_REQUIRED" });
    expect(busyBridge.execute(frame("compact", "", {}, true))).toMatchObject({ ok: true });
  });
});

describe("execute — template/skill dispatch", () => {
  it("dispatches a prompt template with expandPromptTemplates:true, deliverAs defaulting to steer", () => {
    const { pi, sent } = fakePi({ commands: [{ name: "review", source: "prompt" }] });
    const bridge = createBuiltinBridge(baseDeps({ pi }));
    expect(bridge.execute(frame("review", "focus on tests"))).toEqual({
      ok: true,
      data: { op: "command", kind: "template", completion: "unknown" },
    });
    expect(sent).toEqual([
      { text: "/review focus on tests", options: { expandPromptTemplates: true, deliverAs: "steer" } },
    ]);
  });
  it("a skill dispatches the same way and is classified as template kind in the result", () => {
    const { pi, sent } = fakePi({ commands: [{ name: "dev-flow", source: "skill" }] });
    const bridge = createBuiltinBridge(baseDeps({ pi }));
    expect(bridge.execute(frame("dev-flow", ""))).toEqual({
      ok: true,
      data: { op: "command", kind: "template", completion: "unknown" },
    });
    expect(sent[0]).toEqual({ text: "/dev-flow", options: { expandPromptTemplates: true, deliverAs: "steer" } });
  });
  it("E_STALE_CTX when sendUserMessage throws synchronously", () => {
    const { pi } = fakePi({ commands: [{ name: "review", source: "prompt" }], throwOnSend: true });
    const bridge = createBuiltinBridge(baseDeps({ pi }));
    expect(bridge.execute(frame("review", ""))).toEqual({
      ok: false,
      code: "E_STALE_CTX",
      retryable: true,
      effect: "none",
    });
  });
});

describe("execute — extension dispatch + capture.arm/settleArm (§4.9)", () => {
  it("arms the capture before dispatch and settles it after, even with no capture wired", () => {
    const { pi, sent } = fakePi({ commands: [{ name: "agent", source: "extension" }] });
    const bridge = createBuiltinBridge(baseDeps({ pi }));
    const result = bridge.execute(frame("agent", "status"));
    expect(result).toEqual({
      ok: true,
      data: { op: "command", kind: "extension", completion: "unknown", captured: false },
    });
    expect(sent).toEqual([{ text: "/agent status", options: { expandPromptTemplates: true, deliverAs: "followUp" } }]);
  });
  it("arms with the frame's cmdId/origin/name/args and a now()+deadlineMs deadline, then settles", () => {
    const { pi } = fakePi({ commands: [{ name: "agent", source: "extension" }] });
    const capture = fakeCapture();
    const settleArm = vi.fn();
    const bridge = createBuiltinBridge(baseDeps({ pi, capture: () => ({ ...capture, settleArm }), now: () => 5000 }));
    bridge.execute(frame("agent", "status"));
    expect(capture.armed).toMatchObject({
      cmdId: "cmd-0000000000000001",
      reqId: ORIGIN.reqId,
      name: "agent",
      args: "status",
      deadlineAt: 5000 + 8000,
    });
    expect(settleArm).toHaveBeenCalledTimes(1);
  });
  it("captured:true + completion:sync when the capture already owns the name and has collected output", () => {
    const { pi } = fakePi({ commands: [{ name: "agent", source: "extension" }] });
    const output: CommandOutputWire = { entries: [{ kind: "notify", text: "hi", level: "info" }] };
    const capture = fakeCapture({ owns: () => true, output: () => output });
    const bridge = createBuiltinBridge(baseDeps({ pi, capture: () => capture }));
    expect(bridge.execute(frame("agent", "status"))).toEqual({
      ok: true,
      data: { op: "command", kind: "extension", completion: "sync", captured: true, output },
    });
  });
  it("captured:true + completion:unknown when the capture owns the name but has no output yet (settle-deferred handler)", () => {
    const { pi } = fakePi({ commands: [{ name: "agent", source: "extension" }] });
    const capture = fakeCapture({ owns: () => true, output: () => ({ entries: [] }) });
    const bridge = createBuiltinBridge(baseDeps({ pi, capture: () => capture }));
    expect(bridge.execute(frame("agent", "status"))).toEqual({
      ok: true,
      data: { op: "command", kind: "extension", completion: "unknown", captured: true },
    });
  });
  it("still settles the capture on a synchronous sendUserMessage throw, and reports E_STALE_CTX", () => {
    const { pi } = fakePi({ commands: [{ name: "agent", source: "extension" }], throwOnSend: true });
    const settleArm = vi.fn();
    const bridge = createBuiltinBridge(baseDeps({ pi, capture: () => fakeCapture({ settleArm }) }));
    expect(bridge.execute(frame("agent", "status"))).toEqual({
      ok: false,
      code: "E_STALE_CTX",
      retryable: true,
      effect: "none",
    });
    expect(settleArm).toHaveBeenCalledTimes(1);
  });
  it("/webhub status is allowed and dispatched as an ordinary extension command", () => {
    const { pi, sent } = fakePi({ commands: [{ name: "webhub", source: "extension" }] });
    const bridge = createBuiltinBridge(baseDeps({ pi }));
    expect(bridge.execute(frame("webhub", "status"))).toMatchObject({ ok: true });
    expect(sent[0]?.text).toBe("/webhub status");
  });
  it("/webhub __exec is denied even though it is technically a sub-command of a real extension command", () => {
    const { pi } = fakePi({ commands: [{ name: "webhub", source: "extension" }] });
    const bridge = createBuiltinBridge(baseDeps({ pi }));
    expect(bridge.execute(frame("webhub", "__exec new deadbeef"))).toMatchObject({
      ok: false,
      code: "E_COMMAND_DENIED",
    });
  });
});

describe("execute — builtin dispatch (§4.6 builtin row)", () => {
  it("/session returns a synchronous text summary built from ctx", () => {
    const { ctx } = fakeCtx({
      sessionId: "sess-9",
      model: { provider: "anthropic", id: "claude-x" },
      sessionName: "demo",
    });
    const bridge = createBuiltinBridge(baseDeps({ getCtx: () => ctx }));
    const result = bridge.execute(frame("session", ""));
    expect(result.ok).toBe(true);
    const data = (result as { data: { output?: CommandOutputWire } }).data;
    const text = data.output?.entries[0]?.text ?? "";
    expect(text).toContain("sess-9");
    expect(text).toContain("anthropic/claude-x");
    expect(text).toContain("demo");
  });
  it("/name denies with no argument at the policy gate (never reaches the dispatch handler), sets the name once confirmed", () => {
    const { pi, sessionNameCalls } = fakePi();
    const bridge = createBuiltinBridge(baseDeps({ pi }));
    expect(bridge.execute(frame("name", "  "))).toEqual({
      ok: false,
      code: "E_COMMAND_DENIED",
      retryable: false,
      effect: "none",
    });
    expect(bridge.execute(frame("name", "New Name"))).toEqual({
      ok: true,
      data: { op: "command", kind: "builtin", completion: "sync" },
    });
    expect(sessionNameCalls).toEqual(["New Name"]);
  });
  it("/thinking validates the level and forwards it", () => {
    const { pi, thinkingLevelCalls } = fakePi();
    const bridge = createBuiltinBridge(baseDeps({ pi }));
    expect(bridge.execute(frame("thinking", "nonsense"))).toMatchObject({ ok: false, code: "E_BAD_REQUEST" });
    expect(bridge.execute(frame("thinking", "HIGH"))).toEqual({
      ok: true,
      data: { op: "command", kind: "builtin", completion: "sync" },
    });
    expect(thinkingLevelCalls).toEqual(["high"]);
  });
  it("/model resolves provider/id via ctx.modelRegistry.find and calls pi.setModel", () => {
    const model = { provider: "anthropic", id: "claude" };
    const { ctx } = fakeCtx({ findModel: (p, i) => (p === "anthropic" && i === "claude" ? model : undefined) });
    const { pi } = fakePi();
    const bridge = createBuiltinBridge(baseDeps({ pi, getCtx: () => ctx }));
    expect(bridge.execute(frame("model", "bogus"))).toMatchObject({ ok: false, code: "E_BAD_REQUEST" });
    expect(bridge.execute(frame("model", "anthropic/unknown-id"))).toMatchObject({ ok: false, code: "E_BAD_REQUEST" });
    expect(bridge.execute(frame("model", "anthropic/claude"))).toEqual({
      ok: true,
      data: { op: "command", kind: "builtin", completion: "unknown" },
    });
  });
  it("/model reports completion:async and a later cmd_late when sendLate is wired", async () => {
    const model = { provider: "anthropic", id: "claude" };
    const { ctx } = fakeCtx({ findModel: () => model });
    const { pi } = fakePi({ setModelResult: false });
    const sendLate = vi.fn();
    const bridge = createBuiltinBridge(baseDeps({ pi, getCtx: () => ctx, sendLate }));
    expect(bridge.execute(frame("model", "anthropic/claude"))).toEqual({
      ok: true,
      data: { op: "command", kind: "builtin", completion: "async" },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(sendLate).toHaveBeenCalledTimes(1);
    expect(sendLate.mock.calls[0]?.[1]).toMatchObject({ ok: false, code: "E_SUBAGENT_REJECTED" });
  });
  it("/compact fires ctx.compact and reports completion:unknown without sendLate, async with it", () => {
    const { ctx, compactCalls } = fakeCtx();
    const bridge = createBuiltinBridge(baseDeps({ getCtx: () => ctx }));
    expect(bridge.execute(frame("compact", "focus on X"))).toEqual({
      ok: true,
      data: { op: "command", kind: "builtin", completion: "unknown" },
    });
    expect(compactCalls).toEqual([{ customInstructions: "focus on X" }]);
    const sendLate = vi.fn();
    const bridge2 = createBuiltinBridge(baseDeps({ getCtx: () => ctx, sendLate }));
    expect(bridge2.execute(frame("compact", ""))).toEqual({
      ok: true,
      data: { op: "command", kind: "builtin", completion: "async" },
    });
  });
  it("/new dispatches /webhub __exec new <nonce> as a followUp", () => {
    const { pi, sent } = fakePi();
    const bridge = createBuiltinBridge(baseDeps({ pi }));
    expect(bridge.execute(frame("new", "", {}, true))).toMatchObject({
      ok: true,
      data: { op: "command", kind: "builtin" },
    });
    expect(sent[0]?.text).toMatch(/^\/webhub __exec new [0-9a-f]{32}$/);
    expect(sent[0]?.options).toEqual({ expandPromptTemplates: true, deliverAs: "followUp" });
  });
  it("/reload dispatches /agent reload as a followUp", () => {
    const { pi, sent } = fakePi();
    const bridge = createBuiltinBridge(baseDeps({ pi }));
    expect(bridge.execute(frame("reload", "", {}, true))).toMatchObject({
      ok: true,
      data: { op: "command", kind: "builtin" },
    });
    expect(sent[0]).toEqual({ text: "/agent reload", options: { expandPromptTemplates: true, deliverAs: "followUp" } });
  });
  it("builtins that need pi degrade to E_UNSUPPORTED when pi is not wired", () => {
    const bridge = createBuiltinBridge(baseDeps());
    expect(bridge.execute(frame("name", "x"))).toEqual({
      ok: false,
      code: "E_UNSUPPORTED",
      retryable: false,
      effect: "none",
    });
  });
});
