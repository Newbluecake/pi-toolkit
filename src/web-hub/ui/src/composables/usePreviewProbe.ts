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
 * 200 — fails the whole batch to `"failed"`; the composable never retries on its own.
 * 2026-10-09 negative-TTL fix: `"missing"`/`"failed"` are no longer terminal forever — the
 * store re-stages them after `PROBE_MISSING_TTL_MS` (10 s) / `PROBE_FAILED_TTL_MS` (30 s)
 * when a later `ensure()` mentions the path again (a NEW message, a re-render with changed
 * candidates — already-rendered PathTexts never re-ensure on their own, which stays true).
 * There is still no retry timer here: expiry is pull-driven by `ensure`, gated per flush by
 * `store.markPending`, so a failed batch cannot be retried more often than its TTL and the
 * one-request-per-tick batching is unchanged. `stateOf` keeps reporting the old negative
 * state while a re-probe is in flight (no flicker); the store's `probing` mark prevents any
 * double submit. The clock is injectable (`opts.now`, default `Date.now`) — tests drive a
 * fake clock; the composable itself still owns no timers beyond the flush scheduler.
 *
 * Reactivity: the store is plain data; every mutation bumps a `version` ref and every
 * `stateOf()` read depends on it, so all `PathText` computeds re-evaluate on settle. A
 * probe answer keyed to an OLD scope (the user switched mid-flight) still settles — into
 * the old scope's LRU partition, harmless by construction.
 */
import { onScopeDispose, ref, type Ref } from "vue";
import { scopeKeyOf } from "@logic/preview.js";
import { planProbeBatches, PreviewProbeStore, PROBE_LRU_CAP } from "@logic/previewProbe.js";
import type { PreviewProbeKind } from "@protocol/preview.js";
import type { PreviewPathScope } from "../types.js";
import type { PreviewProbeOutcome } from "../transport/types.js";

/** A candidate's probe state (mirrors `logic/previewProbe.js`'s JSDoc typedef):
 * `pending` (in flight) → `confirmed` (backend admitted it — render the clickable ref) /
 * `missing` (nothing there) / `failed` (the REQUEST failed — same plain-text rendering). */
export type PreviewProbeState = "pending" | "confirmed" | "missing" | "failed";

/** Probe transport fn — `PreviewTransport["probe"]`, non-optional here (checked by usePreview). */
export type PreviewProbeFn = NonNullable<import("../transport/types.js").PreviewTransport["probe"]>;

/** dir-plan §5 P3: additive handle surface (kept in its own base so pre-P3 fakes typing
 * `PreviewProbeHandle` stay valid when they omit `kindOf`). */
export interface PreviewProbeHandleExtra {
  /**
   * dir-plan §5 P3 (dirs 透传 + kind 记录): the confirmed KIND of `path` under the current
   * scope (`"dir"` ⇒ `usePreview.open/navigate` sets the `dir=1` opt-in directly, no probe
   * re-request and no 415 round trip); `undefined` for anything unknown/failed — the caller
   * then falls back to a plain fetch (and, on 415 `not-regular`, the one-shot dir re-fetch).
   * Reactive (settles bump the same version `stateOf` reads). Optional per the frozen-types
   * convention: pre-P3 fakes omit it and the composable's `dir` hint degrades cleanly.
   */
  kindOf?(path: string): PreviewProbeKind | undefined;
}

export interface PreviewProbeHandle extends PreviewProbeHandleExtra {
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
  /** Injectable clock for the negative-result TTLs (default `Date.now`; 2026-10-09 fix). */
  readonly now?: (() => number) | undefined;
}

interface QueueItem {
  readonly scopeKey: string;
  readonly scope: PreviewPathScope;
  readonly path: string;
}

export function usePreviewProbe(opts: UsePreviewProbeOptions): PreviewProbeHandle {
  const store = new PreviewProbeStore(PROBE_LRU_CAP, opts.now !== undefined ? { now: opts.now } : undefined);
  const version = ref(0);
  // dir-plan §5 P3: the last confirmed KIND per (scopeKey, path) — `usePreview` consults it
  // ("dir" ⇒ the `dir=1` opt-in) instead of paying a discovery round trip per click. Bounded
  // FIFO at the store's own LRU cap (`PROBE_LRU_CAP`): kinds age out alongside states, and a
  // stale kind is never dangerous (hub `dir=1` on a file answers the file normally; the
  // 415 fallback covers the dir-after-file direction).
  const kinds = new Map<string, PreviewProbeKind>();
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

  function kindKey(scopeKey: string, path: string): string {
    return `${scopeKey}\u0000${path}`; // scopeKeys carry no NUL; probe paths are NUL-free (validatePreviewPath)
  }

  function recordKinds(scopeKey: string, batch: string[], results: ReadonlyArray<PreviewProbeKind>): void {
    for (let i = 0; i < batch.length && i < results.length; i++) {
      kinds.set(kindKey(scopeKey, batch[i]!), results[i]!);
    }
    while (kinds.size > PROBE_LRU_CAP) {
      const oldest = kinds.keys().next();
      if (oldest.done === true) break;
      kinds.delete(oldest.value);
    }
  }

  async function request(scopeKey: string, scope: PreviewPathScope, batch: string[]): Promise<void> {
    let out: PreviewProbeOutcome;
    // dir-plan §5 P3 (dirs 透传): a `dirs` scope asks directories to answer "dir" (A5/A4) —
    // without the flag the request body stays byte-identical to pre-dir-plan.
    const req: { agentKey: string; sessionId: string; paths: readonly string[]; dirs?: true } = {
      agentKey: scope.agentKey,
      sessionId: scope.sessionId,
      paths: batch,
    };
    if (scope.dirs === true) req.dirs = true;
    try {
      out = await opts.probe(req);
    } catch {
      out = { ok: false, status: 0, error: "E_NETWORK" };
    }
    if (disposed) return;
    if (out.ok && out.results.length === batch.length) {
      store.settle(scopeKey, batch, out.results);
      recordKinds(scopeKey, batch, out.results);
    } else store.fail(scopeKey, batch);
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
    kindOf(path) {
      void version.value; // same reactivity contract as stateOf
      const sc = opts.scope.value;
      if (sc === null) return undefined;
      return kinds.get(kindKey(scopeKeyOf(sc), path));
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
