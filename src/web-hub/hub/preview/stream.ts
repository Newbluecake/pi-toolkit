/**
 * web-hub content-preview — streamed write-out (web-hub-preview plan v3 §4.5.2, PV2a).
 *
 * `readAndStream` is §3.1 step ⑨: the ONE place bytes leave the hub. Two strictly separate
 * flows, per ruling #4 (D16):
 *
 * - IMAGE: never consults the identity cache and never calls `verifyWhole`. The sha256 is
 *   computed WHILE streaming (the sniff sample counts as the first hashed chunk) and the LAST
 *   chunk is always held back — nothing final leaves the hub until the whole-file digest and
 *   the post-stat identity both match; any mismatch ⇒ `destroy()`, so the client's body ends
 *   short of `Content-Length`. After the head there are exactly two endings: complete, or
 *   destroyed. It is FORBIDDEN to switch to a whole-file-verify path after the head (pinned by
 *   a source-order assertion: `verifyWhole` only appears inside `streamText`, before its
 *   `writeHead`).
 *
 * - TEXT: everything happens BEFORE the head — read up to `textMax`, cut on a UTF-8 character
 *   boundary (`utf8SafeCut`), then cwd-class re-stat identity check or upload-class
 *   `verifyWhole` (identity cache first, single-flight behind it). Only a fully verified
 *   buffer is ever headed and written. A gzip-offering request gets that verified buffer
 *   compressed first (shared `hub/gzip.ts` negotiation, ≥2 KiB floor, async thread-pool gzip
 *   raced against the write-out deadline) — `Content-Length` names the compressed length while
 *   the `X-PWH-Preview-*` metadata headers keep describing the original bytes; a body that
 *   fails to shrink stays identity, byte-for-byte.
 *
 * Lifecycle: the whole write-out is bounded by `streamAt` (absolute deadline captured at
 * entry; every read/stat/drain races it); `signal` aborts classify as `hub-close` (abort
 * reason `"hub-close"`) vs `client-abort`; all timers are unref'd (`racePreviewIo`); and the
 * handle is closed on EVERY exit — `readAndStream` takes ownership of `src.fh` (§3.1 ⑩'s
 * close lives here; the routes only close handles that never reached this function).
 *
 * Byte/pixel caps are NOT enforced here — §3.1 ⑧ rejects oversized content before this
 * function runs; the kernel is deliberately boundary-agnostic (pinned by tests).
 */

import { createHash } from "node:crypto";
import { PREVIEW_HDR, PREVIEW_VERIFY_MS } from "../../protocol/preview.js";
import { acceptsGzip, GZIP_MIN_BYTES, gzipAsync } from "../gzip.js";
import { isPreviewIoError, PreviewIoError, racePreviewIo } from "./fs.js";
import type { PreviewIoTracker } from "./fs.js";
import { previewIdentOf } from "./ident.js";
import type { PreviewHandle } from "./admit.js";
import { utf8SafeCut } from "./sniff.js";
import type { SniffResult } from "./sniff.js";
import { identityOf } from "./verify.js";
import type { Identity, UploadVerifier } from "./verify.js";

export interface PreviewSink {
  readonly headersSent: boolean;
  writeHead(status: number, headers: Record<string, string>): void;
  end(): void;
  destroy(): void;
  write(chunk: Buffer): boolean;
  waitDrain(signal: AbortSignal): Promise<void>;
}

export type StreamFailReason =
  | "client-abort"
  | "hub-close"
  | "stream-deadline"
  | "shrunk"
  | "hash-mismatch"
  | "identity-changed"
  | "verify-timeout"
  | "verify-deadline"
  | "io"
  /** chunked-plan §2.3: a continuation whose `offset ≥ size` (client arithmetic error) —
   * pre-head only, mapped 400 `E_BAD_REQUEST{reason:"offset"}` by the routes. */
  | "range"
  /** chunked-plan §3.2 (r2 #4): the chunked branch's OWN pre-race tracker check tripping —
   * the ONLY source of this reason (`racePreviewIo` never produces it; `classify` has no
   * branch for it), mapped 503 `E_BUSY` + `Retry-After: 1` by the routes. */
  | "busy"
  /** web-hub-html-preview plan v2 §2.3-⑦: `pv.beforeHead()` said the capability is no longer
   *  live — pre-head only (nothing written), mapped 404 by the `/pv` route. */
  | "not-live";

export type StreamOutcome =
  | { ok: true; bytes: number; truncated: boolean; verify?: "hashed" | "cached" | "joined" }
  | { ok: false; reason: StreamFailReason; headersSent: boolean };

/** §3.1 ⑨ read size; the sniff sample (≤64 KiB) is reused as the first streamed chunk. */
const STREAM_CHUNK_BYTES = 64 * 1024;

/**
 * web-hub-html-preview plan v2 §2.5/§2.3-⑦ (P1a): the `/pv` flow's IO seam. Structural so this
 * module never imports `pv-io.ts` — `PvIoGate` satisfies it. Every `fh.stat`/`fh.read` of a pv
 * response runs through `run` (the 2-slot physical quota, slot held until the op really
 * settles) and the final handle close through `close` (bounded, never rejects).
 */
export interface PvStreamIo {
  run<T>(op: () => Promise<T>, o: { deadlineAt: number; signal?: AbortSignal | undefined }): Promise<T>;
  close(op: () => Promise<void>): Promise<void>;
}

interface StreamSrc {
  fh: PreviewHandle;
  /** admitted (upload: index-checked; cwd: post-open fstat) size — also `Content-Length`. */
  size: number;
  sniff: SniffResult;
  /** the sniff-stage sample — the file's first `min(size, 64 KiB)` bytes, already read. */
  sample: Buffer;
  /** present ⇒ upload class: image hashes against `sha256`, text runs `verifyWhole`. */
  verify?: { uploadId: string; sha256: string };
  /** preview-download: present ⇒ the DOWNLOAD flow (raw bytes, `Content-Disposition:
   *  attachment` carrying this basename, `application/octet-stream`, no sniff/kind gate).
   *  The route skips the sample read for these (download starts at offset 0). */
  download?: { filename: string };
  /** chunked-plan §3.2: present ⇒ the CHUNKED text flow (`streamChunkedText`) — the routes
   *  set it ONLY for a `chunk=1` request whose sniff said `text` (a first-chunk image keeps
   *  the image flow; a continuation that re-sniffed non-text is 409'd by the routes before
   *  this layer). `offset` is the request's validated byte offset (0 for the first chunk),
   *  `ident` the echo to prove the file is the one the client started from (absent on the
   *  first chunk), `ceiling` the hub hard cap (the read length never crosses it). */
  chunk?: { offset: number; ident?: string; ceiling: number };
  /** web-hub-html-preview plan v2 §2.3-⑦: present ⇒ the PV flow — raw bytes under the
   *  caller-built `headers` (the response header table of §3.1; `Content-Length` is forced to
   *  `size`), `beforeHead()` evaluated synchronously right before `writeHead` (false ⇒
   *  `not-live`, pre-head), every fs op through `io`. No sniff/kind gate; `sample` is ignored
   *  and `verify` must be absent. */
  pv?: { headers: Record<string, string>; beforeHead(): boolean; io: PvStreamIo };
}

interface StreamOpts {
  signal: AbortSignal;
  /** §3.1 ⑨ write-out budget (ms), loopback 15s / LAN 30s. */
  streamAt: number;
  textMax: number;
  now(): number;
  verifier: UploadVerifier;
  /** The request's `Accept-Encoding` (routes.ts threads it in). Present-and-gzip (q>0) lets the
   * TEXT flow compress its fully-verified buffer through the shared negotiation (≥2 KiB floor,
   * async thread-pool gzip raced against the write-out deadline); images never compress — they
   * are already-compressed formats and their flow streams instead of buffering. */
  acceptEncoding?: string;
  /** chunked-plan §3.2: the routes instance's zombie-IO tracker — passed ONLY in chunked
   *  mode. Present ⇒ every race in the chunked branch counts an abandoned underlying as a
   *  zombie (5th `racePreviewIo` arg) AND is preceded by the fast-fail pre-check
   *  (`zombies >= max` ⇒ `fail("busy")`). Undefined ⇒ today's untracked semantics, so a
   *  non-chunked request's path is byte-identical to before. */
  tracker?: PreviewIoTracker;
}

interface FlowState {
  headSent: boolean;
}

interface FlowCtx {
  readonly src: StreamSrc;
  readonly sink: PreviewSink;
  readonly opts: StreamOpts;
  readonly deadlineAt: number;
  readonly state: FlowState;
  fail(reason: StreamFailReason): StreamOutcome;
  classify(err: unknown): StreamFailReason;
  race<T>(p: Promise<T>): Promise<T>;
  /** an fs op started lazily: plain flows = `race(lazy())` (byte-identical to before); the pv
   *  flow routes it through the PV IO gate. */
  step<T>(lazy: () => Promise<T>): Promise<T>;
  writeChunk(chunk: Buffer): Promise<void>;
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.ctimeMs === b.ctimeMs;
}

function baseHeaders(
  kind: "image" | "text",
  contentType: string,
  size: number,
  truncated: boolean,
  bodyBytes: number,
): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Length": "", // filled by the caller (image: size; text: the cut or gzipped length)
    [PREVIEW_HDR.kind]: kind,
    [PREVIEW_HDR.size]: String(size),
    [PREVIEW_HDR.bytes]: String(bodyBytes),
    [PREVIEW_HDR.truncated]: truncated ? "1" : "0",
    "Content-Disposition": 'attachment; filename="preview"',
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

export function readAndStream(src: StreamSrc, sink: PreviewSink, opts: StreamOpts): Promise<StreamOutcome> {
  const deadlineAt = opts.now() + opts.streamAt;
  const state: FlowState = { headSent: false };
  const race = <T>(p: Promise<T>): Promise<T> => racePreviewIo(p, deadlineAt, opts.signal, opts.now, opts.tracker);
  const abortKind = (): StreamFailReason => (opts.signal.reason === "hub-close" ? "hub-close" : "client-abort");
  const classify = (err: unknown): StreamFailReason => {
    if (opts.signal.aborted) return abortKind();
    if (isPreviewIoError(err)) return err.ioFail === "deadline" ? "stream-deadline" : abortKind();
    return "io";
  };
  const fail = (reason: StreamFailReason): StreamOutcome => {
    if (state.headSent) sink.destroy(); // §4.5.2 image rule 4: post-head failures destroy
    return { ok: false, reason, headersSent: state.headSent };
  };
  const writeChunk = async (chunk: Buffer): Promise<void> => {
    if (!sink.write(chunk)) await race(sink.waitDrain(opts.signal));
  };
  const pvIo = src.pv?.io;
  const step = <T>(lazy: () => Promise<T>): Promise<T> => {
    if (pvIo === undefined) return race(lazy());
    // pv: an aborted request (revoke / client gone) never starts another fs op
    if (opts.signal.aborted) return Promise.reject(new PreviewIoError("abort", "signal aborted before pv fs step"));
    return pvIo.run(lazy, { deadlineAt, signal: opts.signal });
  };
  const ctx: FlowCtx = { src, sink, opts, deadlineAt, state, fail, classify, race, step, writeChunk };

  return (async (): Promise<StreamOutcome> => {
    try {
      if (src.pv !== undefined) return await streamPv(ctx);
      if (src.download !== undefined) return await streamDownload(ctx);
      if (src.sniff.kind === "image") return await streamImage(ctx);
      if (src.chunk !== undefined) return await streamChunkedText(ctx);
      return await streamText(ctx);
    } catch (err) {
      return fail(classify(err));
    } finally {
      // §3.1 ⑩: this function owns the handle — closed on success, failure and abort alike
      if (pvIo !== undefined) await pvIo.close(() => src.fh.close());
      else await src.fh.close().catch(() => undefined);
    }
  })();
}

// ---------------------------------------------------------------------------
// download flow (preview-download) — the image flow's streaming-hash sibling: same
// read loop, same held-back last chunk (an upload download is sha256-verified WHILE
// streaming and nothing final leaves before the digest + post-stat identity match), but
// octet-stream headers with the real basename and NO dims/mime — no sniff ever ran.
// ---------------------------------------------------------------------------

/** RFC 5987 `filename*` percent-encoding: everything outside the attr-char whitelist is
 *  percent-encoded (stricter than encodeURIComponent, which leaves `'`/`(`/`)`/`*` bare). */
function encodeFilenameStar(name: string): string {
  let out = "";
  for (const b of Buffer.from(name, "utf8")) {
    const c = String.fromCharCode(b);
    out += /^[A-Za-z0-9!#$&+.^_`|~-]$/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

async function streamDownload(ctx: FlowCtx): Promise<StreamOutcome> {
  const { src } = ctx;
  if (src.download === undefined) return ctx.fail("io"); // unreachable — dispatch guard
  return streamRawBody(ctx, {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(src.size),
    [PREVIEW_HDR.kind]: "download",
    [PREVIEW_HDR.size]: String(src.size),
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeFilenameStar(src.download.filename)}`,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
}

/** web-hub-html-preview plan v2 §2.3-⑦: the `/pv` flow — the raw-body kernel under the
 *  caller's header table (`Content-Length` forced to the admitted size). */
async function streamPv(ctx: FlowCtx): Promise<StreamOutcome> {
  const { src } = ctx;
  if (src.pv === undefined) return ctx.fail("io"); // unreachable — dispatch guard
  return streamRawBody(ctx, { ...src.pv.headers, "Content-Length": String(src.size) });
}

/**
 * The raw-bytes kernel shared by the download flow and the pv flow (extracted from
 * `streamDownload`, plan v2 §6 P1a): pre-stat → (pv only: `beforeHead()` gate) → head with the
 * given `headers` → held-back-last-chunk read loop (+ streaming sha256 when `src.verify`) →
 * post-stat identity/hash checks → last chunk → end. Download behaviour is byte-identical.
 */
async function streamRawBody(ctx: FlowCtx, headers: Record<string, string>): Promise<StreamOutcome> {
  const { src, sink, opts, state, fail, step, race, writeChunk } = ctx;

  const pre = await step(() => src.fh.stat());

  // §2.3-⑦: revoked/expired between admission and the head ⇒ nothing is written
  if (src.pv !== undefined && !src.pv.beforeHead()) return fail("not-live");
  sink.writeHead(200, headers);
  state.headSent = true;

  const hasher = src.verify !== undefined ? createHash("sha256") : undefined;
  let pos = 0;
  let pending: Buffer | undefined; // the held-back chunk — never written until proven non-final
  const samplePart = src.sample.subarray(0, Math.min(src.sample.length, src.size));
  if (samplePart.length > 0) {
    hasher?.update(samplePart);
    pending = Buffer.from(samplePart);
    pos = samplePart.length;
  }

  const chunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
  while (pos < src.size) {
    const want = Math.min(chunk.length, src.size - pos);
    const { bytesRead } = await step(() => src.fh.read(chunk, 0, want, pos));
    if (bytesRead === 0) return fail("shrunk"); // EOF before `size` bytes — file shrank
    if (pending !== undefined) await writeChunk(pending); // more data existed ⇒ pending was not final
    const fresh = chunk.subarray(0, bytesRead);
    hasher?.update(fresh);
    pending = Buffer.from(fresh);
    pos += bytesRead;
  }

  const post = await step(() => src.fh.stat());
  if (hasher !== undefined && src.verify !== undefined && hasher.digest("hex") !== src.verify.sha256) {
    return fail("hash-mismatch"); // destroy: body ends short of Content-Length
  }
  if (!sameIdentity(identityOf(post), identityOf(pre))) {
    return fail("identity-changed");
  }
  if (src.verify !== undefined) opts.verifier.remember(src.verify.uploadId, identityOf(post));

  if (pending !== undefined) await writeChunk(pending);
  sink.end();
  return { ok: true, bytes: src.size, truncated: false };
}

// ---------------------------------------------------------------------------
// image flow — streaming hash, last chunk held back, destroy on any mismatch
// ---------------------------------------------------------------------------

async function streamImage(ctx: FlowCtx): Promise<StreamOutcome> {
  const { src, sink, opts, state, fail, race, writeChunk } = ctx;
  if (src.sniff.kind !== "image") return fail("io");
  const sniff = src.sniff;
  if (sniff.dims === null) {
    // caller contract: §3.1 ⑧ already rejected `dims === null`; unreachable, fails closed
    return fail("io");
  }

  const pre = await race(src.fh.stat());

  const headers = baseHeaders("image", sniff.mime, src.size, false, src.size);
  headers["Content-Length"] = String(src.size);
  headers[PREVIEW_HDR.dims] = `${sniff.dims.w}x${sniff.dims.h}`;
  sink.writeHead(200, headers);
  state.headSent = true;

  const hasher = src.verify !== undefined ? createHash("sha256") : undefined;
  let pos = 0;
  let pending: Buffer | undefined; // the held-back chunk — never written until proven non-final
  const samplePart = src.sample.subarray(0, Math.min(src.sample.length, src.size));
  if (samplePart.length > 0) {
    hasher?.update(samplePart);
    pending = Buffer.from(samplePart);
    pos = samplePart.length;
  }

  const chunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
  while (pos < src.size) {
    const want = Math.min(chunk.length, src.size - pos);
    const { bytesRead } = await race(src.fh.read(chunk, 0, want, pos));
    if (bytesRead === 0) return fail("shrunk"); // EOF before `size` bytes — file shrank
    if (pending !== undefined) await writeChunk(pending); // more data existed ⇒ pending was not final
    const fresh = chunk.subarray(0, bytesRead);
    hasher?.update(fresh);
    pending = Buffer.from(fresh);
    pos += bytesRead;
  }

  const post = await race(src.fh.stat());
  if (hasher !== undefined && src.verify !== undefined && hasher.digest("hex") !== src.verify.sha256) {
    return fail("hash-mismatch"); // destroy: body ends short of Content-Length
  }
  if (!sameIdentity(identityOf(post), identityOf(pre))) {
    return fail("identity-changed");
  }
  // §4.5.2 image rule 4: a fully verified upload image WRITES the identity cache (images
  // never read it — this just primes future text previews of the same unchanged upload)
  if (src.verify !== undefined) opts.verifier.remember(src.verify.uploadId, identityOf(post));

  if (pending !== undefined) await writeChunk(pending);
  sink.end();
  return { ok: true, bytes: src.size, truncated: false };
}

// ---------------------------------------------------------------------------
// text flow — verify FIRST (cache → single-flight), head only afterwards
// ---------------------------------------------------------------------------

async function streamText(ctx: FlowCtx): Promise<StreamOutcome> {
  // source-order contract (ruling #4, pinned by tests): this is the ONLY flow that touches the
  // verifier, and its `verifyWhole` call must precede `writeHead` — after the head there is no
  // whole-file-verify path, ever.
  const { src, sink, opts, state, fail, classify, race, writeChunk } = ctx;

  const pre = await race(src.fh.stat());

  const want = Math.min(src.size, opts.textMax);
  const body = Buffer.alloc(want);
  let got = 0;
  const fromSample = Math.min(src.sample.length, want);
  if (fromSample > 0) {
    body.set(src.sample.subarray(0, fromSample), 0);
    got = fromSample;
  }
  while (got < want) {
    const { bytesRead } = await race(src.fh.read(body, got, want - got, got));
    if (bytesRead === 0) return fail("shrunk");
    got += bytesRead;
  }
  const cut = utf8SafeCut(body, want);

  let verifyTag: "hashed" | "cached" | "joined" | undefined;
  if (src.verify !== undefined) {
    const outcome = await race(
      opts.verifier.verifyWhole(
        { uploadId: src.verify.uploadId, sha256: src.verify.sha256, fh: src.fh, identity: identityOf(pre) },
        { signal: opts.signal, waitUntil: Math.min(ctx.deadlineAt, opts.now() + PREVIEW_VERIFY_MS) },
      ),
    );
    if (typeof outcome !== "string") return fail(outcome.fail);
    verifyTag = outcome;
  } else {
    const post = await race(src.fh.stat());
    if (!sameIdentity(identityOf(post), identityOf(pre))) return fail("identity-changed");
  }

  // Dynamic gzip (shared negotiation, hub/gzip.ts): compression happens AFTER verification and
  // BEFORE the head — the text flow is fully buffered at this point, so Content-Length can name
  // the compressed length while every `X-PWH-Preview-*` metadata header still describes the
  // ORIGINAL bytes (kind/size/truncated are content facts, not transport facts). The gzip runs
  // on the thread pool and races the same write-out deadline as every read/stat/drain; a race
  // rejection (deadline/abort) fails through the standard classify path, a body that fails to
  // shrink (or any zlib error, caught inside the eligibility gate) keeps the identity bytes.
  let out = body.subarray(0, cut);
  let gz: Buffer | undefined;
  if (out.length >= GZIP_MIN_BYTES && acceptsGzip(opts.acceptEncoding)) {
    try {
      const compressed = await race(gzipAsync(out));
      gz = compressed.length < out.length ? compressed : undefined;
    } catch (err) {
      return fail(classify(err));
    }
  }

  const headers = baseHeaders("text", "text/plain; charset=utf-8", src.size, cut < src.size, cut);
  headers["Content-Length"] = String(gz === undefined ? cut : gz.length);
  if (gz !== undefined) {
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
  }
  sink.writeHead(200, headers);
  state.headSent = true;

  const send = gz === undefined ? out : gz;
  if (send.length > 0) await writeChunk(send);
  sink.end();
  return verifyTag === undefined
    ? { ok: true, bytes: cut, truncated: cut < src.size }
    : { ok: true, bytes: cut, truncated: cut < src.size, verify: verifyTag };
}

// ---------------------------------------------------------------------------
// chunked text flow (chunked-plan §3.2) — the continuation sibling of `streamText`:
// same verify-FIRST-then-head shape (upload `verifyWhole` / cwd post-stat identity, both
// BEFORE `writeHead` — the source-order ruling holds here too), plus the ident echo check
// against the stream-start `pre` stat and the hub hard ceiling. Every fs-ish race is preceded
// by the tracker pre-check (`busy` fast-fail) and raced WITH the tracker, so a cold/slow fs
// can never wedge the hub. `src.chunk === undefined` requests never enter this function —
// their code path is byte-identical to pre-chunked (pinned by tests).
// ---------------------------------------------------------------------------

async function streamChunkedText(ctx: FlowCtx): Promise<StreamOutcome> {
  const { src, sink, opts, state, fail, classify, race, writeChunk } = ctx;
  const chunk = src.chunk;
  if (chunk === undefined) return fail("io"); // unreachable — dispatch guard
  /** r2 #4: `busy` comes ONLY from this pre-check, never from `classify`. */
  const tripped = (): boolean => opts.tracker !== undefined && opts.tracker.zombies >= opts.tracker.max;

  if (tripped()) return fail("busy");
  const pre = await race(src.fh.stat());

  // identity (§2.3): the echoed token must match the CURRENT pre stat, and the size must
  // still equal the admitted one — either drifting means "the file changed between chunks",
  // answered 409 `E_PREVIEW_CHANGED` before any head is written (D12: never stitch).
  const identNow = previewIdentOf(identityOf(pre));
  if ((chunk.ident !== undefined && chunk.ident !== identNow) || pre.size !== src.size) {
    return fail("identity-changed");
  }

  // §2.2/§2.3: offset ≥ size is a client arithmetic error ⇒ `range` (400 reason:"offset").
  // The one exception: offset 0 on an empty file is a legal "first chunk of nothing".
  if (chunk.offset >= src.size && !(chunk.offset === 0 && src.size === 0)) return fail("range");

  const start = chunk.offset;
  const want = Math.min(src.size - start, opts.textMax, chunk.ceiling - start);
  const body = Buffer.alloc(want);
  let got = 0;
  if (start === 0) {
    // only the FIRST chunk reuses the sniff sample; a continuation reads positionally.
    const fromSample = Math.min(src.sample.length, want);
    if (fromSample > 0) {
      body.set(src.sample.subarray(0, fromSample), 0);
      got = fromSample;
    }
  }
  while (got < want) {
    if (tripped()) return fail("busy");
    const { bytesRead } = await race(src.fh.read(body, got, want - got, start + got));
    if (bytesRead === 0) return fail("shrunk");
    got += bytesRead;
  }

  // §3.2 step 5: cut on a UTF-8 character boundary (except at EOF, where the whole — possibly
  // dangling — tail is served verbatim), then the PROGRESS rule: a cut of 0 with want > 0
  // (the boundary lands inside a multi-byte sequence whose lead byte sits exactly at `want`)
  // is bumped to `want` — a 0-byte body would loop the UI forever loading "more".
  let cut = start + want === src.size ? want : utf8SafeCut(body, want);
  if (cut === 0 && want > 0) cut = want;

  // verification branch — byte-for-byte the same decision as `streamText` (source-order
  // ruling: upload `verifyWhole` / cwd post-stat compare, both strictly BEFORE the head).
  let verifyTag: "hashed" | "cached" | "joined" | undefined;
  if (src.verify !== undefined) {
    if (tripped()) return fail("busy");
    const outcome = await race(
      opts.verifier.verifyWhole(
        { uploadId: src.verify.uploadId, sha256: src.verify.sha256, fh: src.fh, identity: identityOf(pre) },
        { signal: opts.signal, waitUntil: Math.min(ctx.deadlineAt, opts.now() + PREVIEW_VERIFY_MS) },
      ),
    );
    if (typeof outcome !== "string") return fail(outcome.fail);
    verifyTag = outcome;
  } else {
    if (tripped()) return fail("busy");
    const post = await race(src.fh.stat());
    if (!sameIdentity(identityOf(post), identityOf(pre))) return fail("identity-changed");
  }

  // gzip: same negotiation as `streamText` (per-chunk independent compression), raced with
  // the tracker and preceded by the busy pre-check.
  let out = body.subarray(0, cut);
  let gz: Buffer | undefined;
  if (out.length >= GZIP_MIN_BYTES && acceptsGzip(opts.acceptEncoding)) {
    try {
      if (tripped()) return fail("busy");
      const compressed = await race(gzipAsync(out));
      gz = compressed.length < out.length ? compressed : undefined;
    } catch (err) {
      return fail(classify(err));
    }
  }

  const truncated = start + cut < src.size;
  const headers = baseHeaders("text", "text/plain; charset=utf-8", src.size, truncated, cut);
  headers["Content-Length"] = String(gz === undefined ? cut : gz.length);
  // chunked-only headers (§2.3): the offset echo (MUST equal the request's offset), the
  // identity token (computed from the stream-start `pre` stat) and no-store — a non-chunked
  // response carries NONE of these (byte-identical, pinned by tests).
  headers[PREVIEW_HDR.offset] = String(start);
  headers[PREVIEW_HDR.ident] = identNow;
  headers["Cache-Control"] = "no-store";
  if (gz !== undefined) {
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
  }
  sink.writeHead(200, headers);
  state.headSent = true;

  const send = gz === undefined ? out : gz;
  if (send.length > 0) await writeChunk(send);
  sink.end();
  return verifyTag === undefined
    ? { ok: true, bytes: cut, truncated }
    : { ok: true, bytes: cut, truncated, verify: verifyTag };
}
