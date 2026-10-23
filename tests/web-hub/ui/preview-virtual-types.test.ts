/**
 * `@logic/previewVirtualTypes.ts` (preview-perf plan r3, P1a frozen interface): pins the
 * build-time constants and proves the frozen types are importable / implementable as
 * declared. P1/P2/P3 consume these shapes verbatim — this file is the tripwire for
 * accidental value or shape drift, not a behavioral test (there is no behavior: the module
 * is types + constants only).
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  FIND_MAX,
  HIGHLIGHT_WORKER_MAX_TOKENS,
  PREVIEW_VIRTUAL_BLOCK_LINES,
  PREVIEW_VIRTUAL_ENABLED,
  PREVIEW_VIRTUAL_MIN_LINES,
  PREVIEW_VLINE_DISPLAY_MAX,
  PREVIEW_VLINE_MAX_PARTS,
  VIRTUAL_MAX_LINES,
  VIRTUAL_MAX_PX,
  VIRTUAL_SELECTION_MAX_LINES,
  type DisplayLine,
  type DisplayPart,
  type HighlightSpans,
  type MutableVirtualSource,
  type VirtualSourceFactory,
  type VirtualTextChange,
  type VirtualTextSource,
} from "../../../src/web-hub/ui/src/logic/previewVirtualTypes.js";

describe("previewVirtualTypes constants (§8.1 P1a list)", () => {
  it("pins every frozen value", () => {
    expect(PREVIEW_VIRTUAL_ENABLED).toBe(true);
    expect(PREVIEW_VIRTUAL_MIN_LINES).toBe(600);
    expect(PREVIEW_VIRTUAL_BLOCK_LINES).toBe(32);
    expect(VIRTUAL_SELECTION_MAX_LINES).toBe(2048);
    expect(PREVIEW_VLINE_DISPLAY_MAX).toBe(4096);
    expect(VIRTUAL_MAX_PX).toBe(15_000_000);
    expect(VIRTUAL_MAX_LINES).toBe(500_000);
    expect(HIGHLIGHT_WORKER_MAX_TOKENS).toBe(80_000);
    expect(PREVIEW_VLINE_MAX_PARTS).toBe(1000);
    expect(FIND_MAX).toBe(10_000);
  });

  it("selection cap is a whole number of blocks (2048 = 64 × 32, §4.5)", () => {
    expect(VIRTUAL_SELECTION_MAX_LINES % PREVIEW_VIRTUAL_BLOCK_LINES).toBe(0);
  });
});

describe("previewVirtualTypes frozen shapes", () => {
  it("DisplayLine: parts / eol union / clipped exactly as declared (§4.2)", () => {
    expectTypeOf<DisplayLine["parts"]>().toEqualTypeOf<readonly DisplayPart[]>();
    expectTypeOf<DisplayLine["eol"]>().toEqualTypeOf<"\n" | "">();
    expectTypeOf<DisplayLine["clipped"]>().toEqualTypeOf<number>();
    expectTypeOf<DisplayPart>().toMatchObjectType<{ readonly cls: string; readonly text: string }>();
  });

  it("VirtualTextChange: exactly the three §4.2 variants", () => {
    expectTypeOf<VirtualTextChange>().toEqualTypeOf<
      | { readonly kind: "init" }
      | { readonly kind: "append"; readonly fromLine: number; readonly fromOffset: number }
      | { readonly kind: "highlight" }
    >();
  });

  it("HighlightSpans: string classes + Uint32Array span triples (§4.2/§5.3)", () => {
    expectTypeOf<HighlightSpans["classes"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<HighlightSpans["spans"]>().toEqualTypeOf<Uint32Array>();
    const spans: HighlightSpans = { classes: ["tok-keyword"], spans: new Uint32Array([0, 4, 0]) };
    expect(spans.spans).toHaveLength(3);
  });

  it("VirtualTextSource is implementable as declared (§4.2)", () => {
    const changes: VirtualTextChange[] = [
      { kind: "init" },
      { kind: "append", fromLine: 3, fromOffset: 40 },
      { kind: "highlight" },
    ];
    const source: VirtualTextSource = {
      revision: 2,
      lastChange: changes[1]!,
      lineCount: 4,
      length: 100,
      text: () => "abc\n".repeat(4),
      slice: (start, end) => "abc\n".repeat(4).slice(start, end),
      lineStart: (i) => i * 4,
      lineText: (i) => "abc\n",
      displayLine: (i): DisplayLine => ({ parts: [{ cls: "", text: "abc" }], eol: "\n", clipped: 0 }),
      maxDisplayCols: 3,
      lineOf: (offset) => Math.floor(offset / 4),
    };
    expect(source.lineOf(9)).toBe(2);
    expectTypeOf(source.text()).toEqualTypeOf<string>();
  });

  it("MutableVirtualSource extends VirtualTextSource; factory returns it (§4.2)", () => {
    expectTypeOf<MutableVirtualSource>().toExtend<VirtualTextSource>();
    const mutable: MutableVirtualSource = {
      revision: 0,
      lastChange: { kind: "init" },
      lineCount: 0,
      length: 0,
      text: () => "",
      slice: () => "",
      lineStart: () => 0,
      lineText: () => "",
      displayLine: (): DisplayLine => ({ parts: [], eol: "", clipped: 0 }),
      maxDisplayCols: 0,
      lineOf: () => 0,
      append: () => {},
      setHighlight: () => {},
    };
    const asBase: VirtualTextSource = mutable;
    expect(asBase.length).toBe(0);
    const factory: VirtualSourceFactory = {
      fromText: (text) => ({ ...mutable, text: () => text, length: text.length }),
      forStream: () => mutable,
    };
    expectTypeOf(factory.fromText("")).toEqualTypeOf<MutableVirtualSource>();
  });
});
