/**
 * Bundle entry support — startup-bundle plan r3 §3.3.2 / §4.2 / §6.1.
 *
 * The package-root `index.ts` is a dispatcher: it either forwards to the TypeScript source (slow,
 * always correct) or imports the pre-built `dist/bundle/index.js` natively (fast). This module
 * holds everything that decision needs, minus the `import()` itself — the dynamic import stays in
 * the root entry because `tests/boundary/pi-free.test.ts` rejects unresolvable import expressions
 * anywhere under `src/core/` (a computed specifier is exactly that).
 *
 * Constraints baked in here:
 * - I4: no module-scope mutable state; the only cross-activation memory is the
 *   `Symbol.for("pi-subagent:bundle-hooks")` marker, which is process-global by design (the
 *   resolution hook itself is process-global and one-shot).
 * - I8: pi-free — `node:fs` / `node:path` / `node:url` / `node:module` only.
 * - Nothing blocks: every fs call is synchronous but bounded by the src walk (§6.1.1 says 28-33 ms).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOST_SPECIFIERS, resolveHostModules, type HostResolveDeps } from "./host-modules.js";

/** Process-global marker for the installed resolution hook. */
const HOOKS_KEY = Symbol.for("pi-subagent:bundle-hooks");
/** Escape hatch: `PI_TOOLKIT_ENTRY=src` forces the source path (dev/pan-broken-bundle). */
export const ENTRY_ENV = "PI_TOOLKIT_ENTRY";
/** Warn prefix shared with every other startup warning in this package. */
const LOG_PREFIX = "[pi-subagent]";

/**
 * `dist/bundle/index.js`, resolved from THIS module. Both `src/core/` and `dist/bundle/`
 * (the bundle's own flattened layout) sit two levels below the package root, so the relative walk
 * is layout-independent — and it needs no `packageRoot()` (that file belongs to P1).
 */
export function bundlePath(): string {
  return fileURLToPath(new URL("../../dist/bundle/index.js", import.meta.url));
}

/** Absolute `file://` URL of the bundle — the computed specifier the dispatcher imports. */
export function bundleUrl(deps: BundleEntryDeps = {}): string {
  return pathToFileURL(deps.bundleFile ?? bundlePath()).href;
}

/** Package root, derived from the same anchor. Used for the staleness scan only. */
export function packageDir(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

export interface BundleEntryDeps extends HostResolveDeps {
  /** Test seam: bundle path (default `bundlePath()`). */
  readonly bundleFile?: string;
  /** Test seam: source tree root for staleness (default `packageDir()/src`). */
  readonly srcDir?: string;
  /** Test seam: hook installer (default `module.registerHooks` when available). */
  readonly registerHooks?: ((options: { resolve: BundleResolveHook }) => unknown) | undefined;
  /** Test seam: file existence (default `existsSync`). */
  readonly exists?: (path: string) => boolean;
  /** Test seam: directory listing (default `readdirSync`). */
  readonly readdir?: (path: string) => string[];
  /** Test seam: mtime in ms (default `statSync().mtimeMs`). */
  readonly mtime?: (path: string) => number;
}

export type BundleResolveHook = (
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context?: unknown) => unknown,
) => unknown;

const defaultRegisterHooks = (nodeModule as { registerHooks?: unknown }).registerHooks;

/** `module.registerHooks` when the caller did not inject one. An EXPLICIT `undefined`
 *  (`{ registerHooks: undefined }`) means "pretend the runtime lacks it" — that is the Node <22.15
 *  test seam, so a `??` fallback would make the degradation path untestable. */
function hookInstaller(deps: BundleEntryDeps): ((options: { resolve: BundleResolveHook }) => unknown) | undefined {
  if ("registerHooks" in deps) return deps.registerHooks;
  return defaultRegisterHooks as ((options: { resolve: BundleResolveHook }) => unknown) | undefined;
}

/** Node >= 22.15 exposes `module.registerHooks`; older 22.x cannot pin host identity (§3.3.2 #4). */
export function hooksSupported(deps: BundleEntryDeps = {}): boolean {
  return typeof hookInstaller(deps) === "function";
}

/** Pure fs probe — no side effects, no caching. */
export function bundleAvailable(deps: BundleEntryDeps = {}): boolean {
  const exists = deps.exists ?? existsSync;
  return exists(deps.bundleFile ?? bundlePath());
}

/** True when the caller explicitly asked for the source path. */
export function sourceEntryForced(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[ENTRY_ENV]?.trim().toLowerCase() === "src";
}

export interface InstallHooksResult {
  readonly installed: boolean;
  /** Present when `installed === false` for a reason the caller should report. */
  readonly reason?: string;
}

/**
 * Install the host-identity resolution hook (idempotent per process).
 *
 * Every bare specifier the bundle emits is mapped to the host copy, so `instanceof` and schema
 * semantics match the running pi. A specifier that cannot be resolved is FATAL for the bundle
 * path: a partial redirect would produce a graph that is half host, half repo copy — worse than
 * either extreme (§3.3.2 #3). The caller turns this into a hard error; it must not fall back.
 */
export function installBundleHooks(deps: BundleEntryDeps = {}): InstallHooksResult {
  const globals = globalThis as Record<symbol, unknown>;
  if (globals[HOOKS_KEY] === true) return { installed: false, reason: "already installed" };

  const install = hookInstaller(deps);
  if (typeof install !== "function") {
    return { installed: false, reason: "module.registerHooks is unavailable (needs Node >= 22.15)" };
  }

  const resolution = resolveHostModules(deps);
  if (!resolution.ok) return { installed: false, reason: resolution.reason };

  const map = new Map<string, string>();
  const missing: string[] = [];
  for (const entry of HOST_SPECIFIERS) {
    const target = resolution.resolveHost(entry.spec);
    if (target === undefined) missing.push(entry.spec);
    else map.set(entry.spec, target);
  }
  if (missing.length > 0) {
    return {
      installed: false,
      reason: `host modules not resolvable: ${missing.join(", ")} (pi package: ${resolution.piPackageJson})`,
    };
  }

  install({
    resolve: ((specifier: string, context: unknown, nextResolve: (s: string, c?: unknown) => unknown) => {
      const hit = map.get(specifier);
      if (hit !== undefined) return { url: pathToFileURL(hit).href, shortCircuit: true };
      return nextResolve(specifier, context);
    }) satisfies BundleResolveHook,
  });
  globals[HOOKS_KEY] = true;
  return { installed: true };
}

/** Clears the process-global marker. Tests only — the OS-level hook itself cannot be removed. */
export function resetBundleHooksForTest(): void {
  delete (globalThis as Record<symbol, unknown>)[HOOKS_KEY];
}

export interface Staleness {
  readonly state: "fresh" | "stale" | "unknown";
  readonly bundleMtimeMs: number;
  readonly newestSrcMtimeMs: number;
  readonly newestSrcPath: string;
}

/**
 * Compare the bundle's mtime with the newest TypeScript source mtime (§6.1.1).
 *
 * - no bundle ⇒ "unknown" (the caller already took the source path; nothing to warn about)
 * - no src ⇒ "fresh" (release/npm install: the artifact is the only source of truth, zero output —
 *   I9: an unrelated install form must stay byte-identical on stderr)
 * - src newer ⇒ "stale" (warn, keep running the OLD code: never rebuild, never throw)
 *
 * Unreadable entries are skipped rather than fatal: a warning probe must never break startup.
 */
export function staleness(deps: BundleEntryDeps = {}): Staleness {
  const exists = deps.exists ?? existsSync;
  const bundleFile = deps.bundleFile ?? bundlePath();
  const srcDir = deps.srcDir ?? join(packageDir(), "src");
  const mtime = deps.mtime ?? ((path: string) => statSync(path).mtimeMs);

  // Presence first: a missing bundle is "unknown" regardless of what an mtime probe would answer.
  if (!exists(bundleFile)) return { state: "unknown", bundleMtimeMs: 0, newestSrcMtimeMs: 0, newestSrcPath: "" };

  let bundleMtimeMs: number;
  try {
    bundleMtimeMs = mtime(bundleFile);
  } catch {
    return { state: "unknown", bundleMtimeMs: 0, newestSrcMtimeMs: 0, newestSrcPath: "" };
  }
  if (!exists(srcDir)) return { state: "fresh", bundleMtimeMs, newestSrcMtimeMs: 0, newestSrcPath: "" };

  const newest = newestSource(srcDir, deps);
  if (newest === undefined) return { state: "fresh", bundleMtimeMs, newestSrcMtimeMs: 0, newestSrcPath: "" };

  // mtime granularity can be coarse (1 s on some filesystems): treat equality as fresh so a build
  // that lands in the same tick as the last edit never produces a bogus warning.
  const state = newest.mtimeMs > bundleMtimeMs ? "stale" : "fresh";
  return { state, bundleMtimeMs, newestSrcMtimeMs: newest.mtimeMs, newestSrcPath: newest.path };
}

/** Directories under `src/` that are NOT bundle inputs (vite builds the web UI separately).
 *  A `.ts` file there can never make the bundle stale, so the scan skips it — otherwise any UI edit
 *  would raise a permanent bogus "bundle is stale" warning. */
const NON_BUNDLE_DIRS = [join("src", "web-hub", "ui")];

/** Newest `.ts` mtime under `dir` (recursive, dot-dirs skipped, symlinks not followed). */ function newestSource(
  dir: string,
  deps: BundleEntryDeps,
): { path: string; mtimeMs: number } | undefined {
  const readdir = deps.readdir ?? ((path: string) => readdirSync(path));
  const mtime = deps.mtime ?? ((path: string) => statSync(path).mtimeMs);
  let best: { path: string; mtimeMs: number } | undefined;
  const pending: string[] = [dir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let names: string[];
    try {
      names = readdir(current);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = join(current, name);
      if (name.endsWith(".ts")) {
        try {
          const mtimeMs = mtime(full);
          if (best === undefined || mtimeMs > best.mtimeMs) best = { path: full, mtimeMs };
        } catch {
          continue; // vanished mid-scan
        }
        continue;
      }
      // Only descend into plausible directories; a stat per file would double the scan cost.
      if (name.includes(".")) continue;
      if (NON_BUNDLE_DIRS.some((suffix) => full.endsWith(suffix))) continue;
      pending.push(full);
    }
  }
  return best;
}

/** The startup warning for a stale bundle. Empty string ⇒ nothing to say (§6.1.1). */
export function staleWarning(info: Staleness): string {
  if (info.state !== "stale") return "";
  const src = new Date(info.newestSrcMtimeMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const built = new Date(info.bundleMtimeMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    `${LOG_PREFIX} bundle is stale (src updated ${src} > bundle built ${built}); running OLD code — ` +
    `run \`npm run build:bundle\` (or set ${ENTRY_ENV}=src)`
  );
}

/** The `activate` factory a bundle must expose. */
export type BundleFactory = (pi: unknown) => void | Promise<void>;

/**
 * Pick the `activate` factory out of a loaded module namespace.
 * A bundle whose default export is not callable is a broken artifact ⇒ throw (never a silent
 * no-op extension that looks loaded but registers nothing).
 */
export function pickBundleFactory(namespace: unknown): BundleFactory {
  const candidate =
    typeof namespace === "object" && namespace !== null ? (namespace as { default?: unknown }).default : undefined;
  if (typeof candidate !== "function") {
    throw new Error(`${LOG_PREFIX} bundle has no default activate() export — rebuild with \`npm run build:bundle\``);
  }
  return candidate as BundleFactory;
}

/** Directory half of `bundlePath()`, exported for diagnostics/tests. */
export function bundleDir(): string {
  return dirname(bundlePath());
}
