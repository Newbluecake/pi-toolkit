// @vitest-environment happy-dom
/**
 * preview-perf P2 (plan r3 §4.2–§4.5, §6.3 P2 row) — the virtual renderer suite:
 *  - initial mount renders ONLY the window's blocks; every visible `.pv-line`'s
 *    textContent equals `source.displayLine(i)` (terminator riding the line, gutter number
 *    a CSS counter — block root `counter-reset` = start − 1, `data-start` for tests);
 *  - scrolling changes the block set; blocks that stay in range keep DOM node identity;
 *  - append re-renders only the last unfinished line's block + new blocks — every other
 *    mounted block keeps its element AND text-node identity (§4.8);
 *  - highlight arrival re-renders the mounted blocks;
 *  - selection freeze (injected predicate): range only grows, stays contiguous, capped at
 *    2048 lines (past the cap ⇒ normal window + status notice); frozen blocks' props keep
 *    their references (append/highlight queue); flush after collapse;
 *  - logical select-all: Ctrl+A matrix (cancel ONLY on explicit new selection actions),
 *    copy event writes the full loaded text at copy time;
 *  - clipped-line DOM structure (§4.2 r3): empty `.pv-vclip` between parts and the `"\n"`
 *    text node, marker not in textContent, `data-clip` + alt label;
 *  - `scrollToLine`, the view-cap tail notice, gutter digits across a digit boundary, and
 *    the row-height reanchor (§4.3).
 */
import { mount, VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import VirtualCode from "../../../src/web-hub/ui/src/components/shared/VirtualCode.vue";
import VirtualBlock from "../../../src/web-hub/ui/src/components/shared/VirtualBlock.vue";
import { resetLangForTests, setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import {
  PREVIEW_VLINE_DISPLAY_MAX,
  VIRTUAL_SELECTION_MAX_LINES,
} from "../../../src/web-hub/ui/src/logic/previewVirtualTypes.js";
import { spansOf, stubSource } from "./helpers/virtual-source-stub.js";

const ROW = 20;
const VIEW = 400; // 20 lines; overscan 1 screen + half-block hysteresis

/** N lines "L0001".."L####" (all "\n"-terminated unless `open` — unterminated last line). */
function linesText(n: number, open = false): string {
  const parts: string[] = [];
  for (let i = 1; i <= n; i++) parts.push(`L${String(i).padStart(5, "0")}`);
  return parts.join("\n") + (open ? "" : "\n");
}

interface Rig {
  wrapper: VueWrapper;
  pre: HTMLElement;
  spacer: HTMLElement;
  source: ReturnType<typeof stubSource>;
  rev: { v: number };
  /** Drive a source mutation + its reactive tick. */
  tick(fn: () => void): Promise<void>;
  /** Set scrollTop, fire the (passive) scroll listener the way a real scroll would. */
  scrollTo(top: number): void;
  blocks(): HTMLElement[];
  blockOfLine(line1based: number): HTMLElement | undefined;
  lineEls(block: HTMLElement): HTMLElement[];
}

async function mountRig(text: string, extra: Record<string, unknown> = {}): Promise<Rig> {
  const source = stubSource(text);
  const rev = { v: source.revision };
  const wrapper = mount(VirtualCode, {
    props: {
      source,
      sourceRevision: rev.v,
      rowHeight: ROW,
      viewportHeight: VIEW,
      ...(extra.selectionActive === undefined ? {} : { selectionActive: extra.selectionActive }),
    },
    attachTo: document.body,
  });
  await nextTick();
  const pre = wrapper.get("pre.preview-text-body.pv-virtual").element as HTMLElement;
  const spacer = wrapper.get(".pv-spacer").element as HTMLElement;
  return {
    wrapper,
    pre,
    spacer,
    source,
    rev,
    async tick(fn: () => void) {
      fn();
      rev.v = source.revision;
      await wrapper.setProps({ sourceRevision: rev.v });
      await nextTick();
    },
    scrollTo(top: number) {
      pre.scrollTop = top;
      pre.dispatchEvent(new Event("scroll"));
    },
    blocks() {
      return [...pre.querySelectorAll<HTMLElement>(".pv-vblock")];
    },
    blockOfLine(line1: number) {
      const start = Math.floor((line1 - 1) / 32) * 32 + 1;
      return pre.querySelector<HTMLElement>(`.pv-vblock[data-start="${start}"]`) ?? undefined;
    },
    lineEls(block: HTMLElement) {
      return [...block.querySelectorAll<HTMLElement>(":scope > .pv-line")];
    },
  };
}

/** Line textContent as VirtualBlock renders it: parts' text + terminator, no marker. */
function renderedTextOf(source: ReturnType<typeof stubSource>, i: number): string {
  const dl = source.displayLine(i);
  return dl.parts.map((p) => p.text).join("") + dl.eol;
}

afterEach(() => {
  document.body.innerHTML = "";
  resetLangForTests();
});

describe("VirtualCode — windowing", () => {
  it("mounts only the window's blocks; each visible line equals displayLine(i); counter start", async () => {
    const rig = await mountRig(linesText(2000));
    const blocks = rig.blocks();
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.length).toBeLessThan(2000 / 32);
    // window covers [0, 56) lines (20 visible + 1 screen overscan + ½-block) ⇒ blocks 0..1
    expect(blocks.map((b) => b.dataset.start)).toEqual(["1", "33"]);
    // counter-reset = start − 1 (the first increment lands on start)
    expect(blocks[0]!.style.getPropertyValue("counter-reset")).toBe("pvline 0");
    expect(blocks[1]!.style.getPropertyValue("counter-reset")).toBe("pvline 32");
    // every mounted line's textContent is the display form (terminator included)
    for (const [bi, b] of blocks.entries()) {
      const lines = rig.lineEls(b);
      expect(lines).toHaveLength(32);
      for (const [li, el] of lines.entries()) expect(el.textContent).toBe(renderedTextOf(rig.source, bi * 32 + li));
    }
    // the gutter number is a CSS counter — no DOM node carries it
    expect(rig.lineEls(blocks[0]!)[0]!.textContent).toMatch(/^L00001\n$/);
    // spacer geometry: unified gutter + locked row height + total height
    expect(rig.spacer.style.getPropertyValue("--pvline-w")).toBe("4ch"); // 2000 ⇒ 4 digits
    expect(rig.spacer.style.getPropertyValue("--pv-row-h")).toBe("20px");
    expect(rig.spacer.style.getPropertyValue("height")).toBe(`${2000 * ROW}px`);
    expect(rig.spacer.style.getPropertyValue("min-width")).toMatch(/^calc\(/);
    rig.wrapper.unmount();
  });

  it("scrolling changes the block set; surviving blocks keep DOM node identity", async () => {
    const rig = await mountRig(linesText(2000));
    const before = rig.blocks();
    rig.scrollTo(40 * ROW); // line ~41 — window [4, 96) ⇒ blocks 0..2 (block 2 is new)
    await nextTick();
    const after = rig.blocks();
    expect(after.map((b) => b.dataset.start)).toEqual(["1", "33", "65"]);
    // overlap region keeps the exact element nodes (Vue patches in place)
    const kept = before.find((b) => after.includes(b));
    expect(kept).toBeDefined();
    // a small scroll back never unmounts anything that was just mounted
    const snapshot = rig.blocks();
    rig.scrollTo(38 * ROW);
    await nextTick();
    expect(rig.blocks()).toEqual(snapshot);
    rig.wrapper.unmount();
  });

  it("append re-renders only the last unfinished line's block + new blocks (identity kept)", async () => {
    const rig = await mountRig(linesText(2000, true)); // last line "L02000" unterminated
    rig.scrollTo((2000 - 20) * ROW); // bottom: the unfinished line is visible
    await nextTick();
    const lastBlock = rig.blockOfLine(2000)!;
    const stableBlock = rig.blockOfLine(1980)!; // mounted, ABOVE the changed line's block
    const stableLineEl = rig.lineEls(stableBlock)[0]!;
    const stableTextNode = stableLineEl.firstChild!;
    const lastLineBefore = rig.lineEls(lastBlock).at(-1)!;
    expect(lastLineBefore.textContent).toBe("L02000"); // no terminator (open file)
    await rig.tick(() => rig.source.append(linesText(2000, true) + " MORE"));
    // the unfinished line grew, still in its block
    const lastBlockAfter = rig.blockOfLine(2000)!;
    expect(lastBlockAfter).toBe(lastBlock); // same element
    expect(rig.lineEls(lastBlockAfter).at(-1)!.textContent).toBe("L02000 MORE");
    // every OTHER mounted block kept its element and its text node
    expect(rig.blockOfLine(1980)).toBe(stableBlock);
    expect(rig.lineEls(stableBlock)[0]!).toBe(stableLineEl);
    expect(stableLineEl.firstChild).toBe(stableTextNode);
    rig.wrapper.unmount();
  });

  it("highlight arrival re-renders the mounted blocks (token spans appear)", async () => {
    const rig = await mountRig(linesText(100));
    expect(rig.pre.querySelector("span.tok-comment")).toBeNull();
    const off = (n: number): number => rig.source.lineStart(n - 1);
    await rig.tick(() => rig.source.setHighlight(spansOf([off(2), off(2) + 6, "tok-comment"])));
    const tok = rig.pre.querySelector("span.tok-comment");
    expect(tok).not.toBeNull();
    expect(tok!.textContent).toBe("L00002");
    // the line's textContent is unchanged by highlighting
    const line2 = rig.lineEls(rig.blockOfLine(2)!)[1]!;
    expect(line2.textContent).toBe("L00002\n");
    rig.wrapper.unmount();
  });
});

describe("VirtualCode — selection freeze (§4.5)", () => {
  function keyOf(e: Element): string {
    return e.getAttribute("data-start") ?? "?";
  }

  it("while active the window only grows, stays contiguous; queued changes flush after collapse", async () => {
    let active = false;
    const rig = await mountRig(linesText(3000, true), { selectionActive: () => active });
    rig.scrollTo(2980 * ROW); // bottom window: blocks 92..93 (lines 2945..3000)
    await nextTick();
    const preFreeze = rig.blocks();
    active = true;
    rig.scrollTo(2900 * ROW); // scroll UP — a fresh window would DROP blocks 92..93
    await nextTick();
    const grown = rig.blocks();
    expect(grown.length).toBeGreaterThan(preFreeze.length); // the union grew upward
    // 只增不减: every pre-freeze block is still mounted
    for (const b of preFreeze) expect(grown.includes(b)).toBe(true);
    // contiguity: data-start advances by exactly 32
    const starts = grown.map((b) => Number(b.dataset.start));
    for (let i = 1; i < starts.length; i++) expect(starts[i]).toBe(starts[i - 1]! + 32);

    // append + highlight queue: the frozen (already-mounted) blocks do not change
    await rig.tick(() => rig.source.append(linesText(3000, true) + " MORE"));
    await rig.tick(() =>
      rig.source.setHighlight(spansOf([rig.source.lineStart(2849), rig.source.lineStart(2849) + 6, "tok-comment"])),
    );
    expect(rig.pre.querySelector("span.tok-comment")).toBeNull(); // highlight queued, not applied
    const frozenLastLine = rig.lineEls(rig.blockOfLine(3000)!).at(-1)!;
    expect(frozenLastLine.textContent).toBe("L03000"); // last-line growth queued too

    // collapse (selectionchange, async path) ⇒ flush at the current revision
    active = false;
    document.dispatchEvent(new Event("selectionchange"));
    await nextTick();
    expect(rig.pre.querySelector("span.tok-comment")).not.toBeNull(); // flushed highlight
    rig.scrollTo(2980 * ROW); // the shrunk window dropped block 93 — scroll it back, fresh
    await nextTick();
    expect(rig.lineEls(rig.blockOfLine(3000)!).at(-1)!.textContent).toBe("L03000 MORE");
    rig.wrapper.unmount();
  });

  it("frozen blocks keep their text-node identity across appends (props refs frozen)", async () => {
    let active = false;
    const rig = await mountRig(linesText(3000, true), { selectionActive: () => active });
    rig.scrollTo(2980 * ROW); // bottom window (lines 2945..3000 visible+overscan)
    await nextTick();
    active = true;
    const block = rig.blockOfLine(2950)!;
    const lineEl = rig.lineEls(block)[0]!;
    const textNode = lineEl.firstChild!;
    await rig.tick(() => rig.source.append(linesText(3000, true) + " MORE"));
    expect(rig.blockOfLine(2950)).toBe(block);
    expect(rig.lineEls(block)[0]!).toBe(lineEl);
    expect(lineEl.firstChild).toBe(textNode); // native Range endpoints stay valid
    rig.wrapper.unmount();
  });

  it("past 2048 lines the window returns to normal and the status notice fires", async () => {
    let active = false;
    const rig = await mountRig(linesText(4000), { selectionActive: () => active });
    active = true;
    rig.scrollTo((4000 - 20) * ROW); // bottom — union would span ~4000 lines > 2048
    await nextTick();
    const starts = rig.blocks().map(keyOf);
    expect(starts.length).toBeLessThan(4000 / 32);
    // the union is NOT kept: the window is the fresh bottom one (no top blocks)
    expect(Number(starts[0])).toBeGreaterThan(64);
    const status = document.querySelector('.sr-only[role="status"]')!.textContent ?? "";
    expect(status).toContain(String(VIRTUAL_SELECTION_MAX_LINES));
    rig.wrapper.unmount();
  });
});

describe("VirtualCode — logical select-all (§4.5)", () => {
  async function selectAll(rig: Rig): Promise<void> {
    rig.pre.focus();
    const ev = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });
    rig.pre.dispatchEvent(ev);
    await nextTick();
    expect(ev.defaultPrevented).toBe(true);
  }

  function isSelected(rig: Rig): boolean {
    return rig.spacer.classList.contains("is-all-selected");
  }

  it("Ctrl+A: spacer marked, native selection cleared, status announces; copy writes the FULL text", async () => {
    const rig = await mountRig(linesText(100));
    await selectAll(rig);
    expect(isSelected(rig)).toBe(true);
    expect(document.getSelection()!.rangeCount).toBe(0);
    const announce = (document.querySelector('.sr-only[role="status"]')!.textContent ?? "").trim();
    expect(announce).toContain("100");

    // copy at select-all time…
    const dt = { setData: vi.fn() };
    const ev1 = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(ev1, "clipboardData", { value: dt });
    rig.pre.dispatchEvent(ev1);
    expect(dt.setData).toHaveBeenCalledWith("text/plain", linesText(100));
    rig.wrapper.unmount();
  });

  it("copy AFTER an append writes the appended full text (copy-time semantics)", async () => {
    const rig = await mountRig(linesText(100));
    await selectAll(rig);
    await rig.tick(() => rig.source.append(linesText(100) + "extra tail"));
    const dt = { setData: vi.fn() };
    const ev = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: dt });
    rig.pre.dispatchEvent(ev);
    expect(dt.setData).toHaveBeenCalledWith("text/plain", linesText(100) + "extra tail");
    rig.wrapper.unmount();
  });

  it("cancel matrix: only explicit new selection actions cancel", async () => {
    const rig = await mountRig(linesText(2000));
    await selectAll(rig);

    // NOT canceled by scroll / append / highlight / blur
    rig.scrollTo(500 * ROW);
    await nextTick();
    expect(isSelected(rig)).toBe(true);
    await rig.tick(() => rig.source.append(linesText(2000) + "x"));
    expect(isSelected(rig)).toBe(true);
    rig.pre.dispatchEvent(new Event("blur", { bubbles: false }));
    expect(isSelected(rig)).toBe(true);

    // pointerdown in the body cancels
    rig.pre.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    await nextTick();
    expect(isSelected(rig)).toBe(false);

    // Shift+ArrowDown cancels; Esc cancels
    await selectAll(rig);
    rig.pre.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }));
    await nextTick();
    expect(isSelected(rig)).toBe(false);
    await selectAll(rig);
    rig.pre.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(isSelected(rig)).toBe(false);

    // a new non-collapsed selectionchange cancels
    await selectAll(rig);
    const range = document.createRange();
    range.selectNodeContents(rig.pre);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await nextTick();
    expect(isSelected(rig)).toBe(false);
    rig.wrapper.unmount();
  });
});

describe("VirtualCode — clipped lines (§4.2 r3)", () => {
  it("structure: empty .pv-vclip between parts and the terminator; marker not in textContent", async () => {
    const long = "x".repeat(PREVIEW_VLINE_DISPLAY_MAX + 500) + "\nplain\n";
    const rig = await mountRig(long);
    const lines = rig.lineEls(rig.blocks()[0]!);
    const clipped = lines[0]!;
    const clipEl = clipped.querySelector<HTMLElement>(".pv-vclip")!;
    expect(clipEl).not.toBeNull();
    expect(clipEl.childElementCount).toBe(0);
    expect(clipEl.childNodes.length).toBe(0); // EMPTY span — the marker is ::before content
    expect(clipEl.dataset.clip).toBe("500");
    expect(clipEl.dataset.clipLabel).toContain("500");
    // the terminator is the line element's LAST child, a plain "\n" text node AFTER the marker
    const last = clipped.lastChild!;
    expect(last.nodeType).toBe(Node.TEXT_NODE);
    expect(last.textContent).toBe("\n");
    expect(last.previousSibling).toBe(clipEl);
    // the generated marker never enters the DOM text (native copy gets the prefix only)
    expect(clipped.textContent).toBe("x".repeat(PREVIEW_VLINE_DISPLAY_MAX) + "\n");
    // a plain line has no marker span
    expect(lines[1]!.querySelector(".pv-vclip")).toBeNull();
    expect(lines[1]!.textContent).toBe("plain\n");
    // stub cross-check: the display cut is exactly at the max
    expect(rig.source.displayLine(0).clipped).toBe(500);
    rig.wrapper.unmount();
  });

  it("surrogate-safe cut: the prefix never ends on a lone high surrogate", async () => {
    const pair = "\uD83D\uDE00"; // 😀 = high + low
    const body = "a".repeat(PREVIEW_VLINE_DISPLAY_MAX - 1) + pair + "tail\n";
    const rig = await mountRig(body);
    const dl = rig.source.displayLine(0);
    expect(dl.clipped).toBe("tail".length + 2); // the whole pair is pushed past the cut
    const text = rig.lineEls(rig.blocks()[0]!)[0]!.textContent ?? "";
    expect(text.endsWith(pair)).toBe(false); // never a lone high surrogate at the cut
    expect(text).toBe("a".repeat(PREVIEW_VLINE_DISPLAY_MAX - 1) + "\n");
    rig.wrapper.unmount();
  });
});

describe("VirtualCode — geometry, cap, gutter, API", () => {
  it("scrollToLine centers the line and mounts its window", async () => {
    const rig = await mountRig(linesText(5000));
    const vm = rig.wrapper.vm as unknown as { scrollToLine(l: number, w?: "start" | "center"): void };
    vm.scrollToLine(2500, "start");
    await nextTick();
    expect(rig.pre.scrollTop).toBe((2500 - 1) * ROW);
    const firstMounted = Number(rig.blocks()[0]!.dataset.start);
    expect(firstMounted).toBeLessThanOrEqual(2500);
    expect(firstMounted + rig.blocks().length * 32).toBeGreaterThan(2500);
    vm.scrollToLine(1000); // center
    await nextTick();
    expect(Math.round(rig.pre.scrollTop)).toBe(999 * ROW - (VIEW - ROW) / 2);
    rig.wrapper.unmount();
  });

  it("row-height change reanchors scrollTop by logical line (§4.3)", async () => {
    const rig = await mountRig(linesText(5000));
    const st0 = 1234 * ROW + 7; // mid-line fractional position
    rig.scrollTo(st0);
    await nextTick();
    await rig.wrapper.setProps({ rowHeight: 40 });
    await nextTick();
    await nextTick(); // reanchor rides nextTick after the spacer patch
    // anchorLine + in-line fraction are preserved: (st0 / 20) × 40
    expect(Math.abs(rig.pre.scrollTop - (st0 / ROW) * 40)).toBeLessThanOrEqual(1);
    expect(rig.spacer.style.getPropertyValue("--pv-row-h")).toBe("40px");
    rig.wrapper.unmount();
  });

  it("view cap: beyond maxLines the tail notice shows and extra lines never mount", async () => {
    // rowH 15000 ⇒ maxLines = floor(15e6 / 15000) = 1000 < 1200 loaded lines
    const rig = await mountRig(linesText(1200));
    await rig.wrapper.setProps({ rowHeight: 15000, viewportHeight: 30000 });
    await nextTick();
    const note = rig.pre.querySelector(".pv-cap-note");
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain("1200");
    // spacer height is capped at 1000 × 15000 — never beyond VIRTUAL_MAX_PX
    expect(rig.spacer.style.getPropertyValue("height")).toBe(`${1000 * 15000}px`);
    rig.wrapper.unmount();
  });

  it("gutter digits cross a boundary exactly once (999 → 1001 lines)", async () => {
    const rig = await mountRig(linesText(999));
    expect(rig.spacer.style.getPropertyValue("--pvline-w")).toBe("3ch");
    await rig.tick(() => rig.source.append(linesText(999) + "L01000\nL01001\n"));
    expect(rig.spacer.style.getPropertyValue("--pvline-w")).toBe("4ch");
    rig.wrapper.unmount();
  });

  it("probe sits OUTSIDE the scroll container, hidden, with the body described", async () => {
    setLangOverride("zh");
    const rig = await mountRig(linesText(10));
    const probe = document.querySelector<HTMLElement>(".pv-vprobe")!;
    expect(probe.getAttribute("aria-hidden")).toBe("true");
    expect(rig.pre.contains(probe)).toBe(false); // never inside selection/copy
    const descId = rig.pre.getAttribute("aria-describedby");
    expect(descId).toMatch(/^pv-vdesc-/);
    const desc = document.getElementById(descId!);
    expect(desc?.textContent).toContain("按需渲染");
    rig.wrapper.unmount();
  });
});

describe("VirtualBlock — unit (render function)", () => {
  it("renders parts verbatim, empty-part skipped, eol last child", async () => {
    const source = stubSource("token\n");
    await source.setHighlight(spansOf([0, 5, "tok-kw"]));
    const dl = source.displayLine(0);
    const wrapper = mount(VirtualBlock, {
      props: { lines: [dl], start: 33, topPx: 640, clipLabel: (n: number) => `cut ${n}` },
    });
    const root = wrapper.element as HTMLElement;
    expect(root.classList.contains("pv-vblock")).toBe(true);
    expect(root.style.getPropertyValue("counter-reset")).toBe("pvline 32");
    expect(root.style.getPropertyValue("top")).toBe("640px");
    expect(root.dataset.start).toBe("33");
    const line = root.querySelector<HTMLElement>(".pv-line")!;
    const tok = line.querySelector<HTMLElement>("span.tok-kw")!;
    expect(tok.textContent).toBe("token");
    expect(line.lastChild!.textContent).toBe("\n");
    wrapper.unmount();
  });
});
