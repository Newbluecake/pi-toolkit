import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClassifiedError, classifiedInfo } from "../../../src/core/errors.js";
import { DEFAULT_EXTERNAL_AGENTS_SETTINGS } from "../../../src/config/settings.js";
import { createDroidProvider } from "../../../src/external-agent/droid/provider.js";
import { DROID_CHILD_ENV, DROID_EXEC_ARGS, DROID_METHODS } from "../../../src/external-agent/droid/protocol.js";
import { msgBinaryNotFound, msgResumeCwdGone } from "../../../src/external-agent/messages.js";
import { externalSessionPath } from "../../../src/external-agent/paths.js";
import { makeFakeDeps, makeSpec, settingsEcho, standardRpcHandler } from "./fakes.js";

const SETTINGS = { ...DEFAULT_EXTERNAL_AGENTS_SETTINGS.droid, enabled: true };
const SESSION_ID = "12345678-abcd-4321-9876-abcdef012345";
const flush = () => new Promise((r) => setImmediate(r));

function setup(over: { settings?: typeof SETTINGS; agentDir?: string } = {}) {
  const agentDir = over.agentDir ?? mkdtempSync(join(tmpdir(), "droid-agent-"));
  const f = makeFakeDeps(agentDir);
  const provider = createDroidProvider(f.deps, () => over.settings ?? SETTINGS);
  return { f, provider, agentDir };
}

describe("droid/provider create 快乐路径（acceptance ⑤⑪）", () => {
  it("spawn argv/cwd/extraEnv/ownerWatchdog + init/update 参数 + transcript 头行 + observeInit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "droid-cwd-"));
    const { f, provider, agentDir } = setup();
    f.rpcHandler = (m, p) => standardRpcHandler(f.rpcs[0]!)(m, p);
    const handle = await provider.create(makeSpec({ cwd }));
    expect(f.spawnOpts).toHaveLength(1);
    expect(f.spawnOpts[0]).toMatchObject({
      binary: "droid",
      args: DROID_EXEC_ARGS,
      cwd,
      killGraceMs: SETTINGS.killGraceMs,
      ownerWatchdog: false, // DROID_EXITS_ON_STDIN_EOF=true
    });
    expect(f.spawnOpts[0]!.extraEnv).toBe(DROID_CHILD_ENV); // acceptance ⑪：同一常量对象

    const init = f.rpcs[0]!.requests.find((r) => r.method === DROID_METHODS.initializeSession);
    expect(init?.params).toMatchObject({
      machineId: "pi-toolkit",
      cwd,
      modelId: "gpt-6-luna",
      autonomyLevel: "high",
      autoRejectPermissionRequests: false,
    });
    const update = f.rpcs[0]!.requests.find((r) => r.method === DROID_METHODS.updateSessionSettings);
    expect(update?.params).toMatchObject({
      modelId: "gpt-6-luna",
      autonomyLevel: "high",
      autoRejectPermissionRequests: false,
    });

    expect(handle.sessionId).toBe(SESSION_ID);
    expect(f.transcripts).toHaveLength(1);
    expect(f.transcripts[0]!.path).toBe(externalSessionPath(agentDir, "droid", SESSION_ID));
    expect(f.transcripts[0]!.header).toMatchObject({
      type: "external_session",
      provider: "droid",
      sessionId: SESSION_ID,
      cwd,
      modelId: "gpt-6-luna",
      runId: "run-1",
    });
    // observeInit 刷新目录缓存
    expect((f.deps.catalogStore as unknown as { written: unknown[] }).written.length).toBeGreaterThan(0);
    // add_user_message 只在 prompt 时才发
    expect(f.rpcs[0]!.requests.some((r) => r.method === DROID_METHODS.addUserMessage)).toBe(false);
  });

  it("persist=false ⇒ 不建 transcript、sessionFile undefined", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "droid-cwd-"));
    const { f, provider } = setup();
    f.rpcHandler = (m, p) => standardRpcHandler(f.rpcs[0]!)(m, p);
    const handle = await provider.create(makeSpec({ cwd, persist: false }));
    expect(f.transcripts).toHaveLength(0);
    expect(handle.sessionFile).toBeUndefined();
  });

  it("update -32602 Unknown model ⇒ config + 目录候选；terminate(now)；add_user_message 从未发出（S5）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "droid-cwd-"));
    const { f, provider } = setup();
    f.rpcHandler = (m, p) => {
      if (m === DROID_METHODS.updateSessionSettings)
        return new ClassifiedError({
          kind: "internal",
          message: `Unknown model: ${(p as { modelId?: string }).modelId}`,
          retryable: false,
        });
      return standardRpcHandler(f.rpcs[0]!)(m, p);
    };
    await expect(provider.create(makeSpec({ cwd, modelId: "gpt-6-bogus" }))).rejects.toSatisfy((e) => {
      const info = classifiedInfo(e);
      return (
        info?.kind === "config" &&
        info.retryable === false &&
        /unknown droid model "gpt-6-bogus"/.test(info.message) &&
        /gpt-6-luna/.test(info.message) // 目录候选（来自 observeInit）
      );
    });
    expect(f.rpcs[0]!.requests.map((r) => r.method)).toEqual([
      DROID_METHODS.initializeSession,
      DROID_METHODS.updateSessionSettings,
    ]);
    expect(f.children[0]!.terminated).toContain("now");
  });

  it("生效值 autonomy ≠ high ⇒ fail closed（config）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "droid-cwd-"));
    const { f, provider } = setup();
    f.rpcHandler = (m, p) => standardRpcHandler(f.rpcs[0]!, { autonomy: "medium" })(m, p);
    await expect(provider.create(makeSpec({ cwd }))).rejects.toSatisfy(
      (e) => classifiedInfo(e)?.kind === "config" && /autonomyLevel/.test(classifiedInfo(e)!.message),
    );
    expect(f.children[0]!.terminated).toContain("now");
  });

  it("init 静默改模型（S5：echo modelId 不符且 update 也被静默）⇒ fail closed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "droid-cwd-"));
    const { f, provider } = setup();
    f.rpcHandler = (m, p) => {
      if (m === DROID_METHODS.updateSessionSettings) {
        f.rpcs[0]!.notifyDroid(settingsEcho("gpt-6-sol", "high")); // droid 实际生效了别的模型
        return {};
      }
      return standardRpcHandler(f.rpcs[0]!)(m, p);
    };
    await expect(provider.create(makeSpec({ cwd }))).rejects.toSatisfy(
      (e) => classifiedInfo(e)?.kind === "config" && /gpt-6-sol/.test(classifiedInfo(e)!.message),
    );
  });

  it("strict：init 期间入站版本漂移 ⇒ config 致命（acceptance ⑧）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "droid-cwd-"));
    const { f, provider } = setup();
    f.rpcHandler = (m, p) => {
      if (m === DROID_METHODS.initializeSession) f.rpcs[0]!.drift("9.9.9");
      return standardRpcHandler(f.rpcs[0]!)(m, p);
    };
    await expect(provider.create(makeSpec({ cwd }))).rejects.toSatisfy(
      (e) => classifiedInfo(e)?.kind === "config" && /protocol drift/.test(classifiedInfo(e)!.message),
    );
    expect(f.children[0]!.terminated).toContain("now");
  });

  it("warn：漂移继续跑 + warnOnce + degraded protocol_drift 进 attach meta", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "droid-cwd-"));
    const { f, provider } = setup({ settings: { ...SETTINGS, protocolCheck: "warn" } });
    f.rpcHandler = (m, p) => {
      if (m === DROID_METHODS.initializeSession) f.rpcs[0]!.drift("9.9.9");
      return standardRpcHandler(f.rpcs[0]!)(m, p);
    };
    const handle = await provider.create(makeSpec({ cwd }));
    expect(f.warnings.some((w) => /protocol drift/.test(w))).toBe(true);
    const events: { t: string; meta?: { degraded?: readonly string[] } }[] = [];
    handle.attach((e) => events.push(e));
    expect(events[0]).toMatchObject({ t: "external_meta", meta: { degraded: ["protocol_drift"] } });
  });

  it("spawn startup_transient ⇒ 重归类 internal（主会话裁定：runner 无 create 重试循环）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "droid-cwd-"));
    const { f, provider } = setup();
    f.spawnError = new ClassifiedError({ kind: "startup_transient", message: "spawn EAGAIN", retryable: true });
    await expect(provider.create(makeSpec({ cwd }))).rejects.toSatisfy((e) => {
      const info = classifiedInfo(e);
      return info?.kind === "internal" && info.retryable === false && /EAGAIN/.test(info.message);
    });
  });

  it("spawn ENOENT（config）⇒ msgBinaryNotFound 文案", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "droid-cwd-"));
    const { f, provider } = setup();
    f.spawnError = new ClassifiedError({ kind: "config", message: "spawn droid ENOENT", retryable: false });
    await expect(provider.create(makeSpec({ cwd }))).rejects.toSatisfy(
      (e) => classifiedInfo(e)?.kind === "config" && classifiedInfo(e)?.message === msgBinaryNotFound("droid"),
    );
  });
});

describe("droid/provider resume cwd 钉死（acceptance ⑦，S7）", () => {
  const headerFor = (cwd: string) => ({
    type: "external_session" as const,
    version: 1 as const,
    provider: "droid",
    sessionId: SESSION_ID,
    cwd,
    modelId: "gpt-6-luna",
    createdAt: new Date(0).toISOString(),
    roleName: "tester",
    runId: "run-0",
  });

  it("头行 cwd 存在 ⇒ spawn cwd 与 init 参数 cwd 都等于头行 cwd（spec.cwd 故意不同）", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "droid-cwd-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "droid-cwd-b-"));
    const { f, provider, agentDir } = setup();
    f.readHeader = () => headerFor(dirA);
    f.rpcHandler = (m, p) => standardRpcHandler(f.rpcs[0]!)(m, p);
    const file = externalSessionPath(agentDir, "droid", SESSION_ID);
    const handle = await provider.resume(file, makeSpec({ cwd: dirB, resume: true }));
    expect(f.spawnOpts[0]!.cwd).toBe(dirA);
    const init = f.rpcs[0]!.requests.find((r) => r.method === DROID_METHODS.initializeSession);
    expect(init?.params).toMatchObject({ cwd: dirA, sessionId: SESSION_ID });
    // transcript resume 模式 + 追加 subagent:external-resume
    expect(f.transcripts[0]!.resume).toBe(true);
    expect(f.transcripts[0]!.path).toBe(file);
    expect(f.transcripts[0]!.appended.some((e) => e.customType === "subagent:external-resume")).toBe(true);
    expect(handle.sessionId).toBe(SESSION_ID);
  });

  it("头行缺失/非 droid ⇒ config 拒绝且不起进程", async () => {
    const { f, provider } = setup();
    f.readHeader = () => undefined;
    await expect(provider.resume("/tmp/whatever.jsonl", makeSpec({ resume: true }))).rejects.toSatisfy(
      (e) =>
        classifiedInfo(e)?.kind === "config" &&
        /not a droid external-agent session file/.test(classifiedInfo(e)!.message),
    );
    expect(f.spawnOpts).toHaveLength(0);
  });

  it("头行 cwd 已不存在 ⇒ reject config（msgResumeCwdGone）且 spawnChild 未被调用", async () => {
    const gone = join(tmpdir(), "droid-cwd-gone-" + Math.random().toString(36).slice(2));
    const { f, provider } = setup();
    f.readHeader = () => headerFor(gone);
    await expect(provider.resume("/tmp/whatever.jsonl", makeSpec({ resume: true }))).rejects.toSatisfy(
      (e) => classifiedInfo(e)?.kind === "config" && classifiedInfo(e)?.message === msgResumeCwdGone(gone),
    );
    expect(f.spawnOpts).toHaveLength(0);
  });
});

describe("droid/provider ownsSessionFile 与 dispose", () => {
  it("路径前缀 + 头行 provider 双判定", () => {
    const { f, provider, agentDir } = setup();
    const file = externalSessionPath(agentDir, "droid", SESSION_ID);
    f.readHeader = (p) =>
      p === file
        ? {
            type: "external_session",
            version: 1,
            provider: "droid",
            sessionId: SESSION_ID,
            cwd: "/x",
            modelId: "m",
            createdAt: "",
            roleName: "r",
            runId: "r",
          }
        : undefined;
    expect(provider.ownsSessionFile(file)).toBe(true);
    expect(provider.ownsSessionFile("/other/place.jsonl")).toBe(false);
    expect(
      provider.ownsSessionFile(externalSessionPath(agentDir, "droid", "abcdefgh-9999-aaaa-bbbb-ccccddddeeee")),
    ).toBe(false);
  });

  it("dispose 幂等，不杀运行中的 run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "droid-cwd-"));
    const { f, provider } = setup();
    f.rpcHandler = (m, p) => standardRpcHandler(f.rpcs[0]!)(m, p);
    await provider.create(makeSpec({ cwd }));
    provider.dispose();
    provider.dispose();
    expect(f.children[0]!.terminated).toHaveLength(0);
  });
});

describe("droid/provider prompt 驱动（端到端假链路）", () => {
  it("create → attach → prompt → 罐头 turn 完成 → usage/lastAssistantText", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "droid-cwd-"));
    const { f, provider } = setup();
    f.rpcHandler = (m, p) => standardRpcHandler(f.rpcs[0]!)(m, p);
    const handle = await provider.create(makeSpec({ cwd }));
    const events: { t: string }[] = [];
    handle.attach((e) => events.push(e));
    const p = handle.prompt("say hi");
    const rpc = f.rpcs[0]!;
    rpc.notifyDroid({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    rpc.notifyDroid({ type: "assistant_text_delta", messageId: "m-1", blockIndex: 0, textDelta: "HI" });
    rpc.notifyDroid({
      type: "create_message",
      message: { id: "m-1", role: "assistant", content: [{ type: "text", text: "HI" }] },
    });
    rpc.notifyDroid({
      type: "agent_turn_completed",
      reason: "completed",
      turnId: "t-1",
      tokenUsage: {
        inputTokens: 3,
        outputTokens: 2,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        factoryCredits: 5,
      },
    });
    await p;
    await flush();
    expect(handle.getLastAssistantText()).toBe("HI");
    expect(handle.getUsage()?.input).toBe(3);
    expect(events[0]!.t).toBe("external_meta");
    expect(events.some((e) => e.t === "settled")).toBe(true);
  });
});

describe("droid/provider init/update 阶段进程早退 + echo 等待回落（§15 跟踪项，P5）", () => {
  it("init 期间进程早退 ⇒ 立即 failAll（internal），不等 initTimeoutMs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "droid-cwd-"));
    const { f, provider } = setup();
    f.rpcHandler = undefined; // init 请求永悬（fake-droid exit-during-init 同构）
    const created = provider.create(makeSpec({ cwd }));
    const observed = created.catch((e: unknown) => e); // 立即挂 handler，避免 unhandled rejection
    const child = f.children[0]!;
    await flush();
    child.exit(3, null); // §15：提前死亡
    await flush();
    expect(f.rpcs[0]!.failAllCalls).toHaveLength(1);
    const info = classifiedInfo(f.rpcs[0]!.failAllCalls[0]);
    expect(info?.kind).toBe("internal");
    expect(info?.retryable).toBe(false);
    expect(info?.message).toContain("exited unexpectedly during session setup");
    await expect(created).rejects.toMatchObject({ message: expect.stringContaining("setup") });
    expect((await observed) instanceof Error).toBe(true);
    expect(child.terminated).toContain("now"); // failSpawned 收口组杀
  });

  it("update 后无全量 echo ⇒ requestTimeoutMs 超时回落最新 echo（init result.settings）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "droid-cwd-"));
    const { f, provider } = setup();
    // init 应答带全量 settings（不通知）；update 应答 {} 但**不**发 settings_updated。
    f.rpcHandler = (method) => {
      if (method === DROID_METHODS.initializeSession)
        return {
          sessionId: SESSION_ID,
          hostId: "h",
          session: { messages: [] },
          settings: { modelId: "gpt-6-luna", reasoningEffort: "low", autonomyLevel: "high" },
          availableModels: [],
        };
      if (method === DROID_METHODS.updateSessionSettings) return {};
      if (method === DROID_METHODS.closeSession) return {};
      return {};
    };
    const created = provider.create(makeSpec({ cwd }));
    await flush();
    // echo 等待挂在 requestTimeoutMs 计时器上；到点前未决。
    f.clock.advance(SETTINGS.requestTimeoutMs - 1);
    await flush();
    // 到点 ⇒ 回落 init echo，生效值校验通过，create 完成。
    f.clock.advance(1);
    const handle = await created;
    expect(handle.sessionId).toBe(SESSION_ID);
    expect(f.children[0]!.terminated).toHaveLength(0); // 未因此收口
  });
});
