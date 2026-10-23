/**
 * Shared syntax-highlight driver (extracted from `HighlightedCode.vue`, 2026-10-23, for the
 * preview line-numbers package): the lazily-imported Prism engine handle plus the
 * load → debounce → tokenize → flatten reactive pipeline. Both `HighlightedCode.vue`
 * (transcript fences + the legacy un-numbered preview body) and `NumberedCode.vue` (the
 * numbered per-line preview body) ride this — the behavior contract is unchanged:
 *
 *  - the Prism engine + language packs load through ONE shared dynamic `import()` (one
 *    code-split chunk, first screen never pays; a failed load ⇒ plain text forever);
 *  - every text/lang change renders PLAIN immediately and only re-tokenizes after the text
 *    settles for `HIGHLIGHT_DEBOUNCE_MS` (a busy stream never tokenizes per frame);
 *  - `shouldHighlight`'s large-text gates and a token-budget/grammar failure all degrade to
 *    `null` parts ⇒ the caller renders its plain-text DOM.
 *
 * Rendering stays with the callers (VNode `<span class="tok-*">` — never v-html/innerHTML).
 */
import { onBeforeUnmount, ref, watch, type Ref } from "vue";
import { encodeHighlightSpans, flattenTokens, HIGHLIGHT_DEBOUNCE_MS, shouldHighlight } from "@logic/highlight.js";
import type { HighlightSpans } from "@logic/previewVirtualTypes.js";
import { countCodeLines } from "@logic/previewLines.js";
import {
  getHighlightWorkerClient,
  HIGHLIGHT_WORKER_MAX_BYTES,
  type HighlightWorkerClient,
  type HighlightWorkerHandle,
} from "./highlight-worker-client.js";

/** The structural surface the engine implements (typed in `prism.d.ts`). */
export interface PrismLike {
  readonly languages: Record<string, unknown>;
  tokenize(text: string, grammar: unknown): unknown[];
}

/** One flattened render fragment (`flattenTokens`'s row shape). */
export interface FlatPart {
  readonly cls: string;
  readonly text: string;
}

/** One shared in-flight load for every mounted instance; `null` = load failed ⇒ plain text. */
let prismPromise: Promise<PrismLike | null> | null = null;

/**
 * preview-perf P3 §5.2: the SYNCHRONOUS engine cache. `undefined` = the load has not settled
 * yet; once it has, this is exactly the promise's resolution — a later `useHighlightParts`
 * call starts with the engine already in hand and can tokenize during setup, so the FIRST
 * render of a one-shot preview body is the highlighted VNode instead of a plain text node
 * that gets replaced a moment later (评审 r1 #11: `debounceMs = 0` alone cannot do that —
 * the 150 ms debounce would still emit plain first). Written inside `loadPrism()`'s settled
 * handlers; never read before the first call.
 */
let resolvedPrism: PrismLike | null | undefined = undefined;

export function loadPrism(): Promise<PrismLike | null> {
  prismPromise ??= import("./highlight-impl.js")
    .then((m) => {
      resolvedPrism = m.default as PrismLike;
      return resolvedPrism;
    })
    .catch(() => {
      resolvedPrism = null; // failed load ⇒ plain text forever (contract unchanged)
      return null;
    });
  return prismPromise;
}

/**
 * The reactive highlight pipeline. `source` is re-read on every invalidation (props or the
 * late-arriving engine). Returns a ref that is `null` while/forever-plain, or the flattened
 * token parts once tokenized. Must be called during setup (owns a watcher + unmount hook).
 *
 * preview-perf P3 §5.2 — `opts.immediate` (the one-shot preview bodies pass it; the
 * transcript's CodeBlock does NOT, keeping its 150 ms debounce byte-identical): when the
 * engine is already resolved (`resolvedPrism` — the synchronous cache above), parts are
 * computed SYNCHRONOUSLY in setup, so the caller's first render is already highlighted; a
 * cold engine still renders plain first and swaps exactly once on arrival; a failed load
 * stays plain forever. Subsequent text/lang changes in immediate mode also re-tokenize
 * synchronously (one-shot callers change text at most on a retry remount).
 */
export function useHighlightParts(
  source: () => { readonly text: string; readonly lang: string | null },
  opts?: { readonly immediate?: boolean },
): Ref<FlatPart[] | null> {
  const immediate = opts?.immediate === true;
  const prism = ref<PrismLike | null>(resolvedPrism ?? null);
  /** Non-null ⇒ highlighted parts; null ⇒ plain-text rendering. */
  const parts = ref<FlatPart[] | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  void loadPrism().then((p) => {
    if (!disposed) prism.value = p;
  });

  function recompute(): void {
    const p = prism.value;
    const { text, lang } = source();
    if (p === null || lang === null || !shouldHighlight(text)) {
      parts.value = null;
      return;
    }
    const grammar = p.languages[lang];
    if (grammar === undefined) {
      parts.value = null;
      return;
    }
    try {
      parts.value = flattenTokens(p.tokenize(text, grammar)) as FlatPart[] | null;
    } catch {
      parts.value = null; // a grammar must never break rendering — fall back to plain text
    }
  }

  watch(
    () => [source().text, source().lang, prism.value] as const,
    () => {
      if (immediate && prism.value !== null) {
        // Engine in hand (setup-time via the sync cache, or a later arrival): tokenize NOW —
        // the first render is the highlighted VNode (§5.2), never plain-then-replace.
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        recompute();
        return;
      }
      // Latest text shows plain right away (identical pre-highlight DOM); tokenizing is
      // debounced so a streaming caller never re-tokenizes per frame.
      parts.value = null;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(recompute, HIGHLIGHT_DEBOUNCE_MS);
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
  });

  return parts;
}

/* ------------------------------------------------------------------------- *
 * preview-perf P5 addendum (user ruling 2026-10-23, evidence docs/dev/preview-perf/
 * PB-report.md §7.3): §5.2's `immediate` (first-frame highlight) is for SMALL files only.
 * PB's re-measure showed a stable open regression when inline tokenizing rode the first
 * frame — hl-600 (600 行 / 22.6 KB) 64.6→97.6 ms, and the line-numbers-off 2292-line body
 * 113→247 ms. ≤ the two bounds below keeps the sync-in-setup tokenizes at trivia scale
 * (≤200 lines ⇒ ≤ a few ms); anything larger inside the gates renders PLAIN first and swaps
 * when the debounced tokenize lands (the pre-§5.2 behaviour). The virtual (worker) path is
 * unaffected — it starts plain by design and never uses `immediate`.
 * ------------------------------------------------------------------------- */

/** §5.2 immediate-first-frame highlight: max logical lines. */
export const PREVIEW_IMMEDIATE_HIGHLIGHT_MAX_LINES = 200;
/** §5.2 immediate-first-frame highlight: max UTF-8 bytes (same accounting as `shouldHighlight`). */
export const PREVIEW_IMMEDIATE_HIGHLIGHT_MAX_BYTES = 8 * 1024;

/** §5.2's size gate: is this text small enough to tokenize inside setup? */
export function isImmediateHighlightSize(text: string): boolean {
  if (text.length === 0 || text.length > PREVIEW_IMMEDIATE_HIGHLIGHT_MAX_BYTES) return false; // units bound ⇒ bytes bound
  if (countCodeLines(text) > PREVIEW_IMMEDIATE_HIGHLIGHT_MAX_LINES) return false;
  // Exact UTF-8 byte walk (bounded: the units gate above caps this at 8 192 iterations).
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4; // surrogate pair = one astral code point
      i++;
    } else bytes += 3; // BMP char, or a lone surrogate (TextEncoder substitution)
    if (bytes > PREVIEW_IMMEDIATE_HIGHLIGHT_MAX_BYTES) return false;
  }
  return true;
}

/* ------------------------------------------------------------------------- *
 * preview-perf P5 (plan r3 §5.3, 已拍板 ①) — the VIRTUAL-BODY highlight entry.
 *
 * P3's inline orchestration in `PreviewText.vue` moved here and gained its worker leg: the
 * virtual source view (>600 lines / every line-numbered stream) tokenizes IN THE WORKER under
 * the widened gates — `shouldHighlight(text, { maxBytes: 256 KiB, maxLines: Infinity })`,
 * `flattenTokens(…, { maxTokens: 80_000 })` inside the worker — and applies the transferred
 * `HighlightSpans` as soon as they arrive (no idle wait: the main thread only decodes the
 * mounted blocks' lines, §5.3). The worker path needs NO main-thread Prism load at all.
 *
 * Whenever the worker is out — sticky unavailable (constructor / `error` / `messageerror` /
 * CSP rejection), or THIS request's 3 s deadline — the client resolves `fallback` and this
 * side runs §5.1's path VERBATIM: `loadPrism()` → idle scheduling (gesture + recent-scroll
 * dodging) → tokenize under the ORIGINAL gates (100 KiB / 3000 lines / 20k tokens). A text the
 * worker gates rejected is left plain without asking: §5.1's gates are strictly narrower, so
 * the fallback would reject it too. Streams never highlight (§5.3, unchanged).
 *
 * Invalidation is epoch-based: every `schedule()` bumps the epoch, so a result arriving for a
 * superseded text (same-path retry, view switch) is dropped on arrival, and `dispose()`
 * (window close / unmount) additionally cancels the pending worker request outright.
 * ------------------------------------------------------------------------- */

export interface VirtualHighlighterDeps {
  /** The CURRENT virtual body text (ANSI-stripped loaded text — what the worker tokenizes). */
  readonly text: () => string;
  /** Prism grammar id for the file (`null` ⇒ plain text, no request at all). */
  readonly lang: () => string | null;
  /** The virtual source view is the active renderer (false ⇒ nothing to do). */
  readonly active: () => boolean;
  /** Spans arrived — apply to the virtual source (repaints the mounted blocks only, P2). */
  readonly apply: (spans: HighlightSpans) => void;
  /** §5.1 dodge, consulted only by the main-thread FALLBACK: a drag or a scroll within 150 ms. */
  readonly busy: () => boolean;
  /** Test seam — defaults to the process-wide shared worker client. */
  readonly workerClient?: HighlightWorkerClient | undefined;
}

export interface VirtualHighlighter {
  /** (Re)start for the current text/lang; invalidates any pending work first. */
  schedule(): void;
  /** Drop pending work without rescheduling (left the virtual path / text rebuilt elsewhere). */
  invalidate(): void;
  /** Window closed / component unmount — cancel everything; later callbacks are no-ops. */
  dispose(): void;
}

/** §5.1 idle scheduling: `requestIdleCallback` where available, `setTimeout` 50 ms otherwise. */
function scheduleIdleTask(cb: () => void, opts?: { readonly timeout?: number }): () => void {
  const ric = (globalThis as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof ric === "function") {
    const h = ric(cb, { timeout: opts?.timeout ?? 500 });
    return () => {
      const cic = (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
      if (typeof cic === "function") cic(h);
    };
  }
  const h = setTimeout(cb, 50);
  return () => clearTimeout(h);
}

export function createVirtualHighlighter(deps: VirtualHighlighterDeps): VirtualHighlighter {
  const client = (): HighlightWorkerClient => deps.workerClient ?? getHighlightWorkerClient();
  let epoch = 0;
  let disposed = false;
  let pendingWorker: HighlightWorkerHandle | null = null;
  let idleCancel: (() => void) | null = null;

  function dropWorker(): void {
    if (pendingWorker !== null) {
      pendingWorker.cancel();
      pendingWorker = null;
    }
  }

  function dropIdle(): void {
    if (idleCancel !== null) {
      idleCancel();
      idleCancel = null;
    }
  }

  function invalidate(): void {
    epoch += 1; // a result arriving for an older epoch is dropped on arrival
    dropWorker();
    dropIdle();
  }

  /** §5.1 verbatim: ORIGINAL gates, gesture/scroll dodging, tokenize → encode → apply. */
  function queueMainThread(engine: PrismLike, myEpoch: number): void {
    if (disposed || myEpoch !== epoch) return;
    dropIdle();
    idleCancel = scheduleIdleTask(
      () => {
        idleCancel = null;
        if (disposed || myEpoch !== epoch) return;
        // Dodge gestures and recent scrolls — re-queue instead of tokenizing (§5.1).
        if (deps.busy()) {
          queueMainThread(engine, myEpoch);
          return;
        }
        const text = deps.text();
        const lang = deps.lang();
        if (lang === null || !shouldHighlight(text)) return; // original gates stand (§5.1)
        const grammar = engine.languages[lang];
        if (grammar === undefined) return;
        try {
          const parts = flattenTokens(engine.tokenize(text, grammar));
          if (parts === null) return;
          const spans = encodeHighlightSpans(parts);
          if (spans === null) return;
          if (disposed || myEpoch !== epoch) return;
          deps.apply(spans);
        } catch {
          /* a grammar must never break rendering — plain stands */
        }
      },
      { timeout: 500 },
    );
  }

  function runMainThreadFallback(myEpoch: number): void {
    if (disposed || myEpoch !== epoch) return;
    void loadPrism().then((engine) => {
      if (engine === null || disposed || myEpoch !== epoch) return; // failed load ⇒ plain forever
      queueMainThread(engine, myEpoch);
    });
  }

  function schedule(): void {
    invalidate(); // also the text-change path: a pending tokenize for the OLD text is dropped
    if (disposed || !deps.active()) return;
    const lang = deps.lang();
    if (lang === null) return; // unknown language ⇒ plain, no request
    const text = deps.text();
    // §5.3 admission (256 KiB / lines uncapped). Strictly wider than §5.1's gates, so a text
    // rejected here would be rejected by the fallback too — plain stands, no worker roundtrip.
    if (!shouldHighlight(text, { maxBytes: HIGHLIGHT_WORKER_MAX_BYTES, maxLines: Infinity })) return;
    const myEpoch = epoch;
    const handle = client().request(text, lang);
    pendingWorker = handle;
    void handle.result.then((outcome) => {
      if (myEpoch !== epoch) return; // superseded (epoch 作废) — drop silently
      pendingWorker = null;
      if (outcome.status === "spans") {
        deps.apply(outcome.spans);
        return;
      }
      if (outcome.status === "fallback") runMainThreadFallback(myEpoch); // worker out ⇒ §5.1
      // "plain" (grammar/budget/encode) and "cancelled": plain stands, nothing to do
    });
  }

  function dispose(): void {
    disposed = true;
    invalidate();
  }

  return { schedule, invalidate, dispose };
}
