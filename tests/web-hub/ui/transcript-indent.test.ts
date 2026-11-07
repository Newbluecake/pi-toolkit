import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 2026-11-04 「这个缩进感觉太突兀了，可以减少一点缩进距离」: the desktop (≥481px) assistant
 * left indent — avatar column + column gap — was narrowed 40px→30px by shrinking the avatar
 * chip 28→24px and the gap --sp-3(12px)→6px, keeping every message kind on one shared column:
 * `.msg-assistant` / `.msg-custom` / `.msg-cmd` (left avatar) and the mirrored `.msg-user`
 * (right avatar, whose bubble cap compensates chip+gap so the bubble keeps its width).
 *
 * These pins freeze the narrowed geometry AND the untouched mobile side: below 481px the
 * avatar is display:none and every message kind stays the single-column base grid with the
 * --sp-3 column-gap (no effect on one column) — the mobile layout must not move with future
 * desktop tweaks. The strategy stays grid-column/gap only: no negative margin may be bolted
 * onto the body (`.md` / `.msg-main`) to fake a narrower indent.
 */
const css = readFileSync(
  resolve(fileURLToPath(import.meta.url), "../../../../src/web-hub/ui/src/styles/transcript.css"),
  "utf8",
);
/** Top-level (non-indented) rule body — media-query rules are indented and never match. */
const rule = (selector: string): string => {
  const m = new RegExp(`(?:^|\\n)${selector.replace(/[.()>:*[\]"=]/g, "\\$&")} \\{([^}]*)\\}`).exec(css);
  return m?.[1] ?? "";
};
/** Every `@media (min-width: 481px)` block joined (the tablet block + the late .msg-cmd one). */
const tablet = [...css.matchAll(/@media \(min-width: 481px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]!).join("\n");

describe("desktop assistant indent 40px→30px (2026-11-04)", () => {
  it("avatar chip is 24×24 (icon untouched), so column 24px + gap 6px = 30px total", () => {
    const avatar = rule(".avatar");
    expect(avatar).toMatch(/width:\s*24px/);
    expect(avatar).toMatch(/height:\s*24px/);
    // the glyph rides along unchanged inside the smaller chip
    expect(rule(".avatar .icon")).toMatch(/width:\s*15px/);

    const pair = /\.msg-assistant,\s*\n\s*\.msg-custom \{([^}]*)\}/.exec(tablet)?.[1] ?? "";
    expect(pair, "tablet .msg-assistant/.msg-custom override").not.toBe("");
    const chip = /grid-template-columns:\s*(\d+)px/.exec(pair)?.[1];
    const gap = /column-gap:\s*(\d+)px/.exec(pair)?.[1];
    expect(chip, "tablet avatar column width").toBe("24");
    expect(gap, "tablet column gap").toBe("6");
    expect(Number(chip) + Number(gap)).toBe(30);
  });

  it("all four message kinds share the same 24px + 6px column geometry", () => {
    expect(tablet).toMatch(
      /\.msg-assistant,\s*\n\s*\.msg-custom \{\s*grid-template-columns:\s*24px minmax\(0,\s*1fr\);\s*column-gap:\s*6px/,
    );
    expect(tablet).toMatch(/\.msg-cmd \{\s*grid-template-columns:\s*24px minmax\(0,\s*1fr\);\s*column-gap:\s*6px/);
    // mirrored user row (bubble | avatar) + the bubble-cap compensation keeps the bubble width
    expect(tablet).toMatch(/\.msg-user \{[^}]*max-width:\s*calc\(min\(78%,\s*640px\)\s*\+\s*24px\s*\+\s*6px\)/);
    expect(tablet).toMatch(
      /\.msg-user \{[^}]*grid-template-columns:\s*minmax\(0,\s*auto\)\s*24px;\s*column-gap:\s*6px/,
    );
    // identity row centre line follows the 24px chip (base 28px matched the old 28px chip)
    expect(tablet).toMatch(/\n\s*\.msg-head \{\s*min-height:\s*24px/);
  });
});

describe("mobile (≤480px) layout is untouched by the desktop narrowing", () => {
  it("avatar stays display:none and every message kind keeps the single-column base grid", () => {
    expect(rule(".avatar")).toMatch(/display:\s*none/);
    for (const sel of [".msg-assistant", ".msg-custom", ".msg-cmd"]) {
      const base = rule(sel);
      expect(base, sel).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
      expect(base, `${sel} base gap stays the sp-3 token`).toMatch(/column-gap:\s*var\(--sp-3\)/);
      expect(base, `${sel} base gains no tablet geometry`).not.toMatch(/24px|\b6px\b/);
    }
  });

  it("narrowing is grid geometry only — no negative margin on the body to fake the indent", () => {
    for (const sel of [".md", ".msg-main"]) {
      const body = rule(sel);
      expect(body, sel).not.toMatch(/margin-left:\s*-/);
    }
  });
});
