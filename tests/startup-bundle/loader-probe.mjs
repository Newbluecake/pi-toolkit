/**
 * Child probe for the startup-bundle parity suite: drives the REAL pi extension loader
 * (`loadExtensions` — the exact function pi uses for every extension path) against one entry and
 * prints {ms, errors, toolNames, commandNames} as JSON. Plain ESM on purpose: it imports pi's
 * compiled dist directly, no TS transform involved.
 *
 * argv: loader-probe.mjs <mode-and-entry...>  — usage:
 *   node loader-probe.mjs load <entryAbsPath> <cwd>
 * The pi package dir comes from PI_TOOLKIT_TEST_PI_PKG (set by the test) or is resolved from this
 * file's location (repo node_modules).
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

// `require.resolve` fails here (the pi package's exports map has no "require" condition);
// `import.meta.resolve` honors the "import" condition and yields dist/index.js.
const piPkg =
  process.env.PI_TOOLKIT_TEST_PI_PKG ??
  dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));

const [, , command, entry, cwd] = process.argv;
if (command !== "load") throw new Error(`loader-probe: unknown command ${command}`);

// Hermetic HOME: without this a bare layout read the developer's real ~/.pi/agent settings.
const home = mkdtempSync(join(tmpdir(), "pt-loader-probe-"));
const previousHome = process.env.HOME;
process.env.HOME = home;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.PI_TOOLKIT_ENTRY;

const { loadExtensions } = await import(pathToFileURL(join(piPkg, "dist", "core", "extensions", "loader.js")).href);
const t0 = performance.now();
const result = await loadExtensions([entry], cwd ?? process.cwd());
const ms = performance.now() - t0;
const ext = result.extensions[0];
const out = {
  ms: Math.round(ms),
  errors: result.errors.map((e) => String(e.error)),
  extensionCount: result.extensions.length,
  toolNames: ext ? [...ext.tools.keys()] : [],
  commandNames: ext ? (ext.commands ? [...ext.commands.keys()] : []) : [],
};
process.stdout.write(JSON.stringify(out));
process.exit(0);
// Not reached on happy path, but keep the cleanup honest for early throws above.
void previousHome;
void (() => {
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
})();
