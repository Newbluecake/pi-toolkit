/**
 * P7 硬要求 / quota-plan r2 §11 第一行：kimi/zai 的所有输出（verdict、render、
 * HUD、gate 文案、hook、sampler、fingerprint）逐字节不变。
 *
 * fixture 由 `tests/quota/helpers/kimi-zai-golden.ts` 的 `recordKimiZaiGolden()`
 * 在 P7 改动**之前**对当时实现录制（`UPDATE_QUOTA_GOLDEN=1` 一次性落盘），
 * 此后**永不重新生成**。pace-aware L1 的唯一批准差异：两个 zai 的 5h 55%
 * 在窗口已过 70% 时降为 L0；下面显式迁移这些预期，其余字段仍逐字节比对。
 */

process.env.TZ = "Asia/Shanghai"; // 须在录制函数执行前固定（formatResetAt 用本地钟面）

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { recordKimiZaiGolden, type GoldenRecording } from "./helpers/kimi-zai-golden.js";
import type { QuotaWire } from "../../src/web-hub/protocol/messages.js";

const FIXTURE = resolve(process.cwd(), "tests/fixtures/quota-kimi-zai-golden.json");

function loadFixture(): GoldenRecording {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as GoldenRecording;
}

function withPaceAwareL1(fixture: GoldenRecording): GoldenRecording {
  for (const key of ["zai-cn-l1", "zai-l1"]) {
    const v = fixture.verdicts[key]!;
    fixture.verdicts[key] = {
      ...v,
      level: 0,
      windows: v.windows.map((w) => (w.scope === "5h" ? { ...w, level: 0, reason: "under-pace" } : w)),
    };
  }
  const oldMessage = fixture.renders.message as string;
  expect(oldMessage.startsWith("[quota] zai-coding-cn 5h 55% · 7d 10%\n")).toBe(true);
  fixture.renders.message = oldMessage.split("\n").slice(1).join("\n");
  delete fixture.gate.annotationL1;
  const wire = fixture.sampler.wire as QuotaWire;
  const fingerprintProviders = JSON.parse(fixture.sampler.fingerprint as string) as QuotaWire["providers"];
  for (const providers of [wire.providers, fingerprintProviders]) {
    for (const p of providers) {
      if (p.id !== "zai-coding-cn" && p.id !== "zai") continue;
      p.level = 0;
      // 指纹不含窗口等级，wire 含；不往指纹新增字段。
      for (const w of p.windows) if (w.scope === "5h" && "level" in w) w.level = 0;
    }
  }
  return {
    ...fixture,
    hook: [
      {
        ...fixture.hook[0]!,
        content: "[quota] zai-coding-cn / zai 订阅可用，当前 5h 55% · 7d 10%，可正常派单。",
        details: { level: 0, providers: [], available: ["zai-coding-cn", "zai"] },
      },
      ...fixture.hook.slice(1),
    ],
    sampler: { wire, fingerprint: JSON.stringify(fingerprintProviders) },
  };
}

describe("kimi/zai golden (byte-identical pre/post P7)", () => {
  it("reproduces the frozen fixture except for the approved under-pace L1 changes", () => {
    const recording = recordKimiZaiGolden();
    expect(existsSync(FIXTURE), "golden fixture must exist (never regenerate it)").toBe(true);
    const fixture = withPaceAwareL1(loadFixture());
    expect(recording.meta.now).toBe(fixture.meta.now);
    // displayLevel is a later additive verdict field (display-only); the frozen fixture predates it.
    const stripDisplay = (k: string, val: unknown): unknown => (k === "displayLevel" ? undefined : val);
    expect(JSON.parse(JSON.stringify(recording, stripDisplay))).toEqual(JSON.parse(JSON.stringify(fixture)));
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
