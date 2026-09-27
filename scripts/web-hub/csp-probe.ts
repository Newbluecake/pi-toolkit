#!/usr/bin/env -S npx tsx
/**
 * P0 browser-level CSP probe (`npm run probe:csp`, vue-plan.md v2.1 §4.4.1, §5.2). Builds the
 * `csp-probe/` entries through the exact same `vite.config.ts` the real production bundle
 * uses, serves the output under the real `CSP` header (imported, never re-typed) from
 * `src/web-hub/hub/http.ts`, and drives a locally-cached headless Chromium (via
 * `lib/playwright.ts`) to prove — or disprove — every CSP-sensitive Vue construct the plan
 * relies on: object `:style` bindings (percentage + px), `v-show`, numeric `:class` switching,
 * and Vue's large-static-block hoisting path. A reverse control (`negative.html`) proves the
 * violation listener actually catches violations at all (a probe that can't see the thing it's
 * supposed to detect would otherwise report a false "all clear").
 *
 * Exit codes: 0 = pass; 1 = assertion failure (CSP violated, or something computed wrong); 2 =
 * Playwright/Chromium unavailable (offline cache miss and no network).
 */
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { CSP } from "../../src/web-hub/hub/http.js";
import { serveStatic } from "../../src/web-hub/hub/static.js";
import { loadPlaywright, type PwPage } from "./lib/playwright.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VITE_CONFIG = resolve(REPO_ROOT, "src/web-hub/ui/vite.config.ts");
const PROBE_OUT_DIR = resolve(REPO_ROOT, "node_modules/.cache/pwh-csp-probe");
const PORT = 42111;
const INIT_SCRIPT = `
  window.__pwhViolations = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__pwhViolations.push({ violatedDirective: e.violatedDirective, blockedURI: e.blockedURI });
  });
`;

interface Failure {
  readonly assertion: string;
  readonly detail: string;
}

async function startServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    void serveStatic(PROBE_OUT_DIR, req.url ?? "/", res).then((served) => {
      if (!served && !res.headersSent) {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolveP, rejectP) => {
    server.once("error", rejectP);
    server.listen(PORT, "127.0.0.1", () => resolveP());
  });
  return { server, port: PORT };
}

async function readComputed(page: PwPage, selector: string, prop: string): Promise<string> {
  return page.evaluate<string, { selector: string; prop: string }>(
    ({ selector: sel, prop: p }) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`missing element: ${sel}`);
      return getComputedStyle(el).getPropertyValue(p);
    },
    { selector, prop },
  );
}

async function violations(page: PwPage): Promise<Array<{ violatedDirective: string; blockedURI: string }>> {
  return page.evaluate(() => (window as unknown as { __pwhViolations: unknown[] }).__pwhViolations) as Promise<
    Array<{ violatedDirective: string; blockedURI: string }>
  >;
}

async function runPositive(page: PwPage, base: string, failures: Failure[]): Promise<void> {
  await page.goto(`${base}/index.html`, { waitUntil: "load" });
  await page.waitForFunction("window.__PWH_PROBE_READY__ === true", { timeout: 5_000 });

  const pctWidth = parseFloat(await readComputed(page, '[data-probe="pct"]', "width"));
  if (!(Math.abs(pctWidth - 210) <= 1)) {
    failures.push({ assertion: "style-object-percent", detail: `pct width computed ${pctWidth}px, expected ~210px` });
  }

  const pxWidth = parseFloat(await readComputed(page, '[data-probe="width"]', "width"));
  if (!(Math.abs(pxWidth - 10) <= 0.5)) {
    failures.push({ assertion: "style-object-px", detail: `width computed ${pxWidth}px, expected 10px` });
  }

  const displayBefore = await readComputed(page, '[data-probe="vshow"]', "display");
  if (displayBefore === "none") failures.push({ assertion: "v-show-initial", detail: "vshow box hidden at load" });
  await page.click('[data-action="toggle-vshow"]');
  const displayAfter = await readComputed(page, '[data-probe="vshow"]', "display");
  if (displayAfter !== "none")
    failures.push({ assertion: "v-show-toggle", detail: "vshow box still visible after toggle" });

  const bgLevel1 = await readComputed(page, '[data-probe="level"]', "background-color");
  if (bgLevel1 !== "rgb(11, 122, 112)") {
    failures.push({ assertion: "dynamic-class-initial", detail: `level-1 background ${bgLevel1}` });
  }
  await page.click('[data-action="cycle-level"]');
  const bgLevel2 = await readComputed(page, '[data-probe="level"]', "background-color");
  if (bgLevel2 !== "rgb(31, 95, 196)") {
    failures.push({ assertion: "dynamic-class-cycle", detail: `level-2 background ${bgLevel2}` });
  }

  const staticCount = await page.evaluate(() => document.querySelectorAll('[data-probe="static"] .s').length);
  if (staticCount !== 30) {
    failures.push({ assertion: "static-block-count", detail: `expected 30 static siblings, saw ${staticCount}` });
  }

  const styleTagCount = await page.evaluate(() => document.querySelectorAll("style").length);
  if (styleTagCount !== 0) failures.push({ assertion: "no-style-tags", detail: `${styleTagCount} <style> tags found` });

  const scriptsMissingSrc = await page.evaluate(
    () => Array.from(document.querySelectorAll("script")).filter((s) => s.getAttribute("src") === null).length,
  );
  if (scriptsMissingSrc !== 0) {
    failures.push({ assertion: "no-inline-scripts", detail: `${scriptsMissingSrc} <script> without src` });
  }

  const v = await violations(page);
  if (v.length !== 0) {
    failures.push({ assertion: "zero-csp-violations", detail: JSON.stringify(v) });
  }
}

async function runNegative(page: PwPage, base: string, failures: Failure[]): Promise<void> {
  await page.goto(`${base}/negative.html`, { waitUntil: "load" });
  await page.waitForFunction("window.__PWH_PROBE_READY__ === true", { timeout: 5_000 });
  const color = await readComputed(page, "#target", "color");
  if (color === "rgb(1, 2, 3)") {
    failures.push({
      assertion: "negative-control-applied",
      detail: "forbidden inline style color WAS applied — CSP not enforced",
    });
  }
  const v = await violations(page);
  const styleAttrViolations = v.filter((x) => x.violatedDirective.startsWith("style-src"));
  if (styleAttrViolations.length === 0) {
    failures.push({
      assertion: "negative-control-detected",
      detail:
        "expected at least one style-src violation from the deliberate inline style= — probe cannot detect real violations",
    });
  }
}

async function main(): Promise<void> {
  console.log("→ building csp-probe entries via vite.config.ts --mode csp-probe");
  await build({ configFile: VITE_CONFIG, mode: "csp-probe", logLevel: "warn" });

  console.log("→ loading local Playwright + Chromium");
  const pw = await loadPlaywright();
  if (!pw.ok) {
    console.error(`✗ browser unavailable: ${pw.reason}`);
    console.error(
      "  (conservative fallback per plan §4.4.1: treat as if the probe failed — disable both :style and v-show)",
    );
    process.exit(2);
  }
  console.log(`  playwright ${pw.version} (${pw.source}), chromium at ${pw.executablePath}`);

  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const failures: Failure[] = [];
  try {
    const browser = await pw.chromium.launch({ headless: true, executablePath: pw.executablePath });
    try {
      const context = await browser.newContext();
      await context.addInitScript(INIT_SCRIPT);
      const page = await context.newPage();
      await runPositive(page, base, failures);
      const negPage = await context.newPage();
      await runNegative(negPage, base, failures);
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
  }

  if (failures.length === 0) {
    console.log("✓ probe:csp — PASS. All :style / v-show / dynamic-class / static-hoisting constructs are CSP-clean.");
    console.log("  verdict: no source-scan tightening needed.");
    process.exit(0);
  }

  console.error(`✗ probe:csp — ${failures.length} assertion(s) failed:`);
  for (const f of failures) console.error(`  - ${f.assertion}: ${f.detail}`);
  const styleFailed = failures.some((f) => f.assertion.startsWith("style-object"));
  const vshowFailed = failures.some((f) => f.assertion.startsWith("v-show"));
  console.error("  verdict: per plan §4.4.1 —");
  console.error(
    `    :style object bindings: ${styleFailed ? "TIGHTEN (ban entirely; use class steps / <meter>)" : "ok"}`,
  );
  console.error(`    v-show: ${vshowFailed ? "TIGHTEN (ban; use v-if)" : "ok"}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
