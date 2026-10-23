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
import { markRaw, onBeforeUnmount, ref, shallowRef, watch, type Ref } from "vue";
import {
  decodeHighlightSpans,
  encodeHighlightSpans,
  flattenTokens,
  HIGHLIGHT_DEBOUNCE_MS,
  HIGHLIGHT_MAX_TOKENS,
  shouldHighlight,
} from "@logic/highlight.js";
import type { HighlightSpans } from "@logic/previewVirtualTypes.js";
import { countCodeLines } from "@logic/previewLines.js";
import { PW_DRAGGING_CLASS } from "../../composables/usePreviewWindowLayout.js";
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
export interface UseHighlightPartsOpts {
  readonly immediate?: boolean;
  /** Test seam — defaults to the process-wide shared worker client. */
  readonly workerClient?: HighlightWorkerClient | undefined;
}

/** Test-only override for `useHighlightParts`' worker client (J1; see `UseHighlightPartsOpts`). */
let testWorkerClient: HighlightWorkerClient | null = null;
export function setHighlightWorkerClientForTests(client: HighlightWorkerClient | null): void {
  testWorkerClient = client;
}

export function useHighlightParts(
  source: () => { readonly text: string; readonly lang: string | null },
  opts?: UseHighlightPartsOpts,
): Ref<FlatPart[] | null> {
  const immediate = opts?.immediate === true;
  const prism = ref<PrismLike | null>(resolvedPrism ?? null);
  /** Non-null ⇒ highlighted parts; null ⇒ plain-text rendering. J1 #3: `shallowRef` +
   *  `markRaw` — the 4–10k `{cls,text}` fragments must never ride Vue's deep reactivity
   *  (jank-20kb LT-2's createReactiveObject/walk/track share). */
  const parts = shallowRef<FlatPart[] | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  /** J1 epoch: bumped on every invalidation — a worker reply / idle tokenize for an older
   *  text is dropped on arrival (same discipline as `createVirtualHighlighter`). */
  let epoch = 0;
  let pendingWorker: HighlightWorkerHandle | null = null;
  let idleCancel: (() => void) | null = null;

  void loadPrism().then((p) => {
    if (!disposed) prism.value = p;
  });

  /** Main-thread tokenize under the ORIGINAL gates — the §5.2 immediate sync path and the
   *  §5.1 fallback leg (worker out) both land here; behaviour is the pre-J1 recompute(). */
  function recomputeMain(engine: PrismLike): void {
    const { text, lang } = source();
    if (lang === null || !shouldHighlight(text)) {
      parts.value = null;
      return;
    }
    const grammar = engine.languages[lang];
    if (grammar === undefined) {
      parts.value = null;
      return;
    }
    try {
      const flat = flattenTokens(engine.tokenize(text, grammar));
      parts.value = flat === null ? null : (markRaw(flat) as FlatPart[]);
    } catch {
      parts.value = null; // a grammar must never break rendering — fall back to plain text
    }
  }

  function dropPending(): void {
    epoch += 1;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pendingWorker !== null) {
      pendingWorker.cancel();
      pendingWorker = null;
    }
    if (idleCancel !== null) {
      idleCancel();
      idleCancel = null;
    }
  }

  /** J1 §5.1 fallback (worker unavailable / timed out / errored): idle-scheduled main-thread
   *  tokenize with the ORIGINAL gates, dodging gestures and recent scrolls — verbatim the
   *  virtual path's `queueMainThread`, now shared by the non-virtual bodies too. */
  function queueMainThread(myEpoch: number): void {
    if (disposed || myEpoch !== epoch) return;
    void loadPrism().then((engine) => {
      if (engine === null || disposed || myEpoch !== epoch) return; // failed load ⇒ plain forever
      if (idleCancel !== null) idleCancel();
      idleCancel = scheduleIdleTask(
        () => {
          idleCancel = null;
          if (disposed || myEpoch !== epoch) return;
          if (highlightInteractionBusy()) {
            queueMainThread(myEpoch); // dodge — re-queue instead of tokenizing (§5.1)
            return;
          }
          recomputeMain(engine);
        },
        { timeout: 500 },
      );
    });
  }

  /** Debounce settled — tokenize. J1 #1: the request goes to the shared highlight WORKER
   *  first (only the postMessage copy rides the main thread); the reply's spans decode back
   *  into the exact `flattenTokens` shape (same engine chunk, same grammar, same offsets ⇒
   *  byte-identical rendering). Admission keeps the ORIGINAL gates — 100 KiB / 3000 lines /
   *  20k tokens — on BOTH legs: the worker request carries the 20k token budget so the
   *  degrade set (which files highlight at all) stays EXACTLY today's; plan §5's widened
   *  256 KiB / 80k budget stays a virtual-path-only rule (it would visibly change which
   *  non-virtual files highlight and could flood a full-DOM body with up to 80k spans). */
  function startHighlight(): void {
    if (disposed) return;
    const { text, lang } = source();
    if (lang === null || !shouldHighlight(text)) return; // original gates stand (J1 choice)
    const myEpoch = epoch;
    const client = opts?.workerClient ?? testWorkerClient ?? getHighlightWorkerClient();
    const handle = client.request(text, lang, { maxTokens: HIGHLIGHT_MAX_TOKENS });
    pendingWorker = handle;
    void handle.result.then((outcome) => {
      if (disposed || myEpoch !== epoch) return; // superseded (epoch 作废) — drop silently
      pendingWorker = null;
      if (outcome.status === "spans") {
        const decoded = decodeHighlightSpans(outcome.spans, text, 0, text.length);
        parts.value = decoded === null ? null : (markRaw(decoded) as FlatPart[]); // invalid ⇒ plain
        return;
      }
      if (outcome.status === "fallback") queueMainThread(myEpoch); // worker out ⇒ §5.1
      // "plain" (grammar/budget/encode) and "cancelled": plain stands, nothing to do
    });
  }

  watch(
    () => [source().text, source().lang, prism.value] as const,
    () => {
      dropPending(); // also the text-change path: pending work for the OLD text is dropped
      if (immediate && prism.value !== null) {
        // Engine in hand (setup-time via the sync cache, or a later arrival): tokenize NOW —
        // the first render is the highlighted VNode (§5.2), never plain-then-replace. This
        // leg stays on the MAIN thread on purpose: `immediate` is the ≤200-line/≤8 KiB
        // small-file contract (PB §7.3) — a worker roundtrip can never make the first
        // render synchronous.
        recomputeMain(prism.value);
        return;
      }
      // Latest text shows plain right away (identical pre-highlight DOM); tokenizing is
      // debounced so a streaming caller never re-tokenizes per frame.
      parts.value = null;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(startHighlight, HIGHLIGHT_DEBOUNCE_MS);
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    disposed = true;
    dropPending(); // cancels the pending worker request outright
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

/** §5.1 idle scheduling: `requestIdleCallback` where available, `setTimeout` 50 ms otherwise.
 *  Exported since J1: the markdown preview's progressive mount rides the same scheduler. */
export function scheduleIdleTask(cb: () => void, opts?: { readonly timeout?: number }): () => void {
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

/* ------------------------------------------------------------------------- *
 * J1 #1 (jank-20kb) — the SHARED §5.1 dodge signal + batched highlight application.
 *
 * `highlightInteractionBusy`: the gesture/scroll dodge `createVirtualHighlighter` encodes
 * through its per-mount `busy` dep, lifted to a process-wide helper so `useHighlightParts`'s
 * main-thread FALLBACK leg can dodge too (a preview-window drag or a scroll within 150 ms).
 * One lazily-installed passive capture listener feeds the timestamp — module scope follows
 * the shared worker client's precedent (this is the Vue UI bundle, not the pi extension).
 * ------------------------------------------------------------------------- */

let sharedLastScrollAt = 0;
let sharedScrollTrackerInstalled = false;

function installSharedScrollTracker(): void {
  if (sharedScrollTrackerInstalled || typeof document === "undefined") return;
  sharedScrollTrackerInstalled = true;
  try {
    document.addEventListener(
      "scroll",
      () => {
        sharedLastScrollAt = Date.now();
      },
      { passive: true, capture: true },
    );
  } catch {
    /* a listener must never break rendering */
  }
}

/** §5.1 dodge: true while a preview-window drag is in progress or a scroll landed <150 ms ago. */
export function highlightInteractionBusy(): boolean {
  installSharedScrollTracker(); // lazy + idempotent — first consumer wires the listener
  try {
    if (typeof document !== "undefined" && document.body.classList.contains(PW_DRAGGING_CLASS)) {
      return true;
    }
  } catch {
    /* no body — not busy */
  }
  return Date.now() - sharedLastScrollAt < 150;
}

/* ------------------------------------------------------------------------- *
 * J1 #2 — batched highlight application (kills jank-20kb LT-3: the whole-body DOM
 * re-cloak after tokenize, one synchronous flush inserting 4–10k token spans).
 *
 * Once parts/spans arrive, the caller swaps its rows (lines for `NumberedCode`, parts for
 * `HighlightedCode`) BLOCK by block across macrotask boundaries (`setTimeout(0)` — a task
 * boundary per batch, never rAF [source-scan] and never a single flush). Each batch stays
 * under the DOM budget below (well <50 ms even at 4× CPU throttle), the user can scroll
 * between batches, and a text change / unmount cancels the run. Selection rule: a
 * non-collapsed selection touching the rewritten subtree DEFERS the remaining batches
 * (rewriting a row's children would collapse the selection; plain and highlighted rows
 * carry identical text, so nothing else — copy, Ctrl+A, find — can observe the staging).
 * ------------------------------------------------------------------------- */

/** One batch's DOM budget: token spans (parts) applied per batch. The cursor walks the FLAT
 *  parts array (both callers), so line-count granularity never re-cloaks a one-line
 *  minified body in a single giant batch. */
export const HIGHLIGHT_BATCH_MAX_PARTS = 512;
/** While a selection defers the run: the fallback poll interval (ms) — `selectionchange`
 *  resumes immediately; this keeps a held-forever selection from wedging the run silently. */
const HIGHLIGHT_BATCH_DEFER_POLL_MS = 500;

export interface HighlightBatchSpec {
  /** Total row count (the cursor walks [0, total)). */
  readonly total: number;
  /** Cost-aware advance: return the next cursor (> from, ≤ total); ≥1 row per call. */
  readonly next: (from: number) => number;
  /** The rewritten subtree's root — a non-collapsed selection touching it defers the batch. */
  readonly root: () => HTMLElement | null;
  /** Apply rows [from, to). */
  readonly apply: (from: number, to: number) => void;
}

export interface HighlightBatchHandle {
  /** Text changed / component unmount — stop the run; later steps are no-ops. */
  cancel(): void;
}

export function startHighlightBatches(spec: HighlightBatchSpec): HighlightBatchHandle {
  let cursor = 0;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deferralArmed = false;

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function disarmDeferral(): void {
    if (!deferralArmed) return;
    deferralArmed = false;
    if (typeof document !== "undefined") {
      try {
        document.removeEventListener("selectionchange", step);
      } catch {
        /* nothing armed anyway */
      }
    }
  }

  /** A non-collapsed selection touching the rewritten subtree defers the remaining batches —
   *  the swap would collapse the user's selection (J1 选区规则; a crossing selection counts:
   *  either endpoint inside the root). */
  function deferredBySelection(): boolean {
    if (typeof document === "undefined" || typeof document.getSelection !== "function") return false;
    const sel = document.getSelection();
    if (sel === null || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return false;
    const root = spec.root();
    if (root === null) return false;
    return root.contains(range.startContainer) || root.contains(range.endContainer);
  }

  function armDeferral(): void {
    if (deferralArmed) return;
    deferralArmed = true;
    if (typeof document !== "undefined") {
      try {
        document.addEventListener("selectionchange", step);
      } catch {
        /* a listener must never break the run */
      }
    }
    timer = setTimeout(step, HIGHLIGHT_BATCH_DEFER_POLL_MS); // fallback poll
  }

  function step(): void {
    if (cancelled) return;
    clearTimer();
    disarmDeferral();
    if (cursor >= spec.total) return;
    if (deferredBySelection()) {
      armDeferral();
      return;
    }
    const advanced = Math.min(spec.next(cursor), spec.total);
    const to = advanced > cursor ? advanced : Math.min(cursor + 1, spec.total); // ≥1 row progress
    spec.apply(cursor, to);
    cursor = to;
    if (cursor >= spec.total) return;
    timer = setTimeout(step, 0); // a task boundary per batch — paint/scroll happen in between
  }

  timer = setTimeout(step, 0);

  return {
    cancel(): void {
      cancelled = true;
      clearTimer();
      disarmDeferral();
    },
  };
}
