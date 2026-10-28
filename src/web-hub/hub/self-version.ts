/**
 * A (hub self-version): the hub reads its OWN `package.json` instead of trusting the version the
 * launcher (`agent/index.ts`'s `buildHubConfig`) put into `PI_WEBHUB_CONFIG`.
 *
 * Why: `getBuildInfo()` caches the launcher's build info once per *activation*, so a pi session
 * that activated before a release keeps reporting the old version. The hub it spawns (or restarts
 * into) meanwhile runs whatever is on disk — jiti loads `src/web-hub/hub/main.ts` from the package
 * the launcher resolved. That mismatch is what made `ui-root.ts` reject the freshly built UI root
 * (`info.version !== expect.version` ⇒ `version-mismatch`) after every release.
 *
 * The hub's own package root is `packageRootDir()` (same derivation as `packageUiDistDir`, from
 * THIS module's `import.meta.url`), i.e. exactly the package the running code was loaded from, so
 * the value describes the code actually executing.
 *
 * Precedence: the package version wins whenever it reads and is semver-shaped; the launcher's
 * values are used verbatim only as a fallback (missing/unreadable/malformed package.json, or a
 * non-semver `version`). Never throws, never logs — the caller (`main.ts`) owns the log line.
 *
 * `buildId` (`<version>@<commit>[dirty]`): the commit half belongs to the LAUNCHER's checkout, so
 * it may describe a different tree than the code this hub loaded. Reusing it under a different
 * version would print e.g. `0.10.2@<0.10.1 commit>`, i.e. a build id that never existed. When the
 * two disagree we therefore emit `${version}@unknown` — "unknown" is the pre-existing, honest
 * commit placeholder (`defaultBuildInfo`'s own fallback, and `protocol/version-info.ts`'s
 * `normalizeCommit` maps it to `null` ⇒ the version panel shows "无法验证" instead of inventing a
 * match). `HubInfo.bootHead` (web-hub-version plan §3.5, captured after start through
 * `src/git/run.ts`) is the separate, validated commit source; keeping it out of `buildId` keeps
 * startup free of a git subprocess and leaves `hub.json` byte-identical while versions agree.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { packageRootDir } from "../protocol/paths.js";

/**
 * Same predicate as `ui-root.ts`'s `isSafeHubVersion` (semver-shaped, no `..`) — the version becomes
 * a directory name for the external UI root, so only a path-safe string may become the hub's
 * identity. Duplicated rather than imported on purpose: `ui-root.test.ts` pins the exact set of
 * modules that import `ui-root.ts`, and a one-line regex is not worth widening that pin.
 * `self-version.test.ts` pins parity between the two.
 */
const SAFE_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/;
export function isSafeSelfVersion(version: string): boolean {
  return SAFE_VERSION_RE.test(version) && !version.includes("..");
}

/** Why the package read was not used; absent when the package version won. */
export type SelfVersionFallback = "missing" | "unreadable" | "malformed" | "not-semver";

export interface SelfVersionInput {
  /** `config.pluginVersion` — what the launcher claims. */
  readonly launcherVersion: string;
  /** `config.buildId` — `<launcherVersion>@<commit>[dirty]` from the launcher. */
  readonly launcherBuildId: string;
  /** Package root holding the `package.json` to read. */
  readonly pkgRoot: string;
  /** Sync reader seam (tests); default `readFileSync(path, "utf8")`. */
  readonly readText?: (path: string) => string;
}

export interface SelfVersionResult {
  /** The hub's effective version (`config.pluginVersion` after resolution). */
  readonly version: string;
  /** The hub's effective build id (`config.buildId` after resolution). */
  readonly buildId: string;
  /** `"package"` when the hub read its own `package.json`; `"launcher"` on any fallback. */
  readonly source: "package" | "launcher";
  readonly fallback?: SelfVersionFallback;
}

/** Commit placeholder used when the launcher's build id describes another version. */
export const UNKNOWN_BUILD_COMMIT = "unknown";

/** The version half of `<version>@<commit>` (build ids never contain `@` in either half). */
export function buildIdVersion(buildId: string): string | undefined {
  const at = buildId.indexOf("@");
  return at <= 0 ? undefined : buildId.slice(0, at);
}

/**
 * Resolve the hub's effective version + build id. Pure: the only side effect is the injected
 * (default: synchronous, single small file) read.
 */
export function resolveSelfVersion(input: SelfVersionInput): SelfVersionResult {
  const read = input.readText ?? ((p: string) => readFileSync(p, "utf8"));
  let raw: string;
  try {
    raw = read(join(input.pkgRoot, "package.json"));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return fallback(input, code === "ENOENT" ? "missing" : "unreadable");
  }
  let version: unknown;
  try {
    version = (JSON.parse(raw) as { version?: unknown } | null)?.version;
  } catch {
    return fallback(input, "malformed");
  }
  if (typeof version !== "string" || version === "") return fallback(input, "not-semver");
  // Same predicate `buildUiCandidates` uses for the external UI directory: the version becomes a
  // path segment there, so an unsafe string must never become the hub's identity either.
  if (!isSafeSelfVersion(version)) return fallback(input, "not-semver");
  const buildId =
    buildIdVersion(input.launcherBuildId) === version ? input.launcherBuildId : `${version}@${UNKNOWN_BUILD_COMMIT}`;
  return { version, buildId, source: "package" };
}

function fallback(input: SelfVersionInput, reason: SelfVersionFallback): SelfVersionResult {
  return {
    version: input.launcherVersion,
    buildId: input.launcherBuildId,
    source: "launcher",
    fallback: reason,
  };
}

/** Production entry: resolve against the package this hub process was loaded from. */
export function resolveSelfVersionHere(launcherVersion: string, launcherBuildId: string): SelfVersionResult {
  return resolveSelfVersion({ launcherVersion, launcherBuildId, pkgRoot: packageRootDir() });
}
