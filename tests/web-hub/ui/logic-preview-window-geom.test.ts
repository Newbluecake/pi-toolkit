// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  avoidObstacle,
  CASCADE,
  clampRect,
  defaultRect,
  EDGE,
  maximizedRect,
  MIN_H,
  MIN_W,
  moveRect,
  resizeRect,
  cascadeRect,
  TITLE_H,
  TITLE_KEEP_X,
  type PreviewRect,
  type PreviewResizeDir,
  type PreviewViewportBox,
} from "../../../src/web-hub/ui/src/logic/previewWindowGeom.js";

/**
 * web-hub-preview-windows plan r2 §7.3 (评审 #9, W1): every listed 必测用例 — the 768×900
 * cascade example, the short-viewport no-contradiction case, partially-offscreen 8-direction
 * resizes, plus the fixed-seed property run (P1–P4 always hold; the opposite edge only ever
 * moves through the P4 translation).
 */

const VP: PreviewViewportBox = { vw: 1280, vh: 800, top: 0 };
const vpOf = (vw: number, vh: number, top = 0): PreviewViewportBox => ({ vw, vh, top });

function assertP1toP4(r: PreviewRect, vp: PreviewViewportBox): void {
  const aw = Math.max(0, vp.vw - 2 * EDGE);
  const ah = Math.max(0, vp.vh - vp.top - 2 * EDGE);
  const mw = Math.min(MIN_W, aw);
  const mh = Math.min(MIN_H, ah);
  // P1
  expect([r.x, r.y, r.w, r.h].every(Number.isFinite), `P1 finite: ${JSON.stringify(r)}`).toBe(true);
  // P2
  expect(r.w, `P2 w ≥ ${mw}: ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(mw);
  expect(r.h, `P2 h ≥ ${mh}: ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(mh);
  // P3
  expect(r.w, `P3 w ≤ ${aw}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(aw);
  expect(r.h, `P3 h ≤ ${ah}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(ah);
  // P4
  expect(r.x, `P4 x ≥ ${TITLE_KEEP_X - r.w}: ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(TITLE_KEEP_X - r.w);
  expect(r.x, `P4 x ≤ ${vp.vw - TITLE_KEEP_X}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(vp.vw - TITLE_KEEP_X);
  expect(r.y, `P4 y ≥ ${vp.top}: ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(vp.top);
  expect(r.y, `P4 y ≤ ${vp.vh - TITLE_H}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(vp.vh - TITLE_H);
}

describe("logic/previewWindowGeom: defaultRect / clampRect", () => {
  it("defaultRect: w=min(960,AW), h=min(0.85·vh,900,AH), centered in the usable box", () => {
    expect(defaultRect(VP)).toEqual({ x: 160, y: 60, w: 960, h: 680 });
  });

  it("clampRect: P2/P3 size clamps then the P4 translation", () => {
    expect(clampRect({ x: 1500, y: -100, w: 50, h: 50 }, VP)).toEqual({ x: 1184, y: 0, w: MIN_W, h: MIN_H });
    expect(clampRect({ x: 0, y: 0, w: 5000, h: 5000 }, VP)).toEqual({ x: 0, y: 0, w: 1264, h: 784 });
    // with a topbar the vertical window starts below it
    expect(clampRect({ x: 160, y: 0, w: 960, h: 680 }, vpOf(1280, 800, 48))).toEqual({ x: 160, y: 48, w: 960, h: 680 });
  });

  it("P1: NaN/Infinity falls back to defaultRect", () => {
    expect(clampRect({ x: Number.NaN, y: 0, w: 400, h: 300 }, VP)).toEqual(defaultRect(VP));
    expect(clampRect({ x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 300 }, VP)).toEqual(defaultRect(VP));
    expect(moveRect({ x: Number.NaN, y: 0, w: 400, h: 300 }, 10, 10, VP)).toEqual(defaultRect(VP));
  });

  it("clampRect is idempotent", () => {
    const once = clampRect({ x: 4000, y: -50, w: 100, h: 5000 }, vpOf(1024, 700, 32));
    expect(clampRect(once, vpOf(1024, 700, 32))).toEqual(once);
  });

  it("moveRect translates then clamps (P4 keeps the title bar reachable)", () => {
    expect(moveRect({ x: 100, y: 100, w: 400, h: 300 }, 2000, 0, VP)).toEqual({ x: 1184, y: 100, w: 400, h: 300 });
    expect(moveRect({ x: 100, y: 100, w: 400, h: 300 }, -500, 5000, VP)).toEqual({
      x: -304,
      y: 752,
      w: 400,
      h: 300,
    });
  });
});

describe("logic/previewWindowGeom: resizeRect (§7.3 per-axis rules)", () => {
  const s: PreviewRect = { x: 200, y: 200, w: 600, h: 400 };

  it("grows/shrinks along the dragged edge; the opposite edge stays fixed", () => {
    expect(resizeRect(s, "e", 200, 0, VP)).toEqual({ x: 200, y: 200, w: 800, h: 400 });
    expect(resizeRect(s, "e", -500, 0, VP)).toEqual({ x: 200, y: 200, w: 360, h: 400 }); // P2 floor
    expect(resizeRect(s, "w", -1000, 0, VP)).toEqual({ x: 8, y: 200, w: 792, h: 400 }); // P5 wall
    expect(resizeRect(s, "w", 500, 0, VP)).toEqual({ x: 440, y: 200, w: 360, h: 400 }); // P2 floor
    expect(resizeRect(s, "s", 0, 1000, VP)).toEqual({ x: 200, y: 200, w: 600, h: 592 }); // P5 wall
    expect(resizeRect(s, "n", 0, -100, VP)).toEqual({ x: 200, y: 100, w: 600, h: 500 });
    expect(resizeRect(s, "n", 0, 1000, VP)).toEqual({ x: 200, y: 360, w: 600, h: 240 }); // P2 floor
    expect(resizeRect(s, "se", 100, 100, VP)).toEqual({ x: 200, y: 200, w: 700, h: 500 });
    expect(resizeRect(s, "nw", -100, -100, VP)).toEqual({ x: 100, y: 100, w: 700, h: 500 });
  });

  it("P5 vs P2 conflict: a viewport smaller than the minimum keeps the minimum (P2 wins)", () => {
    const tiny = vpOf(300, 300, 0); // AW=284 < MIN_W ⇒ mw=284
    const r = resizeRect({ x: 8, y: 8, w: 284, h: 284 }, "e", 400, 0, tiny);
    expect(r).toEqual({ x: 8, y: 8, w: 284, h: 284 });
  });

  it("短视口 vh−top < 240: mh = AH, no contradiction (评审 #9)", () => {
    const short = vpOf(1024, 200, 0); // AH=184 < 240 ⇒ mh=184
    const d = defaultRect(short);
    assertP1toP4(d, short);
    expect(d.h).toBe(184); // min(0.85·200=170, 900, 184) floored to mh — no contradiction
    for (const dir of ["n", "s", "e", "w"] as const) {
      assertP1toP4(resizeRect(d, dir, 50, 50, short), short);
    }
  });

  it("窗口部分离屏后八个方向缩放 — every result satisfies P1–P4", () => {
    const off: PreviewRect = { x: -700, y: 400, w: 600, h: 300 }; // mostly offscreen left
    for (const dir of ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const) {
      for (const d of [-300, -50, 0, 50, 300]) {
        assertP1toP4(resizeRect(off, dir, d, d, VP), VP);
        assertP1toP4(resizeRect(off, dir, d, -d, VP), VP);
      }
    }
  });

  it("a mostly-offscreen west resize brings the window back through the P4 translation", () => {
    const off = (): PreviewRect => ({ x: -700, y: 400, w: 600, h: 300 });
    // either drag direction hits the P2 floor: left ≤ right(−100) − 360 = −460, w = 360; the
    // trailing clampRect then translates x to the P4 bound 96 − 360 = −264 (the ONLY step
    // allowed to move the opposite/right edge along with it).
    expect(resizeRect(off(), "w", -2000, 0, VP)).toEqual({ x: -264, y: 400, w: 360, h: 300 });
    expect(resizeRect(off(), "w", 2000, 0, VP)).toEqual({ x: -264, y: 400, w: 360, h: 300 });
  });

  it("min-edge drag with the OPPOSITE edge past the usable box: s.end−A keeps it fixed (P6)", () => {
    // rework #1 (kami #1): right edge 1300 is 28px past the box — dragging the LEFT edge out
    // must stop at s.end − AW = 36 so the width never exceeds AW; without the term the
    // trailing P3 size clamp shoved the right edge 1300→1272 by non-P4 means.
    const off: PreviewRect = { x: 700, y: 200, w: 600, h: 300 };
    const r = resizeRect(off, "w", -1000, 0, VP);
    expect(r).toEqual({ x: 36, y: 200, w: 1264, h: 300 });
    expect(r.x + r.w).toBe(1300); // the opposite (right) edge is byte-fixed
    assertP1toP4(r, VP);
    // vertical twin: bottom edge 820 is past vh−EDGE = 792
    const offY: PreviewRect = { x: 200, y: 500, w: 600, h: 320 };
    const r2 = resizeRect(offY, "n", 0, -1000, VP);
    expect(r2).toEqual({ x: 200, y: 36, w: 600, h: 784 });
    expect(r2.y + r2.h).toBe(820);
    assertP1toP4(r2, VP);
    // a modest drag still respects the floor: the left edge cannot pass 36 even at dx = −10
    const r3 = resizeRect(off, "w", -10, 0, VP);
    expect(r3.x + r3.w).toBe(1300);
  });
});

describe("logic/previewWindowGeom: cascadeRect (§7.3)", () => {
  it("768×900 (评审 example): the offset window is fully visible", () => {
    const vp = vpOf(768, 900, 0);
    const base = defaultRect(vp); // w=752 h=765 at (8, 67.5)
    const next = cascadeRect(base, vp, [base]);
    assertP1toP4(next, vp);
    expect(next).toEqual({ x: 8, y: 8, w: 752, h: 765 }); // the only fully-visible slot
    expect(next.w + next.x).toBeLessThanOrEqual(vp.vw - EDGE);
    expect(next.h + next.y).toBeLessThanOrEqual(vp.vh - EDGE);
  });

  it("768×900: no distinguishable slot ⇒ falls back to the origin (overlap accepted)", () => {
    const vp = vpOf(768, 900, 0);
    const base = defaultRect(vp);
    const occupied: PreviewRect[] = [{ x: 8, y: 8, w: 752, h: 765 }]; // exactly the origin slot
    expect(cascadeRect(base, vp, occupied)).toEqual({ x: 8, y: 8, w: 752, h: 765 });
  });

  it("takes the first base+k·32 candidate that is separated and fully inside", () => {
    const vp = vpOf(1280, 800, 0);
    const base = defaultRect(vp); // (160, 60, 960, 680)
    expect(cascadeRect(base, vp, [base])).toEqual({
      x: base.x + CASCADE,
      y: base.y + CASCADE,
      w: 960,
      h: 680,
    });
    // an occupied window already at +32/+32 pushes it to the origin row (j=0)
    const occupied2 = [base, { x: base.x + CASCADE, y: base.y + CASCADE, w: 960, h: 680 }];
    expect(cascadeRect(base, vp, occupied2)).toEqual({ x: EDGE, y: EDGE, w: 960, h: 680 });
  });

  it("separation is per-axis ≥16 — a window 32px away only in x is a different slot", () => {
    const vp = vpOf(1280, 800, 0);
    const base = defaultRect(vp);
    const near = { x: base.x + 5, y: base.y + 5, w: 400, h: 300 }; // within 16 on both axes
    // candidate +32/+32 is ≥16 away from `near` too (37/37) — still taken
    expect(cascadeRect(base, vp, [base, near])).toMatchObject({ x: base.x + CASCADE, y: base.y + CASCADE });
  });
});

describe("logic/previewWindowGeom: property run (fixed seed, 1000×)", () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("after any move/resize/viewport-shrink sequence P1–P4 always hold", () => {
    const rng = mulberry32(20261021);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
    const dirs = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;
    let vp = vpOf(1280, 800, 0);
    let r = defaultRect(vp);
    for (let i = 0; i < 1000; i++) {
      const op = rng();
      if (op < 0.3) {
        r = moveRect(r, (rng() - 0.5) * 2400, (rng() - 0.5) * 1600, vp);
      } else if (op < 0.65) {
        r = resizeRect(r, pick(dirs), (rng() - 0.5) * 1600, (rng() - 0.5) * 1200, vp);
      } else if (op < 0.97) {
        vp = vpOf(400 + Math.floor(rng() * 1521), 400 + Math.floor(rng() * 801), Math.floor(rng() * 121));
        r = clampRect(r, vp);
      } else {
        r = clampRect({ x: Number.NaN, y: rng(), w: rng(), h: rng() }, vp); // P1 injection
      }
      assertP1toP4(r, vp);
    }
  });

  it("the opposite edge only moves when the P4 translation intervened", () => {
    const rng = mulberry32(20261021);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
    const dirs = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;
    let vp = vpOf(1280, 800, 0);
    let r = defaultRect(vp);
    for (let i = 0; i < 1000; i++) {
      const dir = pick(dirs);
      const dx = Math.floor((rng() - 0.5) * 1600);
      const dy = Math.floor((rng() - 0.5) * 1200);
      const start = r;
      const final = resizeRect(r, dir, dx, dy, vp);
      assertP1toP4(final, vp);
      // P4's min(max(…)) moves an axis only by landing EXACTLY on one of its bounds, so a
      // final coordinate STRICTLY inside the P4 window proves P4 never moved that axis — a
      // detector built from the output + the constraint table alone, with NO replica of the
      // implementation under test (rework #2: the old per-axis reference was circular).
      const p4QuietX = final.x > TITLE_KEEP_X - final.w && final.x < vp.vw - TITLE_KEEP_X;
      const p4QuietY = final.y > vp.top && final.y < vp.vh - TITLE_H;
      if (p4QuietX) {
        // the dragged edge may move; the OPPOSITE edge must stay byte-fixed on that axis
        if (dir.includes("w")) {
          expect(final.x + final.w, `iter ${i} dir ${dir}: right edge moved w/o P4`).toBe(start.x + start.w);
        }
        if (dir.includes("e")) {
          expect(final.x, `iter ${i} dir ${dir}: left edge moved w/o P4`).toBe(start.x);
        }
        if (!dir.includes("w") && !dir.includes("e")) {
          expect(final.x, `iter ${i} dir ${dir}: x moved w/o P4`).toBe(start.x);
          expect(final.x + final.w, `iter ${i} dir ${dir}: w changed w/o P4`).toBe(start.x + start.w);
        }
      }
      if (p4QuietY) {
        if (dir.includes("n")) {
          expect(final.y + final.h, `iter ${i} dir ${dir}: bottom edge moved w/o P4`).toBe(start.y + start.h);
        }
        if (dir.includes("s")) {
          expect(final.y, `iter ${i} dir ${dir}: top edge moved w/o P4`).toBe(start.y);
        }
        if (!dir.includes("n") && !dir.includes("s")) {
          expect(final.y, `iter ${i} dir ${dir}: y moved w/o P4`).toBe(start.y);
          expect(final.y + final.h, `iter ${i} dir ${dir}: h changed w/o P4`).toBe(start.y + start.h);
        }
      }
      r = final;
      if (rng() < 0.2) {
        vp = vpOf(400 + Math.floor(rng() * 1521), 400 + Math.floor(rng() * 801), Math.floor(rng() * 121));
        r = clampRect(r, vp);
        assertP1toP4(r, vp);
      }
    }
  });
});

describe("previewWindowGeom — maximizedRect (2026-10-22 L1 桌面最大化/恢复)", () => {
  it("fills the usable box: EDGE inset from the sides and from the topbar's bottom edge", () => {
    const vp = vpOf(1280, 800, 40);
    const r = maximizedRect(vp);
    expect(r).toEqual({ x: EDGE, y: 40 + EDGE, w: 1280 - 2 * EDGE, h: 800 - 40 - 2 * EDGE });
    // by construction it satisfies every clamp constraint (it IS the P3 ceiling box)
    assertP1toP4(r, vp);
    expect(clampRect(r, vp)).toEqual(r); // idempotent through the clamp
  });

  it("degrades on a tiny viewport instead of contradicting P2/P3 (top-heavy viewports)", () => {
    const vp = vpOf(300, 200, 190); // usable height degenerates
    const r = maximizedRect(vp);
    expect(r).toEqual({ x: EDGE, y: 190 + EDGE, w: 284, h: 0 });
    const clamped = clampRect(r, vp);
    expect(clamped.w).toBeGreaterThanOrEqual(Math.min(MIN_W, 300 - 2 * EDGE));
    expect(clamped.h).toBeGreaterThanOrEqual(Math.min(MIN_H, 200 - 190 - 2 * EDGE));
  });
});

describe("previewWindowGeom — avoidObstacle (2026-10-24 ask-paths fix #1)", () => {
  const r: PreviewRect = { x: 100, y: 100, w: 400, h: 300 };

  it("no intersection ⇒ the cascaded rect is returned unchanged", () => {
    const obstacle: PreviewRect = { x: 900, y: 600, w: 200, h: 100 };
    expect(avoidObstacle(r, obstacle, VP)).toEqual(r);
  });

  it("degenerate / non-finite obstacles are ignored", () => {
    expect(avoidObstacle(r, { x: 100, y: 100, w: 0, h: 0 }, VP)).toEqual(r);
    expect(avoidObstacle(r, { x: Number.NaN, y: 0, w: 100, h: 100 }, VP)).toEqual(r);
  });

  it("prefers the LEFT gap when it fits", () => {
    const obstacle: PreviewRect = { x: 450, y: 100, w: 300, h: 300 }; // overlaps r (100..500 × 100..400)
    const out = avoidObstacle(r, obstacle, VP);
    expect(out).toEqual({ x: 450 - 400 - EDGE, y: 100, w: 400, h: 300 });
    expect(out.x + out.w).toBeLessThanOrEqual(obstacle.x);
  });

  it("falls through to ABOVE when the left gap cannot hold the window", () => {
    // obstacle too close to the left edge for a 400-wide window to sit left of it
    const obstacle: PreviewRect = { x: 300, y: 350, w: 400, h: 150 }; // overlaps r's bottom (y 350 < 400)
    const out = avoidObstacle(r, obstacle, VP);
    expect(out.y + out.h).toBeLessThanOrEqual(obstacle.y);
    expect(out).toEqual({ x: 100, y: 350 - 300 - EDGE, w: 400, h: 300 });
  });

  it("keeps the cascaded rect (overlap allowed) when no side fits", () => {
    // a huge window around a centered obstacle: no side can hold it
    const big: PreviewRect = { x: 50, y: 50, w: 1100, h: 650 };
    const obstacle: PreviewRect = { x: 500, y: 300, w: 200, h: 100 };
    expect(avoidObstacle(big, obstacle, VP)).toEqual(big);
  });

  it("the result always satisfies P1–P4 in the current viewport", () => {
    const vp = vpOf(900, 700, 40);
    const obstacle: PreviewRect = { x: 400, y: 300, w: 200, h: 200 };
    const out = avoidObstacle(r, obstacle, vp);
    assertP1toP4(out, vp);
  });
});
