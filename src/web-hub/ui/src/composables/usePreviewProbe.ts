/**
 * web-hub content preview — the App-level PROBE controller (web-hub-preview 2026-10-07 修订
 * 「先探测后标记」, package PV4b).
 *
 * The state machine the transcript renders against: a candidate path starts UNMARKED (plain
 * text, never blocking the render), gets queued by `ensure()`, and flips to clickable only
 * when the backend CONFIRMS it (`"confirmed"`); `"missing"` / `"failed"` / still-`"pending"`
 * all keep rendering plain text. All results live in `logic/previewProbe.ts`'s pure
 * `PreviewProbeStore`, keyed by `scopeKeyOf(scope)` — a session/cwd switch structurally
 * cannot see the old scope's entries (they just age out of the LRU), so "scope 变化 ⇒ 旧
 * 探测结果作废" holds with zero invalidation code.
 *
 * Batching (修订 spec: 一条消息的所有候选合并为一个请求，不是每路径一个): `ensure()` only
 * APPENDS to a queue; the flush is scheduled once per macrotask (`schedule`, default
 * `setTimeout(…, 0)`), so every candidate submitted during the same render tick — one
 * settled message mounts all of its `PathText` segments synchronously — leaves in ONE
 * request (candidates arriving later start the next batch; the store dedupes anything
 * already pending or terminal, so a re-render never re-sends). Oversized flushes split into
 * wire batches by `planProbeBatches` (server caps: 100 entries / 8 KiB body).
 *
 * Failure policy (修订 spec: probe 请求失败 ⇒ 全部按纯文本，不阻塞渲染): ANY transport
 * error — network, the 5s deadline, a non-200, a malformed body, even a length-mismatched
 * 200 — fails the whole batch to `"failed"`; the composable never retries on its own (a
 * failed entry is terminal, only a scope change probes again).
 *
 * Reactivity: the store is plain data; every mutation bumps a `version` ref and every
 * `stateOf()` read depends on it, so all `PathText` computeds re-evaluate on settle. A
 * probe answer keyed to an OLD scope (the user switched mid-flight) still settles — into
 * the old scope's LRU partition, harmless by construction.
 */
import { onScopeDispose, ref, type Ref } from "vue";
import { scopeKeyOf } from "@logic/preview.js";
import { planProbeBatches, PreviewProbeStore } from "@logic/previewProbe.js";
import type { PreviewPathScope } from "../types.js";
import type { PreviewProbeOutcome } from "../transport/types.js";

/** A candidate's probe state (mirrors `logic/previewProbe.js`'s JSDoc typedef):
 * `pending` (in flight) → `confirmed` (backend admitted it — render the clickable ref) /
 * `missing` (nothing there) / `failed` (the REQUEST failed — same plain-text rendering). */
export type PreviewProbeState = "pending" | "confirmed" | "missing" | "failed";

/** Probe transport fn — `PreviewTransport["probe"]`, non-optional here (checked by usePreview). */
export type PreviewProbeFn = NonNullable<import("../transport/types.js").PreviewTransport["probe"]>;

export interface PreviewProbeHandle {
  /**
   * Current state of `path` under the CURRENT scope; `undefined` = not yet staged (the
   * caller renders plain text and — in `PathText` — queues it via `ensure`). Reactive.
   */
  stateOf(path: string): PreviewProbeState | undefined;
  /** Queue candidates for probing (dedup + batch at the next flush). No-op without a scope. */
  ensure(paths: readonly string[]): void;
}

export interface UsePreviewProbeOptions {
  readonly probe: PreviewProbeFn;
  readonly scope: Readonly<Ref<PreviewPathScope | null>>;
  /** Flush scheduler (default `setTimeout(…, 0)`); returns a cancel fn. Injectable for tests. */
  readonly schedule?: ((fn: () => void) => () => void) | undefined;
}

interface QueueItem {
  readonly scopeKey: string;
  readonly scope: PreviewPathScope;
  readonly path: string;
}

export function usePreviewProbe(opts: UsePreviewProbeOptions): PreviewProbeHandle {
  const store = new PreviewProbeStore();
  const version = ref(0);
  let queue: QueueItem[] = [];
  let cancelScheduled: (() => void) | null = null;
  let disposed = false;

  const schedule =
    opts.schedule ??
    ((fn: () => void): (() => void) => {
      const t = setTimeout(fn, 0);
      return () => clearTimeout(t);
    });

  function flush(): void {
    cancelScheduled = null;
    const items = queue;
    queue = [];
    const groups = new Map<string, { scope: PreviewPathScope; paths: string[] }>();
    for (const item of items) {
      const g = groups.get(item.scopeKey);
      if (g === undefined) groups.set(item.scopeKey, { scope: item.scope, paths: [item.path] });
      else g.paths.push(item.path);
    }
    for (const [scopeKey, g] of groups) {
      // markPending dedupes (in-flight + terminal + within-call) and returns exactly the
      // paths that need the wire; planProbeBatches honours the server's caps.
      const fresh = store.markPending(scopeKey, g.paths);
      for (const batch of planProbeBatches(fresh)) void request(scopeKey, g.scope, batch);
    }
    version.value++; // pending marks are visible state (renders the same plain text, but stay honest)
  }

  async function request(scopeKey: string, scope: PreviewPathScope, batch: string[]): Promise<void> {
    let out: PreviewProbeOutcome;
    try {
      out = await opts.probe({ agentKey: scope.agentKey, sessionId: scope.sessionId, paths: batch });
    } catch {
      out = { ok: false, status: 0, error: "E_NETWORK" };
    }
    if (disposed) return;
    if (out.ok && out.results.length === batch.length) store.settle(scopeKey, batch, out.results);
    else store.fail(scopeKey, batch);
    version.value++;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (cancelScheduled !== null) {
      cancelScheduled();
      cancelScheduled = null;
    }
    queue = [];
  }
  onScopeDispose(dispose, true); // failSilently: safe outside a component/effect scope (unit tests)

  return {
    stateOf(path) {
      void version.value; // reactive dependency: any store mutation re-runs the caller's computed
      const sc = opts.scope.value;
      if (sc === null) return undefined;
      return store.get(scopeKeyOf(sc), path);
    },
    ensure(paths) {
      if (disposed || paths.length === 0) return;
      const sc = opts.scope.value;
      if (sc === null) return; // nothing is clickable without a scope — nothing to probe either
      const key = scopeKeyOf(sc);
      for (const p of paths) queue.push({ scopeKey: key, scope: sc, path: p });
      if (cancelScheduled === null) cancelScheduled = schedule(flush);
    },
  };
}
