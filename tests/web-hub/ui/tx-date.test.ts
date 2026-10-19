// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import TxDate from "../../../src/web-hub/ui/src/components/transcript/TxDate.vue";
import { buildTxEntries } from "../../../src/web-hub/ui/src/components/transcript/entries.js";
import { parseDateMarker } from "../../../src/web-hub/ui/src/logic/dateMarker.js";
import { resetLangForTests, setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import { MESSAGES } from "../../../src/web-hub/ui/src/i18n/index.js";
import type { TranscriptSource } from "../../../src/web-hub/ui/src/contracts.js";

const MARKER = "[date] 2026-10-19 Mon 14:12 (Asia/Shanghai)";

const source = (items: unknown[]): TranscriptSource =>
  ({ items, streaming: null, tools: [] }) as unknown as TranscriptSource;
const customEntryItem = (content: string, details?: unknown, display?: boolean) => ({
  id: "d1",
  kind: "custom",
  entry: { id: "d1", type: "custom_message", customType: "subagent:date", content, details, display },
});

describe("parseDateMarker", () => {
  it("prefers details.kind; falls back to the cross-day note; else unknown", () => {
    expect(parseDateMarker(MARKER, { kind: "idle" })).toEqual({
      date: "2026-10-19",
      weekday: "Mon",
      time: "14:12",
      zone: "Asia/Shanghai",
      kind: "idle",
    });
    expect(parseDateMarker(`${MARKER} — 当前日期已变更，时间为注入时刻`)?.kind).toBe("cross-day");
    expect(parseDateMarker(MARKER)?.kind).toBe("unknown");
    expect(parseDateMarker(MARKER, { kind: "bogus" })?.kind).toBe("unknown");
    expect(parseDateMarker("[date] nope")).toBeUndefined();
  });
});

describe("buildTxEntries — date entries", () => {
  it("projects a history custom_message (even persisted display:false) to a date entry", () => {
    const { entries } = buildTxEntries(source([customEntryItem(MARKER, { kind: "first" }, false)]));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "date", marker: { date: "2026-10-19", kind: "first" } });
  });
  it("projects a live custom message the same way, even with display:false", () => {
    const item = {
      id: "m1",
      kind: "message",
      message: {
        role: "custom",
        customType: "subagent:date",
        content: MARKER,
        display: false,
        details: { kind: "idle" },
      },
    };
    const { entries } = buildTxEntries(source([item]));
    expect(entries[0]).toMatchObject({ type: "date", marker: { kind: "idle" } });
  });
  it("unparseable content falls back to the generic custom card", () => {
    const { entries } = buildTxEntries(source([customEntryItem("something else", { kind: "idle" })]));
    expect(entries[0]).toMatchObject({ type: "custom", customType: "subagent:date", text: "something else" });
  });
  it("other display:false live customs stay hidden", () => {
    const item = {
      id: "m2",
      kind: "message",
      message: { role: "custom", customType: "x:y", content: "hid", display: false },
    };
    expect(buildTxEntries(source([item])).entries).toHaveLength(0);
  });
});

describe("TxDate component", () => {
  const base = { date: "2026-10-19", weekday: "Mon", time: "14:12", zone: "Asia/Shanghai" } as const;
  const render = (
    lang: "zh" | "en",
    kind: "first" | "cross-day" | "idle" | "unknown",
    weekday: string = base.weekday,
  ) => {
    setLangOverride(lang, null);
    return mount(TxDate, { props: { marker: { ...base, weekday, kind } } });
  };

  it("renders only the date line for every kind (no note row)", () => {
    for (const kind of ["first", "cross-day", "idle", "unknown"] as const) {
      const w = render("zh", kind);
      expect(w.text()).toBe("2026-10-19 周一 14:12 · Asia/Shanghai");
      expect(w.find(".tx-date-note").exists()).toBe(false);
    }
    expect(render("en", "idle").find(".tx-date-text").text()).toBe("2026-10-19 Mon 14:12 · Asia/Shanghai");
    resetLangForTests();
  });
  it("unknown weekday token is shown raw; plain text only", () => {
    const w = render("en", "unknown", "Xyz");
    expect(w.find(".tx-date-note").exists()).toBe(false);
    expect(w.find(".tx-date-text").text()).toContain("Xyz");
    expect(w.attributes("role")).toBe("separator");
    resetLangForTests();
  });
});

describe("transcript i18n date keys", () => {
  const keys = ["dateAriaLabel", ...["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `dateWeek${d}`)];
  it("exist, non-empty, in both languages", () => {
    for (const lang of ["en", "zh"] as const) {
      const ns = (MESSAGES[lang] as Record<string, Record<string, string>>).transcript!;
      for (const k of keys) expect(ns[k], `${lang}.${k}`).toBeTruthy();
    }
  });
});
