#!/usr/bin/env -S npx tsx
/**
 * `npm run check:web` (vue-plan.md v2.1 §1.2, §4.1, §4.3, §5.2 — P0; §2.1/§5.2 P5b addendum).
 * Guards the *production* build output (`dist/web-hub-ui/`, `npm run build:web` must have
 * already run) against every CSP/security invariant the plan pins down, plus manifest/size
 * hygiene. Never touches `src/`.
 *
 * P5b addendum: after every P0-era check passes, this also runs the hub's own `verifyUiRoot`
 * (`hub/ui-root.ts`, §2.1) against `dist/web-hub-ui/` with the exact `{version, protoMajor}`
 * the real hub would expect from a package it shipped at this `package.json` version — the same
 * check the running hub performs before ever trusting this directory as its `"package"`
 * candidate. This closes the gap a CI build could otherwise slip through: every earlier check
 * here inspects file *contents*; `verifyUiRoot` additionally re-validates the exact trust
 * boundary (ownership/mode/symlinks/manifest hash) the hub itself applies, so a CI artifact that
 * passes `check:web` is guaranteed servable, not just well-formed.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { readPackageVersion } from "../../src/web-hub/ui/build-info-plugin.js";
import { verifyUiRoot } from "../../src/web-hub/hub/ui-root.js";
import { isAllowedUiPath, parseUiBuildInfo, type UiBuildInfo } from "../../src/web-hub/protocol/ui-manifest.js";
import { PROTO } from "../../src/web-hub/protocol/version.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIST_DIR = resolve(REPO_ROOT, "dist/web-hub-ui");
const HASHED_ASSET_RE = /-[A-Za-z0-9_-]{8,}\.(js|css|svg)$/;
const FORBIDDEN_JS_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "eval(", re: /\beval\s*\(/ },
  { name: "new Function(", re: /\bnew\s+Function\s*\(/ },
  { name: 'Function("', re: /\bFunction\s*\(\s*["']/ },
  { name: "sourceMappingURL", re: /sourceMappingURL=/ },
  { name: "static <style", re: /<style[\s>]/i },
  { name: "static <script", re: /<script[\s>]/i },
  { name: "static on*= attribute", re: /<[a-zA-Z][^>]*\son[a-zA-Z]+\s*=/i },
  { name: "static style= attribute", re: /<[a-zA-Z][^>]*\sstyle\s*=/i },
];
/** Documentation URLs allowed to appear as string literals (never as a resource fetch). */
const EXTERNAL_URL_ALLOWLIST: RegExp[] = [
  /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/,
  /^https:\/\/vuejs\.org\//, // Vue runtime's own `warn()` error-reference links (first-party framework code, not a fetch)
  /^http:\/\/www\.w3\.org\//, // XML namespace URIs (createElementNS("http://www.w3.org/2000/svg", ...)) — identifiers, never fetched
];
// Budget history: 120 KiB since #26 P0; bumped to 128 KiB by web-hub-preview PV6 (2026-10-05) —
// wiring `PathText`/`PreviewHost`/`usePreview` into App.vue pulls the whole preview feature into
// the bundle for the first time (HEAD-only 116885 B, HEAD+PV6 122969 B gzip at the bump);
// bumped to 144 KiB by fleet-drawer F6 (2026-10-05) — the drawer components go live
// (FleetDrawer/FleetTree/FleetSummaryBar/RunTranscript/RunHeader + summary.ts) and todo-web is
// in flight in the same workspace (工作区实测 134388 B gzip,含在途 todo-web);the slack above
// the measurement absorbs todo-web's landing without another immediate bump.
// bumped to 169 KiB by syntax-highlight (2026-10) — Prism rides a LAZY chunk
// (`assets/highlight-impl-*.js`, ~21 KB gz, loaded only when a highlightable code view
// mounts, never first-screen) while the main chunk grows by the renderer/logic/wiring;
// workspace-measured total ≈165 KB gz (含在途 model-switch M3a), a few KB of slack on top.
// bumped to 190 KiB by spawn-default-model + picker-widen (2026-10-06) — DirPicker goes
// modal + per-spawn SpawnModelField, the settings card pulls @sinclair/typebox's runtime
// parser (`parseSpawnModelRef` via protocol) into the bundle, plus popover clamp/flip and
// the full-page login; release gate measured 177,597 B gz, ~13 KiB slack on top.
// bumped to 208 KiB by worktree-diff D4 (2026-10-08) — the token/password wtdiff transport
// (~460 lines, mostly duplicated boilerplate that gzips well) lands at 194,621 B gz,
// 61 B over the old budget; the ~13 KiB of slack on top absorbs D5 (diff dialog components
// + wtdiff.js logic becoming reachable) landing without another immediate bump.
// bumped to 232 KiB by steer-recall P-ui + session-history P-ui (2026-10-09) — held queue rows,
// recall/re-edit and the epoch-scoped merge reducer, plus the history dialog/list logic; the
// release gate measured 225,926 B gz with both landed, ~11 KiB slack on top.
// Precise per-build numbers drift with in-flight packages — re-measure before the next bump.
// bumped to 245 KiB by worktree-graph P5 (2026-10-10). Independent pre-P5/P5
// measurement: main 216,146 B -> 218,760 B gz (+2,614 B), comprising approximately
// 1,334 B of en/zh graph dictionaries (the eager import.meta.glob architecture) and
// 1,280 B of panel wiring. Layout code stays in lazy assets/WorktreeGraph-*.js (~6.8 KB gz).
// Plan §5's <=1.5 KB main-increment gate is exceeded by an explicit main-session exception
// accepted 2026-10-10; this is NOT evidence of layout code leaking into main.
// Remeasured after the P5 rejection fixes (2026-10-10, current tree including concurrent
// packages): main 219,241 B gz; WorktreeGraph lazy chunk 6,840 B gz; total JS 248,175 B gz
// (including theme-init.js). The accepted 245 KiB budget remains unchanged, with 2,705 B
// of current-tree headroom. The independent delta above isolates P5; the current-tree
// main size must not be compared as an isolated P5 delta.
// sysload P5 (2026-10-11, docs/dev/sysload/plan.md §10 "仅实测超标时"): after sysload P4 (load
// pill / card / drawer banner + en/zh load dictionaries) and the @mention parity UI, total JS
// measured 255,430 B gz on a clean committed tree ⇒ budget raised to 255 KiB (261,120 B,
// ~5.6 KB headroom).
// Bumped to 256 KiB by web-hub-avatar U (2026-10-11, docs/dev/web-hub-avatar/plan.md §5):
// the client editor/composable and settings/transcript wiring measured 261,622 B gz, just over
// the 255 KiB gate; the minimum round-byte bump restores 522 B of headroom.
// Bumped to 257 KiB by web-hub-avatar W (2026-10-11): App.vue now wires useAvatar globally,
// so the U avatar UI is no longer tree-shaken; the measured bundle is 262,723 B gz.
// Budget rebase (2026-10-11): the current build measures 234,616 B gz on the first
// screen (theme-init.js + the entry module) and 28,106 B gz in lazy chunks. The old
// empirical total-JS budget counted lazy chunks that are not loaded on first paint;
// keep separate budgets so first-screen regressions are visible without making lazy
// feature growth a routine budget bump.
// Bumped to 254 KiB by the fleet badge + agent-card bash counts (2026-10-15, 用户拍板「如果有
// 运行中的命令,这里的数字也要统计进去」/「会话列表也要展示运行中的命令」): FleetSummaryBar's
// badge sums `summaryCounts(bashJobs).running` into the agent count and AgentCard gains a
// terminal-icon running-bash segment (`runningBashCount` via bashJobsOf/summaryCounts);
// measured 259,164 B gz, +112 B over the previous 259,052 B — minimum KiB-granularity bump.
// Bumped to 255 KiB by the quota pill width tiers + hover peek (2026-10-15, 用户需求「quota 在
// topbar 的宽度不能一直增长，如果项目过多，可以转换成悬浮展示的形式」): QuotaPill gains the
// three-face tier system (full/compact/names text forms + a hidden per-tier clone measurer +
// ResizeObserver-driven evaluation with hysteresis and a CSS-cap probe) and the hover-peek
// popover wiring (pin/peek state, 150ms open / 200ms close timers, QuotaCard's no-focus-steal
// `peek` prop); QuotaCard/i18n label changes ride along. Measured 260,326 B gz vs 259,165 B
// before (+1,161 B, incl. the verifier R1/R2 per-tier data-face on the measurer clones) — after byte-level trims (single cssText probe write, index-based tier
// scan, shared hover handlers) the remaining ~1.1 KB is intrinsic to the spec (hysteresis and
// the cap probe are required behaviour, not fat), so the minimum 1 KiB bump it is.
const FIRST_SCREEN_JS_BUDGET_GZIP_BYTES = 255 * 1024;
const LAZY_JS_BUDGET_GZIP_BYTES = 42 * 1024;
// CSS (one file, cssCodeSplit:false ⇒ all of it is first-screen): the 25 KiB set in vue-plan v2.1
// was as empirical as the old JS total. 2026-10-11 (user: don't spend effort squeezing gzip bytes)
// it follows the same rule as the first-screen JS budget — measured 25,615 B gz × 1.10 rounded up
// to a whole KiB = 28 KiB — so it stays a regression alarm instead of a per-feature chore.
const CSS_BUDGET_GZIP_BYTES = 28 * 1024;

export type JsAssetClassification = {
  firstScreen: Set<string>;
  lazy: Set<string>;
};

function assetPath(value: string): string {
  const pathname = value.split(/[?#]/, 1)[0] ?? value;
  return decodeURIComponent(pathname)
    .replace(/^\/+/, "")
    .replace(/^(\.\/)+/, "");
}

function htmlAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of tag.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    attrs.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function staticImports(source: string): string[] {
  const imports: string[] = [];
  // Dynamic import() is deliberately excluded: those modules are lazy by definition. Whitespace is
  // optional because minified output emits `import{a}from"./x.js"` / `import"./x.js"`; static
  // re-exports (`export{a}from"./x.js"`) load eagerly too.
  const importRe = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[^("'`]+?\s*from\s*)?["']([^"']+)["']/g;
  for (const match of source.matchAll(importRe)) imports.push(match[1]!);
  return imports;
}

/** Classify JS files loaded by the built index.html, including static-import fallback. */
export function classifyJsAssets(html: string, jsSources: ReadonlyMap<string, string>): JsAssetClassification {
  const firstScreen = new Set<string>();
  const entryModules: string[] = [];
  const modulePreloads: string[] = [];
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const attrs = htmlAttributes(match[0]);
    const src = attrs.get("src");
    const href = attrs.get("href");
    if (match[1]!.toLowerCase() === "script" && src && (attrs.get("type") ?? "").toLowerCase() === "module") {
      entryModules.push(assetPath(src));
    } else if (match[1]!.toLowerCase() === "link" && attrs.get("rel")?.toLowerCase() === "modulepreload" && href) {
      modulePreloads.push(assetPath(href));
    } else if (match[1]!.toLowerCase() === "script" && src && assetPath(src).endsWith(".js")) {
      firstScreen.add(assetPath(src));
    }
  }
  for (const path of [...entryModules, ...modulePreloads]) firstScreen.add(path);

  if (modulePreloads.length === 0) {
    const pending = [...entryModules];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const source = jsSources.get(current);
      if (!source) continue;
      const currentDir = current.includes("/") ? current.slice(0, current.lastIndexOf("/") + 1) : "";
      for (const imported of staticImports(source)) {
        if (!imported.startsWith(".")) continue;
        const resolved = assetPath(join(currentDir, imported));
        firstScreen.add(resolved);
        pending.push(resolved);
      }
    }
  }

  const allJs = new Set([...jsSources.keys()].filter((path) => path.endsWith(".js")));
  return {
    firstScreen: new Set([...firstScreen].filter((path) => allJs.has(path))),
    lazy: new Set([...allJs].filter((path) => !firstScreen.has(path))),
  };
}

export function gzipBytes(source: string | Uint8Array): number {
  return gzipSync(source).length;
}

export function budgetExceeded(actual: number, budget: number): boolean {
  return actual > budget;
}

class CheckError extends Error {}

function fail(msg: string): never {
  throw new CheckError(msg);
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(abs)));
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

function relPosix(dir: string, abs: string): string {
  return relative(dir, abs).split("\\").join("/");
}

async function checkIndexHtml(html: string): Promise<void> {
  if (!html.includes('data-auth-mode="__AUTH_MODE__"')) {
    fail('index.html is missing the data-auth-mode="__AUTH_MODE__" placeholder serveIndex() substitutes');
  }
  const scriptTagRe = /<script\b[^>]*>/gi;
  for (const m of html.matchAll(scriptTagRe)) {
    if (!/\bsrc\s*=/.test(m[0])) fail(`inline <script> without src in index.html: ${m[0]}`);
  }
  if (/<style[\s>]/i.test(html)) fail("index.html contains a <style> tag");
  if (/\son[a-zA-Z]+\s*=/i.test(html)) fail("index.html contains an on*= inline event attribute");
  if (/\sstyle\s*=/i.test(html)) fail("index.html contains a style= attribute");
}

function scanForbiddenPatterns(source: string, file: string): void {
  for (const { name, re } of FORBIDDEN_JS_PATTERNS) {
    if (re.test(source)) fail(`${file}: forbidden pattern "${name}"`);
  }
  const urlRe = /https?:\/\/[^\s"'()<>`;]+/g;
  for (const m of source.matchAll(urlRe)) {
    const url = m[0];
    if (!EXTERNAL_URL_ALLOWLIST.some((allow) => allow.test(url))) {
      fail(`${file}: external resource reference not on the allowlist: ${url}`);
    }
  }
}

async function checkManifest(files: string[]): Promise<UiBuildInfo> {
  const infoPath = join(DIST_DIR, "build-info.json");
  const raw = await readFile(infoPath, "utf8").catch(() => fail("build-info.json is missing"));
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    fail("build-info.json is not valid JSON");
  }
  const parsed = parseUiBuildInfo(json);
  if (!parsed.ok) fail(`build-info.json failed validation: ${parsed.error}`);

  const onDisk = new Map<string, string>(); // path -> abs
  for (const abs of files) {
    const rel = relPosix(DIST_DIR, abs);
    if (rel === "build-info.json") continue;
    onDisk.set(rel, abs);
  }
  const manifestPaths = new Set(parsed.info.files.map((f) => f.path));
  for (const path of manifestPaths) {
    if (!onDisk.has(path)) fail(`build-info.json lists "${path}" but it is missing from dist/web-hub-ui/`);
  }
  for (const path of onDisk.keys()) {
    if (!manifestPaths.has(path)) fail(`"${path}" exists in dist/web-hub-ui/ but is not listed in build-info.json`);
  }
  for (const entry of parsed.info.files) {
    const abs = onDisk.get(entry.path)!;
    const buf = await readFile(abs);
    const st = await stat(abs);
    if (st.size !== entry.bytes) fail(`"${entry.path}": manifest bytes ${entry.bytes} != actual ${st.size}`);
    const sha = createHash("sha256").update(buf).digest("hex");
    if (sha !== entry.sha256) fail(`"${entry.path}": manifest sha256 mismatch`);
  }
  return parsed.info;
}

async function main(): Promise<void> {
  await stat(DIST_DIR).catch(() => fail(`${DIST_DIR} does not exist — run "npm run build:web" first`));

  const files = await listFiles(DIST_DIR);
  if (files.length === 0) fail(`${DIST_DIR} is empty`);

  for (const abs of files) {
    const rel = relPosix(DIST_DIR, abs);
    if (rel === "build-info.json") continue;
    if (!isAllowedUiPath(rel)) fail(`unexpected file not on the UI path whitelist: ${rel}`);
    if (extname(rel) === ".map") fail(`.map file must not ship: ${rel}`);
    if (rel.startsWith("assets/") && !HASHED_ASSET_RE.test(rel)) {
      fail(`asset file name has no ≥8-char hash: ${rel}`);
    }
  }

  const indexAbs = join(DIST_DIR, "index.html");
  await checkIndexHtml(await readFile(indexAbs, "utf8").catch(() => fail("index.html is missing")));

  let cssGzipTotal = 0;
  const jsSources = new Map<string, string>();
  const jsGzipBytes = new Map<string, number>();
  for (const abs of files) {
    const rel = relPosix(DIST_DIR, abs);
    if (rel === "build-info.json") continue;
    const ext = extname(rel);
    if (ext === ".js") {
      const source = await readFile(abs, "utf8");
      scanForbiddenPatterns(source, rel);
      jsSources.set(rel, source);
      jsGzipBytes.set(rel, gzipBytes(source));
    } else if (ext === ".css") {
      const source = await readFile(abs, "utf8");
      if (/<style[\s>]/i.test(source)) fail(`${rel}: contains a <style> tag literal (unexpected in CSS)`);
      // Motion pref (2026-10, `pwh_motion`): the reduce rules must have been rewritten.
      // `[data-motion=…]` selectors appear in built CSS ONLY through vite.config.ts's
      // motion-css.ts PostCSS pass, so a reduce query without them means that pass did not
      // run for this build (plugin unwired / bypassed) — the browser-side switch would be dead.
      // Quote-agnostic: the minifier strips attribute-value quotes (`[data-motion=off]`).
      if (/prefers-reduced-motion/i.test(source) && !/\[data-motion=(["']?)off\1\]/.test(source)) {
        fail(
          `${rel}: prefers-reduced-motion rules present but the pwh_motion rewrite left no [data-motion="off"] copies — is motionPrefCssPlugin wired in src/web-hub/ui/vite.config.ts?`,
        );
      }
      cssGzipTotal += gzipSync(await readFile(abs)).length;
    }
  }
  const classification = classifyJsAssets(await readFile(indexAbs, "utf8"), jsSources);
  const firstScreenJsGzip = [...classification.firstScreen].reduce((total, path) => total + jsGzipBytes.get(path)!, 0);
  const lazyJsGzip = [...classification.lazy].reduce((total, path) => total + jsGzipBytes.get(path)!, 0);
  if (budgetExceeded(firstScreenJsGzip, FIRST_SCREEN_JS_BUDGET_GZIP_BYTES)) {
    fail(`first-screen JS gzip budget exceeded: ${firstScreenJsGzip} > ${FIRST_SCREEN_JS_BUDGET_GZIP_BYTES} bytes`);
  }
  if (budgetExceeded(lazyJsGzip, LAZY_JS_BUDGET_GZIP_BYTES)) {
    fail(`lazy JS gzip budget exceeded: ${lazyJsGzip} > ${LAZY_JS_BUDGET_GZIP_BYTES} bytes`);
  }
  if (cssGzipTotal > CSS_BUDGET_GZIP_BYTES) {
    fail(`CSS gzip budget exceeded: ${cssGzipTotal} > ${CSS_BUDGET_GZIP_BYTES} bytes`);
  }

  await checkManifest(files);

  const version = await readPackageVersion();
  const verified = await verifyUiRoot(DIST_DIR, { version, protoMajor: PROTO.major });
  if (!verified.ok) {
    fail(
      `hub's own verifyUiRoot rejected dist/web-hub-ui/: ${verified.reason}${verified.detail ? ` (${verified.detail})` : ""}`,
    );
  }

  console.log(
    `✓ check:web — dist/web-hub-ui/ OK (${files.length} files, first-screen JS ${firstScreenJsGzip}B gz/${FIRST_SCREEN_JS_BUDGET_GZIP_BYTES}B, lazy JS ${lazyJsGzip}B gz/${LAZY_JS_BUDGET_GZIP_BYTES}B, CSS ${cssGzipTotal}B gz/${CSS_BUDGET_GZIP_BYTES}B)`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`✗ check:web — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
