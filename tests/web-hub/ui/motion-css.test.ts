/**
 * `src/web-hub/ui/motion-css.ts` — the build-time motion-preference CSS rewrite (2026-10,
 * `pwh_motion`). Unit tests over fixture CSS plus a standing pass over EVERY real stylesheet:
 * after the transform no un-prefixed reduce rule may remain, and every reduce media block
 * must match the exact simple shape the transform supports (compound / inverted /
 * no-preference shapes are deliberately NOT rewritten — see the module header — so authoring
 * one must fail here loudly instead of silently mis-transforming).
 */
import { globSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import {
  MOTION_FORCE_PREFIX,
  MOTION_KEEP_PREFIX,
  motionPrefCssPlugin,
  rewriteMotionCss,
} from "../../../src/web-hub/ui/motion-css.js";

const STYLES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/web-hub/ui/src/styles");

describe("rewriteMotionCss — fixture CSS", () => {
  it("guards in-media selectors and emits forced copies outside the media, in order", () => {
    const out = rewriteMotionCss(`.a { animation: x 1s; }
@media (prefers-reduced-motion: reduce) {
  .a { animation: none; }
}
.later { color: blue; }`);
    // in-media: guarded selector inside the (still present) media query
    expect(out).toContain(`@media (prefers-reduced-motion: reduce) {\n  ${MOTION_KEEP_PREFIX} .a {`);
    // forced copy: AFTER the media block, outside it, before the later rule
    const mediaEnd = out.indexOf("}");
    const forcedAt = out.indexOf(`${MOTION_FORCE_PREFIX} .a {`);
    const laterAt = out.indexOf(".later");
    expect(forcedAt).toBeGreaterThan(mediaEnd);
    expect(forcedAt).toBeLessThan(laterAt);
    expect(out).toContain(`${MOTION_FORCE_PREFIX} .a { animation: none; }`); // clone keeps the source formatting
  });

  it("prefixes every part of a selector list (pseudo-elements included), preserves !important", () => {
    const out = rewriteMotionCss(`@media (prefers-reduced-motion: reduce) {
  .dot::after,
  .dot-live::after,
  .spin {
    animation: none !important;
  }
}`);
    expect(out).toContain(
      `${MOTION_KEEP_PREFIX} .dot::after, ${MOTION_KEEP_PREFIX} .dot-live::after, ${MOTION_KEEP_PREFIX} .spin`,
    );
    expect(out).toContain(
      `${MOTION_FORCE_PREFIX} .dot::after, ${MOTION_FORCE_PREFIX} .dot-live::after, ${MOTION_FORCE_PREFIX} .spin`,
    );
    expect(out).toContain("animation: none !important");
    expect(out.match(/animation: none !important/g)).toHaveLength(2); // in-media + forced
  });

  it("replaces a bare :root selector instead of descendant-prefixing it (tokens.css shape)", () => {
    const out = rewriteMotionCss(`:root { --dur-fast: 80ms; }
@media (prefers-reduced-motion: reduce) {
  :root {
    --dur-fast: 0ms;
    --dur-base: 0ms;
  }
}`);
    expect(out).toContain(`  ${MOTION_KEEP_PREFIX} {`);
    expect(out).toContain(`${MOTION_FORCE_PREFIX} {`);
    expect(out).not.toContain(`${MOTION_KEEP_PREFIX} :root`);
    expect(out).not.toContain(`${MOTION_FORCE_PREFIX} :root`);
  });

  it("descends into nested at-rules (@supports) in BOTH copies", () => {
    const out = rewriteMotionCss(`@media (prefers-reduced-motion: reduce) {
  @supports (display: grid) {
    .b { animation: none; }
  }
}`);
    // in-media copy keeps the @supports wrapper with the guarded rule inside
    expect(out).toContain(
      `@media (prefers-reduced-motion: reduce) {\n  @supports (display: grid) {\n    ${MOTION_KEEP_PREFIX} .b {`,
    );
    // forced copy keeps the @supports wrapper too, outside the media
    const mediaIdx = out.lastIndexOf("@media");
    const forcedIdx = out.indexOf(`${MOTION_FORCE_PREFIX} .b {`);
    expect(forcedIdx).toBeGreaterThan(mediaIdx);
    expect(out.slice(forcedIdx - 40, forcedIdx)).toContain("@supports");
  });

  it("a media-type prefix (`screen and`) is still the simple shape and IS rewritten", () => {
    const out = rewriteMotionCss(`@media screen and (prefers-reduced-motion: reduce) {
  .g { animation: none; }
}`);
    expect(out).toContain(`${MOTION_KEEP_PREFIX} .g {`);
    expect(out).toContain(`${MOTION_FORCE_PREFIX} .g {`);
  });

  it("already-rewritten selectors pass through unchanged (idempotence guard, no double prefix)", () => {
    const out = rewriteMotionCss(
      `@media (prefers-reduced-motion: reduce) {\n  ${MOTION_KEEP_PREFIX} .spin { animation: none; }\n}`,
    );
    expect(out.match(new RegExp(MOTION_KEEP_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(2);
    expect(out).not.toContain(`${MOTION_KEEP_PREFIX} ${MOTION_KEEP_PREFIX}`);
  });

  it("an empty / comment-only media block emits no dead forced clones", () => {
    const out = rewriteMotionCss(`@media (prefers-reduced-motion: reduce) {\n  /* nothing */\n}\n.z{}`);
    expect(out).not.toContain(MOTION_FORCE_PREFIX);
    expect(out).toContain("/* nothing */");
  });

  it("deliberately-unsupported shapes are left untouched", () => {
    const css = `@media (prefers-reduced-motion: no-preference) { .d { animation: x; } }
@media (min-width: 480px) and (prefers-reduced-motion: reduce) { .e { animation: none; } }
@media not (prefers-reduced-motion: reduce) { .f { animation: none; } }
@media (max-width: 480px) { .w { color: red; } }`;
    expect(rewriteMotionCss(css)).toBe(css);
  });
});

describe("motionPrefCssPlugin — runs through real postcss", () => {
  it("is an accepted postcss plugin and applies the same rewrite", async () => {
    const result = await postcss([motionPrefCssPlugin()]).process(
      `@media (prefers-reduced-motion: reduce) {\n  .a { animation: none; }\n}`,
      { from: undefined },
    );
    expect(result.css).toContain(`${MOTION_KEEP_PREFIX} .a {`);
    expect(result.css).toContain(`${MOTION_FORCE_PREFIX} .a {`);
  });
});

// -------------------------------------------------------------------------------------------------
// The standing whole-stylesheets pass: run the REAL transform over every real stylesheet and
// assert (a) no un-prefixed reduce rule survives, (b) every forced copy sits OUTSIDE the media
// block, (c) every reduce media in the SOURCE matches the exact supported simple shape, and
// (d) no `no-preference` query exists anywhere (unsupported by design — see the module header).
// -------------------------------------------------------------------------------------------------

const REDUCE_MEDIA_RE = /^(?:(?:only\s+)?(?:screen|all)\s+and\s+)?\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)$/i;

function isReduceMedia(params: string): boolean {
  return REDUCE_MEDIA_RE.test(params.trim());
}

function hasReduceMediaAncestor(node: postcss.Node): boolean {
  for (let p = node.parent; p !== undefined; p = p.parent) {
    if (p.type === "atrule" && (p as postcss.AtRule).name === "media" && isReduceMedia((p as postcss.AtRule).params)) {
      return true;
    }
  }
  return false;
}

describe("rewriteMotionCss over the real stylesheets", () => {
  const files = globSync("*.css", { cwd: STYLES_DIR })
    .map((f) => resolve(STYLES_DIR, f))
    .sort();

  it("found the stylesheets (glob-failure canary) and at least one reduce block to rewrite", () => {
    expect(files.length).toBeGreaterThan(10);
    const reduceFiles = files.filter((f) => /prefers-reduced-motion:\s*reduce/.test(readFileSync(f, "utf8")));
    expect(reduceFiles.length).toBeGreaterThanOrEqual(9);
  });

  it("no un-prefixed reduce rule remains; forced copies are outside every reduce media", () => {
    const problems: string[] = [];
    let rewritten = 0;
    for (const file of files) {
      const name = file.split("/").pop()!;
      const original = readFileSync(file, "utf8");
      if (!/prefers-reduced-motion/.test(original)) continue;
      const out = rewriteMotionCss(original);
      const parsed = postcss.parse(out);
      parsed.walkAtRules("media", (m) => {
        if (!isReduceMedia(m.params)) return;
        // (a) every rule inside a reduce media carries the keep-guard
        m.walkRules((r) => {
          const first = r.selector.split(",")[0]!.trim();
          if (first !== MOTION_KEEP_PREFIX && !first.startsWith(`${MOTION_KEEP_PREFIX} `)) {
            problems.push(`${name}: un-prefixed reduce rule "${r.selector}"`);
          }
        });
      });
      // (b) forced prefixes never appear under a reduce media
      parsed.walkRules((r) => {
        if (r.selector.includes(MOTION_FORCE_PREFIX) && hasReduceMediaAncestor(r)) {
          problems.push(`${name}: forced copy inside the reduce media "${r.selector}"`);
        }
      });
      // every original reduce media produced at least one forced copy
      const reduceCount = (original.match(/prefers-reduced-motion:\s*reduce/g) ?? []).length;
      const forcedCount = (out.match(/\[data-motion="off"\]/g) ?? []).length;
      if (forcedCount < reduceCount)
        problems.push(`${name}: ${forcedCount} forced prefixes < ${reduceCount} reduce medias`);
      // (c) source shape canary: every reduce media in the SOURCE is the exact simple shape
      postcss.parse(original).walkAtRules("media", (m) => {
        if (/prefers-reduced-motion:\s*reduce/.test(m.params) && !isReduceMedia(m.params)) {
          problems.push(`${name}: unsupported compound/inverted reduce media "${m.params.trim()}"`);
        }
        if (hasReduceMediaAncestor(m)) problems.push(`${name}: reduce media nested in a reduce media`);
      });
      // (d) no-preference canary: unsupported by the transform by design
      if (/prefers-reduced-motion:\s*no-preference/.test(original)) {
        problems.push(`${name}: prefers-reduced-motion: no-preference is unsupported (see motion-css.ts)`);
      }
      rewritten++;
    }
    expect(problems, problems.join("; ")).toEqual([]);
    expect(rewritten).toBeGreaterThanOrEqual(9); // the canary above found them; here they were all rewritten
  });

  it("non-reduce rules keep their selectors byte-identical (only reduce blocks change)", () => {
    for (const file of files) {
      const original = readFileSync(file, "utf8");
      if (!/prefers-reduced-motion:\s*reduce/.test(original)) continue;
      const name = file.split("/").pop()!;
      const outsideSelectors = (root: postcss.Root): string[] => {
        const list: string[] = [];
        root.walkRules((r) => {
          if (!hasReduceMediaAncestor(r) && !r.selector.includes("data-motion")) list.push(r.selector);
        });
        return list;
      };
      const before = outsideSelectors(postcss.parse(original));
      const after = outsideSelectors(postcss.parse(rewriteMotionCss(original)));
      expect(after, name).toEqual(before);
    }
  });
});
