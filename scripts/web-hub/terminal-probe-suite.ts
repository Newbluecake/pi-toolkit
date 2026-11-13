/** WebGL-only P0: actual production artifacts, unchanged hub CSP, no transport/backend. */
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { CSP } from "../../src/web-hub/hub/http.js";
import { loadPlaywright, type PwPage, type PwBrowser } from "./lib/playwright.js";
import type { UiProvenance } from "./lib/ui-provenance.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIST = resolve(ROOT, "dist/web-hub-ui");
const OUT = resolve(ROOT, "node_modules/.cache/pwh-terminal-probe");
const INIT = `
window.__violations = []; window.__states = []; window.__visibleDomFallbacks = 0;
window.__originalAttribute = Element.prototype.setAttribute;
window.__originalFactory = document.createElement;
document.addEventListener('securitypolicyviolation', e => window.__violations.push({directive:e.violatedDirective,uri:e.blockedURI}));
document.addEventListener('DOMContentLoaded', () => {
  new MutationObserver(() => {
    for (const row of document.querySelectorAll('.xterm-rows')) {
      if (getComputedStyle(row).visibility !== 'hidden') window.__visibleDomFallbacks++;
    }
    const host = document.querySelector('[data-terminal-spike]');
    if (host && host.dataset.state) {
      const state = {phase:host.dataset.state,rebuilds:Number(host.dataset.rebuilds||0)};
      if (JSON.stringify(window.__states.at(-1)) !== JSON.stringify(state)) window.__states.push(state);
    }
  }).observe(document.documentElement, {subtree:true,childList:true,attributes:true});
});
`;
function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}
const wait = (page: PwPage, fn: () => unknown, timeout = 10_000) => page.waitForFunction(fn, undefined, { timeout });
async function metrics(page: PwPage) {
  return page.evaluate(() => {
    const w = window as unknown as {
      __violations: unknown[];
      __states: unknown[];
      __visibleDomFallbacks: number;
      __originalAttribute: unknown;
      __originalFactory: unknown;
    };
    const host = document.querySelector<HTMLElement>("[data-terminal-spike]");
    const screen = document.querySelector(".xterm-screen");
    const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-terminal-webgl-canvas]");
    const viewport = document.querySelector(".xterm-scrollable-element");
    const surface = document.querySelector<HTMLElement>(".terminal-spike-surface");
    const width = screen?.getBoundingClientRect().width ?? 0,
      height = screen?.getBoundingClientRect().height ?? 0;
    return {
      phase: host?.dataset["state"],
      rebuilds: Number(host?.dataset["rebuilds"] ?? 0),
      renderer: surface?.dataset["renderer"],
      ready: host?.dataset["ready"],
      text: host?.dataset["bufferText"] ?? "",
      rows: Number(host?.dataset["rows"] ?? 0),
      font: Number(host?.dataset["fontSize"] ?? 0),
      contrast: Number(host?.dataset["contrast"] ?? 0),
      width,
      height,
      cellHeight: height / Number(host?.dataset["rows"] ?? 1),
      canvasWidth: canvas?.width ?? 0,
      canvasHeight: canvas?.height ?? 0,
      background: viewport ? getComputedStyle(viewport).backgroundColor : "",
      reason: document.querySelector('[role="status"]')?.textContent ?? "",
      xterms: document.querySelectorAll(".xterm").length,
      styles: document.querySelectorAll("style").length,
      sheets: document.adoptedStyleSheets.length,
      links: document.querySelectorAll('link[rel="stylesheet"]').length,
      violations: w.__violations,
      states: w.__states,
      visibleDomFallbacks: w.__visibleDomFallbacks,
      prototypeStable:
        Element.prototype.setAttribute === w.__originalAttribute && document.createElement === w.__originalFactory,
      title: document.title,
    };
  });
}
async function loseContext(page: PwPage, failRebuild = false) {
  await page.evaluate((fail) => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-terminal-webgl-canvas]")!;
    const gl = canvas.getContext("webgl2")!;
    const extension = gl.getExtension("WEBGL_lose_context");
    if (!extension) throw new Error("WEBGL_lose_context unavailable");
    (window as unknown as { __previousCanvas: unknown }).__previousCanvas = canvas;
    if (fail) {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
        return type === "webgl2" ? null : Reflect.apply(original, this, [type, ...args]);
      } as typeof original;
    }
    extension.loseContext();
  }, failRebuild);
}

export async function runTerminalProbe(selected = "chromium"): Promise<void> {
  check(selected === "chromium", "Terminal P0 uses Chromium; Firefox is explicitly NOT RUN by root ruling");
  await mkdir(OUT, { recursive: true });
  const prov = JSON.parse(
    await readFile(resolve(ROOT, "node_modules/.cache/pwh-ui-provenance.json"), "utf8"),
  ) as UiProvenance;
  const host = Object.entries(prov.chunks).find(([, c]) => c.terminalHost)?.[0];
  check(host, "production host missing; run build:web");
  const terminalAssets = new Set([
    ...Object.entries(prov.chunks)
      .filter(([, c]) => c.terminalExclusive)
      .map(([p]) => `/${p}`),
    ...Object.keys(prov.terminal?.css ?? {}).map((p) => `/${p}`),
  ]);
  const pw = await loadPlaywright();
  if (!pw.ok) {
    await writeFile(resolve(OUT, "report-r3.json"), JSON.stringify({ verdict: "NOT RUN", reason: pw.reason }, null, 2));
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
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  check(address && typeof address !== "string", "server address missing");
  const base = `http://127.0.0.1:${address.port}`;
  const results: unknown[] = [
    {
      browser: "firefox",
      verdict: "NOT RUN",
      reason: "root ruling: GTK3 absent; NSS >=3.113 required; no system upgrade",
    },
  ];
  let failed = false;
  let blocked = false;
  const run = async (
    browser: PwBrowser,
    id: string,
    init: string,
    action: (page: PwPage, requests: string[]) => Promise<unknown>,
    negative = false,
  ) => {
    const errors: string[] = [],
      warnings: string[] = [],
      requests: string[] = [];
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await context.addInitScript(INIT + init);
    const page = await context.newPage();
    page.on("console", (message) => {
      const m = message as { type(): string; text(): string };
      if (m.type() === "error") errors.push(m.text());
      else if (m.type() === "warning") warnings.push(m.text());
    });
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("request", (request) => requests.push((request as { url(): string }).url()));
    try {
      await page.goto(`${base}/terminal-spike.html`, { waitUntil: "load" });
      await wait(page, () => !!document.querySelector("[data-terminal-open]"));
      const details = await action(page, requests);
      const final = await metrics(page);
      if (!negative) {
        check(
          final.violations.length === 0 && errors.length === 0,
          `CSP/console errors: ${final.violations.length}/${errors.length}`,
        );
        check(
          final.visibleDomFallbacks === 0 && final.prototypeStable,
          "visible DOM fallback or DOM prototype mutation detected",
        );
      }
      results.push({ id, verdict: "PASS", details, final, errors, warnings, requests });
    } catch (error) {
      failed = true;
      results.push({
        id,
        verdict: "FAIL",
        error: String(error),
        diagnostic: await metrics(page).catch(() => null),
        errors,
        warnings,
        requests,
      });
      console.error(`[${id}] ${String(error)}`);
    } finally {
      await context.close();
    }
  };
  const open = async (page: PwPage) => {
    await page.click("[data-terminal-open]");
    await wait(
      page,
      () =>
        !!document.querySelector(".xterm") ||
        document.querySelector<HTMLElement>("[data-terminal-spike]")?.dataset["error"] === "true",
    );
    const opening = await page.evaluate(() =>
      [
        ".terminal-spike-surface",
        ".terminal-spike-viewport",
        ".xterm",
        ".xterm-screen",
        "canvas[data-terminal-webgl-canvas]",
      ].map((sel) => {
        const e = document.querySelector<HTMLElement>(sel);
        const c = e as HTMLCanvasElement | null;
        return {
          sel,
          dataset: e ? { ...e.dataset } : {},
          width: e?.getBoundingClientRect().width,
          height: e?.getBoundingClientRect().height,
          visibility: e ? getComputedStyle(e).visibility : "",
          cw: c?.width,
          ch: c?.height,
        };
      }),
    );
    await wait(
      page,
      () =>
        document.querySelector<HTMLElement>("[data-terminal-spike]")?.dataset["ready"] === "true" ||
        document.querySelector<HTMLElement>("[data-terminal-spike]")?.dataset["error"] === "true",
    );
    const m = await metrics(page);
    check(
      m.ready === "true" && m.renderer === "webgl",
      `WebGL did not start: ${m.reason}; opening=${JSON.stringify(opening)}`,
    );
    return m;
  };
  const screenshot = (page: PwPage, id: string) =>
    (page as PwPage & { screenshot(opts: { path: string }): Promise<unknown> }).screenshot({
      path: resolve(OUT, `${id}.png`),
    });
  let browser: PwBrowser | undefined;
  try {
    browser = await pw.chromium.launch({ headless: true, executablePath: pw.executablePath });
    await run(browser, "webgl-normal-and-recovery", "", async (page, requests) => {
      const before = await metrics(page);
      check(
        before.sheets === 0 && before.links === 0 && !requests.some((url) => terminalAssets.has(new URL(url).pathname)),
        "terminal resource loaded before click",
      );
      const initial = await open(page);
      check(
        initial.text.includes("TRUECOLOR") &&
          initial.contrast === 7 &&
          initial.width > 400 &&
          initial.height > 200 &&
          initial.sheets === 3 &&
          initial.styles === 0,
        "render/truecolor/contrast/style contract failed",
      );
      await screenshot(page, "r3-chromium-initial");
      await page.click("[data-terminal-resize]");
      await wait(page, () => (document.querySelector(".xterm-screen")?.getBoundingClientRect().width ?? 0) > 800);
      const resized = await metrics(page);
      check(resized.rows > initial.rows, "resize did not change rows");
      await page.click("[data-terminal-theme]");
      await wait(page, () => {
        const e = document.querySelector(".xterm-scrollable-element");
        return e && getComputedStyle(e).backgroundColor === "rgb(240, 224, 208)";
      });
      const themed = await metrics(page);
      await page.click("[data-terminal-font]");
      await wait(
        page,
        () => document.querySelector<HTMLElement>("[data-terminal-spike]")?.dataset["fontSize"] === "18",
      );
      const font = await metrics(page);
      check(font.cellHeight > initial.cellHeight, "font measurement did not update");
      await page.click("[data-terminal-replay]");
      await wait(
        page,
        () => document.querySelector<HTMLElement>("[data-terminal-spike]")?.dataset["replayed"] === "true",
      );
      const replay = await metrics(page);
      check(
        replay.text.includes("REPLAY") &&
          replay.title === "Terminal P0" &&
          !requests.some((url) => url.includes("probe-sink")),
        "alternate screen/OSC guard failed",
      );
      await screenshot(page, "r3-chromium-themed");
      await loseContext(page);
      await wait(page, () => {
        const host = document.querySelector<HTMLElement>("[data-terminal-spike]");
        return host?.dataset["ready"] === "true" && host.dataset["rebuilds"] === "1";
      });
      const recovered = await metrics(page);
      check(
        await page.evaluate(
          () =>
            document.querySelector("canvas[data-terminal-webgl-canvas]") !==
            (window as unknown as { __previousCanvas: unknown }).__previousCanvas,
        ),
        "renderer was not recreated",
      );
      check(
        recovered.renderer === "webgl" &&
          recovered.contrast === 7 &&
          recovered.font === 18 &&
          recovered.background === themed.background,
        "recovery lost renderer/options",
      );
      await screenshot(page, "r3-chromium-recovered");
      await loseContext(page);
      await wait(
        page,
        () => document.querySelector<HTMLElement>("[data-terminal-spike]")?.dataset["state"] === "reopen-required",
      );
      const exhausted = await metrics(page);
      check(
        exhausted.rebuilds === 1 && exhausted.xterms === 0 && exhausted.reason.includes("请重开终端"),
        "second loss exceeded retry budget or fell back",
      );
      await page.click("[data-terminal-dispose]");
      const disposed = await metrics(page);
      check(disposed.sheets === 0 && disposed.links === 0 && disposed.styles === 0, "dispose leaked resources");
      await open(page);
      await page.click("[data-terminal-dispose]");
      return { before, initial, resized, themed, font, replay, recovered, exhausted, disposed };
    });
    await run(browser, "recovery-fails-no-dom-fallback", "", async (page) => {
      await open(page);
      await loseContext(page, true);
      await wait(
        page,
        () => document.querySelector<HTMLElement>("[data-terminal-spike]")?.dataset["state"] === "reopen-required",
      );
      const failure = await metrics(page);
      check(
        failure.rebuilds === 1 && failure.reason.includes("请重开终端") && failure.xterms === 0 && failure.sheets === 0,
        "failed rebuild did not stop cleanly",
      );
      await screenshot(page, "r3-chromium-reopen-required");
      await page.click("[data-terminal-dispose]");
      return failure;
    });
    const unavailable = async (page: PwPage) => {
      await page.click("[data-terminal-open]");
      await wait(page, () => {
        const h = document.querySelector<HTMLElement>("[data-terminal-spike]");
        return h?.dataset["state"] === "unavailable" || h?.dataset["ready"] === "true";
      });
      const m = await metrics(page);
      check(
        m.phase === "unavailable" &&
          m.ready !== "true" &&
          m.xterms === 0 &&
          m.sheets === 0 &&
          m.reason.includes("终端未启动"),
        "unavailable WebGL silently started a renderer",
      );
      return m;
    };
    await run(
      browser,
      "getcontext-null",
      `const get = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function(type,...args) { return type === 'webgl2' ? null : get.call(this,type,...args); };`,
      unavailable,
    );
    await run(
      browser,
      "getcontext-throws",
      `const get = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function(type,...args) { if(type === 'webgl2') throw new Error('probe WebGL disabled'); return get.call(this,type,...args); };`,
      unavailable,
    );
    await run(
      browser,
      "addon-activation-fails",
      `const get = HTMLCanvasElement.prototype.getContext; let calls=0; HTMLCanvasElement.prototype.getContext = function(type,...args) { if(type === 'webgl2' && ++calls > 2) return null; return get.call(this,type,...args); };`,
      unavailable,
    );
    await run(
      browser,
      "negative-control",
      "",
      async (page) => {
        await page.evaluate(() => {
          const target = document.createElement("div");
          target.id = "negative-target";
          document.body.appendChild(target);
          const style = document.createElement("style");
          style.textContent = "#negative-target { color: rgb(1, 2, 3); }";
          document.head.appendChild(style);
        });
        await wait(page, () => (window as unknown as { __violations: unknown[] }).__violations.length > 0);
        const m = await metrics(page);
        check(
          m.violations.some((v) => (v as { directive: string }).directive.startsWith("style-src")),
          "CSP negative control missed inline stylesheet",
        );
        check(
          await page.evaluate(
            () => getComputedStyle(document.querySelector("#negative-target")!).color !== "rgb(1, 2, 3)",
          ),
          "forbidden negative style was applied",
        );
        return m;
      },
      true,
    );
    await browser.close();
    browser = undefined;
    browser = await pw.chromium.launch({
      headless: true,
      executablePath: pw.executablePath,
      args: ["--disable-webgl"],
    });
    await run(browser, "webgl-disabled-launch-flag", "", async (page) => {
      const m = await unavailable(page);
      await screenshot(page, "r3-chromium-webgl-disabled");
      return m;
    });
  } catch (error) {
    blocked = true;
    results.push({ verdict: "NOT RUN", error: String(error) });
    console.error(String(error));
  } finally {
    await browser?.close();
    server.close();
  }
  const verdict = failed ? "FAIL" : blocked ? "BLOCKED" : "PASS";
  await writeFile(
    resolve(OUT, "report-r3.json"),
    JSON.stringify({ verdict, playwright: pw.version, chromium: pw.executablePath, csp: CSP, results }, null, 2),
  );
  process.exitCode = failed ? 1 : blocked ? 2 : 0;
  console.log(`${verdict === "PASS" ? "✓" : "✗"} terminal WebGL-only P0 ${verdict}: ${OUT}/report-r3.json`);
}
