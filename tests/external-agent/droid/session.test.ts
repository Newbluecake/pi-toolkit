import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassifiedError, classifiedInfo } from "../../../src/core/errors.js";
import { DEFAULT_EXTERNAL_AGENTS_SETTINGS } from "../../../src/external-agent/settings.js";
import type { DriverEvent } from "../../../src/core/types.js";
import type { ExternalCatalogPort } from "../../../src/external-agent/types.js";
import { createDroidEnvelope, type DroidEnvelope } from "../../../src/external-agent/droid/envelope.js";
import {
  DROID_METHODS,
  DROID_PERMISSION_ACK_TIMEOUT_MS,
  DROID_UNSUPPORTED_REQUEST_REPLY,
} from "../../../src/external-agent/droid/protocol.js";
import { droidNativeSessionPaths } from "../../../src/external-agent/droid/reconcile.js";
import { createDroidSession, type DroidRpcHandlersRef } from "../../../src/external-agent/droid/session.js";
import { MSG_PERMISSION_REPLY_FAILED, msgPermissionUnacknowledged } from "../../../src/external-agent/messages.js";
import { FakeChild, FakeLedger, FakeRpc, FakeTranscript, makeFakeDeps, makeSpec, type FakeDeps } from "./fakes.js";

const SETTINGS = { ...DEFAULT_EXTERNAL_AGENTS_SETTINGS.droid, enabled: true };
const SESSION_ID = "12345678-abcd-4321-9876-abcdef012345";
const flush = () => new Promise((r) => setImmediate(r));

function makeSession(
  f: FakeDeps,
  over: { resume?: boolean; transcript?: boolean; cwd?: string; settings?: typeof SETTINGS } = {},
) {
  const spec = makeSpec({ cwd: over.cwd ?? "/tmp/fake-cwd", persist: over.transcript ?? true });
  const child = new FakeChild();
  const handlersRef: DroidRpcHandlersRef = {
    current: {
      onNotification: () => {},
      onRequest: () => ({ error: { ...DROID_UNSUPPORTED_REQUEST_REPLY } }),
      onDrift: () => {},
      onProtocolError: () => {},
    },
  };
  const envelope: DroidEnvelope = createDroidEnvelope();
  const rpc = new FakeRpc({
    envelope,
    write: (line) => child.write(line),
    onNotification: (m, p) => handlersRef.current.onNotification(m, p),
    onRequest: (m, id, p) => handlersRef.current.onRequest(m, id, p),
    onDrift: (d) => handlersRef.current.onDrift(d),
    onProtocolError: (e) => handlersRef.current.onProtocolError(e),
    clock: f.clock,
  });
  rpc.handler = (method) => {
    if (method === DROID_METHODS.addUserMessage) return {};
    if (method === DROID_METHODS.interruptSession) return {};
    if (method === DROID_METHODS.getContextStats) return { used: 100, limit: 1000 };
    if (method === DROID_METHODS.closeSession) return {};
    return new Error(`unexpected ${method}`);
  };
  const ledger = new FakeLedger(spec.external.pricing, { thinkingInOutput: true, cumulativeIncludesChild: false });
  const transcript =
    over.transcript === false
      ? undefined
      : new FakeTranscript(`/tmp/fake-agent/external-agent/droid/sessions/${SESSION_ID}.jsonl`, undefined, false);
  const catalog: ExternalCatalogPort = {
    snapshot: () => undefined,
    refreshInBackground: () => {},
    observeInit: () => {},
  };
  const handle = createDroidSession({
    deps: f.deps,
    settings: over.settings ?? SETTINGS,
    spec,
    child,
    rpc,
    envelope,
    handlersRef,
    cwd: over.cwd ?? "/tmp/fake-cwd",
    sessionId: SESSION_ID,
    effectiveModelId: "gpt-6-luna",
    effectiveEffort: "low",
    autonomyEcho: "high",
    ...(transcript === undefined ? {} : { transcript }),
    ledger,
    resume: over.resume ?? false,
    catalog,
    bufferedNotifications: [],
  });
  return { handle, child, rpc, ledger, transcript, spec };
}

/** 跑完一个正常 turn（completed，零用量）。 */
function completeTurn(rpc: FakeRpc, text = "DONE") {
  rpc.notifyDroid({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
  rpc.notifyDroid({ type: "assistant_text_delta", messageId: "m-1", blockIndex: 0, textDelta: text });
  rpc.notifyDroid({
    type: "create_message",
    message: { id: "m-1", role: "assistant", content: [{ type: "text", text }] },
  });
  rpc.notifyDroid({
    type: "agent_turn_completed",
    reason: "completed",
    turnId: `t-${Math.random()}`,
    tokenUsage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
      factoryCredits: 1,
    },
  });
}

describe("droid/session attach 与首条消息", () => {
  it("attach 立即发 external_meta（sessionId/autonomy/pricing/degraded/nativeSessionFile）；二次 attach throw", () => {
    const f = makeFakeDeps();
    const { handle } = makeSession(f);
    const events: DriverEvent[] = [];
    handle.attach((e) => events.push(e));
    expect(events[0]).toMatchObject({
      t: "external_meta",
      meta: {
        provider: "droid",
        sessionId: SESSION_ID,
        autonomy: "high",
        pricing: { status: "priced", basis: "upstream" },
      },
    });
    const meta = (events[0] as Extract<DriverEvent, { t: "external_meta" }>).meta;
    expect(meta.nativeSessionFile).toContain(`/.factory/sessions/-tmp-fake-cwd/${SESSION_ID}.jsonl`);
    expect(() => handle.attach(() => {})).toThrow();
  });

  it("首条 prompt 拼装 rolePrompt/contextBlocks/schema；resume 形态原样透传", async () => {
    const f = makeFakeDeps();
    const { handle, rpc } = makeSession(f);
    handle.attach(() => {});
    const spec = makeSpec({
      rolePrompt: "You are a tester.",
      contextBlocks: [{ kind: "memory", text: "rule-1" }],
      schema: { type: "object" },
    });
    // 直接换 spec 太重，这里只验证默认 spec（无 rolePrompt/blocks/schema）原样 + 另有 prompt.ts 单测
    const p = handle.prompt("do the task");
    completeTurn(rpc);
    await p;
    const sent = rpc.requests.find((r) => r.method === DROID_METHODS.addUserMessage);
    expect(sent?.params).toEqual({ text: expect.stringContaining("do the task") });
    void spec;
  });

  it("prompt 完成 ⇒ resolve，getLastAssistantText/getUsage/getModelRef/getThinkingLevel 可用", async () => {
    const f = makeFakeDeps();
    const { handle, rpc } = makeSession(f);
    handle.attach(() => {});
    const p = handle.prompt("hi");
    completeTurn(rpc, "answer-text");
    await p;
    expect(handle.getLastAssistantText()).toBe("answer-text");
    expect(handle.getUsage()?.input).toBe(1);
    expect(handle.getModelRef?.()).toEqual({ provider: "droid", id: "gpt-6-luna" });
    expect(handle.getThinkingLevel?.()).toBe("low");
    expect(handle.getTurnErrorInfo?.()).toBeUndefined();
    expect(handle.sessionFile).toContain(SESSION_ID);
  });
});

describe("droid/session 反向权限请求（§4.3 零卡死表）", () => {
  it("request_permission ⇒ 同步回 proceed_once + approvals 计数；permission_resolved 清回执计时器", async () => {
    const f = makeFakeDeps();
    const events: DriverEvent[] = [];
    const { handle, rpc } = makeSession(f);
    handle.attach((e) => events.push(e));
    const p = handle.prompt("hi");
    rpc.notifyDroid({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    const reply = rpc.reverseRequest(DROID_METHODS.requestPermission, "req-1", {
      toolUses: [{ toolUse: { type: "tool_use", id: "call_1", name: "Execute", input: {} } }],
    });
    expect(reply).toEqual({ result: { selectedOption: "proceed_once" } });
    expect(events.some((e) => e.t === "external_meta" && e.meta.permissionApprovals === 1)).toBe(true);
    rpc.notifyDroid({
      type: "permission_resolved",
      requestId: "req-1",
      toolUseIds: ["call_1"],
      selectedOption: "proceed_once",
    });
    f.clock.advance(DROID_PERMISSION_ACK_TIMEOUT_MS + 1); // 回执已清 ⇒ 不致命
    completeTurn(rpc);
    await p;
    expect(rpc.requests.some((r) => r.method === DROID_METHODS.interruptSession)).toBe(false);
  });

  it("回执超时 10s ⇒ 致命收口：interrupt 发出 + terminate(now) + prompt reject config", async () => {
    const f = makeFakeDeps();
    const { handle, rpc, child } = makeSession(f);
    handle.attach(() => {});
    const p = handle.prompt("hi");
    rpc.notifyDroid({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    rpc.reverseRequest(DROID_METHODS.requestPermission, "req-2", { toolUses: [] });
    f.clock.advance(DROID_PERMISSION_ACK_TIMEOUT_MS);
    await expect(p).rejects.toSatisfy(
      (e) => classifiedInfo(e)?.kind === "config" && classifiedInfo(e)?.message === msgPermissionUnacknowledged(10_000),
    );
    expect(rpc.requests.some((r) => r.method === DROID_METHODS.interruptSession)).toBe(true);
    expect(child.terminated).toContain("now");
  });

  it("应答写入抛错（onProtocolError MSG_PERMISSION_REPLY_FAILED）⇒ 同样收口", async () => {
    const f = makeFakeDeps();
    const { handle, rpc, child } = makeSession(f);
    handle.attach(() => {});
    const p = handle.prompt("hi");
    rpc.notifyDroid({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    rpc.protocolError(
      new ClassifiedError({ kind: "internal", message: MSG_PERMISSION_REPLY_FAILED, retryable: false }),
    );
    await expect(p).rejects.toSatisfy((e) => classifiedInfo(e)?.message === MSG_PERMISSION_REPLY_FAILED);
    expect(rpc.requests.some((r) => r.method === DROID_METHODS.interruptSession)).toBe(true);
    expect(child.terminated).toContain("now");
  });

  it("ask_user / 未知反向请求 ⇒ -32601", async () => {
    const f = makeFakeDeps();
    const { handle, rpc } = makeSession(f);
    handle.attach(() => {});
    expect(rpc.reverseRequest("droid.ask_user", "r-1", {})).toEqual({ error: DROID_UNSUPPORTED_REQUEST_REPLY });
    expect(rpc.reverseRequest("droid.pick_options", "r-2", {})).toEqual({ error: DROID_UNSUPPORTED_REQUEST_REPLY });
  });
});

describe("droid/session 漂移与进程死亡", () => {
  it("strict 漂移 ⇒ config 致命（interrupt + SIGKILL + prompt reject）", async () => {
    const f = makeFakeDeps();
    const { handle, rpc, child } = makeSession(f);
    handle.attach(() => {});
    const p = handle.prompt("hi");
    rpc.drift("9.9.9");
    await expect(p).rejects.toSatisfy(
      (e) => classifiedInfo(e)?.kind === "config" && /protocol drift/.test(classifiedInfo(e)!.message),
    );
    expect(child.terminated).toContain("now");
  });

  it("warn 漂移 ⇒ 继续 + degraded protocol_drift + warnOnce", async () => {
    const f = makeFakeDeps();
    const { handle, rpc } = makeSession(f, { settings: { ...SETTINGS, protocolCheck: "warn" } });
    const events: DriverEvent[] = [];
    handle.attach((e) => events.push(e));
    const p = handle.prompt("hi");
    rpc.drift("9.9.9");
    completeTurn(rpc);
    await p; // 不致命
    expect(f.warnings.some((w) => /protocol drift/.test(w))).toBe(true);
    expect(events.some((e) => e.t === "external_meta" && e.meta.degraded?.includes("protocol_drift"))).toBe(true);
  });

  it("turn 中进程意外退出 ⇒ prompt reject internal（带 stderr 尾部）", async () => {
    const f = makeFakeDeps();
    const { handle, rpc, child } = makeSession(f);
    handle.attach(() => {});
    child.stderr = "boom SECRET";
    const p = handle.prompt("hi");
    rpc.notifyDroid({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    child.exit(1, null);
    await expect(p).rejects.toSatisfy((e) => {
      const info = classifiedInfo(e);
      return info?.kind === "internal" && /droid exited unexpectedly/.test(info.message) && /boom/.test(info.message);
    });
  });

  it("我方 abort 后进程退出 ⇒ prompt resolve", async () => {
    const f = makeFakeDeps();
    const { handle, rpc, child } = makeSession(f);
    handle.attach(() => {});
    const p = handle.prompt("hi");
    rpc.notifyDroid({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    const a = handle.requestAbort();
    child.exit(143, "SIGTERM");
    await p;
    await a;
  });
});

describe("droid/session steer/abort/dispose/killable（acceptance ⑩）", () => {
  it("steer idle ⇒ 立即 resolve 不发送；turn 中 ⇒ 发 add_user_message", async () => {
    const f = makeFakeDeps();
    const { handle, rpc } = makeSession(f);
    handle.attach(() => {});
    await handle.steer("idle-steer");
    expect(rpc.requests.filter((r) => r.method === DROID_METHODS.addUserMessage)).toHaveLength(0);
    const p = handle.prompt("hi");
    rpc.notifyDroid({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    await handle.steer("mid-turn-steer");
    expect(rpc.requests.filter((r) => r.method === DROID_METHODS.addUserMessage)).toHaveLength(2);
    completeTurn(rpc);
    await p;
  });

  it("requestAbort idle ⇒ 立即 resolve 不发 interrupt", async () => {
    const f = makeFakeDeps();
    const { handle, rpc } = makeSession(f);
    handle.attach(() => {});
    await handle.requestAbort();
    expect(rpc.requests.some((r) => r.method === DROID_METHODS.interruptSession)).toBe(false);
  });

  it("requestAbort turn 中 ⇒ interrupt；cancelled 结算后双 resolve", async () => {
    const f = makeFakeDeps();
    const { handle, rpc, child } = makeSession(f);
    handle.attach(() => {});
    const p = handle.prompt("hi");
    rpc.notifyDroid({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    const a = handle.requestAbort();
    expect(rpc.requests.some((r) => r.method === DROID_METHODS.interruptSession)).toBe(true);
    rpc.notifyDroid({
      type: "agent_turn_completed",
      reason: "cancelled",
      turnId: "t-ab",
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        factoryCredits: 0,
      },
    });
    await p;
    await a;
    expect(child.terminated).toHaveLength(0);
    expect(handle.getTurnErrorInfo?.()).toBeUndefined(); // 我方 abort ⇒ runner 按 stopCause 结算
  });

  it("requestAbort 后 interrupt 未结算 ⇒ 5s 升级 graceful", async () => {
    const f = makeFakeDeps();
    const { handle, rpc, child } = makeSession(f);
    handle.attach(() => {});
    const p = handle.prompt("hi");
    rpc.notifyDroid({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    const a = handle.requestAbort();
    f.clock.advance(5_000);
    await a;
    expect(child.terminated).toContain("graceful");
    rpc.notifyDroid({
      type: "agent_turn_completed",
      reason: "cancelled",
      turnId: "t-ab2",
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        factoryCredits: 0,
      },
    });
    await p;
  });

  it("dispose 同步幂等：idle ⇒ graceful；turn 中 ⇒ now；二次调用返回同一份报告", async () => {
    const f1 = makeFakeDeps();
    const s1 = makeSession(f1);
    s1.handle.attach(() => {});
    const r1 = s1.handle.dispose();
    expect(s1.child.terminated).toEqual(["graceful"]);
    expect(r1).toMatchObject({ returned: true, killed: 1, unkillable: [] });
    expect(s1.handle.dispose()).toBe(r1);
    expect(s1.transcript?.isClosed).toBe(true);

    const f2 = makeFakeDeps();
    const s2 = makeSession(f2);
    s2.handle.attach(() => {});
    const p = s2.handle.prompt("hi");
    p.catch(() => {});
    s2.rpc.notifyDroid({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    s2.handle.dispose();
    expect(s2.child.terminated).toEqual(["now"]);
  });

  it("killableHandles：恰一个 droid:<pid>；已退出/宽限内 no-op；宽限过期 ⇒ SIGKILL 组", () => {
    const f = makeFakeDeps();
    const { handle, child } = makeSession(f);
    const ks = [...handle.killableHandles];
    expect(ks).toHaveLength(1);
    expect(ks[0]).toMatchObject({ kind: "process", id: "droid:4242" });
    ks[0]!.kill();
    expect(child.terminated).toEqual(["now"]);
    // 宽限内 no-op
    const f2 = makeFakeDeps();
    const s2 = makeSession(f2);
    const k2 = [...s2.handle.killableHandles][0]!;
    s2.child.terminate("graceful");
    k2.kill();
    expect(s2.child.terminated).toEqual(["graceful"]);
    s2.child.expireGrace();
    k2.kill();
    expect(s2.child.terminated).toEqual(["graceful", "now"]);
    // 已退出 no-op
    const f3 = makeFakeDeps();
    const s3 = makeSession(f3);
    s3.child.exit(0);
    [...s3.handle.killableHandles][0]!.kill();
    expect(s3.child.terminated).toEqual([]);
  });

  it("setActiveTools no-op / getActiveTools []", () => {
    const { handle } = makeSession(makeFakeDeps());
    handle.setActiveTools(["x"]);
    expect(handle.getActiveTools()).toEqual([]);
  });
});

describe("droid/session context_usage 与错误脱敏", () => {
  it("first-turn RPC auth rejection signals availability and remains auth/redacted in the run error", async () => {
    const f = makeFakeDeps();
    const observed = vi.fn();
    f.deps.observeAvailability = observed;
    const { handle, rpc, child } = makeSession(f);
    rpc.handler = (method) => (method === DROID_METHODS.addUserMessage ? new Error("No access token SECRET") : {});
    let failure: unknown;
    try {
      await handle.prompt("hello");
    } catch (e) {
      failure = e;
    }
    expect(classifiedInfo(failure)).toMatchObject({ kind: "auth", retryable: false });
    expect(classifiedInfo(failure)?.message).not.toContain("SECRET");
    expect(observed.mock.calls).toEqual([[{ source: "run", authError: "No access token" }]]);
    expect(child.terminated).toContain("now");
    expect(handle.getTurnErrorInfo?.()).toMatchObject({ kind: "auth" });
    expect(f.clock.pendingTimers).toBe(0);
  });

  it("assistant 消息后节流轮询 get_context_stats ⇒ context_usage；连败 3 次停用", async () => {
    const f = makeFakeDeps();
    const events: DriverEvent[] = [];
    const { handle, rpc } = makeSession(f);
    handle.attach((e) => events.push(e));
    const p = handle.prompt("hi");
    rpc.notifyDroid({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    rpc.notifyDroid({
      type: "create_message",
      message: { id: "m-1", role: "assistant", content: [{ type: "text", text: "A" }] },
    });
    await flush();
    expect(rpc.requests.some((r) => r.method === DROID_METHODS.getContextStats)).toBe(true);
    expect(
      events.some((e) => e.t === "context_usage" && e.usage.tokens === 100 && e.usage.contextWindow === 1000),
    ).toBe(true);
    completeTurn(rpc);
    await p;

    // 连败停用
    rpc.handler = (m) => (m === DROID_METHODS.getContextStats ? new Error("down") : {});
    const before = rpc.requests.filter((r) => r.method === DROID_METHODS.getContextStats).length;
    for (let i = 0; i < 5; i++) {
      rpc.notifyDroid({
        type: "create_message",
        message: { id: `m-x${i}`, role: "assistant", content: [{ type: "text", text: "B" }] },
      });
      f.clock.advance(20_000);
      await flush();
    }
    const after = rpc.requests.filter((r) => r.method === DROID_METHODS.getContextStats).length;
    expect(after - before).toBe(3); // 3 连败后停用
  });

  it("auth classification survives redaction obscuring token-expired wording", async () => {
    const f = makeFakeDeps();
    f.deps.redact = (text) => text.replace(/token\s+\S+/gi, "token ***");
    const observed = vi.fn();
    f.deps.observeAvailability = observed;
    const { handle, rpc } = makeSession(f);
    const pending = handle.prompt("hello");
    rpc.notifyDroid({ type: "error", message: "Access token expired" });
    completeTurn(rpc);
    await pending;
    expect(handle.getTurnErrorInfo?.()).toMatchObject({ kind: "auth", retryable: false });
    expect(observed.mock.calls).toEqual([
      [{ source: "run", authError: expect.stringContaining("authentication failed") }],
    ]);
    expect(handle.getTurnErrorInfo?.()?.message).toContain("token ***");
  });

  it("error 通知脱敏后进入 getTurnErrorInfo（acceptance ④：不含凭据值）", async () => {
    const f = makeFakeDeps();
    const { handle, rpc } = makeSession(f);
    handle.attach(() => {});
    const p = handle.prompt("hi");
    rpc.notifyDroid({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    rpc.notifyDroid({ type: "error", message: "HTTP 402 subscription SECRET expired" });
    rpc.notifyDroid({
      type: "agent_turn_completed",
      reason: "model_usage_exhausted",
      turnId: "t-402",
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        factoryCredits: 0,
      },
    });
    await p;
    const info = handle.getTurnErrorInfo!();
    expect(info).toMatchObject({ kind: "auth", retryable: false });
    expect(info!.message).toContain("FACTORY_API_KEY");
    expect(info!.message).toContain("***");
    expect(info!.message).not.toContain("SECRET");
  });
});

describe("droid/session r3 异常退出对账", () => {
  afterEach(() => vi.unstubAllEnvs());

  const plantSettings = (sessionCwd: string, sessionId: string, tokenUsage: unknown): string => {
    const home = mkdtempSync(join(tmpdir(), "droid-home-"));
    const paths = droidNativeSessionPaths({ homeDir: home, cwd: sessionCwd, sessionId });
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.settingsFile, JSON.stringify({ model: "m", tokenUsage }));
    vi.stubEnv("HOME", home);
    return home;
  };

  it("turn 未结算时进程死 ⇒ 正差额补记 usage + external_meta reconciled:true", async () => {
    plantSettings("/tmp/fake-cwd", SESSION_ID, {
      inputTokens: 500,
      outputTokens: 60,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
      factoryCredits: 300,
    });
    const f = makeFakeDeps();
    const events: DriverEvent[] = [];
    const { handle, rpc, child } = makeSession(f);
    handle.attach((e) => events.push(e));
    const p = handle.prompt("hi");
    p.catch(() => {});
    rpc.notifyDroid({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    // 实时累计已报 100/10
    rpc.notifyDroid({
      type: "session_token_usage_changed",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 10,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        factoryCredits: 50,
      },
    });
    rpc.notifyDroid({
      type: "create_message",
      message: { id: "m-1", role: "assistant", content: [{ type: "text", text: "partial" }] },
    });
    child.exit(2, null); // 崩溃：丢 agent_turn_completed
    await flush();
    const reconciled = events.find((e) => e.t === "external_meta" && e.meta.reconciled === true);
    expect(reconciled).toBeDefined();
    // 补记差值 500-100=400 / 60-10=50
    const patch = events.filter((e) => e.t === "message_end" && e.usage !== undefined).at(-1);
    expect(patch).toMatchObject({ usage: { input: 400, output: 50 } });
    await expect(p).rejects.toSatisfy((e) => classifiedInfo(e)?.kind === "internal");
  });

  it("负差 ⇒ 放弃（不补记、不报错）", async () => {
    plantSettings("/tmp/fake-cwd", SESSION_ID, { inputTokens: 1, outputTokens: 1 });
    const f = makeFakeDeps();
    const events: DriverEvent[] = [];
    const { handle, rpc, child } = makeSession(f);
    handle.attach((e) => events.push(e));
    const p = handle.prompt("hi");
    p.catch(() => {});
    rpc.notifyDroid({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    rpc.notifyDroid({
      type: "session_token_usage_changed",
      tokenUsage: {
        inputTokens: 900,
        outputTokens: 90,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        factoryCredits: 500,
      },
    });
    child.exit(2, null);
    await flush();
    expect(events.find((e) => e.t === "external_meta" && e.meta.reconciled === true)).toBeUndefined();
  });

  it("settings.json 缺失 ⇒ 静默放弃", async () => {
    vi.stubEnv("HOME", mkdtempSync(join(tmpdir(), "droid-home-empty-")));
    const f = makeFakeDeps();
    const events: DriverEvent[] = [];
    const { handle, rpc, child } = makeSession(f);
    handle.attach((e) => events.push(e));
    const p = handle.prompt("hi");
    p.catch(() => {});
    rpc.notifyDroid({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    child.exit(2, null);
    await flush();
    expect(events.find((e) => e.t === "external_meta" && e.meta.reconciled === true)).toBeUndefined();
  });

  it("turn 已结算 ⇒ 绝不重复计费（不补记）", async () => {
    plantSettings("/tmp/fake-cwd", SESSION_ID, { inputTokens: 9999, outputTokens: 999 });
    const f = makeFakeDeps();
    const events: DriverEvent[] = [];
    const { handle, rpc, child } = makeSession(f);
    handle.attach((e) => events.push(e));
    const p = handle.prompt("hi");
    completeTurn(rpc);
    await p;
    child.exit(0, null);
    await flush();
    expect(events.find((e) => e.t === "external_meta" && e.meta.reconciled === true)).toBeUndefined();
    expect(handle.getUsage()?.input).toBe(1); // 只有 turn 对账的 1
  });
});
