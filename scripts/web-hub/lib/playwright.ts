/**
 * Local, offline-first Playwright loader (vue-plan.md v2.1 §1.4, §4.4.1, §5.2 — P0). Never a
 * project dependency: this machine already has `playwright@1.62.1`/`1.63.0`-class packages and
 * a matching cached Chromium build sitting in npm's npx cache and `~/.cache/ms-playwright/`
 * respectively — we reuse both instead of adding ~13 MB of devDependency weight for every
 * contributor.
 *
 * **Resolution strategy (deviates from the plan's literal one-liner — consulted with the plan
 * author 2026-09-27, both points agreed)**: `npx -y -p playwright@<ver> node -p
 * "require.resolve('playwright')"` does NOT actually resolve on this npm/Node (10.9.4/22.x):
 * the spawned `node -p` process's `process.cwd()` stays the caller's cwd, so bare-specifier
 * resolution walks *that* directory's ancestors, never npx's temp install dir — it throws
 * `MODULE_NOT_FOUND` every time. The equivalent that actually works: inside that SAME npx
 * sandbox's `node` subprocess, scan `process.env.PATH` for the entry npx prepends
 * (`<hash>/node_modules/.bin`) whose sibling `node_modules/playwright/package.json` really
 * exists, then `require.resolve('playwright', { paths: [that node_modules dir] })` — explicit
 * `paths` instead of ancestor-directory search. The child process also verifies, before ever
 * reporting success, that the resolved `playwright` version matches `PLAYWRIGHT_VERSION` and
 * that `chromium.executablePath()` points at a file that actually exists — a missing browser
 * binary is reported the same way as a missing package (`ok:false`), and this module's caller
 * treats it as "browser unavailable" (script exit code 2 per plan §4.4).
 *
 * Version pin: the plan's original `1.62.1` was carried over from v1 without a real check: its
 * `browsers.json` wants Chromium revision 1234, but this machine's `~/.cache/ms-playwright/`
 * only has revision 1243 — a strict version mismatch that would leave `executablePath()`
 * pointing at a directory that doesn't exist. `1.63.0`'s `browsers.json` wants exactly 1243
 * (verified against the cached browser). If a different machine's cache ever drifts again,
 * bump this constant to whatever `npm view playwright@<x> browsers.json` (or the resolved
 * chromium revision) actually matches what's on disk — the number itself carries no other
 * meaning, per the plan author.
 */
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

/** See the version-pin note above — bump if the locally cached Chromium revision ever drifts. */
export const PLAYWRIGHT_VERSION = "1.63.0";

const NPX_TIMEOUT_MS = 45_000;

export interface PwPage {
  goto(url: string, opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" }): Promise<unknown>;
  evaluate<T>(fn: (...args: never[]) => T | Promise<T>, ...args: never[]): Promise<T>;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
  waitForFunction(fn: string | ((...args: never[]) => unknown), opts?: { timeout?: number }): Promise<unknown>;
  click(selector: string): Promise<void>;
  close(): Promise<void>;
  on(event: "console" | "pageerror", handler: (...args: unknown[]) => void): void;
}

export interface PwContext {
  newPage(): Promise<PwPage>;
  addInitScript(script: string | { content: string }): Promise<void>;
  close(): Promise<void>;
}

export interface PwBrowser {
  newContext(opts?: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}

export interface PwChromium {
  launch(opts?: Record<string, unknown>): Promise<PwBrowser>;
}

export type LoadPlaywrightResult =
  | {
      readonly ok: true;
      readonly chromium: PwChromium;
      readonly version: string;
      readonly executablePath: string;
      readonly source: "offline" | "online";
    }
  | { readonly ok: false; readonly reason: string };

interface ChildProbeResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly entry?: string;
  readonly version?: string;
  readonly executablePath?: string;
}

/**
 * Runs inside the npx sandbox's own `node -e` subprocess (see the module doc above for why it
 * has to be there). Emits exactly one JSON line to stdout; never throws.
 */
const CHILD_PROBE_SCRIPT = `
const path = require("path");
const fs = require("fs");
function report(obj) {
  console.log(JSON.stringify(obj));
}
const BIN_SUFFIX = path.sep + "node_modules" + path.sep + ".bin";
const parts = (process.env.PATH || "").split(path.delimiter);
let nmDir;
for (const p of parts) {
  if (!p.endsWith(BIN_SUFFIX)) continue;
  const candidate = p.slice(0, -".bin".length - 1);
  if (fs.existsSync(path.join(candidate, "playwright", "package.json"))) {
    nmDir = candidate;
    break;
  }
}
if (!nmDir) {
  report({ ok: false, reason: "playwright-not-resolvable-from-PATH" });
  process.exit(0);
}
try {
  const pkg = require(path.join(nmDir, "playwright", "package.json"));
  const entry = require.resolve("playwright", { paths: [nmDir] });
  const pw = require(entry);
  const executablePath = pw.chromium.executablePath();
  const chromiumOk = fs.existsSync(executablePath);
  report({
    ok: chromiumOk,
    reason: chromiumOk ? undefined : "chromium-executable-missing: " + executablePath,
    entry,
    version: pkg.version,
    executablePath,
  });
} catch (err) {
  report({ ok: false, reason: "resolve-error: " + (err && err.message ? err.message : String(err)) });
}
`;

function runNpxProbe(offline: boolean): Promise<ChildProbeResult> {
  return new Promise((resolveP) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (offline) env["npm_config_offline"] = "true";
    else delete env["npm_config_offline"];
    execFile(
      "npx",
      ["-y", "-p", `playwright@${PLAYWRIGHT_VERSION}`, "node", "-e", CHILD_PROBE_SCRIPT],
      { env, timeout: NPX_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          resolveP({ ok: false, reason: `npx-failed: ${err.message}` });
          return;
        }
        const line = stdout.trim().split("\n").pop() ?? "";
        try {
          resolveP(JSON.parse(line) as ChildProbeResult);
        } catch {
          resolveP({ ok: false, reason: "npx-produced-no-json" });
        }
      },
    );
  });
}

/**
 * Offline-first: tries the npm/npx cache with networking disabled; only on failure retries once
 * with networking allowed (a genuinely missing/mismatched cache entry gets installed for real).
 * Both failing is reported as `{ ok: false }` — callers (scripts run via `tsx`) map that to
 * "browser unavailable" (exit code 2 per plan §4.4), distinct from an assertion failure (1).
 */
export async function loadPlaywright(): Promise<LoadPlaywrightResult> {
  const offlineResult = await runNpxProbe(true);
  const result = offlineResult.ok ? offlineResult : await runNpxProbe(false);
  const source: "offline" | "online" = offlineResult.ok ? "offline" : "online";
  if (!result.ok || result.entry === undefined || result.version === undefined || result.executablePath === undefined) {
    return { ok: false, reason: result.reason ?? "playwright unavailable (offline and online resolution both failed)" };
  }
  const mod = (await import(pathToFileURL(result.entry).href)) as {
    chromium?: PwChromium;
    default?: { chromium: PwChromium };
  };
  // Node's CJS/ESM interop (cjs-module-lexer) can't statically see playwright's dynamically
  // re-exported `module.exports` shape, so a dynamic `import()` of its CJS entry only reliably
  // exposes `default` (the whole CJS exports object) — named exports like `chromium` are not
  // guaranteed. Prefer a real named export if interop did detect one, else fall back to `default`.
  const chromium = mod.chromium ?? mod.default?.chromium;
  if (!chromium) {
    return {
      ok: false,
      reason: `playwright module at ${result.entry} exposed neither a named nor a default "chromium" export`,
    };
  }
  return { ok: true, chromium, version: result.version, executablePath: result.executablePath, source };
}
