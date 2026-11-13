/** P0: exercise the actual production terminal artifacts under the unchanged hub CSP. */
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { CSP } from "../../src/web-hub/hub/http.js";
import { loadPlaywright, type PwPage } from "./lib/playwright.js";
import type { UiProvenance } from "./lib/ui-provenance.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIST = resolve(ROOT, "dist/web-hub-ui");
const REPORT_DIR = resolve(ROOT, "node_modules/.cache/pwh-terminal-probe");
const INIT = `
window.__terminalViolations = [];
window.__terminalOriginalSetAttribute = Element.prototype.setAttribute;
document.addEventListener('securitypolicyviolation', e => window.__terminalViolations.push({directive:e.violatedDirective,uri:e.blockedURI}));
`;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function metrics(page: PwPage) {
  return page.evaluate(() => {
    const row = document.querySelector<HTMLElement>(".xterm-rows");
    const host = document.querySelector<HTMLElement>("[data-terminal-spike]");
    const renderer = document.querySelector<HTMLElement>(".terminal-spike-surface")?.dataset["renderer"];
    const canvas = document.querySelector<HTMLCanvasElement>(".xterm-screen canvas");
    const span = row?.querySelector<HTMLElement>("span");
    const screen = document.querySelector<HTMLElement>(".xterm-screen");
    const viewport = document.querySelector<HTMLElement>(".xterm-scrollable-element");
    return {
      renderer,
      canvasWidth: canvas?.width ?? 0,
      canvasHeight: canvas?.height ?? 0,
      rows: Number(host?.dataset["rows"] ?? row?.children.length ?? 0),
      text: host?.dataset["bufferText"] ?? row?.textContent ?? "",
      width: screen?.getBoundingClientRect().width ?? 0,
      height: screen?.getBoundingClientRect().height ?? 0,
      rowHeight: (screen?.getBoundingClientRect().height ?? 0) / Number(host?.dataset["rows"] ?? 1),
      spanDisplay: span ? getComputedStyle(span).display : "",
      spanVerticalAlign: span ? getComputedStyle(span).verticalAlign : "",
      color: row ? getComputedStyle(row).color : "",
      fontSize: host?.dataset["fontSize"] ?? "",
      background: viewport ? getComputedStyle(viewport).backgroundColor : "",
      sheets: document.adoptedStyleSheets.length,
      bridges: document.querySelectorAll("[data-terminal-style-bridge]").length,
      styles: [...document.querySelectorAll("style")].map((s) => ({ type: s.type, text: s.textContent })),
      links: document.querySelectorAll('link[rel="stylesheet"]').length,
      violations: (window as unknown as { __terminalViolations: unknown[] }).__terminalViolations,
      title: document.title,
      status: document.querySelector('[role="status"]')?.textContent,
      hostState: { ...document.querySelector<HTMLElement>("[data-terminal-spike]")?.dataset },
    };
  });
}

export async function runTerminalProbe(selected = "chromium", renderer = "auto"): Promise<void> {
  check(["auto", "dom"].includes(renderer), "--renderer must be auto or dom");
  check(["chromium", "firefox", "both"].includes(selected), "--browser must be chromium, firefox or both");
  await mkdir(REPORT_DIR, { recursive: true });
  const prov = JSON.parse(
    await readFile(resolve(ROOT, "node_modules/.cache/pwh-ui-provenance.json"), "utf8"),
  ) as UiProvenance;
  const host = Object.entries(prov.chunks).find(([, c]) => c.terminalHost)?.[0];
  check(host, "production terminal host missing; run build:web first");
  const terminalAssets = new Set([
    ...Object.entries(prov.chunks)
      .filter(([, c]) => c.terminalExclusive)
      .map(([p]) => `/${p}`),
    ...Object.keys(prov.terminal?.css ?? {}).map((p) => `/${p}`),
  ]);
  const pw = await loadPlaywright();
  if (!pw.ok || (selected !== "chromium" && !pw.firefox)) {
    await writeFile(
      resolve(REPORT_DIR, `report-${renderer}.json`),
      JSON.stringify({ verdict: "NOT RUN", reason: pw.ok ? "Firefox unavailable" : pw.reason }, null, 2),
    );
    process.exitCode = 2;
    return;
  }
  const server = createServer((req, res) => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/terminal-spike.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><title>Terminal P0</title></head><body><main data-terminal-spike></main><script type="module" src="/${host}"></script></body></html>`,
      );
      return;
    }
    if (path === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    if (!/^\/assets\/[\w.-]+\.(js|css)$/.test(path)) {
      res.writeHead(404).end();
      return;
    }
    void readFile(resolve(DIST, path.slice(1))).then(
      (bytes) => {
        res.writeHead(200, { "Content-Type": extname(path) === ".js" ? "text/javascript" : "text/css" });
        res.end(bytes);
      },
      () => res.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolveP, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveP);
  });
  const address = server.address();
  check(address && typeof address !== "string", "probe server has no address");
  const base = `http://127.0.0.1:${address.port}`;
  const rows: unknown[] = [];
  let failed = false;
  let blocked = false;
  if (selected === "chromium")
    rows.push({
      browser: "firefox",
      verdict: "NOT RUN",
      reason: "Not selected; P0 Chromium-only gate (root ruling 2026-11-13)",
    });
  try {
    const engines = [{ name: "chromium", launcher: pw.chromium, executablePath: pw.executablePath }];
    if (pw.firefox)
      engines.push({ name: "firefox", launcher: pw.firefox.launcher, executablePath: pw.firefox.executablePath });
    for (const engine of engines.filter((e) => selected === "both" || e.name === selected)) {
      const errors: string[] = [];
      const warnings: string[] = [];
      const requests: string[] = [];
      let browser;
      let debugPage: PwPage | undefined;
      let negativeEvidence: unknown;
      try {
        browser = await engine.launcher.launch({ headless: true, executablePath: engine.executablePath });
        const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
        await context.addInitScript(INIT);
        const page = await context.newPage();
        debugPage = page;
        const negative = await context.newPage();
        await negative.goto(`${base}/terminal-spike.html?negative=1`, { waitUntil: "load" });
        await negative.click("[data-terminal-open]");
        await negative.waitForFunction(
          () => (window as unknown as { __terminalViolations: unknown[] }).__terminalViolations.length > 0,
          undefined,
          { timeout: 10000 },
        );
        const neg = await metrics(negative);
        check(
          neg.violations.some((v) => (v as { directive: string }).directive.startsWith("style-src")),
          "negative control missed style-src violation",
        );
        check(neg.sheets === 0, "negative control accidentally installed compatibility sheets");
        negativeEvidence = neg;
        await negative.close();
        page.on("console", (message) => {
          const m = message as { type(): string; text(): string };
          if (m.type() === "error") errors.push(m.text());
          else if (m.type() === "warning") warnings.push(m.text());
        });
        page.on("pageerror", (error) => errors.push(String(error)));
        page.on("request", (request) => requests.push((request as { url(): string }).url()));
        await page.goto(`${base}/terminal-spike.html${renderer === "dom" ? "?renderer=dom" : ""}`, {
          waitUntil: "load",
        });
        await page.waitForFunction(() => !!document.querySelector("[data-terminal-open]"), undefined, {
          timeout: 5000,
        });
        const before = await metrics(page);
        check(before.sheets === 0 && before.links === 0, "terminal CSS loaded before click");
        check(
          !requests.some((url) => terminalAssets.has(new URL(url).pathname)),
          "terminal JS/CSS fetched before click",
        );
        await page.click("[data-terminal-open]");
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLElement>("[data-terminal-spike]")?.dataset["ready"] === "true" ||
            document.querySelector<HTMLElement>("[data-terminal-spike]")?.dataset["error"] === "true",
          undefined,
          { timeout: 10000 },
        );
        await (page as PwPage & { screenshot(opts: { path: string }): Promise<unknown> }).screenshot({
          path: resolve(REPORT_DIR, `${engine.name}-${renderer}-initial.png`),
        });
        const cssom = await page.evaluate(() => {
          const root = document.querySelector(".terminal-spike-surface")!;
          const element = document.createElement("span");
          root.appendChild(element);
          element.setAttribute("style", "color: rgb(12, 34, 56)");
          const color = getComputedStyle(element).color;
          element.remove();
          return color;
        });
        check(cssom === "rgb(12, 34, 56)", "root-scoped CSSOM attribute adapter did not apply");
        const initial = await metrics(page);
        check(initial.hostState["error"] !== "true", `terminal host rejected open: ${initial.status}`);
        check(
          initial.text.includes("P0 terminal ready") &&
            initial.text.includes("RED") &&
            initial.text.includes("TRUECOLOR"),
          "rendered terminal text missing",
        );
        check(initial.width > 400 && initial.height > 200 && initial.rowHeight > 10, "terminal layout/measure failed");
        check(
          initial.renderer === "webgl"
            ? initial.canvasWidth > 400 && initial.canvasHeight > 200
            : initial.spanDisplay === "inline-block" && initial.spanVerticalAlign === "top",
          "dimension stylesheet not applied",
        );
        check(initial.sheets === 3 && initial.styles.length === 0, "constructed/inert stylesheet contract broken");
        await page.click("[data-terminal-resize]");
        await page.waitForFunction(
          () => (document.querySelector(".xterm-screen")?.getBoundingClientRect().width ?? 0) > 800,
          undefined,
          { timeout: 5000 },
        );
        const resized = await metrics(page);
        check(resized.width > initial.width && resized.rows > initial.rows, "fit resize did not update layout");
        await page.click("[data-terminal-theme]");
        await page.waitForFunction(
          () => {
            const viewport = document.querySelector(".xterm-scrollable-element");
            return viewport && getComputedStyle(viewport).backgroundColor === "rgb(240, 224, 208)";
          },
          undefined,
          { timeout: 5000 },
        );
        const themed = await metrics(page);
        check(themed.background === "rgb(240, 224, 208)", "theme background not applied");
        await page.click("[data-terminal-font]");
        await page.waitForFunction(
          () => {
            return document.querySelector<HTMLElement>("[data-terminal-spike]")?.dataset["fontSize"] === "18";
          },
          undefined,
          { timeout: 5000 },
        );
        const font = await metrics(page);
        check(font.rowHeight > initial.rowHeight, "font remeasurement failed");
        await page.click("[data-terminal-replay]");
        await page.waitForFunction(
          () => document.querySelector<HTMLElement>("[data-terminal-spike]")?.dataset["replayed"] === "true",
          undefined,
          { timeout: 5000 },
        );
        const replay = await metrics(page);
        check(
          replay.text.includes("REPLAY") && replay.title === "Terminal P0",
          "alternate-screen/replay/OSC title guard failed",
        );
        check(!requests.some((url) => url.includes("probe-sink")), "OSC caused a resource request");
        check(
          replay.violations.length === 0 && errors.length === 0,
          `positive violations=${replay.violations.length}, consoleErrors=${errors.length}; first=${JSON.stringify({ violations: replay.violations.slice(0, 3), errors: errors.slice(0, 3) })}`,
        );
        await (page as PwPage & { screenshot(opts: { path: string }): Promise<unknown> }).screenshot({
          path: resolve(REPORT_DIR, `${engine.name}-${renderer}.png`),
        });
        await page.click("[data-terminal-dispose]");
        const disposed = await metrics(page);
        check(
          await page.evaluate(
            () =>
              Element.prototype.setAttribute ===
              (window as unknown as { __terminalOriginalSetAttribute: unknown }).__terminalOriginalSetAttribute,
          ),
          "attribute adapter not restored on dispose",
        );
        check(
          disposed.sheets === before.sheets && disposed.links === 0 && disposed.styles.length === 0,
          "dispose leaked stylesheets/styles/links",
        );
        // A second mount exercises per-instance IDs and cleanup rather than just one lucky open.
        await page.click("[data-terminal-open]");
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLElement>("[data-terminal-spike]")?.dataset["ready"] === "true" ||
            document.querySelector<HTMLElement>("[data-terminal-spike]")?.dataset["error"] === "true",
          undefined,
          { timeout: 10000 },
        );
        const remounted = await metrics(page);
        check(remounted.sheets === 3, "remount stylesheet count incorrect");
        check(remounted.violations.length === 0 && errors.length === 0, "remount added CSP/console errors");
        await page.click("[data-terminal-dispose]");
        rows.push({
          browser: engine.name,
          executablePath: engine.executablePath,
          verdict: "PASS",
          before,
          initial,
          resized,
          themed,
          font,
          replay,
          disposed,
          negative: negativeEvidence,
          errors,
          warnings,
          requests,
        });
        await context.close();
      } catch (error) {
        if (!browser) blocked = true;
        else failed = true;
        rows.push({
          browser: engine.name,
          verdict: browser ? "FAIL" : "NOT RUN",
          error: String(error),
          diagnostic: debugPage ? await metrics(debugPage).catch(() => null) : null,
          negative: negativeEvidence,
          errors,
          warnings,
          requests,
        });
        console.error(`[${engine.name}] ${String(error)}`);
      } finally {
        await browser?.close();
      }
    }
  } finally {
    server.close();
  }
  await writeFile(
    resolve(REPORT_DIR, `report-${renderer}.json`),
    JSON.stringify(
      { verdict: failed ? "FAIL" : blocked ? "BLOCKED" : "PASS", playwright: pw.version, renderer, csp: CSP, rows },
      null,
      2,
    ),
  );
  if (failed) process.exitCode = 1;
  else if (blocked) process.exitCode = 2;
  else console.log(`✓ probe:csp --suite terminal — ${selected} PASS (${REPORT_DIR}/report-${renderer}.json)`);
}
