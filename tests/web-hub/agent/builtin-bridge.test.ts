/**
 * §4.6/§4.9 `BuiltinBridge.execute()` pipeline tests (plan control-plan.md, package C11):
 * validate → classify → policy (deny/confirm) → dispatch by kind (template/skill, extension incl.
 * `capture.arm`/`settleArm`, builtin incl. the 7-name direct-dispatch table).
 */
import { describe, expect, it, vi } from "vitest";
import { createBuiltinBridge, type BuiltinBridgeDeps } from "../../../src/web-hub/agent/builtin-bridge.js";
import type { CommandCapturePort, CaptureInvocation } from "../../../src/commands/capture.js";
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

describe("execute — extension async-late channel (fix 2026-10-22)", () => {
  /** Engine-shaped fake: owns the name, empty sync output, but an OPEN window for the frame's
   *  cmdId — plus the one-shot finish listener the bridge registers. */
  function asyncCapture(output: CommandOutputWire) {
    const listeners = new Map<string, (reason: "settled" | "timeout") => void>();
    const port: CommandCapturePort & { fire(id: string, reason: "settled" | "timeout"): void } = {
      arm() {},
      take: () => undefined,
      settleArm() {},
      finish() {},
      owns: () => true,
      output: () => ({ entries: [] }),
      isActive: (cmdId: string) => cmdId === "cmd-0000000000000001",
      onFinish: (cmdId: string, listener) => {
        listeners.set(cmdId, listener);
      },
      outputFor: () => output,
      fire(id: string, reason) {
        const listener = listeners.get(id);
        if (listener !== undefined) listener(reason);
      },
    };
    return port;
  }

  it("still-open window + sendLate wired ⇒ completion:async, and the finish listener sends the late result with outputFor's output", () => {
    const { pi } = fakePi({ commands: [{ name: "fabric", source: "extension" }] });
    const late: Array<{ id: string; body: unknown; reason?: "settled" | "timeout" }> = [];
    const output: CommandOutputWire = { entries: [{ kind: "notify", text: "fabric status ok", level: "info" }] };
    const capture = asyncCapture(output);
    const bridge = createBuiltinBridge(
      baseDeps({
        pi,
        capture: () => capture,
        sendLate: (frame, result) => late.push({ id: frame.id, body: result }),
      }),
    );
    const result = bridge.execute(frame("fabric", "status"));
    expect(result).toEqual({
      ok: true,
      data: { op: "command", kind: "extension", completion: "async", captured: true },
    });
    expect(late).toEqual([]); // nothing late yet — the handler is still running
    capture.fire("cmd-0000000000000001", "settled");
    expect(late).toEqual([
      {
        id: "cmd-0000000000000001",
        body: {
          ok: true,
          data: { op: "command", kind: "extension", completion: "sync", captured: true, output },
        },
      },
    ]);
  });

  it("a timeout-reason finish (window expiry / boundary dispose) sends the same late upgrade", () => {
    const { pi } = fakePi({ commands: [{ name: "fabric", source: "extension" }] });
    const late: unknown[] = [];
    const capture = asyncCapture({ entries: [] }); // nothing collected in time
    const bridge = createBuiltinBridge(
      baseDeps({ pi, capture: () => capture, sendLate: (_f, result) => late.push(result) }),
    );
    expect(bridge.execute(frame("fabric", "status"))).toMatchObject({ data: { completion: "async" } });
    capture.fire("cmd-0000000000000001", "timeout");
    expect(late).toEqual([
      { ok: true, data: { op: "command", kind: "extension", completion: "sync", captured: true } },
    ]);
  });

  it("no sendLate wired ⇒ stays completion:unknown even with an open window (legacy degrade)", () => {
    const { pi } = fakePi({ commands: [{ name: "fabric", source: "extension" }] });
    const capture = asyncCapture({ entries: [] });
    const bridge = createBuiltinBridge(baseDeps({ pi, capture: () => capture }));
    expect(bridge.execute(frame("fabric", "status"))).toEqual({
      ok: true,
      data: { op: "command", kind: "extension", completion: "unknown", captured: true },
    });
  });

  it("window NOT active (settle-deferred handler — take() never matched) ⇒ stays completion:unknown", () => {
    const { pi } = fakePi({ commands: [{ name: "fabric", source: "extension" }] });
    const capture = asyncCapture({ entries: [] });
    const bridge = createBuiltinBridge(
      baseDeps({
        pi,
        capture: () => ({ ...capture, isActive: () => false }),
        sendLate: (_f, r) => void r,
      }),
    );
    expect(bridge.execute(frame("fabric", "status"))).toEqual({
      ok: true,
      data: { op: "command", kind: "extension", completion: "unknown", captured: true },
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
  it("/new uses deps.armExec's nonce when provided, so it can be verified later (acc32-B4)", () => {
    const { pi, sent } = fakePi();
    const armExec = (op: string) => `armed-${op}-nonce`;
    const bridge = createBuiltinBridge(baseDeps({ pi, armExec }));
    bridge.execute(frame("new", "", {}, true));
    expect(sent[0]?.text).toBe("/webhub __exec new armed-new-nonce");
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

// ---------------------------------------------------------------------------
// web-resume plan §2.4/§2.5 — the `resume` builtin's two web forms through the bridge, the
// claim-aware armExec, and isQuiet.
// ---------------------------------------------------------------------------
describe("execute — web-resume resume forms (§2.4/§2.5)", () => {
  it("expect mismatch rejects with E_SESSION_CHANGED before the resume port is ever consulted", () => {
    const resume = vi.fn();
    const { ctx } = fakeCtx({ sessionId: "sess-1" });
    const bridge = createBuiltinBridge(baseDeps({ getCtx: () => ctx, getSessionId: () => "sess-1", resume }));
    const out = bridge.execute(
      frame("resume", '__pick {"id":"x","gen":"0123456789abcdef"}', {
        cmd: {
          op: "command",
          name: "resume",
          args: '__pick {"id":"x","gen":"0123456789abcdef"}',
          expect: { sessionId: "other" },
        },
      }),
    );
    expect(out).toMatchObject({ ok: false, code: "E_SESSION_CHANGED" });
    expect(resume).not.toHaveBeenCalled();
  });

  it("policy denies everything but __list/__pick, so the resume port never sees another form", () => {
    const resume = vi.fn();
    const bridge = createBuiltinBridge(baseDeps({ resume }));
    const out = bridge.execute(frame("resume", ""));
    expect(out).toMatchObject({ ok: false, code: "E_COMMAND_DENIED" });
    expect(resume).not.toHaveBeenCalled();
  });

  it("without the resume port wired the deny is the honest answer (feature signal is off too)", () => {
    const bridge = createBuiltinBridge(baseDeps({}));
    expect(bridge.execute(frame("resume", '__list {"scope":"recent"}'))).toMatchObject({
      ok: false,
      code: "E_COMMAND_DENIED",
    });
  });

  it("delegates __list/__pick to the resume port with the ctx, passing a Promise through verbatim", () => {
    const pending = { ok: true, data: { op: "command", kind: "builtin", completion: "sync" as const } };
    const resume = vi.fn((_frame: CmdFrame, _cmd: CmdArgs & { op: "command" }, _ctx: unknown) =>
      Promise.resolve(pending),
    );
    const { ctx } = fakeCtx();
    const bridge = createBuiltinBridge(baseDeps({ getCtx: () => ctx, resume }));
    const out = bridge.execute(frame("resume", '__list {"scope":"recent"}'));
    expect(out instanceof Promise).toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]![2]).toBe(ctx);
  });

  it("an override `resume: deny` blocks even __list (§2.7 override rule)", () => {
    const resume = vi.fn();
    const bridge = createBuiltinBridge(baseDeps({ resume, overrides: () => ({ resume: "deny" }) }));
    expect(bridge.execute(frame("resume", '__list {"scope":"recent"}'))).toMatchObject({
      ok: false,
      code: "E_COMMAND_DENIED",
    });
    expect(resume).not.toHaveBeenCalled();
  });

  it("/new with a held exec claim ⇒ E_COMMAND_DENIED exec:in-flight, no message sent (§2.5 step 3)", () => {
    const { pi, sent } = fakePi();
    const bridge = createBuiltinBridge(baseDeps({ pi, armExec: () => undefined }));
    const out = bridge.execute(frame("new", "", {}, true)); // the clear button bakes confirm:true in
    expect(out).toMatchObject({ ok: false, code: "E_COMMAND_DENIED", message: "exec:in-flight" });
    expect(sent).toHaveLength(0);
  });

  it("isQuiet marks exactly the `resume __list` form", () => {
    const bridge = createBuiltinBridge(baseDeps({}));
    expect(bridge.isQuiet(frame("resume", '__list {"scope":"all"}'))).toBe(true);
    expect(bridge.isQuiet(frame("resume", '__pick {"id":"x","gen":"0123456789abcdef"}'))).toBe(false);
    expect(bridge.isQuiet(frame("resume", ""))).toBe(false);
    expect(bridge.isQuiet(frame("new", ""))).toBe(false);
  });
});

describe("execute — /fabric web surface (2026-10-22 ruling: policy-gated, not hard-denied)", () => {
  it("fabric join is baseline allow and dispatches as an ordinary extension command", () => {
    const { pi, sent } = fakePi({ commands: [{ name: "fabric", source: "extension" }] });
    const bridge = createBuiltinBridge(baseDeps({ pi }));
    expect(bridge.execute(frame("fabric", "join"))).toMatchObject({ ok: true });
    expect(sent[0]).toEqual({ text: "/fabric join", options: { expandPromptTemplates: true, deliverAs: "followUp" } });
  });

  it("webCommandPolicy.fabric:'deny' refuses the mutation (override wins for the whole name)", () => {
    const { pi, sent } = fakePi({ commands: [{ name: "fabric", source: "extension" }] });
    const bridge = createBuiltinBridge(baseDeps({ pi, overrides: () => ({ fabric: "deny" }) }));
    expect(bridge.execute(frame("fabric", "join"))).toMatchObject({
      ok: false,
      code: "E_COMMAND_DENIED",
      effect: "none",
    });
    expect(sent).toEqual([]);
  });

  it("webCommandPolicy.fabric:'confirm' goes through the E_CONFIRM_REQUIRED → confirm:true round-trip", () => {
    const { pi } = fakePi({ commands: [{ name: "fabric", source: "extension" }] });
    const bridge = createBuiltinBridge(baseDeps({ pi, overrides: () => ({ fabric: "confirm" }) }));
    const first = bridge.execute(frame("fabric", "leave"));
    expect(first).toMatchObject({ ok: false, code: "E_CONFIRM_REQUIRED", effect: "none" });
    expect((first as { message?: string }).message).toContain("/fabric leave");
    expect(bridge.execute(frame("fabric", "leave", {}, true))).toMatchObject({ ok: true });
  });

  it("an unknown subcommand stays denied (typo surface)", () => {
    const { pi } = fakePi({ commands: [{ name: "fabric", source: "extension" }] });
    const bridge = createBuiltinBridge(baseDeps({ pi }));
    expect(bridge.execute(frame("fabric", "joinx"))).toMatchObject({ ok: false, code: "E_COMMAND_DENIED" });
  });

  it("the web sees join's output: a captured fabric invocation settles completion:sync with output", () => {
    const { pi } = fakePi({ commands: [{ name: "fabric", source: "extension" }] });
    const output: CommandOutputWire = { entries: [{ kind: "notify", text: "已加入（epoch 1）。", level: "info" }] };
    const capture = fakeCapture({ owns: () => true, output: () => output });
    const bridge = createBuiltinBridge(baseDeps({ pi, capture: () => capture }));
    expect(bridge.execute(frame("fabric", "join"))).toEqual({
      ok: true,
      data: { op: "command", kind: "extension", completion: "sync", captured: true, output },
    });
  });
});

// ---------------------------------------------------------------------------
// web-hub-cmd-history plan §5.2/§4.6 (A1) — bridge-side recording: the builtin card table,
// noteIntent, the terminal-only placeholder, the `history` open field, and the M3 freeze
// (bridge return values / sendLate sequence unchanged modulo the new `history` field).
// ---------------------------------------------------------------------------

/** Recording fake: captures every recorder call the bridge makes. */
function recRecorder(policy = "record") {
  const calls: {
    intents: Array<Record<string, unknown>>;
    externals: Array<Record<string, unknown>>;
    immediates: Array<Record<string, unknown>>;
  } = { intents: [], externals: [], immediates: [] };
  const handles = new Map<string, { settle: (o: { error?: unknown; failed?: string }) => void }>();
  const recorder = {
    policyFor: () => policy,
    noteIntent: (i: Record<string, unknown>) => calls.intents.push(i),
    begin: () => undefined,
    beginExternal: (i: Record<string, unknown> & { cmdId: string }) => {
      calls.externals.push(i);
      const h = {
        cmdId: i.cmdId,
        sink: () => undefined,
        commitBeforeLeave: () => undefined,
        afterLeaveCancelled: () => undefined,
        settle: (o: { error?: unknown; failed?: string }) => {
          calls.immediates.push({ kind: "settle", cmdId: i.cmdId, outcome: o });
        },
      };
      handles.set(i.cmdId, h);
      return h;
    },
    recordImmediate: (r: Record<string, unknown>) => calls.immediates.push({ kind: "immediate", ...r }),
    running: () => [],
    counters: () => ({ appended: 0, skipped: 0, failed: 0 }),
    dispose: () => undefined,
  };
  return { recorder: recorder as never, calls };
}

describe("execute — cmd-history: builtin cards at the real settlement point (§5.2 F5)", () => {
  it("/session: recordImmediate(done) carrying the same session text as the reply", () => {
    const { ctx } = fakeCtx({ sessionId: "sess-9" });
    const rec = recRecorder();
    const bridge = createBuiltinBridge(baseDeps({ getCtx: () => ctx, recorder: () => rec.recorder }));
    const result = bridge.execute(frame("session", "")) as { data: { output?: CommandOutputWire; history?: string } };
    expect(result.data.history).toBe("recorded");
    expect(rec.calls.immediates).toHaveLength(1);
    const r = rec.calls.immediates[0]!;
    expect(r.kind).toBe("immediate");
    expect(r).toMatchObject({ cmdId: "cmd-0000000000000001", name: "session", source: "web", state: "done" });
    const replyText = result.data.output?.entries[0]?.text;
    expect((r as { output?: CommandOutputWire }).output?.entries[0]?.text).toBe(replyText);
  });

  it("/name: recorded only after setSessionName succeeds, body 会话名称：<x>", () => {
    const { pi } = fakePi();
    const rec = recRecorder();
    const bridge = createBuiltinBridge(baseDeps({ pi, recorder: () => rec.recorder }));
    bridge.execute(frame("name", "Renamed"));
    expect(rec.calls.immediates).toHaveLength(1);
    expect(rec.calls.immediates[0]).toMatchObject({ name: "name", state: "done" });
    expect((rec.calls.immediates[0] as { output?: CommandOutputWire }).output?.entries[0]).toMatchObject({
      kind: "notify",
      text: "会话名称：Renamed",
    });
  });

  it("/name with a throwing setSessionName ⇒ E_STALE_CTX and NO record (effect none)", () => {
    const pi = {
      getCommands: () => [],
      setSessionName: () => {
        throw new Error("stale");
      },
    };
    const rec = recRecorder();
    const bridge = createBuiltinBridge(baseDeps({ pi: pi as never, recorder: () => rec.recorder }));
    expect(bridge.execute(frame("name", "x"))).toMatchObject({ ok: false, code: "E_STALE_CTX" });
    expect(rec.calls.immediates).toHaveLength(0);
  });

  it("/thinking: recorded after success, body 思考等级：<lv>", () => {
    const { pi } = fakePi();
    const rec = recRecorder();
    const bridge = createBuiltinBridge(baseDeps({ pi, recorder: () => rec.recorder }));
    bridge.execute(frame("thinking", "high"));
    expect((rec.calls.immediates[0] as { output?: CommandOutputWire }).output?.entries[0]).toMatchObject({
      kind: "notify",
      text: "思考等级：high",
    });
  });

  it("/model: beginExternal(lazyStart:true) in the same sync block — before the Promise can settle; an effect-none sync throw leaves NO record", async () => {
    const model = { provider: "anthropic", id: "claude" };
    const { ctx } = fakeCtx({ findModel: () => model });
    const rec = recRecorder();
    let release: (v: boolean) => void = () => {};
    const pi = {
      getCommands: () => [],
      setModel: () => new Promise<boolean>((res) => (release = res)),
    };
    const bridge = createBuiltinBridge(baseDeps({ pi: pi as never, getCtx: () => ctx, recorder: () => rec.recorder }));
    const result = bridge.execute(frame("model", "anthropic/claude")) as { data: { history?: string } };
    expect(result.data.history).toBe("recorded");
    // the record opened in the SAME synchronous block (§5.2 "于 setModel 调用前" — the lazy
    // timer starts before any settlement can run; the sync-throw gate keeps effect-none refusals
    // record-free), and the observer settle rides the resolution below.
    expect(rec.calls.externals[0]).toMatchObject({
      cmdId: "cmd-0000000000000001",
      name: "model",
      args: "anthropic/claude",
      source: "web",
      lazyStart: true,
    });
    release(true);
    await Promise.resolve();
    await Promise.resolve();
    const settle = rec.calls.immediates.find((i) => i.kind === "settle");
    expect(settle).toBeDefined();
    expect(settle).toMatchObject({ cmdId: "cmd-0000000000000001", outcome: {} });
    // effect-none: a synchronous setModel throw never opens a record
    const rec2 = recRecorder();
    const pi2 = {
      getCommands: () => [],
      setModel: () => {
        throw new Error("stale");
      },
    };
    const bridge2 = createBuiltinBridge(
      baseDeps({ pi: pi2 as never, getCtx: () => ctx, recorder: () => rec2.recorder }),
    );
    expect(bridge2.execute(frame("model", "anthropic/claude"))).toMatchObject({ ok: false, code: "E_STALE_CTX" });
    expect(rec2.calls.externals).toHaveLength(0);
  });

  it("/model auth rejection ⇒ settle failed with the fixed message (record, not the reply)", async () => {
    const model = { provider: "anthropic", id: "claude" };
    const { ctx } = fakeCtx({ findModel: () => model });
    const rec = recRecorder();
    const pi = { getCommands: () => [], setModel: () => Promise.resolve(false) };
    const bridge = createBuiltinBridge(baseDeps({ pi: pi as never, getCtx: () => ctx, recorder: () => rec.recorder }));
    bridge.execute(frame("model", "anthropic/claude"));
    await Promise.resolve();
    await Promise.resolve();
    const settle = rec.calls.immediates.find((i) => i.kind === "settle");
    expect(settle).toMatchObject({ outcome: { failed: "authentication not configured for that model" } });
  });

  it("/model promise rejection ⇒ settle failed with the rejection message", async () => {
    const model = { provider: "anthropic", id: "claude" };
    const { ctx } = fakeCtx({ findModel: () => model });
    const rec = recRecorder();
    const pi = { getCommands: () => [], setModel: () => Promise.reject(new Error("net down")) };
    const bridge = createBuiltinBridge(baseDeps({ pi: pi as never, getCtx: () => ctx, recorder: () => rec.recorder }));
    bridge.execute(frame("model", "anthropic/claude"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const settle = rec.calls.immediates.find((i) => i.kind === "settle");
    expect(settle).toMatchObject({ outcome: { failed: "net down" } });
  });

  it("/model: the sendLate .then chain is unchanged — async reply first, one late with the auth error", async () => {
    const model = { provider: "anthropic", id: "claude" };
    const { ctx } = fakeCtx({ findModel: () => model });
    const rec = recRecorder();
    const { pi } = fakePi({ setModelResult: false });
    const sendLate = vi.fn();
    const bridge = createBuiltinBridge(
      baseDeps({ pi: pi as never, getCtx: () => ctx, sendLate, recorder: () => rec.recorder }),
    );
    const sync = bridge.execute(frame("model", "anthropic/claude")) as { data: Record<string, unknown> };
    expect(sync.data).toEqual({ op: "command", kind: "builtin", completion: "async", history: "recorded" });
    await Promise.resolve();
    await Promise.resolve();
    expect(sendLate).toHaveBeenCalledTimes(1);
    // error bodies carry no CmdData (pre-feature shape, untouched); `history` rides ok lates only
    expect(sendLate.mock.calls[0]![1]).toEqual({
      ok: false,
      code: "E_SUBAGENT_REJECTED",
      retryable: false,
      effect: "none",
      message: "authentication not configured for that model",
    });
  });

  it("/compact: beginExternal(lazyStart:false), NO start entry ever; onComplete ⇒ settle done; onError ⇒ failed with message", async () => {
    const rec = recRecorder();
    const { ctx } = fakeCtx({
      compact: (o) => {
        queueMicrotask(() => o.onError?.(new Error("compact blew up")));
      },
    });
    const bridge = createBuiltinBridge(baseDeps({ getCtx: () => ctx, recorder: () => rec.recorder }));
    bridge.execute(frame("compact", ""));
    expect(rec.calls.externals[0]).toMatchObject({ name: "compact", lazyStart: false });
    await new Promise((r) => setTimeout(r, 0));
    const settle = rec.calls.immediates.find((i) => i.kind === "settle");
    expect(settle).toMatchObject({ outcome: { failed: "compact blew up" } });
  });

  it("/compact with recorder but NO sendLate: recording-only callbacks are passed to ctx.compact", async () => {
    const rec = recRecorder();
    const { ctx } = fakeCtx({ compact: (o) => queueMicrotask(() => o.onComplete?.()) });
    const bridge = createBuiltinBridge(baseDeps({ getCtx: () => ctx, recorder: () => rec.recorder }));
    const result = bridge.execute(frame("compact", "instruction-x")) as { data: Record<string, unknown> };
    expect(result.data).toEqual({ op: "command", kind: "builtin", completion: "unknown", history: "recorded" });
    await new Promise((r) => setTimeout(r, 0));
    const settle = rec.calls.immediates.find((i) => i.kind === "settle");
    expect(settle).toMatchObject({ outcome: {} });
  });

  it("/new: armExec receives the frame id; ok reply carries history recorded", () => {
    const { pi } = fakePi();
    const rec = recRecorder();
    const armExec = vi.fn((op: string) => `armed-${op}`);
    const bridge = createBuiltinBridge(baseDeps({ pi, armExec, recorder: () => rec.recorder }));
    const result = bridge.execute(frame("new", "", {}, true)) as { data: { history?: string } };
    expect(result.data.history).toBe("recorded");
    expect(armExec).toHaveBeenCalledWith("new", "cmd-0000000000000001");
    // the /new CARD itself is written at the internalExec execution point (index.ts), not here
    expect(rec.calls.immediates).toHaveLength(0);
  });

  it("/reload (#42): no intent noted, reply history none, still dispatches /agent reload", () => {
    const { pi, sent } = fakePi({ commands: [{ name: "agent", source: "extension" }] });
    const rec = recRecorder();
    const bridge = createBuiltinBridge(baseDeps({ pi, recorder: () => rec.recorder }));
    const result = bridge.execute(frame("reload", "", {}, true)) as { data: { history?: string } };
    expect(result.data.history).toBe("none");
    expect(rec.calls.intents).toEqual([]);
    expect(sent[0]?.text).toBe("/agent reload");
  });

  it("resume __list ⇒ history none; no recorder call", async () => {
    const rec = recRecorder();
    const resume = vi.fn(() => ({
      ok: true,
      data: { op: "command", kind: "builtin", completion: "sync", sessions: { total: 0, items: [] } },
    }));
    const bridge = createBuiltinBridge(baseDeps({ recorder: () => rec.recorder, resume: resume as never }));
    const r = (await bridge.execute(frame("resume", '__list {"scope":"all"}'))) as { data: Record<string, unknown> };
    expect(r.data.history).toBe("none");
    expect(rec.calls.immediates).toHaveLength(0);
  });
});

describe("execute — cmd-history: extension dispatch recording (G7 intents, Q4 placeholder)", () => {
  it("owned extension ⇒ noteIntent(source web, cmdId = frame id) before sendUserMessage; history recorded", () => {
    const { pi, sent } = fakePi({ commands: [{ name: "agent", source: "extension" }] });
    const capture = fakeCapture({ owns: () => true, output: () => ({ entries: [] }) });
    const rec = recRecorder();
    const bridge = createBuiltinBridge(
      baseDeps({ pi, capture: () => capture, recorder: () => rec.recorder, now: () => 4242 }),
    );
    const result = bridge.execute(frame("agent", "status")) as { data: { history?: string } };
    expect(result.data.history).toBe("recorded");
    expect(rec.calls.intents).toEqual([
      {
        cmdId: "cmd-0000000000000001",
        source: "web",
        sessionId: "sess-1",
        at: 4242,
        match: { name: "agent", args: "status" },
      },
    ]);
    expect(sent[0]?.text).toBe("/agent status");
  });

  it("a feishu-origin frame notes the intent with source feishu", () => {
    const { pi } = fakePi({ commands: [{ name: "agent", source: "extension" }] });
    const capture = fakeCapture({ owns: () => true, output: () => ({ entries: [] }) });
    const rec = recRecorder();
    const bridge = createBuiltinBridge(baseDeps({ pi, capture: () => capture, recorder: () => rec.recorder }));
    bridge.execute(
      frame("agent", "status", { origin: { listener: "lan", ip: "feishu", user: "feishu:ou_1", reqId: "r2" } }),
    );
    expect(rec.calls.intents[0]).toMatchObject({ source: "feishu" });
  });

  it("skip-policy owned extension (agent reload fire) ⇒ history none, intent still noted", () => {
    const { pi } = fakePi({ commands: [{ name: "agent", source: "extension" }] });
    const capture = fakeCapture({ owns: () => true, output: () => ({ entries: [] }) });
    const rec = recRecorder("skip");
    const bridge = createBuiltinBridge(baseDeps({ pi, capture: () => capture, recorder: () => rec.recorder }));
    const result = bridge.execute(frame("agent", "reload fire", {}, true)) as { data: { history?: string } };
    expect(result.data.history).toBe("none");
    expect(rec.calls.intents).toHaveLength(1);
  });

  it("third-party extension ⇒ terminal-only recordImmediate + history recorded (Q4)", () => {
    const { pi } = fakePi({ commands: [{ name: "third-party", source: "extension" }] });
    const rec = recRecorder();
    const bridge = createBuiltinBridge(baseDeps({ pi, recorder: () => rec.recorder, now: () => 777 }));
    const result = bridge.execute(frame("third-party", "go", {}, true)) as { data: { history?: string } };
    expect(result.data.history).toBe("recorded");
    expect(rec.calls.immediates).toEqual([
      {
        kind: "immediate",
        cmdId: "cmd-0000000000000001",
        name: "third-party",
        args: "go",
        source: "web",
        startedAt: 777,
        state: "done",
        notice: "terminal-only",
      },
    ]);
  });

  it("third-party dispatch that throws sendUserMessage ⇒ no record (effect none)", () => {
    const { pi } = fakePi({ commands: [{ name: "third-party", source: "extension" }], throwOnSend: true });
    const rec = recRecorder();
    const bridge = createBuiltinBridge(baseDeps({ pi, recorder: () => rec.recorder }));
    expect(bridge.execute(frame("third-party", "go", {}, true))).toMatchObject({ ok: false, code: "E_STALE_CTX" });
    expect(rec.calls.immediates).toHaveLength(0);
  });

  it("async-late (open window) reply carries history too (m2: late channels)", async () => {
    const model = { provider: "anthropic", id: "claude" };
    void model;
    const { pi } = fakePi({ commands: [{ name: "agent", source: "extension" }] });
    const late: CommandOutputWire = { entries: [{ kind: "notify", text: "late out", level: "info" }] };
    const listeners = new Map<string, (r: "settled" | "timeout") => void>();
    const capture: CommandCapturePort = {
      arm() {},
      take: () => undefined,
      settleArm() {},
      finish() {},
      owns: () => true,
      output: () => ({ entries: [] }),
      isActive: (id) => id === "cmd-0000000000000001",
      onFinish: (id, l) => listeners.set(id, l),
      outputFor: () => late,
    };
    const rec = recRecorder();
    const sendLate = vi.fn();
    const bridge = createBuiltinBridge(
      baseDeps({ pi, capture: () => capture, recorder: () => rec.recorder, sendLate }),
    );
    const result = bridge.execute(frame("agent", "status")) as { data: { history?: string } };
    expect(result.data).toMatchObject({ completion: "async" });
    expect(result.data.history).toBe("recorded");
    listeners.get("cmd-0000000000000001")!("settled");
    expect(sendLate).toHaveBeenCalledTimes(1);
    const lateBody = sendLate.mock.calls[0]![1] as { data: { output?: CommandOutputWire; history?: string } };
    expect(lateBody.data.output).toBe(late);
    expect(lateBody.data.history).toBe("recorded");
  });
});

describe("execute — cmd-history: M3 freeze (recorder unwired ⇒ byte-identical replies)", () => {
  /** Strip the `history` field from a result for comparison against the pre-feature shape. */
  const strip = (r: unknown): unknown => {
    const body = r as { data?: Record<string, unknown> };
    if (body?.data !== undefined && "history" in body.data) {
      const { history, ...rest } = body.data;
      void history;
      return { ...body, data: rest };
    }
    return r;
  };

  it("every builtin/extension reply equals the pre-feature shape once `history` is stripped", () => {
    const model = { provider: "anthropic", id: "claude" };
    const { ctx } = fakeCtx({ findModel: () => model, sessionId: "sess-9", sessionName: "n" });
    const { pi } = fakePi({ commands: [{ name: "agent", source: "extension" }] });
    const capture = fakeCapture({ owns: () => true, output: () => ({ entries: [] }) });
    const rec = recRecorder();
    const sendLate = vi.fn();
    const mk = (recorder?: () => unknown) =>
      createBuiltinBridge(
        baseDeps({
          pi: pi as never,
          getCtx: () => ctx,
          capture: () => capture,
          sendLate,
          ...(recorder !== undefined ? { recorder: recorder as never } : {}),
        }),
      );
    for (const [name, args, confirm] of [
      ["session", "", undefined],
      ["name", "N", undefined],
      ["thinking", "high", undefined],
      ["model", "anthropic/claude", undefined],
      ["compact", "", undefined],
      ["new", "", true],
      ["reload", "", true],
      ["agent", "status", undefined],
    ] as const) {
      const without = strip(mk().execute(frame(name, args, {}, confirm)));
      const withRec = strip(mk(() => rec.recorder).execute(frame(name, args, {}, confirm)));
      expect(withRec, name).toEqual(without);
    }
  });
});
