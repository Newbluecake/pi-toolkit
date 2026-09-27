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
import { createDevHub, DEFAULT_UI_DIST, type DevHubHandle } from "./dev-hub.js";
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
const SCREENSHOT_ONLY_WIDTH = 1440;
const THEMES: readonly ("light" | "dark")[] = ["light", "dark"];
const CELL_HEIGHT = 900;
const SETTLE_MS = 200;

interface MatrixCell {
  readonly width: number;
  readonly theme: "light" | "dark";
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
  readonly screenshotOnly: boolean;
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
        screenshotOnly: false,
        label: `${width}x${theme}${mobile ? "-touch" : ""}`,
      });
    }
    // Extra pass: 1024 with touch (pointer: coarse) alongside the normal mouse-only 1024 pass.
    cells.push({
      width: 1024,
      theme,
      isMobile: false,
      hasTouch: true,
      screenshotOnly: false,
      label: `1024x${theme}-touch`,
    });
  }
  for (const theme of THEMES) {
    cells.push({
      width: SCREENSHOT_ONLY_WIDTH,
      theme,
      isMobile: false,
      hasTouch: false,
      screenshotOnly: true,
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

async function runCell(
  browser: PwBrowser,
  hub: DevHubHandle,
  scenario: ScenarioSpec,
  cell: MatrixCell,
  checks: readonly CheckModule[],
  outDir: string,
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
    const msg = arg as { type(): string; text(): string };
    if (msg.type() === "error") consoleErrors.push(msg.text());
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

  await page.goto(`${origin}/${scenario.route}`, { waitUntil: "load" });
  await page.waitForTimeout(SETTLE_MS);
  await refreshCspViolations();

  const screenshotPath = resolve(outDir, `${scenario.name}-${cell.label}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const outcomes: CheckOutcome[] = [];
  if (!cell.screenshotOnly) {
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
      try {
        console.log(`→ ${scenario.name} (${scenario.mode}, fixture=${scenario.fixture}) on ${hub.url}`);
        for (const cell of cells) {
          const result = await runCell(browser, hub, scenario, cell, checks, opts.outDir);
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
