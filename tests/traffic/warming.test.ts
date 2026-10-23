/**
 * T5（traffic-merge plan §7.3）：pi 原生 cache warming 否决钩子（`src/traffic/warming.ts`）。
 *
 * 规则上膛（isRewriteArmed() 为真）⇒ `cache_warming_decision` 返回 `{action:"stop"}`；未上膛 ⇒ `undefined`
 * （不改写 pi 自己的决策）；armed 判定抛错 ⇒ fail-open（放行）+ 计数 + 一次去重 warn；dispose 注销。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { registerWarmingVeto } from "../../src/traffic/warming.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler>();
  const off = vi.fn();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
      return off as unknown as () => void;
    }),
  };
  return { pi, handler: (event = "cache_warming_decision") => handlers.get(event)!, off };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registerWarmingVeto", () => {
  it('armed ⇒ 返回 {action:"stop"}', () => {
    const { pi, handler } = fakePi();
    registerWarmingVeto(pi as never, () => true);
    expect(handler()({ type: "cache_warming_decision", action: "warm" }, undefined)).toEqual({ action: "stop" });
  });

  it("未 armed ⇒ undefined（不否决，pi 决策保持原样）", () => {
    const { pi, handler } = fakePi();
    registerWarmingVeto(pi as never, () => false);
    expect(handler()({ type: "cache_warming_decision", action: "warm" }, undefined)).toBeUndefined();
  });

  it("armed 判定抛错 ⇒ undefined（fail-open）+ errors 计数 + 一次去重 warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pi, handler } = fakePi();
    const handle = registerWarmingVeto(pi as never, () => {
      throw new Error("boom");
    });
    for (let i = 0; i < 3; i += 1) {
      expect(handler()({ type: "cache_warming_decision", action: "warm" }, undefined)).toBeUndefined();
    }
    expect(handle.errors).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("traffic");
  });

  it("dispose 调用 pi.on 返回的 unsubscriber；errors 是只读快照", () => {
    const { pi, off, handler } = fakePi();
    const handle = registerWarmingVeto(pi as never, () => false);
    expect(off).not.toHaveBeenCalled();
    handle.dispose();
    expect(off).toHaveBeenCalledTimes(1);
    expect(handle.errors).toBe(0);
    expect(handler).toBeDefined();
  });

  it("对象形式（T3 装配的调用形状 { rewriteArmed() }）：与裸函数等价", () => {
    const { pi, handler } = fakePi();
    let armed = true;
    registerWarmingVeto(pi as never, {
      rewriteArmed: () => armed,
    });
    expect(handler()({ type: "cache_warming_decision", action: "warm" }, undefined)).toEqual({ action: "stop" });
    armed = false;
    expect(handler()({ type: "cache_warming_decision", action: "warm" }, undefined)).toBeUndefined();
  });
});
