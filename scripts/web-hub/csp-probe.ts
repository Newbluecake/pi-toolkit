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
 * preview-perf P5 (plan r3 §5.3) adds the WORKER case to the positive page: the real
 * `highlight-worker-client` + real module worker chunk must load, tokenize and transfer
 * `HighlightSpans` back — and it must pass on Chromium AND Firefox (plan: 「Chromium 和
 * Firefox 都要实测通过」; Firefox therefore became a hard requirement of the base probe,
 * like the mermaid suite — missing cached Firefox is exit 2).
 *
 * `--suite mermaid` (`npm run probe:mermaid`): the web-hub-mermaid real-browser gate (plan §10.4), Chromium + Firefox;
 * `--lan` additionally serves the probe build on 0.0.0.0 for the S0 real-device run.
 *
 * Exit codes: 0 = pass; 1 = assertion failure (CSP violated, or something computed wrong); 2 =
 * Playwright/Chromium unavailable (offline cache miss and no network).
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { CSP } from "../../src/web-hub/hub/http.js";
import { loadPlaywright, type PwPage } from "./lib/playwright.js";
import { runMermaidSuite } from "./mermaid-probe-suite.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VITE_CONFIG = resolve(REPO_ROOT, "src/web-hub/ui/vite.config.ts");
const PROBE_OUT_DIR = resolve(REPO_ROOT, "node_modules/.cache/pwh-csp-probe");
const PORT = 42111;
const MERMAID_REPORT = resolve(REPO_ROOT, "node_modules/.cache/pwh-mermaid-probe-report.json");
/** Paths the mermaid suite's pages request on purpose to prove they are NEVER fetched (plan §10.4 N group). */
const SINK_PREFIX = "/probe-sink/";
const sinkHits: string[] = [];
const PROBE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Minimal static server for the probe's own build output (a plain Vite `outDir`, not a
 * manifest-verified UI root) — deliberately simpler than `hub/static.ts`'s `createUiServer`,
 * which trusts nothing without a signed manifest; this script's own output is the only thing it
 * ever serves, from a fixed `node_modules/.cache/` path this process itself just built. */
async function serveProbeFile(urlPath: string, res: import("node:http").ServerResponse): Promise<boolean> {
  const rel = urlPath.split("?")[0] === "/" ? "index.html" : (urlPath.split("?")[0] ?? "").replace(/^\//, "");
  if (rel.includes("..") || rel.includes("\0")) return false;
  const ct = PROBE_CONTENT_TYPES[extname(rel).toLowerCase()];
  if (ct === undefined) return false;
  try {
    const data = await readFile(resolve(PROBE_OUT_DIR, rel));
    res.writeHead(200, { "Content-Type": ct, "Content-Length": data.length });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}
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

async function startServer(host = "127.0.0.1"): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if ((req.url ?? "").startsWith(SINK_PREFIX)) {
      sinkHits.push((req.url ?? "").split("?")[0] ?? "");
      res.writeHead(404).end();
      return;
    }
    void serveProbeFile(req.url ?? "/", res).then((served) => {
      if (!served && !res.headersSent) {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolveP, rejectP) => {
    server.once("error", rejectP);
    server.listen(PORT, host, () => resolveP());
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
  await page.waitForFunction(
    () => (window as unknown as { __PWH_PROBE_READY__?: boolean }).__PWH_PROBE_READY__ === true,
    { timeout: 5_000 },
  );

  // preview-perf P5 §5.3 — the module-worker case FIRST, so a blocked worker script also
  // shows up in the violations read at the end of this function. "spans-ok" is the only
  // passing outcome: the worker loaded under the production CSP, tokenized the sample, and
  // its transferred HighlightSpans decode back into tok-* parts (the page computes it). Any
  // other outcome ("fallback" = worker unavailable/CSP-rejected, "plain", "spans-bad",
  // still "pending" after 10 s) fails with the outcome string as the detail.
  await page.waitForFunction(
    () => (window as unknown as { __PWH_WORKER_RESULT__?: string }).__PWH_WORKER_RESULT__ !== undefined,
    { timeout: 10_000 },
  );
  const workerResult = await page.evaluate<string>(
    () => (window as unknown as { __PWH_WORKER_RESULT__?: string }).__PWH_WORKER_RESULT__ ?? "",
  );
  if (workerResult !== "spans-ok") {
    failures.push({ assertion: "worker-highlight", detail: `worker outcome: ${workerResult}` });
  }

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
  await page.waitForFunction(
    () => (window as unknown as { __PWH_PROBE_READY__?: boolean }).__PWH_PROBE_READY__ === true,
    { timeout: 5_000 },
  );
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

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** `--suite mermaid`: Chromium + Firefox × corpus groups R/N/C/F/M/L (plan §10.4). `--lan`: only SERVE the probe
 * build on 0.0.0.0 (S0 real-device test) — no authentication, development only. */
async function mainMermaid(): Promise<void> {
  const lan = process.argv.includes("--lan");
  if (lan) {
    console.warn(
      "⚠ --lan binds 0.0.0.0 and serves ONLY the probe build output, with NO authentication. Development use only.",
    );
    const { port } = await startServer("0.0.0.0");
    console.log(`  open http://<this-machine-lan-ip>:${port}/mermaid.html — Ctrl-C to stop`);
    await new Promise(() => undefined);
    return;
  }
  console.log("→ loading local Playwright + Chromium + Firefox");
  const pw = await loadPlaywright();
  if (!pw.ok || pw.firefox === undefined) {
    console.error(`✗ browser unavailable: ${pw.ok ? "no cached Firefox build" : pw.reason}`);
    process.exit(2);
  }
  console.log(
    `  playwright ${pw.version} (${pw.source}); chromium ${pw.executablePath}; firefox ${pw.firefox.executablePath}`,
  );
  const { server, port } = await startServer();
  try {
    const chromiumExe = pw.executablePath;
    const firefox = pw.firefox;
    const { failures } = await runMermaidSuite({
      base: `http://127.0.0.1:${port}`,
      outDir: PROBE_OUT_DIR,
      sinkHits,
      reportPath: MERMAID_REPORT,
      launchers: [
        { name: "chromium", launch: () => pw.chromium.launch({ headless: true, executablePath: chromiumExe }) },
        {
          name: "firefox",
          launch: () => firefox.launcher.launch({ headless: true, executablePath: firefox.executablePath }),
        },
      ],
    });
    if (failures.length === 0) {
      console.log(`✓ probe:mermaid — PASS (Chromium + Firefox). Report: ${MERMAID_REPORT}`);
      process.exit(0);
    }
    console.error(`✗ probe:mermaid — ${failures.length} assertion(s) failed (report: ${MERMAID_REPORT}):`);
    for (const f of failures.slice(0, 60)) console.error(`  - [${f.browser}] ${f.caseId}: ${f.assertion}: ${f.detail}`);
    process.exit(1);
  } finally {
    server.close();
  }
}

async function main(): Promise<void> {
  console.log("→ building csp-probe entries via vite.config.ts --mode csp-probe");
  await build({ configFile: VITE_CONFIG, mode: "csp-probe", logLevel: "warn" });
  if (argValue("--suite") === "mermaid") return mainMermaid();

  console.log("→ loading local Playwright + Chromium");
  const pw = await loadPlaywright();
  if (!pw.ok) {
    console.error(`✗ browser unavailable: ${pw.reason}`);
    console.error(
      "  (conservative fallback per plan §4.4.1: treat as if the probe failed — disable both :style and v-show)",
    );
    process.exit(2);
  }
  if (pw.firefox === undefined) {
    // preview-perf P5 §5.3: the worker case must pass on Firefox too — a missing cached
    // Firefox build is "browser unavailable" (exit 2), same envelope as the mermaid suite.
    console.error(
      "✗ browser unavailable: no cached Firefox build for the P5 worker case (probe:csp requires Chromium + Firefox)",
    );
    process.exit(2);
  }
  console.log(`  playwright ${pw.version} (${pw.source}), chromium at ${pw.executablePath}`);
  console.log(`  firefox at ${pw.firefox.executablePath}`);

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
    // preview-perf P5 §5.3 — the worker case on FIREFOX as well (the positive suite's other
    // assertions stay Chromium-only, exactly as before): load the page, wait for the worker
    // outcome, assert spans-ok + zero violations recorded by the init script.
    const firefox = await pw.firefox.launcher.launch({ headless: true, executablePath: pw.firefox.executablePath });
    try {
      const context = await firefox.newContext();
      await context.addInitScript(INIT_SCRIPT);
      const page = await context.newPage();
      await page.goto(`${base}/index.html`, { waitUntil: "load" });
      await page.waitForFunction(
        () => (window as unknown as { __PWH_PROBE_READY__?: boolean }).__PWH_PROBE_READY__ === true,
        { timeout: 5_000 },
      );
      await page.waitForFunction(
        () => (window as unknown as { __PWH_WORKER_RESULT__?: string }).__PWH_WORKER_RESULT__ !== undefined,
        { timeout: 10_000 },
      );
      const ffWorker = await page.evaluate<string>(
        () => (window as unknown as { __PWH_WORKER_RESULT__?: string }).__PWH_WORKER_RESULT__ ?? "",
      );
      if (ffWorker !== "spans-ok") {
        failures.push({ assertion: "worker-highlight-firefox", detail: `worker outcome: ${ffWorker}` });
      }
      const ffViolations = await violations(page);
      if (ffViolations.length !== 0) {
        failures.push({ assertion: "zero-csp-violations-firefox", detail: JSON.stringify(ffViolations) });
      }
      await context.close();
    } finally {
      await firefox.close();
    }
  } finally {
    server.close();
  }

  if (failures.length === 0) {
    console.log("✓ probe:csp — PASS. All :style / v-show / dynamic-class / static-hoisting constructs are CSP-clean.");
    console.log("  verdict: no source-scan tightening needed.");
    console.log(
      "  P5 worker: module worker + HighlightSpans transfer OK under the production CSP (Chromium + Firefox).",
    );
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
