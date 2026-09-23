// quota-plan §9.2 forecast.test.ts — sample ring (window prune, max cap, reset
// detection, purity) + first↔last slope ETA prediction.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORECAST_OPTIONS,
  forecast,
  FORECAST_MIN_SPAN_MS,
  FORECAST_WINDOW_MS,
  pushSample,
} from "../../src/quota/forecast.js";

const MINUTE = 60_000;
const HOUR = 3_600_000;

describe("forecast", () => {
  it("returns skipped:too-few below minSamples", () => {
    expect(forecast([], HOUR)).toEqual({ samples: 0, skipped: "too-few" });
    expect(forecast([{ at: 0, usedPct: 20 }], HOUR)).toEqual({ samples: 1, skipped: "too-few" });
  });

  it("returns skipped:too-short when the span is below minSpanMs", () => {
    const ring = [
      { at: 0, usedPct: 20 },
      { at: FORECAST_MIN_SPAN_MS - 1, usedPct: 40 },
    ];
    expect(forecast(ring, HOUR)).toEqual({ samples: 2, skipped: "too-short" });
    // exactly 5min span is enough
    const ok = forecast(
      [
        { at: 0, usedPct: 20 },
        { at: FORECAST_MIN_SPAN_MS, usedPct: 40 },
      ],
      HOUR,
    );
    expect(ok.skipped).toBeUndefined();
    expect(ok.etaMs).toBe(3 * FORECAST_MIN_SPAN_MS); // 60% remaining at 20%/5min
  });

  it("computes first↔last slope: (t0,20%) → (t0+1h,40%) ⇒ 20%/h, eta 3h", () => {
    const t0 = 5 * HOUR;
    const result = forecast(
      [
        { at: t0, usedPct: 20 },
        { at: t0 + HOUR, usedPct: 40 },
      ],
      t0 + HOUR,
    );
    expect(result).toEqual({ etaMs: 3 * HOUR, burnPctPerHour: 20, samples: 2 });
  });

  it("returns skipped:not-burning for flat or decreasing usage", () => {
    const t0 = 5 * HOUR;
    expect(
      forecast(
        [
          { at: t0, usedPct: 40 },
          { at: t0 + HOUR, usedPct: 40 },
        ],
        t0 + HOUR,
      ),
    ).toEqual({ samples: 2, skipped: "not-burning" });
    expect(
      forecast(
        [
          { at: t0, usedPct: 50 },
          { at: t0 + HOUR, usedPct: 40 },
        ],
        t0 + HOUR,
      ),
    ).toEqual({ samples: 2, skipped: "not-burning" });
  });

  it("drops samples older than windowMs (boundary inclusive) and slopes on the survivors", () => {
    const now = 10 * HOUR;
    // 4h old → outside the 3h window; 1h old + fresh → inside.
    const result = forecast(
      [
        { at: now - 4 * HOUR, usedPct: 10 },
        { at: now - HOUR, usedPct: 20 },
        { at: now, usedPct: 40 },
      ],
      now,
    );
    expect(result.samples).toBe(2);
    expect(result.burnPctPerHour).toBe(20);
    expect(result.etaMs).toBe(3 * HOUR);
    // exactly at the cutoff is kept
    const boundary = forecast(
      [
        { at: now - FORECAST_WINDOW_MS, usedPct: 30 },
        { at: now, usedPct: 60 },
      ],
      now,
    );
    expect(boundary.samples).toBe(2);
    expect(boundary.burnPctPerHour).toBe(10);
  });

  it("honours custom options", () => {
    const t0 = 5 * HOUR;
    const ring = [
      { at: t0, usedPct: 20 },
      { at: t0 + 10 * MINUTE, usedPct: 40 },
    ];
    expect(forecast(ring, t0 + 10 * MINUTE, { minSpanMs: HOUR }).skipped).toBe("too-short");
    expect(forecast(ring, t0 + 10 * MINUTE, { minSamples: 3 }).skipped).toBe("too-few");
  });
});

describe("pushSample", () => {
  it("appends and returns a new array without mutating the input (pure)", () => {
    const ring = [{ at: 0, usedPct: 20 }];
    const next = pushSample(ring, { at: MINUTE, usedPct: 21 });
    expect(next).toEqual([
      { at: 0, usedPct: 20 },
      { at: MINUTE, usedPct: 21 },
    ]);
    expect(next).not.toBe(ring);
    expect(ring).toEqual([{ at: 0, usedPct: 20 }]);
  });

  it("restarts the ring on a >= 15 point drop (window reset detection)", () => {
    const ring = [
      { at: 0, usedPct: 50 },
      { at: MINUTE, usedPct: 60 },
    ];
    expect(pushSample(ring, { at: 2 * MINUTE, usedPct: 5 })).toEqual([{ at: 2 * MINUTE, usedPct: 5 }]);
  });

  it("keeps accumulating across sub-hysteresis jitter (60% → 58%)", () => {
    const ring = [{ at: 0, usedPct: 60 }];
    const next = pushSample(ring, { at: MINUTE, usedPct: 58 });
    expect(next).toHaveLength(2);
  });

  it("evicts the oldest beyond maxSamples (33rd pushes out the 1st)", () => {
    let ring: readonly { at: number; usedPct: number }[] = [];
    for (let i = 0; i <= 32; i++) ring = pushSample(ring, { at: i * MINUTE, usedPct: i });
    expect(ring).toHaveLength(DEFAULT_FORECAST_OPTIONS.maxSamples);
    expect(ring[0]).toEqual({ at: MINUTE, usedPct: 1 }); // {at:0} evicted
    expect(ring[ring.length - 1]).toEqual({ at: 32 * MINUTE, usedPct: 32 });
  });

  it("prunes ring samples outside windowMs relative to the new sample", () => {
    const ring = [
      { at: 0, usedPct: 10 },
      { at: HOUR, usedPct: 20 },
    ];
    // new sample at 4h ⇒ cutoff 1h ⇒ {at:0} dropped, {at:1h} kept
    expect(pushSample(ring, { at: 4 * HOUR, usedPct: 40 })).toEqual([
      { at: HOUR, usedPct: 20 },
      { at: 4 * HOUR, usedPct: 40 },
    ]);
  });

  it("honours a custom maxSamples", () => {
    let ring: readonly { at: number; usedPct: number }[] = [];
    for (let i = 0; i < 5; i++) ring = pushSample(ring, { at: i * MINUTE, usedPct: i }, { maxSamples: 3 });
    expect(ring).toHaveLength(3);
    expect(ring[0]?.at).toBe(2 * MINUTE);
  });
});
