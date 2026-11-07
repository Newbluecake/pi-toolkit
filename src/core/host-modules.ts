/**
 * Host module resolution — startup-bundle plan r3 §3.3.1.
 *
 * The esbuild bundle (dist/bundle/index.js) loads natively, so its bare specifiers resolve through
 * Node's own algorithm: from `dist/bundle/` that finds THIS repo's `node_modules/` copy on a
 * local-path install (the default on the dev machine), which would give a second `Container` class
 * and a second typebox — `instanceof` silently false, schema semantics wrong (§2.4). The entry
 * dispatcher therefore pins every bare specifier to the HOST (pi's) copy before importing the
 * bundle; this file computes those targets.
 *
 * Anchor: `realpath(argv1)` → walk up to pi's package.json → `createRequire(<that package.json>)`.
 * `createRequire(argv1)` is NOT used directly — `bin/pi` is a symlink on every normal install
 * (§3.3.1), and resolving from the symlink path yields `Cannot find module`.
 *
 * pi-free (I8: `tests/boundary/pi-free.test.ts` scans src/core for non-`node:` imports).
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

const PI_SCOPE = "@earendil-works";
const PI_PKG = "pi-coding-agent";
/** pi's own package — the resolution anchor (its package.json is the createRequire base). */
export const PI_PACKAGE = `${PI_SCOPE}/${PI_PKG}`;

/**
 * Bare specifiers the bundle may emit, and how each maps onto the host tree.
 *
 * - `require`: `createRequire(piPackageJson).resolve(request)` — pi aliases these to its own
 *   dependency copies, so the host's require agrees with pi's `getAliases()`.
 * - `package`: locate `<name>/package.json` by walking up from pi's package dir (pi keeps its
 *   peers in sibling `node_modules/`), then read its entry for `subpath` from the manifest.
 *   Needed because pi's packages export ONLY the `import` condition:
 *   `require.resolve("@earendil-works/pi-coding-agent")` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`
 *   (measured, pi 1.4.0). `pi-ai` additionally maps its root to the `compat` entry (§3.3.2 #2).
 *
 * `@sinclair/typebox` is deliberately absent as a resolution target: the host tree has no such
 * package (only `typebox@1.3.27`), which is exactly why the repo's devDep
 * (`@sinclair/typebox@0.34.52`) must never be what the bundle picks up.
 */
export const HOST_SPECIFIERS: ReadonlyArray<{
  /** the specifier the bundle emits */
  readonly spec: string;
  /** the host package that must satisfy it */
  readonly packageName: string;
  /** which `exports` key of that package */
  readonly subpath: string;
}> = [
  { spec: "@earendil-works/pi-coding-agent", packageName: PI_PACKAGE, subpath: "." },
  { spec: "@earendil-works/pi-tui", packageName: "@earendil-works/pi-tui", subpath: "." },
  // pi aliases pi-ai's root to the compat entrypoint — a strict superset of the core entrypoint.
  { spec: "@earendil-works/pi-ai", packageName: "@earendil-works/pi-ai", subpath: "./compat" },
  { spec: "typebox", packageName: "typebox", subpath: "." },
  { spec: "typebox/value", packageName: "typebox", subpath: "./value" },
  // The repo's peer spelling; source code imports this name. Mapped to the host's `typebox`.
  { spec: "@sinclair/typebox", packageName: "typebox", subpath: "." },
  { spec: "@sinclair/typebox/value", packageName: "typebox", subpath: "./value" },
];

export interface HostResolveDeps {
  /** Parent-process entry (default `process.argv[1]`). */
  readonly argv1?: string | undefined;
  readonly realpath?: (path: string) => string;
  readonly exists?: (path: string) => boolean;
  /** Test seam: resolution anchored at a package.json path (default `createRequire`). */
  readonly resolveFromPackageJson?: (fromPackageJson: string, request: string) => string;
  /** Test seam: manifest read (default `readFileSync`). */
  readonly readText?: (path: string) => string;
}

export type HostResolution =
  | {
      readonly ok: true;
      readonly piPackageJson: string;
      /** undefined ⇒ that specifier has no host counterpart (the caller must treat it as fatal). */
      readonly resolveHost: (spec: string) => string | undefined;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Locate `@earendil-works/pi-coding-agent/package.json` at or above `start` (a file path).
 * Walks at most 64 levels. Shared with the hub launcher (`src/web-hub/agent/launcher.ts`).
 */
export function findPiPackageJson(start: string, exists: (path: string) => boolean = existsSync): string | undefined {
  let dir = dirname(start);
  for (let i = 0; i < 64; i++) {
    // npm-global layout: <p>/lib/node_modules/@earendil-works/pi-coding-agent/package.json
    if (basename(dir) === PI_PKG && basename(dirname(dir)) === PI_SCOPE) {
      const own = join(dir, "package.json");
      if (exists(own)) return own;
    }
    const nested = join(dir, "node_modules", PI_SCOPE, PI_PKG, "package.json");
    if (exists(nested)) return nested;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * The three-step chain: `realpath(argv1)` → pi's package.json → `createRequire(<package.json>)`.
 * Never falls back to `createRequire(argv1)`: a failure is reported, not papered over (§3.3.2 #3).
 */
export function resolveHostModules(deps: HostResolveDeps = {}): HostResolution {
  const realpath = deps.realpath ?? realpathSync;
  const exists = deps.exists ?? existsSync;
  const readText = deps.readText ?? ((path: string) => readFileSync(path, "utf8"));
  const resolveFrom = deps.resolveFromPackageJson ?? ((from: string, req: string) => createRequire(from).resolve(req));

  const argv1 = deps.argv1 ?? process.argv[1];
  if (argv1 === undefined || argv1 === "") return { ok: false, reason: "process.argv[1] is empty" };

  let real: string;
  try {
    real = realpath(argv1);
  } catch (err) {
    return { ok: false, reason: `realpath(${argv1}) failed: ${errorText(err)}` };
  }

  const piPackageJson = findPiPackageJson(real, exists);
  if (piPackageJson === undefined) return { ok: false, reason: `pi package not found above ${real}` };

  const piRoot = dirname(piPackageJson);
  const resolveHost = (spec: string): string | undefined => {
    const entry = HOST_SPECIFIERS.find((candidate) => candidate.spec === spec);
    if (entry === undefined) return undefined;
    // Manifest first: pi's packages export ONLY the `import` condition, so `require.resolve`
    // fails on them (ERR_PACKAGE_PATH_NOT_EXPORTED) even though the package is right there.
    const manifest = findPackageJson(entry.packageName, piRoot, exists);
    if (manifest !== undefined) {
      const relative = packageEntry(manifest, entry.subpath, readText, exists);
      if (relative !== undefined) return join(dirname(manifest), relative);
    }
    // Fallback for exotic layouts (bundled/embedded distributions): ask Node itself.
    try {
      return resolveFrom(
        piPackageJson,
        entry.subpath === "." ? entry.packageName : `${entry.packageName}/${entry.subpath.slice(2)}`,
      );
    } catch {
      return undefined;
    }
  };

  return { ok: true, piPackageJson, resolveHost };
}

/** Walk up from `start` for `<spec>'s package.json` (scope-aware: `@scope/name`). */
function findPackageJson(spec: string, start: string, exists: (path: string) => boolean): string | undefined {
  // Both `typebox` and `@scope/name` are valid here; the latter keeps its scope segment.
  const segments = spec.split("/");
  if (segments.some((segment) => segment === "")) return undefined;
  const inside = segments.join("/");
  let dir = start;
  for (let i = 0; i < 64; i++) {
    // `dir` may itself BE node_modules (pi keeps its deps as siblings of its own folder):
    // check both `dir/node_modules/<spec>` and `dir/<spec>`.
    const candidate = join(dir, "node_modules", inside, "package.json");
    if (exists(candidate)) return candidate;
    const sibling = join(dir, inside, "package.json");
    if (exists(sibling)) return sibling;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * The relative entry file a manifest declares for `subpath`: `exports[subpath].import` (the
 * condition extensions load under), then the object/string forms of that key, then `main`, then
 * `index.js` when it exists. Only shapes pi's own packages use are supported.
 */
function packageEntry(
  manifest: string,
  subpath: string,
  readText: (path: string) => string,
  exists: (path: string) => boolean,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(manifest));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;

  const exportsField = record["exports"];
  if (typeof exportsField === "object" && exportsField !== null) {
    const map = exportsField as Record<string, unknown>;
    const candidate = subpath === "." && !("." in map) ? exportsField : map[subpath];
    const fromExports = conditionEntry(candidate);
    if (fromExports !== undefined) return fromExports;
  }

  const main = record["main"];
  if (typeof main === "string" && main !== "") return main;
  return exists(join(dirname(manifest), "index.js")) ? "index.js" : undefined;
}

function conditionEntry(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const conditions = value as Record<string, unknown>;
  for (const key of ["import", "node", "default"]) {
    const hit = conditions[key];
    if (typeof hit === "string") return hit;
  }
  return undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
