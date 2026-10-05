/**
 * P4's assertion module for the visual harness (vue-plan.md v2.1 §4.4.2, §5.2, ui-design.md
 * §5.3/§5.4/§6.4/§6.6). Glob-discovered by `scripts/web-hub/visual.ts` (P2, frozen for this
 * package) — this file only ever *adds* a `CheckModule`, never touches the framework.
 *
 * `bodyApplicability()` (below) is the shared gate every DOM-dependent check runs through
 * first: a P0-placeholder `App.vue` (plan §1.1's P0→P3 seam, not yet landed) degrades to an
 * informational skip unless `PWH_VISUAL_STRICT_BODY=1` forces a hard fail; a real P3+ page with
 * no `.detail-body` mounted (no agent selected — `dashboard`/`states`/`login` never route past
 * `#/`) is reported *not applicable*, never a failure; only a `.detail-body` that IS mounted but
 * is still missing its expected child selector is a genuine regression. `checkFleetDrawerOpen`
 * layers its own extra not-applicable bucket on top: a mounted `.detail-body` whose agent has
 * zero fleet rows legitimately renders no `.fleet-summary-bar`/`#fleet-drawer` at all
 * (ui-design.md §9 "无子 agent → 不渲染", fleet-drawer §6.1's `v-if`). The `long` scenario is the one
 * that matters most for §6.6 — its fixture already has a 1000-message deep-linked agent
 * (`tests/fixtures/web-hub-ui/long.json`) exercising real windowing.
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

/** Distinguishes three reasons `.detail-body` (P4's seam, mounted by `AgentDetail.vue` only
 * once an agent is selected AND its history has finished loading — plan §3.2's component tree)
 * might be absent from the page, so the checks below can tell "a real bug" apart from "this
 * scenario/route never puts an agent detail pane on screen at all": the P0 placeholder `App.vue`
 * (pre-P3, see the module doc comment), or a scenario/route with no agent ever selected
 * (`dashboard`/`states`/`login` all route to `#/`, and the wide-viewport dashboard split shows
 * `EmptyState` in the detail pane instead — ui-design.md §6.2's "select an agent" empty state).
 * Neither is a regression; both must be reported as *not applicable*, never fail — exactly the
 * same non-negotiable distinction `checks-shell.ts`'s own `ctx.scenario === "login" ? null : ...`
 * guards draw for shell-only checks. `checkFleetDrawerOpen` additionally treats a *present*
 * `.detail-body` with zero fleet rows as its own, separate not-applicable case (ui-design.md §9's
 * "无子 agent → 不渲染", same rule the deleted `FleetPanel.vue` used to document) — that is a
 * third bucket, not a missing-DOM one, so it is decided by
 * each check individually rather than folded into this shared helper. */
export type BodyApplicability = "placeholder" | "no-agent" | "ready";

export async function bodyApplicability(ctx: CheckContext): Promise<BodyApplicability> {
  if (await isPlaceholderApp(ctx)) return "placeholder";
  const hasDetailBody = await ctx.page.evaluate(() => document.querySelector(".detail-body") !== null);
  if (!hasDetailBody) return "no-agent";
  return "ready";
}

/** Resolves the shared "not applicable" outcomes above — `isStrictBodyMode()`'s own strict/
 * placeholder split still governs the `"placeholder"` case; a `"ready"` page whose expected
 * selector is genuinely missing is left to the caller (a real regression, never silently
 * passed). */
export async function applicabilityOutcome(
  name: string,
  ctx: CheckContext,
  applicability: BodyApplicability,
): Promise<CheckOutcome | null> {
  if (applicability === "placeholder") {
    if (isStrictBodyMode()) return outcome(name, false, "<detail-body> not found (strict mode)");
    return pass(name, "skipped (placeholder App)");
  }
  if (applicability === "no-agent") return pass(name, "not applicable: no agent selected in this scenario/route");
  return null;
}

/** ui-design.md §6.4/§6.6 + fleet-drawer plan v2 §6.2 (F6): the old `<details class="fleet">`
 * panel is gone — the fleet UI is now the in-flow `.fleet-summary-bar` toggle plus the
 * `#fleet-drawer` side drawer (`.tree .run` rows inside; the drawer is MOUNTED whenever the
 * agent has fleet rows, `display:none` when closed, so row presence is a DOM query, not a
 * visibility one). This check asserts the new open/visibility semantics: the `.detail`
 * `data-drawer` mode matches the viewport (≥1280 docked / ≤767 fullscreen / else overlay),
 * docked starts OPEN (localStorage `webhub.fleetDrawer.open` defaults to "1" — the harness runs
 * a fresh profile), overlay/fullscreen start CLOSED per mount, and the summary bar's
 * `aria-expanded` agrees with `[data-drawer-open]`. Renders nothing at all when the selected
 * agent has zero fleet rows (ui-design §9 不占位; §6.1's `v-if`) — that is this check's own
 * third not-applicable bucket, on top of the shared placeholder/no-agent split. That bucket is
 * only legitimate when `ctx.expectFleetRows` is false (the fixture backing this cell genuinely
 * never schedules a fleet frame for the routed agent — `visual.ts`'s own
 * `fixtureExpectsFleetRows`); P1 fix (dashboard.json:330-416 vs. the old fixed `SETTLE_MS`): a
 * cell whose fixture DOES promise fleet rows for this agent but still shows zero `.tree .run`
 * after `visual.ts`'s deterministic wait is a real regression, not a shrug. */
async function checkFleetDrawerOpen(ctx: CheckContext): Promise<CheckOutcome> {
  const applicability = await bodyApplicability(ctx);
  const shared = await applicabilityOutcome("fleet-drawer-open", ctx, applicability);
  if (shared !== null) return shared;
  const result = await ctx.page.evaluate((width: number) => {
    const detail = document.querySelector(".detail");
    const bar = document.querySelector(".fleet-summary-bar");
    const drawer = document.querySelector("#fleet-drawer");
    if (!detail || !bar || !drawer) return { present: false as const };
    const mode = detail.getAttribute("data-drawer");
    const open = detail.hasAttribute("data-drawer-open");
    return {
      present: true as const,
      mode,
      open,
      ariaExpanded: bar.getAttribute("aria-expanded"),
      rows: drawer.querySelectorAll(".tree .run").length,
      expectMode: width >= 1280 ? "docked" : width <= 767 ? "fullscreen" : "overlay",
      expectOpen: width >= 1280, // §6.2: docked 持久化默认 "1";overlay/fullscreen 每次挂载关闭
    };
  }, ctx.width);
  if (!result.present) {
    if (ctx.expectFleetRows) {
      return outcome(
        "fleet-drawer-open",
        false,
        "#fleet-drawer/.fleet-summary-bar not found, but fixture promises fleet rows for this agent",
      );
    }
    return pass("fleet-drawer-open", "not applicable: selected agent has no fleet rows");
  }
  const problems: string[] = [];
  if (result.mode !== result.expectMode) problems.push(`mode=${result.mode} expected=${result.expectMode}`);
  if (result.open !== result.expectOpen) problems.push(`open=${result.open} expected=${result.expectOpen}`);
  if (result.ariaExpanded !== String(result.open)) {
    problems.push(`aria-expanded=${result.ariaExpanded} vs open=${result.open}`);
  }
  if (ctx.expectFleetRows && result.rows === 0) {
    problems.push("fixture promises fleet rows but #fleet-drawer .tree .run is empty");
  }
  return outcome(
    "fleet-drawer-open",
    problems.length === 0,
    problems.length > 0
      ? `width=${ctx.width} ${problems.join("; ")}`
      : `width=${ctx.width} mode=${result.mode} open=${result.open} rows=${result.rows}`,
  );
}

/** ui-design.md §6.6: transcript windowing caps mounted `.tx-item`s at 300 total, 80 on a phone
 * first screen, 200 elsewhere. */
async function checkTranscriptWindowCap(ctx: CheckContext): Promise<CheckOutcome> {
  const applicability = await bodyApplicability(ctx);
  const shared = await applicabilityOutcome("transcript-window-cap", ctx, applicability);
  if (shared !== null) return shared;
  const has = await ctx.page.evaluate(() => document.querySelector(".transcript") !== null);
  if (!has) return outcome("transcript-window-cap", false, ".transcript not found");
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
  const applicability = await bodyApplicability(ctx);
  const shared = await applicabilityOutcome("content-visibility-auto", ctx, applicability);
  if (shared !== null) return shared;
  const result = await ctx.page.evaluate(() => {
    const el = document.querySelector(".tx-item");
    if (!el) return undefined;
    return getComputedStyle(el).contentVisibility;
  });
  if (result === undefined) return outcome("content-visibility-auto", false, ".tx-item not found");
  return outcome("content-visibility-auto", result === "auto", `computed content-visibility=${result}`);
}

/** ui-design.md §6.4: long code/tool output scrolls *inside* its own block, never the page. */
async function checkLongContentScrollsWithinBlock(ctx: CheckContext): Promise<CheckOutcome> {
  const applicability = await bodyApplicability(ctx);
  const shared = await applicabilityOutcome("long-content-scrolls-within-block", ctx, applicability);
  if (shared !== null) return shared;
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
    return outcome("long-content-scrolls-within-block", false, ".codeblock pre / .tool-section .pre not found");
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
      await checkFleetDrawerOpen(ctx),
      await checkTranscriptWindowCap(ctx),
      await checkContentVisibilityAuto(ctx),
      await checkLongContentScrollsWithinBlock(ctx),
      await checkNoTitleTooltips(ctx),
    ];
  },
};
