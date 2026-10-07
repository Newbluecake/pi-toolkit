/**
 * hub dynamic-response gzip negotiation (shared by the two JSON exits and the preview text
 * write-out). Lifted verbatim out of `static.ts` (compress-once/negotiate-per-request for the
 * static UI bundle) so the DYNAMIC exits — `http.ts`'s `sendJson` (every `/api/*` JSON body,
 * incl. the instances injected into the spawn/preview/file-search/agent-remove/upload route
 * modules) and `run-routes.ts`'s own `sendJson` copy (`/api/run/*`) — negotiate off the exact
 * same `Accept-Encoding` parser; `static.ts` re-exports `acceptsGzip` from here so existing
 * import paths keep working.
 *
 * Contract (mirrors the static layer's ruling, extended with a size floor):
 *   - identity responses are byte-identical to the pre-gzip behavior — no extra headers, no
 *     async detour; the sync path stays sync (`res.headersSent` is still true the moment
 *     `sendJsonNegotiated` returns for every non-compressed body, preserving the callers'
 *     existing `headersSent`-guard semantics);
 *   - a response is compressed ONLY when the request offers `gzip` (case-insensitive, `q>0`)
 *     AND the body is ≥ `GZIP_MIN_BYTES` — below that floor the round trip costs more than it
 *     saves;
 *   - compression is ASYNC (`promisify(zlib.gzip)` → libuv thread pool): the hub is a single
 *     event loop whose SSE pushes must not stall behind a few hundred KB of `gzipSync`;
 *   - `Content-Length` is always the length of the bytes actually written, and the compressed
 *     response carries `Content-Encoding: gzip` + `Vary: Accept-Encoding`;
 *   - failure degrades to identity: a zlib error, or a "compressed" buffer that did not
 *     actually shrink, sends the original bytes instead — never a 500.
 *
 * Deliberately NOT covered here (same exclusions as the plan): SSE streams (`res.write` flush
 * semantics), the static bundle (`static.ts` keeps its own pre-compressed cache), and preview
 * images (already-compressed formats — the text flow in `preview/stream.ts` applies this module
 * post-verify, the image flow never does).
 *
 * No module-scope mutable state: the only cross-call marker is a per-response decoration
 * (`__pwhGzipPending`) on the `ServerResponse` itself, same pattern as the LAN transport's
 * `__lanLease` socket decoration — a second `sendJson` arriving while a gzip write is still in
 * flight no-ops, exactly like the old synchronous `headersSent` guard did.
 */
import type { ServerResponse } from "node:http";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";

/** 2 KiB floor: bodies below this are never worth a (thread-pool) compression round trip. */
export const GZIP_MIN_BYTES = 2048;

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

/** Async gzip (libuv thread pool) — the hub's event loop stays free for SSE pushes. */
export const gzipAsync: (buf: Buffer) => Promise<Buffer> = promisify(gzipCallback);

/** The request's `Accept-Encoding` off a real `ServerResponse` (duck-typed: fake `res` objects
 * in unit tests simply yield `undefined` ⇒ identity, byte-identical). */
export function acceptEncodingOf(res: ServerResponse): string | undefined {
  const raw = (res as { req?: { headers?: Record<string, unknown> } }).req?.headers?.["accept-encoding"];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return undefined;
}

/** See `sendJsonNegotiated` — the response decoration marking an in-flight gzip write. */
type PendingGzipRes = ServerResponse & { __pwhGzipPending?: boolean };

/**
 * The unified gzip-aware JSON sender. Signature-compatible drop-in for the pre-gzip
 * `sendJson`/`run-routes.ts sendJson` copies (`void` return — callers never awaited them, and
 * must not have to now). Identity responses are written synchronously; only an eligible
 * (gzip-accepted, ≥2 KiB) body detours through the thread pool before its single
 * `writeHead`+`end`.
 */
export function sendJsonNegotiated(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent || res.destroyed) return;
  const marked = res as PendingGzipRes;
  if (marked.__pwhGzipPending === true) return; // a gzip send is already in flight — first sender wins
  const text = JSON.stringify(body);
  const bytes = Buffer.from(text, "utf8");
  const writeIdentity = (): void => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(bytes.length),
    });
    res.end(text);
  };
  if (bytes.length < GZIP_MIN_BYTES || !acceptsGzip(acceptEncodingOf(res))) {
    writeIdentity();
    return;
  }
  marked.__pwhGzipPending = true;
  gzipAsync(bytes).then(
    (gz) => {
      marked.__pwhGzipPending = false;
      if (res.destroyed) return;
      if (res.headersSent || gz.length >= bytes.length) {
        writeIdentity(); // did not actually shrink (or someone else won the response) ⇒ identity
        return;
      }
      res.writeHead(status, {
        ...headers,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Encoding": "gzip",
        "Content-Length": String(gz.length),
        Vary: "Accept-Encoding",
      });
      res.end(gz);
    },
    () => {
      marked.__pwhGzipPending = false;
      writeIdentity(); // zlib failure degrades to identity bytes, never a 500
    },
  );
}
