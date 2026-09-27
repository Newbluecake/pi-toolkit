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
 * narrow and one split-view width have been exercised.
 */
import type { CheckContext, CheckModule, CheckOutcome, ExtPage } from "../visual.js";
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

  await page.evaluate((h) => {
    window.location.hash = h;
  }, AGENT_ALPHA_ROUTE_LITERAL);
  await page
    .waitForFunction(() => document.querySelectorAll(".tx-item").length > 0, { timeout: 5_000 })
    .catch(() => {});

  const hasOlder = await page.evaluate(() => document.querySelector(".tx-older") !== null);
  if (!hasOlder) {
    return [pass("e2e-load-older-grows-transcript", "not applicable: no .tx-older button for this fixture/agent")];
  }

  await page.click(".tx-older");
  // `tests/fixtures/web-hub-ui/dashboard.json`'s `historyOlder["agent-alpha"]` page reports
  // `hasMore: false` — the deterministic, content-independent signal that the round trip (click
  // → `hub.loadOlder` → real `/api/history` request → dispatched `page` event → re-render)
  // actually completed is the "Load Older Messages" button disappearing. (Whether the fetched
  // entry itself becomes *visible* additionally depends on `state.js`'s legacy `messageKey`
  // role+timestamp dedup, which this fixture's entries — lacking their own `message.timestamp`,
  // only an entry-level one — happen to collide on; that is a fixture-data quality finding for
  // whoever owns `dashboard.json`, not a P3/P4 regression, and is reported separately rather
  // than encoded as a flaky content assertion here.)
  const settled = await page
    .waitForFunction(() => document.querySelector(".tx-older") === null, { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  const stillPaging = await page.evaluate(() => document.querySelector(".tx-divider .label") !== null);
  return [
    outcome(
      "e2e-load-older-round-trips",
      settled,
      settled ? undefined : `still-paging=${stillPaging} — .tx-older never cleared after click`,
    ),
  ];
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

/** Presses Tab up to `maxSteps` times, recording the focused element after each press. Stops
 * early once focus leaves the page onto `<body>` (Chromium's signal that the tab order has run
 * out of focusable elements and moved to browser chrome) — a bounded walk, never poll-forever,
 * matching this repo's own `csp-probe`/`visual.ts` convention of deterministic timeouts over
 * unbounded loops. */
/** Presses Tab up to `maxSteps` times, recording the focused element after each press. Stops
 * early once focus leaves the page onto `<body>` (Chromium's signal that the tab order has run
 * out of focusable elements and moved to browser chrome) — a bounded walk, never poll-forever,
 * matching this repo's own `csp-probe`/`visual.ts` convention of deterministic timeouts over
 * unbounded loops. The terminal `<body>` step itself is never included in the returned list —
 * its bounding rect is the whole viewport, which trivially "overlaps" everything including the
 * dock, and it isn't a real focusable page element to begin with. */
async function walkTabOrder(page: E2EPage, maxSteps: number): Promise<FocusStep[]> {
  const steps: FocusStep[] = [];
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
    if (step === null || step.isBody) break;
    steps.push({ selector: step.selector, rect: step.rect, inDock: step.inDock });
  }
  return steps;
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
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector(".detail-head") !== null, { timeout: 8_000 }).catch(() => {});
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  const steps = await walkTabOrder(page, 80);
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
    results.push(pass("e2e-focus-order-dock-reachable", "not applicable: .dock not found"));
    results.push(pass("e2e-focus-order-no-overlap-with-dock", "not applicable: .dock not found"));
  } else {
    const dockReached = steps.some((s) => s.inDock);
    results.push(outcome("e2e-focus-order-dock-reachable", dockReached, `${steps.length} tab step(s) walked`));

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
// module entry
// ---------------------------------------------------------------------------

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
