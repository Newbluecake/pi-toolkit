/**
 * preview-perf P5 (plan r3 §5.3) — the MAIN-THREAD client for `highlight-worker.ts`.
 *
 * One process-wide shared worker, created lazily on the first request and reused by every
 * virtual source view (`getHighlightWorkerClient()`; the plan's 「懒创建、全局复用一个
 * Worker」). Requests carry a monotone id and a 3 s deadline (§5.3):
 *
 *  - TIMEOUT ⇒ `terminate()` + lazy rebuild on the next request (NOT sticky — the worker stays
 *    in play for other files); every request pending on the terminated worker resolves
 *    `fallback` and the caller runs §5.1's original-gate main-thread idle path.
 *  - STICKY UNAVAILABLE (constructor throws, the `error` event — script load failure / CSP
 *    rejection / an uncaught error inside the worker — or `messageerror`) ⇒ the process never
 *    tries again; every current and future request resolves `fallback` immediately. This is
 *    plan K10's answer: enterprise policy or an extension blocking workers degrades to the
 *    pre-P5 behaviour, never to a broken view.
 *  - `cancel()` resolves `cancelled` and detaches the id: a reply that still arrives (the
 *    worker cannot be interrupted mid-tokenize) is dropped. Callers cancel on epoch bumps
 *    (text changed / left the virtual view) and on window close.
 *
 * The reply's `Uint32Array` arrives through a transfer (worker-side zero copy); this side only
 * re-shapes it into the frozen `HighlightSpans` after structural validation. A reply that fails
 * validation is ignored — the request's own deadline then decides its fate.
 *
 * The default worker factory is a test seam away from the real `Worker` (see `workerFactory`);
 * tests inject structural fakes, node/happy-dom (no `Worker`) gets a sticky `fallback` — which
 * is exactly why every component test keeps exercising the §5.1 fallback path unchanged.
 */
import type { HighlightSpans } from "@logic/previewVirtualTypes.js";
import type { HighlightWorkerRequest } from "./highlight-worker.js";

/** §5.3 gate: the worker path tokenizes up to 256 KiB (UTF-8 bytes); lines are uncapped. */
export const HIGHLIGHT_WORKER_MAX_BYTES = 256 * 1024;
/** §5.3 per-request deadline (ms). A timeout terminates + rebuilds the shared worker. */
export const HIGHLIGHT_WORKER_TIMEOUT_MS = 3_000;

/** What a request resolves to. `fallback` ⇒ the caller MUST run the §5.1 main-thread path. */
export type HighlightWorkerOutcome =
  | { readonly status: "spans"; readonly spans: HighlightSpans }
  | { readonly status: "plain" } // grammar missing / token budget / encode failure — plain stands
  | { readonly status: "fallback" } // worker out for this attempt (sticky or this request's timeout)
  | { readonly status: "cancelled" }; // cancelled by the caller — always ignored

export interface HighlightWorkerHandle {
  readonly result: Promise<HighlightWorkerOutcome>;
  /** Detach this request: resolves `cancelled` now; a late reply is dropped. */
  cancel(): void;
}

export interface HighlightWorkerClient {
  /** Sticky process-wide verdict (§5.3 回落). Read-only diagnostics; `request` already folds it in. */
  readonly unavailable: boolean;
  /** J1: `opts.maxTokens` (optional) pins the worker's `flattenTokens` budget for THIS request —
   *  the non-virtual bodies pass the ORIGINAL 20k so their degrade set stays byte-identical;
   *  omitted keeps the worker's own widened 80k default (the virtual path, unchanged). */
  request(text: string, lang: string, opts?: { readonly maxTokens?: number }): HighlightWorkerHandle;
}

/** Structural subset of `Worker` the client touches (tests implement this; prod casts). */
export interface HighlightWorkerLike {
  postMessage(message: unknown, transfer?: unknown): void;
  terminate(): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: "error" | "messageerror", listener: () => void): void;
}

/** Builds the real same-origin module worker (Vite emits it as a lazy chunk off this literal). */
function defaultWorkerFactory(): HighlightWorkerLike | null {
  if (typeof Worker !== "function") return null; // node/happy-dom/very old engines
  return new Worker(new URL("./highlight-worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as HighlightWorkerLike;
}

export interface HighlightWorkerClientOptions {
  /** Test seam; absent ⇒ the real module worker. Returning `null` models "no Worker here". */
  readonly workerFactory?: (() => HighlightWorkerLike | null) | undefined;
  readonly timeoutMs?: number | undefined;
}

interface PendingEntry {
  readonly resolve: (o: HighlightWorkerOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function createHighlightWorkerClient(opts?: HighlightWorkerClientOptions): HighlightWorkerClient {
  const makeWorker = opts?.workerFactory ?? defaultWorkerFactory;
  const timeoutMs = opts?.timeoutMs ?? HIGHLIGHT_WORKER_TIMEOUT_MS;
  /** Sticky verdict — only constructor failure / `error` / `messageerror` ever set this. */
  let dead = false;
  let worker: HighlightWorkerLike | null = null;
  let nextId = 1;
  const pending = new Map<number, PendingEntry>();

  /** First remover wins: every settle path deletes the entry, so nothing settles twice. */
  function settle(id: number, outcome: HighlightWorkerOutcome): void {
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(outcome);
  }

  function failAllPending(): void {
    for (const id of [...pending.keys()]) settle(id, { status: "fallback" });
  }

  function killWorker(): void {
    if (worker === null) return;
    try {
      worker.terminate();
    } catch {
      /* already gone — nothing to clean */
    }
    worker = null;
  }

  function onReply(data: unknown): void {
    if (data === null || typeof data !== "object") return;
    const r = data as { kind?: unknown; id?: unknown; classes?: unknown; spans?: unknown };
    if (typeof r.id !== "number" || !Number.isInteger(r.id)) return;
    if (pending.get(r.id) === undefined) return; // cancelled / superseded — drop silently
    if (r.kind === "plain") {
      settle(r.id, { status: "plain" });
      return;
    }
    if (r.kind !== "spans") return; // unknown reply kind: ignore (deadline decides)
    // Structural validation before anything consumes it (the frozen interface is trusted after).
    if (!Array.isArray(r.classes) || r.classes.some((c) => typeof c !== "string")) return;
    if (!(r.spans instanceof Uint32Array) || r.spans.length % 3 !== 0) return;
    settle(r.id, { status: "spans", spans: { classes: r.classes, spans: r.spans } });
  }

  function ensureWorker(): HighlightWorkerLike | null {
    if (dead) return null;
    if (worker !== null) return worker;
    let w: HighlightWorkerLike | null;
    try {
      w = makeWorker();
    } catch {
      dead = true; // §5.3: 构造抛错 ⇒ 粘滞不可用
      return null;
    }
    if (w === null) {
      dead = true; // no Worker in this environment — same sticky verdict
      return null;
    }
    // An `error` event means the script never loaded (CSP rejection / 404 / network) or the
    // worker hit an uncaught error — either way the channel cannot be trusted again (§5.3).
    w.addEventListener("error", () => {
      dead = true;
      killWorker();
      failAllPending();
    });
    w.addEventListener("messageerror", () => {
      dead = true;
      killWorker();
      failAllPending();
    });
    w.addEventListener("message", (ev) => onReply(ev.data));
    worker = w;
    return w;
  }

  function request(text: string, lang: string, opts?: { readonly maxTokens?: number }): HighlightWorkerHandle {
    const w = ensureWorker();
    const settled = (o: HighlightWorkerOutcome): HighlightWorkerHandle => ({
      result: Promise.resolve(o),
      cancel: (): void => undefined,
    });
    if (w === null) return settled({ status: "fallback" });
    const id = nextId++;
    let resolveFn!: (o: HighlightWorkerOutcome) => void;
    const result = new Promise<HighlightWorkerOutcome>((res) => {
      resolveFn = res;
    });
    const entry: PendingEntry = {
      resolve: resolveFn,
      timer: setTimeout(() => {
        // §5.3: this request's 3 s deadline expired — terminate the (shared!) worker and
        // rebuild lazily on the next request. Every request pending on it falls to the
        // main-thread fallback path; the verdict stays NON-sticky.
        killWorker();
        settle(id, { status: "fallback" });
        failAllPending();
      }, timeoutMs),
    };
    pending.set(id, entry);
    // Fire-and-forget postMessage: the deadline owns failure — a throw here would mean the
    // worker object itself is unusable, which the error/timeout paths already cover.
    try {
      const message: HighlightWorkerRequest =
        typeof opts?.maxTokens === "number" && Number.isFinite(opts.maxTokens) && opts.maxTokens > 0
          ? { kind: "tokenize", id, text, lang, maxTokens: opts.maxTokens }
          : { kind: "tokenize", id, text, lang };
      w.postMessage(message);
    } catch {
      killWorker();
      settle(id, { status: "fallback" });
    }
    return { result, cancel: (): void => settle(id, { status: "cancelled" }) };
  }

  return {
    get unavailable(): boolean {
      return dead;
    },
    request,
  };
}

let sharedClient: HighlightWorkerClient | null = null;

/**
 * The process-wide client (§5.3: one lazily-created, globally reused worker). Module scope is
 * fine here — this is the Vue UI bundle, not the pi extension (`highlight-core.ts` keeps the
 * same discipline with its Prism promise).
 */
export function getHighlightWorkerClient(): HighlightWorkerClient {
  sharedClient ??= createHighlightWorkerClient();
  return sharedClient;
}
