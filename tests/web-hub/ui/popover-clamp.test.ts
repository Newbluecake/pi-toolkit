// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { clampPopoverY, POPOVER_PANEL_GAP } from "../../../src/web-hub/ui/src/composables/usePopoverClamp.js";

/**
 * `usePopoverClamp.ts`'s vertical fit (`clampPopoverY`): desktop model/thinking popovers open
 * ABOVE their chip, so a chip near the top of the page (new session, short transcript) pushed
 * the widened (394f72b) panel's top off-screen — with the search autofocus also popping the
 * mobile keyboard and shrinking the visual viewport. The clamp measures the space above/below
 * the chip (visualViewport first, innerHeight fallback), flips the panel BELOW the chip when
 * above doesn't fit AND below has more room, and caps max-height at min(70vh, that space).
 * happy-dom zero rects ⇒ no-op (layout-less component tests unaffected).
 */

function rect(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function measured(r: DOMRect): { el: HTMLElement; spy: ReturnType<typeof vi.spyOn> } {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const spy = vi.spyOn(el, "getBoundingClientRect").mockReturnValue(r);
  return { el, spy };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("clampPopoverY (desktop popover vertical fit)", () => {
  it("flips below the chip when the chip sits near the top (above fits neither the panel nor more space)", () => {
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("visualViewport", undefined);
    const { el: panel } = measured(rect(0, 0, 720, 400)); // 400px panel
    const { el: chip } = measured(rect(0, 30, 100, 62)); // chip near the top
    clampPopoverY(panel, chip);
    expect(panel.style.top).toBe(`calc(100% + ${POPOVER_PANEL_GAP}px)`);
    expect(panel.style.bottom).toBe("auto");
    // below space: 800 - 62 (chip bottom) - 8 (margin) - 6 (gap) = 724; cap = min(560, 724)
    expect(panel.style.maxHeight).toBe("560px");
  });

  it("stays above when the panel fits above, even with more room below", () => {
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("visualViewport", undefined);
    const { el: panel } = measured(rect(0, 0, 720, 300));
    const { el: chip } = measured(rect(0, 400, 100, 432));
    clampPopoverY(panel, chip);
    expect(panel.style.top).toBe(""); // CSS anchor (above) kept
    expect(panel.style.bottom).toBe("");
    // above space: 400 - 8 - 6 = 386 ≥ 300; cap = min(560, 386)
    expect(panel.style.maxHeight).toBe("386px");
  });

  it("stays above when neither side fits but above has more space, capping to the above space", () => {
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("visualViewport", undefined);
    const { el: panel } = measured(rect(0, 0, 720, 500));
    const { el: chip } = measured(rect(0, 400, 100, 432));
    clampPopoverY(panel, chip);
    expect(panel.style.top).toBe("");
    expect(panel.style.bottom).toBe("");
    // above: 386; below: 800 - 432 - 8 - 6 = 354 → above wins; cap = min(560, 386)
    expect(panel.style.maxHeight).toBe("386px");
  });

  it("uses visualViewport height/offsetTop over innerHeight (mobile keyboard shrinks it)", () => {
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("visualViewport", { height: 400, offsetTop: 100 });
    const { el: panel } = measured(rect(0, 0, 720, 300));
    const { el: chip } = measured(rect(0, 110, 100, 142)); // just below the visible top edge
    clampPopoverY(panel, chip);
    expect(panel.style.top).toBe(`calc(100% + ${POPOVER_PANEL_GAP}px)`);
    // above: 110 - 100 - 14 = -4 → 0; below: 100 + 400 - 142 - 14 = 344; cap = min(0.7*400, 344) = 280
    expect(panel.style.maxHeight).toBe("280px");
  });

  it("re-opening re-measures: inline overrides are cleared before measuring", () => {
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("visualViewport", undefined);
    const { el: panel, spy } = measured(rect(0, 0, 720, 400));
    const { el: chip, spy: chipSpy } = measured(rect(0, 30, 100, 62));
    clampPopoverY(panel, chip);
    expect(panel.style.top).not.toBe("");
    // second open: chip now sits mid-page and the panel fits above
    chipSpy.mockReturnValue(rect(0, 500, 100, 532));
    spy.mockReturnValue(rect(0, 0, 720, 200));
    clampPopoverY(panel, chip);
    expect(panel.style.top).toBe("");
    expect(panel.style.bottom).toBe("");
    // fits above (486 ≥ 200) ⇒ above kept, cap = min(560, 486)
    expect(panel.style.maxHeight).toBe("486px");
  });

  it("happy-dom zero rects ⇒ no-op (no inline top/bottom/max-height applied)", () => {
    vi.stubGlobal("innerHeight", 768);
    vi.stubGlobal("visualViewport", undefined);
    const { el: panel } = measured(rect(0, 0, 0, 0));
    const { el: chip } = measured(rect(0, 0, 0, 0));
    clampPopoverY(panel, chip);
    expect(panel.style.top).toBe("");
    expect(panel.style.bottom).toBe("");
    expect(panel.style.maxHeight).toBe("");
  });
});
