/**
 * 一次性生成器：对**当前实现**录制 compact-hint 的 mode=off 黄金 fixture
 * （dynamic-threshold-plan.md §11.3 / T-D3-OFF-GOLDEN）。
 *
 * 用法：`npx tsx scripts/exp/generate-compact-hint-golden.ts`
 * 场景定义在 tests/integration/helpers/compact-hint-golden.ts（与回放测试共用）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runGoldenScenarios } from "../../tests/integration/helpers/compact-hint-golden.js";

const recording = runGoldenScenarios();
const target = resolve(process.cwd(), "tests/fixtures/compact-hint-golden.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(recording, null, 2)}\n`);
console.log(`[golden] wrote ${target}: ${recording.scenarios.length} scenarios, ${recording.messages.length} messages`);
