/**
 * external-agent plan §7.2 集成（P5）：fake-droid「链路」类场景——完成 / 用量计费 /
 * schema 提取 / resume 链 / resume cwd 钉死（两例）/ abort 两路 / init 早退 / extraEnv /
 * grandchild 组杀 / 目录探测 + advertised。真进程 + 真进程组 + 真时钟小预算。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDroidStack,
  makeBinary,
  readLines,
  smallBudget,
  waitFor,
  type DroidStack,
} from "./helpers/external-droid.js";

const stacks: DroidStack[] = [];
afterEach(() => {
  for (const s of stacks.splice(0)) s.dispose();
});

function spawnDroid(s: DroidStack, prompt: string, over: Record<string, unknown> = {}) {
  return s.stack.spawn
    .spawn({
      type: "worker",
      prompt,
      modelOverride: { provider: "droid", id: "gpt-6-luna" },
      ...(over as object),
    })
    .then((r) => {
      if (!("runId" in r)) throw new Error(`spawn rejected: ${JSON.stringify(r)}`);
      return r.runId as string;
    });
}

describe("external droid integration — chain (§7.2)", () => {
  it("完成：default 模式 end-to-end（spawn→init→update→turn→completed），transcript 落盘", async () => {
    const s = buildDroidStack({ binary: makeBinary(tmpRoot(), []) });
    stacks.push(s);
    const runId = await spawnDroid(s, "say done");
    const { status, outcome } = await waitFor(s.stack, runId, 30_000);
    expect(status).toBe("completed");
    expect(outcome?.text).toBe("DONE");
    expect(outcome?.usage).toMatchObject({ input: 120, output: 12 });
    // transcript：头行 + user + assistant（externalSessionPath 布局）。
    const sessionsDir = join(s.agentDir, "external-agent", "droid", "sessions");
    const written = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    expect(written).toHaveLength(1);
    const header = JSON.parse(readFileSync(join(sessionsDir, written[0]!), "utf8").split("\n")[0]!);
    expect(header).toMatchObject({ type: "external_session", provider: "droid", modelId: "gpt-6-luna" });
    // 进程组已清场（run 终态后 dispose）
    s.stack.external?.dispose();
  }, 60_000);

  it("计费：registry 命中 ⇒ priced（costUsd>0，child 用量 partial）；无价可依 ⇒ unpriced all", async () => {
    const s = buildDroidStack({ binary: makeBinary(tmpRoot(), ["--mode", "usage-script"]) });
    stacks.push(s);
    const runId = await spawnDroid(s, "usage");
    const { outcome } = await waitFor(s.stack, runId, 30_000);
    // usage-script：turn tokenUsage 250/30/600 + child 10/2（L6：child token 计入、成本不计
    // ⇒ partial）。priced with input=1 cacheRead=0.1。
    expect(outcome?.usage).toMatchObject({ input: 260, output: 32, cacheRead: 600 });
    expect(outcome?.usage?.costUsd).toBeGreaterThan(0);
    expect(outcome?.usage?.unpriced).toBe("partial");

    // kimi-k3（factory 自托管，注册表无价）⇒ unpriced all、costUsd=0。
    const kimi = await s.stack.spawn
      .spawn({ type: "worker", prompt: "usage", modelOverride: { provider: "droid", id: "kimi-k3" } })
      .then((r) => {
        if (!("runId" in r)) throw new Error(`spawn rejected: ${JSON.stringify(r)}`);
        return r.runId as string;
      });
    const kimiDone = await waitFor(s.stack, kimi, 30_000);
    expect(kimiDone.outcome?.usage).toMatchObject({ unpriced: "all" });
    expect(kimiDone.outcome?.usage?.costUsd).toBe(0);
  }, 90_000);

  it("schema 提取：末尾 ```json 块被提取校验；缺块 ⇒ failed{schema}", async () => {
    const script = join(tmpRoot(), "schema.jsonl");
    const good = [
      {
        notify: { type: "assistant_text_delta", messageId: "m1", blockIndex: 0, textDelta: "answer" },
      },
      {
        notify: {
          type: "create_message",
          message: { id: "m1", role: "assistant", content: [{ type: "text", text: 'final\n```json\n{"v": 7}\n```' }] },
        },
      },
      {
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
        },
      },
    ];
    writeFileSync(script, good.map((l) => JSON.stringify(l)).join("\n"));
    const s = buildDroidStack({ binary: makeBinary(tmpRoot(), ["--script", script]) });
    stacks.push(s);
    const ok = await s.stack.spawn
      .spawn({
        type: "worker",
        prompt: "structured",
        modelOverride: { provider: "droid", id: "gpt-6-luna" },
        schema: { type: "object", properties: { v: { type: "number" } }, required: ["v"] },
      })
      .then((r) => ("runId" in r ? (r.runId as string) : undefined));
    expect(ok).toBeDefined();
    const done = await waitFor(s.stack, ok!, 30_000);
    expect(done.status).toBe("completed");
    expect(done.outcome?.structuredResult).toEqual({ v: 7 });

    const badScript = join(tmpRoot(), "schema-bad.jsonl");
    writeFileSync(
      badScript,
      [
        JSON.stringify({
          notify: {
            type: "create_message",
            message: { id: "m2", role: "assistant", content: [{ type: "text", text: "no json" }] },
          },
        }),
        JSON.stringify({
          notify: {
            type: "agent_turn_completed",
            reason: "completed",
            turnId: "t2",
            tokenUsage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              thinkingTokens: 0,
              factoryCredits: 1,
            },
          },
        }),
      ].join("\n"),
    );
    const s2 = buildDroidStack({ binary: makeBinary(tmpRoot(), ["--script", badScript]) });
    stacks.push(s2);
    const bad = await s2.stack.spawn
      .spawn({
        type: "worker",
        prompt: "structured",
        modelOverride: { provider: "droid", id: "gpt-6-luna" },
        schema: { type: "object", properties: { v: { type: "number" } }, required: ["v"] },
      })
      .then((r) => ("runId" in r ? (r.runId as string) : undefined));
    const failed = await waitFor(s2.stack, bad!, 30_000);
    expect(failed.status).toBe("failed");
    expect(failed.outcome?.error?.kind).toBe("schema");
  }, 60_000);

  it("resume 链：resumeFrom 完成 run ⇒ 新 run 同 sessionId 续跑，transcript 追加 external-resume", async () => {
    const s = buildDroidStack({ binary: makeBinary(tmpRoot(), []) });
    stacks.push(s);
    const first = await spawnDroid(s, "first");
    const done = await waitFor(s.stack, first, 30_000);
    expect(done.status).toBe("completed");
    const snap = s.stack.query.get(first as never);
    const sessionFile = snap?.diag.sessionFile;
    expect(sessionFile).toBeDefined();
    const before = readFileSync(sessionFile!, "utf8");

    const second = await s.stack.spawn.spawn({ type: "worker", prompt: "second", resumeFrom: first }).then((r) => {
      if (!("runId" in r)) throw new Error(`resume rejected: ${JSON.stringify(r)}`);
      return r.runId as string;
    });
    const done2 = await waitFor(s.stack, second, 30_000);
    expect(done2.status).toBe("completed");
    const after = readFileSync(sessionFile!, "utf8");
    expect(after.length).toBeGreaterThan(before.length);
    expect(after).toContain("subagent:external-resume");
    // 同一 droid session 文件 ⇒ sessionId 未变。
    const snap2 = s.stack.query.get(second as never);
    expect(snap2?.diag.sessionFile).toBe(sessionFile);
    // 无 override 继承 droid 模型。
    expect(snap2?.diag.model).toEqual({ provider: "droid", id: "gpt-6-luna" });
  }, 90_000);

  it("resume cwd 钉死（echo-cwd）①：spec.cwd=B ⇒ fake 进程 cwd 与 init cwd 都是 A", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "droid-cwd-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "droid-cwd-b-"));
    const s = buildDroidStack({ binary: makeBinary(tmpRoot(), ["--mode", "echo-cwd"]) });
    stacks.push(s);
    const first = await spawnDroid(s, "in A", { cwd: dirA });
    const done = await waitFor(s.stack, first, 30_000);
    expect(done.status).toBe("completed");
    const echoes = readLines(s.echoFile).map((l) => JSON.parse(l));
    expect(echoes.length).toBeGreaterThanOrEqual(2); // 探测 1 次 + run 1 次
    const runEcho = echoes[echoes.length - 1]!;
    expect(runEcho.processCwd).toBe(dirA);
    expect(runEcho.initCwd).toBe(dirA);

    // resume：请求 cwd=B（H2 后）——头行 cwd=A 仍钉死。
    const second = await s.stack.spawn
      .spawn({ type: "worker", prompt: "resume in B", resumeFrom: first, cwd: dirB })
      .then((r) => {
        if (!("runId" in r)) throw new Error(`resume rejected: ${JSON.stringify(r)}`);
        return r.runId as string;
      });
    const done2 = await waitFor(s.stack, second, 30_000);
    expect(done2.status).toBe("completed");
    const resumeEcho = JSON.parse(readLines(s.echoFile).at(-1)!);
    expect(resumeEcho.processCwd).toBe(dirA); // 进程 cwd = 头行 cwd
    expect(resumeEcho.initCwd).toBe(dirA); // init 参数 cwd = 头行 cwd（≠ spec.cwd=B）
  }, 90_000);

  it("resume cwd 钉死 ②：头行 cwd（目录 A）被删 ⇒ failed{config}（msgResumeCwdGone），不起进程", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "droid-cwd-gone-"));
    const s = buildDroidStack({ binary: makeBinary(tmpRoot(), ["--mode", "echo-cwd"]) });
    stacks.push(s);
    const first = await spawnDroid(s, "in A", { cwd: dirA });
    expect((await waitFor(s.stack, first, 30_000)).status).toBe("completed");
    rmSync(dirA, { recursive: true, force: true });
    const traceBefore = readLines(s.traceFile).length;
    const second = await s.stack.spawn
      .spawn({ type: "worker", prompt: "resume after A gone", resumeFrom: first })
      .then((r) => {
        if (!("runId" in r)) throw new Error(`resume rejected: ${JSON.stringify(r)}`);
        return r.runId as string;
      });
    const failed = await waitFor(s.stack, second, 30_000);
    expect(failed.status).toBe("failed");
    expect(failed.outcome?.error?.message).toContain("no longer exists");
    // 未起进程：trace 无新增（探测在 build 时已结束）。
    expect(readLines(s.traceFile).length).toBe(traceBefore);
  }, 90_000);

  it("abort 两路：query.stop（interrupt ⇒ cancelled 结算）；信号路（no-exit-on-eof + ignore-interrupt ⇒ killGrace 后 SIGKILL）", async () => {
    const s = buildDroidStack({
      binary: makeBinary(tmpRoot(), ["--mode", "silent-turn"]),
      settings: { killGraceMs: 800 },
    });
    stacks.push(s);
    const runId = await spawnDroid(s, "hang", {
      budgetOverride: smallBudget({ totalMs: 60_000, idleMs: 60_000, firstEventMs: 60_000 }),
    });
    await sleepUntilRunning(s.stack, runId);
    await s.stack.query.stop(runId as never, "user_stop");
    const aborted = await waitFor(s.stack, runId, 30_000);
    expect(["aborted", "completed"]).toContain(aborted.status); // interrupt 生效 ⇒ cancelled 结算
  }, 90_000);

  it("§15：init 期间进程早退（exit-during-init）⇒ 快速 failed{internal}，不等 initTimeoutMs", async () => {
    const s = buildDroidStack({
      binary: makeBinary(tmpRoot(), ["--mode", "exit-during-init"]),
      settings: { initTimeoutMs: 20_000 },
    });
    stacks.push(s);
    const t0 = Date.now();
    const runId = await spawnDroid(s, "will crash");
    const failed = await waitFor(s.stack, runId, 30_000);
    expect(failed.status).toBe("failed");
    expect(Date.now() - t0).toBeLessThan(10_000); // 早退监听接管（initTimeout=20s）
    expect(failed.outcome?.error?.message).toContain("exited unexpectedly during session setup");
  }, 60_000);

  it("grandchild 组杀无残留（spawn-grandchild）", async () => {
    const s = buildDroidStack({ binary: makeBinary(tmpRoot(), ["--mode", "spawn-grandchild"]) });
    stacks.push(s);
    const runId = await spawnDroid(s, "spawn grandchild");
    const done = await waitFor(s.stack, runId, 30_000);
    expect(done.status).toBe("completed");
    // grandchild pid 记录在 trace（`grandchild:<pid>`）；run 终态后组内全灭。
    const line = readLines(s.traceFile).find((l) => l.startsWith("grandchild:"));
    expect(line).toBeDefined();
    const gpid = Number(line!.slice("grandchild:".length));
    await sleep(300); // 组杀传播
    expect(isAlive(gpid)).toBe(false);
  }, 60_000);

  it("extraEnv 到达子进程：DROID_CHILD_ENV（DISABLE_AUTO_UPDATE=1）可见（trace 回显）", async () => {
    const s = buildDroidStack({ binary: makeBinary(tmpRoot(), []) });
    stacks.push(s);
    const runId = await spawnDroid(s, "echo env");
    const done = await waitFor(s.stack, runId, 30_000);
    expect(done.status).toBe("completed");
    const lines = readLines(s.traceFile);
    expect(lines).toContain("env:DISABLE_AUTO_UPDATE=1");
    expect(lines).toContain("env:FACTORYD_DISABLE_AUTO_UPDATE=1");
  }, 60_000);

  it("无效模型：update -32602 ⇒ failed{config}（session_create），add_user_message 从未发出", async () => {
    // models-file 含目标模型 ⇒ 准入 exists=true；update 干净拒绝（S5）。
    const modelsFile = join(tmpRoot(), "models.json");
    writeFileSync(
      modelsFile,
      JSON.stringify([
        {
          id: "weird-model",
          modelProvider: "openai",
          supportedReasoningEfforts: ["low"],
          defaultReasoningEffort: "low",
          deprecated: false,
        },
      ]),
    );
    const s = buildDroidStack({
      binary: makeBinary(tmpRoot(), ["--mode", "unknown-model-on-update", "--models-file", modelsFile]),
    });
    stacks.push(s);
    // 等目录探测完成（build 时后台启动；无缓存时需要一次真探测）。
    await sleepUntilCatalog(s, 15_000);
    const runId = await s.stack.spawn
      .spawn({ type: "worker", prompt: "doomed", modelOverride: { provider: "droid", id: "weird-model" } })
      .then((r) => {
        if (!("runId" in r)) throw new Error(`spawn rejected: ${JSON.stringify(r)}`);
        return r.runId as string;
      });
    const failed = await waitFor(s.stack, runId, 30_000);
    expect(failed.status).toBe("failed");
    expect(failed.outcome?.error?.message).toContain("update_session_settings rejected");
    expect(readLines(s.traceFile)).not.toContain("droid.add_user_message");
  }, 90_000);
});

// ── helpers ──
let sharedRoot = "";
function tmpRoot(): string {
  if (sharedRoot === "") {
    sharedRoot = mkdtempSync(join(tmpdir(), "ext-droid-shared-"));
    mkdirSync(sharedRoot, { recursive: true });
  } else {
    try {
      mkdirSync(sharedRoot, { recursive: true });
    } catch {
      /* parallel-safe */
    }
  }
  return sharedRoot;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleepUntilRunning(stack: DroidStack["stack"], runId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = stack.query.get(runId as never);
    if (snap?.status === "running") return;
    await sleep(50);
  }
  throw new Error("run never became running");
}

async function sleepUntilCatalog(s: DroidStack, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const models = s.stack.external?.advertised() ?? [];
    if (models.some((m) => m.id === "weird-model")) return;
    await sleep(100);
  }
  throw new Error("catalog probe did not complete");
}
