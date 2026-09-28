/**
 * P6's assertion module for the visual harness (vue-plan.md v2.1 §4.4.2, §5.2, §5.3 — P6
 * exclusive: "跨区域整合断言：列表→详情→对话流全流程、主题切换后各区域配色、窄屏折叠与深链组合、键盘可达/焦点顺序"). Every other
 * `checks-*.ts` module asserts a single package's own DOM in isolation; this one asserts flows
 * that only exist once P3 (shell/list/detail) and P4 (fleet/transcript) are both wired together
 * — the reason P6 depends on both being merged (§5.1) before it can run at all.
 *
 * **Ordering / page-mutation contract (important, and NOT documented on `visual.ts` itself)**:
 * `runCell` (P2, frozen) invokes every glob-loaded check module against the *same* `ctx.page`
 * for a given cell, in filename-sorted order — `checks-body.ts` → `checks-common.ts` →
 * `checks-e2e.ts` → `checks-shell.ts`. `checks-common.ts`'s own theme three-state check already
 * relies on this silently: it forces `pwh_theme` through light/dark/system and reloads three
 * times, then leaves `localStorage` cleared and the page back on its original route before
 * returning. This module does the same, deliberately: every check that navigates (hash
 * changes), clicks, or reloads restores the route it received before returning, and each
 * function that depends on a specific route re-asserts that route at its own start rather than
 * trusting an earlier function in this same module to have left it there — so `checks-shell.ts`
 * (which runs after this file, alphabetically) always sees the pristine per-cell page it would
 * have seen had this module not existed.
 *
 * Scenario/width/theme gating: every check below is scoped to exactly the scenario(s) where it
 * is meaningful (`dashboard` for the list→detail flow, `detail` for everything that needs an
 * already-selected agent) and to a small, deliberately chosen subset of the width×theme matrix
 * (never every cell) — each mutating check (click/reload/keyboard) costs real wall-clock time
 * and the ui-design.md requirement it verifies does not vary per extra breakpoint once one
 * narrow and one split-view width have been exercised. The one exception is the axe audit
 * (group E), which §5.3's "axe 0 违规" gate applies to BOTH theme cells (color-contrast is
 * theme-dependent) of dashboard/detail/login/states at the same two representative widths.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { CheckContext, CheckModule, CheckOutcome, ExtPage } from "../visual.js";
import { loadFixture } from "../dev-hub.js";
import { THEME_STORAGE_KEY } from "../../../src/web-hub/ui/src/composables/useTheme.js";

function outcome(name: string, ok: boolean, detail?: string): CheckOutcome {
  return ok ? { name, ok } : { name, ok, detail: detail ?? "failed" };
}

function pass(name: string, detail?: string): CheckOutcome {
  return detail === undefined ? { name, ok: true } : { name, ok: true, detail };
}

/** `ExtPage` (visual.ts, frozen) doesn't declare `keyboard` — this module needs `Tab`/`Escape`
 * key presses, which exist at runtime on every real Playwright `Page`. Same cast-only pattern
 * `visual.ts` itself uses to extend `lib/playwright.ts`'s minimal `PwPage`. */
interface E2EPage extends ExtPage {
  keyboard: { press(key: string): Promise<void> };
}

/** Playwright's real `waitForFunction(pageFunction, arg, options)` — `PwPage`'s frozen minimal
 * type only declares the no-arg form, and an interface extension can't overload it compatibly,
 * so the one call site that needs an argument casts here (same cast-only pattern as E2EPage). */
interface WaitForArgPage {
  waitForFunction(fn: (arg: string) => boolean, arg: string, opts?: { timeout?: number }): Promise<unknown>;
}

function asE2EPage(ctx: CheckContext): E2EPage {
  return ctx.page as unknown as E2EPage;
}

// ---------------------------------------------------------------------------
// pure helpers (exported + unit-tested — see tests/web-hub/ui/checks-e2e.test.ts)
// ---------------------------------------------------------------------------

export const AGENT_ALPHA_ROUTE = "#/agent/agent-alpha";
export const NOT_CONNECTED_TITLE = "This agent is not connected";

export function isNotConnectedEmptyState(title: string | null | undefined): boolean {
  return title === NOT_CONNECTED_TITLE;
}

/** ui-design §6.2/§4.4.2's "列表→详情→对话流全流程" is only meaningful in the single-view (<768)
 * layout, where clicking a card actually *replaces* what's on screen — the split (≥768) layout
 * shows both panes simultaneously so a click never changes which DOM subtree is visible. */
export function isListDetailFlowCell(scenario: string, width: number, theme: "light" | "dark"): boolean {
  return scenario === "dashboard" && width < 768 && theme === "light";
}

/** One representative split-view width is enough to prove pagination round-trips through the
 * real dev-hub `/api/history` endpoint; running it at every breakpoint would only re-test the
 * same network path with a different viewport. */
export function isLoadOlderCell(scenario: string, width: number, hasTouch: boolean, theme: "light" | "dark"): boolean {
  return scenario === "detail" && width === 1024 && !hasTouch && theme === "light";
}

/** One narrow (no sidebar) and one split (sidebar mounted) width — enough to prove every
 * concurrently-visible region (`.topbar`/`.sidebar`/`.dock`) shares the same surface color and
 * that the canvas/surface distinction survives a real theme switch, without repeating the same
 * six-region comparison at every one of the matrix's six breakpoints. */
export function isThemeConsistencyWidth(width: number): boolean {
  return width === 375 || width === 768;
}

export function isNarrowDeepLinkWidth(width: number): boolean {
  return width === 375;
}

/** Exercises the "not connected" empty state at one narrow and one split width — the two layout
 * branches (`DashboardView.vue`'s narrow `v-else-if="route.name === 'agent'"` vs. its `!narrow`
 * branch) are different template branches with independently-decided empty-state copy, so both
 * need their own probe rather than assuming one implies the other. */
export function isMissingAgentProbeWidth(width: number, hasTouch: boolean): boolean {
  return width === 375 || (width === 1024 && !hasTouch);
}

/** Same two representative widths as the missing-agent probe: one single-view, one split. */
export function isFocusWalkWidth(width: number, hasTouch: boolean): boolean {
  return width === 375 || (width === 1024 && !hasTouch);
}

/** vue-plan.md v2.1 §4.4.2's axe row covers dashboard/login/states × light/dark; the dispatch
 * adds `detail` (the screen with by far the most interactive markup) and pins the audit to the
 * same two representative widths every other mutating check in this module uses — one narrow,
 * one split — in BOTH theme cells, since axe's wcag2aa set includes color-contrast and the two
 * themes have fully independent token sets (`styles/tokens.css`). `long` stays out: its 1000-entry
 * fixture exists to stress windowing (§6.6), not to add a fifth accessibility surface. */
export const AXE_SCENARIOS: readonly string[] = ["dashboard", "detail", "login", "states"];

export function isAxeCell(scenario: string, width: number, hasTouch: boolean): boolean {
  return AXE_SCENARIOS.includes(scenario) && (width === 375 || (width === 1024 && !hasTouch));
}

export interface SimpleRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Standard axis-aligned bounding-box intersection test, with `epsilonPx` of slack: two rects
 * whose overlap in either axis is at most `epsilonPx` are treated as merely touching, not
 * intersecting. This absorbs the sub-pixel layout noise real browsers produce for adjacent
 * flex/grid siblings (e.g. a `44px` touch target's computed bottom edge landing a fraction of a
 * pixel past its neighbor's top edge) — the same kind of tolerance `checks-shell.ts`'s own
 * `checkSidebarWidth` already applies via `Math.abs(actual - expected) <= 1` for the same reason. */
export function rectsIntersect(a: SimpleRect, b: SimpleRect, epsilonPx = 1): boolean {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlapX > epsilonPx && overlapY > epsilonPx;
}

/** The slice of a dev-hub fixture this module's pagination assertions need — deliberately NOT
 * `DevHubFixture` itself so the pure helpers stay unit-testable with inline literals (the real
 * `DevHubFixture` from `dev-hub.ts` is structurally assignable to this). */
export interface FixtureOlderShape {
  readonly historyOlder?: Readonly<Record<string, Readonly<Record<string, { readonly entries?: readonly unknown[] }>>>>;
  readonly history?: Readonly<Record<string, { readonly entries?: readonly unknown[] }>>;
}

export interface OlderExpectation {
  /** True iff the fixture declares at least one `historyOlder` page for the agent — the detail
   * view MUST then render a `.tx-older` button, and its absence is a product regression, never
   * a "not applicable" pass (verifier finding: the previous version passed silently either way). */
  readonly expected: boolean;
  /** The `before` cursor key of the first declared page (for failure messages), if any. */
  readonly before: string | null;
  /** A distinctive message text from the older page's entries that MUST become visible in the
   * transcript after a successful round trip — `null` only when the page carries no textual
   * message entries at all (content assertion then degrades to the item-count assertion). */
  readonly text: string | null;
}

function firstMessageText(entries: readonly unknown[]): string | null {
  for (const entry of entries) {
    const message = (entry as { message?: unknown } | null)?.message;
    if (message === null || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string" && content.trim().length > 0) return content.trim();
    if (Array.isArray(content)) {
      for (const part of content as readonly unknown[]) {
        const p = part as { type?: unknown; text?: unknown } | null;
        if (p !== null && p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) {
          return p.text.trim();
        }
      }
    }
  }
  return null;
}

export function olderExpectation(fixture: FixtureOlderShape, agentKey: string): OlderExpectation {
  const pages = fixture.historyOlder?.[agentKey];
  if (pages === undefined) return { expected: false, before: null, text: null };
  const before = Object.keys(pages)[0];
  if (before === undefined) return { expected: false, before: null, text: null };
  return { expected: true, before, text: firstMessageText(pages[before]?.entries ?? []) };
}

/** The LAST textual message of the agent's initial history page — used as the "initial render
 * has fully settled" landmark before any item counting (the render gate's 100ms throttle can
 * still have tail entries queued when the first `.tx-item` mounts). */
export function historyLandmark(fixture: FixtureOlderShape, agentKey: string): string | null {
  const entries = fixture.history?.[agentKey]?.entries ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = firstMessageText([entries[i]]);
    if (text !== null) return text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// axe result shaping (pure, unit-tested — the audit itself needs a real page)
// ---------------------------------------------------------------------------

export interface AxeViolationLike {
  readonly id: string;
  readonly impact?: string | null;
  readonly nodes?: ReadonlyArray<{ readonly target?: unknown }>;
}

/** One line per violated rule: `rule-id(impact)@selector | selector (+N more)`. axe's
 * `node.target` is a selector array (one string per shadow-DOM level) — joined with a space for
 * the common flat case. Bounded at `maxLen` so a pathological page can't blow up report.txt. */
export function formatAxeViolations(violations: readonly AxeViolationLike[], maxLen = 1200): string {
  const parts = violations.map((v) => {
    const nodes = v.nodes ?? [];
    const selectors = nodes
      .slice(0, 3)
      .map((n) => (Array.isArray(n.target) ? (n.target as readonly unknown[]).join(" ") : String(n.target ?? "?")));
    const extra = nodes.length > 3 ? ` (+${nodes.length - 3} more)` : "";
    return `${v.id}(${v.impact ?? "?"})@${selectors.join(" | ")}${extra}`;
  });
  const out = parts.join("; ");
  return out.length > maxLen ? out.slice(0, maxLen - 1) + "…" : out;
}

// ---------------------------------------------------------------------------
// group A — list → detail → transcript full flow (ui-design §5.4, §6.2)
// ---------------------------------------------------------------------------

async function checkListDetailBackFlow(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (!isListDetailFlowCell(ctx.scenario, ctx.width, ctx.theme)) return [];
  const page = asE2EPage(ctx);
  const results: CheckOutcome[] = [];

  await page.evaluate(() => {
    window.location.hash = "#/";
  });
  await page.waitForFunction(() => document.querySelector("a.agent-card") !== null, { timeout: 5_000 }).catch(() => {});

  const hasCard = await page.evaluate(() => document.querySelector("a.agent-card") !== null);
  if (!hasCard) return [outcome("e2e-list-detail-flow", false, "no a.agent-card found in the list view")];

  const beforeLen = await page.evaluate(() => window.history.length);
  await page.click("a.agent-card");
  await page
    .waitForFunction(() => document.querySelector(".detail-head .detail-title") !== null, { timeout: 5_000 })
    .catch(() => {});

  const afterClick = await page.evaluate(() => ({
    hash: window.location.hash,
    len: window.history.length,
    hasSidebar: document.querySelector(".sidebar") !== null,
    hasDetail: document.querySelector(".detail") !== null,
    title: document.querySelector(".detail-title")?.textContent ?? "",
    txItems: document.querySelectorAll(".tx-item").length,
  }));
  results.push(outcome("e2e-flow-click-navigates-to-detail", /^#\/agent\//.test(afterClick.hash), afterClick.hash));
  results.push(
    outcome(
      "e2e-flow-click-single-view-swap",
      !afterClick.hasSidebar && afterClick.hasDetail,
      JSON.stringify(afterClick),
    ),
  );
  results.push(
    outcome("e2e-flow-click-detail-title-populated", afterClick.title.trim().length > 0, JSON.stringify(afterClick)),
  );
  results.push(outcome("e2e-flow-click-transcript-mounted", afterClick.txItems > 0, `txItems=${afterClick.txItems}`));
  results.push(
    outcome(
      "e2e-flow-click-grows-browser-history",
      afterClick.len > beforeLen,
      `before=${beforeLen} after=${afterClick.len}`,
    ),
  );

  const hasBack = await page.evaluate(() => document.querySelector("button.detail-back") !== null);
  if (!hasBack) {
    results.push(outcome("e2e-flow-back-button-present", false, "button.detail-back not found at narrow width"));
  } else {
    await page.click("button.detail-back");
    await page.waitForFunction(() => document.querySelector(".sidebar") !== null, { timeout: 5_000 }).catch(() => {});
    const afterBack = await page.evaluate(() => ({
      hash: window.location.hash,
      hasSidebar: document.querySelector(".sidebar") !== null,
    }));
    results.push(
      outcome(
        "e2e-flow-back-button-returns-to-list",
        afterBack.hash === "#/" && afterBack.hasSidebar,
        JSON.stringify(afterBack),
      ),
    );
  }

  await page.evaluate(() => {
    window.location.hash = "#/";
  });
  return results;
}

// ---------------------------------------------------------------------------
// group A2 — pagination round-trip within an already-open detail view (ui-design §5.4)
// ---------------------------------------------------------------------------

async function checkLoadOlderGrowsTranscript(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (!isLoadOlderCell(ctx.scenario, ctx.width, ctx.hasTouch, ctx.theme)) return [];
  const page = asE2EPage(ctx);
  // The detail scenario's contract (visual.ts's DEFAULT_SCENARIOS): fixture `dashboard`, routed
  // to agent-alpha. The pagination expectation is DERIVED from that fixture, not assumed — the
  // same `loadFixture` the harness's own dev-hub boot uses, so a fixture edit that drops
  // `historyOlder` flips this check back to a declared not-applicable instead of a stale fail.
  const agentKey = "agent-alpha";
  let fixture: FixtureOlderShape;
  try {
    fixture = await loadFixture("dashboard");
  } catch (err) {
    return [outcome("e2e-load-older-button-present", false, `dashboard fixture unreadable: ${String(err)}`)];
  }
  const expectation = olderExpectation(fixture, agentKey);

  await page.evaluate((h) => {
    window.location.hash = h;
  }, AGENT_ALPHA_ROUTE_LITERAL);
  await page
    .waitForFunction(() => document.querySelectorAll(".tx-item").length > 0, { timeout: 5_000 })
    .catch(() => {});

  const hasOlder = await page.evaluate(() => document.querySelector(".tx-older") !== null);
  if (!expectation.expected) {
    return [
      pass("e2e-load-older-grows-transcript", "not applicable: fixture declares no historyOlder for agent-alpha"),
    ];
  }
  if (!hasOlder) {
    return [
      outcome(
        "e2e-load-older-button-present",
        false,
        `fixture declares historyOlder["${agentKey}"]["${expectation.before ?? "?"}"] but no .tx-older button rendered`,
      ),
    ];
  }
  const results: CheckOutcome[] = [pass("e2e-load-older-button-present")];

  // Render settle before counting: `waitForFunction(.tx-item > 0)` returns after the FIRST item
  // mounts, but the render gate (100ms throttle) can still have the remaining initial entries
  // queued — a `beforeCount` taken that early makes the later growth assertion false-pass. Wait
  // for the fixture's own last history message as the "initial render complete" landmark.
  const landmark = historyLandmark(fixture, agentKey);
  if (landmark !== null) {
    await (page as unknown as WaitForArgPage)
      .waitForFunction((text) => (document.querySelector(".transcript")?.textContent ?? "").includes(text), landmark, {
        timeout: 5_000,
      })
      .catch(() => {});
  }
  const beforeCount = await page.evaluate(() => document.querySelectorAll(".tx-item").length);
  await page.click(".tx-older");
  // dashboard.json's `historyOlder["agent-alpha"]` page reports `hasMore: false` — the
  // deterministic signal that the network round trip (click → `hub.loadOlder` → real
  // `/api/history` request → dispatched `page` event) completed is the button disappearing. But
  // a disappearing button alone proves nothing about the DATA (verifier finding): P4's designed
  // flow (plan §3.6 前插锚点 — `Transcript.vue`'s `paging` watcher shifts the window `start`
  // forward by exactly the prepended count so the viewport never jumps) parks freshly fetched
  // older items behind the `TxHiddenGap` affordance ("N earlier messages hidden · Show") instead
  // of revealing them outright. The full user-visible round trip is therefore TWO clicks:
  // `.tx-older` (fetch) then `.tx-window-gap` (reveal) — and only after the second must the old
  // message's own text be present in the transcript.
  const settled = await page
    .waitForFunction(() => document.querySelector(".tx-older") === null, { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  results.push(
    outcome(
      "e2e-load-older-round-trips",
      settled,
      settled ? undefined : ".tx-older never cleared after click (paging divider stuck or page event never applied)",
    ),
  );
  if (!settled) return results;

  const gapShown = await page
    .waitForFunction(() => document.querySelector(".tx-window-gap") !== null, { timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  results.push(
    outcome(
      "e2e-load-older-anchor-gap-shown",
      gapShown,
      gapShown
        ? undefined
        : "no .tx-window-gap after the page landed — the prepend anchor must park fetched items behind the hidden-gap affordance",
    ),
  );
  if (!gapShown) return results;

  await page.click(".tx-window-gap");
  await page
    .waitForFunction(() => document.querySelector(".tx-window-gap") === null, { timeout: 3_000 })
    .catch(() => {});
  const after = await page.evaluate(() => ({
    count: document.querySelectorAll(".tx-item").length,
    text: document.querySelector(".transcript")?.textContent ?? "",
  }));
  results.push(
    outcome(
      "e2e-load-older-grows-transcript",
      after.count > beforeCount,
      `tx-item count before=${beforeCount} after=${after.count} (fetch + reveal)`,
    ),
  );
  if (expectation.text !== null) {
    const found = after.text.includes(expectation.text);
    const shown = expectation.text.length > 60 ? expectation.text.slice(0, 60) + "…" : expectation.text;
    results.push(
      outcome(
        "e2e-load-older-content-visible",
        found,
        `older page's message "${shown}" ${found ? "found" : "NOT found"} in .transcript after fetch + reveal`,
      ),
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// group B — theme switch keeps every concurrently-visible region in sync (ui-design §3.9, §7)
// ---------------------------------------------------------------------------

interface SurfaceColors {
  readonly topbar: string | null;
  readonly sidebar: string | null;
  readonly dock: string | null;
  readonly canvas: string;
}

async function readSurfaceColors(page: E2EPage): Promise<SurfaceColors> {
  return page.evaluate(() => {
    const topbarEl = document.querySelector(".topbar");
    const sidebarEl = document.querySelector(".sidebar");
    const dockEl = document.querySelector(".dock");
    return {
      topbar: topbarEl ? getComputedStyle(topbarEl).backgroundColor : null,
      sidebar: sidebarEl ? getComputedStyle(sidebarEl).backgroundColor : null,
      dock: dockEl ? getComputedStyle(dockEl).backgroundColor : null,
      canvas: getComputedStyle(document.body).backgroundColor,
    };
  });
}

async function setThemePrefAndReload(page: E2EPage, pref: "light" | "dark" | null): Promise<void> {
  await page.evaluate(
    (args) => {
      try {
        if (args.pref === null) window.localStorage.removeItem(args.key);
        else window.localStorage.setItem(args.key, args.pref);
      } catch {
        /* storage disabled — matches theme-init.js's own defensive posture */
      }
    },
    { key: THEME_STORAGE_KEY, pref },
  );
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector(".topbar") !== null, { timeout: 8_000 }).catch(() => {});
}

async function checkThemeConsistencyAcrossRegions(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (ctx.scenario !== "detail" || !isThemeConsistencyWidth(ctx.width) || ctx.theme !== "light") return [];
  const page = asE2EPage(ctx);
  const results: CheckOutcome[] = [];

  await setThemePrefAndReload(page, "light");
  const light = await readSurfaceColors(page);
  await setThemePrefAndReload(page, "dark");
  const dark = await readSurfaceColors(page);
  // Restore default (system) preference and the canonical route before returning — the next
  // check in this module (and, after that, `checks-shell.ts`) must see a clean, un-forced page.
  await setThemePrefAndReload(page, null);
  await page.evaluate((h) => {
    if (window.location.hash !== h) window.location.hash = h;
  }, AGENT_ALPHA_ROUTE_LITERAL);

  const lightPresent = [light.topbar, light.sidebar, light.dock].filter((v): v is string => v !== null);
  const darkPresent = [dark.topbar, dark.sidebar, dark.dock].filter((v): v is string => v !== null);
  results.push(
    outcome(
      "e2e-theme-surface-regions-consistent-light",
      new Set(lightPresent).size <= 1,
      JSON.stringify({ topbar: light.topbar, sidebar: light.sidebar, dock: light.dock }),
    ),
  );
  results.push(
    outcome(
      "e2e-theme-surface-regions-consistent-dark",
      new Set(darkPresent).size <= 1,
      JSON.stringify({ topbar: dark.topbar, sidebar: dark.sidebar, dock: dark.dock }),
    ),
  );

  const regions: ReadonlyArray<{ name: string; light: string | null; dark: string | null }> = [
    { name: "topbar", light: light.topbar, dark: dark.topbar },
    { name: "sidebar", light: light.sidebar, dark: dark.sidebar },
    { name: "dock", light: light.dock, dark: dark.dock },
  ];
  for (const r of regions) {
    if (r.light === null || r.dark === null) continue; // not mounted at this width — not applicable
    results.push(outcome(`e2e-theme-switches-${r.name}`, r.light !== r.dark, `light=${r.light} dark=${r.dark}`));
  }
  results.push(
    outcome("e2e-theme-canvas-switches", light.canvas !== dark.canvas, `light=${light.canvas} dark=${dark.canvas}`),
  );
  if (lightPresent.length > 0) {
    results.push(
      outcome(
        "e2e-theme-canvas-distinct-from-surface",
        light.canvas !== lightPresent[0],
        `canvas=${light.canvas} surface=${lightPresent[0] ?? ""}`,
      ),
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// group C — narrow-screen collapse + deep-link combination (ui-design §6.2, §6.4)
// ---------------------------------------------------------------------------

async function checkNarrowDeepLinkCombination(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (ctx.scenario !== "detail" || !isNarrowDeepLinkWidth(ctx.width) || ctx.theme !== "light") return [];
  const page = asE2EPage(ctx);
  const results: CheckOutcome[] = [];

  await page.evaluate((h) => {
    window.location.hash = h;
  }, AGENT_ALPHA_ROUTE_LITERAL);
  await page.waitForFunction(() => document.querySelector(".detail-head") !== null, { timeout: 5_000 }).catch(() => {});

  const layout = await page.evaluate(() => ({
    hasSidebar: document.querySelector(".sidebar") !== null,
    hasDetail: document.querySelector(".detail") !== null,
    fleetOpen: (document.querySelector(".fleet") as HTMLDetailsElement | null)?.open ?? null,
  }));
  results.push(
    outcome("e2e-narrow-deeplink-single-view", !layout.hasSidebar && layout.hasDetail, JSON.stringify(layout)),
  );
  if (layout.fleetOpen !== null) {
    results.push(
      outcome("e2e-narrow-deeplink-fleet-collapsed", layout.fleetOpen === false, `fleetOpen=${layout.fleetOpen}`),
    );
  }

  // ui-design §6.2: "深链直达时详情返回按钮用 replace（history.length 不变、hash 变 #/）" — this page was
  // reached via `page.goto`, so `DashboardView.vue`'s `historyFloor` should still equal the
  // current `history.length`, forcing the `replace` branch instead of `history.back()`.
  const beforeBack = await page.evaluate(() => window.history.length);
  await page.click("button.detail-back");
  await page.waitForTimeout(300);
  const afterBack = await page.evaluate(() => ({ hash: window.location.hash, len: window.history.length }));
  results.push(
    outcome(
      "e2e-narrow-deeplink-back-uses-replace",
      afterBack.hash === "#/" && afterBack.len === beforeBack,
      `before=${beforeBack} after=${JSON.stringify(afterBack)}`,
    ),
  );

  // ui-design §6.2 / §4.4.2's shell row: "<768 按 Esc 返回". Re-enter the detail view, then
  // press Escape and expect the same list-return outcome as the back button above.
  await page.evaluate((h) => {
    window.location.hash = h;
  }, AGENT_ALPHA_ROUTE_LITERAL);
  await page.waitForFunction(() => document.querySelector(".detail-head") !== null, { timeout: 5_000 }).catch(() => {});
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const afterEsc = await page.evaluate(() => window.location.hash);
  results.push(outcome("e2e-narrow-deeplink-esc-returns-to-list", afterEsc === "#/", `hash=${afterEsc}`));

  await page.evaluate((h) => {
    window.location.hash = h;
  }, AGENT_ALPHA_ROUTE_LITERAL);
  return results;
}

async function checkDeepLinkToMissingAgentEmptyState(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (ctx.scenario !== "detail" || !isMissingAgentProbeWidth(ctx.width, ctx.hasTouch) || ctx.theme !== "light") {
    return [];
  }
  const page = asE2EPage(ctx);

  await page.evaluate(() => {
    window.location.hash = "#/agent/e2e-does-not-exist";
  });
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => {
    const empty = document.querySelector(".empty");
    return {
      title: empty?.querySelector("h2")?.textContent ?? null,
      hasBackLink: empty?.querySelector('a[href="#/"]') !== null,
    };
  });

  const suffix = `w${ctx.width}`;
  const results: CheckOutcome[] = [
    outcome(
      `e2e-missing-agent-empty-state-${suffix}`,
      isNotConnectedEmptyState(info.title),
      `expected="${NOT_CONNECTED_TITLE}" actual=${info.title ?? "(none)"}`,
    ),
    outcome(`e2e-missing-agent-back-link-${suffix}`, info.hasBackLink, JSON.stringify(info)),
  ];

  await page.evaluate((h) => {
    window.location.hash = h;
  }, AGENT_ALPHA_ROUTE_LITERAL);
  return results;
}

// ---------------------------------------------------------------------------
// group D — keyboard reachability / focus order (ui-design §6.5, §11)
// ---------------------------------------------------------------------------

interface FocusStep {
  readonly selector: string;
  readonly rect: SimpleRect;
  readonly inDock: boolean;
}

export interface TabWalk {
  readonly steps: readonly FocusStep[];
  /** True iff focus landed on `<body>` at least once mid-walk (recorded as a `BODY` marker in
   * diagnostic traces). In headless Chromium Tab from the last page element wraps back to the
   * document start, so a `<body>` landing is EITHER tab-order exhaustion (end of the cycle) OR a
   * transient focus loss — the fixture's timed SSE script events keep arriving during the walk,
   * and a re-render that detaches the currently-focused node drops `activeElement` to `<body>`
   * mid-order. The walker therefore does NOT stop at the first `<body>` (that was the W4-verifier
   * false negative at detail/1024: 12 steps, BODY, walk aborted before ever reaching the dock):
   * it keeps walking through it and terminates only when the cycle demonstrably repeats (the
   * first step's selector comes back around) or `maxSteps` is exhausted — so a dock that exists
   * in the tab order is always reached within one full document cycle, while a dock that truly
   * never receives focus still fails, now with the full selector trace attached. */
  readonly wrapped: boolean;
}

async function walkTabOrder(page: E2EPage, maxSteps: number): Promise<TabWalk> {
  const steps: FocusStep[] = [];
  let wrapped = false;
  for (let i = 0; i < maxSteps; i++) {
    await page.keyboard.press("Tab");
    const step = await page.evaluate(() => {
      const el = document.activeElement;
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      const cls = typeof el.className === "string" ? el.className : "";
      const firstClass = cls.split(" ")[0] ?? "";
      return {
        selector: `${el.tagName.toLowerCase()}${firstClass ? "." + firstClass : ""}`,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        inDock: el.closest(".dock") !== null,
        isBody: el.tagName === "BODY",
      };
    });
    if (step === null) break;
    if (step.isBody) {
      wrapped = true;
      continue;
    }
    // Cycle-complete detection after a wrap: the first step's selector has come back around.
    // (Selector granularity is deliberate — good enough for termination, and the full trace is
    // only ever used as failure diagnostics.)
    if (wrapped && steps.length > 0 && step.selector === steps[0]?.selector) break;
    steps.push({ selector: step.selector, rect: step.rect, inDock: step.inDock });
  }
  return { steps, wrapped: wrapped };
}

/** Bounded one-line trace of a walk for failure details, with `BODY` markers for wrap points. */
function traceWalk(walk: TabWalk, maxLen = 600): string {
  const out = walk.steps.map((s) => s.selector).join(" → ") + (walk.wrapped ? " (with BODY wrap)" : "");
  return out.length > maxLen ? out.slice(0, maxLen - 1) + "…" : out;
}

async function checkKeyboardFocusOrder(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (ctx.scenario !== "detail" || !isFocusWalkWidth(ctx.width, ctx.hasTouch) || ctx.theme !== "light") return [];
  const page = asE2EPage(ctx);

  // A real `reload()` (not just a hash assignment) before walking matters here, specifically:
  // earlier checks in this same module (`checkNarrowDeepLinkCombination`, `checkLoadOlderGrowsTranscript`)
  // click real buttons, and Chromium's "sequential focus navigation starting point" remembers
  // the last interactively-focused element even across a client-side (hashchange-only) route
  // change and even after that element is `blur()`-ed — the very next Tab press resumes from
  // wherever that point was, not from the top of the document, which would make this check's
  // "first Tab reaches the skip link" assertion depend on unrelated sibling checks' click
  // history instead of testing what a real visitor's first keypress after loading the page
  // does. A full reload resets that browser-internal state exactly like a fresh page load would.
  await page.evaluate((h) => {
    window.location.hash = h;
  }, AGENT_ALPHA_ROUTE_LITERAL);
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector(".detail-head") !== null, { timeout: 8_000 }).catch(() => {});
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  const walk = await walkTabOrder(page, 80);
  const { steps } = walk;
  const results: CheckOutcome[] = [];

  const first = steps[0];
  results.push(
    outcome(
      "e2e-focus-order-starts-with-skip-link",
      first !== undefined && first.selector.startsWith("a.skip-link"),
      first?.selector ?? "(no focusable element found)",
    ),
  );

  const dockRect = await page.evaluate(() => {
    const d = document.querySelector(".dock");
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (dockRect === null) {
    // The detail scenario is routed to a CONNECTED agent (dashboard.json's agent-alpha) whose
    // composer (P3's `DetailDock.vue`) must always render — a missing dock is a product
    // regression, never a "not applicable" pass (verifier finding: absence was silently passed).
    results.push(
      outcome(
        "e2e-focus-order-dock-reachable",
        false,
        ".dock not rendered on a connected agent's detail view — DetailDock.vue must mount the composer",
      ),
    );
    results.push(
      outcome("e2e-focus-order-no-overlap-with-dock", false, ".dock not rendered — overlap cannot be verified"),
    );
  } else {
    const dockReached = steps.some((s) => s.inDock);
    results.push(
      outcome(
        "e2e-focus-order-dock-reachable",
        dockReached,
        `${steps.length} tab step(s): ${traceWalk(walk) || "(none)"}`,
      ),
    );

    const overlapping = steps.filter(
      (s) => !s.inDock && s.rect.width > 0 && s.rect.height > 0 && rectsIntersect(s.rect, dockRect),
    );
    results.push(
      outcome(
        "e2e-focus-order-no-overlap-with-dock",
        overlapping.length === 0,
        overlapping.map((s) => s.selector).join(", "),
      ),
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// group E — axe-core accessibility audit (vue-plan.md v2.1 §4.4.2 axe row, §5.3 P6 "axe 0 违规")
// ---------------------------------------------------------------------------

/** Injection trade-off (deviation from §4.4.2's "另开 bypassCSP: true 的 context", documented per
 * dispatch): `CheckContext` exposes only the cell's existing `page` — no browser/context factory
 * — so a second bypass-CSP context is not reachable from a check module without changing P2's
 * frozen `visual.ts`. `page.addScriptTag({ path })` is NOT an alternative here: it injects an
 * inline `<script>`, which the dev-hub's real production CSP (`script-src 'self'`, no
 * 'unsafe-inline') would block — and the block would fire a `securitypolicyviolation` into the
 * very listener `checks-common.ts` asserts on. Playwright's CDP-level `page.evaluate(source)` is
 * not governed by page CSP at all, so evaluating the axe source string gives the same audit
 * against the same real-CSP DOM with zero CSP surface changes. axe itself is pure DOM analysis
 * (no network, no eval), so nothing else in its path touches CSP either. */
let cachedAxeSource: string | undefined;

function axeSource(): string {
  if (cachedAxeSource === undefined) {
    cachedAxeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  }
  return cachedAxeSource;
}

/** ExtPage's typed `evaluate` only accepts function arguments; Playwright's runtime also accepts
 * a source string (the standard axe-playwright injection path). Cast-only, same pattern as
 * E2EPage above. */
interface StringEvalPage {
  evaluate(script: string): Promise<unknown>;
}

interface AxeAudit {
  readonly wcag: readonly AxeViolationLike[];
  readonly bestPractice: readonly AxeViolationLike[];
}

async function checkAxeAccessibility(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (!isAxeCell(ctx.scenario, ctx.width, ctx.hasTouch)) return [];
  const page = asE2EPage(ctx);
  const suffix = `${ctx.width}x${ctx.theme}`;

  // Re-assert the scenario's canonical route: sibling checks in this module (and glob-earlier
  // modules) may have left the page on a probe route like `#/agent/e2e-does-not-exist`.
  const route = ctx.scenario === "detail" ? AGENT_ALPHA_ROUTE_LITERAL : "#/";
  await page.evaluate((h) => {
    if (window.location.hash !== h) window.location.hash = h;
  }, route);
  await page
    .waitForFunction(() => document.querySelector(".app, .login-page") !== null, { timeout: 5_000 })
    .catch(() => {});
  await page.waitForTimeout(200);

  let audit: AxeAudit | null;
  try {
    await (page as unknown as StringEvalPage).evaluate(axeSource());
    const raw = await page.evaluate(async () => {
      const w = window as unknown as {
        axe?: { run(context: unknown, options: unknown): Promise<{ violations: readonly unknown[] }> };
      };
      if (w.axe === undefined) return null;
      const wcag = await w.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
      const best = await w.axe.run(document, { runOnly: { type: "tag", values: ["best-practice"] } });
      return { wcag: wcag.violations, bestPractice: best.violations };
    });
    audit = raw as AxeAudit | null;
  } catch (err) {
    return [outcome(`e2e-axe-wcag2-${suffix}`, false, `axe audit threw: ${String(err)}`)];
  }
  if (audit === null) {
    return [outcome(`e2e-axe-wcag2-${suffix}`, false, "axe-core source evaluated but window.axe is undefined")];
  }

  const results: CheckOutcome[] = [
    outcome(
      `e2e-axe-wcag2-${suffix}`,
      audit.wcag.length === 0,
      audit.wcag.length === 0 ? undefined : `${audit.wcag.length} violation(s): ${formatAxeViolations(audit.wcag)}`,
    ),
  ];
  // best-practice is advisory per dispatch: always reported, never failing.
  results.push(
    pass(
      `e2e-axe-best-practice-${suffix}`,
      audit.bestPractice.length === 0
        ? "0 advisory finding(s)"
        : `${audit.bestPractice.length} advisory (not failing): ${formatAxeViolations(audit.bestPractice, 600)}`,
    ),
  );
  return results;
}

// ---------------------------------------------------------------------------
// group F — control-plane cross-region full flow (#32 C7, control-plan.md v2.1 §12.3: C7's own
// checks-e2e.ts addition on top of C5/C6's per-component checks-control.ts probes)
// ---------------------------------------------------------------------------

/** One representative desktop cell, deliberately NOT `checks-control.ts`'s own action cell
 * (1024x!touch x light) — that cell already carries residual mutation from
 * `checkStopButtonTwoStep`/`checkComposerKeys` (checks-control.ts loads and runs before this
 * file, alphabetically) by the time this module's checks run on the SAME cell. Picking the dark
 * cell instead means this flow starts from a pristine composer/stop-button and can run its own
 * list→detail→send→queue→abort narrative without either check module stepping on the other's
 * assumptions — same isolation discipline this file's header already documents for route state. */
function isControlFlowCell(scenario: string, width: number, theme: "light" | "dark", hasTouch: boolean): boolean {
  return scenario === "control" && width === 1024 && theme === "dark" && !hasTouch;
}

/** Same single representative cell as `isControlFlowCell` — `checkAskUserFormStructure`
 * (checks-control.ts) runs on every cell of the `ask-user` scenario but always restores the
 * route to `#/agent/agent-alpha` with a fresh (unanswered) draft before finishing, so any cell is
 * safe here; reusing the exact same cell just keeps this module's own cost/consistency story
 * simple (one flow, one cell, per scenario). */
function isAskUserAnswerCell(scenario: string, width: number, theme: "light" | "dark", hasTouch: boolean): boolean {
  return scenario === "ask-user" && width === 1024 && theme === "dark" && !hasTouch;
}

/** `ExtPage`'s `keyboard` cast (E2EPage) only declares `press`; this flow also needs `type` to
 * fill the composer textarea through real keyboard events (same input path a human/`v-model`
 * expects), matching `checks-control.ts`'s own `ControlPage` cast pattern. */
interface TypingPage extends ExtPage {
  keyboard: { type(text: string): Promise<void>; press(key: string): Promise<void> };
}

function asTypingPage(ctx: CheckContext): TypingPage {
  return ctx.page as unknown as TypingPage;
}

/** `POST /api/cmd` + `POST /api/dialog` are the two control-plane write endpoints (mirrors
 * `checks-control.ts`'s own `isControlApiPath` — duplicated rather than imported: that file
 * already imports FROM this one for the axe helpers, and this module intentionally never
 * imports back to avoid a two-file cycle). */
function isControlWriteApi(url: string): boolean {
  try {
    const p = new URL(url).pathname;
    return p === "/api/cmd" || p === "/api/dialog";
  } catch {
    return false;
  }
}

function countControlWrites(ctx: CheckContext): number {
  return ctx.requests.filter((r) => isControlWriteApi(r.url)).length;
}

/** The full narrative §9.2/§12.3 asks for beyond `checks-control.ts`'s per-component probes:
 * list → detail → compose+send on a BUSY agent → the new item lands in the LIVE `.queue-list`
 * (a real POST /api/cmd → dev-hub `pushQueueItem` → SSE `status` → Vue re-render round trip —
 * `checks-control.ts`'s composer checks only ever count POSTs, they never assert the queue DOM
 * actually grew) → the two-step stop button aborts. */
async function checkControlSendQueueAbortFlow(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (!isControlFlowCell(ctx.scenario, ctx.width, ctx.theme, ctx.hasTouch)) return [];
  const page = asTypingPage(ctx);
  const results: CheckOutcome[] = [];

  await page.evaluate(() => {
    window.location.hash = "#/";
  });
  await page
    .waitForFunction(() => document.querySelector('a.agent-card[href="#/agent/agent-alpha"]') !== null, {
      timeout: 5_000,
    })
    .catch(() => {});
  const hasCard = await page.evaluate(
    () => document.querySelector('a.agent-card[href="#/agent/agent-alpha"]') !== null,
  );
  if (!hasCard) return [outcome("e2e-control-flow", false, "agent-alpha card not found in the list view")];

  await page.click('a.agent-card[href="#/agent/agent-alpha"]');
  await page
    .waitForFunction(() => document.querySelector(".detail-title") !== null, { timeout: 5_000 })
    .catch(() => {});
  const afterNav = await page.evaluate(() => ({
    hash: window.location.hash,
    hasComposer: document.querySelector(".composer textarea") !== null,
    hasStop: document.querySelector(".stop-btn") !== null,
    queueCountBefore: document.querySelectorAll(".queue-list .queue-item").length,
  }));
  results.push(outcome("e2e-control-flow-list-to-detail", afterNav.hash === AGENT_ALPHA_ROUTE, afterNav.hash));
  if (!afterNav.hasComposer || !afterNav.hasStop) {
    results.push(outcome("e2e-control-flow-detail-controls-present", false, JSON.stringify(afterNav)));
    return results;
  }

  const probeText = "e2e control flow probe " + Date.now();
  await page.click(".composer textarea");
  await page.keyboard.type(probeText);
  await page.waitForTimeout(150);
  const postsBeforeSend = countControlWrites(ctx);
  await page.click(".composer [data-send]");
  await (page as unknown as WaitForArgPage)
    .waitForFunction(
      (needle: string) =>
        Array.from(document.querySelectorAll(".queue-list .queue-item .queue-text")).some((el) =>
          (el.textContent ?? "").includes(needle),
        ),
      probeText,
      { timeout: 5_000 },
    )
    .catch(() => {});
  const afterSend = await page.evaluate((needle: string) => {
    const items = Array.from(document.querySelectorAll(".queue-list .queue-item .queue-text")).map(
      (el) => el.textContent ?? "",
    );
    return { count: items.length, matched: items.some((t) => t.includes(needle)) };
  }, probeText);
  results.push(
    outcome(
      "e2e-control-flow-send-posts-once",
      countControlWrites(ctx) === postsBeforeSend + 1,
      `posts ${postsBeforeSend}→${countControlWrites(ctx)}`,
    ),
  );
  results.push(
    outcome(
      "e2e-control-flow-send-lands-in-live-queue",
      afterSend.count > afterNav.queueCountBefore && afterSend.matched,
      `queueCountBefore=${afterNav.queueCountBefore} after=${JSON.stringify(afterSend)}`,
    ),
  );

  const postsBeforeStop = countControlWrites(ctx);
  await page.click(".stop-btn");
  await page.waitForTimeout(300);
  const armed = await page.evaluate(() => document.querySelector(".stop-btn")?.getAttribute("data-armed") === "true");
  await page.click(".stop-btn");
  await page.waitForTimeout(500);
  results.push(
    outcome(
      "e2e-control-flow-stop-two-step-aborts",
      armed && countControlWrites(ctx) === postsBeforeStop + 1,
      `armed=${armed}, posts ${postsBeforeStop}→${countControlWrites(ctx)}`,
    ),
  );

  await page.evaluate(() => {
    window.location.hash = "#/";
  });
  return results;
}

/** Beyond `checks-control.ts`'s `checkAskUserFormStructure` (which only ever inspects the form's
 * shape, never submits): select the first option, submit, and confirm the LIVE round trip — a
 * real `POST /api/dialog` → dev-hub closes the dialog → SSE `dialogs` push → `AgentDetail`
 * unmounts the now-answered form. */
async function checkAskUserAnswerFlow(ctx: CheckContext): Promise<CheckOutcome[]> {
  if (!isAskUserAnswerCell(ctx.scenario, ctx.width, ctx.theme, ctx.hasTouch)) return [];
  const page = asTypingPage(ctx);
  const present = await page.evaluate(() => document.querySelector(".ask-user-form") !== null);
  if (!present) return [];

  const submitDisabledBefore = await page.evaluate(
    () => (document.querySelector(".ask-user-form [data-submit]") as HTMLButtonElement | null)?.disabled ?? null,
  );
  await page.click('.ask-user-form input[type="radio"]');
  await page.waitForTimeout(150);
  const submitDisabledAfterPick = await page.evaluate(
    () => (document.querySelector(".ask-user-form [data-submit]") as HTMLButtonElement | null)?.disabled ?? null,
  );
  const results: CheckOutcome[] = [
    outcome(
      "e2e-ask-user-answer-enables-submit",
      submitDisabledBefore === true && submitDisabledAfterPick === false,
      `before=${String(submitDisabledBefore)} after=${String(submitDisabledAfterPick)}`,
    ),
  ];

  const postsBefore = countControlWrites(ctx);
  await page.click(".ask-user-form [data-submit]");
  await page
    .waitForFunction(() => document.querySelector(".ask-user-form") === null, { timeout: 5_000 })
    .catch(() => {});
  const formGone = await page.evaluate(() => document.querySelector(".ask-user-form") === null);
  results.push(
    outcome(
      "e2e-ask-user-answer-round-trip-closes-dialog",
      formGone && countControlWrites(ctx) === postsBefore + 1,
      `formGone=${formGone}, posts ${postsBefore}→${countControlWrites(ctx)}`,
    ),
  );
  return results;
}

// ---------------------------------------------------------------------------
// module entry

/** `AGENT_ALPHA_ROUTE` needs no runtime dependency on `window`, but referencing it as a plain
 * top-level `const` from inside a `page.evaluate(() => ...)` closure would try to serialize this
 * module's closure across the Playwright IPC boundary — every call site above instead passes it
 * as an explicit `evaluate(fn, arg)` argument or inlines the literal. This alias exists purely so
 * the string is written once. */
const AGENT_ALPHA_ROUTE_LITERAL = AGENT_ALPHA_ROUTE;

export const check: CheckModule = {
  id: "e2e",
  async run(ctx: CheckContext): Promise<CheckOutcome[]> {
    const page = asE2EPage(ctx);
    const originalHash = await page.evaluate(() => window.location.hash);
    const outcomes: CheckOutcome[] = [];
    try {
      outcomes.push(...(await checkListDetailBackFlow(ctx)));
      outcomes.push(...(await checkLoadOlderGrowsTranscript(ctx)));
      outcomes.push(...(await checkThemeConsistencyAcrossRegions(ctx)));
      outcomes.push(...(await checkNarrowDeepLinkCombination(ctx)));
      outcomes.push(...(await checkDeepLinkToMissingAgentEmptyState(ctx)));
      outcomes.push(...(await checkKeyboardFocusOrder(ctx)));
      outcomes.push(...(await checkAxeAccessibility(ctx)));
      outcomes.push(...(await checkControlSendQueueAbortFlow(ctx)));
      outcomes.push(...(await checkAskUserAnswerFlow(ctx)));
    } finally {
      // Leave the page exactly how the next glob-loaded check module (`checks-shell.ts`, sorted
      // after this file) expects to find it — see this file's header comment.
      await page.evaluate((h) => {
        if (window.location.hash !== h) window.location.hash = h;
      }, originalHash);
      await page.waitForTimeout(150);
    }
    return outcomes;
  },
};
