/**
 * Markdown inline-image loader (md-preview-html plan, user ruling 2026-10-20) — the fetching
 * half of the preview-mode `image` nodes `MdImage.vue` renders. Per-DOCUMENT (one loader per
 * `PreviewText` mount, provided through `MD_IMAGE_LOADER`; stream segments share it, so the
 * bounds below hold for the whole document):
 *
 * - at most `maxImages` (24) image loads per document — the rest render the placeholder;
 * - at most `concurrency` (2) fetches in flight, FIFO queue;
 * - each fetch has its own `timeoutMs` (45s) deadline and an AbortController — `release()`
 *   (component unmount / file switch / rendered→source mode switch, all of which unmount the
 *   `MdBlock` subtree) aborts it;
 * - per-image size cap rides the transport's existing `maxPixels` budget (the hub's 413 /
 *   `E_PREVIEW_TOO_LARGE` surfaces as a placeholder, never an error page);
 * - a total `budgetBytes` (32 MiB) decoded budget — once the SUM of loaded image bytes
 *   reaches it, every later image is the placeholder (`"budget"`).
 *
 * The loader is transport-agnostic: `fetchImage` is injected (the UI wires it with
 * `createMdImageFetcher` below, tests with a fake). Failed/denied/oversize images all land in
 * the same `placeholder` terminal state with a machine `reason` the component maps to copy.
 */
import { ref, type Ref } from "vue";
import { clientImageBudget } from "@logic/preview.js";
import { readPreviewDataUrl, type FileReaderLike } from "./usePreview.js";
import type { PreviewTransport } from "../transport/types.js";
import type { PreviewPathScope } from "../types.js";

export type MdImageSlotState = "loading" | "ready" | "placeholder";

/** Machine reasons for the placeholder state; `MdImage.vue` maps them to i18n copy. */
export type MdImageFailReason = "unavailable" | "denied" | "tooLarge" | "failed" | "timeout" | "limit" | "budget";

export type MdImageFetchResult =
  | { readonly ok: true; readonly dataUrl: string; readonly bytes: number }
  | { readonly ok: false; readonly reason: Exclude<MdImageFailReason, "limit" | "budget" | "timeout"> };

export interface MdImageSlot {
  readonly state: Readonly<Ref<MdImageSlotState>>;
  readonly dataUrl: Readonly<Ref<string | null>>;
  readonly reason: Readonly<Ref<MdImageFailReason | null>>;
  /** Abort a queued/in-flight load (component unmount). Idempotent. */
  release(): void;
}

export interface MdImageLoaderOptions {
  readonly fetchImage: (path: string, signal: AbortSignal) => Promise<MdImageFetchResult>;
  readonly maxImages?: number;
  readonly concurrency?: number;
  readonly budgetBytes?: number;
  readonly timeoutMs?: number;
}

export interface MdImageLoader {
  load(path: string): MdImageSlot;
  /** Abort everything (PreviewText unmount). Later `release()` calls stay no-ops. */
  dispose(): void;
}

export const MD_IMAGE_MAX_PER_DOC = 24;
export const MD_IMAGE_CONCURRENCY = 2;
export const MD_IMAGE_BUDGET_BYTES = 32 * 1024 * 1024;
export const MD_IMAGE_TIMEOUT_MS = 45_000;

interface SlotRecord {
  readonly path: string;
  readonly state: Ref<MdImageSlotState>;
  readonly dataUrl: Ref<string | null>;
  readonly reason: Ref<MdImageFailReason | null>;
  released: boolean;
  queued: boolean;
  settled: boolean;
  ctl: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
  timedOut: boolean;
}

export function createMdImageLoader(opts: MdImageLoaderOptions): MdImageLoader {
  const maxImages = opts.maxImages ?? MD_IMAGE_MAX_PER_DOC;
  const concurrency = opts.concurrency ?? MD_IMAGE_CONCURRENCY;
  const budgetBytes = opts.budgetBytes ?? MD_IMAGE_BUDGET_BYTES;
  const timeoutMs = opts.timeoutMs ?? MD_IMAGE_TIMEOUT_MS;

  // Admission counts DISTINCT paths, and a path that already loaded is served from `ready`
  // without refetching or spending budget: a rendered↔source mode switch remounts every
  // MdImage, which must not exhaust the per-document limit (verifier finding, 2026-10-20).
  // Both maps stay ≤ maxImages entries (only admitted paths are ever inserted).
  const admittedPaths = new Set<string>();
  const ready = new Map<string, string>();
  let running = 0;
  let bytesLoaded = 0;
  let disposed = false;
  const queue: SlotRecord[] = [];
  const live = new Set<SlotRecord>();

  function finish(rec: SlotRecord, state: MdImageSlotState, reason: MdImageFailReason | null): void {
    rec.state.value = state;
    rec.reason.value = reason;
    live.delete(rec);
  }

  /**
   * Idempotent single settle per slot. The timeout and `release()` settle SYNCHRONOUSLY (a
   * fetch that ignores `abort()` must not hang the slot or leak its concurrency slot); a
   * late fetch resolution then only contributes its spent bytes to the budget.
   */
  function settle(rec: SlotRecord, res: MdImageFetchResult | null): void {
    if (rec.settled) {
      if (res !== null && res.ok) bytesLoaded += res.bytes;
      return;
    }
    rec.settled = true;
    if (rec.timer !== null) {
      clearTimeout(rec.timer);
      rec.timer = null;
    }
    rec.ctl = null;
    running--;
    if (res !== null && res.ok) bytesLoaded += res.bytes; // counts even after release (bytes were spent)
    if (!rec.released) {
      if (rec.timedOut) finish(rec, "placeholder", "timeout");
      else if (res === null) finish(rec, "placeholder", "failed");
      else if (res.ok) {
        rec.dataUrl.value = res.dataUrl;
        ready.set(rec.path, res.dataUrl);
        finish(rec, "ready", null);
      } else finish(rec, "placeholder", res.reason);
    } else {
      live.delete(rec);
    }
    pump();
  }

  function start(rec: SlotRecord): void {
    if (bytesLoaded >= budgetBytes) {
      rec.queued = false;
      rec.settled = true;
      finish(rec, "placeholder", "budget");
      return;
    }
    running++;
    const ctl = new AbortController();
    rec.ctl = ctl;
    rec.timer = setTimeout(() => {
      rec.timedOut = true;
      rec.ctl?.abort();
      settle(rec, null);
    }, timeoutMs);
    Promise.resolve()
      .then(() => opts.fetchImage(rec.path, ctl.signal))
      .then(
        (res) => settle(rec, res),
        () => settle(rec, null),
      );
  }

  function pump(): void {
    while (!disposed && running < concurrency) {
      const rec = queue.shift();
      if (rec === undefined) return;
      if (rec.released) continue;
      rec.queued = false;
      start(rec);
    }
  }

  function release(rec: SlotRecord): void {
    if (rec.released) return;
    rec.released = true;
    if (rec.queued) {
      rec.queued = false;
      rec.settled = true;
      live.delete(rec);
      return;
    }
    if (!rec.settled) {
      rec.ctl?.abort();
      settle(rec, null); // synchronous: reaps the concurrency slot even if the fetch never answers
    }
  }

  function load(path: string): MdImageSlot {
    const rec: SlotRecord = {
      path,
      state: ref<MdImageSlotState>("loading") as Ref<MdImageSlotState>,
      dataUrl: ref<string | null>(null) as Ref<string | null>,
      reason: ref<MdImageFailReason | null>(null) as Ref<MdImageFailReason | null>,
      released: false,
      queued: false,
      settled: false,
      ctl: null,
      timer: null,
      timedOut: false,
    };
    const cached = disposed ? undefined : ready.get(path);
    if (cached !== undefined) {
      rec.settled = true;
      rec.dataUrl.value = cached;
      finish(rec, "ready", null);
      return { state: rec.state, dataUrl: rec.dataUrl, reason: rec.reason, release: () => release(rec) };
    }
    if (disposed || (!admittedPaths.has(path) && admittedPaths.size >= maxImages)) {
      finish(rec, "placeholder", "limit");
      return { state: rec.state, dataUrl: rec.dataUrl, reason: rec.reason, release: () => release(rec) };
    }
    admittedPaths.add(path);
    rec.queued = true;
    live.add(rec);
    queue.push(rec);
    pump();
    return { state: rec.state, dataUrl: rec.dataUrl, reason: rec.reason, release: () => release(rec) };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    queue.length = 0;
    for (const rec of [...live]) release(rec);
    ready.clear();
    admittedPaths.clear();
  }

  return { load, dispose };
}

/* ---------------------------------------------------------------------------
 * The UI wiring: resolve through the SAME preview transport + admission as an image preview
 * (`GET /api/preview`, `X-PWH: 1` — inside `transport.fetch`), the SAME `maxPixels` client
 * budget, and the SAME FileReader → verified `data:<mime>;base64,` conversion (D1/HP8 — CSP
 * stays `img-src 'self' data:`).
 * ------------------------------------------------------------------------ */

export interface MdImageFetcherDeps {
  readonly transport: () => PreviewTransport | undefined;
  readonly scope: () => PreviewPathScope | null;
  readonly coarse: () => boolean;
  readonly createFileReader?: () => FileReaderLike;
}

/** Map a failed preview outcome to a placeholder reason (never throws). */
function reasonForOutcome(out: {
  readonly status: number;
  readonly error: string;
}): Extract<MdImageFetchResult, { ok: false }>["reason"] {
  if (out.error === "E_PREVIEW_TOO_LARGE") return "tooLarge";
  if (out.status === 403 || out.status === 415) return "denied";
  if (out.status === 404) return "unavailable";
  return "failed";
}

export function createMdImageFetcher(
  deps: MdImageFetcherDeps,
): (path: string, signal: AbortSignal) => Promise<MdImageFetchResult> {
  return async (path, signal) => {
    const sc = deps.scope();
    const transport = deps.transport();
    if (sc === null || transport === undefined) return { ok: false, reason: "unavailable" };
    let out;
    try {
      out = await transport.fetch(
        { agentKey: sc.agentKey, sessionId: sc.sessionId, path },
        { signal, maxPixels: clientImageBudget({ coarse: deps.coarse() }) },
      );
    } catch {
      return { ok: false, reason: "failed" }; // network/abort — release() owns the abort UX
    }
    if (!out.ok) return { ok: false, reason: reasonForOutcome(out) };
    if (out.kind !== "image") return { ok: false, reason: "failed" };
    let dataUrl: string;
    try {
      dataUrl = await readPreviewDataUrl(out.blob, deps.createFileReader);
    } catch {
      return { ok: false, reason: "failed" };
    }
    if (!dataUrl.startsWith(`data:${out.mime};base64,`)) return { ok: false, reason: "failed" };
    return { ok: true, dataUrl, bytes: out.blob.size };
  };
}
