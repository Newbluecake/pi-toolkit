/**
 * T-D2-CONCURRENT 子进程夹具（非测试文件，vitest 不收集——文件名不带 `.test.`）。
 *
 * 由 telemetry-store.test.ts 经 `child_process.fork` 拉起，`execArgv: ["--import", "tsx"]`
 * 让子进程能直接运行 TS 源并解析 `.js` 后缀导入。用法：
 *
 *   telemetry-fork-child.ts <filePath> <sessionId> <iterations>
 *
 * 每次迭代经真实 tracker + store 写一对记录（switch 行 + 打断前一个观察窗的 window 行），
 * 与真实遥测节奏一致；其中一方的写入量按参数跨过 2 MiB 触发一次 rotate。
 * 退出码：0 = 成功，2 = 参数错误，1 = 未捕获异常（父进程据此断言「无未捕获异常」）。
 */

import { createSwitchTelemetryTracker, type TelemetrySnapshot } from "../../../src/compact-hint/dynamic/telemetry.js";
import { createTelemetryStore } from "../../../src/compact-hint/dynamic/telemetry-store.js";

const SNAPSHOT: TelemetrySnapshot = {
  model: { provider: "anthropic", id: "claude-opus-4-5", contextWindow: 1_000_000 },
  lines: { mode: "on", hintPercent: 41, forcePercent: 88, basis: "cost", dynamicUsable: true, degradeReason: null },
  estimate: { g: 779.4, sigma: 512.2, s0: 98_400, cStar: 161_000, rUsd: 10, handoffTokens: 4_500 },
  price: { cacheRead: 0.2, cacheWrite: 5, output: 20, tierHit: 272_000, writePricingApproximate: true },
  cachedContextTokens: 410_000,
};

function main(): number {
  const [filePath, sessionId, iterationsRaw] = process.argv.slice(2);
  if (!filePath || !sessionId || !iterationsRaw) {
    console.error("usage: telemetry-fork-child.ts <filePath> <sessionId> <iterations>");
    return 2;
  }
  const iterations = Number(iterationsRaw);
  if (!Number.isFinite(iterations) || iterations <= 0) {
    console.error("iterations must be a positive number");
    return 2;
  }
  const store = createTelemetryStore({ filePath });
  const tracker = createSwitchTelemetryTracker({ now: () => Date.now(), sessionId });
  for (let i = 0; i < iterations; i += 1) {
    const records = tracker.onSessionCompact(
      {
        reason: i % 2 === 0 ? "manual" : "threshold",
        compactionEntry: {
          fromHook: i % 3 === 0,
          tokensBefore: 400_000 + i,
          usage: { cost: { total: 0.01 + i / 1000 } },
        },
      },
      undefined,
      SNAPSHOT,
    );
    for (const record of records) store.append(record);
  }
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error("telemetry-fork-child failed:", error);
  process.exit(1);
}
