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
 * URL mapping (tightened from the legacy server — the old `/assets/<p>` → `<root>/<p>` dual-path
 * fallback and "any top-level `.js`" allowance are both gone): `/` and `/index.html` → the cached,
 * `authMode`-substituted index; any other path must be `isAllowedUiPath` *and* present in the
 * current manifest to be served — everything else is a 404 (never a filesystem fallback, since
 * there is no filesystem access left in the hot path at all).
 */
import type { ServerResponse } from "node:http";
import { dirname, extname } from "node:path";
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
};

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
    opts: { readonly authMode: "token" | "password"; readonly acceptLanguage?: string },
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
  /** Invalidated whenever the verified root's `info` (version/commit/builtAt/file set) changes —
   * cheaper and more precise than trusting `realDir` alone to differ across a redeploy of the
   * same candidate (see the module doc comment). */
  let indexCache: { info: VerifiedUiRoot["info"]; token: Buffer; password: Buffer } | undefined;

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

  function indexVariantsOf(root: VerifiedUiRoot): { token: Buffer; password: Buffer } {
    if (indexCache !== undefined && indexCache.info === root.info) return indexCache;
    const bytes = root.files.get("index.html")?.bytes ?? Buffer.alloc(0);
    const built = {
      info: root.info,
      token: substituteAuthMode(bytes, "token"),
      password: substituteAuthMode(bytes, "password"),
    };
    indexCache = built;
    return built;
  }

  function writeBuffer(res: ServerResponse, data: Buffer, contentType: string, cacheControl: string): void {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(200, { "Content-Type": contentType, "Content-Length": data.length, "Cache-Control": cacheControl });
    res.end(data);
  }

  async function serve(
    urlPath: string,
    res: ServerResponse,
    o: { readonly authMode: "token" | "password"; readonly acceptLanguage?: string },
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
      const variants = indexVariantsOf(result.root);
      writeBuffer(
        res,
        o.authMode === "token" ? variants.token : variants.password,
        CONTENT_TYPES[".html"]!,
        "no-cache",
      );
      return true;
    }
    if (!isAllowedUiPath(rel)) return false;
    const file = result.root.files.get(rel);
    if (file === undefined) return false;
    const contentType = CONTENT_TYPES[extname(rel).toLowerCase()];
    if (contentType === undefined) return false; // defensive; isAllowedUiPath already restricts extensions
    writeBuffer(
      res,
      file.bytes,
      contentType,
      isImmutableAsset(rel) ? "public, max-age=31536000, immutable" : "no-cache",
    );
    return true;
  }

  async function refresh(): Promise<UiStatus> {
    const result = await svc.resolve();
    logStatus(result.status);
    return result.status;
  }

  return { serve, refresh, status: () => svc.status() ?? UNBUILT_STATUS };
}
