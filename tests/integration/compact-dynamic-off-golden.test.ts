/**
 * T-D3-OFF-GOLDEN（dynamic-threshold-plan.md §11.3 / §12 D3）：`mode="off"` ⇒ 所有
 * `sendMessage` 的 content/details 与 `tests/fixtures/compact-hint-golden.json` 逐字节相同。
 *
 * fixture 由 scripts/exp/generate-compact-hint-golden.ts 在动态阈值接线**之前**对当前
 * 实现录制（19 场景 / 44 条消息：tick 闩锁·抖动·重挂、hint 冷却、窗口切换、未知用量、
 * force 成功/onError/同步抛、switch demand 先礼后兵、handoff pending 跳过、绝对 token 线、
 * 绝对线自动失效、force 纯 token 线、窗口缩放 force + 密化 tick、小窗钳制、json/print 惰性、
 * 全线关闭、literal force、1M 大窗）。**禁止为了让测试通过而修改 fixture**：回放必须
 * 逐字节等于录制（JSON.parse 后 deep-equal，字符串字段再逐字节比对）。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runGoldenScenarios, type GoldenRecording } from "./helpers/compact-hint-golden.js";

function loadFixture(): GoldenRecording {
  const raw = readFileSync(resolve(process.cwd(), "tests/fixtures/compact-hint-golden.json"), "utf8");
  return JSON.parse(raw) as GoldenRecording;
}

describe("T-D3-OFF-GOLDEN: mode=off is byte-identical to the pre-change recording", () => {
  it("replays every scenario with no dynamic runtime and matches the fixture exactly", () => {
    const fixture = loadFixture();
    const recording = runGoldenScenarios();
    expect(recording.scenarios).toEqual(fixture.scenarios);
    expect(recording.messages.length).toBe(fixture.messages.length);
    for (let i = 0; i < fixture.messages.length; i += 1) {
      const want = fixture.messages[i];
      const got = recording.messages[i];
      expect(got).toEqual(want);
      // 逐字节：content 与序列化后的 details（deep-equal 之外再钉字符串坐标）。
      expect(got.content).toBe(want.content);
      expect(JSON.stringify(got.details)).toBe(JSON.stringify(want.details));
      expect(got.customType).toBe(want.customType);
    }
  });

  it("fixture covers the required scenario families (windows, tick, hint, force, demand, token lines)", () => {
    const fixture = loadFixture();
    const names = fixture.scenarios.map((s) => s.name);
    expect(names).toContain("tick-grid-latch-wobble-rearm");
    expect(names).toContain("hint-latch-cooldown-rearm");
    expect(names).toContain("hint-window-switch-and-effective-zero");
    expect(names).toContain("force-complete-resume-and-cooldown");
    expect(names).toContain("switch-demand-then-force-fallback");
    expect(names).toContain("absolute-token-line-1m-window");
    expect(names).toContain("absolute-line-auto-disable-small-window");
    expect(names).toContain("window-scaled-force-densified-ticks");
    expect(fixture.messages.length).toBeGreaterThan(30);
  });
});
