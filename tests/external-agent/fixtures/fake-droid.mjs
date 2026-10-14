#!/usr/bin/env node
/**
 * fake-droid — external-agent plan §7.2 的可编程假 droid（`droid exec --input-format stream-jsonrpc
 * --output-format stream-jsonrpc` 形状）。离线：不起真 droid、不碰 Factory API。
 *
 * 协议面（droid-protocol.md §13 实测形状）：
 * - 出站帧恒带 type + factoryApiVersion:"1.0.0" + factoryProtocolVersion:"1.264.0"（drift 模式改 9.9.9）。
 * - initialize_session：settings_updated 全量 echo 先于响应；响应带 sessionId/settings/availableModels。
 * - update_session_settings：成功 ⇒ 先部分 echo 再全量 echo，响应 `{}`；--mode unknown-model-on-update
 *   ⇒ `-32602 "Unknown model: <id>"`（S5）。
 * - add_user_message：响应 `{}` 后跑一个罐头 turn（working_state → 用量基线（S10）→ 增量 →
 *   assistant 增量/create_message → agent_turn_completed completed → idle）。
 * - interrupt_session：turn 活跃 ⇒ 响应 + tool_result cancelled（发两次，S/27 实测重复）+
 *   agent_turn_completed cancelled + idle。
 * - droid.request_permission（permission-request 模式）：严格模拟 S2——未收到带
 *   result.selectedOption 的应答就永久等待；收到后发 permission_resolved 再继续。
 *
 * 用法：node fake-droid.mjs [--mode <name>] [--script <jsonl>] [--delay-ms <n>]
 *         [--ignore-sigterm] [--no-exit-on-eof]
 * 模式（§7.2 全清单；也可用同名独立 flag）：default(无) / hang-after-init / no-first-event /
 *   silent-turn / half-line / crash-mid-turn / ignore-interrupt / ignore-sigterm /
 *   no-exit-on-eof / drift / envelope-reject / permission-request / permission-no-ack /
 *   ask-user-request / http-402 / stdout-garbage / spawn-grandchild / slow-init / usage-script /
 *   echo-cwd / unknown-model-on-update
 * --self-test：派生自身跑模式矩阵断言（离线），全过 exit 0。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const PROTO = "1.264.0";
const API = "1.0.0";

const FAKE_MODELS = [
  {
    id: "gpt-6-luna",
    modelId: "gpt-6-luna",
    modelProvider: "openai",
    displayName: "GPT-6 Luna",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
    deprecated: false,
    tokenMultiplier: 0.04,
  },
  {
    id: "claude-sonnet-5",
    modelId: "claude-sonnet-5",
    modelProvider: "anthropic",
    displayName: "Sonnet 5",
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "high",
    deprecated: false,
    tokenMultiplier: 0.8,
  },
  {
    id: "kimi-k3",
    modelId: "kimi-k3",
    modelProvider: "factory",
    displayName: "Kimi K3",
    supportedReasoningEfforts: ["off", "low", "high", "max"],
    defaultReasoningEffort: "high",
    deprecated: false,
    tokenMultiplier: 1.2,
  },
  {
    id: "auto",
    modelId: "auto",
    kind: "router",
    modelProvider: "factory",
    displayName: "Auto Model",
    supportedReasoningEfforts: ["none"],
    defaultReasoningEffort: "none",
    deprecated: false,
    tokenMultiplier: 1,
  },
  {
    id: "old-model-1",
    modelId: "old-model-1",
    modelProvider: "factory",
    displayName: "Old Model [Deprecated]",
    supportedReasoningEfforts: ["high"],
    defaultReasoningEffort: "high",
    deprecated: true,
    tokenMultiplier: 0.5,
  },
];

function parseArgs(argv) {
  const o = {
    mode: "default",
    script: undefined,
    delayMs: 0,
    ignoreSigterm: false,
    noExitOnEof: false,
    selfTest: false,
  };
  const args = [...argv];
  while (args.length > 0) {
    const a = args.shift();
    if (a === "--self-test") o.selfTest = true;
    else if (a === "--mode") o.mode = args.shift();
    else if (a === "--script") o.script = args.shift();
    else if (a === "--delay-ms") o.delayMs = Number(args.shift() ?? 0);
    else if (a === "--ignore-sigterm") o.ignoreSigterm = true;
    else if (a === "--no-exit-on-eof") o.noExitOnEof = true;
    else if (a === "exec" || a === "--input-format" || a === "--output-format") {
      if (a.startsWith("--")) args.shift(); // 吃掉格式参数的值
    } else if (a !== undefined) o.mode = a; // 容错：裸模式名
  }
  if (o.mode === "ignore-sigterm") o.ignoreSigterm = true;
  if (o.mode === "no-exit-on-eof") o.noExitOnEof = true;
  return o;
}

function runFake(o) {
  const proto = o.mode === "drift" ? "9.9.9" : PROTO;
  const envelope = { jsonrpc: "2.0", factoryApiVersion: API, factoryProtocolVersion: proto };
  const send = (frame) => process.stdout.write(JSON.stringify({ ...envelope, ...frame }) + "\n");
  const respond = (id, result) => send({ type: "response", id, result });
  const respondError = (id, code, message) => send({ type: "response", id, error: { code, message } });

  let sessionId;
  const settings = {
    modelId: "gpt-6-luna",
    reasoningEffort: "low",
    autonomyLevel: "medium",
    autonomyMode: "auto-medium",
  };
  const fullEcho = () => ({
    modelId: settings.modelId,
    reasoningEffort: settings.reasoningEffort,
    autonomyMode: settings.autonomyMode,
    interactionMode: "auto",
    autonomyLevel: settings.autonomyLevel,
    availableAutonomyLevels: ["off", "low", "medium", "high"],
  });
  const notify = (notification) =>
    send({ type: "notification", method: "droid.session_notification", params: { sessionId, notification } });
  const working = (newState) => notify({ type: "droid_working_state_changed", newState });

  const zero = () => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    factoryCredits: 0,
  });
  const cum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, credits: 0 };
  const cumFrame = () => ({
    inputTokens: cum.input,
    outputTokens: cum.output,
    cacheCreationTokens: cum.cacheWrite,
    cacheReadTokens: cum.cacheRead,
    thinkingTokens: cum.thinking,
    factoryCredits: cum.credits,
  });
  const usageChanged = () =>
    notify({
      type: "session_token_usage_changed",
      sessionId,
      tokenUsage: cumFrame(),
      inclusiveTokenUsage: cumFrame(),
      lastCallTokenUsage: { inputTokens: cum.input, outputTokens: cum.output, cacheReadTokens: cum.cacheRead },
    });
  const bump = (d) => {
    cum.input += d.input;
    cum.output += d.output;
    cum.cacheRead += d.cacheRead;
    cum.cacheWrite += d.cacheWrite;
    cum.thinking += d.thinking;
    cum.credits += d.credits;
  };

  let turnActive = false;
  let activeToolUseId;
  let pendingPermission; // { id, toolUseIds }
  let scriptLines;
  if (o.script !== undefined)
    scriptLines = readFileSync(o.script, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));

  const replayScript = async () => {
    for (const line of scriptLines ?? []) {
      if (typeof line.delayMs === "number") await new Promise((r) => setTimeout(r, line.delayMs));
      else if (line.notify !== undefined) notify(line.notify);
      else if (line.frame !== undefined) send(line.frame);
    }
  };

  const finishTurn = (reason, turnDelta) => {
    notify({
      type: "agent_turn_completed",
      reason,
      turnId: randomUUID(),
      tokenUsage: turnDelta,
      cumulativeTokenUsage: cumFrame(),
      childTokenUsage: zero(),
      cumulativeChildTokenUsage: zero(),
      durationMs: 5,
    });
    turnActive = false;
    working("idle");
  };

  const cannedTurn = (text) => {
    const turnId = randomUUID();
    turnActive = true;
    working("streaming_assistant_message");
    notify({
      type: "create_message",
      message: { id: turnId, role: "user", content: [{ type: "text", text }], createdAt: Date.now() },
    });
    working("thinking");
    usageChanged(); // S10：新 turn 首条 = 基线（上一时刻累计）
    const delta = { input: 120, output: 12, cacheRead: 0, cacheWrite: 500, thinking: 0, credits: 42 };
    bump(delta);
    usageChanged();
    const msgId = randomUUID();
    notify({ type: "assistant_text_delta", messageId: msgId, blockIndex: 0, textDelta: "DONE" });
    notify({ type: "assistant_text_complete", messageId: msgId, blockIndex: 0 });
    notify({
      type: "create_message",
      message: {
        id: msgId,
        role: "assistant",
        content: [{ type: "text", text: "DONE" }],
        createdAt: Date.now(),
        modelId: settings.modelId,
      },
    });
    finishTurn("completed", {
      inputTokens: delta.input,
      outputTokens: delta.output,
      cacheCreationTokens: delta.cacheWrite,
      cacheReadTokens: delta.cacheRead,
      thinkingTokens: delta.thinking,
      factoryCredits: delta.credits,
    });
  };

  const usageScriptTurn = () => {
    turnActive = true;
    working("streaming_assistant_message");
    working("thinking");
    usageChanged(); // 基线
    bump({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0, thinking: 0, credits: 50 });
    usageChanged();
    bump({ input: 150, output: 20, cacheRead: 600, cacheWrite: 0, thinking: 0, credits: 130 });
    usageChanged();
    const msgId = randomUUID();
    notify({ type: "assistant_text_delta", messageId: msgId, blockIndex: 0, textDelta: "DONE" });
    notify({
      type: "create_message",
      message: { id: msgId, role: "assistant", content: [{ type: "text", text: "DONE" }] },
    });
    notify({
      type: "agent_turn_completed",
      reason: "completed",
      turnId: randomUUID(),
      tokenUsage: {
        inputTokens: 250,
        outputTokens: 30,
        cacheCreationTokens: 0,
        cacheReadTokens: 600,
        thinkingTokens: 0,
        factoryCredits: 180,
      },
      cumulativeTokenUsage: cumFrame(),
      childTokenUsage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        factoryCredits: 5,
      },
      cumulativeChildTokenUsage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        factoryCredits: 5,
      },
      durationMs: 5,
    });
    turnActive = false;
    working("idle");
  };

  const toolTurn = () => {
    // permission-request / permission-no-ack：S/44 同构——tool_call 渐进 → 等权限应答。
    turnActive = true;
    activeToolUseId = "call_" + randomUUID().replaceAll("-", "").slice(0, 24);
    working("streaming_assistant_message");
    working("thinking");
    notify({ type: "tool_call", toolUse: { type: "tool_use", id: activeToolUseId, name: "Execute", input: {} } });
    notify({
      type: "tool_call",
      toolUse: {
        type: "tool_use",
        id: activeToolUseId,
        name: "Execute",
        input: { command: "printf x > marker.txt", riskLevel: "medium" },
      },
    });
    working("executing_tool");
    notify({ type: "tool_execution_phase_changed", toolUseId: activeToolUseId, toolName: "Execute", phase: "queued" });
    working("waiting_for_tool_confirmation");
    const reqId = randomUUID();
    pendingPermission = { id: reqId, toolUseIds: [activeToolUseId] };
    send({
      type: "request",
      id: reqId,
      method: "droid.request_permission",
      params: {
        toolUses: [
          {
            toolUse: {
              type: "tool_use",
              id: activeToolUseId,
              name: "Execute",
              input: { command: "printf x > marker.txt", riskLevel: "medium" },
            },
            confirmationType: "exec",
            details: { type: "exec", fullCommand: "printf x > marker.txt", command: "printf" },
          },
        ],
        options: [
          { label: "Proceed once", value: "proceed_once" },
          { label: "Cancel", value: "cancel" },
        ],
      },
    });
    // S2：未收到带 selectedOption 的应答 ⇒ 永久等待（无定时器）。
  };

  const onPermissionReply = (frame) => {
    if (pendingPermission === undefined || frame.id !== pendingPermission.id) return;
    const selected = frame.result?.selectedOption;
    if (typeof selected !== "string") return; // 形状不对 ⇒ 继续永久等待（S2）
    if (o.mode === "permission-no-ack") return; // 收到应答也不发 permission_resolved
    const reqId = pendingPermission.id;
    const toolUseIds = pendingPermission.toolUseIds;
    pendingPermission = undefined;
    working("executing_tool");
    notify({ type: "permission_resolved", requestId: reqId, toolUseIds, selectedOption: selected });
    notify({
      type: "tool_execution_phase_changed",
      toolUseId: activeToolUseId,
      toolName: "Execute",
      phase: "executing",
    });
    notify({
      type: "tool_result",
      toolUseId: activeToolUseId,
      messageId: randomUUID(),
      content: "Command completed successfully\n\n[Process exited with code 0]",
      isError: false,
    });
    const msgId = randomUUID();
    notify({ type: "assistant_text_delta", messageId: msgId, blockIndex: 0, textDelta: "DONE" });
    notify({
      type: "create_message",
      message: { id: msgId, role: "assistant", content: [{ type: "text", text: "DONE" }] },
    });
    finishTurn("completed", { ...zero(), inputTokens: 10, outputTokens: 4, factoryCredits: 7 });
  };

  const onAddUserMessage = (id, text) => {
    if (o.mode === "no-first-event") return; // 连响应都不回
    respond(id, {});
    switch (o.mode) {
      case "hang-after-init":
        return; // 响应了但零通知（no_first_event 超时场景）
      case "silent-turn":
        turnActive = true;
        working("streaming_assistant_message"); // 开了 turn 后沉默（idle 超时场景）
        return;
      case "half-line":
        process.stdout.write('{"jsonrpc":"2.0","type":"notification","factoryApi'); // 半行，无换行
        return;
      case "crash-mid-turn":
        turnActive = true;
        working("streaming_assistant_message");
        working("thinking");
        process.exit(2);
        return;
      case "permission-request":
      case "permission-no-ack":
        toolTurn();
        return;
      case "ask-user-request": {
        turnActive = true;
        working("streaming_assistant_message");
        send({
          type: "request",
          id: randomUUID(),
          method: "droid.ask_user",
          params: { questions: [{ question: "pick one", options: ["a", "b"] }] },
        });
        // E5：无论应答是 -32601 还是别的，都有界地完成 turn。
        const msgId = randomUUID();
        notify({ type: "assistant_text_delta", messageId: msgId, blockIndex: 0, textDelta: "DONE" });
        notify({
          type: "create_message",
          message: { id: msgId, role: "assistant", content: [{ type: "text", text: "DONE" }] },
        });
        finishTurn("completed", { ...zero(), inputTokens: 8, outputTokens: 2, factoryCredits: 3 });
        return;
      }
      case "http-402":
        turnActive = true;
        working("streaming_assistant_message");
        working("thinking");
        notify({
          type: "error",
          message:
            '402 {"detail":"Organization does not have an active paid subscription","status":402,"title":"Payment Required","requestId":"fake::1"}',
          errorType: "Error",
          timestamp: new Date().toISOString(),
        });
        finishTurn("model_usage_exhausted", zero());
        return;
      case "stdout-garbage":
        process.stdout.write("this is not json at all\n");
        process.stdout.write("neither is this\n");
        cannedTurn(text);
        return;
      case "usage-script":
        usageScriptTurn();
        return;
      default:
        if (scriptLines !== undefined) {
          turnActive = true;
          void replayScript();
          return;
        }
        cannedTurn(text);
    }
  };

  const onRequest = (frame) => {
    if (o.mode === "envelope-reject") {
      // S/43 ④：信封被拒形状（id:null -32700），对一切请求。
      send({ type: "response", id: null, error: { code: -32700, message: "Invalid JSON-RPC message" } });
      return;
    }
    const { id, method, params } = frame;
    switch (method) {
      case "droid.initialize_session": {
        const doInit = () => {
          sessionId = typeof params?.sessionId === "string" ? params.sessionId : randomUUID();
          if (typeof params?.modelId === "string") settings.modelId = params.modelId;
          if (typeof params?.reasoningEffort === "string") settings.reasoningEffort = params.reasoningEffort;
          if (typeof params?.autonomyLevel === "string") {
            settings.autonomyLevel = params.autonomyLevel;
            settings.autonomyMode = `auto-${params.autonomyLevel}`;
          }
          notify({ type: "settings_updated", settings: fullEcho() });
          const result = {
            sessionId,
            hostId: "fake-host",
            session: { messages: [] },
            settings: fullEcho(),
            availableModels: FAKE_MODELS,
          };
          if (o.mode === "echo-cwd") result.echo = { processCwd: process.cwd(), initCwd: params?.cwd };
          respond(id, result);
        };
        if (o.mode === "slow-init") setTimeout(doInit, o.delayMs > 0 ? o.delayMs : 1500);
        else doInit();
        return;
      }
      case "droid.update_session_settings": {
        if (o.mode === "unknown-model-on-update" && typeof params?.modelId === "string") {
          respondError(id, -32602, `Unknown model: ${params.modelId}`);
          return;
        }
        const partial = {};
        if (typeof params?.modelId === "string") {
          settings.modelId = params.modelId;
          partial.modelId = params.modelId;
        }
        if (typeof params?.reasoningEffort === "string") {
          settings.reasoningEffort = params.reasoningEffort;
          partial.reasoningEffort = params.reasoningEffort;
        }
        if (typeof params?.autonomyLevel === "string") {
          settings.autonomyLevel = params.autonomyLevel;
          settings.autonomyMode = `auto-${params.autonomyLevel}`;
          partial.autonomyLevel = params.autonomyLevel;
        }
        notify({ type: "settings_updated", settings: partial }); // S/47：先部分 echo
        notify({ type: "settings_updated", settings: fullEcho() }); // 再全量 echo
        respond(id, {});
        return;
      }
      case "droid.add_user_message":
        onAddUserMessage(id, typeof params?.text === "string" ? params.text : "");
        return;
      case "droid.interrupt_session": {
        respond(id, {});
        if (o.mode === "ignore-interrupt" || o.mode === "silent-turn") return; // 不应答协议层结算
        if (!turnActive) return;
        if (activeToolUseId !== undefined) {
          const cancelled = {
            type: "tool_result",
            toolUseId: activeToolUseId,
            messageId: randomUUID(),
            content: "Error: Tool execution cancelled by user",
            isError: true,
          };
          notify(cancelled);
          notify(cancelled); // S/27 实测：interrupt 的 tool_result 重复发两次
          activeToolUseId = undefined;
        }
        finishTurn("cancelled", zero());
        return;
      }
      case "droid.get_context_stats":
        respond(id, {
          used: 1024,
          remaining: 920576,
          limit: 921600,
          accuracy: "estimated",
          updatedAt: new Date().toISOString(),
        });
        return;
      case "droid.close_session":
        respond(id, {});
        return;
      default:
        respondError(id, -32601, `unknown method ${String(method)}`);
    }
  };

  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim().length === 0) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (frame?.type === "response") onPermissionReply(frame);
      else if (typeof frame?.method === "string") onRequest(frame);
    }
  });
  process.stdin.on("end", () => {
    if (o.noExitOnEof) return; // S3 对照组：EOF 不退
    setTimeout(() => process.exit(0), 50).unref?.();
  });
  if (o.ignoreSigterm) process.on("SIGTERM", () => {});
  if (o.mode === "spawn-grandchild") {
    // 同进程组（不 detached）孙进程：组杀测试的活靶。
    const g = spawn("sleep", ["300"], { stdio: "ignore" });
    g.unref();
    process.once("exit", () => {
      try {
        process.kill(g.pid, "SIGKILL");
      } catch {}
    });
  }
}

// ── --self-test：派生自身跑模式矩阵（离线，不起真 droid） ──
async function selfTest() {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const file = new URL(import.meta.url).pathname;

  const drive = (args, script, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [file, ...args], { stdio: ["pipe", "pipe", "pipe"], cwd: opts.cwd });
      const frames = [];
      let buf = "";
      let settled = false;
      const timeout = setTimeout(() => finish(new Error("drive timeout")), opts.timeoutMs ?? 4000);
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.kill("SIGKILL");
        if (err) reject(err);
        else resolve({ frames, child });
      };
      child.stdout.on("data", (c) => {
        if (opts.raw) {
          opts.raw(c);
          return;
        }
        buf += c.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try {
            frames.push(JSON.parse(line));
          } catch {}
        }
        if (opts.until !== undefined && frames.some(opts.until)) finish();
      });
      child.on("exit", () => finish());
      const write = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
      const run = async () => {
        try {
          await script({ write, frames, child, finish });
        } catch (e) {
          finish(e);
        }
      };
      void run();
    });

  const INIT = {
    jsonrpc: "2.0",
    type: "request",
    factoryApiVersion: API,
    factoryProtocolVersion: PROTO,
    id: "1",
    method: "droid.initialize_session",
    params: {
      machineId: "selftest",
      cwd: process.cwd(),
      modelId: "gpt-6-luna",
      autonomyLevel: "high",
      autoRejectPermissionRequests: false,
    },
  };
  const UPDATE = {
    ...INIT,
    id: "2",
    method: "droid.update_session_settings",
    params: { modelId: "gpt-6-luna", autonomyLevel: "high", autoRejectPermissionRequests: false },
  };
  const PROMPT = { ...INIT, id: "3", method: "droid.add_user_message", params: { text: "hi" } };
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push(`ok ${name}`);
    } catch (e) {
      results.push(`FAIL ${name}: ${e.message}`);
    }
  };
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const isTurnDone = (f) => f.params?.notification?.type === "agent_turn_completed";

  await check("default full turn", async () => {
    const { frames } = await drive(
      [],
      async ({ write }) => {
        write(INIT);
        write(UPDATE);
        write(PROMPT);
      },
      { until: isTurnDone },
    );
    const init = frames.find((f) => f.id === "1");
    assert(init?.result?.sessionId, "init sessionId");
    assert(Array.isArray(init.result.availableModels) && init.result.availableModels.length >= 3, "availableModels");
    assert(frames.find((f) => f.id === "2")?.result !== undefined, "update ok");
    const done = frames.find(isTurnDone);
    assert(done.params.notification.reason === "completed", "completed reason");
    assert(
      frames.some((f) => f.params?.notification?.type === "settings_updated"),
      "settings_updated",
    );
    assert(
      frames.every((f) => f.factoryProtocolVersion === PROTO),
      "envelope version",
    );
  });

  await check("unknown-model-on-update", async () => {
    const { frames } = await drive(
      ["--mode", "unknown-model-on-update"],
      async ({ write }) => {
        write(INIT);
        write(UPDATE);
      },
      { until: (f) => f.id === "2" },
    );
    const upd = frames.find((f) => f.id === "2");
    assert(upd.error?.code === -32602 && /Unknown model: gpt-6-luna/.test(upd.error.message), "-32602");
  });

  await check("permission-request approve", async () => {
    const { frames } = await drive(
      ["--mode", "permission-request"],
      async ({ write, frames }) => {
        write(INIT);
        write(UPDATE);
        write(PROMPT);
        // 等权限请求到达后回 proceed_once
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          const req = frames.find((f) => f.type === "request" && f.method === "droid.request_permission");
          if (req) {
            write({
              jsonrpc: "2.0",
              type: "response",
              factoryApiVersion: API,
              factoryProtocolVersion: PROTO,
              id: req.id,
              result: { selectedOption: "proceed_once" },
            });
            return;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("no permission request");
      },
      { until: isTurnDone },
    );
    const resolved = frames.find((f) => f.params?.notification?.type === "permission_resolved");
    assert(resolved?.params?.notification?.selectedOption === "proceed_once", "permission_resolved");
    assert(frames.find(isTurnDone).params.notification.reason === "completed", "completed after approval");
  });

  await check("permission-no-ack hangs", async () => {
    let sawResolved = false;
    await drive(
      ["--mode", "permission-no-ack"],
      async ({ write, frames, finish }) => {
        write(INIT);
        write(UPDATE);
        write(PROMPT);
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline) {
          const req = frames.find((f) => f.type === "request" && f.method === "droid.request_permission");
          if (req && !write.done) {
            write.done = true;
            write({
              jsonrpc: "2.0",
              type: "response",
              factoryApiVersion: API,
              factoryProtocolVersion: PROTO,
              id: req.id,
              result: { selectedOption: "proceed_once" },
            });
          }
          if (frames.some((f) => f.params?.notification?.type === "permission_resolved")) sawResolved = true;
          await new Promise((r) => setTimeout(r, 10));
        }
        finish();
      },
      { timeoutMs: 3000 },
    );
    assert(!sawResolved, "must never resolve permission");
  });

  await check("http-402", async () => {
    const { frames } = await drive(
      ["--mode", "http-402"],
      async ({ write }) => {
        write(INIT);
        write(UPDATE);
        write(PROMPT);
      },
      { until: isTurnDone },
    );
    const err = frames.find((f) => f.params?.notification?.type === "error");
    assert(/\b402\b/.test(err?.params?.notification?.message ?? ""), "402 error notification");
    assert(frames.find(isTurnDone).params.notification.reason === "model_usage_exhausted", "usage_exhausted");
  });

  await check("drift", async () => {
    const { frames } = await drive(["--mode", "drift"], async ({ write }) => write(INIT), {
      until: (f) => f.id === "1",
    });
    assert(
      frames.every((f) => f.factoryProtocolVersion === "9.9.9"),
      "drift version",
    );
  });

  await check("envelope-reject", async () => {
    const { frames } = await drive(["--mode", "envelope-reject"], async ({ write }) => write(INIT), {
      until: (f) => f.type === "response",
    });
    assert(frames[0]?.id === null && frames[0]?.error?.code === -32700, "-32700 id null");
  });

  await check("echo-cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-droid-cwd-"));
    const { frames } = await drive(["--mode", "echo-cwd"], async ({ write }) => write(INIT), {
      until: (f) => f.id === "1",
      cwd: dir,
    });
    const echo = frames.find((f) => f.id === "1")?.result?.echo;
    assert(echo?.processCwd === dir && echo?.initCwd === INIT.params.cwd, `echo cwd ${JSON.stringify(echo)}`);
  });

  await check("ask-user-request", async () => {
    const { frames } = await drive(
      ["--mode", "ask-user-request"],
      async ({ write, frames }) => {
        write(INIT);
        write(UPDATE);
        write(PROMPT);
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          const req = frames.find((f) => f.type === "request" && f.method === "droid.ask_user");
          if (req) {
            write({
              jsonrpc: "2.0",
              type: "response",
              factoryApiVersion: API,
              factoryProtocolVersion: PROTO,
              id: req.id,
              error: { code: -32601, message: "not supported by pi-toolkit host" },
            });
            return;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("no ask_user request");
      },
      { until: isTurnDone },
    );
    assert(frames.find(isTurnDone).params.notification.reason === "completed", "completed after -32601");
  });

  await check("crash-mid-turn", async () => {
    const { child } = await drive(["--mode", "crash-mid-turn"], async ({ write }) => {
      write(INIT);
      write(UPDATE);
      write(PROMPT);
    });
    assert(child.exitCode === 2, `exit code ${child.exitCode}`);
  });

  await check("script replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-droid-script-"));
    const scriptPath = join(dir, "s.jsonl");
    writeFileSync(
      scriptPath,
      JSON.stringify({ delayMs: 20 }) +
        "\n" +
        JSON.stringify({ notify: { type: "droid_working_state_changed", newState: "thinking" } }) +
        "\n" +
        JSON.stringify({
          notify: {
            type: "agent_turn_completed",
            reason: "completed",
            turnId: "t1",
            tokenUsage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              thinkingTokens: 0,
              factoryCredits: 1,
            },
            cumulativeTokenUsage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              thinkingTokens: 0,
              factoryCredits: 1,
            },
          },
        }) +
        "\n",
    );
    const { frames } = await drive(
      ["--script", scriptPath],
      async ({ write }) => {
        write(INIT);
        write(UPDATE);
        write(PROMPT);
      },
      { until: isTurnDone },
    );
    assert(
      frames.some((f) => f.params?.notification?.type === "droid_working_state_changed"),
      "script notify",
    );
  });

  await check("silent modes produce no events", async () => {
    for (const mode of ["hang-after-init", "silent-turn"]) {
      const { frames } = await drive(["--mode", mode], async ({ write, frames, finish }) => {
        write(INIT);
        write(UPDATE);
        write(PROMPT);
        setTimeout(() => finish(), 400);
      });
      const events = frames.filter(
        (f) => f.type === "notification" && f.params?.notification?.type === "droid_working_state_changed",
      );
      assert(events.length <= (mode === "silent-turn" ? 1 : 0), `${mode} events`);
    }
  });

  await check("half-line stays unterminated", async () => {
    let raw = "";
    await drive(
      ["--mode", "half-line"],
      async ({ write, finish }) => {
        write(INIT);
        write(UPDATE);
        write(PROMPT);
        setTimeout(() => finish(), 400);
      },
      { raw: (c) => (raw += c.toString()) },
    );
    const lastLine =
      raw
        .split("\n")
        .filter((l) => l.length > 0)
        .at(-1) ?? "";
    assert(lastLine.startsWith("{") && !lastLine.endsWith("}"), "last line is a partial frame");
  });

  await check("usage-script carries child usage", async () => {
    const { frames } = await drive(
      ["--mode", "usage-script"],
      async ({ write }) => {
        write(INIT);
        write(UPDATE);
        write(PROMPT);
      },
      { until: isTurnDone },
    );
    const done = frames.find(isTurnDone).params.notification;
    assert(done.tokenUsage.inputTokens === 250, "turn usage");
    assert(done.childTokenUsage.inputTokens === 10, "child usage");
    assert(
      frames.filter((f) => f.params?.notification?.type === "session_token_usage_changed").length >= 3,
      "usage stream",
    );
  });

  await check("interrupt produces duplicate cancelled tool_result", async () => {
    const { frames } = await drive(
      ["--mode", "permission-request"],
      async ({ write, frames }) => {
        write(INIT);
        write(UPDATE);
        write(PROMPT);
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          if (frames.some((f) => f.type === "request" && f.method === "droid.request_permission")) {
            write({ ...INIT, id: "9", method: "droid.interrupt_session", params: {} });
            return;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("no permission request");
      },
      { until: isTurnDone },
    );
    const results2 = frames.filter((f) => f.params?.notification?.type === "tool_result");
    assert(results2.length === 2, `duplicate tool_result (${results2.length})`);
    assert(frames.find(isTurnDone).params.notification.reason === "cancelled", "cancelled");
  });

  const failed = results.filter((r) => r.startsWith("FAIL"));
  for (const r of results) console.log(r);
  console.log(
    failed.length === 0
      ? `SELF-TEST PASS (${results.length} checks)`
      : `SELF-TEST FAIL (${failed.length}/${results.length})`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.selfTest) {
  selfTest().catch((e) => {
    console.error("SELF-TEST ERROR", e);
    process.exit(1);
  });
} else {
  runFake(opts);
}
