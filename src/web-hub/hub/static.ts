/**
 * hub Vue UI serving (vue-plan.md v2.1 §2.1/§2.4, §5.2 — P5b's atomic switch). Replaces the
 * legacy `src/web-hub/web/` zero-build static server (`serveStatic`/`serveIndex`/`webRoot`,
 * plan §包 C) with `createUiServer`, which composes P5a's already-merged, not-yet-wired
 * primitives:
 *   - `ui-root.ts`'s `createUiRootService` (single-flight resolve + request-triggered redeploy
 *     probe over `buildUiCandidates`'s two fixed-order candidates — package-bundled
 *     `dist/web-hub-ui/` first, then the external, version-pinned
 *     `~/.pi/agent/web-hub-ui/<hubVersion>/`);
 *   - `unbuilt.ts`'s `renderUnbuiltPage` (the HTTP-200 placeholder page served whenever neither
 *     candidate verifies).
 *
 * TOCTOU (§2.1): `verifyUiRoot` already read + sha256'd every manifest file into memory before
 * this module ever sees a `VerifiedUiRoot` — `serve()` below does zero disk I/O, it only ever
 * indexes `root.files` (a `ReadonlyMap<path, VerifiedUiFile>`) and (for `index.html`) substitutes
 * the `data-auth-mode` placeholder on the already-verified bytes, cached per `authMode` and
 * invalidated whenever the underlying root changes (a "换代" redeploy, keyed off the verified
 * root's `realDir` — `resolveUiRoot`'s own fingerprint-based redeploy detection already ensures a
 * changed `build-info.json` produces a fresh `VerifiedUiRoot` object with a would-be-different
 * `files` map, but `realDir` alone is not guaranteed to differ across a redeploy of the *same*
 * candidate — see `INDEX_CACHE_GENERATION` below for how this module tells two same-`realDir`
 * roots apart without touching P5a's frozen `ui-root.ts`).
 *
 * gzip (compress-once-at-assembly, negotiate-per-request): the verified bytes above are the only
 * input — `gzipSync` pre-compresses every text-ish file (`.html/.js/.css/.svg/.webmanifest`;
 * `.png` is already-compressed and skipped) into the same per-root variants cache, eagerly at
 * `refresh()` (hub startup awaits it before serving) and lazily on the first `serve()` that sees
 * a not-yet-cached root. A request whose `Accept-Encoding` offers `gzip` (case-insensitive,
 * `q>0`) on a compressible type gets the cached gzip bytes + `Content-Encoding: gzip` + `Vary:
 * Accept-Encoding`; every other response (no header, no `gzip` token, `q=0`, or an incompressible
 * type) is byte-identical to the pre-gzip behavior. Scope: static UI resources only — SSE and
 * every `/api` endpoint (incl. `/api/preview`) never pass through `serve()` at all.
 *
 * URL mapping (tightened from the legacy server — the old `/assets/<p>` → `<root>/<p>` dual-path
 * fallback and "any top-level `.js`" allowance are both gone): `/` and `/index.html` → the cached,
 * `authMode`-substituted index; any other path must be `isAllowedUiPath` *and* present in the
 * current manifest to be served — everything else is a 404 (never a filesystem fallback, since
 * there is no filesystem access left in the hot path at all).
 */
import type { ServerResponse } from "node:http";
import { dirname, extname } from "node:path";
import { gzipSync } from "node:zlib";
import { PROTO } from "../protocol/version.js";
import { isAllowedUiPath } from "../protocol/ui-manifest.js";
import { detectUiLang, renderUnbuiltPage } from "./unbuilt.js";
import {
  createUiRootService,
  type UiCandidatePlan,
  type UiRootFsDeps,
  type UiStatus,
  type VerifiedUiRoot,
} from "./ui-root.js";
import type { HubLog } from "./ports.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

/** Extensions eligible for gzip negotiation — every CONTENT_TYPES entry except `.png`, the one
 * already-compressed format in the table. In lockstep with CONTENT_TYPES / `isAllowedUiPath`
 * (there is no `.json`/`.ico` in the whitelist, so none to consider here). */
const GZIP_EXTENSIONS: ReadonlySet<string> = new Set([".html", ".js", ".css", ".svg", ".webmanifest"]);

/** Parses an `Accept-Encoding` header: is `gzip` offered with a non-zero quality value? */
export function acceptsGzip(acceptEncoding: string | undefined): boolean {
  if (acceptEncoding === undefined) return false;
  for (const part of acceptEncoding.split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (name === undefined || name.trim().toLowerCase() !== "gzip") continue;
    const qParam = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith("q="));
    if (qParam === undefined) return true;
    const q = Number.parseFloat(qParam.slice(2));
    return Number.isFinite(q) && q > 0;
  }
  return false;
}

const AUTH_MODE_PLACEHOLDER = 'data-auth-mode="__AUTH_MODE__"';

/** `assets/index-<hash>.js` style names — the only paths that get the year-long immutable cache. */
const IMMUTABLE_ASSET_RE = /^assets\/.*-[A-Za-z0-9_-]{8,}\.(?:js|css|svg)$/;

/**
 * Decode + minimally validate a URL path into a manifest-relative lookup key. Unlike the legacy
 * `safeRelativePath`, this never touches a filesystem — an over-permissive decode only risks a
 * lookup miss (404) against `root.files`, never a path traversal, since nothing here ever joins
 * the result onto a directory. The traversal/NUL/backslash rejections are kept anyway (defense
 * in depth, and so a `%2e%2e` probe 404s for the same reason a human reading the code expects).
 */
export function uiRelPath(urlPath: string): string | undefined {
  const raw = urlPath.split("?")[0]!.split("#")[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (!decoded.startsWith("/")) return undefined;
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.includes("..")) return undefined;
  return decoded === "/" ? "index.html" : decoded.slice(1);
}

export interface UiServer {
  /** Serves one request; resolves `false` when nothing matched (caller answers 404). */
  serve(
    urlPath: string,
    res: ServerResponse,
    opts: {
      readonly authMode: "token" | "password";
      readonly acceptLanguage?: string;
      readonly acceptEncoding?: string;
    },
  ): Promise<boolean>;
  /** Forces a full re-resolve (e.g. hub startup, §2.1: "await ui.refresh()"). */
  refresh(): Promise<UiStatus>;
  /** Last known status, or the `unbuilt`/empty-candidates shape before the first resolve. */
  status(): UiStatus;
}

export interface CreateUiServerOptions {
  readonly candidates: readonly UiCandidatePlan[];
  readonly hubVersion: string;
  readonly log: HubLog;
  readonly deps?: Partial<UiRootFsDeps>;
  readonly probeThrottleMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  /** vue-plan.md v2.1 §2.1（P5b）：每当解析结果相比上一次实际发生变化时回调一次（初始
   * refresh 也会触发一次）——`hub.ts` 接到后 `hubJson.patchUi(status)`，与 `LanFrontendDeps.onStatus`
   * 对 `LanStatus` 的做法完全对称。 */
  readonly onStatus?: (status: UiStatus) => void;
}

const UNBUILT_STATUS: UiStatus = { state: "unbuilt", candidates: [] };

function statusSignature(s: UiStatus): string {
  return s.state === "ok"
    ? `ok:${s.source}:${s.version}:${s.commit}:${s.builtAt}`
    : `unbuilt:${s.candidates.map((c) => `${c.kind}=${c.reason ?? "?"}:${c.detail ?? ""}`).join(",")}`;
}

function isImmutableAsset(rel: string): boolean {
  return IMMUTABLE_ASSET_RE.test(rel);
}

/**
 * `packageUiDistDir()` (the "package" candidate's `dir`) is `<packageRoot>/dist/web-hub-ui/` —
 * two levels up is the package root a `cd && npm run build:web` actually targets (§2.1's
 * install method 2). Derived from the already-known candidate `dir` here instead of importing
 * `protocol/paths.ts`'s `packageUiDistDir` directly, since this module only ever sees candidate
 * dirs that already flowed through `buildUiCandidates`.
 */
function packageRootFromCandidateDir(dir: string): string {
  return dirname(dirname(dir));
}

export function createUiServer(opts: CreateUiServerOptions): UiServer {
  const svc = createUiRootService(opts.candidates, { version: opts.hubVersion, protoMajor: PROTO.major }, opts.deps, {
    ...(opts.probeThrottleMs === undefined ? {} : { probeThrottleMs: opts.probeThrottleMs }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });

  let lastLoggedSignature: string | undefined;

  /** Per-root serving variants, keyed by the verified root's `info` object identity and rebuilt
   * only when a redeploy produces a fresh `info` (same generation logic the pre-gzip `indexCache`
   * used — see the module doc comment). Holds the authMode-substituted index bytes (identity +
   * gzip for both auth modes) and the pre-compressed gzip bytes of every other compressible
   * manifest file; compression happens exactly once per generation, never per request. */
  interface UiRootVariants {
    readonly info: VerifiedUiRoot["info"];
    readonly indexToken: Buffer;
    readonly indexPassword: Buffer;
    readonly gzipIndexToken: Buffer;
    readonly gzipIndexPassword: Buffer;
    readonly gzipFiles: ReadonlyMap<string, Buffer>;
  }
  let variants: UiRootVariants | undefined;

  function logStatus(status: UiStatus): void {
    const sig = statusSignature(status);
    if (sig === lastLoggedSignature) return;
    lastLoggedSignature = sig;
    if (status.state === "ok") {
      opts.log.info("web-hub: ui root", { source: status.source, version: status.version, commit: status.commit });
    }
    for (const c of status.candidates) {
      if (c.reason !== undefined) {
        opts.log.warn("web-hub: ui root rejected", { kind: c.kind, dir: c.dir, reason: c.reason, detail: c.detail });
      }
    }
    opts.onStatus?.(status);
  }

  function substituteAuthMode(bytes: Buffer, authMode: "token" | "password"): Buffer {
    const text = bytes.toString("utf8");
    const body = text.includes(AUTH_MODE_PLACEHOLDER)
      ? text.replace(AUTH_MODE_PLACEHOLDER, `data-auth-mode="${authMode}"`)
      : text;
    return Buffer.from(body, "utf8");
  }

  function variantsOf(root: VerifiedUiRoot): UiRootVariants {
    if (variants !== undefined && variants.info === root.info) return variants;
    const bytes = root.files.get("index.html")?.bytes ?? Buffer.alloc(0);
    const indexToken = substituteAuthMode(bytes, "token");
    const indexPassword = substituteAuthMode(bytes, "password");
    const gzipFiles = new Map<string, Buffer>();
    for (const [rel, file] of root.files) {
      if (rel === "index.html") continue; // served as the substituted variants below, never raw
      if (!GZIP_EXTENSIONS.has(extname(rel).toLowerCase())) continue; // .png etc. stay identity-only
      gzipFiles.set(rel, gzipSync(file.bytes));
    }
    const built: UiRootVariants = {
      info: root.info,
      indexToken,
      indexPassword,
      gzipIndexToken: gzipSync(indexToken),
      gzipIndexPassword: gzipSync(indexPassword),
      gzipFiles,
    };
    variants = built;
    return built;
  }

  function writeBuffer(
    res: ServerResponse,
    data: Buffer,
    contentType: string,
    cacheControl: string,
    extra?: Readonly<{ "Content-Encoding"?: string; Vary?: string }>,
  ): void {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": data.length,
      "Cache-Control": cacheControl,
      ...(extra ?? {}),
    });
    res.end(data);
  }

  async function serve(
    urlPath: string,
    res: ServerResponse,
    o: { readonly authMode: "token" | "password"; readonly acceptLanguage?: string; readonly acceptEncoding?: string },
  ): Promise<boolean> {
    const result = await svc.maybeRefresh(urlPath);
    logStatus(result.status);
    const rel = uiRelPath(urlPath);

    if (result.root === undefined) {
      if (rel !== "index.html") return false; // unbuilt: only `/`/`/index.html` get the placeholder; nothing else is served
      const pkgCandidate = result.status.candidates.find((c) => c.kind === "package");
      const html = renderUnbuiltPage({
        lang: detectUiLang(o.acceptLanguage),
        version: opts.hubVersion,
        mode: o.authMode,
        ...(o.authMode === "token"
          ? {
              rejected: result.status.candidates,
              ...(pkgCandidate !== undefined ? { pkgDir: packageRootFromCandidateDir(pkgCandidate.dir) } : {}),
            }
          : {}),
      });
      if (res.headersSent || res.destroyed) return true;
      const data = Buffer.from(html, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": data.length,
        "Cache-Control": "no-store",
        "X-PWH-UI": "unbuilt",
      });
      res.end(data);
      return true;
    }

    if (rel === undefined) return false;
    if (rel === "index.html") {
      const v = variantsOf(result.root);
      const gzipped = acceptsGzip(o.acceptEncoding);
      writeBuffer(
        res,
        gzipped
          ? o.authMode === "token"
            ? v.gzipIndexToken
            : v.gzipIndexPassword
          : o.authMode === "token"
            ? v.indexToken
            : v.indexPassword,
        CONTENT_TYPES[".html"]!,
        "no-cache",
        gzipped ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : undefined,
      );
      return true;
    }
    if (!isAllowedUiPath(rel)) return false;
    const file = result.root.files.get(rel);
    if (file === undefined) return false;
    const contentType = CONTENT_TYPES[extname(rel).toLowerCase()];
    if (contentType === undefined) return false; // defensive; isAllowedUiPath already restricts extensions
    const gzipBytes = acceptsGzip(o.acceptEncoding) ? variantsOf(result.root).gzipFiles.get(rel) : undefined;
    const cacheControl = isImmutableAsset(rel) ? "public, max-age=31536000, immutable" : "no-cache";
    if (gzipBytes !== undefined) {
      writeBuffer(res, gzipBytes, contentType, cacheControl, { "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
    } else {
      writeBuffer(res, file.bytes, contentType, cacheControl);
    }
    return true;
  }

  async function refresh(): Promise<UiStatus> {
    const result = await svc.resolve();
    logStatus(result.status);
    if (result.root !== undefined) variantsOf(result.root); // compress-once at startup (hub.ts awaits refresh() before serving)
    return result.status;
  }

  return { serve, refresh, status: () => svc.status() ?? UNBUILT_STATUS };
}
