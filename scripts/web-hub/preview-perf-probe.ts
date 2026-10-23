#!/usr/bin/env -S npx tsx
/**
 * Preview-perf PB probe runner (docs/dev/preview-perf/plan.md §6.1) — `npm run
 * probe:preview-perf`. NOT a CI gate (same class as `probe:mermaid`): a manual,
 * real-browser measurement over the production csp-probe build.
 *
 * What it does:
 *  1. verifies the sha256-pinned corpus (`tests/fixtures/preview-perf/manifest.json`) —
 *     refuses to run on any mismatch (baseline numbers are only meaningful against the
 *     pinned bytes);
 *  2. builds the csp-probe entries through the same `src/web-hub/ui/vite.config.ts`
 *     production pipeline the shipped bundle uses (`--mode csp-probe`);
 *  3. serves the build + `/corpus/*` under the REAL CSP header (imported from
 *     `src/web-hub/hub/http.ts`, never re-typed);
 *  4. drives Chromium (required) plus Firefox/WebKit (optional; skipped with an install hint
 *     when no cached browser exists) with REAL Playwright mouse/wheel input;
 *  5. collects: in-page open-to-frame (click timeStamp → 2nd rAF), CDP
 *     `Performance.getMetrics` deltas (「每轮平均每步成本」), CDP `Tracing` single-step peaks
 *     (EventDispatch + UpdateLayoutTree/Layout per input), rAF frame gaps, longtasks;
 *  6. writes machine-readable JSON (default `docs/dev/preview-perf/baseline.json`) and a
 *     human table to stdout.
 *
 * Baseline mode is the DEFAULT (record-only — the §6.1 gate table applies to the POST-P3
 * virtual renderer, so pre-change numbers are expected to exceed it). `--gate` (wired for
 * P3+) evaluates the gate table; `--virtual` flips the page's VirtualCode switch (also P3+).
 *
 * Exit codes: 0 = ran clean; 1 = infrastructure/functional failure (corpus mismatch, missing
 * elements, page errors, engine crash); 2 = Playwright/Chromium unavailable.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { CSP } from "../../src/web-hub/hub/http.js";
import { PLAYWRIGHT_VERSION, loadPlaywright } from "./lib/playwright.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VITE_CONFIG = resolve(REPO_ROOT, "src/web-hub/ui/vite.config.ts");
const PROBE_OUT_DIR = resolve(REPO_ROOT, "node_modules/.cache/pwh-csp-probe");
const FIXTURE_DIR = resolve(REPO_ROOT, "tests/fixtures/preview-perf");
const DEFAULT_JSON_OUT = resolve(REPO_ROOT, "docs/dev/preview-perf/baseline.json");
const PORT = 42117;

// --- args ------------------------------------------------------------------------
const argValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const QUICK = process.argv.includes("--quick");
const SKIP_BUILD = process.argv.includes("--skip-build");
const VIRTUAL = process.argv.includes("--virtual");
const GATE = process.argv.includes("--gate");
const ENGINES = (argValue("--engines") ?? "chromium,firefox,webkit").split(",");
const ROUNDS = QUICK ? 2 : Number(argValue("--rounds") ?? 7);
const STREAM_ROUNDS = QUICK ? 1 : Number(argValue("--stream-rounds") ?? 3);
const FS_SCALES = QUICK ? [1] : (argValue("--fs") ?? "1,3").split(",").map(Number);
const JSON_OUT = resolve(REPO_ROOT, argValue("--json") ?? DEFAULT_JSON_OUT);

// --- corpus verification -----------------------------------------------------------
interface Manifest {
  files: Record<string, { sha256: string; bytes: number; lines: number }>;
  log8mib: { seed: number; totalBytes: number; firstChunkBytes: number; nextChunkBytes: number };
}
const OPEN_CORPORA = ["stack-3609.ts", "hl-600.ts", "hl-601.ts", "uploads-2292.ts", "longline.js", "wide-1200.md"];

async function verifyCorpus(): Promise<Manifest> {
  const manifest = JSON.parse(await readFile(resolve(FIXTURE_DIR, "manifest.json"), "utf8")) as Manifest;
  for (const [name, meta] of Object.entries(manifest.files)) {
    const buf = await readFile(resolve(FIXTURE_DIR, `${name}.txt`));
    const sha = createHash("sha256").update(buf).digest("hex");
    if (sha !== meta.sha256 || buf.length !== meta.bytes) {
      console.error(`✗ corpus mismatch: ${name}`);
      console.error(`  manifest sha256 ${meta.sha256} (${meta.bytes} B) vs on-disk ${sha} (${buf.length} B)`);
      console.error("  regenerate with: node tests/fixtures/preview-perf/gen-corpus.mjs (and re-pin deliberately)");
      process.exit(1);
    }
  }
  return manifest;
}

// --- static server (probe build + corpus, real CSP) ---------------------------------
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ts": "text/plain; charset=utf-8",
  ".js.txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};
function contentTypeFor(rel: string): string {
  if (rel.startsWith("corpus/")) return "text/plain; charset=utf-8";
  return CONTENT_TYPES[rel.slice(rel.lastIndexOf("."))] ?? "application/octet-stream";
}
async function startServer(): Promise<Server> {
  const server = createServer((req, res) => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    void (async () => {
      const url = (req.url ?? "/").split("?")[0] ?? "/";
      if (url === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }
      let rel = url === "/" ? "preview-perf.html" : url.replace(/^\//, "");
      if (rel.startsWith("corpus/")) {
        const name = rel.slice("corpus/".length);
        if (!OPEN_CORPORA.includes(name)) {
          res.writeHead(404).end();
          return;
        }
        try {
          // on-disk payload carries a .txt suffix (prettier never parses fixture slices);
          // the canonical (extension-real) name is what the page requests
          const data = await readFile(resolve(FIXTURE_DIR, `${name}.txt`));
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": data.length });
          res.end(data);
        } catch {
          res.writeHead(404).end();
        }
        return;
      }
      if (rel.includes("..") || rel.includes("\0") || rel.startsWith("/")) {
        res.writeHead(404).end();
        return;
      }
      try {
        const data = await readFile(resolve(PROBE_OUT_DIR, rel));
        res.writeHead(200, { "Content-Type": contentTypeFor(rel), "Content-Length": data.length });
        res.end(data);
      } catch {
        res.writeHead(404).end();
      }
    })();
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(PORT, "127.0.0.1", () => res());
  });
  return server;
}
const BASE = `http://127.0.0.1:${PORT}`;

// --- playwright (full faces; lib/playwright.ts's narrow views are the floor) ---------
interface CdpEvent {
  name: string;
  ph: string;
  ts: number;
  dur: number;
  tid?: number;
  args?: { data?: { type?: string }; name?: string };
}
interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  on(event: string, handler: (data: unknown) => void): void;
  detach(): Promise<void>;
}
interface PwMouse {
  move(x: number, y: number, opts?: { steps?: number }): Promise<void>;
  down(): Promise<void>;
  up(): Promise<void>;
  click(x: number, y: number): Promise<void>;
  wheel(dx: number, dy: number): Promise<void>;
}
interface PwPageFull {
  goto(url: string, opts?: { waitUntil?: "load" | "domcontentloaded" }): Promise<unknown>;
  evaluate<T>(fn: string, arg?: unknown): Promise<T>;
  waitForFunction(fn: string, opts?: { timeout?: number }): Promise<unknown>;
  click(selector: string): Promise<void>;
  close(): Promise<void>;
  on(event: "pageerror" | "console", handler: (msg: unknown) => void): void;
  mouse: PwMouse;
  waitForTimeout(ms: number): Promise<void>;
}
interface PwContextFull {
  newPage(): Promise<PwPageFull>;
  addInitScript(script: { content: string }): Promise<void>;
  close(): Promise<void>;
  newCDPSession(page: unknown): Promise<CdpSession>;
}
interface PwBrowserFull {
  newContext(opts?: Record<string, unknown>): Promise<PwContextFull>;
  close(): Promise<void>;
}
interface PwLauncher {
  launch(opts?: Record<string, unknown>): Promise<PwBrowserFull>;
  executablePath(): string;
}
interface PwModule {
  chromium: PwLauncher;
  firefox?: PwLauncher;
  webkit?: PwLauncher;
}

const INSTALL_HINT = `npx -y -p playwright@${PLAYWRIGHT_VERSION} playwright install <chromium|firefox|webkit>`;

/** webkit is not probed by lib/playwright.ts (file domain frozen) — resolve the same npx
 *  sandbox entry ourselves and probe `webkit.executablePath()` for a cached build. */
async function loadWebkit(
  pwOk: boolean,
): Promise<{ launcher: PwLauncher; executablePath: string } | { reason: string }> {
  if (!pwOk) return { reason: "playwright itself unavailable" };
  const entry = await new Promise<string>((res) => {
    execFile(
      "npx",
      [
        "-y",
        "-p",
        `playwright@${PLAYWRIGHT_VERSION}`,
        "node",
        "-e",
        'const p=require("path"),f=require("fs");const s=p.sep+"node_modules"+p.sep+".bin";for(const x of(process.env.PATH||"").split(p.delimiter)){if(x.endsWith(s)){const c=x.slice(0,-".bin".length-1);if(f.existsSync(p.join(c,"playwright","package.json"))){console.log(require.resolve("playwright",{paths:[c]}));process.exit(0)}}}process.exit(1)',
      ],
      { timeout: 45_000 },
      (err, stdout) => res(err ? "" : (stdout.trim().split("\n").pop() ?? "")),
    );
  });
  if (entry === "") return { reason: "playwright entry not resolvable" };
  try {
    const mod = (await import(entry)) as PwModule & { default?: PwModule };
    const webkit = mod.webkit ?? mod.default?.webkit;
    if (webkit === undefined) return { reason: "playwright module has no webkit launcher" };
    const exe = webkit.executablePath();
    if (!existsSync(exe)) return { reason: `no cached WebKit build (${exe})` };
    return { launcher: webkit, executablePath: exe };
  } catch (err) {
    return { reason: `webkit probe failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// --- metrics helpers ----------------------------------------------------------------
interface FrameGapResult {
  p95: number;
  max: number;
  n: number;
  longtasks: number[];
  longtaskSupported: boolean;
}
interface MetricRec {
  id: string;
  engine: string;
  fs: number;
  viewport: string;
  corpus: string | null;
  kind: string;
  unit: "ms";
  rounds: number[];
  median: number;
  p95: number;
  stepsPerRound?: number;
  stepMax?: number;
  stepP95?: number;
  frameP95?: number;
  frameMax?: number;
  longtaskCount?: number;
  note?: string;
}
const metrics: MetricRec[] = [];
const failures: Array<{ engine: string; id: string; detail: string }> = [];

function stats(rounds: number[]): { median: number; p95: number } {
  const s = [...rounds].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { median: at(0.5), p95: at(0.95) };
}

function record(
  id: string,
  engine: string,
  fs: number,
  viewport: string,
  corpus: string | null,
  kind: string,
  rounds: number[],
  extra: Partial<MetricRec> = {},
): void {
  const st = stats(rounds);
  metrics.push({ id, engine, fs, viewport, corpus, kind, unit: "ms", rounds, ...st, ...extra });
}

function txSelector(file: string): string {
  return `#pp-tx-${file.replace(/\./g, "-")} .path-ref`;
}

/** Measured fact (2026-10-23, playwright 1.63 / chromium-1243 headless): `Performance.getMetrics`
 *  duration counters NEVER accumulate (0 after a 300 ms busy loop + 20k-node layout) — they
 *  only move under a live DevTools-style timeline. All per-step/per-click numbers below are
 *  therefore TRACE-derived (`devtools.timeline` events — the same three buckets the plan's
 *  §6.1 formula wants: input EventDispatch ≈ synchronous script, UpdateLayoutTree = style,
 *  Layout = layout), with `RunTask` sums as a whole-main-thread-busy cross-check. */
interface TraceSummary {
  /** Σ UpdateLayoutTree durations (ms). */
  styleTotal: number;
  /** Σ Layout durations (ms). */
  layoutTotal: number;
  /** Σ input-EventDispatch durations (ms). */
  inputTotal: number;
  /** Σ RunTask durations (ms) — whole main-thread busy (no double counting: top-level). */
  busyTotal: number;
  nRunTasks: number;
  /** per input event: its EventDispatch + trailing UpdateLayoutTree/Layout (§6.1 单步峰值). */
  stepCosts: number[];
}

function summarizeTrace(events: CdpEvent[]): TraceSummary {
  let styleTotal = 0;
  let layoutTotal = 0;
  let inputTotal = 0;
  const stepEvs = events
    .filter(
      (e) =>
        e.ph === "X" &&
        ((e.name === "EventDispatch" && INPUT_EVENT_TYPES.has(e.args?.data?.type ?? "")) ||
          e.name === "UpdateLayoutTree" ||
          e.name === "Layout"),
    )
    .sort((a, b) => a.ts - b.ts);
  const stepCosts: number[] = [];
  let cur: number | null = null;
  for (const e of stepEvs) {
    if (e.name === "EventDispatch") {
      if (cur !== null) stepCosts.push(cur);
      cur = e.dur / 1000;
      inputTotal += e.dur / 1000;
    } else if (cur !== null) {
      cur += e.dur / 1000;
    }
    if (e.name === "UpdateLayoutTree") styleTotal += e.dur / 1000;
    else if (e.name === "Layout") layoutTotal += e.dur / 1000;
  }
  if (cur !== null) stepCosts.push(cur);
  // Renderer-MAIN-thread busy only: `toplevel` RunTask slices arrive for every thread
  // (compositor/IO run in parallel — summing them would double count). The main thread is
  // identified by the `thread_name` metadata slice "CrRendererMain"; without it, degrade to
  // the plain RunTask name sum (older naming) on the thread that carries EventDispatch.
  let mainTid: number | null = null;
  for (const e of events) {
    if (e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain" && e.tid !== undefined) {
      mainTid = e.tid;
      break;
    }
  }
  if (mainTid === null) {
    const dispatch = events.find((e) => e.name === "EventDispatch" && e.tid !== undefined);
    mainTid = dispatch?.tid ?? null;
  }
  let busyTotal = 0;
  let nRunTasks = 0;
  for (const e of events) {
    if (
      e.ph === "X" &&
      (e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask") &&
      (mainTid === null || e.tid === mainTid)
    ) {
      busyTotal += e.dur / 1000;
      nRunTasks++;
    }
  }
  return { styleTotal, layoutTotal, inputTotal, busyTotal, nRunTasks, stepCosts };
}

const tracePerStep = (t: TraceSummary, steps: number): number =>
  steps <= 0 ? 0 : (t.styleTotal + t.layoutTotal + t.inputTotal) / steps;

/** CDP Tracing: collect devtools.timeline events for a bounded window. */
async function withTracing(cdp: CdpSession, fn: () => Promise<void>): Promise<CdpEvent[]> {
  const buf: CdpEvent[] = [];
  let done: (() => void) | null = null;
  const doneP = new Promise<void>((res) => {
    done = res;
  });
  const onData = (d: unknown): void => {
    const v = (d as { value: CdpEvent[] }).value ?? [];
    for (const e of v) buf.push(e);
  };
  const onEnd = (): void => done?.();
  cdp.on("Tracing.dataCollected", onData);
  cdp.on("Tracing.tracingComplete", onEnd);
  await cdp.send("Tracing.start", {
    // `toplevel` carries RunTask (the whole-main-thread-busy cross-check); devtools.timeline
    // carries EventDispatch / UpdateLayoutTree / Layout.
    categories: "devtools.timeline,toplevel",
    options: "record-storage",
    transferMode: "ReportEvents",
  });
  try {
    await fn();
  } finally {
    await cdp.send("Tracing.end");
    await Promise.race([doneP, new Promise<void>((res) => setTimeout(res, 3000))]);
  }
  return buf;
}

const INPUT_EVENT_TYPES = new Set(["pointermove", "mousemove", "wheel", "mousedown", "mouseup", "click"]);

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

interface PageEnv {
  engine: string;
  fs: number;
  viewport: { width: number; height: number };
  virtual: boolean;
  page: PwPageFull;
  context: PwContextFull;
  cdp: CdpSession | null; // chromium only
  consoleErrors: string[];
}

async function newSession(
  launcher: PwLauncher,
  env: { engine: string; fs: number; width: number; height: number; virtual: boolean },
): Promise<{ browser: PwBrowserFull; env: PageEnv }> {
  const browser = await launcher.launch({ headless: true, executablePath: launcher.executablePath() });
  const context = await browser.newContext({
    viewport: { width: env.width, height: env.height },
    deviceScaleFactor: 1,
  });
  await context.addInitScript({
    content: `try{localStorage.setItem("pwh_fontscale","${env.fs}");localStorage.setItem("pwh_linenumbers","1");}catch(e){}`,
  });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${String(err)}`));
  page.on("console", (msg) => {
    const m = msg as { type?: () => string; text?: () => string };
    try {
      if (m.type?.() === "error") consoleErrors.push(`console.error: ${m.text?.() ?? ""}`);
    } catch {
      /* ignore */
    }
  });
  await page.goto(`${BASE}/preview-perf.html${env.virtual ? "?virtual=1" : ""}`, { waitUntil: "load" });
  await page.waitForFunction("window.__PWH_PROBE_READY__ === true", { timeout: 30_000 });
  await page.waitForFunction("window.__pp !== undefined && document.querySelector('.pp-shell') !== null", {
    timeout: 30_000,
  });
  let cdp: CdpSession | null = null;
  if (env.engine === "chromium") {
    cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
  }
  return {
    browser,
    env: {
      engine: env.engine,
      fs: env.fs,
      viewport: { width: env.width, height: env.height },
      virtual: env.virtual,
      page,
      context,
      cdp,
      consoleErrors,
    },
  };
}

async function pp<T>(env: PageEnv, expr: string): Promise<T> {
  return env.page.evaluate<T>(`window.__pp.${expr}`);
}

async function openOnce(env: PageEnv, file: string): Promise<number> {
  const path = `/work/${file}`;
  const armed = await pp<boolean>(env, `armOpen(${JSON.stringify(path)})`);
  if (!armed) throw new Error(`armOpen failed for ${file}`);
  await env.page.click(txSelector(file));
  const r = await pp<{ ms: number }>(env, "collectOpen()");
  await pp<void>(env, "closeAll()");
  return r.ms;
}

interface WinInfo {
  count: number;
  rects: Array<{ x: number; y: number; w: number; h: number; header: { x: number; y: number } }>;
  handles: Record<string, { x: number; y: number }>;
}

async function openKeep(env: PageEnv, file: string): Promise<void> {
  const path = `/work/${file}`;
  const armed = await pp<boolean>(env, `armOpen(${JSON.stringify(path)})`);
  if (!armed) throw new Error(`armOpen failed for ${file}`);
  await env.page.click(txSelector(file));
  const r = await pp<{ ms: number }>(env, "collectOpen()");
  if (r.ms < 0) throw new Error(`open timed out for ${file}`);
}

/** One real-mouse gesture round (drag or resize): 60 moves, ~8ms apart. */
async function gestureRound(
  env: PageEnv,
  opts: { kind: "drag" | `resize:${string}`; from: { x: number; y: number }; dx: number; dy: number; steps?: number },
): Promise<{ trace: TraceSummary | null; frame: FrameGapResult | null }> {
  const steps = opts.steps ?? 60;
  await pp<void>(env, "beginGaps()");
  const events = await (env.cdp === null
    ? (async () => {
        await runMoves(env, opts, steps);
        return [] as CdpEvent[];
      })()
    : withTracing(env.cdp, () => runMoves(env, opts, steps)));
  const frame = await pp<FrameGapResult>(env, "endGaps()");
  return { trace: events.length === 0 ? null : summarizeTrace(events), frame };
}

async function runMoves(
  env: PageEnv,
  opts: { kind: string; from: { x: number; y: number }; dx: number; dy: number },
  steps: number,
): Promise<void> {
  const { x, y } = opts.from;
  await env.page.mouse.move(x, y);
  await env.page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await env.page.mouse.move(x + (opts.dx * i) / steps, y + (opts.dy * i) / steps);
    await env.page.waitForTimeout(8);
  }
  await env.page.mouse.up();
}

// --- per-engine suite ---------------------------------------------------------------
interface EngineResult {
  executablePath?: string;
  skipped?: string;
  env?: { fontFamily: string; fontsStatus: string };
  virtual: boolean;
}

async function runEngine(
  name: "chromium" | "firefox" | "webkit",
  launcher: PwLauncher | null,
  reasonIfSkipped?: string,
): Promise<EngineResult> {
  if (launcher === null) {
    console.warn(`⚠ ${name}: SKIPPED — ${reasonIfSkipped ?? "unavailable"}`);
    console.warn(`  to enable: ${INSTALL_HINT.replace("<chromium|firefox|webkit>", name)}`);
    return { skipped: reasonIfSkipped ?? "unavailable", virtual: VIRTUAL };
  }
  const full = name === "chromium";
  const vpTag = (w: number, h: number): string => `${w}x${h}`;
  console.log(`→ ${name}: functional pass`);
  const session = await newSession(launcher, { engine: name, fs: 1, width: 1440, height: 900, virtual: VIRTUAL });
  const { browser, env } = session;
  try {
    const ready = await pp<{
      corpus: string[];
      fontFamily: string;
      fontsStatus: string;
      log8mib: { chunks: number; surrogateSplit: boolean; totalBytes: number };
      violations: Array<{ directive: string; uri: string }>;
    }>(env, "ready()");
    if (!ready.log8mib.surrogateSplit) {
      failures.push({
        engine: name,
        id: "log8mib.surrogateSplit",
        detail: "no chunk boundary splits a surrogate pair",
      });
    }
    // functional: one open per corpus + assertions
    for (const f of OPEN_CORPORA) {
      await openKeep(env, f);
      const st = await pp<{ windows: number; lines: number; content: boolean }>(env, "openState()");
      if (st.windows !== 1 || !st.content) failures.push({ engine: name, id: `open.${f}`, detail: JSON.stringify(st) });
      if (f === "stack-3609.ts" && st.lines !== 3609) {
        failures.push({ engine: name, id: "lines.stack-3609", detail: `saw ${st.lines} .pv-line` });
      }
      if (f === "longline.js" && st.lines !== 701) {
        failures.push({ engine: name, id: "lines.longline", detail: `saw ${st.lines} .pv-line (expect 701)` });
      }
      if (f === "wide-1200.md") {
        const ok = await pp<boolean>(env, "toSourceView()");
        const src = await pp<boolean>(env, "isSourceView()");
        if (!ok || !src) failures.push({ engine: name, id: "wide.sourceView", detail: "source toggle failed" });
      }
      await pp<void>(env, "closeAll()");
    }
    // highlight gates: uploads-2292 (≤ gate → tok) and stack-3609 (over gate → no tok)
    await openKeep(env, "uploads-2292.ts");
    for (let i = 0; i < 100 && !(await pp<boolean>(env, "tokArrived()")); i++) await sleep(50);
    if (!(await pp<boolean>(env, "tokArrived()"))) {
      failures.push({ engine: name, id: "highlight.uploads-2292", detail: "tok spans never arrived" });
    }
    await pp<void>(env, "closeAll()");
    await openKeep(env, "stack-3609.ts");
    if (await pp<boolean>(env, "tokArrived()")) {
      failures.push({ engine: name, id: "highlight.stack-3609", detail: "tok spans present past the 100 KiB gate" });
    }
    await pp<void>(env, "closeAll()");

    // ---- opens (warm) ----
    console.log(`→ ${name}: open-to-frame (warm, fs 1)`);
    for (const f of full ? OPEN_CORPORA : ["stack-3609.ts", "hl-600.ts", "wide-1200.md"]) {
      await openOnce(env, f); // warm-up
      const rounds: number[] = [];
      for (let i = 0; i < ROUNDS; i++) rounds.push(await openOnce(env, f));
      record(`open.warm.${f}`, name, 1, vpTag(1440, 900), f, "open-to-frame", rounds);
    }

    // ---- streaming (log-8mib) ----
    console.log(`→ ${name}: streaming log-8mib (${STREAM_ROUNDS} rounds)`);
    const streamRounds: number[] = [];
    const chunkCosts: number[] = [];
    for (let i = 0; i < STREAM_ROUNDS; i++) {
      await openKeep(env, "log-8mib");
      await pp<void>(env, "beginGaps()");
      const t0 = Date.now();
      // The continuation is IO-driven: the sentinel only intersects when scrolled to the
      // bottom, so each poll pins scrollTop to the (growing) scrollHeight — the same way a
      // real reader tail-follows a log.
      await pp<void>(env, "setScrollTop(1e9)");
      let info = await pp<{ state: string; chunks: number; loaded: number } | null>(env, "streamInfo()");
      let lastChunks = info?.chunks ?? 0;
      const chunkArrivals: number[] = [];
      const pump = async (): Promise<void> => {
        while (Date.now() - t0 < 90_000) {
          info = await pp<{ state: string; chunks: number; loaded: number } | null>(env, "streamInfo()");
          if (info !== null && info.chunks > lastChunks) {
            lastChunks = info.chunks;
            chunkArrivals.push(Date.now());
          }
          if (info !== null && ["done", "cap", "error", "changed"].includes(info.state)) break;
          await pp<void>(env, "setScrollTop(1e9)"); // follow the tail as it grows
          await sleep(60);
        }
      };
      if (env.cdp !== null) {
        const traceBusy = await withTracing(env.cdp, pump);
        const streamSum = summarizeTrace(traceBusy);
        if (lastChunks > 0) chunkCosts.push(streamSum.busyTotal / lastChunks);
      } else {
        await pump();
      }
      void chunkArrivals;
      const totalS = (Date.now() - t0) / 1000;
      streamRounds.push(totalS * 1000);
      if (info === null || !["done", "cap"].includes(info.state)) {
        failures.push({ engine: name, id: `stream.round${i}`, detail: `final state ${info?.state ?? "null"}` });
      } else if (info.loaded !== ready.log8mib.totalBytes) {
        failures.push({ engine: name, id: `stream.loaded${i}`, detail: `loaded ${info.loaded}` });
      }
      const frame = await pp<FrameGapResult>(env, "endGaps()");
      if (i === 0 && frame.longtasks.length > 0) {
        record(`stream.longtasks`, name, 1, vpTag(1440, 900), "log-8mib", "longtask-list", frame.longtasks, {
          note: "round 0 only",
        });
      }
      await pp<void>(env, "closeAll()");
    }
    record(`stream.wall.total`, name, 1, vpTag(1440, 900), "log-8mib", "stream-wall", streamRounds, {
      note: "whole-stream wall time (min-gap 300ms dominates)",
    });
    if (chunkCosts.length > 0) {
      record(`stream.append.perChunk`, name, 1, vpTag(1440, 900), "log-8mib", "chunk-append", chunkCosts, {
        note: "whole-stream main-thread busy (RunTask) ÷ chunk count — amortized, not per-chunk peaks (see stream.longtasks)",
      });
    }

    if (full) {
      // ---- cold opens (fresh context per round: Prism chunk uncached) ----
      console.log("→ chromium: open-to-frame (cold)");
      const coldRound = async (f: string): Promise<number> => {
        const s = await newSession(launcher, { engine: name, fs: 1, width: 1440, height: 900, virtual: VIRTUAL });
        try {
          return await openOnce(s.env, f);
        } finally {
          await s.browser.close();
        }
      };
      const coldStack: number[] = [];
      for (let i = 0; i < ROUNDS; i++) coldStack.push(await coldRound("stack-3609.ts"));
      record("open.cold.stack-3609.ts", name, 1, vpTag(1440, 900), "stack-3609.ts", "open-to-frame", coldStack);

      // ---- drag / resize ----
      console.log("→ chromium: drag + resize (real mouse, 60 steps/round)");
      const gestures: Array<{ id: string; kind: "drag" | `resize:${string}`; file: string; dx: number; dy: number }> = [
        { id: "drag", kind: "drag", file: "stack-3609.ts", dx: 200, dy: 60 },
        { id: "resize.e", kind: "resize:e", file: "stack-3609.ts", dx: 160, dy: 0 },
        { id: "resize.s", kind: "resize:s", file: "stack-3609.ts", dx: 0, dy: 120 },
        { id: "resize.se", kind: "resize:se", file: "stack-3609.ts", dx: 160, dy: 120 },
        { id: "resize.e.softwrap", kind: "resize:e", file: "hl-600.ts", dx: 160, dy: 0 },
      ];
      for (const g of gestures) {
        const perStepRounds: number[] = [];
        const busyPerStepRounds: number[] = [];
        let stepCosts: number[] = [];
        const frameP95: number[] = [];
        const frameMax: number[] = [];
        let longtasks = 0;
        for (let i = 0; i < ROUNDS; i++) {
          await openKeep(env, g.file);
          const wi = await pp<WinInfo>(env, "winInfo()");
          const from = g.kind === "drag" ? wi.rects[wi.rects.length - 1]!.header : wi.handles[g.kind.slice(7)]!;
          if (from === undefined) {
            failures.push({ engine: name, id: `gesture.${g.id}`, detail: "missing handle/header anchor" });
            break;
          }
          const r = await gestureRound(env, { kind: g.kind, from, dx: g.dx, dy: g.dy });
          if (r.trace !== null) {
            perStepRounds.push(tracePerStep(r.trace, 60));
            busyPerStepRounds.push(r.trace.busyTotal / 60);
            stepCosts = stepCosts.concat(r.trace.stepCosts);
          }
          if (r.frame !== null) {
            frameP95.push(r.frame.p95);
            frameMax.push(r.frame.max);
            longtasks += r.frame.longtasks.length;
          }
          await pp<void>(env, "closeAll()");
        }
        if (perStepRounds.length > 0) {
          const st = stats(perStepRounds);
          const stepSt = stats(stepCosts);
          metrics.push({
            id: `gesture.${g.id}`,
            engine: name,
            fs: 1,
            viewport: vpTag(1440, 900),
            corpus: g.file,
            kind: "per-step avg (dispatch+style+layout, trace)",
            unit: "ms",
            rounds: perStepRounds,
            median: st.median,
            p95: st.p95,
            stepsPerRound: 60,
            stepMax: stepSt.p95 === 0 ? undefined : Math.max(...stepCosts),
            stepP95: stepSt.p95 === 0 ? undefined : stepSt.p95,
            frameP95: stats(frameP95).median,
            frameMax: Math.max(...(frameMax.length > 0 ? frameMax : [0])),
            longtaskCount: longtasks,
            note: `main-thread busy/step median ${stats(busyPerStepRounds).median.toFixed(3)} ms (RunTask cross-check)`,
          });
        }
      }

      // ---- activation: 6 windows × 20 clicks/round ----
      console.log("→ chromium: window activation (6 windows)");
      await openKeep(env, OPEN_CORPORA[0]!);
      for (const f of OPEN_CORPORA.slice(1)) await openKeep(env, f);
      const wi = await pp<WinInfo>(env, "winInfo()");
      if (wi.count !== 6) failures.push({ engine: name, id: "activate.windows", detail: `saw ${wi.count}` });
      const perClick: number[] = [];
      const frameP95: number[] = [];
      for (let r = 0; r < ROUNDS; r++) {
        await pp<void>(env, "beginGaps()");
        const evs = await withTracing(env.cdp!, async () => {
          for (let c = 0; c < 20; c++) {
            const target = wi.rects[(r + c) % wi.rects.length]!;
            // the cascade exposes each window's TOP strip — click there (header centre can sit
            // under a later window and its own buttons live mid-header)
            await env.page.mouse.click(target.x + target.w / 2, target.y + 5);
          }
        });
        const sum = summarizeTrace(evs);
        for (const c of sum.stepCosts) perClick.push(c);
        const frame = await pp<FrameGapResult>(env, "endGaps()");
        frameP95.push(frame.p95);
      }
      record(
        "activate.perClick",
        name,
        1,
        vpTag(1440, 900),
        "6 windows (distinct corpora)",
        "per-click dispatch+style+layout (trace)",
        perClick,
        {
          frameP95: stats(frameP95).median,
          note: "6 distinct files (openWindow dedups same-path); plan's 6×stack-3609 is unreachable",
        },
      );
      await pp<void>(env, "closeAll()");

      // ---- scroll: 40 × wheel(400px) + 5 far jumps ----
      console.log("→ chromium: scroll (wheel + far jumps)");
      const wheelPerStep: number[] = [];
      const jumpCosts: number[] = [];
      const frameP95S: number[] = [];
      let scrollLongtasks = 0;
      for (let i = 0; i < ROUNDS; i++) {
        await openKeep(env, "stack-3609.ts");
        const wi2 = await pp<WinInfo>(env, "winInfo()");
        const r0 = wi2.rects[wi2.rects.length - 1]!;
        const cx = r0.x + r0.w / 2;
        const cy = r0.y + r0.h * 0.6;
        await env.page.mouse.move(cx, cy);
        await pp<void>(env, "beginGaps()");
        const wheelEvs = await withTracing(env.cdp!, async () => {
          for (let s = 0; s < 40; s++) {
            await env.page.mouse.wheel(0, 400);
            await env.page.waitForTimeout(8);
          }
        });
        const sum = summarizeTrace(wheelEvs);
        wheelPerStep.push(tracePerStep(sum, 40));
        if (i === 0 && sum.stepCosts.length > 0) {
          const st = stats(sum.stepCosts);
          metrics.push({
            id: "scroll.wheel.stepPeak",
            engine: name,
            fs: 1,
            viewport: vpTag(1440, 900),
            corpus: "stack-3609.ts",
            kind: "trace step peak (round 0)",
            unit: "ms",
            rounds: sum.stepCosts,
            median: st.median,
            p95: st.p95,
            stepMax: Math.max(...sum.stepCosts),
          });
        }
        for (const frac of [0.25, 0.5, 0.75, 1.0, 0.0]) {
          const si = await pp<{ scrollHeight: number } | null>(env, "scrollInfo()");
          if (si === null) break;
          const jumpEvs = await withTracing(env.cdp!, async () => {
            await pp<void>(env, `setScrollTop(${Math.floor(si.scrollHeight * frac)})`);
            await env.page.waitForTimeout(30);
          });
          jumpCosts.push(summarizeTrace(jumpEvs).busyTotal);
        }
        const frame = await pp<FrameGapResult>(env, "endGaps()");
        frameP95S.push(frame.p95);
        scrollLongtasks += frame.longtasks.length;
        await pp<void>(env, "closeAll()");
      }
      record(
        "scroll.wheel.perStep",
        name,
        1,
        vpTag(1440, 900),
        "stack-3609.ts",
        "per-step avg (dispatch+style+layout, trace)",
        wheelPerStep,
        {
          stepsPerRound: 40,
          frameP95: stats(frameP95S).median,
          longtaskCount: scrollLongtasks,
        },
      );
      record(
        "scroll.farjump",
        name,
        1,
        vpTag(1440, 900),
        "stack-3609.ts",
        "per-jump main-thread busy (RunTask)",
        jumpCosts,
      );

      // ---- highlight cost: uploads-2292 (≤ gate, Prism on main thread) ----
      console.log("→ chromium: highlight cost (uploads-2292)");
      const hlCosts: number[] = [];
      const hlStyleLayout: number[] = [];
      const hlLong: number[] = [];
      for (let i = 0; i < ROUNDS; i++) {
        // the tracing window spans open + Prism import + tokenize + patch (plan §6.1: open →
        // setHighlight, plus the arrival patch's cost); busy = Σ RunTask (whole main thread)
        await pp<void>(env, "beginGaps()");
        const evs = await withTracing(env.cdp!, async () => {
          await openKeep(env, "uploads-2292.ts");
          for (let k = 0; k < 400 && !(await pp<boolean>(env, "tokArrived()")); k++) await sleep(25);
        });
        const sum = summarizeTrace(evs);
        hlCosts.push(sum.busyTotal);
        hlStyleLayout.push(sum.styleTotal + sum.layoutTotal);
        const frame = await pp<FrameGapResult>(env, "endGaps()");
        for (const d of frame.longtasks) hlLong.push(d);
        await pp<void>(env, "closeAll()");
      }
      record(
        "highlight.busy",
        name,
        1,
        vpTag(1440, 900),
        "uploads-2292.ts",
        "click→tok main-thread busy (RunTask)",
        hlCosts,
        {
          note: "whole open+highlight pipeline (Prism import + tokenize + patch); style+layout share in rounds field",
        },
      );
      record(
        "highlight.styleLayout",
        name,
        1,
        vpTag(1440, 900),
        "uploads-2292.ts",
        "click→tok style+layout (trace)",
        hlStyleLayout,
      );
      if (hlLong.length > 0)
        record("highlight.longtasks", name, 1, vpTag(1440, 900), "uploads-2292.ts", "longtask-list", hlLong);
    }

    // CSP + console hygiene
    const viol = await pp<Array<{ directive: string; uri: string }>>(env, "violations()");
    if (viol.length > 0) failures.push({ engine: name, id: "csp", detail: JSON.stringify(viol.slice(0, 5)) });
    if (env.consoleErrors.length > 0) {
      failures.push({ engine: name, id: "console", detail: env.consoleErrors.slice(0, 5).join(" | ") });
    }
    await browser.close();
    return {
      executablePath: launcher.executablePath(),
      env: { fontFamily: ready.fontFamily, fontsStatus: ready.fontsStatus },
      virtual: VIRTUAL,
    };
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
}

async function runFs3(launcher: PwLauncher, name: "chromium"): Promise<void> {
  console.log("→ chromium: fs-scale 3 subset");
  const session = await newSession(launcher, { engine: name, fs: 3, width: 1440, height: 900, virtual: VIRTUAL });
  const { browser, env } = session;
  try {
    await openOnce(env, "stack-3609.ts");
    const rounds: number[] = [];
    for (let i = 0; i < ROUNDS; i++) rounds.push(await openOnce(env, "stack-3609.ts"));
    record("open.warm.stack-3609.ts", name, 3, "1440x900", "stack-3609.ts", "open-to-frame", rounds);

    const dragRounds: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      await openKeep(env, "stack-3609.ts");
      const wi = await pp<WinInfo>(env, "winInfo()");
      const r = await gestureRound(env, {
        kind: "drag",
        from: wi.rects[wi.rects.length - 1]!.header,
        dx: 200,
        dy: 60,
      });
      if (r.trace !== null) dragRounds.push(tracePerStep(r.trace, 60));
      await pp<void>(env, "closeAll()");
    }
    if (dragRounds.length > 0) {
      record(
        "gesture.drag",
        name,
        3,
        "1440x900",
        "stack-3609.ts",
        "per-step avg (dispatch+style+layout, trace)",
        dragRounds,
        {
          stepsPerRound: 60,
        },
      );
    }

    const wheelPerStep: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      await openKeep(env, "stack-3609.ts");
      const wi = await pp<WinInfo>(env, "winInfo()");
      const r0 = wi.rects[wi.rects.length - 1]!;
      await env.page.mouse.move(r0.x + r0.w / 2, r0.y + r0.h * 0.6);
      const evs = await withTracing(env.cdp!, async () => {
        for (let s = 0; s < 40; s++) {
          await env.page.mouse.wheel(0, 400);
          await env.page.waitForTimeout(8);
        }
      });
      wheelPerStep.push(tracePerStep(summarizeTrace(evs), 40));
      await pp<void>(env, "closeAll()");
    }
    record(
      "scroll.wheel.perStep",
      name,
      3,
      "1440x900",
      "stack-3609.ts",
      "per-step avg (dispatch+style+layout, trace)",
      wheelPerStep,
      {
        stepsPerRound: 40,
      },
    );
  } finally {
    await browser.close();
  }
}

async function runNarrow(launcher: PwLauncher, name: "chromium" | "firefox" | "webkit"): Promise<void> {
  console.log(`→ ${name}: narrow 390x844 opens`);
  const session = await newSession(launcher, { engine: name, fs: 1, width: 390, height: 844, virtual: VIRTUAL });
  const { browser, env } = session;
  try {
    await openOnce(env, "stack-3609.ts");
    const rounds: number[] = [];
    for (let i = 0; i < ROUNDS; i++) rounds.push(await openOnce(env, "stack-3609.ts"));
    record("open.warm.stack-3609.ts", name, 1, "390x844", "stack-3609.ts", "open-to-frame", rounds);
  } finally {
    await browser.close();
  }
}

// --- report ---------------------------------------------------------------------------
function printTable(): void {
  const byId = new Map<string, MetricRec[]>();
  for (const m of metrics) {
    const list = byId.get(m.id) ?? [];
    list.push(m);
    byId.set(m.id, list);
  }
  console.log("\n══ preview-perf baseline (median / p95, ms) ══");
  for (const [id, list] of byId) {
    for (const m of list) {
      const where = [m.engine, `fs${m.fs}`, m.viewport].join(" ");
      const extra: string[] = [];
      if (m.stepMax !== undefined) extra.push(`stepMax ${m.stepMax.toFixed(2)}`);
      if (m.frameMax !== undefined) extra.push(`frameMax ${m.frameMax.toFixed(1)}`);
      if (m.longtaskCount !== undefined) extra.push(`longtasks ${m.longtaskCount}`);
      console.log(
        `  ${id.padEnd(28)} ${where.padEnd(26)} ${m.median.toFixed(2).padStart(8)} / ${m.p95.toFixed(2).padStart(8)}  ${extra.join(" · ")}`,
      );
    }
  }
}

async function main(): Promise<void> {
  console.log("→ verifying corpus sha256");
  const manifest = await verifyCorpus();
  console.log(
    `  ${Object.keys(manifest.files).length} files pinned; log-8mib seed 0x${manifest.log8mib.seed.toString(16)}`,
  );
  if (!SKIP_BUILD) {
    console.log("→ building csp-probe entries via vite.config.ts --mode csp-probe");
    await build({ configFile: VITE_CONFIG, mode: "csp-probe", logLevel: "warn" });
  }
  console.log("→ loading local Playwright");
  const pw = await loadPlaywright();
  if (!pw.ok) {
    console.error(`✗ browser unavailable: ${pw.reason}`);
    console.error(`  install hint: ${INSTALL_HINT}`);
    process.exit(2);
  }
  console.log(`  playwright ${pw.version} (${pw.source}); chromium ${pw.executablePath}`);

  const wantFirefox = ENGINES.includes("firefox");
  const wantWebkit = ENGINES.includes("webkit");
  const webkitProbe = wantWebkit ? await loadWebkit(pw.ok) : { reason: "not requested" };

  const server = await startServer();
  const chromiumResult: EngineResult = { virtual: VIRTUAL };
  const firefoxResult: EngineResult = { virtual: VIRTUAL };
  const webkitResult: EngineResult = { virtual: VIRTUAL };
  /** Optional engines degrade to skipped-with-reason (a crashed engine is "unavailable",
   *  never a false pass: the skip lands in the JSON and on stdout with its install hint). */
  const tryEngine = async (label: string, run: () => Promise<void>, result: EngineResult): Promise<void> => {
    try {
      await run();
    } catch (err) {
      const reason = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      result.skipped = `launch/run failed: ${reason}`;
      console.warn(`⚠ ${label}: SKIPPED — ${result.skipped}`);
      console.warn(
        `  missing system libs? try: npx -y -p playwright@${PLAYWRIGHT_VERSION} playwright install-deps ${label}`,
      );
      console.warn(`  no browser at all?  try: ${INSTALL_HINT.replace("<chromium|firefox|webkit>", label)}`);
    }
  };
  try {
    chromiumResult.executablePath = pw.executablePath;
    Object.assign(chromiumResult, await runEngine("chromium", pw.chromium as unknown as PwLauncher));
    await runNarrow(pw.chromium as unknown as PwLauncher, "chromium");
    if (FS_SCALES.includes(3)) await runFs3(pw.chromium as unknown as PwLauncher, "chromium");
    if (wantFirefox && pw.firefox !== undefined) {
      firefoxResult.executablePath = pw.firefox.executablePath;
      await tryEngine(
        "firefox",
        async () => {
          Object.assign(firefoxResult, await runEngine("firefox", pw.firefox!.launcher as unknown as PwLauncher));
          await runNarrow(pw.firefox!.launcher as unknown as PwLauncher, "firefox");
        },
        firefoxResult,
      );
    } else if (wantFirefox) {
      firefoxResult.skipped = "no cached Firefox build";
      console.warn(`⚠ firefox: SKIPPED — no cached Firefox build`);
      console.warn(`  to enable: ${INSTALL_HINT.replace("<chromium|firefox|webkit>", "firefox")}`);
    }
    if (wantWebkit) {
      if ("launcher" in webkitProbe) {
        webkitResult.executablePath = webkitProbe.executablePath;
        await tryEngine(
          "webkit",
          async () => {
            Object.assign(webkitResult, await runEngine("webkit", webkitProbe.launcher));
            await runNarrow((webkitProbe as { launcher: PwLauncher }).launcher, "webkit");
          },
          webkitResult,
        );
      } else {
        webkitResult.skipped = webkitProbe.reason;
        console.warn(`⚠ webkit: SKIPPED — ${webkitResult.skipped}`);
        console.warn(`  to enable: ${INSTALL_HINT.replace("<chromium|firefox|webkit>", "webkit")}`);
      }
    }
  } finally {
    server.close();
  }

  printTable();

  const out = {
    schema: "preview-perf-baseline/1",
    meta: {
      date: new Date().toISOString(),
      playwright: pw.version,
      playwrightSource: pw.source,
      headless: true,
      viewportDefault: [1440, 900],
      dpr: 1,
      rounds: ROUNDS,
      streamRounds: STREAM_ROUNDS,
      fsScales: FS_SCALES,
      virtual: VIRTUAL,
      gate: GATE,
      corpusManifest: manifest,
      lineNumbers: "1 (on)",
      notes: [
        "baseline = pre-P1 dev HEAD incl. P0 (commit 1e768c70, @property geometry vars)",
        "6 activation windows use DISTINCT corpora (openWindow dedups same-path)",
        "log-8mib served from memory; chunk sizes 256 KiB + 1 MiB (hub streams 64 KiB × 300 ms)",
      ],
    },
    engines: { chromium: chromiumResult, firefox: firefoxResult, webkit: webkitResult },
    metrics,
    failures,
  };
  await writeFile(JSON_OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`\nJSON → ${JSON_OUT}`);

  if (GATE) {
    console.error("✗ --gate is not implemented yet (P3+: plan §6.1 gate table targets the virtual renderer)");
    process.exit(1);
  }
  if (failures.length > 0) {
    console.error(`✗ probe:preview-perf — ${failures.length} failure(s):`);
    for (const f of failures.slice(0, 40)) console.error(`  - [${f.engine}] ${f.id}: ${f.detail}`);
    process.exit(1);
  }
  console.log("✓ probe:preview-perf — baseline recorded (record-only; gate lands with P3)");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
