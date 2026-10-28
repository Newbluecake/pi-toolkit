import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Text-level CSS assertions for the running tool-card ring (2026-10-28 贴合/粗糙 rework).
 * No layout engine runs in vitest — these pin the SOURCE contracts (band placement, radius
 * strategy, motion parameters, reduced-motion fallback); the pixel-level fit was verified in
 * real Chromium via playwright screenshots (/tmp/breath/, 3× device scale, edge-band scans).
 */
const css = readFileSync("src/web-hub/ui/src/styles/transcript.css", "utf8");

const rule = (sel: string): string => {
  const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.()>:*[\]"=]/g, "\\$&")} \\{([^}]*)\\}`));
  expect(m, sel).not.toBeNull();
  return m![1]!;
};

/** slice a `{ ... }` block (nested-brace aware) starting right after `anchor` */
const blockAfter = (anchor: string): string => {
  const start = css.indexOf(anchor);
  expect(start, anchor).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced block after ${anchor}`);
};

describe("running tool-card ring (text-level CSS invariants)", () => {
  it("the ring is painted on the card's own border band (pixel-fit with the static border)", () => {
    const running = rule('.tool[data-st="running"]');
    // transparent 1px border keeps the band; the gradient clipped to border-box shows through it
    expect(running).toContain("border-color: transparent");
    expect(running).toMatch(/linear-gradient\(var\(--c-surface\), var\(--c-surface\)\) padding-box/);
    expect(running).toMatch(/0 0 \/ 300% 100% border-box/);
    // the ring colors are token-derived, no hard-coded rgba
    expect(running).toContain("color-mix(in srgb, var(--st-tool) 35%, var(--c-border))");
    // candidate A motion: 2.4s sweep with ease-in-out-ish cubic-bezier (was 1.6s linear)
    expect(running).toMatch(/animation:\s*transcript-ring-sweep 2\.4s cubic-bezier\(0\.45, 0, 0\.55, 1\) infinite/);
    // softened, widened peak (was a hard 100% --st-tool stripe at 35/50/65%)
    expect(running).toContain("color-mix(in srgb, var(--st-tool) 72%, var(--tool-ring-base))");
  });

  it("the old padding-box mask overlay is gone (it sat 1px inside the border band)", () => {
    expect(css).not.toContain("-webkit-mask-composite");
    expect(css).not.toContain("content-box exclude");
    expect(css).not.toContain("calc(var(--r-md) - 1px)");
    expect(css).not.toContain('.tool[data-st="running"]:has(> .tool-head > .tool-progress)');
    // ToolCard.vue still renders the span; it must never lay out (flex-gap side effect)
    expect(rule(".tool-progress")).toMatch(/display:\s*none/);
  });

  it("sweep keyframes position BOTH background layers (list-valued interpolation)", () => {
    const kf = blockAfter("@keyframes transcript-ring-sweep");
    expect(kf).toMatch(/from\s*\{\s*background-position:\s*0 0,\s*100% 0/);
    expect(kf).toMatch(/to\s*\{\s*background-position:\s*0 0,\s*0% 0/);
  });

  it("prefers-reduced-motion keeps a static ring on the border band (no sweep)", () => {
    const media = blockAfter("@media (prefers-reduced-motion: reduce)");
    const m = media.match(/\.tool\[data-st="running"\] \{([^}]*)\}/);
    expect(m, "reduced-motion running rule").not.toBeNull();
    expect(m![1]).toContain("animation: none");
    expect(m![1]).toContain("linear-gradient(var(--tool-ring-base), var(--tool-ring-base)) border-box");
    // the legacy overlay rule no longer carries the fallback
    expect(media).not.toContain(".tool-progress");
  });
});
