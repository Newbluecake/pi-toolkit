// Mirror of src/core/package-root.ts — parity: tests/config/package-root-parity.test.ts.
//
// startup-bundle plan r3 §3.4: once every module lives inside a single bundle, `import.meta.url`
// no longer encodes a file's depth, so `new URL("../..", import.meta.url)` derivations break.
// This resolver anchors on CONTENT instead: walk up from a start path and return the nearest
// ancestor directory holding a `package.json` whose `name` is this package.
//
// Constraints (AGENTS.md):
// - I4: no module-level memo — `/reload` re-activates in the same process.
// - I8: `node:*` only; the protocol side keeps a verbatim mirror
//   (`src/web-hub/protocol/package-root.ts`) because protocol may not value-import `src/core/*`.
// - Every call site is a cold path (activate / first request), so plain synchronous fs is fine.
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `package.json#name` this resolver anchors on (the manifest value — I7 keeps runtime keys, not this). */
const PACKAGE_NAME = "pi-toolkit";

/** Ancestor levels inspected, counting the start directory itself. */
const MAX_DEPTH = 8;

/** Directory a start specifier points at: a directory stays, anything else contributes its dirname. */
function startDir(from: string | URL): string {
  const raw = from instanceof URL ? fileURLToPath(from) : from;
  // A bare string may still be a specifier (`import.meta.url` is a string, not a URL object).
  const path = raw.startsWith("file:") ? fileURLToPath(raw) : raw;
  const abs = resolve(path);
  try {
    if (statSync(abs, { throwIfNoEntry: false })?.isDirectory() === true) return abs;
  } catch {
    /* unreadable start: fall through to the dirname form */
  }
  return dirname(abs);
}

/** True when `dir/package.json` names this package. Missing/unreadable/corrupt manifests are "not it". */
function isPackageRoot(dir: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown };
    return parsed.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * @param from Start point (default: this module's `import.meta.url`); tests inject it.
 * @returns The nearest ancestor directory whose `package.json` has `name === "pi-toolkit"`,
 *          absolute, **without** a trailing separator. A start path inside the package
 *          (`src/…`, `dist/…`, a bundled file) resolves to the same root.
 * @throws  When no anchor is found within {@link MAX_DEPTH} levels (never silently falls back to
 *          `cwd`). Callers keep their own pre-existing degradation: `try`/`catch` ⇒ `""` /
 *          `undefined` / a thrown "candidates tried" error.
 */
export function packageRoot(from: string | URL = import.meta.url): string {
  const tried: string[] = [];
  let dir = startDir(from);
  for (let i = 0; i < MAX_DEPTH; i += 1) {
    tried.push(dir);
    if (isPackageRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `pi-toolkit: 无法定位包根（没有 name === "${PACKAGE_NAME}" 的 package.json）。已尝试: ${tried.join(", ")}`,
  );
}
