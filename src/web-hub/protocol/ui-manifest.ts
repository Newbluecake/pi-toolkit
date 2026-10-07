/**
 * web-hub Vue UI build manifest (vue-plan.md v2.1 §1.2, §5.2 — P0 frozen interface).
 *
 * `build-info.json` is the single artifact hub-side UI root resolution (P5a's
 * `verifyUiRoot`, plan §2.1) trusts to decide whether a candidate root
 * (package-bundled `dist/web-hub-ui/` or the external
 * `~/.pi/agent/web-hub-ui/<version>/`) is safe and version-compatible to
 * serve. This module is pure (no `node:fs`, no pi imports) so both the Vite
 * build plugin (`build-info-plugin.ts`) and the hub (`src/web-hub/hub/ui-root.ts`,
 * P5a) and `scripts/web-hub/check-ui-dist.ts` (P0) import the identical
 * validation/parsing logic — never re-implement it.
 */

/** The manifest written by `build-info-plugin.ts`'s `closeBundle` into `dist/web-hub-ui/build-info.json`. */
export interface UiBuildInfo {
  /** Manifest schema version. Only `1` is understood by this build. */
  v: 1;
  /** `package.json`'s `version` at build time (= hub's `config.pluginVersion`). */
  version: string;
  /** Wire protocol major (`PROTO.major` from `protocol/version.ts`) baked in at build time. */
  proto: { major: number };
  /** ISO 8601 build timestamp; reproducible when `SOURCE_DATE_EPOCH` is set. */
  builtAt: string;
  /** `git rev-parse HEAD` (short, 12 hex chars), `-dirty` suffix if the tree was dirty; `"unknown"` outside git / on timeout. */
  commit: string;
  /** Every shipped file except `build-info.json` itself, sorted by `path`. */
  files: UiManifestFile[];
}

export interface UiManifestFile {
  /** Root-relative, forward-slash path (e.g. `"index.html"`, `"assets/index-abcd1234.js"`). */
  path: string;
  /** Exact byte length. */
  bytes: number;
  /** Lower-case hex SHA-256 of the file's bytes (64 chars). */
  sha256: string;
}

/** Hard cap on manifest entries — a legitimate build never comes close; guards against a corrupted/oversized manifest. */
export const UI_MAX_FILES = 64;

/** Hard cap on the sum of `files[].bytes` — plan §2.1's "产物清单字节预算" (real builds are expected to land near 0.5 MiB). */
export const UI_MAX_TOTAL_BYTES = 4 * 1024 * 1024;

const COMMIT_UNKNOWN = "unknown";
const COMMIT_RE = /^[0-9a-f]{12}(-dirty)?$|^unknown$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** Toplevel files that ship without going through `assets/` (theme bootstrap, favicon, the SPA
 * shell, and the 2026-10-07 Android-PWA set: install manifest + PNG icons). */
const TOP_LEVEL_ALLOW = new Set([
  "index.html",
  "theme-init.js",
  "favicon.svg",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
]);
/** `assets/<name>.<ext>` — Vite's hashed output naming (`index-<hash>.js` etc.). */
const ASSET_RE = /^assets\/[A-Za-z0-9._-]+\.(js|css|svg)$/;

/**
 * Root-relative path whitelist shared by the build-time manifest writer, the
 * runtime hub server, and `check-ui-dist.ts`. Anything not matching this is
 * never served and never counted as a valid manifest entry.
 */
export function isAllowedUiPath(p: string): boolean {
  if (TOP_LEVEL_ALLOW.has(p)) return true;
  return ASSET_RE.test(p);
}

function isNonNegativeInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/**
 * Validate + parse an arbitrary JSON value into a `UiBuildInfo`. Never throws.
 * Checks (in order, first failure wins): shape / `v===1` / `version` non-empty
 * string / `proto.major` non-negative integer / `builtAt` non-empty string /
 * `commit` matches `COMMIT_RE` / `files` is an array within `UI_MAX_FILES` and
 * `UI_MAX_TOTAL_BYTES`, contains `index.html`, has no duplicate paths, and
 * every entry has an `isAllowedUiPath` path, a non-negative integer `bytes`,
 * and a well-formed lower-case-hex 64-char `sha256`.
 */
export function parseUiBuildInfo(json: unknown): { ok: true; info: UiBuildInfo } | { ok: false; error: string } {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, error: "not-an-object" };
  }
  const obj = json as Record<string, unknown>;
  if (obj["v"] !== 1) return { ok: false, error: "bad-version-field" };
  if (typeof obj["version"] !== "string" || obj["version"] === "") return { ok: false, error: "bad-version" };
  const proto = obj["proto"];
  if (
    typeof proto !== "object" ||
    proto === null ||
    Array.isArray(proto) ||
    !isNonNegativeInteger((proto as Record<string, unknown>)["major"])
  ) {
    return { ok: false, error: "bad-proto" };
  }
  if (typeof obj["builtAt"] !== "string" || obj["builtAt"] === "") return { ok: false, error: "bad-builtAt" };
  if (typeof obj["commit"] !== "string" || !COMMIT_RE.test(obj["commit"])) return { ok: false, error: "bad-commit" };
  const files = obj["files"];
  if (!Array.isArray(files)) return { ok: false, error: "bad-files" };
  if (files.length > UI_MAX_FILES) return { ok: false, error: "too-many-files" };

  const seen = new Set<string>();
  let totalBytes = 0;
  let hasIndex = false;
  const parsedFiles: UiManifestFile[] = [];
  for (const entry of files) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: "bad-file-entry" };
    }
    const f = entry as Record<string, unknown>;
    const path = f["path"];
    const bytes = f["bytes"];
    const sha256 = f["sha256"];
    if (typeof path !== "string" || !isAllowedUiPath(path)) return { ok: false, error: "bad-file-path" };
    if (seen.has(path)) return { ok: false, error: "duplicate-file-path" };
    seen.add(path);
    if (!isNonNegativeInteger(bytes)) return { ok: false, error: "bad-file-bytes" };
    if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) return { ok: false, error: "bad-file-sha256" };
    totalBytes += bytes;
    if (totalBytes > UI_MAX_TOTAL_BYTES) return { ok: false, error: "too-large" };
    if (path === "index.html") hasIndex = true;
    parsedFiles.push({ path, bytes, sha256 });
  }
  if (!hasIndex) return { ok: false, error: "missing-index" };

  return {
    ok: true,
    info: {
      v: 1,
      version: obj["version"],
      proto: { major: (proto as Record<string, unknown>)["major"] as number },
      builtAt: obj["builtAt"],
      commit: obj["commit"],
      files: parsedFiles,
    },
  };
}

/** `commit` value used when `git` is unavailable, the tree isn't a git checkout, or resolution timed out. */
export const UNKNOWN_COMMIT = COMMIT_UNKNOWN;
