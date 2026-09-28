import { describe, expect, it } from "vitest";
import {
  createReqDeadline,
  deriveBudget,
  raceDeadline,
  WRITE_TOTAL_MS,
} from "../../../src/web-hub/hub/req-deadline.js";

describe("createReqDeadline / remaining() / expired()", () => {
  it("remaining() counts down and clamps at 0; expired() flips once the deadline passes", () => {
    let t = 1_000;
    const now = () => t;
    const d = createReqDeadline(now, 1_000);
    expect(d.remaining()).toBe(1_000);
    expect(d.expired()).toBe(false);
    t += 400;
    expect(d.remaining()).toBe(600);
    t += 700;
    expect(d.remaining()).toBe(0); // clamped, never negative
    expect(d.expired()).toBe(true);
  });

  it("defaults to WRITE_TOTAL_MS when no totalMs is given", () => {
    const d = createReqDeadline(() => 0);
    expect(d.remaining()).toBe(WRITE_TOTAL_MS);
  });

  it("negative totalMs clamps to 0 remaining immediately", () => {
    const d = createReqDeadline(() => 0, -500);
    expect(d.remaining()).toBe(0);
    expect(d.expired()).toBe(true);
  });
});

describe("raceDeadline", () => {
  it("resolves with the promise's value when it settles first", async () => {
    await expect(raceDeadline(Promise.resolve(42), 1_000)).resolves.toBe(42);
  });

  it("rejects once ms elapses if the promise never settles", async () => {
    await expect(raceDeadline(new Promise(() => {}), 10)).rejects.toThrow("E_DEADLINE");
  });
});

describe("deriveBudget", () => {
  it("is max(0, min(cap, remaining - reserve))", () => {
    expect(deriveBudget(10_000, 4_000, 5_000)).toBe(4_000); // capped
    expect(deriveBudget(6_000, 4_000, 5_000)).toBe(1_000); // remaining-reserve wins
    expect(deriveBudget(1_000, 4_000, 5_000)).toBe(0); // negative clamps to 0
    expect(deriveBudget(0, 4_000, 5_000)).toBe(0);
  });
});
