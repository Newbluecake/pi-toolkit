import { describe, expect, it } from "vitest";
import { SPEED_MIN_SPAN_MS, SPEED_WINDOW_MS, SpeedTracker } from "../../src/hud/speed.js";

/** 手动时钟：测试完全控制 now。 */
function makeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("SpeedTracker", () => {
  it("computes window speed from samples inside the window", () => {
    const clock = makeClock();
    const tracker = new SpeedTracker(clock.now);
    tracker.push(100);
    clock.advance(1_000);
    tracker.push(160);
    // 60 tokens / 1s = 60 t/s
    expect(tracker.windowSpeed()).toBe(60);
  });

  it("returns undefined when the sample span is below SPEED_MIN_SPAN_MS", () => {
    const clock = makeClock();
    const tracker = new SpeedTracker(clock.now);
    tracker.push(100);
    clock.advance(SPEED_MIN_SPAN_MS - 1);
    tracker.push(200);
    expect(tracker.windowSpeed()).toBeUndefined();
  });

  it("returns undefined for a single burst sample (caller falls back)", () => {
    const clock = makeClock();
    const tracker = new SpeedTracker(clock.now);
    // burst 投递：长 TTFT 后整段响应一次性 flush —— 只有一个样本。
    tracker.push(500);
    expect(tracker.windowSpeed()).toBeUndefined();
    tracker.reset();
    expect(tracker.windowSpeed()).toBeUndefined();
  });

  it("returns undefined when tokens do not increase", () => {
    const clock = makeClock();
    const tracker = new SpeedTracker(clock.now);
    tracker.push(100);
    clock.advance(1_000);
    tracker.push(100);
    expect(tracker.windowSpeed()).toBeUndefined();
  });

  it("anchors the window at the first sample inside SPEED_WINDOW_MS", () => {
    const clock = makeClock();
    const tracker = new SpeedTracker(clock.now);
    tracker.push(0); // t0，窗口外（>3s 前）
    clock.advance(2_500);
    tracker.push(50); // 窗口内首样本
    clock.advance(1_000);
    tracker.push(150);
    // 窗口锚点 = 50@2.5s：100 tokens / 1s = 100 t/s（不含窗口外样本）
    expect(tracker.windowSpeed()).toBe(100);
  });

  it("prunes samples older than 2× the window", () => {
    const clock = makeClock();
    const tracker = new SpeedTracker(clock.now);
    tracker.push(10);
    clock.advance(SPEED_WINDOW_MS * 2 + 1);
    tracker.push(20);
    // 旧样本已被裁剪 → 只剩单样本 → undefined
    expect(tracker.windowSpeed()).toBeUndefined();
    clock.advance(1_000);
    tracker.push(80);
    expect(tracker.windowSpeed()).toBe(60);
  });
});
