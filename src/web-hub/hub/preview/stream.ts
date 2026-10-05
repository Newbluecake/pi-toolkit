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
 *   buffer is ever headed and written.
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
import { isPreviewIoError, racePreviewIo } from "./fs.js";
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
  | "io";

export type StreamOutcome =
  | { ok: true; bytes: number; truncated: boolean; verify?: "hashed" | "cached" | "joined" }
  | { ok: false; reason: StreamFailReason; headersSent: boolean };

/** §3.1 ⑨ read size; the sniff sample (≤64 KiB) is reused as the first streamed chunk. */
const STREAM_CHUNK_BYTES = 64 * 1024;

interface StreamSrc {
  fh: PreviewHandle;
  /** admitted (upload: index-checked; cwd: post-open fstat) size — also `Content-Length`. */
  size: number;
  sniff: SniffResult;
  /** the sniff-stage sample — the file's first `min(size, 64 KiB)` bytes, already read. */
  sample: Buffer;
  /** present ⇒ upload class: image hashes against `sha256`, text runs `verifyWhole`. */
  verify?: { uploadId: string; sha256: string };
}

interface StreamOpts {
  signal: AbortSignal;
  /** §3.1 ⑨ write-out budget (ms), loopback 15s / LAN 30s. */
  streamAt: number;
  textMax: number;
  now(): number;
  verifier: UploadVerifier;
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
  race<T>(p: Promise<T>): Promise<T>;
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
): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Length": "", // filled by the caller (image: size; text: the cut length)
    [PREVIEW_HDR.kind]: kind,
    [PREVIEW_HDR.size]: String(size),
    [PREVIEW_HDR.truncated]: truncated ? "1" : "0",
    "Content-Disposition": 'attachment; filename="preview"',
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

export function readAndStream(src: StreamSrc, sink: PreviewSink, opts: StreamOpts): Promise<StreamOutcome> {
  const deadlineAt = opts.now() + opts.streamAt;
  const state: FlowState = { headSent: false };
  const race = <T>(p: Promise<T>): Promise<T> => racePreviewIo(p, deadlineAt, opts.signal, opts.now);
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
  const ctx: FlowCtx = { src, sink, opts, deadlineAt, state, fail, race, writeChunk };

  return (async (): Promise<StreamOutcome> => {
    try {
      if (src.sniff.kind === "image") return await streamImage(ctx);
      return await streamText(ctx);
    } catch (err) {
      return fail(classify(err));
    } finally {
      // §3.1 ⑩: this function owns the handle — closed on success, failure and abort alike
      await src.fh.close().catch(() => undefined);
    }
  })();
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

  const headers = baseHeaders("image", sniff.mime, src.size, false);
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
  const { src, sink, opts, state, fail, race, writeChunk } = ctx;

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

  const headers = baseHeaders("text", "text/plain; charset=utf-8", src.size, cut < src.size);
  headers["Content-Length"] = String(cut);
  sink.writeHead(200, headers);
  state.headSent = true;

  const out = body.subarray(0, cut);
  if (out.length > 0) await writeChunk(out);
  sink.end();
  return verifyTag === undefined
    ? { ok: true, bytes: cut, truncated: cut < src.size }
    : { ok: true, bytes: cut, truncated: cut < src.size, verify: verifyTag };
}
