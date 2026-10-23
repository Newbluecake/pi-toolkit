import { existsSync, globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * preview-perf P0 (docs/dev/preview-perf/plan.md §3): the five preview-window geometry vars
 * (`--pw-x/y/w/h/z`) are registered via `@property` with `inherits: false`. Unregistered
 * custom properties inherit, so every drag / activate / resize restyled the ENTIRE window
 * content subtree (~30 ms on a 3.6k-line source view, plan table A). Registration makes one
 * var change restyle the window box only. This file pins the source-level contract:
 *
 *  1. the five registrations exist with the agreed `syntax`/`initial-value` + `inherits:false`
 *     (a plain `@property` without `inherits:false` would silently restore the old behaviour);
 *  2. `var(--pw-*)` is READ only on the window `<section>` itself — a descendant reading an
 *     inherited value would break the moment the vars go non-inherited, so the read sites are
 *     frozen to the two whitelisted rules (desktop `.preview-window.is-floating`, phone band
 *     z-index on the same element);
 *  3. the writers stay value-shaped: `<length>` (`"${r.x}px"`) for x/y/w/h, `<integer>`
 *     (`zOf`) for z. A REGISTERED property falls back to its initial-value on an invalid
 *     value, so a malformed write would silently teleport the window to 0px/0 — these pins
 *     catch that at the source level;
 *  4. when a production bundle exists (`dist/web-hub-ui/`, `npm run build:web`), its CSS must
 *     still carry the five `@property` rules (esbuild/vite must not drop them). Skipped when
 *     no bundle is on disk — `npm test` in CI runs before `build:web`.
 */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (f: string): string => readFileSync(resolve(ROOT, f), "utf8");

const previewCssPath = "src/web-hub/ui/src/styles/preview.css";
const preview = read(previewCssPath);
const layout = read("src/web-hub/ui/src/composables/usePreviewWindowLayout.ts");
const host = read("src/web-hub/ui/src/components/preview/PreviewHost.vue");

/** One `@property <name> { … }` block, tolerant of both prettier and minified formatting. */
function atProperty(css: string, name: string): string {
  return new RegExp(`@property\\s+${name}\\s*\\{[^}]*\\}`).exec(css)?.[0] ?? "";
}

/** One rule body for an exact selector line (leading indentation allowed — media queries). */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{[^}]*\\}`).exec(css)?.[0] ?? "";
}

/** Strip block comments (CSS/JS/Vue) so prose that merely MENTIONS the vars can't trip the scans. */
function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Strip `// …` line comments (the `:` exemption keeps `https://…` strings intact). */
function stripLineComments(src: string): string {
  return src.replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

describe("preview-perf P0: geometry vars registered non-inherited (@property)", () => {
  it("registers --pw-x/y/w/h as <length> and --pw-z as <integer>, all inherits:false", () => {
    for (const name of ["--pw-x", "--pw-y", "--pw-w", "--pw-h"] as const) {
      const block = atProperty(preview, name);
      expect(block, `${name} has an @property registration`).toBeTruthy();
      expect(block).toMatch(/syntax:\s*"<length>"/);
      expect(block).toMatch(/inherits:\s*false/);
      expect(block).toMatch(/initial-value:\s*0px/);
    }
    const z = atProperty(preview, "--pw-z");
    expect(z, "--pw-z has an @property registration").toBeTruthy();
    expect(z).toMatch(/syntax:\s*"<integer>"/);
    expect(z).toMatch(/inherits:\s*false/);
    expect(z).toMatch(/initial-value:\s*0\b/);
  });

  it("var(--pw-*) is read only on the window box itself — no descendant relies on inheritance", () => {
    const css = stripBlockComments(preview);
    // Sanity: both whitelisted rules were actually captured (the selectors still exist).
    const floating = ruleBody(css, ".preview-window.is-floating");
    expect(floating).toMatch(/left:\s*var\(--pw-x\)/);
    expect(floating).toMatch(/top:\s*var\(--pw-y\)/);
    expect(floating).toMatch(/width:\s*var\(--pw-w\)/);
    expect(floating).toMatch(/height:\s*var\(--pw-h\)/);
    expect(floating).toMatch(/z-index:\s*var\(--pw-z\)/);
    const phone = ruleBody(css, ".preview-overlay.is-windows .preview-window");
    expect(phone).toMatch(/z-index:\s*var\(--pw-z\)/);

    // preview.css minus those two rule bodies must not read any --pw-* var…
    const rest = css.replace(floating, "").replace(phone, "");
    expect(rest, "no other preview.css rule reads a --pw-* var").not.toMatch(/var\(--pw-/);

    // …and neither may any other UI source (comments stripped; only code counts).
    const uiSrcDir = "src/web-hub/ui/src";
    const others = globSync(`${uiSrcDir}/**/*.{css,vue,ts,js}`, { cwd: ROOT })
      .filter((f) => resolve(ROOT, f) !== resolve(ROOT, previewCssPath))
      .map((f) => stripLineComments(stripBlockComments(read(f))));
    for (const src of others) {
      expect(src, "var(--pw-*) reads stay inside preview.css's two window-box rules").not.toMatch(/var\(--pw-/);
    }
  });

  it("writers stay <length>/<integer>-shaped (registered props fall back to initial-value on garbage)", () => {
    for (const [key, coord] of [
      ["--pw-x", "x"],
      ["--pw-y", "y"],
      ["--pw-w", "w"],
      ["--pw-h", "h"],
    ] as const) {
      expect(layout, `${key} must be written as "Npx" (a bare <length>) — varsOf's template literal`).toMatch(
        new RegExp('"' + key + '":\\s*`\\$\\{r\\.' + coord + "\\}px`"),
      );
    }
    // z rides zOf(): String(1 + Math.max(0, indexOf)) — always a non-negative integer string.
    expect(host).toMatch(/"--pw-z":\s*zOf\(id\)/);
    expect(host).toMatch(
      /function zOf\(id: number\): string\s*\{\s*return String\(1 \+ Math\.max\(0, order\.value\.indexOf\(id\)\)\);/,
    );
    // And no THIRD writer exists anywhere (both quote styles — the phone template uses '--pw-z').
    const writers = globSync("src/web-hub/ui/src/**/*.{css,vue,ts,js}", { cwd: ROOT }).filter((f) => {
      const src = stripLineComments(stripBlockComments(read(f)));
      return /["']--pw-[a-z]+["']\s*:/.test(src);
    });
    expect(writers.map((f) => resolve(ROOT, f)).sort()).toEqual(
      [
        resolve(ROOT, "src/web-hub/ui/src/composables/usePreviewWindowLayout.ts"),
        resolve(ROOT, "src/web-hub/ui/src/components/preview/PreviewHost.vue"),
      ].sort(),
    );
  });

  const distAssets = resolve(ROOT, "dist/web-hub-ui/assets");
  const distCss = existsSync(distAssets) ? globSync("*.css", { cwd: distAssets }) : [];
  (distCss.length > 0 ? it : it.skip)("shipped bundle keeps the five @property rules (built dist found)", () => {
    const bundle = distCss.map((f) => readFileSync(resolve(distAssets, f), "utf8")).join("\n");
    for (const name of ["--pw-x", "--pw-y", "--pw-w", "--pw-h"] as const) {
      const block = atProperty(bundle, name);
      expect(block, `${name} @property survives the vite/esbuild CSS pipeline`).toBeTruthy();
      expect(block).toMatch(/inherits:\s*false/);
      expect(block).toMatch(/syntax:\s*"<length>"/);
    }
    const z = atProperty(bundle, "--pw-z");
    expect(z, "--pw-z @property survives the vite/esbuild CSS pipeline").toBeTruthy();
    expect(z).toMatch(/inherits:\s*false/);
    expect(z).toMatch(/syntax:\s*"<integer>"/);
  });
});
