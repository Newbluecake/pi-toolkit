/**
 * P4's assertion module for the visual harness (vue-plan.md v2.1 §4.4.2, §5.2, ui-design.md
 * §5.3/§5.4/§6.4/§6.6). Glob-discovered by `scripts/web-hub/visual.ts` (P2, frozen for this
 * package) — this file only ever *adds* a `CheckModule`, never touches the framework.
 *
 * Important limitation (documented, not a bug): `visual.ts`'s scenario matrix
 * (`DEFAULT_SCENARIOS`) drives real pages built from the *current* `dist/web-hub-ui/`, whose
 * `App.vue` may still be P0's placeholder until P3 replaces it (plan §1.1's P0→P3 seam) — so
 * `.fleet`/`#transcript` may not appear in a `dashboard`/`detail`/`long` page yet. Every check
 * below only degrades a missing-target-DOM outcome to an informational **pass**
 * ("skipped (placeholder App)") after confirming via `containsPlaceholderAppMarker` that the
 * mounted app really is still P0's placeholder — exactly the plan's own guidance ("若 App.vue 仍是
 * 占位导致 body 场景无法挂载...勿改 App.vue"). Once P3 (`App.vue` → `DashboardView` →
 * `AgentDetail.vue`) lands, the placeholder marker is gone from the DOM, so the *same*
 * missing-DOM branch now fails instead of silently passing — a real regression can't hide behind
 * this skip once the seam is closed. `PWH_VISUAL_STRICT_BODY=1` bypasses the placeholder check
 * entirely and always fails on missing DOM (for CI/local runs asserting the real P3+ shell is
 * live). The `long` scenario is the one that matters most for §6.6 — its fixture already has a
 * 1000-message deep-linked agent (`tests/fixtures/web-hub-ui/long.json`) ready for the day
 * `#/agent/agent-long` actually renders a transcript.
 *
 * §6.6's "streaming 100 帧/s ⇒ DOM 批次 ≤10/s" is deliberately not re-tested here: that budget is
 * enforced by `useHub.ts`'s `renderGate` (P1, already covered by `render-gate.test.ts`/
 * `render-gate-property.test.ts`) upstream of every component in this package — `Transcript.vue`
 * has no throttling of its own to verify, it just renders whatever `agent` prop it's handed.
 */
import type { CheckContext, CheckModule, CheckOutcome } from "../visual.js";

function pass(name: string, detail?: string): CheckOutcome {
  return detail === undefined ? { name, ok: true } : { name, ok: true, detail };
}

function outcome(name: string, ok: boolean, detail?: string): CheckOutcome {
  return ok ? { name, ok } : { name, ok, detail: detail ?? "failed" };
}

/** The P0 placeholder `App.vue`'s only stable, load-bearing text (vue-plan.md v2.1 §1.1's
 * P0→P3 seam — P3 replaces this file's body wholesale). Used to tell "P3 hasn't landed yet, this
 * page really can't have `.fleet`/`.transcript` DOM" apart from "P3 landed and the DOM is
 * genuinely missing", which must fail instead of pass. */
export const PLACEHOLDER_APP_MARKER = "pi web-hub — UI under construction";

export function containsPlaceholderAppMarker(text: string): boolean {
  return text.includes(PLACEHOLDER_APP_MARKER);
}

/** Forces every missing-DOM branch below to fail hard instead of degrading to a placeholder-App
 * skip — for CI/local runs that want to assert the real P3+ DOM is present. */
export function isStrictBodyMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PWH_VISUAL_STRICT_BODY === "1";
}

async function isPlaceholderApp(ctx: CheckContext): Promise<boolean> {
  const text = await ctx.page.evaluate(() => document.body.textContent ?? "");
  return containsPlaceholderAppMarker(text);
}

/** Resolves what to report when a check's target DOM is absent: strict mode always fails; a
 * confirmed P0 placeholder App degrades to an informational skip; anything else (P3+ landed but
 * the DOM genuinely isn't there) fails. Never a silent pass once App.vue is real. */
async function missingDomOutcome(name: string, ctx: CheckContext, detail: string): Promise<CheckOutcome> {
  if (isStrictBodyMode()) return outcome(name, false, `${detail} (strict mode)`);
  if (await isPlaceholderApp(ctx)) return pass(name, `skipped (placeholder App): ${detail}`);
  return outcome(name, false, detail);
}

/** ui-design.md §6.4/§6.6: the fleet panel starts collapsed (just the summary row) on a <768
 * viewport and expanded at ≥768, and the tree area never exceeds its dvh/vh cap. */
async function checkFleetDefaultOpen(ctx: CheckContext): Promise<CheckOutcome> {
  const has = await ctx.page.evaluate(() => document.querySelector(".fleet") !== null);
  if (!has) return missingDomOutcome("fleet-default-open", ctx, ".fleet not found");
  const result = await ctx.page.evaluate((width: number) => {
    const el = document.querySelector(".fleet") as HTMLDetailsElement | null;
    if (!el) return { present: false, open: false };
    return { present: true, open: el.open, expectOpen: width >= 768 };
  }, ctx.width);
  if (!result.present) return missingDomOutcome("fleet-default-open", ctx, ".fleet not found");
  const ok = result.open === result.expectOpen;
  return outcome("fleet-default-open", ok, `width=${ctx.width} open=${result.open} expected=${result.expectOpen}`);
}

/** ui-design.md §6.6: transcript windowing caps mounted `.tx-item`s at 300 total, 80 on a phone
 * first screen, 200 elsewhere. */
async function checkTranscriptWindowCap(ctx: CheckContext): Promise<CheckOutcome> {
  const has = await ctx.page.evaluate(() => document.querySelector(".transcript") !== null);
  if (!has) return missingDomOutcome("transcript-window-cap", ctx, ".transcript not found");
  const count = await ctx.page.evaluate(() => document.querySelectorAll(".tx-item").length);
  if (count > 300) return outcome("transcript-window-cap", false, `mounted .tx-item=${count} > 300`);
  if (ctx.scenario === "long") {
    const expected = ctx.width <= 480 ? 80 : 200;
    if (count > expected) {
      return outcome(
        "transcript-window-cap",
        false,
        `long scenario, width=${ctx.width}: mounted=${count} > ${expected}`,
      );
    }
  }
  return pass("transcript-window-cap", `mounted=${count}`);
}

/** ui-design.md §6.6: off-screen `.tx-item`s use `content-visibility: auto` to skip layout/paint. */
async function checkContentVisibilityAuto(ctx: CheckContext): Promise<CheckOutcome> {
  const result = await ctx.page.evaluate(() => {
    const el = document.querySelector(".tx-item");
    if (!el) return undefined;
    return getComputedStyle(el).contentVisibility;
  });
  if (result === undefined) return missingDomOutcome("content-visibility-auto", ctx, ".tx-item not found");
  return outcome("content-visibility-auto", result === "auto", `computed content-visibility=${result}`);
}

/** ui-design.md §6.4: long code/tool output scrolls *inside* its own block, never the page. */
async function checkLongContentScrollsWithinBlock(ctx: CheckContext): Promise<CheckOutcome> {
  const result = await ctx.page.evaluate(() => {
    const pre = document.querySelector(".codeblock pre, .tool-section .pre") as HTMLElement | null;
    if (!pre) return undefined;
    return {
      overscroll: getComputedStyle(pre).overscrollBehaviorX || getComputedStyle(pre).overscrollBehavior,
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
  if (result === undefined) {
    return missingDomOutcome("long-content-scrolls-within-block", ctx, ".codeblock pre / .tool-section .pre not found");
  }
  const ok = result.docScrollWidth <= result.innerWidth && result.overscroll.includes("contain");
  return outcome("long-content-scrolls-within-block", ok, JSON.stringify(result));
}

/** ui-design.md §6.3/§6.4: no interactive fleet-row/tool-card element depends on a `title=`
 * tooltip (hover-only affordances are banned repo-wide, not just in P3's shell). */
async function checkNoTitleTooltips(ctx: CheckContext): Promise<CheckOutcome> {
  const count = await ctx.page.evaluate(
    () => document.querySelectorAll(".run[title], .tool[title], .tool-head[title]").length,
  );
  return outcome("no-title-tooltips-in-body", count === 0, `${count} [title] element(s) found`);
}

export const check: CheckModule = {
  id: "body",
  async run(ctx: CheckContext): Promise<CheckOutcome[]> {
    return [
      await checkFleetDefaultOpen(ctx),
      await checkTranscriptWindowCap(ctx),
      await checkContentVisibilityAuto(ctx),
      await checkLongContentScrollsWithinBlock(ctx),
      await checkNoTitleTooltips(ctx),
    ];
  },
};
