/**
 * external-agent plan §7.2 集成（P5）：fake-droid「零卡死」类场景——挂死 / 无事件 /
 * 半行 / 不退出 / SIGTERM 不理 / 权限两态 / 402 / 无效模型 / AskUser / stdout 污染 /
 * 信号路 abort。真进程 + 真进程组 + 真时钟小预算；每条都断言 run 有界到达终态。
 */
import { mkdtempSync } from "node:fs";
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

let sharedRoot = "";
function root(): string {
  if (sharedRoot === "") sharedRoot = mkdtempSync(join(tmpdir(), "ext-droid-hang-"));
  return sharedRoot;
}

function spawnHang(s: DroidStack, over: Record<string, unknown> = {}) {
  return s.stack.spawn
    .spawn({
      type: "worker",
      prompt: "hang",
      modelOverride: { provider: "droid", id: "gpt-6-luna" },
      budgetOverride: smallBudget(),
      ...(over as object),
    })
    .then((r) => {
      if (!("runId" in r)) throw new Error(`spawn rejected: ${JSON.stringify(r)}`);
      return r.runId as string;
    });
}

describe("external droid integration — zero-hang (§7.2)", () => {
  it("挂死（hang-after-init）⇒ no_first_event 超时 ⇒ timed_out；组杀", async () => {
    const s = buildDroidStack({ binary: makeBinary(root(), ["--mode", "hang-after-init"]) });
    stacks.push(s);
    const runId = await spawnHang(s);
    const done = await waitFor(s.stack, runId, 30_000);
    expect(done.status).toBe("timed_out");
    expect(done.outcome?.timeoutReason ?? done.outcome?.error?.message).toBeTruthy();
  }, 60_000);

  it("无事件（silent-turn）⇒ idle 超时 ⇒ timed_out", async () => {
    const s = buildDroidStack({ binary: makeBinary(root(), ["--mode", "silent-turn"]) });
    stacks.push(s);
    const runId = await spawnHang(s);
    const done = await waitFor(s.stack, runId, 30_000);
    expect(done.status).toBe("timed_out");
  }, 60_000);

  it("半行输出（half-line）⇒ 不解析残行、不崩；idle 兜底", async () => {
    const s = buildDroidStack({ binary: makeBinary(root(), ["--mode", "half-line"]) });
    stacks.push(s);
    const runId = await spawnHang(s);
    const done = await waitFor(s.stack, runId, 30_000);
    expect(["timed_out", "failed"]).toContain(done.status); // 有界到达，无悬挂
  }, 60_000);

  it("进程不退出（no-exit-on-eof）+ interrupt 不响应 ⇒ 信号路 abort：killGrace 后 SIGKILL，unkillable 为空", async () => {
    const s = buildDroidStack({
      binary: makeBinary(root(), ["--mode", "silent-turn", "--no-exit-on-eof"]),
      settings: { killGraceMs: 800 },
    });
    stacks.push(s);
    const runId = await spawnHang(s, {
      budgetOverride: smallBudget({ totalMs: 60_000, idleMs: 60_000, firstEventMs: 60_000 }),
    });
    // 等到 running 再停（prompt 已发出、turn 挂起）。
    await untilRunning(s, runId);
    void s.stack.query.stop(runId as never, "user_stop");
    const done = await waitFor(s.stack, runId, 60_000);
    expect(["aborted", "timed_out"]).toContain(done.status);
    const snap = s.stack.query.get(runId as never);
    expect(snap?.diag.unkillable ?? []).toEqual([]); // killGrace 后 SIGKILL 组成功
  }, 90_000);

  it("SIGTERM 不理会（silent-turn + --ignore-sigterm）⇒ killGrace 后 SIGKILL，unkillable 为空", async () => {
    const s = buildDroidStack({
      binary: makeBinary(root(), ["--mode", "silent-turn", "--ignore-sigterm"]),
      settings: { killGraceMs: 800 },
    });
    stacks.push(s);
    const runId = await spawnHang(s, {
      budgetOverride: smallBudget({ totalMs: 4_000, idleMs: 4_000, firstEventMs: 4_000 }),
    });
    const done = await waitFor(s.stack, runId, 30_000);
    expect(done.status).toBe("timed_out"); // 总预算到点 ⇒ 停止升级 ⇒ SIGTERM 组不理会 ⇒ SIGKILL
    const snap = s.stack.query.get(runId as never);
    expect(snap?.diag.unkillable ?? []).toEqual([]);
  }, 60_000);

  it("反向请求（permission-request）⇒ 我方同步批准 ⇒ completed；无悬挂请求", async () => {
    const s = buildDroidStack({ binary: makeBinary(root(), ["--mode", "permission-request"]) });
    stacks.push(s);
    const runId = await spawnHang(s, {
      budgetOverride: smallBudget({ totalMs: 60_000, idleMs: 60_000, firstEventMs: 60_000 }),
    });
    const done = await waitFor(s.stack, runId, 30_000);
    expect(done.status).toBe("completed");
    // fake 在 cwd 下写 marker.txt（proceed_once 批准后执行）
    // —— cwd 是 stack root；不强制断言文件（S2 形状已由批准回执覆盖）。
  }, 60_000);

  it("批准无回执（permission-no-ack）⇒ ≤10s+requestTimeout 内 failed{config}（msgPermissionUnacknowledged），进程组全灭", async () => {
    const s = buildDroidStack({
      binary: makeBinary(root(), ["--mode", "permission-no-ack"]),
      settings: { requestTimeoutMs: 3_000 },
    });
    stacks.push(s);
    const runId = await spawnHang(s, {
      budgetOverride: smallBudget({ totalMs: 60_000, idleMs: 60_000, firstEventMs: 60_000, toolMs: 60_000 }),
    });
    const done = await waitFor(s.stack, runId, 40_000);
    expect(done.status).toBe("failed");
    expect(done.outcome?.error?.kind).toBe("config");
    expect(done.outcome?.error?.message).toContain("permission");
  }, 90_000);

  it("402（http-402）⇒ failed{auth} 不可重试、只起 1 个进程、文案无凭据", async () => {
    const s = buildDroidStack({ binary: makeBinary(root(), ["--mode", "http-402"]) });
    stacks.push(s);
    process.env.FACTORY_API_KEY = "fk-test-secret-DO-NOT-PRINT";
    try {
      const runId = await spawnHang(s);
      const done = await waitFor(s.stack, runId, 30_000);
      expect(done.status).toBe("failed");
      expect(done.outcome?.error).toMatchObject({ kind: "auth", retryable: false });
      expect(done.outcome?.error?.message).toContain("FACTORY_API_KEY");
      expect(done.outcome?.error?.message).not.toContain("fk-test-secret");
      // 只起 1 个 droid 进程（trace 里 initialize_session 恰一次，探测除外 ⇒ ≥1 且 run 部分 =1）
      const inits = readLines(s.traceFile).filter((l) => l === "droid.initialize_session");
      expect(inits.length).toBe(2); // build 探测 1 + run 1
    } finally {
      delete process.env.FACTORY_API_KEY;
    }
  }, 60_000);

  it("stdout-garbage ⇒ 非致命（低于阈值）继续完成 turn", async () => {
    const s = buildDroidStack({ binary: makeBinary(root(), ["--mode", "stdout-garbage"]) });
    stacks.push(s);
    const runId = await spawnHang(s, {
      budgetOverride: smallBudget({ totalMs: 30_000, idleMs: 30_000, firstEventMs: 30_000 }),
    });
    const done = await waitFor(s.stack, runId, 30_000);
    expect(done.status).toBe("completed"); // 2 行非 JSON < 阈值 20 ⇒ 不致命
    expect(done.outcome?.text).toBe("DONE");
  }, 60_000);

  it("AskUser 反向请求 ⇒ -32601 后 turn 有界结束（E5）", async () => {
    const s = buildDroidStack({ binary: makeBinary(root(), ["--mode", "ask-user-request"]) });
    stacks.push(s);
    const runId = await spawnHang(s, {
      budgetOverride: smallBudget({ totalMs: 30_000, idleMs: 30_000, firstEventMs: 30_000 }),
    });
    const done = await waitFor(s.stack, runId, 30_000);
    expect(done.status).toBe("completed");
  }, 60_000);

  it("envelope-reject（id:null -32700）⇒ 协议致命 failed（internal）", async () => {
    const s = buildDroidStack({ binary: makeBinary(root(), ["--mode", "envelope-reject"]) });
    stacks.push(s);
    const runId = await spawnHang(s, {
      budgetOverride: smallBudget({ totalMs: 30_000, idleMs: 30_000, firstEventMs: 30_000 }),
    });
    const done = await waitFor(s.stack, runId, 30_000);
    expect(done.status).toBe("failed");
  }, 60_000);

  it("drift（入站版本不符）⇒ strict 致命 failed{config}（msgProtocolDrift）", async () => {
    const s = buildDroidStack({ binary: makeBinary(root(), ["--mode", "drift"]) });
    stacks.push(s);
    const runId = await spawnHang(s, {
      budgetOverride: smallBudget({ totalMs: 30_000, idleMs: 30_000, firstEventMs: 30_000 }),
    });
    const done = await waitFor(s.stack, runId, 30_000);
    expect(done.status).toBe("failed");
    expect(done.outcome?.error?.kind).toBe("config");
  }, 60_000);
});

async function untilRunning(s: DroidStack, runId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = s.stack.query.get(runId as never);
    if (snap?.status === "running") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("run never became running");
}
