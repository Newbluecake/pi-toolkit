/**
 * web-hub HTML preview — extension → `Content-Type` (plan v2 §3.1, P1a). Pure. The ONLY thing
 * that picks a `/pv` response type (the server never sniffs: `nosniff` + a fixed table), so an
 * unknown extension is `application/octet-stream` — inert, since the sandbox has no
 * `allow-downloads`.
 */

const UTF8 = "; charset=utf-8";

const TABLE: Readonly<Record<string, string>> = {
  html: `text/html${UTF8}`,
  htm: `text/html${UTF8}`,
  css: `text/css${UTF8}`,
  js: `text/javascript${UTF8}`,
  mjs: `text/javascript${UTF8}`,
  cjs: `text/javascript${UTF8}`,
  json: "application/json",
  map: "application/json",
  webmanifest: "application/manifest+json",
  wasm: "application/wasm",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: `text/plain${UTF8}`,
  csv: `text/plain${UTF8}`,
  tsv: `text/plain${UTF8}`,
  md: `text/plain${UTF8}`,
  log: `text/plain${UTF8}`,
  xml: "application/xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
};

export const PV_DEFAULT_MIME = "application/octet-stream";

/** Lower-cased extension of the final path segment (`""` when none / a bare dotfile). */
export function pvExtOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** `/pv` Content-Type for a (decoded) relative path or file name. Never throws. */
export function pvContentType(rel: string): string {
  if (typeof rel !== "string") return PV_DEFAULT_MIME;
  const ext = pvExtOf(rel);
  return Object.hasOwn(TABLE, ext) ? (TABLE[ext] as string) : PV_DEFAULT_MIME;
}
