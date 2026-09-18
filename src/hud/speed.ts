/**
 * pi-hud 移植：流式输出速率滑动窗口（时钟注入，可单测）。
 * 收编源插件散落的 streamSamples / pushStreamSample / computeWindowSpeed 全局态。
 *
 * 滑动窗口速率：避免上游 burst 投递（长 TTFT 后整段响应一次性 flush，如
 * Factory/baseten kimi 短响应）时，"累计 ÷ 总耗时"把瞬时下发速度误报为生成速度。
 */

export const SPEED_WINDOW_MS = 3_000;
export const SPEED_MIN_SPAN_MS = 500;

type Sample = { t: number; tokens: number };

export class SpeedTracker {
  private samples: Sample[] = [];

  constructor(private readonly now: () => number) {}

  reset(): void {
    this.samples = [];
  }

  push(tokens: number): void {
    const now = this.now();
    this.samples.push({ t: now, tokens });
    const cutoff = now - SPEED_WINDOW_MS * 2;
    while (this.samples.length > 0) {
      const first = this.samples[0];
      if (first === undefined || first.t >= cutoff) break;
      this.samples.shift();
    }
  }

  /** 窗口内速率（t/s）；样本不足 / 跨度太短 / 无增量时返回 undefined（调用侧回退）。 */
  windowSpeed(): number | undefined {
    if (this.samples.length < 2) return undefined;
    const now = this.now();
    const cutoff = now - SPEED_WINDOW_MS;
    let first = this.samples[0];
    for (const sample of this.samples) {
      if (sample.t >= cutoff) {
        first = sample;
        break;
      }
    }
    const last = this.samples[this.samples.length - 1];
    if (first === undefined || last === undefined) return undefined;
    const spanMs = last.t - first.t;
    const deltaTokens = last.tokens - first.tokens;
    if (spanMs < SPEED_MIN_SPAN_MS || deltaTokens <= 0) return undefined;
    return deltaTokens / (spanMs / 1_000);
  }
}
