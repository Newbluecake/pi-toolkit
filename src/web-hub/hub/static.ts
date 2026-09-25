/**
 * hub static file serving (plan §包 C). Serves the frontend produced by
 * package E from `src/web-hub/web/` (no build step).
 *
 * URL mapping: `/` → `index.html`; `/assets/<p>` → `<root>/<p>` (falling back
 * to `<root>/assets/<p>`); any other `/<p>` → `<root>/<p>` so relative ES
 * module imports resolve. Guards, in order: percent-decode (malformed ⇒ 404),
 * reject `..` / NUL / backslash / dot-segments, extension whitelist
 * (`.html .js .css .svg .ico`), lexical containment in `root`, then realpath
 * containment (symlink escape) and regular-file check. Returns `false` when
 * nothing was served so the caller answers 404.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const MAX_STATIC_BYTES = 8 * 1024 * 1024;

export function webRoot(): string {
  return fileURLToPath(new URL("../web/", import.meta.url));
}

function within(root: string, target: string): boolean {
  const base = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(base);
}

/** Decode + validate a URL path into a root-relative path, or undefined if unsafe. */
export function safeRelativePath(urlPath: string): string | undefined {
  const raw = urlPath.split("?")[0]!.split("#")[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (!decoded.startsWith("/")) return undefined;
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.includes("..")) return undefined;
  const rel = decoded === "/" ? "index.html" : decoded.slice(1);
  const segments = rel.split("/");
  if (segments.some((s) => s.length === 0 || s.startsWith("."))) return undefined;
  if (!(extname(rel).toLowerCase() in CONTENT_TYPES)) return undefined;
  return rel;
}

async function tryServe(root: string, rel: string, res: ServerResponse): Promise<boolean> {
  const absRoot = resolve(root);
  const target = resolve(absRoot, rel);
  if (!within(absRoot, target)) return false;
  let data: Buffer;
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(absRoot), realpath(target)]);
    if (!within(realRoot, realTarget)) return false;
    const st = await stat(realTarget);
    if (!st.isFile() || st.size > MAX_STATIC_BYTES) return false;
    data = await readFile(realTarget);
  } catch {
    return false;
  }
  if (res.headersSent || res.destroyed) return true;
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(rel).toLowerCase()]!,
    "Content-Length": data.length,
    "Cache-Control": "no-cache",
  });
  res.end(data);
  return true;
}

export async function serveStatic(root: string, urlPath: string, res: ServerResponse): Promise<boolean> {
  const rel = safeRelativePath(urlPath);
  if (rel === undefined) return false;
  if (rel.startsWith("assets/")) {
    const stripped = rel.slice("assets/".length);
    if (stripped.length > 0 && (await tryServe(root, stripped, res))) return true;
  }
  return tryServe(root, rel, res);
}
