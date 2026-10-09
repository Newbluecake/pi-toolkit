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
const JS_BUDGET_GZIP_BYTES = 232 * 1024;
const CSS_BUDGET_GZIP_BYTES = 25 * 1024;

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

  let jsGzipTotal = 0;
  let cssGzipTotal = 0;
  for (const abs of files) {
    const rel = relPosix(DIST_DIR, abs);
    if (rel === "build-info.json") continue;
    const ext = extname(rel);
    if (ext === ".js") {
      const source = await readFile(abs, "utf8");
      scanForbiddenPatterns(source, rel);
      jsGzipTotal += gzipSync(await readFile(abs)).length;
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
  if (jsGzipTotal > JS_BUDGET_GZIP_BYTES) {
    fail(`JS gzip budget exceeded: ${jsGzipTotal} > ${JS_BUDGET_GZIP_BYTES} bytes`);
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
    `✓ check:web — dist/web-hub-ui/ OK (${files.length} files, JS ${jsGzipTotal}B gz, CSS ${cssGzipTotal}B gz)`,
  );
}

main().catch((err: unknown) => {
  console.error(`✗ check:web — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
