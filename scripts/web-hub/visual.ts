#!/usr/bin/env -S npx tsx
/**
 * Visual acceptance harness (`npm run visual:web`, vue-plan.md v2.1 §4.4.2, §4.5, §5.2 — P2
 * framework; assertion modules are per-package, glob-loaded, see below).
 *
 * Starts one `dev-hub` instance per matrix scenario (real production `dist/web-hub-ui/` bytes +
 * the real `CSP` header — never a mock DOM), drives a locally cached headless Chromium (via
 * `lib/playwright.ts`) across the breakpoint × color-scheme matrix, screenshots every cell to
 * `/tmp/pwh-visual/<run>/`, and runs every `scripts/web-hub/visual/checks-*.ts` module found on
 * disk against each cell. This file never gains new assertions itself — P3/P4/P6 each add their
 * own `checks-<package>.ts` (glob-discovered, sorted by filename) without touching this one;
 * `checks-common.ts` (P2, the only module that exists today) is the sole thing wired in yet, so
 * a P2-only run legitimately has nothing else to load.
 *
 * Exit codes: 0 = every check in every cell passed; 1 = at least one check failed; 2 = Chromium
 * unavailable (see `lib/playwright.ts`).
 */
import { globSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDevHub, DEFAULT_UI_DIST, loadFixture, type DevHubFixture, type DevHubHandle } from "./dev-hub.js";
import { loadPlaywright, type PwBrowser, type PwContext, type PwPage } from "./lib/playwright.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HERE = fileURLToPath(new URL(".", import.meta.url));

// ---------------------------------------------------------------------------
// check module contract (framework surface — stable across P2/P3/P4/P6)
// ---------------------------------------------------------------------------

/** Everything Playwright can actually do on a page, beyond `lib/playwright.ts`'s minimal
 * `PwPage` (which only covers what `csp-probe.ts` needed). Cast, never a `lib/playwright.ts`
 * edit — that file is P0's exclusive frozen surface; the extra methods already exist at
 * runtime on the real Playwright `Page`, this is purely a local TS view of them. */
export interface ExtPage extends PwPage {
  reload(opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" }): Promise<unknown>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<Buffer>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  on(event: "console" | "pageerror" | "request" | "requestfailed" | "response", handler: (arg: unknown) => void): void;
  waitForTimeout(ms: number): Promise<void>;
}

export interface CspViolation {
  readonly violatedDirective: string;
  readonly blockedURI: string;
}

export interface RequestRecord {
  readonly url: string;
  readonly sameOrigin: boolean;
}

export interface FailedRequestRecord {
  readonly url: string;
  readonly reason: string;
}

export interface CheckContext {
  readonly page: ExtPage;
  readonly baseUrl: string;
  readonly scenario: string;
  readonly width: number;
  readonly theme: "light" | "dark";
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
  readonly requests: readonly RequestRecord[];
  readonly failedRequests: readonly FailedRequestRecord[];
  readonly cspViolations: readonly CspViolation[];
  /** True iff the fixture backing this cell's dev-hub declares a `fleet` script event for the
   * currently routed agent (`agentKeyFromRoute`/`fixtureExpectsFleetRows`, computed once per
   * scenario) — i.e. `.fleet` rows are known to be reachable, not merely possible. Lets
   * `checks-body.ts`'s `checkFleetDefaultOpen` tell "this fixture genuinely has no fleet data"
   * (still not-applicable) apart from "the fleet frame never got applied in time" (a real
   * regression, per the P1 dashboard.json:330-416 timing bug this field exists to close). */
  readonly expectFleetRows: boolean;
  /** Pulls `window.__pwhViolations` from the *current* document and merges it into
   * `cspViolations`. CSP violations are page-JS state that resets on every navigation, unlike
   * the Node-side request/console listeners (attached once, cover the whole context lifetime)
   * — call this after any reload/navigation your own check performs. */
  refreshCspViolations(): Promise<void>;
}

export interface CheckOutcome {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface CheckModule {
  readonly id: string;
  run(ctx: CheckContext): Promise<CheckOutcome[]>;
}

// ---------------------------------------------------------------------------
// matrix
// ---------------------------------------------------------------------------

interface ScenarioSpec {
  readonly name: string;
  readonly mode: "token" | "password";
  readonly fixture: string;
  readonly route: string;
}

/** ui-design §6 matrix scenarios (vue-plan.md §4.4.2). `detail`/`long` reuse another fixture's
 * dev-hub with a direct `#/agent/<key>` deep link; `login` runs in password mode against the
 * (agent-less) `empty` fixture since the login page never reaches the dashboard. */
const DEFAULT_SCENARIOS: readonly ScenarioSpec[] = [
  { name: "dashboard", mode: "token", fixture: "dashboard", route: "#/" },
  { name: "detail", mode: "token", fixture: "dashboard", route: "#/agent/agent-alpha" },
  { name: "login", mode: "password", fixture: "empty", route: "#/" },
  { name: "states", mode: "token", fixture: "states", route: "#/" },
  { name: "long", mode: "token", fixture: "long", route: "#/agent/agent-long" },
];

const BREAKPOINTS: readonly number[] = [375, 481, 767, 768, 1024, 1025];
const EXTRA_WIDTH = 1440;
const THEMES: readonly ("light" | "dark")[] = ["light", "dark"];
const CELL_HEIGHT = 900;
const SETTLE_MS = 200;

interface MatrixCell {
  readonly width: number;
  readonly theme: "light" | "dark";
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
  readonly label: string;
}

function buildCells(): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (const theme of THEMES) {
    for (const width of BREAKPOINTS) {
      const mobile = width <= 767;
      cells.push({
        width,
        theme,
        isMobile: mobile,
        hasTouch: mobile,
        label: `${width}x${theme}${mobile ? "-touch" : ""}`,
      });
    }
    // Extra pass: 1024 with touch (pointer: coarse) alongside the normal mouse-only 1024 pass.
    cells.push({
      width: 1024,
      theme,
      isMobile: false,
      hasTouch: true,
      label: `1024x${theme}-touch`,
    });
  }
  // P2's own `SCREENSHOT_ONLY_WIDTH` used to skip every check at 1440 (issue D, todo #26 W3
  // 打回点 D) — a wide desktop cell that silently ran zero assertions, including
  // `checks-shell.ts`'s own split/sidebar-width checks (`expectedSidebarWidth` already covers
  // 1280+ → 340px) which are just as meaningful at 1440 as at 1025. Runs the same full check set
  // as every other cell now — the "extra" here is purely that it isn't part of the documented
  // breakpoint set, not that it gets special (lesser) treatment.
  for (const theme of THEMES) {
    cells.push({
      width: EXTRA_WIDTH,
      theme,
      isMobile: false,
      hasTouch: false,
      label: `1440x${theme}`,
    });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// check module loading
// ---------------------------------------------------------------------------

async function loadCheckModules(): Promise<CheckModule[]> {
  const files = globSync("checks-*.ts", { cwd: resolve(HERE, "visual") })
    .map((f) => resolve(HERE, "visual", f))
    .sort();
  const mods: CheckModule[] = [];
  for (const file of files) {
    const imported = (await import(pathToFileURL(file).href)) as { check?: CheckModule; default?: CheckModule };
    const mod = imported.check ?? imported.default;
    if (mod === undefined || typeof mod.run !== "function") {
      throw new Error(`visual:web — ${file} does not export a CheckModule ("check" or default)`);
    }
    mods.push(mod);
  }
  return mods;
}

// ---------------------------------------------------------------------------
// per-cell run
// ---------------------------------------------------------------------------

const VIOLATION_INIT_SCRIPT = `
  window.__pwhViolations = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__pwhViolations.push({ violatedDirective: e.violatedDirective, blockedURI: e.blockedURI });
  });
`;

/** Strict origin comparison (verifier fix): a naive `url.startsWith(origin)` treats
 * `http://127.0.0.1:1234.evil.example/` as same-origin with `http://127.0.0.1:1234` (the prefix
 * matches even though the host is entirely different) — parse both sides and compare the actual
 * `URL#origin` instead. `data:`/`about:` URLs have no meaningful origin to compare (blank pages,
 * inlined resources) and are always treated as same-origin, matching the previous behavior. */
export function isSameOrigin(url: string, origin: string): boolean {
  if (url.startsWith("data:") || url.startsWith("about:")) return true;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

interface CellResult {
  readonly scenario: string;
  readonly label: string;
  readonly screenshot: string;
  readonly outcomes: CheckOutcome[];
}

/** Extracts the agent key `AgentDetail.vue` will end up routed to from a scenario's hash route
 * (`"#/agent/agent-alpha"` → `"agent-alpha"`), or `undefined` for a non-agent route (`"#/"`). */
export function agentKeyFromRoute(route: string): string | undefined {
  const m = /^#\/agent\/(.+)$/.exec(route);
  return m?.[1];
}

/** True iff `fixture`'s script declares a `fleet` frame — scoped (`DevHubScriptEvent.agentKey`)
 * or embedded (`data.agentKey`, mirroring `dev-hub.ts`'s own fallback) — for `agentKey`, with at
 * least one row. Used by `runCell` to decide whether it is worth waiting for `.fleet .run` to
 * appear before screenshotting/checking (P1 fix: the P2 fixed `SETTLE_MS` was shorter than the
 * fixture's own `atMs`, so the fleet frame never had a chance to land in time — see
 * dashboard.json's `atMs: 250` fleet event vs. the old 200ms settle). */
export function fixtureExpectsFleetRows(fixture: DevHubFixture, agentKey: string | undefined): boolean {
  if (agentKey === undefined) return false;
  for (const ev of fixture.script ?? []) {
    if (ev.event !== "fleet") continue;
    const dataAgentKey = (ev.data as { agentKey?: unknown } | undefined)?.agentKey;
    const scopedKey = ev.agentKey ?? (typeof dataAgentKey === "string" ? dataAgentKey : undefined);
    if (scopedKey !== agentKey) continue;
    const runs = (ev.data as { runs?: unknown } | undefined)?.runs;
    if (Array.isArray(runs) && runs.length > 0) return true;
  }
  return false;
}

/** Deterministic timeout for `.fleet .run` to appear once we know (`fixtureExpectsFleetRows`)
 * that a fleet frame IS coming for the routed agent — generous enough to absorb the render
 * gate's throttle window (`RenderGateOptions.intervalMs`, default 100ms) plus the fixture's own
 * `atMs` delay, but still bounded (never an unbounded/poll-forever wait). */
const FLEET_WAIT_TIMEOUT_MS = 5_000;

async function runCell(
  browser: PwBrowser,
  hub: DevHubHandle,
  scenario: ScenarioSpec,
  cell: MatrixCell,
  checks: readonly CheckModule[],
  outDir: string,
  expectFleetRows: boolean,
): Promise<CellResult> {
  const context = (await browser.newContext({
    viewport: { width: cell.width, height: CELL_HEIGHT },
    colorScheme: cell.theme,
    reducedMotion: "reduce",
    isMobile: cell.isMobile,
    hasTouch: cell.hasTouch,
    deviceScaleFactor: 1,
  })) as PwContext;
  await context.addInitScript(VIOLATION_INIT_SCRIPT);

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requests: RequestRecord[] = [];
  const failedRequests: FailedRequestRecord[] = [];
  const cspViolations: CspViolation[] = [];

  const page = (await context.newPage()) as unknown as ExtPage;
  const origin = hub.url;
  page.on("console", (arg: unknown) => {
    const msg = arg as { type(): string; text(): string; location?: () => { url?: string } };
    if (msg.type() !== "error") return;
    const loc = typeof msg.location === "function" ? msg.location() : undefined;
    consoleErrors.push(loc?.url ? `${msg.text()} [${loc.url}]` : msg.text());
  });
  page.on("pageerror", (arg: unknown) => {
    const err = arg as Error;
    pageErrors.push(err.message ?? String(err));
  });
  page.on("request", (arg: unknown) => {
    const req = arg as { url(): string };
    const url = req.url();
    requests.push({ url, sameOrigin: isSameOrigin(url, origin) });
  });
  page.on("requestfailed", (arg: unknown) => {
    const req = arg as { url(): string; failure(): { errorText: string } | null };
    failedRequests.push({ url: req.url(), reason: req.failure()?.errorText ?? "unknown" });
  });
  page.on("response", (arg: unknown) => {
    const res = arg as { url(): string; status(): number };
    if (res.status() >= 400) failedRequests.push({ url: res.url(), reason: `HTTP ${res.status()}` });
  });

  async function refreshCspViolations(): Promise<void> {
    const fresh = await page.evaluate(
      () => (window as unknown as { __pwhViolations?: CspViolation[] }).__pwhViolations ?? [],
    );
    cspViolations.push(...fresh);
  }

  // Token mode: `page.goto(origin + scenario.route)` never authenticates — the token/session
  // exchange only happens client-side, triggered by a `#t=<token>` fragment (`token-client.js`'s
  // `start()`, see `useHashRoute.ts`'s ordering-constraint doc comment). Without it every token
  // scenario (dashboard/detail/states/long) sits at `conn==="auth"` ⇒ `TokenGate` forever. Load
  // the login fragment first, wait deterministically for the authenticated shell (`.app`) to
  // mount (never a fixed sleep — `openStream()`'s SSE `hello` frame timing is not fixed), then
  // move to the scenario's real route as a client-side hash assignment (never a second `#`
  // concatenated onto the goto URL, and never a second full navigation, which would re-run
  // `start()` against an already-cleared fragment and race the just-established session).
  if (scenario.mode === "token") {
    if (hub.token === undefined)
      throw new Error(`visual: dev-hub in token mode returned no token for scenario "${scenario.name}"`);
    await page.goto(`${origin}/#t=${encodeURIComponent(hub.token)}`, { waitUntil: "load" });
    await page.waitForFunction(() => document.querySelector(".app") !== null, { timeout: 15_000 });
    if (scenario.route !== "#/") {
      await page.evaluate((route) => {
        window.location.hash = route;
      }, scenario.route);
    }
  } else {
    await page.goto(`${origin}/${scenario.route}`, { waitUntil: "load" });
  }
  if (expectFleetRows) {
    await page
      .waitForFunction(() => document.querySelectorAll(".fleet .run").length > 0, {
        timeout: FLEET_WAIT_TIMEOUT_MS,
      })
      .catch(() => {
        // Timed out: leave it to `checks-body.ts`'s `checkFleetDefaultOpen` (told via
        // `expectFleetRows` on `CheckContext`) to report this as a real failure — never swallow
        // it silently, and never retry with a longer sleep.
      });
  }
  await page.waitForTimeout(SETTLE_MS);
  await refreshCspViolations();

  const screenshotPath = resolve(outDir, `${scenario.name}-${cell.label}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const outcomes: CheckOutcome[] = [];
  {
    const ctx: CheckContext = {
      page,
      baseUrl: origin,
      scenario: scenario.name,
      width: cell.width,
      theme: cell.theme,
      isMobile: cell.isMobile,
      hasTouch: cell.hasTouch,
      consoleErrors,
      pageErrors,
      requests,
      failedRequests,
      cspViolations,
      refreshCspViolations,
      expectFleetRows,
    };
    for (const mod of checks) {
      const results = await mod.run(ctx);
      outcomes.push(...results);
    }
  }

  await context.close();
  return { scenario: scenario.name, label: cell.label, screenshot: screenshotPath, outcomes };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface VisualOptions {
  readonly root: string;
  readonly outDir: string;
  readonly scenarios: readonly string[];
}

function parseArgs(argv: readonly string[]): VisualOptions {
  let root = DEFAULT_UI_DIST;
  let outDir = resolve("/tmp/pwh-visual", String(Date.now()));
  let scenarios: readonly string[] = DEFAULT_SCENARIOS.map((s) => s.name);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`visual:web: missing value for ${a}`);
      return v;
    };
    if (a === "--root") root = resolve(next());
    else if (a === "--out-dir") outDir = resolve(next());
    else if (a === "--scenario" || a === "--scenarios")
      scenarios = next()
        .split(",")
        .map((s) => s.trim());
    else throw new Error(`visual:web: unknown argument "${a}"`);
  }
  return { root, outDir, scenarios };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`→ loading local Playwright + Chromium`);
  const pw = await loadPlaywright();
  if (!pw.ok) {
    console.error(`✗ browser unavailable: ${pw.reason}`);
    process.exit(2);
    return;
  }
  console.log(`  playwright ${pw.version} (${pw.source})`);

  await mkdir(opts.outDir, { recursive: true });
  console.log(`→ screenshots + report → ${opts.outDir}`);

  const checks = await loadCheckModules();
  console.log(`→ loaded ${checks.length} check module(s): ${checks.map((c) => c.id).join(", ") || "(none yet)"}`);

  const cells = buildCells();
  const scenarioSpecs = DEFAULT_SCENARIOS.filter((s) => opts.scenarios.includes(s.name));
  if (scenarioSpecs.length === 0) {
    throw new Error(
      `visual:web: no matching scenarios in --scenarios (known: ${DEFAULT_SCENARIOS.map((s) => s.name).join(",")})`,
    );
  }

  const browser = await pw.chromium.launch({ headless: true, executablePath: pw.executablePath });
  const allResults: CellResult[] = [];
  try {
    for (const scenario of scenarioSpecs) {
      const hub = await createDevHub({
        mode: scenario.mode,
        scenario: scenario.fixture,
        root: opts.root,
        log: () => {},
      });
      const fixture = await loadFixture(scenario.fixture);
      const expectFleetRows = fixtureExpectsFleetRows(fixture, agentKeyFromRoute(scenario.route));
      try {
        console.log(`→ ${scenario.name} (${scenario.mode}, fixture=${scenario.fixture}) on ${hub.url}`);
        for (const cell of cells) {
          const result = await runCell(browser, hub, scenario, cell, checks, opts.outDir, expectFleetRows);
          allResults.push(result);
          const failed = result.outcomes.filter((o) => !o.ok);
          console.log(
            `  ${scenario.name} ${cell.label}: ${result.outcomes.length - failed.length}/${result.outcomes.length} checks ok`,
          );
        }
      } finally {
        await hub.close();
      }
    }
  } finally {
    await browser.close();
  }

  const failures = allResults.flatMap((r) => r.outcomes.filter((o) => !o.ok).map((o) => ({ ...r, outcome: o })));
  const reportJson = { root: REPO_ROOT, uiRoot: opts.root, cells: allResults, failureCount: failures.length };
  await writeFile(resolve(opts.outDir, "report.json"), JSON.stringify(reportJson, null, 2));

  const lines: string[] = [];
  lines.push(`pwh visual:web report — ${allResults.length} cell(s), ${failures.length} failing check(s)`);
  for (const f of failures) {
    lines.push(`  ✗ [${f.scenario} ${f.label}] ${f.outcome.name}: ${f.outcome.detail ?? "failed"}`);
  }
  if (failures.length === 0) lines.push("  ✓ all checks passed");
  await writeFile(resolve(opts.outDir, "report.txt"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));

  if (failures.length > 0) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMain()) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
