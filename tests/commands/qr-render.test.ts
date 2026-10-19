// feishu-bot plan v2 §9 (F9): terminal half-block QR rendering (src/commands/qr-render.ts).
// Same renderer the F-probe used (OpenCV-verified); the glyphs are deliberately INVERTED
// (light modules render as solid blocks) so dark terminals scan reliably.

import { describe, expect, it } from "vitest";
import { renderQr } from "../../src/commands/qr-render.js";
import { PI_WIDGET_MAX_LINES, qrFitsWidget } from "../../src/commands/webhub.js";

const GLYPH_RE = /^[█▀▄ ]+$/;

describe("renderQr", () => {
  it("emits ceil((size+8)/2) equal-width lines over the four block glyphs only", () => {
    const text = "https://open.feishu.cn/page/launcher?user_code=ABCDEF1234";
    const out = renderQr(text);
    const lines = out.split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => GLYPH_RE.test(l))).toBe(true);
    const width = lines[0]!.length;
    expect(lines.every((l) => l.length === width)).toBe(true);
    // v4 (57-byte URL ⇒ size 33) with quiet zone 4 ⇒ width 41, height ceil(41/2) = 21
    expect(width).toBe(33 + 8);
    expect(lines.length).toBe(21);
  });

  it("renders the four-module quiet zone as solid blocks (inverted rendering)", () => {
    const lines = renderQr("HELLO").split("\n");
    // quiet rows 0..3 (top) are all-light ⇒ all-solid on both half-rows of every line that
    // stays inside the zone; the FIRST line covers matrix rows -4/-3, entirely quiet zone.
    expect(lines[0]).toBe("█".repeat(21 + 8));
    // left quiet columns within a mid line: positions 0..3 are both-half light ⇒ "█"
    const mid = lines[Math.floor(lines.length / 2)]!;
    expect(mid.slice(0, 4)).toBe("████");
  });

  it("contains dark modules in the code area (not all-solid)", () => {
    const lines = renderQr("https://open.feishu.cn/page/launcher?user_code=ABCDEF1234").split("\n");
    const joined = lines.join("");
    expect(joined.includes(" ")).toBe(true); // a dark module pair renders as blank
    expect(joined).not.toBe("█".repeat(joined.length));
  });

  it("is deterministic and stable for the same input", () => {
    expect(renderQr("stable-input")).toBe(renderQr("stable-input"));
    expect(renderQr("stable-input")).not.toBe(renderQr("stable-input-2"));
  });

  it("propagates qr-too-large for oversized payloads (caller must catch and fall back to the URL)", () => {
    expect(() => renderQr("x".repeat(2_954))).toThrow("qr-too-large");
  });

  it("even the smallest QR exceeds pi's string-array widget cap — the component factory is mandatory", () => {
    // v1 (21 modules + quiet zone 4) ⇒ ceil(29/2) = 15 lines; pi's MAX_WIDGET_LINES (string[]
    // content only) is 10, so showQr uses the uncapped component-factory setWidget overload.
    const minimal = renderQr("A").split("\n");
    expect(minimal.length).toBe(15);
    expect(minimal.length).toBeGreaterThan(PI_WIDGET_MAX_LINES);
    expect(qrFitsWidget(24)).toBe(true); // uncapped component path hosts it on a normal terminal
  });

  it("a realistic decorated setup URL renders ~23 lines, far beyond the string-array cap", () => {
    // decorateQrUrl shape: launcher URL + user_code + from=sdk&tp=sdk&source=pi-toolkit&name=pi@<host>
    const url =
      "https://open.feishu.cn/page/launcher?user_code=AB12CD34&from=sdk&tp=sdk&source=pi-toolkit&name=pi@devbox";
    const lines = renderQr(url).split("\n");
    expect(lines.length).toBe(23); // v5 (37 modules + quiet zone 4) ⇒ ceil(45/2) = 23
    expect(lines.length).toBeGreaterThan(PI_WIDGET_MAX_LINES);
    expect(qrFitsWidget(24)).toBe(true);
  });
});
