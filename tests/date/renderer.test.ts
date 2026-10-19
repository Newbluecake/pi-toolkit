import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DATE_CUSTOM_TYPE, dateKindSuffix, parseDateMarker } from "../../src/date/core.js";
import { wireDate } from "../../src/date/index.js";
import { formatDateMarkerLine, renderDateMessage } from "../../src/date/renderer.js";

const MARKER = "[date] 2026-10-19 Mon 14:12 (Asia/Shanghai)";
const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } as unknown as Parameters<
  typeof renderDateMessage
>[2];
const msg = (content: unknown, details: unknown) =>
  ({
    role: "custom",
    customType: DATE_CUSTOM_TYPE,
    content,
    display: true,
    details,
    timestamp: 0,
  }) as unknown as Parameters<typeof renderDateMessage>[0];

describe("parseDateMarker / dateKindSuffix", () => {
  it("parses the marker (also with the cross-day tail) and rejects garbage", () => {
    expect(parseDateMarker(MARKER)).toEqual({
      date: "2026-10-19",
      weekday: "Mon",
      time: "14:12",
      zone: "Asia/Shanghai",
    });
    expect(parseDateMarker(`${MARKER} — 当前日期已变更，时间为注入时刻`)?.time).toBe("14:12");
    expect(parseDateMarker("[date] soon")).toBeUndefined();
    expect(parseDateMarker("hello")).toBeUndefined();
  });
  it("maps kinds to English suffix tokens; unknown ⇒ empty", () => {
    expect(dateKindSuffix("first")).toBe("session start");
    expect(dateKindSuffix("cross-day")).toBe("new day");
    expect(dateKindSuffix("idle")).toBe("idle");
    expect(dateKindSuffix(undefined)).toBe("");
    expect(dateKindSuffix("weird")).toBe("");
  });
});

describe("formatDateMarkerLine", () => {
  it("renders one compact line per kind", () => {
    expect(formatDateMarkerLine(MARKER, "idle")).toBe("── date 2026-10-19 Mon 14:12 (Asia/Shanghai) · idle ──");
    expect(formatDateMarkerLine(MARKER, "cross-day")).toBe("── date 2026-10-19 Mon 14:12 (Asia/Shanghai) · new day ──");
    expect(formatDateMarkerLine(MARKER, "first")).toBe(
      "── date 2026-10-19 Mon 14:12 (Asia/Shanghai) · session start ──",
    );
    expect(formatDateMarkerLine(MARKER, undefined)).toBe("── date 2026-10-19 Mon 14:12 (Asia/Shanghai) ──");
  });
  it("is undefined for unparseable / non-string content", () => {
    expect(formatDateMarkerLine("nope", "idle")).toBeUndefined();
    expect(formatDateMarkerLine([{ type: "text" }], "idle")).toBeUndefined();
  });
});

describe("renderDateMessage (TUI)", () => {
  it("renders a single dim padded line", () => {
    const lines = renderDateMessage(msg(MARKER, { kind: "idle" }), { expanded: false, outputPad: 1 }, theme)!.render(
      120,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("<dim>── date 2026-10-19 Mon 14:12 (Asia/Shanghai) · idle ──</dim>");
    expect(lines[0]!.startsWith(" <dim>")).toBe(true);
    const wide = renderDateMessage(msg(MARKER, { kind: "idle" }), { expanded: false, outputPad: 3 }, theme)!.render(
      120,
    );
    expect(wide[0]!.startsWith("   <dim>")).toBe(true);
  });
  it("falls back to the default renderer (undefined) when unparseable; tolerates missing details", () => {
    expect(renderDateMessage(msg("garbage", { kind: "idle" }), { expanded: false }, theme)).toBeUndefined();
    const lines = renderDateMessage(msg(MARKER, undefined), { expanded: false } as never, theme)!.render(120);
    expect(lines[0]).toContain("── date 2026-10-19 Mon 14:12 (Asia/Shanghai) ──");
  });
});

describe("wireDate renderer registration", () => {
  it("registers the renderer for DATE_CUSTOM_TYPE when the host supports it", () => {
    const calls: Array<[string, unknown]> = [];
    const pi = {
      on: () => undefined,
      registerMessageRenderer: (type: string, fn: unknown) => calls.push([type, fn]),
    } as unknown as ExtensionAPI;
    wireDate(pi, { enabled: true });
    expect(calls).toEqual([[DATE_CUSTOM_TYPE, renderDateMessage]]);
  });
  it("is silent on hosts without registerMessageRenderer and when disabled", () => {
    const calls: unknown[] = [];
    const bare = { on: () => undefined } as unknown as ExtensionAPI;
    expect(() => wireDate(bare, { enabled: true })).not.toThrow();
    const off = { on: () => calls.push(1), registerMessageRenderer: () => calls.push(2) } as unknown as ExtensionAPI;
    wireDate(off, { enabled: false });
    expect(calls).toEqual([]);
  });
});
