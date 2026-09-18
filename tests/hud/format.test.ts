import { sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatCwdForFooter,
  formatDuration,
  formatSpeed,
  formatStartTime,
  formatTokens,
  sanitizeStatusText,
} from "../../src/hud/format.js";

describe("formatTokens", () => {
  it("covers all magnitude tiers", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(9_999)).toBe("10.0k");
    expect(formatTokens(10_000)).toBe("10k");
    expect(formatTokens(999_999)).toBe("1000k");
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(9_999_999)).toBe("10.0M");
    expect(formatTokens(10_000_000)).toBe("10M");
    expect(formatTokens(1_234_567_890)).toBe("1235M");
  });
});

describe("formatDuration", () => {
  it("formats sub-second, seconds, minutes, hours", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(999)).toBe("<1s");
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(59_999)).toBe("59s");
    expect(formatDuration(60_000)).toBe("1m00s");
    expect(formatDuration(65_000)).toBe("1m05s");
    expect(formatDuration(3_599_000)).toBe("59m59s");
    expect(formatDuration(3_600_000)).toBe("1h00m00s");
    expect(formatDuration(3_661_000)).toBe("1h01m01s");
  });
});

describe("formatSpeed", () => {
  it("handles non-finite / non-positive and precision tiers", () => {
    expect(formatSpeed(0)).toBe("0t/s");
    expect(formatSpeed(-1)).toBe("0t/s");
    expect(formatSpeed(Number.NaN)).toBe("0t/s");
    expect(formatSpeed(Number.POSITIVE_INFINITY)).toBe("0t/s");
    expect(formatSpeed(5.25)).toBe("5.3t/s");
    expect(formatSpeed(10)).toBe("10t/s");
    expect(formatSpeed(123.6)).toBe("124t/s");
  });
});

describe("formatCwdForFooter", () => {
  const home = process.platform === "win32" ? "C:\\Users\\me" : "/home/me";
  it("returns cwd unchanged when home is undefined", () => {
    expect(formatCwdForFooter("/any/path", undefined)).toBe("/any/path");
  });
  it("collapses home itself to ~", () => {
    expect(formatCwdForFooter(home, home)).toBe("~");
  });
  it("prefixes paths inside home with ~", () => {
    expect(formatCwdForFooter(`${home}${sep}proj${sep}x`, home)).toBe(`~${sep}proj${sep}x`);
  });
  it("leaves paths outside home unchanged", () => {
    const outside = process.platform === "win32" ? "D:\\work" : "/var/tmp";
    expect(formatCwdForFooter(outside, home)).toBe(outside);
  });
  it("does not treat a sibling with a common prefix as inside home", () => {
    expect(formatCwdForFooter(`${home}2${sep}x`, home)).toBe(`${home}2${sep}x`);
  });
});

describe("sanitizeStatusText", () => {
  it("strips newlines/tabs and collapses whitespace", () => {
    expect(sanitizeStatusText("a\nb\tc\r\nd")).toBe("a b c d");
    expect(sanitizeStatusText("  a   b  ")).toBe("a b");
    expect(sanitizeStatusText("")).toBe("");
  });
});

describe("formatStartTime", () => {
  it("formats as yyyy-MM-dd HH:mm", () => {
    expect(formatStartTime(new Date(2026, 8, 5, 9, 7).getTime())).toBe("2026-09-05 09:07");
  });
});
