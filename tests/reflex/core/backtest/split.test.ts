/**
 * B1 · family split coin (BA §4.2 / U3): deterministic sha256 hashing, the 60/40 distribution
 * over 10k random roots (±2pp), and unscored ⇔ no root.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SPLIT_TRAIN_PERCENT, splitForRoot, splitOfRoot } from "../../../../src/reflex/core/backtest/split.js";

/** Deterministic mulberry32 — same shape as the governance corpus generator. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("splitOfRoot", () => {
  it("matches the literal definition: sha256 first-4-bytes BE mod 100 < 60", () => {
    for (const root of ["a", "b", "jobs", "0192fast", "π"]) {
      const bytes = createHash("sha256").update(root, "utf8").digest();
      const prefix = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
      expect(splitOfRoot(root)).toBe(prefix % 100 < SPLIT_TRAIN_PERCENT ? "train" : "holdout");
    }
  });

  it("is deterministic and stable per root", () => {
    expect(splitOfRoot("root-1")).toBe(splitOfRoot("root-1"));
    expect(splitOfRoot("root-1")).toBe(splitOfRoot("root-1"));
  });

  it("distributes 10,000 random roots within 60% ± 2pp", () => {
    const rand = rng(25);
    let train = 0;
    const n = 10_000;
    for (let i = 0; i < n; i++) {
      const root = `sess-${Math.floor(rand() * 1e9).toString(36)}-${i}`;
      if (splitOfRoot(root) === "train") train += 1;
    }
    const ratio = train / n;
    expect(ratio).toBeGreaterThan(0.58);
    expect(ratio).toBeLessThan(0.62);
  });

  it("splitForRoot: absent root ⇒ unscored", () => {
    expect(splitForRoot(undefined)).toBe("unscored");
    expect(splitForRoot("anything")).not.toBe("unscored");
  });
});
