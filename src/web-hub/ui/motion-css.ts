/**
 * Build-time motion-preference CSS rewrite (2026-10, `pwh_motion` browser pref).
 *
 * Field report: the user's desktop Edge reports `prefers-reduced-motion: reduce` (Windows
 * animation effects off), so EVERY animation in the UI (composer busy breathe, run spinners,
 * dots, carets, skeletons…) is dead — the reduce rules live in ~9 stylesheets under
 * `src/styles/`. The `pwh_motion` browser pref (`"system" | "on" | "off"`, applied as
 * `<html data-motion="on"|"off">`, absent for system — see `public/theme-init.js` and
 * `src/composables/useMotionPref.ts`) gives the user a switch, and this module makes the
 * switchable half of it work WITHOUT touching a single stylesheet: a tiny local PostCSS
 * plugin rewrites every `@media (prefers-reduced-motion: reduce)` block at build time.
 *
 * Rewrite of `@media (prefers-reduced-motion: reduce) { S { … } }`:
 *
 *   1. In-media guard — every selector S (comma-split) becomes
 *      `:root:not([data-motion="on"]) S` (a bare `:root` becomes
 *      `:root:not([data-motion="on"])`). The media query keeps answering the OS question,
 *      but the selector now ALSO requires that the user has not forced animations on — under
 *      `data-motion="on"` the reduce rules stop applying even when the OS requests reduce
 *      (the exact Edge case above).
 *   2. Forced-reduce copy — the media block's children are cloned right after it, OUTSIDE
 *      the media, each selector prefixed `:root[data-motion="off"] ` (bare `:root` →
 *      `:root[data-motion="off"]`). Under `data-motion="off"` the reduce rules apply even
 *      when the OS does NOT request reduce.
 *   3. No attribute (`"system"`) ⇒ the `:not([data-motion="on"])` prefix always matches and
 *      the forced copy never matches — byte-equivalent behavior to the pre-feature media
 *      query, modulo specificity (see below).
 *
 * Specificity note (verified against every stylesheet at write time): the prefixes add one
 * pseudo-class + one attribute selector, so the reduce rules can only WIN MORE OFTEN, never
 * less. Every existing reduce rule targets a selector whose base `animation`/token
 * declaration sits EARLIER in the SAME file (`.spin`, `.caret`, `.skel`, `.composer-input.busy`,
 `:root --dur-*`, … — no later rule anywhere re-defines those properties after a reduce
 * block), and the two `!important` cases (`primitives.css` `.spin`/`.dot::after`,
 * `states.css` `.skel`) have no competing `!important` — so the bump changes no outcome.
 *
 * Deliberate boundary — EXACT simple shape only. `REDUCE_MEDIA_RE` matches
 * `@media (prefers-reduced-motion: reduce)` (optionally `screen and` / `all and` /
 * `only screen and` prefixed). Anything else that merely MENTIONS the feature is left
 * untouched:
 *   - compound queries (`(min-width: 480px) and (prefers-reduced-motion: reduce)`) — a
 *     forced copy outside the media would silently drop the width condition;
 *   - inverted queries (`not (prefers-reduced-motion: reduce)`);
 *   - `prefers-reduced-motion: no-preference` — none exist in this codebase (grepped); under
 *     `data-motion="off"` such a block would have to stop applying, which the current
 *     rewrite does not express.
 * None of these shapes exist in `src/styles/**`; `tests/web-hub/ui/motion-css.test.ts`
 * pins all three canaries against the real stylesheets, so authoring one fails loudly here
 * instead of silently mis-transforming.
 *
 * Dependency note: `postcss` is NOT a new dependency — Vite itself depends on it
 * (`vite@^6` → `postcss@^8.4.43`, hoisted into `node_modules/postcss`), and this module only
 * ever runs at BUILD time (imported from `vite.config.ts`, never from browser code) or in
 * Vitest. Adding it to `package.json` (runtime deps are forbidden; a devDependency would
 * imply a version contract this plugin doesn't need) would duplicate Vite's own guarantee.
 */
import postcss from "postcss";

/**
 * The only media shape this transform rewrites (case-insensitive, whitespace-tolerant).
 * See the "Deliberate boundary" note above for everything deliberately NOT matched.
 */
const REDUCE_MEDIA_RE = /^(?:(?:only\s+)?(?:screen|all)\s+and\s+)?\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)$/i;

/** In-media guard prefix: reduce rules keep applying only unless the user forced motion on. */
export const MOTION_KEEP_PREFIX = ':root:not([data-motion="on"])';
/** Forced-reduce prefix: the out-of-media copy applies only when the user forced motion off. */
export const MOTION_FORCE_PREFIX = ':root[data-motion="off"]';

/** True when a selector was already rewritten (idempotence guard for re-walks/nesting). */
function alreadyRewritten(sel: string): boolean {
  return sel.startsWith(MOTION_KEEP_PREFIX) || sel.startsWith(MOTION_FORCE_PREFIX);
}

/**
 * Comma-split a selector list (top-level commas only — `postcss.list.comma` is bracket- and
 * function-aware) and prefix each part. A bare `:root` is REPLACED by the prefix (prefixing
 * it would yield `:root[data-motion="off"] :root`, which never matches twice over); every
 * other selector — pseudo-elements, combinators, attribute selectors included — is
 * DESCENDANT-prefixed. Already-rewritten parts pass through unchanged.
 */
function prefixSelectorList(selector: string, prefix: string): string {
  return postcss.list
    .comma(selector)
    .map((raw) => {
      const sel = raw.trim();
      if (alreadyRewritten(sel)) return sel;
      if (sel === ":root") return prefix;
      return `${prefix} ${sel}`;
    })
    .join(", ");
}

/** Rewrite every `Rule` under `node` (recursing through nested at-rules like `@supports`).
 * `Container.walkRules` visits DESCENDANTS only, so a bare `Rule` passed directly
 * (the forced clones are exactly that) must prefix ITSELF; comments are not containers at
 * all and are skipped. */
function prefixRulesUnder(node: postcss.Node, prefix: string): void {
  if (node.type === "rule") {
    // `Node.type` is `string` (not a literal union), so narrow by cast after the check.
    const rule = node as postcss.Rule;
    rule.selector = prefixSelectorList(rule.selector, prefix);
    return;
  }
  const c = node as postcss.Container;
  if (typeof c.walkRules === "function")
    c.walkRules((rule) => {
      rule.selector = prefixSelectorList(rule.selector, prefix);
    });
}

/** A reduce-media nested inside another reduce-media is an authoring error this transform
 * refuses to guess at (unrolling it correctly depends on which layer owns which guard) —
 * the stylesheet canary test catches it. */
function hasReduceMediaAncestor(node: postcss.Node): boolean {
  for (let p = node.parent; p !== undefined; p = p.parent) {
    if (
      p.type === "atrule" &&
      (p as postcss.AtRule).name === "media" &&
      REDUCE_MEDIA_RE.test((p as postcss.AtRule).params.trim())
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The transform proper, over an already-parsed root (the PostCSS plugin entry and
 * {@link rewriteMotionCss} both funnel through here; pure in the sense that it only mutates
 * the passed tree). For each matching media block: guard the in-media selectors, then splice
 * forced-reduce clones of the block's children in right after it (document order preserved —
 * the copies only carry declarations cloned from inside the block, so their cascade position
 * after the media block keeps any intra-block order intact).
 */
export function transformMotionCss(root: postcss.Root): void {
  const reduceMedias: postcss.AtRule[] = [];
  root.walkAtRules("media", (m) => {
    if (REDUCE_MEDIA_RE.test(m.params.trim()) && !hasReduceMediaAncestor(m)) reduceMedias.push(m);
  });
  for (const media of reduceMedias) {
    // Clone the children FIRST — the in-media pass below mutates the live rules in place,
    // and cloning after it would inherit the KEEP prefix (which the idempotence guard would
    // then refuse to re-prefix with FORCE).
    const pristine = [...(media.nodes ?? [])].map((child) => child.clone());
    prefixRulesUnder(media, MOTION_KEEP_PREFIX);
    const clones: postcss.ChildNode[] = [];
    let anchor: postcss.ChildNode = media;
    for (const copy of pristine) {
      prefixRulesUnder(copy, MOTION_FORCE_PREFIX);
      clones.push(copy);
      media.parent?.insertAfter(anchor, copy);
      anchor = copy;
    }
    // A rule-less (empty/comment-only) media block only produced dead clones — drop them.
    const hasAnyRule = (n: postcss.Node): boolean => {
      if (n.type === "rule") return true;
      const c = n as postcss.Container;
      return typeof c.walkRules === "function" ? c.some(() => true) : false;
    };
    if (!clones.some(hasAnyRule)) for (const copy of clones) copy.remove();
  }
}

/** Pure string form of {@link transformMotionCss} — parse, transform, stringify. */
export function rewriteMotionCss(css: string): string {
  const parsed = postcss.parse(css);
  transformMotionCss(parsed);
  return parsed.toString();
}

/** Vite `css.postcss.plugins` entry — see the module header for the rewrite contract. */
export function motionPrefCssPlugin(): postcss.Plugin {
  return {
    postcssPlugin: "pwh-motion-pref",
    Once(root: postcss.Root) {
      transformMotionCss(root);
    },
  };
}
