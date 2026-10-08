import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Scroll-chain guard for the 2026-10 transcript scroll-freeze fix (user report: a wheel/touch
 * gesture over the thinking block or another capped inner region "froze" the page). Root cause:
 * nested vertical scrollers declared `overscroll-behavior: contain`, so once the inner scroller
 * hit its edge the chain stopped (plus browser scroll latching kept the gesture captive).
 *
 * Part 1 pins the CSS ruling textually (same style as quota-pill's CSS ladder tests):
 * - every inner scroller that lives INSIDE the transcript or the detail-header panels must NOT
 *   declare vertical `overscroll-behavior: contain` — the chain must pass to the outer scroller;
 * - the outer `.transcript` itself KEEPS its contain (the chain ends there — never the page);
 * - modal/overlay/drawer/sidebar scrollers KEEP theirs (a modal's scroll must never chain to
 *   the page behind it): the wtdiff dialog body, the ask-user form, the fleet drawer tree, the
 *   agents sidebar list;
 * - the horizontal-only `overscroll-behavior-x: contain` on code `pre` stays (a horizontal pan
 *   must not trigger history-swipe), and no vertical form sneaks into that rule.
 * Part 2 pins the coarse-pointer clamp CSS (`[data-cc="clamped"]` / `[data-cc="expanded"]`),
 * including the code-block exception (horizontal pan preserved, only the vertical axis
 * clamps), and pins the deliberate exclusion of `.md-table-wrap` (horizontal-only, no
 * max-height ⇒ can never scroll vertically, so it is not a nested vertical scroller).
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const STYLES = resolve(REPO_ROOT, "src/web-hub/ui/src/styles");

function readCss(name: string): string {
  return readFileSync(resolve(STYLES, name), "utf8");
}

const transcriptCss = readCss("transcript.css");
const todoCss = readCss("todo.css");
const bashJobsCss = readCss("bash-jobs.css");
const worktreesCss = readCss("worktrees.css");
const diffCss = readCss("diff.css");
const dialogCss = readCss("dialog.css");
const drawerCss = readCss("drawer.css");
const agentsCss = readCss("agents.css");

/** Pulls the declaration block for one `selector { ... }` rule (first match only). Multi-
 *  selector rules pass the selector list comma-separated; the regex allows whitespace around
 *  the comma so a prettier line break inside the selector list still matches. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector
    .split(",")
    .map((part) => part.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*,\\s*");
  const m = new RegExp(escaped + "\\s*\\{([^}]*)\\}").exec(css);
  if (m === null) throw new Error(`rule not found in CSS: ${selector}`);
  return m[1]!;
}

/** Strips block comments from a rule body so EXPLANATORY prose (which legitimately mentions
 *  `overscroll-behavior` while documenting why the declaration is gone) can't trip the
 *  declaration-level assertions below. */
function declBody(css: string, selector: string): string {
  return ruleBody(css, selector).replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("inner scrollers no longer trap the scroll chain (scroll-freeze fix, part 1)", () => {
  it("transcript-inner capped regions declare no overscroll-behavior at all", () => {
    expect(declBody(transcriptCss, ".thinking-text")).not.toContain("overscroll-behavior");
    expect(declBody(transcriptCss, ".tool-section .pre")).not.toContain("overscroll-behavior");
    expect(declBody(transcriptCss, ".diff")).not.toContain("overscroll-behavior");
    // the codeblock pre's own rule (max-height 420px) — its horizontal contain lives in the
    // separate shared `.codeblock pre, .pre` rule, pinned further down
    expect(declBody(transcriptCss, ".codeblock pre")).not.toContain("overscroll-behavior");
  });

  it("detail-header panel scrollers (todo / bash-jobs / worktrees / wtdiff in-panel list) likewise", () => {
    expect(declBody(todoCss, ".todo-list")).not.toContain("overscroll-behavior");
    expect(declBody(bashJobsCss, ".bj-list")).not.toContain("overscroll-behavior");
    expect(declBody(bashJobsCss, ".bj-tail")).not.toContain("overscroll-behavior");
    expect(declBody(worktreesCss, ".wt-list")).not.toContain("overscroll-behavior");
    expect(declBody(diffCss, ".wtd-file-list.is-tall")).not.toContain("overscroll-behavior");
  });

  it("the outer .transcript KEEPS its contain — the chain must end at the transcript, never the page", () => {
    expect(ruleBody(transcriptCss, ".transcript")).toContain("overscroll-behavior: contain");
  });

  it("modal/overlay/drawer/sidebar scrollers keep theirs (a modal scroll never chains to the page)", () => {
    expect(ruleBody(diffCss, ".wtd-body")).toContain("overscroll-behavior: contain"); // wtdiff DIALOG body
    expect(ruleBody(dialogCss, ".ask-user-form")).toContain("overscroll-behavior: contain");
    expect(ruleBody(drawerCss, ".tree-scroll")).toContain("overscroll-behavior: contain");
    expect(ruleBody(agentsCss, ".agent-list")).toContain("overscroll-behavior: contain");
  });

  it("code keeps the horizontal-only contain (history-swipe guard) and gains no vertical form", () => {
    const pre = declBody(transcriptCss, ".codeblock pre, .pre");
    expect(pre).toContain("overscroll-behavior-x: contain");
    expect(pre).not.toMatch(/overscroll-behavior\s*:/);
  });
});

describe("coarse-pointer clamp CSS exists and is coarse-only (scroll-freeze fix, part 2)", () => {
  const coarseIdx = transcriptCss.indexOf("@media (pointer: coarse)");
  const coarseBlock = coarseIdx >= 0 ? transcriptCss.slice(coarseIdx) : "";

  it("the clamp states live inside the @media (pointer: coarse) block, nowhere before it", () => {
    expect(coarseIdx).toBeGreaterThanOrEqual(0);
    expect(coarseBlock).toContain('[data-cc="clamped"]');
    expect(coarseBlock).toContain('[data-cc="expanded"]');
    // desktop (fine pointer) keeps plain inner scrolling: no data-cc selectors outside the block
    expect(transcriptCss.slice(0, coarseIdx)).not.toContain("[data-cc=");
  });

  it("clamped = overflow hidden with a fade; expanded = cap lifted so content flows with the page", () => {
    expect(coarseBlock).toContain("overflow: hidden");
    expect(coarseBlock).toContain("max-height: none");
    expect(coarseBlock).toContain("linear-gradient"); // the bottom fade
    expect(coarseBlock).toContain("pointer-events: none"); // the fade never eats a tap
  });

  it("code blocks keep their horizontal pan: only the vertical axis clamps, code is never force-wrapped", () => {
    const clamped = ruleBody(transcriptCss, '.codeblock pre[data-cc="clamped"]');
    expect(clamped).toContain("overflow-y: hidden");
    expect(clamped).not.toContain("overflow-x"); // base `overflow-x: auto` untouched (never hidden, never visible-only)
    expect(ruleBody(transcriptCss, '.codeblock pre[data-cc="expanded"]')).toContain("max-height: none");
    // the fade rides the NON-scrolling `.codeblock` wrapper (an abspos child of the panning
    // pre would scroll away) and blends into the block's sunken background
    expect(ruleBody(transcriptCss, '.codeblock[data-cc="clamped"]')).toContain("position: relative");
    expect(ruleBody(transcriptCss, '.codeblock[data-cc="clamped"]::after')).toContain("--c-sunken");
  });

  it("exclusion pin: .md-table-wrap is horizontal-only (no max-height) — never a nested vertical scroller", () => {
    expect(declBody(transcriptCss, ".md-table-wrap")).toContain("overflow-x: auto");
    expect(declBody(transcriptCss, ".md-table-wrap")).not.toContain("max-height");
    expect(declBody(transcriptCss, ".md-table-wrap")).not.toContain("overflow-y");
  });
});
