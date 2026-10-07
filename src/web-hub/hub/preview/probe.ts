/**
 * web-hub content-preview — the batch existence-probe kernel (2026-10-07 修订「先探测后标
 * 记」, plan §修订): `POST /api/preview/probe` lets the UI ask, for up
 * to `PREVIEW_PROBE_MAX_PATHS` candidate paths in ONE request, "would a preview of this path
 * succeed?" BEFORE rendering it clickable — a settled message whose `/abs/file.ts` no longer
 * exists stays plain text instead of a button that opens an error panel.
 *
 * Security: every entry runs `openAdmittedPath` (`open.ts`) — the SAME ⑤–⑦ pipeline (session
 * visibility → upload/cwd classification → PV2b store open / PV2a cwd admitter) a real
 * `GET /api/preview` walks; the admission rules exist in exactly one place. Nothing here
 * re-implements a defence. What probe ADDS on top of the open is a bounded head read
 * (`min(size, 8 KiB)` — enough for the §4.4 sniff's magic numbers and the 8 KiB text head)
 * to classify the entry: sniff `text`/`image` ⇒ that kind; binary, not-found, not-admitted,
 * non-regular, deadline-exhausted ⇒ `"missing"` (the 2026-10-07 ruling: every case where a
 * preview click could not have succeeded collapses to missing, so the UI keeps plain text).
 * No file body beyond the head is read, nothing is streamed, no content is returned.
 *
 * Body/JSON parsing lives here too (`readProbeBody`/`parseProbeBody`) — bounded by
 * `PREVIEW_PROBE_MAX_BODY_BYTES` with a content-length precheck, mirroring `http.ts`'s
 * `readBody` discipline (this module is scanned by the same source-scan guard: NO `node:fs*`
 * imports; `node:http` types only).
 *
 * Never answers HTTP itself: `runPreviewProbe` returns the results (or an abort the caller
 * resolves via its own signal), and `routes.ts`'s `handleProbe` owns the whole request
 * lifecycle (CSRF/auth/limits/audit/teardown) reusing the preview ⓪–⑩ machinery.
 */

import type { IncomingMessage } from "node:http";
import {
  PREVIEW_PROBE_MAX_BODY_BYTES,
  PREVIEW_PROBE_MAX_PATHS,
  validatePreviewPath,
  type PreviewProbeKind,
} from "../../protocol/preview.js";
import type { ReqDeadline } from "../req-deadline.js";
import { previewFsStep } from "./fs.js";
import { openAdmittedPath, type OpenPathDeps, type OpenPathInput } from "./open.js";
import { sniff } from "./sniff.js";
import { PREVIEW_SNIFF_TEXT_BYTES } from "../../protocol/preview.js";

// ---------------------------------------------------------------------------
// request body (bounded read + JSON shape validation)
// ---------------------------------------------------------------------------

/** Mirrors `http.ts`'s body-read budget class: hard wall, unref'd timer, settle-once. */
const PROBE_BODY_READ_MS = 4_000;

export interface ProbeBodyInput {
  readonly paths: readonly string[];
}

export type ProbeBodyResult =
  | { ok: true; paths: string[] }
  | { ok: false; status: number; code: "E_BAD_REQUEST"; reason: "json" | "shape" | "too-many" };

/**
 * Pure JSON-shape validation (exported for direct unit tests): body must be an object with a
 * `paths` ARRAY of strings, at most `PREVIEW_PROBE_MAX_PATHS` entries. Per-entry path
 * VALIDITY is deliberately NOT a body error — a single malformed entry answers `"missing"`
 * for itself (the UI only sends `isClickable`-validated paths; one hostile entry must not
 * kill the whole message's probe).
 */
export function parseProbeBody(raw: unknown): ProbeBodyResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 400, code: "E_BAD_REQUEST", reason: "shape" };
  }
  const paths = (raw as { paths?: unknown }).paths;
  if (!Array.isArray(paths)) return { ok: false, status: 400, code: "E_BAD_REQUEST", reason: "shape" };
  if (paths.length > PREVIEW_PROBE_MAX_PATHS) {
    return { ok: false, status: 400, code: "E_BAD_REQUEST", reason: "too-many" };
  }
  for (const p of paths) {
    if (typeof p !== "string") return { ok: false, status: 400, code: "E_BAD_REQUEST", reason: "shape" };
  }
  return { ok: true, paths };
}

export type ProbeBodyRead =
  | { ok: true; body: ProbeBodyInput }
  | { ok: false; status: number; code: "E_BAD_REQUEST"; reason: "json" | "shape" | "too-many" | "body" };

/**
 * Read the request body capped at `PREVIEW_PROBE_MAX_BODY_BYTES` (declared content-length
 * precheck + in-flight byte count), parse it, validate the shape. 408-style read timeouts
 * surface as 400 `reason:"body"` — probe responses use only the E_BAD_REQUEST family for
 * request-shape problems (the 413 keeps its status for the byte cap, mirroring `readBody`).
 */
export function readProbeBody(req: IncomingMessage): Promise<ProbeBodyRead> {
  return new Promise<ProbeBodyRead>((resolve) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > PREVIEW_PROBE_MAX_BODY_BYTES) {
      resolve({ ok: false, status: 413, code: "E_BAD_REQUEST", reason: "body" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (err: { status: number; code: "E_BAD_REQUEST"; reason: "body" | "json" } | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", onData);
      if (err !== undefined) {
        resolve({ ok: false, ...err });
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown;
      if (text.length === 0) {
        parsed = undefined;
      } else {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          resolve({ ok: false, status: 400, code: "E_BAD_REQUEST", reason: "json" });
          return;
        }
      }
      const shape = parseProbeBody(parsed);
      resolve(shape.ok ? { ok: true, body: { paths: shape.paths } } : shape);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > PREVIEW_PROBE_MAX_BODY_BYTES) finish({ status: 413, code: "E_BAD_REQUEST", reason: "body" });
      else chunks.push(chunk);
    };
    const timer = setTimeout(() => finish({ status: 400, code: "E_BAD_REQUEST", reason: "body" }), PROBE_BODY_READ_MS);
    timer.unref?.();
    req.on("data", onData);
    req.once("end", () => finish(undefined));
    req.once("error", () => finish({ status: 400, code: "E_BAD_REQUEST", reason: "body" }));
    req.once("aborted", () => finish({ status: 400, code: "E_BAD_REQUEST", reason: "body" }));
  });
}

// ---------------------------------------------------------------------------
// the kernel
// ---------------------------------------------------------------------------

export interface ProbeKernelDeps extends OpenPathDeps {
  now(): number;
}

export type ProbeRunResult = { ok: true; results: PreviewProbeKind[] } | { ok: false; abort: true };

/**
 * Probe every path (in order) and return the per-entry kinds — same length and order as
 * `params.paths`. `abort: true` ⇒ the caller's signal fired (client disconnect / hub close);
 * per-path failures are NEVER request failures, they are `"missing"` entries.
 */
export async function runPreviewProbe(
  deps: ProbeKernelDeps,
  params: Omit<OpenPathInput, "path"> & { paths: readonly string[] },
  deadline: ReqDeadline,
  signal: AbortSignal,
): Promise<ProbeRunResult> {
  const results: PreviewProbeKind[] = [];
  for (const path of params.paths) {
    if (signal.aborted) return { ok: false, abort: true };
    const kind = await probeOne(deps, { ...params, path }, deadline, signal);
    if (kind === undefined) return { ok: false, abort: true };
    results.push(kind);
  }
  return { ok: true, results };
}

/** One entry: open through the SHARED pipeline, sniff the head, close. `undefined` = abort. */
async function probeOne(
  deps: ProbeKernelDeps,
  input: OpenPathInput,
  deadline: ReqDeadline,
  signal: AbortSignal,
): Promise<PreviewProbeKind | undefined> {
  if (typeof input.path !== "string" || !validatePreviewPath(input.path)) return "missing";
  const op = await openAdmittedPath(deps, input, deadline, signal);
  if (!op.ok) return op.abort === true ? undefined : "missing";
  const opened = op.opened;
  try {
    const sample = await readHead(deps, opened.fh, opened.size, deadline, signal);
    if (signal.aborted) return undefined;
    const s = sniff(sample, opened.size);
    return s.kind === "text" ? "text" : s.kind === "image" ? "image" : "missing";
  } catch (err) {
    if (signal.aborted) return undefined; // an aborted request is never answered
    return "missing"; // head read failed (deadline etc.) — indistinguishable from dead
  } finally {
    await opened.fh.close().catch(() => undefined);
  }
}

/**
 * Bounded pread of `min(size, PREVIEW_SNIFF_TEXT_BYTES)` — the §4.4 head the sniff needs
 * (magic numbers live in the first bytes; the text decision reads at most these 8 KiB).
 * Unlike preview's `readSample` there is NO JPEG continuation: probe does not need dims.
 */
async function readHead(
  deps: ProbeKernelDeps,
  fh: { read(buf: Buffer, off: number, len: number, pos: number): Promise<{ bytesRead: number }> },
  size: number,
  deadline: ReqDeadline,
  signal: AbortSignal,
): Promise<Buffer> {
  const want = Math.min(size, PREVIEW_SNIFF_TEXT_BYTES);
  const buf = Buffer.alloc(want);
  let got = 0;
  while (got < want) {
    const { bytesRead } = await previewFsStep(() => fh.read(buf, got, want - got, got), deadline, signal, {
      now: deps.now,
    });
    if (bytesRead === 0) break; // EOF early (file shrank) — the partial head still sniffs
    got += bytesRead;
  }
  return buf.subarray(0, got);
}
