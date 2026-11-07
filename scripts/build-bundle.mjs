/**
 * Build the single-file ESM bundle (startup-bundle plan r3 §3.5/§6.3).
 *
 * Why: pi loads every extension through jiti, which walks the whole module graph file by file
 * (~643 files here ⇒ 9.9-11.6 s). A single pre-bundled `.js` file takes ~0.85 s natively; the
 * entry dispatcher (`index.ts`) installs host-module resolution hooks and then imports this file.
 *
 * Determinism: identical inputs must produce identical bytes (CI asserts the sha256). No
 * timestamps, no absolute paths, no minifier version skew, no sourcemap by default.
 *
 * Gates run on every build (they cost one extra 0.17 s build, and a broken artifact that only CI
 * notices is worse than a 0.2 s script):
 *   - reproducibility: two builds, equal sha256
 *   - size budget:    <= 6 MB
 *   - inputs:         every metafile input starts with `src/` (no node_modules may slip in)
 *   - dynamic import: zero `import(` / `__require(` in the output
 *
 * Usage: node scripts/build-bundle.mjs [--check]   (--check: verify only, do not write)
 *        BUNDLE_SOURCEMAP=1 node scripts/build-bundle.mjs   (writes dist/bundle/index.js.map)
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { BUNDLE_EXTERNALS } from "./bundle-externals.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT = join(ROOT, "dist", "bundle", "index.js");
const SIZE_BUDGET = 6 * 1024 * 1024;
const TIME_BUDGET_MS = 5_000;

const checkOnly = process.argv.includes("--check");
const withSourcemap = process.env.BUNDLE_SOURCEMAP === "1";

/** One build. `write:false` keeps the bytes in memory so hashing happens before any write. */
async function run() {
  const started = Date.now();
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ["src/index.ts"],
    outfile: OUT,
    bundle: true,
    format: "esm", // must be ESM: import.meta.url is empty under CJS
    platform: "node",
    target: "node22",
    charset: "utf8",
    // Explicit list, not `packages: "external"`: same bytes, but an accidental new bare dependency
    // then fails the "inputs start with src/" gate instead of being silently externalized.
    external: BUNDLE_EXTERNALS,
    // No minify: measured no speed gain (887 vs 917 ms) and it costs stack readability.
    // No splitting: one file IS the win — jiti's per-module cost returns with every extra file.
    sourcemap: withSourcemap ? "external" : false,
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
    write: false,
  });
  return { result, elapsedMs: Date.now() - started };
}

function fail(message) {
  console.error(`build:bundle FAILED — ${message}`);
  process.exit(1);
}

const outputsOf = (result) => result.outputFiles ?? [];
const bundleText = (result) => {
  const file = outputsOf(result).find((output) => output.path === OUT);
  if (file === undefined) fail(`esbuild produced no ${relative(ROOT, OUT)}`);
  return file.text;
};
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const first = await run();
const firstText = bundleText(first.result);
const firstHash = sha256(firstText);

// Gate: reproducibility (rebuild into memory; the first build already has the same inputs).
const second = await run();
const secondHash = sha256(bundleText(second.result));
if (firstHash !== secondHash) fail(`not reproducible: ${firstHash} != ${secondHash}`);

// Gate: size budget.
const bytes = Buffer.byteLength(firstText, "utf8");
if (bytes > SIZE_BUDGET) fail(`bundle is ${bytes} bytes, over the ${SIZE_BUDGET}-byte budget`);

// Gate: build time.
if (first.elapsedMs > TIME_BUDGET_MS) fail(`build took ${first.elapsedMs} ms, over ${TIME_BUDGET_MS} ms`);

// Gate: only src/ inputs (nothing from node_modules).
const foreign = Object.keys(first.result.metafile.inputs).filter((input) => !input.startsWith("src/"));
if (foreign.length > 0) fail(`non-src inputs: ${foreign.slice(0, 10).join(", ")}`);

// Gate: no dynamic import / CJS require left in the artifact (bundle-internal imports hide the
// host-identity problem: they would resolve natively from dist/bundle/ up into node_modules).
const dynamicImports = firstText.match(/\bimport\s*\(|\b__require\s*\(/g) ?? [];
if (dynamicImports.length > 0) fail(`artifact contains ${dynamicImports.length} dynamic import/__require`);

if (checkOnly) {
  // --check must not leave a stale artifact behind either: verify what is on disk matches.
  let onDisk;
  try {
    onDisk = readFileSync(OUT, "utf8");
  } catch {
    fail(`${relative(ROOT, OUT)} is missing (run without --check first, or in this command)`);
  }
  if (sha256(onDisk) !== firstHash) fail(`${relative(ROOT, OUT)} on disk differs from a fresh build`);
  console.log(
    `build:bundle --check ok — ${relative(ROOT, OUT)} sha256=${firstHash.slice(0, 16)} ` +
      `size=${(bytes / 1024 / 1024).toFixed(2)} MB time=${first.elapsedMs} ms`,
  );
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, firstText);
  if (withSourcemap) {
    const map = outputsOf(first.result).find((output) => output.path === `${OUT}.map`);
    if (map !== undefined) writeFileSync(`${OUT}.map`, map.text);
  } else {
    rmSync(`${OUT}.map`, { force: true });
  }
  console.log(
    `build:bundle ok — ${relative(ROOT, OUT)} sha256=${firstHash.slice(0, 16)} ` +
      `size=${(bytes / 1024 / 1024).toFixed(2)} MB time=${first.elapsedMs} ms ` +
      `inputs=${Object.keys(first.result.metafile.inputs).length}`,
  );
}
