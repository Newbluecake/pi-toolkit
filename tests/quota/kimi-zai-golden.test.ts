/**
 * P7 硬要求 / quota-plan r2 §11 第一行：kimi/zai 的所有输出（verdict、render、
 * HUD、gate 文案、hook、sampler、fingerprint）逐字节不变。
 *
 * fixture 由 `tests/quota/helpers/kimi-zai-golden.ts` 的 `recordKimiZaiGolden()`
 * 在 P7 改动**之前**对当时实现录制（`UPDATE_QUOTA_GOLDEN=1` 一次性落盘），
 * 此后**永不重新生成**——禁止为了让测试通过而修改 fixture；回放必须
 * deep-equal（字符串字段天然逐字节比对）。
 */

process.env.TZ = "Asia/Shanghai"; // 须在录制函数执行前固定（formatResetAt 用本地钟面）

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { recordKimiZaiGolden, type GoldenRecording } from "./helpers/kimi-zai-golden.js";

const FIXTURE = resolve(process.cwd(), "tests/fixtures/quota-kimi-zai-golden.json");

function loadFixture(): GoldenRecording {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as GoldenRecording;
}

describe("kimi/zai golden (byte-identical pre/post P7)", () => {
  it("reproduces the recorded fixture exactly", () => {
    const recording = recordKimiZaiGolden();
    if (process.env.UPDATE_QUOTA_GOLDEN === "1") {
      // 一次性录制开关（仅在基于未改动实现生成 fixture 时使用过一次）。
      writeFileSync(FIXTURE, `${JSON.stringify(recording, null, 2)}\n`, "utf8");
    }
    expect(existsSync(FIXTURE), "golden fixture must exist (never regenerate it)").toBe(true);
    const fixture = loadFixture();
    expect(recording.meta.now).toBe(fixture.meta.now);
    expect(JSON.parse(JSON.stringify(recording))).toEqual(JSON.parse(JSON.stringify(fixture)));
  });

  it("fixture covers every required surface (verdicts / renders / gate / hook / sampler)", () => {
    const fixture = loadFixture();
    for (const key of [
      "kimi-trap",
      "zai-cn-l1",
      "zai-l1",
      "zai-l2",
      "kimi-l3-pct",
      "stale",
      "demotion-floor",
      "reset-elapsed",
      "forecast-before-reset",
      "forecast-eta",
    ]) {
      expect(fixture.verdicts[key], key).toBeDefined();
    }
    for (const key of [
      "statusPlain",
      "statusThemed",
      "statusStale",
      "statusEmpty",
      "tick",
      "message",
      "messageMergedL3",
      "warn",
      "warnDemotionFloor",
      "block",
      "blockPaygo",
      "recovery",
      "available",
      "adviceObjectSub",
      "adviceObjectPaygo",
      "adviceArray",
      "adviceEmpty",
    ]) {
      expect(key in fixture.renders, key).toBe(true);
    }
    for (const key of [
      "blocked",
      "blockedWithNewDeps",
      "gatePassL0",
      "gatePassUnknown",
      "picked",
      "pickedWithNewDeps",
      "annotationL1",
      "annotationL3",
      "annotationDemoted",
      "annotationL0",
    ]) {
      expect(key in fixture.gate, key).toBe(true);
    }
    // 「不带新 deps」与「带新 deps 但非 droid 模型」两条路径必须逐字节相同。
    expect(fixture.gate.blockedWithNewDeps).toEqual(fixture.gate.blocked);
    expect(fixture.gate.pickedWithNewDeps).toEqual(fixture.gate.picked);
    expect(fixture.hook.length).toBeGreaterThan(0);
    expect(fixture.sampler.fingerprint).not.toBe("");
  });
});
