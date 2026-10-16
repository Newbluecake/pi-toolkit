// sysload wire projection: the overall-level "held since" anchor (2026-10-16 field report
// 「已持续 0s」 — the hub used to project `sample.mono - verdict.mono` ≡ 0).
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { projectLoadWire } from "../../src/sysload/wire.js";
import type { LoadVerdict } from "../../src/sysload/types.js";

const verdict: LoadVerdict = {
  level: "ok",
  gating: false,
  metrics: { cpu: { level: "ok" }, mem: { level: "ok" }, disk: [] },
  mono: 100_000,
  at: 1_000_000,
};

describe("projectLoadWire — sinceAgoMs", () => {
  it("anchors on the caller-tracked overall level-since mono when given", () => {
    const wire = projectLoadWire(verdict, DEFAULT_SETTINGS.load, 100_000, 1_000_000, undefined, 40_000);
    expect(wire.sinceAgoMs).toBe(60_000);
  });

  it("legacy call (no level-since) keeps now - verdict.mono", () => {
    expect(projectLoadWire(verdict, DEFAULT_SETTINGS.load, 100_500).sinceAgoMs).toBe(500);
  });

  it("a level-since in the future is dropped, never negative", () => {
    const wire = projectLoadWire(verdict, DEFAULT_SETTINGS.load, 100_000, 1_000_000, undefined, 200_000);
    expect(wire.sinceAgoMs).toBeUndefined();
  });
});
