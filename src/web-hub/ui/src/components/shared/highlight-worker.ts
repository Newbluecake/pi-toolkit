/**
 * preview-perf P5 (plan r3 §5.3, 已拍板 ①) — the syntax-highlight WORKER entry.
 *
 * NEVER imported by the main bundle: `highlight-worker-client.ts`'s default factory references
 * it as `new Worker(new URL("./highlight-worker.ts", import.meta.url), { type: "module" })`,
 * which Vite bundles into its own lazy chunk (ES-module worker — `vite.config.ts` sets
 * `worker.format: "es"` so the dynamic engine import below survives). Same-origin module
 * worker, allowed by the production CSP: no `worker-src` directive ⇒ falls back to
 * `script-src 'self'` (plan §5.3 前置核对; the csp-probe worker case proves it live under the
 * REAL header on Chromium+Firefox).
 *
 * What runs here (§5.3): the FULL-TEXT `Prism.tokenize` — cross-line syntax state kept intact,
 * never per-line — plus `flattenTokens` (80k token budget) and the `HighlightSpans` encoding,
 * all off the main thread; only the compact `Uint32Array` triples + class table cross back
 * (buffer transferred ⇒ zero copy). That is what buys the widened gate (256 KiB / 80k tokens)
 * for the virtual source view; the main thread's own gates stay at §5.1's original values.
 *
 * TWO prism loading subtleties, both handled here:
 *
 *  1. prismjs core registers its own LEGACY "highlight-in-worker" `self` message handler at
 *     evaluation time (prism.js:1154) unless `_self.Prism.disableWorkerMessageHandler` was
 *     set on a PRE-EXISTING global (prism.js:78 reads it before the instance exists). That
 *     legacy handler `JSON.parse`s EVERY incoming message — our object protocol would make it
 *     throw an uncaught SyntaxError, which surfaces on the main thread as a Worker `error`
 *     event and would trip the client's sticky-unavailable path (§5.3 回落) even though OUR
 *     handler works fine. So the flag global is seeded at the TOP of this module — before the
 *     engine ever loads — and the engine is imported DYNAMICALLY inside the message handler
 *     (a static import would evaluate prism before this module's body runs). No top-level
 *     await: the build targets ES2020.
 *  2. Every reply path is wrapped: an uncaught error inside a worker fires the main-thread
 *     `error` event, so a per-file failure (missing grammar, token-budget blowout, a grammar
 *     that throws) must ANSWER `{ kind: "plain" }` instead of throwing.
 *
 * `computeWorkerReplyWith` — the pure request→reply reduction, engine injected, no worker
 * globals — is exported for unit tests; the glue registration is guarded so importing this
 * module under node/vitest has no side effects beyond seeding the (harmless) flag global.
 */
import { encodeHighlightSpans, flattenTokens } from "@logic/highlight.js";
import { HIGHLIGHT_WORKER_MAX_TOKENS } from "@logic/previewVirtualTypes.js";
import type { PrismLike } from "./highlight-core.js";

// §subtlety 1: seed the pre-load flag BEFORE any prismjs code evaluates. The spread keeps an
// already-present global (e.g. a test file that imported highlight-impl first) intact.
{
  const g = globalThis as { Prism?: Record<string, unknown> };
  g.Prism = { ...g.Prism, disableWorkerMessageHandler: true };
}

/** Wire request (client → worker). The `kind` discriminant future-proofs the channel. */
export interface HighlightWorkerRequest {
  readonly kind: "tokenize";
  readonly id: number;
  readonly text: string;
  readonly lang: string;
}

/** Wire reply (worker → client). `spans`' buffer rides the transfer list (§5.3). */
export type HighlightWorkerReply =
  | {
      readonly kind: "spans";
      readonly id: number;
      readonly classes: readonly string[];
      readonly spans: Uint32Array;
    }
  | { readonly kind: "plain"; readonly id: number };

/**
 * The pure reduction a `tokenize` request maps to (engine injected so tests stay synchronous).
 * Never throws — every failure mode (unknown message shape, missing grammar, budget/encode
 * blowout, a grammar that throws) answers `plain` for THAT request (the file simply stays
 * unhighlighted; the worker itself stays usable). Returns `null` only for a message that is
 * not a recognizable request (ignored, never replied).
 */
export function computeWorkerReplyWith(
  Prism: PrismLike,
  msg: unknown,
): { reply: HighlightWorkerReply; transfer: readonly unknown[] } | null {
  if (msg === null || typeof msg !== "object") return null;
  const m = msg as { kind?: unknown; id?: unknown; text?: unknown; lang?: unknown };
  if (m.kind !== "tokenize" || typeof m.id !== "number" || typeof m.text !== "string" || typeof m.lang !== "string") {
    return null;
  }
  const plain: HighlightWorkerReply = { kind: "plain", id: m.id };
  try {
    const grammar = Prism.languages[m.lang];
    if (grammar === undefined) return { reply: plain, transfer: [] }; // unknown language ⇒ plain
    const parts = flattenTokens(Prism.tokenize(m.text, grammar), { maxTokens: HIGHLIGHT_WORKER_MAX_TOKENS });
    if (parts === null) return { reply: plain, transfer: [] }; // token budget blew ⇒ plain
    const spans = encodeHighlightSpans(parts);
    if (spans === null) return { reply: plain, transfer: [] };
    return {
      reply: { kind: "spans", id: m.id, classes: spans.classes, spans: spans.spans },
      transfer: [spans.spans.buffer], // transfer ⇒ the main thread takes ownership, zero copy
    };
  } catch {
    return { reply: plain, transfer: [] }; // a grammar must never take the worker down
  }
}

/* ------------------------------------------------------------------------- *
 * Worker glue. Structurally typed (never the DOM `Worker` type — this scope IS the worker):
 * under node/vitest `self` may be missing or lack `postMessage`, in which case the module
 * registers nothing and stays importable for the unit tests above.
 * ------------------------------------------------------------------------- */

interface WorkerPort {
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  postMessage(message: unknown, transfer?: unknown): void;
}

const port: WorkerPort | null =
  typeof self === "object" &&
  self !== null &&
  typeof (self as unknown as WorkerPort).addEventListener === "function" &&
  typeof (self as unknown as WorkerPort).postMessage === "function"
    ? (self as unknown as WorkerPort)
    : null;

if (port !== null) {
  /** The engine loads lazily (AFTER the flag seed above ran) — one shared in-flight promise. */
  let enginePromise: Promise<PrismLike> | null = null;
  const engine = (): Promise<PrismLike> => {
    enginePromise ??= import("./highlight-impl.js").then(
      (m) => m.default as PrismLike,
      () => null as unknown as PrismLike, // a failed load answers plain per request (below)
    );
    return enginePromise;
  };
  port.addEventListener("message", (ev) => {
    const out = computeReplySafely(ev.data);
    if (out === null) return; // not a request (or a foreign message) — ignore
    out.then((res) => {
      if (res === null) return;
      try {
        port.postMessage(res.reply, res.transfer);
      } catch {
        /* a reply must never throw inside the worker (an uncaught error would trip the
         * main thread's sticky-unavailable path); there is nothing left to try anyway */
      }
    });
  });
  /** Reply for a request with the engine loaded (plain on engine-load failure). */
  function computeReplySafely(
    data: unknown,
  ): Promise<{ reply: HighlightWorkerReply; transfer: readonly unknown[] } | null> {
    return engine().then((Prism) => {
      if (Prism === null) {
        // engine chunk failed to load — answer plain for well-formed requests, else ignore
        if (data === null || typeof data !== "object") return null;
        const m = data as { kind?: unknown; id?: unknown };
        return m.kind === "tokenize" && typeof m.id === "number"
          ? { reply: { kind: "plain", id: m.id }, transfer: [] }
          : null;
      }
      return computeWorkerReplyWith(Prism, data);
    });
  }
}
