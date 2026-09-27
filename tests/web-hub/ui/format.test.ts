import { describe, expect, it } from "vitest";
import {
  clip,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatUsd,
  localeFor,
} from "../../../src/web-hub/ui/src/format.js";

describe("format (vue-plan.md v2.1 §3.1, §3.6, §5.2 — P1)", () => {
  describe("formatUsd: '<$1 shows 4 decimals' rule preserved from the legacy render/dom.js", () => {
    it("unknown/non-finite ⇒ em dash", () => {
      expect(formatUsd(undefined)).toBe("—");
      expect(formatUsd(null)).toBe("—");
      expect(formatUsd("x")).toBe("—");
      expect(formatUsd(NaN)).toBe("—");
      expect(formatUsd(Infinity)).toBe("—");
    });
    it("exactly zero ⇒ '$0' (not '$0.00'/'$0.0000')", () => {
      expect(formatUsd(0)).toBe("$0");
    });
    it("< $1 shows 4 decimal places", () => {
      expect(formatUsd(0.0123)).toBe("$0.0123");
      expect(formatUsd(0.5)).toBe("$0.5000");
      expect(formatUsd(0.99995)).toBe("$1.0000"); // rounds within the 4-decimal formatter, still the <1 branch
    });
    it(">= $1 shows 2 decimal places", () => {
      expect(formatUsd(1)).toBe("$1.00");
      expect(formatUsd(1.005)).toBe("$1.01");
      expect(formatUsd(42.5)).toBe("$42.50");
    });
  });

  describe("formatDuration: compact 42s / 3m05s / 1h02m", () => {
    it("unknown/negative ⇒ ''", () => {
      expect(formatDuration(undefined)).toBe("");
      expect(formatDuration(-1)).toBe("");
      expect(formatDuration(NaN)).toBe("");
    });
    it("< 60s: Ns", () => {
      expect(formatDuration(0)).toBe("0s");
      expect(formatDuration(42_000)).toBe("42s");
    });
    it("< 1h: NmSSs", () => {
      expect(formatDuration(185_000)).toBe("3m05s");
    });
    it(">= 1h: NhMMm", () => {
      expect(formatDuration(3_720_000)).toBe("1h02m");
    });
  });

  describe("clip", () => {
    it("under the limit: unchanged", () => {
      expect(clip("hello", 10)).toBe("hello");
    });
    it("over the limit: truncated with an ellipsis, total length === max", () => {
      const out = clip("hello world", 5);
      expect(out).toBe("hell…");
      expect(out.length).toBe(5);
    });
  });

  describe("formatPercent / formatDateTime / formatNumber: Intl-backed, unknown ⇒ em dash", () => {
    it("formatPercent: 0..100-scale input", () => {
      expect(formatPercent(null)).toBe("—");
      expect(formatPercent(42)).toBe("42%");
      expect(formatPercent(0)).toBe("0%");
    });
    it("formatDateTime: unknown ⇒ em dash, a real epoch millis formats without throwing", () => {
      expect(formatDateTime(undefined)).toBe("—");
      expect(typeof formatDateTime(1_700_000_000_000)).toBe("string");
      expect(formatDateTime(1_700_000_000_000)).not.toBe("—");
    });
    it("formatNumber: locale-grouped", () => {
      expect(formatNumber(null)).toBe("—");
      expect(formatNumber(1234)).toBe("1,234");
    });
  });

  describe("localeFor", () => {
    it("maps §3.8's Lang to a concrete BCP 47 tag", () => {
      expect(localeFor("en")).toBe("en-US");
      expect(localeFor("zh")).toBe("zh-CN");
    });
  });
});
