/**
 * Mermaid probe suite (web-hub-mermaid plan §10.4) — `npm run probe:mermaid`. Driven from
 * `scripts/web-hub/csp-probe.ts --suite mermaid`, which owns the build, the static server (real
 * production `CSP` header) and the Playwright loading. Groups R/N/C/F/M/L run in Chromium AND Firefox;
 * both must be clean. Authority for "zero requests" is Playwright's own `request` event plus the
 * server-side `/probe-sink/*` log — never in-page heuristics.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { CORPUS, USER_FLOW, type ProbeCase } from "../../src/web-hub/ui/csp-probe/mermaid-corpus.js";
import { MERMAID_ALLOWED_TYPES } from "../../src/web-hub/ui/src/logic/mermaid.js";
import type { PwBrowser, PwContext, PwPage, PwRequest } from "./lib/playwright.js";

export interface SuiteEnv {
  base: string;
  /** Absolute probe build directory (to gzip chunk sizes). */
  outDir: string;
  /** Server-side `/probe-sink/*` log (shared array, never reset by the suite except through `sinkHits.length`). */
  sinkHits: string[];
  reportPath: string;
  launchers: Array<{ name: "chromium" | "firefox"; launch: () => Promise<PwBrowser> }>;
}

interface Failure {
  browser: string;
  caseId: string;
  assertion: string;
  detail: string;
}

interface Api {
  render(text: string, theme: "light" | "dark", wantSvg?: boolean): Promise<RenderReport>;
  sinkControl(): Promise<boolean>;
  fontFamily(): string;
  engineState(): string;
  dom(): { bad: string[]; bodyAdds: string[] };
  resetDom(): void;
  violations(): Array<{ directive: string; uri: string }>;
  bodyChildren(): string[];
  svgToImageHuge(): boolean;
  effectiveConfig(text: string, theme: "light" | "dark"): Promise<Record<string, unknown>>;
  parseCostMs(text: string, rounds: number): Promise<number>;
}

interface RenderReport {
  outcome: "ok" | "error" | "cancelled";
  reason?: string;
  message?: string;
  diagramType?: string;
  width?: number;
  height?: number;
  decoded?: boolean;
  naturalWidth?: number;
  ms: number;
  svg?: string;
  srcLength?: number;
}

const ALLOWED_BODY_ADD = new Set(["div#cy", "div#katex-temp"]);
const SITE_SANITIZE_TAGS = [
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "del",
  "sub",
  "sup",
  "small",
  "mark",
  "code",
  "br",
  "span",
  "p",
  "div",
];

/** Evaluate a call with serializable arguments against `window.__pwh`. */
function callApi<T>(page: PwPage, method: keyof Api, ...args: unknown[]): Promise<T> {
  return page.evaluate<T, { method: string; args: unknown[] }>(
    ({ method: m, args: a }) => {
      const api = (window as unknown as { __pwh: Record<string, (...x: unknown[]) => unknown> }).__pwh;
      return api[m]!(...a) as Promise<T>;
    },
    { method, args },
  );
}

const MEASURE_FN = (): Array<{ what: string; label: string; box: string; shape: string }> => {
  const bad: Array<{ what: string; label: string; box: string; shape: string }> = [];
  const TOL = 2;
  const rectOf = (el: Element): DOMRect => el.getBoundingClientRect();
  const inside = (inner: DOMRect, outer: DOMRect): boolean =>
    inner.left >= outer.left - TOL &&
    inner.right <= outer.right + TOL &&
    inner.top >= outer.top - TOL &&
    inner.bottom <= outer.bottom + TOL;
  const fmt = (r: DOMRect): string =>
    `${r.left.toFixed(1)},${r.top.toFixed(1)},${r.width.toFixed(1)}x${r.height.toFixed(1)}`;
  // flowchart / state / class / mindmap nodes: every <text> of a node must sit inside the node's shape.
  for (const node of Array.from(document.querySelectorAll("g.node"))) {
    const shape = Array.from(
      node.querySelectorAll(
        ":scope > rect, :scope > polygon, :scope > circle, :scope > ellipse, :scope > path, :scope > g > rect.label-container, :scope > g > path",
      ),
    ).filter((e) => !e.closest(".label"))[0];
    if (!shape) continue;
    const sr = rectOf(shape);
    if (sr.width === 0) continue;
    for (const t of Array.from(node.querySelectorAll("text"))) {
      const tr = rectOf(t);
      if (tr.width === 0) continue;
      if (!inside(tr, sr))
        bad.push({ what: "node-text", label: (t.textContent ?? "").slice(0, 30), box: fmt(tr), shape: fmt(sr) });
    }
  }
  // sequence actors: text.actor must sit inside the preceding rect.actor.
  for (const text of Array.from(document.querySelectorAll("text.actor"))) {
    const rect = text.previousElementSibling;
    if (!rect || !rect.matches("rect.actor")) continue;
    if (!inside(rectOf(text), rectOf(rect))) {
      bad.push({
        what: "actor-text",
        label: (text.textContent ?? "").slice(0, 30),
        box: fmt(rectOf(text)),
        shape: fmt(rectOf(rect)),
      });
    }
  }
  return bad;
};

export async function runMermaidSuite(
  env: SuiteEnv,
): Promise<{ failures: Failure[]; report: Record<string, unknown> }> {
  const failures: Failure[] = [];
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), browsers: {} };
  const fail = (browser: string, caseId: string, assertion: string, detail: string): void => {
    failures.push({ browser, caseId, assertion, detail });
  };

  for (const launcher of env.launchers) {
    const browser = await launcher.launch();
    const b: Record<string, unknown> = {};
    (report["browsers"] as Record<string, unknown>)[launcher.name] = b;
    try {
      await runBrowser(launcher.name, browser, env, b, fail);
    } finally {
      await browser.close();
    }
  }
  await writeFile(env.reportPath, `${JSON.stringify(report, null, 1)}\n`, "utf8");
  return { failures, report };
}

type FailFn = (browser: string, caseId: string, assertion: string, detail: string) => void;

const INIT_SCRIPT = `
  window.__name = window.__name || ((f) => f); // tsx/esbuild keepNames helper leaks into serialized evaluate() functions
  window.__pwhWarn = [];
  const w = console.warn.bind(console);
  console.warn = (...a) => { try { window.__pwhWarn.push(a.map(String).join(" ")); } catch (e) {} w(...a); };
`;

const COARSE_INIT = `
  const mm = window.matchMedia.bind(window);
  const noop = () => {};
  window.matchMedia = (q) => /pointer:\\s*coarse/.test(q)
    ? { matches: true, media: q, onchange: null, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop, dispatchEvent: () => false }
    : mm(q);
`;

async function newProbePage(
  ctx: PwContext,
  base: string,
  requests: Array<{ url: string; type: string; at: number }>,
  consoleWarn: string[],
): Promise<PwPage> {
  const page = await ctx.newPage();
  page.on("request", (r) => {
    const req = r as PwRequest;
    requests.push({ url: req.url(), type: req.resourceType(), at: Date.now() });
  });
  page.on("console", (m) => {
    const msg = m as { text(): string };
    const text = msg.text();
    if (text.includes("[pwh-mermaid]")) consoleWarn.push(text);
  });
  await page.goto(`${base}/mermaid.html`, { waitUntil: "load" });
  await page.waitForFunction("window.__PWH_PROBE_READY__ === true", { timeout: 10_000 });
  return page;
}

function isAllowedRequest(url: string, base: string): boolean {
  if (!url.startsWith(base)) return false;
  const path = url.slice(base.length).split("?")[0] ?? "";
  return path === "/mermaid.html" || path.startsWith("/assets/") || path === "/favicon.ico";
}

async function runBrowser(
  name: string,
  browser: PwBrowser,
  env: SuiteEnv,
  out: Record<string, unknown>,
  fail: FailFn,
): Promise<void> {
  const ctx = await browser.newContext();
  await ctx.addInitScript(INIT_SCRIPT);
  const requests: Array<{ url: string; type: string; at: number }> = [];
  const warns: string[] = [];

  /* ---- L (pre-engine): oversize input must be refused WITHOUT loading the engine ---- */
  {
    const page = await newProbePage(ctx, env.base, requests, warns);
    for (const c of CORPUS.filter((x) => x.id === "l-too-long" || x.id === "l-too-many-chars")) {
      const r = await callApi<RenderReport>(page, "render", c.text, "light");
      if (r.outcome !== "error" || r.reason !== "too-large")
        fail(name, c.id, "too-large-without-engine", JSON.stringify(r));
    }
    const engineLoads = requests.filter((q) => /\/assets\/mmd-/.test(q.url));
    if (engineLoads.length > 0)
      fail(name, "l-pre-engine", "engine-not-loaded", `${engineLoads.length} mermaid chunks requested`);
    if ((await callApi<boolean>(page, "svgToImageHuge")) !== true)
      fail(name, "l-huge-viewbox", "output-invalid", "svgToImage accepted a huge viewBox");
    await page.close();
  }

  /* ---- main page: R / N / C / M / F / rest of L, one warm engine ---- */
  const page = await newProbePage(ctx, env.base, requests, warns);
  requests.length = 0;
  warns.length = 0;

  // Sink control: prove the request log can see a sink hit at all (a probe blind to hits proves nothing).
  const sinkBefore = env.sinkHits.length;
  await callApi<boolean>(page, "sinkControl");
  const controlSeen =
    env.sinkHits.length > sinkBefore && requests.some((q) => q.url.includes("/probe-sink/control.png"));
  if (!controlSeen) fail(name, "sink-control", "sink-detects-requests", "positive control request was not observed");
  requests.length = 0;
  const sinkBaseline = env.sinkHits.length;
  await callApi(page, "resetDom");

  const results: Array<Record<string, unknown>> = [];
  const typesSeen = new Set<string>();
  const coldWarm: Record<string, unknown> = {};
  let bodyBaseline: string[] | undefined;
  let loadMarks: Array<{ at: string; chunks: string[] }> = [];

  const check = async (c: ProbeCase, theme: "light" | "dark", wantSvg: boolean): Promise<RenderReport> => {
    const reqStart = requests.length;
    const sinkStart = env.sinkHits.length;
    const r = await callApi<RenderReport>(page, "render", c.text, theme, wantSvg);
    const tag = `${c.id}/${theme}`;
    // outcome expectation
    if (c.expect.kind === "ok") {
      if (r.outcome !== "ok") fail(name, tag, "expected-ok", JSON.stringify(r));
      else {
        if (!r.decoded || (r.naturalWidth ?? 0) <= 0)
          fail(name, tag, "img-decodes", JSON.stringify({ ...r, svg: undefined }));
        if (r.diagramType) typesSeen.add(r.diagramType);
        if (r.diagramType && !MERMAID_ALLOWED_TYPES.has(r.diagramType))
          fail(name, tag, "type-allowed", String(r.diagramType));
      }
    } else if (c.expect.kind === "error") {
      if (r.outcome !== "error" || !c.expect.reasons.includes(r.reason ?? "")) {
        fail(
          name,
          tag,
          "expected-error",
          `want ${c.expect.reasons.join("|")}, got ${JSON.stringify({ ...r, svg: undefined })}`,
        );
      }
    }
    // network: nothing but engine chunks and the page itself; zero sink hits (server + browser view)
    for (const q of requests.slice(reqStart)) {
      if (!isAllowedRequest(q.url, env.base)) fail(name, tag, "no-unexpected-request", q.url);
    }
    if (env.sinkHits.length !== sinkStart) fail(name, tag, "zero-sink-hits", env.sinkHits.slice(sinkStart).join(","));
    // DOM side effects
    const dom = await callApi<{ bad: string[]; bodyAdds: string[] }>(page, "dom");
    if (dom.bad.length > 0) fail(name, tag, "no-resource-nodes-in-stage", dom.bad.join(","));
    await callApi(page, "resetDom");
    const chunks = requests
      .slice(reqStart)
      .filter((q) => /\/assets\/.*\.js/.test(q.url))
      .map((q) => q.url.split("/assets/")[1] ?? q.url);
    if (chunks.length > 0) loadMarks.push({ at: tag, chunks });
    const kids = await callApi<string[]>(page, "bodyChildren");
    if (bodyBaseline === undefined && r.outcome === "ok") bodyBaseline = kids;
    else if (bodyBaseline !== undefined && JSON.stringify(kids) !== JSON.stringify(bodyBaseline)) {
      fail(name, tag, "body-children-stable", `${bodyBaseline.join(",")} -> ${kids.join(",")}`);
    }
    results.push({ id: c.id, theme, outcome: r.outcome, reason: r.reason, type: r.diagramType, ms: r.ms });
    return r;
  };

  // R first (cold flowchart + cold sequence measured), both themes.
  for (const c of CORPUS.filter((x) => x.group === "R")) {
    for (const theme of ["light", "dark"] as const) {
      const r = await check(c, theme, false);
      if (theme === "light" && (c.id === "user-flow" || c.id === "sequence")) coldWarm[`${c.id}-first-ms`] = r.ms;
    }
  }
  // hot: a second, different flowchart after the engine and flow chunks are loaded
  const hot = await callApi<RenderReport>(page, "render", "flowchart LR\n  H1[热] --> H2[渲染] --> H3[测试]", "light");
  coldWarm["flowchart-hot-ms"] = hot.ms;

  for (const group of ["N", "M", "L"] as const) {
    for (const c of CORPUS.filter(
      (x) => x.group === group && x.id !== "l-too-long" && x.id !== "l-too-many-chars" && x.id !== "l-coarse-201",
    )) {
      const r = await check(c, "light", false);
      if (c.id === "l-dense-480") coldWarm["dense-480-edges-ms"] = r.ms;
      if (group === "M")
        (out["math"] ??= {} as Record<string, unknown>) &&
          ((out["math"] as Record<string, unknown>)[c.id] = r.outcome === "ok" ? "ok" : `${r.outcome}:${r.reason}`);
    }
  }

  // C: effective config must stay the site config under hostile directives
  for (const c of CORPUS.filter((x) => x.group === "C")) {
    const r = await check(c, "light", true);
    const eff = await callApi<Record<string, unknown>>(page, "effectiveConfig", c.text, "light");
    const tag = c.id;
    if (eff["htmlLabels"] !== false) fail(name, tag, "htmlLabels-locked", String(eff["htmlLabels"]));
    if (eff["securityLevel"] !== "strict") fail(name, tag, "securityLevel-locked", String(eff["securityLevel"]));
    if (eff["hasThemeCSS"] !== false) fail(name, tag, "themeCSS-locked", "themeCSS survived");
    if (JSON.stringify(eff["dompurifyTags"]) !== JSON.stringify(SITE_SANITIZE_TAGS))
      fail(name, tag, "dompurify-locked", JSON.stringify(eff["dompurifyTags"]));
    if (eff["flowchartHtmlLabels"] === true) fail(name, tag, "flowchart.htmlLabels-locked", "true");
    if (eff["themeVariablesFontSize"] !== undefined && eff["themeVariablesFontSize"] !== "16px")
      fail(name, tag, "themeVariables.fontSize-locked", String(eff["themeVariablesFontSize"]));
    if (r.outcome === "ok" && r.svg !== undefined && /foreignObject/i.test(r.svg))
      fail(name, tag, "no-foreignObject", "output has foreignObject");
    (out["effectiveConfig"] ??= {} as Record<string, unknown>) &&
      ((out["effectiveConfig"] as Record<string, unknown>)[c.id] = eff);
  }

  // F: measure in an unrestricted page (same engine, all styles applied — what the <img> shows)
  const fontFamily = await callApi<string>(page, "fontFamily");
  const measurePage = await ctx.newPage();
  out["fonts"] = { fontFamily };
  for (const c of CORPUS.filter((x) => x.group === "F")) {
    const r = await check(c, "light", true);
    if (r.outcome !== "ok" || r.svg === undefined) continue;
    await measurePage.setContent(
      `<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="host" style="width:1400px">${r.svg}</div></body>`,
    );
    const bad = await measurePage.evaluate(MEASURE_FN);
    if (bad.length > 0) fail(name, c.id, "label-inside-shape", JSON.stringify(bad.slice(0, 4)));
    (out["fonts"] as Record<string, unknown>)[c.id] = bad.length === 0 ? "ok" : bad;
  }
  await measurePage.close();

  // parse/pre-check overhead (recorded, not gated)
  coldWarm["preparse-ms-userflow"] = Number((await callApi<number>(page, "parseCostMs", USER_FLOW, 5)).toFixed(1));

  // violations (everything except the known style-src-* noise)
  const violations = await callApi<Array<{ directive: string; uri: string }>>(page, "violations");
  const nonStyle = violations.filter((v) => !v.directive.startsWith("style-src"));
  if (nonStyle.length > 0) fail(name, "csp", "only-style-src-violations", JSON.stringify(nonStyle.slice(0, 5)));
  out["cspViolations"] = { total: violations.length, nonStyle: nonStyle.length };

  // gate breaches
  const breaches = await page.evaluate<string[]>(() =>
    (window as unknown as { __pwhWarn: string[] }).__pwhWarn.filter((m) => m.includes("gate breach")),
  );
  if (breaches.length > 0 || warns.some((w) => w.includes("gate breach")))
    fail(name, "gate", "gateBreach===0", `${breaches.length + warns.length} breach logs`);
  out["gateBreach"] = breaches.length + warns.filter((w) => w.includes("gate breach")).length;
  out["sinkHits"] = env.sinkHits.length - sinkBaseline;
  if (env.sinkHits.length !== sinkBaseline)
    fail(name, "sink", "zero-sink-hits-total", env.sinkHits.slice(sinkBaseline).join(","));
  await page.close();

  /* ---- coarse-pointer page: 201 edges must be refused ---- */
  const coarseCtx = await browser.newContext();
  await coarseCtx.addInitScript(INIT_SCRIPT);
  await coarseCtx.addInitScript(COARSE_INIT);
  const coarse = await newProbePage(coarseCtx, env.base, requests, warns);
  const cc = CORPUS.find((x) => x.id === "l-coarse-201")!;
  const cr = await callApi<RenderReport>(coarse, "render", cc.text, "light");
  if (cr.outcome !== "error" || cr.reason !== "too-large") fail(name, cc.id, "coarse-too-large", JSON.stringify(cr));
  out["coarse201"] = cr.outcome === "error" ? cr.reason : cr.outcome;
  await coarse.close();
  await coarseCtx.close();
  await ctx.close();

  // report numbers
  const sizeOf = async (chunk: string): Promise<{ raw: number; gzip: number }> => {
    try {
      const buf = await readFile(join(env.outDir, "assets", chunk));
      return { raw: buf.length, gzip: gzipSync(buf).length };
    } catch {
      return { raw: 0, gzip: 0 };
    }
  };
  const loads: Array<{ at: string; chunks: number; raw: number; gzip: number }> = [];
  for (const m of loadMarks) {
    let raw = 0;
    let gz = 0;
    for (const ch of m.chunks) {
      const s = await sizeOf(ch);
      raw += s.raw;
      gz += s.gzip;
    }
    loads.push({ at: m.at, chunks: m.chunks.length, raw, gzip: gz });
  }
  out["chunkLoads"] = loads.slice(0, 12);
  out["timings"] = coldWarm;
  out["diagramTypesSeen"] = [...typesSeen].sort();
  out["cases"] = results.length;
  out["digest"] = createHash("sha256").update(JSON.stringify(results)).digest("hex").slice(0, 12);
  loadMarks = [];
}
