// @vitest-environment node
/**
 * worktree-graph plan v2 §7 P5 — `graph-tokens-contrast`: parse `styles/tokens.css`'s THREE
 * theme blocks (light `:root`, system-dark `@media (prefers-color-scheme: dark) { :root:not
 * (.theme-light) }`, forced-dark `:root.theme-dark`) and verify §4.3's contrast gates:
 * - chip TEXT `--gg-chip-fg-*` ≥ 4.5:1 against its OWN chip background `--gg-chip-bg-*`
 *   (head/branch/remote/tag);
 * - lane LINE colors `--gg-lane-0..7` ≥ 3:1 against `--c-surface` (the panel surface the
 *   graph sits on).
 * The two chip tokens that reference other tokens (`--gg-chip-fg-head: var(--c-on-primary-
 * soft)`) are resolved through the same block's definitions — the test mirrors the cascade
 * for these named references only (no `var()` arithmetic exists in the graph set).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TOKENS = readFileSync(
  resolve(fileURLToPath(new URL("../../../src/web-hub/ui/src/styles", import.meta.url)), "tokens.css"),
  "utf8",
);

/** One theme block's declarations, `--name: value` pairs in source order. */
function declarationsOf(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(`--${m[1]}`, m[2]!.trim());
  }
  return out;
}

/** The three theme blocks: light (`:root {…}` first), system-dark, forced-dark. */
function themeBlocks(): { name: string; decls: Map<string, string> }[] {
  const light = /:root\s*\{([\s\S]*?)\n\}/.exec(TOKENS);
  const sysDark =
    /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\.theme-light\)\s*\{([\s\S]*?)\n\s*\}\n\}/.exec(TOKENS);
  const forcedDark = /:root\.theme-dark\s*\{([\s\S]*?)\n\}/.exec(TOKENS);
  if (light === null || sysDark === null || forcedDark === null) {
    throw new Error("failed to locate the three theme blocks in tokens.css");
  }
  return [
    { name: "light (:root)", decls: declarationsOf(light[1]!) },
    { name: "system-dark", decls: declarationsOf(sysDark[1]!) },
    { name: "forced-dark (.theme-dark)", decls: declarationsOf(forcedDark[1]!) },
  ];
}

/** Resolve a token value through the block: `var(--x)` chains (1 level is all the graph set
 *  uses), `rgb(…)` / 3/6-digit hex → linear-ish [r,g,b]. */
function resolveColor(decls: Map<string, string>, name: string): [number, number, number] {
  let value = decls.get(name);
  if (value === undefined) throw new Error(`token ${name} missing from this theme block`);
  for (let i = 0; i < 4; i++) {
    const v = value!.trim();
    const varRef = /^var\((--[a-z0-9-]+)\)$/i.exec(v);
    if (varRef === null) break;
    value = decls.get(varRef[1]!);
    if (value === undefined) throw new Error(`${name} references missing ${varRef[1]}`);
  }
  const v = value!.trim();
  const hex3 = /^#([0-9a-f]{3})$/i.exec(v);
  if (hex3 !== null) {
    const s = hex3[1]!;
    return [parseInt(s[0]! + s[0]!, 16), parseInt(s[1]! + s[1]!, 16), parseInt(s[2]! + s[2]!, 16)];
  }
  const hex6 = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex6 !== null) {
    const s = hex6[1]!;
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*[\d.]+\s*)?\)$/.exec(v);
  if (rgb !== null) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  throw new Error(`unparsable color for ${name}: ${v}`);
}

/** WCAG 2.x relative luminance + contrast ratio. */
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const fmt = (r: number): string => r.toFixed(2);

describe("graph tokens contrast (worktree-graph plan v2 §4.3/§7 P5)", () => {
  const themes = themeBlocks();

  it("parses all three theme blocks and finds the full graph token set in each", () => {
    expect(themes).toHaveLength(3);
    for (const { name, decls } of themes) {
      for (let i = 0; i < 8; i++) expect(decls.has(`--gg-lane-${i}`), `${name} lane ${i}`).toBe(true);
      for (const kind of ["head", "branch", "remote", "tag"]) {
        expect(decls.has(`--gg-chip-fg-${kind}`), `${name} chip fg ${kind}`).toBe(true);
        expect(decls.has(`--gg-chip-bg-${kind}`), `${name} chip bg ${kind}`).toBe(true);
      }
      expect(decls.has("--c-surface"), name).toBe(true);
    }
  });

  it("chip text ≥ 4.5:1 against its own chip background, all kinds, all three themes", () => {
    const failures: string[] = [];
    for (const { name, decls } of themes) {
      for (const kind of ["head", "branch", "remote", "tag"]) {
        const fg = resolveColor(decls, `--gg-chip-fg-${kind}`);
        const bg = resolveColor(decls, `--gg-chip-bg-${kind}`);
        const ratio = contrast(fg, bg);
        if (ratio < 4.5) failures.push(`${name} ${kind}: ${fmt(ratio)}:1`);
      }
    }
    expect(failures.join("; ")).toBe("");
  });

  it("lane line colors ≥ 3:1 against --c-surface, all 8 lanes, all three themes", () => {
    const failures: string[] = [];
    for (const { name, decls } of themes) {
      const surface = resolveColor(decls, "--c-surface");
      for (let i = 0; i < 8; i++) {
        const lane = resolveColor(decls, `--gg-lane-${i}`);
        const ratio = contrast(lane, surface);
        if (ratio < 3) failures.push(`${name} lane ${i}: ${fmt(ratio)}:1`);
      }
    }
    expect(failures.join("; ")).toBe("");
  });

  it("merged-plan §7.4: --gg-lane-landed present in all three themes; opaque dot ≥3:1 AND route (stroke-opacity .85 composited onto --c-surface) ≥3:1", () => {
    const failures: string[] = [];
    for (const { name, decls } of themes) {
      if (!decls.has("--gg-lane-landed")) {
        failures.push(`${name}: --gg-lane-landed missing`);
        continue;
      }
      const landed = resolveColor(decls, "--gg-lane-landed");
      const surface = resolveColor(decls, "--c-surface");
      const direct = contrast(landed, surface); // the dot is opaque
      if (direct < 3) failures.push(`${name} dot: ${fmt(direct)}:1`);
      // the route paints at stroke-opacity .85 (graph.css `.gg-route path`) over the surface
      const composited = landed.map((c, i) => Math.round(0.85 * c + 0.15 * surface[i]!)) as [number, number, number];
      const route = contrast(composited, surface);
      if (route < 3) failures.push(`${name} route@.85: ${fmt(route)}:1`);
    }
    expect(failures.join("; ")).toBe("");
  });

  it("the graph css + lazy component exist and reference the tokens (wiring canary)", () => {
    const graphCss = readFileSync(
      resolve(fileURLToPath(new URL("../../../src/web-hub/ui/src/styles", import.meta.url)), "graph.css"),
      "utf8",
    );
    expect(graphCss).toContain("--gg-lane-0");
    expect(graphCss).toContain("--gg-chip-fg-head");
    // the lazy chunk owns graph.css — the MAIN panel stylesheet must not pull it in
    const worktreesCss = readFileSync(
      resolve(fileURLToPath(new URL("../../../src/web-hub/ui/src/styles", import.meta.url)), "worktrees.css"),
      "utf8",
    );
    expect(worktreesCss).not.toContain("graph.css");
    expect(worktreesCss).not.toContain("--gg-lane-");
  });
});
